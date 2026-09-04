// [2026-09-04]-[English localization: translate test names and comments; no expectation changes (no Chinese assertions tied to in-scope src); no test-logic change]
import { describe, expect, test } from "bun:test"
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const state = mkdtempSync(join(tmpdir(), "switchman-doctor-state-"))
process.env.SWITCHMAN_STATE = state

import { formatDoctorReport, runDoctor } from "../src/doctor"
import { ensureUpdateCommands } from "../src/selfupdate"

const path = join(tmpdir(), "switchman-doctor-config.jsonc")
const codes = (text: string, extra: Record<string, unknown> = {}) => runDoctor({ configPath: path, configText: text, ...extra }).diagnostics.map((d) => d.code)

describe("switchman doctor", () => {
  test("config-representative diagnostics, near-spelling suggestions, and all-off legal default", () => {
    expect(codes("{bad")).toContain("SWM001")
    const result = runDoctor({ configPath: path, configText: '{"providers":{"deepseeek":{"enabeld":true}}}' })
    // [2026-08-31]-[De-vendored: near-spellings of unknown keys stay warn with a suggestion; legal custom keys downgrade to info]
    expect(result.diagnostics.find((d) => d.code === "SWM020")?.level).toBe("warn")
    expect(result.diagnostics.find((d) => d.code === "SWM020")?.hint).toBe("deepseek")
    expect(result.diagnostics.find((d) => d.code === "SWM021")?.hint).toBe("enabled")
    expect(codes('{"providers":{"deepseek":{"enabled":"yes","peak":{"timezone":"local","ranges":[{"days":[1],"start":"09:00","end":"11:00"},{"days":[1],"start":"10:00","end":"12:00"}]}}}}')).toEqual(expect.arrayContaining(["SWM030", "SWM035"]))
    expect(runDoctor({ configPath: path, configText: '{"providers":{"deepseek":{"enabled":false},"zhipuai-coding-plan":{"enabled":false},"github-copilot":{"enabled":false}}}' }).diagnostics.map((d) => d.code)).not.toContain("SWM040")
  })
  test("[de-vendored] SWM020 new semantics: custom provider keys legal (info); illegal billing SWM036; unmarked billing SWM061", () => {
    const custom = runDoctor({ configPath: path, configText: '{"providers":{"my-gateway":{"enabled":true,"billing":"subscription"}}}' })
    const swm020 = custom.diagnostics.find((d) => d.code === "SWM020")
    expect(swm020?.level).toBe("info")
    expect(swm020?.hint).toBeUndefined()
    const bad = runDoctor({ configPath: path, configText: '{"providers":{"deepseek":{"billing":"free"}}}' })
    expect(bad.diagnostics.some((d) => d.code === "SWM036" && d.path === "providers.deepseek.billing")).toBe(true)
    // builtin key billing not declared explicitly → info hint (factory default in effect)
    const unmarked = runDoctor({ configPath: path, configText: '{"providers":{"deepseek":{"enabled":false}}}' })
    expect(unmarked.diagnostics.some((d) => d.code === "SWM061" && d.path === "providers.deepseek.billing")).toBe(true)
  })
  test("legacy options, observe risk, state and path diagnostics", () => {
    writeFileSync(join(state, "routing.json"), "{bad")
    const result = runDoctor({ configPath: path, configText: '{"providers":{"deepseek":{"enabled":true,"observe":false}}}', legacy: { quotaEnabled: { glm: true }, billingWindow: true, sections: ["cost", "lanes"] }, env: { OPENCODE_CONFIG_DIR: "relative", XDG_CONFIG_HOME: "/xdg" } })
    expect(result.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(["SWM040", "SWM042", "SWM043", "SWM044", "SWM050", "SWM052"]))
    expect(result.diagnostics.filter((d) => d.code === "SWM044").map((d) => d.path)).toEqual(["legacy.cost", "legacy.lanes"])
    expect(() => runDoctor({ configPath: path, configText: "{}" })).not.toThrow()
    expect(codes("{}", { env: { OPENCODE_CONFIG_DIR: "relative" } })).toContain("SWM052")
    const dir = mkdtempSync(join(tmpdir(), "switchman-readonly-")); chmodSync(dir, 0o500)
    // root may retain write access in CI; non-existent parent is the portable unwritable/error case.
    expect(codes("{}", { configPath: join(dir, "missing", "config.jsonc") })).toContain("SWM051")
  })
  test("report sorts stably by error/warn/info and does not leak field values", () => {
    const report = formatDoctorReport({ diagnostics: [{ code: "SWM012", level: "info" }, { code: "SWM040", level: "warn" }, { code: "SWM001", level: "error", path: "providers.secret" }] })
    expect(report.split("\n").map((x) => x.split(" ")[1])).toEqual(["SWM001", "SWM040", "SWM012"])
    expect(report).not.toContain("secret-value")
  })
  test("doctor command assets generated per local/prod; update/ignore semantics intact", () => {
    const base = mkdtempSync(join(tmpdir(), "switchman-doctor-command-"))
    ensureUpdateCommands("prod", base, "/tool/doctor.js")
    expect(require("node:fs").existsSync(join(base, "command", "switchman-doctor.md"))).toBe(true)
    expect(require("node:fs").existsSync(join(base, "command", "switchman-update.md"))).toBe(true)
    ensureUpdateCommands("local", base, "/tool/doctor.js")
    expect(require("node:fs").existsSync(join(base, "command", "switchman-doctor.md"))).toBe(true)
    expect(require("node:fs").existsSync(join(base, "command", "switchman-ignore.md"))).toBe(true)
    expect(require("node:fs").existsSync(join(base, "command", "switchman-update.md"))).toBe(false)
  })
})
