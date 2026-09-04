import { describe, expect, test } from "bun:test"
import { selectInjectableDefs } from "../src/shells"
import type { ShellDefinition } from "../src/catalog"

// [2026-09-04]-[English localization: translate comments; no test-logic change]
// [2026-09-02]-[context-slimming fixtures: injection face = six-lane chain selection ∪ custom lanes; empty candidates fail-open back to the full set]
function def(name: string, modelId: string, capability: "rw" | "ro" = "rw"): ShellDefinition {
  return {
    name, provider: "github-copilot", modelId, pool: "copilot", family: "openai",
    effort: "high" as ShellDefinition["effort"], capability, vision: false,
    matrixKey: `github-copilot|${modelId}|high`,
  }
}
// m1=S(L5), m2=B(L3), m3=C(L2): each model has rw+ro faces, 6 shells total
const defs: ShellDefinition[] = [
  def("cp-mx-m1-high", "m1"),
  def("cp-mx-m1-high-ro", "m1", "ro"),
  def("cp-mx-m2-high", "m2"),
  def("cp-mx-m2-high-ro", "m2", "ro"),
  def("cp-mx-m3-high", "m3"),
  def("cp-mx-m3-high-ro", "m3", "ro"),
]
const tierOf: Record<string, "S" | "B" | "C"> = { m1: "S", m2: "B", m3: "C" }
const capabilityOf = (modelId: string) => ({ score: 1.0, tier: tierOf[modelId] })
const opts = { capabilityOf }

describe("selectInjectableDefs (injection-face selection)", () => {
  test("selection = union of six-lane chain candidates: inter-model competition drops losing faces (m2/m3 ro faces)", () => {
    const picked = selectInjectableDefs(defs, opts).map((d) => d.name).sort()
    // main=[m2,m1] hard=[m1,m2] review=[m1-ro] economy=[m3,m2] mechanical=[m3,m2] → union 4/6
    expect(picked).toEqual(["cp-mx-m1-high", "cp-mx-m1-high-ro", "cp-mx-m2-high", "cp-mx-m3-high"])
    expect(picked.length).toBeLessThan(defs.length)
  })
  test("shells referenced by custom lanes are force-kept", () => {
    const picked = selectInjectableDefs(defs, { ...opts, customLanes: { main: ["cp-mx-m2-high-ro"] } }).map((d) => d.name).sort()
    expect(picked).toContain("cp-mx-m2-high-ro")
    expect(picked).toContain("cp-mx-m1-high")
  })
  test("empty candidates fail-open back to the full set (prevents zero-injection deadlock)", () => {
    const ghost = { main: ["ghost"], hard: ["ghost"], review: ["ghost"], economy: ["ghost"], mechanical: ["ghost"], vision: ["ghost"] } as Record<string, readonly string[]>
    expect(selectInjectableDefs(defs, { ...opts, customLanes: ghost })).toEqual(defs)
  })
  test("[re-review P2] capabilityOf returning a plain number (legacy compat path = L5 fail-open): all faces upgraded to per-lane primaries, falls back to the full set", () => {
    const numeric = selectInjectableDefs(defs, { capabilityOf: (m) => ({ m1: 1.0, m2: 0.8, m3: 0.6 }[m] ?? 0.5) }).map((d) => d.name).sort()
    expect(numeric).toEqual(defs.map((d) => d.name).sort())
  })
  test("empty input returns empty", () => {
    expect(selectInjectableDefs([], opts)).toEqual([])
  })
})

describe("selectInjectableDefs (available-model force-keep)", () => {
  test("[2026-09-02 fix] keepModels = full available set: chain-losing faces/models all kept (injection face = available-set semantics)", () => {
    const all = new Set(defs.map((d) => `github-copilot/${d.modelId}`))
    expect(selectInjectableDefs(defs, { ...opts, keepModels: all }).map((d) => d.name).sort())
      .toEqual(defs.map((d) => d.name).sort())
  })
  test("keepModels subset: keeps only that model's faces (incl. off-chain ro faces), the rest still follow chain selection", () => {
    const kept = selectInjectableDefs(defs, { ...opts, keepModels: new Set(["github-copilot/m2"]) }).map((d) => d.name).sort()
    expect(kept).toContain("cp-mx-m2-high")
    expect(kept).toContain("cp-mx-m2-high-ro")
    expect(kept).not.toContain("cp-mx-m3-high-ro")
  })
})
