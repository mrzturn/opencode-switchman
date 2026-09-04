// [2026-09-04]-[English localization: translate CLI messages and comments; no logic change]
// [2026-09-04]-[auto-handover core extracted: shared by the TUI manual /handover and the main plugin's tool.execute.after auto trigger.
//  Pure logic, no UI: fork full backup (no messageID = copy all messages) → backup title tagged [backup] → summarize
//  compaction of the current session (reusing the last assistant's provider/model) → no session switch (unlike builtin /fork).
//  After compaction, the agent loop re-reads messages via filterCompactedEffect on the next step (host prompt.ts while loop);
//  the task continues automatically with "summary + retained tail" context — in-design host behavior, no race (the hook is awaited serially inside the tool path)]
export interface HandoverPort {
  /** Full fork: returns the new session { id, title }; null on failure */
  forkFull(sessionID: string, directory: string): Promise<{ id: string; title: string | undefined } | null>
  /** Retitle ([backup] tag; fail-open on failure, does not block compaction) */
  setTitle(sessionID: string, directory: string, title: string): Promise<boolean>
  /** Get the last assistant message's provider/model (for compaction; skips compaction when absent) */
  lastAssistantModel(sessionID: string, directory: string): Promise<{ providerID: string; modelID: string } | null>
  /** Compact (summarize): returns success or not */
  compact(sessionID: string, directory: string, model: { providerID: string; modelID: string }): Promise<boolean>
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

export async function runHandover(port: HandoverPort, sessionID: string, directory: string): Promise<HandoverResult> {
  try {
    const forked = await port.forkFull(sessionID, directory)
    if (!forked?.id) return { ok: false, compacted: false, message: `session.fork failed (no new session returned)` }
    const marked = await port.setTitle(forked.id, directory, backupTitle(forked.title, sessionID)).catch(() => false)
    const model = await port.lastAssistantModel(sessionID, directory)
    const compacted = model ? await port.compact(sessionID, directory, model) : false
    const mark = marked ? " ([backup] tagged)" : ""
    return {
      ok: true,
      backupID: forked.id,
      compacted,
      message: compacted
        ? `Fully backed up as session ${forked.id.slice(0, 8)}…${mark}; current session compacted`
        : `Fully backed up as session ${forked.id.slice(0, 8)}…${mark}; no model info retrieved, skipped current session compaction`,
    }
  } catch (exc) {
    return { ok: false, compacted: false, message: `handover failed: ${exc instanceof Error ? exc.message : String(exc)}` }
  }
}

/** v1 SDK adapter (main plugin input.client, path/query/body style; RequestResult fields are non-throwing) */
export function v1HandoverPort(client: {
  session: {
    fork(opts: any): Promise<any>
    update(opts: any): Promise<any>
    messages(opts: any): Promise<any>
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
    async lastAssistantModel(sessionID, directory) {
      const res = await client.session.messages({ path: { id: sessionID }, query: { directory } }).catch(() => null)
      const rows: any[] = Array.isArray(res?.data) ? res.data : []
      for (const row of [...rows].reverse()) {
        const info = row?.info ?? row
        if (info?.providerID && info?.modelID) return { providerID: String(info.providerID), modelID: String(info.modelID) }
      }
      return null
    },
    async compact(sessionID, directory, model) {
      const res = await client.session.summarize({
        path: { id: sessionID },
        query: { directory },
        body: { providerID: model.providerID, modelID: model.modelID },
      })
      return !res?.error
    },
  }
}
