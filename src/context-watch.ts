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

/** Verification/delivery commands pass through (tiny output, no context injection): delivery git (state-changing +
 *  bounded-output reads, including add/commit/push wrap-up), test/lint/typecheck, build/pack — wrap-up verification
 *  and delivery still work at every watermark. Archaeology git is excluded here and handled as scanning below. */
export function isVerificationBash(command: string): boolean {
  const c = command.trim()
  const g = gitClass(c)
  if (g !== "none") return g === "delivery"
  return /\b(bun\s+(test|run\s+(test|lint|typecheck|build)|build|install)|npm\s+(test|run\s+(test|lint|typecheck|build)|install|publish)|yarn\s+(test|lint|build)|pnpm\s+(test|run\s+(test|lint|typecheck|build)|build))\b/.test(c)
    || /\b(tsc|eslint|biome|prettier|ruff|vitest|jest|pytest|cargo\s+(test|build)|go\s+(test|build))\b/.test(c)
}

// [2026-09-05]-[git UX split: delivery git (state-changing + bounded output) is exempt from the read gate at ALL tiers —
//  the soft-tier one-time nudge used to land on the first git call of the wrap-up (git ops cluster exactly when context
//  is fullest); unbounded archaeology git (log -p / range diff / blame without -L) is reclassified as scanning — nudged
//  at soft, denied at hard with a scoping hint instead of the generic bash deny]
export type GitClass = "delivery" | "archaeology" | "none"

/** Git subcommands whose unbounded forms can dump history-sized output */
const GIT_ARCHAEOLOGY_SUBS: ReadonlySet<string> = new Set(["log", "shortlog", "diff", "blame", "annotate"])

/** Classify the first `git <sub>` occurrence: delivery (passes the gate at any watermark) / archaeology (scan-class,
 *  must be scoped or delegated) / none (not a git command; global git flags like `-C`/`--no-pager` are not stripped —
 *  rare in agent usage, they fall back to generic bash handling) */
export function gitClass(command: string): GitClass {
  const c = command.trim()
  const m = c.match(/(?:^|[\s;&|])git\s+([a-z]+)/)
  if (!m) return "none"
  const sub = m[1]
  if (!GIT_ARCHAEOLOGY_SUBS.has(sub)) return "delivery"
  const rest = c.slice((m.index ?? 0) + m[0].length)
  const hasMaxCount = /(^|\s)-\d+(\s|$)/.test(rest) || /(^|\s)-n\s*\d+/.test(rest) || /--max-count(=|\s+)\d+/.test(rest)
  const hasSummary = /(^|\s)(--oneline|--stat|--shortstat|--name-only|--name-status)(\s|$|=)/.test(rest) || /(^|\s)(-s|--no-patch)(\s|$)/.test(rest)
  const hasPatch = /(^|\s)(-p|-u|--patch)(\s|$)/.test(rest)
  const hasLineRange = /(^|\s)-L\s*\d/.test(rest)
  if (/\|\s*(head|tail|wc)\b/.test(c)) return "delivery"
  switch (sub) {
    case "log":
    case "shortlog": {
      // full patches always need -n; a bare log passes only in compact form (--oneline/--stat) or bounded by -n
      const unbounded = hasPatch ? !hasMaxCount : !(hasMaxCount || hasSummary)
      return unbounded ? "archaeology" : "delivery"
    }
    case "diff": {
      // range diffs (a..b) dump history-sized patches; working-tree/staged/single-ref diffs are wrap-up reads
      return !hasSummary && /\S\.\.\.?\S/.test(rest) ? "archaeology" : "delivery"
    }
    default: {
      // blame/annotate: whole-file blame is one line per source line; only -L bounds it
      return !hasLineRange ? "archaeology" : "delivery"
    }
  }
}

/** Archaeology git = unbounded history dumps (log -p without -n, range diff without --stat, blame without -L):
 *  scan-class, nudged at soft / denied at hard with a scoping hint (used by index.ts for gate copy) */
export function isArchaeologyBash(command: string): boolean {
  return gitClass(command.trim()) === "archaeology"
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

/** Read-gate decision: verification bash (delivery git + test/lint/build) passes at EVERY tier (delivery must not
 *  stall); soft = one-time nudge per tool for the rest (deny with a redirect suggestion, allowed afterwards);
 *  hard/force = read-class and non-verification bash always deny. nudge/deny copy is assembled by index.ts (with
 *  the economy candidate + archaeology scoping hint attached). */
export function readGateDecision(input: ReadGateInput): ReadGateAction {
  const { tool, level, bashCommand } = input
  if (level === "ok") return "allow"
  const isBash = tool === "bash"
  const isReadClass = READ_CLASS_TOOLS.has(tool)
  if (!isBash && !isReadClass) return "allow"
  if (isBash && bashCommand !== undefined && isVerificationBash(bashCommand)) return "allow"
  if (level === "soft") return input.alreadyNudged ? "allow" : "nudge"
  // hard / force
  return "deny"
}
