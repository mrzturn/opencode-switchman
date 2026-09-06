// [2026-09-06]-[applyRankMove unit contract: shared reorder semantics for the /modelRank dialog (enter actions +
// ctrl+up/ctrl+down hotkeys). Pure function — no filesystem, but the module chain expects a state dir to exist]
// Sandbox: SWITCHMAN_STATE points to a temp dir (same fixture pattern as user-overrides.test.ts)
import { describe, test, expect, beforeAll } from "bun:test"
import { mkdtempSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-rm-"))
mkdirSync(process.env.SWITCHMAN_STATE, { recursive: true })

import { applyRankMove } from "../src/user-overrides"

describe("applyRankMove (manual ranking reorder shared by dialog actions and hotkeys)", () => {
  const list = ["a", "b", "c"]

  test("±1 swaps with the neighbor and reports the new index", () => {
    expect(applyRankMove(list, "b", -1)).toEqual({ models: ["b", "a", "c"], index: 0 })
    expect(applyRankMove(list, "b", 1)).toEqual({ models: ["a", "c", "b"], index: 2 })
  })

  test("boundary hits are null no-ops (no write)", () => {
    expect(applyRankMove(list, "a", -1)).toBeNull()
    expect(applyRankMove(list, "c", 1)).toBeNull()
  })

  test("pin to top: ranked and unranked both land at index 0", () => {
    expect(applyRankMove(list, "c", 0)).toEqual({ models: ["c", "a", "b"], index: 0 })
    expect(applyRankMove(list, "z", 0)).toEqual({ models: ["z", "a", "b", "c"], index: 0 })
  })

  test("unranked: up appends at the end, down is a no-op (hotkey hint path)", () => {
    expect(applyRankMove(list, "z", 1)).toEqual({ models: ["a", "b", "c", "z"], index: 3 })
    expect(applyRankMove(list, "z", -1)).toBeNull()
  })

  test("input list is not mutated", () => {
    expect(list).toEqual(["a", "b", "c"])
  })
})
