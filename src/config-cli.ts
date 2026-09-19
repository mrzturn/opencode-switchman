// [2026-09-04]-[English localization: translate CLI messages and comments; no logic change]
// switchman-config CLI (bundled asset, runs directly with node/bun): read/write entry for task-pool selection and capability ranking.
// For all clients outside the /poolConfig-chat, /modelRank-chat command templates and the TUI popup; all commands are non-interactive.
// [2026-09-03]-[Added with the task-pool selection/manual ranking features; [2026-09-03 semantics fix]-[pool = task-pool lane (not a provider pool);
//  select the models joining each lane, the same model may join multiple lanes]; exit codes 0=success 1=failure]
import { baseScoreDynamic, normalizeModelKey } from "./capability"
import { loadSupersetShells, loadManifest, paths, readUiLocale } from "./state"
import {
  loadCapabilityRank, loadPoolConfig, poolAllowlist, poolUniverse,
  writeCapabilityRank, clearCapabilityRank, writePoolConfig, resetPoolConfig,
  type RankScoreOverride,
} from "./user-overrides"
import { LANE_ORDER, type Lane } from "./types"
import { TIER_RANK } from "./model-ranks"
import { resolveDisplayLocale, t, type LocaleTag } from "./i18n"

// [2026-09-19]-[render-time CLI i18n: the CLI has no project context, so the display locale is resolved ONCE per
//  process (global ui.lang snapshot → terminal env → "en"; see src/i18n.ts) and every user-visible console/error
//  string with a `cli.config.*` key renders via t(locale, key, params); flags, subcommand names, model/tier text and
//  path placeholders stay verbatim; exit codes and control flow unchanged]
let cachedLocale: LocaleTag | null = null
function cliLocale(): LocaleTag {
  if (!cachedLocale) cachedLocale = resolveDisplayLocale({ uiLang: readUiLocale(), env: process.env })
  return cachedLocale
}

interface ModelRow { key: string; modelId: string; tier: string; source: string; raw: number | null; manualIdx?: number; poolMember?: boolean }

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

function fmtRow(n: number, row: ModelRow, selected: boolean, locale: LocaleTag): string {
  const checkMark = selected ? "[x]" : "[ ]"
  const manualTag = row.source === "manual" ? "·manual rank" : ""
  return t(locale, "cli.config.poolRow", {
    rankPadded: String(n).padStart(2, "0"), checkMark, modelId: row.modelId, tier: row.tier, manualTag,
  })
}

function laneOrThrow(lane: string | undefined, locale: LocaleTag): Lane {
  const key = String(lane ?? "").trim().toLowerCase() as Lane
  if (!(LANE_ORDER as string[]).includes(key)) {
    throw new Error(t(locale, "cli.config.unknownPool", { lane: lane ?? "(missing)", laneList: LANE_ORDER.join("/") }))
  }
  return key
}

function printPoolList(filterLane?: string): void {
  const locale = cliLocale()
  const rows = allModelRows()
  const allow = loadPoolConfig()
  const head = t(locale, "cli.config.poolHeader", { poolConfigPath: paths().poolConfig })
  if (filterLane) {
    const lane = laneOrThrow(filterLane, locale)
    const sel = allow[lane]
    console.log(head)
    console.log(t(locale, "cli.config.poolSection", {
      lane,
      selection: sel
        ? `manually selected ${sel.size}/${rows.length} participating models`
        : "unconfigured: system default (all available models participate)",
    }))
    rows.forEach((row, i) => console.log(fmtRow(i + 1, row, sel ? sel.has(row.key) : true, locale)))
    return
  }
  console.log(head)
  for (const lane of LANE_ORDER) {
    const sel = allow[lane]
    console.log(t(locale, "cli.config.poolSectionBrief", {
      lane,
      detail: sel
        ? ` manually selected ${sel.size} models: ${[...sel].join(", ")}`
        : " system default (all available models participate)",
    }))
  }
  console.log(t(locale, "cli.config.poolListHint", { laneList: LANE_ORDER.join("|") }))
}

function resolveRefs(refs: string[], rows: ModelRow[], locale: LocaleTag): string[] {
  // Dot-folding fallback: hand-typed args often give "glm-5-3-flash" ↔ manifest key "glm-5.3-flash" (normalizeModelKey keeps dots)
  const alt = new Map(rows.map((r) => [r.key.replace(/\./g, "-"), r.key]))
  const out: string[] = []
  for (const r of refs) {
    if (/^\d+$/.test(r)) {
      const hit = rows[Number(r) - 1]
      if (!hit) throw new Error(t(locale, "cli.config.indexOutOfRange", { index: r, rowCount: rows.length }))
      out.push(hit.key)
      continue
    }
    const key = normalizeModelKey(r)
    if (!key) throw new Error(t(locale, "cli.config.invalidModel", { model: r }))
    out.push(alt.get(key.replace(/\./g, "-")) ?? key)
  }
  return out
}

function cmdPool(args: string[]): number {
  const locale = cliLocale()
  const [sub, lane, ...rest] = args
  if (!sub || sub === "list") {
    printPoolList(lane)
    return 0
  }
  const key = laneOrThrow(lane, locale)
  const rows = allModelRows()
  if (rows.length === 0) throw new Error(t(locale, "cli.config.noManifest"))
  // add/remove semantics operate on the "currently effective selection set": unconfigured lane = system default full set (the first operation materializes it into an explicit list, consistent with TUI checkboxes)
  const explicit = poolAllowlist(key)
  const current = [...(explicit ?? rows.map((r) => r.key))]
  if (sub === "add" || sub === "remove" || sub === "set") {
    if (rest.length === 0) throw new Error(t(locale, "cli.config.poolRequiresArg", { sub }))
    const refs = resolveRefs(rest, rows, locale)
    let next: string[]
    if (sub === "add") next = [...current, ...refs.filter((k) => !current.includes(k))]
    else if (sub === "remove") next = current.filter((k) => !refs.includes(k))
    else next = refs
    const file = writePoolConfig(key, next)
    const n = file?.pools[key]?.length
    console.log(n === undefined
      ? t(locale, "cli.config.poolSelectionCleared", { lane: key })
      : t(locale, "cli.config.poolUpdated", { lane: key, modelCount: n }))
    printPoolList(key)
    return 0
  }
  if (sub === "clear") {
    resetPoolConfig(key)
    console.log(t(locale, "cli.config.poolConfigCleared", { lane: key }))
    return 0
  }
  throw new Error(t(locale, "cli.config.unknownPoolSub", { sub }))
}

/** [2026-09-10]-[merged interleaved view: manual entries no longer float as a block on top — every model (manual + base)
 *  is sorted by effective capability (tier, raw; manual wins exact ties), so /modelRank moves and rank CLI indices act
 *  on one global ordering. Manual keys missing from the model universe keep a row (dead-key tolerance)]
 *  [2026-09-18]-[rank universe = pool selection: with at least one task pool configured the view shows EXACTLY the
 *  pool-selected universe — dead manual keys (rank entries absent from every pool) are no longer listed; the next
 *  rank write prunes them from capability-rank.json instead (see writeCapabilityRank). With NO pool configured the
 *  view degenerates to the manual entries alone (cleanup-only) while the CLI/TUI guide the user to /poolConfig first] */
export function rankViewRows(): ModelRow[] {
  const rank = loadCapabilityRank()
  const universe = poolUniverse()
  let rows: ModelRow[]
  if (universe.size === 0) {
    // cleanup-only degeneration: the manual entries alone (base rows filtered out entirely)
    const seen = new Set<string>()
    rows = []
    for (const k of rank?.models ?? []) {
      if (seen.has(k)) continue
      seen.add(k)
      rows.push(toRow(k))
    }
  } else {
    rows = allModelRows()
      .filter((r) => universe.has(r.key))
      .map((r) => ({ ...r, poolMember: true }))
  }
  rows.sort(capabilityCompare)
  return rows
}

function cmdRank(args: string[]): number {
  const locale = cliLocale()
  const [sub, ...rest] = args
  const rank = loadCapabilityRank()
  const universe = poolUniverse()
  if (!sub || sub === "list") {
    if (universe.size === 0) {
      console.log(t(locale, "cli.config.rankDisabledUntilPools", { capabilityRankPath: paths().capabilityRank }))
      console.log(t(locale, "cli.config.rankHowTo"))
      const legacy = rank?.models ?? []
      if (legacy.length > 0) {
        console.log(t(locale, "cli.config.legacyHeader"))
        legacy.forEach((k, i) => console.log(t(locale, "cli.config.legacyRow", {
          rankPadded: String(i + 1).padStart(2, "0"), modelKey: k,
        })))
      }
      return 0
    }
    const view = rankViewRows()
    const manualCount = rank?.models.length ?? 0
    console.log(t(locale, "cli.config.rankHeader", { capabilityRankPath: paths().capabilityRank, universeCount: universe.size }))
    console.log(t(locale, "cli.config.mergedHeader", {
      manualCount, manualSuffix: manualCount > 0 ? "" : "; none = all use the base capability score",
    }))
    view.forEach((row, i) => {
      const manualTag = row.source === "manual"
        ? t(locale, "cli.config.manualTag", { score: row.raw !== null ? ` ${row.raw}` : "" })
        : ""
      const poolTag = row.poolMember === false ? ` ${t(locale, "cli.config.notInPoolTag")}` : ""
      console.log(t(locale, "cli.config.rankRow", {
        rankPadded: String(i + 1).padStart(2, "0"), modelId: row.modelId, tier: row.tier, manualTag, poolTag,
      }))
    })
    return 0
  }
  if (sub === "add" || sub === "remove" || sub === "set") {
    if (sub !== "remove" && universe.size === 0) {
      throw new Error(t(locale, "cli.config.rankNoPools"))
    }
    if (rest.length === 0) throw new Error(t(locale, "cli.config.rankRequiresArg", { sub }))
    const refs = resolveRefs(rest, rankViewRows(), locale)
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
    console.log(t(locale, "cli.config.rankUpdated", { modelCount: file.models.length }))
    return cmdRank(["list"])
  }
  if (sub === "clear") {
    clearCapabilityRank()
    console.log(t(locale, "cli.config.rankCleared"))
    return 0
  }
  throw new Error(t(locale, "cli.config.unknownRankSub", { sub }))
}

/** CLI entry (callable directly by tests); argv excludes node/self */
export function runCli(argv: string[]): number {
  const locale = cliLocale()
  const [group, ...args] = argv
  try {
    if (group === "pool") return cmdPool(args)
    if (group === "rank") return cmdRank(args)
    console.log(t(locale, "cli.config.usage"))
    console.log(t(locale, "cli.config.usagePoolList"))
    console.log(t(locale, "cli.config.usagePoolAdd"))
    console.log(t(locale, "cli.config.usagePoolRemove"))
    console.log(t(locale, "cli.config.usagePoolSet"))
    console.log(t(locale, "cli.config.usagePoolClear"))
    console.log(t(locale, "cli.config.usageRankList"))
    console.log(t(locale, "cli.config.usageRankSet"))
    console.log(t(locale, "cli.config.usageRankAdd"))
    console.log(t(locale, "cli.config.usageRankRemove"))
    console.log(t(locale, "cli.config.usageRankClear"))
    return group ? 1 : 0
  } catch (exc) {
    console.error(t(locale, "cli.config.errorPrefix", { message: exc instanceof Error ? exc.message : String(exc) }))
    return 1
  }
}

/* Direct-run entry (dist output is executed by node/bun; under bun test import argv[1] is the test-runner path and does not trigger) */
if (/switchman-config\.(js|mjs|ts)$/.test(String(process.argv[1] ?? ""))) {
  process.exitCode = runCli(process.argv.slice(2))
}
