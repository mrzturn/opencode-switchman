// 厂商无关失败分类层 + 模型退休 fixture（bun test）
import { describe, test, expect, beforeAll } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-fc-"))

import { classifyFailure } from "../src/failclass"
import {
  REAL_FAIL_TTL_MS, RATE_LIMIT_TTL_MS, markRealFailure, isRealFailedCombo,
  noteModelNotFound, isModelRetired, retiredModelKeys, filterRetiredShells,
} from "../src/breaker"
import { checkShell } from "../src/gates"
import { buildBanner } from "../src/banner"
import { billingWindow } from "../src/lane"
import type { ShellRegEntry } from "../src/types"

const META = 'ROUTE_META {"lane":"main","role":"programmer","capability":"rw","source":"auto"}'

function shell(provider = "p", modelId = "model"): ShellRegEntry {
  return {
    name: `test-mx-${modelId}-high`, pool: "glm", provider, modelId,
    effort: "high", family: "glm", capability: "rw", vision: false,
    matrixKey: `${provider}|${modelId}|high`, comboKey: `${provider}|${modelId}|high`,
    status: "enabled",
  } as ShellRegEntry
}

// ================= 1. classifyFailure 判定表 =================
describe("失败分类 classifyFailure", () => {
  test("not_found：404 与模型名失效/下线", () => {
    expect(classifyFailure("HTTP 404: model not found")).toBe("not_found")
    expect(classifyFailure("Model unknown model or decommissioned")).toBe("not_found")
    expect(classifyFailure("已下线")).toBe("not_found")
  })
  test("rate_limit：429 与限流字样", () => {
    expect(classifyFailure("HTTP 429: rate limited")).toBe("rate_limit")
    expect(classifyFailure("too many requests, throttled")).toBe("rate_limit")
  })
  test("quota：402/余额/配额与 403-quota 特例", () => {
    expect(classifyFailure("HTTP 402: payment required")).toBe("quota")
    expect(classifyFailure("insufficient balance")).toBe("quota")
    expect(classifyFailure("HTTP 403: monthly quota exceeded")).toBe("quota")
    expect(classifyFailure("HTTP 403: credit limit reached")).toBe("quota")
  })
  test("auth：401/密钥与 403-forbidden 归 auth", () => {
    expect(classifyFailure("HTTP 401: unauthorized")).toBe("auth")
    expect(classifyFailure("invalid api key")).toBe("auth")
    expect(classifyFailure("HTTP 403: Forbidden")).toBe("auth")
  })
  test("server：5xx 与过载", () => {
    expect(classifyFailure("HTTP 500")).toBe("server")
    expect(classifyFailure("HTTP 502 bad gateway")).toBe("server")
  })
  test("network：超时与连接层", () => {
    expect(classifyFailure("TimeoutError")).toBe("network")
    expect(classifyFailure("ECONNREFUSED")).toBe("network")
  })
  test("兜底 unknown", () => {
    expect(classifyFailure("some random gibberish")).toBe("unknown")
  })
})

// ================= 2. rate_limit 短 TTL vs 默认长 TTL =================
describe("实调失败 TTL 分离", () => {
  test("限流短标记在 10 分钟后过期，真失败长标记仍在", () => {
    const now = Date.now()
    markRealFailure("rl|combo", now, RATE_LIMIT_TTL_MS)
    markRealFailure("lf|combo", now)
    expect(isRealFailedCombo("rl|combo", now)).toBe(true)
    expect(isRealFailedCombo("lf|combo", now)).toBe(true)
    // 过了短 TTL：限流过期、长标记仍有效
    expect(isRealFailedCombo("rl|combo", now + RATE_LIMIT_TTL_MS + 1)).toBe(false)
    expect(isRealFailedCombo("lf|combo", now + RATE_LIMIT_TTL_MS + 1)).toBe(true)
    // 过了长 TTL：两者都过期
    expect(isRealFailedCombo("lf|combo", now + REAL_FAIL_TTL_MS + 1)).toBe(false)
  })
})

// ================= 3. 模型退休（连续 404） =================
describe("模型退休 noteModelNotFound", () => {
  test("1h 窗内累计 3 次触发退休，返回恰好触发", () => {
    const now = Date.now()
    expect(noteModelNotFound("p/retire-me", now)).toBe(false)
    expect(noteModelNotFound("p/retire-me", now + 1)).toBe(false)
    expect(noteModelNotFound("p/retire-me", now + 2)).toBe(true) // 第三次恰好触发
    expect(isModelRetired("p/retire-me")).toBe(true)
    expect(retiredModelKeys()).toContain("p/retire-me")
    // 已退休后再记不再触发
    expect(noteModelNotFound("p/retire-me", now + 3)).toBe(false)
  })
  test("不足 3 次不退休", () => {
    const now = Date.now()
    noteModelNotFound("p/not-yet", now)
    noteModelNotFound("p/not-yet", now + 1)
    expect(isModelRetired("p/not-yet")).toBe(false)
  })
  test("filterRetiredShells 滤掉已退休模型壳", () => {
    noteModelNotFound("p/filtered", Date.now())
    noteModelNotFound("p/filtered", Date.now() + 1)
    noteModelNotFound("p/filtered", Date.now() + 2)
    const kept = filterRetiredShells([
      { provider: "p", modelId: "filtered" },
      { provider: "p", modelId: "alive" },
    ])
    expect(kept.map((s) => s.modelId)).toEqual(["alive"])
  })
})

// ================= 4. 退休闸 deny =================
describe("退休闸 checkShell deny", () => {
  test("retiredModels 命中 provider/modelId → deny 含「已下线」", () => {
    const s = shell("p", "retired-gate")
    const r = checkShell(s.name, s, META, {
      registry: { [s.name]: s },
      matrix: null,
      routing: { down_agents: {}, down_expiry: {} },
      quotaExhausted: {},
      retiredModels: new Set(["p/retired-gate"]),
      lanes: { main: [s.name] },
    })
    expect(r.deny).toContain("已下线")
  })
  test("未命中退休集 → 不拦（fail-open）", () => {
    const s = shell("p", "alive-gate")
    const r = checkShell(s.name, s, META, {
      registry: { [s.name]: s },
      matrix: null,
      routing: { down_agents: {}, down_expiry: {} },
      quotaExhausted: {},
      retiredModels: new Set<string>(),
      lanes: { main: [s.name] },
    })
    expect(r.deny).toBeNull()
  })
})

// ================= 5. 横幅 [限制] 含「已下线」 =================
describe("横幅退休标注", () => {
  test("retiredModels>0 时 [限制] 行含「已下线」", () => {
    const lines = buildBanner({
      lanes: null, down: [],
      quota: { glm: null, copilot: null },
      states: {}, billing: billingWindow(),
      matrixInfo: { mode: "desktop", configStatus: "ok", watch: true, retiredModels: 3 },
    })
    expect(lines[2]).toContain("3 模型已下线")
  })
  test("retiredModels=0 时不追加", () => {
    const lines = buildBanner({
      lanes: null, down: [],
      quota: { glm: null, copilot: null },
      states: {}, billing: billingWindow(),
      matrixInfo: { mode: "desktop", configStatus: "ok", watch: true, retiredModels: 0 },
    })
    expect(lines[2]).not.toContain("已下线")
  })
})
