// [2026-09-04]-[English localization: translate comments and status messages; no logic change]
// Shared shell generator (used by scripts/gen-shells.ts and runtime superset injection) + models.dev catalog cache
// [2026-08-29]-[shell matrix static->dynamic: extracted the gen-shells naming/lane/family logic into shared pure functions;
//  the runtime superset and the static manifest are generated from the same source, gen:shells output semantics unchanged]-
// [fail-open iron rule: catalog fetch failure -> stale cache -> implicit metadata from bundled shells.json -> single-lane off degradation, never blocks injection]
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { paths, readJson, writeJsonAtomic, appendStatusLog } from "./state"
import manifestDefault from "./shells.json"
import type { ShellManifestEntry } from "./types"
import { poolForProviderId } from "./provider-config"

export type Effort = string
export interface EffortInfo { efforts: string[]; toggle: boolean; vision: boolean; /** [2026-09-01]-[models.dev status=deprecated: rotated off the shelf (free models update daily, old -free ones get marked deprecated)] */ deprecated?: boolean }
export interface ShellDefinition {
  name: string
  provider: string
  modelId: string
  pool: string
  quotaPool?: string
  family: string
  effort: Effort
  capability: "rw" | "ro"
  vision: boolean
  matrixKey: string // provider|modelId|effort
  degraded?: boolean // no metadata source at all (runtime-only flag)
}

// ---- naming and family (identical to the original gen-shells entry by entry) ----
const SHORT: Record<string, string> = {
  "gpt-5.6-luna": "luna", "gpt-5.6-terra": "terra", "gpt-5.6-sol": "sol",
  "gpt-5.5": "55", "gpt-5.4": "54", "gpt-5.4-mini": "54mini", "gpt-5.4-nano": "54nano",
  "gpt-5.3-codex": "53codex", "gpt-5.2": "52", "gpt-5.2-codex": "52codex", "gpt-5-mini": "5mini",
  "claude-sonnet-5": "claude5", "claude-sonnet-4.6": "claude46", "claude-sonnet-4.5": "claude45", "claude-sonnet-4": "claude4",
  "claude-opus-5": "opus5", "claude-opus-4.8": "opus48", "claude-opus-4.7": "opus47", "claude-opus-4.6": "opus46",
  "claude-opus-4.5": "opus45", "claude-fable-5": "fable5", "claude-haiku-4.5": "haiku45",
  "gemini-3.1-pro-preview": "gem31pro", "gemini-3.5-flash": "gem35f", "gemini-3.6-flash": "gem36f", "gemini-3.7-flash": "gem37f",
  "grok-4.5": "grok45", "grok-4.6": "grok46",
  "kimi-k2.7-code": "k27code", "kimi-k3": "k3",
  "mai-code-1-flash-picker": "mai1fp", "mai-code-1.1-flash": "mai11f",
  "glm-5.3": "53", "glm-5.3-flash": "53f", "glm-5.3-highspeed": "53hs", "glm-5.2-highspeed": "52hs",
  "glm-5.2": "52", "glm-5.1": "51", "glm-5-turbo": "5t", "glm-4.7": "47",
  "glm-4.6v": "46v", "glm-5v-turbo": "5vt", "glm-4.5-air": "45air",
  "deepseek-v4-flash": "v4f", "deepseek-v4-flash-vision-exp": "v4fv", "deepseek-v4-pro": "v4p",
  "big-pickle": "bigpickle", "hy3-free": "hy3", "mimo-v2.5-free": "mimo",
  "muse-spark-1.2-contributor-free": "muse", "nemotron-3-ultra-free": "nemo3u", "nemotron-3.5-lightning-free": "nemo35l",
}
export function shortOf(modelId: string): string {
  if (SHORT[modelId]) return SHORT[modelId]
  if (modelId.endsWith("-fast") && SHORT[modelId.slice(0, -5)]) return `${SHORT[modelId.slice(0, -5)]}fast`
  return modelId.replace(/[^a-zA-Z0-9]/g, "")
}
export function familyOf(modelId: string): string {
  const m = /^(claude|gpt|gemini|grok|kimi|glm|deepseek|mai)/.exec(modelId)
  return m ? m[1] : modelId.split(/[^a-zA-Z]/)[0] || "unknown"
}
export function poolOf(provider: string): string {
  const pool = poolForProviderId(provider)
  if (pool) return pool
  return "zen"
}
const EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
export function canonEffort(e: string): string {
  return e === "none" ? "off" : e
}
export function sortEfforts(efforts: Iterable<string>): string[] {
  return [...new Set(efforts)].sort((a, b) => {
    const ia = EFFORT_ORDER.indexOf(a), ib = EFFORT_ORDER.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
}

/** Stable short hash (FNV-1a -> first 4 base36 chars): collision suffix independent of iteration order */
export function stableHash(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36).slice(0, 4).padStart(4, "0")
}

// ---- models.dev parsing (pure function) ----
export function parseModelsDevApi(data: Record<string, any>): Record<string, EffortInfo> {
  const out: Record<string, EffortInfo> = {}
  for (const [prov, p] of Object.entries(data)) {
    for (const [mid, m] of Object.entries((p as any)?.models ?? {})) {
      const opts = Array.isArray((m as any)?.reasoning_options) ? (m as any).reasoning_options : []
      const efforts: string[] = []
      let toggle = false
      for (const o of opts) {
        if (o?.type === "toggle") toggle = true
        if (o?.type === "effort" && Array.isArray(o.values)) {
          for (const v of o.values) efforts.push(String(v))
        }
      }
      const modalIn = Array.isArray((m as any)?.modalities?.input) ? (m as any).modalities.input : []
      out[`${prov}/${mid}`] = {
        efforts,
        toggle,
        vision: (m as any)?.attachment === true || modalIn.includes("image"),
        ...( (m as any)?.status === "deprecated" ? { deprecated: true } : {} ),
      }
    }
  }
  return out
}

/** Direct fetch (for scripts; runtime goes through the loadCatalog cache) */
export async function fetchModelsDevIndex(etag?: string | null): Promise<{ index: Record<string, EffortInfo>; etag: string | null; notModified: boolean }> {
  const res = await fetch("https://models.dev/api.json", {
    headers: { Accept: "application/json", "User-Agent": "opencode-switchman/0.1", ...(etag ? { "If-None-Match": etag } : {}) },
    signal: AbortSignal.timeout(20_000),
  })
  if (res.status === 304) return { index: {}, etag: etag ?? null, notModified: true }
  if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`)
  const index = parseModelsDevApi(await res.json() as Record<string, any>)
  return { index, etag: res.headers.get("etag"), notModified: false }
}

// ---- state dir cache (ETag + TTL 24h; stale cache on failure) ----
export const CATALOG_TTL_MS = 24 * 3600_000
interface CatalogCache { fetched_at: number; etag: string | null; index: Record<string, EffortInfo> }

export interface CatalogResult { index: Record<string, EffortInfo>; status: "ok" | "stale" | "none"; etag: string | null }

export function loadCatalog(now = Date.now()): Promise<CatalogResult> {
  const p = paths().modelCatalog
  const cache = readJson<CatalogCache>(p)
  if (cache?.index && typeof cache.fetched_at === "number" && now - cache.fetched_at < CATALOG_TTL_MS) {
    return Promise.resolve({ index: cache.index, status: "ok", etag: cache.etag ?? null })
  }
  return fetchModelsDevIndex(cache?.etag ?? null).then(
    (r) => {
      if (r.notModified) {
        writeJsonAtomic(p, { ...(cache as CatalogCache), fetched_at: now } satisfies CatalogCache)
        return { index: (cache as CatalogCache).index, status: "ok" as const, etag: r.etag }
      }
      writeJsonAtomic(p, { fetched_at: now, etag: r.etag, index: r.index } satisfies CatalogCache)
      return { index: r.index, status: "ok" as const, etag: r.etag }
    },
    (exc) => {
      if (cache?.index) return { index: cache.index, status: "stale" as const, etag: cache.etag ?? null }
      appendStatusLog(`models.dev catalog unavailable and no cache (fail-open degradation): ${exc}`)
      return { index: {}, status: "none" as const, etag: null }
    },
  )
}

/** Implicit metadata from the bundled shells.json (model -> lane/vision fallback source; better than single-lane degradation on a cold start with no network) */
export function bundledModelIndex(): Record<string, EffortInfo> {
  const out: Record<string, EffortInfo> = {}
  for (const s of (manifestDefault as any).shells as ShellManifestEntry[]) {
    const key = `${s.provider}/${s.modelId}`
    const info = out[key] ?? { efforts: [], toggle: false, vision: s.vision }
    info.efforts.push(s.effort)
    if (s.effort === "off") info.toggle = true
    info.vision = info.vision || s.vision
    out[key] = info
  }
  return out
}

// [2026-09-01]-[superset floor source change: opencode's bundled free models (OpenCode Zen = the models.dev opencode provider)
//  replace the static manifest -- free models rotate daily with the official catalog, a hard-coded list inevitably goes stale;
//  free = id ending in -free union a special-case set (big-pickle and other official in-house free models without the suffix),
//  and status != deprecated (rotated-off old free models get marked deprecated; today's usable set is usually single-digit).
//  Goes through the loadCatalog cache (24h TTL + stale fallback).
//  Only affects the shell-existence floor; dispatchability is still decided by the activation surface (config surface union sessions) and credential gating]
export const FLOOR_PROVIDER = "opencode" // OpenCode Zen
/** Official models that are free without a -free suffix (special-case set verified against the catalog) */
export const FLOOR_FREE_EXTRA = new Set(["big-pickle"])

/** Extract full keys (provider/modelId) of free floor models from the models.dev catalog index */
export function freeFloorModels(index: Record<string, EffortInfo>): string[] {
  const prefix = `${FLOOR_PROVIDER}/`
  return Object.keys(index)
    .filter((k) => k.startsWith(prefix))
    .filter((k) => !index[k]?.deprecated)
    .map((k) => k.slice(prefix.length))
    .filter((mid) => mid.endsWith("-free") || FLOOR_FREE_EXTRA.has(mid))
    .filter((mid) => isConversational(mid))
    .map((mid) => `${FLOOR_PROVIDER}/${mid}`)
    .sort()
}

// ---- superset expansion (model x lane -> shell definitions) ----
export interface BuildShellsOpts {
  /** Static ro marker set (for gen-shells, by shell name) */
  roSet?: Set<string>
  /** Runtime: append a -ro alias shell per lane for review (shared matrixKey = shared probe combo) */
  roAliases?: boolean
  /** Metadata-less models get family=providerID (runtime degradation calibration; the script path keeps familyOf) */
  degradedFamilyByProvider?: boolean
  /** Mark the degraded field (runtime only; gen:shells output unchanged) */
  markDegraded?: boolean
}

/** Short-name collision = all members get a stable hash suffix (independent of input order; without collisions the output matches the original gen-shells field by field) */
export function buildShells(models: string[], metaIndex: Record<string, EffortInfo>, opts: BuildShellsOpts = {}): ShellDefinition[] {
  const uniq = [...new Set(models)]
  const slashOf = (full: string) => full.indexOf("/")
  const group = new Map<string, string[]>()
  const shortMap = new Map<string, string>()
  for (const full of uniq) {
    const slash = slashOf(full)
    if (slash <= 0 || slash === full.length - 1) continue
    const short = shortOf(full.slice(slash + 1))
    shortMap.set(full, short)
    const gk = `${poolOf(full.slice(0, slash))}|${short}`
    const list = group.get(gk) ?? []
    list.push(full)
    group.set(gk, list)
  }
  for (const list of group.values()) {
    if (list.length <= 1) continue
    for (const full of list) shortMap.set(full, `${shortMap.get(full)}h${stableHash(full)}`)
  }

  const shells: ShellDefinition[] = []
  const seen = new Set<string>()
  for (const full of uniq) {
    const slash = slashOf(full)
    if (slash <= 0 || slash === full.length - 1) continue
    const provider = full.slice(0, slash)
    const modelId = full.slice(slash + 1)
    const pool = poolOf(provider)
    const info = metaIndex[full]
    // Lane assembly: metadata (toggle->off; effort values kept as-is) -> metadata-less single-lane off
    let efforts: string[] = ["off"]
    let vision = false
    if (info) {
      const vals = info.efforts.map(canonEffort).filter((e) => e !== "none")
      if (vals.length > 0 || info.toggle) {
        efforts = sortEfforts(info.toggle ? ["off", ...vals] : vals.length > 0 ? vals : ["off"])
      }
      vision = info.vision
    }
    const family = info || !opts.degradedFamilyByProvider ? familyOf(modelId) : provider
    for (const effort of efforts) {
      const name = `${pool === "deepseek" ? "ds" : pool}-mx-${shortMap.get(full)}-${effort}`
      if (seen.has(name)) continue
      seen.add(name)
      shells.push({
        name,
        provider,
        modelId,
        pool,
        family,
        effort,
        capability: opts.roSet?.has(name) ? "ro" : "rw",
        vision,
        matrixKey: `${provider}|${modelId}|${effort}`,
        ...(opts.markDegraded && !info ? { degraded: true } : {}),
      })
      // [2026-08-29]-[review -ro alias shell: shares the probe combo with the rw shell (same matrixKey); probes dedupe by key]-
      if (opts.roAliases && !opts.roSet?.has(name)) {
        const alias = `${name}-ro`
        if (!seen.has(alias)) {
          seen.add(alias)
          shells.push({
            name: alias, provider, modelId, pool, family, effort,
            capability: "ro", vision, matrixKey: `${provider}|${modelId}|${effort}`,
            ...(opts.markDegraded && !info ? { degraded: true } : {}),
          })
        }
      }
    }
  }
  return shells
}

/** ShellDefinition -> ShellManifestEntry (reused by the registry/injection) */
export function toManifestEntry(d: ShellDefinition): ShellManifestEntry {
  return {
    name: d.name, pool: d.pool as ShellManifestEntry["pool"], provider: d.provider,
    modelId: d.modelId, effort: d.effort, family: d.family as ShellManifestEntry["family"],
    capability: d.capability, vision: d.vision, matrixKey: d.matrixKey,
  }
}

/** Exclude embedding-class models (non-conversational) */
export function isConversational(modelId: string): boolean {
  return !/embed|rerank|embedding/i.test(modelId)
}

/** Read raw file content (for tests/debugging) */
export function readTextIfExists(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return null
  }
}

export const catalogFileName = "model-catalog.json"
export function catalogPathOf(dir: string): string {
  return join(dir, catalogFileName)
}
