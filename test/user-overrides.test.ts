// [2026-09-04]-[English localization: translate test names and comments; synced the writePoolConfig error expectation with the translated src message; no test-logic change]
// User manual override layer fixture (bun test): manual capability ranking (baseScoreDynamic override) + task-pool selection (computeLane/gate 5.5).
// Sandbox: SWITCHMAN_STATE points to a temp dir; an empty capability.json pins the base score source so assertions do not drift with realtime data.
import { describe, test, expect, beforeAll } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-uo-"))
mkdirSync(process.env.SWITCHMAN_STATE, { recursive: true })
writeFileSync(
  join(process.env.SWITCHMAN_STATE, "capability.json"),
  JSON.stringify({ source: "artificial-analysis", version: "fixed-empty", fetched_at: Date.now() / 1000, thresholds: { S: 62, A: 55, B: 45 }, models: {} }),
)

import { baseScoreDynamic, manualRankResult, resetCapabilityCache } from "../src/capability"
import {
  validateCapabilityRank, loadCapabilityRank, writeCapabilityRank, clearCapabilityRank,
  validatePoolConfig, loadPoolConfig, poolAllowlist, writePoolConfig, resetPoolConfig, resetUserOverridesCache,
} from "../src/user-overrides"
import { computeLane } from "../src/lane"
import { checkShell } from "../src/gates"
import { paths } from "../src/state"
import type { ShellRegEntry } from "../src/types"

beforeAll(() => {
  resetCapabilityCache()
  resetUserOverridesCache()
})

function shellReg(over: Partial<ShellRegEntry> = {}): ShellRegEntry {
  return {
    name: "s", pool: "glm", provider: "zhipuai-coding-plan", modelId: "glm-5.3",
    effort: "high", family: "glm", capability: "rw", vision: false,
    matrixKey: "zhipuai-coding-plan|glm-5.3|high", comboKey: "zhipuai-coding-plan|glm-5.3|high",
    status: "enabled",
    ...over,
  } as ShellRegEntry
}

const REGISTRY: Record<string, ShellRegEntry> = {
  "glm-mx-glm-53-high": shellReg({ name: "glm-mx-glm-53-high", modelId: "glm-5.3", matrixKey: "zhipuai-coding-plan|glm-5.3|high", comboKey: "zhipuai-coding-plan|glm-5.3|high" }),
  "glm-mx-glm-53-flash-high": shellReg({ name: "glm-mx-glm-53-flash-high", modelId: "glm-5.3-flash", matrixKey: "zhipuai-coding-plan|glm-5.3-flash|high", comboKey: "zhipuai-coding-plan|glm-5.3-flash|high" }),
}
const BASE = Object.keys(REGISTRY)

// ---- File layer ----

describe("capability-rank.json (manual capability ranking)", () => {
  test("validation: dedupe/normalization, bad structure null", () => {
    expect(validateCapabilityRank(null)).toBeNull()
    expect(validateCapabilityRank({ models: "x" })).toBeNull()
    const v = validateCapabilityRank({ models: ["GLM-5.3", "glm-5.3", "  ", "ZhipuAI/GLM-5.3-Flash(x)"] })
    expect(v).not.toBeNull()
    expect(v!.models).toEqual(["glm-5.3", "glm-5.3-flash"]) // normalized keys (provider/variant parens stripped, dots kept)
  })

  test("write/read round-trip + cache invalidation", () => {
    writeCapabilityRank(["glm-5.3", "gpt-5.6"])
    const loaded = loadCapabilityRank()
    expect(loaded?.models).toEqual(["glm-5.3", "gpt-5.6"])
    expect(loaded?.updated_at.length).toBeGreaterThan(0)
    writeCapabilityRank(["kimi-k3"])
    expect(loadCapabilityRank()?.models).toEqual(["kimi-k3"])
  })

  test("baseScoreDynamic: manual ranking overrides the base capability score (curated S gpt-5.6 ranked after glm-5.3)", () => {
    writeCapabilityRank(["glm-5.3", "gpt-5.6"])
    const first = baseScoreDynamic("glm-5.3")
    const second = baseScoreDynamic("gpt-5.6")
    expect(first.source).toBe("manual")
    expect(first.tier).toBe("S")
    expect(first.score).toBe(1.0)
    expect(second.source).toBe("manual")
    // small-n ordinal ladder (n≤4: S/A/B/C in order): 2-item ranking's runner-up = A tier (rawScore still linear 100→0 preserving order)
    expect(second.rawScore).toBe(0)
    expect(second.tier).toBe("A")
    expect(second.score).toBe(0.85)
    expect(second.version!.startsWith("manual-")).toBe(true)
  })

  test("tier ladder: n=4 S/A/B/C in order; n≥5 back to the quantile semantics (top20% S)", () => {
    writeCapabilityRank(["m1", "m2", "m3", "m4"])
    expect(["m1", "m2", "m3", "m4"].map((m) => baseScoreDynamic(m).tier)).toEqual(["S", "A", "B", "C"])
    writeCapabilityRank(["m1", "m2", "m3", "m4", "m5"])
    // linear 100/75/50/25/0 + quantile thresholds 75/50/25 → S/S/A/B/C
    expect(["m1", "m2", "m3", "m4", "m5"].map((m) => baseScoreDynamic(m).tier)).toEqual(["S", "S", "A", "B", "C"])
  })

  test("prefix matching: a ranking entry covers its variants (gpt-5.6 → gpt-5.6-luna)", () => {
    writeCapabilityRank(["gpt-5.6"])
    const hit = manualRankResult("gpt-5.6-luna")
    expect(hit?.source).toBe("manual")
    expect(hit?.matchedAs).toBe("gpt-5.6")
    expect(hit?.tier).toBe("S")
  })

  test("manualRankResult: returns null on no hit (original fallback chain applies)", () => {
    writeCapabilityRank(["glm-5.3"])
    expect(manualRankResult("kimi-k3")).toBeNull()
    expect(manualRankResult("")).toBeNull()
  })

  test("unmatched models use the original fallback chain; after clear everything falls back to the curated table", () => {
    writeCapabilityRank(["glm-5.3", "gpt-5.6"])
    const untouched = baseScoreDynamic("claude-opus-5")
    expect(untouched.source).toBe("exact")
    expect(untouched.tier).toBe("S")
    clearCapabilityRank()
    expect(loadCapabilityRank()).toBeNull()
    expect(baseScoreDynamic("glm-5.3").source).toBe("exact")
  })
})

// ---- Task-pool selection (lane keys: economy/mechanical/main/hard/vision/review; the same model may repeat across pools) ----

describe("pool-config.json (task-pool selection)", () => {
  test("validation: unknown lane keys ignored, case normalized, empty list = unconfigured (fail-open)", () => {
    expect(validatePoolConfig(null)).toBeNull()
    const v = validatePoolConfig({ pools: { MAIN: ["GLM-5.3", "glm-5.3", " "], economy: [], nosuchpool: ["glm-5.3"], hard: ["gpt-5.6"] } })
    expect(v).not.toBeNull()
    expect(Object.keys(v!.pools).sort()).toEqual(["hard", "main"]) // unknown keys/empty lists dropped
    expect(v!.pools.main).toEqual(["glm-5.3"])
  })

  test("writePoolConfig: lanes independent, the same model may repeat; empty list = key deleted, back to default", () => {
    writePoolConfig("MAIN ", ["glm-5.3"]) // case/whitespace tolerant normalization
    expect(poolAllowlist("main")).not.toBeNull()
    writePoolConfig("economy", ["glm-5.3", "gpt-5.6"]) // the same model repeats across pools
    expect([...poolAllowlist("main")!]).toEqual(["glm-5.3"])
    expect([...poolAllowlist("economy")!]).toEqual(["glm-5.3", "gpt-5.6"])
    expect(poolAllowlist("hard")).toBeNull() // unconfigured lane = not filtered
    expect(() => writePoolConfig("nosuchpool", ["glm-5.3"])).toThrow(/unknown task pool/)
    expect(writePoolConfig("main", [])?.pools.main).toBeUndefined() // empty = key deleted, back to default
    expect(poolAllowlist("main")).toBeNull()
    expect([...poolAllowlist("economy")!]).toEqual(["glm-5.3", "gpt-5.6"]) // other lanes kept
    resetPoolConfig("economy")
    expect(loadPoolConfig()).toEqual({}) // all empty = file deleted
    expect(existsSync(paths().poolConfig)).toBe(false)
    resetPoolConfig("main") // idempotent: no error when the file no longer exists
  })

  test("computeLane: lane key isolation — main's selection filter applies, unconfigured economy unaffected", () => {
    writePoolConfig("main", ["glm-5.3"])
    const p = { registry: REGISTRY, matrix: null, routing: null, poolConfig: loadPoolConfig() }
    const main = computeLane("main", BASE, p)
    expect(main.chain.map((c) => c.shell)).toEqual(["glm-mx-glm-53-high"])
    expect(main.dropped).toContainEqual({ shell: "glm-mx-glm-53-flash-high", reason: "pool-config" })
    // economy unconfigured: nothing dropped for pool-config (tier-affinity trimming is unrelated; only verifying no selection reason)
    const economy = computeLane("economy", BASE, p)
    expect(economy.dropped.some((d) => d.reason === "pool-config")).toBe(false)
    expect(economy.chain.some((c) => c.shell === "glm-mx-glm-53-flash-high")).toBe(true)
  })

  test("computeLane: selection lists span provider pools (the same model may repeat)", () => {
    const copilotShell = shellReg({
      name: "copilot-mx-gpt-56-high", pool: "copilot", provider: "github-copilot", modelId: "gpt-5.6",
      family: "gpt", matrixKey: "github-copilot|gpt-5.6|high", comboKey: "github-copilot|gpt-5.6|high",
    })
    const reg = { ...REGISTRY, "copilot-mx-gpt-56-high": copilotShell }
    writePoolConfig("main", ["glm-5.3", "gpt-5.6"])
    const r = computeLane("main", [...BASE, "copilot-mx-gpt-56-high"], {
      registry: reg, matrix: null, routing: null, poolConfig: loadPoolConfig(),
    })
    // cross-pool mixed selection: glm and copilot shells both selected
    expect(r.chain.map((c) => c.shell)).toEqual(["glm-mx-glm-53-high", "copilot-mx-gpt-56-high"])
    expect(r.dropped).toContainEqual({ shell: "glm-mx-glm-53-flash-high", reason: "pool-config" })
  })

  test("computeLane: without poolConfig (absent) no filtering — fail-open compatible with old callers", () => {
    writePoolConfig("main", ["glm-5.3"])
    const r = computeLane("main", BASE, { registry: REGISTRY, matrix: null, routing: null })
    expect(r.chain.length).toBe(2)
  })

  test("gate 5.5: not-selected shells are denied with task-pool selection copy and redirect hint; the hint never recommends non-selected models", () => {
    writePoolConfig("main", ["glm-5.3"])
    const snap = {
      registry: REGISTRY,
      matrix: null,
      routing: null,
      quotaExhausted: {},
      lanes: { main: BASE },
      poolConfig: loadPoolConfig(),
    }
    const deny = checkShell("glm-mx-glm-53-flash-high", REGISTRY["glm-mx-glm-53-flash-high"], 'ROUTE_META {"lane":"main","role":"programmer","producer_family":"glm","capability":"rw","modality":"text","source":"auto"}', snap)
    expect(deny.deny).toContain("main task-pool selection list") // produced by src/gates.ts (translated by the parallel workstream; expectation synced)
    expect(deny.deny).toContain("glm-mx-glm-53-high") // hint points at a selected model
    const allow = checkShell("glm-mx-glm-53-high", REGISTRY["glm-mx-glm-53-high"], 'ROUTE_META {"lane":"main","role":"programmer","producer_family":"glm","capability":"rw","modality":"text","source":"auto"}', snap)
    expect(allow.deny).toBeNull()
  })

  test("config file paths land in the state directory", () => {
    expect(paths().poolConfig.endsWith("pool-config.json")).toBe(true)
    expect(paths().capabilityRank.endsWith("capability-rank.json")).toBe(true)
  })
})
