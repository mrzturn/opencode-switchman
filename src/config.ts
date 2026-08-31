import { existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { canonicalKeyOf, defaultProviderConfig, genericProviderDefaults, PROVIDER_KEYS, renderDefaultConfigJsonc, resolveProviderKey } from "./provider-config"
import type { PeakRange, ProviderKey, ProviderUserConfig } from "./provider-config"
import type { Pool, RoutePolicy } from "./types"

export interface ConfigDiagnostic { code: string; level: "error" | "warn" | "info"; path?: string; hint?: string }
// [2026-08-31]-[去厂商化：providers 开放化——任意 provider 键合法（opencode 官方/自定义），
//  billing 显式配置驱动订阅系数；内置三键仅作出厂缺省与配额池映射]
export interface UserConfig { version: number; providers: Record<string, ProviderUserConfig>; extensions: Record<string, unknown> }
export interface LoadedUserConfig { path: string; config: UserConfig; diagnostics: ConfigDiagnostic[]; generated: boolean }

export function resolveOpencodeConfigDir(env: Record<string, string | undefined> = process.env, home = homedir()): string {
  if (env.OPENCODE_CONFIG_DIR) return env.OPENCODE_CONFIG_DIR
  return join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode")
}

/** JSONC 仅移除注释和尾逗号，字符串/转义状态不参与剥离。 */
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
    const before = out.slice(0, pos); return { error: { line: before.split("\n").length, col: pos - before.lastIndexOf("\n"), message: "JSONC 解析失败" } }
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
  const defaults = { version: 1, providers: defaultProviderConfig(), extensions: {} as Record<string, unknown> }
  const filled = plain(fillMissing(value, defaults)) ? fillMissing(value, defaults) : structuredClone(defaults); const ds: ConfigDiagnostic[] = []
  if (!plain(filled.providers)) filled.providers = structuredClone(defaults.providers)
  // [2026-08-31]-[去厂商化：逐键校验扩展到任意 provider 键；内置键用规格缺省，自定义键用通用缺省（billing 默认 api）。
  //  字段缺省（undefined）=内存补齐不报错（自定义键最小配置友好）；类型坏值才给诊断并回退]
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
    // [2026-08-31]-[billing 字段：subscription|api 显式声明；非法值内存回退出厂缺省（SWM036）]
    if (p.billing === undefined) p.billing = def.billing
    else if (p.billing !== "subscription" && p.billing !== "api") { ds.push({ code: "SWM036", level: "error", path: `providers.${key}.billing` }); p.billing = def.billing }
    if (p.peak === undefined) p.peak = structuredClone(def.peak)
    else if (!plain(p.peak) || !validTimezone(p.peak.timezone)) { ds.push({ code: "SWM031", level: "error", path: `providers.${key}.peak.timezone` }); p.peak = structuredClone(def.peak) }
    else {
      const code = rangeDiagnostic(p.peak.ranges)
      if (code) { ds.push({ code, level: "error", path: `providers.${key}.peak.ranges` }); p.peak.ranges = structuredClone(def.peak.ranges) }
    }
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
  // 超限文件不得移动或覆盖；这是保护未知/误放入内容的 fail-open 边界。
  if (bad && existsSync(path) && !diagnostics.some((d) => d.code === "SWM003")) {
    try { if (!lstatSync(path).isSymbolicLink()) { const backup = `${path}.invalid-${Date.now()}-${process.pid}.bak`; renameSync(path, backup); if (writeTemplate(path)) diagnostics.push({ code: "SWM002", level: "info", path }) } } catch { /* 原文件必须保留 */ }
    raw = {}
  }
  const checked = validateUserConfig(raw); diagnostics.push(...checked.diagnostics)
  return { path, config: checked.config, diagnostics, generated: diagnostics.some((d) => d.code === "SWM002") }
}
export function routePolicy(config: UserConfig, legacy?: Partial<Record<Pool, boolean>>): RoutePolicy {
  const out: RoutePolicy = Object.create(null)
  for (const pool of ["copilot", "glm", "deepseek"] as Pool[]) { const p = config.providers[{ copilot: "github-copilot", glm: "glm-coding-plan-cn", deepseek: "deepseek-api" }[pool] as ProviderKey]; out[pool] = { observe: legacy?.[pool] ?? p.observe, routing: p.enabled } }
  return out
}

/** [2026-08-31]-[去厂商化：任意 provider 的有效配置解析——精确键→别名/前缀归一键→通用缺省；
 *  自定义键缺省＝不参与路由、可观察、api 计费、无高峰（内存补缺，不写回）] */
export function providerEntry(config: UserConfig, providerId: string): ProviderUserConfig {
  const direct = config.providers[providerId]
  if (direct && plain(direct)) {
    return (canonicalKeyOf(providerId) ? direct : { ...genericProviderDefaults(), ...direct }) as ProviderUserConfig
  }
  const hit = config.providers[resolveProviderKey(providerId)]
  if (hit && plain(hit)) return hit
  return structuredClone(genericProviderDefaults())
}

/** provider 计费结构（subscription|api）；唯一来源是用户 jsonc 显式声明（含出厂缺省） */
export function billingOfProvider(config: UserConfig, providerId: string): "subscription" | "api" {
  return providerEntry(config, providerId).billing
}

function peakEntryActive(now: Date, peak: ProviderUserConfig["peak"]): boolean {
  const parts = peak.timezone === "local" ? { wd: ((now.getDay() + 6) % 7) + 1, h: now.getHours(), m: now.getMinutes() } : (() => { const a = new Intl.DateTimeFormat("en-US", { timeZone: peak.timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now); const g = (t: string) => a.find((x) => x.type === t)?.value ?? "0"; return { wd: (["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(g("weekday")) + 1), h: Number(g("hour")), m: Number(g("minute")) } })()
  const nowMin = parts.h * 60 + parts.m
  return peak.ranges.some((r) => r.days.some((d) => { const a = minute(r.start), b = minute(r.end); return a < b ? d === parts.wd && nowMin >= a && nowMin < b : (d === parts.wd && nowMin >= a) || (d % 7 + 1 === parts.wd && nowMin < b) }))
}

/** 任意 provider 的高峰窗口是否活跃（事实口径：只看时刻表，不看 enabled；展示用） */
export function providerPeakActive(now: Date, cfg: UserConfig, providerId: string): boolean {
  return peakEntryActive(now, providerEntry(cfg, providerId).peak)
}

/** [2026-08-31]-[终审P1-1：路由口径高峰——enabled:false 的 provider 高峰/水位不参与排序（与
 *  模板注释「水位/高峰/耗尽是否参与路由排序与硬拦」一致）；展示口径用 providerPeakActive] */
export function routingPeakActive(now: Date, cfg: UserConfig, providerId: string): boolean {
  const entry = providerEntry(cfg, providerId)
  return entry.enabled && peakEntryActive(now, entry.peak)
}

export function evaluatePeakSchedules(now: Date, cfg: UserConfig, pool: Pool): boolean {
  return providerPeakActive(now, cfg, { copilot: "github-copilot", glm: "glm-coding-plan-cn", deepseek: "deepseek-api" }[pool] as ProviderKey)
}
