// [2026-09-04]-[dispatch-bias fix: measured session context watermark + tiered gate on read-class tools — turns the rules' self-reported watermark into mechanism enforcement]
// [2026-09-05]-[v1 read budget: the soft-tier one-time-per-tool nudge is retired — its "allowed afterwards" coupon invited
//  deliberate probe-retry loops. Reads are now judged from turn 1 by estimated injection size (context is sunk cost;
//  only the marginal injection compounds), watermarks keep lifecycle duties only (soft=advice, hard=wrap-up deny,
//  force=auto-handover). v2 (dynamic R*) is parked in docs/Pending-Confirmation-and-Implementation/.]
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

// [2026-09-05]-[v1 read budget: replaces ReadGateInput/readGateDecision — per-call decision on estimated injection
//  size, no consumable per-tool state (the old one-time nudge was a coupon models rationally burned via retry/probing)]
/** Per-call read-injection budget (R*): reads whose estimated token injection exceeds this are auto-bounded ("cap")
 *  or denied with exact bounded-retry params. Default 1500 ≈ P(500) + summary(400) + S(6000)/T(10) — the break-even
 *  where self-reading stops being cheaper than delegating to an economy shell. */
export const DEFAULT_READ_BUDGET_TOKENS = 1500
export const MIN_READ_BUDGET_TOKENS = 200
export const MAX_READ_BUDGET_TOKENS = 20_000
/** Used when a file sample yields no usable line structure (empty/one-line files) */
const FALLBACK_TOKENS_PER_LINE = 7.5

export function readBudgetOf(context: { readBudgetTokens?: number } | undefined): number {
  const raw = context?.readBudgetTokens
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_READ_BUDGET_TOKENS
  return Math.min(MAX_READ_BUDGET_TOKENS, Math.max(MIN_READ_BUDGET_TOKENS, Math.round(raw)))
}

/** Per-turn self-read allowance: 2× the per-call budget — one bounded read plus slack; resets on each user turn */
export function turnBudgetOf(readBudget: number): number {
  return readBudget * 2
}

/** Post-hoc charging for tool outputs we could not pre-estimate (bash, glob/grep/list): ~3.5 bytes/token */
export function estimateOutputTokens(outputLength: number): number {
  return Math.ceil(outputLength / 3.5)
}

/** Head sample of a file (first 64KB) used to derive per-line token density; produced by index.ts (IO lives there) */
export interface FileSample {
  path: string
  bytes: number
  sampleBytes: number
  newlines: number
}

export interface ReadEstimate {
  /** estimated tokens the requested range would inject */
  totalTokens: number
  tokensPerLine: number
  /** bounded-retry line count that fits the budget (clamped 50..500) */
  suggestedLimit: number
  hasLimit: boolean
  requestedLimit?: number
  offset?: number
}

/** Estimate the injection cost of a read call from a 64KB head sample: bytes/line → tokens/line (clamped 3..20 to
 *  absorb minified/verbose outliers), then tokens/line × effective lines (honoring limit/offset). Pure. */
export function estimateReadRange(
  sample: FileSample,
  args: { limit?: unknown; offset?: unknown } | undefined,
  readBudget: number,
): ReadEstimate {
  const sampleLines = sample.newlines + 1
  const coversFile = sample.sampleBytes >= sample.bytes
  const bytesPerLine = sample.sampleBytes > 0 ? sample.sampleBytes / sampleLines : 0
  const tokensPerLine = bytesPerLine > 0 ? Math.min(20, Math.max(3, bytesPerLine / 3.5)) : FALLBACK_TOKENS_PER_LINE
  const totalLines = coversFile ? sampleLines : Math.max(1, Math.ceil(sample.bytes / (bytesPerLine || 1)))
  const limit = typeof args?.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : undefined
  const offset = typeof args?.offset === "number" && args.offset > 0 ? Math.floor(args.offset) : 1
  const effectiveLines =
    limit !== undefined ? Math.max(1, Math.min(limit, Math.max(1, totalLines - offset + 1))) : totalLines
  return {
    totalTokens: Math.ceil(tokensPerLine * effectiveLines),
    tokensPerLine,
    suggestedLimit: Math.min(500, Math.max(50, Math.floor(readBudget / tokensPerLine))),
    hasLimit: limit !== undefined,
    requestedLimit: limit,
    offset,
  }
}

export interface BudgetGateInput {
  tool: string
  level: WatermarkLevel
  readBudget: number
  turnUsed: number
  bashCommand?: string
  /** read-range estimate (read tool only; glob/grep/list and unsampleable paths pass null → fail-open) */
  est?: ReadEstimate | null
}

export type BudgetGateAction =
  | "allow"
  | "cap"
  | "deny-budget"
  | "deny-turn"
  | "deny-archaeology"
  | "deny-hard"

/** Read-budget gate decision (pure and deterministic — identical inputs always yield the identical action; probing
 *  cannot change a verdict, which is what killed the old coupon-nudge design):
 *  - verification bash (delivery git + test/lint/build) passes at EVERY tier (delivery must not stall)
 *  - archaeology git (unbounded history dumps) is denied at ALL tiers with a scoping hint — a context bomb is a
 *    context bomb at 10k or 90k
 *  - other bash passes at ok/soft (charged post-hoc in tool.execute.after) and is denied at hard/force (wrap-up mode)
 *  - read-class is denied at hard/force (wrap-up mode); once the per-turn cap (2×R*) is spent, denied until the next
 *    user turn
 *  - read with an estimate over R*: auto-bounded ("cap") when no explicit limit was set; denied with exact
 *    bounded-retry params ("deny-budget") when the caller's own limit still overshoots
 *  - everything else (un-estimable read-class included) is fail-open "allow" — post-hoc charging still applies */
export function budgetGateDecision(input: BudgetGateInput): BudgetGateAction {
  const { tool, level, readBudget, turnUsed, bashCommand, est } = input
  if (tool === "bash") {
    if (bashCommand !== undefined && isVerificationBash(bashCommand)) return "allow"
    if (bashCommand !== undefined && isArchaeologyBash(bashCommand)) return "deny-archaeology"
    return level === "hard" || level === "force" ? "deny-hard" : "allow"
  }
  if (!READ_CLASS_TOOLS.has(tool)) return "allow"
  if (level === "hard" || level === "force") return "deny-hard"
  if (turnUsed >= turnBudgetOf(readBudget)) return "deny-turn"
  if (tool !== "read" || !est) return "allow"
  if (est.totalTokens <= readBudget) return "allow"
  return est.hasLimit ? "deny-budget" : "cap"
}
