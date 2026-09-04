// [2026-09-04]-[English localization: translate test names and comments; synced expectations with translated src messages; no test-logic change]
import { describe, expect, test } from "bun:test"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evaluatePeakSchedules, loadUserConfig, parseJsonc, resolveOpencodeConfigDir, resolveEffectiveOptions, routePolicy, validateUserConfig, providerEntry, billingOfProvider, providerPeakActive, routingPeakActive } from "../src/config"
import { defaultProviderConfig, poolForProviderId, providerKeyForPool } from "../src/provider-config"
import { checkShell } from "../src/gates"
import { computeLane, routingAdvice } from "../src/lane"
import { scoreShell } from "../src/scoring"
import { billingWindowForConfig } from "../src/lane"

const sandbox = () => mkdtempSync(join(tmpdir(), "switchman-config-"))
const load = (home: string) => loadUserConfig({ home, env: {} })
function configOf(over: Record<string, unknown> = {}): any { return { version: 1, providers: defaultProviderConfig(), extensions: {}, ...over } }

describe("User watermark config", () => {
  test("directory priority accepts only injected env/home", () => {
    expect(resolveOpencodeConfigDir({ OPENCODE_CONFIG_DIR: "/a", XDG_CONFIG_HOME: "/b" }, "/h")).toBe("/a")
    expect(resolveOpencodeConfigDir({ XDG_CONFIG_HOME: "/b" }, "/h")).toBe("/b/opencode")
    expect(resolveOpencodeConfigDir({}, "/h")).toBe("/h/.config/opencode")
  })
  test("JSONC keeps strings, parses comments and trailing commas, stable error line/col", () => {
    const p = parseJsonc('{ // line\n "url":"https://x/* */\\\"", "literal":"a, }b,]", /* block */ "x": 1, }')
    expect("value" in p && p.value).toEqual({ url: 'https://x/* */"', literal: "a, }b,]", x: 1 })
    expect("value" in parseJsonc('{"x": 1, // tail\n}')).toBe(true)
    const bad = parseJsonc('{\n "x":,\n}')
    expect("error" in bad && bad.error).toMatchObject({ line: 2, col: expect.any(Number), message: "JSONC parse failed" })
  })
  test("missing file generates the full template with schema/version/providers comments", () => {
    const home = sandbox(); const loaded = load(home)
    const body = readFileSync(loaded.path, "utf8")
    expect(loaded.generated).toBe(true); expect(body).toContain('"$schema"'); expect(body).toContain('"version"'); expect(body).toContain('"deepseek"'); expect(body).toContain("Config semantic version")
  })
  test("valid file is only completed in memory; original bytes and mtime unchanged", () => {
    const home = sandbox(), dir = join(home, ".config", "opencode"); mkdirSync(dir, { recursive: true })
    const path = join(dir, "opencode-switchman.jsonc"), body = '{"version":1,"providers":{"deepseek":{"enabled":false}}}'
    writeFileSync(path, body); const before = statSync(path).mtimeMs
    const loaded = load(home)
    expect(readFileSync(path, "utf8")).toBe(body); expect(statSync(path).mtimeMs).toBe(before); expect(loaded.config.providers["github-copilot"]).toBeTruthy()
  })
  test("explicit false/null/empty arrays and unknown fields kept; illegal values only fall back in memory", () => {
    const raw = configOf({ providers: { "deepseek": { enabled: false, observe: null, peak: { timezone: "local", ranges: [] }, unknown: [] } }, extra: null })
    const r = validateUserConfig(raw)
    expect(r.config.providers["deepseek"].enabled).toBe(false); expect(r.config.providers["deepseek"].peak.ranges).toEqual([])
    expect((r.config.providers["deepseek"] as any).unknown).toEqual([]); expect((r.config as any).extra).toBeNull(); expect(r.diagnostics.some((d) => d.code === "SWM030")).toBe(true)
  })
  test("bad file is backed up then rebuilt; the symlinked original is never overwritten", () => {
    const home = sandbox(), dir = join(home, ".config", "opencode"); mkdirSync(dir, { recursive: true }); const path = join(dir, "opencode-switchman.jsonc")
    writeFileSync(path, "{bad"); load(home); expect(readdirSync(dir).some((name) => /^opencode-switchman\.jsonc\.invalid-\d+-\d+\.bak$/.test(name))).toBe(true); expect(readFileSync(path, "utf8")).toContain("$schema")
    const target = join(dir, "target.jsonc"); writeFileSync(target, "{bad"); require("node:fs").rmSync(path); symlinkSync(target, path)
    load(home); expect(lstatSync(path).isSymbolicLink()).toBe(true); expect(readFileSync(target, "utf8")).toBe("{bad")
  })
  test("dangerous keys rejected with no prototype pollution; concurrent first reads leave a single valid file", async () => {
    const raw = JSON.parse('{"__proto__":{"polluted":true},"providers":{"constructor":{}}}')
    const r = validateUserConfig(raw); expect(({} as any).polluted).toBeUndefined(); expect((r.config.providers as any).constructor).toBeUndefined()
    const home = sandbox(); const [a, b] = await Promise.all([Promise.resolve(load(home)), Promise.resolve(load(home))])
    expect(a.path).toBe(b.path); expect(parseJsonc(readFileSync(a.path, "utf8"))).toHaveProperty("value"); expect(existsSync(`${a.path}.lock`)).toBe(false); expect(readdirSync(join(home, ".config", "opencode")).some((n) => n.includes(".tmp."))).toBe(false)
  })
  test("crash-leftover locks older than 30 seconds can be preempted", () => {
    const home = sandbox(), dir = join(home, ".config", "opencode"); mkdirSync(dir, { recursive: true }); const lock = join(dir, "opencode-switchman.jsonc.lock")
    writeFileSync(lock, ""); utimesSync(lock, new Date(Date.now() - 31_000), new Date(Date.now() - 31_000))
    expect(load(home).generated).toBe(true); expect(existsSync(lock)).toBe(false)
  })
  test("range diagnostics split, cross-day/cross-week/DST/local evaluation and overlap detection", () => {
    for (const [ranges, code] of [[[{ days: [0], start: "09:00", end: "10:00" }], "SWM032"], [[{ days: [1], start: "9:00", end: "10:00" }], "SWM033"], [[{ days: [1], start: "09:00", end: "09:00" }], "SWM034"], [[{ days: [1], start: "09:00", end: "11:00" }, { days: [1], start: "10:00", end: "12:00" }], "SWM035"]] as any) {
      const c = configOf(); c.providers["deepseek"].peak.ranges = ranges; expect(validateUserConfig(c).diagnostics.some((d) => d.code === code)).toBe(true)
    }
    const c = configOf(); c.providers["deepseek"].peak = { timezone: "America/New_York", ranges: [{ days: [7], start: "23:00", end: "02:00" }] }
    c.providers["deepseek"].peak.ranges = [{ days: [6], start: "23:00", end: "02:00" }]
    expect(evaluatePeakSchedules(new Date("2026-03-08T06:30:00Z"), c, "deepseek")).toBe(true) // DST switch week Sunday 01:30, from Saturday range
    c.providers["deepseek"].peak.ranges = [{ days: [1], start: "23:00", end: "02:00" }]
    expect(evaluatePeakSchedules(new Date("2026-03-10T05:30:00Z"), c, "deepseek")).toBe(true) // Tuesday 01:30, Monday cross-day
    c.providers["deepseek"].peak = { timezone: "local", ranges: [] }; expect(evaluatePeakSchedules(new Date(), c, "deepseek")).toBe(false)
  })
  test("config key/alias mapping and consistent fail-open across three spots when default routing is off", () => {
    expect(providerKeyForPool("glm")).toBe("zhipuai-coding-plan"); expect(poolForProviderId("zhipuai-coding-plan")).toBe("glm"); expect(poolForProviderId("github-copilot-oauth")).toBe("copilot"); expect(poolForProviderId("deepseek")).toBe("deepseek")
    const policy = routePolicy(validateUserConfig(configOf()).config); expect(Object.values(policy).every((x) => !x.routing)).toBe(true)
    expect(scoreShell({ modelId: "x", effort: "high", lane: "main", pool: "glm", matrixStatus: "ok", latencyMs: null, peakActive: false, immediate: false, water: { glmFiveHourPct: 80, routing: { glm: false } } }).water).toBe(1)
    for (const pool of ["glm", "copilot", "deepseek"] as const) {
      const shell: any = { name: pool, pool, provider: pool, modelId: "glm-5.3-flash", family: "glm", effort: "high", capability: "rw", vision: false, status: "enabled", matrixKey: pool, comboKey: pool }
      const input: any = { registry: { [pool]: shell }, matrix: { [pool]: { status: "ok", latency_ms: null } }, routing: { down_agents: {}, down_expiry: {} }, quotaExhausted: { [pool]: true }, routePolicy: policy }
      expect(computeLane("main", [pool], input).chain).toHaveLength(1)
      expect(checkShell(pool, shell, 'ROUTE_META {"lane":"main","role":"programmer","producer_family":"gpt","capability":"rw","modality":"text","source":"auto"}', { ...input, lanes: { main: [pool] } }).deny).toBeNull()
      policy[pool].routing = true
      expect(computeLane("main", [pool], input).chain).toHaveLength(0)
      policy[pool].routing = false
    }
    expect(routingAdvice({ glm: { state: "strained" } }, policy)).toBeNull(); policy.glm.routing = true; expect(routingAdvice({ glm: { state: "strained" } }, policy)).toContain("GLM")
  })
  test("explicit legacy billingWindow overrides the new config peak decision", () => {
    const config = validateUserConfig(configOf()).config
    const now = new Date(2026, 7, 31, 10, 0) // Monday local
    expect(billingWindowForConfig(now, config).glmPeak).toBe(false)
    expect(billingWindowForConfig(now, config, { glmPeakHours: [9, 12], dsPeakRanges: [] }).glmPeak).toBe(true)
    expect(billingWindowForConfig(now, config, { glmPeakHours: [9, 12], dsPeakRanges: [] }).dsPeak).toBe(false)
  })
  test("[de-vendored] billing field: builtin factory defaults, illegal-value fallback (SWM036), custom keys default to api", () => {
    const r = validateUserConfig(configOf())
    expect(r.config.providers["zhipuai-coding-plan"].billing).toBe("subscription")
    expect(r.config.providers["deepseek"].billing).toBe("api")
    expect(r.config.providers["github-copilot"].billing).toBe("subscription")
    const bad = configOf({ providers: { "deepseek": { billing: "free" as any } } })
    const rb = validateUserConfig(bad)
    expect(rb.diagnostics.some((d) => d.code === "SWM036" && d.path === "providers.deepseek.billing")).toBe(true)
    expect(rb.config.providers["deepseek"].billing).toBe("api")
    // custom provider key: legal, generic defaults completed in memory (api billing, no peak)
    const custom = validateUserConfig(configOf({ providers: { "my-gateway": { enabled: true } } }))
    expect(custom.diagnostics.some((d) => d.path?.startsWith("providers.my-gateway"))).toBe(false)
    expect(custom.config.providers["my-gateway"].billing).toBe("api")
    expect(custom.config.providers["my-gateway"].observe).toBe(true)
    expect(custom.config.providers["my-gateway"].peak.ranges).toEqual([])
  })
  test("[de-vendored] providerEntry/billingOfProvider/providerPeakActive resolve any key", () => {
    const config = validateUserConfig(configOf({
      providers: {
        "my-gateway": { enabled: true, billing: "subscription" as const, peak: { timezone: "local", ranges: [{ days: [1], start: "09:00", end: "10:00" }] } },
      },
    })).config
    expect(billingOfProvider(config, "my-gateway")).toBe("subscription")
    expect(billingOfProvider(config, "deepseek")).toBe("api")
    expect(billingOfProvider(config, "zhipuai-coding-plan")).toBe("subscription") // alias canonicalized to the builtin key
    expect(billingOfProvider(config, "totally-unknown")).toBe("api") // unconfigured custom key falls back to generic defaults
    expect(providerPeakActive(new Date(2026, 7, 31, 9, 30), config, "my-gateway")).toBe(true) // Monday 09:30 hits the custom peak
    expect(providerPeakActive(new Date(2026, 7, 31, 10, 30), config, "my-gateway")).toBe(false)
    // providerEntry explicit fields win over generic defaults (enabled keeps its explicit true)
    expect(providerEntry(config, "my-gateway").enabled).toBe(true)
  })
  test("[final review P1-1] routingPeakActive: peak is excluded from routing when enabled:false; factual providerPeakActive unaffected", () => {
    const config = validateUserConfig(configOf()).config // builtin keys ship enabled:false
    const now = new Date(2026, 7, 31, 15, 0) // Monday 15:00 (inside GLM's factory peak 14-18)
    expect(providerPeakActive(now, config, "zhipuai-coding-plan")).toBe(true) // factual semantics: currently in peak
    expect(routingPeakActive(now, config, "zhipuai-coding-plan")).toBe(false) // routing semantics: enabled=false not effective
    const enabled = validateUserConfig(configOf({ providers: { "deepseek": { enabled: true } } })).config
    expect(routingPeakActive(new Date(2026, 7, 31, 10, 0), enabled, "deepseek")).toBe(true) // Monday 10:00 inside DS's factory peak
    expect(routingPeakActive(new Date(2026, 7, 31, 13, 0), enabled, "deepseek")).toBe(false)
  })
  test("[final review P1] providerEntry exact key wins: custom alias key coexisting with the builtin canonical key", () => {
    const config = validateUserConfig(configOf({
      providers: {
        "glm-coding-plan-cn": { enabled: false, billing: "subscription" as const },
        "zhipuai-coding-plan": { enabled: true, billing: "api" as const },
      },
    })).config
    expect(providerEntry(config, "zhipuai-coding-plan").billing).toBe("api") // exact key wins, not swallowed by canonicalization
    expect(providerEntry(config, "zhipuai-coding-plan").enabled).toBe(true)
    expect(billingOfProvider(config, "zhipuai-coding-plan")).toBe("api")
    expect(billingOfProvider(config, "glm-coding-plan-cn")).toBe("subscription")
  })
})

describe("Unified behavior-section config surface [2026-09-01]", () => {
  test("behavior sections completed in memory by default (quota/cost/capability/matrix/banner/rules/lanes)", () => {
    const r = validateUserConfig(configOf())
    expect(r.config.quota).toEqual({ glmFiveHourReservePct: 90, deepseekLowBalanceWarnCny: 10 })
    expect(r.config.cost.enabled).toBe(true)
    expect(r.config.capability).toEqual({ enabled: true, source: "auto", lmarenaCheck: false })
    expect(r.config.matrix).toEqual({ mode: "auto", watch: true })
    expect(r.config.banner.enabled).toBe(true); expect(r.config.rules.enabled).toBe(true); expect(r.config.lanes).toEqual({})
    expect(r.diagnostics.filter((d) => d.code === "SWM037")).toEqual([])
  })
  test("behavior-section explicit values kept; bad-typed values fall back to defaults and report SWM037", () => {
    const r = validateUserConfig(configOf({
      quota: { glmFiveHourReservePct: 80, deepseekLowBalanceWarnCny: 5 },
      matrix: { mode: "legacy" as any, watch: false },
      banner: { enabled: false },
      lanes: { main: ["a", "b"], hard: 3 as any },
      capability: { apiKey: 42 as any },
    }))
    expect(r.config.quota.glmFiveHourReservePct).toBe(80); expect(r.config.quota.deepseekLowBalanceWarnCny).toBe(5)
    expect(r.config.matrix.mode).toBe("legacy"); expect(r.config.matrix.watch).toBe(false)
    expect(r.config.banner.enabled).toBe(false)
    expect(r.config.lanes).toEqual({ main: ["a", "b"] }) // a single bad lane only falls back that entry
    expect(r.config.capability.apiKey).toBeUndefined()
    expect(r.diagnostics.filter((d) => d.code === "SWM037").map((d) => d.path)).toEqual(expect.arrayContaining(["lanes.hard", "capability.apiKey"]))
    const bad = validateUserConfig(configOf({ quota: { glmFiveHourReservePct: 101 }, matrix: { mode: "nope" as any } }))
    expect(bad.config.quota.glmFiveHourReservePct).toBe(90); expect(bad.config.matrix.mode).toBe("auto")
    expect(bad.diagnostics.filter((d) => d.code === "SWM037").map((d) => d.path)).toEqual(expect.arrayContaining(["quota.glmFiveHourReservePct", "matrix.mode"]))
  })
  test("resolveEffectiveOptions: jsonc is the baseline, tuple explicit keys override and legacySections are inventoried", () => {
    const cfg = validateUserConfig(configOf({ quota: { glmFiveHourReservePct: 70, deepseekLowBalanceWarnCny: 3 }, lanes: { main: ["jsonc-lane"] }, matrix: { mode: "legacy", watch: false }, banner: { enabled: false } })).config
    const none = resolveEffectiveOptions(undefined, cfg)
    expect(none.options.quota!.glm!.fiveHourReservePct).toBe(70)
    expect(none.options.quota!.deepseek!.lowBalanceWarnCny).toBe(3)
    expect(none.options.lanes).toEqual({ main: ["jsonc-lane"] })
    expect(none.options.matrix!.mode).toBe("legacy"); expect(none.options.matrix!.watch).toBe(false)
    expect(none.options.banner!.enabled).toBe(false)
    expect(none.legacySections).toEqual([])
    const legacy = resolveEffectiveOptions({ quota: { glm: { fiveHourReservePct: 50 } }, lanes: { main: ["tuple-lane"] } }, cfg)
    expect(legacy.options.quota!.glm!.fiveHourReservePct).toBe(50) // tuple explicit wins (gen-1 compatible)
    expect(legacy.options.quota!.deepseek!.lowBalanceWarnCny).toBe(3) // not explicit → jsonc
    expect(legacy.options.lanes).toEqual({ main: ["tuple-lane"] })
    expect(legacy.legacySections).toEqual(expect.arrayContaining(["quota", "lanes"]))
  })
  test("generated template contains behavior-section comments and parses/validates directly", () => {
    const home = sandbox(); const loaded = load(home)
    const body = readFileSync(loaded.path, "utf8")
    for (const key of ['"quota"', '"cost"', '"capability"', '"matrix"', '"banner"', '"rules"', '"lanes"']) expect(body).toContain(key)
    const parsed = parseJsonc(body)
    expect("value" in parsed).toBe(true)
    if ("value" in parsed) { const v = validateUserConfig(parsed.value); expect(v.diagnostics.filter((d) => d.level === "error")).toEqual([]) }
  })
})
