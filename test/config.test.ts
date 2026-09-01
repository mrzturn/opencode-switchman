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

describe("用户水位配置", () => {
  test("目录优先级只接受注入 env/home", () => {
    expect(resolveOpencodeConfigDir({ OPENCODE_CONFIG_DIR: "/a", XDG_CONFIG_HOME: "/b" }, "/h")).toBe("/a")
    expect(resolveOpencodeConfigDir({ XDG_CONFIG_HOME: "/b" }, "/h")).toBe("/b/opencode")
    expect(resolveOpencodeConfigDir({}, "/h")).toBe("/h/.config/opencode")
  })
  test("JSONC 保留字符串，注释和尾逗号可解析，错误稳定给行列", () => {
    const p = parseJsonc('{ // line\n "url":"https://x/* */\\\"", "literal":"a, }b,]", /* block */ "x": 1, }')
    expect("value" in p && p.value).toEqual({ url: 'https://x/* */"', literal: "a, }b,]", x: 1 })
    expect("value" in parseJsonc('{"x": 1, // tail\n}')).toBe(true)
    const bad = parseJsonc('{\n "x":,\n}')
    expect("error" in bad && bad.error).toMatchObject({ line: 2, col: expect.any(Number), message: "JSONC 解析失败" })
  })
  test("缺文件生成带 schema/version/providers 中文注释的完整模板", () => {
    const home = sandbox(); const loaded = load(home)
    const body = readFileSync(loaded.path, "utf8")
    expect(loaded.generated).toBe(true); expect(body).toContain('"$schema"'); expect(body).toContain('"version"'); expect(body).toContain('"deepseek"'); expect(body).toContain("配置语义")
  })
  test("有效文件仅内存补缺，不改变原字节及 mtime", () => {
    const home = sandbox(), dir = join(home, ".config", "opencode"); mkdirSync(dir, { recursive: true })
    const path = join(dir, "opencode-switchman.jsonc"), body = '{"version":1,"providers":{"deepseek":{"enabled":false}}}'
    writeFileSync(path, body); const before = statSync(path).mtimeMs
    const loaded = load(home)
    expect(readFileSync(path, "utf8")).toBe(body); expect(statSync(path).mtimeMs).toBe(before); expect(loaded.config.providers["github-copilot"]).toBeTruthy()
  })
  test("显式 false/null/空数组与未知字段保留，非法值只在内存回退", () => {
    const raw = configOf({ providers: { "deepseek": { enabled: false, observe: null, peak: { timezone: "local", ranges: [] }, unknown: [] } }, extra: null })
    const r = validateUserConfig(raw)
    expect(r.config.providers["deepseek"].enabled).toBe(false); expect(r.config.providers["deepseek"].peak.ranges).toEqual([])
    expect((r.config.providers["deepseek"] as any).unknown).toEqual([]); expect((r.config as any).extra).toBeNull(); expect(r.diagnostics.some((d) => d.code === "SWM030")).toBe(true)
  })
  test("坏文件备份后重建；symlink 原文件绝不覆盖", () => {
    const home = sandbox(), dir = join(home, ".config", "opencode"); mkdirSync(dir, { recursive: true }); const path = join(dir, "opencode-switchman.jsonc")
    writeFileSync(path, "{bad"); load(home); expect(readdirSync(dir).some((name) => /^opencode-switchman\.jsonc\.invalid-\d+-\d+\.bak$/.test(name))).toBe(true); expect(readFileSync(path, "utf8")).toContain("$schema")
    const target = join(dir, "target.jsonc"); writeFileSync(target, "{bad"); require("node:fs").rmSync(path); symlinkSync(target, path)
    load(home); expect(lstatSync(path).isSymbolicLink()).toBe(true); expect(readFileSync(target, "utf8")).toBe("{bad")
  })
  test("危险键拒绝且无原型污染；并发首次读取只留下有效文件", async () => {
    const raw = JSON.parse('{"__proto__":{"polluted":true},"providers":{"constructor":{}}}')
    const r = validateUserConfig(raw); expect(({} as any).polluted).toBeUndefined(); expect((r.config.providers as any).constructor).toBeUndefined()
    const home = sandbox(); const [a, b] = await Promise.all([Promise.resolve(load(home)), Promise.resolve(load(home))])
    expect(a.path).toBe(b.path); expect(parseJsonc(readFileSync(a.path, "utf8"))).toHaveProperty("value"); expect(existsSync(`${a.path}.lock`)).toBe(false); expect(readdirSync(join(home, ".config", "opencode")).some((n) => n.includes(".tmp."))).toBe(false)
  })
  test("超过 30 秒的崩溃残留锁可抢占", () => {
    const home = sandbox(), dir = join(home, ".config", "opencode"); mkdirSync(dir, { recursive: true }); const lock = join(dir, "opencode-switchman.jsonc.lock")
    writeFileSync(lock, ""); utimesSync(lock, new Date(Date.now() - 31_000), new Date(Date.now() - 31_000))
    expect(load(home).generated).toBe(true); expect(existsSync(lock)).toBe(false)
  })
  test("区间诊断拆分、跨日/跨周/DST/local 求值与重叠检出", () => {
    for (const [ranges, code] of [[[{ days: [0], start: "09:00", end: "10:00" }], "SWM032"], [[{ days: [1], start: "9:00", end: "10:00" }], "SWM033"], [[{ days: [1], start: "09:00", end: "09:00" }], "SWM034"], [[{ days: [1], start: "09:00", end: "11:00" }, { days: [1], start: "10:00", end: "12:00" }], "SWM035"]] as any) {
      const c = configOf(); c.providers["deepseek"].peak.ranges = ranges; expect(validateUserConfig(c).diagnostics.some((d) => d.code === code)).toBe(true)
    }
    const c = configOf(); c.providers["deepseek"].peak = { timezone: "America/New_York", ranges: [{ days: [7], start: "23:00", end: "02:00" }] }
    c.providers["deepseek"].peak.ranges = [{ days: [6], start: "23:00", end: "02:00" }]
    expect(evaluatePeakSchedules(new Date("2026-03-08T06:30:00Z"), c, "deepseek")).toBe(true) // DST 切换周 Sunday 01:30, from Saturday range
    c.providers["deepseek"].peak.ranges = [{ days: [1], start: "23:00", end: "02:00" }]
    expect(evaluatePeakSchedules(new Date("2026-03-10T05:30:00Z"), c, "deepseek")).toBe(true) // Tuesday 01:30, Monday cross-day
    c.providers["deepseek"].peak = { timezone: "local", ranges: [] }; expect(evaluatePeakSchedules(new Date(), c, "deepseek")).toBe(false)
  })
  test("配置键/别名映射及默认 routing 关闭时三处一致 fail-open", () => {
    expect(providerKeyForPool("glm")).toBe("zhipuai-coding-plan"); expect(poolForProviderId("zhipuai-coding-plan")).toBe("glm"); expect(poolForProviderId("github-copilot-oauth")).toBe("copilot"); expect(poolForProviderId("deepseek")).toBe("deepseek")
    const policy = routePolicy(validateUserConfig(configOf()).config); expect(Object.values(policy).every((x) => !x.routing)).toBe(true)
    expect(scoreShell({ modelId: "x", effort: "high", lane: "main", pool: "glm", matrixStatus: "ok", latencyMs: null, peakActive: false, immediate: false, water: { glmFiveHourPct: 80, routing: { glm: false } } }).water).toBe(1)
    for (const pool of ["glm", "copilot", "deepseek"] as const) {
      const shell: any = { name: pool, pool, provider: pool, modelId: "x", family: "x", effort: "high", capability: "rw", vision: false, status: "enabled", matrixKey: pool, comboKey: pool }
      const input: any = { registry: { [pool]: shell }, matrix: { [pool]: { status: "ok", latency_ms: null } }, routing: { down_agents: {}, down_expiry: {} }, quotaExhausted: { [pool]: true }, routePolicy: policy }
      expect(computeLane("main", [pool], input).chain).toHaveLength(1)
      expect(checkShell(pool, shell, 'ROUTE_META {"lane":"main","role":"programmer","producer_family":"gpt","capability":"rw","modality":"text","source":"auto"}', { ...input, lanes: { main: [pool] } }).deny).toBeNull()
      policy[pool].routing = true
      expect(computeLane("main", [pool], input).chain).toHaveLength(0)
      policy[pool].routing = false
    }
    expect(routingAdvice({ glm: { state: "strained" } }, policy)).toBeNull(); policy.glm.routing = true; expect(routingAdvice({ glm: { state: "strained" } }, policy)).toContain("GLM")
  })
  test("显式旧 billingWindow 覆盖新配置峰值判定", () => {
    const config = validateUserConfig(configOf()).config
    const now = new Date(2026, 7, 31, 10, 0) // Monday local
    expect(billingWindowForConfig(now, config).glmPeak).toBe(false)
    expect(billingWindowForConfig(now, config, { glmPeakHours: [9, 12], dsPeakRanges: [] }).glmPeak).toBe(true)
    expect(billingWindowForConfig(now, config, { glmPeakHours: [9, 12], dsPeakRanges: [] }).dsPeak).toBe(false)
  })
  test("[去厂商化] billing 字段：内置出厂缺省、非法值回退（SWM036）、自定义键默认 api", () => {
    const r = validateUserConfig(configOf())
    expect(r.config.providers["zhipuai-coding-plan"].billing).toBe("subscription")
    expect(r.config.providers["deepseek"].billing).toBe("api")
    expect(r.config.providers["github-copilot"].billing).toBe("subscription")
    const bad = configOf({ providers: { "deepseek": { billing: "free" as any } } })
    const rb = validateUserConfig(bad)
    expect(rb.diagnostics.some((d) => d.code === "SWM036" && d.path === "providers.deepseek.billing")).toBe(true)
    expect(rb.config.providers["deepseek"].billing).toBe("api")
    // 自定义 provider 键：合法、内存补全通用缺省（api 计费、无高峰）
    const custom = validateUserConfig(configOf({ providers: { "my-gateway": { enabled: true } } }))
    expect(custom.diagnostics.some((d) => d.path?.startsWith("providers.my-gateway"))).toBe(false)
    expect(custom.config.providers["my-gateway"].billing).toBe("api")
    expect(custom.config.providers["my-gateway"].observe).toBe(true)
    expect(custom.config.providers["my-gateway"].peak.ranges).toEqual([])
  })
  test("[去厂商化] providerEntry/billingOfProvider/providerPeakActive 任意键解析", () => {
    const config = validateUserConfig(configOf({
      providers: {
        "my-gateway": { enabled: true, billing: "subscription" as const, peak: { timezone: "local", ranges: [{ days: [1], start: "09:00", end: "10:00" }] } },
      },
    })).config
    expect(billingOfProvider(config, "my-gateway")).toBe("subscription")
    expect(billingOfProvider(config, "deepseek")).toBe("api")
    expect(billingOfProvider(config, "zhipuai-coding-plan")).toBe("subscription") // 别名归一到内置键
    expect(billingOfProvider(config, "totally-unknown")).toBe("api") // 无配置自定义键回退通用缺省
    expect(providerPeakActive(new Date(2026, 7, 31, 9, 30), config, "my-gateway")).toBe(true) // 周一 09:30 命中自定义高峰
    expect(providerPeakActive(new Date(2026, 7, 31, 10, 30), config, "my-gateway")).toBe(false)
    // providerEntry 显式字段优先于通用缺省（enabled 保留显式 true）
    expect(providerEntry(config, "my-gateway").enabled).toBe(true)
  })
  test("[终审P1-1] routingPeakActive：enabled:false 时高峰不参与路由；事实口径 providerPeakActive 不受影响", () => {
    const config = validateUserConfig(configOf()).config // 内置键出厂 enabled:false
    const now = new Date(2026, 7, 31, 15, 0) // 周一 15:00（GLM 出厂高峰 14-18 内）
    expect(providerPeakActive(now, config, "zhipuai-coding-plan")).toBe(true) // 事实口径：正在高峰
    expect(routingPeakActive(now, config, "zhipuai-coding-plan")).toBe(false) // 路由口径：enabled=false 不生效
    const enabled = validateUserConfig(configOf({ providers: { "deepseek": { enabled: true } } })).config
    expect(routingPeakActive(new Date(2026, 7, 31, 10, 0), enabled, "deepseek")).toBe(true) // 周一 10:00 在 DS 出厂高峰
    expect(routingPeakActive(new Date(2026, 7, 31, 13, 0), enabled, "deepseek")).toBe(false)
  })
  test("[终审P1] providerEntry 精确键优先：自定义别名键与内置规范键并存时精确键胜出", () => {
    const config = validateUserConfig(configOf({
      providers: {
        "glm-coding-plan-cn": { enabled: false, billing: "subscription" as const },
        "zhipuai-coding-plan": { enabled: true, billing: "api" as const },
      },
    })).config
    expect(providerEntry(config, "zhipuai-coding-plan").billing).toBe("api") // 精确键优先，不被归一吞掉
    expect(providerEntry(config, "zhipuai-coding-plan").enabled).toBe(true)
    expect(billingOfProvider(config, "zhipuai-coding-plan")).toBe("api")
    expect(billingOfProvider(config, "glm-coding-plan-cn")).toBe("subscription")
  })
})

describe("行为段统一配置面 [2026-09-01]", () => {
  test("行为段缺省内存补齐（quota/cost/capability/matrix/banner/rules/lanes）", () => {
    const r = validateUserConfig(configOf())
    expect(r.config.quota).toEqual({ glmFiveHourReservePct: 90, deepseekLowBalanceWarnCny: 10 })
    expect(r.config.cost.enabled).toBe(true)
    expect(r.config.capability).toEqual({ enabled: true, source: "auto", lmarenaCheck: false })
    expect(r.config.matrix).toEqual({ mode: "auto", watch: true })
    expect(r.config.banner.enabled).toBe(true); expect(r.config.rules.enabled).toBe(true); expect(r.config.lanes).toEqual({})
    expect(r.diagnostics.filter((d) => d.code === "SWM037")).toEqual([])
  })
  test("行为段显式值保留；类型坏值回退缺省并报 SWM037", () => {
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
    expect(r.config.lanes).toEqual({ main: ["a", "b"] }) // 单条坏 lane 只回退该条
    expect(r.config.capability.apiKey).toBeUndefined()
    expect(r.diagnostics.filter((d) => d.code === "SWM037").map((d) => d.path)).toEqual(expect.arrayContaining(["lanes.hard", "capability.apiKey"]))
    const bad = validateUserConfig(configOf({ quota: { glmFiveHourReservePct: 101 }, matrix: { mode: "nope" as any } }))
    expect(bad.config.quota.glmFiveHourReservePct).toBe(90); expect(bad.config.matrix.mode).toBe("auto")
    expect(bad.diagnostics.filter((d) => d.code === "SWM037").map((d) => d.path)).toEqual(expect.arrayContaining(["quota.glmFiveHourReservePct", "matrix.mode"]))
  })
  test("resolveEffectiveOptions：jsonc 为基线，元组显式键覆盖并清点 legacySections", () => {
    const cfg = validateUserConfig(configOf({ quota: { glmFiveHourReservePct: 70, deepseekLowBalanceWarnCny: 3 }, lanes: { main: ["jsonc-lane"] }, matrix: { mode: "legacy", watch: false }, banner: { enabled: false } })).config
    const none = resolveEffectiveOptions(undefined, cfg)
    expect(none.options.quota!.glm!.fiveHourReservePct).toBe(70)
    expect(none.options.quota!.deepseek!.lowBalanceWarnCny).toBe(3)
    expect(none.options.lanes).toEqual({ main: ["jsonc-lane"] })
    expect(none.options.matrix!.mode).toBe("legacy"); expect(none.options.matrix!.watch).toBe(false)
    expect(none.options.banner!.enabled).toBe(false)
    expect(none.legacySections).toEqual([])
    const legacy = resolveEffectiveOptions({ quota: { glm: { fiveHourReservePct: 50 } }, lanes: { main: ["tuple-lane"] } }, cfg)
    expect(legacy.options.quota!.glm!.fiveHourReservePct).toBe(50) // 元组显式优先（兼容一代）
    expect(legacy.options.quota!.deepseek!.lowBalanceWarnCny).toBe(3) // 未显式走 jsonc
    expect(legacy.options.lanes).toEqual({ main: ["tuple-lane"] })
    expect(legacy.legacySections).toEqual(expect.arrayContaining(["quota", "lanes"]))
  })
  test("生成模板包含行为段中文注释且可直接解析校验", () => {
    const home = sandbox(); const loaded = load(home)
    const body = readFileSync(loaded.path, "utf8")
    for (const key of ['"quota"', '"cost"', '"capability"', '"matrix"', '"banner"', '"rules"', '"lanes"']) expect(body).toContain(key)
    const parsed = parseJsonc(body)
    expect("value" in parsed).toBe(true)
    if ("value" in parsed) { const v = validateUserConfig(parsed.value); expect(v.diagnostics.filter((d) => d.level === "error")).toEqual([]) }
  })
})
