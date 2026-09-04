// [2026-09-04]-[English localization: translate comments and messages; no logic change]
// One-shot switch of the opencode plugin load source: local repo (file://, consumes the dist build
// artifacts) ⇄ npm release (pinned-version entry)
// Usage: bun scripts/plugin-mode.ts local|prod [--version x.y.z]; restart opencode after switching
// Keeps three config places in sync: the plugin entries in opencode.jsonc / tui.jsonc + the $schema
// in opencode-switchman.jsonc
// [2026-08-29]-[opencode.json is annotated JSONC; line-level surgery preserves the rest of the
//  content; idempotent and safe to re-run]-
// [2026-08-31]-[tui.jsonc's plugin array is maintained independently (server/TUI keep separate
//  registration lists); rebuilt when missing]-
// [2026-09-02]-[Rewrite: the old regex only recognized bare package-name entries and went blind to the
//  pinned-version entries introduced by update-cli (opencode-switchman@x.y.z) — mode:local produced
//  duplicate active entries and broke JSON commas, and mode:prod could not upgrade to the latest npm
//  version; replaced by a plugin-array-block rewriter (comment/activate/insert + active-entry comma
//  recomputation); prod reuses update-cli's latestVersion/rewriteSpec/pruneCaches, the main config
//  $schema follows the mode, and the repo root is derived automatically]-
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { cachePackagesDirOf, configDirOf, latestVersion, pruneCaches, rewriteSpec, stateDirOf } from "./update-cli.mjs"

export const PKG = "opencode-switchman"
export const SCHEMA_FILE = "opencode-switchman-v1.schema.json"
const REMOTE_SCHEMA = `https://raw.githubusercontent.com/mrzturn/opencode-switchman/main/schema/${SCHEMA_FILE}`

/** Repo root (realpath guards against the macOS /var→/private/var symlink; same entry criterion as update-cli) */
export function repoRootOf(): string {
  return realpathSync(join(import.meta.dir, ".."))
}

export function schemaUrlOf(mode: "local" | "prod", root = repoRootOf()): string {
  return mode === "local" ? pathToFileURL(join(root, "schema", SCHEMA_FILE)).href : REMOTE_SCHEMA
}

/**
 * Idempotent switch of the main config $schema: only replaces values pointing at this plugin's
 * schema; other $schema lines are untouched.
 */
export function switchSchemaRef(text: string, schemaUrl: string): { text: string; changed: boolean } {
  const re = new RegExp(`("\\$schema"\\s*:\\s*")([^"]*${SCHEMA_FILE})(")`)
  if (!re.test(text) || re.exec(text)![2] === schemaUrl) return { text, changed: false }
  return { text: text.replace(re, `$1${schemaUrl}$3`), changed: true }
}

type BodyLine = { line: string; kind: "active" | "comment" | "blank" }

type PluginBlock = { lines: string[]; pluginIdx: number; closeIdx: number; closeInline: number; indent: string; body: BodyLine[] } | null

/** Splits inline array content on top-level commas (string-aware; the top-level open bracket never enters a fragment; tuple/nested entries are kept whole) */
function splitInline(arr: string): string[] {
  const frags: string[] = []
  let depth = 0
  let inStr = false
  let cur = ""
  for (const c of arr) {
    if (inStr) {
      cur += c
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      cur += c
      continue
    }
    if (c === "[") {
      depth++
      if (depth > 1) cur += c
      continue
    }
    if (c === "]") {
      depth--
      if (depth === 0) break
      cur += c
      continue
    }
    if (c === "{") depth++
    else if (c === "}") depth--
    else if (c === "," && depth === 1) {
      if (cur.trim()) frags.push(cur.trim())
      cur = ""
      continue
    }
    cur += c
  }
  if (cur.trim()) frags.push(cur.trim())
  return frags
}

/** Locates the plugin array block; inline arrays are expanded into one entry per line */
function parsePluginBlock(text: string): PluginBlock {
  const lines = text.split("\n")
  const pluginIdx = lines.findIndex((l) => /"plugin"\s*:\s*\[/.test(l))
  if (pluginIdx < 0) return null
  const pluginLine = lines[pluginIdx]
  const open = pluginLine.indexOf("[")
  const closeInline = pluginLine.indexOf("]", open)
  const indent = pluginLine.match(/^\s*/)?.[0] ?? ""

  let bodyLines: string[]
  let closeIdx: number
  if (closeInline >= 0) {
    closeIdx = pluginIdx
    const entries = splitInline(lines[pluginIdx].slice(open, closeInline + 1))
    bodyLines = entries.map((e) => `${indent}  ${e}`)
  } else {
    closeIdx = pluginIdx + 1 + lines.slice(pluginIdx + 1).findIndex((l) => l.trim().startsWith("]"))
    if (closeIdx <= pluginIdx) return null
    bodyLines = lines.slice(pluginIdx + 1, closeIdx)
  }
  const body: BodyLine[] = bodyLines.map((line) => {
    const t = line.trim()
    return { line, kind: t === "" ? "blank" : t.startsWith("//") ? "comment" : "active" }
  })
  return { lines, pluginIdx, closeIdx, closeInline, indent, body }
}

/** Reassembles the config text; inline state expands into "plugin open line + array body + shrunk closing line"; multi-line state keeps the original open line and everything from the closing line on */
function assembleBlock(b: NonNullable<PluginBlock>, rebuilt: string[]): string {
  const prefix = b.lines.slice(0, b.pluginIdx)
  const pluginLine = b.lines[b.pluginIdx]
  if (b.closeInline >= 0) {
    const openCol = pluginLine.indexOf("[")
    const closeCol = pluginLine.indexOf("]", openCol)
    return [
      ...prefix,
      pluginLine.slice(0, openCol + 1),
      ...rebuilt,
      `${b.indent}]${pluginLine.slice(closeCol + 1)}`,
      ...b.lines.slice(b.pluginIdx + 1),
    ].join("\n")
  }
  return [...prefix, pluginLine, ...rebuilt, ...b.lines.slice(b.closeIdx)].join("\n")
}

/**
 * Recomputes commas in the plugin array block: an active entry followed by another active entry →
 * trailing comma, otherwise none (comment lines don't participate).
 * update-cli rewriteSpec's uncommented/replaced paths don't handle inter-entry commas; this function
 * is the single choke point shared by both paths.
 */
export function recommaPluginArray(text: string): { text: string; changed: boolean } {
  const b = parsePluginBlock(text)
  if (!b) return { text, changed: false }
  const actives = b.body.map((l, i) => (l.kind === "active" ? i : -1)).filter((i) => i >= 0)
  // Uniform indentation for active entries (update-cli uncommented eats comment-line indentation) + comma recomputation
  const stdIndent = `${b.indent}  `
  const rebuilt = b.body.map((l, i) => {
    if (l.kind !== "active") return l.line
    const stripped = `${stdIndent}${l.line.replace(/,(\s*)$/, "$1").trim()}`
    return actives.some((j) => j > i) ? `${stripped},` : stripped
  })
  const result = assembleBlock(b, rebuilt)
  return { text: result, changed: result !== text }
}

/**
 * Switches the plugin array block to the local file:// source: package-name entries (incl. @version)
 * are commented out, the file:// entry is activated (inserted as first element if absent).
 * Line-level surgery preserves comments and third-party entries; active-entry commas are recomputed
 * to keep the JSONC valid.
 * Returns { text, action }; action ∈ switched|noop|unparseable.
 * Limitation: multi-line tuple entries (["pkg", {...}] spanning lines) are unsupported — reported as
 * unparseable without rewriting.
 */
export function switchToLocal(text: string, fileSpec: string, pkg = PKG): { text: string; action: string } {
  const b = parsePluginBlock(text)
  if (!b) return { text, action: "unparseable" }
  const pkgRe = new RegExp(`"${pkg}(@[^"]*)?"`)
  // Guard against multi-line tuples/nested structures: an active line whose open bracket is not closed on the same line → abort the surgery (single-line tuples are already merged by parsePluginBlock)
  for (const l of b.body) {
    if (l.kind !== "active") continue
    const t = l.line.trim()
    if ((t.match(/[[{]/g) ?? []).length > (t.match(/[\]}]/g) ?? []).length) return { text, action: "unparseable" }
  }

  // Active package-name entries (incl. @version) → comment out; commented file:// lines of this repo → activate; target not in place → insert as first element
  const out: BodyLine[] = b.body.map((l) => {
    if (l.kind === "active" && pkgRe.test(l.line) && !l.line.includes("file://"))
      return { line: l.line.replace(/^(\s*)/, "$1// "), kind: "comment" }
    if (l.kind === "comment" && l.line.includes(fileSpec))
      return { line: l.line.replace(/^(\s*)\/\/\s?/, "$1"), kind: "active" }
    return l
  })
  if (!out.some((l) => l.kind === "active" && l.line.includes(fileSpec)))
    out.unshift({ line: `${b.indent}  "${fileSpec}"`, kind: "active" })

  const actives = out.map((l, i) => (l.kind === "active" ? i : -1)).filter((i) => i >= 0)
  const stdIndent = `${b.indent}  `
  const rebuilt = out.map((l, i) => {
    if (l.kind !== "active") return l.line
    const stripped = `${stdIndent}${l.line.replace(/,(\s*)$/, "$1").trim()}`
    return actives.some((j) => j > i) ? `${stripped},` : stripped
  })
  const result = assembleBlock(b, rebuilt)
  return { text: result, action: result === text ? "noop" : "switched" }
}

/** Comments out active file:// entries of this package (pre-step for prod; other third-party file:// entries are untouched, same match criterion as update-cli) */
export function commentFileRefs(text: string, pkg = PKG): { text: string; changed: boolean } {
  const re = new RegExp(`^(\\s*)("file://[^"]*${pkg}[^"]*")(,?)\\s*$`)
  let changed = false
  const out = text.split("\n").map((l) => {
    if (changed || !re.test(l) || l.trim().startsWith("//")) return l
    changed = true
    return l.replace(re, "$1// $2$3")
  })
  return { text: out.join("\n"), changed }
}

function firstExisting(dir: string, names: string[]): string | null {
  for (const name of names) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return null
}

/**
 * Runs the mode switch: the plugin entries in the opencode/tui configs + the main config $schema.
 * local: build runs first via the package.json script; prod: pulls npm latest (or --version) +
 * prunes caches + upgraded.flag.
 */
export async function run(argv = process.argv.slice(2), io: { env?: NodeJS.ProcessEnv; home?: string; log?: (m: string) => void; fetch?: typeof fetch } = {}) {
  const env = io.env ?? process.env
  const home = io.home ?? homedir()
  const log = io.log ?? ((m: string) => console.log(m))
  const mode = argv[0]
  if (mode !== "local" && mode !== "prod") throw new Error("usage: bun scripts/plugin-mode.ts local|prod [--version x.y.z]")

  const root = repoRootOf()
  const fileSpec = pathToFileURL(root).href
  const cfgDir = configDirOf(env, home)
  const mainPath = firstExisting(cfgDir, ["opencode.jsonc", "opencode.json"])
  if (!mainPath) throw new Error(`not found: ${join(cfgDir, "opencode.jsonc")}|opencode.json`)
  const tuiPath = firstExisting(cfgDir, ["tui.jsonc", "tui.json"]) ?? join(cfgDir, "tui.jsonc")
  const targets = [
    { path: mainPath, text: readFileSync(mainPath, "utf8") },
    { path: tuiPath, text: existsSync(tuiPath) ? readFileSync(tuiPath, "utf8") : '{\n  "$schema": "https://opencode.ai/tui.json",\n  "plugin": []\n}\n' },
  ]

  let spec: string
  if (mode === "prod") {
    const vi = argv.indexOf("--version")
    const version = vi >= 0 ? String(argv[vi + 1] ?? "") : await latestVersion(io.fetch ?? globalThis.fetch)
    if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`invalid version: ${version}`)
    spec = `${PKG}@${version}`
  } else {
    spec = fileSpec
  }

  for (const t of targets) {
    let text = t.text
    let action: string
    if (mode === "local") {
      ;({ text, action } = switchToLocal(text, fileSpec))
    } else {
      const cf = commentFileRefs(text)
      const r = rewriteSpec(cf.text, spec)
      if (r.action === "unparseable") throw new Error(`cannot locate the plugin array in ${t.path}; edit it manually and retry`)
      const rc = recommaPluginArray(r.text) // rewriteSpec does not handle inter-entry commas (e.g. uncommented followed by a third-party entry)
      text = rc.text
      action = cf.changed || r.action !== "noop" || rc.changed ? "switched" : "noop"
    }
    if (action === "unparseable") throw new Error(`cannot locate the plugin array in ${t.path} (or it contains unsupported multi-line entries); edit it manually and retry`)
    if (action === "noop") log(`[plugin-mode] ${t.path} is already ${mode}; no change`)
    else {
      mkdirSync(cfgDir, { recursive: true })
      writeFileSync(t.path, text)
      log(`[plugin-mode] switched ${t.path} → ${spec}`)
    }
    const active = text.split("\n").filter((l) => {
      const s = l.trim()
      return s.startsWith('"') && (s.includes(PKG) || s.includes("file://"))
    })
    if (active.length > 1) log(`[plugin-mode] warning: ${t.path} has multiple active entries; the same plugin will load twice: ${active.join(" | ")}`)
  }

  // The main config $schema follows the mode (behavior fields are version-independent and untouched)
  const mainCfgPath = join(cfgDir, "opencode-switchman.jsonc")
  if (existsSync(mainCfgPath)) {
    const r = switchSchemaRef(readFileSync(mainCfgPath, "utf8"), schemaUrlOf(mode, root))
    if (r.changed) {
      writeFileSync(mainCfgPath, r.text)
      log(`[plugin-mode] switched ${mainCfgPath} $schema → ${mode === "local" ? "local repo" : "GitHub main"}`)
    }
  } else {
    log(`[plugin-mode] skipped main config $schema: ${mainCfgPath} does not exist`)
  }

  if (mode === "prod") {
    const pruned = pruneCaches(cachePackagesDirOf(env, home))
    if (pruned.length > 0) log(`[plugin-mode] pruned opencode plugin caches: ${pruned.join(", ")}`)
    const stDir = stateDirOf(env, home)
    mkdirSync(stDir, { recursive: true })
    writeFileSync(join(stDir, "upgraded.flag"), "")
  } else {
    log("[plugin-mode] local mode (remember to run bun run build first to keep dist fresh; bun run mode:local already builds)")
  }
  log(`[plugin-mode] done (${spec}). Takes effect after restarting opencode (quit and relaunch the app / re-enter the tui).`)
  return { mode, spec }
}

// Entry check same as update-cli: compare realpath of argv[1] (guards against macOS symlinks falsely triggering execution on import)
try {
  if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(join(import.meta.dir, "plugin-mode.ts"))) {
    run().catch((exc) => {
      console.error(`[plugin-mode] switch failed: ${exc?.message ?? exc}`)
      process.exit(1)
    })
  }
} catch {}
