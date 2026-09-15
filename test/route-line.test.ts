// [2026-09-14]-[D2 per-turn [ROUTE] line contract: one static text (pinned verbatim — it is protocol copy, drift here is
//  a protocol change), gate rule = rules||banner (zero-injection wish respected, same as the watermark/TODO lines), and
//  the wiring pushes it after [WATERMARK:SESSION]/[TODO] inside the rules||banner block. The dispatch-mode opt-out gate
//  is owned by dispatch:"off" (D3, not in this change)]
import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { renderRouteLine, routeLineEnabled } from "../src/route-line"

test("route line: static text pin (protocol copy, verbatim)", () => {
  expect(renderRouteLine()).toBe("[ROUTE] token economy (IRON RULE): before each substantive action, declare in one sentence — [DISPATCH] self or delegate (§6) — weighing the measured context ([WATERMARK:SESSION]): hands-on spends and grows this session's context on every later turn, a dispatch spends a fresh shell context and returns a summary; long or heavy context favors dispatch, trivia (below the delegation floor, known-path reads, workspace bookkeeping, fleet coordination) stays hands-on.")
})

test("route line gate: any of rules/banner on keeps the line, both off suppresses, dispatch-off hides it", () => {
  expect(routeLineEnabled(true, true, false)).toBe(true)
  expect(routeLineEnabled(true, false, false)).toBe(true)
  expect(routeLineEnabled(false, true, false)).toBe(true)
  expect(routeLineEnabled(false, false, false)).toBe(false)
  // [2026-09-14]-[D3: dispatch:"off" is the single opt-out for the routing-discipline surface]
  expect(routeLineEnabled(true, true, true)).toBe(false)
  expect(routeLineEnabled(true, false, true)).toBe(false)
  expect(routeLineEnabled(false, true, true)).toBe(false)
  expect(routeLineEnabled(false, false, true)).toBe(false)
})

const configDir = mkdtempSync(join(tmpdir(), "switchman-route-config-"))
const stateDir = mkdtempSync(join(tmpdir(), "switchman-route-state-"))
const projectDir = mkdtempSync(join(tmpdir(), "switchman-route-project-"))
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

async function boot(rawOptions: Record<string, unknown>) {
  const hooks = await SwitchmanPlugin({ client: fakeClient, directory: projectDir } as any, { matrix: { mode: "legacy" }, ...rawOptions } as any)
  const system = async (sessionID: string) => {
    const output = { system: [] as string[] }
    await hooks["experimental.chat.system.transform"]!({ sessionID } as any, output as any)
    return output.system
  }
  return { system }
}

test("route line wiring: pushed on main-session turns by default, suppressed when rules and banner are both off", async () => {
  const on = await boot({})
  const sysOn = await on.system("ses_route_main")
  expect(sysOn.filter((l) => l === renderRouteLine()).length).toBe(1)

  const off = await boot({ rules: { enabled: false }, banner: { enabled: false } })
  const sysOff = await off.system("ses_route_main2")
  expect(sysOff.some((l) => l === renderRouteLine())).toBe(false)
}, 30_000)
