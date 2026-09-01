// 一键切换 opencode 插件加载源：本地仓库（file://，吃 dist 构建产物）⇄ npm 正式发布包
// 用法：bun scripts/plugin-mode.ts local|prod ；切换后需重启 opencode 生效
// [2026-08-29]-[opencode.json 为 JSONC 带注释，做行级手术保留其余内容；幂等可重复执行]-
// [2026-08-31]-[同步维护 tui.jsonc 的 plugin 数组：server/TUI 是两套独立注册列表，即使同一个包也要分别声明，
// 否则侧边栏状态面板（src/tui.tsx）不会被加载；tui.jsonc 不存在时自动创建]
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// [2026-08-29]-[实际配置为 opencode.jsonc（JSONC 带注释），json/jsonc 双探测]-
const CONFIG = [join(homedir(), ".config", "opencode", "opencode.jsonc"), join(homedir(), ".config", "opencode", "opencode.json")]
  .find((p) => existsSync(p))
const TUI_CONFIG_CANDIDATES = [join(homedir(), ".config", "opencode", "tui.jsonc"), join(homedir(), ".config", "opencode", "tui.json")]
const TUI_CONFIG = TUI_CONFIG_CANDIDATES.find((p) => existsSync(p)) ?? TUI_CONFIG_CANDIDATES[0]
const LOCAL = "file:///Users/mrzturn/Documents/code/my/GitHub/opencode-switchman"
const PKG = "opencode-switchman"

const mode = process.argv[2]
if (mode !== "local" && mode !== "prod") {
  console.error("用法: bun scripts/plugin-mode.ts local|prod")
  process.exit(1)
}
if (!CONFIG) {
  console.error("未找到 ~/.config/opencode/opencode.jsonc|json")
  process.exit(1)
}

if (mode === "prod" && !existsSync(join(homedir(), ".config", "opencode", "node_modules", PKG))) {
  console.error(`[mode:prod] ${PKG} 未安装到 ~/.config/opencode——先执行: cd ~/.config/opencode && npm install ${PKG}`)
  process.exit(1)
}

const text = readFileSync(CONFIG, "utf8")
let out = text
if (mode === "local") {
  out = out.replace(/^(\s*)\/\/\s*("file:\/\/\/Users\/mrzturn[^\"]*")/m, "$1$2")
  out = out.replace(/^(\s*)(\"opencode-switchman\")/m, "$1// $2")
} else {
  out = out.replace(/^(\s*)("file:\/\/\/Users\/mrzturn[^\"]*")/m, "$1// $2")
  out = out.replace(/^(\s*)\/\/\s*(\"opencode-switchman\")/m, "$1$2")
}
if (out === text) console.log(`[plugin-mode] 已是 ${mode}，无变更`)
else {
  writeFileSync(CONFIG, out)
  console.log(`[plugin-mode] 已切换到 ${mode}${mode === "local" ? "（记得先 bun run build 保证 dist 新鲜）" : ""}；重启 opencode 生效`)
}
const active = out.split("\n").filter((l) => {
  const t = l.trim()
  return t.startsWith('"') && (t.includes(PKG) || t.includes("file:"))
})
console.log(`当前生效条目: ${active.join(" | ").trim() || "(无——重启后插件不加载!)"}`)

// ---- 同步 tui.jsonc 的 plugin 数组（TUI 侧边栏状态面板独立注册，不随 opencode.jsonc 联动）----
const spec = mode === "local" ? LOCAL : PKG
const tuiText = existsSync(TUI_CONFIG)
  ? readFileSync(TUI_CONFIG, "utf8")
  : `{\n  "$schema": "https://opencode.ai/tui.json",\n  "plugin": []\n}\n`

let tuiOut = tuiText
// 先移除两种 spec 的既有条目（含注释掉的），再插入目标 spec，保证幂等且不留旧模式残留
tuiOut = tuiOut.replace(/^\s*(?:\/\/)?\s*"file:\/\/\/Users\/mrzturn[^"]*",?\n/m, "")
tuiOut = tuiOut.replace(/^\s*(?:\/\/)?\s*"opencode-switchman",?\n/m, "")
if (!tuiOut.includes(`"${spec}"`)) {
  const withoutTrailingComma = tuiOut.replace(/\[\s*\]/, "[]")
  tuiOut = withoutTrailingComma.includes('"plugin": []')
    ? withoutTrailingComma.replace('"plugin": []', `"plugin": [\n    "${spec}"\n  ]`)
    : withoutTrailingComma.replace(/("plugin"\s*:\s*\[)/, `$1\n    "${spec}",`)
}
if (tuiOut === tuiText && existsSync(TUI_CONFIG)) {
  console.log(`[plugin-mode] tui.jsonc 已含 ${spec}，无变更`)
} else {
  writeFileSync(TUI_CONFIG, tuiOut)
  console.log(`[plugin-mode] 已同步 tui.jsonc：plugin 含 "${spec}"（侧边栏状态面板生效需重启 opencode）`)
}
