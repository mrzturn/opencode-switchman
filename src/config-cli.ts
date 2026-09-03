// switchman-config CLI（随包资产，node/bun 直跑）：任务池选配与能力排名的读写入口。
// 供 /poolConfig-chat、/modelRank-chat 命令模板与 TUI 弹窗外的所有客户端使用；全部命令非交互。
// [2026-09-03]-[随任务池选配/手动排名两功能新增；[2026-09-03 语义修正]-[池=任务池 lane（非 provider 池），
//  选配各 lane 参与模型、同模型可重复进驻多个 lane]；退出码 0=成功 1=失败]
import { baseScoreDynamic, normalizeModelKey } from "./capability"
import { loadSupersetShells, loadManifest, paths } from "./state"
import {
  loadCapabilityRank, loadPoolConfig, poolAllowlist,
  writeCapabilityRank, clearCapabilityRank, writePoolConfig, resetPoolConfig,
} from "./user-overrides"
import { LANE_ORDER, type Lane } from "./types"
import { TIER_RANK } from "./model-ranks"

interface ModelRow { key: string; modelId: string; tier: string; source: string; raw: number | null }

function capabilityCompare(a: ModelRow, b: ModelRow): number {
  return TIER_RANK[a.tier as "S"] - TIER_RANK[b.tier as "S"] ||
    (b.raw ?? -Infinity) - (a.raw ?? -Infinity) ||
    a.key.localeCompare(b.key)
}

function toRow(modelId: string): ModelRow {
  const base = baseScoreDynamic(modelId)
  return {
    key: normalizeModelKey(modelId),
    modelId,
    tier: base.tier,
    source: base.source,
    raw: base.rawScore ?? null,
  }
}

/** 全部可用模型（超集清单优先，回退随包清单；跨 provider 池按 modelId 去重）；有效能力降序 */
export function allModelRows(): ModelRow[] {
  const shells = loadSupersetShells()?.shells ?? loadManifest().shells
  const seen = new Set<string>()
  const rows: ModelRow[] = []
  for (const s of shells) {
    const key = normalizeModelKey(s.modelId)
    if (!key || seen.has(key)) continue
    seen.add(key)
    rows.push(toRow(s.modelId))
  }
  rows.sort(capabilityCompare)
  return rows
}

function fmtRow(n: number, row: ModelRow, selected: boolean): string {
  const mark = selected ? "[x]" : "[ ]"
  const manualTag = row.source === "manual" ? "·手动排名" : ""
  return ` #${String(n).padStart(2, "0")} ${mark} ${row.modelId}（${row.tier}档${manualTag}）`
}

function laneOrThrow(lane?: string): Lane {
  const key = String(lane ?? "").trim().toLowerCase() as Lane
  if (!(LANE_ORDER as string[]).includes(key)) {
    throw new Error(`未知任务池：${lane ?? "（缺）"}（六任务池：${LANE_ORDER.join("/")}）`)
  }
  return key
}

function printPoolList(filterLane?: string): void {
  const rows = allModelRows()
  const allow = loadPoolConfig()
  const head = `任务池选配（配置文件 ${paths().poolConfig}；选配=参与该任务池的模型，同一模型可参与多个池，未配置的池由系统默认决策）`
  if (filterLane) {
    const lane = laneOrThrow(filterLane)
    const sel = allow[lane]
    console.log(head)
    console.log(`== ${lane} ==（${sel ? `手动选配 ${sel.size}/${rows.length} 参与模型` : "未配置：系统默认（全部可用模型参与）"}）`)
    rows.forEach((row, i) => console.log(fmtRow(i + 1, row, sel ? sel.has(row.key) : true)))
    return
  }
  console.log(head)
  for (const lane of LANE_ORDER) {
    const sel = allow[lane]
    console.log(`== ${lane} ==${sel ? ` 手动选配 ${sel.size} 模型：${[...sel].join("、")}` : " 系统默认（全部可用模型参与）"}`)
  }
  console.log(`（查看单池完整清单与编号：pool list <${LANE_ORDER.join("|")}>）`)
}

function resolveRefs(refs: string[], rows: ModelRow[]): string[] {
  // 点号折叠回退：手敲参数常见 "glm-5-3-flash" ↔ 清单键 "glm-5.3-flash"（normalizeModelKey 保留点号）
  const alt = new Map(rows.map((r) => [r.key.replace(/\./g, "-"), r.key]))
  const out: string[] = []
  for (const r of refs) {
    if (/^\d+$/.test(r)) {
      const hit = rows[Number(r) - 1]
      if (!hit) throw new Error(`编号越界 #${r}（列表共 ${rows.length} 项）`)
      out.push(hit.key)
      continue
    }
    const key = normalizeModelKey(r)
    if (!key) throw new Error(`无效模型名：${r}`)
    out.push(alt.get(key.replace(/\./g, "-")) ?? key)
  }
  return out
}

function cmdPool(args: string[]): number {
  const [sub, lane, ...rest] = args
  if (!sub || sub === "list") {
    printPoolList(lane)
    return 0
  }
  const key = laneOrThrow(lane)
  const rows = allModelRows()
  if (rows.length === 0) throw new Error("无可用模型清单（检查 provider 连接与 superset 清单）")
  // add/remove 语义基于「当前有效选配集」：未配置 lane=系统默认全量（首次操作即物化为显式清单，与 TUI 勾选一致）
  const explicit = poolAllowlist(key)
  const current = [...(explicit ?? rows.map((r) => r.key))]
  if (sub === "add" || sub === "remove" || sub === "set") {
    if (rest.length === 0) throw new Error(`pool ${sub} 缺少编号或模型名`)
    const refs = resolveRefs(rest, rows)
    let next: string[]
    if (sub === "add") next = [...current, ...refs.filter((k) => !current.includes(k))]
    else if (sub === "remove") next = current.filter((k) => !refs.includes(k))
    else next = refs
    const file = writePoolConfig(key, next)
    const n = file?.pools[key]?.length
    console.log(n === undefined
      ? `${key} 任务池选配已清空（恢复系统默认候选集，即时生效，侧栏同步刷新）`
      : `已更新 ${key} 任务池选配（${n} 模型参与，即时生效，侧栏同步刷新）`)
    printPoolList(key)
    return 0
  }
  if (sub === "clear") {
    resetPoolConfig(key)
    console.log(`已清除 ${key} 任务池选配配置（该池恢复系统默认候选集，即时生效，侧栏同步刷新）`)
    return 0
  }
  throw new Error(`未知子命令 pool ${sub}（list/add/remove/set/clear）`)
}

/** 手动排名 + 可用模型参考排序的合并视图（编号全局连续，供 rank set/add/remove 引用） */
export function rankViewRows(): ModelRow[] {
  const rank = loadCapabilityRank()
  const rankedKeys = new Set(rank?.models ?? [])
  const ranked: ModelRow[] = (rank?.models ?? []).map((k) => ({ ...toRow(k), source: "manual" }))
  const flat = allModelRows()
  const seen = new Set<string>(rankedKeys)
  const rest: ModelRow[] = []
  for (const r of flat) {
    if (seen.has(r.key)) continue
    seen.add(r.key)
    rest.push(r)
  }
  rest.sort(capabilityCompare)
  return [...ranked, ...rest]
}

function cmdRank(args: string[]): number {
  const [sub, ...rest] = args
  const rank = loadCapabilityRank()
  if (!sub || sub === "list") {
    const view = rankViewRows()
    const manualCount = rank?.models.length ?? 0
    console.log(`模型能力排名（配置文件 ${paths().capabilityRank}；手动排名优先于基础能力分，越靠前能力越强）`)
    console.log(`== 手动排名（${manualCount}${manualCount > 0 ? "" : "；未配置=全部走基础能力分"}）==`)
    view.forEach((row, i) => {
      if (i < manualCount) console.log(` #${String(i + 1).padStart(2, "0")} ${row.modelId}（${row.tier}档·manual）`)
    })
    console.log("== 可用模型参考排序（基础能力分）==")
    view.forEach((row, i) => {
      if (i >= manualCount) console.log(` #${String(i + 1).padStart(2, "0")} ${row.modelId}（${row.tier}档）`)
    })
    return 0
  }
  if (sub === "add" || sub === "remove" || sub === "set") {
    if (rest.length === 0) throw new Error(`rank ${sub} 缺少编号或模型名`)
    const refs = resolveRefs(rest, rankViewRows())
    const current = [...(rank?.models ?? [])]
    let next: string[]
    if (sub === "add") next = [...current, ...refs.filter((k) => !current.includes(k))]
    else if (sub === "remove") next = current.filter((k) => !refs.includes(k))
    else next = refs
    const file = writeCapabilityRank(next)
    console.log(`已更新手动能力排名（${file.models.length} 模型，即时生效，侧栏同步刷新）`)
    return cmdRank(["list"])
  }
  if (sub === "clear") {
    clearCapabilityRank()
    console.log("已清空手动能力排名（全部回退基础能力分，即时生效，侧栏同步刷新）")
    return 0
  }
  throw new Error(`未知子命令 rank ${sub}（list/set/add/remove/clear）`)
}

/** CLI 入口（供测试直调）；argv 不含 node/self */
export function runCli(argv: string[]): number {
  const [group, ...args] = argv
  try {
    if (group === "pool") return cmdPool(args)
    if (group === "rank") return cmdRank(args)
    console.log("用法：switchman-config <pool|rank> ...")
    console.log(`  pool list [任务池]             池选配总览（economy/mechanical/main/hard/vision/review；带池名=完整清单与编号）`)
    console.log("  pool add <任务池> <编号|模型...>    勾选参与该任务池")
    console.log("  pool remove <任务池> <编号|模型...> 取消参与")
    console.log("  pool set <任务池> <编号|模型...>    全量替换该池参与清单（同模型可参与多个池）")
    console.log("  pool clear <任务池>                清除该池配置（恢复系统默认候选集）")
    console.log("  rank list                      查看手动能力排名与可用模型参考排序")
    console.log("  rank set <编号|模型...>         全量重排（按给定顺序，#1 最强）")
    console.log("  rank add <编号|模型...>         追加到排名末尾")
    console.log("  rank remove <编号|模型...>      移出排名")
    console.log("  rank clear                     清空排名（回退基础能力分）")
    return group ? 1 : 0
  } catch (exc) {
    console.error(`switchman-config: ${exc instanceof Error ? exc.message : exc}`)
    return 1
  }
}

/* 直跑入口（dist 产物由 node/bun 执行；bun test import 时 argv[1]=测试器路径不触发） */
if (/switchman-config\.(js|mjs|ts)$/.test(String(process.argv[1] ?? ""))) {
  process.exitCode = runCli(process.argv.slice(2))
}
