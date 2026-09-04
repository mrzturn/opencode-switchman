// [2026-09-04]-[English localization: translate comments and deny/hint messages; no logic change]
// Six-gate checks (order = priority; any hit denies)
// Pure functions: all state injected via GateSnapshot; deny = return a reason (index.ts layer turns it into a thrown Error to block).
import { META_LEGAL } from "./types"
import type { GateSnapshot, Meta, ShellRegEntry } from "./types"
import { metaErrorHint, parseRouteMeta } from "./meta"
import { computeLane, firstCandidate, laneOfShell } from "./lane"
import { baseScoreDynamic, normalizeModelKey } from "./capability"
import { isFallbackCandidate, isPrimaryCandidate } from "./lane-policy"

// [2026-09-04]-[autoRedirect: the deny-note candidate is also exposed as redirect (consumed by the index layer for
//  zero-retry silent redirection); non-redirectable classes (same-name conflict / chain exhausted with no candidate / gate-6 meta) stay null]
// [2026-09-04]-[English localization: deny copy is now English — the earlier "deny copy frozen verbatim (locked by
//  legacy fixtures)" constraint is lifted as of 2026-09-04; test fixtures updated in sync]
export interface GateResult { deny: string | null; note: string | null; redirect: string | null }

function matrixStatus(shell: ShellRegEntry, mcombos: GateSnapshot["matrix"]): [string, string] {
  if (!shell.matrixKey) return ["unprobed", ""]
  const entry = mcombos?.[shell.matrixKey] ?? ({} as any)
  const status = String(entry?.status ?? "").toLowerCase() || "missing"
  return [status, String(entry?.reason ?? "").slice(0, 80)]
}

const ROLE_LANE: Partial<Record<string, import("./types").Lane>> = {
  planner: "hard", reviewer: "review", programmer: "main", uiux: "main", "data-analyst": "main",
  tester: "mechanical", ops: "mechanical", scouter: "economy", clerk: "economy", observer: "vision",
  "expert-alpha": "review", "expert-beta": "review", "expert-gamma": "review", generic: "main",
}

function laneForCheck(shellName: string, meta: Meta | null, lanes: Record<string, string[]>): string {
  const lane = meta?.lane
  if (lane && (META_LEGAL.lane as readonly string[]).includes(lane)) return lane
  return ROLE_LANE[meta?.role ?? ""] ?? laneOfShell(shellName, lanes) ?? "main"
}

export function checkShell(
  agent: string,
  shell: ShellRegEntry,
  prompt: unknown,
  snap: GateSnapshot & { lanes: Record<string, string[]> },
): GateResult {
  const [meta, metaErr] = parseRouteMeta(prompt)
  const lane = laneForCheck(agent, meta, snap.lanes)
  const base = snap.lanes[lane] ?? []
  const regOk = snap.registry !== null

  const buildParams = (laneOverride?: string) => {
    const metaKw: Record<string, unknown> = {}
    if (meta?.producer_family) metaKw.producerFamily = meta.producer_family
    if (meta?.modality) metaKw.modality = meta.modality
    if (meta?.source) metaKw.source = meta.source
    if (meta?.capability) metaKw.capability = meta.capability
    return {
      registry: snap.registry,
      matrix: snap.matrix,
        routing: snap.routing,
        quotaExhausted: snap.quotaExhausted,
        routePolicy: snap.routePolicy,
      // [2026-08-31]-[de-vendorization: deny-note candidate ordering shares one source with the banner (billing/peak factors)]
      billingBoostOf: snap.billingBoostOf,
      peakOf: snap.peakOf,
      // [2026-08-31]-[final-review P1-3: deny-note candidates get the runtime inputs water/costs/glmPeak/states]
      costs: snap.costs,
      water: snap.water,
      glmPeak: snap.glmPeak,
      states: snap.states,
      // [2026-09-03]-[deny-note candidates share the task-pool selection list: the hint never recommends a model that missed the list]
      poolConfig: snap.poolConfig,
      ...metaKw,
      _lane: laneOverride,
    }
  }

  // [2026-09-04]-[autoRedirect: candidate shell-name computation split out and reused by the hint copy; redirect exposes the same value]
  const candidateOf = (laneOverride?: string): string | null => {
    try {
      const p = buildParams() as any
      const useLane = (laneOverride ?? lane) as import("./types").Lane
      return firstCandidate(useLane, snap.lanes[useLane] ?? base, p, agent)
    } catch {
      return null
    }
  }
  const hint = (laneOverride?: string): string => {
    const cand = candidateOf(laneOverride)
    return cand ? `, redirect to ${cand}` : ", downgrade chain exhausted: tell the user why and offer 2 options"
  }

  // Gate 1 registry three states: enabled is the only dispatchable state; discovered = unprobed face → deny;
  // disabled is distinguished by matrix cause (only down denies; unknown/missing fail-open with a note)
  // [2026-08-29]-[dynamic-matrix gate 1 split into three layers: same-name conflict / not activated deny here (the uninjected layer is handled by index.ts denyUninjected)]
  const act = snap.activation
  if (act && act.enabled) {
    if (act.conflicts && act.conflicts.has(agent)) {
      // Non-redirectable class: same-name conflict requires user action
      return { deny: `${agent} conflicts with a user-defined agent of the same name, not dispatchable (rename or delete the custom agent)${hint()}`, note: null, redirect: null }
    }
    if (act.activeShells && !act.activeShells.has(agent)) {
      const restart = act.restartRequired.length > 0
        ? `; new provider(s) (${act.restartRequired.join(", ")}) require an opencode restart to register their shells`
        : ""
      const cand = candidateOf()
      return {
        // [2026-08-29]-[re-review P2 wording fix: "realtime" → "takes effect on the next request" (activation-face changes reach the dispatch gate on the next tool delegation)]
        deny: `${agent} not activated (model not in the current activation matrix: set it visible in model management / add it to favorites / switch the main session to this model to activate; takes effect on the next request${restart})${hint()}`,
        note: null,
        redirect: cand,
      }
    }
  }
  const status = String(shell.status)
  if (status !== "enabled") {
    const [mstat, mreason] = snap.matrix !== null ? matrixStatus(shell, snap.matrix) : ["unknown", ""]
    if (status === "disabled" && snap.matrix !== null && mstat !== "down") {
      return {
        deny: null,
        note: `[opencode-switchman] ${agent} registry=disabled but matrix status=${mstat || "missing"} (not down): fail-open, auto-corrected after the next probe refresh`,
        redirect: null,
      }
    }
    const cand = candidateOf()
    return {
      deny: `${agent} not dispatchable (registry status=${status}${snap.matrix !== null && mstat === "down" ? `, matrix ${mstat}: ${mreason}` : ""})${hint()}`,
      note: null,
      redirect: cand,
    }
  }

  // Gate 2 matrix: only blocks an explicit down; unknown/missing fail-open with a note
  if (snap.matrix !== null) {
    const [mstat, mreason] = matrixStatus(shell, snap.matrix)
    if (mstat === "down") {
      return { deny: `${agent} unavailable (matrix down, ${mreason})${hint()}`, note: null, redirect: candidateOf() }
    }
    if (mstat === "unknown" || mstat === "missing" || mstat === "unprobed") {
      return { deny: null, note: `[opencode-switchman] ${agent} matrix status=${mstat} (not down): not blocked, probe refreshes next round`, redirect: null }
    }
  }

  // Gate 2.5: model retired (consecutive 404s remove it from candidates permanently; cleared on restart; only the dynamic matrix injects retiredModels)
  // [2026-08-29]-[failure classification: vendor-agnostic; deny on provider/modelId hit, no pool hardcoding]
  if (snap.retiredModels?.has(`${shell.provider}/${shell.modelId}`)) {
    return { deny: `${agent} unavailable (model retired: consecutive 404s, redirect to another candidate)${hint()}`, note: null, redirect: candidateOf() }
  }

  // Gate 3: in-process isolation for probe-ok but real-call failures (not persisted; recovers after 30 minutes or on restart)
  if (shell.comboKey && snap.realFailedCombos?.has(shell.comboKey)) {
    return { deny: `${agent} temporarily unavailable (probe ok but actual delegation failed; auto-unlocks after 30 minutes or restart opencode)${hint()}`, note: null, redirect: candidateOf() }
  }

  // Gate 4 breaker: down_agents hit by shell name or comboKey (600s window × 2 failures)
  const down = snap.routing?.down_agents
  if (down && ((agent in down) || (shell.comboKey && shell.comboKey in down))) {
    return { deny: `${agent} temporarily unavailable (breaker tripped after consecutive failures; auto-recovers in about 10 minutes)${hint()}`, note: null, redirect: candidateOf() }
  }

  // Gate 5 pool exhaustion (only blocks when calls are certain to fail; unknown/high watermark does not block)
  const pool = shell.pool
  if (snap.quotaExhausted?.[pool] && snap.routePolicy?.[pool]?.routing !== false) {
    const why = pool === "glm"
      ? "GLM plan exhausted"
      : pool === "copilot" ? "Copilot credits exhausted" : "DeepSeek balance exhausted"
    return { deny: `${agent} temporarily unavailable (${why})${hint()}`, note: null, redirect: candidateOf() }
  }

  // Gate 5.5 task-pool selection (manual pool-config.json): lane → participating-model list; a non-empty list overrides
  // the system default candidate set (the same model may join several lanes); unconfigured = fail-open (the lane falls back to the system default)
  {
    const allow = snap.poolConfig?.[lane]
    if (allow && allow.size > 0 && !allow.has(normalizeModelKey(shell.modelId))) {
      return { deny: `${agent} not in the ${lane} task-pool selection list (use /poolConfig to adjust participating models per task pool, or redirect to another candidate)${hint()}`, note: null, redirect: candidateOf() }
    }
  }

  // Gate 6 ROUTE_META hard gate: missing line / malformed / invalid field / missing required field all deny with a sample + live candidate
  if (metaErr !== null) {
    const fallbackLane = laneForCheck(agent, null, snap.lanes)
    let fallback: string
    try {
      const c = firstCandidate(fallbackLane as import("./types").Lane, snap.lanes[fallbackLane] ?? [], buildParams() as any, agent)
      fallback = c ? `, redirect to ${c}` : ", downgrade chain exhausted: tell the user why and offer 2 options"
    } catch {
      fallback = ", downgrade chain exhausted: tell the user why and offer 2 options"
    }
    return {
      deny: `${agent} dispatched to a shell name, invalid ROUTE_META: ${metaErrorHint(metaErr)}${fallback}`,
      note: null,
      // redirection happens in index.ts (the prompt must be rewritten to synthesize META); stays null here
      redirect: null,
    }
  }
  const role = meta!.role

  // Gate 7 semantic checks
  if (role === "reviewer") {
    const pf = meta!.producer_family
    if (pf && pf === String(shell.family)) {
      return { deny: `${agent} same family as producer (${pf}); re-review requires a cross-family perspective${hint("review")}`, note: null, redirect: candidateOf("review") }
    }
  }
  if (meta!.capability === "rw" && String(shell.capability) === "ro") {
    return { deny: `${agent} is a read-only shell (ro) and cannot take rw write tasks${hint()}`, note: null, redirect: candidateOf() }
  }
  if ((meta!.modality === "image" || meta!.modality === "vision") && !shell.vision) {
    return { deny: `${agent} is not a vision shell and cannot take modality=${meta!.modality} tasks${hint("vision")}`, note: null, redirect: candidateOf("vision") }
  }
  if (lane === "vision" && meta!.modality === "text") {
    return { deny: `${agent} lane=vision requires declaring an image/vision modality${hint("vision")}`, note: null, redirect: candidateOf("vision") }
  }
  const capability = baseScoreDynamic(shell.modelId)
  if (!isPrimaryCandidate(lane as import("./types").Lane, capability) && !isFallbackCandidate(lane as import("./types").Lane, capability)) {
    return { deny: `${agent} capability level too low to take ${lane} tasks${hint()}`, note: null, redirect: candidateOf() }
  }
  if (isFallbackCandidate(lane as import("./types").Lane, capability) && meta!.source !== "user") {
    let current
    try {
      current = computeLane(lane as import("./types").Lane, snap.lanes[lane] ?? base, buildParams() as any)
    } catch {
      return { deny: `${agent} cannot confirm cross-level fallback eligibility for ${lane}; dispatch denied to avoid an unintended downgrade${hint()}`, note: null, redirect: candidateOf() }
    }
    if (!current.chain.some((candidate) => candidate.shell === agent)) {
      return { deny: `${agent} not among the top-2 cross-level fallback candidates for ${lane}${hint()}`, note: null, redirect: candidateOf() }
    }
    if (current.chain.some((candidate) => isPrimaryCandidate(lane as import("./types").Lane, baseScoreDynamic(snap.registry?.[candidate.shell]?.modelId ?? "")))) {
      return { deny: `${agent} is a cross-level fallback candidate for ${lane}; same-level models are still available${hint()}`, note: null, redirect: candidateOf() }
    }
  }
  // [2026-08-31]-[de-vendorization: removed the hard deny for source=auto mis-picking pay-as-you-go pools — api billing is
  //  soft-sorted by the billingBoost product factor (after subscription within the same tier); deny now keeps only the META
  //  format gate and the review cross-family / ro / vision structural gates]
  return { deny: null, note: null, redirect: null }
}

/** Unregistered / non-shell name → fail-open (unknown built-in agents are not governed by routing) */
export function noteUnknownAgent(agent: string): string {
  return `[opencode-switchman] unknown subagent_type='${agent}': allowed (not in the shell list; built-in agents are not governed by routing)`
}

/** [2026-09-04]-[built-in subagent block: explore/general competed with shell routing while being fail-open by default,
 *  and the main model's exploration tasks were drawn to the built-in agents by core tool descriptions; default deny with an economy/main redirect hint] */
export const BUILTIN_SUBAGENTS: Readonly<Record<string, import("./types").Lane>> = {
  explore: "economy",
  general: "main",
}

export function builtinAgentDeny(
  agent: string,
  mode: "deny" | "allow",
  laneHead: (lane: import("./types").Lane) => string | null,
): string | null {
  if (mode !== "deny") return null
  const lane = BUILTIN_SUBAGENTS[agent]
  if (!lane) return null
  const cand = laneHead(lane)
  const role = lane === "economy" ? "scouter" : "generic"
  const target = cand ? `, redirect to ${cand} (ROUTE_META role=${role})` : ", dispatch to the first shell on the [ROUTES] chain in the banner"
  return `[opencode-switchman] built-in agent '${agent}' does not participate in shell routing (shell delegation is enforced to preserve quota awareness / cross-family re-review / watermark gates)${target}; if a built-in agent is truly needed: set builtinAgents.mode="allow" in opencode-switchman.jsonc and restart`
}

/** Shell-name shape check (only for shape recognition in the "uninjected superset" deny; isShell always goes through the registry, heuristics forbidden) */
export function shellLikeName(agent: string): boolean {
  return /^[a-z][a-z0-9]*-mx-[a-z0-9]+-[a-z]+(-ro)?$/.test(agent)
}

/** [2026-08-29]-[dynamic-matrix gate 1, layer 1: shell-shaped name but not injected into the superset → deny (model disabled / no credentials / new provider needs a restart)]
 *  [2026-09-02]-[the injection face became the six-lane chain selection (selectInjectableDefs); copy added a "missed the selection" case to avoid misleading troubleshooting]
 *  [2026-09-02 fix]-[injection-face semantics became "available superset ∪ chain selection": available models are all injected, so uninjected = provider
 *  not connected / no credentials / non-chat model; the copy no longer mentions "missed the selection" to avoid misleading] */
export function denyUninjected(agent: string, restartRequired: string[], hint: string | null): string {
  const restart = restartRequired.length > 0
    ? `provider(s) outside the superset detected (${restartRequired.join(", ")}): new providers require an opencode restart to register their shells`
    : "if this is a new provider, an opencode restart is required to register its shells"
  return `${agent} not injected into the shell superset (provider not connected / no credentials / non-chat model; new providers require an opencode restart)${restart}${hint ? `, ${hint}` : ""}`
}
