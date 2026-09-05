// [2026-09-05]-[artifact workspace fixture: slug/day-folder/session-folder pure functions + WorkspaceTracker
//  create-on-demand / title rename / steady-state idempotence / disabled switch / dispatch trace /
//  config surface (defaults, validation fallback, tuple override, generated template)]
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { WorkspaceTracker, workspaceSlug, dayFolder, sessionFolderName, renderSessionMeta, DEFAULT_WORKSPACE_DIRNAME } from "../src/workspace"
import { validateUserConfig, resolveEffectiveOptions, parseJsonc } from "../src/config"
import { defaultProviderConfig, renderDefaultConfigJsonc } from "../src/provider-config"

function sandboxProject(): string {
  return mkdtempSync(join(tmpdir(), "switchman-ws-"))
}

function tracker(dir: string, enabled = true, dirname = DEFAULT_WORKSPACE_DIRNAME): WorkspaceTracker {
  return new WorkspaceTracker(() => ({ enabled, dirname }), join(dir, "fallback"))
}

describe("workspace: pure naming functions", () => {
  test("workspaceSlug strips filesystem-hostile characters, collapses whitespace, keeps CJK, caps length", () => {
    expect(workspaceSlug("Fix: login <bug>?")).toBe("Fix-login-bug")
    expect(workspaceSlug('a/b\\c:d*e?f"g<h>i|j')).toBe("a-b-c-d-e-f-g-h-i-j")
    expect(workspaceSlug("修复登录问题")).toBe("修复登录问题")
    expect(workspaceSlug("  spaced   out  ")).toBe("spaced-out")
    expect(workspaceSlug("")).toBe("untitled")
    expect(workspaceSlug(undefined)).toBe("untitled")
    expect(workspaceSlug("..")).toBe("untitled")
    expect(workspaceSlug("-.")).toBe("untitled")
    expect(workspaceSlug("x".repeat(200)).length).toBeLessThanOrEqual(48)
  })

  test("dayFolder renders local yyyy-mm-dd with zero padding", () => {
    expect(dayFolder(new Date(2026, 8, 5).getTime())).toBe("2026-09-05")
    expect(dayFolder(new Date(2026, 0, 2).getTime())).toBe("2026-01-02")
  })

  test("sessionFolderName = <sessionId>-<title-slug>", () => {
    expect(sessionFolderName("ses_01ABC", "Add oauth flow")).toBe("ses_01ABC-Add-oauth-flow")
    expect(sessionFolderName("ses_01ABC", "")).toBe("ses_01ABC-untitled")
  })

  test("renderSessionMeta carries id/title/project metadata", () => {
    const md = renderSessionMeta({ id: "ses_1", title: "T", directory: "/p", created: 0 }, "2026-09-05T10:00:00+08:00")
    expect(md).toContain("ses_1")
    expect(md).toContain("/p")
    expect(md).toContain("Safe to gitignore")
  })
})

describe("workspace: WorkspaceTracker folder lifecycle", () => {
  test("ensure returns null for unknown/disabled sessions and creates nothing", () => {
    const dir = sandboxProject()
    const t = tracker(dir)
    expect(t.ensure("ses_unknown")).toBeNull()
    const off = tracker(dir, false)
    off.record({ id: "ses_1", title: "x", directory: dir })
    expect(off.ensure("ses_1")).toBeNull()
    expect(existsSync(join(dir, DEFAULT_WORKSPACE_DIRNAME))).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  test("record + ensure creates the dated session folder with SESSION.md; second ensure is idempotent", () => {
    const dir = sandboxProject()
    const t = tracker(dir)
    t.record({ id: "ses_1", title: "Add oauth", directory: dir, created: new Date(2026, 8, 5, 11).getTime() })
    const first = t.ensure("ses_1")
    expect(first?.created).toBe(true)
    expect(first?.rel).toBe(".switchman/2026-09-05/ses_1-Add-oauth")
    expect(existsSync(join(first!.abs, "SESSION.md"))).toBe(true)
    expect(readFileSync(join(first!.abs, "SESSION.md"), "utf8")).toContain("ses_1")
    const second = t.ensure("ses_1")
    expect(second?.created).toBe(false)
    expect(second?.renamed).toBeNull()
    expect(second?.abs).toBe(first!.abs)
    rmSync(dir, { recursive: true, force: true })
  })

  test("title arriving later renames the folder (event-driven incremental record)", () => {
    const dir = sandboxProject()
    const t = tracker(dir)
    const created = new Date(2026, 8, 5, 9).getTime()
    t.record({ id: "ses_1", title: "", directory: dir, created })
    const untitled = t.ensure("ses_1")
    expect(untitled?.rel).toContain("ses_1-untitled")
    // session.created gives no title; session.updated delivers it afterwards
    t.record({ id: "ses_1", title: "Real Title" })
    const renamed = t.ensure("ses_1")
    expect(renamed?.renamed).toBe("ses_1-untitled")
    expect(renamed?.rel).toBe(".switchman/2026-09-05/ses_1-Real-Title")
    expect(existsSync(untitled!.abs)).toBe(false)
    expect(existsSync(renamed!.abs)).toBe(true)
    expect(readFileSync(join(renamed!.abs, "SESSION.md"), "utf8")).toContain("Real Title")
    rmSync(dir, { recursive: true, force: true })
  })

  test("custom dirname is honored; fallback directory used when the event carries none", () => {
    const dir = sandboxProject()
    const t = tracker(dir, true, "artifacts")
    t.record({ id: "ses_9", title: "x", created: new Date(2026, 8, 5).getTime() }) // no directory → fallback
    const ws = t.ensure("ses_9")
    expect(ws?.rel).toBe(`artifacts/2026-09-05/ses_9-x`)
    expect(ws!.abs.startsWith(join(dir, "fallback"))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  test("traceDispatch appends one JSONL line per delegation; unknown session = no-op", () => {
    const dir = sandboxProject()
    const t = tracker(dir)
    t.record({ id: "ses_1", title: "T", directory: dir, created: new Date(2026, 8, 5).getTime() })
    t.traceDispatch("ses_1", { ts: "2026-09-05T10:00:00+08:00", session: "ses_1", shell: "glm-mx-53f-low", lane: "economy", role: "scouter", source: "auto", redirected: true })
    t.traceDispatch("ses_1", { ts: "2026-09-05T10:01:00+08:00", session: "ses_1", shell: "ds-mx-v4p-high" })
    t.traceDispatch("ses_other", { ts: "x", session: "ses_other", shell: "nope" })
    const lines = readFileSync(join(t.ensure("ses_1")!.abs, "dispatches.jsonl"), "utf8").trim().split("\n")
    expect(lines.length).toBe(2)
    const first = JSON.parse(lines[0]!)
    expect(first.shell).toBe("glm-mx-53f-low")
    expect(first.role).toBe("scouter")
    expect(first.redirected).toBe(true)
    expect(JSON.parse(lines[1]!).lane).toBeUndefined()
    rmSync(dir, { recursive: true, force: true })
  })

  test("forget drops the in-memory entry (ensure → null again)", () => {
    const dir = sandboxProject()
    const t = tracker(dir)
    t.record({ id: "ses_1", title: "T", directory: dir })
    expect(t.ensure("ses_1")).not.toBeNull()
    t.forget("ses_1")
    expect(t.ensure("ses_1")).toBeNull()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("workspace: config surface", () => {
  const configOf = (over: Record<string, unknown> = {}) => ({ version: 1, providers: defaultProviderConfig(), ...over })

  test("defaults: enabled + .switchman; generated template carries the section and validates", () => {
    const v = validateUserConfig(configOf())
    expect(v.config.workspace).toEqual({ enabled: true, dirname: ".switchman" })
    expect(v.diagnostics.filter((d) => d.path?.startsWith("workspace"))).toEqual([])
    const body = renderDefaultConfigJsonc()
    expect(body).toContain('"workspace"')
    expect(body).toContain('".switchman"')
    const parsed = parseJsonc(body)
    expect("value" in parsed).toBe(true)
    if ("value" in parsed) {
      const checked = validateUserConfig(parsed.value)
      expect(checked.diagnostics.filter((d) => d.level === "error")).toEqual([])
      expect(checked.config.workspace.enabled).toBe(true)
    }
  })

  test("bad values fall back with SWM037 (enabled non-boolean; dirname with separators / dots / empty)", () => {
    for (const dirname of ["../evil", "a/b", "a\\b", "", "  ", ".", ".."]) {
      const v = validateUserConfig(configOf({ workspace: { enabled: true, dirname } }))
      expect(v.config.workspace.dirname).toBe(".switchman")
      expect(v.diagnostics.some((d) => d.code === "SWM037" && d.path === "workspace.dirname")).toBe(true)
    }
    const v2 = validateUserConfig(configOf({ workspace: { enabled: "yes" as unknown as boolean, dirname: ".switchman" } }))
    expect(v2.config.workspace.enabled).toBe(true)
    expect(v2.diagnostics.some((d) => d.code === "SWM037" && d.path === "workspace.enabled")).toBe(true)
  })

  test("resolveEffectiveOptions: jsonc baseline, tuple override wins, legacy section inventoried", () => {
    const cfg = validateUserConfig(configOf({ workspace: { enabled: false, dirname: "wsdocs" } })).config
    const none = resolveEffectiveOptions(undefined, cfg)
    expect(none.options.workspace).toEqual({ enabled: false, dirname: "wsdocs" })
    expect(none.legacySections).not.toContain("workspace")
    const over = resolveEffectiveOptions({ workspace: { enabled: true } } as any, cfg)
    expect(over.options.workspace).toEqual({ enabled: true, dirname: "wsdocs" })
    expect(over.legacySections).toContain("workspace")
  })
})
