// [2026-09-04]-[handover-core unit tests: orchestration order, fail-open degradation, v1 adapter parameter shape;
//  the TUI v2 adapter and host interactions cannot be unit tested, typecheck covers them]
// [2026-09-05]-[synced with the compaction channel fix: compact() goes through session.summarize (the manual TUI /compact
//  route — session.command has no compact command, registry is markdown/MCP/skill only at opencode v1.18.9, live
//  "Command not found" incident); the v1 adapter requires a model face (server SummarizePayload mandates providerID+modelID)
//  and sends auto:true (post-compaction continue turn); backup/compaction legs split — see test/auto-handover.test.ts]
// [2026-09-05]-[backup numbering: the server fork counter derives from the SOURCE title (getForkedTitle, v1.18.9), so an
//  unchanged source always returns "(fork #1)" — backups number themselves via listTitles max-N instead]
import { describe, expect, mock, test } from "bun:test"
import { runHandover, backupSession, compactSession, v1HandoverPort, backupTitle, type HandoverPort } from "../src/handover-core"

function makePort(overrides: Partial<HandoverPort> = {}): HandoverPort {
  return {
    async forkFull() { return { id: "ses_backup_1111", title: "Original session (fork #1)" } },
    async setTitle() { return true },
    async listTitles() { return [] },
    async compact() { return true },
    ...overrides,
  }
}

describe("backupTitle", () => {
  test("server always returns (fork #1) for an unchanged source — suffix is stripped, numbering starts at 1", () => {
    expect(backupTitle("TaskA (fork #1)", "ses_x")).toBe("[backup] TaskA (fork #1)")
  })
  test("counts existing backups of the same base (max, so deleted numbers are never reused)", () => {
    expect(backupTitle("TaskA (fork #1)", "ses_x", ["[backup] TaskA (fork #1)", "other"])).toBe("[backup] TaskA (fork #2)")
    expect(backupTitle("TaskA (fork #1)", "ses_x", ["[backup] TaskA (fork #1)", "[backup] TaskA (fork #3)"])).toBe("[backup] TaskA (fork #4)")
  })
  test("different bases never cross-count; full-width legacy suffix tolerated; missing title falls back to sessionID", () => {
    expect(backupTitle("TaskA (fork #1)", "ses_x", ["[backup] TaskB (fork #7)"])).toBe("[backup] TaskA (fork #1)")
    expect(backupTitle("TaskA (fork #1)", "ses_x", ["[backup] TaskA（fork #2）"])).toBe("[backup] TaskA (fork #3)")
    expect(backupTitle(undefined, "ses_x", ["[backup] ses_x (fork #1)"])).toBe("[backup] ses_x (fork #2)")
  })
})

describe("backupSession (backup leg only)", () => {
  test("fork→list→[backup] tag with sequence, no compaction queued", async () => {
    const calls: string[] = []
    const port = makePort({
      async forkFull(sid, dir) { calls.push(`fork:${sid}:${dir}`); return { id: "ses_b", title: "T (fork #1)" } },
      async setTitle(sid, _dir, title) { calls.push(`title:${sid}:${title}`); return true },
      async listTitles(dir) { calls.push(`list:${dir}`); return ["[backup] T (fork #1)"] },
      async compact(sid, _dir) { calls.push(`compact:${sid}`); return true },
    })
    const r = await backupSession(port, "ses_a", "/w")
    expect(r.ok).toBe(true)
    expect(r.backupID).toBe("ses_b")
    expect(r.compacted).toBe(false)
    expect(calls).toEqual(["fork:ses_a:/w", "list:/w", "title:ses_b:[backup] T (fork #2)"])
    expect(r.message).toContain("ses_b".slice(0, 8))
  })

  test("list failure is fail-open: numbering degrades to (fork #1), backup still succeeds", async () => {
    const port = makePort({
      async forkFull() { return { id: "ses_b", title: "T (fork #1)" } },
      async listTitles() { throw new Error("list down") },
    })
    const r = await backupSession(port, "ses_a", "/w")
    expect(r.ok).toBe(true)
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
    expect(calls).toEqual(["fork", "title:[backup] T (fork #1)", "compact:ses_a"])
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
        async list(opts: any) { calls.push(["list", opts]); return { data: [{ title: "[backup] FT (fork #1)" }, { title: "plain" }, {}] } },
        async summarize(opts: any) { calls.push(["summarize", opts]); return { data: true } },
      },
    }
  }

  test("parameter shape is v1 path/query/body; compact goes through the session.summarize channel with auto:true", async () => {
    const c = makeClient()
    const port = v1HandoverPort(c)
    const forked = await port.forkFull("ses_a", "/w")
    expect(forked).toEqual({ id: "ses_f", title: "FT" })
    expect(c.calls[0]).toEqual(["fork", { path: { id: "ses_a" }, query: { directory: "/w" } }])
    expect(await port.setTitle("ses_f", "/w", "[backup] FT")).toBe(true)
    expect(c.calls[1]).toEqual(["update", { path: { id: "ses_f" }, query: { directory: "/w" }, body: { title: "[backup] FT" } }])
    expect(await port.listTitles("/w")).toEqual(["[backup] FT (fork #1)", "plain"])
    expect(c.calls[2]).toEqual(["list", { query: { directory: "/w" } }])
    expect(await port.compact("ses_a", "/w", { providerID: "copilot", modelID: "glm-5.3" })).toBe(true)
    expect(c.calls[3]).toEqual([
      "summarize",
      { path: { id: "ses_a" }, query: { directory: "/w" }, body: { providerID: "copilot", modelID: "glm-5.3", auto: true } },
    ])
  })

  test("compact without a model face: rejected locally, summarize never called (server payload mandates providerID+modelID)", async () => {
    const c = makeClient()
    const port = v1HandoverPort(c)
    expect(await port.compact("ses_a", "/w")).toBe(false)
    expect(c.calls.filter((call) => call[0] === "summarize")).toHaveLength(0)
  })

  test("fork without id / error fields: degrades to null/false/[]", async () => {
    const port = v1HandoverPort({
      session: {
        async fork() { return { data: undefined, error: "boom" } },
        async update() { return { error: "x" } },
        async list() { return { error: "z" } },
        async summarize() { return { error: "y" } },
      },
    })
    expect(await port.forkFull("s", "/w")).toBeNull()
    expect(await port.setTitle("s", "/w", "t")).toBe(false)
    expect(await port.listTitles("/w")).toEqual([])
    expect(await port.compact("s", "/w", { providerID: "p", modelID: "m" })).toBe(false)
  })
})
