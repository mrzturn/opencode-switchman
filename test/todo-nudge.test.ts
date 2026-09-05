// [2026-09-05]-[todo nudge behavioral contract: the [TODO] per-turn status line fixes the stale-todo bug (list written
//  once, marked in_progress, never updated). Contract: todo.updated snapshots the list per main session; the line reports
//  done/total + focus item (in_progress preferred, else first pending as "next"); all-resolved lists and empty lists go
//  quiet; shell/internal sessions and session.deleted sessions never emit; line rides the same rules/banner gate as the
//  watermark line]
import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const configDir = mkdtempSync(join(tmpdir(), "switchman-todo-config-"))
const stateDir = mkdtempSync(join(tmpdir(), "switchman-todo-state-"))
const projectDir = mkdtempSync(join(tmpdir(), "switchman-todo-project-"))
process.env.OPENCODE_CONFIG_DIR = configDir
process.env.SWITCHMAN_STATE = stateDir
writeFileSync(join(stateDir, "model-catalog.json"), JSON.stringify({ fetched_at: Date.now(), etag: null, index: {} }))

import { SwitchmanPlugin } from "../src/index"

const fakeClient = {
  provider: { list: async () => [] },
  session: {
    async get(opts: any) { return { data: { id: opts?.path?.id, title: "T", directory: projectDir } } },
    async list() { return { data: [] } },
  },
}

function todos(...items: Array<{ content: string; status: string }>) {
  return items.map((t) => ({ ...t, priority: "high" }))
}

async function boot() {
  // legacy mode (same recipe as auto-redirect.test.ts): session.created/chat.params classification goes through the
  // deterministic sessionAgent map — dynamic mode's manager only exists after the host-driven config hook
  const hooks = await SwitchmanPlugin({ client: fakeClient, directory: projectDir } as any, { matrix: { mode: "legacy" } } as any)
  const emit = (event: any) => hooks.event!({ event } as any)
  const system = async (sessionID: string) => {
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID } as any, output as any)
    return output.system
  }
  return { emit, system }
}

test("todo nudge: [TODO] line tracks todo.updated snapshots for main sessions", async () => {
  const { emit, system } = await boot()
  const sid = "ses_todo_main"

  // written once: 1 in_progress + 2 pending → line surfaces the focus item
  await emit({ type: "todo.updated", properties: { sessionID: sid, todos: todos(
    { content: "context-watch.ts: git classify", status: "in_progress" },
    { content: "index.ts: handleReadGate copy", status: "pending" },
    { content: "agents-md.ts §5: git discipline", status: "pending" },
  ) } })
  let sys = await system(sid)
  expect(sys.some((l) => l.startsWith("[TODO] 0/3 done · in_progress: context-watch.ts: git classify"))).toBe(true)

  // progress: item1 completed, item2 started → numbers move with the flow
  await emit({ type: "todo.updated", properties: { sessionID: sid, todos: todos(
    { content: "context-watch.ts: git classify", status: "completed" },
    { content: "index.ts: handleReadGate copy", status: "in_progress" },
    { content: "agents-md.ts §5: git discipline", status: "pending" },
  ) } })
  sys = await system(sid)
  expect(sys.some((l) => l.startsWith("[TODO] 1/3 done · in_progress: index.ts: handleReadGate copy"))).toBe(true)

  // completed without starting the next → first pending surfaces as "next"
  await emit({ type: "todo.updated", properties: { sessionID: sid, todos: todos(
    { content: "context-watch.ts: git classify", status: "completed" },
    { content: "index.ts: handleReadGate copy", status: "completed" },
    { content: "agents-md.ts §5: git discipline", status: "pending" },
  ) } })
  sys = await system(sid)
  expect(sys.some((l) => l.startsWith("[TODO] 2/3 done · next: agents-md.ts §5: git discipline"))).toBe(true)

  // all resolved (cancelled counts as resolved) → the line goes quiet
  await emit({ type: "todo.updated", properties: { sessionID: sid, todos: todos(
    { content: "context-watch.ts: git classify", status: "completed" },
    { content: "index.ts: handleReadGate copy", status: "completed" },
    { content: "agents-md.ts §5: git discipline", status: "cancelled" },
  ) } })
  sys = await system(sid)
  expect(sys.some((l) => l.startsWith("[TODO]"))).toBe(false)

  // empty list = cleared → quiet
  await emit({ type: "todo.updated", properties: { sessionID: sid, todos: [] } })
  sys = await system(sid)
  expect(sys.some((l) => l.startsWith("[TODO]"))).toBe(false)
})

test("todo nudge: internal sessions excluded, session.deleted cleans the tracker", async () => {
  const { emit, system } = await boot()

  // internal session (title/compaction/summary; deterministic in both legacy and dynamic paths — a -mx- shell name only
  // classifies as shell when actually injected, which the empty-catalog test env cannot guarantee) → never tracked/rendered
  await emit({ type: "session.created", properties: { info: { id: "ses_title_agent", agent: "title" } } })
  await emit({ type: "todo.updated", properties: { sessionID: "ses_title_agent", todos: todos({ content: "shell work", status: "in_progress" }) } })
  expect((await system("ses_title_agent")).some((l) => l.startsWith("[TODO]"))).toBe(false)

  // main session tracked, then deleted → tracker cleaned
  const sid = "ses_todo_gone"
  await emit({ type: "todo.updated", properties: { sessionID: sid, todos: todos({ content: "doomed task", status: "in_progress" }) } })
  expect((await system(sid)).some((l) => l.startsWith("[TODO] 0/1 done"))).toBe(true)
  await emit({ type: "session.deleted", properties: { info: { id: sid } } })
  expect((await system(sid)).some((l) => l.startsWith("[TODO]"))).toBe(false)
})
