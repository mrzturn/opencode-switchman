import { loadUserConfig } from "./config"
import { formatDoctorReport, runDoctor } from "./doctor"
if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
  console.log("用法：switchman-doctor 检查 opencode-switchman 配置；环境变量 OPENCODE_CONFIG_DIR 可指定配置目录；退出码 0=无问题、1=警告、2=错误")
} else {
const config = loadUserConfig()
const result = runDoctor({ configPath: config.path, diagnostics: config.diagnostics, env: process.env })
console.log(formatDoctorReport(result))
process.exitCode = result.diagnostics.some((d) => d.level === "error") ? 2 : result.diagnostics.some((d) => d.level === "warn") ? 1 : 0
}
