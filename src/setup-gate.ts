// [2026-09-19]-[setup gate: switchman no longer defaults to all models when unconfigured — task dispatch is denied
//  until all 6 task pools have >=1 selected model and the capability ranking has >=1 ranked model. Pure helpers +
//  thin IO wrappers (mtime-cached reads, so a config written by /switchman-setup opens the gate immediately without
//  a restart); model-facing copy stays English by design (byte-stable across locales, the [LANG] rule makes the
//  model relay the remedy in the user's conversation language) — wiring in src/index.ts, guided wizard in src/tui.tsx,
//  chat fallback template in src/commands-md.ts]
import { LANE_ORDER, type Lane } from "./types"
import { loadCapabilityRank, loadPoolConfig } from "./user-overrides"

export interface SetupCompletion {
  complete: boolean
  /** Lanes with no pool selection, in LANE_ORDER order; empty when all 6 are configured */
  missingLanes: Lane[]
  /** Count of configured lanes (0..6) */
  configuredLanes: number
  /** capability-rank.json absent or its models list is empty */
  missingRank: boolean
}

/** Pure completion evaluation from injected state (test-friendly; a lane with an empty selection counts as missing) */
export function evaluateSetup(
  poolCfg: Record<string, ReadonlySet<string>> | null | undefined,
  rankModels: readonly string[] | null | undefined,
): SetupCompletion {
  const missingLanes = LANE_ORDER.filter((lane) => {
    const sel = poolCfg?.[lane]
    return !sel || sel.size === 0
  })
  const missingRank = !rankModels || rankModels.length === 0
  return {
    complete: missingLanes.length === 0 && !missingRank,
    missingLanes,
    configuredLanes: LANE_ORDER.length - missingLanes.length,
    missingRank,
  }
}

/** Live completion (fresh mtime-cached reads; fail-open reads yield "unconfigured") */
export function setupCompletionNow(): SetupCompletion {
  return evaluateSetup(loadPoolConfig(), loadCapabilityRank()?.models ?? null)
}

/** Model-facing deny (English, byte-stable by design); the model relays the remedy in the user's conversation language */
export function setupDenyMessage(c: SetupCompletion): string {
  const parts: string[] = []
  if (c.missingLanes.length > 0) {
    parts.push(c.missingLanes.length === LANE_ORDER.length
      ? `task-pool selection for all ${LANE_ORDER.length} pools (${LANE_ORDER.join(", ")})`
      : `task-pool selection for pools: ${c.missingLanes.join(", ")}`)
  }
  if (c.missingRank) parts.push("capability ranking (at least one ranked model)")
  return "[opencode-switchman] BLOCKED (setup required): dispatch is denied until switchman is configured — unconfigured no longer defaults to all models. Missing: "
    + parts.join("; ")
    + ". Ask the user to run /switchman-setup (TUI slash command), or /switchman-setup-chat here when the TUI plugin is not installed, then retry — relay this guidance in the user's conversation language. Setup saves pool-config.json / capability-rank.json and takes effect immediately via hot-reload."
}

/** Directive body pushed into the system prompt each user turn while setup is incomplete (English by design) */
export function setupDirective(c: SetupCompletion): string {
  const parts: string[] = []
  if (c.missingLanes.length > 0) parts.push(`task pools configured ${c.configuredLanes}/${LANE_ORDER.length}`)
  if (c.missingRank) parts.push("capability ranking missing")
  return `[SETUP] switchman setup incomplete (${parts.join(", ")}). Tell the user (in their conversation language) to run /switchman-setup in the TUI, or /switchman-setup-chat here. HARD GATE: every task call is denied until all ${LANE_ORDER.length} task pools have at least one model selected and the capability ranking has at least one ranked model.`
}

/** Short English brief for the sidebar notice `{missing}` param */
export function setupMissingBrief(c: SetupCompletion): string {
  const parts: string[] = []
  if (c.missingLanes.length > 0) parts.push(`pools ${c.configuredLanes}/${LANE_ORDER.length}`)
  if (c.missingRank) parts.push("rank missing")
  return parts.join(", ")
}
