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
// [2026-09-19]-[render-time TUI localization sweep: sidebar chrome, notices (structured alert flag via renderNotice,
//  replacing the RESTART_HINT_RE regex highlight), quota rows, /poolConfig //modelRank //handover dialogs and palette
//  entries all render via t() against the locale catalogs; the display locale resolves per poll tick (session project
//  lang → global ui.lang → terminal env); marquee title, colors, hotkeys, symbols and layout unchanged]
import type { TuiPlugin, TuiPluginModule, TuiPluginApi } from "@opencode-ai/plugin/tui"
// [2026-09-02]-[solid-js must be imported bare: the host runtime-plugin only rewrites exact specifiers
//  ("solid-js"/"@opentui/solid") at runtime (opentui:runtime-module:* → host instance); the deep path "solid-js/dist/solid.js"
//  misses the rewrite rule and loads a second solid instance → two reactive graphs that never subscribe to each other →
//  the whole panel freezes after mount. Build-time misresolution of server.js is handled by the onLoad redirect in
//  @opentui/solid/bun-plugin (server.js → solid.js client build)]-[impacts live refresh of the TUI panel]
import { createSignal, createMemo, onCleanup, onMount, For } from "solid-js"
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join, relative, isAbsolute, sep, dirname } from "node:path"
// [2026-09-03]-[/poolConfig //modelRank interactive dialogs: task-pool pick lists and capability ranking read/write the
//  user override layer (pool-config.json / capability-rank.json) directly, taking effect in sync with the plugin main
//  process mtime hot reload]
import { loadPoolConfig, writePoolConfig, resetPoolConfig, loadCapabilityRank, writeCapabilityRank, applyRankMove, poolUniverse } from "./user-overrides"
// [2026-09-19]-[/switchman-setup wizard reads live setup completion (mtime-cached reads) so the intro state lines and
//  the Start jump target reflect the config as of dialog open]
import { setupCompletionNow } from "./setup-gate"
// [2026-09-07]-[version line next to the marquee: reuse the selfupdate state/flag readers so the sidebar shares the
//  exact same sources and TTL semantics as the update banner]
import { readSelfUpdateState, flagSemantics, installedPluginVersion, versionBrief } from "./selfupdate"
import { PLUGIN_VERSION } from "./version"
import { allModelRows, rankViewRows } from "./config-cli"
import { LANE_ORDER, type Lane } from "./types"
import { runHandover, type HandoverPort } from "./handover-core"
import { t, resolveDisplayLocale, renderNotice, type LocaleTag, type MsgKey } from "./i18n"
import { readUiLocale, readWorkspaceDirname } from "./state"

type StatusLogEntry = { ts: string; text?: string; key?: string; params?: Record<string, string | number>; alert?: boolean }
type RouteSnapshotEntry = { lane: string; best: string | null; degraded: boolean }
type RouteSnapshot = { ts: string; entries: RouteSnapshotEntry[] }
// [2026-09-02]-[v2: one block per provider plus rows sub-lines (progress bar / reset time), isomorphic to providerStatusEntries in banner.ts]
// [2026-09-19]-[render-time quota i18n: rows/entry blocks carry key+params as the TUI render source (t(locale, key, params)
//  against the quota.* catalog); legacy label/text/tail stay as the fallback when a key is absent]
type QuotaBriefRow = { key?: string; params?: Record<string, string | number>; labelKey?: string; labelParams?: Record<string, string | number>; tailKey?: string; tailParams?: Record<string, string | number>; usedPct: number | null; label?: string; text?: string; tail?: string }
type QuotaBriefEntry = { pool: string; label: string; key?: string; params?: Record<string, string | number>; rows: QuotaBriefRow[]; observeOnly: boolean; peakActive: boolean; stale: boolean }
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
const MARQUEE_MS = 150
const TITLE = "switchman"
// [2026-09-07]-[version/restart flags are session-scoped: mtime later than this process's start = active, matching
//  the main process PLUGIN_START semantics in selfupdate.ts; naturally clears after a restart]
const PROCESS_START = Date.now()
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

// [2026-09-19]-[render-time locale: resolved per poll tick so language switches apply live; session directory first
//  with the TUI directory as the sync fallback (same pattern as refreshBranch/location below; a thenable session.get
//  result degrades to the fallback), then the workspace dirname snapshot, the global ui.lang snapshot, and finally the
//  terminal env inside resolveDisplayLocale; all reads are cheap sync fs]
function resolveTuiLocale(api: TuiPluginApi, sessionID?: string): LocaleTag {
  let sid = sessionID
  if (!sid) {
    try {
      const route = api.route.current
      if (route.name === "session" && typeof route.params?.sessionID === "string") sid = route.params.sessionID
    } catch { /* fail-open: fall through without a session project step */ }
  }
  let sessionDir: string | null = null
  try {
    if (sid) {
      const s = api.state.session.get(sid) as unknown as { directory?: unknown; then?: unknown } | null
      if (s && typeof s.then !== "function" && typeof s.directory === "string" && s.directory) {
        sessionDir = s.directory
      }
    }
  } catch { /* fail-open: fall through to the directory fallback */ }
  if (!sessionDir) {
    try {
      const fallback = api.state.path.directory
      sessionDir = typeof fallback === "string" ? fallback : null
    } catch { sessionDir = null }
  }
  return resolveDisplayLocale({
    sessionDir,
    workspaceDirname: readWorkspaceDirname(),
    uiLang: readUiLocale(),
    env: process.env,
  })
}

// [2026-09-19]-[alert-flag notices: entries carry a structured `alert` flag (see src/state.ts) rendered in error color
//  to tell "manual restart needed" apart from ordinary status chatter at a glance; text renders via renderNotice()
//  (keyed entries translate, legacy prose passes through verbatim)]

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
  // [2026-09-07]-[version line: selfupdate.json (24h TTL-validated), upgrade/ignore flag mtimes vs process start,
  //  and the on-disk package.json version (prod restart-needed detection); all fail-open like the other readers]
  const [selfUpdate, setSelfUpdate] = createSignal(readSelfUpdateState())
  const [updateFlags, setUpdateFlags] = createSignal(flagSemantics(statusLogPath(), PROCESS_START))
  const [installedVersion, setInstalledVersion] = createSignal<string | null>(installedPluginVersion())
  const [tick, setTick] = createSignal(0)
  // [2026-09-19]-[display locale signal: refreshed inside the poll tick below so language switches apply live]
  const [locale, setLocale] = createSignal<LocaleTag>(resolveTuiLocale(props.api, props.sessionID))
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
    setSelfUpdate(readSelfUpdateState())
    setUpdateFlags(flagSemantics(statusLogPath(), PROCESS_START))
    setInstalledVersion(installedPluginVersion())
    setLocale(resolveTuiLocale(props.api, props.sessionID))
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
  // [2026-09-07]-[version line derivation: running label (local adds the checked commit short SHA), update tag
  //  (suppressed by /switchman-ignore like the banner), and upgrade-pending restart detection]
  const version = createMemo(() => versionBrief({
    state: selfUpdate(),
    flags: updateFlags(),
    running: PLUGIN_VERSION,
    installed: installedVersion(),
  }))
  const restartPending = () => restartRequired().length > 0 || version().restartPending

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
                  <b><span style={{ fg: theme().text }}>{q.key ? t(locale(), q.key as MsgKey, q.params) : q.label}</span></b>
                  {q.peakActive && <span style={{ fg: theme().warning }}>{t(locale(), "sidebar.peakTag")}</span>}
                  {q.stale && <span style={{ fg: theme().warning }}>{t(locale(), "sidebar.staleTag")}</span>}
                  {q.observeOnly && !allObserve && <span style={{ fg: theme().textMuted }}>{t(locale(), "sidebar.observeOnlyTag")}</span>}
                </text>
                <For each={q.rows}>
                  {(r) => {
                    const rowText = r.key ? t(locale(), r.key as MsgKey, r.params) : (r.text ?? "")
                    const rowLabel = r.labelKey ? t(locale(), r.labelKey as MsgKey, r.labelParams) : (r.label ?? "")
                    const rowTail = r.tailKey ? t(locale(), r.tailKey as MsgKey, r.tailParams) : r.tail
                    const { fill, track, rest } = splitBarText(rowText)
                    const value = waterColor(r.usedPct)
                    return (
                      <text>
                        <span style={{ fg: theme().textMuted }}>{rowLabel ? `  ${padEndW(rowLabel, 8)}` : "  "}</span>
                        <span style={{ fg: value ?? theme().textMuted }}>{fill}</span>
                        <span style={{ fg: theme().textMuted }}>{track}</span>
                        <span style={{ fg: value ?? theme().textMuted }}>{rest}</span>
                        {rowTail && <span style={{ fg: theme().textMuted }}> {rowTail}</span>}
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
            {/* [2026-09-07]-[version line next to the marquee: muted running version (local mode appends the checked
                commit short SHA), green "→ latest" when outdated, and the blinking restart tag now merges the
                shell-registration restartRequired with upgrade-pending (upgraded.flag / prod disk-version mismatch);
                fail-open unchanged: missing state renders just the bare running version]-[impacts the sidebar title row only] */}
            <span style={{ fg: theme().textMuted }}> {version().running}</span>
            {version().update !== null && <span style={{ fg: MODEL_COLOR }}>{t(locale(), "sidebar.updateAvailable", { updateVersion: version().update! })}</span>}
            {/* [2026-09-06]-[blinking restart tag: ~600ms on/off via the 150ms marquee heartbeat (tick/4 parity), bold
                red — a pending shell-registration restart used to render as a static tag that was easy to stop seeing;
                fail-open unchanged: empty restartRequired list renders nothing]-[impacts the sidebar title row only] */}
            {restartPending() && Math.floor(tick() / 4) % 2 === 0 && (
              <span style={{ fg: theme().error }}><b>{t(locale(), "sidebar.restartNeeded")}</b></span>
            )}
          </text>
          <For each={routes()}>
            {(r: RouteSnapshotEntry) => (
              <text fg={theme().textMuted}>
                {/* [2026-09-19]-[lane labels localized for DISPLAY ONLY: t() falls back to the raw lane identifier
                    (unknown/custom lanes render verbatim), so runtime LANE_ORDER, pool-config.json keys, [ROUTES] and
                    the protocol keep the hardcoded English identifiers; padEndW keeps CJK labels column-aligned]}
                    -[display-layer change, zero runtime impact] */}
                <span style={{ fg: LANE_COLOR }}>{padEndW(t(locale(), `sidebar.lane.${r.lane}` as MsgKey, undefined, r.lane), 10)} </span>
                <span style={{ fg: MODEL_COLOR }}>{r.best ?? t(locale(), "sidebar.noneAvailable")}</span>
                {r.degraded ? <span style={{ fg: theme().warning }}>*</span> : ""}
              </text>
            )}
          </For>
        </box>
      )}
      {recent().length > 0 && (
        <box paddingTop={1} flexDirection="column" gap={0}>
          <text fg={theme().textMuted}>
            <b>{t(locale(), "sidebar.noticeLabel")}</b>
          </text>
          <For each={recent()}>
            {(item: StatusLogEntry) => (
              <text fg={theme().textMuted}>
                <span style={{ fg: theme().textMuted }}>{item.ts.slice(11, 19)} </span>
                <span style={{ fg: item.alert ? theme().error : theme().text }}><b>{renderNotice(item, locale())}</b></span>
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
  // [2026-09-19]-[dialogs resolve the display locale once at mount (transient UI; the sidebar signal covers live switches)]
  const loc = resolveTuiLocale(props.api)
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
      title={t(loc, "dialog.pool.title")}
      options={lanes().map((p) => ({
        title: t(loc, "dialog.pool.laneRow", { pinMark: p.sel ? "✎ " : "", lane: p.lane }),
        value: p.lane,
        description: p.sel
          ? t(loc, "dialog.pool.manualSelection", { selCount: p.sel.size, totalCount: p.total })
          : t(loc, "dialog.pool.notConfigured"),
        onSelect: () => props.api.ui.dialog.replace(() => <PoolModelsDialog api={props.api} lane={p.lane} />),
      }))}
    />
  )
}

function PoolModelsDialog(props: { api: TuiPluginApi; lane: Lane }) {
  const loc = resolveTuiLocale(props.api)
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
      props.api.ui.toast({ variant: "error", message: t(loc, "dialog.pool.toggleWriteFailed", { message: exc instanceof Error ? exc.message : String(exc) }) })
      return
    }
    props.api.ui.toast({
      variant: added ? "success" : "info",
      message: t(loc, "dialog.pool.modelToggled", {
        verb: added ? "Added" : "Removed",
        modelKey: key,
        direction: added ? "to" : "from",
        lane: props.lane,
      }),
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
        props.api.ui.toast({ variant: "warning", message: t(loc, "dialog.pool.keepOneModel") })
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
      props.api.ui.toast({ variant: "error", message: t(loc, "dialog.pool.bulkWriteFailed", { message: exc instanceof Error ? exc.message : String(exc) }) })
      return
    }
    props.api.ui.toast({ variant: "success", message: t(loc, "dialog.pool.allSelected", { lane: props.lane }) })
  }
  const reset = () => {
    resetPoolConfig(props.lane)
    setSelected(new Set(rows().map((r) => r.key)))
    props.api.ui.toast({ variant: "success", message: t(loc, "dialog.pool.configCleared", { lane: props.lane }) })
  }
  // [2026-09-06]-[Uncheck-all shortcut: clears the checkbox state in place (no disk write) so a short list can be
  //  built by checking a few models instead of unchecking the rest one by one; while nothing is checked the previous
  //  config stays untouched on disk — exiting without any check keeps the pre-clear selection in effect, and the
  //  first check after the clear materializes the new explicit list]-[impacts PoolModelsDialog only]
  const uncheckAll = () => {
    if (selected().size === 0) return
    setSelected(new Set<string>())
    props.api.ui.toast({ variant: "info", message: t(loc, "dialog.pool.allUnchecked", { lane: props.lane }) })
  }
  const nSel = () => selected().size
  const options = createMemo(() => [
    { title: t(loc, "dialog.pool.back"), value: "__back", onSelect: () => props.api.ui.dialog.replace(() => <PoolPickerDialog api={props.api} />) },
    { title: t(loc, "dialog.pool.selectAll"), value: "__all", onSelect: () => bulk() },
    { title: t(loc, "dialog.pool.uncheckAll"), value: "__uncheckAll", onSelect: uncheckAll },
    { title: t(loc, "dialog.pool.clearConfig"), value: "__reset", onSelect: reset },
    ...rows().map((r) => ({
      title: t(loc, "dialog.pool.modelRow", { checkMark: selected().has(r.key) ? "[x]" : "[ ]", modelId: r.modelId }),
      value: r.key,
      description: t(loc, "dialog.pool.rowMeta", { tier: r.tier, manualSuffix: r.source === "manual" ? " · manual rank" : "" }),
      onSelect: () => toggle(r.key),
    })),
  ])
  return (
    <props.api.ui.DialogSelect
      title={t(loc, "dialog.pool.selectionTitle", { lane: props.lane, selCount: nSel(), rowCount: rows().length })}
      options={options()}
      flat
    />
  )
}

function openModelRankDialog(api: TuiPluginApi): void {
  // [2026-09-18]-[rank universe = pool selection: with no task pool configured there is nothing to rank — guide to
  //  /poolConfig instead of offering a full-superset ranking list (the config flow is poolConfig → modelRank)]
  api.ui.dialog.replace(() =>
    poolUniverse().size === 0
      ? <RankUniverseEmptyDialog api={api} />
      : <RankPickerDialog api={api} />
  )
}

// ---- [2026-09-18]-[/modelRank empty state: no task-pool selection yet — one action jumps straight into the pool
//  picker so the two-step config flow (poolConfig → modelRank) stays a single round trip]----

function RankUniverseEmptyDialog(props: { api: TuiPluginApi }) {
  const loc = resolveTuiLocale(props.api)
  const options = createMemo(() => [
    { title: t(loc, "dialog.rank.openPoolSelection"), value: "__pools", onSelect: () => props.api.ui.dialog.replace(() => <PoolPickerDialog api={props.api} />) },
    { title: t(loc, "dialog.rank.close"), value: "__close", onSelect: () => props.api.ui.dialog.clear() },
  ])
  return (
    <props.api.ui.DialogSelect
      title={t(loc, "dialog.rank.universeEmptyTitle")}
      options={options()}
      flat
    />
  )
}

// ---- [2026-09-10]-[interleaved move plumbing: one shared path for the list hotkeys and the per-model actions dialog —
//  loads the rank file, applies applyRankMove against the merged view, persists models+scores, toasts the anchored result]----

function rankMoveApply(api: TuiPluginApi, key: string, delta: -1 | 0 | 1): boolean {
  const loc = resolveTuiLocale(api)
  const rank = loadCapabilityRank()
  const view = rankViewRows()
  const name = view.find((r) => r.key === key)?.modelId ?? key
  const res = applyRankMove(rank?.models ?? [], rank?.scores, view, key, delta)
  if (!res) {
    api.ui.toast({
      variant: "info",
      message: t(loc, "dialog.rank.alreadyAtEdge", { modelName: name, edge: delta === 1 ? "bottom" : "top" }),
    })
    return false
  }
  try {
    writeCapabilityRank(res.models, res.scores)
  } catch (exc) {
    api.ui.toast({ variant: "error", message: t(loc, "dialog.rank.moveWriteFailed", { message: exc instanceof Error ? exc.message : String(exc) }) })
    return false
  }
  api.ui.toast({
    variant: "success",
    message: t(loc, "dialog.rank.pinnedOrMoved", {
      verb: delta === 0 ? "Pinned" : "Moved",
      modelName: name,
      position: res.position + 1,
      tier: res.score.tier,
      raw: res.score.raw,
    }),
  })
  return true
}

// ---- [2026-09-06]-[/modelRank list hotkeys: ctrl+up / ctrl+down (alt+up / alt+down mirrored for terminals that swallow
//  ctrl+arrows) move the highlighted model within the manual ranking without opening the per-model action dialog.
//  The host DialogSelect has no per-dialog key API exposed to plugins, so the binding lives in the global keymap layer
//  (registered in tui() below; ctrl/alt+arrows are unbound by the host) and the open dialog claims the module-level
//  context: with no claimant the commands are silent no-ops, so global key real estate stays clean]----
type RankHotkeyClaim = { move: (delta: -1 | 1) => void }
let rankHotkeyClaim: RankHotkeyClaim | null = null

function RankPickerDialog(props: { api: TuiPluginApi }) {
  const loc = resolveTuiLocale(props.api)
  // rev bumps on every hotkey write so rows() re-reads the rank file and re-sorts the list in place (enter-action
  // flows keep using dialog.replace instead, which rebuilds the component from scratch)
  const [rev, setRev] = createSignal(0)
  const rows = createMemo(() => {
    rev()
    return rankViewRows()
  })
  // Highlight tracking: onMove covers filter/navigate; before the first onMove the host selects row 0
  const [highlight, setHighlight] = createSignal<string | null>(null)
  const highlighted = () => highlight() ?? rows()[0]?.key ?? null
  // [2026-09-10]-[hover feedback loop fix: mirroring onMove back into `current` re-fired the host's
  //  current-effects on every mouse-over — the setTimeout moveTo(index, center) call re-scrolled the list
  //  to center the hovered row, sliding fresh rows under the stationary cursor, each firing another
  //  onMouseOver → onMove → current change → re-scroll: an unbounded self-sustaining scroll loop. `current`
  //  is now driven only by explicit programmatic jumps (the ctrl/alt+up/down hotkey moves below), never
  //  mirrored from onMove]-[fixes the runaway /modelRank list scrolling after mouse movement; the ● marker
  //  now marks the last hotkey-moved model only]
  const [cursor, setCursor] = createSignal<string | null>(null)
  const claim: RankHotkeyClaim = {
    move: (delta) => {
      const key = highlighted()
      if (!key) return
      // [2026-09-10]-[interleaved semantics: the move acts on the merged view (manual + base models); any model can
      //  move up/down — unranked ones materialize an anchored manual score between their neighbors]
      if (rankMoveApply(props.api, key, delta)) {
        // Cursor follows the moved model: `current` is the only cursor control the plugin DialogSelect exposes
        // (side effect: the ● marker stays on the last-moved model until the dialog closes); set here ONLY —
        // see the hover feedback loop note above for why onMove must not feed into `current`
        setHighlight(key)
        setCursor(key)
        setRev((v) => v + 1)
      }
    },
  }
  rankHotkeyClaim = claim
  onCleanup(() => {
    if (rankHotkeyClaim === claim) rankHotkeyClaim = null
  })
  return (
    <props.api.ui.DialogSelect
      title={t(loc, "dialog.rank.title")}
      placeholder={t(loc, "dialog.rank.searchHint")}
      options={rows().map((r, i) => ({
        title: t(loc, "dialog.rank.row", { rankPadded: String(i + 1).padStart(2, "0"), modelId: r.modelId }),
        value: r.key,
        description: t(loc, "dialog.rank.rowMeta", {
          tier: r.tier,
          scoreSource: r.source === "manual" ? `manual${r.raw !== null ? ` ${r.raw}` : ""}` : "base capability score",
          poolSuffix: r.poolMember === false ? " · not in any task pool" : "",
        }),
        onSelect: () => props.api.ui.dialog.replace(() => <RankActionsDialog api={props.api} model={r.modelId} modelKey={r.key} />),
      }))}
      current={cursor() ?? undefined}
      onMove={(opt) => setHighlight(String(opt.value))}
      flat
    />
  )
}

function RankActionsDialog(props: { api: TuiPluginApi; model: string; modelKey: string }) {
  const loc = resolveTuiLocale(props.api)
  // [2026-09-10]-[interleaved semantics: up/down/pin act on the merged view via the shared rankMoveApply path (any
  //  model can move — unranked ones materialize an anchored manual score between their neighbors); the obsolete
  //  "add at the end" action is gone; remove strips both the membership and the anchored score]
  const rank = () => loadCapabilityRank()
  const ranked = () => (rank()?.models ?? []).includes(props.modelKey)
  const anchored = () => rank()?.scores?.[props.modelKey]
  const move = (delta: -1 | 0 | 1) => {
    if (rankMoveApply(props.api, props.modelKey, delta)) {
      props.api.ui.dialog.replace(() => <RankPickerDialog api={props.api} />)
    }
  }
  const remove = () => {
    const cur = rank()
    const nextModels = (cur?.models ?? []).filter((k) => k !== props.modelKey)
    const nextScores = { ...(cur?.scores ?? {}) }
    delete nextScores[props.modelKey]
    try {
      writeCapabilityRank(nextModels, Object.keys(nextScores).length > 0 ? nextScores : undefined)
    } catch (exc) {
      props.api.ui.toast({ variant: "error", message: t(loc, "dialog.rank.removeWriteFailed", { message: exc instanceof Error ? exc.message : String(exc) }) })
      return
    }
    props.api.ui.toast({ variant: "success", message: t(loc, "dialog.rank.removed", { model: props.model }) })
    props.api.ui.dialog.replace(() => <RankPickerDialog api={props.api} />)
  }
  const options = createMemo(() => [
    { title: t(loc, "dialog.rank.pinTop"), value: "top", onSelect: () => move(0) },
    { title: t(loc, "dialog.rank.moveUp"), value: "up", onSelect: () => move(-1) },
    { title: t(loc, "dialog.rank.moveDown"), value: "down", onSelect: () => move(1) },
    ...(ranked()
      ? [{ title: t(loc, "dialog.rank.remove"), value: "out", onSelect: remove }]
      : []),
    { title: t(loc, "dialog.rank.back"), value: "__back", onSelect: () => props.api.ui.dialog.replace(() => <RankPickerDialog api={props.api} />) },
  ])
  const a = anchored()
  return (
    <props.api.ui.DialogSelect
      title={t(loc, "dialog.rank.detailTitle", {
        model: props.model,
        rankState: ranked() ? `manually ranked${a ? `, anchored score ${a.tier}/${a.raw}` : " (legacy ladder order)"}` : "not manually ranked",
      })}
      options={options()}
      flat
    />
  )
}

// ---- [2026-09-19]-[/switchman-setup guided wizard: replaces the old default-all behavior (unconfigured pools no
//  longer fall back to every model). Flow: intro (current state + jump to the first unfinished step) → one dialog per
//  task lane in LANE_ORDER order (deliberate curation: selection starts EMPTY even when the lane is unconfigured;
//  Enter toggles in memory only, the per-lane confirm persists to pool-config.json so every save hot-reloads the
//  running plugin and the wizard stays resumable lane-by-lane) → sequential capability-rank pick (min 1 model) →
//  done screen reporting the hot effect plus any providers still flagged restartRequired. Dialog family mirrors
//  PoolPickerDialog/PoolModelsDialog/RankPickerDialog: locale resolved once at mount, Set-based toggles with
//  [x]/[ ] baked into titles, dialog.replace navigation, Esc handled by the host. Locale keys: dialog.setup.* /
//  palette.setup.*]----

function openSetupWizard(api: TuiPluginApi): void {
  api.ui.dialog.replace(() => <SetupIntroDialog api={api} />)
}

function SetupIntroDialog(props: { api: TuiPluginApi }) {
  const loc = resolveTuiLocale(props.api)
  // Completion is frozen at open (transient dialog); Start re-evaluates so it always jumps to the first unfinished step
  const state = setupCompletionNow()
  // {state} has no localized word pair yet — plain "ok"/"missing" strings
  const rankState = state.missingRank ? "missing" : "ok"
  const start = () => {
    const c = setupCompletionNow()
    // First lane in LANE_ORDER order whose selection is empty (missingLanes preserves LANE_ORDER order)
    const laneIdx = LANE_ORDER.findIndex((lane) => c.missingLanes.includes(lane))
    if (laneIdx >= 0) props.api.ui.dialog.replace(() => <SetupLaneDialog api={props.api} laneIdx={laneIdx} />)
    else if (c.missingRank) props.api.ui.dialog.replace(() => <SetupRankDialog api={props.api} />)
    else props.api.ui.dialog.replace(() => <SetupDoneDialog api={props.api} />)
  }
  const options = createMemo(() => [
    { title: t(loc, "dialog.setup.start"), value: "__start", description: t(loc, "dialog.setup.intro"), onSelect: start },
    { title: t(loc, "dialog.rank.close"), value: "__cancel", onSelect: () => props.api.ui.dialog.clear() },
    // Footer-ish info rows (disabled): current pools/rank state at open time
    { title: t(loc, "dialog.setup.statePools", { count: state.configuredLanes }), value: "__statePools", disabled: true },
    { title: t(loc, "dialog.setup.stateRank", { state: rankState }), value: "__stateRank", disabled: true },
  ])
  return (
    <props.api.ui.DialogSelect
      title={t(loc, "dialog.setup.title")}
      options={options()}
      flat
    />
  )
}

function SetupLaneDialog(props: { api: TuiPluginApi; laneIdx: number }) {
  const loc = resolveTuiLocale(props.api)
  const lane = LANE_ORDER[props.laneIdx]
  const rows = createMemo(() => allModelRows())
  // Deliberate curation: resume the configured list when present, otherwise start EMPTY (no default-all — that is
  // exactly the behavior this wizard replaces)
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(
    new Set(loadPoolConfig()[lane] ?? []),
  )
  // Select-all / clear-all stay in memory: nothing is written until the explicit confirm below
  const bulkAll = () => setSelected(new Set(rows().map((r) => r.key)))
  const bulkClear = () => setSelected(new Set<string>())
  const toggle = (key: string) => {
    const cur = new Set(selected())
    if (cur.has(key)) cur.delete(key)
    else cur.add(key)
    setSelected(cur)
  }
  const back = () => {
    if (props.laneIdx > 0) props.api.ui.dialog.replace(() => <SetupLaneDialog api={props.api} laneIdx={props.laneIdx - 1} />)
    else props.api.ui.dialog.replace(() => <SetupIntroDialog api={props.api} />)
  }
  const confirm = () => {
    if (selected().size === 0) {
      props.api.ui.toast({ variant: "warning", message: t(loc, "dialog.setup.keepOne") })
      return
    }
    try {
      writePoolConfig(lane, [...selected()])
    } catch (exc) {
      // Same fail-open semantics as PoolModelsDialog: an IO error must not break the dialog
      props.api.ui.toast({ variant: "error", message: t(loc, "dialog.pool.toggleWriteFailed", { message: exc instanceof Error ? exc.message : String(exc) }) })
      return
    }
    // Receipt reuses statePools with the fresh configured count (mtime-cached read sees this write immediately)
    props.api.ui.toast({ variant: "success", message: t(loc, "dialog.setup.statePools", { count: setupCompletionNow().configuredLanes }) })
    if (props.laneIdx + 1 < LANE_ORDER.length) props.api.ui.dialog.replace(() => <SetupLaneDialog api={props.api} laneIdx={props.laneIdx + 1} />)
    else props.api.ui.dialog.replace(() => <SetupRankDialog api={props.api} />)
  }
  const options = createMemo(() => [
    { title: t(loc, "dialog.setup.selectAll"), value: "__all", onSelect: bulkAll },
    { title: t(loc, "dialog.setup.clearAll"), value: "__clear", onSelect: bulkClear },
    { title: t(loc, "dialog.setup.back"), value: "__back", onSelect: back },
    { title: t(loc, "dialog.setup.confirmLane", { lane, count: selected().size }), value: "__confirm", onSelect: confirm },
    ...rows().map((r) => ({
      title: t(loc, "dialog.setup.laneRow", { checkMark: selected().has(r.key) ? "[x]" : "[ ]", modelId: r.modelId }),
      value: r.key,
      description: t(loc, "dialog.pool.rowMeta", { tier: r.tier, manualSuffix: r.source === "manual" ? " · manual rank" : "" }),
      onSelect: () => toggle(r.key),
    })),
  ])
  return (
    <props.api.ui.DialogSelect
      title={t(loc, "dialog.setup.laneTitle", { index: props.laneIdx + 1, lane, count: selected().size })}
      options={options()}
      flat
    />
  )
}

function SetupRankDialog(props: { api: TuiPluginApi }) {
  const loc = resolveTuiLocale(props.api)
  // Sequential pick: every selection appends to `picked` and the dialog rebuilds with the next pick number
  // (rev bumps like RankPickerDialog so the remaining-rows memo re-reads the universe)
  const [rev, setRev] = createSignal(0)
  const [picked, setPicked] = createSignal<string[]>([])
  const remaining = createMemo(() => {
    rev()
    const uni = poolUniverse()
    const done = new Set(picked())
    return allModelRows().filter((r) => uni.has(r.key) && !done.has(r.key))
  })
  // Guard: an empty rank universe should be unreachable (pools were just configured), divert to the intro instead of
  // stranding the user on an action-less list
  onMount(() => {
    if (poolUniverse().size === 0) {
      props.api.ui.toast({ variant: "warning", message: t(loc, "dialog.setup.keepOne") })
      props.api.ui.dialog.replace(() => <SetupIntroDialog api={props.api} />)
    }
  })
  const finish = () => {
    if (picked().length === 0) {
      props.api.ui.toast({ variant: "warning", message: t(loc, "dialog.setup.rankMinOne") })
      return
    }
    try {
      writeCapabilityRank(picked(), undefined)
    } catch (exc) {
      props.api.ui.toast({ variant: "error", message: t(loc, "dialog.rank.moveWriteFailed", { message: exc instanceof Error ? exc.message : String(exc) }) })
      return
    }
    props.api.ui.toast({ variant: "success", message: t(loc, "dialog.setup.rankFinish", { count: picked().length }) })
    props.api.ui.dialog.replace(() => <SetupDoneDialog api={props.api} />)
  }
  const pick = (key: string) => {
    setPicked((cur) => (cur.includes(key) ? cur : [...cur, key]))
    setRev((v) => v + 1)
  }
  const options = createMemo(() => [
    { title: t(loc, "dialog.setup.rankFinish", { count: picked().length }), value: "__finish", onSelect: finish },
    ...remaining().map((r) => ({
      title: t(loc, "dialog.setup.laneRow", { checkMark: "→", modelId: r.modelId }),
      value: r.key,
      description: t(loc, "dialog.pool.rowMeta", { tier: r.tier, manualSuffix: r.source === "manual" ? " · manual rank" : "" }),
      onSelect: () => pick(r.key),
    })),
  ])
  return (
    <props.api.ui.DialogSelect
      title={t(loc, "dialog.setup.rankTitle", { n: picked().length + 1, remaining: remaining().length })}
      options={options()}
      flat
    />
  )
}

function SetupDoneDialog(props: { api: TuiPluginApi }) {
  const loc = resolveTuiLocale(props.api)
  const poolCfg = loadPoolConfig()
  const summary = LANE_ORDER.map((lane) => `${lane} ${poolCfg[lane]?.size ?? 0}`).join(", ")
  const order = (loadCapabilityRank()?.models ?? []).join(" > ")
  const restart = readRestartRequired()
  const options = createMemo(() => [
    { title: t(loc, "dialog.setup.donePools", { summary }), value: "__pools", disabled: true },
    { title: t(loc, "dialog.setup.doneRank", { order }), value: "__rank", disabled: true },
    ...(restart.length > 0
      ? [{ title: t(loc, "dialog.setup.restartHint", { providers: restart.join(", ") }), value: "__restart", disabled: true }]
      : []),
    { title: t(loc, "dialog.rank.close"), value: "__close", onSelect: () => props.api.ui.dialog.clear() },
  ])
  return (
    <props.api.ui.DialogSelect
      title={t(loc, "dialog.setup.doneTitle")}
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
    // [2026-09-05]-[titles feed the backup sequence counter (see handover-core backupTitle); v2 list may be a plain
    //  array or a paginated {items} — both degrade to [] when absent]
    async listTitles(directory) {
      const res: any = await api.client.session.list({ directory })
      const data = res?.data
      const arr = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []
      return arr.map((s: any) => (typeof s?.title === "string" ? s.title : "")).filter(Boolean)
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
  const loc = resolveTuiLocale(api, sessionID)
  if (!sessionID) {
    api.ui.toast({ variant: "error", message: t(loc, "dialog.handover.noSession") })
    return
  }
  const session = api.state.session.get(sessionID)
  const directory = session?.directory || api.state.path.directory
  api.ui.toast({ variant: "info", message: t(loc, "dialog.handover.inProgress") })
  const result = await runHandover(v2HandoverPort(api), sessionID, directory)
  if (result.ok) {
    api.ui.toast({
      variant: "success",
      message: t(loc, "dialog.handover.resultStay", { resultMessage: result.message }),
    })
  } else {
    api.ui.toast({ variant: "error", message: t(loc, "dialog.handover.result", { resultMessage: result.message }) })
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
  // [2026-09-19]-[palette copy resolves the display locale once at registration (static host strings)]
  const paletteLoc = resolveTuiLocale(api)
  try {
    api.keymap.registerLayer({
      commands: [
        {
          name: "switchman.handover",
          title: t(paletteLoc, "palette.handover.title"),
          desc: t(paletteLoc, "palette.handover.desc"),
          category: t(paletteLoc, "palette.category.label"),
          namespace: "palette",
          slashName: "handover",
          run: () => void runHandoverBackup(api),
        },
        {
          name: "switchman.pool-config",
          title: t(paletteLoc, "palette.poolConfig.title"),
          desc: t(paletteLoc, "palette.poolConfig.desc"),
          category: t(paletteLoc, "palette.category.label"),
          namespace: "palette",
          slashName: "poolConfig",
          run: () => openPoolConfigDialog(api),
        },
        {
          name: "switchman.model-rank",
          title: t(paletteLoc, "palette.modelRank.title"),
          desc: t(paletteLoc, "palette.modelRank.desc"),
          category: t(paletteLoc, "palette.category.label"),
          namespace: "palette",
          slashName: "modelRank",
          run: () => openModelRankDialog(api),
        },
        {
          name: "switchman.setup",
          title: t(paletteLoc, "palette.setup.title"),
          desc: t(paletteLoc, "palette.setup.desc"),
          category: t(paletteLoc, "palette.category.label"),
          namespace: "palette",
          slashName: "switchman-setup",
          run: () => void openSetupWizard(api),
        },
      ],
      bindings: [],
    })
  } catch { /* fail-open */ }
  // [2026-09-06]-[/modelRank list hotkeys: separate fail-open block so a keymap that rejects these bindings cannot take
  //  down the palette commands above; only active while the ranking dialog is open (claims rankHotkeyClaim), alt
  //  variants mirror ctrl for terminals that swallow ctrl+arrows; hidden keeps them out of the palettes]-
  try {
    api.keymap.registerLayer({
      commands: [
        {
          name: "switchman.rank.move-up",
          title: "Move the highlighted model up in /modelRank",
          desc: "In the /modelRank dialog, move the highlighted model up one spot in the manual ranking",
          category: "switchman",
          hidden: true,
          run: () => rankHotkeyClaim?.move(-1),
        },
        {
          name: "switchman.rank.move-down",
          title: "Move the highlighted model down in /modelRank",
          desc: "In the /modelRank dialog, move the highlighted model down one spot in the manual ranking",
          category: "switchman",
          hidden: true,
          run: () => rankHotkeyClaim?.move(1),
        },
      ],
      bindings: [
        { key: "ctrl+up", cmd: "switchman.rank.move-up", desc: "Move the highlighted model up in /modelRank" },
        { key: "ctrl+down", cmd: "switchman.rank.move-down", desc: "Move the highlighted model down in /modelRank" },
        { key: "alt+up", cmd: "switchman.rank.move-up", desc: "Move the highlighted model up in /modelRank" },
        { key: "alt+down", cmd: "switchman.rank.move-down", desc: "Move the highlighted model down in /modelRank" },
      ],
    })
  } catch { /* fail-open: hosts without binding-layer support keep the enter-only flow */ }
}

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-switchman.status",
  tui,
}

export default plugin
