// [2026-09-04]-[auto-handover core extracted: shared by the TUI manual /handover and the main plugin's tool.execute.after auto trigger.
//  Pure logic, no UI: fork full backup (no messageID = copy all messages) → backup title tagged [backup] → compaction of the
//  current session → no session switch (unlike builtin /fork). After compaction, the agent loop re-reads messages via
//  filterCompactedEffect on the next step; the task continues automatically with "summary + retained tail" context]
// [2026-09-05]-[compaction channel fix — two defects proven by live evidence (message DB + status log, 2026-09-05 11:08/11:26 runs):
//  1) deadlock: session.summarize queues a compaction prompt, but the compaction agent runs on the host session loop — which
//     tool.execute.after was blocking while awaiting the summarize response → self-deadlock broken only by a user interrupt
//     (7m25s and 1m40s hangs, both ended the instant the user intervened);
//  2) ineffective: even after the queued compaction eventually ran, the next build call still saw ~93k input (old messages
//     not filtered) → the measured watermark stayed at force and re-triggered forever.
//  Interim fix (session.command {command:"compact"}) was WRONG: the server command registry holds only init/review +
//  markdown/MCP/skill commands — no "compact" — so every auto-handover died with `Command not found: "compact"` (live
//  incident 2026-09-05, 109k context; verified against opencode v1.18.9 packages/opencode/src/command/index.ts). The
//  manual TUI /compact actually calls session.summarize (packages/tui/src/routes/session/index.tsx @ v1.18.9), whose
//  handler queues the compaction part (compactSvc.create) and drains the session loop (promptSvc.loop) — filterCompacted
//  then truncates pre-compaction history on every later build. Both adapters now call session.summarize; the summarize
//  HTTP response returns only after the whole compaction loop finishes (handler awaits the runner deferred), so the auto
//  path still fires it WITHOUT awaiting (src/index.ts). Backup leg (fork + [backup] tag) stays awaited: DB-local, completed
//  within the trigger second in all incident runs]
/** Model face required by the v1 summarize payload (server SummarizePayload: providerID+modelID mandatory, auto optional) */
export interface CompactionModel {
  providerID: string
  modelID: string
}

export interface HandoverPort {
  /** Full fork: returns the new session { id, title }; null on failure */
  forkFull(sessionID: string, directory: string): Promise<{ id: string; title: string | undefined } | null>
  /** Retitle ([backup] tag; fail-open on failure, does not block compaction) */
  setTitle(sessionID: string, directory: string, title: string): Promise<boolean>
  /** All session titles in the directory (for backup sequence numbering); may return [] on failure (fail-open) */
  listTitles(directory: string): Promise<string[]>
  /** Queue real compaction via the session.summarize channel (the TUI manual /compact route); true when accepted.
   *  model: only needed by v1-style adapters (v1 SummarizePayload requires providerID+modelID); the v2 TUI adapter
   *  derives it from the session record and ignores the parameter */
  compact(sessionID: string, directory: string, model?: CompactionModel): Promise<boolean>
}

export interface HandoverResult {
  ok: boolean
  /** Backup session ID (present when fork succeeds) */
  backupID?: string
  /** Whether the current session was compacted */
  compacted: boolean
  message: string
}

// [2026-09-05]-[backup numbering defect (live evidence: every auto-handover backup of the same session was identically
//  titled "[backup] X（fork #1）"): the server fork title counter is derived from the SOURCE session's title
//  (getForkedTitle, opencode v1.18.9 session.ts:161-169 — strips " (fork #N)" from the source title, increments, else
//  appends " (fork #1)"), and our source title never changes between backups, so every fork response comes back
//  "X (fork #1)". Fix: number backups OURSELVES — strip the server suffix, then take 1 + max N among existing
//  "[backup] <base> (fork #N)" titles from session.list (survives plugin restarts; deleted backups don't cause reuse)]
const FORK_SUFFIX_RE = / ?[(（]fork #\d+[)）]$/
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Backup title: `[backup] <base> (fork #N)` with N = 1 + max N of existing backups of the same base (max, not count:
 *  deleting an old backup must not recycle its number). existingTitles defaults to [] (first backup / list failure) */
export function backupTitle(forkTitle: string | undefined, sessionID: string, existingTitles: string[] = []): string {
  const base = (forkTitle ?? sessionID).replace(FORK_SUFFIX_RE, "")
  const max = existingTitles.reduce((acc, t) => {
    // count both paren styles (server emits half-width; tolerate full-width for robustness against legacy entries)
    const m = t.match(new RegExp(`^${escapeRegExp(`[backup] ${base}`)} ?[(（]fork #(\\d+)[)）]$`))
    return m ? Math.max(acc, parseInt(m[1], 10)) : acc
  }, 0)
  return `[backup] ${base} (fork #${max + 1})`
}

/** Backup leg only (fork + [backup] tag). Safe to await from the tool path: DB-local, completes instantly */
export async function backupSession(port: HandoverPort, sessionID: string, directory: string): Promise<HandoverResult> {
  try {
    const forked = await port.forkFull(sessionID, directory)
    if (!forked?.id) return { ok: false, compacted: false, message: `session.fork failed (no new session returned)` }
    // fail-open: an unreachable list only degrades numbering back to (fork #1), never blocks the backup
    const existingTitles = await port.listTitles(directory).catch(() => [] as string[])
    const marked = await port.setTitle(forked.id, directory, backupTitle(forked.title, sessionID, existingTitles)).catch(() => false)
    return {
      ok: true,
      backupID: forked.id,
      compacted: false,
      message: `Fully backed up as session ${forked.id.slice(0, 8)}…${marked ? " ([backup] tagged)" : ""}`,
    }
  } catch (exc) {
    return { ok: false, compacted: false, message: `handover failed: ${exc instanceof Error ? exc.message : String(exc)}` }
  }
}

/** Compaction leg. NEVER await this from tool.execute.after: the summarize response returns only after the whole
 *  compaction loop has run on the host session loop, which stays blocked while the hook is awaited (self-deadlock, see header) */
export async function compactSession(port: HandoverPort, sessionID: string, directory: string, model?: CompactionModel): Promise<boolean> {
  try {
    return await port.compact(sessionID, directory, model)
  } catch {
    return false
  }
}

/** Full handover (manual /handover path): backup then compaction, both awaited — the TUI palette runs it detached from an idle session */
export async function runHandover(port: HandoverPort, sessionID: string, directory: string): Promise<HandoverResult> {
  const backup = await backupSession(port, sessionID, directory)
  if (!backup.ok) return backup
  const compacted = await compactSession(port, sessionID, directory)
  return {
    ...backup,
    compacted,
    message: compacted
      ? `${backup.message}; current session compacted`
      : `${backup.message}; compaction command not accepted (backup stands)`,
  }
}

/** v1 SDK adapter (main plugin input.client, path/query/body style; RequestResult fields are non-throwing) */
export function v1HandoverPort(client: {
  session: {
    fork(opts: any): Promise<any>
    update(opts: any): Promise<any>
    list(opts?: any): Promise<any>
    summarize(opts: any): Promise<any>
  }
}): HandoverPort {
  return {
    async forkFull(sessionID, directory) {
      const res = await client.session.fork({ path: { id: sessionID }, query: { directory } })
      const data = res?.data
      return data?.id ? { id: String(data.id), title: typeof data.title === "string" ? data.title : undefined } : null
    },
    async setTitle(sessionID, directory, title) {
      const res = await client.session.update({ path: { id: sessionID }, query: { directory }, body: { title } })
      return !res?.error
    },
    // [2026-09-05]-[titles feed the backup sequence counter (see backupTitle); array/absent shapes degrade to []]
    async listTitles(directory) {
      const res = await client.session.list({ query: { directory } })
      const data: unknown = res?.data
      if (!Array.isArray(data)) return []
      return data.map((s: any) => (typeof s?.title === "string" ? s.title : "")).filter(Boolean)
    },
    // [2026-09-05]-[was session.command {command:"compact"}: "Command not found" — the registry has no compact command
    //  (init/review + markdown/MCP/skill only, opencode v1.18.9). session.summarize is the real channel the manual TUI
    //  /compact uses (compactSvc.create + promptSvc.loop); auto:true injects the post-compaction "continue" turn so the
    //  interrupted task resumes automatically; the response lands only after the compaction loop finishes — fire detached]
    async compact(sessionID, directory, model) {
      if (!model) return false // v1 SummarizePayload mandates providerID+modelID; without a model face the call would 400
      const body: { providerID: string; modelID: string; auto?: boolean } = {
        providerID: model.providerID,
        modelID: model.modelID,
        auto: true,
      }
      const res = await client.session.summarize({ path: { id: sessionID }, query: { directory }, body })
      return !res?.error
    },
  }
}
