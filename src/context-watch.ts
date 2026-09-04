// [2026-09-04]-[dispatch-bias fix: measured session context watermark + tiered gate on read-class tools — turns the rules' self-reported watermark into mechanism enforcement]
// [2026-09-04]-[English localization: translate runtime messages and comments; no logic change]
// Pure-function layer: token estimation, watermark tiering, read-gate decisions; state (Maps) is held by index.ts, no IO here.
import type { ContextOptions } from "./types"

/** Read-class tools (intercepted/reminded past the line; write/edit/web classes never blocked — delivery must not stall) */
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

/** message.updated → info.tokens (v2) or info.metadata.assistant.tokens (v1) dual-path defensive read;
 *  scope = input+cache.read+reasoning+output ≈ the context carried by the next request */
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

/** Verification/delivery commands pass through (tiny output, no context injection): the whole git family
 *  (including add/commit/push wrap-up), test/lint/typecheck, build/pack — wrap-up verification and delivery still work at hard watermark */
export function isVerificationBash(command: string): boolean {
  const c = command.trim()
  return /^git\s+[a-z]/.test(c)
    || /\b(bun\s+(test|run\s+(test|lint|typecheck|build)|build|install)|npm\s+(test|run\s+(test|lint|typecheck|build)|install|publish)|yarn\s+(test|lint|build)|pnpm\s+(test|run\s+(test|lint|typecheck|build)|build))\b/.test(c)
    || /\b(tsc|eslint|biome|prettier|ruff|vitest|jest|pytest|cargo\s+(test|build)|go\s+(test|build))\b/.test(c)
}

export interface ReadGateInput {
  tool: string
  level: WatermarkLevel
  /** whether this tool was already nudged in this session (soft watermark one-time nudge; hard/force never read this) */
  alreadyNudged?: boolean
  /** bash command text (only used when tool=bash) */
  bashCommand?: string
}

export type ReadGateAction = "allow" | "nudge" | "deny"

/** Read-gate decision: soft = one-time nudge per tool (deny with a redirect suggestion, allowed afterwards); hard/force = read-class
 *  always deny, bash lets only verification commands through; non-read tools always allow. nudge/deny copy is assembled by index.ts (with the economy candidate attached). */
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
