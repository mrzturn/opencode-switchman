// [2026-09-04]-[English localization: translate test names and comments; synced expectations with translated src messages; no test-logic change]
// [2026-09-04]-[handover-core unit tests: orchestration order (fork→tag→fetch model→compact), fail-open degradation,
//  v1 adapter parameter shape (path/query/body); the TUI v2 adapter and host interactions cannot be unit tested, typecheck covers them]
import { describe, expect, mock, test } from "bun:test"
import { runHandover, v1HandoverPort, backupTitle, type HandoverPort } from "../src/handover-core"

function makePort(overrides: Partial<HandoverPort> = {}): HandoverPort {
  return {
    async forkFull() { return { id: "ses_backup_1111", title: "Original session (fork #1)" } },
    async setTitle() { return true },
    async lastAssistantModel() { return { providerID: "glm", modelID: "glm-5.3" } },
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

describe("runHandover orchestration", () => {
  test("success path: fork→[backup] tag→fetch model→compact, in order", async () => {
    const calls: string[] = []
    const port = makePort({
      async forkFull(sid, dir) { calls.push(`fork:${sid}:${dir}`); return { id: "ses_b", title: "T" } },
      async setTitle(sid, _dir, title) { calls.push(`title:${sid}:${title}`); return true },
      async compact(sid, _dir, model) { calls.push(`compact:${sid}:${model.providerID}/${model.modelID}`); return true },
    })
    const r = await runHandover(port, "ses_a", "/w")
    expect(r.ok).toBe(true)
    expect(r.backupID).toBe("ses_b")
    expect(r.compacted).toBe(true)
    expect(calls).toEqual(["fork:ses_a:/w", "title:ses_b:[backup] T", "compact:ses_a:glm/glm-5.3"])
    expect(r.message).toContain("ses_b".slice(0, 8))
  })

  test("title-tag failure is fail-open: does not block compaction", async () => {
    const port = makePort({ async setTitle() { throw new Error("boom") } })
    const r = await runHandover(port, "ses_a", "/w")
    expect(r.ok).toBe(true)
    expect(r.compacted).toBe(true)
  })

  test("no model info: backup succeeds, compaction skipped", async () => {
    const port = makePort({ async lastAssistantModel() { return null } })
    const r = await runHandover(port, "ses_a", "/w")
    expect(r.ok).toBe(true)
    expect(r.compacted).toBe(false)
    expect(r.message).toContain("skipped")
  })

  test("fork failure: ok=false and compaction untouched", async () => {
    const compact = mock(() => Promise.resolve(true))
    const port = makePort({ async forkFull() { return null }, compact: compact as any })
    const r = await runHandover(port, "ses_a", "/w")
    expect(r.ok).toBe(false)
    expect(compact).not.toHaveBeenCalled()
  })

  test("compaction failure: backup still counts as ok (backup value stands independently)", async () => {
    const port = makePort({ async compact() { return false } })
    const r = await runHandover(port, "ses_a", "/w")
    expect(r.ok).toBe(true)
    expect(r.compacted).toBe(false)
  })

  test("fork throws: the whole thing fails and is captured as a result, not an exception", async () => {
    const port = makePort({ async forkFull() { throw new Error("net down") } })
    const r = await runHandover(port, "ses_a", "/w")
    expect(r.ok).toBe(false)
    expect(r.message).toContain("net down")
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
        async messages(opts: any) {
          calls.push(["messages", opts])
          return { data: [{ info: { role: "user" } }, { info: { role: "assistant", providerID: "copilot", modelID: "m1" } }] }
        },
        async summarize(opts: any) { calls.push(["summarize", opts]); return { data: {} } },
      },
    }
  }

  test("parameter shape is v1 path/query/body; messages scanned in reverse for the assistant model", async () => {
    const c = makeClient()
    const port = v1HandoverPort(c)
    const forked = await port.forkFull("ses_a", "/w")
    expect(forked).toEqual({ id: "ses_f", title: "FT" })
    expect(c.calls[0]).toEqual(["fork", { path: { id: "ses_a" }, query: { directory: "/w" } }])
    const model = await port.lastAssistantModel("ses_a", "/w")
    expect(model).toEqual({ providerID: "copilot", modelID: "m1" })
    expect(await port.compact("ses_a", "/w", { providerID: "p", modelID: "m" })).toBe(true)
    expect(c.calls[2]).toEqual(["summarize", { path: { id: "ses_a" }, query: { directory: "/w" }, body: { providerID: "p", modelID: "m" } }])
    await port.setTitle("ses_f", "/w", "[backup] FT")
    expect(c.calls[3]).toEqual(["update", { path: { id: "ses_f" }, query: { directory: "/w" }, body: { title: "[backup] FT" } }])
  })

  test("fork without id / error field: returns null; messages network error returns null model", async () => {
    const port = v1HandoverPort({
      session: {
        async fork() { return { data: undefined, error: "boom" } },
        async update() { return { error: "x" } },
        async messages() { throw new Error("net") },
        async summarize() { return { error: "y" } },
      },
    })
    expect(await port.forkFull("s", "/w")).toBeNull()
    expect(await port.lastAssistantModel("s", "/w")).toBeNull()
    expect(await port.setTitle("s", "/w", "t")).toBe(false)
    expect(await port.compact("s", "/w", { providerID: "p", modelID: "m" })).toBe(false)
  })
})
