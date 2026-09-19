// [2026-09-14]-[D3 dispatch opt-out contract: top-level "dispatch": "off" in <workspace-dirname>/settings.json —
//  exact-string parsing, fail-open fleet everywhere else, present-but-invalid note, and the broken-JSON warning once
//  per process per path. The log callback is injected so every assertion is hermetic (no shared status-log file)]
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadDispatchMode, parseDispatchMode } from "../src/dispatch-mode"
import { t } from "../src/i18n"
import type { MsgKey } from "../src/i18n"

function sandboxProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "switchman-dispatch-mode-"))
  mkdirSync(join(dir, ".switchman"), { recursive: true })
  return dir
}

describe("dispatch-mode: parseDispatchMode (pure)", () => {
  test("exact string: only the exact \"off\" opts out (case/whitespace variants are fleet)", () => {
    expect(parseDispatchMode('{"dispatch":"off"}')).toEqual({ mode: "off", broken: false, invalidValue: false })
    expect(parseDispatchMode('{"v":1,"lang":{"conversation":"en","comments":"en","docs":"en"},"dispatch":"off"}').mode).toBe("off")
    expect(parseDispatchMode('{"dispatch":"OFF"}')).toMatchObject({ mode: "fleet", invalidValue: true, rawValue: "OFF" })
    expect(parseDispatchMode('{"dispatch":"off "}')).toMatchObject({ mode: "fleet", invalidValue: true, rawValue: "off " })
    expect(parseDispatchMode('{"dispatch":" off"}').mode).toBe("fleet")
  })
  test("fail-open: absent field / other values / non-string values → fleet", () => {
    expect(parseDispatchMode("{}")).toEqual({ mode: "fleet", broken: false, invalidValue: false })
    expect(parseDispatchMode('{"lang":{"conversation":"en","comments":"en","docs":"en"}}')).toMatchObject({ mode: "fleet", invalidValue: false })
    expect(parseDispatchMode('{"dispatch":"fleet"}')).toMatchObject({ mode: "fleet", invalidValue: true, rawValue: "fleet" })
    expect(parseDispatchMode('{"dispatch":"on"}')).toMatchObject({ mode: "fleet", invalidValue: true, rawValue: "on" })
    expect(parseDispatchMode('{"dispatch":true}')).toMatchObject({ mode: "fleet", invalidValue: true, rawValue: "true" })
    expect(parseDispatchMode('{"dispatch":42}')).toMatchObject({ mode: "fleet", invalidValue: true, rawValue: "42" })
    expect(parseDispatchMode('{"dispatch":null}').mode).toBe("fleet")
  })
  test("broken JSON is flagged (caller warns); valid non-object JSON is plain fleet (no note)", () => {
    expect(parseDispatchMode("{nope")).toEqual({ mode: "fleet", broken: true, invalidValue: false })
    expect(parseDispatchMode('{"dispatch":"off",')).toEqual({ mode: "fleet", broken: true, invalidValue: false })
    expect(parseDispatchMode('"off"')).toEqual({ mode: "fleet", broken: false, invalidValue: false })
    expect(parseDispatchMode("null")).toEqual({ mode: "fleet", broken: false, invalidValue: false })
  })
})

describe("dispatch-mode: loadDispatchMode (per-call disk read, never throws)", () => {
  test("settings.json with dispatch:\"off\" → off; missing file → fleet; no log noise", () => {
    const offDir = sandboxProject()
    writeFileSync(join(offDir, ".switchman", "settings.json"), JSON.stringify({ v: 1, dispatch: "off" }))
    const logs: Array<{ key: string; params?: Record<string, string | number> }> = []
    expect(loadDispatchMode(offDir, ".switchman", (k, p) => logs.push({ key: k, params: p }))).toBe("off")
    expect(logs).toEqual([])

    const emptyDir = sandboxProject()
    expect(loadDispatchMode(emptyDir, ".switchman", (k, p) => logs.push({ key: k, params: p }))).toBe("fleet")
    expect(logs).toEqual([])
  })
  test("present-but-invalid value → one note, fleet behavior; the note fires once per process per path", () => {
    const dir = sandboxProject()
    writeFileSync(join(dir, ".switchman", "settings.json"), JSON.stringify({ dispatch: "OFF" }))
    const logs: Array<{ key: string; params?: Record<string, string | number> }> = []
    // [2026-09-19]-[i18n cleanup: the log mock now receives structured (key, params) — assert the pair directly]
    const log = (k: string, p?: Record<string, string | number>) => logs.push({ key: k, params: p })
    expect(loadDispatchMode(dir, ".switchman", log)).toBe("fleet")
    expect(loadDispatchMode(dir, ".switchman", log)).toBe("fleet")
    expect(loadDispatchMode(dir, ".switchman", log)).toBe("fleet")
    expect(logs.length).toBe(1)
    expect(logs[0]!.key).toBe("notice.lang.dispatchNotOff")
    expect(logs[0]!.params?.rawValue).toBe("OFF")
    expect(t("en", logs[0]!.key as MsgKey, logs[0]!.params)).toContain("fleet behavior")
  })
  test("broken settings.json → warning with the exact copy, once per process per path; a second path warns separately", () => {
    const dirA = sandboxProject()
    const dirB = sandboxProject()
    writeFileSync(join(dirA, ".switchman", "settings.json"), "{not json")
    writeFileSync(join(dirB, ".switchman", "settings.json"), "{also broken")
    const logs: Array<{ key: string; params?: Record<string, string | number> }> = []
    // [2026-09-19]-[i18n cleanup: the log mock now receives structured (key, params) — assert the pair directly]
    const log = (k: string, p?: Record<string, string | number>) => logs.push({ key: k, params: p })
    // fleet behavior, warning emitted once per path (three reads of A, one of B)
    expect(loadDispatchMode(dirA, ".switchman", log)).toBe("fleet")
    expect(loadDispatchMode(dirA, ".switchman", log)).toBe("fleet")
    expect(loadDispatchMode(dirB, ".switchman", log)).toBe("fleet")
    expect(loadDispatchMode(dirA, ".switchman", log)).toBe("fleet")
    expect(logs.length).toBe(2)
    expect(logs[0]!.key).toBe("notice.lang.settingsInvalidJson")
    expect(logs[1]!.key).toBe("notice.lang.settingsInvalidJson")
    expect(t("en", logs[0]!.key as MsgKey, logs[0]!.params)).toBe('[opencode-switchman] .switchman/settings.json is not valid JSON — ignored (lang config falls back to the AGENTS.md marker; "dispatch":"off" not applied)')
    expect(t("en", logs[1]!.key as MsgKey, logs[1]!.params)).toBe('[opencode-switchman] .switchman/settings.json is not valid JSON — ignored (lang config falls back to the AGENTS.md marker; "dispatch":"off" not applied)')
  })
  test("coexistence: a lang block and dispatch:\"off\" in the same file both parse (extra top-level fields ignored by the lang parser)", () => {
    const dir = sandboxProject()
    writeFileSync(join(dir, ".switchman", "settings.json"), JSON.stringify({
      v: 1,
      lang: { conversation: "zh-CN", comments: "en", docs: "en" },
      dispatch: "off",
    }))
    const logs: Array<{ key: string; params?: Record<string, string | number> }> = []
    expect(loadDispatchMode(dir, ".switchman", (k, p) => logs.push({ key: k, params: p }))).toBe("off")
    expect(logs).toEqual([])
  })
})
