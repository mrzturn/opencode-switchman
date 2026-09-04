// [2026-09-04]-[派发偏向修复 fixture：会话水位闸（context-watch）＋内置 subagent 封堵（gates）
//  ＋新行为段校验（context/builtinAgents/injection/rules.delegationFloor）]
import { describe, expect, test } from "bun:test"
import {
  READ_CLASS_TOOLS, estimateContextTokens, thresholdsOf, watermarkLevel,
  isVerificationBash, readGateDecision,
} from "../src/context-watch"
import { builtinAgentDeny } from "../src/gates"
import { validateUserConfig } from "../src/config"

describe("context-watch：token 估算与水位分级", () => {
  test("estimateContextTokens：v2 顶层 tokens 与 v1 metadata.assistant.tokens 双路径", () => {
    expect(estimateContextTokens({ tokens: { input: 50_000, output: 5_000, reasoning: 1_000, cache: { read: 10_000 } } })).toBe(66_000)
    expect(estimateContextTokens({ metadata: { assistant: { tokens: { input: 10, output: 5, cache: { read: 5 } } } } })).toBe(20)
    expect(estimateContextTokens({ tokens: null })).toBeNull()
    expect(estimateContextTokens({})).toBeNull()
    expect(estimateContextTokens({ tokens: { input: 0, output: 0 } })).toBeNull() // 全零视为无数据
  })
  test("watermarkLevel：soft/hard/force 边界（闭区间下限）", () => {
    const t = { soft: 60_000, hard: 80_000, force: 100_000 }
    expect(watermarkLevel(59_999, t)).toBe("ok")
    expect(watermarkLevel(60_000, t)).toBe("soft")
    expect(watermarkLevel(80_000, t)).toBe("hard")
    expect(watermarkLevel(100_000, t)).toBe("force")
  })
  test("thresholdsOf：缺省 60k/80k/100k", () => {
    expect(thresholdsOf(undefined)).toEqual({ soft: 60_000, hard: 80_000, force: 100_000 })
  })
})

describe("context-watch：读取闸决策", () => {
  test("ok 水位全放行", () => {
    for (const tool of ["read", "glob", "grep", "bash", "edit", "write"]) {
      expect(readGateDecision({ tool, level: "ok", alreadyNudged: false })).toBe("allow")
    }
  })
  test("soft：读取类一次性 nudge（已提醒过放行）；edit/write/webfetch 不属于读取类恒放行", () => {
    expect(readGateDecision({ tool: "read", level: "soft", alreadyNudged: false })).toBe("nudge")
    expect(readGateDecision({ tool: "read", level: "soft", alreadyNudged: true })).toBe("allow")
    expect(readGateDecision({ tool: "bash", level: "soft", alreadyNudged: false, bashCommand: "cat foo" })).toBe("nudge")
    expect(readGateDecision({ tool: "edit", level: "soft", alreadyNudged: false })).toBe("allow")
    expect(readGateDecision({ tool: "webfetch", level: "soft", alreadyNudged: false })).toBe("allow")
  })
  test("hard：read 类一律 deny；bash 验证类放行、非验证类 deny", () => {
    expect(readGateDecision({ tool: "read", level: "hard", alreadyNudged: true })).toBe("deny")
    expect(readGateDecision({ tool: "glob", level: "hard", alreadyNudged: false })).toBe("deny")
    expect(readGateDecision({ tool: "bash", level: "hard", bashCommand: "git status" })).toBe("allow")
    expect(readGateDecision({ tool: "bash", level: "hard", bashCommand: "bun test test/foo.test.ts" })).toBe("allow")
    expect(readGateDecision({ tool: "bash", level: "hard", bashCommand: "npm run typecheck" })).toBe("allow")
    expect(readGateDecision({ tool: "bash", level: "hard", bashCommand: "cat src/index.ts" })).toBe("deny")
    expect(readGateDecision({ tool: "bash", level: "hard" })).toBe("deny") // 无命令文本 fail-closed
  })
  test("force 与 hard 同口径（读取拦截由横幅另注入强制压缩指令）", () => {
    expect(readGateDecision({ tool: "read", level: "force", alreadyNudged: true })).toBe("deny")
    expect(readGateDecision({ tool: "bash", level: "force", bashCommand: "bun test" })).toBe("allow")
  })
  test("READ_CLASS_TOOLS 覆盖 read/glob/grep/list", () => {
    for (const t of ["read", "glob", "grep", "list"]) expect(READ_CLASS_TOOLS.has(t)).toBe(true)
    expect(READ_CLASS_TOOLS.has("bash")).toBe(false)
  })
  test("isVerificationBash：git 全系/测试/lint/构建白名单（收尾交付不拦）", () => {
    expect(isVerificationBash("git diff HEAD~1")).toBe(true)
    expect(isVerificationBash("git add -A && git commit -m x && git push")).toBe(true)
    expect(isVerificationBash("bun run build")).toBe(true)
    expect(isVerificationBash("npm publish")).toBe(true)
    expect(isVerificationBash("rg -n foo src/")).toBe(false)
    expect(isVerificationBash("pytest -x")).toBe(true)
    expect(isVerificationBash("echo hello && cat secret")).toBe(false)
    expect(isVerificationBash("curl -s https://x | head -100")).toBe(false)
  })
})

describe("gates：内置 subagent 封堵", () => {
  const heads = (lane: string) => (lane === "economy" ? "glm-mx-53f-low" : lane === "main" ? "glm-mx-53f-high" : null)
  test("explore/general 默认 deny 附对应 lane 改派建议", () => {
    const d1 = builtinAgentDeny("explore", "deny", heads)
    expect(d1).toContain("explore")
    expect(d1).toContain("glm-mx-53f-low")
    const d2 = builtinAgentDeny("general", "deny", heads)
    expect(d2).toContain("glm-mx-53f-high")
  })
  test("allow 模式恢复放行；非内置名不拦截", () => {
    expect(builtinAgentDeny("explore", "allow", heads)).toBeNull()
    expect(builtinAgentDeny("my-custom-agent", "deny", heads)).toBeNull()
  })
  test("链空时附横幅指引", () => {
    const d = builtinAgentDeny("explore", "deny", () => null)
    expect(d).toContain("[路由]")
  })
})

describe("config：新行为段校验", () => {
  const base = { version: 1, providers: {}, extensions: {} }
  test("缺省：context 60/80/100k、gates on、builtinAgents deny、injection chain、floor 3000", () => {
    const { config, diagnostics } = validateUserConfig(base)
    expect(diagnostics.filter((d) => d.level === "error")).toEqual([])
    expect(config.context).toEqual({ gates: true, softTokens: 60_000, hardTokens: 80_000, forceTokens: 100_000 })
    expect(config.builtinAgents.mode).toBe("deny")
    expect(config.injection.mode).toBe("chain")
    expect(config.rules.delegationFloor).toBe(3_000)
  })
  test("自定义合法值透传", () => {
    const { config } = validateUserConfig({ ...base, context: { softTokens: 30_000, hardTokens: 70_000, forceTokens: 90_000 }, injection: { mode: "all" }, rules: { delegationFloor: 1_500 } })
    expect(config.context.softTokens).toBe(30_000)
    expect(config.injection.mode).toBe("all")
    expect(config.rules.delegationFloor).toBe(1_500)
  })
  test("水位违序/非正整数整段回退缺省并报 SWM037", () => {
    const r1 = validateUserConfig({ ...base, context: { softTokens: 80_000, hardTokens: 80_000, forceTokens: 100_000 } })
    expect(r1.config.context.softTokens).toBe(60_000)
    expect(r1.diagnostics.some((d) => d.code === "SWM037")).toBe(true)
    const r2 = validateUserConfig({ ...base, context: { softTokens: -1, hardTokens: 80_000, forceTokens: 100_000 } })
    expect(r2.config.context.softTokens).toBe(60_000)
  })
  test("枚举坏值回退缺省", () => {
    const r = validateUserConfig({ ...base, builtinAgents: { mode: "maybe" }, injection: { mode: 42 }, rules: { delegationFloor: "low" } })
    expect(r.config.builtinAgents.mode).toBe("deny")
    expect(r.config.injection.mode).toBe("chain")
    expect(r.config.rules.delegationFloor).toBe(3_000)
    expect(r.diagnostics.some((d) => d.code === "SWM037")).toBe(true)
  })
})
