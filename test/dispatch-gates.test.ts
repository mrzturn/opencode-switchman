// [2026-09-04]-[English localization: translate comments and expectation strings; no test-logic change]
// [2026-09-04]-[dispatch-bias fix fixtures: session watermark gate (context-watch) + built-in subagent block (gates)
//  + new behavior-section checks (context/builtinAgents/injection/rules.delegationFloor)]
import { describe, expect, test } from "bun:test"
import {
  READ_CLASS_TOOLS, estimateContextTokens, thresholdsOf, watermarkLevel,
  isVerificationBash, readGateDecision,
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

describe("context-watch: read-gate decisions", () => {
  test("ok level allows everything", () => {
    for (const tool of ["read", "glob", "grep", "bash", "edit", "write"]) {
      expect(readGateDecision({ tool, level: "ok", alreadyNudged: false })).toBe("allow")
    }
  })
  test("soft: one-time nudge for read-class tools (allowed once nudged); edit/write/webfetch are not read-class and always allowed", () => {
    expect(readGateDecision({ tool: "read", level: "soft", alreadyNudged: false })).toBe("nudge")
    expect(readGateDecision({ tool: "read", level: "soft", alreadyNudged: true })).toBe("allow")
    expect(readGateDecision({ tool: "bash", level: "soft", alreadyNudged: false, bashCommand: "cat foo" })).toBe("nudge")
    expect(readGateDecision({ tool: "edit", level: "soft", alreadyNudged: false })).toBe("allow")
    expect(readGateDecision({ tool: "webfetch", level: "soft", alreadyNudged: false })).toBe("allow")
  })
  test("hard: read-class always denied; verification bash allowed, non-verification denied", () => {
    expect(readGateDecision({ tool: "read", level: "hard", alreadyNudged: true })).toBe("deny")
    expect(readGateDecision({ tool: "glob", level: "hard", alreadyNudged: false })).toBe("deny")
    expect(readGateDecision({ tool: "bash", level: "hard", bashCommand: "git status" })).toBe("allow")
    expect(readGateDecision({ tool: "bash", level: "hard", bashCommand: "bun test test/foo.test.ts" })).toBe("allow")
    expect(readGateDecision({ tool: "bash", level: "hard", bashCommand: "npm run typecheck" })).toBe("allow")
    expect(readGateDecision({ tool: "bash", level: "hard", bashCommand: "cat src/index.ts" })).toBe("deny")
    expect(readGateDecision({ tool: "bash", level: "hard" })).toBe("deny") // no command text → fail-closed
  })
  test("force matches hard (forced-compaction instructions are injected separately via the banner)", () => {
    expect(readGateDecision({ tool: "read", level: "force", alreadyNudged: true })).toBe("deny")
    expect(readGateDecision({ tool: "bash", level: "force", bashCommand: "bun test" })).toBe("allow")
  })
  test("READ_CLASS_TOOLS covers read/glob/grep/list", () => {
    for (const t of ["read", "glob", "grep", "list"]) expect(READ_CLASS_TOOLS.has(t)).toBe(true)
    expect(READ_CLASS_TOOLS.has("bash")).toBe(false)
  })
  test("isVerificationBash: git family/test/lint/build whitelist (wrap-up delivery not blocked)", () => {
    expect(isVerificationBash("git diff HEAD~1")).toBe(true)
    expect(isVerificationBash("git add -A && git commit -m x && git push")).toBe(true)
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
    expect(config.context).toEqual({ gates: true, softTokens: 60_000, hardTokens: 80_000, forceTokens: 100_000, autoHandover: true })
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
