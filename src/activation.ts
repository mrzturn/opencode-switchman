// [2026-09-04]-[English localization: translate CLI messages and comments; no logic change]
// Activation matrix pure-function layer (v1.3): mode detection, desktop/TUI model state file parsing, activation-set computation
// [2026-08-29]-[Shell matrix static→dynamic: desktop = model-management visible set; CLI/TUI = favorites;
//  no visible/favorites → active session models only; session models = union of current models across all running main sessions]-
// [fail-open iron rule: missing file = empty (web localStorage not visible → fall back to session models); parse failure = unreadable
//  (treated as empty but flagged in the banner); all exceptions bubble to the caller's fallback, never blocking the hook main flow]
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ActivationState, MatrixConfigStatus, MatrixRunMode, ModelKey } from "./types"
import type { ShellDefinition } from "./catalog"

// [2026-08-29]-[Fix review P1 dual-root paths]-[desktop: electron-store cwd=userData (desktop/src/main/store.ts:18-20)
// and XDG_STATE_HOME=userData (desktop/src/main/server.ts:52) → stateRoot=userData/opencode,
// so opencode.global.dat sits one level above stateRoot; CLI: model.json is inside stateRoot (core/src/global.ts:14)]
export function desktopDatPath(stateRoot: string): string {
  return join(dirname(stateRoot), "opencode.global.dat")
}
export function tuiModelPath(stateRoot: string): string {
  return join(stateRoot, "model.json")
}
/** watch targets: [directory of global.dat (= stateRoot parent), stateRoot]; missing dirs are skipped by the caller */
export function watchDirs(stateRoot: string): [string, string] {
  return [dirname(stateRoot), stateRoot]
}

export type MatrixModeOption = "auto" | "app" | "tui" | "legacy"

/** mode detection: explicit override wins; auto=OPENCODE_CLIENT==="desktop" → desktop, everything else cli */
export function detectMode(forced: MatrixModeOption | undefined, client: string | undefined): MatrixRunMode {
  if (forced === "legacy") return "legacy"
  if (forced === "app") return "desktop"
  if (forced === "tui") return "cli"
  return client === "desktop" ? "desktop" : "cli"
}

/** Dedupe + lexicographic stable sort */
export function sortUnique(keys: readonly string[]): ModelKey[] {
  return [...new Set(keys)].sort() as ModelKey[]
}

function toModelKey(providerID: unknown, modelID: unknown): ModelKey | null {
  return typeof providerID === "string" && providerID && typeof modelID === "string" && modelID
    ? (`${providerID}/${modelID}` as ModelKey)
    : null
}

function parseJsonish(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/** desktop opencode.global.dat model.user → visibility==="show" set (bad structure = null)
 *  [2026-08-29]-[Fix review P1 duplicate-model aggregation: hide overrides show (any visibility other than "show" is excluded)]-[prevents hidden models sneaking into the activation surface via duplicate entries] */
export function parseDesktopModels(dat: unknown): ModelKey[] | null {
  const root = parseJsonish(dat)
  if (!root || typeof root !== "object") return null
  const model = parseJsonish((root as any).model)
  if (!model || typeof model !== "object" || !Array.isArray((model as any).user)) return null
  const shown = new Map<string, boolean>()
  for (const e of (model as any).user) {
    const k = toModelKey(e?.providerID, e?.modelID)
    if (!k) continue
    shown.set(k, (shown.get(k) ?? true) && e?.visibility === "show")
  }
  return sortUnique([...shown].filter(([, v]) => v).map(([k]) => k))
}

/** TUI model.json favorite[] → set (bad structure = null) */
export function parseTuiFavorites(dat: unknown): ModelKey[] | null {
  const root = parseJsonish(dat)
  if (!root || typeof root !== "object" || !Array.isArray((root as any).favorite)) return null
  const out: ModelKey[] = []
  for (const e of (root as any).favorite) {
    const k = toModelKey(e?.providerID, e?.modelID)
    if (k) out.push(k)
  }
  return sortUnique(out)
}

export interface ConfiguredRead { configStatus: MatrixConfigStatus; models: ModelKey[] }

/** Read the config surface for the current mode (desktop=userData/opencode.global.dat visible set; cli=stateRoot/model.json favorites) */
export function readConfigured(stateRoot: string, mode: "desktop" | "cli"): ConfiguredRead {
  // [2026-08-29]-[Fix review P1 dual-root paths: the desktop file lives in stateRoot's parent dir (userData); CLI reads model.json only]
  const file = mode === "desktop" ? desktopDatPath(stateRoot) : tuiModelPath(stateRoot)
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    return { configStatus: "empty", models: [] } // missing = empty (the other client's shape / web has no such file by nature)
  }
  let dat: unknown
  try {
    dat = JSON.parse(raw)
  } catch {
    return { configStatus: "unreadable", models: [] }
  }
  const parsed = mode === "desktop" ? parseDesktopModels(dat) : parseTuiFavorites(dat)
  if (parsed === null) return { configStatus: "unreadable", models: [] }
  return { configStatus: parsed.length > 0 ? "ok" : "empty", models: parsed }
}

export interface ActivationInput {
  generation: number
  mode: MatrixRunMode
  configStatus: MatrixConfigStatus
  configured: readonly ModelKey[]
  /** Active non-shell session models (raw union, deduped and sorted internally) */
  sessionModels: readonly ModelKey[]
  shellsByModel: ReadonlyMap<ModelKey, readonly ShellDefinition[]>
  knownProviders: ReadonlySet<string>
}

/** Activation-set computation: the dispatch range is narrowed only when configured (visible set/favorites) is non-empty; with no visible set configured,
 *  the full injected superset is dispatchable by default; sessionModels are only used for addition (no narrowing) and restartRequired detection —
 *  when a visible set is configured it takes priority for narrowing.
 *  [2026-09-01]-[Semantics change: the old "activeModels=configured∪sessionModels" would narrow candidates to the single model used by the
 *  current session whenever the user had sent a message without configuring a visible set — effectively "everything else unavailable";
 *  user requirement: no visible set = no restriction, everything dispatchable; only a configured visible set narrows by it] */
export function computeActivation(input: ActivationInput): ActivationState {
  const configured = sortUnique(input.configured)
  const sessionModels = sortUnique(input.sessionModels)
  const activeModels = sortUnique([...configured, ...sessionModels])
  const activeShells = new Set<string>()
  const restartRequired = new Set<string>()
  const invalidConfigured = new Set<ModelKey>()
  // restartRequired: regardless of narrowing, any model actually used by a non-shell session that is outside the superset with an unknown provider must prompt a restart
  for (const mk of activeModels) {
    const slash = mk.indexOf("/")
    const provider = slash > 0 ? mk.slice(0, slash) : ""
    const defs = input.shellsByModel.get(mk)
    if (!defs || defs.length === 0) {
      if (provider && !input.knownProviders.has(provider)) restartRequired.add(provider)
      // [2026-09-01]-[Provider known but no shell found for the modelId = dirty favorite — not "restart required" but "invalid config itself",
      //  classified separately to avoid confusion with genuinely new providers pending registration, and to avoid being silently dropped with no diagnosis]
      else if (provider && input.knownProviders.has(provider) && configured.includes(mk)) invalidConfigured.add(mk)
    }
  }
  const configuredShells = configured.some((mk) => input.shellsByModel.has(mk))
  if (!configuredShells) {
    // No visible set configured: the full injected superset is dispatchable by default (not narrowed by sessionModels)
    for (const defs of input.shellsByModel.values()) {
      for (const d of defs) activeShells.add(d.name)
    }
  } else {
    for (const mk of activeModels) {
      const defs = input.shellsByModel.get(mk)
      if (defs && defs.length > 0) for (const d of defs) activeShells.add(d.name)
    }
  }
  return {
    generation: input.generation,
    mode: input.mode,
    configStatus: input.configStatus,
    configured,
    sessionModels,
    activeModels,
    activeShells: [...activeShells].sort(),
    restartRequired: [...restartRequired].sort(),
    invalidConfigured: [...invalidConfigured].sort(),
  }
}


/** provider.list response shape normalization (pure function)
 *  [2026-08-29]-[Fix delta review P1: the hey-api client leaves responseStyle unset so client.provider.list() actually returns
 *  the {data:{all,connected,default},...} wrapper; also compatible with direct {all,connected} and bare arrays. Returns null = unrecognized shape] */
export function normalizeProviderListResponse(resp: unknown): { providers: any[]; connected: Set<string> | null } | null {
  const raw = (resp ?? {}) as any
  const obj = raw?.data ?? raw
  const providers: any[] = Array.isArray(resp) ? resp
    : Array.isArray(obj.all) ? obj.all
      : Array.isArray(obj.data) ? obj.data
        : []
  const connected = Array.isArray(obj.connected) ? new Set<string>(obj.connected.map((x: any) => String(x))) : null
  if (providers.length === 0 && !Array.isArray(resp)) return null
  return { providers, connected }
}

/** State equivalence (excluding generation): equivalent → short-circuit recompute, no bump, no cache clear
 *  [2026-08-29]-[Fix review P1 full-field comparison: configured/sessionModels must be element-wise equal (equal active unions alone
 *  must not short-circuit — the snapshot after a model switch must reflect the new session info, or snapshot/persistence drift from real state)] */
export function sameActivation(a: ActivationState, b: ActivationState): boolean {
  return a.mode === b.mode
    && a.configStatus === b.configStatus
    && eqList(a.configured, b.configured)
    && eqList(a.sessionModels, b.sessionModels)
    && eqList(a.activeModels, b.activeModels)
    && eqList(a.activeShells, b.activeShells)
    && eqList(a.restartRequired, b.restartRequired)
    && eqList(a.invalidConfigured, b.invalidConfigured)
}
function eqList(x: readonly string[], y: readonly string[]): boolean {
  return x.length === y.length && x.join("\u0000") === y.join("\u0000")
}
