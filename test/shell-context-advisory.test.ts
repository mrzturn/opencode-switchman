// [2026-09-14]-[subagent soft tiers wiring contract (D1): system.transform's shell branch replaces the bare early-return —
//  a dispatched shell session (never internal title/compaction/summary) gets at most one [SHELL-CONTEXT] advisory per tier,
//  tracking the shell watermark (conserve → hand-off); subagentCap:false disables the advisories, a terminated session
//  stays silent (the deny message governs), and session.deleted re-arms the dedup map]
// [2026-09-15]-[tiers now sit at the MAIN session's absolute soft/hard lines (50k/90k defaults) and the default shell cap
//  follows forceTokens (130k) — advisory copy below pins 130k as the effective cap]
import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const configDir = mkdtempSync(join(tmpdir(), "switchman-shelladv-config-"))
const stateDir = mkdtempSync(join(tmpdir(), "switchman-shelladv-state-"))
const projectDir = mkdtempSync(join(tmpdir(), "switchman-shelladv-project-"))
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

function assistantTokens(input: number): { role: "assistant"; tokens: { input: number; output: number; reasoning: number; cache: { read: number } } } {
  // estimateContextTokens = input + output + reasoning + cache.read → +4_000 per event
  return { role: "assistant", tokens: { input, output: 1_000, reasoning: 1_000, cache: { read: 2_000 } } }
}

async function boot(rawOptions: Record<string, unknown> = {}) {
  // legacy mode (deterministic sessionAgent classification — same recipe as todo-nudge/subagent-cap tests)
  const hooks = await SwitchmanPlugin({ client: fakeClient, directory: projectDir } as any, { matrix: { mode: "legacy" }, ...rawOptions } as any)
  const emit = (event: any) => hooks.event!({ event } as any)
  const seedShell = async (sessionId: string, agent = "glm-mx-53f-low") =>
    emit({ type: "session.created", properties: { info: { id: sessionId, agent } } })
  const mark = async (sessionId: string, input: number) =>
    emit({ type: "message.updated", properties: { sessionID: sessionId, info: assistantTokens(input) } })
  const system = async (sessionID: string) => {
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID } as any, output as any)
    return output.system
  }
  const deny = (sessionId: string, callID: string) =>
    hooks["tool.execute.before"]!({ tool: "read", sessionID: sessionId, callID } as any, { args: {} } as any)
  return { emit, seedShell, mark, system, deny }
}

const advisory = (sys: string[]) => sys.find((l) => l.startsWith("[SHELL-CONTEXT]"))

test("shell advisory: tier 1 conserve fires once, tier 2 hand-off once, then quiet; termination silences", async () => {
  const { seedShell, mark, system, deny } = await boot()
  const sid = "ses_adv_shell"
  await seedShell(sid)

  // sub-tier-1 measurement (44k) → no advisory, and the shell branch still skips rules/banner/LANG
  await mark(sid, 40_000)
  let sys = await system(sid)
  expect(advisory(sys)).toBeUndefined()

  // crossing tier 1: 50k input → 54k measured ≥ 50k (shared soft line), < 90k → conserve line, numbers rendered from the live measurement
  await mark(sid, 50_000)
  sys = await system(sid)
  expect(advisory(sys)).toBe("[SHELL-CONTEXT] measured shell context ≈ 54k/130k (conserve): stop batch reads and long pastes — switch to targeted grep and cite only the needed excerpts; finish the current work unit before starting anything new; keep outputs compact.")

  // same tier again → suppressed (once-per-tier dedup)
  expect(advisory(await system(sid))).toBeUndefined()

  // crossing tier 2: 90k input → 94k ≥ 90k (shared hard line) → hand-off line with the inline HANDOFF marker
  await mark(sid, 90_000)
  sys = await system(sid)
  expect(advisory(sys)?.startsWith("[SHELL-CONTEXT] measured shell context ≈ 94k/130k (hand-off):")).toBe(true)
  expect(advisory(sys)).toContain("`HANDOFF: inline · progress: n/m · next: <one sentence>`")

  // tier 2 delivered → quiet again
  expect(advisory(await system(sid))).toBeUndefined()

  // crossing the hard cap (126k input → 130k measured ≥ the 130k shared force line) terminates the session → the deny message governs, advisories stop
  await mark(sid, 126_000)
  expect(advisory(await system(sid))).toBeUndefined()
  await expect(deny(sid, "call_adv_deny")).rejects.toThrow("SUBAGENT CONTEXT CAP REACHED")
}, 30_000)

test("shell advisory: subagentCap:false disables the advisories entirely", async () => {
  const { seedShell, mark, system } = await boot({ context: { subagentCap: false } })
  const sid = "ses_adv_nocap"
  await seedShell(sid)
  await mark(sid, 90_000) // would be deep into tier 2 with the cap on
  expect(advisory(await system(sid))).toBeUndefined()
}, 30_000)

test("shell advisory: internal and main sessions never receive it; session.deleted re-arms the dedup", async () => {
  const { emit, seedShell, mark, system } = await boot()
  // internal session (title) — even with a huge watermark it gets nothing
  await seedShell("ses_adv_title", "title")
  await mark("ses_adv_title", 90_000)
  expect(advisory(await system("ses_adv_title"))).toBeUndefined()

  // main session — measured watermark lands in the main map, not the shell map; no advisory either
  await mark("ses_adv_main", 90_000)
  expect(advisory(await system("ses_adv_main"))).toBeUndefined()

  // session.deleted clears shellWatermark + the dedup map: after deletion the same measurements re-arm tier 1
  const sid = "ses_adv_gone"
  await seedShell(sid)
  await mark(sid, 50_000)
  expect(advisory(await system(sid))?.startsWith("[SHELL-CONTEXT] measured shell context ≈ 54k/130k (conserve):")).toBe(true)
  expect(advisory(await system(sid))).toBeUndefined()
  await emit({ type: "session.deleted", properties: { info: { id: sid } } })
  await mark(sid, 50_000)
  expect(advisory(await system(sid))?.startsWith("[SHELL-CONTEXT] measured shell context ≈ 54k/130k (conserve):")).toBe(true)
}, 30_000)
