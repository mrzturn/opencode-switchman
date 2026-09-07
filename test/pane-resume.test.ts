// [2026-09-06 fix]-[tmux pane mirroring resume wiring: a task call carrying task_id REUSES the previous child
//  session (opencode task tool skips sessions.create → no session.created event), so the pane must be opened
//  directly from the allowed dispatch sites (noteResumedChild). Contract: allowed dispatch + task_id + verified
//  session → resume pane triggered (status-log line); verified-missing session → skipped (the fallback fresh
//  session is covered by session.created); fresh dispatch (no task_id) and deny paths never trigger it]
import { describe, expect, test, afterAll } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const prevState = process.env.SWITCHMAN_STATE
const prevConfigDir = process.env.OPENCODE_CONFIG_DIR
process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-pane-resume-state-"))
process.env.OPENCODE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "switchman-pane-resume-cfg-"))
mkdirSync(process.env.SWITCHMAN_STATE, { recursive: true })
// [2026-09-07]-[lang hard gate fixture: sandbox project counts as lang-configured]
const projectDir = mkdtempSync(join(tmpdir(), "switchman-lang-fix-"))
mkdirSync(join(projectDir, ".switchman"), { recursive: true })
writeFileSync(join(projectDir, ".switchman", "settings.json"), JSON.stringify({ v: 1, configuredAt: "x", lang: { conversation: "en", comments: "en", docs: "en" } }))
// hermetic state (same trick as routing.test.ts / auto-redirect.test.ts): pre-seed every TTL cache so the six gates
// never hit the network; the empty catalog pins the curated table
writeFileSync(
  join(process.env.SWITCHMAN_STATE, "capability.json"),
  JSON.stringify({ source: "artificial-analysis", version: "fixed-empty", fetched_at: Date.now() / 1000, thresholds: { S: 62, A: 55, B: 45 }, models: {} }),
)
writeFileSync(join(process.env.SWITCHMAN_STATE, "model-catalog.json"), JSON.stringify({ fetched_at: Date.now(), etag: null, index: {} }))
for (const [file, body] of Object.entries({
  "model-matrix.json": {
    generated_at: new Date().toISOString(),
    combos: Object.fromEntries(loadManifest().shells.map((s) => [s.matrixKey, { status: "ok", latency_ms: 100, checked_at: new Date().toISOString() }])),
  },
  "costs.json": { scores: {}, fetched_at: Date.now() / 1000 },
  "selfupdate.json": { checked_at: new Date().toISOString(), mode: "prod", current: "0.0.0-test", latest: "0.0.0-test", outdated: false },
  "glm-quota.json": { status: "ok", fetched_at: Date.now() / 1000 },
  "copilot-quota.json": { status: "ok", fetched_at: Date.now() / 1000 },
  "ds-balance.json": { status: "ok", fetched_at: Date.now() / 1000 },
} as Record<string, unknown>)) {
  writeFileSync(join(process.env.SWITCHMAN_STATE, file), JSON.stringify(body))
}
afterAll(() => {
  if (prevState === undefined) delete process.env.SWITCHMAN_STATE
  else process.env.SWITCHMAN_STATE = prevState
  if (prevConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = prevConfigDir
})

import { SwitchmanPlugin } from "../src/index"
import { loadManifest, stateDir } from "../src/state"
import { rmSync } from "node:fs"

type Hooks = Awaited<ReturnType<typeof SwitchmanPlugin>>

type GetBehavior = "present" | "missing" | "throws" | "absent"

function pluginInput(behavior: GetBehavior, seen: string[]): any {
  return {
    client: {
      provider: { list: async () => [] },
      session: behavior === "absent"
        ? undefined
        : {
          get: async ({ path }: { path: { id: string } }) => {
            seen.push(path.id)
            if (behavior === "throws") throw new Error("server hiccup")
            return behavior === "present" ? { data: { id: path.id } } : {}
          },
        },
    },
    directory: projectDir,
  }
}

async function makeHooks(behavior: GetBehavior, seen: string[]): Promise<Hooks> {
  const hooks = await SwitchmanPlugin(pluginInput(behavior, seen), { matrix: { mode: "legacy" } } as any)
  const cfg: Record<string, unknown> = {}
  await hooks.config!(cfg)
  return { ...hooks, _cfg: cfg } as any
}

/** Legacy mode + an unknown non-builtin agent = fail-open allowed dispatch (site fires deterministically, no gates) */
async function runTask(hooks: Hooks, callID: string, args: Record<string, unknown>): Promise<void> {
  const output: any = { args }
  await hooks["tool.execute.before"]!({ tool: "task", sessionID: "s-test", callID } as any, output)
  // noteResumedChild verifies asynchronously (void then-chain) — give the microtask/timer a moment
  await new Promise((r) => setTimeout(r, 20))
}

function statusLogText(): string {
  const p = join(stateDir(), "status-log.json")
  if (!existsSync(p)) return ""
  const data = JSON.parse(readFileSync(p, "utf8"))
  return (Array.isArray(data) ? data : []).map((e: { text?: string }) => String(e?.text ?? "")).join("\n")
}

/** status-log persists across tests in the shared state dir — truncate for per-test isolation */
function resetLog(): void {
  rmSync(join(stateDir(), "status-log.json"), { force: true })
}

// opencode-style id: the log line suffixes ses_${id.slice(-6)} (house convention), so keep the last 6 chars intact
const TASK_ID = "ses_ab12cd"
const RESUME_MARK = `resume dispatch ses_ab12cd`

describe("tmux pane resume wiring (task_id reuse, no session.created)", () => {
  test("fresh dispatch (no task_id): no resume trigger", async () => {
    resetLog()
    const hooks = await makeHooks("present", [])
    await runTask(hooks, "c-fresh", { subagent_type: "mystery-agent", prompt: "hello" })
    expect(statusLogText()).not.toContain(RESUME_MARK)
  }, 20_000)

  test("resume with a verified session: pane trigger fires directly", async () => {
    resetLog()
    const seen: string[] = []
    const hooks = await makeHooks("present", seen)
    await runTask(hooks, "c-resume", { subagent_type: "mystery-agent", prompt: "hello", task_id: TASK_ID })
    expect(seen).toContain(TASK_ID)
    expect(statusLogText()).toContain(RESUME_MARK)
  }, 20_000)

  test("resume with a verified-missing session: skipped (opencode falls back to a fresh session covered by session.created)", async () => {
    resetLog()
    const seen: string[] = []
    const hooks = await makeHooks("missing", seen)
    await runTask(hooks, "c-missing", { subagent_type: "mystery-agent", prompt: "hello", task_id: TASK_ID })
    expect(seen).toContain(TASK_ID)
    expect(statusLogText()).not.toContain(RESUME_MARK)
  }, 20_000)

  test("resume when the session lookup errors: fail-open, trigger still fires", async () => {
    resetLog()
    const hooks = await makeHooks("throws", [])
    await runTask(hooks, "c-throw", { subagent_type: "mystery-agent", prompt: "hello", task_id: TASK_ID })
    expect(statusLogText()).toContain(RESUME_MARK)
  }, 20_000)
})
