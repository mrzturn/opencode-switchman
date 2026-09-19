// [2026-09-04]-[English localization: translate CLI messages and comments; no logic change]
// [2026-09-19]-[render-time CLI i18n: the CLI has no project context, so the display locale is resolved ONCE per
//  process (global ui.lang snapshot → terminal env → "en"; see src/i18n.ts) and the usage line plus the doctor
//  report render via t(locale, key, params); SWM codes, env-var names and exit codes stay verbatim]
import { loadUserConfig } from "./config"
import { formatDoctorReport, runDoctor } from "./doctor"
import { resolveDisplayLocale, t } from "./i18n"
import { readUiLocale } from "./state"
const locale = resolveDisplayLocale({ uiLang: readUiLocale(), env: process.env })
if (process.argv.slice(2).some((arg) => arg === "--help" || arg === "-h")) {
  console.log(t(locale, "cli.doctor.usage"))
} else {
const config = loadUserConfig()
const result = runDoctor({ configPath: config.path, diagnostics: config.diagnostics, env: process.env }, locale)
console.log(formatDoctorReport(result, locale))
process.exitCode = result.diagnostics.some((d) => d.level === "error") ? 2 : result.diagnostics.some((d) => d.level === "warn") ? 1 : 0
}
