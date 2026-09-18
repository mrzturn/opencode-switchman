// [2026-09-10]-[candidate surface widening: /modelRank //poolConfig lists read candidates (full superset) first, falling
//  back to the injection-face shells, then the bundled manifest; anchors the read path of shell-superset.json]
import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { paths } from "../src/state"
import { allModelRows, rankViewRows, runCli } from "../src/config-cli"
import {
  writeCapabilityRank, clearCapabilityRank, loadCapabilityRank,
  writePoolConfig, resetPoolConfig,
} from "../src/user-overrides"

process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-candcli-"))
const stateDir: string = process.env.SWITCHMAN_STATE
mkdirSync(stateDir, { recursive: true })

const entry = (modelId: string, name: string) => ({
  name, pool: "copilot", provider: "github-copilot", modelId, effort: "high",
  family: "openai", capability: "rw", vision: false, matrixKey: `github-copilot|${modelId}|high`,
})

// console.log/error are swapped for the duration of each runCli call and restored in finally (output capture only)
function captureCli(argv: string[]): { code: number; out: string; err: string } {
  const out: string[] = []
  const err: string[] = []
  const origLog = console.log
  const origErr = console.error
  console.log = (msg?: unknown) => { out.push(String(msg)) }
  console.error = (msg?: unknown) => { err.push(String(msg)) }
  try {
    const code = runCli(argv)
    return { code, out: out.join("\n"), err: err.join("\n") }
  } finally {
    console.log = origLog
    console.error = origErr
  }
}

beforeAll(() => {
  // Pin the base-score source so tier/sort assertions do not drift with realtime capability data
  writeFileSync(join(stateDir, "capability.json"), JSON.stringify({ version: 1 }))
})

describe("allModelRows (candidate source precedence)", () => {
  test("candidates (full superset) take precedence over the pruned shells face", () => {
    writeFileSync(paths().shellSuperset, JSON.stringify({
      generated_at: new Date().toISOString(),
      counts: { superset_models: 3, shells: 1, full_shells: 3 },
      candidates: [entry("m1", "cp-mx-m1-high"), entry("m2", "cp-mx-m2-high"), entry("m3", "cp-mx-m3-high")],
      shells: [entry("m1", "cp-mx-m1-high")],
    }))
    const rows = allModelRows().map((r) => r.modelId).sort()
    expect(rows).toEqual(["m1", "m2", "m3"])
  })
  test("no candidates field (older file): falls back to the injection-face shells", () => {
    writeFileSync(paths().shellSuperset, JSON.stringify({
      generated_at: new Date().toISOString(),
      counts: { superset_models: 2, shells: 1 },
      shells: [entry("m1", "cp-mx-m1-high")],
    }))
    expect(allModelRows().map((r) => r.modelId)).toEqual(["m1"])
  })
  test("empty candidates array: treated as absent (falls back to shells, not to an empty list)", () => {
    writeFileSync(paths().shellSuperset, JSON.stringify({
      generated_at: new Date().toISOString(),
      candidates: [],
      shells: [entry("m2", "cp-mx-m2-high")],
    }))
    expect(allModelRows().map((r) => r.modelId)).toEqual(["m2"])
  })
  test("same modelId across provider pools dedupes to one row", () => {
    writeFileSync(paths().shellSuperset, JSON.stringify({
      generated_at: new Date().toISOString(),
      candidates: [
        entry("m1", "cp-mx-m1-high"),
        { ...entry("m1", "glm-mx-m1-high"), pool: "glm", provider: "zhipuai-coding-plan", matrixKey: `zhipuai-coding-plan|m1|high` },
      ],
      shells: [entry("m1", "cp-mx-m1-high")],
    }))
    expect(allModelRows().length).toBe(1)
  })
  test("broken superset file: falls back to the bundled manifest (non-empty, no throw)", () => {
    writeFileSync(paths().shellSuperset, "{ not json")
    expect(allModelRows().length).toBeGreaterThan(0)
  })
})

// [2026-09-18]-[rank universe = pool selection, dead keys pruned: rankViewRows shows EXACTLY the pool-selected universe
//  when one exists (dead manual keys are gone from the view AND from the rank file after any write — auto-prune in
//  writeCapabilityRank); with NO pool configured the view degenerates to the manual entries alone (cleanup-only) and
//  writes stay untouched. Fixtures reuse the file's shellSuperset helper; each test restores the default (unconfigured)
//  state in afterEach]-[impact: pins rankViewRows scoping + write-path auto-prune; no src change here]
describe("rankViewRows (pool-universe scoping)", () => {
  // loadSupersetShells requires a non-empty `shells` array even when `candidates` feeds the rows (src/state.ts)
  const supersetOnly = () => writeFileSync(paths().shellSuperset, JSON.stringify({
    generated_at: new Date().toISOString(),
    counts: { superset_models: 3, shells: 1, full_shells: 3 },
    candidates: [entry("glm-5.3", "cp-mx-glm53-high"), entry("kimi-k3", "cp-mx-kimik3-high"), entry("solo-model", "cp-mx-solo-high")],
    shells: [entry("glm-5.3", "cp-mx-glm53-high")],
  }))

  afterEach(() => {
    clearCapabilityRank()
    resetPoolConfig("main")
  })

  test("with a pool configured: EXACTLY the pool universe is listed; dead manual keys are absent from the view", () => {
    supersetOnly()
    writePoolConfig("main", ["glm-5.3", "kimi-k3"])
    writeCapabilityRank(["glm-5.3", "ghost-model"]) // dead key pruned on write (non-empty universe)
    const keys = rankViewRows().map((r) => r.key).sort()
    expect(keys).toEqual(["glm-5.3", "kimi-k3"])
    expect(keys).not.toContain("ghost-model") // dead manual key: no longer listed
    expect(keys).not.toContain("solo-model") // superset model in no pool and not manually ranked: absent
  })

  test("poolMember flags: every listed row is a pool member (true)", () => {
    supersetOnly()
    writePoolConfig("main", ["glm-5.3", "kimi-k3"])
    writeCapabilityRank(["glm-5.3"])
    const rows = rankViewRows()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((r) => r.poolMember === true)).toBe(true)
  })

  test("no pool configured: the view degenerates to the manual entries alone (cleanup-only, base rows filtered out)", () => {
    supersetOnly()
    writeCapabilityRank(["glm-5.3", "ghost-model"])
    resetPoolConfig("main") // universe empty
    const rows = rankViewRows()
    expect(rows.map((r) => r.key)).toEqual(["glm-5.3", "ghost-model"])
  })

  test("auto-prune on write: a legacy dead key (seeded stale file) converges away on the next rank add", () => {
    supersetOnly()
    writePoolConfig("main", ["glm-5.3", "kimi-k3"])
    // Seed a stale file bypassing the pruning writer (simulates a pre-existing rank file with dead entries)
    writeFileSync(paths().capabilityRank, JSON.stringify({
      version: 1,
      updated_at: "2026-09-17T00:00:00+0800",
      models: ["kimi-k3", "ghost-model"],
      scores: { "kimi-k3": { tier: "B", raw: 50 }, "ghost-model": { tier: "S", raw: 90 } },
    }))
    const { code } = captureCli(["rank", "add", "kimi-k3"])
    expect(code).toBe(0)
    expect(loadCapabilityRank()?.models).toEqual(["kimi-k3"]) // ghost-model pruned
    expect(loadCapabilityRank()?.scores?.["ghost-model"]).toBeUndefined() // its anchored score dropped too
    expect(loadCapabilityRank()?.scores?.["kimi-k3"]?.tier).toBe("B") // surviving score kept
  })

  test("auto-prune is gated on the universe: an empty-universe write stays untouched (cleanup path intact)", () => {
    supersetOnly()
    resetPoolConfig("main") // universe empty
    writeCapabilityRank(["ghost-model"])
    expect(loadCapabilityRank()?.models).toEqual(["ghost-model"]) // no prune, legacy cleanup still possible
  })
})

// [2026-09-18]-[rank CLI gating without a pool config: `rank list` guides to /poolConfig (exit 0); `rank set`/`add`
//  refuse with exit 1 ("no task-pool selection yet"); `rank remove` keeps working as the cleanup path against the
//  legacy manual entries]-[impact: pins runCli/cmdRank gating; no src change here]
describe("runCli rank gating (no pool configured)", () => {
  afterEach(() => {
    clearCapabilityRank()
    resetPoolConfig("main")
  })

  test("rank list prints the no-pool guidance (exit 0) and lists legacy entries as cleanup-only", () => {
    resetPoolConfig("main")
    writeCapabilityRank(["glm-5.3"])
    const { code, out } = captureCli(["rank", "list"])
    expect(code).toBe(0)
    expect(out).toContain("disabled until task pools are configured")
    expect(out).toContain("Legacy manual entries")
    expect(out).toContain("glm-5.3")
  })

  test("rank set / rank add refuse with exit 1 while no pool is configured", () => {
    resetPoolConfig("main")
    clearCapabilityRank()
    for (const sub of ["set", "add"] as const) {
      const { code, err } = captureCli(["rank", sub, "glm-5.3"])
      expect(code).toBe(1)
      expect(err).toContain("no task-pool selection yet")
    }
  })

  test("rank remove still works without a pool config (cleanup path resolves against legacy manual entries)", () => {
    resetPoolConfig("main")
    writeCapabilityRank(["glm-5.3", "ghost-model"])
    const { code } = captureCli(["rank", "remove", "ghost-model"])
    expect(code).toBe(0)
    expect(loadCapabilityRank()?.models).toEqual(["glm-5.3"])
  })
})

afterAll(() => rmSync(stateDir, { recursive: true, force: true }))
