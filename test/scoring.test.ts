// 模型评分引擎 fixture（bun test）
// 沙箱：SWITCHMAN_STATE 指向临时目录；baseScore/scoreShell/rankCandidates/logDecision 纯函数直测。
import { describe, test, expect, beforeAll } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-sc-"))

import { baseScore, GLOBAL_MEDIAN_SCORE } from "../src/model-ranks"
import { scoreShell, rankCandidates, logDecision } from "../src/scoring"
import type { ScoreInput, WaterFactor, Rankable, RankContext, DecisionRecord } from "../src/scoring"
import { classifyProbeStatus } from "../src/probe"
import { classifyFailure } from "../src/failclass"
import { paths } from "../src/state"
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
    matrixStatus: "ok", latencyMs: 100, glmPeak: false, immediate: false, water: W,
    ...over,
  }
}

// ================= 1. baseScore 匹配四路 =================
describe("baseScore", () => {
  test("精确键命中", () => {
    expect(baseScore("claude-opus-5")).toEqual({ score: 1.0, tier: "S", source: "exact" })
    expect(baseScore("glm-5.3")).toEqual({ score: 0.85, tier: "A", source: "exact" })
    expect(baseScore("glm-5.3-flash")).toEqual({ score: 0.7, tier: "B", source: "exact" })
    expect(baseScore("glm-4.5-air")).toEqual({ score: 0.55, tier: "C", source: "exact" })
  })
  test("最长前缀命中（变体）", () => {
    expect(baseScore("gpt-5.6-codex")).toEqual({ score: 1.0, tier: "S", source: "prefix" })
    expect(baseScore("gpt-5.6-luna")).toEqual({ score: 1.0, tier: "S", source: "prefix" })
    expect(baseScore("gemini-3.1-pro-preview")).toEqual({ score: 1.0, tier: "S", source: "prefix" })
    expect(baseScore("deepseek-v4-flash-vision-exp")).toEqual({ score: 0.7, tier: "B", source: "prefix" })
  })
  test("精确优先于前缀（gpt-5.6-mini 是 A 不是 S）", () => {
    expect(baseScore("gpt-5.6-mini")).toEqual({ score: 0.85, tier: "A", source: "exact" })
  })
  test("family 中位数（同族未知模型）", () => {
    const r = baseScore("glm-5.4") // glm 族表内分数中位数 0.7 → B
    expect(r.source).toBe("family")
    expect(r.tier).toBe("B")
    expect(r.score).toBe(0.7)
  })
  test("全局兜底（未知新厂商）", () => {
    const r = baseScore("mimo-v2.5-free")
    expect(r.source).toBe("global")
    expect(r.score).toBe(GLOBAL_MEDIAN_SCORE)
    expect(r.tier).toBe("C")
  })
})

// ================= 2. scoreShell 软系数 =================
describe("scoreShell", () => {
  test("strained 健康系数 0.6（其余系数不变）", () => {
    const b = scoreShell(scoreInput({ matrixStatus: "strained" }))
    expect(b.health).toBe(0.6)
    expect(b.total).toBeCloseTo(0.85 * 1.0 * 0.6 * 1.0 * 1.0 * 1.0)
    expect(scoreShell(scoreInput()).health).toBe(1.0)
  })
  test("peak 仅 glm 池生效（copilot 不受影响）", () => {
    expect(scoreShell(scoreInput({ glmPeak: true, pool: "glm" })).peak).toBeCloseTo(0.93)
    expect(scoreShell(scoreInput({ glmPeak: true, pool: "copilot" })).peak).toBe(1.0)
  })
  test("water：GLM 高水位线性降、Copilot 临期烧积分提升", () => {
    expect(scoreShell(scoreInput({ water: { glmFiveHourPct: 90 } })).water).toBeCloseTo(0.6)
    expect(scoreShell(scoreInput({ water: { glmFiveHourPct: 0 } })).water).toBe(1.0)
    const burn = scoreShell(scoreInput({
      pool: "copilot",
      water: { copilotRemainingPct: 50, copilotResetDays: 3 },
    }))
    expect(burn.water).toBe(1.0)
    // 复审P1-1：吃紧（rem<20%）临期不提权，与「吃紧→改 glm」一致
    const tight = scoreShell(scoreInput({
      pool: "copilot",
      water: { copilotRemainingPct: 5, copilotResetDays: 2 },
    }))
    expect(tight.water).toBeLessThan(1.0)
  })
  test("costBias：订阅池 1.0 / 按量池 0.7 / DS 空闲惩罚减轻 0.85", () => {
    expect(scoreShell(scoreInput({ pool: "glm" })).costBias).toBe(1.0)
    expect(scoreShell(scoreInput({ pool: "deepseek" })).costBias).toBe(0.7)
    expect(scoreShell(scoreInput({ pool: "deepseek", water: { dsIdle: true } })).costBias).toBe(0.85)
  })
})

// ================= 3. rankCandidates =================
describe("rankCandidates", () => {
  test("tier 分组不可逆：C 档完美系数不越 A 档最差系数", () => {
    const shells = [
      rankable({ key: "a", modelId: "glm-5.3", effort: "off", matrixStatus: "strained", latencyMs: 999 }),
      rankable({ key: "c", modelId: "glm-4.5-air", effort: "high", pool: "copilot", matrixStatus: "ok", latencyMs: 1 }),
    ]
    const r = rankCandidates(shells, ctx({ glmPeak: true, water: { glmFiveHourPct: 89 } }))
    // c 的乘积分 > a，但 tier 分组使 A 恒在 C 前
    expect(r.breakdowns.get("c")!.total).toBeGreaterThan(r.breakdowns.get("a")!.total)
    expect(r.ranked.map((s) => s.key)).toEqual(["a", "c"])
  })
  test("immediate 只按 latency 升序，忽略软系数（B 档快于 S 档慢）", () => {
    const shells = [
      rankable({ key: "slow-s", modelId: "gpt-5.6", pool: "copilot", family: "gpt", latencyMs: 900 }),
      rankable({ key: "fast-b", modelId: "glm-5.3-flash", latencyMs: 10 }),
    ]
    const r = rankCandidates(shells, ctx({ immediate: true }))
    expect(r.ranked.map((s) => s.key)).toEqual(["fast-b", "slow-s"])
  })
  test("硬门：down/熔断/耗尽/退休/隔离全部剔除，strained 参与", () => {
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
  test("端到端小样本：DS 恒链尾，非 DS 按 tier 序", () => {
    const shells = [
      rankable({ key: "ds-s", modelId: "deepseek-v4-pro", pool: "deepseek", family: "deepseek", latencyMs: 5 }),
      rankable({ key: "glm-a", modelId: "glm-5.3", latencyMs: 50 }),
      rankable({ key: "cp-s", modelId: "gpt-5.6", pool: "copilot", family: "gpt", latencyMs: 80 }),
    ]
    const r = rankCandidates(shells, ctx())
    expect(r.ranked.map((s) => s.key)).toEqual(["cp-s", "glm-a", "ds-s"])
    expect(r.breakdowns.get("cp-s")!.tier).toBe("S")
    expect(r.breakdowns.get("glm-a")!.tier).toBe("A")
    expect(r.breakdowns.get("ds-s")!.tier).toBe("S")
  })
})

// ================= 4. 决策日志 =================
describe("决策日志 logDecision", () => {
  beforeAll(() => {
    mkdirSync(paths().dir, { recursive: true })
  })
  test("写入 + 环形截断保留最近 200 行", async () => {
    const rec = (name: string): DecisionRecord => ({
      at: new Date().toISOString(),
      lane: "main",
      candidates: [{
        name, base: 1.0, baseSource: "exact", effortFit: 1.0, health: 1.0, water: 1.0,
        costBias: 1.0, peak: 1.0, total: 1.0, tier: "S",
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
  test("classifyFailure + classifyProbeStatus（纯函数层）", () => {
    expect(classifyFailure("HTTP 429: rate limited")).toBe("rate_limit")
    expect(classifyProbeStatus({ status: "down", reason: "HTTP 429: too many requests" })).toBe("strained")
    expect(classifyProbeStatus({ status: "down", reason: "HTTP 502 bad gateway" })).toBe("down")
    expect(classifyProbeStatus({ status: "ok" })).toBe("ok")
    expect(classifyProbeStatus({ status: "unknown" })).toBe("unknown")
  })
})
