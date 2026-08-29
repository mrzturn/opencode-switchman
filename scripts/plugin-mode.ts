// 一键切换 opencode 插件加载源：本地仓库（file://，吃 dist 构建产物）⇄ npm 正式发布包
// 用法：bun scripts/plugin-mode.ts local|prod ；切换后需重启 opencode 生效
// [2026-08-29]-[opencode.json 为 JSONC 带注释，做行级手术保留其余内容；幂等可重复执行]-
import { readFileSync, writeFileSync, existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

// [2026-08-29]-[实际配置为 opencode.jsonc（JSONC 带注释），json/jsonc 双探测]-
const CONFIG = [join(homedir(), ".config", "opencode", "opencode.jsonc"), join(homedir(), ".config", "opencode", "opencode.json")]
  .find((p) => existsSync(p))
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
