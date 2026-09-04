#!/usr/bin/env node
// [2026-09-04]-[English localization: translate user-facing messages; no logic change]
// opencode-switchman one-shot installer/updater (self-contained, zero-dependency; runs directly on node>=18 or bun)
// [2026-09-01]-[opencode 1.18.x pins the plugin cache to the spec directory: after a bare package name/`@latest`
//  is installed once, npm is no longer checked for newer versions (verified: ~/.cache/opencode/packages/opencode-switchman
//  always stays on the old version)] - the only reliable update path = rewrite the plugin entry to the exact
//  version opencode-switchman@x.y.z (each version gets its own cache directory) and prune stale cache directories
// Usage: update-cli.mjs [--version x.y.z] [--dry-run]
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const PKG = "opencode-switchman"
const REGISTRY_LATEST = `https://registry.npmjs.org/${PKG}/latest`

export function configDirOf(env = process.env, home = homedir()) {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode")
}

export function stateDirOf(env = process.env, home = homedir()) {
  return env.SWITCHMAN_STATE || join(home, ".config", "opencode", "opencode-switchman")
}

export function cachePackagesDirOf(env = process.env, home = homedir()) {
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "opencode", "packages")
}

/**
 * Rewrite the plugin entry for this package in the opencode/tui config (JSONC) to an exact-version spec.
 * Line-level surgery preserves comments and existing content (same style as scripts/plugin-mode.ts).
 * Returns { text, action, previous? }; action ∈ replaced|uncommented|inserted|created|noop|file-ref|unparseable.
 */
export function rewriteSpec(text, spec, pkg = PKG) {
  const lines = text.split("\n")
  const specRe = new RegExp(`"(${pkg}(?:@[0-9A-Za-z.+~^*-]+)?)"`)

  // 1) Active entry exists: replace the spec inside the quotes in place (for a tuple ["pkg",{...}] only the first item is touched)
  const activeIdx = lines.findIndex((l) => specRe.test(l) && !l.trim().startsWith("//"))
  if (activeIdx >= 0) {
    const line = lines[activeIdx]
    if (line.includes("file://")) return { text, action: "file-ref", previous: null }
    const previous = specRe.exec(line)[1]
    if (previous === spec) return { text, action: "noop", previous }
    lines[activeIdx] = line.replace(specRe, `"${spec}"`)
    return { text: lines.join("\n"), action: "replaced", previous }
  }

  // 2) Only a commented-out entry exists: uncomment and rewrite (commented file:// lines are left alone)
  const commentedIdx = lines.findIndex((l) => !l.includes("file://") && new RegExp(`^\\s*//\\s*"${pkg}`).test(l.trim()))
  if (commentedIdx >= 0) {
    lines[commentedIdx] = lines[commentedIdx].replace(/^\s*\/\//, "").replace(specRe, `"${spec}"`)
    return { text: lines.join("\n"), action: "uncommented", previous: null }
  }

  // 2.5) Active file:// source reference (its spec has no quoted bare package name, so the branch above cannot see it) → no rewrite; left to the mode scripts
  if (lines.some((l) => !l.trim().startsWith("//") && new RegExp(`"file://[^"]*${pkg}`).test(l))) {
    return { text, action: "file-ref", previous: null }
  }

  // 3) No entry: insert into the plugin array (first element with a trailing comma = valid regardless of existing elements)
  const pluginIdx = lines.findIndex((l) => /"plugin"\s*:\s*\[/.test(l))
  if (pluginIdx >= 0) {
    const line = lines[pluginIdx]
    const open = line.indexOf("[")
    const close = line.indexOf("]", open)
    if (close >= 0) {
      // Inline array closed on the same line: "plugin": [] or ["a","b"]
      const inner = line.slice(open + 1, close).trim()
      lines[pluginIdx] = inner
        ? line.slice(0, close) + `, "${spec}"` + line.slice(close)
        : line.slice(0, open) + `["${spec}"]` + line.slice(close + 1)
    } else {
      // Multi-line array: insert as the first element
      const indent = line.match(/^\s*/)[0]
      lines.splice(pluginIdx + 1, 0, `${indent}  "${spec}",`)
    }
    return { text: lines.join("\n"), action: "inserted", previous: null }
  }

  // 4) Empty file → generate a minimal config; file exists but the plugin array cannot be located → error without writing (never overwrite user config)
  if (text.trim() === "") {
    return {
      text: `{\n  "$schema": "https://opencode.ai/config.json",\n  "plugin": ["${spec}"]\n}\n`,
      action: "created",
      previous: null,
    }
  }
  const braceIdx = lines.findIndex((l) => l.trim() === "{")
  if (braceIdx >= 0) {
    lines.splice(braceIdx + 1, 0, `  "plugin": ["${spec}"],`)
    return { text: lines.join("\n"), action: "inserted", previous: null }
  }
  return { text, action: "unparseable", previous: null }
}

/** Prune all directories of this package in the opencode plugin cache (bare name and @any-version); returns the removed directory names */
export function pruneCaches(packagesDir, pkg = PKG) {
  if (!existsSync(packagesDir)) return []
  const removed = []
  for (const name of readdirSync(packagesDir)) {
    if (name !== pkg && !name.startsWith(`${pkg}@`)) continue
    rmSync(join(packagesDir, name), { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

/** Latest version from the npm registry; falls back to curl when fetch is unavailable (node<18) */
export async function latestVersion(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl === "function") {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 10_000)
    try {
      const res = await fetchImpl(REGISTRY_LATEST, { signal: ctl.signal })
      if (!res.ok) throw new Error(`npm registry HTTP ${res.status}`)
      const body = await res.json()
      if (typeof body.version === "string" && body.version) return body.version
      throw new Error("npm registry did not return a version")
    } finally {
      clearTimeout(timer)
    }
  }
  const raw = execFileSync("curl", ["-fsSL", REGISTRY_LATEST], { encoding: "utf8", timeout: 10_000 })
  const hit = /"version"\s*:\s*"([^"]+)"/.exec(raw)
  if (!hit) throw new Error("npm registry response contains no version")
  return hit[1]
}

function firstExisting(dir, names) {
  for (const name of names) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return null
}

/**
 * Perform install/update: rewrite the opencode and tui config entries → prune stale caches → on upgrade, mark upgraded-pending-restart.
 * Returns { spec, actions }; --dry-run only prints the plan without writing to disk.
 */
export async function run(argv = process.argv.slice(2), io = {}) {
  const env = io.env ?? process.env
  const home = io.home ?? homedir()
  const log = io.log ?? ((m) => console.log(m))
  const dry = argv.includes("--dry-run")
  const vi = argv.indexOf("--version")
  const version = vi >= 0 ? String(argv[vi + 1] ?? "") : await latestVersion()
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`Invalid version: ${version}`)
  const spec = `${PKG}@${version}`

  const cfgDir = configDirOf(env, home)
  const mainPath = firstExisting(cfgDir, ["opencode.jsonc", "opencode.json"]) ?? join(cfgDir, "opencode.jsonc")
  // [2026-09-01]-[In the upgrade scenario (opencode config present, tui missing) the tui was silently skipped,
  //  contradicting the README create-if-missing promise] - now create it when missing (sidebar panel),
  //  consistent with plugin-mode.ts
  const tuiPath = firstExisting(cfgDir, ["tui.jsonc", "tui.json"]) ?? join(cfgDir, "tui.jsonc")
  const targets = [{ path: mainPath, text: existsSync(mainPath) ? readFileSync(mainPath, "utf8") : "" }]
  if (tuiPath) targets.push({ path: tuiPath, text: existsSync(tuiPath) ? readFileSync(tuiPath, "utf8") : '{\n  "$schema": "https://opencode.ai/tui.json",\n  "plugin": []\n}\n' })

  const actions = []
  for (const t of targets) {
    const r = rewriteSpec(t.text, spec)
    actions.push({ file: t.path, action: r.action, previous: r.previous ?? null })
    if (r.action === "unparseable") throw new Error(`Cannot locate the plugin array in ${t.path}; edit it manually and retry`)
    if (r.action === "file-ref") {
      log(`[switchman] Skipped ${t.path}: it is a file:// source reference; manage it with bun run mode:prod / mode:local, no rewrite`)
      continue
    }
    if (r.action === "noop") {
      log(`[switchman] ${t.path} is already ${spec}`)
      continue
    }
    log(`[switchman] ${dry ? "Will rewrite" : "Rewrote"} ${t.path}: ${r.previous ? `${r.previous} → ` : ""}${spec} (${r.action})`)
    if (!dry) {
      mkdirSync(cfgDir, { recursive: true })
      writeFileSync(t.path, r.text)
    }
  }

  let pruned = []
  if (!dry) {
    pruned = pruneCaches(cachePackagesDirOf(env, home))
    if (pruned.length > 0) log(`[switchman] Pruned opencode plugin caches: ${pruned.join(", ")}`)
    const mainAct = actions.find((a) => a.file === mainPath)?.action
    if (mainAct === "replaced" || mainAct === "uncommented") {
      // Upgrade semantics: mark the "upgraded, pending restart" banner (expires naturally after restart)
      const stDir = stateDirOf(env, home)
      mkdirSync(stDir, { recursive: true })
      writeFileSync(join(stDir, "upgraded.flag"), "")
    }
  } else {
    log("[switchman] dry-run: no files written, no caches pruned")
  }
  log(`[switchman] Done (${spec}). Restart opencode (quit and relaunch the app / re-enter the tui) for the new version to take effect.`)
  return { spec, actions }
}

// [2026-09-01]-[On macOS the /var/folders→/private/var/folders symlink makes import.meta.url (realpath) and
//  pathToFileURL(argv[1]) (as-is) never equal, so the script silently no-ops with exit 0] - the entry check
//  now takes the realpath of argv[1]
let entryUrl = null
try { entryUrl = pathToFileURL(realpathSync(process.argv[1] ?? "")).href } catch {}
if (import.meta.url === entryUrl) {
  run().catch((exc) => {
    console.error(`[switchman] Update failed: ${exc?.message ?? exc}`)
    process.exit(1)
  })
}
