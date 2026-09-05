/** @jsxImportSource @opentui/solid */
// TUI sidebar live status panel:
// - Top section: real-time best candidate model per task lane, polling route-snapshot.json
//   (computed by bannerLines() in src/index.ts — same source as the banner — and overwritten via writeRouteSnapshot in src/state.ts).
// - Bottom section: latest notice, polling status-log.json (written by appendStatusLog in src/state.ts).
// Replaces the old stderr banner that blocked the input box (console.error spam).
// [2026-08-31]-[New TUI Slot plugin; users must add this package explicitly to the plugin array in tui.json — TUI plugins have no directory auto-discovery]
// [2026-09-01]-[Notice area narrowed to the last entry only; best-candidate panel added, stacked above the notice area]
// [2026-09-04]-[English localization: translate panel/dialog copy and comments; RESTART_HINT_RE now matches the English
//  "restart opencode" notice (emitters were localized in the same sweep); no other behavior change]
import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
// [2026-09-02]-[solid-js must be imported bare: the host runtime-plugin only rewrites exact specifiers
//  ("solid-js"/"@opentui/solid") at runtime (opentui:runtime-module:* → host instance); the deep path "solid-js/dist/solid.js"
//  misses the rewrite rule and loads a second solid instance → two reactive graphs that never subscribe to each other →
//  the whole panel freezes after mount. Build-time misresolution of server.js is handled by the onLoad redirect in
//  @opentui/solid/bun-plugin (server.js → solid.js client build)]-[impacts live refresh of the TUI panel]
import { createSignal, createMemo, onCleanup, For } from "solid-js"
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative, isAbsolute, sep } from "node:path"
// [2026-09-03]-[/poolConfig //modelRank interactive dialogs: task-pool pick lists and capability ranking read/write the
//  user override layer (pool-config.json / capability-rank.json) directly, taking effect in sync with the plugin main
//  process mtime hot reload]
import { loadPoolConfig, writePoolConfig, resetPoolConfig, loadCapabilityRank, writeCapabilityRank } from "./user-overrides"
import { allModelRows, rankViewRows } from "./config-cli"
import { LANE_ORDER, type Lane } from "./types"
import { runHandover, type HandoverPort } from "./handover-core"

type StatusLogEntry = { ts: string; text: string }
type RouteSnapshotEntry = { lane: string; best: string | null; degraded: boolean }
type RouteSnapshot = { ts: string; entries: RouteSnapshotEntry[] }
// [2026-09-02]-[v2: one block per provider plus rows sub-lines (progress bar / reset time), isomorphic to providerStatusEntries in banner.ts]
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
  } catch { /* fail-open: missing or corrupt file → empty list */ }
  return []
}

function readRouteSnapshot(): RouteSnapshotEntry[] {
  try {
    const p = join(statusLogPath(), "route-snapshot.json")
    const raw = JSON.parse(readFileSync(p, "utf8")) as RouteSnapshot
    if (raw && Array.isArray(raw.entries)) return raw.entries
  } catch { /* fail-open: missing or corrupt file → empty list */ }
  return []
}

// [2026-09-01]-[Sidebar "watermark/peak" panel: polls quota-brief.json at the same cadence as route-snapshot
//  (src/banner.ts providerStatusEntries → writeQuotaBrief in src/state.ts persists it; providers with observe=false
//  are already filtered on the write side, so entries here are exactly the observe:true set from user config)]
function readQuotaBrief(): QuotaBriefEntry[] {
  try {
    const p = join(statusLogPath(), "quota-brief.json")
    const raw = JSON.parse(readFileSync(p, "utf8")) as QuotaBrief
    if (raw && Array.isArray(raw.entries)) return raw.entries
  } catch { /* fail-open: missing or corrupt file → empty list */ }
  return []
}

// [2026-09-01]-["restart required" tag next to the title: reads active-matrix.json directly (manager.recompute persists
//  it every run, same source as live status); non-empty means new providers/models await shell registration this round,
//  and the field clears naturally once a restart completes]
function readRestartRequired(): string[] {
  try {
    const p = join(statusLogPath(), "active-matrix.json")
    const raw = JSON.parse(readFileSync(p, "utf8")) as { restartRequired?: string[] }
    if (Array.isArray(raw?.restartRequired)) return raw.restartRequired
  } catch { /* fail-open: missing or corrupt file → treated as no restart needed */ }
  return []
}

const POLL_MS = 2000
const SHOW_LAST = 1
const RESTART_HINT_RE = /restart opencode[^;]*/gi
const MARQUEE_MS = 150
const TITLE = "switchman"
// [2026-09-02]-[Fixed palette for lanes/recommended models: orange = lane type, green = recommended model name; echoes
//  the watermark greens but keeps independent semantics]
// [2026-09-04]-[Brightened to the 400-level palette to match the new waterColor stops; the notice header drops its
//  standalone cyan (clashed with the warm body palette) and now renders like a functional muted heading]
const LANE_COLOR = "#fbbf24"
const MODEL_COLOR = "#4ade80"

// [2026-09-02]-[Watermark gradient: green (plenty) → yellow (past half) → red (exhausted), three-segment linear
//  interpolation; usedPct=null (data not ready / not computable) → the caller falls back to a neutral color; no
//  fallback here, to avoid a misleading "green" implying definite safety]
// [2026-09-04]-[Brightened stops to the 400-level palette: the old 500-level olive mid-tones were the dimmest text
//  in the panel; the sidebar needs contrast headroom]
function waterColor(pct: number | null): string | null {
  if (pct === null || Number.isNaN(pct)) return null
  const p = Math.max(0, Math.min(100, pct))
  const stops: Array<[number, [number, number, number]]> = [
    [0, [74, 222, 128]], [50, [250, 204, 21]], [100, [248, 113, 113]],
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

// [2026-09-02]-[Display-width alignment for sub-row labels: CJK counts as 2 columns (padEnd by code units would
//  misalign a CJK glyph vs "5h" by one column)]
function dispWidth(s: string): number {
  let w = 0
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0xff ? 2 : 1
  return w
}
function padEndW(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - dispWidth(s)))
}

// [2026-09-04]-[Quota sub-row bar split: banner puts the 8-cell bar at the head of r.text; splitting it out lets the
//  █ fill keep the waterColor gradient while the ░ track renders muted, so the fill boundary stays readable instead
//  of dissolving into a same-color dotted track; non-bar rows pass through untouched]
function splitBarText(text: string): { fill: string; track: string; rest: string } {
  const m = /^([█░]+)(.*)$/.exec(text)
  if (!m) return { fill: "", track: "", rest: text }
  const bar = m[1]!
  const cut = bar.indexOf("░")
  return cut === -1
    ? { fill: bar, track: "", rest: m[2]! }
    : { fill: bar.slice(0, cut), track: bar.slice(cut), rest: m[2]! }
}

// [2026-09-02]-[Rainbow marquee: HSV→hex, hue rolling over time, fixed saturation/value for a high-visibility bright color]
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

// [2026-09-01]-[When a notice carries a "restart opencode" hint (restartRequired / provider.list background probe),
//  highlight it in error color to tell "manual restart needed" apart from ordinary status chatter at a glance;
//  rendered by plain string splitting, no markdown/ansi parsing]
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

// [2026-09-02]-[Restore the built-in footer content shadowed by this panel's single_winner: project path + git branch
//  + version line. This plugin's default order 0 < the built-in internal:sidebar-footer's 100, and the sidebar_footer
//  slot's single_winner only renders the chain head, so the built-in path:branch/version lines vanish entirely;
//  re-render them at the panel bottom with the same logic as the built-in one (session.directory first, vcs.branch
//  shown only when the directory matches the TUI cwd, abbreviateHome shortening)]
function abbreviateHome(input: string, home: string): string {
  if (!home) return input
  const rel = relative(home, input)
  if (rel === "") return "~"
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return input
  return "~" + sep + rel
}

// [2026-09-02]-[Live branch refresh: api.state.vcs.branch depends on the opencode server's .git/HEAD watcher → the
//  vcs.branch.updated event chain, which in practice lingers on stale values after a branch switch; instead the plugin
//  reads the target directory's .git/HEAD directly (including the .git-file gitdir pointer for worktrees); detached
//  HEAD and non-git directories return undefined, matching the built-in footer semantics]
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
  // [2026-09-02]-[Branch signal: re-read .git/HEAD every poll cycle (session directory first, TUI directory as
  //  fallback); also subscribes to vcs.branch.updated for instant refresh when the event chain works, with polling as
  //  the safety net; falls back to api.state.vcs when the direct read fails]
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
  // [2026-09-02]-[The title rainbow marquee needs its own heartbeat far faster than data polling; separate duties and
  //  frequencies, no shared timer]
  const marqueeTimer = setInterval(() => setTick((t) => (t + 1) % 360), MARQUEE_MS)
  onCleanup(() => {
    clearInterval(timer)
    clearInterval(marqueeTimer)
  })
  onCleanup(props.api.event.on("vcs.branch.updated", refreshBranch))
  const theme = () => props.api.theme.current
  const recent = () => entries().slice(-SHOW_LAST)
  // Same values as the built-in sidebar-footer: session directory first with TUI directory fallback; branch prefers
  // the plugin's direct read (real-time), falling back to api.state.vcs (trustworthy only when the session directory
  // equals the TUI cwd)
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
      {/* [2026-09-02]-[v2 block layout: header row = ✓ + provider name + peak/stale/observe-only tags; indented
          sub-rows, progress bar + percentage colored by the waterColor green→red gradient for at-a-glance status,
          reset/refresh time trailing in muted color] */}
      {/* [2026-09-04]-[Layout pass: quota sub-rows pad labels to a global 8-column grid (bars and values align across
          provider blocks; fixes glued "refresh2026-10-01"/"balanceexhausted"), the ░ track renders muted under the
          colored fill, tails get a leading space, sections (quota/routes/notice/footer) are separated by one blank
          line each, and per-entry ·observe-only tags collapse when every provider is observe-only (the [WATERMARK]
          banner already carries the full detail)] */}
      {quotaBrief().length > 0 && (() => {
        const allObserve = quotaBrief().every((q) => q.observeOnly)
        return (
        <box flexDirection="column" gap={0}>
          <For each={quotaBrief()}>
            {(q) => (
              <box flexDirection="column" gap={0}>
                <text>
                  {!q.observeOnly && <span style={{ fg: MODEL_COLOR }}>✓ </span>}
                  <b><span style={{ fg: theme().text }}>{q.label}</span></b>
                  {q.peakActive && <span style={{ fg: theme().warning }}> ·peak</span>}
                  {q.stale && <span style={{ fg: theme().warning }}> ·stale</span>}
                  {q.observeOnly && !allObserve && <span style={{ fg: theme().textMuted }}> ·observe-only</span>}
                </text>
                <For each={q.rows}>
                  {(r) => {
                    const { fill, track, rest } = splitBarText(r.text)
                    const value = waterColor(r.usedPct)
                    return (
                      <text>
                        <span style={{ fg: theme().textMuted }}>{r.label ? `  ${padEndW(r.label, 8)}` : "  "}</span>
                        <span style={{ fg: value ?? theme().textMuted }}>{fill}</span>
                        <span style={{ fg: theme().textMuted }}>{track}</span>
                        <span style={{ fg: value ?? theme().textMuted }}>{rest}</span>
                        {r.tail && <span style={{ fg: theme().textMuted }}> {r.tail}</span>}
                      </text>
                    )
                  }}
                </For>
              </box>
            )}
          </For>
        </box>
        )
      })()}
      {routes().length > 0 && (
        <box paddingTop={1} flexDirection="column" gap={0}>
          <text>
            <b>
              <For each={[...TITLE]}>
                {(ch, i) => <span style={{ fg: hsvToHex(i() * 28 + tick() * 3, 0.65, 1) }}>{ch}</span>}
              </For>
            </b>
            {restartRequired().length > 0 && (
              <span style={{ fg: theme().error }}> [RESTART REQUIRED]</span>
            )}
          </text>
          <For each={routes()}>
            {(r: RouteSnapshotEntry) => (
              <text fg={theme().textMuted}>
                <span style={{ fg: LANE_COLOR }}>{r.lane.padEnd(10)} </span>
                <span style={{ fg: MODEL_COLOR }}>{r.best ?? "none available"}</span>
                {r.degraded ? <span style={{ fg: theme().warning }}>*</span> : ""}
              </text>
            )}
          </For>
        </box>
      )}
      {recent().length > 0 && (
        <box paddingTop={1} flexDirection="column" gap={0}>
          <text fg={theme().textMuted}>
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
      {/* [2026-09-02]-[One blank line separating this block from the notice area; branch name in green to match the
          recommended-model color] */}
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

// ---- [2026-09-03]-[/poolConfig //modelRank interactive dialogs: DialogSelect stays open on selection (host submit
//  only fires the callback); checkbox semantics = onSelect toggles in place + writeJsonAtomic persists + toast
//  receipt; cross-layer navigation via dialog.replace (same pattern as the host's built-in dialogs); Esc closes via
//  the host DialogSelect itself. Non-TUI clients go through the cfg.command chat variants]----

function openPoolConfigDialog(api: TuiPluginApi): void {
  api.ui.dialog.replace(() => <PoolPickerDialog api={api} />)
}

function PoolPickerDialog(props: { api: TuiPluginApi }) {
  // [2026-09-03 semantic fix]-[Pool = task lane (economy/mechanical/main/hard/vision/review), not a provider pool:
  //  pick the participating models per lane so the six-lane candidates differ; the same model may join multiple lanes]
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
      title="Task pools (pick a task pool; Esc to exit)"
      options={lanes().map((p) => ({
        title: `${p.sel ? "✎ " : ""}${p.lane}`,
        value: p.lane,
        description: p.sel
          ? `manual selection: ${p.sel.size}/${p.total} models participating`
          : "not configured: system default (all available models participate)",
        onSelect: () => props.api.ui.dialog.replace(() => <PoolModelsDialog api={props.api} lane={p.lane} />),
      }))}
    />
  )
}

function PoolModelsDialog(props: { api: TuiPluginApi; lane: Lane }) {
  const rows = createMemo(() => allModelRows())
  // Initial checkboxes: manually configured → the configured list; unconfigured → system default full set (the first
  // toggle materializes it as an explicit list)
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(
    new Set(loadPoolConfig()[props.lane] ?? rows().map((r) => r.key)),
  )
  const persist = (cur: Set<string>, added: boolean, key: string) => {
    setSelected(cur)
    try {
      writePoolConfig(props.lane, [...cur])
    } catch (exc) {
      // Defensive: unknown lane/IO errors must not break the dialog (current lanes come from LANE_ORDER so this is
      // unreachable; guards future changes)
      props.api.ui.toast({ variant: "error", message: `write failed: ${exc instanceof Error ? exc.message : exc}` })
      return
    }
    props.api.ui.toast({
      variant: added ? "success" : "info",
      message: `${added ? "Added" : "Removed"} ${key} ${added ? "to" : "from"} the ${props.lane} pool (effective immediately, sidebar refreshes)`,
    })
  }
  const toggle = (key: string) => {
    const cur = new Set(selected())
    const added = !cur.has(key)
    if (added) cur.add(key)
    else {
      // Keep at least one participating model; to restore the system default use "Clear config" (empty list =
      // unconfigured = default full set)
      if (cur.size <= 1) {
        props.api.ui.toast({ variant: "warning", message: 'Keep at least one participating model; use "Clear config" to restore the system default' })
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
      props.api.ui.toast({ variant: "error", message: `write failed: ${exc instanceof Error ? exc.message : exc}` })
      return
    }
    props.api.ui.toast({ variant: "success", message: `${props.lane} pool: all models selected` })
  }
  const reset = () => {
    resetPoolConfig(props.lane)
    setSelected(new Set(rows().map((r) => r.key)))
    props.api.ui.toast({ variant: "success", message: `${props.lane} pool config cleared (system default candidate set restored)` })
  }
  const nSel = () => selected().size
  const options = createMemo(() => [
    { title: "← Back to pool list", value: "__back", onSelect: () => props.api.ui.dialog.replace(() => <PoolPickerDialog api={props.api} />) },
    { title: "☑ Select all", value: "__all", onSelect: () => bulk() },
    { title: "✕ Clear config (system default: all available models participate)", value: "__reset", onSelect: reset },
    ...rows().map((r) => ({
      title: `${selected().has(r.key) ? "[x]" : "[ ]"} ${r.modelId}`,
      value: r.key,
      description: `${r.tier}-tier${r.source === "manual" ? " · manual rank" : ""}`,
      onSelect: () => toggle(r.key),
    })),
  ])
  return (
    <props.api.ui.DialogSelect
      title={`${props.lane} pool selection (${nSel()}/${rows().length} participating; select toggles, duplicates across pools allowed)`}
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
      title="Model capability ranking (#1 strongest; manual hits take precedence over base scores; pick a model to adjust)"
      options={rows().map((r, i) => ({
        title: `#${String(i + 1).padStart(2, "0")} ${r.modelId}`,
        value: r.key,
        description: `${r.tier}-tier · ${r.source === "manual" ? "manual rank" : "base capability score"}`,
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
    props.api.ui.toast({ variant: "success", message: `${message} (effective immediately, sidebar refreshes)` })
    props.api.ui.dialog.replace(() => <RankPickerDialog api={props.api} />)
  }
  const move = (delta: -1 | 0 | 1) => {
    // delta 0 = pin to top; ±1 = swap with the neighbor (moving an unranked model up/down = insert at the target
    // position)
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
    apply(cur, delta === 0 ? `Pinned ${props.model} to top` : `Moved ${props.model} to rank #${cur.indexOf(props.modelKey) + 1}`)
  }
  const ranked = () => at() >= 0
  const options = createMemo(() => {
    const list = [
      { title: "▲ Pin to top (set as strongest)", value: "top", onSelect: () => move(0) },
      ...(ranked() && at() > 0
        ? [{ title: "↑ Move up one", value: "up", onSelect: () => move(-1) }]
        : []),
      ...(ranked() && at() < rank().length - 1
        ? [{ title: "↓ Move down one", value: "down", onSelect: () => move(1) }]
        : []),
      ...(ranked()
        ? [{ title: "✕ Remove from ranking (fall back to base score)", value: "out", onSelect: () => apply(rank().filter((k) => k !== props.modelKey), `Removed ${props.model}`) }]
        : [{ title: "＋ Add to ranking (at the end)", value: "in", onSelect: () => move(1) }]),
      { title: "← Back to ranking list", value: "__back", onSelect: () => props.api.ui.dialog.replace(() => <RankPickerDialog api={props.api} />) },
    ]
    return list
  })
  return (
    <props.api.ui.DialogSelect
      title={`${props.model} (currently ${ranked() ? `manual rank #${at() + 1}` : "not manually ranked"})`}
      options={options()}
      flat
    />
  )
}

// ---- [2026-09-04]-[/handover direct-execution variant (bypasses the AI conversation chain, replacing the old
//  cfg.command chat-style handover): core orchestration extracted to src/handover-core.ts (shared with the
//  tool.execute.after auto trigger in the main plugin); this file keeps only the v2 SDK adapter (flat params on
//  api.client) + toast receipts. Behavior: full fork backup ([backup] title tag) → compact the current session → no
//  session switch (distinct from built-in /fork)]----

/** v2 SDK adapter (TUI api.client, flat params; RequestResult fields instead of throwing) */
function v2HandoverPort(api: TuiPluginApi): HandoverPort {
  return {
    async forkFull(sessionID, directory) {
      const res = await api.client.session.fork({ sessionID, directory })
      const data = res?.data
      return data?.id ? { id: String(data.id), title: typeof data.title === "string" ? data.title : undefined } : null
    },
    async setTitle(sessionID, directory, title) {
      const res = await api.client.session.update({ sessionID, directory, title })
      return !res?.error
    },
    // [2026-09-05]-[was session.command {command:"compact"} → "Command not found" (registry: init/review + markdown/MCP/
    //  skill commands only, opencode v1.18.9); before that session.summarize was blamed for the deadlock, but the hang was
    //  caused by AWAITING it from tool.execute.after — the manual path runs detached from the palette. session.summarize
    //  is exactly what the TUI /compact itself calls; manual handover mirrors it (no auto flag = no synthetic continue,
    //  the user drives the next turn); model face from the session record (Session.Info.model {id, providerID})]
    async compact(sessionID, directory) {
      const info: any = await api.client.session.get({ sessionID }).then((r: any) => r?.data).catch(() => undefined)
      const model = info?.model
      const providerID = typeof model?.providerID === "string" ? model.providerID : undefined
      const modelID = typeof model?.id === "string" ? model.id : typeof model?.modelID === "string" ? model.modelID : undefined
      if (!providerID || !modelID) return false // summarize requires providerID+modelID; no model face recorded
      const res = await api.client.session.summarize({ sessionID, directory, providerID, modelID })
      return !res?.error
    },
  }
}

async function runHandoverBackup(api: TuiPluginApi): Promise<void> {
  const route = api.route.current
  const sessionID = route.name === "session" && typeof route.params?.sessionID === "string" ? route.params.sessionID : undefined
  if (!sessionID) {
    api.ui.toast({ variant: "error", message: "/handover: not in a session, nothing to back up" })
    return
  }
  const session = api.state.session.get(sessionID)
  const directory = session?.directory || api.state.path.directory
  api.ui.toast({ variant: "info", message: "/handover: backing up the current session in full and compacting…" })
  const result = await runHandover(v2HandoverPort(api), sessionID, directory)
  if (result.ok) {
    api.ui.toast({
      variant: "success",
      message: `${result.message}; still in the original session, not switched`,
    })
  } else {
    api.ui.toast({ variant: "error", message: `/handover ${result.message}` })
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
  // [2026-09-03]-[/poolConfig //modelRank slash commands (manual dialog entry points; chat variants are
  //  /poolConfig-chat //modelRank-chat): namespace=palette is required to appear in the "/" panel
  //  (the host useCommandSlashes only takes slashName from the palette namespace); on older hosts without
  //  registerLayer, fail-open = only the dialog entry goes missing (the chat cfg.command variants are unaffected)
  // [2026-09-04]-[/handover: direct execution (fork backup + compaction of the current session, no session switch),
  //  no AI interaction, no chat variant]
  try {
    api.keymap.registerLayer({
      commands: [
        {
          name: "switchman.handover",
          title: "Back up and compact the current session",
          desc: "Full fork of the current session as a backup ([backup] title tag) plus compaction of the current session; no session switch (distinct from built-in /fork)",
          category: "switchman",
          namespace: "palette",
          slashName: "handover",
          run: () => void runHandoverBackup(api),
        },
        {
          name: "switchman.pool-config",
          title: "Task pool selection",
          desc: "Pick the participating models per task pool (economy/mechanical/main/hard/vision/review)",
          category: "switchman",
          namespace: "palette",
          slashName: "poolConfig",
          run: () => openPoolConfigDialog(api),
        },
        {
          name: "switchman.model-rank",
          title: "Model capability ranking",
          desc: "Manual capability ranking (takes precedence over base scores; earlier = stronger)",
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
