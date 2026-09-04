// [2026-09-04]-[English localization: translate comments and status messages; no logic change]
// Dynamic matrix manager (v1.3): session registry, state dir watch, recompute orchestration, probe diff
// [2026-08-29]-[fix review-P1 first-turn ordering: system.transform runs before chat.params (opencode session/llm/request.ts:69-73 vs 114-121);
// the first-turn registry is empty -> shell subagents got the dispatcher protocol wrongly injected. fix=listen to session.created
// pre-registration (record the agent name) + classify only by agent name: injected shell names union internal agents, independent of registry timing]
import { watch, statSync, type FSWatcher } from "node:fs"
import { readJson, writeJsonAtomic, paths, nowIso, appendStatusLog } from "./state"
import { readConfigured, computeActivation, sameActivation, sortUnique, desktopDatPath, tuiModelPath, watchDirs } from "./activation"
import type { ActivationState, MatrixRunMode, ModelKey } from "./types"
import type { ShellDefinition } from "./catalog"

// Internal agents (title/compaction/summary): have an agent field but do not count as session models
export const INTERNAL_AGENTS = new Set(["title", "compaction", "summary"])
/** Watched target filenames (watchDirs[0]=global.dat dir; watchDirs[1]=stateRoot) */
const WATCH_FILENAMES = new Set(["opencode.global.dat", "model.json"])

export interface SessionInfo {
  agent: string
  modelKey: ModelKey | null
  isShell: boolean
  updatedAt: number
}

export interface MatrixManagerOptions {
  stateRoot: string
  mode: Exclude<MatrixRunMode, "legacy">
  superset: readonly ShellDefinition[]
  /** Shell names successfully injected by the config hook (sole source of truth for isShell; heuristics forbidden) */
  injectedNames: ReadonlySet<string>
  /** Providers known within the superset (outside the superset -> restartRequired) */
  knownProviders: ReadonlySet<string>
  watchEnabled?: boolean
  debounceMs?: number
  pollMs?: number
  /** Recompute callback: clear the banner cache + submit the probe diff; source distinguishes the trigger (config=visible set/favorites change) */
  onRecompute?: (state: ActivationState, newTargets: string[], source: RecomputeSource) => void
}

/** Recompute trigger sources: config=config-surface file change (desktop visible-set toggles/TUI favorites add-remove);
 *  session=session model switch/delete; startup=config hook direct first-turn call */
export type RecomputeSource = "config" | "session" | "startup"

export const WATCH_DEBOUNCE_MS = 500
// [2026-09-02]-[30s->2s: measured fs.watch events are not delivered inside the opencode host process (a standalone Bun script
// in the same dir works; a real in-plugin favorites change took 22s to be caught by the 30s poll), so mtime polling is the
// actually effective path; statSync x2 per 2s is negligible, 2s poll+500ms debounce ~= favorites changes effective within 2.5s]-[favorites/visible-set changes visible immediately]
export const WATCH_POLL_MS = 2_000
const PARSE_RETRY_MS = 150
const PARSE_RETRIES = 2

export class MatrixManager {
  readonly sessions = new Map<string, SessionInfo>()
  private readonly opts: Required<Pick<MatrixManagerOptions, "watchEnabled" | "debounceMs" | "pollMs">> & MatrixManagerOptions
  private readonly shellsByModel = new Map<ModelKey, ShellDefinition[]>()
  private readonly defByName = new Map<string, ShellDefinition>()
  private current_: ActivationState
  private lastActiveKeys = new Set<string>()
  private watchers: FSWatcher[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private lastMtimes: [number, number] = [0, 0]
  private stopped = false
  private pendingSource: RecomputeSource = "startup"
  // [2026-09-02]-[config-source net-zero feedback throttle: restored favorites/only-recent changes still bump mtime and trigger
  // recompute, but an unchanged activation set = total silence, so users think watching is broken; 10s throttle prevents spam
  // from rapid toggling]
  private lastConfigNoopNoticeMs = 0

  constructor(options: MatrixManagerOptions) {
    this.opts = { watchEnabled: true, debounceMs: WATCH_DEBOUNCE_MS, pollMs: WATCH_POLL_MS, ...options }
    for (const d of this.opts.superset) {
      const mk = `${d.provider}/${d.modelId}` as ModelKey
      const list = this.shellsByModel.get(mk) ?? []
      list.push(d)
      this.shellsByModel.set(mk, list)
      this.defByName.set(d.name, d)
    }
    this.current_ = computeActivation({
      generation: 0, mode: this.opts.mode, configStatus: "empty",
      configured: [], sessionModels: [],
      shellsByModel: this.shellsByModel, knownProviders: this.opts.knownProviders,
    })
  }

  /** session.created pre-registration: the event precedes first-turn chat.params/transform, so transform can classify by agent name from the first turn */
  noteSessionCreated(sessionID: string | undefined, agent: string | undefined): boolean {
    if (this.stopped || !sessionID || !agent) return false
    if (this.sessions.has(sessionID)) return false
    this.sessions.set(sessionID, { agent, modelKey: null, isShell: this.opts.injectedNames.has(agent), updatedAt: Date.now() })
    return true
  }

  /** chat.params classification (agent name sole source of truth): injected shell names -> isShell; title/compaction/summary -> ignore;
   *  the rest (incl. user-defined subagents) -> registered as main sessions. Returns whether the activation matrix is affected */
  noteChatParams(sessionID: string | undefined, agent: string | undefined, modelKey: ModelKey | null): boolean {
    if (this.stopped || !sessionID || !agent) return false
    if (INTERNAL_AGENTS.has(agent)) return false
    const isShell = this.opts.injectedNames.has(agent)
    const prev = this.sessions.get(sessionID)
    this.sessions.set(sessionID, { agent, modelKey, isShell, updatedAt: Date.now() })
    // Shell sessions do not enter the activation matrix; only non-shell session model changes need a recompute
    return !isShell && modelKey !== null && (prev?.modelKey ?? null) !== modelKey
  }

  /** session.deleted: remove the session registry entry. Returns whether a non-shell model was removed (needs recompute) */
  noteSessionDeleted(sessionID: string): boolean {
    const prev = this.sessions.get(sessionID)
    this.sessions.delete(sessionID)
    return Boolean(prev && !prev.isShell && prev.modelKey)
  }

  /** Union of non-shell session models (instant snapshot) */
  sessionModelKeys(): ModelKey[] {
    const out = new Set<string>()
    for (const s of this.sessions.values()) {
      if (!s.isShell && s.modelKey) out.add(s.modelKey)
    }
    return sortUnique([...out] as ModelKey[])
  }

  isShellSession(sessionID: string): boolean {
    return this.sessions.get(sessionID)?.isShell ?? false
  }

  /** transform-phase system-injection skip check: shell sessions union internal agents (title/compaction/summary) --
   *  classified by the agent name in pre-registration/registry, effective from the first turn (session.created pre-registration) */
  skipSystemInjection(sessionID: string): boolean {
    const s = this.sessions.get(sessionID)
    return Boolean(s && (s.isShell || INTERNAL_AGENTS.has(s.agent)))
  }

  snapshot(): ActivationState {
    return this.current_
  }

  /** Current active combo matrixKey set (-ro aliases share keys with rw, naturally deduped) */
  activeMatrixKeys(): string[] {
    const out = new Set<string>()
    for (const name of this.current_.activeShells) {
      const d = this.defByName.get(name)
      if (d) out.add(d.matrixKey)
    }
    return [...out].sort()
  }

  /** Synchronous recompute: read config surface -> union -> persist; state-equivalence short-circuit (no generation bump/no cache clear)
   *  [2026-08-29]-[fix review-P1 write race: this method is fully synchronous (read-compute-write without await) -> naturally
   *  atomic in-process; the model-matrix.json read-modify-write completes synchronously (in-process atomic); async probe writes
   *  serialize via withPathLock plus a generation check on completion that discards stale rounds; interleaving of the two is
   *  guarded by the generation check; cross-process safety relies on unique tmp+rename so files are never corrupted]-
   *  [2026-08-29]-[trigger source pass-through: watch/poll=config, chat.params/session.deleted=session, direct call=startup;
   *  lets onRecompute pick the probe scope by source (config->all active combos, others->only new ones)] */
  recompute(configured?: { configStatus: ActivationState["configStatus"]; models: ModelKey[] }, source: RecomputeSource = "startup"): ActivationState {
    const read = configured ?? readConfigured(this.opts.stateRoot, this.opts.mode)
    const next = computeActivation({
      generation: this.current_.generation + 1,
      mode: this.opts.mode,
      configStatus: read.configStatus,
      configured: read.models,
      sessionModels: this.sessionModelKeys(),
      shellsByModel: this.shellsByModel,
      knownProviders: this.opts.knownProviders,
    })
    if (sameActivation(this.current_, next)) {
      // [2026-09-02]-[config-surface net-zero change feedback: mtime changed but favorites/visible-set content and the activation
      // set are unchanged -- previously no gen bump/no notice/no sidebar rewrite = "no reaction" from the user's view; for the
      // config source emit one throttled status log so any favorites-area operation gets a perceivable receipt; session/startup
      // sources are internal scheduling and stay silent]
      if (source === "config" && Date.now() - this.lastConfigNoopNoticeMs > 10_000) {
        this.lastConfigNoopNoticeMs = Date.now()
        appendStatusLog(`favorites/visible set scanned: activation unchanged (gen=${this.current_.generation}; no recompute, no re-probe)`)
      }
      return this.current_
    }
    if (next.invalidConfigured.length > 0) {
      // [2026-09-01]-[hardening: dirty data in favorites/visible set where the provider is known but no shell exists for the
      // modelId (e.g. accidentally favoriting "provider/not-a-model") was silently dropped with no diagnosis; sameActivation
      // already short-circuits dedup, so log once only on a real change, no spam]
      appendStatusLog(`visible set/favorites contain invalid models (provider known but no such modelId, no shell generated): ${next.invalidConfigured.join(", ")}`)
    }
    const prevKeys = new Set(this.lastActiveKeys)
    const activeKeys = new Set(this.activeMatrixKeysOf(next))
    const newTargets = [...activeKeys].filter((k) => !prevKeys.has(k)).sort()
    this.lastActiveKeys = new Set([...prevKeys, ...activeKeys])
    this.current_ = next
    try {
      writeJsonAtomic(paths().activeMatrix, { ...next, updated_at: nowIso() })
      // model-matrix.json gains active_keys/target_generation (synchronous read-modify-write preserves the probe fields; stale probe rounds are discarded by the generation check)
      const m = readJson<Record<string, unknown>>(paths().matrix)
      writeJsonAtomic(paths().matrix, { ...(m ?? {}), active_keys: [...activeKeys], target_generation: next.generation })
    } catch (exc) {
      appendStatusLog(`activation matrix persist fail-open: ${exc}`)
    }
    try {
      this.opts.onRecompute?.(next, newTargets, source)
    } catch (exc) {
      appendStatusLog(`activation matrix callback fail-open: ${exc}`)
    }
    return next
  }

  private activeMatrixKeysOf(state: ActivationState): string[] {
    const out = new Set<string>()
    for (const name of state.activeShells) {
      const d = this.defByName.get(name)
      if (d) out.add(d.matrixKey)
    }
    return [...out]
  }

  /** Async recompute (watch/poll/session triggered): short retry on unreadable (guards atomic rename races) */
  async recomputeWithRetry(): Promise<ActivationState> {
    let read = this.readConfiguredSafe()
    for (let i = 0; i < PARSE_RETRIES && read.configStatus === "unreadable"; i++) {
      await new Promise((r) => setTimeout(r, PARSE_RETRY_MS))
      read = this.readConfiguredSafe()
    }
    return this.recompute(read, this.pendingSource)
  }

  private readConfiguredSafe(): { configStatus: ActivationState["configStatus"]; models: ModelKey[] } {
    try {
      return readConfigured(this.opts.stateRoot, this.opts.mode)
    } catch (exc) {
      appendStatusLog(`config surface read fail-open (treated as empty): ${exc}`)
      return { configStatus: "empty", models: [] }
    }
  }

  private targetFiles(): [string, string] {
    // [2026-08-29]-[fix review-P1 dual-root paths: global.dat lives in stateRoot's parent dir (userData), model.json in stateRoot]
    return [desktopDatPath(this.opts.stateRoot), tuiModelPath(this.opts.stateRoot)]
  }

  /** Start watch (two dir levels, silently skip missing dirs) + mtime polling fallback */
  start(): void {
    if (this.stopped || !this.opts.watchEnabled) return
    // [2026-08-29]-[fix review-P1 dual-root paths: watch stateRoot's parent dir (global.dat) and stateRoot (model.json) separately]
    const dirs = watchDirs(this.opts.stateRoot)
    for (const dir of dirs) {
      try {
        const w = watch(dir, { recursive: false }, (_event, filename) => {
          if (!filename) return this.scheduleRecompute()
          if (WATCH_FILENAMES.has(String(filename))) this.scheduleRecompute()
        })
        // [2026-09-02]-[log runtime errors: previously swallowed in pure silence, undiagnosable when fs.watch does not deliver inside the host]-[observability]
        w.on("error", (exc) => appendStatusLog(`fs.watch(${dir}) errored, falling back to mtime polling: ${exc}`))
        this.watchers.push(w)
      } catch (exc) {
        // Dir missing (the other host form naturally lacks this file) -> silently skip with the polling fallback; dir exists but watch failed to start (e.g. fd exhaustion) -> log
        try {
          if (statSync(dir).isDirectory()) appendStatusLog(`fs.watch(${dir}) failed to start, falling back to mtime polling: ${exc}`)
        } catch { /* dir missing: expected, silent */ }
      }
    }
    this.refreshMtimes()
    this.pollTimer = setInterval(() => {
      try {
        const [a, b] = this.targetFiles()
        const now: [number, number] = [fileMtimeOf(a), fileMtimeOf(b)]
        if (now[0] !== this.lastMtimes[0] || now[1] !== this.lastMtimes[1]) {
          this.lastMtimes = now
          this.scheduleRecompute()
        }
      } catch { /* fail-open */ }
    }, this.opts.pollMs)
    unref(this.pollTimer)
  }

  private refreshMtimes(): void {
    const [a, b] = this.targetFiles()
    this.lastMtimes = [fileMtimeOf(a), fileMtimeOf(b)]
  }

  /** [2026-08-29]-[trigger source parameter: watch/poll defaults to config (visible-set toggles/favorites add-remove -> full
   *  re-probe); session sources are passed explicitly by chat.params/session.deleted (probe only new combos)] */
  scheduleRecompute(delay?: number, source: RecomputeSource = "config"): void {
    if (this.stopped) return
    this.pendingSource = source
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null
      this.recomputeWithRetry().catch((exc) => appendStatusLog(`recompute fail-open: ${exc}`))
      this.refreshMtimes()
    }, delay ?? this.opts.debounceMs)
    unref(this.debounceTimer)
  }

  stop(): void {
    this.stopped = true
    for (const w of this.watchers) {
      try {
        w.close()
      } catch { /* fail-open */ }
    }
    this.watchers = []
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.debounceTimer = null
    this.pollTimer = null
  }
}

function fileMtimeOf(path: string): number {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

function unref(t: unknown): void {
  if (t && typeof t === "object" && "unref" in (t as any)) (t as any).unref()
}
