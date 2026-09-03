// 六闸判定（顺序即优先级，任一命中即 deny）
// 纯函数：全部状态由 GateSnapshot 注入；deny=返回 reason（index.ts 层转 throw Error 阻断）。
import { META_LEGAL } from "./types"
import type { GateSnapshot, Meta, ShellRegEntry } from "./types"
import { metaErrorHint, parseRouteMeta } from "./meta"
import { computeLane, firstCandidate, laneOfShell } from "./lane"
import { baseScoreDynamic, normalizeModelKey } from "./capability"
import { isFallbackCandidate, isPrimaryCandidate } from "./lane-policy"

export interface GateResult { deny: string | null; note: string | null }

function matrixStatus(shell: ShellRegEntry, mcombos: GateSnapshot["matrix"]): [string, string] {
  if (!shell.matrixKey) return ["unprobed", ""]
  const entry = mcombos?.[shell.matrixKey] ?? ({} as any)
  const status = String(entry?.status ?? "").toLowerCase() || "missing"
  return [status, String(entry?.reason ?? "").slice(0, 80)]
}

const ROLE_LANE: Partial<Record<string, import("./types").Lane>> = {
  planner: "hard", reviewer: "review", programmer: "main", uiux: "main", "data-analyst": "main",
  tester: "mechanical", ops: "mechanical", scouter: "economy", clerk: "economy", observer: "vision",
  "expert-alpha": "review", "expert-beta": "review", "expert-gamma": "review", generic: "main",
}

function laneForCheck(shellName: string, meta: Meta | null, lanes: Record<string, string[]>): string {
  const lane = meta?.lane
  if (lane && (META_LEGAL.lane as readonly string[]).includes(lane)) return lane
  return ROLE_LANE[meta?.role ?? ""] ?? laneOfShell(shellName, lanes) ?? "main"
}

export function checkShell(
  agent: string,
  shell: ShellRegEntry,
  prompt: unknown,
  snap: GateSnapshot & { lanes: Record<string, string[]> },
): GateResult {
  const [meta, metaErr] = parseRouteMeta(prompt)
  const lane = laneForCheck(agent, meta, snap.lanes)
  const base = snap.lanes[lane] ?? []
  const regOk = snap.registry !== null

  const buildParams = (laneOverride?: string) => {
    const metaKw: Record<string, unknown> = {}
    if (meta?.producer_family) metaKw.producerFamily = meta.producer_family
    if (meta?.modality) metaKw.modality = meta.modality
    if (meta?.source) metaKw.source = meta.source
    if (meta?.capability) metaKw.capability = meta.capability
    return {
      registry: snap.registry,
      matrix: snap.matrix,
        routing: snap.routing,
        quotaExhausted: snap.quotaExhausted,
        routePolicy: snap.routePolicy,
      // [2026-08-31]-[去厂商化：deny 附言候选排序与横幅同源（billing/peak 系数）]
      billingBoostOf: snap.billingBoostOf,
      peakOf: snap.peakOf,
      // [2026-08-31]-[终审P1-3：deny 附言候选补足 water/costs/glmPeak/states 运行期输入]
      costs: snap.costs,
      water: snap.water,
      glmPeak: snap.glmPeak,
      states: snap.states,
      // [2026-09-03]-[deny 附言候选与任务池选配清单同源：hint 不推荐未入选模型]
      poolConfig: snap.poolConfig,
      ...metaKw,
      _lane: laneOverride,
    }
  }

  const hint = (laneOverride?: string): string => {
    let cand: string | null = null
    try {
      const p = buildParams() as any
      const useLane = (laneOverride ?? lane) as import("./types").Lane
      cand = firstCandidate(useLane, snap.lanes[useLane] ?? base, p, agent)
    } catch {
      cand = null
    }
    return cand ? `，请改派 ${cand}` : "，降级链已尽：向用户声明原因并给 2 个可选项"
  }

  // 闸1 注册表三态：enabled 唯一可派发；discovered=未探测面 deny；
  // disabled 按矩阵致因区分（down 才 deny，unknown/missing fail-open 放行+提示）
  // [2026-08-29]-[动态矩阵闸1 拆三层：同名冲突/未激活在本层 deny（未注入层由 index.ts denyUninjected）]
  const act = snap.activation
  if (act && act.enabled) {
    if (act.conflicts && act.conflicts.has(agent)) {
      return { deny: `${agent} 与用户自定义同名 agent 冲突，不可派发（请改名或删除自定义 agent）${hint()}`, note: null }
    }
    if (act.activeShells && !act.activeShells.has(agent)) {
      const restart = act.restartRequired.length > 0
        ? `；新 provider（${act.restartRequired.join("、")}）壳注册需重启 opencode`
        : ""
      return {
        // [2026-08-29]-[修复复审P2-文案口径：「实时」→「下一请求生效」（激活面变化对派发闸在下一次 tool 派发生效）]
        deny: `${agent} 未激活（模型不在当前激活矩阵：在模型管理设为可见/加入 favorites/主会话切到该模型即可激活，下一请求生效${restart}）${hint()}`,
        note: null,
      }
    }
  }
  const status = String(shell.status)
  if (status !== "enabled") {
    const [mstat, mreason] = snap.matrix !== null ? matrixStatus(shell, snap.matrix) : ["unknown", ""]
    if (status === "disabled" && snap.matrix !== null && mstat !== "down") {
      return {
        deny: null,
        note: `[opencode-switchman] ${agent} registry=disabled 但矩阵状态=${mstat || "missing"}（非 down）：fail-open 放行，探针下轮刷新后自动纠正`,
      }
    }
    return {
      deny: `${agent} 不可派发（registry status=${status}${snap.matrix !== null && mstat === "down" ? `，矩阵 ${mstat}：${mreason}` : ""}）${hint()}`,
      note: null,
    }
  }

  // 闸2 矩阵：只拦明确 down；unknown/缺项 fail-open 放行+提示
  if (snap.matrix !== null) {
    const [mstat, mreason] = matrixStatus(shell, snap.matrix)
    if (mstat === "down") {
      return { deny: `${agent} 不可用（矩阵 down，${mreason}）${hint()}`, note: null }
    }
    if (mstat === "unknown" || mstat === "missing" || mstat === "unprobed") {
      return { deny: null, note: `[opencode-switchman] ${agent} 矩阵状态=${mstat}（非 down）：不拦截，探针下轮刷新` }
    }
  }

  // 闸2.5：模型已退休（连续 404 永久移出候选，重启清空；仅 dynamic 注入 retiredModels）
  // [2026-08-29]-[失败分类：厂商无关，provider/modelId 命中即 deny，不再依赖池硬编码]
  if (snap.retiredModels?.has(`${shell.provider}/${shell.modelId}`)) {
    return { deny: `${agent} 不可用（模型已下线：连续 404，请改派其他候选）${hint()}`, note: null }
  }

  // 闸3：探针可用但实调失败的进程内隔离（不落盘，30 分钟/重启后恢复）
  if (shell.comboKey && snap.realFailedCombos?.has(shell.comboKey)) {
    return { deny: `${agent} 暂不可用（探针可用但实际委派失败，30 分钟后自动解锁或重启 opencode 恢复）${hint()}`, note: null }
  }

  // 闸4 熔断：down_agents 命中壳名或 comboKey（600s 窗 × 2 次）
  const down = snap.routing?.down_agents
  if (down && ((agent in down) || (shell.comboKey && shell.comboKey in down))) {
    return { deny: `${agent} 暂不可用（连续失败熔断中，约 10 分钟自动恢复）${hint()}`, note: null }
  }

  // 闸5 池耗尽（只认调用必失败；unknown/高水位不拦）
  const pool = shell.pool
  if (snap.quotaExhausted?.[pool] && snap.routePolicy?.[pool]?.routing !== false) {
    const why = pool === "glm"
      ? "GLM 套餐已用尽"
      : pool === "copilot" ? "Copilot 积分已耗尽" : "DeepSeek 余额已耗尽"
    return { deny: `${agent} 暂不可用（${why}）${hint()}`, note: null }
  }

  // 闸5.5 任务池选配（pool-config.json 手动配置）：lane→参与模型清单，清单存在且非空即压过
  // 系统默认候选集（同模型可重复进驻多个 lane）；未配置=fail-open 放行（该 lane 走系统默认）
  {
    const allow = snap.poolConfig?.[lane]
    if (allow && allow.size > 0 && !allow.has(normalizeModelKey(shell.modelId))) {
      return { deny: `${agent} 不在 ${lane} 任务池选配清单（/poolConfig 可调整各任务池参与模型，或改派其他候选）${hint()}`, note: null }
    }
  }

  // 闸6 ROUTE_META 硬闸：行缺失/格式坏/字段非法/安全字段缺失一律 deny 附样例+实时候选
  if (metaErr !== null) {
    const fallbackLane = laneForCheck(agent, null, snap.lanes)
    let fallback: string
    try {
      const c = firstCandidate(fallbackLane as import("./types").Lane, snap.lanes[fallbackLane] ?? [], buildParams() as any, agent)
      fallback = c ? `，请改派 ${c}` : "，降级链已尽：向用户声明原因并给 2 个可选项"
    } catch {
      fallback = "，降级链已尽：向用户声明原因并给 2 个可选项"
    }
    return {
      deny: `${agent} 为壳名派发，ROUTE_META 无效：${metaErrorHint(metaErr)}${fallback}`,
      note: null,
    }
  }
  const role = meta!.role

  // 闸7 语义校验
  if (role === "reviewer") {
    const pf = meta!.producer_family
    if (pf && pf === String(shell.family)) {
      return { deny: `${agent} 与 producer 同 family（${pf}），复审须异族视角${hint("review")}`, note: null }
    }
  }
  if (meta!.capability === "rw" && String(shell.capability) === "ro") {
    return { deny: `${agent} 为只读壳（ro），不接 rw 写任务${hint()}`, note: null }
  }
  if ((meta!.modality === "image" || meta!.modality === "vision") && !shell.vision) {
    return { deny: `${agent} 非视觉壳，不能承接 modality=${meta!.modality} 任务${hint("vision")}`, note: null }
  }
  if (lane === "vision" && meta!.modality === "text") {
    return { deny: `${agent} lane=vision 必须声明 image/vision modality${hint("vision")}`, note: null }
  }
  const capability = baseScoreDynamic(shell.modelId)
  if (!isPrimaryCandidate(lane as import("./types").Lane, capability) && !isFallbackCandidate(lane as import("./types").Lane, capability)) {
    return { deny: `${agent} 能力等级不足，不能承接 ${lane} 任务${hint()}`, note: null }
  }
  if (isFallbackCandidate(lane as import("./types").Lane, capability) && meta!.source !== "user") {
    let current
    try {
      current = computeLane(lane as import("./types").Lane, snap.lanes[lane] ?? base, buildParams() as any)
    } catch {
      return { deny: `${agent} 无法确认 ${lane} 跨级补位资格，为避免错误降级拒绝派发${hint()}`, note: null }
    }
    if (!current.chain.some((candidate) => candidate.shell === agent)) {
      return { deny: `${agent} 未入选 ${lane} 的前二跨级回退候选${hint()}`, note: null }
    }
    if (current.chain.some((candidate) => isPrimaryCandidate(lane as import("./types").Lane, baseScoreDynamic(snap.registry?.[candidate.shell]?.modelId ?? "")))) {
      return { deny: `${agent} 为 ${lane} 的跨级回退候选；当前仍有可用同级模型${hint()}`, note: null }
    }
  }
  // [2026-08-31]-[去厂商化：删 source=auto 误选按量池的硬 deny——api 计费由 billingBoost 乘积系数
  //  软排序兜底（同 tier 排订阅之后），deny 只保留 META 格式与 review 异族/ro/vision 结构门]
  return { deny: null, note: null }
}

/** 未注册/非壳名 → fail-open（unknown 内置代理不受路由管辖） */
export function noteUnknownAgent(agent: string): string {
  return `[opencode-switchman] unknown subagent_type='${agent}'：放行（不在壳清单，内置代理不受路由管辖）`
}

/** 壳命名形态判定（仅用于「未注入超集」deny 的形态识别；isShell 判定一律走注册表，禁启发式） */
export function shellLikeName(agent: string): boolean {
  return /^[a-z][a-z0-9]*-mx-[a-z0-9]+-[a-z]+(-ro)?$/.test(agent)
}

/** [2026-08-29]-[动态矩阵闸1 第一层：壳名形态但未注入超集 → deny（模型未开/无凭证/新增 provider 需重启）]
 *  [2026-09-02]-[注入面改为六档链精选（selectInjectableDefs），文案补「未入选精选」情形避免误导排查方向]
 *  [2026-09-02 修复]-[注入面语义改为「可用全集∪链精选」：可用模型已全量注入，未注入=provider 未连接/
 *  无凭证/非对话类，文案不再提「未入选精选」避免误导] */
export function denyUninjected(agent: string, restartRequired: string[], hint: string | null): string {
  const restart = restartRequired.length > 0
    ? `检测到超集外 provider（${restartRequired.join("、")}）：新增 provider 的壳注册需重启 opencode`
    : "若为新增 provider，壳注册需重启 opencode"
  return `${agent} 未注入壳超集（provider 未连接/无凭证/非对话模型；新增 provider 需重启 opencode）${restart}${hint ? `，${hint}` : ""}`
}
