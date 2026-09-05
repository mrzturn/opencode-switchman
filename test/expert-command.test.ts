// /expert command: template contract + config-hook registration (behavioral contract)
// [2026-09-05]-[locks the two dispatch routes (review head preferred, hard head's ro face fallback) and the
//  $ARGUMENTS placeholder; fallback trigger must match the banner empty-chain marker verbatim]
import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.OPENCODE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "switchman-expert-config-"))
process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-expert-state-"))
writeFileSync(join(process.env.SWITCHMAN_STATE, "model-catalog.json"), JSON.stringify({ fetched_at: Date.now(), etag: null, index: {} }))

import { expertCommandMd } from "../src/commands-md"
import { SwitchmanPlugin } from "../src/index"

test("expertCommandMd carries the argument placeholder and both dispatch routes", () => {
  const md = expertCommandMd()
  // argument surface: opencode substitutes $ARGUMENTS; empty/literal handled by asking the user
  expect(md).toContain("$ARGUMENTS")
  // preferred route: review pool expert seat, read-only, user-sourced (exempts gate-7 fallback chain checks)
  expect(md).toContain('"lane":"review"')
  expect(md).toContain('"role":"expert-alpha"')
  expect(md).toContain('"capability":"ro"')
  expect(md).toContain('"source":"user"')
  expect(md).toContain('"modality":"text"')
  // fallback route: hard pool head on its ro face, explicitly downgraded
  expect(md).toContain('"lane":"hard"')
  expect(md).toContain('"role":"planner"')
  expect(md).toContain("-ro")
  expect(md).toContain("DOWNGRADED")
  // fallback trigger matches the banner empty-chain marker verbatim (src/banner.ts routeLine else-branch)
  expect(md).toContain("all unavailable→terminal failure protocol")
  // banner short names must be mapped back to full shell names for the task tool
  expect(md).toContain("-mx-")
  // deny handling + terminal failure protocol pointers
  expect(md).toContain("deny postscript")
  expect(md).toContain("terminal failure protocol")
})

test("config hook registers /expert alongside the config chat commands", async () => {
  const hooks = await SwitchmanPlugin({ client: { provider: { list: async () => [] } } } as any, undefined as any)
  const cfg: Record<string, any> = {}
  await hooks.config!(cfg as any)
  const cmd = cfg.command ?? {}
  expect(typeof cmd.expert?.template).toBe("string")
  expect(cmd.expert.template).toContain("$ARGUMENTS")
  expect(cmd.expert.template).toContain('"lane":"review"')
  expect(typeof cmd.expert.description).toBe("string")
  // existing conversational commands untouched
  expect(typeof cmd["poolConfig-chat"]?.template).toBe("string")
  expect(typeof cmd["modelRank-chat"]?.template).toBe("string")
}, 15_000)
