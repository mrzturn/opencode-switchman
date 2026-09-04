// [2026-09-04]-[English localization: translate CLI messages and comments; no logic change]
import { loadUserConfig } from "./config"
import { formatDoctorReport, runDoctor } from "./doctor"
if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
  console.log("Usage: switchman-doctor checks the opencode-switchman config; the OPENCODE_CONFIG_DIR env var selects the config directory; exit codes 0=no issues, 1=warnings, 2=errors")
} else {
const config = loadUserConfig()
const result = runDoctor({ configPath: config.path, diagnostics: config.diagnostics, env: process.env })
console.log(formatDoctorReport(result))
process.exitCode = result.diagnostics.some((d) => d.level === "error") ? 2 : result.diagnostics.some((d) => d.level === "warn") ? 1 : 0
}
