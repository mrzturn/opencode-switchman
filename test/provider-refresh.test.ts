// Provider-refresh behavior contract (v1.3; bun test)
// Covers: provider cache freshness gate (stale-cache live probe predicate), model-list delta detection,
//         and the watchdog's in-place superset rebuild via MatrixManager.updateSuperset.
// [2026-09-06]-[new suite for the provider-refresh feature: startup stale-cache probe + background drift rebuild]
import { describe, test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-prefresh-"))

import { providerCacheStale, providerCacheAgeMs, providerModelsDelta, PROVIDER_CACHE_MAX_AGE_MS } from "../src/state"
import type { ProviderCache } from "../src/state"
import { buildShells } from "../src/catalog"
import { MatrixManager } from "../src/matrix-manager"
import { paths } from "../src/state"

// ---- Sandbox (pattern of test/activation.test.ts: stateHome=userData root, stateRoot=stateHome/opencode) ----
const stateHome = mkdtempSync(join(tmpdir(), "opencode-state-"))
const stateRoot = join(stateHome, "opencode")
mkdirSync(stateRoot, { recursive: true })
mkdirSync(paths().dir, { recursive: true })

// ================= 1. providerCacheStale / providerCacheAgeMs =================
describe("provider cache freshness gate", () => {
  // Fixed epoch so the boundary math is deterministic (no wall-clock flakiness)
  const NOW = 1_800_000_000_000
  const cacheOf = (at: string): ProviderCache => ({ at, models: ["glm/glm-5.3"], providers: ["glm"] })
  const isoAgo = (ageMs: number) => new Date(NOW - ageMs).toISOString()

  test("cache written now → age ~0, not stale", () => {
    const c = cacheOf(new Date(NOW).toISOString())
    expect(providerCacheAgeMs(c, NOW)).toBe(0)
    expect(providerCacheStale(c, NOW)).toBe(false)
  })
  test("cache 25h old → stale (past the 24h TTL)", () => {
    const c = cacheOf(isoAgo(25 * 3_600_000))
    expect(providerCacheAgeMs(c, NOW)).toBe(25 * 3_600_000)
    expect(providerCacheStale(c, NOW)).toBe(true)
  })
  test("unparseable timestamp → age null, stale (never trust blindly)", () => {
    const c = cacheOf("not-a-date")
    expect(providerCacheAgeMs(c, NOW)).toBeNull()
    expect(providerCacheStale(c, NOW)).toBe(true)
  })
  test("missing timestamp (partial object) → age null, stale (cache.at ?? \"\" fallback)", () => {
    const c = { models: [], providers: ["glm"] } as unknown as ProviderCache
    expect(providerCacheAgeMs(c, NOW)).toBeNull()
    expect(providerCacheStale(c, NOW)).toBe(true)
  })
  test("TTL boundary: exactly PROVIDER_CACHE_MAX_AGE_MS old → NOT stale (strict >); one ms more → stale", () => {
    expect(providerCacheStale(cacheOf(isoAgo(PROVIDER_CACHE_MAX_AGE_MS)), NOW)).toBe(false)
    expect(providerCacheStale(cacheOf(isoAgo(PROVIDER_CACHE_MAX_AGE_MS + 1)), NOW)).toBe(true)
  })
})

// ================= 2. providerModelsDelta =================
describe("provider model-list delta", () => {
  test("detects added, removed, and both directions", () => {
    expect(providerModelsDelta(["glm/glm-5.3"], ["glm/glm-5.3", "glm/glm-5.4"])).toEqual({ added: ["glm/glm-5.4"], removed: [] })
    expect(providerModelsDelta(["glm/glm-5.3", "deepseek/deepseek-v4-pro"], ["glm/glm-5.3"])).toEqual({ added: [], removed: ["deepseek/deepseek-v4-pro"] })
    expect(providerModelsDelta(["a/m1", "b/m2"], ["b/m2", "c/m3"])).toEqual({ added: ["c/m3"], removed: ["a/m1"] })
  })
  test("identical sets (any order, duplicates in input) → both sides empty (Set semantics, no leak)", () => {
    expect(providerModelsDelta(["a/m1", "b/m2"], ["b/m2", "a/m1"])).toEqual({ added: [], removed: [] })
    expect(providerModelsDelta(["a/m1", "a/m1", "b/m2"], ["b/m2", "b/m2", "a/m1"])).toEqual({ added: [], removed: [] })
  })
  test("outputs are sorted regardless of input order", () => {
    const d = providerModelsDelta(["z/9", "a/1"], ["z/8", "b/3", "a/2"])
    expect(d.added).toEqual(["a/2", "b/3", "z/8"])
    expect(d.removed).toEqual(["a/1", "z/9"])
  })
})

// ================= 3. MatrixManager.updateSuperset (watchdog superset rebuild) =================
describe("MatrixManager.updateSuperset: in-place superset rebuild on model drift", () => {
  const META = {
    "glm/glm-5.3": { efforts: ["high"], toggle: true, vision: false },
    "github-copilot/gpt-5.6-terra": { efforts: ["high"], toggle: true, vision: true },
  }
  // Startup face: provider.list saw only glm/glm-5.3 (terra not yet in the provider's list)
  const initial = buildShells(["glm/glm-5.3"], META as any, { roAliases: true })
  // Watchdog drift face: provider.list now also returns terra → rebuilt superset
  const rebuilt = buildShells(["glm/glm-5.3", "github-copilot/gpt-5.6-terra"], META as any, { roAliases: true })

  test("favorite of a known provider with no shell → invalidConfigured, no shell of that model active", () => {
    writeFileSync(join(stateRoot, "model.json"), JSON.stringify({
      recent: [],
      favorite: [{ providerID: "github-copilot", modelID: "gpt-5.6-terra", visibility: "show", favorite: true }],
      variant: null,
    }))
    const m = new MatrixManager({
      stateRoot, mode: "cli", superset: initial,
      injectedNames: new Set(initial.map((d) => d.name)),
      knownProviders: new Set(["glm", "github-copilot"]),
      watchEnabled: false,
    })
    const st = m.recompute()
    expect(st.invalidConfigured).toContain("github-copilot/gpt-5.6-terra")
    // [2026-09-06]-[adjusted per activation.ts computeActivation: invalid-only favorites do NOT narrow — the initial
    //  superset stays fully dispatchable (activation.ts:143-148, precedent test/activation.test.ts "only invalid favorites");
    //  the pre-rebuild symptom is "no terra shell exists", not an empty active set]
    expect(st.activeShells.some((n) => n.startsWith("copilot-mx-terra"))).toBe(false)
    expect(st.activeShells).toContain("glm-mx-53-high")
  })

  test("updateSuperset: rebuilt defs make the favorite valid and active, generation bumps, matrix keys refresh", () => {
    writeFileSync(join(stateRoot, "model.json"), JSON.stringify({
      recent: [],
      favorite: [{ providerID: "github-copilot", modelID: "gpt-5.6-terra", visibility: "show", favorite: true }],
      variant: null,
    }))
    const m = new MatrixManager({
      stateRoot, mode: "cli", superset: initial,
      injectedNames: new Set(initial.map((d) => d.name)),
      knownProviders: new Set(["glm", "github-copilot"]),
      watchEnabled: false,
    })
    m.recompute()
    const prevGen = m.snapshot().generation
    const next = m.updateSuperset(rebuilt, new Set(["glm", "github-copilot"]))
    // The favorite is no longer dirty: its model now has shells in the superset
    expect(next.invalidConfigured).not.toContain("github-copilot/gpt-5.6-terra")
    expect(next.activeShells.length).toBeGreaterThan(0)
    expect(next.activeShells).toContain("copilot-mx-terra-high")
    // Configured-shells narrowing now applies (the favorite is the active surface; glm-only startup face drops out)
    expect(next.activeShells.every((n) => n.startsWith("copilot-mx-terra"))).toBe(true)
    expect(next.generation).toBeGreaterThan(prevGen)
    // Probe targets refresh in place: terra combos are active matrix keys
    expect(m.activeMatrixKeys().length).toBeGreaterThan(0)
    expect(m.activeMatrixKeys().some((k) => k.startsWith("github-copilot|"))).toBe(true)
    // [2026-09-06]-[adjusted per matrix-manager.ts noteChatParams: a null modelKey registers the session but returns
    //  false (matrix unaffected); the "main-session model change → true" contract needs a real modelKey. Either way the
    //  rebuilt-but-not-injected shell name stays a non-shell agent: injectedNames is untouched by updateSuperset
    //  (cfg.agent is one-shot — the platform restart constraint)]
    expect(m.noteChatParams("s1", "copilot-mx-terra-high", null)).toBe(false)
    expect(m.isShellSession("s1")).toBe(false)
    expect(m.skipSystemInjection("s1")).toBe(false)
    expect(m.noteChatParams("s1", "copilot-mx-terra-high", "github-copilot/gpt-5.6-terra")).toBe(true)
    expect(m.isShellSession("s1")).toBe(false) // still a main session: the new shell is not dispatchable until restart
  })
})
