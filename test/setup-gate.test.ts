// [2026-09-19]-[setup hard gate fixture: evaluateSetup pure states + model-facing copy (deny message / [SETUP]
//  directive / sidebar brief) + the [LIMITS] banner setup-required segment + one index-level wiring test proving
//  the gate denies task with the setup message while unconfigured and opens by hot-reload once a complete setup is
//  seeded (mtime cache re-read, no restart). Style follows lang-config.test.ts / rank-move.test.ts; the wiring
//  group reuses the auto-redirect/pane-resume hermetic fixture pattern]
import { describe, expect, test, afterAll } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LANE_ORDER } from "../src/types"
import { evaluateSetup, setupDenyMessage, setupDirective, setupMissingBrief, setupCompletionNow } from "../src/setup-gate"
import { buildBanner, type BannerInput } from "../src/banner"

// ---- pure-function helpers ----

const poolSets = (spec: Record<string, string[]>): Record<string, ReadonlySet<string>> =>
  Object.fromEntries(Object.entries(spec).map(([k, v]) => [k, new Set(v)]))
const ALL_LANES_SET = Object.fromEntries(LANE_ORDER.map((lane) => [lane, ["fixture-m1"]]))

describe("evaluateSetup (pure completion states)", () => {
  test("null/null → incomplete, all 6 lanes missing, missingRank", () => {
    for (const c of [evaluateSetup(null, null), evaluateSetup(undefined, undefined)]) {
      expect(c.complete).toBe(false)
      expect(c.missingLanes).toEqual([...LANE_ORDER]) // LANE_ORDER order preserved
      expect(c.configuredLanes).toBe(0)
      expect(c.missingRank).toBe(true)
    }
  })

  test("partial lanes (main+hard set, no rank) → the other 4 lanes missing in LANE_ORDER order", () => {
    const c = evaluateSetup(poolSets({ main: ["m1"], hard: ["m1"] }), null)
    expect(c.complete).toBe(false)
    expect(c.missingLanes).toEqual(["economy", "mechanical", "vision", "review"])
    expect(c.configuredLanes).toBe(2)
    expect(c.missingRank).toBe(true)
  })

  test("all lanes set but rank empty/null → missingRank only", () => {
    for (const rank of [null, undefined, []]) {
      const c = evaluateSetup(poolSets(ALL_LANES_SET), rank)
      expect(c.complete).toBe(false)
      expect(c.missingLanes).toEqual([])
      expect(c.configuredLanes).toBe(6)
      expect(c.missingRank).toBe(true)
    }
  })

  test("complete state (all 6 lanes non-empty + rank ≥1) → complete", () => {
    const c = evaluateSetup(poolSets(ALL_LANES_SET), ["zz-setup-fixture-model"])
    expect(c.complete).toBe(true)
    expect(c.missingLanes).toEqual([])
    expect(c.configuredLanes).toBe(6)
    expect(c.missingRank).toBe(false)
  })

  test("an empty-Set lane counts as missing", () => {
    const c = evaluateSetup(poolSets({ ...ALL_LANES_SET, vision: [] }), ["zz-setup-fixture-model"])
    expect(c.complete).toBe(false)
    expect(c.missingLanes).toEqual(["vision"])
    expect(c.configuredLanes).toBe(5)
    expect(c.missingRank).toBe(false)
  })
})

describe("setupDenyMessage (model-facing deny copy)", () => {
  test("full-missing variant: BLOCKED header, all-6-pools phrasing, lane names, both slash commands, hot-reload", () => {
    const msg = setupDenyMessage(evaluateSetup(null, null))
    expect(msg).toContain("BLOCKED (setup required)")
    expect(msg).toContain(`task-pool selection for all ${LANE_ORDER.length} pools (${LANE_ORDER.join(", ")})`)
    for (const lane of LANE_ORDER) expect(msg).toContain(lane)
    expect(msg).toContain("capability ranking (at least one ranked model)")
    expect(msg).toContain("/switchman-setup")
    expect(msg).toContain("/switchman-setup-chat")
    expect(msg).toContain("hot-reload")
  })

  test("partial variant: lists only the missing pools, no all-6 phrasing, no rank clause when ranked", () => {
    const msg = setupDenyMessage(evaluateSetup(poolSets({ main: ["m1"], hard: ["m1"], economy: ["m1"], mechanical: ["m1"] }), ["m1"]))
    expect(msg).toContain("BLOCKED (setup required)")
    expect(msg).toContain("task-pool selection for pools: vision, review")
    expect(msg).not.toContain("all 6 pools")
    expect(msg).not.toContain("capability ranking")
  })
})

describe("setupDirective (system-prompt [SETUP] directive)", () => {
  test("partial 3/6 + rank missing → starts with [SETUP], carries the 3/6 fraction, HARD GATE and both commands", () => {
    const d = setupDirective(evaluateSetup(poolSets({ main: ["m1"], hard: ["m1"], economy: ["m1"] }), null))
    expect(d.startsWith("[SETUP]")).toBe(true)
    expect(d).toContain("task pools configured 3/6")
    expect(d).toContain("capability ranking missing")
    expect(d).toContain("HARD GATE")
    expect(d).toContain("/switchman-setup")
    expect(d).toContain("/switchman-setup-chat")
  })

  test("all lanes set, rank missing → no pools fraction, rank clause only", () => {
    const d = setupDirective(evaluateSetup(poolSets(ALL_LANES_SET), []))
    expect(d.startsWith("[SETUP]")).toBe(true)
    expect(d).toContain("capability ranking missing")
    expect(d).not.toContain("task pools configured")
  })
})

describe("setupMissingBrief (sidebar {missing} brief)", () => {
  test("partial + rank missing → 'pools 3/6, rank missing' shape", () => {
    expect(setupMissingBrief(evaluateSetup(poolSets({ main: ["m1"], hard: ["m1"], economy: ["m1"] }), null)))
      .toBe("pools 3/6, rank missing")
  })
  test("complete → empty brief; rank-only missing → 'rank missing'", () => {
    expect(setupMissingBrief(evaluateSetup(poolSets(ALL_LANES_SET), ["m1"]))).toBe("")
    expect(setupMissingBrief(evaluateSetup(poolSets(ALL_LANES_SET), null))).toBe("rank missing")
  })
})

// ---- [LIMITS] banner setup-required segment (limitLine is module-private → assert through buildBanner) ----

describe("banner limitLine setup-required segment", () => {
  const base: BannerInput = {
    lanes: null,
    down: [],
    quota: { glm: null, copilot: null },
    states: {},
    billing: { glmPeak: false, dsPeak: false, glmLabel: "GLM off-peak", dsLabel: "DS idle 50%" },
  }

  test("incomplete setup → line carries 'setup required: pools n/6', rank clause and the /switchman-setup remedy", () => {
    const lines = buildBanner({
      ...base,
      overrides: { rankModels: 0, poolLanes: 3, setup: { configuredLanes: 3, missingRank: true, complete: false } },
    })
    expect(lines[2]).toContain("setup required: pools 3/6")
    expect(lines[2]).toContain(", rank missing")
    expect(lines[2]).toContain("(/switchman-setup)")
    const rankOk = buildBanner({
      ...base,
      overrides: { rankModels: 0, poolLanes: 3, setup: { configuredLanes: 3, missingRank: false, complete: false } },
    })
    expect(rankOk[2]).toContain("setup required: pools 3/6")
    expect(rankOk[2]).not.toContain("rank missing")
  })

  test("complete or absent setup input → no setup-required segment", () => {
    const complete = buildBanner({
      ...base,
      overrides: { rankModels: 2, poolLanes: 6, setup: { configuredLanes: 6, missingRank: false, complete: true } },
    })
    expect(complete[2]).not.toContain("setup required")
    const absent = buildBanner(base)
    expect(absent[2]).not.toContain("setup required")
  })
})

// ---- index-level wiring: gate denies while unconfigured, opens by hot-reload after seeding ----

const prevState = process.env.SWITCHMAN_STATE
const prevConfigDir = process.env.OPENCODE_CONFIG_DIR
const stateDir = mkdtempSync(join(tmpdir(), "switchman-setupgate-state-"))
process.env.SWITCHMAN_STATE = stateDir
process.env.OPENCODE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "switchman-setupgate-cfg-"))
mkdirSync(stateDir, { recursive: true })
// lang-configured sandbox project: the setup gate only fires when the project language config exists
const projectDir = mkdtempSync(join(tmpdir(), "switchman-setupgate-proj-"))
mkdirSync(join(projectDir, ".switchman"), { recursive: true })
writeFileSync(join(projectDir, ".switchman", "settings.json"), JSON.stringify({ v: 1, configuredAt: "x", lang: { conversation: "en", comments: "en", docs: "en" } }))
// hermetic TTL seeds (same trick as routing/pane-resume): pre-seed every cache so no network is touched
writeFileSync(
  join(stateDir, "capability.json"),
  JSON.stringify({ source: "artificial-analysis", version: "fixed-empty", fetched_at: Date.now() / 1000, thresholds: { S: 62, A: 55, B: 45 }, models: {} }),
)
writeFileSync(join(stateDir, "model-catalog.json"), JSON.stringify({ fetched_at: Date.now(), etag: null, index: {} }))
for (const [file, body] of Object.entries({
  "model-matrix.json": {
    generated_at: new Date().toISOString(),
    combos: Object.fromEntries(loadManifest().shells.map((s) => [s.matrixKey, { status: "ok", latency_ms: 100, checked_at: new Date().toISOString() }])),
  },
  "costs.json": { scores: {}, fetched_at: Date.now() / 1000 },
  "selfupdate.json": { checked_at: new Date().toISOString(), mode: "prod", current: "0.0.0-test", latest: "0.0.0-test", outdated: false },
  "glm-quota.json": { status: "ok", fetched_at: Date.now() / 1000 },
  "copilot-quota.json": { status: "ok", fetched_at: Date.now() / 1000 },
  "ds-balance.json": { status: "ok", fetched_at: Date.now() / 1000 },
} as Record<string, unknown>)) {
  writeFileSync(join(stateDir, file), JSON.stringify(body))
}
afterAll(() => {
  if (prevState === undefined) delete process.env.SWITCHMAN_STATE
  else process.env.SWITCHMAN_STATE = prevState
  if (prevConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = prevConfigDir
})

import { SwitchmanPlugin } from "../src/index"
import { loadManifest } from "../src/state"
import { seedCompleteSetup, manifestModelUniverse } from "./setup-seed"

type Hooks = Awaited<ReturnType<typeof SwitchmanPlugin>>
const pluginInput = { client: { provider: { list: async () => [] } }, directory: projectDir } as any

async function makeHooks(): Promise<Hooks> {
  const hooks = await SwitchmanPlugin(pluginInput, { matrix: { mode: "legacy" } } as any)
  const cfg: Record<string, unknown> = {}
  await hooks.config!(cfg)
  return { ...hooks, _cfg: cfg } as any
}

/** task call with an unknown non-builtin agent: fail-open allowed once the setup gate is open (no other gates fire) */
async function runTask(hooks: Hooks, callID: string): Promise<void> {
  const output: any = { args: { subagent_type: "mystery-agent", prompt: "hello" } }
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "s-setup", callID } as any, output)
}

describe("setup gate wiring (index-level, hot-reload)", () => {
  let hooks: Hooks
  test("unconfigured + lang configured → task denied with the setup message", async () => {
    hooks = await makeHooks()
    expect(setupCompletionNow().complete).toBe(false)
    let msg = ""
    try {
      await runTask(hooks, "sg-deny")
    } catch (exc) {
      msg = String((exc as Error).message ?? exc)
    }
    expect(msg).toContain("BLOCKED (setup required)")
    expect(msg).toContain("all 6 pools")
  }, 20_000)

  test("seeding a complete setup opens the gate immediately on the same hooks instance (mtime hot-reload, no restart)", async () => {
    seedCompleteSetup(stateDir, manifestModelUniverse())
    expect(setupCompletionNow().complete).toBe(true)
    await runTask(hooks, "sg-allow") // no throw = gate open (unknown non-builtin agent is fail-open allowed)
  }, 20_000)
})
