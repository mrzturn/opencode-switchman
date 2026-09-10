// [2026-09-04]-[English localization: translate CLI messages and comments; no logic change]
// switchman-config CLI (bundled asset, runs directly with node/bun): read/write entry for task-pool selection and capability ranking.
// For all clients outside the /poolConfig-chat, /modelRank-chat command templates and the TUI popup; all commands are non-interactive.
// [2026-09-03]-[Added with the task-pool selection/manual ranking features; [2026-09-03 semantics fix]-[pool = task-pool lane (not a provider pool);
//  select the models joining each lane, the same model may join multiple lanes]; exit codes 0=success 1=failure]
import { baseScoreDynamic, normalizeModelKey } from "./capability"
import { loadSupersetShells, loadManifest, paths } from "./state"
import {
  loadCapabilityRank, loadPoolConfig, poolAllowlist,
  writeCapabilityRank, clearCapabilityRank, writePoolConfig, resetPoolConfig,
  type RankScoreOverride,
} from "./user-overrides"
import { LANE_ORDER, type Lane } from "./types"
import { TIER_RANK } from "./model-ranks"

interface ModelRow { key: string; modelId: string; tier: string; source: string; raw: number | null; manualIdx?: number }

// [2026-09-10]-[manual-first tie-break: on exact (tier, raw) ties manual entries sort above base entries, ordered by
//  their models-array slot — lets anchored moves win ties without touching base-vs-base ordering]
function capabilityCompare(a: ModelRow, b: ModelRow): number {
  return TIER_RANK[a.tier as "S"] - TIER_RANK[b.tier as "S"] ||
    (b.raw ?? -Infinity) - (a.raw ?? -Infinity) ||
    (a.manualIdx ?? Infinity) - (b.manualIdx ?? Infinity) ||
    a.key.localeCompare(b.key)
}

function toRow(modelId: string): ModelRow {
  const base = baseScoreDynamic(modelId)
  const key = normalizeModelKey(modelId)
  const row: ModelRow = {
    key,
    modelId,
    tier: base.tier,
    source: base.source,
    raw: base.rawScore ?? null,
  }
  // manual array slot (undefined for non-manual rows): the merged view uses it as the exact-tie tie-break
  if (base.source === "manual" && base.matchedAs) {
    const idx = loadCapabilityRank()?.models.indexOf(base.matchedAs) ?? -1
    if (idx >= 0) row.manualIdx = idx
  }
  return row
}

/** All available models (full-superset candidates first — every conversable model of credentialed providers — falling back to
 *  the injection-face shells, then the bundled manifest; deduped by modelId across provider pools); sorted by effective capability descending
 *  [2026-09-10]-[candidate surface widened from the pruned injection face to the full superset: pools can now be configured
 *  with models that are not (yet) favorites/visible — actual chain candidacy is still decided at runtime by pool selection ∩ activation] */
export function allModelRows(): ModelRow[] {
  const sup = loadSupersetShells()
  const shells = (sup?.candidates && sup.candidates.length > 0 ? sup.candidates : sup?.shells) ?? loadManifest().shells
  const seen = new Set<string>()
  const rows: ModelRow[] = []
  for (const s of shells) {
    const key = normalizeModelKey(s.modelId)
    if (!key || seen.has(key)) continue
    seen.add(key)
    rows.push(toRow(s.modelId))
  }
  rows.sort(capabilityCompare)
  return rows
}

function fmtRow(n: number, row: ModelRow, selected: boolean): string {
  const mark = selected ? "[x]" : "[ ]"
  const manualTag = row.source === "manual" ? "·manual rank" : ""
  return ` #${String(n).padStart(2, "0")} ${mark} ${row.modelId} (${row.tier}-tier${manualTag})`
}

function laneOrThrow(lane?: string): Lane {
  const key = String(lane ?? "").trim().toLowerCase() as Lane
  if (!(LANE_ORDER as string[]).includes(key)) {
    throw new Error(`unknown task pool: ${lane ?? "(missing)"} (six task pools: ${LANE_ORDER.join("/")})`)
  }
  return key
}

function printPoolList(filterLane?: string): void {
  const rows = allModelRows()
  const allow = loadPoolConfig()
  const head = `Task-pool selection (config file ${paths().poolConfig}; selection = the models joining that task pool; the same model may join multiple pools; unconfigured pools use the system default decision)`
  if (filterLane) {
    const lane = laneOrThrow(filterLane)
    const sel = allow[lane]
    console.log(head)
    console.log(`== ${lane} == (${sel ? `manually selected ${sel.size}/${rows.length} participating models` : "unconfigured: system default (all available models participate)"})`)
    rows.forEach((row, i) => console.log(fmtRow(i + 1, row, sel ? sel.has(row.key) : true)))
    return
  }
  console.log(head)
  for (const lane of LANE_ORDER) {
    const sel = allow[lane]
    console.log(`== ${lane} ==${sel ? ` manually selected ${sel.size} models: ${[...sel].join(", ")}` : " system default (all available models participate)"}`)
  }
  console.log(`(view a single pool's full list with numbers: pool list <${LANE_ORDER.join("|")}>)`)
}

function resolveRefs(refs: string[], rows: ModelRow[]): string[] {
  // Dot-folding fallback: hand-typed args often give "glm-5-3-flash" ↔ manifest key "glm-5.3-flash" (normalizeModelKey keeps dots)
  const alt = new Map(rows.map((r) => [r.key.replace(/\./g, "-"), r.key]))
  const out: string[] = []
  for (const r of refs) {
    if (/^\d+$/.test(r)) {
      const hit = rows[Number(r) - 1]
      if (!hit) throw new Error(`index out of range #${r} (list has ${rows.length} items)`)
      out.push(hit.key)
      continue
    }
    const key = normalizeModelKey(r)
    if (!key) throw new Error(`invalid model name: ${r}`)
    out.push(alt.get(key.replace(/\./g, "-")) ?? key)
  }
  return out
}

function cmdPool(args: string[]): number {
  const [sub, lane, ...rest] = args
  if (!sub || sub === "list") {
    printPoolList(lane)
    return 0
  }
  const key = laneOrThrow(lane)
  const rows = allModelRows()
  if (rows.length === 0) throw new Error("no available model manifest (check provider connections and the superset manifest)")
  // add/remove semantics operate on the "currently effective selection set": unconfigured lane = system default full set (the first operation materializes it into an explicit list, consistent with TUI checkboxes)
  const explicit = poolAllowlist(key)
  const current = [...(explicit ?? rows.map((r) => r.key))]
  if (sub === "add" || sub === "remove" || sub === "set") {
    if (rest.length === 0) throw new Error(`pool ${sub} requires an index or model name`)
    const refs = resolveRefs(rest, rows)
    let next: string[]
    if (sub === "add") next = [...current, ...refs.filter((k) => !current.includes(k))]
    else if (sub === "remove") next = current.filter((k) => !refs.includes(k))
    else next = refs
    const file = writePoolConfig(key, next)
    const n = file?.pools[key]?.length
    console.log(n === undefined
      ? `${key} task-pool selection cleared (back to the system default candidate set, effective immediately, sidebar refreshes in sync)`
      : `Updated ${key} task-pool selection (${n} models participating, effective immediately, sidebar refreshes in sync)`)
    printPoolList(key)
    return 0
  }
  if (sub === "clear") {
    resetPoolConfig(key)
    console.log(`Cleared the ${key} task-pool selection config (that pool returns to the system default candidate set, effective immediately, sidebar refreshes in sync)`)
    return 0
  }
  throw new Error(`unknown subcommand pool ${sub} (list/add/remove/set/clear)`)
}

/** [2026-09-10]-[merged interleaved view: manual entries no longer float as a block on top — every model (manual + base)
 *  is sorted by effective capability (tier, raw; manual wins exact ties), so /modelRank moves and rank CLI indices act
 *  on one global ordering. Manual keys missing from the model universe keep a row (dead-key tolerance)] */
export function rankViewRows(): ModelRow[] {
  const rank = loadCapabilityRank()
  const rows = allModelRows()
  const seen = new Set(rows.map((r) => r.key))
  for (const k of rank?.models ?? []) {
    if (seen.has(k)) continue
    seen.add(k)
    rows.push(toRow(k))
  }
  rows.sort(capabilityCompare)
  return rows
}

function cmdRank(args: string[]): number {
  const [sub, ...rest] = args
  const rank = loadCapabilityRank()
  if (!sub || sub === "list") {
    const view = rankViewRows()
    const manualCount = rank?.models.length ?? 0
    console.log(`Model capability ranking (config file ${paths().capabilityRank}; one merged ordering — manual entries interleave with base-score models by effective score; higher up = stronger)`)
    console.log(`== Merged ordering (${manualCount} manual${manualCount > 0 ? "" : "; none = all use the base capability score"}; CLI set/add order entries by the legacy ladder, TUI moves anchor scores between neighbors) ==`)
    view.forEach((row, i) => {
      const manualTag = row.source === "manual"
        ? `·manual${row.raw !== null ? ` ${row.raw}` : ""}`
        : ""
      console.log(` #${String(i + 1).padStart(2, "0")} ${row.modelId} (${row.tier}-tier${manualTag})`)
    })
    return 0
  }
  if (sub === "add" || sub === "remove" || sub === "set") {
    if (rest.length === 0) throw new Error(`rank ${sub} requires an index or model name`)
    const refs = resolveRefs(rest, rankViewRows())
    const current = [...(rank?.models ?? [])]
    // [2026-09-10]-[CLI writes must preserve anchored scores: add keeps every existing entry's score, remove/set drop
    //  only the keys leaving the list (ladder fallback covers the rest)]
    const keepScores = (keep: string[]): Record<string, RankScoreOverride> | undefined => {
      const next: Record<string, RankScoreOverride> = {}
      for (const [k, v] of Object.entries(rank?.scores ?? {})) if (keep.includes(k)) next[k] = v
      return Object.keys(next).length > 0 ? next : undefined
    }
    let next: string[]
    let nextScores: Record<string, RankScoreOverride> | undefined
    if (sub === "add") {
      next = [...current, ...refs.filter((k) => !current.includes(k))]
      nextScores = keepScores([...current, ...refs])
    }
    else if (sub === "remove") {
      next = current.filter((k) => !refs.includes(k))
      nextScores = keepScores(next)
    }
    else {
      next = refs
      nextScores = keepScores(refs)
    }
    const file = writeCapabilityRank(next, nextScores)
    console.log(`Updated the manual capability ranking (${file.models.length} models, effective immediately, sidebar refreshes in sync)`)
    return cmdRank(["list"])
  }
  if (sub === "clear") {
    clearCapabilityRank()
    console.log("Cleared the manual capability ranking (everything falls back to the base capability score, effective immediately, sidebar refreshes in sync)")
    return 0
  }
  throw new Error(`unknown subcommand rank ${sub} (list/set/add/remove/clear)`)
}

/** CLI entry (callable directly by tests); argv excludes node/self */
export function runCli(argv: string[]): number {
  const [group, ...args] = argv
  try {
    if (group === "pool") return cmdPool(args)
    if (group === "rank") return cmdRank(args)
    console.log("Usage: switchman-config <pool|rank> ...")
    console.log(`  pool list [task-pool]             Pool selection overview (economy/mechanical/main/hard/vision/review; with a pool name = full list with indices)`)
    console.log("  pool add <task-pool> <index|model...>    Check models joining that task pool")
    console.log("  pool remove <task-pool> <index|model...> Uncheck participation")
    console.log("  pool set <task-pool> <index|model...>    Fully replace that pool's participation list (the same model may join multiple pools)")
    console.log("  pool clear <task-pool>                Clear that pool's config (back to the system default candidate set)")
    console.log("  rank list                      View the manual capability ranking and the reference ordering of available models")
    console.log("  rank set <index|model...>         Fully reorder (in the given order, #1 is strongest)")
    console.log("  rank add <index|model...>         Append to the end of the ranking")
    console.log("  rank remove <index|model...>      Remove from the ranking")
    console.log("  rank clear                     Clear the ranking (fall back to the base capability score)")
    return group ? 1 : 0
  } catch (exc) {
    console.error(`switchman-config: ${exc instanceof Error ? exc.message : exc}`)
    return 1
  }
}

/* Direct-run entry (dist output is executed by node/bun; under bun test import argv[1] is the test-runner path and does not trigger) */
if (/switchman-config\.(js|mjs|ts)$/.test(String(process.argv[1] ?? ""))) {
  process.exitCode = runCli(process.argv.slice(2))
}
