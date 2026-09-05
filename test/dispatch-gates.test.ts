// [2026-09-04]-[English localization: translate comments and expectation strings; no test-logic change]
// [2026-09-04]-[dispatch-bias fix fixtures: session watermark gate (context-watch) + built-in subagent block (gates)
//  + new behavior-section checks (context/builtinAgents/injection/rules.delegationFloor)]
import { describe, expect, test } from "bun:test"
import {
  READ_CLASS_TOOLS, estimateContextTokens, thresholdsOf, watermarkLevel,
  isVerificationBash, budgetGateDecision, readBudgetOf, turnBudgetOf,
  estimateReadRange, estimateOutputTokens,
} from "../src/context-watch"
import { builtinAgentDeny, checkShell } from "../src/gates"
import { firstCandidate } from "../src/lane"
import { validateUserConfig } from "../src/config"
import type { GateSnapshot, ShellRegEntry } from "../src/types"

describe("context-watch: token estimation and watermark levels", () => {
  test("estimateContextTokens: v2 top-level tokens and v1 metadata.assistant.tokens dual paths", () => {
    expect(estimateContextTokens({ tokens: { input: 50_000, output: 5_000, reasoning: 1_000, cache: { read: 10_000 } } })).toBe(66_000)
    expect(estimateContextTokens({ metadata: { assistant: { tokens: { input: 10, output: 5, cache: { read: 5 } } } } })).toBe(20)
    expect(estimateContextTokens({ tokens: null })).toBeNull()
    expect(estimateContextTokens({})).toBeNull()
    expect(estimateContextTokens({ tokens: { input: 0, output: 0 } })).toBeNull() // all-zero counts as no data
  })
  test("watermarkLevel: soft/hard/force boundaries (inclusive lower bounds)", () => {
    const t = { soft: 60_000, hard: 80_000, force: 100_000 }
    expect(watermarkLevel(59_999, t)).toBe("ok")
    expect(watermarkLevel(60_000, t)).toBe("soft")
    expect(watermarkLevel(80_000, t)).toBe("hard")
    expect(watermarkLevel(100_000, t)).toBe("force")
  })
  test("thresholdsOf: defaults 60k/80k/100k", () => {
    expect(thresholdsOf(undefined)).toEqual({ soft: 60_000, hard: 80_000, force: 100_000 })
  })
})

// [2026-09-05]-[v1 read budget: budgetGateDecision matrix replaces the readGateDecision nudge tests — the gate is
//  deterministic per call (the alreadyNudged coupon is gone) and always-on from turn 1; watermarks keep only
//  lifecycle duties (hard/force = wrap-up deny)]
describe("context-watch: read-budget gate decisions", () => {
  const RB = 1500
  const estOf = (totalTokens: number, hasLimit: boolean, suggestedLimit = 200, offset = 1) => ({
    totalTokens, tokensPerLine: 7.5, suggestedLimit, hasLimit, requestedLimit: hasLimit ? 300 : undefined, offset,
  })
  test("ok level: reads under budget pass; over-budget reads are capped (no limit) or denied (limit set); un-estimable read-class fails open; non-read-class passes", () => {
    expect(budgetGateDecision({ tool: "read", level: "ok", readBudget: RB, turnUsed: 0, est: estOf(400, false) })).toBe("allow")
    expect(budgetGateDecision({ tool: "read", level: "ok", readBudget: RB, turnUsed: 0, est: estOf(4000, false) })).toBe("cap")
    expect(budgetGateDecision({ tool: "read", level: "ok", readBudget: RB, turnUsed: 0, est: estOf(4000, true) })).toBe("deny-budget")
    expect(budgetGateDecision({ tool: "glob", level: "ok", readBudget: RB, turnUsed: 0, est: null })).toBe("allow")
    expect(budgetGateDecision({ tool: "grep", level: "ok", readBudget: RB, turnUsed: 0 })).toBe("allow")
    for (const tool of ["edit", "write", "webfetch", "task"]) {
      expect(budgetGateDecision({ tool, level: "ok", readBudget: RB, turnUsed: 0 })).toBe("allow")
    }
  })
  test("ok/soft: plain bash (incl. cat) passes and is charged post-hoc, not pre-denied", () => {
    expect(budgetGateDecision({ tool: "bash", level: "ok", readBudget: RB, turnUsed: 0, bashCommand: "cat src/index.ts" })).toBe("allow")
    expect(budgetGateDecision({ tool: "bash", level: "soft", readBudget: RB, turnUsed: 0, bashCommand: "cat src/index.ts" })).toBe("allow")
    expect(budgetGateDecision({ tool: "bash", level: "soft", readBudget: RB, turnUsed: 0 })).toBe("allow") // no command text → fail-open at ok/soft
  })
  test("verification bash (delivery git + test/lint/build) passes at EVERY tier", () => {
    for (const level of ["ok", "soft", "hard", "force"] as const) {
      expect(budgetGateDecision({ tool: "bash", level, readBudget: RB, turnUsed: 0, bashCommand: "bun test test/foo.test.ts" })).toBe("allow")
      expect(budgetGateDecision({ tool: "bash", level, readBudget: RB, turnUsed: 0, bashCommand: "git add -A && git commit -m x && git push" })).toBe("allow")
      expect(budgetGateDecision({ tool: "bash", level, readBudget: RB, turnUsed: 0, bashCommand: "git diff HEAD~1" })).toBe("allow")
    }
  })
  test("archaeology git denied at ALL tiers (context bomb is a context bomb at 10k or 90k); scoped forms pass", () => {
    for (const level of ["ok", "soft", "hard", "force"] as const) {
      expect(budgetGateDecision({ tool: "bash", level, readBudget: RB, turnUsed: 0, bashCommand: "git log -p" })).toBe("deny-archaeology")
      expect(budgetGateDecision({ tool: "bash", level, readBudget: RB, turnUsed: 0, bashCommand: "git diff main..dev" })).toBe("deny-archaeology")
      expect(budgetGateDecision({ tool: "bash", level, readBudget: RB, turnUsed: 0, bashCommand: "git blame src/foo.ts" })).toBe("deny-archaeology")
    }
    expect(budgetGateDecision({ tool: "bash", level: "ok", readBudget: RB, turnUsed: 0, bashCommand: "git log -n 20 --oneline" })).toBe("allow")
    expect(budgetGateDecision({ tool: "bash", level: "ok", readBudget: RB, turnUsed: 0, bashCommand: "git log -p -3" })).toBe("allow")
    expect(budgetGateDecision({ tool: "bash", level: "ok", readBudget: RB, turnUsed: 0, bashCommand: "git diff main..dev --stat" })).toBe("allow")
    expect(budgetGateDecision({ tool: "bash", level: "ok", readBudget: RB, turnUsed: 0, bashCommand: "git blame -L 1,30 src/foo.ts" })).toBe("allow")
    expect(budgetGateDecision({ tool: "bash", level: "ok", readBudget: RB, turnUsed: 0, bashCommand: "git log -p | head -100" })).toBe("allow")
  })
  test("hard/force: read-class always denied (wrap-up) even under budget; non-verification bash denied; no command text fails closed", () => {
    for (const level of ["hard", "force"] as const) {
      expect(budgetGateDecision({ tool: "read", level, readBudget: RB, turnUsed: 0, est: estOf(100, false) })).toBe("deny-hard")
      expect(budgetGateDecision({ tool: "glob", level, readBudget: RB, turnUsed: 0 })).toBe("deny-hard")
      expect(budgetGateDecision({ tool: "bash", level, readBudget: RB, turnUsed: 0, bashCommand: "cat src/index.ts" })).toBe("deny-hard")
      expect(budgetGateDecision({ tool: "bash", level, readBudget: RB, turnUsed: 0 })).toBe("deny-hard")
    }
  })
  test("per-turn cap: 2x budget denies further reads until the next user turn", () => {
    expect(budgetGateDecision({ tool: "read", level: "ok", readBudget: RB, turnUsed: 2999, est: estOf(400, false) })).toBe("allow")
    expect(budgetGateDecision({ tool: "read", level: "ok", readBudget: RB, turnUsed: 3000, est: estOf(400, false) })).toBe("deny-turn")
    expect(budgetGateDecision({ tool: "glob", level: "ok", readBudget: RB, turnUsed: 3000 })).toBe("deny-turn")
  })
  test("readBudgetOf: default 1500, clamped to [200, 20000]", () => {
    expect(readBudgetOf(undefined)).toBe(1500)
    expect(readBudgetOf({})).toBe(1500)
    expect(readBudgetOf({ readBudgetTokens: 100 })).toBe(200)
    expect(readBudgetOf({ readBudgetTokens: 99999 })).toBe(20000)
    expect(readBudgetOf({ readBudgetTokens: 800 })).toBe(800)
    expect(readBudgetOf({ readBudgetTokens: Number.NaN })).toBe(1500)
  })
  test("turnBudgetOf: 2x read budget", () => {
    expect(turnBudgetOf(1500)).toBe(3000)
    expect(turnBudgetOf(800)).toBe(1600)
  })
  test("estimateReadRange: 64KB uniform sample math, limit/offset honored, density clamps, suggested limit clamps", () => {
    const sample = { path: "a.ts", bytes: 65536, sampleBytes: 65536, newlines: 1023 } // 64 B/line → 18.2857 tok/line
    const est = estimateReadRange(sample, undefined, 1500)
    expect(est.tokensPerLine).toBeCloseTo(18.2857, 3)
    expect(est.totalTokens).toBe(Math.ceil((64 / 3.5) * 1024))
    expect(est.suggestedLimit).toBe(82) // floor(1500/18.2857)
    expect(est.hasLimit).toBe(false)
    const bounded = estimateReadRange(sample, { limit: 100, offset: 1 }, 1500)
    expect(bounded.totalTokens).toBe(Math.ceil((64 / 3.5) * 100))
    expect(bounded.hasLimit).toBe(true)
    const offset = estimateReadRange(sample, { limit: 100, offset: 1000 }, 1500)
    expect(offset.totalTokens).toBe(Math.ceil((64 / 3.5) * 25)) // only 25 lines remain past offset 1000
    const truncated = estimateReadRange({ path: "b.ts", bytes: 700000, sampleBytes: 65536, newlines: 1023 }, undefined, 1500)
    expect(truncated.totalTokens).toBe(Math.ceil((64 / 3.5) * Math.ceil(700000 / 64)))
    const minified = estimateReadRange({ path: "c.js", bytes: 300000, sampleBytes: 65536, newlines: 0 }, undefined, 1500)
    expect(minified.tokensPerLine).toBe(20) // clamped high
    const empty = estimateReadRange({ path: "d.ts", bytes: 0, sampleBytes: 0, newlines: 0 }, undefined, 1500)
    expect(empty.tokensPerLine).toBe(7.5) // fallback
    expect(empty.totalTokens).toBe(8)
  })
  test("estimateOutputTokens: ceil(len/3.5)", () => {
    expect(estimateOutputTokens(0)).toBe(0)
    expect(estimateOutputTokens(350)).toBe(100)
    expect(estimateOutputTokens(351)).toBe(101)
  })
  test("READ_CLASS_TOOLS covers read/glob/grep/list", () => {
    for (const t of ["read", "glob", "grep", "list"]) expect(READ_CLASS_TOOLS.has(t)).toBe(true)
    expect(READ_CLASS_TOOLS.has("bash")).toBe(false)
  })
  test("isVerificationBash: delivery git/test/lint/build whitelist (wrap-up delivery not blocked); archaeology git excluded", () => {
    expect(isVerificationBash("git diff HEAD~1")).toBe(true)
    expect(isVerificationBash("git add -A && git commit -m x && git push")).toBe(true)
    expect(isVerificationBash("git reset --hard HEAD~1")).toBe(true)
    expect(isVerificationBash("git log -n 20")).toBe(true)
    expect(isVerificationBash("git blame -L 5,9 src/foo.ts")).toBe(true)
    expect(isVerificationBash("git log -p")).toBe(false)
    expect(isVerificationBash("git diff v1.0..v2.0")).toBe(false)
    expect(isVerificationBash("bun run build")).toBe(true)
    expect(isVerificationBash("npm publish")).toBe(true)
    expect(isVerificationBash("rg -n foo src/")).toBe(false)
    expect(isVerificationBash("pytest -x")).toBe(true)
    expect(isVerificationBash("echo hello && cat secret")).toBe(false)
    expect(isVerificationBash("curl -s https://x | head -100")).toBe(false)
  })
})

describe("gates: built-in subagent blocking", () => {
  const heads = (lane: string) => (lane === "economy" ? "glm-mx-53f-low" : lane === "main" ? "glm-mx-53f-high" : null)
  test("explore/general denied by default with a lane-matched redirect suggestion", () => {
    const d1 = builtinAgentDeny("explore", "deny", heads)
    expect(d1).toContain("explore")
    expect(d1).toContain("glm-mx-53f-low")
    const d2 = builtinAgentDeny("general", "deny", heads)
    expect(d2).toContain("glm-mx-53f-high")
  })
  test("allow mode restores passage; non-builtin names are not blocked", () => {
    expect(builtinAgentDeny("explore", "allow", heads)).toBeNull()
    expect(builtinAgentDeny("my-custom-agent", "deny", heads)).toBeNull()
  })
  test("empty chain appends banner guidance", () => {
    const d = builtinAgentDeny("explore", "deny", () => null)
    expect(d).toContain("[ROUTES]")
  })
})

describe("config: new behavior-section validation", () => {
  const base = { version: 1, providers: {}, extensions: {} }
  test("defaults: context 60/80/100k, gates on, builtinAgents deny, injection chain, floor 3000", () => {
    const { config, diagnostics } = validateUserConfig(base)
    expect(diagnostics.filter((d) => d.level === "error")).toEqual([])
    expect(config.context).toEqual({ gates: true, softTokens: 60_000, hardTokens: 80_000, forceTokens: 100_000, readBudgetTokens: 1_500, autoHandover: true })
    expect(config.builtinAgents.mode).toBe("deny")
    expect(config.injection.mode).toBe("chain")
    expect(config.rules.delegationFloor).toBe(3_000)
  })
  test("custom valid values pass through", () => {
    const { config } = validateUserConfig({ ...base, context: { softTokens: 30_000, hardTokens: 70_000, forceTokens: 90_000 }, injection: { mode: "all" }, rules: { delegationFloor: 1_500 } })
    expect(config.context.softTokens).toBe(30_000)
    expect(config.injection.mode).toBe("all")
    expect(config.rules.delegationFloor).toBe(1_500)
  })
  test("out-of-order/non-positive-integer watermarks revert the whole section to defaults with SWM037", () => {
    const r1 = validateUserConfig({ ...base, context: { softTokens: 80_000, hardTokens: 80_000, forceTokens: 100_000 } })
    expect(r1.config.context.softTokens).toBe(60_000)
    expect(r1.diagnostics.some((d) => d.code === "SWM037")).toBe(true)
    const r2 = validateUserConfig({ ...base, context: { softTokens: -1, hardTokens: 80_000, forceTokens: 100_000 } })
    expect(r2.config.context.softTokens).toBe(60_000)
  })
  test("bad enum values revert to defaults", () => {
    const r = validateUserConfig({ ...base, builtinAgents: { mode: "maybe" }, injection: { mode: 42 }, rules: { delegationFloor: "low" } })
    expect(r.config.builtinAgents.mode).toBe("deny")
    expect(r.config.injection.mode).toBe("chain")
    expect(r.config.rules.delegationFloor).toBe(3_000)
    expect(r.diagnostics.some((d) => d.code === "SWM037")).toBe(true)
  })
  test("dispatch.autoRedirect / relay.image: default true, bad values revert, valid values pass through", () => {
    const d = validateUserConfig(base)
    expect(d.config.dispatch.autoRedirect).toBe(true)
    expect(d.config.relay.image).toBe(true)
    const bad = validateUserConfig({ ...base, dispatch: { autoRedirect: "yes" }, relay: { image: 0 } })
    expect(bad.config.dispatch.autoRedirect).toBe(true)
    expect(bad.config.relay.image).toBe(true)
    expect(bad.diagnostics.some((x) => x.code === "SWM037")).toBe(true)
    const ok = validateUserConfig({ ...base, dispatch: { autoRedirect: false }, relay: { image: false } })
    expect(ok.config.dispatch.autoRedirect).toBe(false)
    expect(ok.config.relay.image).toBe(false)
    expect(ok.diagnostics.filter((x) => x.level === "error")).toEqual([])
  })
})

// [2026-09-04]-[autoRedirect fixtures: the deny-note candidate is also exposed as the redirect field (data source for
//  the index layer's silent redirection); the synthetic registry has zero state dependencies (no manifest/matrix reads),
//  and the deny copy and candidate are cross-checked against a same-parameter firstCandidate]
describe("gates: GateResult.redirect (autoRedirect)", () => {
  const glmShell: ShellRegEntry = {
    name: "glm-mx-glm53-high", pool: "glm", provider: "zhipuai-coding-plan", modelId: "glm-5.3",
    effort: "high", family: "glm", capability: "rw", vision: false,
    matrixKey: "zhipuai-coding-plan|glm-5.3|high", status: "enabled", comboKey: "zhipuai-coding-plan|glm-5.3|high",
  }
  const copilotShell: ShellRegEntry = {
    name: "copilot-mx-claude5-high", pool: "copilot", provider: "github-copilot", modelId: "claude-sonnet-5",
    effort: "high", family: "claude", capability: "rw", vision: false,
    matrixKey: "github-copilot|claude-sonnet-5|high", status: "enabled", comboKey: "github-copilot|claude-sonnet-5|high",
  }
  const LANES = { main: [glmShell.name, copilotShell.name] }
  const META = 'ROUTE_META {"lane":"main","role":"programmer","producer_family":"glm","capability":"rw","modality":"text","source":"auto"}'
  const registry = { [glmShell.name]: glmShell, [copilotShell.name]: copilotShell }
  const snap = (over: Partial<GateSnapshot> = {}): GateSnapshot & { lanes: Record<string, string[]> } => ({
    registry, matrix: null,
    routing: { down_agents: {}, down_expiry: {} },
    quotaExhausted: {}, routePolicy: { glm: { observe: true, routing: true }, copilot: { observe: true, routing: true }, deepseek: { observe: false, routing: true } },
    lanes: LANES, ...over,
  })
  const expectedCand = (s: GateSnapshot) =>
    firstCandidate("main", LANES.main, {
      registry, matrix: null, routing: s.routing, quotaExhausted: s.quotaExhausted, routePolicy: s.routePolicy,
    } as any, glmShell.name)

  test("gate 5 pool-exhausted deny → deny copy unchanged and redirect=candidate (same-source hint)", () => {
    const s = snap({ quotaExhausted: { glm: true, copilot: false, deepseek: false } })
    const r = checkShell(glmShell.name, glmShell, META, s)
    expect(r.deny).toContain("GLM plan exhausted")
    expect(r.deny).toContain(", redirect to ")
    expect(r.redirect).toBe(expectedCand(s))
    expect(r.redirect).toBe(copilotShell.name)
  })

  test("gate 1 user-agent name conflict deny → redirect=null (non-redirectable class)", () => {
    const s = snap({
      activation: { enabled: true, activeShells: new Set([glmShell.name, copilotShell.name]), conflicts: new Set([glmShell.name]), restartRequired: [] },
    })
    const r = checkShell(glmShell.name, glmShell, META, s)
    expect(r.deny).toContain("conflicts with a user-defined agent")
    expect(r.redirect).toBeNull()
  })

  test("gate 6 invalid META deny → redirect=null (index layer synthesizes META for redirection)", () => {
    const r = checkShell(glmShell.name, glmShell, "没有 META 的 prompt", snap()) // fixture: prompt without META
    expect(r.deny).toContain("invalid ROUTE_META")
    expect(r.redirect).toBeNull()
  })

  test("allow path has deny=null and redirect=null", () => {
    const r = checkShell(copilotShell.name, copilotShell, META, snap())
    expect(r.deny).toBeNull()
    expect(r.redirect).toBeNull()
  })
})
