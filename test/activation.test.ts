// 动态激活矩阵行为契约（v1.3；bun test）
// 覆盖：mode 判定与空集回退、configured∪sessionModels 并集、切模/删会话、unreadable 回退、
//       超集去重与稳定命名、无 models.dev 元数据降级、闸1 三层语义、lane 补齐、watch 集成（原子 rename+debounce）
import { describe, test, expect, beforeAll } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-act-"))

import { detectMode, parseDesktopModels, parseTuiFavorites, readConfigured, computeActivation, sameActivation, desktopDatPath, tuiModelPath, normalizeProviderListResponse } from "../src/activation"
import type { ModelKey } from "../src/types"
import { buildShells, stableHash, bundledModelIndex, freeFloorModels } from "../src/catalog"
import type { ShellDefinition } from "../src/catalog"
import { MatrixManager } from "../src/matrix-manager"
import { INTERNAL_AGENTS } from "../src/matrix-manager"
import { laneBaseChain } from "../src/lane-policy"
import { checkShell, shellLikeName, denyUninjected } from "../src/gates"
import { buildBanner } from "../src/banner"
import { readJson, paths, loadManifest } from "../src/state"
import { injectShells } from "../src/shells"
import { chatParamsModelKey, sessionDeletedId, sessionCreatedInfo } from "../src/helpers"
import { LANE_ORDER } from "../src/types"
import type { GateSnapshot, ShellRegEntry } from "../src/types"

// ---- 沙箱 ----
// [2026-08-29]-[修复复审P1-双根路径：布局对齐真实形态——stateHome=XDG_STATE_HOME（desktop=userData），
// stateRoot=stateHome/opencode；opencode.global.dat 在 stateHome 根，model.json 在 stateRoot]
const stateHome = mkdtempSync(join(tmpdir(), "opencode-state-"))
const stateRoot = join(stateHome, "opencode")
mkdirSync(stateRoot, { recursive: true })
const DESKTOP_DAT = join(stateHome, "opencode.global.dat")
const TUI_MODEL = join(stateRoot, "model.json")

function writeDesktop(user: unknown[]): void {
  writeFileSync(DESKTOP_DAT, JSON.stringify({ model: { user, recent: [], variant: null }, theme: "dark" }))
}
function writeTui(favorite: unknown[]): void {
  writeFileSync(TUI_MODEL, JSON.stringify({ recent: [], favorite, variant: null }))
}
function defsByModel(defs: ShellDefinition[]): Map<ModelKey, ShellDefinition[]> {
  const m = new Map<ModelKey, ShellDefinition[]>()
  for (const d of defs) {
    const k = `${d.provider}/${d.modelId}` as ModelKey
    const list = m.get(k) ?? []
    list.push(d)
    m.set(k, list)
  }
  return m
}
const META = {
  "glm/glm-5.3": { efforts: ["low", "medium", "high", "max"], toggle: true, vision: false },
  "github-copilot/gpt-5.6-terra": { efforts: ["low", "medium", "high", "max"], toggle: true, vision: true },
  "deepseek/deepseek-v4-pro": { efforts: ["low", "high", "max"], toggle: true, vision: false },
  "glm/glm-5.3-flash": { efforts: ["low", "high"], toggle: true, vision: true },
}
const SUPerset_MODELS = ["glm/glm-5.3", "glm/glm-5.3-flash", "github-copilot/gpt-5.6-terra", "deepseek/deepseek-v4-pro"]
const SUP = buildShells(SUPerset_MODELS, META as any, { roAliases: true, degradedFamilyByProvider: true, markDegraded: true })

function managerOf(over: Partial<ConstructorParameters<typeof MatrixManager>[0]> = {}): MatrixManager {
  return new MatrixManager({
    stateRoot, mode: "cli", superset: SUP,
    injectedNames: new Set(SUP.map((d) => d.name)),
    knownProviders: new Set(SUP.map((d) => d.provider)),
    watchEnabled: false,
    ...over,
  })
}
function registryOf(defs: ShellDefinition[]): Record<string, ShellRegEntry> {
  const out: Record<string, ShellRegEntry> = {}
  for (const d of defs) {
    out[d.name] = { ...d, pool: d.pool as any, family: d.family as any, status: "enabled", comboKey: d.matrixKey }
  }
  return out
}
function matrixOkOf(defs: ShellDefinition[]): Record<string, any> {
  const out: Record<string, any> = {}
  for (const d of defs) out[d.matrixKey] = { status: "ok", latency_ms: null }
  return out
}
function metaOf(lane: string): string {
  return `ROUTE_META {"lane":"${lane}","role":"programmer","producer_family":"glm","capability":"rw","modality":"text","source":"auto"}\n任务`
}

// ================= 1. mode 判定与空集回退 =================
describe("mode 判定与空集回退", () => {
  test("auto：OPENCODE_CLIENT=desktop→desktop；其余→cli；强制覆盖优先", () => {
    expect(detectMode("auto", "desktop")).toBe("desktop")
    expect(detectMode("auto", undefined)).toBe("cli")
    expect(detectMode("auto", "tui")).toBe("cli")
    expect(detectMode("app", undefined)).toBe("desktop") // 强制 desktop 语义
    expect(detectMode("tui", "desktop")).toBe("cli") // 强制覆盖客户端判定
    expect(detectMode("legacy", "desktop")).toBe("legacy")
  })
  test("无可见/favorites（空集）→未配可见集默认全部超集可调度（不因会话模型收紧）", () => {
    writeTui([]) // cli 模式无 favorites
    const m = managerOf({ mode: "cli" })
    m.noteChatParams("s1", "build", "glm/glm-5.3")
    const st = m.recompute()
    expect(st.configStatus).toBe("empty")
    expect(st.activeModels).toEqual(["glm/glm-5.3"])
    // [2026-09-01]-[未配可见集＝不限制：activeShells 覆盖全部超集，不仅 glm-5.3 那一档]
    expect(st.activeShells.some((n) => n.startsWith("ds-mx-") || n.startsWith("copilot-mx-"))).toBe(true)
  })
  test("desktop 无可见项（全 hide）→同样回退会话模型", () => {
    writeDesktop([
      { providerID: "glm", modelID: "glm-5.3", visibility: "hide" },
    ])
    const m = managerOf({ mode: "desktop" })
    m.noteChatParams("s1", "build", "github-copilot/gpt-5.6-terra")
    const st = m.recompute()
    expect(st.configStatus).toBe("empty")
    expect(st.activeModels).toEqual(["github-copilot/gpt-5.6-terra"])
  })
})

// ================= 2. 文件解析与并集 =================
describe("配置面解析与并集", () => {
  test("desktop opencode.global.dat：仅 visibility=show；model 字段可为 JSON 字符串", () => {
    writeDesktop([
      { providerID: "glm", modelID: "glm-5.3", visibility: "show" },
      { providerID: "deepseek", modelID: "deepseek-v4-pro", visibility: "hide" },
      { providerID: "github-copilot", modelID: "gpt-5.6-terra", visibility: "show", favorite: true },
    ])
    expect(parseDesktopModels(JSON.parse(require("node:fs").readFileSync(DESKTOP_DAT, "utf8"))))
      .toEqual(["github-copilot/gpt-5.6-terra", "glm/glm-5.3"])
    // 字符串化 model（persist 层序列化形态）
    const strWrapped = { model: JSON.stringify({ user: [{ providerID: "glm", modelID: "glm-5.3", visibility: "show" }] }) }
    expect(parseDesktopModels(strWrapped)).toEqual(["glm/glm-5.3"])
    expect(parseDesktopModels({ model: { user: "not-array" } })).toBeNull()
  })
  test("TUI model.json：favorite 集解析；结构坏=null", () => {
    expect(parseTuiFavorites({ favorite: [{ providerID: "glm", modelID: "glm-5.3" }], recent: [] })).toEqual(["glm/glm-5.3"])
    expect(parseTuiFavorites({ recent: [] })).toBeNull()
    expect(parseTuiFavorites("{broken" as unknown)).toBeNull()
  })
  test("configured ∪ sessionModels 并集（多会话并集，含配置面外但超集内的会话模型）", () => {
    writeTui([{ providerID: "glm", modelID: "glm-5.3" }])
    const m = managerOf({ mode: "cli" })
    m.noteChatParams("s1", "build", "deepseek/deepseek-v4-pro")
    m.noteChatParams("s2", "build", "github-copilot/gpt-5.6-terra")
    const st = m.recompute()
    expect(st.configStatus).toBe("ok")
    expect(st.configured).toEqual(["glm/glm-5.3"])
    expect(st.sessionModels).toEqual(["deepseek/deepseek-v4-pro", "github-copilot/gpt-5.6-terra"])
    expect(st.activeModels).toEqual([
      "deepseek/deepseek-v4-pro", "github-copilot/gpt-5.6-terra", "glm/glm-5.3",
    ])
  })
  test("超集外 provider → restartRequired 去重", () => {
    writeTui([])
    const m = managerOf({ mode: "cli" })
    m.noteChatParams("s1", "build", "newprov/model-a")
    m.noteChatParams("s2", "build", "newprov/model-b")
    const st = m.recompute()
    expect(st.restartRequired).toEqual(["newprov"])
  })
})

// ================= 2.5 复审 P1 修复：形状契约与首轮时序 =================
describe("delta 复审 P1 修复：provider.list 响应形状归一", () => {
  test("hey-api 包装形状 {data:{all,connected,default}} → 先解包 .data 再取 all/connected", () => {
    const resp = { data: { all: [{ id: "glm", models: { "glm-5.3": {} } }], connected: ["glm"], default: {} } }
    const r = normalizeProviderListResponse(resp)
    expect(r).not.toBeNull()
    expect(r!.providers.map((p: any) => p.id)).toEqual(["glm"])
    expect(r!.connected!.has("glm")).toBe(true)
  })
  test("直接形状 {all,connected} 与裸数组兜底", () => {
    const direct = { all: [{ id: "deepseek", models: { "deepseek-v4-pro": {} } }], connected: ["deepseek"] }
    expect(normalizeProviderListResponse(direct)!.connected!.has("deepseek")).toBe(true)
    const bare = [{ id: "x", models: {} }]
    expect(normalizeProviderListResponse(bare)!.connected).toBeNull()
  })
  test("不可识别形状 → null（触发 cfg.provider 回退）", () => {
    expect(normalizeProviderListResponse({ foo: 1 })).toBeNull()
    expect(normalizeProviderListResponse(undefined)).toBeNull()
  })
})

describe("复审 P1 修复（形状契约/首轮时序/双根路径/全字段等价）", () => {
  test("chat.params 真实形状：model 为 Model 对象（providerID/id），provider 为对象 → modelKey=providerID/id", () => {
    // 契约：clone plugin/src/index.ts:248 model: Model（schema/src/model.ts:16 providerID + id）；provider: ProviderContext
    expect(chatParamsModelKey({
      sessionID: "s1", agent: "build",
      model: { providerID: "glm", id: "glm-5.3", name: "GLM 5.3", capabilities: {} },
      provider: { id: "glm", name: "Zhipu" },
      message: {},
    })).toBe("glm/glm-5.3")
    expect(chatParamsModelKey({ model: { id: "x" } })).toBeNull() // 缺 providerID
    expect(chatParamsModelKey({})).toBeNull()
  })
  test("session.deleted 形状：properties.info.id 优先；.sessionID/.session.id 兜底链", () => {
    // 契约：clone sdk types.gen.ts:576-580 properties={info: Session}
    expect(sessionDeletedId({ info: { id: "s1", agent: "build" } })).toBe("s1")
    expect(sessionDeletedId({ sessionID: "s2" })).toBe("s2")
    expect(sessionDeletedId({ session: { id: "s3" } })).toBe("s3")
    expect(sessionDeletedId({ info: {} })).toBeNull()
    expect(sessionDeletedId(null)).toBeNull()
  })
  test("session.created 形状：properties.info={id,agent}；缺 agent 不预注册", () => {
    expect(sessionCreatedInfo({ info: { id: "s1", agent: "build" } })).toEqual({ id: "s1", agent: "build" })
    expect(sessionCreatedInfo({ info: { id: "s1" } })).toBeNull()
    expect(sessionCreatedInfo(undefined)).toBeNull()
  })
  test("首轮时序：session.created 预注册 → transform 首轮（chat.params 未到）即可分类；自定义 subagent 按主会话", () => {
    writeTui([])
    const m = managerOf({ mode: "cli" })
    m.noteSessionCreated("t1", "glm-mx-53-high") // 壳子代理预注册
    m.noteSessionCreated("t2", "title") // 内部代理
    m.noteSessionCreated("s1", "build") // 主会话
    m.noteSessionCreated("s2", "my-custom-subagent") // 用户自定义 subagent → 按主会话
    expect(m.skipSystemInjection("t1")).toBe(true)
    expect(m.skipSystemInjection("t2")).toBe(true)
    expect(m.skipSystemInjection("s1")).toBe(false)
    expect(m.skipSystemInjection("s2")).toBe(false)
    expect(m.skipSystemInjection("unknown")).toBe(false)
    // 预注册不带模型 → 不计入激活矩阵；chat.params 补齐后计入（含自定义 subagent）
    expect(m.recompute().sessionModels).toEqual([])
    expect(m.noteChatParams("s1", "build", "glm/glm-5.3")).toBe(true)
    expect(m.noteChatParams("s2", "my-custom-subagent", "deepseek/deepseek-v4-pro")).toBe(true)
    expect(m.recompute().sessionModels).toEqual(["deepseek/deepseek-v4-pro", "glm/glm-5.3"])
  })
  test("chat.params 分类：注入壳名→isShell 注册但不计入；内部代理→不注册；模型未变不重算", () => {
    writeTui([])
    const m = managerOf({ mode: "cli" })
    const shellName = SUP[0]!.name
    expect(m.noteChatParams("t1", shellName, "glm/glm-5.3")).toBe(false)
    expect(m.isShellSession("t1")).toBe(true)
    expect(m.noteChatParams("t2", "title", "glm/glm-5.3")).toBe(false)
    expect(m.sessions.has("t2")).toBe(false)
    expect([...INTERNAL_AGENTS].sort()).toEqual(["compaction", "summary", "title"])
    expect(m.noteChatParams("s1", "build", "glm/glm-5.3")).toBe(true)
    expect(m.noteChatParams("s1", "build", "glm/glm-5.3")).toBe(false) // 同模型重复 → 不重算
  })
  test("desktop 双根路径：global.dat 在 stateRoot 父目录（userData）；CLI 只读 stateRoot/model.json", () => {
    expect(desktopDatPath(stateRoot)).toBe(DESKTOP_DAT)
    expect(tuiModelPath(stateRoot)).toBe(TUI_MODEL)
    rmSync(DESKTOP_DAT, { force: true })
    rmSync(TUI_MODEL, { force: true })
    writeFileSync(DESKTOP_DAT, JSON.stringify({ model: { user: [{ providerID: "glm", modelID: "glm-5.3", visibility: "show" }] } }))
    expect(readConfigured(stateRoot, "desktop")).toEqual({ configStatus: "ok", models: ["glm/glm-5.3"] })
    expect(readConfigured(stateRoot, "cli")).toEqual({ configStatus: "empty", models: [] })
  })
  test("desktop 同模型重复：hide 覆盖 show（按 providerID/modelID 聚合，任一非 show 即排除）", () => {
    expect(parseDesktopModels({ model: { user: [
      { providerID: "glm", modelID: "glm-5.3", visibility: "show" },
      { providerID: "glm", modelID: "glm-5.3", visibility: "hide" }, // 重复条目 hide → 排除
      { providerID: "deepseek", modelID: "deepseek-v4-pro", visibility: "show" },
      { providerID: "deepseek", modelID: "deepseek-v4-pro", visibility: "show" }, // 双 show → 保留
    ] } })).toEqual(["deepseek/deepseek-v4-pro"])
  })
  test("sameActivation 全字段：并集相同但 configured/sessionModels 互换 → 不等价（切模快照须反映新会话信息）", () => {
    const mk = (configured: ModelKey[], sessionModels: ModelKey[]) => ({
      generation: 1, mode: "cli" as const, configStatus: "ok" as const,
      configured, sessionModels,
      activeModels: sortUniqueKeys([...configured, ...sessionModels]),
      activeShells: ["glm-mx-53-high"], restartRequired: [], invalidConfigured: [],
    })
    expect(sameActivation(mk(["a/m1"], ["b/m2"]), mk(["b/m2"], ["a/m1"]))).toBe(false) // 并集同、来源不同
    expect(sameActivation(mk(["a/m1"], ["b/m2"]), mk(["a/m1"], ["b/m2"]))).toBe(true)
    const x = mk(["a/m1"], ["b/m2"])
    expect(sameActivation(x, { ...x, generation: 9 })).toBe(true) // generation 不参与
    expect(sameActivation(x, { ...x, configStatus: "empty" as const })).toBe(false)
    expect(sameActivation(x, { ...x, restartRequired: ["newprov"] })).toBe(false)
  })
  function sortUniqueKeys(keys: ModelKey[]): ModelKey[] {
    return [...new Set(keys)].sort() as ModelKey[]
  }
})

// ================= 2.6 legacy 行为基线（复审 P2-8） =================
describe("legacy 行为基线", () => {
  test("默认 lanes 与注入集合=静态 shells.json：六档 lanes ⊆ 清单；injectShells 注入=清单全量", () => {
    const manifest = loadManifest() // 沙箱 state 无自定义 shells.json → 随包静态清单
    expect(manifest.shells.length).toBeGreaterThan(0)
    for (const lane of LANE_ORDER) {
      expect(Array.isArray(manifest.lanes[lane])).toBe(true)
      expect((manifest.lanes[lane] ?? []).length).toBeGreaterThan(0)
      for (const name of manifest.lanes[lane] ?? []) {
        expect(manifest.shells.some((s) => s.name === name)).toBe(true)
      }
    }
    const registry: Record<string, ShellRegEntry> = {}
    for (const s of manifest.shells) registry[s.name] = { ...s, status: "enabled", comboKey: s.matrixKey }
    const cfg: Record<string, any> = {}
    expect(injectShells(cfg, registry)).toBe(manifest.shells.length)
    expect(new Set(Object.keys(cfg.agent))).toEqual(new Set(manifest.shells.map((s) => s.name)))
    const first = cfg.agent[manifest.shells[0]!.name] as any
    expect(first.mode).toBe("subagent")
    expect(typeof first.model).toBe("string") // "provider/modelId" 字符串
  })
})

// ================= 3. 切模 / 删会话 / unreadable =================
describe("会话生命周期与容错", () => {
  test("切模型即时重算：同会话模型变化 → activeModels 跟进、generation+1", () => {
    writeTui([])
    const m = managerOf({ mode: "cli" })
    m.noteChatParams("s1", "build", "glm/glm-5.3")
    const g1 = m.recompute().generation
    expect(m.snapshot().activeModels).toEqual(["glm/glm-5.3"])
    m.noteChatParams("s1", "build", "deepseek/deepseek-v4-pro") // 切模
    const g2 = m.recompute().generation
    expect(g2).toBe(g1 + 1)
    expect(m.snapshot().activeModels).toEqual(["deepseek/deepseek-v4-pro"])
    // 状态等价短路：无变化重算不 bump
    expect(m.recompute().generation).toBe(g2)
  })
  test("session.deleted：移除非壳会话（配置面外时从激活集消失）", () => {
    writeTui([])
    const m = managerOf({ mode: "cli" })
    m.noteChatParams("s1", "build", "glm/glm-5.3")
    m.recompute()
    expect(m.noteSessionDeleted("s1")).toBe(true)
    const st = m.recompute()
    expect(st.activeModels).toEqual([])
    // [2026-09-01]-[空窗期退化：activeModels 为空时 activeShells 退化为全部已注入超集，非空集]
    expect(st.activeShells.length).toBeGreaterThan(0)
  })
  test("壳子代理与内部代理不计入激活矩阵", () => {
    writeTui([])
    const m = managerOf({ mode: "cli" })
    expect(m.noteChatParams("t1", "glm-mx-53-high", "glm/glm-5.3")).toBe(false) // 注入壳名=子代理
    expect(m.noteChatParams("t2", "title", "glm/glm-5.3")).toBe(false)
    expect(m.noteChatParams("t3", "compaction", "glm/glm-5.3")).toBe(false)
    expect(m.noteChatParams("t4", "summary", "glm/glm-5.3")).toBe(false)
    const st = m.recompute()
    expect(st.sessionModels).toEqual([])
    expect(m.isShellSession("t1")).toBe(true)
    expect(m.isShellSession("t2")).toBe(false)
  })
  test("unreadable：文件损坏 → configStatus=unreadable（视为 empty，会话模型仍激活、不 crash）", () => {
    writeFileSync(TUI_MODEL, "{broken json")
    const m = managerOf({ mode: "cli" })
    m.noteChatParams("s1", "build", "glm/glm-5.3")
    const st = m.recompute()
    expect(st.configStatus).toBe("unreadable")
    expect(st.configured).toEqual([])
    expect(st.activeModels).toEqual(["glm/glm-5.3"])
  })
  test("readConfigured：文件缺失=empty（web 版 localStorage 不可见→fail-open 回退）", () => {
    rmSync(TUI_MODEL, { force: true })
    rmSync(DESKTOP_DAT, { force: true })
    expect(readConfigured(stateRoot, "cli")).toEqual({ configStatus: "empty", models: [] })
    expect(readConfigured(stateRoot, "desktop")).toEqual({ configStatus: "empty", models: [] })
  })
})

// ================= 4. 超集生成：去重与稳定命名 =================
describe("超集去重与稳定命名", () => {
  test("同输入两次生成壳名一致；输入顺序打乱命名仍一致（稳定哈希，无遍历序追加）", () => {
    const a = buildShells(SUPerset_MODELS, META as any, { roAliases: true })
    const b = buildShells(SUPerset_MODELS, META as any, { roAliases: true })
    const shuffled = buildShells([...SUPerset_MODELS].reverse(), META as any, { roAliases: true })
    expect(a.map((d) => d.name)).toEqual(b.map((d) => d.name))
    expect(new Set(a.map((d) => d.name))).toEqual(new Set(shuffled.map((d) => d.name)))
  })
  test("输入去重：重复模型只生成一套壳", () => {
    const once = buildShells(["glm/glm-5.3"], META as any)
    const twice = buildShells(["glm/glm-5.3", "glm/glm-5.3"], META as any)
    expect(once.map((d) => d.name)).toEqual(twice.map((d) => d.name))
  })
  test("短名碰撞：全部成员带稳定哈希后缀（顺序无关）", () => {
    const models = ["provA/claude-sonnet-5", "provB/claude-sonnet-5"] // 同 family 同短名、不同 provider
    const fwd = buildShells(models, {} as any)
    const rev = buildShells([...models].reverse(), {} as any)
    expect(new Set(fwd.map((d) => d.name))).toEqual(new Set(rev.map((d) => d.name)))
    const suffixNames = fwd.map((d) => d.name)
    expect(suffixNames.every((n) => /-mx-claude5h[0-9a-z]{4}-off/.test(n))).toBe(true)
    expect(new Set(suffixNames).size).toBe(suffixNames.length)
    expect(stableHash("provA/claude-sonnet-5")).not.toBe(stableHash("provB/claude-sonnet-5"))
  })
  test("-ro 别名壳：与 rw 壳共享 matrixKey（探针组合去重）", () => {
    const defs = buildShells(["glm/glm-5.3"], META as any, { roAliases: true })
    const rw = defs.find((d) => d.name === "glm-mx-53-high")!
    const ro = defs.find((d) => d.name === "glm-mx-53-high-ro")!
    expect(ro.capability).toBe("ro")
    expect(ro.matrixKey).toBe(rw.matrixKey)
  })
})

// ================= 5. 无 models.dev 元数据降级 =================
describe("models.dev 缺元数据降级", () => {
  test("无元数据模型：单档 off + vision=false + family=providerID（fail-open）", () => {
    const defs = buildShells(["someprov/some-model-x"], {}, { degradedFamilyByProvider: true, markDegraded: true })
    expect(defs).toHaveLength(1)
    expect(defs[0].effort).toBe("off")
    expect(defs[0].vision).toBe(false)
    expect(defs[0].family).toBe("someprov")
    expect(defs[0].degraded).toBe(true)
    expect(defs[0].name).toBe("zen-mx-somemodelx-off") // 未知 provider→zen 池（与原 poolOf 一致）
  })
  test("bundledModelIndex：内置 shells.json 可作为档位/视觉回退源", () => {
    const idx = bundledModelIndex()
    const key = Object.keys(idx)[0]!
    expect(idx[key].efforts.length).toBeGreaterThan(0)
    expect(idx[key].toggle).toBe(true) // 内置链含 off 档→可关思考
  })
  // [2026-09-01]-[保底改源：免费判定=OpenCode Zen（models.dev opencode provider）-free 后缀
  //  ∪ big-pickle 特例（官方自研免费模型无后缀）；付费/他池/非对话排除]
  test("freeFloorModels：opencode provider 下 -free 后缀＋big-pickle 特例", () => {
    const idx: Record<string, { efforts: string[]; toggle: boolean; vision: boolean }> = {
      "opencode/ling-3.0-flash-fin-free": { efforts: ["high"], toggle: false, vision: false },
      "opencode/nemotron-3-ultra-free": { efforts: ["high"], toggle: false, vision: false },
      "opencode/mimo-v2.5-free": { efforts: ["high"], toggle: false, vision: false },
      "opencode/big-pickle": { efforts: ["high"], toggle: false, vision: false }, // 特例：无后缀但免费
      "opencode/gpt-5.6-luna": { efforts: ["high"], toggle: false, vision: false }, // 同池付费
      "opencode/muse-spark-1.2": { efforts: ["high"], toggle: false, vision: false }, // 同池付费（非 contributor-free）
      "opencode/x-embedding-free": { efforts: [], toggle: false, vision: false }, // 不可对话
      "zhipuai-coding-plan/glm-5.3": { efforts: ["high"], toggle: false, vision: false }, // 他池
      "zenmux/z-ai/glm-4.7-flash-free": { efforts: ["high"], toggle: false, vision: false }, // 他服务
    }
    expect(freeFloorModels(idx)).toEqual([
      "opencode/big-pickle",
      "opencode/ling-3.0-flash-fin-free",
      "opencode/mimo-v2.5-free",
      "opencode/nemotron-3-ultra-free",
    ])
  })
  test("freeFloorModels：空目录返回空数组（fail-open 回退静态清单路径）", () => {
    expect(freeFloorModels({})).toEqual([])
  })
  // [2026-09-01]-[status=deprecated：已轮换下架的旧免费模型剔除——「今日可用」判定字段]
  test("freeFloorModels：deprecated 旧免费模型剔除（今日可用集）", () => {
    const idx: Record<string, { efforts: string[]; toggle: boolean; vision: boolean; deprecated?: boolean }> = {
      "opencode/mimo-v2.5-free": { efforts: ["high"], toggle: false, vision: false }, // 今日可用
      "opencode/big-pickle": { efforts: ["high"], toggle: false, vision: false }, // 今日可用（特例）
      "opencode/deepseek-v4-flash-free": { efforts: ["high"], toggle: false, vision: false, deprecated: true }, // 已轮换
      "opencode/ling-3.0-flash-free": { efforts: ["high"], toggle: false, vision: false, deprecated: true }, // 已轮换
    }
    expect(freeFloorModels(idx)).toEqual(["opencode/big-pickle", "opencode/mimo-v2.5-free"])
  })
  // [2026-09-01]-[保底主路径：OpenCode Zen 模型 id 无斜杠（mimo-v2.5-free 等）——首斜杠切 provider/modelId]
  test("buildShells：免费保底模型展开正确", () => {
    const defs = buildShells(["opencode/mimo-v2.5-free"], {
      "opencode/mimo-v2.5-free": { efforts: ["high"], toggle: false, vision: false },
    }, { roAliases: true, degradedFamilyByProvider: true, markDegraded: true })
    expect(defs.length).toBe(2) // rw + -ro 别名
    expect(defs[0]).toMatchObject({ provider: "opencode", modelId: "mimo-v2.5-free", effort: "high" })
    expect(defs[0].name).toBe("zen-mx-mimo-high")
    expect(defs[1].name).toBe("zen-mx-mimo-high-ro")
  })
})

// ================= 6. 闸1 三层语义 =================
describe("闸1 三层语义（未注入/同名冲突/未激活）", () => {
  const LANES: Record<string, string[]> = {
    economy: laneBaseChain("economy", { builtin: [], activeShells: new Set(SUP.map((d) => d.name)), shells: attrMap(SUP) }),
    mechanical: laneBaseChain("mechanical", { builtin: [], activeShells: new Set(SUP.map((d) => d.name)), shells: attrMap(SUP) }),
    main: laneBaseChain("main", { builtin: [], activeShells: new Set(SUP.map((d) => d.name)), shells: attrMap(SUP) }),
    hard: laneBaseChain("hard", { builtin: [], activeShells: new Set(SUP.map((d) => d.name)), shells: attrMap(SUP) }),
    vision: laneBaseChain("vision", { builtin: [], activeShells: new Set(SUP.map((d) => d.name)), shells: attrMap(SUP) }),
    review: laneBaseChain("review", { builtin: [], activeShells: new Set(SUP.map((d) => d.name)), shells: attrMap(SUP) }),
  }
  function attrMap(defs: ShellDefinition[]): Map<string, { effort: string; capability: string; vision: boolean; pool: string; modelId: string }> {
    return new Map(defs.map((d) => [d.name, { effort: d.effort, capability: d.capability, vision: d.vision, pool: d.pool, modelId: d.modelId }]))
  }
  function snapOf(over: Partial<GateSnapshot> = {}): GateSnapshot & { lanes: Record<string, string[]> } {
    return {
      registry: registryOf(SUP),
      matrix: matrixOkOf(SUP),
      routing: { down_agents: {}, down_expiry: {} },
      quotaExhausted: {},
      lanes: LANES,
      ...over,
    }
  }
  test("未注入层：壳名形态未注册 → deny（附重启提示与改派候选）；非壳名放行提示", () => {
    expect(shellLikeName("zen-mx-newmodel-high")).toBe(true)
    expect(shellLikeName("my-custom-agent")).toBe(false)
    const msg = denyUninjected("zen-mx-newmodel-high", ["newprov"], "请改派 glm-mx-53-high")
    expect(msg).toContain("未注入壳超集")
    expect(msg).toContain("newprov")
    expect(msg).toContain("重启")
    expect(msg).toContain("请改派 glm-mx-53-high")
    expect(denyUninjected("zen-mx-newmodel-high", [], null)).toContain("若为新增 provider")
  })
  test("同名冲突层：conflicts 命中 → deny", () => {
    const s0 = snapOf({ activation: { enabled: true, activeShells: new Set(SUP.map((d) => d.name)), conflicts: new Set(["glm-mx-53-high"]), restartRequired: [] } })
    const shell = s0.registry!["glm-mx-53-high"]!
    const r = checkShell("glm-mx-53-high", shell, metaOf("main"), s0)
    expect(r.deny).toContain("同名 agent 冲突")
  })
  test("未激活层：注册壳不在激活集 → deny 附激活指引（可见/favorites/切模话术）", () => {
    const activeOnly = new Set(["glm-mx-53-high"]) // 仅一个壳激活
    const s1 = snapOf({ activation: { enabled: true, activeShells: activeOnly, conflicts: new Set(), restartRequired: [] } })
    const shell = s1.registry!["copilot-mx-terra-high"]!
    const r = checkShell("copilot-mx-terra-high", shell, metaOf("main"), s1)
    expect(r.deny).toContain("未激活")
    expect(r.deny).toContain("模型管理")
    // [2026-08-31]-[去厂商化：DS 恒尾删除后 tier 分组主导——S 档 api 壳（ds-v4p）排 A 档订阅壳（glm-53）前]
    expect(r.deny).toContain("请改派 ds-mx-v4p-high")
    // 激活壳放行
    expect(checkShell("glm-mx-53-high", s1.registry!["glm-mx-53-high"]!, metaOf("main"), s1).deny).toBeNull()
  })
  test("restartRequired 提示随未激活 deny 透出", () => {
    const s2 = snapOf({ activation: { enabled: true, activeShells: new Set(["glm-mx-53-high"]), conflicts: new Set(), restartRequired: ["newprov"] } })
    const r = checkShell("copilot-mx-terra-high", s2.registry!["copilot-mx-terra-high"]!, metaOf("main"), s2)
    expect(r.deny).toContain("newprov")
    expect(r.deny).toContain("重启")
  })
  test("activation 缺省（legacy）→ 不做激活门控，注册壳照常走后续闸", () => {
    const s3 = snapOf()
    expect(checkShell("copilot-mx-terra-high", s3.registry!["copilot-mx-terra-high"]!, metaOf("main"), s3).deny).toBeNull()
  })
})

// ================= 7. lane 补齐（仅会话模型场景） =================
describe("lane 补齐策略", () => {
  test("仅会话模型场景：六档全部非空且只含该模型壳；vision 档只含视觉壳", () => {
    // 仅 glm-5.3-flash（视觉模型）在会话中激活
    const defs = buildShells(["glm/glm-5.3-flash"], META as any, { roAliases: true })
    const active = new Set(defs.map((d) => d.name))
    const attrs = new Map(defs.map((d) => [d.name, { effort: d.effort, capability: d.capability, vision: d.vision, pool: d.pool, modelId: d.modelId }]))
    for (const lane of ["economy", "mechanical", "main", "hard", "vision", "review"] as const) {
      const chain = laneBaseChain(lane, { builtin: ["copilot-mx-terra-high"], activeShells: active, shells: attrs })
      expect(chain.length).toBeGreaterThan(0)
      expect(chain.every((n) => active.has(n))).toBe(true) // 内置偏好序引用未激活壳被剔除
    }
    const visionChain = laneBaseChain("vision", { builtin: [], activeShells: active, shells: attrs })
    expect(visionChain.every((n) => attrs.get(n)!.vision)).toBe(true)
    // economy 优先低档、hard 优先高档
    const eco = laneBaseChain("economy", { builtin: [], activeShells: active, shells: attrs })
    expect(eco[0]).toBe("glm-mx-53f-low")
    const hard = laneBaseChain("hard", { builtin: [], activeShells: active, shells: attrs })
    expect(hard[0]).toBe("glm-mx-53f-high") // 该模型最高档
    // review 优先 -ro 别名
    const rev = laneBaseChain("review", { builtin: [], activeShells: active, shells: attrs })
    expect(rev[0].endsWith("-ro")).toBe(true)
  })
})

// ================= 8. 落盘与横幅标注 =================
describe("落盘与横幅标注", () => {
  test("重算落盘 active-matrix.json；model-matrix.json 增 active_keys/target_generation", () => {
    writeTui([{ providerID: "glm", modelID: "glm-5.3" }])
    const m = managerOf({ mode: "cli" })
    m.noteChatParams("s1", "build", "deepseek/deepseek-v4-pro")
    m.recompute()
    const act = readJson<Record<string, any>>(paths().activeMatrix)
    expect(act?.activeModels).toContain("glm/glm-5.3")
    expect(act?.generation).toBeGreaterThan(0)
    const mx = readJson<Record<string, any>>(paths().matrix)!
    expect(Array.isArray(mx?.active_keys)).toBe(true)
    expect(mx.active_keys.length).toBeGreaterThan(0)
    expect(mx.target_generation).toBeGreaterThan(0)
  })
  test("横幅 [限制] 追加 模式/watch/configStatus、restartRequired、降级标注；缺省不变", () => {
    const withInfo = buildBanner({
      lanes: null, down: [],
      quota: { glm: null, copilot: null },
      states: {}, billing: { glmPeak: false, dsPeak: false, glmLabel: "GLM平峰", dsLabel: "DS空闲5折" },
      matrixInfo: { mode: "desktop", configStatus: "ok", watch: true, restartRequired: ["newprov"], degradedModels: 2 },
    })
    expect(withInfo[2]).toContain("矩阵: desktop·watch/ok")
    expect(withInfo[2]).toContain("新 provider newprov 待重启注册")
    expect(withInfo[2]).toContain("2 模型降级单档 off")
    const legacy = buildBanner({
      lanes: null, down: [],
      quota: { glm: null, copilot: null },
      states: {}, billing: { glmPeak: false, dsPeak: false, glmLabel: "GLM平峰", dsLabel: "DS空闲5折" },
    })
    expect(legacy[2]).not.toContain("矩阵:")
  })
})

// ================= 9. watch 集成：临时目录+原子 rename+debounce 重读 =================
describe("watch 集成", async () => {
  await new Promise((r) => setTimeout(r, 30)) // 隔离前置用例的文件态
  test("favorites 原子写入 → debounce 后重算（onRecompute 触发）", async () => {
    rmSync(TUI_MODEL, { force: true })
    rmSync(DESKTOP_DAT, { force: true })
    let recomputed = 0
    const m = new MatrixManager({
      stateRoot, mode: "cli", superset: SUP,
      injectedNames: new Set(SUP.map((d) => d.name)),
      knownProviders: new Set(SUP.map((d) => d.provider)),
      watchEnabled: true, debounceMs: 60, pollMs: 200,
      onRecompute: () => { recomputed++ },
    })
    try {
      m.recompute() // 初始空
      m.start()
      expect(m.snapshot().configStatus).toBe("empty")
      // 原子写入：tmp + rename（模拟 TUI 持久化）
      const tmp = `${TUI_MODEL}.tmp`
      writeFileSync(tmp, JSON.stringify({ recent: [], favorite: [{ providerID: "glm", modelID: "glm-5.3" }], variant: null }))
      const { renameSync } = await import("node:fs")
      renameSync(tmp, TUI_MODEL)
      await new Promise((r) => setTimeout(r, 500))
      expect(recomputed).toBeGreaterThan(0)
      expect(m.snapshot().configStatus).toBe("ok")
      expect(m.snapshot().configured).toEqual(["glm/glm-5.3"])
      expect(m.snapshot().activeShells.length).toBeGreaterThan(0)
    } finally {
      m.stop()
    }
  })
  test("坏 JSON 写入 → unreadable 经重试仍坏 → 不 crash、会话模型兜底", async () => {
    const m = new MatrixManager({
      stateRoot, mode: "cli", superset: SUP,
      injectedNames: new Set(SUP.map((d) => d.name)),
      knownProviders: new Set(SUP.map((d) => d.provider)),
      watchEnabled: true, debounceMs: 60, pollMs: 200,
    })
    try {
      m.noteChatParams("s9", "build", "glm/glm-5.3")
      m.recompute()
      m.start()
      writeFileSync(TUI_MODEL, "{broken") // 非原子损坏写入
      await new Promise((r) => setTimeout(r, 700)) // debounce+重试窗口
      expect(m.snapshot().configStatus).toBe("unreadable")
      expect(m.snapshot().activeModels).toEqual(["glm/glm-5.3"])
    } finally {
      m.stop()
      rmSync(TUI_MODEL, { force: true })
    }
  })
  test("重算触发源透传：直调=startup、会话调度=session、watch/轮询=config（可见集开关/favorites 增删即探依据）", async () => {
    rmSync(TUI_MODEL, { force: true })
    rmSync(DESKTOP_DAT, { force: true })
    const sources: string[] = []
    const m = new MatrixManager({
      stateRoot, mode: "cli", superset: SUP,
      injectedNames: new Set(SUP.map((d) => d.name)),
      knownProviders: new Set(SUP.map((d) => d.provider)),
      watchEnabled: true, debounceMs: 60, pollMs: 200,
      onRecompute: (_s, _t, source) => { sources.push(source) },
    })
    try {
      m.noteChatParams("s7", "build", "glm/glm-5.3") // 预注册，避免首轮空状态等价短路
      m.recompute() // config 钩子直调 → startup
      expect(sources).toEqual(["startup"])
      // session 源断言放在 start() 前：macOS fs.watch 建立后会补投历史目录事件，污染触发源
      m.noteChatParams("s8", "build", "deepseek/deepseek-v4-pro") // 会话模型变化，确保非短路
      m.scheduleRecompute(50, "session")
      await new Promise((r) => setTimeout(r, 150))
      expect(sources).toEqual(["startup", "session"])
      m.start()
      // favorites 写入（TUI 持久化）→ watch/mtime 轮询 → config
      writeFileSync(TUI_MODEL, JSON.stringify({ recent: [], favorite: [{ providerID: "glm", modelID: "glm-5.3" }], variant: null }))
      await new Promise((r) => setTimeout(r, 500))
      expect(sources).toContain("config")
    } finally {
      m.stop()
      rmSync(TUI_MODEL, { force: true })
    }
  })
})

beforeAll(() => {
  mkdirSync(paths().dir, { recursive: true })
  if (!existsSync(paths().dir)) throw new Error("state dir missing")
})
