// [2026-09-04]-[handover-core unit tests: orchestration order, fail-open degradation, v1 adapter parameter shape;
//  the TUI v2 adapter and host interactions cannot be unit tested, typecheck covers them]
// [2026-09-05]-[synced with the compaction channel fix: compact() now goes through session.command {command:"compact"}
//  (the manual /compact channel; session.summarize never compacted the live context) and no longer needs a model face;
//  backup/compaction legs split (backupSession/compactSession) — see test/auto-handover.test.ts for the non-blocking contract]
import { describe, expect, mock, test } from "bun:test"
import { runHandover, backupSession, compactSession, v1HandoverPort, backupTitle, type HandoverPort } from "../src/handover-core"

function makePort(overrides: Partial<HandoverPort> = {}): HandoverPort {
  return {
    async forkFull() { return { id: "ses_backup_1111", title: "Original session (fork #1)" } },
    async setTitle() { return true },
    async compact() { return true },
    ...overrides,
  }
}

describe("backupTitle", () => {
  test("prepends the [backup] prefix when the fork title exists", () => {
    expect(backupTitle("TaskA (fork #2)", "ses_x")).toBe("[backup] TaskA (fork #2)")
  })
  test("falls back to sessionID when the fork title is missing", () => {
    expect(backupTitle(undefined, "ses_x")).toBe("[backup] ses_x")
  })
})

describe("backupSession (backup leg only)", () => {
  test("fork→[backup] tag, no compaction queued", async () => {
    const calls: string[] = []
    const port = makePort({
      async forkFull(sid, dir) { calls.push(`fork:${sid}:${dir}`); return { id: "ses_b", title: "T" } },
      async setTitle(sid, _dir, title) { calls.push(`title:${sid}:${title}`); return true },
      async compact(sid, _dir) { calls.push(`compact:${sid}`); return true },
    })
    const r = await backupSession(port, "ses_a", "/w")
    expect(r.ok).toBe(true)
    expect(r.backupID).toBe("ses_b")
    expect(r.compacted).toBe(false)
    expect(calls).toEqual(["fork:ses_a:/w", "title:ses_b:[backup] T"])
    expect(r.message).toContain("ses_b".slice(0, 8))
  })

  test("title-tag failure is fail-open", async () => {
    const port = makePort({ async setTitle() { throw new Error("boom") } })
    const r = await backupSession(port, "ses_a", "/w")
    expect(r.ok).toBe(true)
  })

  test("fork failure / throw: ok=false, captured as a result", async () => {
    const compact = mock(() => Promise.resolve(true))
    const r1 = await backupSession(makePort({ async forkFull() { return null }, compact: compact as any }), "ses_a", "/w")
    expect(r1.ok).toBe(false)
    const r2 = await backupSession(makePort({ async forkFull() { throw new Error("net down") } }), "ses_a", "/w")
    expect(r2.ok).toBe(false)
    expect(r2.message).toContain("net down")
    expect(compact).not.toHaveBeenCalled()
  })
})

describe("compactSession (compaction leg)", () => {
  test("passes the session through; throws degrade to false (never rejects)", async () => {
    expect(await compactSession(makePort(), "ses_a", "/w")).toBe(true)
    expect(await compactSession(makePort({ async compact() { return false } }), "ses_a", "/w")).toBe(false)
    expect(await compactSession(makePort({ async compact() { throw new Error("net") } }), "ses_a", "/w")).toBe(false)
  })
})

describe("runHandover orchestration (manual /handover path)", () => {
  test("success path: fork→[backup] tag→compact, in order", async () => {
    const calls: string[] = []
    const port = makePort({
      async forkFull() { calls.push("fork"); return { id: "ses_b", title: "T" } },
      async setTitle(_sid, _dir, title) { calls.push(`title:${title}`); return true },
      async compact(sid, _dir) { calls.push(`compact:${sid}`); return true },
    })
    const r = await runHandover(port, "ses_a", "/w")
    expect(r.ok).toBe(true)
    expect(r.backupID).toBe("ses_b")
    expect(r.compacted).toBe(true)
    expect(calls).toEqual(["fork", "title:[backup] T", "compact:ses_a"])
    expect(r.message).toContain("current session compacted")
  })

  test("compaction rejected: backup still counts as ok (backup value stands independently)", async () => {
    const port = makePort({ async compact() { return false } })
    const r = await runHandover(port, "ses_a", "/w")
    expect(r.ok).toBe(true)
    expect(r.compacted).toBe(false)
    expect(r.message).toContain("not accepted")
  })
})

describe("v1HandoverPort adapter", () => {
  function makeClient() {
    const calls: any[] = []
    return {
      calls,
      session: {
        async fork(opts: any) { calls.push(["fork", opts]); return { data: { id: "ses_f", title: "FT" } } },
        async update(opts: any) { calls.push(["update", opts]); return { data: {} } },
        async command(opts: any) { calls.push(["command", opts]); return { data: { info: {}, parts: [] } } },
      },
    }
  }

  test("parameter shape is v1 path/query/body; compact goes through the session command channel", async () => {
    const c = makeClient()
    const port = v1HandoverPort(c)
    const forked = await port.forkFull("ses_a", "/w")
    expect(forked).toEqual({ id: "ses_f", title: "FT" })
    expect(c.calls[0]).toEqual(["fork", { path: { id: "ses_a" }, query: { directory: "/w" } }])
    expect(await port.setTitle("ses_f", "/w", "[backup] FT")).toBe(true)
    expect(c.calls[1]).toEqual(["update", { path: { id: "ses_f" }, query: { directory: "/w" }, body: { title: "[backup] FT" } }])
    expect(await port.compact("ses_a", "/w")).toBe(true)
    expect(c.calls[2]).toEqual(["command", { path: { id: "ses_a" }, query: { directory: "/w" }, body: { command: "compact", arguments: "" } }])
  })

  test("fork without id / error fields: degrades to null/false", async () => {
    const port = v1HandoverPort({
      session: {
        async fork() { return { data: undefined, error: "boom" } },
        async update() { return { error: "x" } },
        async command() { return { error: "y" } },
      },
    })
    expect(await port.forkFull("s", "/w")).toBeNull()
    expect(await port.setTitle("s", "/w", "t")).toBe(false)
    expect(await port.compact("s", "/w")).toBe(false)
  })
})
