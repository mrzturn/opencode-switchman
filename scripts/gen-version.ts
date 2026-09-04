import { readFileSync, writeFileSync } from "node:fs"

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown }
if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
  // [2026-09-04]-[English localization: translate messages; no logic change]
  throw new Error("package.json has no valid version")
}

writeFileSync(
  new URL("../src/version.ts", import.meta.url),
  `// Generated at build time: run bun scripts/gen-version.ts\nexport const PLUGIN_VERSION = ${JSON.stringify(packageJson.version)}\n`,
)
