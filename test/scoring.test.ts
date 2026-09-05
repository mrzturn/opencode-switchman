// [2026-09-04]-[English localization: translate comments; no test-logic change]
// Model scoring engine fixtures (bun test)
// Sandbox: SWITCHMAN_STATE points at a temp dir; baseScore/scoreShell/rankCandidates/logDecision tested as pure functions.
import { describe, test, expect, beforeAll } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-sc-"))

// [2026-08-31]-[mechanism tests decoupled from capability-rank data: write an empty-shell capability.json (models={}
//  is valid but has no entries) — under the disk-index-exclusive semantics everything falls back to the curated table,
//  so level assertions do not drift with the bundled snapshot / live data]
mkdirSync(process.env.SWITCHMAN_STATE, { recursive: true })
writeFileSync(
  join(process.env.SWITCHMAN_STATE, "capability.json"),
  JSON.stringify({ source: "artificial-analysis", version: "fixed-empty", fetched_at: Date.now() / 1000, thresholds: { S: 62, A: 55, B: 45 }, models: {} }),
)

import { baseScore, GLOBAL_MEDIAN_SCORE } from "../src/model-ranks"
import { scoreShell, rankCandidates, logDecision, BILLING_API_BOOST } from "../src/scoring"
import type { ScoreInput, WaterFactor, Rankable, RankContext, DecisionRecord } from "../src/scoring"
import { classifyProbeStatus } from "../src/probe"
import { classifyFailure } from "../src/failclass"
import { paths } from "../src/state"
import { resetCapabilityCache } from "../src/capability"
import type { ShellRegEntry } from "../src/types"

const W: WaterFactor = {}

function shellReg(over: Partial<ShellRegEntry> = {}): ShellRegEntry {
  return {
    name: "s", pool: "glm", provider: "zhipuai-coding-plan", modelId: "glm-5.3",
    effort: "high", family: "glm", capability: "rw", vision: false,
    matrixKey: "zhipuai-coding-plan|glm-5.3|high", comboKey: "zhipuai-coding-plan|glm-5.3|high",
    status: "enabled",
    ...over,
  } as ShellRegEntry
}

function rankable(over: Partial<Rankable> = {}): Rankable {
  return {
    key: "s", modelId: "glm-5.3", effort: "high", pool: "glm", family: "glm",
    capability: "rw", vision: false, matrixStatus: "ok", latencyMs: 100,
    ...over,
  }
}

function ctx(over: Partial<RankContext> = {}): RankContext {
  return { lane: "main", immediate: false, glmPeak: false, water: W, ...over }
}

function scoreInput(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    modelId: "glm-5.3", effort: "high", lane: "main", pool: "glm",
    matrixStatus: "ok", latencyMs: 100, peakActive: false, immediate: false, water: W,
    ...over,
  }
}

// ================= 1. baseScore four-way matching =================
describe("baseScore", () => {
  test("exact key hit", () => {
    expect(baseScore("claude-opus-5")).toEqual({ score: 1.0, tier: "S", source: "exact" })
    expect(baseScore("glm-5.3")).toEqual({ score: 0.85, tier: "A", source: "exact" })
    expect(baseScore("glm-5.3-flash")).toEqual({ score: 0.7, tier: "B", source: "exact" })
    expect(baseScore("glm-4.5-air")).toEqual({ score: 0.55, tier: "C", source: "exact" })
  })
  test("longest-prefix hit (variants)", () => {
    expect(baseScore("gpt-5.6-codex")).toEqual({ score: 1.0, tier: "S", source: "prefix" })
    expect(baseScore("gpt-5.6-luna")).toEqual({ score: 1.0, tier: "S", source: "prefix" })
    expect(baseScore("gemini-3.1-pro-preview")).toEqual({ score: 1.0, tier: "S", source: "prefix" })
    expect(baseScore("deepseek-v4-flash-vision-exp")).toEqual({ score: 0.7, tier: "B", source: "prefix" })
  })
  test("exact beats prefix (gpt-5.6-mini is A, not S)", () => {
    expect(baseScore("gpt-5.6-mini")).toEqual({ score: 0.85, tier: "A", source: "exact" })
  })
  test("family median (unknown model within a known family)", () => {
    const r = baseScore("glm-5.4") // median of the glm family table scores 0.7 → B
    expect(r.source).toBe("family")
    expect(r.tier).toBe("B")
    expect(r.score).toBe(0.7)
  })
  test("global fallback (unknown new vendor)", () => {
    const r = baseScore("mimo-v2.5-free")
    expect(r.source).toBe("global")
    expect(r.score).toBe(GLOBAL_MEDIAN_SCORE)
    expect(r.tier).toBe("C")
  })
})

// ================= 2. scoreShell soft factors =================
describe("scoreShell", () => {
  test("strained health factor 0.6 (other factors unchanged; main defaults to medium, high ordinal effortFit=0.9)", () => {
    const b = scoreShell(scoreInput({ matrixStatus: "strained" }))
    expect(b.health).toBe(0.6)
    expect(b.effortFit).toBe(0.9)
    expect(b.total).toBeCloseTo(0.85 * 0.9 * 0.6 * 1.0 * 1.0 * 1.0 * 1.0 * 1.0)
    expect(scoreShell(scoreInput()).health).toBe(1.0)
  })
  test("peakActive generalization: billing peak 0.93 for any provider (no longer glm-pool-only)", () => {
    expect(scoreShell(scoreInput({ peakActive: true, pool: "glm" })).peak).toBeCloseTo(0.93)
    expect(scoreShell(scoreInput({ peakActive: true, pool: "copilot" })).peak).toBeCloseTo(0.93)
    expect(scoreShell(scoreInput({ peakActive: true, pool: "my-gateway" })).peak).toBeCloseTo(0.93)
    expect(scoreShell(scoreInput({ peakActive: false })).peak).toBe(1.0)
  })
  test("water: GLM linear decay at high watermark, Copilot near-expiry credit burn boost", () => {
    expect(scoreShell(scoreInput({ water: { glmFiveHourPct: 90 } })).water).toBeCloseTo(0.6)
    expect(scoreShell(scoreInput({ water: { glmFiveHourPct: 0 } })).water).toBe(1.0)
    const burn = scoreShell(scoreInput({
      pool: "copilot",
      water: { copilotRemainingPct: 50, copilotResetDays: 3 },
    }))
    expect(burn.water).toBe(1.0)
    // re-review P1-1: tight (rem<20%) near expiry does not boost, consistent with "tight → move to glm"
    const tight = scoreShell(scoreInput({
      pool: "copilot",
      water: { copilotRemainingPct: 5, copilotResetDays: 2 },
    }))
    expect(tight.water).toBeLessThan(1.0)
  })
  test("billingBoost: subscription=1.0 / api=0.85 / costBias always 1.0 (pool-name rules abolished)", () => {
    expect(scoreShell(scoreInput({ pool: "glm", billingBoost: 1.0 })).billingBoost).toBe(1.0)
    expect(scoreShell(scoreInput({ pool: "deepseek", billingBoost: BILLING_API_BOOST })).billingBoost).toBe(0.85)
    expect(scoreShell(scoreInput({ pool: "deepseek", billingBoost: BILLING_API_BOOST })).costBias).toBe(1.0)
    expect(scoreShell(scoreInput({ pool: "copilot" })).costBias).toBe(1.0)
  })
  test("unknownPenalty: global-fallback models 0.75, known (exact/family) models 1.0", () => {
    expect(scoreShell(scoreInput({ modelId: "mimo-v2.5-free" })).unknownPenalty).toBe(0.75)
    expect(scoreShell(scoreInput({ modelId: "glm-5.3" })).unknownPenalty).toBe(1.0)
    expect(scoreShell(scoreInput({ modelId: "glm-5.4" })).unknownPenalty).toBe(1.0) // family-level match counts as known
  })
})

// ================= 3. rankCandidates =================
describe("rankCandidates", () => {
  test("same tier sorted by raw capability index, not shell-name order", () => {
    try {
      writeFileSync(join(process.env.SWITCHMAN_STATE!, "capability.json"), JSON.stringify({
        source: "artificial-analysis", version: "within-tier", fetched_at: Date.now() / 1000,
        thresholds: { S: 80, A: 60, B: 40 },
        models: { "gpt-5.6-luna": { score: 93.2 }, "gpt-5.6-terra": { score: 98.8 } },
      }))
      resetCapabilityCache()
      const r = rankCandidates([
        rankable({ key: "luna", modelId: "gpt-5.6-luna", pool: "copilot", family: "gpt" }),
        rankable({ key: "terra", modelId: "gpt-5.6-terra", pool: "copilot", family: "gpt" }),
      ], ctx())
      expect(r.ranked.map((s) => s.key)).toEqual(["terra", "luna"])
      expect(r.breakdowns.get("terra")!.rawCapability).toBe(98.8)
    } finally {
      writeFileSync(join(process.env.SWITCHMAN_STATE!, "capability.json"), JSON.stringify({
        source: "artificial-analysis", version: "fixed-empty", fetched_at: Date.now() / 1000,
        thresholds: { S: 62, A: 55, B: 45 }, models: {},
      }))
      resetCapabilityCache()
    }
  })
  test("favorites first: a favorited model overtakes a higher raw index within the same tier; no inversion across tiers; no effect under immediate", () => {
    try {
      writeFileSync(join(process.env.SWITCHMAN_STATE!, "capability.json"), JSON.stringify({
        source: "artificial-analysis", version: "preferred", fetched_at: Date.now() / 1000,
        thresholds: { S: 80, A: 60, B: 40 },
        models: { "gpt-5.6-luna": { score: 98.0 }, "gpt-5.6-terra": { score: 90.0 }, "glm-5.3": { score: 70.0 } },
      }))
      resetCapabilityCache()
      const shells = [
        rankable({ key: "luna", modelId: "gpt-5.6-luna", pool: "copilot", family: "gpt" }),
        rankable({ key: "terra", modelId: "gpt-5.6-terra", pool: "copilot", family: "gpt" }),
      ]
      // No preference: luna's higher raw index leads; after favoriting terra, terra overtakes within the same tier
      expect(rankCandidates(shells, ctx()).ranked.map((s) => s.key)).toEqual(["luna", "terra"])
      expect(rankCandidates(shells, ctx({ preferredModels: new Set(["gpt-5.6-terra"]) })).ranked.map((s) => s.key)).toEqual(["terra", "luna"])
      // Favorites never cross levels: level distance is a hard key (fallback must be adjacent), favorites apply only
      // within the same distance — a non-favorited model at a nearer level still leads
      const mixed = [
        rankable({ key: "luna", modelId: "gpt-5.6-luna", pool: "copilot", family: "gpt" }),
        rankable({ key: "glm-a", modelId: "glm-5.3" }),
      ]
      expect(rankCandidates(mixed, ctx({ preferredModels: new Set(["glm-5.3"]) })).ranked.map((s) => s.key)).toEqual(["glm-a", "luna"])
      // immediate orders by latency only; favorites have no effect
      const slow = [
        rankable({ key: "luna", modelId: "gpt-5.6-luna", pool: "copilot", family: "gpt", latencyMs: 900 }),
        rankable({ key: "terra", modelId: "gpt-5.6-terra", pool: "copilot", family: "gpt", latencyMs: 10 }),
      ]
      expect(rankCandidates(slow, ctx({ immediate: true, preferredModels: new Set(["gpt-5.6-luna"]) })).ranked.map((s) => s.key)).toEqual(["terra", "luna"])
    } finally {
      writeFileSync(join(process.env.SWITCHMAN_STATE!, "capability.json"), JSON.stringify({
        source: "artificial-analysis", version: "fixed-empty", fetched_at: Date.now() / 1000,
        thresholds: { S: 62, A: 55, B: 45 }, models: {},
      }))
      resetCapabilityCache()
    }
  })
  test("thinking-effort partition: thinking candidates lead, off shells sink at equal distance (off = lane-level fallback)", () => {
    const shells = [
      rankable({ key: "a", modelId: "glm-5.3", effort: "off", matrixStatus: "strained", latencyMs: 999 }),
      rankable({ key: "c", modelId: "glm-4.5-air", effort: "high", pool: "copilot", matrixStatus: "ok", latencyMs: 1 }),
    ]
    const r = rankCandidates(shells, ctx({ glmPeak: true, water: { glmFiveHourPct: 89 } }))
    expect(r.breakdowns.has("c")).toBe(true)
    expect(r.ranked.map((s) => s.key)).toEqual(["c", "a"])
  })
  test("thinking-effort partition: off shells sink as a group, immediate alike (latency orders only within a partition)", () => {
    const shells = [
      rankable({ key: "s-off", modelId: "gpt-5.6", pool: "copilot", family: "gpt", effort: "off", latencyMs: 5 }),
      rankable({ key: "a-high", modelId: "glm-5.3", effort: "high", latencyMs: 100 }),
    ]
    const normal = rankCandidates(shells, ctx({ lane: "hard" }))
    expect(normal.ranked.map((s) => s.key)).toEqual(["a-high", "s-off"])
    const immediate = rankCandidates(shells, ctx({ lane: "hard", immediate: true }))
    expect(immediate.ranked.map((s) => s.key)).toEqual(["a-high", "s-off"])
  })
  test("immediate sorts same-level models by latency ascending only, ignoring soft factors", () => {
    const shells = [
      rankable({ key: "slow-s", modelId: "gpt-5.6", pool: "copilot", family: "gpt", latencyMs: 900 }),
      rankable({ key: "fast-b", modelId: "glm-5.3-flash", latencyMs: 10 }),
    ]
    const r = rankCandidates(shells, ctx({ immediate: true }))
    expect(r.ranked.map((s) => s.key)).toEqual(["fast-b"])
  })
  test("hard gates: down/breaker/exhausted/retired/isolated all removed, strained still participates", () => {
    const shells = [
      rankable({ key: "down", matrixStatus: "down" }),
      rankable({ key: "breaker" }),
      rankable({ key: "exhausted", pool: "copilot", family: "gpt", modelId: "gpt-5.6" }),
      rankable({ key: "retired" }),
      rankable({ key: "isolated" }),
      rankable({ key: "strained", matrixStatus: "strained" }),
    ]
    const registry = {
      breaker: shellReg({ name: "breaker" }),
      exhausted: shellReg({ name: "exhausted", pool: "copilot", modelId: "gpt-5.6", family: "gpt" }),
      retired: shellReg({ name: "retired", provider: "p", modelId: "m" }),
      isolated: shellReg({ name: "isolated", comboKey: "isolated-combo" }),
      strained: shellReg({ name: "strained" }),
    }
    const r = rankCandidates(shells, ctx({
      routing: { down_agents: { breaker: "x" }, down_expiry: {} },
      registry,
      quotaExhausted: { copilot: true },
      retiredModels: new Set(["p/m"]),
      realFailedCombos: new Set(["isolated-combo"]),
    }))
    expect(r.ranked.map((s) => s.key)).toEqual(["strained"])
    expect(r.breakdowns.get("strained")!.health).toBe(0.6)
  })
  test("end-to-end mini sample: when main has no same-level B, fall back to the adjacent A rather than the farther S", () => {
    const shells = [
      rankable({ key: "ds-s", modelId: "deepseek-v4-pro", pool: "deepseek", family: "deepseek", latencyMs: 5 }),
      rankable({ key: "glm-a", modelId: "glm-5.3", latencyMs: 50 }),
      rankable({ key: "cp-s", modelId: "gpt-5.6", pool: "copilot", family: "gpt", latencyMs: 80 }),
    ]
    const registry = {
      "ds-s": shellReg({ name: "ds-s", pool: "deepseek", provider: "deepseek", modelId: "deepseek-v4-pro", family: "deepseek" }),
      "glm-a": shellReg({ name: "glm-a", provider: "zhipuai-coding-plan" }),
      "cp-s": shellReg({ name: "cp-s", pool: "copilot", provider: "github-copilot", modelId: "gpt-5.6", family: "gpt" }),
    }
    const r = rankCandidates(shells, ctx({ registry, billingBoostOf: (provider) => provider === "deepseek" ? BILLING_API_BOOST : 1.0 }))
    expect(r.ranked[0]!.key).toBe("glm-a")
    expect(r.breakdowns.get("cp-s")!.tier).toBe("S")
    expect(r.breakdowns.get("glm-a")!.tier).toBe("A")
    expect(r.breakdowns.get("ds-s")!.tier).toBe("S")
    expect(r.breakdowns.get("ds-s")!.billingBoost).toBe(0.85)
  })
  test("unknown global-fallback model fixed at L1, cannot serve as main's cross-level fill", () => {
    const shells = [
      rankable({ key: "unknown-b", modelId: "totally-new-model", pool: "zen", family: "totally" }),
      rankable({ key: "known-b", modelId: "glm-5.3-flash", latencyMs: 50 }),
    ]
    const r = rankCandidates(shells, ctx())
    expect(r.ranked.map((s) => s.key)).toEqual(["known-b"])
    expect(r.breakdowns.get("unknown-b")!.unknownPenalty).toBe(0.75)
  })
  test("review's top-two A fill becomes the preferred pick only after all S candidates are hard-gated out", () => {
    const shells = [
      rankable({ key: "s-down", modelId: "gpt-5.6", pool: "copilot", family: "gpt", matrixStatus: "down", capability: "ro" }),
      rankable({ key: "a", modelId: "glm-5.3", family: "glm", capability: "ro" }),
      rankable({ key: "b", modelId: "glm-5.3-flash", family: "glm", capability: "ro" }),
    ]
    const r = rankCandidates(shells, ctx({ lane: "review" }))
    expect(r.ranked.map((s) => s.key)).toEqual(["a"])
  })
  test("[2026-09-05] review same-family deprioritization: with producerFamily set the same-family shell is not dropped and ranks after the cross-family candidate", () => {
    const shells = [
      rankable({ key: "glm-a-ro", modelId: "glm-5.3", family: "glm", capability: "ro", latencyMs: 5 }),
      rankable({ key: "grok-a-ro", modelId: "grok-4.6", pool: "copilot", family: "grok", capability: "ro", latencyMs: 900 }),
    ]
    const registry = {
      "glm-a-ro": shellReg({ name: "glm-a-ro", family: "glm", modelId: "glm-5.3", capability: "ro" }),
      "grok-a-ro": shellReg({ name: "grok-a-ro", pool: "copilot", provider: "github-copilot", family: "grok", modelId: "grok-4.6", capability: "ro" }),
    }
    // no S candidate → both A shells enter as the top-2 fallbacks; cross-family leads despite far worse latency
    // (family is the first comparator key; without it the faster same-family shell would win)
    const r = rankCandidates(shells, ctx({ lane: "review", registry, producerFamily: "glm" }))
    expect(r.ranked.map((s) => s.key)).toEqual(["grok-a-ro", "glm-a-ro"])
  })
  test("[2026-09-05] review last-resort seats at runtime: only B-tier candidates (no S/A) survive the gates → the group takes the best 2 instead of going empty", () => {
    const shells = [
      rankable({ key: "b1", modelId: "glm-5.3-flash", family: "glm", capability: "ro", latencyMs: 30 }),
      rankable({ key: "b2", modelId: "glm-5.3-flash", effort: "medium", family: "glm", capability: "ro", latencyMs: 10 }),
      rankable({ key: "b3", modelId: "glm-4.5-air", effort: "low", family: "glm", capability: "ro", latencyMs: 5 }),
    ]
    // glm-5.3-flash=B(L3) and glm-4.5-air=C(L2) — neither L5 primary nor L4 fallback for the review lane
    const r = rankCandidates(shells, ctx({ lane: "review" }))
    expect(r.ranked.map((s) => s.key)).toEqual(["b1", "b2"])
  })
  test("economy with L1/L2 available does not use L5; only when both L1/L2 are unavailable does it fall back upward", () => {
    const shells = [
      rankable({ key: "l1", modelId: "unknown-model", matrixStatus: "ok" }),
      rankable({ key: "l2", modelId: "glm-4.5-air", matrixStatus: "ok" }),
      rankable({ key: "l5", modelId: "claude-opus-5", matrixStatus: "ok" }),
    ]
    expect(rankCandidates(shells, ctx({ lane: "economy" })).ranked.map((s) => s.key)).toEqual(["l1"])
    expect(rankCandidates(shells, ctx({ lane: "economy", registry: { l1: shellReg({ name: "l1", modelId: "unknown-model", status: "disabled" }), l2: shellReg({ name: "l2", modelId: "glm-4.5-air", status: "disabled" }), l5: shellReg({ name: "l5", modelId: "claude-opus-5" }) } })).ranked.map((s) => s.key)).toEqual(["l5"])
  })
})

// ================= 4. Decision log =================
describe("decision log logDecision", () => {
  beforeAll(() => {
    mkdirSync(paths().dir, { recursive: true })
  })
  test("write + ring truncation keeps the most recent 200 lines", async () => {
    const rec = (name: string): DecisionRecord => ({
      at: new Date().toISOString(),
      lane: "main",
      candidates: [{
        name, base: 1.0, baseSource: "exact", effortFit: 1.0, health: 1.0, water: 1.0,
        costBias: 1.0, peak: 1.0, billingBoost: 1.0, unknownPenalty: 1.0, total: 1.0, tier: "S",
      }],
    })
    for (let i = 0; i < 205; i++) await logDecision([rec(`s${i}`)])
    const lines = readFileSync(paths().decisions, "utf8").split("\n").filter((l) => l.trim() !== "")
    expect(lines).toHaveLength(200)
    expect(JSON.parse(lines[0]).candidates[0].name).toBe("s5")
    expect(JSON.parse(lines[199]).candidates[0].name).toBe("s204")
  })
})

// ================= 5. probe strained =================
describe("probe 429 → strained", () => {
  test("classifyFailure + classifyProbeStatus (pure-function layer)", () => {
    expect(classifyFailure("HTTP 429: rate limited")).toBe("rate_limit")
    expect(classifyProbeStatus({ status: "down", reason: "HTTP 429: too many requests" })).toBe("strained")
    expect(classifyProbeStatus({ status: "down", reason: "HTTP 502 bad gateway" })).toBe("down")
    expect(classifyProbeStatus({ status: "ok" })).toBe("ok")
    expect(classifyProbeStatus({ status: "unknown" })).toBe("unknown")
  })
})
