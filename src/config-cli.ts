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
} from "./user-overrides"
import { LANE_ORDER, type Lane } from "./types"
import { TIER_RANK } from "./model-ranks"

interface ModelRow { key: string; modelId: string; tier: string; source: string; raw: number | null }

function capabilityCompare(a: ModelRow, b: ModelRow): number {
  return TIER_RANK[a.tier as "S"] - TIER_RANK[b.tier as "S"] ||
    (b.raw ?? -Infinity) - (a.raw ?? -Infinity) ||
    a.key.localeCompare(b.key)
}

function toRow(modelId: string): ModelRow {
  const base = baseScoreDynamic(modelId)
  return {
    key: normalizeModelKey(modelId),
    modelId,
    tier: base.tier,
    source: base.source,
    raw: base.rawScore ?? null,
  }
}

/** All available models (superset manifest first, falling back to the bundled manifest; deduped by modelId across provider pools); sorted by effective capability descending */
export function allModelRows(): ModelRow[] {
  const shells = loadSupersetShells()?.shells ?? loadManifest().shells
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

/** Merged view of the manual ranking + reference ordering of available models (indices are globally contiguous, referenced by rank set/add/remove) */
export function rankViewRows(): ModelRow[] {
  const rank = loadCapabilityRank()
  const rankedKeys = new Set(rank?.models ?? [])
  const ranked: ModelRow[] = (rank?.models ?? []).map((k) => ({ ...toRow(k), source: "manual" }))
  const flat = allModelRows()
  const seen = new Set<string>(rankedKeys)
  const rest: ModelRow[] = []
  for (const r of flat) {
    if (seen.has(r.key)) continue
    seen.add(r.key)
    rest.push(r)
  }
  rest.sort(capabilityCompare)
  return [...ranked, ...rest]
}

function cmdRank(args: string[]): number {
  const [sub, ...rest] = args
  const rank = loadCapabilityRank()
  if (!sub || sub === "list") {
    const view = rankViewRows()
    const manualCount = rank?.models.length ?? 0
    console.log(`Model capability ranking (config file ${paths().capabilityRank}; the manual ranking takes priority over the base capability score; higher up = stronger)`)
    console.log(`== Manual ranking (${manualCount}${manualCount > 0 ? "" : "; unconfigured = all use the base capability score"}) ==`)
    view.forEach((row, i) => {
      if (i < manualCount) console.log(` #${String(i + 1).padStart(2, "0")} ${row.modelId} (${row.tier}-tier·manual)`)
    })
    console.log("== Reference ordering of available models (base capability score) ==")
    view.forEach((row, i) => {
      if (i >= manualCount) console.log(` #${String(i + 1).padStart(2, "0")} ${row.modelId} (${row.tier}-tier)`)
    })
    return 0
  }
  if (sub === "add" || sub === "remove" || sub === "set") {
    if (rest.length === 0) throw new Error(`rank ${sub} requires an index or model name`)
    const refs = resolveRefs(rest, rankViewRows())
    const current = [...(rank?.models ?? [])]
    let next: string[]
    if (sub === "add") next = [...current, ...refs.filter((k) => !current.includes(k))]
    else if (sub === "remove") next = current.filter((k) => !refs.includes(k))
    else next = refs
    const file = writeCapabilityRank(next)
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
