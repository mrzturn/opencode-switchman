// [2026-09-04]-[English localization: translate comments and messages; no logic change]
// [2026-09-02]-[Three essentials for building the TUI bundle: ① Bun.build's direct outfile write can
// flush a stale cached artifact to disk → build in memory and manually Bun.write; ② bun's built-in JSX
// transform has no solid reactivity semantics (expressions evaluate eagerly, components render once →
// frozen panels) → must attach @opentui/solid/bun-plugin's solidTransform (its onLoad redirects
// solid-js/dist/server.js — misresolved under target=node — to the client-side solid.js, so src can
// import bare "solid-js"); ③ at runtime, bare "solid-js"/"@opentui/solid" are precisely rewritten to
// the host instances by the host runtime-plugin (opentui:runtime-module:*); deep paths do not match
// the rewrite rules → two disconnected reactive graphs that never subscribe to each other → UI fully
// frozen, so deep paths are forbidden]-
// [Affects live TUI panel refresh; the server bundle dist/opencode-switchman.js does not use this script]-
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
// Post-conditions: ① JSX must be handled by the solid transform (produces createComponent)
// ② solid-js must be a bare import (only then does the host runtime rewrite it to the host instance,
// keeping it on the same reactive graph as the host's effects) ③ deep paths are forbidden
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
