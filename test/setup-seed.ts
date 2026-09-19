// [2026-09-19]-[setup hard gate fixture helper: seeds a COMPLETE switchman setup (pool-config.json with all 6 task
//  pools + capability-rank.json) into a test state dir so index-level hook harnesses pass the setup gate and reach
//  the gates they actually test. Pool lists = the full model universe of the harness superset → gate 5.5 membership
//  is allow-all (identical to the old unconfigured fail-open semantics; no lane filtering, no poolOrdered manual
//  ordering because the fixture rank key prefix-matches nothing). Writes raw JSON (not the src write helpers) to
//  stay decoupled from writeCapabilityRank's pool-universe auto-prune, then drops the mtime cache so the next read
//  is fresh]
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { LANE_ORDER } from "../src/types"
import { loadManifest } from "../src/state"
import { resetUserOverridesCache } from "../src/user-overrides"

/** Fixture rank entry: normalizes to itself and prefix-matches no real modelId in any test shell universe */
export const SETUP_FIXTURE_RANK_MODEL = "zz-setup-fixture-model"

/** All distinct modelIds in the static shell manifest (the superset every index-level harness draws its shells from) */
export function manifestModelUniverse(): string[] {
  return [...new Set(loadManifest().shells.map((s) => s.modelId))]
}

/** Write pool-config.json (every lane = the full universe → membership allow-all) + capability-rank.json (1 fixture model) */
export function seedCompleteSetup(stateDir: string, modelIds: readonly string[]): void {
  const updated_at = new Date().toISOString()
  const pools = Object.fromEntries(LANE_ORDER.map((lane) => [lane, [...modelIds]]))
  writeFileSync(join(stateDir, "pool-config.json"), JSON.stringify({ version: 1, updated_at, pools }))
  writeFileSync(join(stateDir, "capability-rank.json"), JSON.stringify({ version: 1, updated_at, models: [SETUP_FIXTURE_RANK_MODEL] }))
  resetUserOverridesCache()
}
