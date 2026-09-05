// [2026-09-04]-[English localization: translate titles/comments; no logic change]
// [2026-09-04]-[autoRedirect/image-relay index-layer fixture: build plugin instances (legacy/dynamic) and call hooks directly,
//  verifying silent redirects on wrong landing spots (denyUninjected/built-in blocking/gate-6 META/gate-7 semantics) and no-vision image persist+relay]
import { describe, expect, test, afterAll } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const prevState = process.env.SWITCHMAN_STATE
const prevConfigDir = process.env.OPENCODE_CONFIG_DIR
process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-autoredir-state-"))
process.env.OPENCODE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "switchman-autoredir-cfg-"))
mkdirSync(process.env.SWITCHMAN_STATE, { recursive: true })
// capability data decoupled (same trick as routing.test.ts): empty capability.json pins the curated table; empty catalog takes the static-manifest floor
writeFileSync(
  join(process.env.SWITCHMAN_STATE, "capability.json"),
  JSON.stringify({ source: "artificial-analysis", version: "fixed-empty", fetched_at: Date.now() / 1000, thresholds: { S: 62, A: 55, B: 45 }, models: {} }),
)
writeFileSync(join(process.env.SWITCHMAN_STATE, "model-catalog.json"), JSON.stringify({ fetched_at: Date.now(), etag: null, index: {} }))
// [2026-09-04]-[hermetic fix: pre-seed all TTL caches to cut the network. Previously an isolated state dir was not enough —
//  a clean HOME has no credentials → warmup probes wrote all 52 combos as unknown into model-matrix.json → gate-2 unknown
//  fail-open returned early (gates.ts "non-down never blocks"), skipping gates 3-7 so META/semantics/re-review denies all went dead;
//  with a real HOME, probes/quota/costs/self-update hit the network before going green. Pre-seed every matrix combo as ok (fresh
//  generated_at < PROBE_TTL, no refresh triggered) so the six gates deterministically reach gate 6/7; costs/selfupdate/quota likewise
//  prevent background network refreshes]-[CI clean environment fully green with zero networking]
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


type Hooks = Awaited<ReturnType<typeof SwitchmanPlugin>>
const pluginInput = { client: { provider: { list: async () => [] } } } as any

async function makeHooks(rawOptions: unknown): Promise<Hooks> {
  const hooks = await SwitchmanPlugin(pluginInput, rawOptions as any)
  const cfg: Record<string, unknown> = {}
  await hooks.config!(cfg)
  return { ...hooks, _cfg: cfg } as any
}

function taskCall(callID: string) {
  return { tool: "task", sessionID: "s-test", callID }
}

const META = (over: Partial<{ lane: string; role: string; producer_family: string; capability: string; modality: string }> = {}) =>
  `ROUTE_META {"lane":"${over.lane ?? "main"}","role":"${over.role ?? "programmer"}","producer_family":"${over.producer_family ?? "deepseek"}","capability":"${over.capability ?? "rw"}","modality":"${over.modality ?? "text"}","source":"auto"}`

async function runTask(hooks: Hooks, callID: string, subagentType: string, prompt: string): Promise<{ subagentType: string; prompt: string }> {
  const output: any = { args: { subagent_type: subagentType, prompt } }
  await hooks["tool.execute.before"]!(taskCall(callID) as any, output)
  return { subagentType: String(output.args.subagent_type), prompt: String(output.args.prompt) }
}

async function expectDeny(hooks: Hooks, callID: string, subagentType: string, prompt: string): Promise<string> {
  try {
    await runTask(hooks, callID, subagentType, prompt)
  } catch (exc) {
    return String((exc as Error).message ?? exc)
  }
  throw new Error(`expected deny throw did not happen: ${subagentType}`)
}

// Deny-message assertions below match gates.ts output verbatim (kept in sync with the gates group's English copy).
describe("autoRedirect: legacy hooks (on by default)", () => {
  let hooks: Hooks
  test("plugin construction (legacy)", async () => {
    hooks = await makeHooks({ matrix: { mode: "legacy" } })
  }, 20_000)

  test("gate 6 META invalid → synthesize ROUTE_META at the prompt tail per the shell's lane and allow (same shell, no reshaping)", async () => {
    const before = "do one thing for me"
    const r = await runTask(hooks, "c1", "copilot-mx-luna-medium", before)
    expect(r.subagentType).toBe("copilot-mx-luna-medium")
    expect(r.prompt.startsWith(before)).toBe(true)
    // laneOfShell takes the first hit in LANE_ORDER order (the static manifest lists luna-medium under mechanical/main; mechanical hits first)
    const lanesStatic = loadManifest().lanes as Record<string, string[]>
    const lane = (["economy", "mechanical", "main", "hard", "vision", "review"] as const).find((l) => lanesStatic[l]?.includes("copilot-mx-luna-medium"))!
    const roleOf: Record<string, string> = { economy: "scouter", mechanical: "tester", main: "programmer", hard: "planner", vision: "observer" }
    expect(r.prompt).toContain(`ROUTE_META {"lane":"${lane}","role":"${roleOf[lane]}","modality":"text","capability":"${lane === "economy" ? "ro" : "rw"}","source":"auto"}`)
  })

  test("gate 7 non-vision shell taking an image task → silently redirected to the vision chain-head shell (no throw)", async () => {
    const cfgAny = (hooks as any)._cfg as Record<string, any>
    const r = await runTask(hooks, "c2", "ds-mx-v4p-high", META({ lane: "vision", role: "observer", modality: "image" }))
    expect(r.subagentType).not.toBe("ds-mx-v4p-high")
    expect(cfgAny.agent![r.subagentType]).toBeTruthy()
    // the landing spot must be a vision shell (the redirect target comes from the vision chain)
    const def = loadManifest().shells.find((s) => s.name === r.subagentType)
    expect(def?.vision).toBe(true)
  })

  test("review lane META invalid → still throws the original deny (cross-family re-review cannot synthesize a META)", async () => {
    const msg = await expectDeny(hooks, "c3", "copilot-mx-opus5-high-ro", "no META")
    expect(msg).toContain("invalid ROUTE_META")
  })

  test("target guard still refuses (rw meta landing on a ro cross-family shell) → throws the original deny, no redirect", async () => {
    const prompt = META({ lane: "review", role: "reviewer", producer_family: "claude", capability: "rw" })
    const msg = await expectDeny(hooks, "c4", "copilot-mx-opus5-high-ro", prompt)
    expect(msg).toContain("requires a cross-family perspective")
  })

  test("explore built-in blocking → appends a synthetic ROUTE_META and rewrites subagent_type (no throw)", async () => {
    const cfgAny = (hooks as any)._cfg as Record<string, any>
    const r = await runTask(hooks, "c5", "explore", "scan the whole repo structure")
    expect(r.subagentType).not.toBe("explore")
    expect(r.subagentType).not.toBe("general")
    expect(cfgAny.agent![r.subagentType]).toBeTruthy()
    expect(r.prompt).toContain('"lane":"economy","role":"scouter","modality":"text","capability":"ro","source":"auto"')
  })
})

describe("autoRedirect=false: keep throwing the deny", () => {
  let hooks: Hooks
  test("plugin construction (legacy + redirect off)", async () => {
    hooks = await makeHooks({ matrix: { mode: "legacy" }, dispatch: { autoRedirect: false } })
  }, 20_000)

  test("gate 6 META invalid → throws (no META synthesized)", async () => {
    const msg = await expectDeny(hooks, "d1", "copilot-mx-luna-medium", "no META")
    expect(msg).toContain("invalid ROUTE_META")
  })
  test("explore → throws the built-in blocking deny", async () => {
    const msg = await expectDeny(hooks, "d2", "explore", "scan")
    expect(msg).toContain("does not participate in shell routing")
  })
})

describe("autoRedirect: dynamic hooks (denyUninjected redirect)", () => {
  test("uninjected shell name + valid META → poll until activation, then redirected to the chain-head candidate and allowed", async () => {
    const hooks = await makeHooks(undefined)
    // register the main session model (luna) → after the manager recomputes its shell enters the active set, only then can the redirect guard pass
    await hooks["chat.params"]!({ sessionID: "s-dyn", agent: "build", model: { providerID: "github-copilot", id: "gpt-5.6-luna" } } as any, {} as any)
    const cfgAny = (hooks as any)._cfg as Record<string, any>
    const prompt = META({ lane: "main", producer_family: "deepseek" })
    let landed: string | null = null
    for (let i = 0; i < 20 && !landed; i++) {
      try {
        const r = await runTask(hooks, `dyn-${i}`, "glm-mx-nonexist-high", prompt)
        landed = r.subagentType
      } catch {
        await new Promise((res) => setTimeout(res, 250)) // activation recompute not landed yet, back off and retry
      }
    }
    expect(landed).not.toBeNull()
    expect(landed).not.toBe("glm-mx-nonexist-high")
    expect(cfgAny.agent![landed!]).toBeTruthy()
  }, 30_000)

  test("uninjected shell name + autoRedirect=false → keeps throwing denyUninjected", async () => {
    const hooks = await makeHooks({ dispatch: { autoRedirect: false } })
    const msg = await expectDeny(hooks, "dyn-off", "glm-mx-nonexist-high", META())
    expect(msg).toContain("not injected into the shell superset")
  }, 20_000)
})

describe("image relay: messages.transform hook (legacy)", () => {
  let hooks: Hooks
  test("plugin construction", async () => {
    hooks = await makeHooks({ matrix: { mode: "legacy" } })
  }, 20_000)

  test("no-vision main model + data URL image → persisted and replaced by a reading-guidance text part", async () => {
    const sid = "s-relay"
    // deepseek-v4-pro: bundled metadata vision=false
    await hooks["chat.params"]!({ sessionID: sid, agent: "build", model: { providerID: "deepseek", id: "deepseek-v4-pro" } } as any, {} as any)
    const b64 = Buffer.from("fake-png").toString("base64")
    const output: any = {
      messages: [{
        info: { sessionID: sid, role: "user", model: { providerID: "deepseek", id: "deepseek-v4-pro" } },
        parts: [
          { id: "t0", sessionID: sid, messageID: "m1", type: "text", text: "look at the image" },
          { id: "p1", sessionID: sid, messageID: "m1", type: "file", mime: "image/png", url: `data:image/png;base64,${b64}` },
        ],
      }],
    }
    await hooks["experimental.chat.messages.transform"]!({} as any, output)
    const parts = output.messages[0].parts
    expect(parts.length).toBe(2)
    expect(parts[1].type).toBe("text")
    expect(parts[1].text).toContain("no vision input")
    const expectedPath = join(stateDir(), "media", sid, "p1.png")
    expect(parts[1].text).toContain(expectedPath)
    expect(existsSync(expectedPath)).toBe(true)
    expect(readFileSync(expectedPath, "utf8")).toBe("fake-png")
    expect(parts[1].text).toContain('"lane":"vision"')
  })

  test("vision-capable main model → message left untouched", async () => {
    const sid = "s-relay-vision"
    await hooks["chat.params"]!({ sessionID: sid, agent: "build", model: { providerID: "github-copilot", id: "claude-sonnet-5" } } as any, {} as any)
    const parts = [{ id: "p1", type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" }]
    const output: any = { messages: [{ info: { sessionID: sid, role: "user", model: { providerID: "github-copilot", id: "claude-sonnet-5" } }, parts }] }
    await hooks["experimental.chat.messages.transform"]!({} as any, output)
    expect(output.messages[0].parts).toBe(parts)
  })

  // [2026-09-05]-[history relay regression: earlier user messages' image parts leak back to the host on later round-trips,
  //  which replaces them with "Cannot read <filename> (this model does not support image input)" — the recurring clipboard error.
  //  All user messages must be relayed: compact note for earlier ones, full guidance for the last]
  test("earlier user messages' images also replaced (compact note); the last keeps full guidance; assistant messages untouched", async () => {
    const sid = "s-relay-hist"
    await hooks["chat.params"]!({ sessionID: sid, agent: "build", model: { providerID: "deepseek", id: "deepseek-v4-pro" } } as any, {} as any)
    const b64a = Buffer.from("hist-png").toString("base64")
    const b64b = Buffer.from("last-png").toString("base64")
    const output: any = {
      messages: [
        {
          info: { sessionID: sid, role: "user", model: { providerID: "deepseek", id: "deepseek-v4-pro" } },
          parts: [
            { id: "t1", sessionID: sid, messageID: "m1", type: "text", text: "first turn" },
            { id: "ph1", sessionID: sid, messageID: "m1", type: "file", mime: "image/png", url: `data:image/png;base64,${b64a}` },
          ],
        },
        { info: { sessionID: sid, role: "assistant" }, parts: [{ id: "a1", type: "text", text: "ok" }] },
        {
          info: { sessionID: sid, role: "user", model: { providerID: "deepseek", id: "deepseek-v4-pro" } },
          parts: [
            { id: "t2", sessionID: sid, messageID: "m2", type: "text", text: "second turn" },
            { id: "ph2", sessionID: sid, messageID: "m2", type: "file", mime: "image/png", url: `data:image/png;base64,${b64b}` },
          ],
        },
      ],
    }
    await hooks["experimental.chat.messages.transform"]!({} as any, output)
    const firstParts = output.messages[0].parts
    expect(firstParts.length).toBe(2)
    expect((firstParts[1] as any).type).toBe("text")
    expect((firstParts[1] as any).text).toContain("available at")
    expect((firstParts[1] as any).text).toContain(join(stateDir(), "media", sid, "ph1.png"))
    expect((firstParts[1] as any).text).not.toContain('"lane":"vision"')
    expect(existsSync(join(stateDir(), "media", sid, "ph1.png"))).toBe(true)
    expect(output.messages[1].parts.length).toBe(1)
    const lastParts = output.messages[2].parts
    expect(lastParts.length).toBe(2)
    expect((lastParts[1] as any).text).toContain("no vision input")
    expect((lastParts[1] as any).text).toContain('"lane":"vision"')
    // [2026-09-05]-[round-trip re-transform is idempotent: a second pass re-replaces parts and does not duplicate notes]
    await hooks["experimental.chat.messages.transform"]!({} as any, output)
    expect(output.messages[0].parts.length).toBe(2)
    expect(output.messages[2].parts.length).toBe(2)
  })
})

// [2026-09-05]-[no-vision image read guard: reading an image in a text-only session triggers the host's bare
//  "Cannot read image (this model does not support image input)" error — the guard denies early with a redirect]
describe("image read guard: tool.execute.before (legacy)", () => {
  let hooks: Hooks
  test("plugin construction", async () => {
    hooks = await makeHooks({ matrix: { mode: "legacy" } })
  }, 20_000)

  test("no-vision model session reading an image → denied with a vision-shell redirect", async () => {
    const sid = "s-imgguard"
    await hooks["chat.params"]!({ sessionID: sid, agent: "build", model: { providerID: "deepseek", id: "deepseek-v4-pro" } } as any, {} as any)
    let msg = ""
    try {
      await hooks["tool.execute.before"]!({ tool: "read", sessionID: sid, callID: "c-g1" } as any, { args: { filePath: "/tmp/shot.png" } } as any)
    } catch (exc) {
      msg = String((exc as Error).message ?? exc)
    }
    expect(msg).toContain("no vision input")
    expect(msg).toContain("/tmp/shot.png")
    expect(msg).toContain('"lane":"vision"')
  })

  test("vision model / unknown session / non-image path → fail-open allowed (no throw)", async () => {
    const sid = "s-imgguard-ok"
    await hooks["chat.params"]!({ sessionID: sid, agent: "build", model: { providerID: "github-copilot", id: "claude-sonnet-5" } } as any, {} as any)
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: sid, callID: "c-g2" } as any, { args: { filePath: "/tmp/shot.png" } } as any)
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: "s-never-seen", callID: "c-g3" } as any, { args: { filePath: "/tmp/shot.png" } } as any)
    await hooks["tool.execute.before"]!({ tool: "read", sessionID: sid, callID: "c-g4" } as any, { args: { filePath: "/tmp/notes.txt" } } as any)
  })
})
