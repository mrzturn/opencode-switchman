// [2026-09-10]-[candidate surface widening: /modelRank //poolConfig lists read candidates (full superset) first, falling
//  back to the injection-face shells, then the bundled manifest; anchors the read path of shell-superset.json]
import { describe, expect, test, beforeAll, afterAll } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { paths } from "../src/state"
import { allModelRows } from "../src/config-cli"

process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-candcli-"))
const stateDir: string = process.env.SWITCHMAN_STATE
mkdirSync(stateDir, { recursive: true })

const entry = (modelId: string, name: string) => ({
  name, pool: "copilot", provider: "github-copilot", modelId, effort: "high",
  family: "openai", capability: "rw", vision: false, matrixKey: `github-copilot|${modelId}|high`,
})

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

afterAll(() => rmSync(stateDir, { recursive: true, force: true }))
