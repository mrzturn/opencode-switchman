// 六档基础链策略：成员与顺序均由能力分×档位亲和×结构门算法生成。
// 运行期 computeLane 再叠加健康、熔断、水位与实时成本排序；本模块只产出候选基线。
// [2026-08-31]-[去厂商化：删 DS 链尾/尾席预留（池名规则废除），评分乘 billingBoost×unknownPenalty，
//  api 计费与未知组由系数自然沉底；系数经 LaneFactorResolvers 注入（生成期=出厂配置，运行期=用户 jsonc）]
import type { Lane } from "./types"
import { LANE_ORDER } from "./types"
import { TIER_RANK, UNKNOWN_PENALTY } from "./model-ranks"
import type { Tier } from "./model-ranks"

export interface LaneShellAttr {
  effort: string
  capability: string
  vision: boolean
  pool: string
  modelId?: string
  cost?: number | null
}

/** 能力分结果（tier 供分组排序主键；与 capability.DynamicBaseResult 形状同源） */
export interface CapabilityScore { score: number; tier: Tier | null; rawScore?: number }

export interface LanePolicyInput {
  /** 兼容旧调用形状；候选不再由该静态列表决定。 */
  builtin: readonly string[]
  activeShells: ReadonlySet<string>
  shells: ReadonlyMap<string, LaneShellAttr>
  /** 候选链长上限（默认 4） */
  maxLen?: number
  capabilityOf?: (modelId: string) => number | CapabilityScore
  /** [2026-08-31]-[去厂商化：计费/未知组系数解析器（缺省=全 1.0 的订阅已知口径）] */
  billingBoostOf?: (provider: string) => number
  unknownOf?: (modelId: string) => boolean
}

// [2026-08-29]-[评分引擎复用：导出 LANE_SPEC 序位供 scoring.effortFit 计算档位亲和度]
export const LANE_SPEC: Record<Lane, { efforts: string[]; vision: boolean; ro: boolean }> = {
  economy: { efforts: ["low", "minimal", "off", "medium"], vision: false, ro: false },
  mechanical: { efforts: ["medium", "high", "low"], vision: false, ro: false },
  main: { efforts: ["high", "medium", "low"], vision: false, ro: false },
  hard: { efforts: ["xhigh", "max", "high", "medium"], vision: false, ro: false },
  vision: { efforts: ["high", "medium", "low"], vision: true, ro: false },
  review: { efforts: ["high", "max", "xhigh", "medium"], vision: false, ro: true },
}

export interface LaneAlgorithmShell extends LaneShellAttr { name: string; modelId: string; provider?: string }

/** 计费/未知组系数解析器（billingBoostOf/unknownOf 缺省时的回退口径） */
export interface LaneFactorResolvers {
  billingBoostOf?: (provider: string) => number
  unknownOf?: (modelId: string) => boolean
}

/**
 * 生成期/运行期共用候选算法：结构门 → 每模型优先面 → tier 分组（能力档不可逆）→
 * 组内能力×亲和×视觉惩罚×billing×unknown 乘积分 → 成本/名称裁决。
 * [2026-08-31]-[终审P0-1：tier 分组主键与 rankCandidates 同源——api 计费 S 档（0.85）不得被
 *  A 档订阅（0.85）按成本/名称反超；unknownPenalty 只在同 tier 内沉底，不跨 tier 挤出候选]
 * effort/视觉惩罚沿用旧补齐器的「每级 +1」口径，以 1/(1+penalty) 转为乘积分。
 */
export function computeLaneChain(shells: readonly LaneAlgorithmShell[], capabilityOf: (modelId: string) => number | CapabilityScore, lane: Lane, resolvers: LaneFactorResolvers = {}): string[] {
  const spec = LANE_SPEC[lane] ?? LANE_SPEC.main
  const ranked = shells
    .filter((shell) => !spec.vision || shell.vision)
    .map((shell) => {
      const effort = spec.efforts.indexOf(shell.effort)
      const effortPenalty = effort < 0 ? spec.efforts.length : effort
      const visionPenalty = !spec.vision && shell.vision ? 1 : 0
      const billingBoost = resolvers.billingBoostOf && shell.provider !== undefined ? resolvers.billingBoostOf(shell.provider) : 1.0
      const unknownPenalty = resolvers.unknownOf?.(shell.modelId) ? UNKNOWN_PENALTY : 1.0
      const cap = capabilityOf(shell.modelId)
      const capScore = typeof cap === "number" ? cap : cap.score
      const tierRank = typeof cap === "number" ? 0 : (cap.tier ? TIER_RANK[cap.tier] : 0)
       return {
         shell,
         score: capScore / (1 + effortPenalty) / (1 + visionPenalty) * billingBoost * unknownPenalty,
         tierRank,
         rawScore: typeof cap === "number" ? undefined : cap.rawScore,
       }
    })
  // 每模型只留一个档位/面：普通 lane 优先 rw，review 优先 ro；无优先面时才允许另一面兜底。
  const preferred = spec.ro ? "ro" : "rw"
  ranked.sort((a, b) => Number(a.shell.capability !== preferred) - Number(b.shell.capability !== preferred) || b.score - a.score || (typeof a.shell.cost === "number" ? a.shell.cost : Infinity) - (typeof b.shell.cost === "number" ? b.shell.cost : Infinity) || a.shell.name.localeCompare(b.shell.name))
  const onePerModel = new Map<string, typeof ranked[number]>()
  for (const candidate of ranked) if (!onePerModel.has(candidate.shell.modelId)) onePerModel.set(candidate.shell.modelId, candidate)
  const ordered = [...onePerModel.values()]
    .sort((a, b) => {
       if (a.tierRank !== b.tierRank) return a.tierRank - b.tierRank
       if (b.score !== a.score) return b.score - a.score
       // tier 保证跨档不逆序；同档总分持平时再用真实能力指数，避免 S/A/B/C 离散化退化为名称排序。
       if (a.rawScore !== undefined || b.rawScore !== undefined) return (b.rawScore ?? -Infinity) - (a.rawScore ?? -Infinity)
      const ac = typeof a.shell.cost === "number" ? a.shell.cost : Number.POSITIVE_INFINITY
      const bc = typeof b.shell.cost === "number" ? b.shell.cost : Number.POSITIVE_INFINITY
      return ac - bc || a.shell.name.localeCompare(b.shell.name)
    })
  // [2026-08-31]-[去厂商化：删 DS 尾席预留——api/未知组已按系数同 tier 沉底，无预留席，纯分截断]
  return ordered.slice(0, 4).map(({ shell }) => shell.name)
}

/** 激活面候选链：忽略过时 static lanes，直接对当前壳全集重跑同一算法。 */
export function laneBaseChain(lane: Lane, input: LanePolicyInput): string[] {
  const candidates: LaneAlgorithmShell[] = []
  for (const name of input.activeShells) {
    const attr = input.shells.get(name)
    if (!attr) continue
    candidates.push({ name, ...attr, modelId: attr.modelId ?? name })
  }
  const resolvers: LaneFactorResolvers = { billingBoostOf: input.billingBoostOf, unknownOf: input.unknownOf }
  return computeLaneChain(candidates, input.capabilityOf ?? (() => 1), lane, resolvers).slice(0, input.maxLen ?? 4)
}

/** 全六档基础链（banner 一次性装配） */
export function laneBaseChains(input: Omit<LanePolicyInput, "builtin">, builtinLanes: Record<string, readonly string[]>): Record<Lane, string[]> {
  const out = {} as Record<Lane, string[]>
  for (const lane of LANE_ORDER) {
    out[lane] = laneBaseChain(lane, { ...input, builtin: builtinLanes[lane] ?? [] })
  }
  return out
}
