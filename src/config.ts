import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { canonicalKeyOf, defaultProviderConfig, genericProviderDefaults, PROVIDER_KEYS, renderDefaultConfigJsonc, resolveProviderKey } from "./provider-config"
import type { PeakRange, ProviderKey, ProviderUserConfig } from "./provider-config"
import type { CapabilityTierThresholds, Lane, Pool, RoutePolicy, SwitchmanOptions } from "./types"
import { DEFAULT_LANG_CANDIDATES } from "./types"
import { DEFAULT_READ_BUDGET_TOKENS, MAX_READ_BUDGET_TOKENS, MIN_READ_BUDGET_TOKENS } from "./context-watch"

export interface ConfigDiagnostic { code: string; level: "error" | "warn" | "info"; path?: string; hint?: string }
// [2026-09-04]-[English localization: translate CLI messages and comments; no logic change]
// [2026-08-31]-[De-vendoring: providers opened up — any provider key is legal (opencode official/custom);
//  billing explicit config drives the subscription coefficient; the three builtin keys serve only as factory defaults and quota-pool mapping]
// [2026-09-01]-[Unified config surface: behavior sections (quota thresholds/cost/capability/matrix/banner/rules/lanes) moved into this file;
//  the plugin tuple's same-name options are demoted to a compatibility shim (explicit values win over gen-1, doctor reports SWM044)]
export interface UserQuotaConfig { glmFiveHourReservePct: number; deepseekLowBalanceWarnCny: number }
export interface UserCapabilityConfig { enabled: boolean; source: "auto" | "artificial-analysis" | "openrouter"; apiKey?: string; tierThresholds?: CapabilityTierThresholds | "quantile"; lmarenaCheck: boolean }
export interface UserMatrixConfig { mode: "auto" | "app" | "tui" | "legacy"; watch: boolean }
export interface UserContextConfig { gates: boolean; softTokens: number; hardTokens: number; forceTokens: number; autoHandover: boolean; readBudgetTokens?: number }
export interface UserConfig {
  version: number
  providers: Record<string, ProviderUserConfig>
  quota: UserQuotaConfig
  cost: { enabled: boolean }
  capability: UserCapabilityConfig
  matrix: UserMatrixConfig
  banner: { enabled: boolean }
  rules: { enabled: boolean; delegationFloor: number }
  context: UserContextConfig
  builtinAgents: { mode: "deny" | "allow" }
  injection: { mode: "chain" | "all" }
  // [2026-09-04]-[autoRedirect: silent-redirect-on-deny switch (default true); relay.image: image relay switch (default true)]
  dispatch: { autoRedirect: boolean }
  relay: { image: boolean }
  // [2026-09-05]-[artifact workspace: .switchman/<date>/<sessionId>-<title>/ per-project artifact coordination]
  workspace: { enabled: boolean; dirname: string }
  // [2026-09-05]-[project language preference: conversation/comments/docs language — first-run ask + per-turn [LANG] iron-rule line]
  lang: { enabled: boolean; ask: boolean; candidates: string[] }
  lanes: Partial<Record<Lane, string[]>>
  extensions: Record<string, unknown>
}
export interface LoadedUserConfig { path: string; config: UserConfig; diagnostics: ConfigDiagnostic[]; generated: boolean }

export const DEFAULT_CONTEXT_TOKENS = { soft: 60_000, hard: 80_000, force: 100_000 } as const
export const DEFAULT_DELEGATION_FLOOR = 3_000

/** Factory defaults for behavior sections (fillMissing baseline; only bad-typed values fall back and report SWM037) */
export function defaultBehaviorConfig(): Pick<UserConfig, "quota" | "cost" | "capability" | "matrix" | "banner" | "rules" | "context" | "builtinAgents" | "injection" | "dispatch" | "relay" | "workspace" | "lang" | "lanes"> {
  return {
    quota: { glmFiveHourReservePct: 90, deepseekLowBalanceWarnCny: 10 },
    cost: { enabled: true },
    capability: { enabled: true, source: "auto", lmarenaCheck: false },
    matrix: { mode: "auto", watch: true },
    banner: { enabled: true },
    rules: { enabled: true, delegationFloor: DEFAULT_DELEGATION_FLOOR },
    context: { gates: true, softTokens: DEFAULT_CONTEXT_TOKENS.soft, hardTokens: DEFAULT_CONTEXT_TOKENS.hard, forceTokens: DEFAULT_CONTEXT_TOKENS.force, autoHandover: true, readBudgetTokens: DEFAULT_READ_BUDGET_TOKENS },
    builtinAgents: { mode: "deny" },
    injection: { mode: "chain" },
    dispatch: { autoRedirect: true },
    relay: { image: true },
    workspace: { enabled: true, dirname: ".switchman" },
    lang: { enabled: true, ask: true, candidates: [...DEFAULT_LANG_CANDIDATES] },
    lanes: {},
  }
}

export function resolveOpencodeConfigDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode")
}

/** JSONC only strips comments and trailing commas; string/escape states are excluded from stripping. */
export function parseJsonc(text: string): { value: unknown } | { error: { line: number; col: number; message: string } } {
  let out = "", i = 0, str = false, quote = "", line = 1, col = 1
  const put = (c: string) => { out += c; if (c === "\n") { line++; col = 1 } else col++ }
  const nextCode = (pos: number): number => {
    while (pos < text.length) {
      if (/\s/.test(text[pos]!)) { pos++; continue }
      if (text[pos] === "/" && text[pos + 1] === "/") { pos = text.indexOf("\n", pos + 2); if (pos < 0) return text.length; continue }
      if (text[pos] === "/" && text[pos + 1] === "*") { pos = text.indexOf("*/", pos + 2); if (pos < 0) return text.length; pos += 2; continue }
      break
    }
    return pos
  }
  while (i < text.length) {
    const c = text[i]!, n = text[i + 1]
    if (str) { put(c); if (c === "\\" && i + 1 < text.length) { put(text[++i]!) } else if (c === quote) str = false; i++; continue }
    if (c === '"' || c === "'") { str = true; quote = c; put(c); i++; continue }
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") { put(" "); i++ } continue }
    if (c === "/" && n === "*") { put(" "); put(" "); i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) { put(text[i] === "\n" ? "\n" : " "); i++ } if (i < text.length) { put(" "); put(" "); i += 2 }; continue }
    if (c === ",") {
      const j = nextCode(i + 1)
      let k = out.length - 1
      while (k >= 0 && /\s/.test(out[k]!)) k--
      if ((text[j] === "}" || text[j] === "]") && out[k] !== ":" && out[k] !== ",") { i++; continue }
    }
    put(c); i++
  }
  try { return { value: JSON.parse(out) } } catch (e) {
    const m = /position (\d+)/.exec(String(e)); const fallback = /:\s*[,}\]]/.exec(out)
    const pos = m ? Number(m[1]) : fallback ? fallback.index + fallback[0].length - 1 : 0
    const before = out.slice(0, pos); return { error: { line: before.split("\n").length, col: pos - before.lastIndexOf("\n"), message: "JSONC parse failed" } }
  }
}

function plain(v: unknown): v is Record<string, unknown> { return typeof v === "object" && v !== null && !Array.isArray(v) }
const unsafe = new Set(["__proto__", "constructor", "prototype"])
export function fillMissing(raw: unknown, defaults: unknown): any {
  if (Array.isArray(defaults)) return raw === undefined ? structuredClone(defaults) : raw
  if (!plain(defaults)) return raw === undefined ? defaults : raw
  if (raw !== undefined && !plain(raw)) return raw
  const out = Object.create(null) as Record<string, unknown>; const src = plain(raw) ? raw : Object.create(null)
  for (const k of new Set([...Object.keys(defaults), ...Object.keys(src)])) {
    if (unsafe.has(k)) continue
    out[k] = fillMissing(src[k], (defaults as Record<string, unknown>)[k])
  }
  return out
}
function validTimezone(s: unknown): s is string { if (s === "local") return true; if (typeof s !== "string") return false; try { new Intl.DateTimeFormat("en", { timeZone: s }); return true } catch { return false } }
function validTime(v: unknown): v is string { return typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) }
function minute(s: string): number { return Number(s.slice(0, 2)) * 60 + Number(s.slice(3)) }
function rangeDiagnostic(v: unknown): string | null {
  if (!Array.isArray(v)) return "SWM034"
  const slots: boolean[] = Array(7 * 1440).fill(false)
  for (const r of v) {
    if (!plain(r) || !Array.isArray(r.days)) return "SWM034"
    const days = r.days as unknown[]
    if (!days.every((d) => Number.isInteger(d) && Number(d) >= 1 && Number(d) <= 7) || new Set(days).size !== days.length) return "SWM032"
    if (!validTime(r.start) || !validTime(r.end)) return "SWM033"
    if (r.start === r.end) return "SWM034"
    const a = minute(r.start), b = minute(r.end)
    for (const d of days as number[]) for (let x = a, count = (b - a + 1440) % 1440; x < a + count; x++) { const n = ((d - 1) * 1440 + x) % (7 * 1440); if (slots[n]) return "SWM035"; slots[n] = true }
  }
  return null
}
export function validateUserConfig(value: unknown): { config: UserConfig; diagnostics: ConfigDiagnostic[] } {
  const defaults = { version: 1, providers: defaultProviderConfig(), extensions: {} as Record<string, unknown>, ...structuredClone(defaultBehaviorConfig()) }
  const filled = plain(fillMissing(value, defaults)) ? fillMissing(value, defaults) : structuredClone(defaults); const ds: ConfigDiagnostic[] = []
  if (!plain(filled.providers)) filled.providers = structuredClone(defaults.providers)
  // [2026-08-31]-[De-vendoring: per-key validation extended to any provider key; builtin keys use spec defaults, custom keys use generic defaults (billing default api).
  //  Missing fields (undefined) = filled in memory without diagnostics (friendly to minimal custom-key config); only bad-typed values get a diagnostic and fall back]
  const keys = [...new Set([...PROVIDER_KEYS, ...Object.keys(filled.providers)])]
  for (const key of keys) {
    const canonical = canonicalKeyOf(key)
    const def = canonical ? defaults.providers[canonical] : genericProviderDefaults()
    const p = plain(filled.providers[key]) ? filled.providers[key] : structuredClone(def)
    filled.providers[key] = p
    for (const field of ["enabled", "observe"] as const) {
      if (p[field] === undefined) { p[field] = def[field]; continue }
      if (typeof p[field] !== "boolean") { ds.push({ code: "SWM030", level: "error", path: `providers.${key}.${field}` }); p[field] = def[field] }
    }
    // [2026-08-31]-[billing field: subscription|api declared explicitly; illegal values fall back in memory to the factory default (SWM036)]
    if (p.billing === undefined) p.billing = def.billing
    else if (p.billing !== "subscription" && p.billing !== "api") { ds.push({ code: "SWM036", level: "error", path: `providers.${key}.billing` }); p.billing = def.billing }
    if (p.peak === undefined) p.peak = structuredClone(def.peak)
    else if (!plain(p.peak) || !validTimezone(p.peak.timezone)) { ds.push({ code: "SWM031", level: "error", path: `providers.${key}.peak.timezone` }); p.peak = structuredClone(def.peak) }
    else {
      const code = rangeDiagnostic(p.peak.ranges)
      if (code) { ds.push({ code, level: "error", path: `providers.${key}.peak.ranges` }); p.peak.ranges = structuredClone(def.peak.ranges) }
    }
  }
  // [2026-09-01]-[Behavior-section light validation: bad-typed values → SWM037 fallback to defaults; fillMissing already fills defaults, this only catches bad values]
  const bad = (path: string, fix: () => void) => { ds.push({ code: "SWM037", level: "error", path }); fix() }
  const q = filled.quota
  if (typeof q.glmFiveHourReservePct !== "number" || !(q.glmFiveHourReservePct > 0 && q.glmFiveHourReservePct <= 100)) bad("quota.glmFiveHourReservePct", () => { q.glmFiveHourReservePct = defaults.quota.glmFiveHourReservePct })
  if (typeof q.deepseekLowBalanceWarnCny !== "number" || q.deepseekLowBalanceWarnCny < 0) bad("quota.deepseekLowBalanceWarnCny", () => { q.deepseekLowBalanceWarnCny = defaults.quota.deepseekLowBalanceWarnCny })
  for (const [section, field] of [["cost", "enabled"], ["banner", "enabled"], ["rules", "enabled"], ["matrix", "watch"], ["capability", "enabled"], ["capability", "lmarenaCheck"], ["dispatch", "autoRedirect"], ["relay", "image"]] as const) {
    if (typeof (filled[section] as any)[field] !== "boolean") bad(`${section}.${field}`, () => { (filled[section] as any)[field] = (defaults[section] as any)[field] })
  }
  if (!["auto", "app", "tui", "legacy"].includes(filled.matrix.mode)) bad("matrix.mode", () => { filled.matrix.mode = defaults.matrix.mode })
  // [2026-09-04]-[New behavior-section validation: rules.delegationFloor non-negative; context three watermarks positive integers with soft<hard<force
  //  (out-of-order falls back to defaults as a whole); builtinAgents/injection enums (default deny/chain)]
  if (typeof filled.rules.delegationFloor !== "number" || !(filled.rules.delegationFloor >= 0)) bad("rules.delegationFloor", () => { filled.rules.delegationFloor = defaults.rules.delegationFloor })
  const tk = filled.context
  const tokensOk = [tk.softTokens, tk.hardTokens, tk.forceTokens].every((n) => Number.isInteger(n) && n > 0) && tk.softTokens < tk.hardTokens && tk.hardTokens < tk.forceTokens
  if (!tokensOk) bad("context (soft<hard<force must be positive integers)", () => { filled.context = structuredClone(defaults.context) })
  if (typeof tk.gates !== "boolean") bad("context.gates", () => { filled.context.gates = defaults.context.gates })
  // [2026-09-04]-[auto-handover switch: after exceeding the force-compaction watermark, tool.execute.after auto-triggers /handover (default true)]
  if (typeof tk.autoHandover !== "boolean") bad("context.autoHandover", () => { filled.context.autoHandover = defaults.context.autoHandover })
  // [2026-09-05]-[v1 read budget: finite token number clamped to [MIN_READ_BUDGET_TOKENS, MAX_READ_BUDGET_TOKENS]; bad values fall back to the factory default (SWM037)]
  if (typeof tk.readBudgetTokens !== "number" || !Number.isFinite(tk.readBudgetTokens) || tk.readBudgetTokens < MIN_READ_BUDGET_TOKENS || tk.readBudgetTokens > MAX_READ_BUDGET_TOKENS) bad("context.readBudgetTokens", () => { filled.context.readBudgetTokens = defaults.context.readBudgetTokens })
  if (filled.builtinAgents.mode !== "deny" && filled.builtinAgents.mode !== "allow") bad("builtinAgents.mode", () => { filled.builtinAgents.mode = defaults.builtinAgents.mode })
  if (filled.injection.mode !== "chain" && filled.injection.mode !== "all") bad("injection.mode", () => { filled.injection.mode = defaults.injection.mode })
  // [2026-09-05]-[artifact workspace: enabled boolean + flat directory name (path separators/".."/absolute values rejected, fallback ".switchman")]
  if (typeof filled.workspace.enabled !== "boolean") bad("workspace.enabled", () => { filled.workspace.enabled = defaults.workspace.enabled })
  {
    const dn = String(filled.workspace.dirname ?? "")
    if (!dn.trim() || dn !== dn.trim() || /[/\\]/.test(dn) || dn === "." || dn === "..") bad("workspace.dirname", () => { filled.workspace.dirname = defaults.workspace.dirname })
  }
  // [2026-09-05]-[project language preference: enabled/ask booleans; candidates = non-empty trimmed bounded strings (fallback to defaults)]
  if (typeof filled.lang.enabled !== "boolean") bad("lang.enabled", () => { filled.lang.enabled = defaults.lang.enabled })
  if (typeof filled.lang.ask !== "boolean") bad("lang.ask", () => { filled.lang.ask = defaults.lang.ask })
  if (!Array.isArray(filled.lang.candidates) || filled.lang.candidates.length === 0 || !filled.lang.candidates.every((c: unknown) => typeof c === "string" && c.trim() === c && !!c.trim() && c.length <= 48)) bad("lang.candidates", () => { filled.lang.candidates = structuredClone(defaults.lang.candidates) })
  if (!["auto", "artificial-analysis", "openrouter"].includes(filled.capability.source)) bad("capability.source", () => { filled.capability.source = defaults.capability.source })
  if (filled.capability.apiKey !== undefined && typeof filled.capability.apiKey !== "string") bad("capability.apiKey", () => { filled.capability.apiKey = undefined })
  // lanes: each value must be string[]; a single bad value only falls back that lane (rest kept)
  if (!plain(filled.lanes)) bad("lanes", () => { filled.lanes = structuredClone(defaults.lanes) })
  else for (const lane of Object.keys(filled.lanes) as Lane[]) {
    const v = filled.lanes[lane]
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) bad(`lanes.${lane}`, () => { delete filled.lanes[lane] })
  }
  if (!Number.isInteger(filled.version)) { ds.push({ code: "SWM010", level: "warn", path: "version" }); filled.version = 1 }
  return { config: filled as UserConfig, diagnostics: ds }
}
let templateCounter = 0
function writeTemplate(path: string): boolean { const tmp = `${path}.tmp.${process.pid}.${++templateCounter}`; try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(tmp, renderDefaultConfigJsonc()); renameSync(tmp, path); return true } catch { try { rmSync(tmp, { force: true }) } catch {}; return false } }
function lock(path: string): (() => void) | null {
  const p = `${path}.lock`
  const acquire = (): (() => void) | null => { try { const fd = openSync(p, "wx"); return () => { try { closeSync(fd); rmSync(p, { force: true }) } catch {} } } catch { return null } }
  const held = acquire()
  if (held) return held
  try { if (Date.now() - statSync(p).mtimeMs > 30_000) { rmSync(p, { force: true }); return acquire() } } catch {}
  return null
}
export function loadUserConfig(ctx: { env?: Record<string, string | undefined>; home?: string } = {}): LoadedUserConfig {
  const dir = resolveOpencodeConfigDir(ctx.env, ctx.home); const path = join(dir, "opencode-switchman.jsonc"); const diagnostics: ConfigDiagnostic[] = []
  if (!existsSync(path)) { try { mkdirSync(dir, { recursive: true }) } catch {}; const release = lock(path); let generated = false; try { if (!existsSync(path) && release) generated = writeTemplate(path) } finally { release?.() }; if (generated) diagnostics.push({ code: "SWM002", level: "info", path }) }
  let raw: unknown = {}; let bad = false
  try { if (statSync(path).size > 256 * 1024) { diagnostics.push({ code: "SWM003", level: "error", path }); bad = true } else { const parsed = parseJsonc(readFileSync(path, "utf8")); if ("error" in parsed) { diagnostics.push({ code: "SWM001", level: "error", path }); bad = true } else raw = parsed.value } } catch { bad = true }
  // Over-limit files must not be moved or overwritten; this is the fail-open boundary protecting unknown/misplaced content.
  if (bad && existsSync(path) && !diagnostics.some((d) => d.code === "SWM003")) {
    try { if (!lstatSync(path).isSymbolicLink()) { const backup = `${path}.invalid-${Date.now()}-${process.pid}.bak`; renameSync(path, backup); if (writeTemplate(path)) diagnostics.push({ code: "SWM002", level: "info", path }) } } catch { /* the original file must be preserved */ }
    raw = {}
  }
  const checked = validateUserConfig(raw); diagnostics.push(...checked.diagnostics)
  return { path, config: checked.config, diagnostics, generated: diagnostics.some((d) => d.code === "SWM002") }
}

/** [2026-09-01]-[Effective options composition: jsonc behavior sections are the baseline, plugin tuple explicit keys override (gen-1 compatible, doctor reports SWM044);
 *  quota.*.enabled / billingWindow keep the existing SWM042/043 semantics, not inventoried here */
export function resolveEffectiveOptions(raw: unknown, cfg: UserConfig): { options: SwitchmanOptions; legacySections: string[] } {
  const o = (raw ?? {}) as SwitchmanOptions
  const has = (obj: unknown, key: string) => plain(obj) && Object.prototype.hasOwnProperty.call(obj, key)
  const legacySections: string[] = []
  const num = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) ? v : undefined
  const glmReserve = num(o.quota?.glm?.fiveHourReservePct)
  const dsWarn = num(o.quota?.deepseek?.lowBalanceWarnCny)
  if (glmReserve !== undefined || dsWarn !== undefined) legacySections.push("quota")
  const options: SwitchmanOptions = {
    quota: {
      glm: { enabled: o.quota?.glm?.enabled ?? true, fiveHourReservePct: glmReserve ?? cfg.quota.glmFiveHourReservePct },
      deepseek: { enabled: o.quota?.deepseek?.enabled ?? true, lowBalanceWarnCny: dsWarn ?? cfg.quota.deepseekLowBalanceWarnCny },
      copilot: { enabled: o.quota?.copilot?.enabled ?? true },
    },
    cost: { enabled: has(o.cost, "enabled") ? o.cost!.enabled! : cfg.cost.enabled },
    billingWindow: o.billingWindow,
    banner: { enabled: has(o.banner, "enabled") ? o.banner!.enabled! : cfg.banner.enabled },
    rules: {
      enabled: has(o.rules, "enabled") ? o.rules!.enabled! : cfg.rules.enabled,
      delegationFloor: num(o.rules?.delegationFloor) ?? cfg.rules.delegationFloor,
    },
    context: has(o, "context") ? { ...cfg.context, ...o.context } : cfg.context,
    builtinAgents: has(o, "builtinAgents") ? { ...cfg.builtinAgents, ...o.builtinAgents } : cfg.builtinAgents,
    injection: has(o, "injection") ? { ...cfg.injection, ...o.injection } : cfg.injection,
    // [2026-09-04]-[autoRedirect/image-relay switches: jsonc behavior sections are the baseline, tuple explicit keys override (same pattern as builtinAgents)]
    dispatch: has(o, "dispatch") ? { ...cfg.dispatch, ...o.dispatch } : cfg.dispatch,
    relay: has(o, "relay") ? { ...cfg.relay, ...o.relay } : cfg.relay,
    // [2026-09-05]-[artifact workspace switch: same merge pattern; dirname falls back to the default when emptied]
    workspace: has(o, "workspace") ? { ...cfg.workspace, ...o.workspace } : cfg.workspace,
    // [2026-09-05]-[project language preference switch: same merge pattern (jsonc baseline, tuple explicit keys override)]
    lang: has(o, "lang") ? { ...cfg.lang, ...o.lang } : cfg.lang,
    lanes: has(o, "lanes") ? o.lanes : cfg.lanes,
    matrix: {
      mode: has(o.matrix, "mode") ? o.matrix!.mode! : cfg.matrix.mode,
      watch: has(o.matrix, "watch") ? o.matrix!.watch! : cfg.matrix.watch,
    },
    capability: {
      enabled: has(o.capability, "enabled") ? o.capability!.enabled! : cfg.capability.enabled,
      source: has(o.capability, "source") ? o.capability!.source! : cfg.capability.source,
      apiKey: has(o.capability, "apiKey") ? o.capability!.apiKey : cfg.capability.apiKey,
      tierThresholds: has(o.capability, "tierThresholds") ? o.capability!.tierThresholds : cfg.capability.tierThresholds,
      lmarenaCheck: has(o.capability, "lmarenaCheck") ? o.capability!.lmarenaCheck! : cfg.capability.lmarenaCheck,
    },
  }
  for (const section of ["cost", "banner", "rules", "lanes", "matrix", "capability", "context", "builtinAgents", "injection", "dispatch", "relay", "workspace", "lang"] as const) if (has(o, section)) legacySections.push(section)
  return { options, legacySections }
}
export function routePolicy(config: UserConfig, legacy?: Partial<Record<Pool, boolean>>): RoutePolicy {
  const out: RoutePolicy = Object.create(null)
  for (const pool of ["copilot", "glm", "deepseek"] as Pool[]) { const p = config.providers[{ copilot: "github-copilot", glm: "zhipuai-coding-plan", deepseek: "deepseek" }[pool] as ProviderKey]; out[pool] = { observe: legacy?.[pool] ?? p.observe, routing: p.enabled } }
  return out
}

/** [2026-08-31]-[De-vendoring: effective config resolution for any provider — exact key → alias/prefix canonical key → generic defaults;
 *  custom-key defaults = no routing, observable, api billing, no peak (filled in memory, not written back)] */
export function providerEntry(config: UserConfig, providerId: string): ProviderUserConfig {
  const direct = config.providers[providerId]
  if (direct && plain(direct)) {
    return (canonicalKeyOf(providerId) ? direct : { ...genericProviderDefaults(), ...direct }) as ProviderUserConfig
  }
  const hit = config.providers[resolveProviderKey(providerId)]
  if (hit && plain(hit)) return hit
  return structuredClone(genericProviderDefaults())
}

/** provider billing structure (subscription|api); the only source is the user jsonc explicit declaration (including factory defaults) */
export function billingOfProvider(config: UserConfig, providerId: string): "subscription" | "api" {
  return providerEntry(config, providerId).billing
}

function peakEntryActive(now: Date, peak: ProviderUserConfig["peak"]): boolean {
  const parts = peak.timezone === "local" ? { wd: ((now.getDay() + 6) % 7) + 1, h: now.getHours(), m: now.getMinutes() } : (() => { const a = new Intl.DateTimeFormat("en-US", { timeZone: peak.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now); const g = (t: string) => a.find((x) => x.type === t)?.value ?? "0"; return { wd: (["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(g("weekday")) + 1), h: Number(g("hour")), m: Number(g("minute")) } })()
  const nowMin = parts.h * 60 + parts.m
  return peak.ranges.some((r) => r.days.some((d) => { const a = minute(r.start), b = minute(r.end); return a < b ? d === parts.wd && nowMin >= a && nowMin < b : (d === parts.wd && nowMin >= a) || (d % 7 + 1 === parts.wd && nowMin < b) }))
}

/** Whether any provider's peak window is active (factual semantics: schedule only, ignores enabled; for display) */
export function providerPeakActive(now: Date, cfg: UserConfig, providerId: string): boolean {
  return peakEntryActive(now, providerEntry(cfg, providerId).peak)
}

/** [2026-08-31]-[Final review P1-1: routing-semantics peak — providers with enabled:false have their peak/watermark excluded from
 *  ranking (consistent with the template comment "whether watermark/peak/exhaustion participates in routing rank and hard block"); use providerPeakActive for display] */
export function routingPeakActive(now: Date, cfg: UserConfig, providerId: string): boolean {
  const entry = providerEntry(cfg, providerId)
  return entry.enabled && peakEntryActive(now, entry.peak)
}

export function evaluatePeakSchedules(now: Date, cfg: UserConfig, pool: Pool): boolean {
  return providerPeakActive(now, cfg, { copilot: "github-copilot", glm: "zhipuai-coding-plan", deepseek: "deepseek" }[pool] as ProviderKey)
}
