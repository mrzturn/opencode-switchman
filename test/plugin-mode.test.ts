import { describe, expect, test } from "bun:test"
import { commentFileRefs, recommaPluginArray, switchSchemaRef, switchToLocal } from "../scripts/plugin-mode.ts"
import { rewriteSpec } from "../scripts/update-cli.mjs"

const FILE = "file:///repo/opencode-switchman"

describe("plugin-mode switchToLocal", () => {
  test("真实形态：活跃精确版本条目注释化 + 注释 file:// 行激活，逗号合法", () => {
    const before = `{\n  "plugin": [\n    "opencode-switchman@0.2.1"\n    // "file:///repo/opencode-switchman"\n  ],\n  "lsp": true\n}\n`
    const r = switchToLocal(before, FILE)
    expect(r.action).toBe("switched")
    expect(r.text).toContain('    // "opencode-switchman@0.2.1"')
    expect(r.text).toContain(`    "${FILE}"`)
    expect(r.text).toContain('"lsp": true')
    // 活跃条目唯一且为 file://
    const active = r.text.split("\n").filter((l) => l.trim().startsWith('"') && (l.includes("opencode-switchman") || l.includes("file://")))
    expect(active).toEqual([`    "${FILE}"`])
  })

  test("切换后可切回 prod（commentFileRefs + rewriteSpec），注释 file:// 行保留", () => {
    const local = switchToLocal(`{\n  "plugin": [\n    "opencode-switchman@0.2.1"\n    // "file:///repo/opencode-switchman"\n  ]\n}`, FILE).text
    const cf = commentFileRefs(local)
    expect(cf.changed).toBe(true)
    const back = rewriteSpec(cf.text, "opencode-switchman@0.2.1")
    expect(back.action).toBe("uncommented")
    // 包名条目是唯一活跃条目（注释 file:// 不参与逗号）→ 无需逗号；uncommented 吃掉的缩进由 recomma 规范化
    const rc = recommaPluginArray(back.text)
    expect(rc.changed).toBe(true)
    expect(rc.text).toContain('    "opencode-switchman@0.2.1"')
    expect(rc.text).not.toContain('"opencode-switchman@0.2.1",')
    expect(rc.text).toContain(`// "${FILE}"`)
  })

  test("幂等：二次执行 noop 且文本逐字节一致", () => {
    const before = `{\n  "plugin": [\n    // "opencode-switchman@0.2.1"\n    "${FILE}"\n  ]\n}\n`
    const r = switchToLocal(before, FILE)
    expect(r.action).toBe("noop")
    expect(r.text).toBe(before)
  })

  test("活跃条目间的逗号重算：切回 prod 时包名条目需要尾逗号", () => {
    const local = switchToLocal(`{\n  "plugin": [\n    "opencode-switchman@0.2.1"\n    // "${FILE}"\n    "other-plugin@1.0.0"\n  ]\n}\n`, FILE).text
    // local 态：file:// 与 other 活跃，file:// 行应有逗号
    expect(local).toContain(`"${FILE}",`)
    expect(local).toContain('"other-plugin@1.0.0"')
    const cf = commentFileRefs(local)
    expect(cf.changed).toBe(true)
    const back = rewriteSpec(cf.text, "opencode-switchman@0.2.1")
    // 后随第三方活跃条目 → recomma 补尾逗号（rewriteSpec uncommented 自身不管逗号）
    const rc = recommaPluginArray(back.text)
    expect(rc.changed).toBe(true)
    expect(rc.text).toContain('"opencode-switchman@0.2.1",')
    expect(rc.text).toContain(`// "${FILE}"`)
  })

  test("tui 内联数组展开为多行，第三方条目保持活跃，逗号合法", () => {
    const before = `{\n  "$schema": "https://opencode.ai/tui.json",\n  "plugin": ["opencode-switchman@0.2.1", "other-tui@2.0"]\n}\n`
    const r = switchToLocal(before, FILE)
    expect(r.action).toBe("switched")
    expect(r.text).toContain(`    "${FILE}",`) // 后随第三方活跃条目 → 尾逗号
    expect(r.text).toContain('    "other-tui@2.0"') // 最后活跃条目 → 无逗号
    expect(r.text).toContain('// "opencode-switchman@0.2.1"')
    expect(r.text).toContain('"$schema": "https://opencode.ai/tui.json",')
    // 幂等往返
    expect(switchToLocal(r.text, FILE).action).toBe("noop")
  })

  test("空 plugin 数组插入目标；无 plugin 数组报 unparseable 不改写", () => {
    const empty = switchToLocal('{\n  "plugin": []\n}', FILE)
    expect(empty.action).toBe("switched")
    expect(empty.text).toContain(`"${FILE}"`)
    const weird = "just text"
    expect(switchToLocal(weird, FILE)).toMatchObject({ action: "unparseable", text: weird })
  })

  test("第三方 file:// 与第三方包条目不动", () => {
    const before = `{\n  "plugin": [\n    "opencode-switchman@0.2.1",\n    "file:///elsewhere/other-repo",\n    "another@1.2.3"\n  ]\n}\n`
    const r = switchToLocal(before, FILE)
    expect(r.text).toContain('"file:///elsewhere/other-repo",')
    expect(r.text).toContain('"another@1.2.3"')
    expect(r.text).toContain('// "opencode-switchman@0.2.1",')
    expect(r.text).toContain(`"${FILE}",`)
  })

  test("嵌套元组条目整体注释化（不被逗号拆散），跨行元组防御报 unparseable", () => {
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
  test("rewriteSpec uncommented 后随第三方条目的缺逗号被补上；已合法文本不变", () => {
    const bad = `{\n  "plugin": [\n    "opencode-switchman@0.2.1"\n    "other@1.0.0"\n  ]\n}\n`
    expect(recommaPluginArray(bad).text).toContain('"opencode-switchman@0.2.1",')
    expect(recommaPluginArray(bad).changed).toBe(true)
    const good = `{\n  "plugin": [\n    "opencode-switchman@0.2.1",\n    "other@1.0.0"\n  ]\n}\n`
    expect(recommaPluginArray(good)).toMatchObject({ changed: false, text: good })
  })
})

describe("plugin-mode commentFileRefs", () => {
  test("只注释激活的本包 file:// 行；已注释行与其他插件 file:// 不动", () => {
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

  test("远程↔本地幂等切换，其他 $schema 行不动", () => {
    const before = `{\n  // 注释\n  "$schema": "${REMOTE_SCHEMA}",\n  "version": 1\n}\n`
    const toLocal = switchSchemaRef(before, LOCAL_SCHEMA)
    expect(toLocal.changed).toBe(true)
    expect(toLocal.text).toContain(`"$schema": "${LOCAL_SCHEMA}"`)
    expect(switchSchemaRef(toLocal.text, LOCAL_SCHEMA).changed).toBe(false)
    const back = switchSchemaRef(toLocal.text, REMOTE_SCHEMA)
    expect(back.text).toBe(before)
    // 非本插件 schema（opencode 主配置）不动
    const other = `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`
    expect(switchSchemaRef(other, LOCAL_SCHEMA)).toMatchObject({ changed: false, text: other })
  })
})
