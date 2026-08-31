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
  test("配置代表诊断、近似建议与全关闭合法默认", () => {
    expect(codes("{bad")).toContain("SWM001")
    const result = runDoctor({ configPath: path, configText: '{"providers":{"deepsek-api":{"enabeld":true}}}' })
    // [2026-08-31]-[去厂商化：未知键近似拼写仍 warn 附建议；合法自定义键降 info]
    expect(result.diagnostics.find((d) => d.code === "SWM020")?.level).toBe("warn")
    expect(result.diagnostics.find((d) => d.code === "SWM020")?.hint).toBe("deepseek-api")
    expect(result.diagnostics.find((d) => d.code === "SWM021")?.hint).toBe("enabled")
    expect(codes('{"providers":{"deepseek-api":{"enabled":"yes","peak":{"timezone":"local","ranges":[{"days":[1],"start":"09:00","end":"11:00"},{"days":[1],"start":"10:00","end":"12:00"}]}}}}')).toEqual(expect.arrayContaining(["SWM030", "SWM035"]))
    expect(runDoctor({ configPath: path, configText: '{"providers":{"deepseek-api":{"enabled":false},"glm-coding-plan-cn":{"enabled":false},"github-copilot":{"enabled":false}}}' }).diagnostics.map((d) => d.code)).not.toContain("SWM040")
  })
  test("[去厂商化] SWM020 新语义：自定义 provider 键合法（info）；billing 非法值 SWM036；billing 未显式 SWM061", () => {
    const custom = runDoctor({ configPath: path, configText: '{"providers":{"my-gateway":{"enabled":true,"billing":"subscription"}}}' })
    const swm020 = custom.diagnostics.find((d) => d.code === "SWM020")
    expect(swm020?.level).toBe("info")
    expect(swm020?.hint).toBeUndefined()
    const bad = runDoctor({ configPath: path, configText: '{"providers":{"deepseek-api":{"billing":"free"}}}' })
    expect(bad.diagnostics.some((d) => d.code === "SWM036" && d.path === "providers.deepseek-api.billing")).toBe(true)
    // 内置键 billing 未显式声明 → info 提示（出厂缺省生效中）
    const unmarked = runDoctor({ configPath: path, configText: '{"providers":{"deepseek-api":{"enabled":false}}}' })
    expect(unmarked.diagnostics.some((d) => d.code === "SWM061" && d.path === "providers.deepseek-api.billing")).toBe(true)
  })
  test("旧 options、observe 风险、状态与路径诊断", () => {
    writeFileSync(join(state, "routing.json"), "{bad")
    const result = runDoctor({ configPath: path, configText: '{"providers":{"deepseek-api":{"enabled":true,"observe":false}}}', legacy: { quotaEnabled: { glm: true }, billingWindow: true }, env: { OPENCODE_CONFIG_DIR: "relative", XDG_CONFIG_HOME: "/xdg" } })
    expect(result.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(["SWM040", "SWM042", "SWM043", "SWM050", "SWM052"]))
    expect(() => runDoctor({ configPath: path, configText: "{}" })).not.toThrow()
    expect(codes("{}", { env: { OPENCODE_CONFIG_DIR: "relative" } })).toContain("SWM052")
    const dir = mkdtempSync(join(tmpdir(), "switchman-readonly-")); chmodSync(dir, 0o500)
    // root may retain write access in CI; non-existent parent is the portable unwritable/error case.
    expect(codes("{}", { configPath: join(dir, "missing", "config.jsonc") })).toContain("SWM051")
  })
  test("报告按 error/warn/info 稳定排序且不泄漏字段值", () => {
    const report = formatDoctorReport({ diagnostics: [{ code: "SWM012", level: "info" }, { code: "SWM040", level: "warn" }, { code: "SWM001", level: "error", path: "providers.secret" }] })
    expect(report.split("\n").map((x) => x.split(" ")[1])).toEqual(["SWM001", "SWM040", "SWM012"])
    expect(report).not.toContain("secret-value")
  })
  test("doctor 命令资产随 local/prod 生成，update/ignore 语义仍在", () => {
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
