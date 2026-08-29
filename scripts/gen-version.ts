import { readFileSync, writeFileSync } from "node:fs"

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown }
if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
  throw new Error("package.json 缺少有效 version")
}

writeFileSync(
  new URL("../src/version.ts", import.meta.url),
  `// 构建生成：请运行 bun scripts/gen-version.ts\nexport const PLUGIN_VERSION = ${JSON.stringify(packageJson.version)}\n`,
)
