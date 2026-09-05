// [2026-09-05]-[behavioral contract for bundled-skill materialization: content-compare copy, marker-gated cleanup, fail-open]
import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultSkillSyncIo, SKILL_MARKER, syncBundledSkills } from "../src/skill-sync"
import type { SkillSyncIo } from "../src/skill-sync"

function makeSrc(): string {
  const base = mkdtempSync(join(tmpdir(), "sw-skills-src-"))
  // Skill "a": nested file tree; skill "b": single file
  mkdirSync(join(base, "a", "references"), { recursive: true })
  mkdirSync(join(base, "b"), { recursive: true })
  writeFileSync(join(base, "a", "SKILL.md"), "a v1")
  writeFileSync(join(base, "a", "references", "guide.md"), "guide v1")
  writeFileSync(join(base, "b", "SKILL.md"), "b v1")
  return base
}

function makeTarget(): string {
  // Deliberately nonexistent: sync must create the whole chain (fresh-machine install)
  return join(mkdtempSync(join(tmpdir(), "sw-skills-dst-")), "opencode", "skills")
}

/** Capture stderr lines while keeping the real fs (dirs injected per test). */
function ioWith(src: string, target: string): { io: SkillSyncIo; errors: string[] } {
  const errors: string[] = []
  const io = defaultSkillSyncIo(src, target)
  return { io: { ...io, stderr: (line) => errors.push(line) }, errors }
}

describe("Bundled skill sync", () => {
  test("fresh install copies nested files and writes the plugin marker", () => {
    const { io } = ioWith(makeSrc(), makeTarget())
    const s = syncBundledSkills(io)
    expect(s.installed.sort()).toEqual(["a", "b"])
    expect(s.updated).toEqual([])
    expect(s.removed).toEqual([])
    expect(readFileSync(join(io.targetRoot, "a", "SKILL.md"), "utf8")).toBe("a v1")
    expect(readFileSync(join(io.targetRoot, "a", "references", "guide.md"), "utf8")).toBe("guide v1")
    expect(readFileSync(join(io.targetRoot, "b", "SKILL.md"), "utf8")).toBe("b v1")
    expect(existsSync(join(io.targetRoot, "a", SKILL_MARKER))).toBe(true)
    expect(existsSync(join(io.targetRoot, "b", SKILL_MARKER))).toBe(true)
  })

  test("changed source content is overwritten; identical skills stay out of the summary", () => {
    const src = makeSrc()
    const { io } = ioWith(src, makeTarget())
    syncBundledSkills(io)
    writeFileSync(join(src, "a", "SKILL.md"), "a v2")
    writeFileSync(join(src, "a", "references", "guide.md"), "guide v2")
    const s = syncBundledSkills(io)
    expect(s.installed).toEqual([])
    expect(s.updated).toEqual(["a"])
    expect(readFileSync(join(io.targetRoot, "a", "SKILL.md"), "utf8")).toBe("a v2")
    expect(readFileSync(join(io.targetRoot, "a", "references", "guide.md"), "utf8")).toBe("guide v2")
  })

  test("identical content is left untouched (mtime preserved on steady-state re-sync)", () => {
    const src = makeSrc()
    const { io } = ioWith(src, makeTarget())
    syncBundledSkills(io)
    const targetFile = join(io.targetRoot, "a", "SKILL.md")
    const old = new Date(Date.now() - 3_600_000)
    utimesSync(targetFile, old, old)
    const s = syncBundledSkills(io)
    expect(s.updated).toEqual([])
    expect(s.installed).toEqual([])
    expect(statSync(targetFile).mtimeMs).toBe(old.getTime())
  })

  test("marker-gated cleanup removes stale managed skills", () => {
    const src = makeSrc()
    const { io } = ioWith(src, makeTarget())
    syncBundledSkills(io)
    // A skill the plugin installed earlier but no longer bundles
    mkdirSync(join(io.targetRoot, "legacy"), { recursive: true })
    writeFileSync(join(io.targetRoot, "legacy", "SKILL.md"), "legacy")
    writeFileSync(join(io.targetRoot, "legacy", SKILL_MARKER), "")
    const s = syncBundledSkills(io)
    expect(s.removed).toEqual(["legacy"])
    expect(existsSync(join(io.targetRoot, "legacy"))).toBe(false)
  })

  test("directories without the plugin marker are never touched", () => {
    const src = makeSrc()
    const { io } = ioWith(src, makeTarget())
    syncBundledSkills(io)
    mkdirSync(join(io.targetRoot, "user-own-skill"), { recursive: true })
    writeFileSync(join(io.targetRoot, "user-own-skill", "SKILL.md"), "mine")
    const s = syncBundledSkills(io)
    expect(s.removed).toEqual([])
    expect(readFileSync(join(io.targetRoot, "user-own-skill", "SKILL.md"), "utf8")).toBe("mine")
  })

  test("extra files inside a managed dir (node_modules-like) are never removed", () => {
    const src = makeSrc()
    const { io } = ioWith(src, makeTarget())
    syncBundledSkills(io)
    // db-query installs runtime deps into its own dir after the plugin synced it
    mkdirSync(join(io.targetRoot, "a", "node_modules", "pkg"), { recursive: true })
    writeFileSync(join(io.targetRoot, "a", "node_modules", "pkg", "index.js"), "dep")
    writeFileSync(join(io.targetRoot, "a", "untracked.txt"), "user notes")
    const s = syncBundledSkills(io)
    expect(s.updated).toEqual([]) // extra files don't count as content drift
    expect(existsSync(join(io.targetRoot, "a", "node_modules", "pkg", "index.js"))).toBe(true)
    expect(existsSync(join(io.targetRoot, "a", "untracked.txt"))).toBe(true)
  })

  test("fail-open: unreadable source root reports to stderr and never throws", () => {
    const base = mkdtempSync(join(tmpdir(), "sw-skills-fail-"))
    try {
      const { io, errors } = ioWith(join(base, "missing-src"), join(base, "skills"))
      const s = syncBundledSkills(io)
      expect(s.installed).toEqual([])
      expect(s.updated).toEqual([])
      expect(s.removed).toEqual([])
      expect(errors.length).toBeGreaterThan(0)
      expect(errors[0]).toContain("fail-open")
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})
