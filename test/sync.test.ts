import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { desktopDatPath, parseDesktopModels, parseTuiFavorites, tuiModelPath } from "../src/activation"
import { REAL_FAIL_TTL_MS, isRealFailedCombo, markRealFailure, realFailedComboKeys } from "../src/breaker"
import { checkShell } from "../src/gates"
import { syncIfDiverged } from "../src/sync"
import { MatrixManager } from "../src/matrix-manager"
import type { ShellRegEntry } from "../src/types"

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "switchman-sync-"))
  const root = join(home, "opencode")
  mkdirSync(root)
  return { root, desktop: desktopDatPath(root), tui: tuiModelPath(root) }
}
function desktop(user: unknown[], extra: Record<string, unknown> = {}) {
  return { ...extra, model: { user, recent: ["keep"], variant: "keep" } }
}

describe("可见性与 favorites 同步", () => {
  test("desktop 较新时镜像 favorites，保留 TUI 未知键", () => {
    const p = sandbox()
    writeFileSync(p.desktop, JSON.stringify(desktop([{ providerID: "glm", modelID: "a", visibility: "show" }], { desktopUnknown: true })))
    writeFileSync(p.tui, JSON.stringify({ favorite: [{ providerID: "x", modelID: "old" }], recent: ["r"], variant: "v", tuiUnknown: true }))
    utimesSync(p.desktop, new Date(), new Date(Date.now() + 1_000))
    syncIfDiverged(p.root, "desktop")
    const tui = JSON.parse(readFileSync(p.tui, "utf8"))
    expect(parseTuiFavorites(tui)).toEqual(["glm/a"])
    expect(tui.tuiUnknown).toBe(true)
    expect(tui.recent).toEqual(["r"])
  })
  test("TUI 较新时镜像 desktop，保留顶层与 model 元数据", () => {
    const p = sandbox()
    writeFileSync(p.desktop, JSON.stringify(desktop([{ providerID: "x", modelID: "old", visibility: "show", extra: 1 }], { desktopUnknown: true })))
    writeFileSync(p.tui, JSON.stringify({ favorite: [{ providerID: "glm", modelID: "a" }, { providerID: "ds", modelID: "b" }], tuiUnknown: true }))
    utimesSync(p.tui, new Date(), new Date(Date.now() + 1_000))
    syncIfDiverged(p.root, "cli")
    const dat = JSON.parse(readFileSync(p.desktop, "utf8"))
    expect(parseDesktopModels(dat)).toEqual(["ds/b", "glm/a"])
    expect(dat.desktopUnknown).toBe(true)
    expect(dat.model.recent).toEqual(["keep"])
    expect(dat.model.user[0].extra).toBe(1)
  })
  test("集合相同不写入", () => {
    const p = sandbox()
    writeFileSync(p.desktop, JSON.stringify(desktop([{ providerID: "glm", modelID: "a", visibility: "show" }])))
    writeFileSync(p.tui, JSON.stringify({ favorite: [{ providerID: "glm", modelID: "a" }] }))
    const before = readFileSync(p.tui, "utf8")
    syncIfDiverged(p.root, "desktop")
    expect(readFileSync(p.tui, "utf8")).toBe(before)
  })
  test("mtime 同 ms 平局不写（复审P2-3）", () => {
    const p = sandbox()
    writeFileSync(p.desktop, JSON.stringify(desktop([{ providerID: "glm", modelID: "a", visibility: "show" }])))
    writeFileSync(p.tui, JSON.stringify({ favorite: [{ providerID: "ds", modelID: "b" }] }))
    const t = new Date()
    utimesSync(p.desktop, t, t)
    utimesSync(p.tui, t, t)
    syncIfDiverged(p.root, "desktop", p.tui)
    expect(parseDesktopModels(JSON.parse(readFileSync(p.desktop, "utf8")))).toEqual(["glm/a"])
    expect(parseTuiFavorites(JSON.parse(readFileSync(p.tui, "utf8")))).toEqual(["ds/b"])
  })
  test("desktop 获胜时写入注入的 fallback 候选（复审P1-2）", () => {
    const p = sandbox()
    writeFileSync(p.desktop, JSON.stringify(desktop([{ providerID: "glm", modelID: "a", visibility: "show" }])))
    utimesSync(p.desktop, new Date(), new Date(Date.now() + 5_000))
    const fallback = join(p.root, "fallback-model.json")
    syncIfDiverged(p.root, "desktop", fallback)
    expect(parseTuiFavorites(JSON.parse(readFileSync(fallback, "utf8")))).toEqual(["glm/a"])
  })
})

describe("被动侧变更触发同步（复审P1-1）", () => {
  test("sameActivation 短路时 onConfigSync 仍被调，desktop 侧镜像 TUI favorites", async () => {
    const p = sandbox()
    writeFileSync(p.desktop, JSON.stringify(desktop([{ providerID: "glm", modelID: "a", visibility: "show" }])))
    const fallback = join(p.root, "fallback-model.json")
    let syncCalls = 0
    const m = new MatrixManager({
      stateRoot: p.root, mode: "desktop", superset: [],
      injectedNames: new Set(), knownProviders: new Set(),
      watchEnabled: true, debounceMs: 60, pollMs: 200,
      onConfigSync: () => { syncCalls++; syncIfDiverged(p.root, "desktop", fallback) },
    })
    try {
      m.recompute() // 预置状态=dat 现值，后续重算将短路
      m.start()
      // 被动侧（desktop 模式下 TUI 为被动侧）变更 → 重算读 dat 无变化 → 短路 → sync 仍须触发
      writeFileSync(p.tui, JSON.stringify({ favorite: [{ providerID: "ds", modelID: "b" }] }))
      await new Promise((r) => setTimeout(r, 600))
      expect(syncCalls).toBeGreaterThan(0)
      expect(parseDesktopModels(JSON.parse(readFileSync(p.desktop, "utf8")))).toEqual(["ds/b"])
    } finally {
      m.stop()
    }
  })
})

describe("实调失败内存隔离", () => {
  test("标记立即命中，TTL 后惰性过期", () => {
    const now = Date.now()
    markRealFailure("test|combo", now)
    expect(isRealFailedCombo("test|combo", now)).toBe(true)
    expect(realFailedComboKeys(now + REAL_FAIL_TTL_MS + 1).has("test|combo")).toBe(false)
  })
  test("未标记组合保持原有闸行为", () => {
    const shell = { name: "test-mx-model-high", matrixKey: "untouched|combo", comboKey: "untouched|combo", status: "enabled", pool: "glm", provider: "test", modelId: "model", effort: "high", family: "glm", capability: "rw", vision: false } as ShellRegEntry
    const result = checkShell(shell.name, shell, 'ROUTE_META {"lane":"main","role":"programmer","capability":"rw","source":"auto"}', {
      registry: { [shell.name]: shell }, matrix: { [shell.comboKey]: { status: "ok" } },
      routing: { down_agents: {}, down_expiry: {} }, quotaExhausted: {}, realFailedCombos: new Set(),
      lanes: { main: [shell.name] },
    })
    expect(result.deny).toBeNull()
  })
  test("未标记但旧熔断（down_agents）在场 → 仍走旧熔断 deny", () => {
    const shell = { name: "legacy-mx-model-high", matrixKey: "legacy|combo", comboKey: "legacy|combo", status: "enabled", pool: "glm", provider: "legacy", modelId: "model", effort: "high", family: "glm", capability: "rw", vision: false } as ShellRegEntry
    const result = checkShell(shell.name, shell, 'ROUTE_META {"lane":"main","role":"programmer","capability":"rw","source":"auto"}', {
      registry: { [shell.name]: shell }, matrix: { [shell.comboKey]: { status: "ok" } },
      routing: { down_agents: { [shell.comboKey]: "连续失败" }, down_expiry: { [shell.comboKey]: Date.now() + 60_000 } },
      quotaExhausted: {}, realFailedCombos: new Set(),
      lanes: { main: [shell.name] },
    })
    expect(result.deny).not.toBeNull()
  })
  test("标记组合被闸拦截并给出恢复说明", () => {
    const shell = { name: "marked-mx-model-high", matrixKey: "marked|combo", comboKey: "marked|combo", status: "enabled", pool: "glm", provider: "marked", modelId: "model", effort: "high", family: "glm", capability: "rw", vision: false } as ShellRegEntry
    const result = checkShell(shell.name, shell, 'ROUTE_META {"lane":"main","role":"programmer","capability":"rw","source":"auto"}', {
      registry: { [shell.name]: shell }, matrix: { [shell.comboKey]: { status: "ok" } },
      routing: { down_agents: {}, down_expiry: {} }, quotaExhausted: {}, realFailedCombos: new Set([shell.comboKey]),
      lanes: { main: [shell.name] },
    })
    expect(result.deny).toContain("30 分钟后自动解锁")
  })
})
