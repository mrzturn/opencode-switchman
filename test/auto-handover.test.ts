// [2026-09-05]-[regression for the 2026-09-05 deadlock incidents: tool.execute.after must never block on the compaction
//  leg — the compaction agent runs on the host session loop, which the hook itself is blocking (both incident hangs ended
//  the second the user intervened). Contract: backup leg awaited (fork+tag, instant) + bounded; compaction fired detached;
//  cooldown prevents immediate reforking; the detached leg logs when the host accepts the command]
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
    releaseCompact = () => resolve({ data: { info: {}, parts: [] } })
  })
  const calls: string[] = []
  const fakeClient = {
    provider: { list: async () => [] },
    session: {
      async fork(opts: any) { calls.push(`fork:${opts?.path?.id}`); return { data: { id: "ses_backup_auto", title: "T (fork #1)" } } },
      async update(opts: any) { calls.push(`update:${opts?.path?.id}`); return { data: {} } },
      async command(opts: any) { calls.push(`command:${opts?.body?.command}:${opts?.path?.id}`); return compactPending },
    },
  }
  const hooks = await SwitchmanPlugin({ client: fakeClient, directory: "/w" } as any, undefined as any)
  const output = { message: async () => {} } as any

  // seed a force-tier measured watermark via message.updated (input+output+reasoning+cache.read)
  await hooks.event!({ event: { type: "message.updated", properties: { sessionID: "ses_auto_main", info: { role: "assistant", tokens: { input: 120_000, output: 1_000, reasoning: 1_000, cache: { read: 2_000 } } } } } as any })

  const t0 = Date.now()
  await hooks["tool.execute.after"]!({ sessionID: "ses_auto_main", tool: "read" } as any, output)
  // the hook resolves while the compact command is still pending — the deadlock regression
  expect(Date.now() - t0).toBeLessThan(5_000)
  expect(calls).toContain("fork:ses_auto_main")
  expect(calls).toContain("update:ses_backup_auto")
  expect(calls).toContain("command:compact:ses_auto_main")
  expect(readStatusLog()).toContain("auto-handover backup done")

  // cooldown: an immediate second trigger must not refork
  await hooks["tool.execute.after"]!({ sessionID: "ses_auto_main", tool: "read" } as any, output)
  expect(calls.filter((c) => c.startsWith("fork:")).length).toBe(1)

  // the detached compaction leg logs once the host accepts the command
  releaseCompact()
  await new Promise((r) => setTimeout(r, 50))
  expect(readStatusLog()).toContain("auto-handover compaction queued")
}, 30_000)
