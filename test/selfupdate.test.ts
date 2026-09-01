import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bannerTextOf, compareSemver, ensureUpdateCommands, flagSemantics, modeOfDistPath } from "../src/selfupdate"
import { readFileSync, existsSync, writeFileSync, rmSync, utimesSync } from "node:fs"
import type { SelfUpdateState } from "../src/selfupdate"

describe("插件自更新纯函数", () => {
  test("语义化版本比较：新、旧、相等与 prerelease 忽略", () => {
    expect(compareSemver("1.2.3", "1.3.0")).toBeGreaterThan(0)
    expect(compareSemver("2.0.0", "1.9.9")).toBeLessThan(0)
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0)
    expect(compareSemver("1.2.3-beta.1", "1.2.3-rc.1")).toBe(0)
  })

  test("dist 路径含 node_modules 为 prod", () => {
    expect(modeOfDistPath("/repo/dist")).toBe("local")
    expect(modeOfDistPath("/home/user/node_modules/opencode-switchman/dist")).toBe("prod")
  })

  test("横幅按装载模式给出更新提示，无更新时为空", () => {
    const prod: SelfUpdateState = {
      checked_at: "2026-08-29T00:00:00.000Z", mode: "prod", current: "0.0.1", latest: "0.0.2", outdated: true,
    }
    const local: SelfUpdateState = { ...prod, mode: "local", latest: "origin/main 有新提交" }
    expect(bannerTextOf(prod)).toContain("有新版 0.0.2（当前 0.0.1）")
    expect(bannerTextOf(local)).toContain("git pull && bun run mode:local")
    expect(bannerTextOf({ ...prod, outdated: false })).toBeNull()
  })
})

describe("一键升级命令资产", () => {
  test("prod 写入 /switchman-update（随包更新器模板），local 删除残留", () => {
    const base = mkdtempSync(join(tmpdir(), "sw-cmd-"))
    ensureUpdateCommands("prod", base)
    const file = join(base, "command", "switchman-update.md")
    const md = readFileSync(file, "utf8")
    // [2026-09-01]-[opencode 插件缓存钉死裸 spec，npm install 方式无效——模板改为调用随包更新器]-
    expect(md).toContain("update-cli.js")
    expect(md).toContain("node ")
    expect(md).toContain("description:")
    ensureUpdateCommands("local", base)
    expect(existsSync(file)).toBe(false)
  })
  test("升级/忽略标记语义：mtime 晚于进程启动=生效，重启后失效", () => {
    const base = mkdtempSync(join(tmpdir(), "sw-flag-"))
    const past = Date.now() - 60_000
    expect(flagSemantics(base, past).upgraded).toBe(false)
    writeFileSync(join(base, "upgraded.flag"), "")
    utimesSync(join(base, "upgraded.flag"), new Date(), new Date())
    expect(flagSemantics(base, past).upgraded).toBe(true)
    expect(flagSemantics(base, Date.now() + 60_000).upgraded).toBe(false)
    writeFileSync(join(base, "update-ignore.flag"), "")
    utimesSync(join(base, "update-ignore.flag"), new Date(), new Date())
    expect(flagSemantics(base, past).ignored).toBe(true)
  })
  test("横幅：升级完成显示待重启、本次忽略返回 null、local 只给忽略入口", () => {
    const base = mkdtempSync(join(tmpdir(), "sw-bnr-"))
    writeFileSync(join(base, "upgraded.flag"), "")
    utimesSync(join(base, "upgraded.flag"), new Date(), new Date())
    const st: SelfUpdateState = { checked_at: "", mode: "prod", current: "1.0.0", latest: "2.0.0", outdated: true }
    expect(bannerTextOf(st, Date.now(), base)).toContain("已升级")
    rmSync(join(base, "upgraded.flag"), { force: true })
    writeFileSync(join(base, "update-ignore.flag"), "")
    utimesSync(join(base, "update-ignore.flag"), new Date(), new Date())
    expect(bannerTextOf(st, Date.now(), base)).toBeNull()
    rmSync(join(base, "update-ignore.flag"), { force: true })
    expect(bannerTextOf({ ...st, mode: "local" }, Date.now(), base)).toContain("/switchman-ignore")
    expect(bannerTextOf({ ...st, mode: "local" }, Date.now(), base)).not.toContain("/switchman-update")
  })
  test("prod 双命令、local 仅忽略命令", () => {
    const base = mkdtempSync(join(tmpdir(), "sw-cmd2-"))
    ensureUpdateCommands("prod", base)
    expect(existsSync(join(base, "command", "switchman-ignore.md"))).toBe(true)
    ensureUpdateCommands("local", base)
    expect(existsSync(join(base, "command", "switchman-ignore.md"))).toBe(true)
    expect(existsSync(join(base, "command", "switchman-update.md"))).toBe(false)
  })
  test("doctor 命令默认使用插件模块目录而非用户项目 cwd", () => {
    const base = mkdtempSync(join(tmpdir(), "sw-doctor-path-"))
    ensureUpdateCommands("prod", base)
    expect(readFileSync(join(base, "command", "switchman-doctor.md"), "utf8")).not.toContain(`${process.cwd()}/dist/switchman-doctor.js`)
  })
  test("upgradeCommandMd：local 模式文案不含一键升级入口", () => {
    expect(bannerTextOf({ checked_at: "", mode: "local", current: "0.0.1", latest: "", outdated: true })).not.toContain("/switchman-update")
    expect(bannerTextOf({ checked_at: "", mode: "prod", current: "0.0.1", latest: "9.9.9", outdated: true })).toContain("/switchman-update")
  })
})
