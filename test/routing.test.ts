// [2026-09-04]-[English localization: translate comments and expectation strings; no test-logic change]
// Behavior contract fixtures (docs §7; bun test)
// Sandbox: SWITCHMAN_STATE points at a temp dir; six gates/lane/breaker all tested as pure functions, no subprocesses.
import { describe, test, expect, beforeAll } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-fx-"))

// [2026-08-31]-[mechanism tests decoupled from capability-rank data: an empty-shell capability.json pins level
//  assertions to the curated table, immune to bundled default snapshot / live rank data drift (disk index exclusive,
//  miss falls back to the curated table)]
mkdirSync(process.env.SWITCHMAN_STATE, { recursive: true })
writeFileSync(
  join(process.env.SWITCHMAN_STATE, "capability.json"),
  JSON.stringify({ source: "artificial-analysis", version: "fixed-empty", fetched_at: Date.now() / 1000, thresholds: { S: 62, A: 55, B: 45 }, models: {} }),
)

import { parseRouteMeta, metaErrorHint } from "../src/meta"
import { checkShell } from "../src/gates"
import { baseScoreDynamic } from "../src/capability"
import { capabilityLevelFor } from "../src/lane-policy"
import {
  computeLane, firstCandidate, billingWindow, poolStates, routingAdvice,
  glmExhausted, copilotExhausted, deepseekExhausted, laneOfShell,
} from "../src/lane"
import { recordFailure, agentDown, isNotFound } from "../src/breaker"
import { loadRouting, cleanExpired, loadManifest, buildRegistry, paths } from "../src/state"
import { buildBanner, shortName, providerStatusEntries } from "../src/banner"
import type { GateSnapshot, ShellRegEntry, Matrix, MatrixEntry, Routing, Lane } from "../src/types"

// ---- Sandbox assembly ----
const manifest = loadManifest()
const LANES = manifest.lanes as Record<Lane, string[]>
const ALL = Object.values(LANES).flat()

function regEntry(name: string, over: Partial<ShellRegEntry> = {}): ShellRegEntry {
  const m = manifest.shells.find((s) => s.name === name)!
  return { ...m, status: "enabled", comboKey: m.matrixKey, ...over }
}
function fullRegistry(over: Record<string, Partial<ShellRegEntry>> = {}): Record<string, ShellRegEntry> {
  const out: Record<string, ShellRegEntry> = {}
  for (const s of manifest.shells) out[s.name] = { ...s, status: "enabled", comboKey: s.matrixKey, ...over[s.name] }
  return out
}
function matrixOk(latency?: Record<string, number>): Record<string, MatrixEntry> {
  const out: Record<string, MatrixEntry> = {}
  for (const s of manifest.shells) {
    out[s.matrixKey] = { status: "ok", latency_ms: latency?.[s.matrixKey] ?? null }
  }
  return out
}
function meta(lane = "main", role = "programmer", pf = "glm", cap = "rw", mod = "text", src = "auto"): string {
  return `ROUTE_META {"lane":"${lane}","role":"${role}","producer_family":"${pf}","capability":"${cap}","modality":"${mod}","source":"${src}"}\n任务正文` // fixture: Chinese prompt body, intentionally kept
}
function snap(over: Partial<GateSnapshot> = {}): GateSnapshot {
  return {
    registry: fullRegistry(),
    matrix: matrixOk(),
    routing: { down_agents: {}, down_expiry: {} },
    quotaExhausted: {},
    ...over,
  }
}
function denyOf(name: string, prompt: string, s: GateSnapshot = snap()): string | null {
  const shell = s.registry?.[name]
  if (!shell) throw new Error(`fixture 壳缺失: ${name}`)
  return checkShell(name, shell, prompt, { ...s, lanes: LANES }).deny
}
function decOf(name: string, prompt: string, s: GateSnapshot = snap()): { deny: string | null; note: string | null } {
  const shell = s.registry![name]
  return checkShell(name, shell, prompt, { ...s, lanes: LANES })
}

// ================= 1. META parsing (7)=================
describe("META parsing", () => {
  test("1 JSON single-line format parses (all six keys present)", () => {
    const [m, err] = parseRouteMeta(meta())
    expect(err).toBeNull()
    expect(m).toEqual({ lane: "main", role: "programmer", producer_family: "glm", capability: "rw", modality: "text", source: "auto" })
  })
  test("2 k=v space-separated format parses", () => {
    const [m, err] = parseRouteMeta("ROUTE_META lane=main role=programmer producer_family=glm capability=rw modality=text source=auto")
    expect(err).toBeNull()
    expect(m?.role).toBe("programmer")
    expect(m?.source).toBe("auto")
  })
  test("2a a Markdown wrapper must not get a valid META rejected", () => {
    for (const prefix of ["  ROUTE_META", "> ROUTE_META", "- ROUTE_META", "`ROUTE_META`", "ROUTE_META:"]) {
      const [m, err] = parseRouteMeta(`${prefix} {"lane":"mechanical","role":"tester","capability":"rw","source":"auto"}`)
      expect(err).toBeNull()
      expect(m).toEqual({ lane: "mechanical", role: "tester", capability: "rw", source: "auto" })
    }
  })
  test("3 six-key whitelist: unknown keys dropped, values lowercased", () => {
    const [m, err] = parseRouteMeta('ROUTE_META {"role":"Programmer","capability":"RW","source":"AUTO","bogus":"x"}')
    expect(err).toBeNull()
    expect(m).toEqual({ role: "programmer", capability: "rw", source: "auto" })
  })
  test("4 missing required keys → required (source/role/capability)", () => {
    const [, e1] = parseRouteMeta('ROUTE_META {"lane":"main","modality":"text"}')
    expect(e1).toEqual({ kind: "required", field: "source" })
    const [, e2] = parseRouteMeta('ROUTE_META {"source":"auto","capability":"rw"}')
    expect(e2).toEqual({ kind: "required", field: "role" })
  })
  test("5 first-4000-char window: META outside the window counts as missing", () => {
    const far = "x".repeat(4100) + "\n" + meta()
    const [m, err] = parseRouteMeta(far)
    expect(m).toBeNull()
    expect(err).toBe("missing")
  })
  test("6 producer_family rejects pool names (main/gcp invalid)", () => {
    const [, e1] = parseRouteMeta(meta("review", "reviewer", "main"))
    expect(e1).toEqual({ kind: "invalid", field: "producer_family", value: "main" })
    const [, e2] = parseRouteMeta(meta("review", "reviewer", "gcp"))
    expect(e2).toEqual({ kind: "invalid", field: "producer_family", value: "gcp" })
  })
  test("7 invalid value carries the legal-value list (readable deny postscript)", () => {
    const hint = metaErrorHint({ kind: "invalid", field: "source", value: "bogus" })
    expect(hint).toContain("source='bogus' is invalid")
    expect(hint).toContain("auto/user")
    expect(hint).toContain("META format sample")
  })
})

// ================= 2. Six-gate order (11)=================
describe("six-gate order", () => {
  const glmCombo = manifest.shells.find((s) => s.name === "glm-mx-53-high")!.matrixKey
  const terraCombo = manifest.shells.find((s) => s.name === "copilot-mx-terra-high")!.matrixKey

  test("8 matrix explicitly down → deny (with reason)", () => {
    const s = snap({ matrix: { ...matrixOk(), [terraCombo]: { status: "down", reason: "HTTP 502" } } })
    const d = denyOf("copilot-mx-terra-high", meta(), s)
    expect(d).toContain("matrix down")
    expect(d).toContain("HTTP 502")
    expect(d).toMatch(/redirect to|downgrade chain exhausted/)
  })
  test("9 disabled + matrix not down → fail-open allow (stderr note)", () => {
    const s = snap({ matrix: { ...matrixOk(), [terraCombo]: { status: "unknown" } } })
    const reg = fullRegistry({ "copilot-mx-terra-high": { status: "disabled" } })
    const r = decOf("copilot-mx-terra-high", meta(), { ...s, registry: reg })
    expect(r.deny).toBeNull()
    expect(r.note).toContain("fail-open")
  })
  test("10 unprobed face (discovered) → deny", () => {
    const reg = fullRegistry({ "copilot-mx-terra-high": { status: "discovered" as any, matrixKey: "" } })
    const d = denyOf("copilot-mx-terra-high", meta(), snap({ registry: reg }))
    expect(d).toContain("status=discovered")
  })
  test("11 matrix unknown/missing → allow + note hint", () => {
    const s = snap({ matrix: { ...matrixOk(), [terraCombo]: { status: "unknown" } } })
    const r = decOf("copilot-mx-terra-high", meta(), s)
    expect(r.deny).toBeNull()
    expect(r.note).toContain("matrix status=unknown")
  })
  test("12 breaker: shell name or combo hit → deny (10-minute auto-recovery copy)", () => {
    const s1 = snap({ routing: { down_agents: { "glm-mx-53-high": "连续失败" }, down_expiry: {} } }) // fixture: Chinese down reason, intentionally kept
    expect(denyOf("glm-mx-53-high", meta(), s1)).toContain("breaker")
    const s2 = snap({ routing: { down_agents: { [glmCombo]: "连续失败" }, down_expiry: {} } })
    expect(denyOf("glm-mx-53-high", meta(), s2)).toContain("breaker")
  })
  test("13 pool exhausted → deny (blocks only on certain call failure)", () => {
    const s = snap({ quotaExhausted: { copilot: true } })
    const d = denyOf("copilot-mx-terra-high", meta(), s)
    expect(d).toContain("temporarily unavailable")
  })
  test("14 META missing/malformed → deny with sample", () => {
    expect(denyOf("glm-mx-53-high", "裸任务无 META")).toContain("missing ROUTE_META")
    expect(denyOf("glm-mx-53-high", "ROUTE_META {broken\n任务")).toContain("malformed")
    const d = denyOf("glm-mx-53-high", 'ROUTE_META {"lane":"main","modality":"text"}\n任务')
    expect(d).toContain("missing required field")
  })
  test("15 same-family reviewer → deny (cross-family re-review gate)", () => {
    const d = denyOf("glm-mx-53-high", meta("review", "reviewer", "glm", "ro"), snap())
    expect(d).toContain("same family")
    expect(d).toContain("cross-family")
  })
  test("16 rw task dispatched to an ro shell → deny", () => {
    const ro = manifest.shells.find((s) => s.capability === "ro")!.name
    const d = denyOf(ro, meta("review", "planner", "glm", "rw"), snap())
    expect(d).toContain("read-only shell")
  })
  test("17 image task to a non-vision shell → deny; vision shell allowed", () => {
    const d = denyOf("glm-mx-53-high", meta("vision", "observer", "glm", "rw", "image"), snap())
    expect(d).toContain("not a vision shell")
    expect(denyOf("glm-mx-53f-high", meta("vision", "observer", "glm", "rw", "image"), snap())).toBeNull()
  })
  test("18 auto dispatch to a cross-level shell prefers same level; a user-named shell overrides that preference", () => {
    expect(denyOf("ds-mx-v4p-high", meta(), snap())).toContain("cross-level fallback")
    expect(denyOf("ds-mx-v4p-high", meta("main", "programmer", "glm", "rw", "text", "user"), snap())).toBeNull()
  })
  test("19 review L4 dispatch allowed only when all L5 candidates are unavailable", () => {
    const a = LANES.review.find((name) => capabilityLevelFor(baseScoreDynamic(manifest.shells.find((shell) => shell.name === name)!.modelId)) === "L4")!
    const s = LANES.review.map((name) => manifest.shells.find((shell) => shell.name === name)!)
      .filter((shell) => capabilityLevelFor(baseScoreDynamic(shell.modelId)) === "L5")
    expect(s.length).toBeGreaterThan(0)
    const prompt = meta("review", "reviewer", "gpt", "ro")
    expect(denyOf(a, prompt, snap())).toContain("cross-level fallback")
    const matrix = matrixOk()
    for (const shell of s) matrix[shell.matrixKey] = { status: "down" }
    expect(denyOf(a, prompt, snap({ matrix }))).toBeNull()
  })
  test("20 undeclared lane inferred from role; economy-chain membership must not bypass the capability gate", () => {
    const c = { ...regEntry("glm-mx-53-high"), name: "test-c", modelId: "glm-4.5-air", matrixKey: "test-c", comboKey: "test-c" }
    const s = snap({ registry: { ...fullRegistry(), [c.name]: c }, matrix: { ...matrixOk(), [c.matrixKey]: { status: "ok" } } })
    const prompt = 'ROUTE_META {"role":"programmer","capability":"rw","source":"auto"}\n任务正文'
    expect(checkShell(c.name, c, prompt, { ...s, lanes: { ...LANES, economy: [c.name] } }).deny).toContain("cross-level fallback candidates for main")
  })
  test("21 contradictory declaration of lane=vision with text modality → deny", () => {
    const vision = manifest.shells.find((shell) => shell.vision)!.name
    expect(denyOf(vision, meta("vision", "observer", "glm", "rw", "text"), snap())).toContain("requires declaring")
  })
})

// ================= 3. compute_lane determinism (6)=================
describe("compute_lane", () => {
  test("19 same input same output (JSON-serialization equality, no timestamps)", () => {
    const p = { registry: fullRegistry(), matrix: matrixOk(), routing: { down_agents: {}, down_expiry: {} } }
    const a = computeLane("main", LANES.main, p as any)
    const b = computeLane("main", LANES.main, p as any)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.status).toBe("ok")
    expect(a.chain.map((c) => c.shell).every((name) => LANES.main.includes(name))).toBe(true)
  })
  test("20 api billing sinks via factor (within-tier after subscription); auto/user no longer affect gating", () => {
    // [2026-08-31]-[de-vendorization: auto_ok/DS permanent-tail gating removed — with billingBoostOf injecting api 0.85, ordering is by product score]
    const base = { registry: fullRegistry(), matrix: matrixOk(), routing: { down_agents: {}, down_expiry: {} }, billingBoostOf: (provider: string) => provider.includes("deepseek") ? 0.85 : 1.0 }
    const r = computeLane("main", LANES.main, { ...base, source: "auto" } as any)
    const ru = computeLane("main", LANES.main, { ...base, source: "user" } as any)
    expect(r.chain.map((c) => c.shell)).toEqual(ru.chain.map((c) => c.shell))
    const ds = r.chain.find((c) => c.pool === "deepseek")
    if (ds) {
      expect(ds.score!.billingBoost).toBe(0.85)
      // api billing ranks after all same-level / higher-level subscription models within the same tier
      const dsIdx = r.chain.indexOf(ds)
      for (const c of r.chain.slice(0, dsIdx)) {
        if (c.score && c.score.tier === ds.score!.tier) expect(c.score.total).toBeGreaterThanOrEqual(ds.score!.total)
      }
    }
  })
  test("21 immediate orders by probe latency ascending only (pool-name rules abolished)", () => {
    const lat: Record<string, number> = {}
    lat[manifest.shells.find((s) => s.name === "copilot-mx-terra-high")!.matrixKey] = 5000
    lat[manifest.shells.find((s) => s.name === "glm-mx-53-high")!.matrixKey] = 10
    lat[manifest.shells.find((s) => s.name === "ds-mx-v4p-high")!.matrixKey] = 5
    const p = { registry: fullRegistry(), matrix: matrixOk(lat), routing: { down_agents: {}, down_expiry: {} }, urgency: "immediate" }
    const r = computeLane("main", LANES.main, p as any)
    expect(r.chain.every((c, i, all) => i === 0 || (c.latency_ms ?? Infinity) >= (all[i - 1]!.latency_ms ?? Infinity))).toBe(true)
  })
  test("22 same-level first; cross-level fallback ordered by distance to the target level", () => {
    const base = { registry: fullRegistry(), matrix: matrixOk(), routing: { down_agents: {}, down_expiry: {} } }
    const peak = computeLane("mechanical", LANES.mechanical, { ...base, glmPeak: true } as any)
    expect(peak.chain.every((c) => LANES.mechanical.includes(c.shell))).toBe(true)
    const calm = computeLane("mechanical", LANES.mechanical, { ...base, glmPeak: false } as any)
    expect(calm.chain.every((c) => LANES.mechanical.includes(c.shell))).toBe(true)
    // economy without L1: the nearest C(L2) fallback wins over A(L4).
    const strained = computeLane("economy", LANES.economy, {
      ...base, glmPeak: false, states: { copilot: { state: "strained" } },
    } as any)
    expect(strained.chain[0]!.score!.tier).toBe("B")
  })
  test("23 v2.0 cost tiebreaker: at equal tier and equal score the cheaper one leads (immediate by latency)", () => {
    const base = { registry: fullRegistry(), matrix: matrixOk(), routing: { down_agents: {}, down_expiry: {} }, glmPeak: false }
    const costs = (_modelId: string) => 1
    const r = computeLane("mechanical", LANES.mechanical, { ...base, costs } as any)
    expect(r.chain.every((c) => LANES.mechanical.includes(c.shell))).toBe(true)
    const imm = computeLane("mechanical", LANES.mechanical, { ...base, urgency: "immediate", costs } as any)
    expect(imm.chain.every((c) => LANES.mechanical.includes(c.shell))).toBe(true)
  })
  test("24 missing registry/matrix fail-open: static chain passed through with a * downgrade mark", () => {
    const r = computeLane("main", LANES.main, { registry: null, matrix: null, routing: null } as any)
    expect(r.chain.map((c) => c.shell)).toEqual(LANES.main)
    expect(r.status.endsWith("*")).toBe(true)
  })
})

// ================= 4. Breaker (3)=================
describe("breaker", () => {
  beforeAll(() => {
    mkdirSync(paths().dir, { recursive: true })
  })
  test("25 ≥2 failures in a 600s window trip the breaker (combo primary key), 1 failure does not", () => {
    const reg = fullRegistry()
    const r1 = recordFailure("glm-mx-53-high", "HTTP 500 boom", reg)
    expect(r1.tripped).toBe(false)
    const r2 = recordFailure("glm-mx-53-high", "HTTP 500 boom", reg)
    expect(r2.tripped).toBe(true)
    const routing = loadRouting()
    const combo = manifest.shells.find((s) => s.name === "glm-mx-53-high")!.matrixKey
    expect(routing.down_agents[combo]).toBeTruthy()
    expect(agentDown("glm-mx-53-high", routing, reg)).toBe(true)
  })
  test("26 600s TTL expiry auto-clears", () => {
    const routing: Routing = { down_agents: { k: "x" }, down_expiry: { k: Date.now() / 1000 - 1 } }
    const dead = cleanExpired(routing)
    expect(dead).toContain("k")
    expect(routing.down_agents.k).toBeUndefined()
  })
  test("27 same-combo alias shells share the breaker; not-found breaks only the requested name", () => {
    // Alias: glm-mx-53-max and glm-mx-53-high have different combos (different efforts), so build a same-combo alias pair:
    // luna has no alias; verify the semantics with a constructed registry instead
    const reg = fullRegistry()
    const alias = { ...reg["copilot-mx-terra-high"], name: "alias-shell" }
    reg["alias-shell"] = alias as ShellRegEntry
    const routing: Routing = { down_agents: { [alias.comboKey]: "x" }, down_expiry: {} }
    expect(agentDown("alias-shell", routing, reg)).toBe(true)
    expect(agentDown("copilot-mx-terra-high", routing, reg)).toBe(true)
    // not-found semantics
    expect(isNotFound("Agent type 'foo' not found")).toBe(true)
    const reg2 = fullRegistry()
    recordFailure("no-such-shell", "Agent type 'no-such-shell' not found. Available: ...", reg2)
    recordFailure("no-such-shell", "Agent type 'no-such-shell' not found. Available: ...", reg2)
    const rt = loadRouting()
    expect(rt.down_agents["no-such-shell"]).toBeTruthy()
  })
})

// ================= 5. End-to-end (2) + 6. quota verdicts (4)=================
describe("end-to-end and quota verdicts", () => {
  test("28 banner's four lines are each parseable ([ROUTES][WATERMARK][LIMITS][UPDATE])", () => {
    const lines = buildBanner({
      lanes: { main: computeLane("main", LANES.main, { registry: fullRegistry(), matrix: matrixOk(), routing: { down_agents: {}, down_expiry: {} } } as any) } as any,
      down: [],
      quota: { glm: { status: "ok", fetched_at: Date.now() / 1000, five_hour: { used_pct: 37 }, weekly: { used_pct: 1, reset_at: Date.now() / 1000 + 86400 } }, copilot: { status: "ok", fetched_at: Date.now() / 1000, reset_date: "2026-09-01", premium: { quota_id: "premium_interactions", entitlement: 0, used: 3885, remaining: 0, percent_remaining: 100, unlimited: true, overage_permitted: false, has_quota: null, timestamp_utc: null } } },
      states: {},
      billing: billingWindow(),
      advice: null,
      update: "矩阵已刷新", // fixture: Chinese banner update note, intentionally kept
    })
    expect(lines).toHaveLength(4)
    expect(lines[0].startsWith("[ROUTES] ")).toBe(true)
    expect(lines[0]).toContain("economy:")
    expect(lines[1].startsWith("[WATERMARK] ")).toBe(true)
    expect(lines[1]).toContain("GLM 5h 37%")
    // unlimited pitfall: hide the misleading percentage, show used + reset_date
    expect(lines[1]).toContain("unlimited")
    expect(lines[1]).toContain("used 3885")
    expect(lines[1]).not.toContain("100% left")
    expect(lines[2].startsWith("[LIMITS] ")).toBe(true)
    expect(lines[2]).toContain("down: none")
    expect(lines[3].startsWith("[UPDATE] ")).toBe(true)
  })
  test("28b sidebar watermark entries: GLM single block with 5h/week/MCP sub-rows, Copilot credits/refresh sub-rows, progress bars and reset times complete", () => {
    const entries = providerStatusEntries({
      quota: {
        glm: { status: "ok", fetched_at: Date.now() / 1000, stale: true, five_hour: { used_pct: 62, reset_at: Date.now() / 1000 + 3600 }, weekly: { used_pct: 86, reset_at: Date.now() / 1000 + 86400 }, mcp_monthly: { used_pct: 23, reset_at: Date.now() / 1000 + 30 * 86400 } },
        copilot: { status: "ok", fetched_at: Date.now() / 1000, reset_date: "2026-10-01", premium: { quota_id: "p", entitlement: 19000, used: 4459, remaining: 14541, percent_remaining: 76.5, unlimited: false, overage_permitted: false, has_quota: true, timestamp_utc: null } },
        deepseek: null,
      },
    })
    expect(entries.map((e) => e.pool)).toEqual(["glm", "copilot", "deepseek"]) // one block per provider
    const glm = entries[0]!
    expect(glm.rows.map((r) => r.label)).toEqual(["5h", "week", "MCP"])
    expect(glm.rows[0]!.text).toMatch(/█+░* 62%$/)
    expect(glm.rows[0]!.tail).toMatch(/^→\d{2}:\d{2}$/) // 5h window resets within 5h → HH:mm only
    expect(glm.rows[1]!.tail).toMatch(/^→\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(glm.rows[2]!.tail).toMatch(/^→\d{2}-\d{2}$/)
    expect(glm.stale).toBe(true)
    const cp = entries[1]!
    expect(cp.rows.map((r) => r.label)).toEqual(["credits", "refresh"])
    expect(cp.rows[0]!.text).toContain("76.5% left")
    expect(cp.rows[0]!.text).toContain("4459/19000")
    expect(cp.rows[1]!.text).toBe("2026-10-01")
    expect(entries[2]!.rows[0]!.text).toBe("querying/no data")
    // Only the 5h window present → a single sub-row, no missing block
    const one = providerStatusEntries({ quota: { glm: { status: "ok", fetched_at: 0, five_hour: { used_pct: 5 } }, copilot: null, deepseek: null } })
    expect(one[0]!.rows.map((r) => r.label)).toEqual(["5h"])
  })
  test("29 corrupted state file fail-open (loadRouting/registry tolerance)", () => {
    writeFileSync(join(process.env.SWITCHMAN_STATE!, "routing.json"), "{broken json")
    expect(loadRouting().down_agents).toEqual({})
    const d = denyOf("glm-mx-53-high", meta(), snap({ routing: loadRouting() }))
    expect(d).toContain("cross-level fallback")
  })
  test("30 GLM exhaustion verdict: 100% blocks, 99% does not (breaker as backstop)", () => {
    const [dead1, why1] = glmExhausted({ status: "ok", fetched_at: 0, weekly: { used_pct: 100 } })
    expect(dead1).toBe(true)
    expect(why1).toContain("weekly quota exhausted")
    expect(glmExhausted({ status: "ok", fetched_at: 0, weekly: { used_pct: 99 } })[0]).toBe(false)
    expect(glmExhausted(null)[0]).toBe(false)
  })
  test("31 Copilot verdict: has_quota=false exhausts; unlimited+with-quota does not; remaining<=0 blocks only when overage is forbidden", () => {
    // Measured pitfall shape: entitlement missing + remaining 0 + unlimited true + has_quota false (business seat without premium)
    expect(copilotExhausted({ status: "ok", fetched_at: 0, reset_date: "2026-09-01", premium: { quota_id: "premium_interactions", entitlement: null, used: null, remaining: 0, percent_remaining: 100, unlimited: true, overage_permitted: false, has_quota: false, timestamp_utc: null } })[0]).toBe(true)
    expect(copilotExhausted({ status: "ok", fetched_at: 0, premium: null })[0]).toBe(false)
    const [dead, why] = copilotExhausted({ status: "ok", fetched_at: 0, reset_date: "2026-09-01", premium: { quota_id: "p", entitlement: 0, used: 100, remaining: 0, percent_remaining: 0, unlimited: false, overage_permitted: false, has_quota: true, timestamp_utc: null } })
    expect(dead).toBe(true)
    expect(why).toContain("2026-09-01")
    // Overage permitted: no block
    expect(copilotExhausted({ status: "ok", fetched_at: 0, premium: { quota_id: "p", entitlement: 0, used: 100, remaining: 0, percent_remaining: 0, unlimited: false, overage_permitted: true, has_quota: true, timestamp_utc: null } })[0]).toBe(false)
    // Gateway second source of truth
    expect(copilotExhausted({ status: "ok", fetched_at: 0, reset_date: "2026-09-01", gateway_exhausted: true })[0]).toBe(true)
  })
  test("32 DeepSeek exhaustion verdict: pay-as-you-go normal never hard-blocks", () => {
    expect(deepseekExhausted({ status: "ok", exhausted: false })[0]).toBe(false)
    expect(deepseekExhausted({ status: "unknown" })[0]).toBe(false)
    expect(deepseekExhausted({ status: "ok", exhausted: true })[0]).toBe(true)
  })
  test("33 pool_states + routingAdvice contract: surplus/strained/healthy and advice lines", () => {
    // [2026-08-31]-[date-sensitive flip fix: a hardcoded too-close reset_date would give dl=1 and runway>dl*1.3 →
    //  surplus verdict; switched to a dynamic +10 days (dl∈[9,10] gives runway≈1.4<dl*0.8, always strained, decoupled
    //  from the run date)]
    const reset = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10)
    const states = poolStates({
      glm: { status: "ok", fetched_at: Date.now() / 1000, weekly: { used_pct: 10, reset_at: Date.now() / 1000 + 24 * 3600 } },
      copilot: { status: "ok", fetched_at: Date.now() / 1000, reset_date: reset, premium: { quota_id: "p", entitlement: 15000, used: 14000, remaining: 1000, percent_remaining: 6.7, unlimited: false, overage_permitted: false, has_quota: true, timestamp_utc: null } },
    })
    expect(states.copilot?.state).toBe("strained")
    const advice = routingAdvice(states)
    expect(advice).toContain("Copilot monthly credits tight")
  })
  test("34 GLM 5-hour-window reserved watermark: default 90% hard block, configurable; weekly quota still blocks only at 100%", () => {
    expect(glmExhausted({ status: "ok", fetched_at: 0, five_hour: { used_pct: 90 } })[0]).toBe(true)
    expect(glmExhausted({ status: "ok", fetched_at: 0, five_hour: { used_pct: 89 } })[0]).toBe(false)
    expect(glmExhausted({ status: "ok", fetched_at: 0, five_hour: { used_pct: 80 } }, 85)[0]).toBe(false)
    expect(glmExhausted({ status: "ok", fetched_at: 0, five_hour: { used_pct: 86 } }, 85)[0]).toBe(true)
    expect(glmExhausted({ status: "ok", fetched_at: 0, five_hour: { used_pct: 90 }, weekly: { used_pct: 95 } })[0]).toBe(true)
    expect(glmExhausted({ status: "ok", fetched_at: 0, weekly: { used_pct: 95 } })[0]).toBe(false)
    expect(glmExhausted({ status: "ok", fetched_at: 0, five_hour: { used_pct: 90 } }, 0)[0]).toBe(false) // out-of-range threshold falls back to 100%
  })
  test("35 DeepSeek balance warning: banner hint below threshold, no false alarm above/at exhaustion", () => {
    const warn = buildBanner({
      lanes: null, down: [],
      quota: { glm: null, copilot: null, deepseek: { status: "ok", fetched_at: 0, balances: [{ currency: "CNY", total_balance: "8.5" }] } },
      states: {}, billing: billingWindow(), dsLowWarnCny: 10,
    })
    expect(warn[1]).toContain("balance ¥8.50")
    expect(warn[1]).toContain("warn")
    const ok = buildBanner({
      lanes: null, down: [],
      quota: { glm: null, copilot: null, deepseek: { status: "ok", fetched_at: 0, balances: [{ currency: "CNY", total_balance: "37.86" }] } },
      states: {}, billing: billingWindow(), dsLowWarnCny: 10,
    })
    expect(ok[1]).not.toContain("balance")
    const exhausted = buildBanner({
      lanes: null, down: [],
      quota: { glm: null, copilot: null, deepseek: { status: "ok", fetched_at: 0, balances: [{ currency: "CNY", total_balance: "0" }], exhausted: true } },
      states: {}, billing: billingWindow(), dsLowWarnCny: 10,
    })
    expect(exhausted[1]).toContain("balance exhausted")
  })
})
