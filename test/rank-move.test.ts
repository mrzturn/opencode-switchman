// [2026-09-10]-[applyRankMove unit contract: interleaved move semantics for the /modelRank dialog (enter actions +
//  ctrl+up/ctrl+down hotkeys) — moves act on the merged view and anchor a manual (tier, raw) score between the
//  moved model's new neighbors, with decimal steps breaking ties. Pure function — no filesystem, but the module
//  chain expects a state dir to exist. Sandbox: SWITCHMAN_STATE points to a temp dir (same fixture pattern as
//  user-overrides.test.ts)]
import { describe, test, expect, beforeAll } from "bun:test"
import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-rm-"))
mkdirSync(process.env.SWITCHMAN_STATE, { recursive: true })

import { applyRankMove, type RankMoveRow } from "../src/user-overrides"

// merged-view fixture (already sorted strongest-first); m3 is manual with an anchored score
const rows: RankMoveRow[] = [
  { key: "m1", tier: "S", raw: 90 },
  { key: "m2", tier: "S", raw: 80 },
  { key: "m3", tier: "A", raw: 95 },
  { key: "m4", tier: "A", raw: 60 },
  { key: "m5", tier: "B", raw: 40 },
]
const models = ["m3"]
const scores = { m3: { tier: "A" as const, raw: 95 } }

describe("applyRankMove (interleaved move on the merged view)", () => {
  test("move up across a tier boundary: stay in the lower tier, step above the neighbor", () => {
    // m4 (A,60) up between m3 (A,95) and m2 (S,80): different tiers → A/95.001 (tier dominance keeps it below m2)
    const res = applyRankMove(models, scores, rows, "m4", -1)!
    expect(res.score).toEqual({ tier: "A", raw: 95.001 })
    expect(res.position).toBe(2)
  })

  test("move up within one tier: midpoint between the neighbors", () => {
    // m5 (B,40) up between m4 (A,60) and m3 (A,95): same tier → midpoint A/77.5
    const res = applyRankMove(models, scores, rows, "m5", -1)!
    expect(res.score).toEqual({ tier: "A", raw: 77.5 })
  })

  test("move down across a tier boundary: take the lower neighbor's tier, step above it", () => {
    // m3 (A,95) down between m4 (A,60) and m5 (B,40) → B/40.001 (below every A-tier, above m5)
    const res = applyRankMove(models, scores, rows, "m3", 1)!
    expect(res.score).toEqual({ tier: "B", raw: 40.001 })
    expect(res.position).toBe(3)
  })

  test("unranked models move both ways now (up materializes an anchored entry; down works too)", () => {
    const up = applyRankMove(models, scores, rows, "m2", -1)!
    // m2 (S,80) above m1 (S,90), no upper bound → S/90.001
    expect(up.score).toEqual({ tier: "S", raw: 90.001 })
    expect(up.models).toContain("m2")
    const down = applyRankMove(models, scores, rows, "m2", 1)!
    // between m3 (A,95) and m4 (A,60): midpoint A/77.5
    expect(down.score).toEqual({ tier: "A", raw: 77.5 })
  })

  test("tie groups: same (tier, raw) neighbors cannot be split — step past the group", () => {
    const tied: RankMoveRow[] = [
      { key: "t1", tier: "A", raw: 60 },
      { key: "t2", tier: "A", raw: 60 },
      { key: "x", tier: "B", raw: 10 },
    ]
    const res = applyRankMove([], undefined, tied, "x", -1)!
    expect(res.score).toEqual({ tier: "A", raw: 60.001 })
    expect(res.position).toBe(1) // insertion slot; the anchored raw (60.001 > t1) re-sorts it above the tied pair
  })

  test("pin to top: steps above row #1 (ranked or unranked)", () => {
    const res = applyRankMove(models, scores, rows, "m5", 0)!
    expect(res.score).toEqual({ tier: "S", raw: 90.001 })
    expect(res.position).toBe(0)
    expect(res.models[0]).toBe("m5")
    expect(res.scores.m5).toEqual({ tier: "S", raw: 90.001 })
    expect(res.scores.m3).toEqual({ tier: "A", raw: 95 }) // other anchored scores survive
  })

  test("boundary hits are null no-ops (no write)", () => {
    expect(applyRankMove(models, scores, rows, "m1", -1)).toBeNull()
    expect(applyRankMove(models, scores, rows, "m5", 1)).toBeNull()
    expect(applyRankMove(models, scores, rows, "missing", -1)).toBeNull()
  })

  test("models array is rebuilt in merged-view order; keys absent from the view keep their tail slots", () => {
    const res = applyRankMove(["dead", ...models], scores, rows, "m2", -1)!
    // m2 moves to #0: manual keys in merged order = m2, m3; dead key not in the view → appended
    expect(res.models).toEqual(["m2", "m3", "dead"])
    expect(res.index).toBe(0)
  })

  test("input arrays are not mutated", () => {
    expect(models).toEqual(["m3"])
    expect(scores.m3).toEqual({ tier: "A", raw: 95 })
    expect(rows.map((r) => r.key)).toEqual(["m1", "m2", "m3", "m4", "m5"])
  })
})
