// [2026-09-04]-[English localization: translate titles/comments; no logic change]
import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.OPENCODE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "switchman-options-config-"))
process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-options-state-"))
writeFileSync(join(process.env.SWITCHMAN_STATE, "model-catalog.json"), JSON.stringify({ fetched_at: Date.now(), etag: null, index: {} }))

import { SwitchmanPlugin } from "../src/index"
import { parseJsonc, validateUserConfig } from "../src/config"

test("config hook still injects shells when the plugin is declared without options", async () => {
  const hooks = await SwitchmanPlugin({ client: { provider: { list: async () => [] } } } as any, undefined as any)
  const cfg: Record<string, unknown> = {}
  await hooks.config!(cfg as any)
  expect(Object.keys((cfg as any).agent ?? {}).length).toBeGreaterThan(0)
}, 15_000)

// [2026-09-15]-[context.subagentSoftTiers retired (fraction coefficients → shared absolute main-session thresholds):
//  the option is gone from the config surface, legacy values pass through harmlessly; context.subagentForceTokens is
//  optional — absent follows forceTokens, present-but-invalid → deleted with SWM037 (fail-open)]
test("context.subagentSoftTiers retired; subagentForceTokens optional, invalid override deleted (SWM037)", () => {
  // defaults no longer carry either field (the retired key no longer exists on the type)
  const base = validateUserConfig({})
  expect("subagentSoftTiers" in base.config.context).toBe(false)
  expect(base.config.context.subagentForceTokens).toBeUndefined()
  expect(base.diagnostics.filter((d) => d.level === "error")).toEqual([])
  // retired option: legacy jsonc values pass through harmlessly (unknown keys are not validated, no diagnostics)
  const legacy = parseJsonc(`{"context":{"subagentSoftTiers":[0.4,0.8]}}`)
  const legacyChecked = validateUserConfig("value" in legacy ? legacy.value : {})
  expect(legacyChecked.diagnostics.filter((d) => d.level === "error")).toEqual([])
  // valid jsonc override passes through untouched
  const ok = parseJsonc(`{"context":{"subagentForceTokens":150000}}`)
  const okChecked = validateUserConfig("value" in ok ? ok.value : {})
  expect(okChecked.config.context.subagentForceTokens).toBe(150_000)
  expect(okChecked.diagnostics.filter((d) => d.level === "error")).toEqual([])
  // present-but-invalid override (outside 20k..1M / non-finite / wrong type) → deleted + SWM037, cap falls back to forceTokens
  for (const bad of [19_999, 1_000_001, Number.NaN, "big", null]) {
    const checked = validateUserConfig({ context: { subagentForceTokens: bad as any } })
    expect(checked.config.context.subagentForceTokens).toBeUndefined()
    expect(checked.diagnostics.some((d) => d.code === "SWM037" && d.path === "context.subagentForceTokens")).toBe(true)
  }
})
