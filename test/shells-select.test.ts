import { describe, expect, test } from "bun:test"
import { selectInjectableDefs } from "../src/shells"
import type { ShellDefinition } from "../src/catalog"

// [2026-09-02]-[上下文瘦身 fixture：注入面=六档链精选∪自定义 lane；空候选 fail-open 回退全量]
function def(name: string, modelId: string, capability: "rw" | "ro" = "rw"): ShellDefinition {
  return {
    name, provider: "github-copilot", modelId, pool: "copilot", family: "openai",
    effort: "high" as ShellDefinition["effort"], capability, vision: false,
    matrixKey: `github-copilot|${modelId}|high`,
  }
}
// m1=S(L5)、m2=B(L3)、m3=C(L2)：每模型 rw+ro 两面共 6 壳
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

describe("selectInjectableDefs（注入面精选）", () => {
  test("精选=六档链候选并集：模型间竞争裁掉落选面（m2/m3 的 ro 面）", () => {
    const picked = selectInjectableDefs(defs, opts).map((d) => d.name).sort()
    // main=[m2,m1] hard=[m1,m2] review=[m1-ro] economy=[m3,m2] mechanical=[m3,m2] → 并集 4/6
    expect(picked).toEqual(["cp-mx-m1-high", "cp-mx-m1-high-ro", "cp-mx-m2-high", "cp-mx-m3-high"])
    expect(picked.length).toBeLessThan(defs.length)
  })
  test("自定义 lane 引用壳强制保留", () => {
    const picked = selectInjectableDefs(defs, { ...opts, customLanes: { main: ["cp-mx-m2-high-ro"] } }).map((d) => d.name).sort()
    expect(picked).toContain("cp-mx-m2-high-ro")
    expect(picked).toContain("cp-mx-m1-high")
  })
  test("候选为空 fail-open 回退全量（防零注入死局）", () => {
    const ghost = { main: ["ghost"], hard: ["ghost"], review: ["ghost"], economy: ["ghost"], mechanical: ["ghost"], vision: ["ghost"] } as Record<string, readonly string[]>
    expect(selectInjectableDefs(defs, { ...opts, customLanes: ghost })).toEqual(defs)
  })
  test("[复审P2] capabilityOf 返回纯 number（旧兼容路径=L5 fail-open）：全部面升级为各级 primary，回退全量", () => {
    const numeric = selectInjectableDefs(defs, { capabilityOf: (m) => ({ m1: 1.0, m2: 0.8, m3: 0.6 }[m] ?? 0.5) }).map((d) => d.name).sort()
    expect(numeric).toEqual(defs.map((d) => d.name).sort())
  })
  test("空入参返回空", () => {
    expect(selectInjectableDefs([], opts)).toEqual([])
  })
})

describe("selectInjectableDefs（可用模型强制保留）", () => {
  test("[2026-09-02 修复] keepModels=可用全集：链竞争落选面/落选模型全部保留（注入面=可用全集语义）", () => {
    const all = new Set(defs.map((d) => `github-copilot/${d.modelId}`))
    expect(selectInjectableDefs(defs, { ...opts, keepModels: all }).map((d) => d.name).sort())
      .toEqual(defs.map((d) => d.name).sort())
  })
  test("keepModels 子集：只保留该模型全部面（含链外 ro 面），其余仍按链精选", () => {
    const kept = selectInjectableDefs(defs, { ...opts, keepModels: new Set(["github-copilot/m2"]) }).map((d) => d.name).sort()
    expect(kept).toContain("cp-mx-m2-high")
    expect(kept).toContain("cp-mx-m2-high-ro")
    expect(kept).not.toContain("cp-mx-m3-high-ro")
  })
})
