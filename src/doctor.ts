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
      // [2026-08-31]-[去厂商化 SWM020 新语义：任意 provider 键合法（opencode 官方/自定义）；
      //  仅对内置键的近似拼写（编辑距离≤2/包含）降 warn 附建议，其余 info 提示按自定义处理]
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
        // [2026-08-31]-[billing 未显式配置提示：内置键出厂缺省生效中，显式声明可溯源]
        if (canonicalKeyOf(k) && !("billing" in provider)) out.push({ code: "SWM061", level: "info", path: `providers.${k}.billing` })
      }
    }
    // [2026-08-31]-[去厂商化：未知组清点与近似归类命中报告（随包清单口径；info 不拦截）]
    try {
      const shells = loadManifest().shells
      const unknown = shells.filter((s) => baseScoreDynamic(s.modelId).source === "global")
      if (unknown.length > 0) out.push({ code: "SWM060", level: "info", path: "shells", hint: `${unknown.length} 模型未命中已知体系（未知组，排序按系数沉底）` })
      const approx = shells.filter((s) => ["prefix", "family"].includes(baseScoreDynamic(s.modelId).source))
      if (approx.length > 0) out.push({ code: "SWM062", level: "info", path: "shells", hint: `${approx.length} 模型按前缀/family 近似归类` })
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
  // [2026-09-01]-[配置面统一：元组显式行为段提示迁移到 opencode-switchman.jsonc（兼容一代，显式值仍优先）]
  for (const section of input.legacy?.sections ?? []) out.push({ code: "SWM044", level: "warn", path: `legacy.${section}`, hint: "opencode-switchman.jsonc" })
  if (value !== null) {
    const providers = (value as any)?.providers
    if (providers && typeof providers === "object" && PROVIDER_KEYS.some((key) => (providers as any)[key]?.enabled === true && (providers as any)[key]?.observe === false)) out.push({ code: "SWM040", level: "warn", path: "providers" })
  }
  if (input.commandPath && !existsSync(input.commandPath)) out.push({ code: "SWM053", level: "warn", path: input.commandPath })
  if (input.cliPath && !existsSync(input.cliPath)) out.push({ code: "SWM053", level: "warn", path: input.cliPath })
  for (const key of ["glmQuota", "copilotQuota", "dsQuota", "matrix", "routing", "selfupdate"] as const) { const p = paths()[key]; if (existsSync(p)) try { JSON.parse(readFileSync(p, "utf8")) } catch { out.push({ code: "SWM050", level: "warn", path: p }) } }
  // [2026-08-31]-[终审P2-1：入口透传的加载期诊断与本次重新解析校验同源，按 code+path+level+hint
  //  去重避免同一条错误被双计（横幅 doctor 摘要计数失真）]
  const deduped = out.filter((d, i, arr) =>
    arr.findIndex((x) => x.code === d.code && x.path === d.path && x.level === d.level && (x.hint ?? "") === (d.hint ?? "")) === i)
  return { diagnostics: deduped.sort((a, b) => ({ error: 0, warn: 1, info: 2 }[a.level] - { error: 0, warn: 1, info: 2 }[b.level] || a.code.localeCompare(b.code))) }
}
export function formatDoctorReport(result: DoctorResult): string {
  if (!result.diagnostics.length) return "opencode-switchman doctor：未发现问题"
  const rank = { error: 0, warn: 1, info: 2 }
  return [...result.diagnostics].sort((a, b) => rank[a.level] - rank[b.level] || a.code.localeCompare(b.code)).map((d) => `${d.level.toUpperCase()} ${d.code}${d.path ? ` ${d.path}` : ""}${d.hint ? `（建议 ${d.hint}）` : ""}`).join("\n")
}
