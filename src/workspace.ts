// [2026-09-05]-[artifact workspace: plugin-coordinated per-project artifact directory — every main session gets
//  <project>/<.switchman>/<yyyy-mm-dd>/<sessionId>-<title>/ holding plans/progress/process docs/media/dispatch trace,
//  created on demand and renamed when the session title arrives; fail-open everywhere, never blocks the chat flow]
import { appendFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { nowIso } from "./state"

export interface WorkspaceSessionInfo {
  id: string
  title?: unknown
  directory?: unknown
  /** session creation epoch ms (decides the yyyy-mm-dd day folder; fallback = now) */
  created?: unknown
}

export interface WorkspaceSettings { enabled: boolean; dirname: string }

export const DEFAULT_WORKSPACE_DIRNAME = ".switchman"
export const UNTITLED_SLUG = "untitled"
const SLUG_MAX = 48

/** Filesystem-safe folder segment: strip path/hostile chars, collapse separators, cap length; empty → untitled */
export function workspaceSlug(value: unknown): string {
  const t = String(value ?? "").trim()
  if (!t) return UNTITLED_SLUG
  const slug = t
    // [2026-09-05]-[control chars + Windows/macOS reserved + shell metacharacters replaced with "-", whitespace collapsed]
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/^[-.]+|-+$/g, "")
  if (!slug || slug === "." || slug === "..") return UNTITLED_SLUG
  return slug.length > SLUG_MAX ? slug.slice(0, SLUG_MAX).replace(/-+$/, "") || UNTITLED_SLUG : slug
}

/** Local calendar date folder yyyy-mm-dd of a timestamp (session creation day; stable across resumed sessions) */
export function dayFolder(ms: number, d = new Date(ms)): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** Session folder name: <sessionId>-<title-slug> (both sanitized; user-facing coordination unit) */
export function sessionFolderName(sessionID: string, title: unknown): string {
  return `${workspaceSlug(sessionID)}-${workspaceSlug(title)}`
}

interface Entry {
  directory: string
  created: number
  title: string
  folder: string | null // last ensured folder name (null = never ensured this process)
}

export interface EnsuredWorkspace { abs: string; rel: string; created: boolean; renamed: string | null }

/** Dispatch-trace record appended to dispatches.jsonl on every allowed task delegation */
export interface DispatchTrace { ts: string; session: string; shell: string; lane?: string; role?: string; source?: string; redirected?: boolean }

export function renderSessionMeta(e: { id: string; title: string; directory: string; created: number }, updatedAt: string): string {
  return `# Switchman Session Workspace

- session id: ${e.id}
- title: ${e.title || UNTITLED_SLUG}
- project: ${e.directory}
- session created: ${new Date(e.created).toISOString()}
- workspace updated: ${updatedAt}

Auto-created by the opencode-switchman plugin. Task artifacts for this session (plans, progress,
design docs, delegation records, intermediate outputs) live in this folder:
- SESSION.md — this metadata (plugin-maintained)
- dispatches.jsonl — dispatch trace (plugin-maintained)
- media/ — images relayed for vision delegation (plugin-maintained)
- everything else — free-form artifacts written by the orchestrating model per the protocol

Safe to gitignore, archive, or delete.
`
}

/**
 * In-memory session registry + on-disk folder coordination.
 * IO happens only on first ensure per session (or a title-driven rename); steady-state calls are read-free.
 */
export class WorkspaceTracker {
  private sessions = new Map<string, Entry>()

  constructor(
    private settings: () => WorkspaceSettings,
    private fallbackDirectory: string,
  ) {}

  /** Record/merge session facts (events may arrive incrementally: created first, title later) */
  record(info: WorkspaceSessionInfo): void {
    if (!info || typeof info.id !== "string" || !info.id) return
    const prev = this.sessions.get(info.id)
    const directory = typeof info.directory === "string" && info.directory ? info.directory : prev?.directory ?? this.fallbackDirectory
    const created = typeof info.created === "number" && info.created > 0 ? info.created : prev?.created ?? Date.now()
    const title = typeof info.title === "string" ? info.title : prev?.title ?? ""
    this.sessions.set(info.id, { directory, created, title, folder: prev?.folder ?? null })
  }

  known(sessionID: string): boolean {
    return this.sessions.has(sessionID)
  }

  forget(sessionID: string): void {
    this.sessions.delete(sessionID)
  }

  /**
   * Ensure the session folder exists (create on demand; rename when the title slug changed).
   * Returns null when disabled/unknown/failure (fail-open); `created` marks a fresh folder,
   * `renamed` carries the previous folder name when a title change triggered a rename.
   */
  ensure(sessionID: string): EnsuredWorkspace | null {
    try {
      const s = this.settings()
      if (!s.enabled) return null
      const e = this.sessions.get(sessionID)
      if (!e) return null
      const day = dayFolder(e.created)
      const want = sessionFolderName(sessionID, e.title)
      const root = join(e.directory, s.dirname)
      const wantAbs = join(root, day, want)
      let renamed: string | null = null
      if (e.folder && e.folder !== want) {
        const prevAbs = join(root, day, e.folder)
        // rename only into a free target; both existing (title flip-flop) → adopt the target, leave the old folder
        if (existsSync(prevAbs) && !existsSync(wantAbs)) {
          try { renameSync(prevAbs, wantAbs); renamed = e.folder } catch { /* fail-open: adopt target below */ }
        }
      }
      const created = !existsSync(wantAbs)
      mkdirSync(wantAbs, { recursive: true })
      if (created || renamed) {
        try { writeFileSync(join(wantAbs, "SESSION.md"), renderSessionMeta({ id: sessionID, title: e.title, directory: e.directory, created: e.created }, nowIso())) } catch { /* fail-open */ }
      }
      e.folder = want
      return { abs: wantAbs, rel: `${s.dirname}/${day}/${want}`, created, renamed }
    } catch {
      return null
    }
  }

  /** Append one dispatch trace line; missing workspace (disabled/unknown session) = no-op */
  traceDispatch(sessionID: string, trace: DispatchTrace): EnsuredWorkspace | null {
    const ws = this.ensure(sessionID)
    if (!ws) return null
    try { appendFileSync(join(ws.abs, "dispatches.jsonl"), `${JSON.stringify(trace)}\n`) } catch { /* fail-open */ }
    return ws
  }
}
