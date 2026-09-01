#!/usr/bin/env node
// opencode-switchman 一键安装/更新器（自包含零依赖；node>=18 或 bun 直接运行）
// [2026-09-01]-[opencode 1.18.x 插件缓存按 spec 目录钉死：裸包名/`@latest` 首次装入后不再查 npm 新版
//  （实测 ~/.cache/opencode/packages/opencode-switchman 恒为旧版）——唯一可靠更新路径＝把 plugin 条目
//  改写为精确版本 opencode-switchman@x.y.z（每版本独立缓存目录）并清理旧缓存目录]-
// 用法：update-cli.mjs [--version x.y.z] [--dry-run]
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

const PKG = "opencode-switchman"
const REGISTRY_LATEST = `https://registry.npmjs.org/${PKG}/latest`

export function configDirOf(env = process.env, home = homedir()) {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode")
}

export function stateDirOf(env = process.env, home = homedir()) {
  return env.SWITCHMAN_STATE || join(home, ".config", "opencode", "opencode-switchman")
}

export function cachePackagesDirOf(env = process.env, home = homedir()) {
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "opencode", "packages")
}

/**
 * 把 opencode/tui 配置（JSONC）里的本插件条目改写为精确版本 spec。
 * 行级手术保留注释与既有内容（同 scripts/plugin-mode.ts 风格）。
 * 返回 { text, action, previous? }；action ∈ replaced|uncommented|inserted|created|noop|file-ref|unparseable。
 */
export function rewriteSpec(text, spec, pkg = PKG) {
  const lines = text.split("\n")
  const specRe = new RegExp(`"(${pkg}(?:@[0-9A-Za-z.+~^*-]+)?)"`)

  // 1) 已有激活条目：原位替换引号内 spec（元组 ["pkg",{...}] 只动第一项）
  const activeIdx = lines.findIndex((l) => specRe.test(l) && !l.trim().startsWith("//"))
  if (activeIdx >= 0) {
    const line = lines[activeIdx]
    if (line.includes("file://")) return { text, action: "file-ref", previous: null }
    const previous = specRe.exec(line)[1]
    if (previous === spec) return { text, action: "noop", previous }
    lines[activeIdx] = line.replace(specRe, `"${spec}"`)
    return { text: lines.join("\n"), action: "replaced", previous }
  }

  // 2) 只有被注释的条目：取消注释并改写（file:// 的注释行不动）
  const commentedIdx = lines.findIndex((l) => !l.includes("file://") && new RegExp(`^\\s*//\\s*"${pkg}`).test(l.trim()))
  if (commentedIdx >= 0) {
    lines[commentedIdx] = lines[commentedIdx].replace(/^\s*\/\//, "").replace(specRe, `"${spec}"`)
    return { text: lines.join("\n"), action: "uncommented", previous: null }
  }

  // 2.5) 激活的 file:// 源码引用（spec 不含引号包裹的裸包名，上面分支探测不到）→ 不改写，交给 mode 脚本管理
  if (lines.some((l) => !l.trim().startsWith("//") && new RegExp(`"file://[^"]*${pkg}`).test(l))) {
    return { text, action: "file-ref", previous: null }
  }

  // 3) 无条目：插入 plugin 数组（首元素带尾逗号＝对任意既有元素都合法）
  const pluginIdx = lines.findIndex((l) => /"plugin"\s*:\s*\[/.test(l))
  if (pluginIdx >= 0) {
    const line = lines[pluginIdx]
    const open = line.indexOf("[")
    const close = line.indexOf("]", open)
    if (close >= 0) {
      // 同行闭合的内联数组："plugin": [] 或 ["a","b"]
      const inner = line.slice(open + 1, close).trim()
      lines[pluginIdx] = inner
        ? line.slice(0, close) + `, "${spec}"` + line.slice(close)
        : line.slice(0, open) + `["${spec}"]` + line.slice(close + 1)
    } else {
      // 多行数组：插入为首元素
      const indent = line.match(/^\s*/)[0]
      lines.splice(pluginIdx + 1, 0, `${indent}  "${spec}",`)
    }
    return { text: lines.join("\n"), action: "inserted", previous: null }
  }

  // 4) 文件为空 → 生成最小配置；文件存在但无法定位 plugin 数组 → 报错不写（绝不覆盖用户配置）
  if (text.trim() === "") {
    return {
      text: `{\n  "$schema": "https://opencode.ai/config.json",\n  "plugin": ["${spec}"]\n}\n`,
      action: "created",
      previous: null,
    }
  }
  const braceIdx = lines.findIndex((l) => l.trim() === "{")
  if (braceIdx >= 0) {
    lines.splice(braceIdx + 1, 0, `  "plugin": ["${spec}"],`)
    return { text: lines.join("\n"), action: "inserted", previous: null }
  }
  return { text, action: "unparseable", previous: null }
}

/** 清理 opencode 插件缓存里本包的全部目录（裸名与 @任意版本）；返回被删目录名 */
export function pruneCaches(packagesDir, pkg = PKG) {
  if (!existsSync(packagesDir)) return []
  const removed = []
  for (const name of readdirSync(packagesDir)) {
    if (name !== pkg && !name.startsWith(`${pkg}@`)) continue
    rmSync(join(packagesDir, name), { recursive: true, force: true })
    removed.push(name)
  }
  return removed
}

/** npm registry 最新版本号；node<18 无 fetch 时回退 curl */
export async function latestVersion(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl === "function") {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), 10_000)
    try {
      const res = await fetchImpl(REGISTRY_LATEST, { signal: ctl.signal })
      if (!res.ok) throw new Error(`npm registry HTTP ${res.status}`)
      const body = await res.json()
      if (typeof body.version === "string" && body.version) return body.version
      throw new Error("npm registry 未返回 version")
    } finally {
      clearTimeout(timer)
    }
  }
  const raw = execFileSync("curl", ["-fsSL", REGISTRY_LATEST], { encoding: "utf8", timeout: 10_000 })
  const hit = /"version"\s*:\s*"([^"]+)"/.exec(raw)
  if (!hit) throw new Error("npm registry 响应不含 version")
  return hit[1]
}

function firstExisting(dir, names) {
  for (const name of names) {
    const p = join(dir, name)
    if (existsSync(p)) return p
  }
  return null
}

/**
 * 执行安装/更新：改写 opencode 与 tui 配置条目 → 清理旧缓存 → 升级场景标记已升级待重启。
 * 返回 { spec, actions }；--dry-run 只打印计划不写盘。
 */
export async function run(argv = process.argv.slice(2), io = {}) {
  const env = io.env ?? process.env
  const home = io.home ?? homedir()
  const log = io.log ?? ((m) => console.log(m))
  const dry = argv.includes("--dry-run")
  const vi = argv.indexOf("--version")
  const version = vi >= 0 ? String(argv[vi + 1] ?? "") : await latestVersion()
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`无效版本号: ${version}`)
  const spec = `${PKG}@${version}`

  const cfgDir = configDirOf(env, home)
  const mainPath = firstExisting(cfgDir, ["opencode.jsonc", "opencode.json"]) ?? join(cfgDir, "opencode.jsonc")
  const tuiPath = firstExisting(cfgDir, ["tui.jsonc", "tui.json"])
    ?? (existsSync(mainPath) ? null : join(cfgDir, "tui.jsonc")) // 全新安装时顺带建 tui 配置（侧边栏面板）
  const targets = [{ path: mainPath, text: tuiPath === mainPath || existsSync(mainPath) ? readFileSync(mainPath, "utf8") : "" }]
  if (tuiPath) targets.push({ path: tuiPath, text: existsSync(tuiPath) ? readFileSync(tuiPath, "utf8") : '{\n  "$schema": "https://opencode.ai/tui.json",\n  "plugin": []\n}\n' })

  const actions = []
  for (const t of targets) {
    const r = rewriteSpec(t.text, spec)
    actions.push({ file: t.path, action: r.action, previous: r.previous ?? null })
    if (r.action === "unparseable") throw new Error(`${t.path} 中无法定位 plugin 数组，请手动编辑后重试`)
    if (r.action === "file-ref") {
      log(`[switchman] 跳过 ${t.path}：当前是 file:// 源码引用，请用 bun run mode:prod / mode:local 管理，不做改写`)
      continue
    }
    if (r.action === "noop") {
      log(`[switchman] ${t.path} 已是 ${spec}`)
      continue
    }
    log(`[switchman] ${dry ? "将改写" : "已改写"} ${t.path}: ${r.previous ? `${r.previous} → ` : ""}${spec}（${r.action}）`)
    if (!dry) {
      mkdirSync(cfgDir, { recursive: true })
      writeFileSync(t.path, r.text)
    }
  }

  let pruned = []
  if (!dry) {
    pruned = pruneCaches(cachePackagesDirOf(env, home))
    if (pruned.length > 0) log(`[switchman] 已清理 opencode 插件缓存: ${pruned.join("、")}`)
    const mainAct = actions.find((a) => a.file === mainPath)?.action
    if (mainAct === "replaced" || mainAct === "uncommented") {
      // 升级语义：标记「已升级待重启」横幅（重启后自然失效）
      const stDir = stateDirOf(env, home)
      mkdirSync(stDir, { recursive: true })
      writeFileSync(join(stDir, "upgraded.flag"), "")
    }
  } else {
    log("[switchman] dry-run：未写入任何文件、未清理缓存")
  }
  log(`[switchman] 完成（${spec}）。重启 opencode（app 退出重开 / tui 重进）后新版本生效。`)
  return { spec, actions }
}

// [2026-09-01]-[macOS /var/folders→/private/var/folders 符号链接致 import.meta.url(realpath) 与
//  pathToFileURL(argv[1])(原样) 永不相等，脚本静默空转 exit 0]-[入口判定改为对 argv[1] 取 realpath]
let entryUrl = null
try { entryUrl = pathToFileURL(realpathSync(process.argv[1] ?? "")).href } catch {}
if (import.meta.url === entryUrl) {
  run().catch((exc) => {
    console.error(`[switchman] 更新失败: ${exc?.message ?? exc}`)
    process.exit(1)
  })
}
