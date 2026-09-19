// [2026-09-06]-[subagent hard cap behavioral contract: a shell subagent crossing the context cap is force-terminated —
//  every further tool call in that session is denied with a wrap-up order, the session can never be resumed via task_id
//  (persistent registry, survives plugin re-instantiation), internal sessions and sub-cap sessions are untouched, and
//  fresh dispatches without task_id are unaffected]
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const configDir = mkdtempSync(join(tmpdir(), "switchman-subcap-config-"))
const stateDir = mkdtempSync(join(tmpdir(), "switchman-subcap-state-"))
process.env.OPENCODE_CONFIG_DIR = configDir
process.env.SWITCHMAN_STATE = stateDir
// [2026-09-06]-[model catalog stub: message.updated model-key recording consults the runtime index for the window cap]
writeFileSync(join(stateDir, "model-catalog.json"), JSON.stringify({ fetched_at: Date.now(), etag: null, index: {} }))
// [2026-09-07]-[lang hard gate fixture: sandbox project counts as lang-configured]
const projectDir = mkdtempSync(join(tmpdir(), "switchman-lang-fix-"))
mkdirSync(join(projectDir, ".switchman"), { recursive: true })
writeFileSync(join(projectDir, ".switchman", "settings.json"), JSON.stringify({ v: 1, configuredAt: "x", lang: { conversation: "en", comments: "en", docs: "en" } }))

import { SwitchmanPlugin } from "../src/index"
import {
  MAX_SUBAGENT_CAP_TOKENS, MIN_SUBAGENT_CAP_TOKENS,
  subagentCapOf, capByWindow, subagentCapDenyMessage, subagentResumeDenyMessage,
  subagentSoftTiersOf, shellSoftTier, shellSoftTierMessage, shellSoftTierDecision,
} from "../src/context-watch"
import { renderNotice } from "../src/i18n"

type Hooks = Awaited<ReturnType<typeof SwitchmanPlugin>>

function readStatusLog(): string {
  const p = join(stateDir, "status-log.json")
  if (!existsSync(p)) return ""
  // [2026-09-19]-[i18n cleanup: entries are structured {key, params} — render English for the prose assertions]
  try {
    const data = JSON.parse(readFileSync(p, "utf8"))
    if (Array.isArray(data)) return data.map((e: { key?: string; params?: Record<string, string | number>; text?: string }) => renderNotice(e, "en")).join("\n")
  } catch { /* fail-open: fall through to raw text */ }
  return readFileSync(p, "utf8")
}

function assistantTokens(input: number): { role: "assistant"; tokens: { input: number; output: number; reasoning: number; cache: { read: number } } } {
  // estimateContextTokens = input + output + reasoning + cache.read → +4_000 per event
  return { role: "assistant", tokens: { input, output: 1_000, reasoning: 1_000, cache: { read: 2_000 } } }
}

async function bootPlugin(): Promise<Hooks> {
  const fakeClient = {
    provider: { list: async () => [] },
    session: {
      async get(opts: any) { return { data: { id: opts?.path?.id } } },
    },
  }
  // [2026-09-06]-[legacy mode forced (same pattern as todo-nudge/pane-resume tests): the classification under test is
  //  sessionAgent-based; dynamic mode would need a probed superset for isShellSession]
  return SwitchmanPlugin({ client: fakeClient, directory: projectDir } as any, { matrix: { mode: "legacy" } } as any)
}

async function mark(hooks: Hooks, sessionId: string, input: number): Promise<void> {
  await hooks.event!({ event: { type: "message.updated", properties: { sessionID: sessionId, info: assistantTokens(input) } } } as any)
}

/** Register a shell child session (legacy mode classification: agent name matching /-mx-/) */
async function seedShellSession(hooks: Hooks, sessionId: string, agent = "glm-mx-53f-low"): Promise<void> {
  await hooks.event!({ event: { type: "session.created", properties: { info: { id: sessionId, agent } } } } as any)
}

describe("subagent cap: pure decision layer", () => {
  // [2026-09-15]-[subagentForceTokens optional: absent follows forceTokens (shared hard line); present values keep the clamp]
  test("subagentCapOf: absent → follows forceTokens (130k default), clamped override, disabled → null", () => {
    expect(subagentCapOf(undefined)).toBe(130_000)
    expect(subagentCapOf({})).toBe(130_000)
    expect(subagentCapOf({ forceTokens: 90_000 })).toBe(90_000)
    expect(subagentCapOf({ subagentForceTokens: 250_000 })).toBe(250_000)
    expect(subagentCapOf({ subagentForceTokens: 1 })).toBe(MIN_SUBAGENT_CAP_TOKENS)
    expect(subagentCapOf({ subagentForceTokens: 99_999_999 })).toBe(MAX_SUBAGENT_CAP_TOKENS)
    expect(subagentCapOf({ subagentCap: false })).toBeNull()
    expect(subagentCapOf({ subagentCap: false, subagentForceTokens: 50_000 })).toBeNull()
  })
  test("capByWindow: never past 90% of the model window; unknown window keeps the base cap", () => {
    expect(capByWindow(100_000, 200_000)).toBe(100_000)
    expect(capByWindow(100_000, 100_000)).toBe(90_000)
    expect(capByWindow(100_000, undefined)).toBe(100_000)
    expect(capByWindow(100_000, -5)).toBe(100_000)
  })
  test("deny messages carry the wrap-up order / permanent-termination guidance", () => {
    const cap = subagentCapDenyMessage(101_000, 100_000)
    expect(cap).toContain("SUBAGENT CONTEXT CAP REACHED")
    expect(cap).toContain("101k/100k")
    expect(cap).toContain("work-progress summary")
    const resume = subagentResumeDenyMessage("ses_child1")
    expect(resume).toContain("ses_child1")
    expect(resume).toContain("can never be resumed")
    expect(resume).toContain("without task_id")
  })
})

// [2026-09-14]-[subagent soft tiers (D1): two graceful advisories precede the hard termination backstop; delivered at
//  most once per tier via system.transform's shell branch, ending with the inline HANDOFF marker the dispatcher relays
//  per agents-md §2 item 5]
// [2026-09-15]-[tiers switch from fraction coefficients to the MAIN session's ABSOLUTE soft/hard thresholds expressed
//  against the force anchor (subagentForceTokens when valid, else forceTokens); the window-clamped effective cap still
//  pulls them down proportionally — a tier never exceeds the real termination line]
describe("subagent soft tiers: pure decision layer", () => {
  test("tier derivation: shared absolute thresholds against the force anchor, fail-open defaults", () => {
    // default config (no overrides): main-session 50k soft / 90k hard against the 130k force anchor
    expect(subagentSoftTiersOf(undefined)).toEqual([50_000 / 130_000, 90_000 / 130_000])
    expect(subagentSoftTiersOf({})).toEqual([50_000 / 130_000, 90_000 / 130_000])
    // subagentForceTokens override: the absolute 50k/90k lines preserved against the 100k anchor
    expect(subagentSoftTiersOf({ subagentForceTokens: 100_000 })).toEqual([0.5, 0.9])
    // custom main-session thresholds ride along
    expect(subagentSoftTiersOf({ softTokens: 30_000, hardTokens: 60_000, forceTokens: 120_000 })).toEqual([0.25, 0.5])
    // invalid anchor → forceTokens
    expect(subagentSoftTiersOf({ subagentForceTokens: Number.NaN, forceTokens: 200_000 })).toEqual([0.25, 0.45])
    // misconfigured thresholds (soft ≥ force, or f-ordering violated) → fail-open pure-defaults derivation
    expect(subagentSoftTiersOf({ softTokens: 130_000, hardTokens: 140_000, forceTokens: 120_000 })).toEqual([50_000 / 130_000, 90_000 / 130_000])
    expect(subagentSoftTiersOf({ softTokens: 90_000, hardTokens: 80_000, forceTokens: 120_000 })).toEqual([50_000 / 130_000, 90_000 / 130_000])
    expect(subagentSoftTiersOf({ softTokens: 120_000, hardTokens: 125_000, forceTokens: 120_000 })).toEqual([50_000 / 130_000, 90_000 / 130_000])
  })
  test("tier firing at the shared absolute lines: ≈50k conserve / ≈90k hand-off against a 130k effective cap", () => {
    const tiers = subagentSoftTiersOf(undefined)
    const cap = 130_000
    expect(shellSoftTier(49_999, cap, tiers)).toBe(0)
    expect(shellSoftTier(50_000, cap, tiers)).toBe(1)
    expect(shellSoftTier(89_999, cap, tiers)).toBe(1)
    expect(shellSoftTier(90_000, cap, tiers)).toBe(2)
  })
  test("subagentForceTokens override keeps the absolute 50k/90k lines against a 100k cap", () => {
    const tiers = subagentSoftTiersOf({ subagentForceTokens: 100_000 })
    const cap = subagentCapOf({ subagentForceTokens: 100_000 })!
    expect(tiers).toEqual([0.5, 0.9])
    expect(shellSoftTier(49_999, cap, tiers)).toBe(0)
    expect(shellSoftTier(50_000, cap, tiers)).toBe(1)
    expect(shellSoftTier(89_999, cap, tiers)).toBe(1)
    expect(shellSoftTier(90_000, cap, tiers)).toBe(2)
  })
  test("small window-clamped cap pulls the tiers down proportionally (a tier never exceeds the termination line)", () => {
    const tiers = subagentSoftTiersOf(undefined)
    // 90% of a ~26.7k window → 24k effective cap
    const clamped = capByWindow(120_000, 26_667)
    expect(clamped).toBe(24_000)
    // ≈9.2k conserve / ≈16.6k hand-off (default 50k/90k tiers against the 130k anchor, pulled down with the cap)
    expect(shellSoftTier(9_229, clamped, tiers)).toBe(0)
    expect(shellSoftTier(9_230, clamped, tiers)).toBe(1)
    expect(shellSoftTier(16_614, clamped, tiers)).toBe(1)
    expect(shellSoftTier(16_615, clamped, tiers)).toBe(2)
    expect(shellSoftTier(24_000, clamped, tiers)).toBe(2)
    for (const f of tiers) expect(Math.floor(f * clamped)).toBeLessThanOrEqual(clamped)
  })
  test("tier copy verbatim pins (absolute k rendered from the effective cap, HANDOFF inline-only)", () => {
    expect(shellSoftTierMessage(1, 62_400, 100_000)).toBe(
      "[SHELL-CONTEXT] measured shell context ≈ 62k/100k (conserve): stop batch reads and long pastes — switch to targeted grep and cite only the needed excerpts; finish the current work unit before starting anything new; keep outputs compact.",
    )
    expect(shellSoftTierMessage(2, 80_000, 100_000)).toBe(
      "[SHELL-CONTEXT] measured shell context ≈ 80k/100k (hand-off): open no new files or edits; finish the current unit, then end your FINAL message with a compact handover block (completed; key findings with file:line; remaining; next steps) followed by the marker line `HANDOFF: inline · progress: n/m · next: <one sentence>` (m = the delegation's work units, n = completed). Your final message is returned to the delegating session as the task result.",
    )
  })
  test("once-per-tier dedup, subagentCap:false and terminated sessions stay silent (pure semantics)", () => {
    const tiers = subagentSoftTiersOf(undefined)
    // below tier 1: quiet, delivered state unchanged
    expect(shellSoftTierDecision({ terminated: false, tokens: 30_000, cap: 100_000, tiers, delivered: 0 })).toEqual({ line: null, delivered: 0 })
    // tier 1 fires once; a second request at the same tier is suppressed
    const t1 = shellSoftTierDecision({ terminated: false, tokens: 50_000, cap: 100_000, tiers, delivered: 0 })
    expect(t1.delivered).toBe(1)
    expect(t1.line).toContain("[SHELL-CONTEXT]")
    expect(t1.line).toContain("(conserve)")
    expect(shellSoftTierDecision({ terminated: false, tokens: 50_000, cap: 100_000, tiers, delivered: 1 }).line).toBeNull()
    // the higher tier fires exactly one more line (never re-delivers tier 1's copy)
    const t2 = shellSoftTierDecision({ terminated: false, tokens: 90_000, cap: 100_000, tiers, delivered: 1 })
    expect(t2.delivered).toBe(2)
    expect(t2.line).toContain("(hand-off)")
    expect(t2.line).toContain("HANDOFF: inline")
    expect(shellSoftTierDecision({ terminated: false, tokens: 90_000, cap: 100_000, tiers, delivered: 2 }).line).toBeNull()
    // subagentCap: false → advisories off (they exist to make the cap graceful)
    expect(shellSoftTierDecision({ terminated: false, tokens: 90_000, cap: null, tiers, delivered: 0 })).toEqual({ line: null, delivered: 0 })
    // no measurement yet → quiet
    expect(shellSoftTierDecision({ terminated: false, tokens: undefined, cap: 100_000, tiers, delivered: 0 })).toEqual({ line: null, delivered: 0 })
    // terminated session → no advisory (the hard cap's deny message governs from here)
    expect(shellSoftTierDecision({ terminated: true, tokens: 90_000, cap: 100_000, tiers, delivered: 0 })).toEqual({ line: null, delivered: 0 })
  })
})

describe("subagent cap: plugin wiring", () => {
  // [2026-09-15]-[default cap now follows forceTokens (130k): crossing values shifted to the shared 130k line]
  test("shell session crossing the shared 130k line → tools denied, task_id resume denied, registry persisted", async () => {
    const hooks = await bootPlugin()
    await seedShellSession(hooks, "ses_shell_cap")
    // sub-cap watermark (94k measured): tools still allowed
    await mark(hooks, "ses_shell_cap", 90_000)
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "ses_shell_cap", callID: "call_pre" } as any, { args: {} } as any)
    // crossing: measured context = 126_000 + 4_000 = 130k ≥ cap
    await mark(hooks, "ses_shell_cap", 126_000)
    expect(readStatusLog()).toContain("subagent context cap: session ses_shell_cap (glm-mx-53f-low)")
    expect(readStatusLog()).toContain("session terminated")
    await expect(hooks["tool.execute.before"]!({ tool: "read", sessionID: "ses_shell_cap", callID: "call_1" } as any, { args: {} } as any)).rejects.toThrow("SUBAGENT CONTEXT CAP REACHED")
    await expect(hooks["tool.execute.before"]!({ tool: "bash", sessionID: "ses_shell_cap", callID: "call_2" } as any, { args: { command: "ls" } } as any)).rejects.toThrow("SUBAGENT CONTEXT CAP REACHED")
    // resume from the main session via task_id → permanent denial
    await expect(hooks["tool.execute.before"]!({ tool: "task", sessionID: "ses_main", callID: "call_3" } as any, { args: { subagent_type: "glm-mx-53f-low", task_id: "ses_shell_cap", prompt: "continue" } } as any)).rejects.toThrow("can never be resumed")
    // fresh dispatch (no task_id) must NOT hit the resume deny (later gates may still speak, but never this one)
    let freshErr: unknown = null
    try {
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "ses_main", callID: "call_4" } as any, { args: { subagent_type: "glm-mx-53f-low", prompt: "fresh" } } as any)
    } catch (e) { freshErr = e }
    expect(String(freshErr)).not.toContain("can never be resumed")
    // let the fire-and-forget registry write land, then assert persistence
    await new Promise((r) => setTimeout(r, 150))
    const reg = JSON.parse(readFileSync(join(stateDir, "subagent-cap.json"), "utf8"))
    expect(reg.ses_shell_cap.tokens).toBe(130_000)
    expect(reg.ses_shell_cap.agent).toBe("glm-mx-53f-low")
  }, 30_000)

  test("internal sessions and main sessions are never terminated by the cap", async () => {
    const hooks = await bootPlugin()
    await seedShellSession(hooks, "ses_internal_title", "title")
    await mark(hooks, "ses_internal_title", 180_000)
    await mark(hooks, "ses_main_big", 180_000)
    // the internal session's read passes the cap gate (the main-session read gate also exempts it);
    // the main session at 180k is deliberately NOT read here — its own hard watermark gate owns that behavior
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "ses_internal_title", callID: "call_i1" } as any, { args: {} } as any)
    expect(readStatusLog()).not.toContain("ses_internal_title")
    expect(readStatusLog()).not.toContain("termination")
    // and its resume deny never fires (not a shell session)
    let err: unknown = null
    try {
      await hooks["tool.execute.before"]!({ tool: "task", sessionID: "ses_main_big", callID: "call_i2" } as any, { args: { subagent_type: "glm-mx-53f-low", task_id: "ses_main_big" } } as any)
    } catch (e) { err = e }
    expect(String(err)).not.toContain("can never be resumed")
  }, 30_000)

  test("termination survives plugin re-instantiation (persistent registry, no fresh message.updated needed)", async () => {
    const hooks = await bootPlugin() // fresh instance, same SWITCHMAN_STATE → registry eager-loaded
    await expect(hooks["tool.execute.before"]!({ tool: "task", sessionID: "ses_main", callID: "call_r1" } as any, { args: { subagent_type: "glm-mx-53f-low", task_id: "ses_shell_cap" } } as any)).rejects.toThrow("can never be resumed")
    await expect(hooks["tool.execute.before"]!({ tool: "read", sessionID: "ses_shell_cap", callID: "call_r2" } as any, { args: {} } as any)).rejects.toThrow("SUBAGENT CONTEXT CAP REACHED")
  }, 30_000)

  test("nested task inside a capped subagent session is denied by the same gate (a-branch, any tool class)", async () => {
    const hooks = await bootPlugin()
    await expect(hooks["tool.execute.before"]!({ tool: "task", sessionID: "ses_shell_cap", callID: "call_n1" } as any, { args: { subagent_type: "glm-mx-53f-low", prompt: "delegate onward" } } as any)).rejects.toThrow("SUBAGENT CONTEXT CAP REACHED")
  }, 30_000)
})
