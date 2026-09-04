// [2026-09-04]-[English localization: translate test names and comments; assertions against out-of-scope modules (gates.ts/banner.ts) kept verbatim; no test-logic change]
// Dynamic activation matrix behavior contract (v1.3; bun test)
// Covers: mode detection and empty-set fallback, configured∪sessionModels union, model switch/session deletion, unreadable fallback,
//         superset dedupe and stable naming, degraded without models.dev metadata, gate-1 three-layer semantics, lane completion, watch integration (atomic rename+debounce)
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

// ---- Sandbox ----
// [2026-08-29]-[Fix review P1 dual-root paths: layout matches the real shapes — stateHome=XDG_STATE_HOME (desktop=userData),
// stateRoot=stateHome/opencode; opencode.global.dat sits at the stateHome root, model.json inside stateRoot]
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
  return `ROUTE_META {"lane":"${lane}","role":"programmer","producer_family":"glm","capability":"rw","modality":"text","source":"auto"}\nTask`
}

// ================= 1. mode detection and empty-set fallback =================
describe("mode detection and empty-set fallback", () => {
  test("auto: OPENCODE_CLIENT=desktop→desktop; otherwise→cli; forced override wins", () => {
    expect(detectMode("auto", "desktop")).toBe("desktop")
    expect(detectMode("auto", undefined)).toBe("cli")
    expect(detectMode("auto", "tui")).toBe("cli")
    expect(detectMode("app", undefined)).toBe("desktop") // forced desktop semantics
    expect(detectMode("tui", "desktop")).toBe("cli") // forced override beats client detection
    expect(detectMode("legacy", "desktop")).toBe("legacy")
  })
  test("no visible/favorites (empty set) → unconfigured visible set defaults to the full superset dispatchable (not narrowed by session models)", () => {
    writeTui([]) // cli mode has no favorites
    const m = managerOf({ mode: "cli" })
    m.noteChatParams("s1", "build", "glm/glm-5.3")
    const st = m.recompute()
    expect(st.configStatus).toBe("empty")
    expect(st.activeModels).toEqual(["glm/glm-5.3"])
    // [2026-09-01]-[no visible set = no restriction: activeShells covers the entire superset, not just the glm-5.3 tier]
    expect(st.activeShells.some((n) => n.startsWith("ds-mx-") || n.startsWith("copilot-mx-"))).toBe(true)
  })
  test("desktop with no visible items (all hide) → also falls back to session models", () => {
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

// ================= 2. File parsing and union =================
describe("config-surface parsing and union", () => {
  test("desktop opencode.global.dat: only visibility=show; the model field may be a JSON string", () => {
    writeDesktop([
      { providerID: "glm", modelID: "glm-5.3", visibility: "show" },
      { providerID: "deepseek", modelID: "deepseek-v4-pro", visibility: "hide" },
      { providerID: "github-copilot", modelID: "gpt-5.6-terra", visibility: "show", favorite: true },
    ])
    expect(parseDesktopModels(JSON.parse(require("node:fs").readFileSync(DESKTOP_DAT, "utf8"))))
      .toEqual(["github-copilot/gpt-5.6-terra", "glm/glm-5.3"])
    // stringified model (serialized form at the persist layer)
    const strWrapped = { model: JSON.stringify({ user: [{ providerID: "glm", modelID: "glm-5.3", visibility: "show" }] }) }
    expect(parseDesktopModels(strWrapped)).toEqual(["glm/glm-5.3"])
    expect(parseDesktopModels({ model: { user: "not-array" } })).toBeNull()
  })
  test("TUI model.json: favorite set parsing; bad structure = null", () => {
    expect(parseTuiFavorites({ favorite: [{ providerID: "glm", modelID: "glm-5.3" }], recent: [] })).toEqual(["glm/glm-5.3"])
    expect(parseTuiFavorites({ recent: [] })).toBeNull()
    expect(parseTuiFavorites("{broken" as unknown)).toBeNull()
  })
  test("configured ∪ sessionModels union (multi-session union, including session models outside the config surface but inside the superset)", () => {
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
  test("provider outside the superset → restartRequired deduped", () => {
    writeTui([])
    const m = managerOf({ mode: "cli" })
    m.noteChatParams("s1", "build", "newprov/model-a")
    m.noteChatParams("s2", "build", "newprov/model-b")
    const st = m.recompute()
    expect(st.restartRequired).toEqual(["newprov"])
  })
})

// ================= 2.5 Delta review P1 fixes: shape contracts and first-round timing =================
describe("delta review P1 fixes: provider.list response shape normalization", () => {
  test("hey-api wrapper shape {data:{all,connected,default}} → unwrap .data first, then take all/connected", () => {
    const resp = { data: { all: [{ id: "glm", models: { "glm-5.3": {} } }], connected: ["glm"], default: {} } }
    const r = normalizeProviderListResponse(resp)
    expect(r).not.toBeNull()
    expect(r!.providers.map((p: any) => p.id)).toEqual(["glm"])
    expect(r!.connected!.has("glm")).toBe(true)
  })
  test("direct shape {all,connected} and bare-array fallback", () => {
    const direct = { all: [{ id: "deepseek", models: { "deepseek-v4-pro": {} } }], connected: ["deepseek"] }
    expect(normalizeProviderListResponse(direct)!.connected!.has("deepseek")).toBe(true)
    const bare = [{ id: "x", models: {} }]
    expect(normalizeProviderListResponse(bare)!.connected).toBeNull()
  })
  test("unrecognizable shape → null (triggers the cfg.provider fallback)", () => {
    expect(normalizeProviderListResponse({ foo: 1 })).toBeNull()
    expect(normalizeProviderListResponse(undefined)).toBeNull()
  })
})

describe("review P1 fixes (shape contracts / first-round timing / dual-root paths / full-field equivalence)", () => {
  test("chat.params real shape: model is a Model object (providerID/id), provider is an object → modelKey=providerID/id", () => {
    // Contract: clone plugin/src/index.ts:248 model: Model (schema/src/model.ts:16 providerID + id); provider: ProviderContext
    expect(chatParamsModelKey({
      sessionID: "s1", agent: "build",
      model: { providerID: "glm", id: "glm-5.3", name: "GLM 5.3", capabilities: {} },
      provider: { id: "glm", name: "Zhipu" },
      message: {},
    })).toBe("glm/glm-5.3")
    expect(chatParamsModelKey({ model: { id: "x" } })).toBeNull() // providerID missing
    expect(chatParamsModelKey({})).toBeNull()
  })
  test("session.deleted shape: properties.info.id first; .sessionID/.session.id fallback chain", () => {
    // Contract: clone sdk types.gen.ts:576-580 properties={info: Session}
    expect(sessionDeletedId({ info: { id: "s1", agent: "build" } })).toBe("s1")
    expect(sessionDeletedId({ sessionID: "s2" })).toBe("s2")
    expect(sessionDeletedId({ session: { id: "s3" } })).toBe("s3")
    expect(sessionDeletedId({ info: {} })).toBeNull()
    expect(sessionDeletedId(null)).toBeNull()
  })
  test("session.created shape: properties.info={id,agent}; agent missing = no pre-registration", () => {
    expect(sessionCreatedInfo({ info: { id: "s1", agent: "build" } })).toEqual({ id: "s1", agent: "build" })
    expect(sessionCreatedInfo({ info: { id: "s1" } })).toBeNull()
    expect(sessionCreatedInfo(undefined)).toBeNull()
  })
  test("first-round timing: session.created pre-registration → transform's first round (chat.params not yet arrived) can already classify; custom subagents treated as main sessions", () => {
    writeTui([])
    const m = managerOf({ mode: "cli" })
    m.noteSessionCreated("t1", "glm-mx-53-high") // shell subagent pre-registered
    m.noteSessionCreated("t2", "title") // internal agent
    m.noteSessionCreated("s1", "build") // main session
    m.noteSessionCreated("s2", "my-custom-subagent") // user-defined subagent → treated as main session
    expect(m.skipSystemInjection("t1")).toBe(true)
    expect(m.skipSystemInjection("t2")).toBe(true)
    expect(m.skipSystemInjection("s1")).toBe(false)
    expect(m.skipSystemInjection("s2")).toBe(false)
    expect(m.skipSystemInjection("unknown")).toBe(false)
    // Pre-registration carries no model → not counted in the activation matrix; counted once chat.params arrives (custom subagents included)
    expect(m.recompute().sessionModels).toEqual([])
    expect(m.noteChatParams("s1", "build", "glm/glm-5.3")).toBe(true)
    expect(m.noteChatParams("s2", "my-custom-subagent", "deepseek/deepseek-v4-pro")).toBe(true)
    expect(m.recompute().sessionModels).toEqual(["deepseek/deepseek-v4-pro", "glm/glm-5.3"])
  })
  test("chat.params classification: injected shell name → isShell registers but not counted; internal agents → not registered; unchanged model → no recompute", () => {
    writeTui([])
    const m = managerOf({ mode: "cli" })
    const shellName = SUP[0]!.name
    expect(m.noteChatParams("t1", shellName, "glm/glm-5.3")).toBe(false)
    expect(m.isShellSession("t1")).toBe(true)
    expect(m.noteChatParams("t2", "title", "glm/glm-5.3")).toBe(false)
    expect(m.sessions.has("t2")).toBe(false)
    expect([...INTERNAL_AGENTS].sort()).toEqual(["compaction", "summary", "title"])
    expect(m.noteChatParams("s1", "build", "glm/glm-5.3")).toBe(true)
    expect(m.noteChatParams("s1", "build", "glm/glm-5.3")).toBe(false) // same model repeated → no recompute
  })
  test("desktop dual-root paths: global.dat in stateRoot's parent dir (userData); CLI reads stateRoot/model.json only", () => {
    expect(desktopDatPath(stateRoot)).toBe(DESKTOP_DAT)
    expect(tuiModelPath(stateRoot)).toBe(TUI_MODEL)
    rmSync(DESKTOP_DAT, { force: true })
    rmSync(TUI_MODEL, { force: true })
    writeFileSync(DESKTOP_DAT, JSON.stringify({ model: { user: [{ providerID: "glm", modelID: "glm-5.3", visibility: "show" }] } }))
    expect(readConfigured(stateRoot, "desktop")).toEqual({ configStatus: "ok", models: ["glm/glm-5.3"] })
    expect(readConfigured(stateRoot, "cli")).toEqual({ configStatus: "empty", models: [] })
  })
  test("desktop duplicate models: hide overrides show (aggregated by providerID/modelID, any non-show excludes)", () => {
    expect(parseDesktopModels({ model: { user: [
      { providerID: "glm", modelID: "glm-5.3", visibility: "show" },
      { providerID: "glm", modelID: "glm-5.3", visibility: "hide" }, // duplicate entry hide → excluded
      { providerID: "deepseek", modelID: "deepseek-v4-pro", visibility: "show" },
      { providerID: "deepseek", modelID: "deepseek-v4-pro", visibility: "show" }, // double show → kept
    ] } })).toEqual(["deepseek/deepseek-v4-pro"])
  })
  test("only invalid favorites: no narrowing, keeps all injected shells and flags the dirty config", () => {
    const shells = new Map<ModelKey, any[]>([["glm/glm-5.3", [{ name: "glm-mx-53-high" }]]])
    const state = computeActivation({
      generation: 1, mode: "cli", configStatus: "ok",
      configured: ["glm/not-a-model"], sessionModels: [], shellsByModel: shells,
      knownProviders: new Set(["glm"]),
    })
    expect(state.activeShells).toEqual(["glm-mx-53-high"])
    expect(state.invalidConfigured).toEqual(["glm/not-a-model"])
  })
  test("sameActivation full-field: equal unions but swapped configured/sessionModels → not equivalent (the post-switch snapshot must reflect the new session info)", () => {
    const mk = (configured: ModelKey[], sessionModels: ModelKey[]) => ({
      generation: 1, mode: "cli" as const, configStatus: "ok" as const,
      configured, sessionModels,
      activeModels: sortUniqueKeys([...configured, ...sessionModels]),
      activeShells: ["glm-mx-53-high"], restartRequired: [], invalidConfigured: [],
    })
    expect(sameActivation(mk(["a/m1"], ["b/m2"]), mk(["b/m2"], ["a/m1"]))).toBe(false) // same union, different sources
    expect(sameActivation(mk(["a/m1"], ["b/m2"]), mk(["a/m1"], ["b/m2"]))).toBe(true)
    const x = mk(["a/m1"], ["b/m2"])
    expect(sameActivation(x, { ...x, generation: 9 })).toBe(true) // generation not part of equivalence
    expect(sameActivation(x, { ...x, configStatus: "empty" as const })).toBe(false)
    expect(sameActivation(x, { ...x, restartRequired: ["newprov"] })).toBe(false)
  })
  function sortUniqueKeys(keys: ModelKey[]): ModelKey[] {
    return [...new Set(keys)].sort() as ModelKey[]
  }
})

// ================= 2.6 Legacy behavior baseline (review P2-8) =================
describe("legacy behavior baseline", () => {
  test("default lanes and the injection set = static shells.json: six lanes ⊆ manifest; injectShells injects the full manifest", () => {
    const manifest = loadManifest() // sandboxed state has no custom shells.json → bundled static manifest
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
    expect(typeof first.model).toBe("string") // "provider/modelId" string
  })
})

// ================= 3. Model switch / session deletion / unreadable =================
describe("session lifecycle and fault tolerance", () => {
  test("model switch recomputes immediately: same-session model change → activeModels follows, generation+1", () => {
    writeTui([])
    const m = managerOf({ mode: "cli" })
    m.noteChatParams("s1", "build", "glm/glm-5.3")
    const g1 = m.recompute().generation
    expect(m.snapshot().activeModels).toEqual(["glm/glm-5.3"])
    m.noteChatParams("s1", "build", "deepseek/deepseek-v4-pro") // model switch
    const g2 = m.recompute().generation
    expect(g2).toBe(g1 + 1)
    expect(m.snapshot().activeModels).toEqual(["deepseek/deepseek-v4-pro"])
    // state-equivalence short circuit: no-change recompute does not bump
    expect(m.recompute().generation).toBe(g2)
  })
  test("session.deleted: removes a non-shell session (disappears from the activation set when outside the config surface)", () => {
    writeTui([])
    const m = managerOf({ mode: "cli" })
    m.noteChatParams("s1", "build", "glm/glm-5.3")
    m.recompute()
    expect(m.noteSessionDeleted("s1")).toBe(true)
    const st = m.recompute()
    expect(st.activeModels).toEqual([])
    // [2026-09-01]-[gap-window degradation: when activeModels is empty, activeShells degrades to the full injected superset, not an empty set]
    expect(st.activeShells.length).toBeGreaterThan(0)
  })
  test("shell subagents and internal agents are not counted in the activation matrix", () => {
    writeTui([])
    const m = managerOf({ mode: "cli" })
    expect(m.noteChatParams("t1", "glm-mx-53-high", "glm/glm-5.3")).toBe(false) // injected shell name = subagent
    expect(m.noteChatParams("t2", "title", "glm/glm-5.3")).toBe(false)
    expect(m.noteChatParams("t3", "compaction", "glm/glm-5.3")).toBe(false)
    expect(m.noteChatParams("t4", "summary", "glm/glm-5.3")).toBe(false)
    const st = m.recompute()
    expect(st.sessionModels).toEqual([])
    expect(m.isShellSession("t1")).toBe(true)
    expect(m.isShellSession("t2")).toBe(false)
  })
  test("unreadable: corrupted file → configStatus=unreadable (treated as empty, session models still active, no crash)", () => {
    writeFileSync(TUI_MODEL, "{broken json")
    const m = managerOf({ mode: "cli" })
    m.noteChatParams("s1", "build", "glm/glm-5.3")
    const st = m.recompute()
    expect(st.configStatus).toBe("unreadable")
    expect(st.configured).toEqual([])
    expect(st.activeModels).toEqual(["glm/glm-5.3"])
  })
  test("readConfigured: missing file = empty (web localStorage not visible → fail-open fallback)", () => {
    rmSync(TUI_MODEL, { force: true })
    rmSync(DESKTOP_DAT, { force: true })
    expect(readConfigured(stateRoot, "cli")).toEqual({ configStatus: "empty", models: [] })
    expect(readConfigured(stateRoot, "desktop")).toEqual({ configStatus: "empty", models: [] })
  })
})

// ================= 4. Superset generation: dedupe and stable naming =================
describe("superset dedupe and stable naming", () => {
  test("same input twice yields identical shell names; shuffled input order still yields identical names (stable hash, no traversal-order suffix)", () => {
    const a = buildShells(SUPerset_MODELS, META as any, { roAliases: true })
    const b = buildShells(SUPerset_MODELS, META as any, { roAliases: true })
    const shuffled = buildShells([...SUPerset_MODELS].reverse(), META as any, { roAliases: true })
    expect(a.map((d) => d.name)).toEqual(b.map((d) => d.name))
    expect(new Set(a.map((d) => d.name))).toEqual(new Set(shuffled.map((d) => d.name)))
  })
  test("input dedupe: duplicate models produce one set of shells", () => {
    const once = buildShells(["glm/glm-5.3"], META as any)
    const twice = buildShells(["glm/glm-5.3", "glm/glm-5.3"], META as any)
    expect(once.map((d) => d.name)).toEqual(twice.map((d) => d.name))
  })
  test("short-name collision: all members get stable hash suffixes (order-independent)", () => {
    const models = ["provA/claude-sonnet-5", "provB/claude-sonnet-5"] // same family same short name, different providers
    const fwd = buildShells(models, {} as any)
    const rev = buildShells([...models].reverse(), {} as any)
    expect(new Set(fwd.map((d) => d.name))).toEqual(new Set(rev.map((d) => d.name)))
    const suffixNames = fwd.map((d) => d.name)
    expect(suffixNames.every((n) => /-mx-claude5h[0-9a-z]{4}-off/.test(n))).toBe(true)
    expect(new Set(suffixNames).size).toBe(suffixNames.length)
    expect(stableHash("provA/claude-sonnet-5")).not.toBe(stableHash("provB/claude-sonnet-5"))
  })
  test("-ro alias shells: share the matrixKey with the rw shells (probe-combo dedupe)", () => {
    const defs = buildShells(["glm/glm-5.3"], META as any, { roAliases: true })
    const rw = defs.find((d) => d.name === "glm-mx-53-high")!
    const ro = defs.find((d) => d.name === "glm-mx-53-high-ro")!
    expect(ro.capability).toBe("ro")
    expect(ro.matrixKey).toBe(rw.matrixKey)
  })
})

// ================= 5. Degraded without models.dev metadata =================
describe("models.dev missing-metadata degradation", () => {
  test("model without metadata: single off tier + vision=false + family=providerID (fail-open)", () => {
    const defs = buildShells(["someprov/some-model-x"], {}, { degradedFamilyByProvider: true, markDegraded: true })
    expect(defs).toHaveLength(1)
    expect(defs[0].effort).toBe("off")
    expect(defs[0].vision).toBe(false)
    expect(defs[0].family).toBe("someprov")
    expect(defs[0].degraded).toBe(true)
    expect(defs[0].name).toBe("zen-mx-somemodelx-off") // unknown provider → zen pool (consistent with the original poolOf)
  })
  test("bundledModelIndex: the builtin shells.json serves as a tier/vision fallback source", () => {
    const idx = bundledModelIndex()
    const key = Object.keys(idx)[0]!
    expect(idx[key].efforts.length).toBeGreaterThan(0)
    expect(idx[key].toggle).toBe(true) // the builtin chain includes the off tier → thinking can be toggled off
  })
  // [2026-09-01]-[free-floor source change: free = OpenCode Zen (models.dev opencode provider) -free suffix
  //  ∪ the big-pickle special case (official in-house free model without suffix); paid/other pools/non-chat excluded]
  test("freeFloorModels: -free suffix under the opencode provider + the big-pickle special case", () => {
    const idx: Record<string, { efforts: string[]; toggle: boolean; vision: boolean }> = {
      "opencode/ling-3.0-flash-fin-free": { efforts: ["high"], toggle: false, vision: false },
      "opencode/nemotron-3-ultra-free": { efforts: ["high"], toggle: false, vision: false },
      "opencode/mimo-v2.5-free": { efforts: ["high"], toggle: false, vision: false },
      "opencode/big-pickle": { efforts: ["high"], toggle: false, vision: false }, // special case: no suffix but free
      "opencode/gpt-5.6-luna": { efforts: ["high"], toggle: false, vision: false }, // same pool, paid
      "opencode/muse-spark-1.2": { efforts: ["high"], toggle: false, vision: false }, // same pool, paid (not contributor-free)
      "opencode/x-embedding-free": { efforts: [], toggle: false, vision: false }, // non-chat
      "zhipuai-coding-plan/glm-5.3": { efforts: ["high"], toggle: false, vision: false }, // other pool
      "zenmux/z-ai/glm-4.7-flash-free": { efforts: ["high"], toggle: false, vision: false }, // other service
    }
    expect(freeFloorModels(idx)).toEqual([
      "opencode/big-pickle",
      "opencode/ling-3.0-flash-fin-free",
      "opencode/mimo-v2.5-free",
      "opencode/nemotron-3-ultra-free",
    ])
  })
  test("freeFloorModels: empty directory returns an empty array (fail-open to the static manifest path)", () => {
    expect(freeFloorModels({})).toEqual([])
  })
  // [2026-09-01]-[status=deprecated: rotated-out old free models are removed — the "available today" field]
  test("freeFloorModels: deprecated old free models removed (available-today set)", () => {
    const idx: Record<string, { efforts: string[]; toggle: boolean; vision: boolean; deprecated?: boolean }> = {
      "opencode/mimo-v2.5-free": { efforts: ["high"], toggle: false, vision: false }, // available today
      "opencode/big-pickle": { efforts: ["high"], toggle: false, vision: false }, // available today (special case)
      "opencode/deepseek-v4-flash-free": { efforts: ["high"], toggle: false, vision: false, deprecated: true }, // rotated out
      "opencode/ling-3.0-flash-free": { efforts: ["high"], toggle: false, vision: false, deprecated: true }, // rotated out
    }
    expect(freeFloorModels(idx)).toEqual(["opencode/big-pickle", "opencode/mimo-v2.5-free"])
  })
  // [2026-09-01]-[free-floor main path: OpenCode Zen model ids have no slash (mimo-v2.5-free etc.) — first slash splits provider/modelId]
  test("buildShells: free-floor models expand correctly", () => {
    const defs = buildShells(["opencode/mimo-v2.5-free"], {
      "opencode/mimo-v2.5-free": { efforts: ["high"], toggle: false, vision: false },
    }, { roAliases: true, degradedFamilyByProvider: true, markDegraded: true })
    expect(defs.length).toBe(2) // rw + -ro alias
    expect(defs[0]).toMatchObject({ provider: "opencode", modelId: "mimo-v2.5-free", effort: "high" })
    expect(defs[0].name).toBe("zen-mx-mimo-high")
    expect(defs[1].name).toBe("zen-mx-mimo-high-ro")
  })
})

// ================= 6. Gate-1 three-layer semantics =================
describe("gate-1 three-layer semantics (uninjected / same-name conflict / not activated)", () => {
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
  test("uninjected layer: shell-shaped name not registered → deny (with restart hint and redirect candidates); non-shell names pass with a hint", () => {
    expect(shellLikeName("zen-mx-newmodel-high")).toBe(true)
    expect(shellLikeName("my-custom-agent")).toBe(false)
    // deny copy produced by src/gates.ts (translated by the parallel workstream; expectations synced to its English copy)
    const msg = denyUninjected("zen-mx-newmodel-high", ["newprov"], "redirect to glm-mx-53-high")
    expect(msg).toContain("not injected into the shell superset")
    expect(msg).toContain("newprov")
    expect(msg).toContain("restart")
    expect(msg).toContain("redirect to glm-mx-53-high")
    expect(denyUninjected("zen-mx-newmodel-high", [], null)).toContain("if this is a new provider")
  })
  test("same-name conflict layer: conflicts hit → deny", () => {
    const s0 = snapOf({ activation: { enabled: true, activeShells: new Set(SUP.map((d) => d.name)), conflicts: new Set(["glm-mx-53-high"]), restartRequired: [] } })
    const shell = s0.registry!["glm-mx-53-high"]!
    const r = checkShell("glm-mx-53-high", shell, metaOf("main"), s0)
    expect(r.deny).toContain("conflicts with a user-defined agent of the same name") // src/gates.ts, out of scope
  })
  test("not-activated layer: registered shell not in the activation set → deny with activation guidance (visible/favorites/model-switch copy)", () => {
    // [2026-09-02 official index recalibration]-[the main chain's only member = ds-mx-v4p-high (B=L3 main slot); the activation set = chain members;
    //  the same snapshot covers both "off-chain shell denied as not activated" and "in-chain shell allowed"]
    const activeOnly = new Set(["ds-mx-v4p-high"])
    const s1 = snapOf({ activation: { enabled: true, activeShells: activeOnly, conflicts: new Set(), restartRequired: [] } })
    const shell = s1.registry!["copilot-mx-terra-high"]!
    const r = checkShell("copilot-mx-terra-high", shell, metaOf("main"), s1)
    expect(r.deny).toContain("not activated") // src/gates.ts, out of scope
    expect(r.deny).toContain("model management") // src/gates.ts, out of scope
    // [2026-09-02 official index recalibration]-[terra = the A-tier fallback shell; under same-tier priority the B-tier main slot ds-v4p is in the chain so terra is switched out;
    //  chain head = ds-v4p, and the redirect suggestion points at the chain head accordingly]
    expect(r.deny).toContain("redirect to ds-mx-v4p-high")
    // Active shell allowed ([2026-09-02 official index recalibration] ds-v4p = B = L3 main slot in chain; under same-tier priority the A-tier fallback shell does not enter the main chain)
    expect(checkShell("ds-mx-v4p-high", s1.registry!["ds-mx-v4p-high"]!, metaOf("main"), s1).deny).toBeNull()
  })
  test("restartRequired hints surface with the not-activated deny", () => {
    const s2 = snapOf({ activation: { enabled: true, activeShells: new Set(["glm-mx-53-high"]), conflicts: new Set(), restartRequired: ["newprov"] } })
    const r = checkShell("copilot-mx-terra-high", s2.registry!["copilot-mx-terra-high"]!, metaOf("main"), s2)
    expect(r.deny).toContain("newprov")
    expect(r.deny).toContain("restart") // src/gates.ts, out of scope
  })
  test("activation absent (legacy) → no activation gating; registered shells proceed through the remaining gates as usual", () => {
    const s3 = snapOf()
    // [2026-09-02 official index recalibration]-[the in-chain allow assertion uses the main-slot member ds-mx-v4p-high (under same-tier priority the A-tier shell does not enter the main chain)]
    expect(checkShell("ds-mx-v4p-high", s3.registry!["ds-mx-v4p-high"]!, metaOf("main"), s3).deny).toBeNull()
  })
})

// ================= 7. Lane completion (session-models-only scenario) =================
describe("lane completion policy", () => {
  test("session-models-only scenario: all six lanes non-empty and contain only that model's shells; the vision lane only vision shells", () => {
    // only glm-5.3-flash (a vision model) active in the session
    const defs = buildShells(["glm/glm-5.3-flash"], META as any, { roAliases: true })
    const active = new Set(defs.map((d) => d.name))
    const attrs = new Map(defs.map((d) => [d.name, { effort: d.effort, capability: d.capability, vision: d.vision, pool: d.pool, modelId: d.modelId }]))
    for (const lane of ["economy", "mechanical", "main", "hard", "vision", "review"] as const) {
      const chain = laneBaseChain(lane, { builtin: ["copilot-mx-terra-high"], activeShells: active, shells: attrs })
      expect(chain.length).toBeGreaterThan(0)
      expect(chain.every((n) => active.has(n))).toBe(true) // builtin preference-order references to inactive shells are dropped
    }
    const visionChain = laneBaseChain("vision", { builtin: [], activeShells: active, shells: attrs })
    expect(visionChain.every((n) => attrs.get(n)!.vision)).toBe(true)
    // economy prefers low tiers, hard prefers high tiers
    const eco = laneBaseChain("economy", { builtin: [], activeShells: active, shells: attrs })
    expect(eco[0]).toBe("glm-mx-53f-low")
    const hard = laneBaseChain("hard", { builtin: [], activeShells: active, shells: attrs })
    expect(hard[0]).toBe("glm-mx-53f-high") // the model's highest tier
    // review prefers the -ro alias
    const rev = laneBaseChain("review", { builtin: [], activeShells: active, shells: attrs })
    expect(rev[0].endsWith("-ro")).toBe(true)
  })
})

// ================= 8. Persistence and banner annotation =================
describe("persistence and banner annotation", () => {
  test("recompute persists active-matrix.json; model-matrix.json gains active_keys/target_generation", () => {
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
  test("the [LIMITS] banner line appends mode/watch/configStatus, restartRequired and degraded annotations; absent = unchanged", () => {
    // banner copy produced by src/banner.ts (translated by the parallel workstream; expectations synced to its English copy)
    const withInfo = buildBanner({
      lanes: null, down: [],
      quota: { glm: null, copilot: null },
      states: {}, billing: { glmPeak: false, dsPeak: false, glmLabel: "GLM off-peak", dsLabel: "DS idle 50%" },
      matrixInfo: { mode: "desktop", configStatus: "ok", watch: true, restartRequired: ["newprov"], degradedModels: 2 },
    })
    expect(withInfo[2]).toContain("matrix: desktop·watch/ok")
    expect(withInfo[2]).toContain("new provider(s) newprov pending restart to register")
    expect(withInfo[2]).toContain("2 models degraded one effort off")
    const legacy = buildBanner({
      lanes: null, down: [],
      quota: { glm: null, copilot: null },
      states: {}, billing: { glmPeak: false, dsPeak: false, glmLabel: "GLM off-peak", dsLabel: "DS idle 50%" },
    })
    expect(legacy[2]).not.toContain("matrix:")
  })
})

// ================= 9. Watch integration: temp dir + atomic rename + debounce re-read =================
describe("watch integration", async () => {
  await new Promise((r) => setTimeout(r, 30)) // isolate the file state from preceding cases
  test("favorites atomic write → recompute after debounce (onRecompute fired)", async () => {
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
      m.recompute() // initially empty
      m.start()
      expect(m.snapshot().configStatus).toBe("empty")
      // atomic write: tmp + rename (simulating TUI persistence)
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
  test("bad JSON written → unreadable even after retries → no crash, session models as fallback", async () => {
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
      writeFileSync(TUI_MODEL, "{broken") // non-atomic corrupted write
      await new Promise((r) => setTimeout(r, 700)) // debounce + retry window
      expect(m.snapshot().configStatus).toBe("unreadable")
      expect(m.snapshot().activeModels).toEqual(["glm/glm-5.3"])
    } finally {
      m.stop()
      rmSync(TUI_MODEL, { force: true })
    }
  })
  test("recompute trigger-source pass-through: direct call=startup, session dispatch=session, watch/poll=config (the basis for visible-set toggle/favorites add-remove probes)", async () => {
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
      m.noteChatParams("s7", "build", "glm/glm-5.3") // pre-register, avoiding the first-round empty-state equivalence short circuit
      m.recompute() // config hook direct call → startup
      expect(sources).toEqual(["startup"])
      // the session-source assertion is placed before start(): once established, macOS fs.watch replays historical directory events, polluting the trigger source
      m.noteChatParams("s8", "build", "deepseek/deepseek-v4-pro") // session model change, ensuring no short circuit
      m.scheduleRecompute(50, "session")
      await new Promise((r) => setTimeout(r, 150))
      expect(sources).toEqual(["startup", "session"])
      m.start()
      // favorites write (TUI persistence) → watch/mtime polling → config
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
