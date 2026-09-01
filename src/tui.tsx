/** @jsxImportSource @opentui/solid */
// TUI 侧边栏实时状态面板：
// - 上半区：各任务档位（lane）实时最佳候选模型，轮询读取 route-snapshot.json
//   （由 src/index.ts bannerLines() 与横幅同源计算后覆盖写入 src/state.ts writeRouteSnapshot）。
// - 下半区：最新一条通知，轮询读取 status-log.json（src/state.ts appendStatusLog 写入）。
// 替代原先阻塞输入框的 stderr 横幅（console.error 刷屏）。
// [2026-08-31]-[新增 TUI Slot 插件；需用户在 tui.json 的 plugin 数组里显式加入本包，TUI 插件无目录自动发现]
// [2026-09-01]-[通知区收窄为仅显示最后一条；新增最佳候选面板，与通知区上下分栏展示]
import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup, For } from "solid-js"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

type StatusLogEntry = { ts: string; text: string }
type RouteSnapshotEntry = { lane: string; best: string | null; degraded: boolean }
type RouteSnapshot = { ts: string; entries: RouteSnapshotEntry[] }

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

function View(props: { api: TuiPluginApi }) {
  const [entries, setEntries] = createSignal<StatusLogEntry[]>(readStatusLog())
  const [routes, setRoutes] = createSignal<RouteSnapshotEntry[]>(readRouteSnapshot())
  const [restartRequired, setRestartRequired] = createSignal<string[]>(readRestartRequired())
  const timer = setInterval(() => {
    setEntries(readStatusLog())
    setRoutes(readRouteSnapshot())
    setRestartRequired(readRestartRequired())
  }, POLL_MS)
  onCleanup(() => clearInterval(timer))
  const theme = () => props.api.theme.current
  const recent = () => entries().slice(-SHOW_LAST)

  return (
    <box flexDirection="column" gap={0}>
      {routes().length > 0 && (
        <box flexDirection="column" gap={0}>
          <text fg={theme().textMuted}>
            <b>switchman</b>
            {restartRequired().length > 0 && (
              <span style={{ fg: theme().error }}> 【需要重启更新识别】</span>
            )}
          </text>
          <For each={routes()}>
            {(r) => (
              <text fg={theme().textMuted}>
                <span style={{ fg: theme().textMuted }}>{r.lane.padEnd(10)} </span>
                {r.best ?? "全不可用"}
                {r.degraded ? "*" : ""}
              </text>
            )}
          </For>
        </box>
      )}
      {recent().length > 0 && (
        <box flexDirection="column" gap={0}>
          <text fg={theme().textMuted}>
            <b>notice</b>
          </text>
          <For each={recent()}>
            {(item) => (
              <text fg={theme().textMuted}>
                <span style={{ fg: theme().textMuted }}>{item.ts.slice(11, 19)} </span>
                <For each={noticeSegments(item.text)}>
                  {(seg) => <span style={{ fg: seg.alert ? theme().error : theme().textMuted }}>{seg.text}</span>}
                </For>
              </text>
            )}
          </For>
        </box>
      )}
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    slots: {
      sidebar_footer(_ctx, _props) {
        return <View api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-switchman.status",
  tui,
}

export default plugin
