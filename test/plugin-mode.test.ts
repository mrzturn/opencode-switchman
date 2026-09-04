// [2026-09-04]-[English localization: translate titles/comments; no logic change]
import { describe, expect, test } from "bun:test"
import { commentFileRefs, recommaPluginArray, switchSchemaRef, switchToLocal } from "../scripts/plugin-mode.ts"
import { rewriteSpec } from "../scripts/update-cli.mjs"

const FILE = "file:///repo/opencode-switchman"

describe("plugin-mode switchToLocal", () => {
  test("real shape: active exact-version entry commented out + commented file:// line activated, commas legal", () => {
    const before = `{\n  "plugin": [\n    "opencode-switchman@0.2.1"\n    // "file:///repo/opencode-switchman"\n  ],\n  "lsp": true\n}\n`
    const r = switchToLocal(before, FILE)
    expect(r.action).toBe("switched")
    expect(r.text).toContain('    // "opencode-switchman@0.2.1"')
    expect(r.text).toContain(`    "${FILE}"`)
    expect(r.text).toContain('"lsp": true')
    // exactly one active entry and it is the file:// one
    const active = r.text.split("\n").filter((l) => l.trim().startsWith('"') && (l.includes("opencode-switchman") || l.includes("file://")))
    expect(active).toEqual([`    "${FILE}"`])
  })

  test("after switching, can switch back to prod (commentFileRefs + rewriteSpec), the commented file:// line is kept", () => {
    const local = switchToLocal(`{\n  "plugin": [\n    "opencode-switchman@0.2.1"\n    // "file:///repo/opencode-switchman"\n  ]\n}`, FILE).text
    const cf = commentFileRefs(local)
    expect(cf.changed).toBe(true)
    const back = rewriteSpec(cf.text, "opencode-switchman@0.2.1")
    expect(back.action).toBe("uncommented")
    // the package-name entry is the only active one (the commented file:// line takes no comma) → no comma needed; uncommented's eaten indentation is normalized by recomma
    const rc = recommaPluginArray(back.text)
    expect(rc.changed).toBe(true)
    expect(rc.text).toContain('    "opencode-switchman@0.2.1"')
    expect(rc.text).not.toContain('"opencode-switchman@0.2.1",')
    expect(rc.text).toContain(`// "${FILE}"`)
  })

  test("idempotent: a second run is a noop and the text is byte-identical", () => {
    const before = `{\n  "plugin": [\n    // "opencode-switchman@0.2.1"\n    "${FILE}"\n  ]\n}\n`
    const r = switchToLocal(before, FILE)
    expect(r.action).toBe("noop")
    expect(r.text).toBe(before)
  })

  test("comma recomputation between active entries: switching back to prod requires a trailing comma on the package-name entry", () => {
    const local = switchToLocal(`{\n  "plugin": [\n    "opencode-switchman@0.2.1"\n    // "${FILE}"\n    "other-plugin@1.0.0"\n  ]\n}\n`, FILE).text
    // local state: file:// and other are active, the file:// line should have a comma
    expect(local).toContain(`"${FILE}",`)
    expect(local).toContain('"other-plugin@1.0.0"')
    const cf = commentFileRefs(local)
    expect(cf.changed).toBe(true)
    const back = rewriteSpec(cf.text, "opencode-switchman@0.2.1")
    // followed by an active third-party entry → recomma adds the trailing comma (rewriteSpec uncommented does not manage commas itself)
    const rc = recommaPluginArray(back.text)
    expect(rc.changed).toBe(true)
    expect(rc.text).toContain('"opencode-switchman@0.2.1",')
    expect(rc.text).toContain(`// "${FILE}"`)
  })

  test("tui inline array expanded to multiple lines, third-party entries stay active, commas legal", () => {
    const before = `{\n  "$schema": "https://opencode.ai/tui.json",\n  "plugin": ["opencode-switchman@0.2.1", "other-tui@2.0"]\n}\n`
    const r = switchToLocal(before, FILE)
    expect(r.action).toBe("switched")
    expect(r.text).toContain(`    "${FILE}",`) // followed by an active third-party entry → trailing comma
    expect(r.text).toContain('    "other-tui@2.0"') // last active entry → no comma
    expect(r.text).toContain('// "opencode-switchman@0.2.1"')
    expect(r.text).toContain('"$schema": "https://opencode.ai/tui.json",')
    // idempotent round trip
    expect(switchToLocal(r.text, FILE).action).toBe("noop")
  })

  test("empty plugin array gets the target inserted; no plugin array reports unparseable without rewriting", () => {
    const empty = switchToLocal('{\n  "plugin": []\n}', FILE)
    expect(empty.action).toBe("switched")
    expect(empty.text).toContain(`"${FILE}"`)
    const weird = "just text"
    expect(switchToLocal(weird, FILE)).toMatchObject({ action: "unparseable", text: weird })
  })

  test("third-party file:// and third-party package entries untouched", () => {
    const before = `{\n  "plugin": [\n    "opencode-switchman@0.2.1",\n    "file:///elsewhere/other-repo",\n    "another@1.2.3"\n  ]\n}\n`
    const r = switchToLocal(before, FILE)
    expect(r.text).toContain('"file:///elsewhere/other-repo",')
    expect(r.text).toContain('"another@1.2.3"')
    expect(r.text).toContain('// "opencode-switchman@0.2.1",')
    expect(r.text).toContain(`"${FILE}",`)
  })

  test("nested tuple entries commented out as a whole (not split by commas); cross-line tuples defensively report unparseable", () => {
    const tuple = `{\n  "plugin": [["opencode-switchman", { "options": true }], "other@1.0"]\n}\n`
    const r = switchToLocal(tuple, FILE)
    expect(r.text).toContain('// ["opencode-switchman", { "options": true }]')
    expect(r.text).toContain('"other@1.0"')
    expect(r.text).toContain(`"${FILE}"`)
    const multiline = `{\n  "plugin": [\n    ["opencode-switchman",\n    {\n      "options": true\n    }]\n  ]\n}\n`
    expect(switchToLocal(multiline, FILE).action).toBe("unparseable")
  })
})

describe("plugin-mode recommaPluginArray", () => {
  test("missing comma after rewriteSpec uncommented followed by a third-party entry gets added; already legal text unchanged", () => {
    const bad = `{\n  "plugin": [\n    "opencode-switchman@0.2.1"\n    "other@1.0.0"\n  ]\n}\n`
    expect(recommaPluginArray(bad).text).toContain('"opencode-switchman@0.2.1",')
    expect(recommaPluginArray(bad).changed).toBe(true)
    const good = `{\n  "plugin": [\n    "opencode-switchman@0.2.1",\n    "other@1.0.0"\n  ]\n}\n`
    expect(recommaPluginArray(good)).toMatchObject({ changed: false, text: good })
  })
})

describe("plugin-mode commentFileRefs", () => {
  test("only active file:// lines of this package get commented; already commented lines and other plugins' file:// untouched", () => {
    const before = `{\n  "plugin": [\n    "${FILE}",\n    "file:///elsewhere/other"\n    // "${FILE}"\n  ]\n}\n`
    const r = commentFileRefs(before)
    expect(r.changed).toBe(true)
    expect(r.text).toContain(`    // "${FILE}",`)
    expect(r.text).toContain('"file:///elsewhere/other"')
    expect(commentFileRefs(r.text).changed).toBe(false)
  })
})

describe("plugin-mode switchSchemaRef", () => {
  const LOCAL_SCHEMA = "file:///repo/schema/opencode-switchman-v1.schema.json"
  const REMOTE_SCHEMA = "https://raw.githubusercontent.com/mrzturn/opencode-switchman/main/schema/opencode-switchman-v1.schema.json"

  test("remote↔local idempotent switching, other $schema lines untouched", () => {
    const before = `{\n  // comment\n  "$schema": "${REMOTE_SCHEMA}",\n  "version": 1\n}\n`
    const toLocal = switchSchemaRef(before, LOCAL_SCHEMA)
    expect(toLocal.changed).toBe(true)
    expect(toLocal.text).toContain(`"$schema": "${LOCAL_SCHEMA}"`)
    expect(switchSchemaRef(toLocal.text, LOCAL_SCHEMA).changed).toBe(false)
    const back = switchSchemaRef(toLocal.text, REMOTE_SCHEMA)
    expect(back.text).toBe(before)
    // non-this-plugin schema (opencode main config) untouched
    const other = `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`
    expect(switchSchemaRef(other, LOCAL_SCHEMA)).toMatchObject({ changed: false, text: other })
  })
})
