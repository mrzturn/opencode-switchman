// [2026-09-04]-[autoRedirect/图片中继 index 层 fixture：构造插件实例（legacy/dynamic 两路）直调钩子，
//  验证错误落点静默改派（denyUninjected/内置封堵/闸6 META/闸7 语义门）与无视觉图片落盘中继]
import { describe, expect, test, afterAll } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const prevState = process.env.SWITCHMAN_STATE
const prevConfigDir = process.env.OPENCODE_CONFIG_DIR
process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-autoredir-state-"))
process.env.OPENCODE_CONFIG_DIR = mkdtempSync(join(tmpdir(), "switchman-autoredir-cfg-"))
mkdirSync(process.env.SWITCHMAN_STATE, { recursive: true })
// 能力数据解耦（同 routing.test.ts 手法）：空 capability.json 锚定策展表；空 catalog 走静态清单保底
writeFileSync(
  join(process.env.SWITCHMAN_STATE, "capability.json"),
  JSON.stringify({ source: "artificial-analysis", version: "fixed-empty", fetched_at: Date.now() / 1000, thresholds: { S: 62, A: 55, B: 45 }, models: {} }),
)
writeFileSync(join(process.env.SWITCHMAN_STATE, "model-catalog.json"), JSON.stringify({ fetched_at: Date.now(), etag: null, index: {} }))
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
  throw new Error(`预期 deny 抛错未发生：${subagentType}`)
}

describe("autoRedirect：legacy 钩子（默认开启）", () => {
  let hooks: Hooks
  test("插件构造（legacy）", async () => {
    hooks = await makeHooks({ matrix: { mode: "legacy" } })
  }, 20_000)

  test("闸6 META 无效 → prompt 末尾按壳所属 lane 合成 ROUTE_META 放行（同壳不改型）", async () => {
    const before = "帮我做一件事"
    const r = await runTask(hooks, "c1", "copilot-mx-luna-medium", before)
    expect(r.subagentType).toBe("copilot-mx-luna-medium")
    expect(r.prompt.startsWith(before)).toBe(true)
    // laneOfShell 取 LANE_ORDER 序首个命中（静态清单里 luna-medium 同列 mechanical/main，首命中 mechanical）
    const lanesStatic = loadManifest().lanes as Record<string, string[]>
    const lane = (["economy", "mechanical", "main", "hard", "vision", "review"] as const).find((l) => lanesStatic[l]?.includes("copilot-mx-luna-medium"))!
    const roleOf: Record<string, string> = { economy: "scouter", mechanical: "tester", main: "programmer", hard: "planner", vision: "observer" }
    expect(r.prompt).toContain(`ROUTE_META {"lane":"${lane}","role":"${roleOf[lane]}","modality":"text","capability":"${lane === "economy" ? "ro" : "rw"}","source":"auto"}`)
  })

  test("闸7 非视觉壳承 image 任务 → 静默改派到 vision 链首壳（不抛错）", async () => {
    const cfgAny = (hooks as any)._cfg as Record<string, any>
    const r = await runTask(hooks, "c2", "ds-mx-v4p-high", META({ lane: "vision", role: "observer", modality: "image" }))
    expect(r.subagentType).not.toBe("ds-mx-v4p-high")
    expect(cfgAny.agent![r.subagentType]).toBeTruthy()
    // 落点必须是视觉壳（改派目标来自 vision 链）
    const def = loadManifest().shells.find((s) => s.name === r.subagentType)
    expect(def?.vision).toBe(true)
  })

  test("review lane META 无效 → 仍抛原 deny（异族复审不可合成 META）", async () => {
    const msg = await expectDeny(hooks, "c3", "copilot-mx-opus5-high-ro", "没有 META")
    expect(msg).toContain("ROUTE_META 无效")
  })

  test("目标守卫仍拒（rw meta 落 ro 异族壳）→ 抛原 deny 不改派", async () => {
    const prompt = META({ lane: "review", role: "reviewer", producer_family: "claude", capability: "rw" })
    const msg = await expectDeny(hooks, "c4", "copilot-mx-opus5-high-ro", prompt)
    expect(msg).toContain("复审须异族视角")
  })

  test("explore 内置封堵 → 追加合成 ROUTE_META 并改写 subagent_type（不抛错）", async () => {
    const cfgAny = (hooks as any)._cfg as Record<string, any>
    const r = await runTask(hooks, "c5", "explore", "扫描整个仓库结构")
    expect(r.subagentType).not.toBe("explore")
    expect(r.subagentType).not.toBe("general")
    expect(cfgAny.agent![r.subagentType]).toBeTruthy()
    expect(r.prompt).toContain('"lane":"economy","role":"scouter","modality":"text","capability":"ro","source":"auto"')
  })
})

describe("autoRedirect=false：维持 deny 抛错", () => {
  let hooks: Hooks
  test("插件构造（legacy＋关闭改派）", async () => {
    hooks = await makeHooks({ matrix: { mode: "legacy" }, dispatch: { autoRedirect: false } })
  }, 20_000)

  test("闸6 META 无效 → 抛错（不合成 META）", async () => {
    const msg = await expectDeny(hooks, "d1", "copilot-mx-luna-medium", "没有 META")
    expect(msg).toContain("ROUTE_META 无效")
  })
  test("explore → 抛内置封堵 deny", async () => {
    const msg = await expectDeny(hooks, "d2", "explore", "扫描")
    expect(msg).toContain("不参与壳路由")
  })
})

describe("autoRedirect：dynamic 钩子（denyUninjected 改派）", () => {
  test("未注入壳名＋有效 META → 轮询等待激活后改派链首候选放行", async () => {
    const hooks = await makeHooks(undefined)
    // 注册主会话模型（luna）→ 管理器重算后其壳进入激活面，改派守卫才可能通过
    await hooks["chat.params"]!({ sessionID: "s-dyn", agent: "build", model: { providerID: "github-copilot", id: "gpt-5.6-luna" } } as any, {} as any)
    const cfgAny = (hooks as any)._cfg as Record<string, any>
    const prompt = META({ lane: "main", producer_family: "deepseek" })
    let landed: string | null = null
    for (let i = 0; i < 20 && !landed; i++) {
      try {
        const r = await runTask(hooks, `dyn-${i}`, "glm-mx-nonexist-high", prompt)
        landed = r.subagentType
      } catch {
        await new Promise((res) => setTimeout(res, 250)) // 激活重算未落地，退避重试
      }
    }
    expect(landed).not.toBeNull()
    expect(landed).not.toBe("glm-mx-nonexist-high")
    expect(cfgAny.agent![landed!]).toBeTruthy()
  }, 30_000)

  test("未注入壳名＋autoRedirect=false → 维持 denyUninjected 抛错", async () => {
    const hooks = await makeHooks({ dispatch: { autoRedirect: false } })
    const msg = await expectDeny(hooks, "dyn-off", "glm-mx-nonexist-high", META())
    expect(msg).toContain("未注入壳超集")
  }, 20_000)
})

describe("image relay：messages.transform 钩子（legacy）", () => {
  let hooks: Hooks
  test("插件构造", async () => {
    hooks = await makeHooks({ matrix: { mode: "legacy" } })
  }, 20_000)

  test("无视觉主模型＋data URL 图片 → 落盘并替换为读图指引文本", async () => {
    const sid = "s-relay"
    // deepseek-v4-pro：bundled 元数据 vision=false
    await hooks["chat.params"]!({ sessionID: sid, agent: "build", model: { providerID: "deepseek", id: "deepseek-v4-pro" } } as any, {} as any)
    const b64 = Buffer.from("fake-png").toString("base64")
    const output: any = {
      messages: [{
        info: { sessionID: sid, role: "user", model: { providerID: "deepseek", id: "deepseek-v4-pro" } },
        parts: [
          { id: "t0", sessionID: sid, messageID: "m1", type: "text", text: "看图" },
          { id: "p1", sessionID: sid, messageID: "m1", type: "file", mime: "image/png", url: `data:image/png;base64,${b64}` },
        ],
      }],
    }
    await hooks["experimental.chat.messages.transform"]!({} as any, output)
    const parts = output.messages[0].parts
    expect(parts.length).toBe(2)
    expect(parts[1].type).toBe("text")
    expect(parts[1].text).toContain("本会话模型无视觉输入")
    const expectedPath = join(stateDir(), "media", sid, "p1.png")
    expect(parts[1].text).toContain(expectedPath)
    expect(existsSync(expectedPath)).toBe(true)
    expect(readFileSync(expectedPath, "utf8")).toBe("fake-png")
    expect(parts[1].text).toContain('"lane":"vision"')
  })

  test("有视觉主模型 → 消息原样不动", async () => {
    const sid = "s-relay-vision"
    await hooks["chat.params"]!({ sessionID: sid, agent: "build", model: { providerID: "github-copilot", id: "claude-sonnet-5" } } as any, {} as any)
    const parts = [{ id: "p1", type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" }]
    const output: any = { messages: [{ info: { sessionID: sid, role: "user", model: { providerID: "github-copilot", id: "claude-sonnet-5" } }, parts }] }
    await hooks["experimental.chat.messages.transform"]!({} as any, output)
    expect(output.messages[0].parts).toBe(parts)
  })
})
