/** @jsxImportSource @opentui/solid */
// TUI 侧边栏实时状态面板：
// - 上半区：各任务档位（lane）实时最佳候选模型，轮询读取 route-snapshot.json
//   （由 src/index.ts bannerLines() 与横幅同源计算后覆盖写入 src/state.ts writeRouteSnapshot）。
// - 下半区：最新一条通知，轮询读取 status-log.json（src/state.ts appendStatusLog 写入）。
// 替代原先阻塞输入框的 stderr 横幅（console.error 刷屏）。
// [2026-08-31]-[新增 TUI Slot 插件；需用户在 tui.json 的 plugin 数组里显式加入本包，TUI 插件无目录自动发现]
// [2026-09-01]-[通知区收窄为仅显示最后一条；新增最佳候选面板，与通知区上下分栏展示]
import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
// [2026-09-02]-[solid-js 必须裸导入：宿主 runtime-plugin 仅对精确 specifier（"solid-js"/"@opentui/solid"）
// 做运行时重写（opentui:runtime-module:* → 宿主实例）；深路径 "solid-js/dist/solid.js" 不匹配重写规则，
// 会加载第二份 solid 实例→两份图谱互不订阅→面板挂载后全冻结。构建期 server.js 误解析由
// @opentui/solid/bun-plugin 的 onLoad 重定向（server.js→solid.js 客户端构建）解决]-[影响 TUI 面板实时刷新]
import { createSignal, createMemo, onCleanup, For } from "solid-js"
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative, isAbsolute, sep } from "node:path"
// [2026-09-03]-[/poolConfig //modelRank 交互弹窗：任务池选配勾选与能力排名直接读写用户覆盖层
//  （pool-config.json / capability-rank.json），与插件主进程 mtime 热加载同源生效]
import { loadPoolConfig, writePoolConfig, resetPoolConfig, loadCapabilityRank, writeCapabilityRank } from "./user-overrides"
import { allModelRows, rankViewRows } from "./config-cli"
import { LANE_ORDER, type Lane } from "./types"

type StatusLogEntry = { ts: string; text: string }
type RouteSnapshotEntry = { lane: string; best: string | null; degraded: boolean }
type RouteSnapshot = { ts: string; entries: RouteSnapshotEntry[] }
// [2026-09-02]-[v2：一 provider 一条目块＋rows 子行（进度条/重置时间），与 banner.ts providerStatusEntries 同构]
type QuotaBriefRow = { label: string; text: string; usedPct: number | null; tail?: string }
type QuotaBriefEntry = { pool: string; label: string; rows: QuotaBriefRow[]; observeOnly: boolean; peakActive: boolean; stale: boolean }
type QuotaBrief = { ts: string; entries: QuotaBriefEntry[] }

function statusLogPath(): string {
  return process.env.SWITCHMAN_STATE || join(homedir(), ".config", "opencode", "opencode-switchman")
}

function readStatusLog(): StatusLogEntry[] {
  try {
    const p = join(statusLogPath(), "status-log.json")
    const raw = JSON.parse(readFileSync(p, "utf8"))
    if (Array.isArray(raw)) return raw
  } catch { /* fail-open：文件不存在或坏则空列表 */ }
  return []
}

function readRouteSnapshot(): RouteSnapshotEntry[] {
  try {
    const p = join(statusLogPath(), "route-snapshot.json")
    const raw = JSON.parse(readFileSync(p, "utf8")) as RouteSnapshot
    if (raw && Array.isArray(raw.entries)) return raw.entries
  } catch { /* fail-open：文件不存在或坏则空列表 */ }
  return []
}

// [2026-09-01]-[侧边栏「水位/峰值」面板：与 route-snapshot 同轮询节奏，读 quota-brief.json
//  （src/banner.ts providerStatusEntries → src/state.ts writeQuotaBrief 落盘，observe=false 的 provider
//  在写入侧已过滤，此处拿到的即「用户配置 observe:true」的全量条目）]
function readQuotaBrief(): QuotaBriefEntry[] {
  try {
    const p = join(statusLogPath(), "quota-brief.json")
    const raw = JSON.parse(readFileSync(p, "utf8")) as QuotaBrief
    if (raw && Array.isArray(raw.entries)) return raw.entries
  } catch { /* fail-open：文件不存在或坏则空列表 */ }
  return []
}

// [2026-09-01]-[标题旁「需要重启更新识别」标注：直接读 active-matrix.json（manager.recompute 每次落盘，
// 与状态实时同源），非空即代表本轮有新 provider/模型未完成壳注册，重启完成后此文件自然清空该字段]
function readRestartRequired(): string[] {
  try {
    const p = join(statusLogPath(), "active-matrix.json")
    const raw = JSON.parse(readFileSync(p, "utf8")) as { restartRequired?: string[] }
    if (Array.isArray(raw?.restartRequired)) return raw.restartRequired
  } catch { /* fail-open：文件不存在或坏则视为无需重启 */ }
  return []
}

const POLL_MS = 2000
const SHOW_LAST = 1
const RESTART_HINT_RE = /重启[^；：，。、（）()]*/g
const MARQUEE_MS = 150
const TITLE = "switchman"
// [2026-09-02]-[任务档位/推荐模型固定配色：橙=lane 类型，绿=推荐模型名，与水位渐变绿色系呼应但语义独立]
const LANE_COLOR = "#f59e0b"
const MODEL_COLOR = "#22c55e"
const NOTICE_HEADER_COLOR = "#7dd3fc"

// [2026-09-02]-[水位渐变色：绿(充裕)→黄(过半)→红(耗尽)，三段线性插值；usedPct=null（数据未就绪/不可算）时
//  调用方回退中性色，不在此处兜底避免误导"绿色"表示确定安全]
function waterColor(pct: number | null): string | null {
  if (pct === null || Number.isNaN(pct)) return null
  const p = Math.max(0, Math.min(100, pct))
  const stops: Array<[number, [number, number, number]]> = [
    [0, [34, 197, 94]], [50, [234, 179, 8]], [100, [239, 68, 68]],
  ]
  let lo = stops[0]!, hi = stops[stops.length - 1]!
  for (let i = 0; i < stops.length - 1; i++) {
    if (p >= stops[i]![0] && p <= stops[i + 1]![0]) { lo = stops[i]!; hi = stops[i + 1]!; break }
  }
  const range = hi[0] - lo[0] || 1
  const t = (p - lo[0]) / range
  const lerp = (a: number, b: number) => Math.round(a + (b - a) * t)
  const hex = (n: number) => n.toString(16).padStart(2, "0")
  return `#${hex(lerp(lo[1][0], hi[1][0]))}${hex(lerp(lo[1][1], hi[1][1]))}${hex(lerp(lo[1][2], hi[1][2]))}`
}

// [2026-09-02]-[子行标签显宽对齐：CJK 按 2 列计（padEnd 按码元数会把「周」与「5h」错开一列）]
function dispWidth(s: string): number {
  let w = 0
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1
  return w
}
function padEndW(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - dispWidth(s)))
}

// [2026-09-02]-[彩虹走马灯：HSV→hex，色相随时间偏移滚动，饱和度/明度固定出高识别度亮色]
function hsvToHex(h: number, s: number, v: number): string {
  const hh = ((h % 360) + 360) % 360
  const c = v * s
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1))
  const m = v - c
  let r = 0, g = 0, b = 0
  if (hh < 60) { r = c; g = x; b = 0 }
  else if (hh < 120) { r = x; g = c; b = 0 }
  else if (hh < 180) { r = 0; g = c; b = x }
  else if (hh < 240) { r = 0; g = x; b = c }
  else if (hh < 300) { r = x; g = 0; b = c }
  else { r = c; g = 0; b = x }
  const to255 = (n: number) => Math.round((n + m) * 255)
  const hex = (n: number) => n.toString(16).padStart(2, "0")
  return `#${hex(to255(r))}${hex(to255(g))}${hex(to255(b))}`
}

// [2026-09-01]-[通知含"重启"提示（restartRequired/provider.list 后台探测）时高亮为 error 色，
// 一眼分辨"需要动手重启"与普通状态播报；纯字符串切分渲染，不引入 markdown/ansi 解析]
function noticeSegments(text: string): { text: string; alert: boolean }[] {
  const matches = [...text.matchAll(RESTART_HINT_RE)]
  if (matches.length === 0) return [{ text, alert: false }]
  const segments: { text: string; alert: boolean }[] = []
  let cursor = 0
  for (const m of matches) {
    const idx = m.index ?? 0
    if (idx > cursor) segments.push({ text: text.slice(cursor, idx), alert: false })
    segments.push({ text: m[0], alert: true })
    cursor = idx + m[0].length
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), alert: false })
  return segments
}

// [2026-09-02]-[补回被本面板 single_winner 覆盖的内置 footer 内容：项目路径+git 分支+版本行。
//  本插件 order 缺省 0 < 内置 internal:sidebar-footer 的 100，sidebar_footer 槽 single_winner 只渲染
//  链首条目，内置的 path:branch/version 行整体消失；此处按内置同款逻辑（session.directory 优先、
//  目录与 TUI cwd 一致才显示 vcs.branch、abbreviateHome 缩写）在面板底部补渲染]
function abbreviateHome(input: string, home: string): string {
  if (!home) return input
  const rel = relative(home, input)
  if (rel === "") return "~"
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return input
  return "~" + sep + rel
}

// [2026-09-02]-[分支实时刷新：api.state.vcs.branch 依赖 opencode 服务端 .git/HEAD watcher→vcs.branch.updated
//  事件链，实测切换分支后长期滞留旧值；改为插件侧直读目标目录 .git/HEAD 自证当前分支（含 worktree 的
//  .git 文件 gitdir 指针），detached HEAD 与非 git 目录返回 undefined 与内置 footer 语义一致]
function gitBranch(dir: string): string | undefined {
  try {
    const dotGit = join(dir, ".git")
    let headPath: string
    if (statSync(dotGit).isDirectory()) {
      headPath = join(dotGit, "HEAD")
    } else {
      const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim()
      if (!pointer) return undefined
      headPath = join(pointer, "HEAD")
    }
    const head = readFileSync(headPath, "utf8").trim()
    if (!head.startsWith("ref:")) return undefined
    const ref = head.slice(4).trim()
    return ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref
  } catch {
    return undefined
  }
}

function View(props: { api: TuiPluginApi; sessionID: string }) {
  return ViewInner(props)
}

function ViewInner(props: { api: TuiPluginApi; sessionID: string }) {
  const [entries, setEntries] = createSignal<StatusLogEntry[]>(readStatusLog())
  const [routes, setRoutes] = createSignal<RouteSnapshotEntry[]>(readRouteSnapshot())
  const [quotaBrief, setQuotaBrief] = createSignal<QuotaBriefEntry[]>(readQuotaBrief())
  const [restartRequired, setRestartRequired] = createSignal<string[]>(readRestartRequired())
  const [tick, setTick] = createSignal(0)
  // [2026-09-02]-[分支信号：每轮轮询直读 .git/HEAD（session 目录优先回退 TUI 目录）；另订阅
  //  vcs.branch.updated 事件在事件链正常时即时刷新，事件丢失由轮询兜底；直读失败回退 api.state.vcs]
  const [gitDirBranch, setGitDirBranch] = createSignal<string | undefined>(gitBranch(props.api.state.path.directory))
  const refreshBranch = () => {
    const session = props.api.state.session.get(props.sessionID)
    const dir = session?.directory || props.api.state.path.directory
    setGitDirBranch(gitBranch(dir))
  }
  const timer = setInterval(() => {
    setEntries(readStatusLog())
    setRoutes(readRouteSnapshot())
    setQuotaBrief(readQuotaBrief())
    setRestartRequired(readRestartRequired())
    refreshBranch()
  }, POLL_MS)
  // [2026-09-02]-[标题彩虹走马灯需要比数据轮询快得多的独立心跳，二者职责/频率不同，不共用一个 timer]
  const marqueeTimer = setInterval(() => setTick((t) => (t + 1) % 360), MARQUEE_MS)
  onCleanup(() => {
    clearInterval(timer)
    clearInterval(marqueeTimer)
  })
  onCleanup(props.api.event.on("vcs.branch.updated", refreshBranch))
  const theme = () => props.api.theme.current
  const recent = () => entries().slice(-SHOW_LAST)
  // 与内置 sidebar-footer 同款取值：会话目录优先回退 TUI 目录；分支优先取插件侧直读值（实时），
  // 直读失败回退 api.state.vcs（仅会话目录=TUI cwd 时可信）
  const location = createMemo(() => {
    const session = props.api.state.session.get(props.sessionID)
    const dir = session?.directory || props.api.state.path.directory
    const out = abbreviateHome(dir, homedir())
    const branch =
      gitDirBranch() ??
      (session?.directory === props.api.state.path.directory ? props.api.state.vcs?.branch : undefined)
    const list = out.split("/")
    return { parent: list.slice(0, -1).join("/"), name: list.at(-1) ?? "", branch }
  })

  return (
    <box flexDirection="column" gap={0}>
      {/* [2026-09-02]-[v2 块状布局：头部行=✓+provider 名+高峰/滞后/仅观察标注；子行缩进，进度条+百分比
          按 waterColor 绿→红渐变一眼读状态，重置/刷新时间弱化色尾随] */}
      {quotaBrief().length > 0 && (
        <box flexDirection="column" gap={0}>
          <For each={quotaBrief()}>
            {(q) => (
              <box flexDirection="column" gap={0}>
                <text>
                  {!q.observeOnly && <span style={{ fg: MODEL_COLOR }}>✓ </span>}
                  <b><span style={{ fg: theme().text }}>{q.label}</span></b>
                  {q.peakActive && <span style={{ fg: theme().warning }}> ·高峰</span>}
                  {q.stale && <span style={{ fg: theme().warning }}> ·滞后</span>}
                  {q.observeOnly && <span style={{ fg: theme().textMuted }}> ·仅观察</span>}
                </text>
                <For each={q.rows}>
                  {(r) => (
                    <text>
                      <span style={{ fg: theme().textMuted }}>{r.label ? `  ${padEndW(r.label, 4)}` : "  "}</span>
                      <span style={{ fg: waterColor(r.usedPct) ?? theme().textMuted }}>{r.text}</span>
                      {r.tail && <span style={{ fg: theme().textMuted }}>{r.tail}</span>}
                    </text>
                  )}
                </For>
              </box>
            )}
          </For>
        </box>
      )}
      {routes().length > 0 && (
        <box flexDirection="column" gap={0}>
          <text>
            <b>
              <For each={[...TITLE]}>
                {(ch, i) => <span style={{ fg: hsvToHex(i() * 28 + tick() * 3, 0.65, 1) }}>{ch}</span>}
              </For>
            </b>
            {restartRequired().length > 0 && (
              <span style={{ fg: theme().error }}> 【需要重启更新识别】</span>
            )}
          </text>
          <For each={routes()}>
            {(r: RouteSnapshotEntry) => (
              <text fg={theme().textMuted}>
                <span style={{ fg: LANE_COLOR }}>{r.lane.padEnd(10)} </span>
                <span style={{ fg: MODEL_COLOR }}>{r.best ?? "全不可用"}</span>
                {r.degraded ? <span style={{ fg: theme().warning }}>*</span> : ""}
              </text>
            )}
          </For>
        </box>
      )}
      {recent().length > 0 && (
        <box flexDirection="column" gap={0}>
          <text fg={NOTICE_HEADER_COLOR}>
            <b>notice</b>
          </text>
          <For each={recent()}>
            {(item: StatusLogEntry) => (
              <text fg={theme().textMuted}>
                <span style={{ fg: theme().textMuted }}>{item.ts.slice(11, 19)} </span>
                <For each={noticeSegments(item.text)}>
                  {(seg: { text: string; alert: boolean }) => <span style={{ fg: seg.alert ? theme().error : theme().text }}><b>{seg.text}</b></span>}
                </For>
              </text>
            )}
          </For>
        </box>
      )}
      {/* [2026-09-02]-[与通知区间留一行空隙区分两块；分支名用绿色与推荐模型色统一] */}
      <box flexShrink={0} paddingTop={1} flexDirection="column" gap={0}>
        <text>
          <span style={{ fg: theme().textMuted }}>{location().parent}/</span>
          <span style={{ fg: theme().text }}>{location().name}</span>
          {location().branch && <span style={{ fg: MODEL_COLOR }}>:{location().branch}</span>}
        </text>
        <text fg={theme().textMuted}>
          <span style={{ fg: theme().success }}>• </span>
          <b>Open</b>
          <span style={{ fg: theme().text }}>
            <b>Code</b>
          </span>{" "}
          {props.api.app.version}
        </text>
      </box>
    </box>
  )
}

// ---- [2026-09-03]-[/poolConfig //modelRank 交互弹窗：DialogSelect 选中不关窗（宿主 submit 只回调），
//  勾选语义=onSelect 原地切换 + writeJsonAtomic 落盘 + toast 回执；层间跳转用 dialog.replace
//  （与宿主内置弹窗同模式）；Esc 由宿主 DialogSelect 自带关闭。非 TUI 客户端走 cfg.command 会话式]----

function openPoolConfigDialog(api: TuiPluginApi): void {
  api.ui.dialog.replace(() => <PoolPickerDialog api={api} />)
}

function PoolPickerDialog(props: { api: TuiPluginApi }) {
  // [2026-09-03 语义修正]-[池=任务池 lane（economy/mechanical/main/hard/vision/review），非 provider 池：
  //  选配各 lane 参与模型让六档候选体现差异化；同模型可重复参与多个 lane]
  const lanes = createMemo(() => {
    const allow = loadPoolConfig()
    const total = allModelRows().length
    return LANE_ORDER.map((lane) => ({
      lane,
      sel: allow[lane],
      total,
    }))
  })
  return (
    <props.api.ui.DialogSelect
      title="任务池选配（选择任务池；Esc 退出）"
      options={lanes().map((p) => ({
        title: `${p.sel ? "✎ " : ""}${p.lane}`,
        value: p.lane,
        description: p.sel
          ? `手动选配 ${p.sel.size}/${p.total} 参与模型`
          : "未配置：系统默认（全部可用模型参与）",
        onSelect: () => props.api.ui.dialog.replace(() => <PoolModelsDialog api={props.api} lane={p.lane} />),
      }))}
    />
  )
}

function PoolModelsDialog(props: { api: TuiPluginApi; lane: Lane }) {
  const rows = createMemo(() => allModelRows())
  // 初始勾选：已手动配置→配置清单；未配置→系统默认全量（首次切换即物化为显式清单）
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(
    new Set(loadPoolConfig()[props.lane] ?? rows().map((r) => r.key)),
  )
  const persist = (cur: Set<string>, added: boolean, key: string) => {
    setSelected(cur)
    try {
      writePoolConfig(props.lane, [...cur])
    } catch (exc) {
      // 防御：未知 lane/IO 异常不中断弹窗（当前 lane 来自 LANE_ORDER 不可达，兜底未来改动）
      props.api.ui.toast({ variant: "error", message: `写入失败：${exc instanceof Error ? exc.message : exc}` })
      return
    }
    props.api.ui.toast({
      variant: added ? "success" : "info",
      message: `${added ? "已加入" : "已移出"} ${props.lane} 任务池：${key}（即时生效，侧栏同步刷新）`,
    })
  }
  const toggle = (key: string) => {
    const cur = new Set(selected())
    const added = !cur.has(key)
    if (added) cur.add(key)
    else {
      // 至少保留一个参与模型；恢复系统默认请用「清除配置」（空清单=未配置=默认全量）
      if (cur.size <= 1) {
        props.api.ui.toast({ variant: "warning", message: "至少保留一个参与模型；恢复系统默认请用「清除配置」" })
        return
      }
      cur.delete(key)
    }
    persist(cur, added, key)
  }
  const bulk = () => {
    const cur = new Set(rows().map((r) => r.key))
    setSelected(cur)
    try {
      writePoolConfig(props.lane, [...cur])
    } catch (exc) {
      props.api.ui.toast({ variant: "error", message: `写入失败：${exc instanceof Error ? exc.message : exc}` })
      return
    }
    props.api.ui.toast({ variant: "success", message: `${props.lane} 任务池已全量选配` })
  }
  const reset = () => {
    resetPoolConfig(props.lane)
    setSelected(new Set(rows().map((r) => r.key)))
    props.api.ui.toast({ variant: "success", message: `${props.lane} 任务池配置已清除（恢复系统默认候选集）` })
  }
  const nSel = () => selected().size
  const options = createMemo(() => [
    { title: "← 返回任务池列表", value: "__back", onSelect: () => props.api.ui.dialog.replace(() => <PoolPickerDialog api={props.api} />) },
    { title: "☑ 全部选配", value: "__all", onSelect: () => bulk() },
    { title: "✕ 清除配置（恢复系统默认：全部可用模型参与）", value: "__reset", onSelect: reset },
    ...rows().map((r) => ({
      title: `${selected().has(r.key) ? "[x]" : "[ ]"} ${r.modelId}`,
      value: r.key,
      description: `${r.tier}档${r.source === "manual" ? " · 手动排名" : ""}`,
      onSelect: () => toggle(r.key),
    })),
  ])
  return (
    <props.api.ui.DialogSelect
      title={`${props.lane} 任务池选配（${nSel()}/${rows().length} 参与；选中即切换，可跨池重复）`}
      options={options()}
      flat
    />
  )
}

function openModelRankDialog(api: TuiPluginApi): void {
  api.ui.dialog.replace(() => <RankPickerDialog api={api} />)
}

function RankPickerDialog(props: { api: TuiPluginApi }) {
  const rows = createMemo(() => rankViewRows())
  return (
    <props.api.ui.DialogSelect
      title="模型能力排名（#1 最强，命中者优先于基础能力分；选择模型进行调整）"
      options={rows().map((r, i) => ({
        title: `#${String(i + 1).padStart(2, "0")} ${r.modelId}`,
        value: r.key,
        description: `${r.tier}档 · ${r.source === "manual" ? "手动排名" : "基础能力分"}`,
        onSelect: () => props.api.ui.dialog.replace(() => <RankActionsDialog api={props.api} model={r.modelId} modelKey={r.key} />),
      }))}
      flat
    />
  )
}

function RankActionsDialog(props: { api: TuiPluginApi; model: string; modelKey: string }) {
  const rank = () => [...(loadCapabilityRank()?.models ?? [])]
  const at = () => rank().indexOf(props.modelKey)
  const apply = (next: string[], message: string) => {
    writeCapabilityRank(next)
    props.api.ui.toast({ variant: "success", message: `${message}（即时生效，侧栏同步刷新）` })
    props.api.ui.dialog.replace(() => <RankPickerDialog api={props.api} />)
  }
  const move = (delta: -1 | 0 | 1) => {
    // delta 0=置顶；±1=相邻换位（未排名模型上移/下移=按目标位插入）
    const cur = rank()
    const i = cur.indexOf(props.modelKey)
    if (delta === 0) {
      if (i >= 0) cur.splice(i, 1)
      cur.unshift(props.modelKey)
    } else {
      const target = i >= 0 ? Math.min(Math.max(i + delta, 0), cur.length - 1) : cur.length
      if (i >= 0) cur.splice(i, 1)
      cur.splice(target, 0, props.modelKey)
    }
    apply(cur, delta === 0 ? `已置顶 ${props.model}` : `已调整 ${props.model} 排名至 #${cur.indexOf(props.modelKey) + 1}`)
  }
  const ranked = () => at() >= 0
  const options = createMemo(() => {
    const list = [
      { title: "▲ 置顶（设为最强）", value: "top", onSelect: () => move(0) },
      ...(ranked() && at() > 0
        ? [{ title: "↑ 上移一位", value: "up", onSelect: () => move(-1) }]
        : []),
      ...(ranked() && at() < rank().length - 1
        ? [{ title: "↓ 下移一位", value: "down", onSelect: () => move(1) }]
        : []),
      ...(ranked()
        ? [{ title: "✕ 移出排名（回退基础能力分）", value: "out", onSelect: () => apply(rank().filter((k) => k !== props.modelKey), `已移出 ${props.model}`) }]
        : [{ title: "＋ 加入排名（末尾）", value: "in", onSelect: () => move(1) }]),
      { title: "← 返回排名列表", value: "__back", onSelect: () => props.api.ui.dialog.replace(() => <RankPickerDialog api={props.api} />) },
    ]
    return list
  })
  return (
    <props.api.ui.DialogSelect
      title={`${props.model}（当前 ${ranked() ? `手动排名 #${at() + 1}` : "未手动排名"}）`}
      options={options()}
      flat
    />
  )
}

// ---- [2026-09-04]-[/handover 直接执行版（不经 AI 对话链路，替代原 cfg.command 会话式交接）：
//  ① session.fork 全量复制当前会话为备份（不传 messageID=复制全部消息）；② 备份标题加 [backup]
//  标记（fork 计数后缀保证多次备份标题唯一）；③ 对当前会话执行 summarize 压缩（沿用最后一条
//  assistant 消息的 provider/model）；④ 不切换会话——这是与内置 /fork 的核心区别（fork 后跳到新会话）]----

async function runHandoverBackup(api: TuiPluginApi): Promise<void> {
  const route = api.route.current
  const sessionID = route.name === "session" && typeof route.params?.sessionID === "string" ? route.params.sessionID : undefined
  if (!sessionID) {
    api.ui.toast({ variant: "error", message: "/handover：当前不在会话中，无可备份的会话" })
    return
  }
  const session = api.state.session.get(sessionID)
  const directory = session?.directory || api.state.path.directory
  api.ui.toast({ variant: "info", message: "/handover：正在全量备份当前会话并压缩…" })
  try {
    const forkRes = await api.client.session.fork({ sessionID, directory })
    if (forkRes.error || !forkRes.data?.id) throw new Error(`session.fork 失败: ${forkRes.error ?? "未返回新会话 ID"}`)
    const backupID = forkRes.data.id
    // [backup] 标记：失败只降级为无标记备份，不阻断压缩
    try {
      await api.client.session.update({
        sessionID: backupID,
        directory,
        title: `[backup] ${forkRes.data.title ?? sessionID}`,
      })
    } catch { /* fail-open */ }
    // 压缩模型：TUI 内存态最后一条 assistant 消息 → 空态回退 REST session.messages
    let model: { providerID: string; modelID: string } | undefined
    for (const m of [...api.state.session.messages(sessionID)].reverse()) {
      const info: any = (m as any)?.info ?? m
      if (info?.providerID && info?.modelID) {
        model = { providerID: info.providerID, modelID: info.modelID }
        break
      }
    }
    if (!model) {
      const msgsRes: any = await api.client.session.messages({ sessionID, directory }).catch(() => null)
      for (const entry of [...(msgsRes?.data ?? [])].reverse()) {
        const info: any = entry?.info ?? entry
        if (info?.providerID && info?.modelID) {
          model = { providerID: info.providerID, modelID: info.modelID }
          break
        }
      }
    }
    let compacted = false
    if (model) {
      const sumRes = await api.client.session.summarize({ sessionID, directory, providerID: model.providerID, modelID: model.modelID })
      compacted = !sumRes.error
    }
    api.ui.toast({
      variant: "success",
      message: compacted
        ? `已全量备份为会话 ${backupID.slice(0, 8)}…（[backup] 标记）并压缩当前会话；仍在原会话，未切换`
        : `已全量备份为会话 ${backupID.slice(0, 8)}…（[backup] 标记）；未取到模型信息，跳过当前会话压缩`,
    })
  } catch (exc) {
    api.ui.toast({ variant: "error", message: `/handover 失败：${exc instanceof Error ? exc.message : exc}` })
  }
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    slots: {
      sidebar_footer(_ctx, props) {
        return <View api={api} sessionID={props.session_id} />
      },
    },
  })
  // [2026-09-03]-[/poolConfig //modelRank slash 命令（手动弹窗入口；会话式为 /poolConfig-chat
  //  //modelRank-chat）：namespace=palette 才会出现在 "/" 面板
  //  （宿主 useCommandSlashes 只取 palette 命名空间的 slashName）；老版本无 registerLayer 时
  //  fail-open 仅缺弹窗入口（会话式 cfg.command 版本不受影响）
  // [2026-09-04]-[/handover：直接执行（fork 备份+当前会话压缩，不切会话），无 AI 交互、无会话式变体]
  try {
    api.keymap.registerLayer({
      commands: [
        {
          name: "switchman.handover",
          title: "备份并压缩当前会话",
          desc: "全量 fork 当前会话为备份（标题加 [backup] 标记）并压缩当前会话；不切换会话（区别于内置 /fork）",
          category: "switchman",
          namespace: "palette",
          slashName: "handover",
          run: () => void runHandoverBackup(api),
        },
        {
          name: "switchman.pool-config",
          title: "任务池选配",
          desc: "选配各任务池（economy/mechanical/main/hard/vision/review）参与模型",
          category: "switchman",
          namespace: "palette",
          slashName: "poolConfig",
          run: () => openPoolConfigDialog(api),
        },
        {
          name: "switchman.model-rank",
          title: "模型能力排名",
          desc: "手动能力排名（优先于基础能力分，越靠前能力越强）",
          category: "switchman",
          namespace: "palette",
          slashName: "modelRank",
          run: () => openModelRankDialog(api),
        },
      ],
      bindings: [],
    })
  } catch { /* fail-open */ }
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-switchman.status",
  tui,
}

export default plugin
