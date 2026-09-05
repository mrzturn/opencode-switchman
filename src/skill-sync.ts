// [2026-09-05]-[bundle agent skills into the plugin package and materialize them into the opencode global skills dir
//  (<configDir>/opencode/skills) at plugin startup; marker-gated content sync, fail-open throughout]-[new module]
// Sync semantics: add/overwrite-only copy (never deletes extra files inside a managed skill dir, e.g. db-query's
// node_modules installed later by its setup.sh); cleanup only removes dirs that carry the plugin marker.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { homedir } from "node:os"
import { resolveOpencodeConfigDir } from "./config"

export const SKILL_MARKER = ".opencode-switchman"

export interface DirentLike { name: string; isDirectory: boolean }
export type SyncBytes = Uint8Array | string

export interface SkillSyncIo {
  srcRoot: string
  targetRoot: string
  stderr(line: string): void
  exists(path: string): boolean
  readdir(path: string): DirentLike[]
  readFile(path: string): SyncBytes
  writeFile(path: string, data: SyncBytes): void
  mkdir(path: string): void
  remove(path: string): void
}

export interface SkillSyncSummary { installed: string[]; updated: string[]; removed: string[] }

/** Same import.meta.url resolution strategy as src/selfupdate.ts (bun sets .dir; ESM spec guarantees .url). */
function moduleDirOf(url: string): string {
  if (url.startsWith("file://")) {
    try { return dirname(fileURLToPath(url)) } catch { /* fallthrough */ }
  }
  return dirname(decodeURIComponent(url).replace(/^file:\/\//, ""))
}

/**
 * Bundled skills source dir: <module-dir>/../skills — resolves to <repo>/skills from src/ (tests, local build)
 * and to <package-root>/skills from dist/opencode-switchman.js in the shipped npm package.
 */
export function bundledSkillsDir(moduleUrl = import.meta.url): string {
  return join(moduleDirOf(moduleUrl), "..", "skills")
}

/** opencode natively scans <configDir>/opencode/skills/<name>/SKILL.md (XDG_CONFIG_HOME / OPENCODE_CONFIG_DIR aware). */
export function defaultTargetRoot(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  return join(resolveOpencodeConfigDir(env, home), "skills")
}

export function defaultSkillSyncIo(srcRoot = bundledSkillsDir(), targetRoot = defaultTargetRoot()): SkillSyncIo {
  return {
    srcRoot,
    targetRoot,
    stderr: (line) => { try { process.stderr.write(`${line}\n`) } catch { /* never surface */ } },
    exists: existsSync,
    readdir: (p) => readdirSync(p, { withFileTypes: true }).map((d) => ({ name: d.name, isDirectory: d.isDirectory() })),
    readFile: readFileSync,
    writeFile: writeFileSync,
    mkdir: (p) => mkdirSync(p, { recursive: true }),
    remove: (p) => rmSync(p, { recursive: true, force: true }),
  }
}

function toBuffer(x: SyncBytes): Buffer {
  return typeof x === "string" ? Buffer.from(x, "utf8") : Buffer.from(x)
}

function bytesEqual(a: SyncBytes, b: SyncBytes): boolean {
  if (a === b) return true
  return toBuffer(a).equals(toBuffer(b))
}

/** Recursive relative-file listing (dirs descending); symlinked entries read as plain files, good enough for skill trees. */
function listFiles(io: SkillSyncIo, abs: string, rel: string, out: string[]): void {
  for (const entry of io.readdir(abs)) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name
    if (entry.isDirectory) listFiles(io, join(abs, entry.name), childRel, out)
    else out.push(childRel)
  }
}

function syncOneSkill(io: SkillSyncIo, name: string, markerPath: string): boolean {
  const files: string[] = []
  listFiles(io, join(io.srcRoot, name), "", files)
  let changed = false
  for (const rel of files) {
    const from = join(io.srcRoot, name, rel)
    const to = join(io.targetRoot, name, rel)
    const data = io.readFile(from)
    if (!io.exists(to) || !bytesEqual(io.readFile(to), data)) {
      io.mkdir(dirname(to))
      io.writeFile(to, data)
      changed = true
    }
  }
  // Marker repair: write only when missing/non-empty, so steady-state re-syncs leave mtimes untouched.
  if (!io.exists(markerPath) || !bytesEqual(io.readFile(markerPath), Buffer.alloc(0))) {
    io.writeFile(markerPath, "")
    changed = true
  }
  return changed
}

/** [fail-open iron rule] Never throws: per-skill failures are isolated and reported to stderr; a fatal error yields an empty summary. */
export function syncBundledSkills(io: SkillSyncIo = defaultSkillSyncIo()): SkillSyncSummary {
  const summary: SkillSyncSummary = { installed: [], updated: [], removed: [] }
  try {
    const bundled = io.readdir(io.srcRoot).filter((e) => e.isDirectory).map((e) => e.name).sort()
    for (const name of bundled) {
      try {
        const markerPath = join(io.targetRoot, name, SKILL_MARKER)
        const existed = io.exists(join(io.targetRoot, name))
        const changed = syncOneSkill(io, name, markerPath)
        if (!existed) summary.installed.push(name)
        else if (changed) summary.updated.push(name)
      } catch (exc) {
        io.stderr(`[switchman] skill sync failed for "${name}" (fail-open): ${exc}`)
      }
    }
    // Marker-gated cleanup: stale plugin-managed skills (no longer bundled) are removed; unmarked dirs are never touched.
    try {
      const managed = new Set(bundled)
      for (const entry of io.readdir(io.targetRoot)) {
        if (!entry.isDirectory || managed.has(entry.name)) continue
        if (!io.exists(join(io.targetRoot, entry.name, SKILL_MARKER))) continue
        io.remove(join(io.targetRoot, entry.name))
        summary.removed.push(entry.name)
      }
    } catch (exc) {
      io.stderr(`[switchman] skill cleanup fail-open: ${exc}`)
    }
  } catch (exc) {
    io.stderr(`[switchman] skill sync fail-open: ${exc}`)
  }
  return summary
}
