// [2026-09-04]-[English localization: translate test names and comments; no test-logic change.
//  NOTE: scripts/update-cli.mjs was translated by the parallel workstream; the "Invalid version" expectation below matches its English copy.]
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cachePackagesDirOf, configDirOf, pruneCaches, rewriteSpec, run, stateDirOf } from "../scripts/update-cli.mjs"

const sandbox = () => mkdtempSync(join(tmpdir(), "sw-update-cli-"))

describe("update-cli config rewrite", () => {
  test("bare package name replaced with the exact version, everything else preserved byte-for-byte", () => {
    const before = `{\n  "$schema": "https://opencode.ai/config.json",\n  "plugin": [\n    "opencode-switchman"\n    // "file:///repo/opencode-switchman"\n  ]\n}\n`
    const r = rewriteSpec(before, "opencode-switchman@0.2.1")
    expect(r.action).toBe("replaced")
    expect(r.previous).toBe("opencode-switchman")
    expect(r.text).toContain('"opencode-switchman@0.2.1"')
    expect(r.text).toContain('// "file:///repo/opencode-switchman"')
    expect(r.text.split("\n").length).toBe(before.split("\n").length)
  })
  test("old exact versions and @latest are both replaced; identical spec is a noop", () => {
    expect(rewriteSpec('{"plugin":["opencode-switchman@0.2.0"]}', "opencode-switchman@0.3.0").previous).toBe("opencode-switchman@0.2.0")
    expect(rewriteSpec('{"plugin":["opencode-switchman@latest"]}', "opencode-switchman@0.3.0").action).toBe("replaced")
    expect(rewriteSpec('{"plugin":["opencode-switchman@0.3.0"]}', "opencode-switchman@0.3.0").action).toBe("noop")
  })
  test("commented entries are uncommented and rewritten; an active file:// reference is skipped untouched", () => {
    expect(rewriteSpec('{\n  // "opencode-switchman"\n}', "opencode-switchman@0.2.0").action).toBe("uncommented")
    const fileRef = '{"plugin":["file:///repo/opencode-switchman"]}'
    expect(rewriteSpec(fileRef, "opencode-switchman@0.2.0")).toMatchObject({ action: "file-ref", text: fileRef })
  })
  test("multiline/inline/empty-array/no-plugin-key insertions all produce valid JSON", () => {
    const multi = rewriteSpec('{\n  "plugin": [\n    "a"\n  ]\n}', "opencode-switchman@0.2.0")
    expect(multi.action).toBe("inserted")
    expect(JSON.parse(multi.text).plugin[0]).toBe("opencode-switchman@0.2.0")
    const inline = rewriteSpec('{"plugin": ["a"]}', "opencode-switchman@0.2.0")
    expect(JSON.parse(inline.text).plugin).toEqual(["a", "opencode-switchman@0.2.0"])
    const empty = rewriteSpec('{\n  "$schema": "x",\n  "plugin": []\n}', "opencode-switchman@0.2.0")
    expect(JSON.parse(empty.text).plugin).toEqual(["opencode-switchman@0.2.0"])
    const noKey = rewriteSpec('{\n  "model": "a/b"\n}', "opencode-switchman@0.2.0")
    expect(JSON.parse(noKey.text).plugin).toEqual(["opencode-switchman@0.2.0"])
  })
  test("empty text creates a minimal template; existing files where the plugin array cannot be located report unparseable without rewrite", () => {
    expect(rewriteSpec("", "opencode-switchman@0.2.0").action).toBe("created")
    const weird = "just some text"
    expect(rewriteSpec(weird, "opencode-switchman@0.2.0")).toMatchObject({ action: "unparseable", text: weird })
  })
})

describe("update-cli path resolution and cache pruning", () => {
  test("directory priority matches src/config.ts semantics", () => {
    expect(configDirOf({ OPENCODE_CONFIG_DIR: "/a" }, "/h")).toBe("/a")
    expect(configDirOf({ XDG_CONFIG_HOME: "/b" }, "/h")).toBe("/b/opencode")
    expect(configDirOf({}, "/h")).toBe("/h/.config/opencode")
    expect(cachePackagesDirOf({ XDG_CACHE_HOME: "/c" }, "/h")).toBe("/c/opencode/packages")
    expect(cachePackagesDirOf({}, "/h")).toBe("/h/.cache/opencode/packages")
    expect(stateDirOf({ SWITCHMAN_STATE: "/s" }, "/h")).toBe("/s")
    expect(stateDirOf({}, "/h")).toBe("/h/.config/opencode/opencode-switchman")
  })
  test("pruneCaches removes only this package (bare name and @any-version), other packages kept", () => {
    const dir = sandbox()
    const pkgs = join(dir, "packages")
    for (const name of ["opencode-switchman", "opencode-switchman@0.0.1", "opencode-switchman@latest", "opencode-switchman@0.2.0", "other-pkg"]) {
      mkdirSync(join(pkgs, name), { recursive: true })
      writeFileSync(join(pkgs, name, "f.txt"), "x")
    }
    const removed = pruneCaches(pkgs)
    expect(removed.sort()).toEqual(["opencode-switchman", "opencode-switchman@0.0.1", "opencode-switchman@0.2.0", "opencode-switchman@latest"])
    expect(existsSync(join(pkgs, "other-pkg"))).toBe(true)
    expect(pruneCaches(join(dir, "missing"))).toEqual([])
  })
})

describe("update-cli run end-to-end (sandboxed env, no network)", () => {
  test("upgrade scenario: rewrite both configs + prune caches + flag upgraded; dry-run writes nothing", async () => {
    const home = sandbox()
    const cfg = join(home, ".config", "opencode")
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, "opencode.jsonc"), '{\n  "plugin": ["opencode-switchman@0.1.0"]\n}\n')
    writeFileSync(join(cfg, "tui.jsonc"), '{\n  "plugin": []\n}\n')
    const cache = join(home, ".cache")
    mkdirSync(join(cache, "opencode", "packages", "opencode-switchman@0.1.0"), { recursive: true })
    const env = { XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: cache }
    const lines: string[] = []
    const out = await run(["--version", "0.2.0"], { env, home, log: (m) => lines.push(m) })
    expect(out.spec).toBe("opencode-switchman@0.2.0")
    expect(readFileSync(join(cfg, "opencode.jsonc"), "utf8")).toContain('"opencode-switchman@0.2.0"')
    expect(JSON.parse(readFileSync(join(cfg, "tui.jsonc"), "utf8")).plugin).toEqual(["opencode-switchman@0.2.0"])
    expect(existsSync(join(cache, "opencode", "packages", "opencode-switchman@0.1.0"))).toBe(false)
    expect(existsSync(join(home, ".config", "opencode", "opencode-switchman", "upgraded.flag"))).toBe(true)
    // dry-run: same input produces no change (restore the entry first)
    writeFileSync(join(cfg, "opencode.jsonc"), '{\n  "plugin": ["opencode-switchman@0.1.0"]\n}\n')
    lines.length = 0
    await run(["--version", "0.2.0", "--dry-run"], { env, home, log: (m) => lines.push(m) })
    expect(readFileSync(join(cfg, "opencode.jsonc"), "utf8")).toContain('"opencode-switchman@0.1.0"')
    expect(lines.join("\n")).toContain("dry-run")
  })
  test("fresh install: with no config files, creates the opencode and tui configs without flagging an upgrade", async () => {
    const home = sandbox()
    const env = { XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache") }
    const lines: string[] = []
    const out = await run(["--version", "0.2.0"], { env, home, log: (m) => lines.push(m) })
    const cfg = join(home, ".config", "opencode")
    const mainJson = JSON.parse(readFileSync(join(cfg, "opencode.jsonc"), "utf8"))
    expect(mainJson.plugin).toEqual(["opencode-switchman@0.2.0"])
    expect(JSON.parse(readFileSync(join(cfg, "tui.jsonc"), "utf8")).plugin).toEqual(["opencode-switchman@0.2.0"])
    expect(existsSync(join(cfg, "opencode-switchman", "upgraded.flag"))).toBe(false)
    expect(out.actions.map((a) => a.action).sort()).toEqual(["created", "inserted"])
    void readdirSync(cfg)
  })
  test("upgrade scenario but tui config missing: tui.jsonc is created and the spec written (create-if-missing)", async () => {
    const home = sandbox()
    const cfg = join(home, ".config", "opencode")
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, "opencode.jsonc"), '{\n  "plugin": ["opencode-switchman@0.1.0"]\n}\n')
    const env = { XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache") }
    const out = await run(["--version", "0.2.0"], { env, home, log: () => {} })
    expect(JSON.parse(readFileSync(join(cfg, "tui.jsonc"), "utf8")).plugin).toEqual(["opencode-switchman@0.2.0"])
    expect(out.actions.find((a) => a.file === join(cfg, "tui.jsonc"))?.action).toBe("inserted")
  })
  test("invalid version errors out directly", async () => {
    const home = sandbox()
    await expect(run(["--version", "abc"], { env: {}, home, log: () => {} })).rejects.toThrow("Invalid version")
  })
})
