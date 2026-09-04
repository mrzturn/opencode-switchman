// [2026-09-04]-[English localization: translate test names and comments; synced expectations with translated banner text; no test-logic change]
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bannerTextOf, compareSemver, ensureUpdateCommands, flagSemantics, modeOfDistPath } from "../src/selfupdate"
import { readFileSync, existsSync, writeFileSync, rmSync, utimesSync } from "node:fs"
import type { SelfUpdateState } from "../src/selfupdate"

describe("Plugin self-update pure functions", () => {
  test("semantic version comparison: newer, older, equal, prerelease ignored", () => {
    expect(compareSemver("1.2.3", "1.3.0")).toBeGreaterThan(0)
    expect(compareSemver("2.0.0", "1.9.9")).toBeLessThan(0)
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0)
    expect(compareSemver("1.2.3-beta.1", "1.2.3-rc.1")).toBe(0)
  })

  test("dist path containing node_modules is prod", () => {
    expect(modeOfDistPath("/repo/dist")).toBe("local")
    expect(modeOfDistPath("/home/user/node_modules/opencode-switchman/dist")).toBe("prod")
  })

  test("banner gives update hints per load mode; empty when no update", () => {
    const prod: SelfUpdateState = {
      checked_at: "2026-08-29T00:00:00.000Z", mode: "prod", current: "0.0.1", latest: "0.0.2", outdated: true,
    }
    const local: SelfUpdateState = { ...prod, mode: "local", latest: "origin/main has new commits" }
    expect(bannerTextOf(prod)).toContain("new version 0.0.2 (current 0.0.1)")
    expect(bannerTextOf(local)).toContain("git pull && bun run mode:local")
    expect(bannerTextOf({ ...prod, outdated: false })).toBeNull()
  })
})

describe("One-click upgrade command assets", () => {
  test("prod writes /switchman-update (bundled updater template), local removes leftovers", () => {
    const base = mkdtempSync(join(tmpdir(), "sw-cmd-"))
    ensureUpdateCommands("prod", base)
    const file = join(base, "command", "switchman-update.md")
    const md = readFileSync(file, "utf8")
    // [2026-09-01]-[opencode pins the plugin cache to the bare spec, so npm install is ineffective — the template was changed to call the bundled updater]-
    expect(md).toContain("update-cli.js")
    expect(md).toContain("node ")
    expect(md).toContain("description:")
    ensureUpdateCommands("local", base)
    expect(existsSync(file)).toBe(false)
  })
  test("upgrade/ignore marker semantics: mtime later than process start = active, expires after restart", () => {
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
  test("banner: upgrade-complete shows restart-pending, ignore-this-time returns null, local offers only the ignore entry", () => {
    const base = mkdtempSync(join(tmpdir(), "sw-bnr-"))
    writeFileSync(join(base, "upgraded.flag"), "")
    utimesSync(join(base, "upgraded.flag"), new Date(), new Date())
    const st: SelfUpdateState = { checked_at: "", mode: "prod", current: "1.0.0", latest: "2.0.0", outdated: true }
    expect(bannerTextOf(st, Date.now(), base)).toContain("upgraded")
    rmSync(join(base, "upgraded.flag"), { force: true })
    writeFileSync(join(base, "update-ignore.flag"), "")
    utimesSync(join(base, "update-ignore.flag"), new Date(), new Date())
    expect(bannerTextOf(st, Date.now(), base)).toBeNull()
    rmSync(join(base, "update-ignore.flag"), { force: true })
    expect(bannerTextOf({ ...st, mode: "local" }, Date.now(), base)).toContain("/switchman-ignore")
    expect(bannerTextOf({ ...st, mode: "local" }, Date.now(), base)).not.toContain("/switchman-update")
  })
  test("prod dual commands, local ignore-only", () => {
    const base = mkdtempSync(join(tmpdir(), "sw-cmd2-"))
    ensureUpdateCommands("prod", base)
    expect(existsSync(join(base, "command", "switchman-ignore.md"))).toBe(true)
    ensureUpdateCommands("local", base)
    expect(existsSync(join(base, "command", "switchman-ignore.md"))).toBe(true)
    expect(existsSync(join(base, "command", "switchman-update.md"))).toBe(false)
  })
  test("doctor command defaults to the plugin module directory, not the user project cwd", () => {
    const base = mkdtempSync(join(tmpdir(), "sw-doctor-path-"))
    ensureUpdateCommands("prod", base)
    expect(readFileSync(join(base, "command", "switchman-doctor.md"), "utf8")).not.toContain(`${process.cwd()}/dist/switchman-doctor.js`)
  })
  test("upgradeCommandMd: local-mode copy has no one-click upgrade entry", () => {
    expect(bannerTextOf({ checked_at: "", mode: "local", current: "0.0.1", latest: "", outdated: true })).not.toContain("/switchman-update")
    expect(bannerTextOf({ checked_at: "", mode: "prod", current: "0.0.1", latest: "9.9.9", outdated: true })).toContain("/switchman-update")
  })
})
