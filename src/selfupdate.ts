// [2026-09-04]-[English localization: translate CLI messages and comments; no logic change]
// Plugin self-update check: state cache and all external calls are fail-open, never affecting OpenCode startup.
import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { paths, readJson, withPathLock, writeJsonAtomic, appendStatusLog } from "./state"
import { resolveOpencodeConfigDir } from "./config"
import { PLUGIN_VERSION } from "./version"

export type LoadMode = "local" | "prod"

export interface SelfUpdateState {
  checked_at: string
  mode: LoadMode
  current: string
  latest: string
  outdated: boolean
}

const UPDATE_TTL_MS = 24 * 60 * 60 * 1000

// [2026-08-29]-[Fix P0: the desktop opencode module loader does not provide import.meta.dir (bun/CLI does) —
//  the config hook would TypeError on split right after entering detectLoadMode, fail-open swallows it resulting in zero shell injection and dead dispatch;
//  fall back to import.meta.url (guaranteed to exist by the ESM spec) to resolve the directory]-
function moduleDir(): string {
  const meta = import.meta as any
  if (typeof meta.dir === "string" && meta.dir) return meta.dir
  const url = typeof meta.url === "string" ? meta.url : ""
  if (url.startsWith("file://")) {
    try {
      return dirname(fileURLToPath(url))
    } catch { /* fallthrough */ }
  }
  return dirname(decodeURIComponent(url).replace(/^file:\/\//, ""))
}

export function modeOfDistPath(dir: string): LoadMode {
  return dir.split(/[\\/]+/).includes("node_modules") ? "prod" : "local"
}

export function detectLoadMode(): LoadMode {
  return modeOfDistPath(moduleDir())
}

/** Positive means latest is newer than current; prerelease markers are ignored per spec. */
export function compareSemver(current: string, latest: string): number {
  const parts = (version: string): number[] => version.replace(/^v/, "").split("-")[0]!.split(".")
    .slice(0, 3).map((part) => Number.parseInt(part, 10) || 0)
  const a = parts(current)
  const b = parts(latest)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (b[i] ?? 0) - (a[i] ?? 0)
  }
  return 0
}

function validState(value: unknown): value is SelfUpdateState {
  if (!value || typeof value !== "object") return false
  const state = value as Partial<SelfUpdateState>
  return typeof state.checked_at === "string" && (state.mode === "local" || state.mode === "prod")
    && typeof state.current === "string" && typeof state.latest === "string" && typeof state.outdated === "boolean"
}

export function readSelfUpdateState(): SelfUpdateState | null {
  const state = readJson<unknown>(paths().selfupdate)
  if (!validState(state)) return null
  const checkedAt = Date.parse(state.checked_at)
  if (!Number.isFinite(checkedAt) || Date.now() - checkedAt > UPDATE_TTL_MS) return null
  return state
}

function localUpdateState(): SelfUpdateState {
  const root = dirname(moduleDir())
  const latest = execFileSync("git", ["ls-remote", "https://github.com/mrzturn/opencode-switchman.git", "refs/heads/main"], {
    timeout: 8_000, encoding: "utf8",
  }).trim().split(/\s+/)[0]
  const current = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 8_000, encoding: "utf8" }).trim()
  if (!latest || !current) throw new Error("git update check returned no commit SHA")
  return { checked_at: new Date().toISOString(), mode: "local", current, latest: "origin/main has new commits", outdated: latest !== current }
}

async function prodUpdateState(): Promise<SelfUpdateState> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetch("https://registry.npmjs.org/opencode-switchman/latest", { signal: controller.signal })
    if (!response.ok) throw new Error(`npm registry HTTP ${response.status}`)
    const body = await response.json() as { version?: unknown }
    if (typeof body.version !== "string") throw new Error("npm registry returned no version")
    return {
      checked_at: new Date().toISOString(), mode: "prod", current: PLUGIN_VERSION, latest: body.version,
      outdated: compareSemver(PLUGIN_VERSION, body.version) > 0,
    }
  } finally {
    clearTimeout(timer)
  }
}

export async function refreshSelfUpdate(): Promise<SelfUpdateState | null> {
  const path = paths().selfupdate
  return withPathLock(path, async () => {
    const cached = readSelfUpdateState()
    if (cached) return cached
    try {
      const state = detectLoadMode() === "prod" ? await prodUpdateState() : localUpdateState()
      writeJsonAtomic(path, state)
      return state
    } catch (exc) {
      appendStatusLog(`self-update check fail-open: ${exc}`)
      return null
    }
  })
}

export function bannerTextOf(state: SelfUpdateState | null, now = Date.now(), baseDir?: string): string | null {
  if (!state?.outdated) return null
  const flags = flagSemantics(baseDir)
  // [2026-08-29]-[Upgrade complete: the banner shows "upgraded, restart pending", overriding the version hint]-
  if (flags.upgraded) return `opencode-switchman upgraded (running ${state.current}) — restart opencode to take effect`
  if (flags.ignored) return null // ignored this time: session-scoped, the hint returns automatically after a restart
  if (state.mode === "prod") {
    // [2026-08-29]-[One-click upgrade: prod registers the /switchman-update and /switchman-ignore command entries]-
    return `opencode-switchman has a new version ${state.latest} (current ${state.current}) — /switchman-update to upgrade now (silent; prompts for a restart when done); /switchman-ignore to skip this time`
  }
  // local mode only hints, no auto-upgrade (spec: auto-upgrade covers npm release versions only); offers "ignore this time" only
  return "Local build is behind origin/main — update manually then restart: git pull && bun run mode:local; /switchman-ignore to skip this time"
}

// ---- A "button" = a custom command + a session-scoped marker (mtime > process start time → valid for this session, expires on restart) ----

const PLUGIN_START = Date.now()

/** Marker semantics: mtime later than process start = active for this session; naturally expires after restart (re-prompts on each launch) */
export function flagSemantics(baseDir = join(homedir(), ".config", "opencode", "opencode-switchman"), startMs = PLUGIN_START, now = Date.now()): { upgraded: boolean; ignored: boolean } {
  const active = (name: string): boolean => {
    try {
      return statSync(join(baseDir, name)).mtimeMs > startMs
    } catch {
      return false
    }
  }
  void now
  return { upgraded: active("upgraded.flag"), ignored: active("update-ignore.flag") }
}

/** Bundled updater path (same directory as the main build output; copied to dist/update-cli.js by scripts/update-cli.mjs at build time) */
export function updateCliPath(): string {
  return pluginCliPath("update-cli.js")
}

/** Bundled CLI asset path (switchman-doctor.js / switchman-config.js etc. live next to the main build output) */
export function pluginCliPath(name: string): string {
  return join(moduleDir(), name)
}

// [2026-09-01]-[opencode 1.18.x plugin cache is pinned to the spec directory; npm install into ~/.config/opencode has no effect on the actual load
//  path — /switchman-update now calls the bundled updater: rewrite the plugin entry to the latest exact version + clean old caches]-
export function upgradeCommandMd(cliPath: string = updateCliPath()): string {
  // JSON quoting yields a shell-safe single argument even when the installation path has spaces.
  const quoted = JSON.stringify(cliPath)
  return [
    "---",
    "description: Upgrade opencode-switchman now (rewrite the plugin entry to the latest exact version and clean old caches)",
    "---",
    "",
    `!\`node ${quoted} 2>/dev/null || bun ${quoted}\``,
    "",
    "Above is the output of the opencode-switchman updater (it automatically rewrites the plugin entries in opencode.jsonc/tui.jsonc to exact versions and cleans the opencode plugin cache). Please:",
    "1. Report the upgrade result in one sentence (success / already latest / failure reason)",
    "2. Remind the user to restart opencode (app: quit and relaunch / tui: re-enter) before the new version takes effect",
    "",
  ].join("\n")
}

export function ignoreCommandMd(): string {
  return [
    "---",
    "description: Ignore this opencode-switchman update hint (restored after restart)",
    "---",
    "",
    "!`touch \"$HOME/.config/opencode/opencode-switchman/update-ignore.flag\"`",
    "",
    "The command above has marked this update hint as ignored. Please confirm in one sentence: no more prompts this session; opencode will prompt again after a restart.",
    "",
  ].join("\n")
}

/** [2026-08-29]-[prod registers the "upgrade now + ignore this time" commands; local registers only "ignore this time" and removes the upgrade command]-
 *  [fail-open] */
export function doctorCommandMd(cliPath: string): string {
  // JSON quoting yields a shell-safe single argument even when the installation path has spaces.
  const quoted = JSON.stringify(cliPath)
  return ["---", "description: Check the opencode-switchman user config and local state", "---", "", `!\`node ${quoted}\``, "", "Relay the report in full; exit codes: 0=no error, 1=warnings, 2=errors — relay even when non-zero.", ""].join("\n")
}

export function ensureUpdateCommands(mode: LoadMode, baseDir = resolveOpencodeConfigDir(), cliPath?: string): void {
  try {
    const cmdDir = join(baseDir, "command")
    const write = (name: string, md: string): void => {
      mkdirSync(cmdDir, { recursive: true })
      writeFileSync(join(cmdDir, name), md)
    }
    if (mode === "prod") {
      write("switchman-update.md", upgradeCommandMd())
      write("switchman-ignore.md", ignoreCommandMd())
    } else {
      write("switchman-ignore.md", ignoreCommandMd())
      rmSync(join(cmdDir, "switchman-update.md"), { force: true })
    }
    write("switchman-doctor.md", doctorCommandMd(cliPath ?? join(moduleDir(), "switchman-doctor.js")))
  } catch (exc) {
    appendStatusLog(`upgrade command assets fail-open: ${exc}`)
  }
}

export function updateBannerText(): string | null {
  return bannerTextOf(readSelfUpdateState())
}
