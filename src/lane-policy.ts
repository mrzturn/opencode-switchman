// 六档基础链策略（v1.3 动态矩阵）：内置偏好序∩激活壳 → 按 lane 所需 effort/vision/ro 补齐
// [2026-08-29]-[静态 lanes 在动态模式下只是偏好序（引用未激活壳会被剔除）；
//  补齐按 lane 档位亲和度排序，纯函数确定性输出（同分按名称字典序）]
// computeLane（lane.ts）继续负责健康/熔断/水位/成本排序——本模块只产出 base 链。
import type { Lane } from "./types"
import { LANE_ORDER } from "./types"

export interface LaneShellAttr {
  effort: string
  capability: string
  vision: boolean
  pool: string
}

export interface LanePolicyInput {
  /** 内置偏好序（shells.json lanes；用户 options.lanes 优先级由调用方处理） */
  builtin: readonly string[]
  activeShells: ReadonlySet<string>
  shells: ReadonlyMap<string, LaneShellAttr>
  /** 补齐后链长上限（默认 4） */
  maxLen?: number
}

const LANE_SPEC: Record<Lane, { efforts: string[]; vision: boolean; ro: boolean }> = {
  economy: { efforts: ["low", "minimal", "off", "medium"], vision: false, ro: false },
  mechanical: { efforts: ["medium", "high", "low"], vision: false, ro: false },
  main: { efforts: ["high", "medium", "low"], vision: false, ro: false },
  hard: { efforts: ["xhigh", "max", "high", "medium"], vision: false, ro: false },
  vision: { efforts: ["high", "medium", "low"], vision: true, ro: false },
  review: { efforts: ["high", "max", "xhigh", "medium"], vision: false, ro: true },
}

/** 六档基础链＝内置偏好序∩激活壳 ＋ 激活壳按 lane 亲和度补齐 */
export function laneBaseChain(lane: Lane, input: LanePolicyInput): string[] {
  const spec = LANE_SPEC[lane] ?? LANE_SPEC.main
  const maxLen = input.maxLen ?? 4
  const out: string[] = []
  for (const name of input.builtin) {
    if (out.length >= maxLen) break
    if (input.activeShells.has(name) && !out.includes(name)) out.push(name)
  }
  if (out.length >= maxLen) return out
  const candidates: { name: string; score: number }[] = []
  for (const name of input.activeShells) {
    if (out.includes(name)) continue
    const attr = input.shells.get(name)
    if (!attr) continue
    if (spec.vision && !attr.vision) continue // vision 档硬过滤：非视觉壳不进
    const effIdx = spec.efforts.indexOf(attr.effort)
    const capPenalty = spec.ro ? (attr.capability === "ro" ? 0 : 1) : (attr.capability === "rw" ? 0 : 1)
    const visionBonus = spec.vision ? 0 : attr.vision ? 1 : 0 // 非视觉档文本优先（同分靠后）
    candidates.push({ name, score: (effIdx < 0 ? spec.efforts.length : effIdx) + capPenalty + visionBonus })
  }
  candidates.sort((a, b) => a.score - b.score || (a.name < b.name ? -1 : 1))
  for (const c of candidates) {
    if (out.length >= maxLen) break
    out.push(c.name)
  }
  return out
}

/** 全六档基础链（banner 一次性装配） */
export function laneBaseChains(input: Omit<LanePolicyInput, "builtin">, builtinLanes: Record<string, readonly string[]>): Record<Lane, string[]> {
  const out = {} as Record<Lane, string[]>
  for (const lane of LANE_ORDER) {
    out[lane] = laneBaseChain(lane, { ...input, builtin: builtinLanes[lane] ?? [] })
  }
  return out
}
