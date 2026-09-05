// [2026-09-05]-[regression for the 2026-09-05 deadlock incidents: tool.execute.after must never block on the compaction
//  leg — the compaction agent runs on the host session loop, which the hook itself is blocking (both incident hangs ended
//  the second the user intervened). Contract: backup leg awaited (fork+tag, instant) + bounded; compaction fired detached
//  through the session.summarize channel (model face seeded via chat.params — session.command has no compact command at
//  opencode v1.18.9, the "Command not found" incident); cooldown prevents immediate reforking; the detached leg logs once
//  the host response lands]
import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const configDir = mkdtempSync(join(tmpdir(), "switchman-autoho-config-"))
const stateDir = mkdtempSync(join(tmpdir(), "switchman-autoho-state-"))
process.env.OPENCODE_CONFIG_DIR = configDir
process.env.SWITCHMAN_STATE = stateDir
writeFileSync(join(stateDir, "model-catalog.json"), JSON.stringify({ fetched_at: Date.now(), etag: null, index: {} }))

import { SwitchmanPlugin } from "../src/index"

function readStatusLog(): string {
  const p = join(stateDir, "status-log.json")
  return existsSync(p) ? readFileSync(p, "utf8") : ""
}

test("auto-handover: backup leg bounded, compaction fired detached, cooldown guards refork", async () => {
  let releaseCompact!: () => void
  const compactPending = new Promise<any>((resolve) => {
    releaseCompact = () => resolve({ data: true })
  })
  const calls: string[] = []
  const fakeClient = {
    provider: { list: async () => [] },
    session: {
      async fork(opts: any) { calls.push(`fork:${opts?.path?.id}`); return { data: { id: "ses_backup_auto", title: "T (fork #1)" } } },
      async update(opts: any) { calls.push(`update:${opts?.path?.id}:${opts?.body?.title}`); return { data: {} } },
      async list(opts: any) { calls.push(`list:${opts?.query?.directory}`); return { data: [] } },
      async summarize(opts: any) { calls.push(`summarize:${opts?.body?.providerID}/${opts?.body?.modelID}:${opts?.path?.id}`); return compactPending },
    },
  }
  const hooks = await SwitchmanPlugin({ client: fakeClient, directory: "/w" } as any, undefined as any)
  const output = { message: async () => {} } as any

  // seed a force-tier measured watermark via message.updated (input+output+reasoning+cache.read)
  await hooks.event!({ event: { type: "message.updated", properties: { sessionID: "ses_auto_main", info: { role: "assistant", tokens: { input: 120_000, output: 1_000, reasoning: 1_000, cache: { read: 2_000 } } } } } as any })
  // seed the session model face the summarize payload needs (chat.params: input.model is a Model object {providerID, id})
  await hooks["chat.params"]!({ sessionID: "ses_auto_main", model: { providerID: "copilot", id: "glm-5.3" } } as any, output)

  const t0 = Date.now()
  await hooks["tool.execute.after"]!({ sessionID: "ses_auto_main", tool: "read" } as any, output)
  // the hook resolves while the summarize response is still pending — the deadlock regression
  expect(Date.now() - t0).toBeLessThan(5_000)
  expect(calls).toContain("fork:ses_auto_main")
  expect(calls).toContain("update:ses_backup_auto:[backup] T (fork #1)")
  expect(calls).toContain("summarize:copilot/glm-5.3:ses_auto_main")
  expect(readStatusLog()).toContain("auto-handover backup done")

  // cooldown: an immediate second trigger must not refork
  await hooks["tool.execute.after"]!({ sessionID: "ses_auto_main", tool: "read" } as any, output)
  expect(calls.filter((c) => c.startsWith("fork:")).length).toBe(1)

  // the detached compaction leg logs once the host response lands
  releaseCompact()
  await new Promise((r) => setTimeout(r, 50))
  expect(readStatusLog()).toContain("auto-handover compaction accepted")
}, 30_000)
