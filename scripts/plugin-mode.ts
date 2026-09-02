// 一键切换 opencode 插件加载源：本地仓库（file://，吃 dist 构建产物）⇄ npm 正式版（精确版本条目）
// 用法：bun scripts/plugin-mode.ts local|prod [--version x.y.z]；切换后需重启 opencode 生效
// 同步维护三处配置：opencode.jsonc / tui.jsonc 的 plugin 条目 + opencode-switchman.jsonc 的 $schema
// [2026-08-29]-[opencode.json 为 JSONC 带注释，做行级手术保留其余内容；幂等可重复执行]-
// [2026-08-31]-[tui.jsonc 的 plugin 数组独立维护（server/TUI 两套注册列表），缺失即补建]-
// [2026-09-02]-[重写：旧版正则只认裸包名条目，对 update-cli 引入的精确版本条目
//  （opencode-switchman@x.y.z）失明——mode:local 会产生双激活条目且破坏 JSON 逗号，mode:prod 无法
//  升级到 npm 最新版；改为 plugin 数组块重写器（注释/激活/插入 + 活跃条目逗号重算），prod 复用
//  update-cli 的 latestVersion/rewriteSpec/pruneCaches，主配置 $schema 跟随模式切换，仓库根自动推导]-
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { cachePackagesDirOf, configDirOf, latestVersion, pruneCaches, rewriteSpec, stateDirOf } from "./update-cli.mjs"

export const PKG = "opencode-switchman"
export const SCHEMA_FILE = "opencode-switchman-v1.schema.json"
const REMOTE_SCHEMA = `https://raw.githubusercontent.com/mrzturn/opencode-switchman/main/schema/${SCHEMA_FILE}`

/** 仓库根（realpath 防 macOS /var→/private/var 符号链接，同 update-cli 入口判定口径） */
export function repoRootOf(): string {
  return realpathSync(join(import.meta.dir, ".."))
}

export function schemaUrlOf(mode: "local" | "prod", root = repoRootOf()): string {
  return mode === "local" ? pathToFileURL(join(root, "schema", SCHEMA_FILE)).href : REMOTE_SCHEMA
}

/**
 * 主配置 $schema 幂等切换：仅替换指向本插件 schema 的值，其他 $schema 行不动。
 */
export function switchSchemaRef(text: string, schemaUrl: string): { text: string; changed: boolean } {
  const re = new RegExp(`("\\$schema"\\s*:\\s*")([^"]*${SCHEMA_FILE})(")`)
  if (!re.test(text) || re.exec(text)![2] === schemaUrl) return { text, changed: false }
  return { text: text.replace(re, `$1${schemaUrl}$3`), changed: true }
}

type BodyLine = { line: string; kind: "active" | "comment" | "blank" }

type PluginBlock = { lines: string[]; pluginIdx: number; closeIdx: number; closeInline: number; indent: string; body: BodyLine[] } | null

/** 内联数组内容按顶层逗号切分（字符串感知；顶层数组开括号不入碎片；元组/嵌套条目整块保留） */
function splitInline(arr: string): string[] {
  const frags: string[] = []
  let depth = 0
  let inStr = false
  let cur = ""
  for (const c of arr) {
    if (inStr) {
      cur += c
      if (c === '"') inStr = false
      continue
    }
    if (c === '"') {
      inStr = true
      cur += c
      continue
    }
    if (c === "[") {
      depth++
      if (depth > 1) cur += c
      continue
    }
    if (c === "]") {
      depth--
      if (depth === 0) break
      cur += c
      continue
    }
    if (c === "{") depth++
    else if (c === "}") depth--
    else if (c === "," && depth === 1) {
      if (cur.trim()) frags.push(cur.trim())
      cur = ""
      continue
    }
    cur += c
  }
  if (cur.trim()) frags.push(cur.trim())
  return frags
}

/** 定位 plugin 数组块；内联数组展开为逐条目行 */
function parsePluginBlock(text: string): PluginBlock {
  const lines = text.split("\n")
  const pluginIdx = lines.findIndex((l) => /"plugin"\s*:\s*\[/.test(l))
  if (pluginIdx < 0) return null
  const pluginLine = lines[pluginIdx]
  const open = pluginLine.indexOf("[")
  const closeInline = pluginLine.indexOf("]", open)
  const indent = pluginLine.match(/^\s*/)?.[0] ?? ""

  let bodyLines: string[]
  let closeIdx: number
  if (closeInline >= 0) {
    closeIdx = pluginIdx
    const entries = splitInline(lines[pluginIdx].slice(open, closeInline + 1))
    bodyLines = entries.map((e) => `${indent}  ${e}`)
  } else {
    closeIdx = pluginIdx + 1 + lines.slice(pluginIdx + 1).findIndex((l) => l.trim().startsWith("]"))
    if (closeIdx <= pluginIdx) return null
    bodyLines = lines.slice(pluginIdx + 1, closeIdx)
  }
  const body: BodyLine[] = bodyLines.map((line) => {
    const t = line.trim()
    return { line, kind: t === "" ? "blank" : t.startsWith("//") ? "comment" : "active" }
  })
  return { lines, pluginIdx, closeIdx, closeInline, indent, body }
}

/** 重组配置文本；内联态展开为「plugin 开行 + 数组体 + 收缩闭合行」，多行态保留原开行与闭合行起 */
function assembleBlock(b: NonNullable<PluginBlock>, rebuilt: string[]): string {
  const prefix = b.lines.slice(0, b.pluginIdx)
  const pluginLine = b.lines[b.pluginIdx]
  if (b.closeInline >= 0) {
    const openCol = pluginLine.indexOf("[")
    const closeCol = pluginLine.indexOf("]", openCol)
    return [
      ...prefix,
      pluginLine.slice(0, openCol + 1),
      ...rebuilt,
      `${b.indent}]${pluginLine.slice(closeCol + 1)}`,
      ...b.lines.slice(b.pluginIdx + 1),
    ].join("\n")
  }
  return [...prefix, pluginLine, ...rebuilt, ...b.lines.slice(b.closeIdx)].join("\n")
}

/**
 * plugin 数组块逗号重算：活跃条目行后随活跃条目 → 尾逗号，否则无（注释行不参与）。
 * update-cli rewriteSpec 的 uncommented/replaced 不处理条目间逗号，本函数作为两条链路的统一收口。
 */
export function recommaPluginArray(text: string): { text: string; changed: boolean } {
  const b = parsePluginBlock(text)
  if (!b) return { text, changed: false }
  const actives = b.body.map((l, i) => (l.kind === "active" ? i : -1)).filter((i) => i >= 0)
  // 活跃条目统一缩进（update-cli uncommented 会吃掉注释行缩进）+ 逗号重算
  const stdIndent = `${b.indent}  `
  const rebuilt = b.body.map((l, i) => {
    if (l.kind !== "active") return l.line
    const stripped = `${stdIndent}${l.line.replace(/,(\s*)$/, "$1").trim()}`
    return actives.some((j) => j > i) ? `${stripped},` : stripped
  })
  const result = assembleBlock(b, rebuilt)
  return { text: result, changed: result !== text }
}

/**
 * 把 plugin 数组块切到本地 file:// 源：包名条目（含 @版本）注释化，file:// 条目激活（无则插入首元素）。
 * 行级手术保留注释与第三方条目；活跃条目逗号重算，保证 JSONC 合法。
 * 返回 { text, action }；action ∈ switched|noop|unparseable。
 * 限制：多行元组条目（["pkg", {...}] 跨行）不支持，报 unparseable 不改写。
 */
export function switchToLocal(text: string, fileSpec: string, pkg = PKG): { text: string; action: string } {
  const b = parsePluginBlock(text)
  if (!b) return { text, action: "unparseable" }
  const pkgRe = new RegExp(`"${pkg}(@[^"]*)?"`)
  // 多行元组/嵌套结构防御：活跃行的开括号未在本行闭合 → 放弃手术（单行元组已由 parsePluginBlock 合并）
  for (const l of b.body) {
    if (l.kind !== "active") continue
    const t = l.line.trim()
    if ((t.match(/[[{]/g) ?? []).length > (t.match(/[\]}]/g) ?? []).length) return { text, action: "unparseable" }
  }

  // 活跃包名条目（含 @版本）→ 注释化；注释态本仓库 file:// 行 → 激活；目标未就位 → 插入首元素
  const out: BodyLine[] = b.body.map((l) => {
    if (l.kind === "active" && pkgRe.test(l.line) && !l.line.includes("file://"))
      return { line: l.line.replace(/^(\s*)/, "$1// "), kind: "comment" }
    if (l.kind === "comment" && l.line.includes(fileSpec))
      return { line: l.line.replace(/^(\s*)\/\/\s?/, "$1"), kind: "active" }
    return l
  })
  if (!out.some((l) => l.kind === "active" && l.line.includes(fileSpec)))
    out.unshift({ line: `${b.indent}  "${fileSpec}"`, kind: "active" })

  const actives = out.map((l, i) => (l.kind === "active" ? i : -1)).filter((i) => i >= 0)
  const stdIndent = `${b.indent}  `
  const rebuilt = out.map((l, i) => {
    if (l.kind !== "active") return l.line
    const stripped = `${stdIndent}${l.line.replace(/,(\s*)$/, "$1").trim()}`
    return actives.some((j) => j > i) ? `${stripped},` : stripped
  })
  const result = assembleBlock(b, rebuilt)
  return { text: result, action: result === text ? "noop" : "switched" }
}

/** 把激活的本包 file:// 条目注释化（prod 前置步骤；其他第三方 file:// 不动，同 update-cli 匹配口径） */
export function commentFileRefs(text: string, pkg = PKG): { text: string; changed: boolean } {
  const re = new RegExp(`^(\\s*)("file://[^"]*${pkg}[^"]*")(,?)\\s*$`)
  let changed = false
  const out = text.split("\n").map((l) => {
    if (changed || !re.test(l) || l.trim().startsWith("//")) return l
    changed = true
    return l.replace(re, "$1// $2$3")
  })
  return { text: out.join("\n"), changed }
}

function firstExisting(dir: string, names: string[]): string | null {
  for (const name of names) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return null
}

/**
 * 执行模式切换：opencode/tui 配置 plugin 条目 + 主配置 $schema。
 * local：build 由 package.json 脚本先行；prod：拉 npm latest（或 --version）+ 清缓存 + upgraded.flag。
 */
export async function run(argv = process.argv.slice(2), io: { env?: NodeJS.ProcessEnv; home?: string; log?: (m: string) => void; fetch?: typeof fetch } = {}) {
  const env = io.env ?? process.env
  const home = io.home ?? homedir()
  const log = io.log ?? ((m: string) => console.log(m))
  const mode = argv[0]
  if (mode !== "local" && mode !== "prod") throw new Error("用法: bun scripts/plugin-mode.ts local|prod [--version x.y.z]")

  const root = repoRootOf()
  const fileSpec = pathToFileURL(root).href
  const cfgDir = configDirOf(env, home)
  const mainPath = firstExisting(cfgDir, ["opencode.jsonc", "opencode.json"])
  if (!mainPath) throw new Error(`未找到 ${join(cfgDir, "opencode.jsonc")}|opencode.json`)
  const tuiPath = firstExisting(cfgDir, ["tui.jsonc", "tui.json"]) ?? join(cfgDir, "tui.jsonc")
  const targets = [
    { path: mainPath, text: readFileSync(mainPath, "utf8") },
    { path: tuiPath, text: existsSync(tuiPath) ? readFileSync(tuiPath, "utf8") : '{\n  "$schema": "https://opencode.ai/tui.json",\n  "plugin": []\n}\n' },
  ]

  let spec: string
  if (mode === "prod") {
    const vi = argv.indexOf("--version")
    const version = vi >= 0 ? String(argv[vi + 1] ?? "") : await latestVersion(io.fetch ?? globalThis.fetch)
    if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`无效版本号: ${version}`)
    spec = `${PKG}@${version}`
  } else {
    spec = fileSpec
  }

  for (const t of targets) {
    let text = t.text
    let action: string
    if (mode === "local") {
      ;({ text, action } = switchToLocal(text, fileSpec))
    } else {
      const cf = commentFileRefs(text)
      const r = rewriteSpec(cf.text, spec)
      if (r.action === "unparseable") throw new Error(`${t.path} 中无法定位 plugin 数组，请手动编辑后重试`)
      const rc = recommaPluginArray(r.text) // rewriteSpec 不处理条目间逗号（如 uncommented 后随第三方条目）
      text = rc.text
      action = cf.changed || r.action !== "noop" || rc.changed ? "switched" : "noop"
    }
    if (action === "unparseable") throw new Error(`${t.path} 中无法定位 plugin 数组（或含不支持的跨行条目），请手动编辑后重试`)
    if (action === "noop") log(`[plugin-mode] ${t.path} 已是 ${mode}，无变更`)
    else {
      mkdirSync(cfgDir, { recursive: true })
      writeFileSync(t.path, text)
      log(`[plugin-mode] 已切换 ${t.path} → ${spec}`)
    }
    const active = text.split("\n").filter((l) => {
      const s = l.trim()
      return s.startsWith('"') && (s.includes(PKG) || s.includes("file://"))
    })
    if (active.length > 1) log(`[plugin-mode] 警告: ${t.path} 存在多个激活条目，同名插件会双载: ${active.join(" | ")}`)
  }

  // 主配置 $schema 跟随模式（行为字段与版本无关，不动）
  const mainCfgPath = join(cfgDir, "opencode-switchman.jsonc")
  if (existsSync(mainCfgPath)) {
    const r = switchSchemaRef(readFileSync(mainCfgPath, "utf8"), schemaUrlOf(mode, root))
    if (r.changed) {
      writeFileSync(mainCfgPath, r.text)
      log(`[plugin-mode] 已切换 ${mainCfgPath} $schema → ${mode === "local" ? "本地仓库" : "GitHub main"}`)
    }
  } else {
    log(`[plugin-mode] 跳过主配置 $schema：${mainCfgPath} 不存在`)
  }

  if (mode === "prod") {
    const pruned = pruneCaches(cachePackagesDirOf(env, home))
    if (pruned.length > 0) log(`[plugin-mode] 已清理 opencode 插件缓存: ${pruned.join("、")}`)
    const stDir = stateDirOf(env, home)
    mkdirSync(stDir, { recursive: true })
    writeFileSync(join(stDir, "upgraded.flag"), "")
  } else {
    log("[plugin-mode] 本地模式（记得先 bun run build 保证 dist 新鲜；bun run mode:local 已自动构建）")
  }
  log(`[plugin-mode] 完成（${spec}）。重启 opencode（app 退出重开 / tui 重进）后生效。`)
  return { mode, spec }
}

// 入口判定同 update-cli：对 argv[1] 取 realpath 比对（防 macOS 符号链接导致 import 误触发执行）
try {
  if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(join(import.meta.dir, "plugin-mode.ts"))) {
    run().catch((exc) => {
      console.error(`[plugin-mode] 切换失败: ${exc?.message ?? exc}`)
      process.exit(1)
    })
  }
} catch {}
