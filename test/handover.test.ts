// [2026-09-04]-[handover-core 单测：编排顺序（fork→标记→取模型→压缩）、fail-open 降级、
//  v1 适配器参数形状（path/query/body）；TUI v2 适配器与宿主交互无法单测，靠 typecheck 兜底]
import { describe, expect, mock, test } from "bun:test"
import { runHandover, v1HandoverPort, backupTitle, type HandoverPort } from "../src/handover-core"

function makePort(overrides: Partial<HandoverPort> = {}): HandoverPort {
  return {
    async forkFull() { return { id: "ses_backup_1111", title: "原会话 (fork #1)" } },
    async setTitle() { return true },
    async lastAssistantModel() { return { providerID: "glm", modelID: "glm-5.3" } },
    async compact() { return true },
    ...overrides,
  }
}

describe("backupTitle", () => {
  test("fork 标题存在时拼 [backup] 前缀", () => {
    expect(backupTitle("任务A (fork #2)", "ses_x")).toBe("[backup] 任务A (fork #2)")
  })
  test("fork 标题缺失时回退 sessionID", () => {
    expect(backupTitle(undefined, "ses_x")).toBe("[backup] ses_x")
  })
})

describe("runHandover 编排", () => {
  test("成功路径：fork→[backup] 标记→取模型→压缩，全链按序", async () => {
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

  test("标题标记失败 fail-open：不阻断压缩", async () => {
    const port = makePort({ async setTitle() { throw new Error("boom") } })
    const r = await runHandover(port, "ses_a", "/w")
    expect(r.ok).toBe(true)
    expect(r.compacted).toBe(true)
  })

  test("无模型信息：备份成功、跳过压缩", async () => {
    const port = makePort({ async lastAssistantModel() { return null } })
    const r = await runHandover(port, "ses_a", "/w")
    expect(r.ok).toBe(true)
    expect(r.compacted).toBe(false)
    expect(r.message).toContain("跳过")
  })

  test("fork 失败：ok=false 且不触碰压缩", async () => {
    const compact = mock(() => Promise.resolve(true))
    const port = makePort({ async forkFull() { return null }, compact: compact as any })
    const r = await runHandover(port, "ses_a", "/w")
    expect(r.ok).toBe(false)
    expect(compact).not.toHaveBeenCalled()
  })

  test("压缩失败：备份仍算 ok（备份价值独立成立）", async () => {
    const port = makePort({ async compact() { return false } })
    const r = await runHandover(port, "ses_a", "/w")
    expect(r.ok).toBe(true)
    expect(r.compacted).toBe(false)
  })

  test("fork 抛错：整体 fail 捕获为结果而非异常", async () => {
    const port = makePort({ async forkFull() { throw new Error("net down") } })
    const r = await runHandover(port, "ses_a", "/w")
    expect(r.ok).toBe(false)
    expect(r.message).toContain("net down")
  })
})

describe("v1HandoverPort 适配器", () => {
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

  test("参数形状为 v1 path/query/body；messages 倒序取 assistant 模型", async () => {
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

  test("fork 无 id / error 字段：返回 null；messages 网络错返回 null 模型", async () => {
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
