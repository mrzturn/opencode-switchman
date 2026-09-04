// [2026-09-04]-[派发偏向修复：会话上下文水位实测＋读取类工具分级闸——把规程自报水位变成机制执行]
// 纯函数层：token 估算、水位分级、读取闸决策；状态（Map）由 index.ts 持有，此处无 IO。
import type { ContextOptions } from "./types"

/** 读取类工具（超线后拦截/提醒；write/edit/web 类不拦——不阻塞交付） */
export const READ_CLASS_TOOLS: ReadonlySet<string> = new Set(["read", "glob", "grep", "list"])

export type WatermarkLevel = "ok" | "soft" | "hard" | "force"

export interface ContextThresholds { soft: number; hard: number; force: number }

export function thresholdsOf(options: ContextOptions | undefined): ContextThresholds {
  return {
    soft: options?.softTokens ?? 60_000,
    hard: options?.hardTokens ?? 80_000,
    force: options?.forceTokens ?? 100_000,
  }
}

/** message.updated → info.tokens（v2）或 info.metadata.assistant.tokens（v1）双路径防御读取；
 *  口径=input+cache.read+reasoning+output ≈ 下一轮请求携带的上下文 */
export function estimateContextTokens(info: unknown): number | null {
  const anyInfo = info as { tokens?: TokensShape; metadata?: { assistant?: { tokens?: TokensShape } } } | null
  const t = anyInfo?.tokens ?? anyInfo?.metadata?.assistant?.tokens
  if (!t || typeof t !== "object") return null
  const total = (t.input ?? 0) + (t.output ?? 0) + (t.reasoning ?? 0) + (t.cache?.read ?? 0)
  return total > 0 ? total : null
}

interface TokensShape { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }

export function watermarkLevel(tokens: number, t: ContextThresholds): WatermarkLevel {
  if (tokens >= t.force) return "force"
  if (tokens >= t.hard) return "hard"
  if (tokens >= t.soft) return "soft"
  return "ok"
}

/** 验证/交付类命令放行（输出极小、不注入上下文）：git 全系（含 add/commit/push 收尾交付）、
 *  测试/lint/类型检查、构建打包——硬水位下仍可收尾验证与交付 */
export function isVerificationBash(command: string): boolean {
  const c = command.trim()
  return /^git\s+[a-z]/.test(c)
    || /\b(bun\s+(test|run\s+(test|lint|typecheck|build)|build|install)|npm\s+(test|run\s+(test|lint|typecheck|build)|install|publish)|yarn\s+(test|lint|build)|pnpm\s+(test|run\s+(test|lint|typecheck|build)|build))\b/.test(c)
    || /\b(tsc|eslint|biome|prettier|ruff|vitest|jest|pytest|cargo\s+(test|build)|go\s+(test|build))\b/.test(c)
}

export interface ReadGateInput {
  tool: string
  level: WatermarkLevel
  /** 该会话该工具此前是否已提醒过（软水位一次性提醒机制；hard/force 不读此字段） */
  alreadyNudged?: boolean
  /** bash 命令文本（仅 tool=bash 时使用） */
  bashCommand?: string
}

export type ReadGateAction = "allow" | "nudge" | "deny"

/** 读取闸决策：soft=每工具一次性 nudge（deny 附改派建议，之后放行）；hard/force=read 类一律
 *  deny、bash 仅验证类放行；非读取类工具恒 allow。nudge/deny 的文案由 index.ts 组装（附 economy 候选）。 */
export function readGateDecision(input: ReadGateInput): ReadGateAction {
  const { tool, level, bashCommand } = input
  if (level === "ok") return "allow"
  const isBash = tool === "bash"
  const isReadClass = READ_CLASS_TOOLS.has(tool)
  if (!isBash && !isReadClass) return "allow"
  if (level === "soft") return input.alreadyNudged ? "allow" : "nudge"
  // hard / force
  if (isBash) return bashCommand !== undefined && isVerificationBash(bashCommand) ? "allow" : "deny"
  return "deny"
}
