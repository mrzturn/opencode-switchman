// [2026-09-02]-[TUI 产物构建三要素：①Bun.build 的 outfile 直写会落盘过期缓存产物 → 内存产物手动
// Bun.write；②bun 内建 JSX 转换无 solid 响应式语义（表达式立即求值，组件只渲染一次→面板冻结）→
// 必须挂 @opentui/solid/bun-plugin 的 solidTransform（其 onLoad 会把 target=node 误解析的
// solid-js/dist/server.js 重定向为客户端 solid.js，故 src 用裸 "solid-js" 即可）；
// ③运行时裸 "solid-js"/"@opentui/solid" 会被宿主 runtime-plugin 精确重写到宿主实例
// （opentui:runtime-module:*），深路径不匹配重写规则→双实例图谱互不订阅→UI 全冻结，禁用深路径]-
// [影响 TUI 面板实时刷新；服务器产物 dist/opencode-switchman.js 不走此脚本]
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const outfile = process.argv[2] || "dist/opencode-switchman-tui.js"
const result = await Bun.build({
  entrypoints: ["src/tui.tsx"],
  target: "node",
  format: "esm",
  external: ["solid-js", "@opentui/solid", "@opentui/core"],
  plugins: [createSolidTransformPlugin()],
})
if (!result.success) {
  console.error(result.logs)
  process.exit(1)
}
const code = await result.outputs[0].text()
await Bun.write(outfile, code)
// 后置校验：①JSX 必须由 solid 转换处理（产出 createComponent）②solid-js 必须是裸导入
// （运行时才会被宿主重写到宿主实例，保证与宿主 effect 同一响应式图谱）③禁深路径
if (!code.includes("_$createComponent") && !code.includes("createComponent")) {
  console.error("post-condition failed: solid JSX transform did not run (no createComponent output)")
  process.exit(1)
}
if (!code.includes('from "solid-js"')) {
  console.error("post-condition failed: dist must import bare solid-js (host runtime rewrite depends on exact specifier)")
  process.exit(1)
}
if (code.includes("solid-js/dist/")) {
  console.error("post-condition failed: deep solid-js path present; host runtime rewrite only matches bare 'solid-js'")
  process.exit(1)
}
console.log("built", outfile)
