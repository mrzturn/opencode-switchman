// 用户手动覆盖层 fixture（bun test）：手动能力排名（baseScoreDynamic 覆盖）+ 任务池选配（computeLane/闸5.5）。
// 沙箱：SWITCHMAN_STATE 指向临时目录；写空壳 capability.json 固定基础分来源，断言不随实时数据漂移。
import { describe, test, expect, beforeAll } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-uo-"))
mkdirSync(process.env.SWITCHMAN_STATE, { recursive: true })
writeFileSync(
  join(process.env.SWITCHMAN_STATE, "capability.json"),
  JSON.stringify({ source: "artificial-analysis", version: "fixed-empty", fetched_at: Date.now() / 1000, thresholds: { S: 62, A: 55, B: 45 }, models: {} }),
)

import { baseScoreDynamic, manualRankResult, resetCapabilityCache } from "../src/capability"
import {
  validateCapabilityRank, loadCapabilityRank, writeCapabilityRank, clearCapabilityRank,
  validatePoolConfig, loadPoolConfig, poolAllowlist, writePoolConfig, resetPoolConfig, resetUserOverridesCache,
} from "../src/user-overrides"
import { computeLane } from "../src/lane"
import { checkShell } from "../src/gates"
import { paths } from "../src/state"
import type { ShellRegEntry } from "../src/types"

beforeAll(() => {
  resetCapabilityCache()
  resetUserOverridesCache()
})

function shellReg(over: Partial<ShellRegEntry> = {}): ShellRegEntry {
  return {
    name: "s", pool: "glm", provider: "zhipuai-coding-plan", modelId: "glm-5.3",
    effort: "high", family: "glm", capability: "rw", vision: false,
    matrixKey: "zhipuai-coding-plan|glm-5.3|high", comboKey: "zhipuai-coding-plan|glm-5.3|high",
    status: "enabled",
    ...over,
  } as ShellRegEntry
}

const REGISTRY: Record<string, ShellRegEntry> = {
  "glm-mx-glm-53-high": shellReg({ name: "glm-mx-glm-53-high", modelId: "glm-5.3", matrixKey: "zhipuai-coding-plan|glm-5.3|high", comboKey: "zhipuai-coding-plan|glm-5.3|high" }),
  "glm-mx-glm-53-flash-high": shellReg({ name: "glm-mx-glm-53-flash-high", modelId: "glm-5.3-flash", matrixKey: "zhipuai-coding-plan|glm-5.3-flash|high", comboKey: "zhipuai-coding-plan|glm-5.3-flash|high" }),
}
const BASE = Object.keys(REGISTRY)

// ---- 文件层 ----

describe("capability-rank.json（手动能力排名）", () => {
  test("校验：去重/归一化/坏结构 null", () => {
    expect(validateCapabilityRank(null)).toBeNull()
    expect(validateCapabilityRank({ models: "x" })).toBeNull()
    const v = validateCapabilityRank({ models: ["GLM-5.3", "glm-5.3", "  ", "ZhipuAI/GLM-5.3-Flash(x)"] })
    expect(v).not.toBeNull()
    expect(v!.models).toEqual(["glm-5.3", "glm-5.3-flash"]) // 归一化键（去 provider/变体括号，保留点号）
  })

  test("写入/读取 round-trip + 缓存失效", () => {
    writeCapabilityRank(["glm-5.3", "gpt-5.6"])
    const loaded = loadCapabilityRank()
    expect(loaded?.models).toEqual(["glm-5.3", "gpt-5.6"])
    expect(loaded?.updated_at.length).toBeGreaterThan(0)
    writeCapabilityRank(["kimi-k3"])
    expect(loadCapabilityRank()?.models).toEqual(["kimi-k3"])
  })

  test("baseScoreDynamic：手动排名压过基础能力分（gpt-5.6 策展 S 被排到 glm-5.3 之后）", () => {
    writeCapabilityRank(["glm-5.3", "gpt-5.6"])
    const first = baseScoreDynamic("glm-5.3")
    const second = baseScoreDynamic("gpt-5.6")
    expect(first.source).toBe("manual")
    expect(first.tier).toBe("S")
    expect(first.score).toBe(1.0)
    expect(second.source).toBe("manual")
    // 小 n 序位阶梯（n≤4 依次 S/A/B/C）：2 项排名次名=A 档（rawScore 仍线性 100→0 保序）
    expect(second.rawScore).toBe(0)
    expect(second.tier).toBe("A")
    expect(second.score).toBe(0.85)
    expect(second.version!.startsWith("manual-")).toBe(true)
  })

  test("档位阶梯：n=4 依次 S/A/B/C；n≥5 回归 quantile 口径（top20% S）", () => {
    writeCapabilityRank(["m1", "m2", "m3", "m4"])
    expect(["m1", "m2", "m3", "m4"].map((m) => baseScoreDynamic(m).tier)).toEqual(["S", "A", "B", "C"])
    writeCapabilityRank(["m1", "m2", "m3", "m4", "m5"])
    // 线性 100/75/50/25/0 + quantile 阈值 75/50/25 → S/S/A/B/C
    expect(["m1", "m2", "m3", "m4", "m5"].map((m) => baseScoreDynamic(m).tier)).toEqual(["S", "S", "A", "B", "C"])
  })

  test("前缀匹配：排名条目覆盖其变体（gpt-5.6 → gpt-5.6-luna）", () => {
    writeCapabilityRank(["gpt-5.6"])
    const hit = manualRankResult("gpt-5.6-luna")
    expect(hit?.source).toBe("manual")
    expect(hit?.matchedAs).toBe("gpt-5.6")
    expect(hit?.tier).toBe("S")
  })

  test("manualRankResult：未命中返回 null（走原回退链）", () => {
    writeCapabilityRank(["glm-5.3"])
    expect(manualRankResult("kimi-k3")).toBeNull()
    expect(manualRankResult("")).toBeNull()
  })

  test("未命中模型走原回退链；clear 后全员回退策展表", () => {
    writeCapabilityRank(["glm-5.3", "gpt-5.6"])
    const untouched = baseScoreDynamic("claude-opus-5")
    expect(untouched.source).toBe("exact")
    expect(untouched.tier).toBe("S")
    clearCapabilityRank()
    expect(loadCapabilityRank()).toBeNull()
    expect(baseScoreDynamic("glm-5.3").source).toBe("exact")
  })
})

// ---- 任务池选配（lane 键：economy/mechanical/main/hard/vision/review，同模型可跨池重复）----

describe("pool-config.json（任务池选配）", () => {
  test("校验：未知 lane 键忽略、大小写归一、空清单=未配置（fail-open）", () => {
    expect(validatePoolConfig(null)).toBeNull()
    const v = validatePoolConfig({ pools: { MAIN: ["GLM-5.3", "glm-5.3", " "], economy: [], nosuchpool: ["glm-5.3"], hard: ["gpt-5.6"] } })
    expect(v).not.toBeNull()
    expect(Object.keys(v!.pools).sort()).toEqual(["hard", "main"]) // 未知键/空清单剔除
    expect(v!.pools.main).toEqual(["glm-5.3"])
  })

  test("writePoolConfig：跨 lane 互不影响、同模型可重复进驻；空清单=删键恢复默认", () => {
    writePoolConfig("MAIN ", ["glm-5.3"]) // 大小写/空白容错归一
    expect(poolAllowlist("main")).not.toBeNull()
    writePoolConfig("economy", ["glm-5.3", "gpt-5.6"]) // 同模型跨池重复
    expect([...poolAllowlist("main")!]).toEqual(["glm-5.3"])
    expect([...poolAllowlist("economy")!]).toEqual(["glm-5.3", "gpt-5.6"])
    expect(poolAllowlist("hard")).toBeNull() // 未配置 lane=不过滤
    expect(() => writePoolConfig("nosuchpool", ["glm-5.3"])).toThrow(/未知任务池/)
    expect(writePoolConfig("main", [])?.pools.main).toBeUndefined() // 空=删键恢复默认
    expect(poolAllowlist("main")).toBeNull()
    expect([...poolAllowlist("economy")!]).toEqual(["glm-5.3", "gpt-5.6"]) // 其余 lane 保留
    resetPoolConfig("economy")
    expect(loadPoolConfig()).toEqual({}) // 全空=文件删除
    expect(existsSync(paths().poolConfig)).toBe(false)
    resetPoolConfig("main") // 幂等：文件已不存在不报错
  })

  test("computeLane：lane 键隔离——main 选配过滤生效，economy 未配置不受影响", () => {
    writePoolConfig("main", ["glm-5.3"])
    const p = { registry: REGISTRY, matrix: null, routing: null, poolConfig: loadPoolConfig() }
    const main = computeLane("main", BASE, p)
    expect(main.chain.map((c) => c.shell)).toEqual(["glm-mx-glm-53-high"])
    expect(main.dropped).toContainEqual({ shell: "glm-mx-glm-53-flash-high", reason: "pool-config" })
    // economy 未配置：无任何 pool-config 出局（tier 亲和裁剪与此无关，只验无选配原因）
    const economy = computeLane("economy", BASE, p)
    expect(economy.dropped.some((d) => d.reason === "pool-config")).toBe(false)
    expect(economy.chain.some((c) => c.shell === "glm-mx-glm-53-flash-high")).toBe(true)
  })

  test("computeLane：选配清单跨 provider 池（同模型可重复进驻）", () => {
    const copilotShell = shellReg({
      name: "copilot-mx-gpt-56-high", pool: "copilot", provider: "github-copilot", modelId: "gpt-5.6",
      family: "gpt", matrixKey: "github-copilot|gpt-5.6|high", comboKey: "github-copilot|gpt-5.6|high",
    })
    const reg = { ...REGISTRY, "copilot-mx-gpt-56-high": copilotShell }
    writePoolConfig("main", ["glm-5.3", "gpt-5.6"])
    const r = computeLane("main", [...BASE, "copilot-mx-gpt-56-high"], {
      registry: reg, matrix: null, routing: null, poolConfig: loadPoolConfig(),
    })
    // 跨池混合选配：glm 与 copilot 壳同时入选
    expect(r.chain.map((c) => c.shell)).toEqual(["glm-mx-glm-53-high", "copilot-mx-gpt-56-high"])
    expect(r.dropped).toContainEqual({ shell: "glm-mx-glm-53-flash-high", reason: "pool-config" })
  })

  test("computeLane：未传 poolConfig（缺省）不过滤——fail-open 兼容旧调用方", () => {
    writePoolConfig("main", ["glm-5.3"])
    const r = computeLane("main", BASE, { registry: REGISTRY, matrix: null, routing: null })
    expect(r.chain.length).toBe(2)
  })

  test("闸5.5：未入选壳 deny 附任务池选配文案与改派 hint；hint 不推荐未入选模型", () => {
    writePoolConfig("main", ["glm-5.3"])
    const snap = {
      registry: REGISTRY,
      matrix: null,
      routing: null,
      quotaExhausted: {},
      lanes: { main: BASE },
      poolConfig: loadPoolConfig(),
    }
    const deny = checkShell("glm-mx-glm-53-flash-high", REGISTRY["glm-mx-glm-53-flash-high"], 'ROUTE_META {"lane":"main","role":"programmer","producer_family":"glm","capability":"rw","modality":"text","source":"auto"}', snap)
    expect(deny.deny).toContain("main 任务池选配清单")
    expect(deny.deny).toContain("glm-mx-glm-53-high") // hint 指向已入选模型
    const allow = checkShell("glm-mx-glm-53-high", REGISTRY["glm-mx-glm-53-high"], 'ROUTE_META {"lane":"main","role":"programmer","producer_family":"glm","capability":"rw","modality":"text","source":"auto"}', snap)
    expect(allow.deny).toBeNull()
  })

  test("配置文件路径落位状态目录", () => {
    expect(paths().poolConfig.endsWith("pool-config.json")).toBe(true)
    expect(paths().capabilityRank.endsWith("capability-rank.json")).toBe(true)
  })
})
