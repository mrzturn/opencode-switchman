// [2026-09-06]-[subagent hard cap behavioral contract: a shell subagent crossing the context cap is force-terminated —
//  every further tool call in that session is denied with a wrap-up order, the session can never be resumed via task_id
//  (persistent registry, survives plugin re-instantiation), internal sessions and sub-cap sessions are untouched, and
//  fresh dispatches without task_id are unaffected]
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const configDir = mkdtempSync(join(tmpdir(), "switchman-subcap-config-"))
const stateDir = mkdtempSync(join(tmpdir(), "switchman-subcap-state-"))
process.env.OPENCODE_CONFIG_DIR = configDir
process.env.SWITCHMAN_STATE = stateDir
// [2026-09-06]-[model catalog stub: message.updated model-key recording consults the runtime index for the window cap]
writeFileSync(join(stateDir, "model-catalog.json"), JSON.stringify({ fetched_at: Date.now(), etag: null, index: {} }))

import { SwitchmanPlugin } from "../src/index"
import {
  DEFAULT_SUBAGENT_CAP_TOKENS, MAX_SUBAGENT_CAP_TOKENS, MIN_SUBAGENT_CAP_TOKENS,
  subagentCapOf, capByWindow, subagentCapDenyMessage, subagentResumeDenyMessage,
} from "../src/context-watch"

type Hooks = Awaited<ReturnType<typeof SwitchmanPlugin>>

function readStatusLog(): string {
  const p = join(stateDir, "status-log.json")
  return existsSync(p) ? readFileSync(p, "utf8") : ""
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
  return SwitchmanPlugin({ client: fakeClient, directory: "/w" } as any, { matrix: { mode: "legacy" } } as any)
}

async function mark(hooks: Hooks, sessionId: string, input: number): Promise<void> {
  await hooks.event!({ event: { type: "message.updated", properties: { sessionID: sessionId, info: assistantTokens(input) } } } as any)
}

/** Register a shell child session (legacy mode classification: agent name matching /-mx-/) */
async function seedShellSession(hooks: Hooks, sessionId: string, agent = "glm-mx-53f-low"): Promise<void> {
  await hooks.event!({ event: { type: "session.created", properties: { info: { id: sessionId, agent } } } } as any)
}

describe("subagent cap: pure decision layer", () => {
  test("subagentCapOf: default 100k, clamped, disabled → null", () => {
    expect(subagentCapOf(undefined)).toBe(DEFAULT_SUBAGENT_CAP_TOKENS)
    expect(subagentCapOf({})).toBe(DEFAULT_SUBAGENT_CAP_TOKENS)
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

describe("subagent cap: plugin wiring", () => {
  test("shell session crossing 100k → tools denied, task_id resume denied, registry persisted", async () => {
    const hooks = await bootPlugin()
    await seedShellSession(hooks, "ses_shell_cap")
    // sub-cap watermark (94k measured): tools still allowed
    await mark(hooks, "ses_shell_cap", 90_000)
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "ses_shell_cap", callID: "call_pre" } as any, { args: {} } as any)
    // crossing: measured context = 105_000 + 4_000 = 109k ≥ cap
    await mark(hooks, "ses_shell_cap", 105_000)
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
    expect(reg.ses_shell_cap.tokens).toBe(109_000)
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
