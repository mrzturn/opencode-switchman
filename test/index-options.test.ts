import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.OPENCODE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "switchman-options-config-"))
process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-options-state-"))
writeFileSync(join(process.env.SWITCHMAN_STATE, "model-catalog.json"), JSON.stringify({ fetched_at: Date.now(), etag: null, index: {} }))

import { SwitchmanPlugin } from "../src/index"

test("插件声明无 options 时 config 钩子仍注入壳", async () => {
  const hooks = await SwitchmanPlugin({ client: { provider: { list: async () => [] } } } as any, undefined as any)
  const cfg: Record<string, unknown> = {}
  await hooks.config!(cfg as any)
  expect(Object.keys((cfg as any).agent ?? {}).length).toBeGreaterThan(0)
}, 15_000)
