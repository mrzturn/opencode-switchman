// [2026-09-04]-[English localization: translate CLI messages and comments; no logic change]
import { existsSync, statSync, readFileSync, accessSync, constants } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { parseJsonc, resolveOpencodeConfigDir, validateUserConfig } from "./config"
import { canonicalKeyOf, PROVIDER_KEYS } from "./provider-config"
import { loadManifest, paths } from "./state"
import { baseScoreDynamic } from "./capability"
import type { ConfigDiagnostic } from "./config"

export interface DoctorInput {
  configPath: string; configText?: string; diagnostics?: ConfigDiagnostic[]; commandPath?: string; cliPath?: string
  env?: Record<string, string | undefined>; home?: string
  legacy?: { quotaEnabled?: Partial<Record<"glm" | "copilot" | "deepseek", boolean>>; billingWindow?: boolean; sections?: string[] }
}
export interface DoctorResult { diagnostics: ConfigDiagnostic[] }
function suggestion(actual: string, expected: readonly string[]): string | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[-_]/g, "")
  const distance = (a: string, b: string): number => {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i++) { let prev = row[0]!; row[0] = i; for (let j = 1; j <= b.length; j++) { const old = row[j]!; row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = old } }
    return row[b.length]!
  }
  return expected.find((x) => norm(actual).includes(norm(x)) || norm(x).includes(norm(actual)) || distance(norm(actual), norm(x)) <= 2)
}
export function runDoctor(input: DoctorInput): DoctorResult {
  const out = [...(input.diagnostics ?? [])]
  let value: unknown = null
  try { const p = parseJsonc(input.configText ?? readFileSync(input.configPath, "utf8")); if ("error" in p) out.push({ code: "SWM001", level: "error", path: input.configPath }); else value = p.value } catch { out.push({ code: "SWM001", level: "error", path: input.configPath }) }
  if (value !== null) {
    out.push(...validateUserConfig(value).diagnostics)
    const providers = (value as any)?.providers
    if ((value as any)?.version === undefined || Number((value as any).version) < 1) out.push({ code: "SWM010", level: "warn", path: "version" })
    if (Number((value as any)?.version) > 1) out.push({ code: "SWM011", level: "warn", path: "version" })
    if ((value as any)?.$schema !== "https://raw.githubusercontent.com/mrzturn/opencode-switchman/main/schema/opencode-switchman-v1.schema.json") out.push({ code: "SWM012", level: "info", path: "$schema" })
    if (providers && typeof providers === "object") for (const k of Object.keys(providers)) {
      // [2026-08-31]-[De-vendored SWM020 new semantics: any provider key is legal (opencode official/custom);
      //  near-spellings of builtin keys (edit distance≤2/containment) get warn + suggestion, everything else stays info as custom]
      if (!PROVIDER_KEYS.includes(k as any)) {
        const near = suggestion(k, PROVIDER_KEYS)
        if (canonicalKeyOf(k) || near) out.push({ code: "SWM020", level: "warn", path: `providers.${k}`, hint: near ?? canonicalKeyOf(k) ?? undefined })
        else out.push({ code: "SWM020", level: "info", path: `providers.${k}` })
      }
      const provider = (providers as Record<string, unknown>)[k]
      if (provider && typeof provider === "object" && !Array.isArray(provider)) {
        for (const field of Object.keys(provider)) {
          if (!["enabled", "observe", "billing", "peak"].includes(field)) { const hint = suggestion(field, ["enabled", "observe", "billing", "peak"]); if (hint) out.push({ code: "SWM021", level: "warn", path: `providers.${k}.${field}`, hint }) }
        }
        // [2026-08-31]-[billing not explicitly configured hint: the builtin key's factory default is in effect; explicit declaration enables traceability]
        if (canonicalKeyOf(k) && !("billing" in provider)) out.push({ code: "SWM061", level: "info", path: `providers.${k}.billing` })
      }
    }
    // [2026-08-31]-[De-vendoring: unknown-group inventory and near-classification hit reporting (bundled manifest semantics; info does not block)]
    try {
      const shells = loadManifest().shells
      const unknown = shells.filter((s) => baseScoreDynamic(s.modelId).source === "global")
      if (unknown.length > 0) out.push({ code: "SWM060", level: "info", path: "shells", hint: `${unknown.length} models not matched by the known system (unknown group, ranked to the bottom by coefficient)` })
      const approx = shells.filter((s) => ["prefix", "family"].includes(baseScoreDynamic(s.modelId).source))
      if (approx.length > 0) out.push({ code: "SWM062", level: "info", path: "shells", hint: `${approx.length} models classified approximately by prefix/family` })
    } catch { /* fail-open */ }
  }
  try { statSync(dirname(input.configPath)); accessSync(dirname(input.configPath), constants.W_OK) } catch { out.push({ code: "SWM051", level: "error", path: dirname(input.configPath) }) }
  const env = input.env
  if (env?.OPENCODE_CONFIG_DIR) {
    const root = env.OPENCODE_CONFIG_DIR
    if (!isAbsolute(root) || (existsSync(root) && statSync(root).isFile())) out.push({ code: "SWM052", level: "error", path: "OPENCODE_CONFIG_DIR" })
    const xdg = env.XDG_CONFIG_HOME && join(env.XDG_CONFIG_HOME, "opencode")
    if (xdg && resolveOpencodeConfigDir(env, input.home) !== xdg) out.push({ code: "SWM052", level: "warn", path: "OPENCODE_CONFIG_DIR" })
  }
  if (input.legacy?.quotaEnabled && Object.keys(input.legacy.quotaEnabled).length) out.push({ code: "SWM042", level: "warn", path: "legacy.quota" })
  if (input.legacy?.billingWindow) out.push({ code: "SWM043", level: "warn", path: "legacy.billingWindow" })
  // [2026-09-01]-[Unified config surface: tuple explicit behavior sections prompt migration to opencode-switchman.jsonc (gen-1 compatible, explicit values still win)]
  for (const section of input.legacy?.sections ?? []) out.push({ code: "SWM044", level: "warn", path: `legacy.${section}`, hint: "opencode-switchman.jsonc" })
  if (value !== null) {
    const providers = (value as any)?.providers
    if (providers && typeof providers === "object" && PROVIDER_KEYS.some((key) => (providers as any)[key]?.enabled === true && (providers as any)[key]?.observe === false)) out.push({ code: "SWM040", level: "warn", path: "providers" })
  }
  if (input.commandPath && !existsSync(input.commandPath)) out.push({ code: "SWM053", level: "warn", path: input.commandPath })
  if (input.cliPath && !existsSync(input.cliPath)) out.push({ code: "SWM053", level: "warn", path: input.cliPath })
  for (const key of ["glmQuota", "copilotQuota", "dsQuota", "matrix", "routing", "selfupdate"] as const) { const p = paths()[key]; if (existsSync(p)) try { JSON.parse(readFileSync(p, "utf8")) } catch { out.push({ code: "SWM050", level: "warn", path: p }) } }
  // [2026-08-31]-[Final review P2-1: load-time diagnostics passed through by the entry share the same source as this re-parse validation; dedupe by code+path+level+hint
  //  to avoid double-counting the same error (banner doctor summary count distortion)]
  const deduped = out.filter((d, i, arr) =>
    arr.findIndex((x) => x.code === d.code && x.path === d.path && x.level === d.level && (x.hint ?? "") === (d.hint ?? "")) === i)
  return { diagnostics: deduped.sort((a, b) => ({ error: 0, warn: 1, info: 2 }[a.level] - { error: 0, warn: 1, info: 2 }[b.level] || a.code.localeCompare(b.code))) }
}
export function formatDoctorReport(result: DoctorResult): string {
  if (!result.diagnostics.length) return "opencode-switchman doctor: no issues found"
  const rank = { error: 0, warn: 1, info: 2 }
  return [...result.diagnostics].sort((a, b) => rank[a.level] - rank[b.level] || a.code.localeCompare(b.code)).map((d) => `${d.level.toUpperCase()} ${d.code}${d.path ? ` ${d.path}` : ""}${d.hint ? ` (hint: ${d.hint})` : ""}`).join("\n")
}
