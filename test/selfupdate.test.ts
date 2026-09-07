// [2026-09-04]-[English localization: translate test names and comments; synced expectations with translated banner text; no test-logic change]
import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bannerTextOf, compareSemver, ensureUpdateCommands, flagSemantics, modeOfDistPath, installedPluginVersion, versionBrief } from "../src/selfupdate"
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

describe("Sidebar version line derivation (versionBrief)", () => {
  const flagsNone = { upgraded: false, ignored: false }
  const prodCurrent = { checked_at: "", mode: "prod" as const, current: "1.0.1", latest: "1.0.1", outdated: false }

  test("up-to-date prod: running version only, no update tag, no restart", () => {
    expect(versionBrief({ state: prodCurrent, flags: flagsNone, running: "1.0.1", installed: "1.0.1" }))
      .toEqual({ running: "v1.0.1", update: null, restartPending: false })
  })

  test("prod outdated: update tag carries the latest version; /switchman-ignore suppresses it", () => {
    const st = { ...prodCurrent, latest: "1.2.0", outdated: true }
    expect(versionBrief({ state: st, flags: flagsNone, running: "1.0.1", installed: "1.0.1" }).update).toBe("v1.2.0")
    expect(versionBrief({ state: st, flags: { upgraded: false, ignored: true }, running: "1.0.1", installed: "1.0.1" }).update).toBeNull()
  })

  test("local mode: update tag reads origin/main, running label carries the checked commit short SHA", () => {
    const st = { checked_at: "", mode: "local" as const, current: "a".repeat(40), latest: "origin/main has new commits", outdated: true }
    const b = versionBrief({ state: st, flags: flagsNone, running: "1.0.1", installed: null })
    expect(b.running).toBe("v1.0.1@aaaaaaa")
    expect(b.update).toBe("origin/main")
    expect(b.restartPending).toBe(false)
  })

  test("restart pending: upgraded.flag wins; prod disk-version mismatch counts; local mismatch does not", () => {
    expect(versionBrief({ state: prodCurrent, flags: { upgraded: true, ignored: false }, running: "1.0.1", installed: "1.0.1" }).restartPending).toBe(true)
    expect(versionBrief({ state: prodCurrent, flags: flagsNone, running: "1.0.1", installed: "1.2.0" }).restartPending).toBe(true)
    const localSt = { checked_at: "", mode: "local" as const, current: "deadbeef".repeat(5), latest: "", outdated: false }
    expect(versionBrief({ state: localSt, flags: flagsNone, running: "1.0.1", installed: "1.2.0" }).restartPending).toBe(false)
  })

  test("missing state: labels degrade to the bare running version, flags still drive the restart tag", () => {
    expect(versionBrief({ state: null, flags: { upgraded: false, ignored: true }, running: "1.0.1", installed: null }))
      .toEqual({ running: "v1.0.1", update: null, restartPending: false })
    expect(versionBrief({ state: null, flags: { upgraded: true, ignored: true }, running: "1.0.1", installed: null }).restartPending).toBe(true)
  })

  test("installedPluginVersion reads package.json next to the loaded module (repo root under test)", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
    expect(installedPluginVersion()).toBe(pkg.version)
  })
})
