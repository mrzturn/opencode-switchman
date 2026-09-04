// [2026-09-04]-[English localization: translate comments and test titles; no assertion or logic change]
// Dynamic capability grading fixture (bun test)
// Sandbox: SWITCHMAN_STATE points at a temp dir; direct pure-function tests + fetch stubs for refresh fallback and decision-log traceability.
import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-cap-"))

import {
  normalizeModelKey, tierOfScore, resolveThresholds, percentileOf,
  parseAaModels, parseOpenRouterModels,
  baseScoreDynamic, refreshCapability, loadCapability, loadBundledCapability, resetCapabilityCache,
} from "../src/capability"
import { scoreShell, logDecision } from "../src/scoring"
import type { ScoreInput, DecisionRecord } from "../src/scoring"
import { CAPABILITY_TTL, paths } from "../src/state"
import type { CapabilityIndex } from "../src/capability"

const W = {}
function scoreInput(over: Partial<ScoreInput> = {}): ScoreInput {
  return {
    modelId: "glm-5.3", effort: "high", lane: "main", pool: "glm",
    matrixStatus: "ok", latencyMs: 100, peakActive: false, immediate: false, water: W,
    ...over,
  }
}

function writeIndex(idx: Partial<CapabilityIndex>): void {
  const full: CapabilityIndex = {
    source: "artificial-analysis", version: "test-ver-1", fetched_at: Date.now() / 1000,
    thresholds: { S: 62, A: 55, B: 45 },
    models: {
      "gpt-5.6": { score: 70 },
      "claude-opus-4.8": { score: 58 },
      "glm-5.3": { score: 47 },
      "mimo": { score: 40 },
    },
    ...idx,
  }
  mkdirSync(paths().dir, { recursive: true })
  writeFileSync(paths().capability, JSON.stringify(full))
  resetCapabilityCache()
}

// ================= 1. key normalization =================
describe("normalizeModelKey", () => {
  test("provider prefix/spaces/variant parens/illegal chars", () => {
    expect(normalizeModelKey("openai/gpt-5.6-codex")).toBe("gpt-5.6-codex")
    expect(normalizeModelKey("Claude Opus 4.8 (High)")).toBe("claude-opus-4.8")
    expect(normalizeModelKey("GPT-5.6 [04-14]")).toBe("gpt-5.6")
    expect(normalizeModelKey("  gemini_3.1_pro  ")).toBe("gemini-3.1-pro")
    expect(normalizeModelKey("")).toBe("")
  })
})

// ================= 2. tier mapping and thresholds =================
describe("tierOfScore / resolveThresholds", () => {
  const th = { S: 62, A: 55, B: 45 }
  test("absolute threshold boundaries: 62->S / 55->A / 45->B / below->C", () => {
    expect(tierOfScore(62, th)).toBe("S")
    expect(tierOfScore(61.9, th)).toBe("A")
    expect(tierOfScore(55, th)).toBe("A")
    expect(tierOfScore(54.9, th)).toBe("B")
    expect(tierOfScore(45, th)).toBe("B")
    expect(tierOfScore(44, th)).toBe("C")
  })
  test("quantile: p80/p60/p40 percentile thresholds", () => {
    const scores = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]
    expect(resolveThresholds("quantile", scores)).toEqual({ S: 80, A: 60, B: 40 })
  })
  test("invalid thresholds fall back to defaults (S>A>B must hold strictly)", () => {
    expect(resolveThresholds({ S: 50, A: 50, B: 40 }, [])).toEqual({ S: 62, A: 55, B: 45 })
    expect(resolveThresholds(undefined, [])).toEqual({ S: 62, A: 55, B: 45 })
  })
  test("percentileOf returns null on an empty array", () => {
    expect(percentileOf([], 0.8)).toBeNull()
  })
})

// ================= 3. dual-source parsing (pure functions) =================
describe("parseAaModels / parseOpenRouterModels", () => {
  test("AA v2: evaluations long/short field compatibility, entries without indices dropped, versionHint=latest release_date", () => {
    const r = parseAaModels({
      data: [
        { name: "GPT-5.6", evaluations: { artificial_analysis_intelligence_index: 70.5, artificial_analysis_coding_index: 65 } },
        { name: "Claude Opus 4.8 (High)", evaluations: { intelligence_index: 58 }, release_date: "2026-08-01" },
        { name: "NoIndex", evaluations: { mmlu_pro: 0.8 }, release_date: "2026-08-15" },
      ],
    })
    expect(Object.keys(r.models).sort()).toEqual(["claude-opus-4.8", "gpt-5.6"])
    expect(r.models["gpt-5.6"]!.score).toBe(70.5)
    expect(r.models["gpt-5.6"]!.coding).toBe(65)
    expect(r.models["claude-opus-4.8"]!.score).toBe(58)
    expect(r.versionHint).toBe("2026-08-01")
  })
  test("OpenRouter: id strips the provider prefix, versionHint=max created; top-level fields and benchmarks.artificial_analysis both supported", () => {
    const r = parseOpenRouterModels({
      data: [
        { id: "openai/gpt-5.6", intelligence: 71, created: 1700000001 },
        { id: "anthropic/claude-opus-4.8", coding: 57, created: 1700000000 },
        { id: "z-ai/glm-5.3", benchmarks: { artificial_analysis: { intelligence_index: 59.5, coding_index: 74.8, agentic_index: 59.1 } }, created: 1700000002 },
        { id: "x/no-index", created: 1700000003 },
      ],
    })
    expect(r.scoreKind).toBe("index")
    expect(Object.keys(r.models).sort()).toEqual(["claude-opus-4.8", "glm-5.3", "gpt-5.6"])
    expect(r.models["gpt-5.6"]!.score).toBe(71)
    expect(r.models["glm-5.3"]!.score).toBe(59.5)
    expect(r.models["glm-5.3"]!.coding).toBe(74.8)
    expect(r.versionHint).toBe("1700000003") // max created across the whole catalog (incl. entries without indices; version = catalog freshness)
  })
  test("OpenRouter without index fields (measured public-source shape): rank-derived percentile scores only for models with benchmarks data; models without data dropped (fall back to bundled tiers, unknown != weakest)", () => {
    const r = parseOpenRouterModels({
      data: [
        { id: "anthropic/claude-opus-5", created: 1784912544, benchmarks: { design_arena: [{ elo: 1300 }] } },
        { id: "openai/gpt-5.6", created: 1784912543, benchmarks: { design_arena: [] } },
        { id: "zhipu/glm-5.3", created: 1784912542, benchmarks: { design_arena: [{ elo: 1200 }] } },
        { id: "deepseek/deepseek-chat", created: 1784912541, benchmarks: { design_arena: [{ elo: 1100 }] } },
        { id: "z-ai/glm-5-turbo", created: 1784912540 }, // no benchmarks = no evaluation data -> dropped, not ranked at the list tail
      ],
    })
    expect(r.scoreKind).toBe("rank")
    expect(Object.keys(r.models).sort()).toEqual(["claude-opus-5", "deepseek-chat", "glm-5.3", "gpt-5.6"])
    expect(r.models["claude-opus-5"]!.score).toBe(100)
    expect(r.models["gpt-5.6"]!.score).toBeCloseTo(66.7)
    expect(r.models["glm-5.3"]!.score).toBeCloseTo(33.3)
    expect(r.models["deepseek-chat"]!.score).toBe(0)
    expect(r.models["glm-5-turbo"]).toBeUndefined()
  })
})

// ================= 4. baseScoreDynamic match chain =================
describe("baseScoreDynamic", () => {
  beforeEach(() => {
    rmSync(paths().capability, { force: true })
    resetCapabilityCache()
  })
  test("no live cache: bundled default ranks take priority (bundled), curated table becomes the last-resort fallback", () => {
    // [2026-08-31]-[bundled official rank snapshot fallback: up-to-date bundled ranks even when offline/fetch fails; keys read dynamically from the snapshot to avoid drift across iterations]
    const b = loadBundledCapability()!
    expect(b.bundled).toBe(true)
    expect(String(b.version)).toMatch(/^bundled-/)
    expect(Object.keys(b.models).length).toBeGreaterThan(100)
    expect(b.thresholds.S).toBeGreaterThan(b.thresholds.A)
    expect(b.thresholds.A).toBeGreaterThan(b.thresholds.B)
    const key = Object.keys(b.models).sort()![0]!
    const r = baseScoreDynamic(key)
    expect(r.source).toBe("bundled")
    expect(r.version).toBe(b.version)
    expect(r.matchedAs).toBe(key)
    // prefix variants also hit the bundled ranks
    expect(baseScoreDynamic(`${key}-xyz-variant`).source).toBe("bundled")
    // bundled miss too -> curated table/global fallback
    expect(baseScoreDynamic("totally-unknown-xyz").source).toBe("global")
  })
  test("api exact hit (version exposed)", () => {
    writeIndex({})
    expect(baseScoreDynamic("glm-5.3")).toEqual({
      score: 0.7, rawScore: 47, tier: "B", source: "api", version: "test-ver-1", matchedAs: "glm-5.3",
    })
  })
  test("api longest-prefix hit (>=4 chars)", () => {
    writeIndex({})
    expect(baseScoreDynamic("gpt-5.6-luna").source).toBe("api")
    expect(baseScoreDynamic("gpt-5.6-luna").tier).toBe("S")
    expect(baseScoreDynamic("mimo-v2-free").tier).toBe("C")
  })
  test("api miss -> curated table fallback", () => {
    writeIndex({})
    expect(baseScoreDynamic("gpt-5.4")).toEqual({ score: 0.85, tier: "A", source: "exact", version: null })
  })
  test("expired cache still participates as last-good (no fallback before refresh)", () => {
    writeIndex({ fetched_at: Date.now() / 1000 - CAPABILITY_TTL - 10 })
    expect(baseScoreDynamic("glm-5.3").source).toBe("api")
  })
})

// ================= 5. refresh chain fail-open (fetch stubs) =================
describe("refreshCapability", () => {
  const realFetch = globalThis.fetch
  beforeEach(() => {
    rmSync(paths().capability, { force: true })
    resetCapabilityCache()
  })
  afterAll(() => {
    globalThis.fetch = realFetch
    resetCapabilityCache()
  })
  test("429: no throw, no persist, scoring falls back to bundled default ranks (non-blocking)", async () => {
    globalThis.fetch = (async () => new Response("rate limited", { status: 429 })) as any
    await refreshCapability({ source: "openrouter" })
    expect(existsSync(paths().capability)).toBe(false)
    expect(loadCapability()).toBeNull()
    const r = baseScoreDynamic("glm-5.3")
    // offline/rate-limit fallback: bundled ranks or the curated table provide a valid base score -- never blocks delegation
    expect(r.source).not.toBe("api")
    expect([1.0, 0.85, 0.7, 0.55]).toContain(r.score)
  })
  test("network failure (offline): fail-open as above", async () => {
    globalThis.fetch = (async () => { throw new TypeError("fetch failed") }) as any
    await refreshCapability({ source: "openrouter" })
    expect(existsSync(paths().capability)).toBe(false)
  })
  test("AA success: capability.json persisted with source/version/fetched_at, scoring chain switches to api", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      status: 200,
      data: [{ name: "GPT-5.6", evaluations: { artificial_analysis_intelligence_index: 70 } }],
    }), { status: 200, headers: { etag: '"ver-abc"' } })) as any
    await refreshCapability({ source: "artificial-analysis", apiKey: "k" })
    const disk = JSON.parse(readFileSync(paths().capability, "utf8"))
    expect(disk.source).toBe("artificial-analysis")
    expect(disk.version).toBe("ver-abc")
    expect(typeof disk.fetched_at).toBe("number")
    const r = baseScoreDynamic("gpt-5.6-codex")
    expect(r.source).toBe("api")
    expect(r.version).toBe("ver-abc")
  })
  test("auto without key: skip AA, go straight to OpenRouter", async () => {
    delete process.env.ARTIFICIAL_ANALYSIS_API_KEY
    delete process.env.AA_API_KEY
    let called = ""
    globalThis.fetch = (async (url: any) => {
      called = String(url)
      return new Response(JSON.stringify({ data: [{ id: "openai/gpt-5.6", intelligence: 70 }] }), { status: 200 })
    }) as any
    await refreshCapability({})
    expect(called).toContain("openrouter.ai")
    expect(loadCapability()!.source).toBe("openrouter")
  })
  test("rank-derived scores (no index fields): force quantile when thresholds unconfigured, top20% is S; models without benchmarks stay out of the table", async () => {
    // 20 models in coding order (high->low): derived scores 100..0, quantile p80/p60/p40 -> ranks 0-3 S, 4-7 A, 8-11 B, rest C
    const data: any[] = Array.from({ length: 20 }, (_, i) => ({ id: `v/m${i}`, created: 1700000000 + i, benchmarks: { design_arena: [] } }))
    data.push({ id: "v/no-data", created: 1700000020 }) // no evaluation data -> dropped (unknown != weakest)
    globalThis.fetch = (async () => new Response(JSON.stringify({ data }), { status: 200 })) as any
    await refreshCapability({ source: "openrouter" })
    const idx = loadCapability()!
    expect(idx.score_kind).toBe("rank")
    expect(idx.thresholds).toEqual({ S: 78.9, A: 57.9, B: 36.8 }) // p80/p60/p40 computed (linear quantiles over 20 entries)
    expect(tierOfScore(idx.models["m0"]!.score, idx.thresholds)).toBe("S")
    expect(tierOfScore(idx.models["m5"]!.score, idx.thresholds)).toBe("A")
    expect(tierOfScore(idx.models["m10"]!.score, idx.thresholds)).toBe("B")
    expect(tierOfScore(idx.models["m19"]!.score, idx.thresholds)).toBe("C")
    expect(idx.models["no-data"]).toBeUndefined()
  })
})

// ================= 6. scoring integration and decision-log traceability =================
describe("scoring integration", () => {
  beforeAll(() => {
    mkdirSync(paths().dir, { recursive: true })
  })
  test("scoreShell: baseSource=api + raw capability index + baseVersion, product chain unchanged", () => {
    rmSync(paths().capability, { force: true })
    writeIndex({})
    const b = scoreShell(scoreInput({ modelId: "glm-5.3" }))
    expect(b.base).toBeCloseTo(0.7)
    expect(b.rawCapability).toBe(47)
    expect(b.baseSource).toBe("api")
    expect(b.baseVersion).toBe("test-ver-1")
    expect(b.total).toBeCloseTo(b.base * b.effortFit * b.health * b.water * b.costBias * b.peak)
  })
  test("offline fresh install (no capability.json): scoreShell consumes the bundled default ranks directly", () => {
    // [2026-08-31]-[bundled full-chain integration: missing disk index -> the bundled snapshot exclusively drives scoring (source=bundled, version bundled- prefixed)]
    rmSync(paths().capability, { force: true })
    resetCapabilityCache()
    const b = loadBundledCapability()!
    const key = Object.keys(b.models).sort()![0]!
    const sb = scoreShell(scoreInput({ modelId: key }))
    expect(sb.baseSource).toBe("bundled")
    expect(sb.baseVersion).toBe(b.version)
    expect(String(sb.baseVersion)).toMatch(/^bundled-/)
    expect(sb.total).toBeCloseTo(sb.base * sb.effortFit * sb.health * sb.water * sb.costBias * sb.peak * sb.billingBoost * sb.unknownPenalty)
  })
  test("decision log: baseSource=api with a traceable version", async () => {
    rmSync(paths().capability, { force: true })
    writeIndex({})
    const b = scoreShell(scoreInput({ modelId: "glm-5.3" }))
    const rec: DecisionRecord = {
      at: new Date().toISOString(),
      lane: "main",
      candidates: [{ name: "glm-mx-53-high", base: b.base, baseSource: b.baseSource, baseVersion: b.baseVersion, effortFit: b.effortFit, health: b.health, water: b.water, costBias: b.costBias, peak: b.peak, billingBoost: b.billingBoost, unknownPenalty: b.unknownPenalty, total: b.total, tier: b.tier }],
    }
    await logDecision([rec])
    const line = JSON.parse(readFileSync(paths().decisions, "utf8").split("\n")[0]!)
    expect(line.candidates[0].baseSource).toBe("api")
    expect(line.candidates[0].baseVersion).toBe("test-ver-1")
  })
})
