import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bannerTextOf, compareSemver, ensureUpgradeCommand, modeOfDistPath } from "../src/selfupdate"
import { readFileSync, existsSync } from "node:fs"
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
  test("prod 写入 /switchman-update（npm 静默安装模板），local 删除残留", () => {
    const base = mkdtempSync(join(tmpdir(), "sw-cmd-"))
    ensureUpgradeCommand("prod", base)
    const file = join(base, "command", "switchman-update.md")
    const md = readFileSync(file, "utf8")
    expect(md).toContain("npm install opencode-switchman@latest")
    expect(md).toContain("description:")
    ensureUpgradeCommand("local", base)
    expect(existsSync(file)).toBe(false)
  })
  test("upgradeCommandMd：local 模式文案不含一键升级入口", () => {
    expect(bannerTextOf({ checked_at: "", mode: "local", current: "0.0.1", latest: "", outdated: true })).not.toContain("/switchman-update")
    expect(bannerTextOf({ checked_at: "", mode: "prod", current: "0.0.1", latest: "9.9.9", outdated: true })).toContain("/switchman-update")
  })
})
