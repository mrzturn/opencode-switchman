// opencode-switchman plugin entry — the only OpenCode API adaptation layer (v1.2)
// Hook surface: config (shell injection + credential collection) / chat.params (session→agent mapping) /
//         experimental.chat.system.transform (dispatcher rules + banner injection, shell subagents skipped) /
//         tool.execute.before (six-gate deny) / tool.execute.after (auto-handover: auto backup+compact at force watermark) / event (failure accounting → breaker)
// [2026-09-04]-[/handover moved to direct TUI execution (fork backup + current-session compaction, no AI in the loop); the main plugin
//  no longer registers the conversational command or the handover tool (see src/tui.tsx runHandoverBackup)]
// [fail-open iron rule: any hook exception only writes stderr, never blocks the main flow; all core logic lives in the pure-function layer]
// [2026-09-04]-[English localization: translate runtime messages and comments; no logic change]
import type { Plugin } from "@opencode-ai/plugin"
import { watch, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { AGENTS_MD } from "./assets/agents-md"
import { DELEGATION_TEMPLATE } from "./assets/delegation-template"
import {
  loadContext, buildRegistry, loadManifest, laneShells, paths,
  cleanExpired, ensureStateDir, stateDir, loadSupersetShells, writeJsonAtomic,
  appendStatusLog,
  writeRouteSnapshot,
  writeQuotaBrief,
  loadProviderCache, saveProviderCache, nowIso,
} from "./state"
import { checkShell, noteUnknownAgent, shellLikeName, denyUninjected, builtinAgentDeny, BUILTIN_SUBAGENTS } from "./gates"
import {
  computeLane, billingWindow, billingWindowForConfig, poolStates, routingAdvice,
  glmExhausted, copilotExhausted, deepseekExhausted, firstCandidate, laneOfShell,
} from "./lane"
import { READ_CLASS_TOOLS, estimateContextTokens, thresholdsOf, watermarkLevel, readGateDecision, isArchaeologyBash } from "./context-watch"
import { backupSession, compactSession, v1HandoverPort, type HandoverResult } from "./handover-core"
import { logDecision, BILLING_API_BOOST } from "./scoring"
import type { WaterFactor, DecisionRecord } from "./scoring"
import { quotaView, readAuthStore, markCopilotGatewayExhausted } from "./quota"
import { costOf, refreshCosts, costsStale } from "./cost"
import { baseScoreDynamic, refreshCapability, capabilityStale } from "./capability"
import { refreshMatrixIfStale, refreshActiveMatrixIfStale, probeKeys } from "./probe"
import { injectShells, injectShellDefs, selectInjectableDefs } from "./shells"
import { buildBanner, shortName, providerStatusEntries } from "./banner"
import { refreshSelfUpdate, updateBannerText, ensureUpdateCommands, detectLoadMode, pluginCliPath } from "./selfupdate"
import { loadPoolConfig, overrideSummary } from "./user-overrides"
import { poolConfigCommandMd, modelRankCommandMd, expertCommandMd, langCommandMd } from "./commands-md"
import { billingOfProvider, loadUserConfig, resolveEffectiveOptions, routingPeakActive, routePolicy, DEFAULT_DELEGATION_FLOOR } from "./config"
import { poolForProviderId } from "./provider-config"
import { runDoctor } from "./doctor"
import {
  recordFailure, cleanRoutingExpired, markRealFailure, realFailedComboKeys,
  RATE_LIMIT_TTL_MS, ENDPOINT_TTL_MS, REAL_FAIL_TTL_MS, recordIsolation, recordInjection, realFailedRemainingMs,
  noteModelNotFound, retiredModelKeys, filterRetiredShells,
} from "./breaker"
import { classifyFailure } from "./failclass"
import { LANE_ORDER, DEFAULT_LANG_CANDIDATES } from "./types"
import type { SwitchmanOptions, Lane, LaneResult, Pool, ShellRegEntry, ModelKey } from "./types"
import { WorkspaceTracker, DEFAULT_WORKSPACE_DIRNAME, type EnsuredWorkspace } from "./workspace"
import { loadLangConfig, renderLangLine, renderAskDirective, saveLangFromQuestion } from "./lang-config"
import { detectMode, readConfigured, normalizeProviderListResponse } from "./activation"
import type { MatrixModeOption } from "./activation"
// [2026-08-29]-[event/parameter shape-extraction pure functions moved to helpers.ts: the entry must not export non-plugin functions, otherwise
//  opencode invokes them as plugin factories producing null hooks, blowing up the config hook and provider.list]-[fixed startup error]
import { chatParamsModelKey, sessionDeletedId, sessionCreatedInfo } from "./helpers"
import { parseRouteMeta } from "./meta"
import { relayImageParts } from "./relay"
import { syncBundledSkills } from "./skill-sync"
import { MatrixManager } from "./matrix-manager"
import { laneBaseChain } from "./lane-policy"
import {
  buildShells, loadCatalog, bundledModelIndex, isConversational, toManifestEntry, freeFloorModels,
} from "./catalog"
import type { ShellDefinition, EffortInfo } from "./catalog"

/** opencode state root (desktop sets XDG_STATE_HOME=userData; CLI = xdg-basedir default ~/.local/state) */
function resolveOpencodeStateRoot(): string {
  const xdg = process.env.XDG_STATE_HOME
  return join(xdg ?? join(homedir(), ".local", "state"), "opencode")
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => {
    const t = setTimeout(() => rej(new Error(`timeout ${ms}ms`)), ms)
    if (typeof t === "object" && t !== null && "unref" in t) (t as any).unref()
  })])
}

interface Credentials { glmKey?: string; dsKey?: string; copilotToken?: string; glmBaseURL?: string; deepseekBaseURL?: string }

export const SwitchmanPlugin: Plugin = async (input, rawOptions) => {
  const raw = rawOptions ?? {}
  // [2026-09-04]-[auto-handover: capture the main plugin's input surface (v1 client + project directory) for the tool.execute.after
  //  automatic /handover (the hook parameter input shadows the outer name)]
  const pluginClient = input.client
  const pluginDirectory = input.directory
  // legacy options only override the new file observe when explicitly present, avoiding defaults clobbering user config.
  const rawQuota = (raw as any).quota
  const legacyObserve: Partial<Record<Pool, boolean>> = {}
  for (const pool of ["glm", "copilot", "deepseek"] as Pool[]) {
    if (rawQuota?.[pool] && Object.prototype.hasOwnProperty.call(rawQuota[pool], "enabled")) legacyObserve[pool] = Boolean(rawQuota[pool].enabled)
  }
  let userConfig = loadUserConfig()
  // [2026-09-01]-[unified config surface: the jsonc behavior section is the baseline synthesizing effective options (explicit tuple keys keep gen-1 priority);
  //  rebuilt after the config hook reloads jsonc, so banner/thresholds/lanes take effect immediately (mode/watch are startup-level, effective after restart)]
  let { options, legacySections } = resolveEffectiveOptions(raw, userConfig.config)
  let policy = routePolicy(userConfig.config, legacyObserve)
  // [2026-08-31]-[vendor-neutral: billing/peak coefficient resolver — reads only the user jsonc (any provider key),
  //  only explicit subscription gets 1.0, other api gets 0.85; closure reads the latest userConfig (effective after config hook reload)]
  const billingBoostOf = (provider: string): number =>
    billingOfProvider(userConfig.config, provider) === "subscription" ? 1.0 : BILLING_API_BOOST
  // [2026-08-31]-[final review P1-2: the only peak resolver — within the legacy explicit billingWindow override period, effective for glm/deepseek pools
  //  (legacy options kept for gen-1 compatibility), otherwise the jsonc routing scope (enabled gated); closure reads the latest policy/userConfig]
  const legacyBillingWindow = Object.prototype.hasOwnProperty.call(raw, "billingWindow") ? options.billingWindow : undefined
  const peakOfProvider = (provider: string): boolean => {
    if (legacyBillingWindow) {
      const w = billingWindow(new Date(), legacyBillingWindow)
      const pool = poolForProviderId(provider)
      if (pool === "glm") return w.glmPeak && policy.glm.routing
      if (pool === "deepseek") return w.dsPeak && policy.deepseek.routing
      return false
    }
    return routingPeakActive(new Date(), userConfig.config, provider)
  }
  const unknownOfModel = (modelId: string): boolean => baseScoreDynamic(modelId).source === "global"
  let doctorSummary: string | null = null
  const creds: Credentials = { copilotToken: undefined }
  let initTried = false
  const denySkip = new Set<string>() // callIDs denied by ourselves: excluded from failure accounting
  let bannerCache: { at: number; lines: string[] } | null = null
  const sessionAgent = new Map<string, string>() // legacy path: recorded by chat.params (distinguishes main model vs shell subagent)
  // [2026-09-04]-[image relay: session → main model modelKey (recorded by chat.params, both dynamic/legacy paths) + model metadata index
  //  built by the config hook (vision verdict same source as shell injection), queried at runtime by experimental.chat.messages.transform]
  const sessionModelKey = new Map<string, ModelKey>()
  let metaIndexRuntime: Record<string, EffortInfo> | null = null
  // [2026-08-29]-[dynamic matrix v1.3: mode decided once; legacy = original static path byte-for-byte unchanged]
  const runMode = detectMode(options.matrix!.mode as MatrixModeOption, process.env.OPENCODE_CLIENT)
  const dynamic = runMode !== "legacy"
  let manager: MatrixManager | null = null
  // [2026-08-29]-[fail-open visibility: when config injection crashes only stderr is written, the model side never notices and dispatches blindly
  //  against an empty registry — set the flag on crash, and transform injects an explicit warning into the system prompt (do it yourself / tell the user; don't dispatch)]-
  let configFailed = false
  const injectedNames = new Set<string>()
  const conflictNames = new Set<string>()
  let supersetDefs: ShellDefinition[] = []
  let degradedModelCount = 0
  // [2026-09-04]-[measured session context watermark: message.updated token usage → main-session (non-shell/non-internal) watermark;
  //  past the line, read-class tools get the tiered gate (nudge first, then hard deny) — turns rules self-reporting into mechanism enforcement]
  const sessionWatermark = new Map<string, { tokens: number; at: number }>()
  const readNudged = new Map<string, Set<string>>()
  // [2026-09-05]-[todo nudge: latest todo snapshot per main session (fed by todo.updated events; the tool replaces the whole
  //  list each call, so the last event is authoritative). Root cause of the stale-todo bug: default-prompt models (e.g. GLM)
  //  get no todo discipline from opencode's default system prompt and nothing re-surfaced the list after the first write, so
  //  it fell out of attention once delegation turns piled up; the per-turn [TODO] line keeps it visible]
  const sessionTodos = new Map<string, { todos: Array<{ content: string; status: string }>; at: number }>()
  // [2026-09-04]-[auto-handover guards: inflight prevents concurrency (tools run in parallel; several afters past the line trigger only once);
  //  a 10-minute cooldown prevents "post-compaction summary + tail still past the line → compact again" flapping (the measured watermark only falls
  //  back after the next assistant message)]
  const handoverInflight = new Set<string>()
  const handoverCooldown = new Map<string, number>()
  const HANDOVER_COOLDOWN_MS = 10 * 60_000
  // [2026-09-05]-[artifact workspace: per-project <dirname>/<yyyy-mm-dd>/<sessionId>-<title>/ folder per main session
  //  (plans/progress/process docs/media/dispatch trace coordination; protocol directs the model to write there).
  //  Settings closure reads the live options (jsonc reload effective immediately); folder IO happens only on
  //  create/title-rename, steady-state ensure() is read-free; fail-open everywhere]
  const workspace = new WorkspaceTracker(
    () => ({ enabled: options.workspace?.enabled !== false, dirname: options.workspace?.dirname || DEFAULT_WORKSPACE_DIRNAME }),
    pluginDirectory,
  )
  // [2026-09-05]-[project language preference: per-session first-ask latch (released on capture/session delete);
  //  the config itself is re-read from disk EVERY turn, so "configured = never ask again" holds across restarts]
  const langAsked = new Set<string>()

  function isShellOrInternalSession(sessionID: string | undefined): boolean {
    if (!sessionID) return false
    if (dynamic) return manager?.skipSystemInjection(sessionID) === true
    const agent = sessionAgent.get(sessionID) ?? ""
    return /-mx-/.test(agent) || agent === "title" || agent === "compaction" || agent === "summary"
  }

  function kk(n: number): string { return `${Math.round(n / 1000)}k` }

  /** [WATERMARK:SESSION] banner line: ok tier reports numbers only (saves tokens); past the line attaches tiered directives */
  function sessionWatermarkLine(sessionID: string | undefined): string | null {
    try {
      if (!sessionID || isShellOrInternalSession(sessionID)) return null
      const wm = sessionWatermark.get(sessionID)
      if (!wm) return null
      const t = thresholdsOf(options.context)
      const level = watermarkLevel(wm.tokens, t)
      const base = `[WATERMARK:SESSION] measured session context ~${kk(wm.tokens)} (soft ${kk(t.soft)}/hard ${kk(t.hard)}/force ${kk(t.force)})`
      if (level === "ok") return base
      if (level === "soft") return `${base}—soft watermark exceeded: new reads/scans must be delegated to an economy shell (scouter/clerk); self-reads get a one-time nudge (delivery git and test/lint are exempt)`
      if (level === "hard") return `${base}—hard watermark exceeded: read/glob/grep/list self-reads denied; bash runs verification only (state-changing git always passes; scope git log/diff/blame with -n/--stat/-L or delegate); wrap up`
      // [2026-09-04]-[force tier copy split: with auto-handover on, stand by for automatic compaction (banner reports facts only, saves tokens);
      //  with it off, keep the legacy directive (relying on manual /handover)]
      if (options.context?.autoHandover !== false) return `${base}—[MANDATORY] force-compaction watermark exceeded: auto-handover will fully back up and compact this session (the task continues automatically); stand by — no new reads or delegations`
      return `${base}—[MANDATORY] force-compaction watermark exceeded: run /handover or compact the context now; no new reads or delegations`
    } catch { return null }
  }

  /**
   * [TODO] status line: unfinished lists only (all-done lists go quiet); compact progress numbers + the current focus item
   * re-surface the list every turn so it never goes stale (mirrors the watermark line's mechanism; facts + a short directive)
   * [2026-09-05]-[todo nudge line: pairs with protocol §0.7; cancelled counts as resolved, pending focus tags as "next"]
   */
  function sessionTodoLine(sessionID: string | undefined): string | null {
    try {
      if (!sessionID || isShellOrInternalSession(sessionID)) return null
      const snap = sessionTodos.get(sessionID)
      if (!snap) return null
      const total = snap.todos.length
      const done = snap.todos.filter((t) => t.status === "completed" || t.status === "cancelled").length
      if (done >= total) return null
      const inProg = snap.todos.find((t) => t.status === "in_progress")
      const focus = inProg ?? snap.todos.find((t) => t.status === "pending")
      const focusTxt = focus ? ` · ${inProg ? "in_progress" : "next"}: ${focus.content.slice(0, 60)}` : ""
      return `[TODO] ${done}/${total} done${focusTxt} — keep todowrite current (update as each item starts/finishes)`
    } catch { return null }
  }

  /** [2026-09-05]-[artifact workspace event path: record + ensure a main session's folder; shell/internal sessions filtered
   *  (call AFTER the agent classification so isShellOrInternalSession sees the registration); logs only on create/rename] */
  function noteWorkspaceSession(info: { id?: unknown; title?: unknown; directory?: unknown; created?: unknown } | null | undefined): void {
    try {
      const id = info && typeof (info as any).id === "string" ? (info as any).id : ""
      if (!id || isShellOrInternalSession(id)) return
      workspace.record(info as any)
      const ensured = workspace.ensure(id)
      if (ensured?.created) appendStatusLog(`artifact workspace created: ${ensured.rel}`)
      else if (ensured?.renamed) appendStatusLog(`artifact workspace renamed: ${ensured.renamed} → ${ensured.rel}`)
    } catch { /* fail-open */ }
  }

  /**
   * [2026-09-05]-[artifact workspace lazy path: sessions unknown to this process (resumed after a restart) are fetched once
   *  via session.get (3s timeout), then fail-open to pluginDirectory + today; null = disabled/unknown session/IO failure]
   */
  async function ensureWorkspace(sessionID: string | undefined): Promise<EnsuredWorkspace | null> {
    try {
      if (options.workspace?.enabled === false) return null
      if (!sessionID || isShellOrInternalSession(sessionID)) return null
      if (!workspace.known(sessionID)) {
        try {
          const res = await withTimeout(Promise.resolve(
            (pluginClient as any)?.session?.get?.({ path: { id: sessionID }, query: { directory: pluginDirectory } }),
          ), 3_000)
          const data = (res as any)?.data
          if (data?.id) workspace.record({ id: String(data.id), title: data.title, directory: data.directory, created: data?.time?.created })
        } catch { /* fail-open: fallback registration below */ }
        if (!workspace.known(sessionID)) workspace.record({ id: sessionID, directory: pluginDirectory })
      }
      return workspace.ensure(sessionID)
    } catch { return null }
  }

  /** [2026-09-05]-[artifact workspace dispatch trace: one JSONL line per allowed delegation (lane/role from ROUTE_META); fail-open no-op] */
  function traceDispatch(sessionID: string | undefined, shellName: string, prompt: unknown, redirected: boolean): void {
    try {
      if (!sessionID || isShellOrInternalSession(sessionID)) return
      const [meta] = parseRouteMeta(prompt)
      workspace.traceDispatch(sessionID, {
        ts: nowIso(), session: sessionID, shell: shellName,
        lane: typeof meta?.lane === "string" ? meta.lane : undefined,
        role: typeof meta?.role === "string" ? meta.role : undefined,
        source: typeof meta?.source === "string" ? meta.source : undefined,
        redirected: redirected || undefined,
      })
    } catch { /* fail-open */ }
  }

  function clearBannerCache(): void {
    bannerCache = null
  }

  /** The sidebar only polls persisted snapshots; rebuild proactively after refresh — never rely on the next chat request to read the banner. */
  function refreshSidebarState(): void {
    try {
      clearBannerCache()
      bannerLines()
    } catch { /* fail-open */ }
  }

  // [2026-09-03]-[manual capability-rank/task-pool changes take effect immediately: directory-level watch on both override files (writeJsonAtomic=tmp+rename
  //  swaps inodes, so watch the directory not the file), 5s mtime polling as fallback (some hosts' fs.watch never delivers; matrix-manager
  //  uses the same policy); a trigger forces banner+sidebar snapshot rebuild, so TUI dialogs/CLI/hand-edited files all become visible immediately]-[config changes visible immediately]
  const OVERRIDE_WATCH_FILES = new Set(["capability-rank.json", "pool-config.json"])
  let overrideWatchStarted = false
  let overrideWatchTimer: ReturnType<typeof setTimeout> | null = null
  let overrideWatchMtimeSig = ""
  function onOverrideConfigChanged(): void {
    if (overrideWatchTimer) clearTimeout(overrideWatchTimer)
    overrideWatchTimer = setTimeout(() => {
      overrideWatchTimer = null
      try { appendStatusLog("capability rank/task-pool selection changed: banner and sidebar refresh immediately") } catch { /* fail-open */ }
      refreshSidebarState()
    }, 200)
    if (typeof overrideWatchTimer === "object" && overrideWatchTimer !== null && "unref" in overrideWatchTimer) (overrideWatchTimer as any).unref()
  }

  function startOverrideConfigWatcher(): void {
    if (overrideWatchStarted) return
    overrideWatchStarted = true
    let dir = ""
    try {
      dir = stateDir()
      const w = watch(dir, { recursive: false }, (_event, filename) => {
        if (filename && OVERRIDE_WATCH_FILES.has(String(filename))) onOverrideConfigChanged()
      })
      w.on("error", (exc) => { try { appendStatusLog(`fs.watch(${dir}) override-config watch error (mtime polling fallback): ${exc}`) } catch { /* fail-open */ } })
    } catch { /* fail-open: missing directory/startup failure is covered by polling */ }
    // mtime polling fallback: first run records a baseline without triggering
    const poll = () => {
      try {
        let sig = ""
        for (const name of OVERRIDE_WATCH_FILES) {
          try { sig += `${statSync(join(dir, name)).mtimeMs};` } catch { sig += "-;" }
        }
        if (overrideWatchMtimeSig && sig !== overrideWatchMtimeSig) onOverrideConfigChanged()
        overrideWatchMtimeSig = sig
      } catch { /* fail-open */ }
    }
    poll()
    const pollTimer = setInterval(poll, 5000)
    if (typeof pollTimer === "object" && pollTimer !== null && "unref" in pollTimer) (pollTimer as any).unref()
  }

  function routingWithRealFailures(routing: ReturnType<typeof loadContext>["routing"]) {
    // [2026-08-29]-[re-review P2-5: legacy in-memory marks are always empty yet still guarded, matching the new gate's write point against future non-dynamic write paths]-
    if (!dynamic) return routing
    const down = { ...routing.down_agents }
    for (const combo of realFailedComboKeys()) down[combo] = "probe ok but real delegation failed (30-min in-memory isolation)"
    return { ...routing, down_agents: down }
  }

  function collectCreds(cfg: Record<string, any>): void {
    try {
      // priority: opencode auth layer (managed by /connect) → provider config options → env
      const auth = readAuthStore()
      creds.glmKey = auth.glmKey ?? creds.glmKey
      creds.dsKey = auth.dsKey ?? creds.dsKey
      creds.copilotToken = auth.githubToken ?? creds.copilotToken
      for (const [pid, p] of Object.entries<any>(cfg.provider ?? {})) {
        const apiKey = p?.options?.apiKey
        const baseURL = p?.options?.baseURL
        if (poolForProviderId(pid) === "glm") {
          creds.glmKey = creds.glmKey ?? (typeof apiKey === "string" ? apiKey : undefined)
          creds.glmBaseURL = typeof baseURL === "string" ? baseURL : creds.glmBaseURL
        }
        if (poolForProviderId(pid) === "deepseek") {
          creds.dsKey = creds.dsKey ?? (typeof apiKey === "string" ? apiKey : undefined)
          creds.deepseekBaseURL = typeof baseURL === "string" ? baseURL : creds.deepseekBaseURL
        }
      }
      if (!creds.glmKey && process.env.ZAI_API_KEY) creds.glmKey = process.env.ZAI_API_KEY
      if (!creds.dsKey && process.env.DEEPSEEK_API_KEY) creds.dsKey = process.env.DEEPSEEK_API_KEY
    } catch { /* fail-open */ }
  }

  function probeEndpoints() {
    return { glmKey: creds.glmKey, dsKey: creds.dsKey, glmBaseURL: creds.glmBaseURL, deepseekBaseURL: creds.deepseekBaseURL }
  }

  function readConfiguredSafe(stateRoot: string, mode: "desktop" | "cli") {
    try {
      return readConfigured(stateRoot, mode)
    } catch (exc) {
      appendStatusLog(`config surface read fail-open: ${exc}`)
      return { configStatus: "empty" as const, models: [] as ModelKey[] }
    }
  }

  /** [2026-09-01]-[P3 startup race fix: single attempt with a short timeout (blocks briefly); failure/not-ready throws for the caller's backoff retry]-
   *  single provider.list probe (no retry logic here; retries belong to collectProviderModels's backoff scheduling) */
  async function attemptProviderList(
    input: { client?: { provider?: { list?: () => Promise<unknown> } } },
    timeoutMs: number,
  ): Promise<{ models: string[]; providers: string[] }> {
    const resp = await withTimeout(Promise.resolve(input?.client?.provider?.list?.()), timeoutMs)
    // shape normalization pure function in activation.normalizeProviderListResponse (delta re-review P1: unwrap .data first)
    const normalized = normalizeProviderListResponse(resp)
    if (!normalized) throw new Error("provider.list response shape unrecognized")
    const providers = normalized.providers
    const connected = normalized.connected
    const models: string[] = []
    const providerIds: string[] = []
    for (const p of providers) {
      const pid = String(p?.id ?? "")
      if (!pid) continue
      // connected present = credentialed filter (providers outside this list would always fail after shell registration and pollute the restartRequired baseline)
      if (connected && !connected.has(pid)) continue
      providerIds.push(pid)
      for (const mid of Object.keys(p?.models ?? {})) {
        models.push(`${pid}/${mid}`)
      }
    }
    if (providers.length === 0 && !Array.isArray(resp)) throw new Error("provider.list response shape unrecognized")
    return { models, providers: providerIds }
  }

  // [2026-09-01]-[startup race hardening: opencode core's provider registry readiness time is unpredictable; the original 2 fixed retries
  //  at 2.5s/8s often still hit not-ready (both timed out in practice) — switched to adaptive backoff (shorter first timeout + more
  //  attempts) with a markedly higher hit rate; injectShellDefs must wait for this result inside the config hook (cfg.agent only takes
  //  effect once inside the hook, later appends are ignored — a hard constraint of the opencode plugin API this plugin cannot bypass),
  //  so this stays await, but the backoff scheduling makes it "return as soon as possible" instead of a fixed wait; most of the time it
  //  gets the real provider.list result faster than before, reducing the chance of falling to the restartRequired fallback]
  const PROVIDER_LIST_BACKOFF_MS = [0, 1_500, 3_000, 6_000] // 4 attempts, cumulative wait 10.5s + 4× timeout budget
  const PROVIDER_LIST_ATTEMPT_TIMEOUT_MS = 5_000

  /** all conversational models of credentialed providers (client.provider.list with adaptive backoff; falls back to cfg.provider keys on failure) */
  async function collectProviderModels(
    input: { client?: { provider?: { list?: () => Promise<unknown> } } },
    cfg: Record<string, any>,
  ): Promise<{ models: string[]; providers: string[]; fellBack: boolean }> {
    let lastExc: unknown = null
    for (let i = 0; i < PROVIDER_LIST_BACKOFF_MS.length; i++) {
      if (PROVIDER_LIST_BACKOFF_MS[i] > 0) await new Promise((r) => setTimeout(r, PROVIDER_LIST_BACKOFF_MS[i]))
      try {
        const result = await attemptProviderList(input, PROVIDER_LIST_ATTEMPT_TIMEOUT_MS)
        if (i > 0) appendStatusLog(`provider.list attempt ${i + 1} succeeded (previous ${i} not ready)`)
        return { ...result, fellBack: false }
      } catch (exc) {
        lastExc = exc
        if (i < PROVIDER_LIST_BACKOFF_MS.length - 1) {
          appendStatusLog(`provider.list attempt ${i + 1} not ready, backing off: ${exc}`)
        }
      }
    }
    // all attempts failed: fall back to the cfg.provider key set (providerIDs only, as restartRequired baseline; model surface covered by config surface/built-in chains)
    const keys = Object.keys(cfg.provider ?? {})
    appendStatusLog(`provider.list unavailable (fell back to ${keys.length} cfg.provider keys after ${PROVIDER_LIST_BACKOFF_MS.length} attempts): ${lastExc}`)
    return { models: [], providers: keys, fellBack: true }
  }

  // [2026-09-01]-[async fallback: if the in-hook backoff still fails outright (opencode core unusually slow at startup),
  //  or this startup used the cross-restart cache (no live probe) — keep probing provider.list in the background at longer
  //  intervals; on success refresh the cache so the next startup is instant; a newly seen provider can only be hinted as
  //  "restart required", never silently activated — cfg.agent is read once inside the config hook (hard opencode plugin API
  //  constraint), shells cannot be registered after the fact;
  //  the value here is turning "is a restart still needed / would a restart take effect now" from blind guessing into explicit, live status hints]
  function scheduleProviderListWatchdog(
    input: { client?: { provider?: { list?: () => Promise<unknown> } } },
    knownProviders: ReadonlySet<string>,
  ): void {
    const delays = [15_000, 30_000, 60_000] // 3 background rounds, increasing gaps, 105s more in total; process exit ends it naturally, no explicit cancel
    const run = async () => {
      for (const delay of delays) {
        await new Promise((r) => setTimeout(r, delay))
        try {
          const result = await attemptProviderList(input, 6_000)
          // [2026-09-01]-[real probe success refreshes the cross-restart cache: next startup's config hook reads the cache directly, no re-waiting]
          saveProviderCache({ at: nowIso(), models: result.models, providers: result.providers })
          const fresh = result.providers.filter((p) => !knownProviders.has(p))
          if (fresh.length > 0) {
            appendStatusLog(`provider.list background probe: new provider(s) connected (${fresh.join(", ")}) — restart opencode to complete shell registration`)
            clearBannerCache()
          }
          return
        } catch { /* keep backing off to the next round, fail-open */ }
      }
    }
    run().catch(() => {})
  }

  function warmup(): void {
    if (initTried) return
    initTried = true
    try {
      ensureStateDir()
      ensureStateAssets()
      creds.copilotToken = creds.copilotToken ?? readAuthStore().githubToken
      const costsP = costsStale() && options.cost!.enabled ? refreshCosts().catch(() => {}) : Promise.resolve()
      // [2026-08-31]-[dynamic capability grading: scheduled at the same cadence as the probe (TTL 24h skips actual fetches)]
      const capP = capabilityStale() && options.capability!.enabled ? refreshCapability(options.capability!).catch(() => {}) : Promise.resolve()
      const matrixP = dynamic && manager
        ? refreshActiveMatrixIfStale(probeEndpoints(), manager.activeMatrixKeys()).catch(() => {})
        : refreshMatrixIfStale(probeEndpoints()).catch(() => {})
      quotaView(creds as any, { observe: {
        glm: policy.glm.observe,
        deepseek: policy.deepseek.observe,
        copilot: policy.copilot.observe,
      } })
      // [2026-09-01]-[probe live coupling: write sidebar snapshots only after the startup probe/matrix/capability refreshes land, avoiding stale pre-refresh data]-[fail-open, never blocks startup]
      Promise.allSettled([costsP, capP, matrixP]).then(refreshSidebarState).catch(() => {})
      // [2026-08-28]-[probe/quota/cost ran only once at startup; startup races (e.g. core writing the token late) or post-peak rate limits never self-healed]-
      // [10min periodic refresh: skipped automatically within matrix TTL; quota/cost covered by their own TTLs; timer unref never blocks process exit]
      // [2026-08-29]-[dynamic matrix probes only active combos (incremental, ro aliases share keys with dedup); legacy stays full]
      const timer = setInterval(() => {
        try {
          const matrixP = dynamic && manager
            ? refreshActiveMatrixIfStale(probeEndpoints(), manager.activeMatrixKeys()).catch(() => {})
            : refreshMatrixIfStale(probeEndpoints()).catch(() => {})
          quotaView(creds as any, { observe: {
            glm: policy.glm.observe,
            deepseek: policy.deepseek.observe,
            copilot: policy.copilot.observe,
          } })
          const costsP = costsStale() && options.cost!.enabled ? refreshCosts().catch(() => {}) : Promise.resolve()
          // [2026-08-31]-[dynamic capability grading: 10min periodic same-cadence check, capabilityStale/TTL 24h gates the actual fetch]
          const capP = capabilityStale() && options.capability!.enabled ? refreshCapability(options.capability!).catch(() => {}) : Promise.resolve()
          // [2026-09-01]-[probe live coupling: once the 10min periodic refresh lands, invalidate the banner cache and rewrite sidebar snapshots immediately, not waiting for the next chat message]
           Promise.allSettled([matrixP, costsP, capP]).then(refreshSidebarState).catch(() => {})
        } catch { /* fail-open */ }
      }, 600_000)
      if (typeof timer === "object" && timer !== null && "unref" in timer) (timer as any).unref()
    } catch (exc) {
      appendStatusLog(`warmup fail-open: ${exc}`)
    }
  }

  function ensureStateAssets(): void {
    try {
      // [2026-08-28]-[after bundle deployment import.meta relative paths break; assets moved to inline TS modules; templates rewrite at every startup = pinned to the package version]
      writeFileSync(join(stateDir(), "delegation-template.md"), DELEGATION_TEMPLATE)
    } catch { /* fail-open */ }
    // [2026-09-05]-[materialize bundled agent skills into the opencode global skills dir at startup (add/overwrite-only,
    //  marker-gated cleanup inside syncBundledSkills); logged only when something actually changed]-[fail-open]
    try {
      const s = syncBundledSkills()
      if (s.installed.length + s.updated.length + s.removed.length > 0) {
        appendStatusLog(`skills synced: ${s.installed.length} installed, ${s.updated.length} updated, ${s.removed.length} removed (${[...s.installed, ...s.updated, ...s.removed].join(", ")})`)
      }
    } catch (exc) {
      appendStatusLog(`skill sync fail-open: ${exc}`)
    }
  }

  function quotaExhaustedFlags(): Partial<Record<Pool, boolean>> {
    try {
      const qv = quotaView(creds as any, { observe: {
        glm: policy.glm.observe,
        deepseek: policy.deepseek.observe,
        copilot: policy.copilot.observe,
      } })
      return {
        glm: policy.glm.routing && glmExhausted(qv.glm, options.quota!.glm!.fiveHourReservePct)[0],
        copilot: policy.copilot.routing && copilotExhausted(qv.copilot)[0],
        deepseek: policy.deepseek.routing && deepseekExhausted(qv.deepseek)[0],
      }
    } catch {
      return {}
    }
  }

  function currentContext() {
    warmup()
    const ctx = loadContext(options, creds as any, dynamic ? dynamicManifest() : undefined)
    try {
      cleanExpired(ctx.routing)
    } catch { /* fail-open */ }
    const registry = buildRegistry(ctx)
    return { ctx, registry }
  }

  /** dynamic superset manifest view (fallback disk read before config; default falls back to the static manifest) */
  function dynamicManifest(): ReturnType<typeof loadManifest> | null {
    if (supersetDefs.length > 0) {
      return { shells: supersetDefs.map(toManifestEntry), lanes: (loadManifest() as any).lanes }
    }
    try {
      const persisted = loadSupersetShells()
      if (persisted) return { shells: persisted.shells, lanes: (loadManifest() as any).lanes }
    } catch { /* fail-open */ }
    return null
  }

  /** favorites model set (modelId scope): same-tier in-chain priority; reads the activation snapshot's config surface, fail-open empty set */
  function preferredModelIds(): Set<string> {
    try {
      return new Set((manager?.snapshot().configured ?? []).map((k) => k.slice(k.indexOf("/") + 1)))
    } catch {
      return new Set()
    }
  }

  /** six-lane base chain: user lanes option first; dynamic runs the algorithm over all active shells; legacy uses the generation-time same-source chain. */
  function baseChainFor(lane: Lane): string[] {
    const custom = (options.lanes as any)?.[lane]
    if (Array.isArray(custom) && custom.length > 0) return custom
    if (!dynamic || !manager) return laneShells(loadContext(options, creds as any), lane)
    const m = loadManifest()
    const attrs = new Map<string, { effort: string; capability: string; vision: boolean; pool: string; provider: string; modelId: string; cost: number | null }>()
    // [2026-08-29]-[failure classification: dynamic filters retired-model shells first, so models 404ing continuously never re-enter redirect candidates]
    for (const s of filterRetiredShells((dynamicManifest() ?? m).shells)) {
      attrs.set(s.name, { effort: s.effort, capability: s.capability, vision: s.vision, pool: String(s.pool), provider: s.provider, modelId: s.modelId, cost: costOf(s.modelId) })
    }
    return laneBaseChain(lane, {
      builtin: (m.lanes as any)[lane] ?? [],
      activeShells: new Set(manager.snapshot().activeShells),
      shells: attrs, capabilityOf: (modelId) => baseScoreDynamic(modelId),
      // [2026-08-31]-[vendor-neutral: chain generation multiplies billingBoost×unknownPenalty (user config/capability grading driven)]
      billingBoostOf, unknownOf: unknownOfModel,
      // [2026-09-02]-[favorites first: favorite models rank first in the same tier within the chain]
      preferredModels: preferredModelIds(),
    })
  }

  function waterFactorOf(qv: ReturnType<typeof quotaView>): WaterFactor {
    const g = qv.glm
    const c = qv.copilot
    let copilotResetDays: number | null = null
    if (c?.reset_date && typeof c.reset_date === "string") {
      const d = new Date(`${c.reset_date.slice(0, 10)}T00:00:00`)
      if (!Number.isNaN(d.getTime())) {
        const start = new Date()
        start.setHours(0, 0, 0, 0)
        copilotResetDays = Math.max(Math.floor((d.getTime() - start.getTime()) / 86400000), 0)
      }
    }
    return {
      glmFiveHourPct: typeof g?.five_hour?.used_pct === "number" ? g.five_hour.used_pct : null,
      glmWeeklyPct: typeof g?.weekly?.used_pct === "number" ? g.weekly.used_pct : null,
      copilotRemainingPct: typeof c?.premium?.percent_remaining === "number" ? c.premium.percent_remaining : null,
      copilotResetDays,
    }
  }

  function bannerLines(): string[] {
    try {
      if (bannerCache && Date.now() - bannerCache.at < 15_000) return bannerCache.lines
      const { ctx, registry } = currentContext()
      const quotaEx = quotaExhaustedFlags()
      const costs = options.cost!.enabled ? costOf : null
      const lanes: Record<string, LaneResult> = {}
        const peak = billingWindowForConfig(new Date(), userConfig.config, Object.prototype.hasOwnProperty.call(raw, "billingWindow") ? options.billingWindow : undefined)
       const qv = quotaView(creds as any, { observe: {
         glm: policy.glm.observe,
         deepseek: policy.deepseek.observe,
         copilot: policy.copilot.observe,
      } })
       // [2026-08-29]-[scoring engine: normalized quota-view watermark factor (water coefficients)]
       const water = { ...waterFactorOf(qv), routing: Object.fromEntries(Object.entries(policy).map(([k, v]) => [k, v.routing])) as Partial<Record<Pool, boolean>> }
       const states = poolStates(qv, peak, policy)
       for (const lane of LANE_ORDER) {
         try {
           lanes[lane] = computeLane(lane, baseChainFor(lane), {
             registry, matrix: ctx.matrix?.combos ?? null, routing: routingWithRealFailures(ctx.routing),
              quotaExhausted: quotaEx, routePolicy: policy, states, glmPeak: peak.glmPeak, costs, water,
              billingBoostOf, peakOf: peakOfProvider,
              // [2026-09-02]-[favorites first: runtime same-tier-first, same source as the base chain]
               preferredModels: preferredModelIds(),
               // [2026-09-03]-[task-pool selection: banner recommendation matches each lane's selection list]
               poolConfig: loadPoolConfig(),
            })
          } catch { /* one lane failing never affects the others */ }
        }
        // [2026-09-01]-[down source annotation: breaker (routing.json 600s) and real-fail isolation (in-memory TTL) shown with time left, separately]
       const down = new Map<string, string>()
       for (const k of Object.keys(routingWithRealFailures(ctx.routing).down_agents)) down.set(k, "breaker")
       for (const k of realFailedComboKeys()) {
         const left = realFailedRemainingMs(k)
         down.set(k, left !== null ? `real-fail isolation·${Math.max(1, Math.round(left / 60_000))}m left` : "real-fail isolation")
       }
      // [2026-08-29]-[dynamic matrix: [ROUTES] shows only active candidates; [LIMITS] appends mode/watch/configStatus/restartRequired/downgrade marks]
      const matrixInfo = dynamic && manager ? {
        mode: runMode, configStatus: manager.snapshot().configStatus,
        watch: options.matrix!.watch === true,
        restartRequired: manager.snapshot().restartRequired,
        invalidConfigured: manager.snapshot().invalidConfigured,
        degradedModels: degradedModelCount,
        retiredModels: retiredModelKeys().length,
      } : undefined
      const lines = buildBanner({
        lanes: lanes as any,
        down,
        quota: { glm: null as any, copilot: null as any },
        states,
        billing: peak,
         advice: routingAdvice(states, policy),
         providerPolicy: policy as any,
         doctorSummary,
         matrixInfo,
         update: updateBannerText(),
         overrides: overrideSummary(),
      })
      // [WATERMARK] line needs raw quota data → second assembly (the banner pure function takes a snapshot; real quota added here)
      const lines2 = buildBanner({
        lanes: lanes as any,
        down,
        quota: { glm: qv.glm, copilot: qv.copilot, deepseek: qv.deepseek },
        states,
        billing: peak,
         advice: routingAdvice(states, policy),
         providerPolicy: policy as any,
         doctorSummary,
        dsLowWarnCny: options.quota!.deepseek!.lowBalanceWarnCny,
        matrixInfo,
        update: updateBannerText(),
        overrides: overrideSummary(),
      })
      // [2026-08-29]-[scoring engine decision log: every banner rebuild (15s cache expiry) appends per-lane score details; fail-open, never blocks]
      try {
        const records: DecisionRecord[] = []
        for (const lane of LANE_ORDER) {
          const candidates = (lanes[lane]?.chain ?? [])
            .filter((c) => c.score)
            .map((c) => ({ name: c.shell, ...c.score! }))
          if (candidates.length > 0) records.push({ at: new Date().toISOString(), lane, candidates })
        }
        if (records.length > 0) logDecision(records).catch(() => {})
      } catch { /* fail-open */ }
      // [2026-09-01]-[TUI sidebar "best model" panel: each lane's chain-head candidate, same source as the banner, overwritten for tui.tsx polling]
      try {
        writeRouteSnapshot(LANE_ORDER.map((lane) => {
          const r = lanes[lane]
          const top = r?.chain?.[0]
          return {
            lane,
            best: top ? shortName(top.shell) : null,
            degraded: r ? r.status.endsWith("*") : false,
          }
        }))
      } catch { /* fail-open */ }
      // [2026-09-01]-[TUI sidebar "watermark/peak" panel: same source as the [WATERMARK] banner, always visible, overwritten for tui.tsx polling]
      try {
        writeQuotaBrief(providerStatusEntries({
          quota: { glm: qv.glm, copilot: qv.copilot, deepseek: qv.deepseek },
          providerPolicy: policy as any,
          dsLowWarnCny: options.quota!.deepseek!.lowBalanceWarnCny,
          peakOf: peakOfProvider,
        }))
      } catch { /* fail-open */ }
      bannerCache = { at: Date.now(), lines: lines2 }
      return lines2
    } catch (exc) {
      appendStatusLog(`banner fail-open: ${exc}`)
      return []
    }
  }

  /** dynamic-mode six-lane map (produced by lane-policy); legacy = static lanes */
  function dynamicLaneMap(ctx: ReturnType<typeof loadContext>): Record<string, string[]> {
    if (!dynamic) return (ctx.manifest.lanes ?? {}) as Record<string, string[]>
    const out: Record<string, string[]> = {}
    for (const lane of LANE_ORDER) out[lane] = baseChainFor(lane)
    return out
  }

  // [2026-09-04]-[runtime gate input assembly extracted: shared by the task six gates / built-in blocking / read watermark gate (water/glmPeak/states)]
  function gateExtrasSnapshot(): { water?: WaterFactor; glmPeak?: boolean; states?: Record<string, unknown> } {
    try {
      const peak = billingWindowForConfig(new Date(), userConfig.config, legacyBillingWindow)
      const qv = quotaView(creds as any, { observe: {
        glm: policy.glm.observe,
        deepseek: policy.deepseek.observe,
        copilot: policy.copilot.observe,
      } })
      return {
        water: { ...waterFactorOf(qv), routing: Object.fromEntries(Object.entries(policy).map(([k, v]) => [k, v.routing])) as Partial<Record<Pool, boolean>> },
        glmPeak: peak.glmPeak,
        states: poolStates(qv, peak, policy),
      }
    } catch { return {} }
  }

  /** designated lane chain-head candidate (for built-in blocking / read-gate postscript; same source as the banner) */
  function laneHeadCandidate(lane: Lane, ctx: ReturnType<typeof loadContext>): string | null {
    try {
      const lanes = dynamicLaneMap(ctx)
      const extras = gateExtrasSnapshot()
      return firstCandidate(lane, lanes[lane] ?? [], {
        registry: buildRegistry(ctx),
        matrix: ctx.matrix?.combos ?? null,
        routing: routingWithRealFailures(ctx.routing),
        quotaExhausted: quotaExhaustedFlags(),
        billingBoostOf,
        peakOf: peakOfProvider,
        costs: options.cost!.enabled ? costOf : undefined,
        water: extras.water,
        glmPeak: extras.glmPeak,
        states: extras.states as any,
        poolConfig: loadPoolConfig(),
      } as any, undefined)
    } catch { return null }
  }

  /** [2026-09-04]-[read watermark gate: soft = one-time per-tool intercept+nudge (with an economy redirect suggestion); hard/force = read-class
   *  always denied, bash lets only verification commands through; shell subagent sessions exempt (they are the delegated executors)] */
  function handleReadGate(input: { tool: string; sessionID?: string; callID: string }, output: { args?: any }): void {
    try {
      if (options.context?.gates !== true) return
      const sid = input.sessionID
      if (!sid || isShellOrInternalSession(sid)) return
      const wm = sessionWatermark.get(sid)
      if (!wm) return
      const t = thresholdsOf(options.context)
      const level = watermarkLevel(wm.tokens, t)
      if (level === "ok") return
      const nudged = readNudged.get(sid) ?? new Set<string>()
      const cmd = input.tool === "bash" ? String(output.args?.command ?? "") : undefined
      const action = readGateDecision({
        tool: input.tool, level, alreadyNudged: nudged.has(input.tool),
        bashCommand: cmd,
      })
      if (action === "allow") return
      if (action === "nudge") { nudged.add(input.tool); readNudged.set(sid, nudged) }
      const { ctx } = currentContext()
      const hint = laneHeadCandidate("economy", ctx)
      const head = `[opencode-switchman] measured session context ~${kk(wm.tokens)} exceeds the ${level === "force" ? "force-compaction" : level === "hard" ? "hard" : "soft"} watermark (soft ${kk(t.soft)}/hard ${kk(t.hard)}/force ${kk(t.force)})`
      // [2026-09-05]-[git UX split copy: delivery git passes every tier silently; unbounded archaeology git gets a
      //  scoping hint (-n/--stat/-L) instead of the generic "delegate it" wording, so the wrap-up can proceed in-place]
      const archaeology = cmd !== undefined && cmd !== "" && isArchaeologyBash(cmd)
      let msg: string
      if (level === "soft") {
        msg = archaeology
          ? `${head}: bash self-read intercepted once (this tool is allowed afterwards in this session) — unbounded git log/diff/blame is scanning: rerun scoped (-n N / --oneline / --stat / -L a,b) or delegate to an economy shell${hint ? ` (e.g. ${hint}, ROUTE_META role=scouter)` : ""}; conclusions + file:line summary only`
          : `${head}: ${input.tool} self-read intercepted once (this tool is allowed afterwards in this session) — delegate new reads/scans to an economy shell${hint ? ` (e.g. ${hint}, ROUTE_META role=scouter)` : ""}; conclusions + file:line summary only`
      } else if (level === "hard") {
        msg = archaeology
          ? `${head}: unbounded git archaeology denied — rerun scoped (e.g., -n 20 / --oneline / --stat / -L a,b) or delegate to an economy shell${hint ? ` (e.g. ${hint})` : ""}; state-changing git and test/lint/build still run; please wrap up`
          : `${head}: ${input.tool} self-read denied — reads/scans must be delegated to an economy shell${hint ? ` (e.g. ${hint})` : ""}; state-changing git (add/commit/push/checkout) and test/lint/build still run; please wrap up`
      } else {
        // [2026-09-04]-[force tier deny copy: with auto-handover on, tell the model to stand by (don't fight the automatic compaction)]
        msg = options.context?.autoHandover !== false
          ? `${head}: force-compaction watermark exceeded — auto-handover will back up and compact this session (the task continues automatically); stand by, no new reads or delegations`
          : `${head}: compact the context immediately (/handover, or summarize-archive and split into a new session); no new reads or delegations`
      }
      denySkip.add(input.callID)
      appendStatusLog(`read watermark gate ${action} (${input.tool}, ~${kk(wm.tokens)}, ${level})`)
      throw new Error(msg)
    } catch (exc) {
      if (denySkip.has(input.callID)) throw exc
      appendStatusLog(`read watermark gate fail-open (allowed): ${exc}`)
    }
  }

  /** [2026-09-04]-[autoRedirect: deny-postscript candidate shell name verbatim (firstCandidateHint reused; used by the index-layer silent redirect)] */
  function firstCandidateShell(agent: string, ctx: ReturnType<typeof loadContext>, extras?: { water?: WaterFactor; glmPeak?: boolean; states?: Record<string, unknown> }): string | null {
    try {
      const lanes = dynamicLaneMap(ctx)
      const lane = (Object.keys(lanes) as Lane[]).find((l) => lanes[l]?.includes(agent)) ?? "main"
      return firstCandidate(lane, lanes[lane] ?? [], {
        registry: buildRegistry(ctx),
        matrix: ctx.matrix?.combos ?? null,
        routing: routingWithRealFailures(ctx.routing),
        quotaExhausted: quotaExhaustedFlags(),
        billingBoostOf,
        peakOf: peakOfProvider,
        costs: options.cost!.enabled ? costOf : undefined,
        water: extras?.water,
        glmPeak: extras?.glmPeak,
        states: extras?.states as any,
        // [2026-09-03]-[deny-postscript candidates never recommend models outside the task-pool selection list (same source as gate 5.5/banner)]
        poolConfig: loadPoolConfig(),
      } as any, agent)
    } catch {
      return null
    }
  }

  /** deny postscript: first candidate (chain-head shell passing all gates); [2026-08-31]-[final review P1-3: same source as the banner — accepts gateExtras to complete runtime inputs] */
  function firstCandidateHint(agent: string, ctx: ReturnType<typeof loadContext>, extras?: { water?: WaterFactor; glmPeak?: boolean; states?: Record<string, unknown> }): string | null {
    const cand = firstCandidateShell(agent, ctx, extras)
    return cand ? `redirect to ${cand}` : "downgrade chain exhausted: state the reason to the user and offer 2 options"
  }

  return {
    config: async (cfg: Record<string, any>) => {
      try {
        // [2026-08-31]-[config hook first step: load the user watermark config; routing snapshot consistent within this startup]-[fail-open]
        // [2026-09-01]-[jsonc reload rebuilds effective options immediately: thresholds/lanes/banner/rules apply to subsequent requests]
        userConfig = loadUserConfig()
        ;({ options, legacySections } = resolveEffectiveOptions(raw, userConfig.config))
        policy = routePolicy(userConfig.config, legacyObserve)
        const doctor = runDoctor({ configPath: userConfig.path, diagnostics: userConfig.diagnostics, env: process.env, legacy: { quotaEnabled: legacyObserve, billingWindow: Object.prototype.hasOwnProperty.call(raw, "billingWindow"), sections: legacySections } })
        const errors = doctor.diagnostics.filter((d) => d.level === "error").length
        const warns = doctor.diagnostics.filter((d) => d.level === "warn").length
        doctorSummary = errors || warns ? `doctor: ${errors} error / ${warns} warn` : null
        if (doctorSummary) appendStatusLog(`doctor found ${errors} error / ${warns} warn; run /switchman-doctor to view`)
        try { writeJsonAtomic(paths().doctorSnapshot, { at: new Date().toISOString(), diagnostics: doctor.diagnostics.map((d) => ({ code: d.code, level: d.level, path: d.path })) }) } catch { /* fail-open */ }
        collectCreds(cfg)
        creds.copilotToken = creds.copilotToken ?? readAuthStore().githubToken
        // [2026-08-29]-[one-click upgrade command assets: prod registers /switchman-update, local removes leftovers — effective on both legacy/dynamic paths]-
        ensureUpdateCommands(detectLoadMode())
        // [2026-09-03]-[/poolConfig-chat //modelRank-chat: conversational config entries (AI translates to CLI commands);
        //  manual interactive dialogs live in the TUI plugin, keeping the original names /poolConfig //modelRank; the two complement each other]-
        cfg.command = {
          "poolConfig-chat": { template: poolConfigCommandMd(pluginCliPath("switchman-config.js")), description: "Configure task-pool participating models conversationally (economy/mechanical/main/hard/vision/review); use /poolConfig for the manual dialog" },
          "modelRank-chat": { template: modelRankCommandMd(pluginCliPath("switchman-config.js")), description: "Configure model capability ranks conversationally (manual ranks override base capability scores); use /modelRank for the manual dialog" },
          // [2026-09-05]-[/expert: expert consultation — review-pool head preferred, hard-pool head's ro face as fallback;
          //  selection is read live from the [ROUTES] banner at execution time (no stale CLI snapshot), dispatch goes
          //  through the standard six gates + auto-redirect]
          "expert": { template: expertCommandMd(), description: "Dispatch the requirement to the strongest available expert for an answer or design (review pool preferred; falls back to the hard pool's top model on its read-only shell)" },
          // [2026-09-05]-[/switchman-lang: show/reconfigure the project language preference (marker-question re-ask
          //  flows through the same plugin-side capture; see commands-md.langCommandMd)]
          "switchman-lang": { template: langCommandMd(options.workspace?.dirname || DEFAULT_WORKSPACE_DIRNAME), description: "Show or reconfigure this project's language preference (conversation / code comments & commit messages / documents)" },
          // [2026-09-04]-[removed the /handover conversational registration: moved to direct TUI palette execution (fork backup + compaction of the
          //  current session, no AI in the loop); opencode's built-in session.fork (message-selection fork dialog) also occupies /fork,
          //  so the plugin no longer registers a same-name command, avoiding dual entries]-
          // [2026-09-03]-[/poolConfig-chat //modelRank-chat: conversational config entries (AI translates to CLI commands);
          //  manual interactive dialogs live in the TUI plugin, keeping the original names /poolConfig //modelRank; the two complement each other]-
          ...cfg.command,
        }
        // [2026-09-03]-[capability rank/task-pool watch: manual config changes refresh banner and sidebar immediately, not waiting for the next chat message; effective on both legacy/dynamic paths]-[config changes visible immediately]
        startOverrideConfigWatcher()
        if (!dynamic) {
          // legacy: static shells.json path (behavior byte-identical with v1.2)
          const { registry } = currentContext()
          const n = injectShells(cfg, registry)
          appendStatusLog(`injected ${n} model shells (agents, legacy static matrix)`)
          // [2026-08-29]-[config hook triggers the self-update check]-[async check; failure never blocks startup]
          refreshSelfUpdate().then((state) => { if (state?.outdated) clearBannerCache() }).catch(() => {})
          return
        }
        // [2026-08-29]-[superset injection: config once (cfg.agent is immutable at runtime) → runtime activation gating]
        // superset = config surface ∪ all conversational models of credentialed providers ∪ floor models; embedding classes excluded
        const stateRoot = resolveOpencodeStateRoot()
        const configured = readConfiguredSafe(stateRoot, runMode)
        // [2026-09-01]-[instant startup across restarts: after the first successful provider.list probe, providers/models are cached (written only on
        //  real success, see scheduleProviderListWatchdog/the success branch below); non-first startups build shells straight from the cache,
        //  no longer blocking on the provider.list network race at every restart (the old backoff took up to ~30s) — the cache may lag the
        //  latest connection state, so a real probe still runs once in the background: a newly seen provider is what hints a restart, hit rate
        //  unchanged from the old implementation, it just no longer blocks the doorway]
        const providerCache = loadProviderCache()
        let providerModels: { models: string[]; providers: string[]; fellBack: boolean }
        let usedProviderCache = false
        if (providerCache) {
          providerModels = { models: providerCache.models, providers: providerCache.providers, fellBack: false }
          usedProviderCache = true
          appendStatusLog(`provider.list using cross-restart cache (${providerCache.providers.length} providers, cached at ${providerCache.at}); verifying additions in background`)
        } else {
          providerModels = await collectProviderModels(input, cfg)
          if (!providerModels.fellBack) saveProviderCache({ at: nowIso(), models: providerModels.models, providers: providerModels.providers })
        }
        const catalog = await loadCatalog().catch(() => ({ index: {}, status: "none" as const, etag: null }))
        // [2026-09-01]-[floor source change: opencode's bundled free models (OpenCode Zen, models.dev opencode provider
        //  -free ∪ big-pickle special case, 24h rolling) take priority; catalog unavailable (offline cold start) fail-open falls back to the static manifest]
        const freeFloor = freeFloorModels(catalog.index)
        const floorModels = freeFloor.length > 0
          ? freeFloor
          : [...new Set(loadManifest().shells.map((s) => `${s.provider}/${s.modelId}`))]
        if (freeFloor.length > 0) appendStatusLog(`floor = ${freeFloor.length} OpenCode Zen free models (catalog ${catalog.status})`)
        else appendStatusLog(`floor fell back to the static manifest (catalog ${catalog.status}, 0 free models)`)
        // [2026-09-01]-[hardening: configured (visible set/favorites) used to be merged into supersetModels blindly; dirty favorites (e.g. accidentally
        // favoriting "provider/not-a-model" whose provider is not in the real connected set) would be built by buildShells as real,
        // dispatchable-but-doomed shells, and would pollute knownProviders below, distorting computeActivation's "provider known"
        // verdict so the dirty data was never detected. Now filter by the real connected provider set first, logging filtered entries
        // separately instead of passively promoting them into "seemingly legal" shells]
        const realKnownProviders = new Set(providerModels.providers)
        const invalidFavoriteModels = configured.models.filter((m) => !realKnownProviders.has(m.slice(0, m.indexOf("/"))))
        if (invalidFavoriteModels.length > 0) {
          appendStatusLog(`visible set/favorites contain invalid models with unknown provider (provider not connected; ignored, no shells built): ${invalidFavoriteModels.join(", ")}`)
        }
        const validConfiguredModels = configured.models.filter((m) => realKnownProviders.has(m.slice(0, m.indexOf("/"))))
        const supersetModels = [...new Set([...validConfiguredModels, ...providerModels.models, ...floorModels])]
          .filter((full) => isConversational(full.slice(full.indexOf("/") + 1)))
          .sort()
        const metaIndex: Record<string, EffortInfo> = { ...bundledModelIndex(), ...catalog.index }
        // [2026-09-04]-[image relay: the same metadata index serves messages.transform runtime vision queries (same source as shell injection)]
        metaIndexRuntime = metaIndex
        supersetDefs = buildShells(supersetModels, metaIndex, {
          roAliases: true, degradedFamilyByProvider: true, markDegraded: true,
        })
        // [2026-09-04]-[injection surface mode configurable: chain (default) = six-lane chain curation ∪ favorites/visible set (saves 6-10k
        //  tokens/session on the task tool description; out-of-chain models called by name go through denyUninjected hinting to enable them
        //  in model management); all = the full usable set (old behavior, any available model callable). cfg.agent takes effect once;
        //  changing the config needs a restart]
        const injectKeepModels = options.injection!.mode === "all"
          ? new Set(supersetModels)
          : new Set(validConfiguredModels)
        const fullSupersetCount = supersetDefs.length
        supersetDefs = selectInjectableDefs(supersetDefs, {
          customLanes: (options.lanes as Record<string, readonly string[]> | null) ?? null,
          keepModels: injectKeepModels,
          preferredModels: new Set(validConfiguredModels.map((m) => m.slice(m.indexOf("/") + 1))),
          capabilityOf: (modelId) => baseScoreDynamic(modelId),
          billingBoostOf, unknownOf: unknownOfModel,
          costOf: (modelId) => costOf(modelId),
        })
        degradedModelCount = new Set(supersetDefs.filter((d) => d.degraded).map((d) => `${d.provider}/${d.modelId}`)).size
        const { injected, conflicts } = injectShellDefs(cfg, supersetDefs)
        injectedNames.clear()
        for (const n of injected) injectedNames.add(n)
        conflictNames.clear()
        for (const n of conflicts) conflictNames.add(n)
        try {
          writeJsonAtomic(paths().shellSuperset, {
            generated_at: new Date().toISOString(),
            counts: { superset_models: supersetModels.length, shells: supersetDefs.length, full_shells: fullSupersetCount, degraded: degradedModelCount },
            mode: runMode,
            shells: supersetDefs.map(toManifestEntry),
          })
        } catch { /* fail-open */ }
        const knownProviders = new Set<string>([...supersetModels.map((m) => m.slice(0, m.indexOf("/"))), ...providerModels.providers])
        // [2026-09-01]-[async fallback: when the in-hook backoff still falls back entirely, or this startup used the cross-restart cache (no live probe),
        //  the background keeps probing — a newly seen provider can only be hinted as restart-required (hard cfg.agent one-shot constraint, see
        //  the scheduleProviderListWatchdog comment), but at least "would a restart take effect now" becomes a live, explicit status hint]
        if (providerModels.fellBack || usedProviderCache) scheduleProviderListWatchdog(input, knownProviders)
        manager = new MatrixManager({
          stateRoot, mode: runMode, superset: supersetDefs,
          injectedNames, knownProviders,
          watchEnabled: options.matrix!.watch === true,
          onRecompute: (state, newTargets, source) => {
            clearBannerCache()
            // [2026-08-29]-[config-surface changes probe immediately: desktop visible-set toggles / TUI favorites add-remove (config source)
            //  re-probe all active combos without waiting for TTL; session/startup sources keep probing only new combos; the 10min
            //  periodic refresh stays unchanged]-
           const targets = source === "config" ? (manager?.activeMatrixKeys() ?? newTargets) : newTargets
            // [2026-09-01]-[after favorites/visible-set changes the sidebar snapshot must wait for the forced full probe, then be rewritten actively;
            //  relying on the next chat message to trigger bannerLines would leave recommendations stale for a long time]-[config changes visible immediately]
            const probeP = targets.length > 0
              ? probeKeys(targets, probeEndpoints()).catch(() => {})
              : Promise.resolve()
            // [2026-09-02]-[favorites changes shown immediately: recompute is fully synchronous (new chains persisted before this callback), so rewrite
            //  the sidebar snapshot right away — the new chains are computable now with favorites applied; health/latency reuse the previous
            //  probe round, refreshing once more after the probe converges latency ordering. Previously rewriting only in probeP.then left the
            //  sidebar on stale chains during the probe window (seconds to tens of seconds)]-
            // [config changes visible immediately: notifications and sidebar candidates change in sync]
            refreshSidebarState()
            probeP.then(refreshSidebarState).catch(() => {})
            // [2026-08-31]-[switched to persisted status-log rendered by the tui.tsx sidebar, no longer flooding stderr over the input box]-[high-frequency recompute notices]
            appendStatusLog(`activation matrix recomputed (gen=${state.generation}, active shells ${state.activeShells.length}, probes ${source}×${targets.length})`)
          },
        })
        manager.recompute(configured)
        manager.start()
        appendStatusLog(`injected ${injected.size} shells (mode=${runMode}, injection surface=${options.injection!.mode}=${fullSupersetCount}→${supersetDefs.length} after curation, conflicts ${conflicts.size}; activation gating active)`)
        // [2026-08-29]-[config hook triggers the self-update check]-[async check; failure never blocks startup]
        refreshSelfUpdate().then((state) => { if (state?.outdated) clearBannerCache() }).catch(() => {})
      } catch (exc) {
        configFailed = true
        appendStatusLog(`config hook fail-open: ${exc}`)
      }
    },

    "chat.params": async (input) => {
      try {
        // [2026-08-29]-[re-review P1 fix — first-turn timing and classification: the agent name's single source of truth — the injected
        //  shell-name set → isShell; title/compaction/summary → ignore; everything else (including user-defined subagents) → register as main session;
        //  modelKey taken from the Model object's providerID/id (chatParamsModelKey)]
        const sessionID = (input as any).sessionID as string | undefined
        const agent = (input as any).agent as string | undefined
        // [2026-09-04]-[image relay: session main-model record (both paths; used for vision lookup by messages.transform)]
        const modelKey = chatParamsModelKey(input)
        if (sessionID && modelKey) sessionModelKey.set(sessionID, modelKey)
        if (dynamic) {
          if (manager?.noteChatParams(sessionID, agent, chatParamsModelKey(input))) manager.scheduleRecompute(50, "session")
          return
        }
        if (sessionID && agent) sessionAgent.set(sessionID, agent)
      } catch { /* fail-open */ }
    },

    "experimental.chat.system.transform": async (input, output) => {
      try {
        // shell subagents/internal agents get no dispatcher rules or banner (their role is already the executor; saves tokens and prevents role confusion);
        // [2026-08-29]-[re-review P1 fix — first-turn timing: transform runs before chat.params — rely on the agent-name classification pre-registered
        //  by session.created (dynamic = skipSystemInjection; legacy = sessionAgent ∪ internal agent names), not on chat.params arriving first]
        if (input.sessionID) {
          if (dynamic) {
            if (manager?.skipSystemInjection(input.sessionID)) return
          } else {
            const agent = sessionAgent.get(input.sessionID) ?? ""
            if (/-mx-/.test(agent) || agent === "title" || agent === "compaction" || agent === "summary") return
          }
        }
        // [2026-08-29]-[fail-open visibility: explicit warning when injection crashes — don't dispatch; do it yourself or tell the user]-
        if (configFailed) {
          output.system.push("[opencode-switchman] ⚠ plugin injection failed (shells/dispatch gates unavailable) — task delegation forbidden this turn; do it yourself or explain to the user, then proceed yourself")
        }
        // [v1.2] dispatcher rules bundled with the package: injected into the system prompt every turn (in-memory, cannot be lost to local file edits,
        // coexists by concatenation with the user's own global/project AGENTS.md, neither overwriting the other)
        // [2026-09-02]-[dedup: skip re-injection when a project/global AGENTS.md already carries the same text (a user who manually installed
        //  the protocol, saving ~2.2k tokens/session). opencode concatenates the assembled system section into system[0] before transform fires
        //  (session/llm/request.ts prepare), so AGENTS.md content is detectable; if not assembled, detection misses and injection proceeds (fail-safe)]
        //  [2026-09-04]-[repo AGENTS.md is now a dev-only guide, so this branch no longer fires for this repo's own dev sessions]-
        const rulesMarker = "# Global Protocol (master dispatcher rules"
        const rulesAlreadyPresent = Array.isArray(output.system)
          && output.system.some((p) => typeof p === "string" && p.includes(rulesMarker))
        if (options.rules!.enabled && !rulesAlreadyPresent) {
          // [2026-09-04]-[rules interpolation: delegation floor and the three watermark thresholds come from user jsonc (defaults 3k/60k/80k/100k)]
          const t = thresholdsOf(options.context)
          let rules = AGENTS_MD.trimEnd()
            .replaceAll("{{DELEGATION_FLOOR}}", String(options.rules!.delegationFloor ?? DEFAULT_DELEGATION_FLOOR))
            .replaceAll("{{SOFT}}", kk(t.soft))
            .replaceAll("{{HARD}}", kk(t.hard))
            .replaceAll("{{FORCE}}", kk(t.force))
          // [2026-09-05]-[artifact workspace: interpolate the per-session workspace path; disabled/failed → neutralize the
          //  section so agents are never directed into a dead path]
          const ws = await ensureWorkspace(input.sessionID)
          if (ws) rules = rules.replaceAll("{{WORKSPACE_DIR}}", ws.rel)
          else {
            const wsHead = "## 3. Artifact Workspace"
            const start = rules.indexOf(wsHead)
            const end = rules.indexOf("\n## ", start + wsHead.length)
            if (start >= 0 && end > start) rules = `${rules.slice(0, start)}${wsHead}\nDisabled (workspace.enabled=false); no default artifact directory.${rules.slice(end)}`
          }
          output.system.push(rules)
        }
        if (options.banner!.enabled) {
          for (const line of bannerLines()) output.system.push(line)
        }
        // [2026-09-04]-[measured session watermark line: injected into the main session every turn (ok tier reports numbers only); when rules/banner are both off, respect the zero-injection wish]
        if (options.rules!.enabled || options.banner!.enabled) {
          const wmLine = sessionWatermarkLine(input.sessionID)
          if (wmLine) output.system.push(wmLine)
          // [2026-09-05]-[todo nudge line: same gate as the watermark line — re-surfaces the unfinished todo list every turn]
          const todoLine = sessionTodoLine(input.sessionID)
          if (todoLine) output.system.push(todoLine)
        }
        // [2026-09-05]-[project language preference: per-turn [LANG] iron-rule line (settings.json → AGENTS.md marker,
        //  disk re-read every turn = mechanism-enforced stickiness); unconfigured → first-turn-only ask directive
        //  (latched per session; the question-tool answers are captured and persisted plugin-side, never by the model)]
        if (options.lang!.enabled) {
          const loaded = loadLangConfig(pluginDirectory, options.workspace?.dirname || DEFAULT_WORKSPACE_DIRNAME)
          if (loaded) output.system.push(renderLangLine(loaded.cfg, loaded.source))
          else if (options.lang!.ask !== false && input.sessionID && !langAsked.has(input.sessionID)) {
            langAsked.add(input.sessionID)
            output.system.push(renderAskDirective(options.lang!.candidates ?? DEFAULT_LANG_CANDIDATES))
          }
        }
      } catch (exc) {
        appendStatusLog(`rules/banner fail-open: ${exc}`)
      }
    },

    // [2026-09-04]-[image relay: when the main session model has no vision, replace image parts in the last user message with a
    //  "persisted paths + image-reading guidance" text (vision shells/MCP vision tools pick up by path), so the host no longer errors;
    //  metadata unknown/model not found → fail-open, leave as-is; the whole hook is try/catch — the chat stream is never severed]
    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        if (options.relay?.image === false) return
        const msgs = (output as any)?.messages
        if (!Array.isArray(msgs) || msgs.length === 0) return
        let target: { info: any; parts: unknown[] } | null = null
        for (let i = msgs.length - 1; i >= 0; i--) {
          if (msgs[i]?.info?.role === "user") { target = msgs[i]; break }
        }
        if (!target || !Array.isArray(target.parts)) return
        const sid = typeof target.info?.sessionID === "string" ? target.info.sessionID : undefined
        if (!sid || isShellOrInternalSession(sid)) return
        const m = target.info?.model
        const key = sessionModelKey.get(sid)
          ?? (typeof m?.providerID === "string" && typeof m?.id === "string" ? `${m.providerID}/${m.id}` as ModelKey : null)
        if (!key) return
        const meta = (metaIndexRuntime ?? bundledModelIndex())[key]
        const modelVision = meta ? meta.vision === true : null // metadata unknown → null, leave as-is
        if (modelVision !== false) return
        const { ctx } = currentContext()
        // [2026-09-05]-[artifact workspace first: relayed images land in the session workspace media/ (grouped with the
        //  task's other artifacts); global state dir kept as fail-open fallback]
        const ws = await ensureWorkspace(sid)
        const writeDir = ws ? join(ws.abs, "media") : join(stateDir(), "media", sid)
        const res = await relayImageParts(target.parts, {
          modelVision,
          visionHead: laneHeadCandidate("vision", ctx),
          writeDir,
        })
        // write back to output only when parts actually changed (msgs elements are the output.messages[i] references)
        if (res.changed) {
          target.parts = res.parts
          appendStatusLog(`image relay: model ${key} has no vision input; persisted ${res.paths.length} image(s) to disk and injected reading guidance (session ${sid})`)
        }
      } catch (exc) {
        appendStatusLog(`image relay fail-open (passed through): ${exc}`)
      }
    },

    "tool.execute.before": async (input, output) => {
      // [2026-09-04]-[read watermark gate: read-class/bash tools other than task are intercepted by tier per the measured session watermark]
      if (input.tool !== "task") {
        if (input.tool === "bash" || READ_CLASS_TOOLS.has(input.tool)) handleReadGate(input as any, output as any)
        return
      }
      try {
        const { ctx, registry } = currentContext()
        cleanRoutingExpired()
        const agent = String(output.args?.subagent_type ?? "").trim()
        if (!agent) return
        // [2026-08-29]-[gate 1 layer one (dynamic): shell-shaped name but not injected into the superset → deny (with restart/activation guidance);
        //  non-shell unknown stays fail-open allowed]
        let shell: ShellRegEntry | undefined = registry[agent]
        const activationGate = dynamic
          ? {
            enabled: true,
            activeShells: manager ? new Set(manager.snapshot().activeShells) : null,
            conflicts: conflictNames,
            restartRequired: manager?.snapshot().restartRequired ?? [],
          }
          : null
        // [2026-08-31]-[final review P1-3: deny-postscript candidates share the banner's source — add water/glmPeak/states runtime inputs
        //  (quotaView is a cached read, same TTL as quotaExhaustedFlags, no extra network cost)]
        const gateExtras = gateExtrasSnapshot()
        // [2026-09-04]-[autoRedirect: gate snapshot extracted into a shared object (the redirect guard re-checks the target shell with the same snap)]
        const gateSnap = {
          registry,
          matrix: ctx.matrix?.combos ?? null,
          // [2026-08-29]-[feature 1 dynamic matrix only: legacy static path byte-for-byte unchanged (tester regression found the missing gate)]-
          routing: dynamic ? routingWithRealFailures(ctx.routing) : ctx.routing,
          quotaExhausted: quotaExhaustedFlags(),
          routePolicy: policy,
          costs: options.cost!.enabled ? costOf : undefined,
          lanes: dynamicLaneMap(ctx),
          activation: activationGate,
          realFailedCombos: dynamic ? realFailedComboKeys() : undefined,
          retiredModels: dynamic ? new Set(retiredModelKeys()) : undefined,
          // [2026-08-31]-[vendor-neutral: deny-postscript candidates share the banner's ordering]
          billingBoostOf,
          peakOf: peakOfProvider,
          water: gateExtras.water,
          glmPeak: gateExtras.glmPeak,
          states: gateExtras.states as any,
          // [2026-09-03]-[gate 5.5 task-pool selection: manual config overrides system defaults (same source as banner/hint)]
          poolConfig: loadPoolConfig(),
        }
        // [2026-09-04]-[autoRedirect: one-hop guard — re-check the target shell with checkShell on the same snap; target still denied or the redirect
        //  would loop → keep the original deny and return false (the guard only decides pass/block, never a second redirect)]
        const autoRedirectOn = options.dispatch?.autoRedirect !== false
        const tryRedirect = (target: string | null, prompt: unknown): boolean => {
          try {
            if (!autoRedirectOn || !target || target === agent) return false
            const tshell = registry[target]
            if (!tshell) return false
            const g = checkShell(target, tshell, prompt, gateSnap)
            if (g.deny || (g.redirect && g.redirect !== target)) return false
            output.args.subagent_type = target
            return true
          } catch {
            return false
          }
        }
        if (!shell) {
          if (dynamic && shellLikeName(agent)) {
            const hint = firstCandidateHint(agent, ctx, gateExtras)
            // [2026-09-04]-[autoRedirect: uninjected-shell deny — when the META is valid and the chain-head candidate passes the guard, silently redirect and allow]
            if (autoRedirectOn) {
              const [meta, metaErr] = parseRouteMeta(output.args?.prompt)
              const cand = meta !== null && metaErr === null ? firstCandidateShell(agent, ctx, gateExtras) : null
              if (cand && tryRedirect(cand, output.args?.prompt)) {
                appendStatusLog(`auto-redirect ${agent} → ${cand} (uninjected shell; redirected to the chain-head candidate)`)
                traceDispatch(input.sessionID, cand, output.args?.prompt, true)
                return
              }
            }
            // [2026-09-04]-[added denySkip: the original implementation threw in this branch without marking the callID, so the catch-all treated it as
            //  fail-open and allowed it — denyUninjected's "keep throwing" never actually blocked; after the fix the deny is truly rethrown]
            denySkip.add(input.callID)
            throw new Error(denyUninjected(agent, activationGate?.restartRequired ?? [], hint))
          }
          // [2026-09-04]-[built-in subagent blocking: explore/general compete with shell routing; default deny with a redirect suggestion]
          const builtinDeny = builtinAgentDeny(agent, options.builtinAgents!.mode ?? "deny", (lane) => laneHeadCandidate(lane, ctx))
          if (builtinDeny) {
            // [2026-09-04]-[autoRedirect: built-in agent blocking — append a synthetic ROUTE_META to the prompt tail and redirect to the corresponding lane's chain head]
            if (autoRedirectOn) {
              const lane = BUILTIN_SUBAGENTS[agent]
              const cand = lane ? laneHeadCandidate(lane, ctx) : null
              if (cand) {
                const role = lane === "economy" ? "scouter" : "generic"
                const metaLine = `ROUTE_META {"lane":"${lane}","role":"${role}","modality":"text","capability":"ro","source":"auto"}`
                const basePrompt = typeof output.args?.prompt === "string" ? output.args.prompt : ""
                const newPrompt = `${basePrompt}${basePrompt.endsWith("\n") ? "" : "\n"}${metaLine}`
                if (tryRedirect(cand, newPrompt)) {
                  output.args.prompt = newPrompt
                  appendStatusLog(`auto-redirect ${agent} → ${cand} (built-in agent blocked; appended a synthetic ROUTE_META)`)
                  traceDispatch(input.sessionID, cand, newPrompt, true)
                  return
                }
              }
            }
            denySkip.add(input.callID)
            throw new Error(builtinDeny)
          }
          appendStatusLog(noteUnknownAgent(agent))
          traceDispatch(input.sessionID, agent, output.args?.prompt, false)
          return
        }
        const r = checkShell(agent, shell, output.args?.prompt, gateSnap)
        if (r.note) appendStatusLog(r.note)
        if (!r.deny) traceDispatch(input.sessionID, agent, output.args?.prompt, false)
        if (r.deny) {
          // [2026-09-04]-[autoRedirect: denied and a hint candidate is already computed → one-hop silent redirect (guard re-check), zero retries]
          if (tryRedirect(r.redirect, output.args?.prompt)) {
            appendStatusLog(`auto-redirect ${agent} → ${r.redirect} (${r.deny.slice(0, 60)})`)
            traceDispatch(input.sessionID, r.redirect ?? agent, output.args?.prompt, true)
            return
          }
          // [2026-09-04]-[autoRedirect: gate 6 META invalid — synthesize a ROUTE_META at the prompt tail for non-review lanes and re-check the same
          //  shell for pass (review requires a real cross-family producer_family, cannot be synthesized; deny stands)]
          if (autoRedirectOn && !r.redirect && r.deny.includes("invalid ROUTE_META")) {
            const lane = laneOfShell(agent, gateSnap.lanes) ?? "main"
            if (lane !== "review") {
              const role = ({ hard: "planner", main: "programmer", mechanical: "tester", economy: "scouter", vision: "observer" } as Record<string, string>)[lane] ?? "programmer"
              const metaLine = `ROUTE_META {"lane":"${lane}","role":"${role}","modality":"${lane === "vision" ? "image" : "text"}","capability":"${lane === "economy" ? "ro" : "rw"}","source":"auto"}`
              const basePrompt = typeof output.args?.prompt === "string" ? output.args.prompt : ""
              const newPrompt = `${basePrompt}${basePrompt.endsWith("\n") ? "" : "\n"}${metaLine}`
              const g = checkShell(agent, shell, newPrompt, gateSnap)
              if (!g.deny && !(g.redirect && g.redirect !== agent)) {
                output.args.prompt = newPrompt
                appendStatusLog(`auto-redirect ${agent} (added ROUTE_META, ${lane} lane)`)
                traceDispatch(input.sessionID, agent, newPrompt, true)
                return
              }
            }
          }
          denySkip.add(input.callID)
          throw new Error(r.deny)
        }
      } catch (exc) {
        if (denySkip.has(input.callID)) throw exc // deny rethrown as-is (blocks dispatch)
        appendStatusLog(`six gates fail-open (allowed): ${exc}`)
      }
    },

    // [2026-09-04]-[auto-handover: tool.execute.after is awaited on the tool execution path → naturally serialized with the main loop
    //  (no double-burn/race). Triggered only at the force-compaction watermark: soft/hard keep deny+hints so the model wraps up explicitly
    //  (higher summary fidelity); at force the model has lost read ability and the task is likely unfinished — fork a full backup, then
    //  queue compaction of the current session; after compaction is written the host agent loop re-reads messages on the next step via
    //  filterCompactedEffect, so the task continues automatically on "summary + preserved tail" context, no re-prompting needed]
    // [2026-09-05]-[split legs after two deadlock incidents (2026-09-05 11:08/11:26): the backup leg (fork + [backup] tag) is awaited —
    //  DB-local, completed within the trigger second both times; the compaction leg is fired DETACHED — the summarize response returns
    //  only after the whole compaction loop has run on the host session loop, which stays blocked while this hook is awaited, so awaiting
    //  it self-deadlocks until a user interrupt (7m25s/1m40s hangs, both ended the second the user intervened). The measured watermark
    //  falls back with the next assistant message once filterCompacted truncates the pre-compaction history]
    "tool.execute.after": async (hookInput, hookOutput) => {
      // [2026-09-05]-[project language preference capture: our marker question answered → the plugin persists the config
      //  itself (the model never writes the settings file); unrelated tools fall through, fail-open everywhere]
      if (hookInput.tool === "question") {
        try {
          const saved = saveLangFromQuestion(hookInput.args, (hookOutput as any)?.output, pluginDirectory, options.workspace?.dirname || DEFAULT_WORKSPACE_DIRNAME)
          if (saved) {
            langAsked.delete(hookInput.sessionID)
            appendStatusLog(`project language preference saved (${saved.rel}): conversation=${saved.cfg.conversation} comments=${saved.cfg.comments} docs=${saved.cfg.docs}`)
          }
        } catch { /* fail-open */ }
      }
      const sid = hookInput.sessionID
      try {
        if (options.context?.autoHandover === false) return
        if (!sid || isShellOrInternalSession(sid)) return
        const wm = sessionWatermark.get(sid)
        if (!wm) return
        if (watermarkLevel(wm.tokens, thresholdsOf(options.context)) !== "force") return
        if (handoverInflight.has(sid)) return
        if (Date.now() - (handoverCooldown.get(sid) ?? 0) < HANDOVER_COOLDOWN_MS) return
        handoverInflight.add(sid)
        appendStatusLog(`auto-handover triggered (after ${hookInput.tool}, ~${kk(wm.tokens)} exceeds the force-compaction watermark): full backup + queued compaction of the current session`)
        // [2026-09-05]-[backup leg bounded: the SDK disables HTTP timeouts (client.js req.timeout = false), so any unbounded
        //  await here could hang the tool path forever; 45s is generous for the DB-local fork+tag leg (fail-open on timeout)]
        const result = await Promise.race([
          backupSession(v1HandoverPort(pluginClient), sid, pluginDirectory),
          new Promise<HandoverResult>((resolve) => {
            const timer = setTimeout(() => resolve({ ok: false, compacted: false, message: "backup leg timed out after 45s (fail-open)" }), 45_000)
            if (typeof timer === "object" && timer !== null && "unref" in timer) (timer as any).unref()
          }),
        ])
        handoverCooldown.set(sid, Date.now())
        appendStatusLog(`auto-handover backup ${result.ok ? "done" : "failed"}: ${result.message}`)
        // compaction leg: NEVER awaited here (see the 2026-09-05 header note) — fired detached
        if (result.ok) {
          readNudged.delete(sid)
          // [2026-09-05]-[compaction channel = session.summarize (what the manual TUI /compact calls; session.command has
          //  no compact command — registry is markdown/MCP/skill only, v1.18.9 "Command not found" incident). Model face
          //  from the chat.params-tracked ModelKey; auto:true injects the post-compaction continue turn so the task resumes]
          const key = sessionModelKey.get(sid)
          const slash = key?.indexOf("/") ?? -1
          const compactionModel = key && slash > 0 ? { providerID: key.slice(0, slash), modelID: key.slice(slash + 1) } : undefined
          void compactSession(v1HandoverPort(pluginClient), sid, pluginDirectory, compactionModel).then((accepted) => {
            appendStatusLog(
              `auto-handover compaction ${accepted ? "accepted" : "failed"}: ${
                accepted
                  ? "session.summarize returned (compaction ran on the session loop)"
                  : compactionModel
                    ? "session.summarize rejected (backup stands)"
                    : "no session model recorded (chat.params never fired); backup stands"
              }`,
            )
          })
        }
      } catch (exc) {
        appendStatusLog(`auto-handover fail-open: ${exc}`)
      } finally {
        if (sid) handoverInflight.delete(sid)
      }
    },

    event: async ({ event }) => {
      try {
        // [2026-08-29]-[re-review P1 fix — first-turn timing: session.created pre-registration (the event precedes the first chat.params/transform;
        //  records the agent name for transform's first-turn classification; modelKey filled in by chat.params)]
        if (event.type === "session.created") {
          const info = sessionCreatedInfo((event as any).properties)
          if (info) {
            if (dynamic) manager?.noteSessionCreated(info.id, info.agent)
            else sessionAgent.set(info.id, info.agent)
            // [2026-09-05]-[artifact workspace: registered AFTER the agent classification above (shell/internal sessions excluded)]
            noteWorkspaceSession((event as any).properties?.info)
          }
          return
        }
        // [2026-09-05]-[artifact workspace: session.updated carries the generated/edited title → record + ensure
        //  (title rename guarded inside the tracker; steady-state updates do no IO)]
        if (event.type === "session.updated") {
          noteWorkspaceSession((event as any).properties?.info)
          return
        }
        // [2026-09-04]-[measured session context watermark: message.updated → the latest assistant message's token usage
        //  (input+cache.read+reasoning+output ≈ next-round context); shell/internal sessions not counted]
        if (event.type === "message.updated") {
          const props = (event as any).properties
          const sid = props?.sessionID
          const info = props?.info
          if (typeof sid === "string" && info?.role === "assistant" && !isShellOrInternalSession(sid)) {
            const est = estimateContextTokens(info)
            if (est !== null) sessionWatermark.set(sid, { tokens: est, at: Date.now() })
          }
          return
        }
        // [2026-08-29]-[re-review P1 fix — session.deleted shape: properties={info:{id}} (sdk types.gen.ts:576-580);
        //  clean the session registry (dynamic matrix only; non-shell sessions removed → recompute)]
        if (event.type === "session.deleted") {
          const sid = sessionDeletedId((event as any).properties)
          if (sid) {
            sessionWatermark.delete(sid)
            readNudged.delete(sid)
            sessionTodos.delete(sid)
            workspace.forget(sid)
            langAsked.delete(sid)
            if (dynamic && manager?.noteSessionDeleted(sid)) manager.scheduleRecompute(50, "session")
          }
          return
        }
        // [2026-09-05]-[todo nudge: todo.updated replaces the whole list (delete+reinsert in SessionTodo.update) → snapshot
        //  the last event per main session; shell/internal sessions excluded (their lists never face the dispatcher's panel)]
        if (event.type === "todo.updated") {
          const props = (event as any).properties
          const sid = props?.sessionID
          if (typeof sid === "string" && !isShellOrInternalSession(sid) && Array.isArray(props?.todos)) {
            const todos = (props.todos as any[])
              .filter((t) => t && typeof t.content === "string" && typeof t.status === "string")
              .map((t) => ({ content: t.content as string, status: t.status as string }))
            if (todos.length === 0) sessionTodos.delete(sid)
            else sessionTodos.set(sid, { todos, at: Date.now() })
          }
          return
        }
        if (event.type !== "message.part.updated") return
        const part = (event as any).properties?.part
        if (part?.type !== "tool" || part?.state?.status !== "error") return
        if (part.callID && denySkip.has(part.callID)) {
          denySkip.delete(part.callID)
          return // self-deny: no failure accounting
        }
        const agent = String(part.state?.input?.subagent_type ?? "").trim()
        if (!agent) return
        const { ctx, registry } = currentContext()
        const reason = String(part.state?.error ?? part.state?.message ?? "dispatch failed").slice(0, 300)
        const combo = registry[agent]?.comboKey
        // [2026-08-29]-[failure classification: vendor-neutral classification, decided once and reused end to end (transient 429 vs real quota)]
        const category = classifyFailure(reason)
        // [2026-09-01]-[config-layer failure triage: shell not injected = dispatch-layer failure (probe-ok models are not poisoned by gating leaks),
        //  audit only, no isolation, no breaker; endpoint incompatibility = permanent config error, isolated with a 6h long TTL]
        if (category === "shell_injection") {
          recordInjection(agent, reason)
          return
        }
        // [2026-08-29]-[feature 1 dynamic matrix only: legacy keeps the original recordFailure breaker path (tester regression found the missing gate)]-
        const realFailed = dynamic && Boolean(combo && ctx.matrix?.combos[combo]?.status === "ok")
        if (realFailed) {
          // rate limit uses a short TTL (10-min self-heal); endpoint uses 6h (retrying a permanent config error is pointless); others default to 30 minutes
          const ttlMs = category === "rate_limit" ? RATE_LIMIT_TTL_MS : category === "endpoint" ? ENDPOINT_TTL_MS : undefined
          markRealFailure(combo!, undefined, ttlMs)
          // [2026-09-01]-[isolation events persisted: previously purely in-memory with zero audit — the banner reported down but no record existed]
          recordIsolation(agent, combo!, category, ttlMs ?? REAL_FAIL_TTL_MS, reason)
          clearBannerCache()
        }
        const rec = realFailed ? null : recordFailure(agent, reason, registry)
        // Copilot gateway quota-class errors → second truth source marks the pool exhausted (trusted until reset_date)
        // [2026-08-29]-[failure classification: only a real quota marks pool exhaustion, transient 429s never do; quota on non-copilot pools gets no
        //  pool-level handling — the 10min probe keeps reporting down, the banner degrades naturally, and the 30-min in-memory mark already covers it]
        if (category === "quota") {
          const shell = registry[agent]
          if (shell?.pool === "copilot") markCopilotGatewayExhausted(reason)
        }
        // retired-model class (consecutive 404s) → retire and remove from candidates
        if (category === "not_found" && dynamic) {
          const shell = registry[agent]
          if (shell && noteModelNotFound(`${shell.provider}/${shell.modelId}`)) {
            clearBannerCache()
            appendStatusLog(`model retired (consecutive 404s), removed from candidates: ${shell.provider}/${shell.modelId}`)
          }
        }
        if (rec?.tripped) appendStatusLog(`${agent} breaker tripped (600s): ${reason.slice(0, 80)}`)
      } catch (exc) {
        appendStatusLog(`failure accounting fail-open: ${exc}`)
      }
    },
  }
}

export default SwitchmanPlugin
