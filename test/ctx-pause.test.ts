// [2026-09-11]-[/ctx-pause //ctx-resume behavioral contract: the command marker injected into a user message is
// captured at the event layer and suspends context control for THAT session only — read gates (self-read budget +
// watermark tiers) and auto-handover fall through while paused; measurement keeps recording; the watermark line keeps
// reporting numbers with a PAUSED notice and a ≥95%-window warning (pure text, no denies); resume restores
// enforcement; re-fired captures never double-log (idempotent); session.deleted cleans the suspension]
import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const configDir = mkdtempSync(join(tmpdir(), "switchman-ctxpa-config-"))
const stateDir = mkdtempSync(join(tmpdir(), "switchman-ctxpa-state-"))
const projectDir = mkdtempSync(join(tmpdir(), "switchman-ctxpa-project-"))
process.env.OPENCODE_CONFIG_DIR = configDir
process.env.SWITCHMAN_STATE = stateDir
// catalog entry present from module load (the model-catalog index is cached at first read; a mid-file rewrite would
// never be seen) — harmless for the other tests: their sessions carry no model face, so no threshold clamping occurs
writeFileSync(join(stateDir, "model-catalog.json"), JSON.stringify({ fetched_at: Date.now(), etag: null, index: { "copilot/glm-5.3": { contextWindow: 128_000 } } }))

import { SwitchmanPlugin } from "../src/index"
import { CTX_PAUSE_MARKER, CTX_RESUME_MARKER, ctxControlMarkerOf, pausedWindowWarning } from "../src/context-watch"

function readStatusLog(): string {
  const p = join(stateDir, "status-log.json")
  return existsSync(p) ? readFileSync(p, "utf8") : ""
}

const fakeClient = {
  provider: { list: async () => [] },
  session: {
    async fork(opts: any) { return { data: { id: `${opts?.path?.id}_fork`, title: "T (fork)" } } },
    async update() { return { data: {} } },
    async list() { return { data: [] } },
    async get(opts: any) { return { data: { id: opts?.path?.id, title: "T", directory: projectDir } } },
    async summarize() { return { data: true } },
  },
}

async function boot(client: unknown = fakeClient) {
  // legacy mode (same recipe as todo-nudge.test.ts): deterministic session classification without the dynamic manager
  const hooks = await SwitchmanPlugin({ client, directory: projectDir } as any, { matrix: { mode: "legacy" } } as any)
  const emit = (event: any) => hooks.event!({ event } as any)
  const user = (sid: string, text: string) =>
    emit({ type: "message.updated", properties: { sessionID: sid, info: { id: `msg_${sid}_${text.length}`, role: "user", parts: [{ type: "text", text }] } } })
  const watermark = (sid: string, tokens: number) =>
    emit({ type: "message.updated", properties: { sessionID: sid, info: { role: "assistant", tokens: { input: tokens, output: 1_000, reasoning: 0, cache: { read: 0 } } } } })
  const glob = (sid: string) =>
    hooks["tool.execute.before"]!({ sessionID: sid, tool: "glob", callID: `call_${sid}_${Math.random()}` } as any, { args: { pattern: "*.ts" } } as any)
  const system = async (sessionID: string) => {
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID } as any, output as any)
    return output.system
  }
  return { hooks, emit, user, watermark, glob, system }
}

test("ctx-pause: marker suspends the hard-tier read gate for this session only; resume restores; captures idempotent", async () => {
  const { user, watermark, glob } = await boot()
  const sid = "ses_ctxpa_main"
  const other = "ses_ctxpa_other"

  await watermark(sid, 85_000) // defaults 60k/80k/120k → hard tier
  await expect(glob(sid)).rejects.toThrow(/hard watermark/)

  // pause marker → gate open (no throw, args untouched)
  await user(sid, `${CTX_PAUSE_MARKER} pause this session`)
  await glob(sid)

  // a re-fired message.updated of the same marker never double-logs (idempotent flip)
  await user(sid, `${CTX_PAUSE_MARKER} pause this session`)
  expect(readStatusLog().split(`ctx control paused for session ${sid}`).length - 1).toBe(1)

  // session scoping: another session at the same tier stays gated
  await watermark(other, 85_000)
  await expect(glob(other)).rejects.toThrow(/hard watermark/)

  // resume restores enforcement; idempotent on re-fire
  await user(sid, `${CTX_RESUME_MARKER} resume this session`)
  await expect(glob(sid)).rejects.toThrow(/hard watermark/)
  await user(sid, `${CTX_RESUME_MARKER} resume this session`)
  expect(readStatusLog().split(`ctx control resumed for session ${sid}`).length - 1).toBe(1)
})

test("ctx-pause: transform-path capture (real host shape — parts live on the message, not on info)", async () => {
  const { hooks, watermark, glob, system } = await boot()
  const sid = "ses_ctxpa_transform"
  // [2026-09-11 fix]-[live verification: the real host's message.updated info carries no parts, so capture had to
  //  move to experimental.chat.messages.transform where {info, parts} pairs arrive per round-trip]
  const turn = (msgId: string, text: string) =>
    hooks["experimental.chat.messages.transform"]!({ sessionID: sid } as any, {
      messages: [{ info: { id: msgId, role: "user", sessionID: sid }, parts: [{ type: "text", text }] }],
    } as any)

  await watermark(sid, 85_000) // hard tier armed
  await expect(glob(sid)).rejects.toThrow(/hard watermark/)

  await turn("msg_t1", `${CTX_PAUSE_MARKER} pause this session`) // info has NO parts field — the real shape
  await glob(sid) // gate suspended

  // seen-map: the same message id re-arriving in later round-trips never double-logs
  await turn("msg_t1", `${CTX_PAUSE_MARKER} pause this session`)
  expect(readStatusLog().split(`ctx control paused for session ${sid}`).length - 1).toBe(1)

  // watermark line keeps reporting with the PAUSED notice
  expect((await system(sid)).some((l) => l.includes("ctx control PAUSED"))).toBe(true)

  // resume via the transform path restores enforcement
  await turn("msg_t2", `${CTX_RESUME_MARKER} resume this session`)
  await expect(glob(sid)).rejects.toThrow(/hard watermark/)
})

test("ctx-pause: auto-handover suspended while paused (fresh session — no cooldown interference)", async () => {
  const forks: string[] = []
  const recordingClient = {
    ...fakeClient,
    session: {
      ...fakeClient.session,
      async fork(opts: any) { forks.push(opts?.path?.id); return { data: { id: `${opts?.path?.id}_fork`, title: "T (fork)" } } },
    },
  }
  const { hooks, user, watermark } = await boot(recordingClient)
  const output = { message: async () => {} } as any

  // control (unpaused): force tier → backup fork fires (the standard auto-handover contract)
  const a = "ses_ctxpa_ho_a"
  await watermark(a, 130_000)
  await hooks["tool.execute.after"]!({ sessionID: a, tool: "read" } as any, output)
  expect(forks).toContain(a)

  // paused session: same force tier → no backup, hook returns fast
  const b = "ses_ctxpa_ho_b"
  await user(b, `${CTX_PAUSE_MARKER} pause`)
  await watermark(b, 130_000)
  const t0 = Date.now()
  await hooks["tool.execute.after"]!({ sessionID: b, tool: "read" } as any, output)
  expect(Date.now() - t0).toBeLessThan(5_000)
  expect(forks).not.toContain(b)
})

test("ctx-pause: watermark line keeps numbers + PAUSED notice; resume returns tiered directives", async () => {
  const { user, emit, system } = await boot()
  const sid = "ses_ctxpa_line"
  const assistant = (tokens: number) =>
    emit({ type: "message.updated", properties: { sessionID: sid, info: { role: "assistant", modelID: "glm-5.3", providerID: "copilot", tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0 } } } } })

  await assistant(70_000) // soft tier under the defaults
  await user(sid, `${CTX_PAUSE_MARKER} pause`)
  let sys = await system(sid)
  let line = sys.find((l) => l.startsWith("[WATERMARK:SESSION]"))
  expect(line).toContain("ctx control PAUSED by /ctx-pause")
  expect(line).toContain("~70k")
  expect(line).toContain("resume with /ctx-resume")
  expect(line).not.toContain("[WARNING]")

  // resume → tiered directives return (85k ≥ hard 80k)
  await assistant(85_000)
  await user(sid, `${CTX_RESUME_MARKER} resume`)
  sys = await system(sid)
  line = sys.find((l) => l.startsWith("[WATERMARK:SESSION]"))
  expect(line).not.toContain("PAUSED")
  expect(line).toContain("hard watermark exceeded")
})

test("ctx-pause: session.deleted cleans the suspension (fresh watermark is unpaused again)", async () => {
  const { user, watermark, emit, system } = await boot()
  const sid = "ses_ctxpa_del"
  await watermark(sid, 85_000)
  await user(sid, `${CTX_PAUSE_MARKER} pause`)
  expect((await system(sid)).some((l) => l.includes("ctx control PAUSED"))).toBe(true)

  await emit({ type: "session.deleted", properties: { info: { id: sid } } })
  await watermark(sid, 85_000) // re-seed: the session's watermark map was cleaned with it
  expect((await system(sid)).some((l) => l.includes("ctx control PAUSED"))).toBe(false)
})

test("ctx-pause: marker detection is pure and shape-defensive", () => {
  expect(ctxControlMarkerOf({ parts: [{ type: "text", text: `prefix ${CTX_PAUSE_MARKER} suffix` }] })).toBe("pause")
  expect(ctxControlMarkerOf({ parts: [{ type: "text", text: `prefix ${CTX_RESUME_MARKER} suffix` }] })).toBe("resume")
  expect(ctxControlMarkerOf({ parts: [{ type: "file", path: "/x" }] })).toBe(null)
  expect(ctxControlMarkerOf({ parts: [{ type: "text", text: "unrelated" }] })).toBe(null)
  expect(ctxControlMarkerOf(null)).toBe(null)
  expect(ctxControlMarkerOf({})).toBe(null)
})

test("ctx-pause: pausedWindowWarning fires only at ≥95% of a known window (pure, fail-open on unknown)", () => {
  // the ≥95%-window override is the ONLY warning a pause cannot suppress (overflow hard-errors regardless)
  expect(pausedWindowWarning(125_000, 128_000)).toContain("[WARNING] context window ≥95% full (~125k/128k)")
  expect(pausedWindowWarning(121_600, 128_000)).toContain("[WARNING]") // exactly 95%
  expect(pausedWindowWarning(121_599, 128_000)).toBe("") // just under
  expect(pausedWindowWarning(70_000, 128_000)).toBe("")
  // unknown/invalid window → fail-open, numbers only (the paused line keeps its no-warning form)
  expect(pausedWindowWarning(500_000, undefined)).toBe("")
  expect(pausedWindowWarning(500_000, 0)).toBe("")
  expect(pausedWindowWarning(500_000, Number.NaN)).toBe("")
})
