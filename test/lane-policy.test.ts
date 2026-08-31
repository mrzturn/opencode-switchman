import { describe, expect, test } from "bun:test"
import { computeLaneChain } from "../src/lane-policy"
import { loadManifest } from "../src/state"
import { baseScoreFromCapabilityIndex, loadBundledCapability } from "../src/capability"
import { baseScore } from "../src/model-ranks"
import { BILLING_API_BOOST } from "../src/scoring"
import { defaultBillingOf } from "../src/provider-config"

// [2026-08-31]-[去厂商化：DS 尾席预留/池名排序删除——api 计费与未知组经 billingBoost×unknownPenalty 沉底；
//  fixture 补 provider 字段 + 生成期同源解析器（出厂 billing + 能力分级 global=未知组）]
const shells = [
  { name: "cp-high", modelId: "cp", provider: "github-copilot", pool: "copilot", effort: "high", capability: "rw", vision: false, cost: 2 },
  { name: "cp-high-ro", modelId: "cp", provider: "github-copilot", pool: "copilot", effort: "high", capability: "ro", vision: false, cost: 2 },
  { name: "glm-high", modelId: "glm", provider: "zhipuai-coding-plan", pool: "glm", effort: "high", capability: "rw", vision: false, cost: 1 },
  { name: "glm-high-ro", modelId: "glm", provider: "zhipuai-coding-plan", pool: "glm", effort: "high", capability: "ro", vision: false, cost: 1 },
  { name: "ds-high", modelId: "ds", provider: "deepseek-api", pool: "deepseek", effort: "high", capability: "rw", vision: false, cost: 0 },
  { name: "ds-high-ro", modelId: "ds", provider: "deepseek-api", pool: "deepseek", effort: "high", capability: "ro", vision: false, cost: 0 },
  { name: "cp-medium", modelId: "cp-medium", provider: "github-copilot", pool: "copilot", effort: "medium", capability: "rw", vision: false },
  { name: "vision-high", modelId: "vision", provider: "zhipuai-coding-plan", pool: "glm", effort: "high", capability: "rw", vision: true },
  { name: "review-glm-rw", modelId: "review", provider: "zhipuai-coding-plan", pool: "glm", effort: "high", capability: "rw", vision: false },
  { name: "review-glm-ro", modelId: "review", provider: "zhipuai-coding-plan", pool: "glm", effort: "high", capability: "ro", vision: false },
  { name: "review-cp-rw", modelId: "review-cp", provider: "github-copilot", pool: "copilot", effort: "high", capability: "rw", vision: false },
  { name: "review-cp-ro", modelId: "review-cp", provider: "github-copilot", pool: "copilot", effort: "high", capability: "ro", vision: false },
] as const
const capability = (model: string) => ({ cp: 1, glm: 1, ds: 1, "cp-medium": 1, vision: 1, review: 1, "review-cp": 1 }[model] ?? 0)
const resolvers = { billingBoostOf: (provider: string) => defaultBillingOf(provider) === "subscription" ? 1.0 : BILLING_API_BOOST }

describe("候选链算法", () => {
  test("[终审P0-1] tier 分组主键：S/api(0.85) 不落 A/subscription(0.85) 之后（同亲和同乘积）", () => {
    const mix = [
      { name: "s-api", modelId: "s-api", provider: "deepseek-api", pool: "deepseek", effort: "high", capability: "rw", vision: false, cost: 9 },
      { name: "a-sub", modelId: "a-sub", provider: "github-copilot", pool: "copilot", effort: "high", capability: "rw", vision: false, cost: 0 },
    ]
    const cap = (id: string) => (id === "s-api" ? { score: 1.0, tier: "S" as const } : { score: 0.85, tier: "A" as const })
    // 乘积分：s-api=1.0×0.85=0.85 与 a-sub=0.85×1.0=0.85 打平——tier 分组使 S 恒先，成本(9>0)不得反超
    expect(computeLaneChain(mix, cap, "main", resolvers)).toEqual(["s-api", "a-sub"])
    // 未知组（0.75）只在同 tier 内沉底：B-unknown 仍先于 C-known（tier 主键不可逆）
    const tierMix = [
      { name: "b-unknown", modelId: "b-unknown", provider: "my-gateway", pool: "zen", effort: "high", capability: "rw", vision: false },
      { name: "c-known", modelId: "c-known", provider: "github-copilot", pool: "copilot", effort: "high", capability: "rw", vision: false },
    ]
    const cap2 = (id: string) => (id === "b-unknown" ? { score: 0.7, tier: "B" as const } : { score: 0.55, tier: "C" as const })
    expect(computeLaneChain(tierMix, cap2, "main", { unknownOf: (id) => id === "b-unknown" })).toEqual(["b-unknown", "c-known"])
  })
  test("六 lane 均由能力×亲和×结构门×计费系数生成，api 计费系数沉底（无预留席）", () => {
    // economy/mechanical/main：同分订阅壳挤掉 api 计费 ds——D3 尾席预留已废除，纯系数沉底
    expect(computeLaneChain(shells, capability, "economy", resolvers)).toEqual(["cp-medium", "glm-high", "cp-high", "review-cp-rw"])
    expect(computeLaneChain(shells, capability, "mechanical", resolvers)).toEqual(["cp-medium", "glm-high", "cp-high", "review-cp-rw"])
    expect(computeLaneChain(shells, capability, "main", resolvers)).toEqual(["glm-high", "cp-high", "review-cp-rw", "review-glm-rw"])
    expect(computeLaneChain(shells, capability, "hard", resolvers)).toEqual(["glm-high", "cp-high", "review-cp-rw", "review-glm-rw"])
    expect(computeLaneChain(shells, capability, "vision", resolvers)).toEqual(["vision-high"])
    expect(computeLaneChain(shells, capability, "review", resolvers)).toEqual(["glm-high-ro", "cp-high-ro", "review-cp-ro", "review-glm-ro"])
    // 双壳场景 ds 仍在链内（无竞争者时系数沉底不剔除）
    expect(computeLaneChain([shells[0], shells[4]], capability, "main", resolvers)).toEqual(["cp-high", "ds-high"])
  })
  test("未注入解析器时无计费偏置（纯能力×亲和×成本裁决）；订阅显式标记可反转 api 沉底", () => {
    // 无 resolvers：ds cost 0 → 同分时按成本裁决居前（无池名规则）
    expect(computeLaneChain(shells, capability, "economy")).toEqual(["cp-medium", "ds-high", "glm-high", "cp-high"])
    // 显式把 deepseek-api 标 subscription（1.0）后不再沉底，回到成本裁决序
    const flat = { billingBoostOf: () => 1.0 }
    expect(computeLaneChain(shells, capability, "economy", flat)).toEqual(["cp-medium", "ds-high", "glm-high", "cp-high"])
    expect(computeLaneChain([
      { name: "a", modelId: "a", pool: "glm", effort: "high", capability: "rw", vision: false, cost: 2 },
      { name: "b", modelId: "b", pool: "copilot", effort: "high", capability: "rw", vision: false, cost: 1 },
      { name: "c", modelId: "c", pool: "copilot", effort: "low", capability: "rw", vision: false },
    ], (id) => id === "c" ? 0.85 : 1, "main")).toEqual(["b", "a", "c"])
  })
  test("未知组惩罚：global 兜底模型同分场景排已知之后（unknownOf 解析器）", () => {
    const mix = [
      { name: "known", modelId: "glm", provider: "zhipuai-coding-plan", pool: "glm", effort: "high", capability: "rw", vision: false },
      { name: "mystery", modelId: "mystery", provider: "my-gateway", pool: "zen", effort: "high", capability: "rw", vision: false },
    ]
    expect(computeLaneChain(mix, () => 1, "main", { unknownOf: (id) => id === "mystery" })).toEqual(["known", "mystery"])
    expect(computeLaneChain(mix, () => 1, "main")).toEqual(["known", "mystery"]) // 同分按名称序兜底一致
  })
  test("生成清单六链与随包能力快照同源（含计费/未知组系数与 tier 分组），引用壳存在且 review 含 GLM ro 壳", () => {
    const manifest = loadManifest(); const bundled = loadBundledCapability()
    // 与 gen-shells 同源解析器：capabilityOf 返回 {score,tier}（tier 分组主键同源）
    const cap = (modelId: string) => baseScoreFromCapabilityIndex(modelId, bundled) ?? baseScore(modelId)
    const genResolvers = {
      billingBoostOf: (provider: string) => defaultBillingOf(provider) === "subscription" ? 1.0 : BILLING_API_BOOST,
      unknownOf: (modelId: string) => (baseScoreFromCapabilityIndex(modelId, bundled)?.source ?? baseScore(modelId).source) === "global",
    }
    for (const lane of ["economy", "mechanical", "main", "hard", "vision", "review"] as const) {
      const expected = computeLaneChain(manifest.shells, cap, lane, genResolvers)
      expect(manifest.lanes[lane]).toEqual(expected)
      expect(manifest.lanes[lane].every((name) => manifest.shells.some((shell) => shell.name === name))).toBe(true)
    }
    for (const lane of ["economy", "mechanical", "main", "hard", "vision"] as const) expect(computeLaneChain(shells, capability, lane, resolvers).every((name) => !name.endsWith("-ro"))).toBe(true)
    expect(computeLaneChain(shells, capability, "review", resolvers).every((name) => name.endsWith("-ro"))).toBe(true)
    expect(computeLaneChain(shells, capability, "review", resolvers)).toContain("glm-high-ro")
    for (const lane of ["economy", "mechanical", "main", "hard", "vision", "review"] as const) {
      const chain = computeLaneChain(shells, capability, lane, resolvers)
      expect(new Set(chain.map((name) => shells.find((shell) => shell.name === name)!.modelId)).size).toBeLessThanOrEqual(4)
      // api 计费沉底：同能力同亲和时 deepseek 壳排订阅壳之后（系数 0.85，非预留席）
      const ds = chain.findIndex((name) => shells.find((shell) => shell.name === name)!.pool === "deepseek")
      expect(ds < 0 || ds === chain.length - 1).toBe(true)
    }
    expect(manifest.lanes.review.every((name) => manifest.shells.find((shell) => shell.name === name)!.capability === "ro")).toBe(true)
  })
})
