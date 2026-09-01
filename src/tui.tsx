/** @jsxImportSource @opentui/solid */
// TUI 侧边栏实时状态面板：轮询读取 status-log.json（由 src/state.ts appendStatusLog 写入），
// 替代原先阻塞输入框的 stderr 横幅（console.error 刷屏）。
// [2026-08-31]-[新增 TUI Slot 插件；需用户在 tui.json 的 plugin 数组里显式加入本包，TUI 插件无目录自动发现]
import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createSignal, onCleanup, For } from "solid-js"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

type StatusLogEntry = { ts: string; text: string }

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

const POLL_MS = 2000
const SHOW_LAST = 4

function View(props: { api: TuiPluginApi }) {
  const [entries, setEntries] = createSignal<StatusLogEntry[]>(readStatusLog())
  const timer = setInterval(() => setEntries(readStatusLog()), POLL_MS)
  onCleanup(() => clearInterval(timer))
  const theme = () => props.api.theme.current
  const recent = () => entries().slice(-SHOW_LAST)

  return (
    <box gap={0}>
      {recent().length > 0 && (
        <box flexDirection="column" gap={0}>
          <text fg={theme().textMuted}>
            <b>switchman</b>
          </text>
          <For each={recent()}>
            {(item) => (
              <text fg={theme().textMuted}>
                <span style={{ fg: theme().textMuted }}>{item.ts.slice(11, 19)} </span>
                {item.text}
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
