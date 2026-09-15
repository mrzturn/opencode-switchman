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

// [2026-09-14]-[D5: lane-default role table for the gate-6 synthesizer — the five non-review entries are exactly the
//  table hardcoded at index.ts's former synthesis sites; review → reviewer (the review lane's own role, so gate 7's
//  reviewer branch runs with producer_family absent = the cross-family preference is unenforced)]
const LANE_DEFAULT_ROLE: Record<string, string> = {
  hard: "planner", main: "programmer", mechanical: "tester", economy: "scouter", vision: "observer", review: "reviewer",
}

// [2026-09-14]-[D5: the gate-6 ROUTE_META disposition — MISSING (no parseable line) / MALFORMED (line present but
//  unparseable) no longer deny: gate 6 synthesizes the lane-default META (the former index.ts synthesis table) and
//  continues into gate 7 with an observe note. Only ABSENCE is synthesized: a PRESENT-but-wrong META (invalid field
//  value, or a parseable line missing required fields) stays a producer-error deny with the sample hint. Gate 7
//  semantics on the synthesized meta: producer_family absent → review cross-family preference unenforced (the
//  same-family DOWNGRADED note path still applies); source "auto" → fallback-eligibility checks apply unchanged.
//  Review lane synthesizes capability "ro" (review is an ro lane) so the synthesized meta does not structurally
//  deny every ro review shell at the rw/ro check — that would contradict the downgrade for the exact corner
//  (autoRedirect off / review lane) that motivated it]-
function synthesizeMeta(agent: string, lanes: Record<string, string[]>): Meta {
  const lane = (laneOfShell(agent, lanes) ?? "main") as import("./types").Lane
  return {
    lane,
    role: LANE_DEFAULT_ROLE[lane] ?? "programmer",
    capability: lane === "economy" || lane === "review" ? "ro" : "rw",
    modality: lane === "vision" ? "image" : "text",
    source: "auto",
  }
}

const ROUTE_META_SYNTH_NOTE = "[opencode-switchman] ROUTE_META missing/malformed — synthesized from lane; declare it to enable review cross-family / source=user semantics"

export function checkShell(
  agent: string,
  shell: ShellRegEntry,
  prompt: unknown,
  snap: GateSnapshot & { lanes: Record<string, string[]> },
): GateResult {
  const [parsedMeta, metaErr] = parseRouteMeta(prompt)
  let meta = parsedMeta
  let metaSynthNote: string | null = null
  // [2026-09-14]-[D5 downgrade-to-observe: a MISSING (no parseable line) or MALFORMED (line present but unparseable)
  //  META no longer denies — gate 6 synthesizes the lane-default META and continues into gate 7 with an observe note
  //  (see synthesizeMeta). Only ABSENCE is synthesized; a PRESENT-but-wrong META (invalid field value / missing
  //  required field on a parseable line) keeps the gate-6 deny below — a producer error the delegator must fix]-
  if (metaErr === "missing" || metaErr === "malformed") {
    meta = synthesizeMeta(agent, snap.lanes)
    metaSynthNote = ROUTE_META_SYNTH_NOTE
  }
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

  // Gate 6 ROUTE_META hard gate [2026-09-14]-[D5: only PRESENT-but-wrong META denies now — an invalid field value, or
  //  a parseable line missing required fields (a producer error worth surfacing with the sample + live candidate);
  //  missing/malformed was already synthesized above and never reaches this branch]
  if (metaErr !== null && metaErr !== "missing" && metaErr !== "malformed") {
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
      // a present-but-wrong META must be corrected by the delegator (rewriting it plugin-side would mask the error); stays null here
      redirect: null,
    }
  }
  const role = meta!.role

  // [2026-09-05]-[review same-family self-review fallback: cross-family reviewers stay strictly preferred; when the
  //  review chain carries no cross-family candidate at all, a same-family shell is allowed as a last-resort
  //  self-review seat (DOWNGRADED) instead of an unconditional deny that dead-ends the review lane ("review: none
  //  available"). The exemption note is attached at the final return so the structural rw/ro + vision gates and the
  //  fallback-chain checks below still apply to an exempted dispatch; a deny always supersedes the note.]
  const REVIEW_SELF_REVIEW_NOTE = "[opencode-switchman] DOWNGRADED: no cross-family reviewer available — same-family self-review allowed; declare DOWNGRADED in the review conclusion"
  let reviewSelfReviewNote: string | null = null
  // Lazily computed once, only when the review-lane chain is actually needed (same try/catch pattern as the fallback block below)
  let reviewChain: import("./types").LaneResult | null = null
  let reviewChainDone = false
  const reviewChainOf = (): import("./types").LaneResult | null => {
    if (reviewChainDone) return reviewChain
    reviewChainDone = true
    try {
      // [2026-09-05]-[capability pinned to "ro": the review chain answers "which reviewer shells are alive" (review is
      //  an ro lane), so the dispatching task's own capability=rw must not filter ro reviewers out — with the raw META
      //  capability every ro shell would be dropped and the chain would read empty, falsely signalling "no cross-family
      //  reviewer". producerFamily still flows through for the famClass tail ordering.]
      reviewChain = computeLane("review" as import("./types").Lane, snap.lanes.review ?? base, { ...buildParams() as any, capability: "ro" })
    } catch {
      reviewChain = null
    }
    return reviewChain
  }

  // Gate 7 semantic checks
  if (role === "reviewer") {
    const pf = meta!.producer_family
    if (pf && pf === String(shell.family)) {
      // Deny stays only while a cross-family candidate exists on the review chain; ranking already sinks the
      // same-family shell to the chain tail (scoring famClass), so cross-family is still served first.
      const hasCrossFamily = reviewChainOf()?.chain.some((c) => String(c.family ?? "") !== String(pf).toLowerCase()) ?? false
      if (hasCrossFamily) {
        return { deny: `${agent} same family as producer (${pf}); re-review requires a cross-family perspective${hint("review")}`, note: null, redirect: candidateOf("review") }
      }
      reviewSelfReviewNote = REVIEW_SELF_REVIEW_NOTE
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
    // [2026-09-05]-[review last-resort seat exemption: a below-fallback shell (e.g. B-tier/L3) holding a last-resort
    //  review seat — on the chain while the chain carries no L5 primary candidate — is allowed with the DOWNGRADED
    //  note instead of denying "capability level too low", keeping the review lane dispatchable when only B-tier
    //  models are alive; other lanes unchanged]
    if (lane === "review") {
      const rc = reviewChainOf()
      const onChain = Boolean(rc?.chain.some((c) => c.shell === agent))
      const noPrimary = Boolean(rc && !rc.chain.some((c) => isPrimaryCandidate("review" as import("./types").Lane, baseScoreDynamic(snap.registry?.[c.shell]?.modelId ?? ""))))
      // [2026-09-14]-[D5: the gate-6 synth note rides along when the META was synthesized for this dispatch]
      if (onChain && noPrimary) return { deny: null, note: [metaSynthNote, REVIEW_SELF_REVIEW_NOTE].filter(Boolean).join(" ") || null, redirect: null }
    }
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
  //  format gate, the review ro / vision structural gates, and the review cross-family deny (kept while a cross-family
  //  candidate exists on the review chain)]
  // [2026-09-05]-[review same-family self-review: the last-resort exemption note (no cross-family reviewer on the chain)
  //  is emitted here after every structural gate passed]
  // [2026-09-14]-[D5: a synthesized META rides as an observe note (a deny always supersedes it); both notes joined when they co-occur]
  return { deny: null, note: [metaSynthNote, reviewSelfReviewNote].filter(Boolean).join(" ") || null, redirect: null }
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
 *  not connected / no credentials / non-chat model; the copy no longer mentions "missed the selection" to avoid misleading]
 *  [2026-09-05 fix]-[sentence separator: the restart clause was concatenated onto the closing paren ("...restart)if this is...") — split into its own sentence] */
export function denyUninjected(agent: string, restartRequired: string[], hint: string | null): string {
  const restart = restartRequired.length > 0
    ? `provider(s) outside the superset detected (${restartRequired.join(", ")}): new providers require an opencode restart to register their shells`
    : "if this is a new provider, an opencode restart is required to register its shells"
  return `${agent} not injected into the shell superset (provider not connected / no credentials / non-chat model). ${restart}${hint ? `. ${hint}` : ""}`
}
