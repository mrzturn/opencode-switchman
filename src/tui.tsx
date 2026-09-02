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

type StatusLogEntry = { ts: string; text: string }
type RouteSnapshotEntry = { lane: string; best: string | null; degraded: boolean }
type RouteSnapshot = { ts: string; entries: RouteSnapshotEntry[] }
type QuotaBriefEntry = { pool: string; label: string; text: string; observeOnly: boolean; peakActive: boolean; usedPct: number | null }
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
      {quotaBrief().length > 0 && (
        <box flexDirection="column" gap={0}>
          <For each={quotaBrief()}>
            {(q) => (
              <text fg={theme().textMuted}>
                {!q.observeOnly && <span style={{ fg: MODEL_COLOR }}>✓ </span>}
                <span style={{ fg: theme().textMuted }}>{q.label.padEnd(8)} </span>
                <span style={{ fg: waterColor(q.usedPct) ?? theme().textMuted }}>{q.text}</span>
                {q.peakActive && <span style={{ fg: theme().warning }}> ·高峰</span>}
                {q.observeOnly && <span style={{ fg: theme().textMuted }}> ·仅观察</span>}
              </text>
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

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    slots: {
      sidebar_footer(_ctx, props) {
        return <View api={api} sessionID={props.session_id} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-switchman.status",
  tui,
}

export default plugin
