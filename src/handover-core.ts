// [2026-09-04]-[auto-handover core extracted: shared by the TUI manual /handover and the main plugin's tool.execute.after auto trigger.
//  Pure logic, no UI: fork full backup (no messageID = copy all messages) → backup title tagged [backup] → compaction of the
//  current session → no session switch (unlike builtin /fork). After compaction, the agent loop re-reads messages via
//  filterCompactedEffect on the next step; the task continues automatically with "summary + retained tail" context]
// [2026-09-05]-[compaction channel fix — two defects proven by live evidence (message DB + status log, 2026-09-05 11:08/11:26 runs):
//  1) deadlock: session.summarize queues a compaction prompt, but the compaction agent runs on the host session loop — which
//     tool.execute.after was blocking while awaiting the summarize response → self-deadlock broken only by a user interrupt
//     (7m25s and 1m40s hangs, both ended the instant the user intervened);
//  2) ineffective: even after the queued compaction eventually ran, the next build call still saw ~93k input (old messages
//     not filtered) → the measured watermark stayed at force and re-triggered forever. The manual /compact (session command
//     channel) shrinks the context for real. Compaction now goes through session.command {command:"compact"} — the same
//     channel as the manual /compact — and the auto path fires it WITHOUT awaiting (src/index.ts). The backup leg (fork +
//     [backup] tag) stays awaited: it is DB-local and completed within the trigger second in both incident runs]
export interface HandoverPort {
  /** Full fork: returns the new session { id, title }; null on failure */
  forkFull(sessionID: string, directory: string): Promise<{ id: string; title: string | undefined } | null>
  /** Retitle ([backup] tag; fail-open on failure, does not block compaction) */
  setTitle(sessionID: string, directory: string, title: string): Promise<boolean>
  /** Queue real compaction via the host session command channel (same as the manual /compact); true when accepted */
  compact(sessionID: string, directory: string): Promise<boolean>
}

export interface HandoverResult {
  ok: boolean
  /** Backup session ID (present when fork succeeds) */
  backupID?: string
  /** Whether the current session was compacted */
  compacted: boolean
  message: string
}

/** Backup title: fork-count suffix (orig (fork #N)) keeps repeated backups unique */
export function backupTitle(forkTitle: string | undefined, sessionID: string): string {
  return `[backup] ${forkTitle ?? sessionID}`
}

/** Backup leg only (fork + [backup] tag). Safe to await from the tool path: DB-local, completes instantly */
export async function backupSession(port: HandoverPort, sessionID: string, directory: string): Promise<HandoverResult> {
  try {
    const forked = await port.forkFull(sessionID, directory)
    if (!forked?.id) return { ok: false, compacted: false, message: `session.fork failed (no new session returned)` }
    const marked = await port.setTitle(forked.id, directory, backupTitle(forked.title, sessionID)).catch(() => false)
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

/** Compaction leg. NEVER await this from tool.execute.after: it executes on the host session loop, which stays blocked while the hook is awaited (self-deadlock, see header) */
export async function compactSession(port: HandoverPort, sessionID: string, directory: string): Promise<boolean> {
  try {
    return await port.compact(sessionID, directory)
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
    command(opts: any): Promise<any>
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
    // [2026-09-05]-[was session.summarize: wrong channel — generated a summary but never compacted the live context; the
    //  session command channel is what the manual /compact uses (verified effective on the incident session)]
    async compact(sessionID, directory) {
      const res = await client.session.command({
        path: { id: sessionID },
        query: { directory },
        body: { command: "compact", arguments: "" },
      })
      return !res?.error
    },
  }
}
