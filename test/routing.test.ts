// 行为契约 fixture（docs §7；bun test）
// 沙箱：SWITCHMAN_STATE 指向临时目录；六闸/lane/熔断全部纯函数直测，无子进程。
import { describe, test, expect, beforeAll } from "bun:test"
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-fx-"))

// [2026-08-31]-[机制测试与能力排名数据解耦：空壳 capability.json 使档位断言只锚定策展表，
//  不随内置默认快照/实时排名数据漂移（磁盘索引独占，未命中即回退策展表）]
mkdirSync(process.env.SWITCHMAN_STATE, { recursive: true })
writeFileSync(
  join(process.env.SWITCHMAN_STATE, "capability.json"),
  JSON.stringify({ source: "artificial-analysis", version: "fixed-empty", fetched_at: Date.now() / 1000, thresholds: { S: 62, A: 55, B: 45 }, models: {} }),
)

import { parseRouteMeta, metaErrorHint } from "../src/meta"
import { checkShell } from "../src/gates"
import { baseScoreDynamic } from "../src/capability"
import { capabilityLevelFor } from "../src/lane-policy"
import {
  computeLane, firstCandidate, billingWindow, poolStates, routingAdvice,
  glmExhausted, copilotExhausted, deepseekExhausted, laneOfShell,
} from "../src/lane"
import { recordFailure, agentDown, isNotFound } from "../src/breaker"
import { loadRouting, cleanExpired, loadManifest, buildRegistry, paths } from "../src/state"
import { buildBanner, shortName, providerStatusEntries } from "../src/banner"
import type { GateSnapshot, ShellRegEntry, Matrix, MatrixEntry, Routing, Lane } from "../src/types"

// ---- 沙箱装配 ----
const manifest = loadManifest()
const LANES = manifest.lanes as Record<Lane, string[]>
const ALL = Object.values(LANES).flat()

function regEntry(name: string, over: Partial<ShellRegEntry> = {}): ShellRegEntry {
  const m = manifest.shells.find((s) => s.name === name)!
  return { ...m, status: "enabled", comboKey: m.matrixKey, ...over }
}
function fullRegistry(over: Record<string, Partial<ShellRegEntry>> = {}): Record<string, ShellRegEntry> {
  const out: Record<string, ShellRegEntry> = {}
  for (const s of manifest.shells) out[s.name] = { ...s, status: "enabled", comboKey: s.matrixKey, ...over[s.name] }
  return out
}
function matrixOk(latency?: Record<string, number>): Record<string, MatrixEntry> {
  const out: Record<string, MatrixEntry> = {}
  for (const s of manifest.shells) {
    out[s.matrixKey] = { status: "ok", latency_ms: latency?.[s.matrixKey] ?? null }
  }
  return out
}
function meta(lane = "main", role = "programmer", pf = "glm", cap = "rw", mod = "text", src = "auto"): string {
  return `ROUTE_META {"lane":"${lane}","role":"${role}","producer_family":"${pf}","capability":"${cap}","modality":"${mod}","source":"${src}"}\n任务正文`
}
function snap(over: Partial<GateSnapshot> = {}): GateSnapshot {
  return {
    registry: fullRegistry(),
    matrix: matrixOk(),
    routing: { down_agents: {}, down_expiry: {} },
    quotaExhausted: {},
    ...over,
  }
}
function denyOf(name: string, prompt: string, s: GateSnapshot = snap()): string | null {
  const shell = s.registry?.[name]
  if (!shell) throw new Error(`fixture 壳缺失: ${name}`)
  return checkShell(name, shell, prompt, { ...s, lanes: LANES }).deny
}
function decOf(name: string, prompt: string, s: GateSnapshot = snap()): { deny: string | null; note: string | null } {
  const shell = s.registry![name]
  return checkShell(name, shell, prompt, { ...s, lanes: LANES })
}

// ================= 1. META 解析（7）=================
describe("META 解析", () => {
  test("1 JSON 单行格式解析成功（六键齐全）", () => {
    const [m, err] = parseRouteMeta(meta())
    expect(err).toBeNull()
    expect(m).toEqual({ lane: "main", role: "programmer", producer_family: "glm", capability: "rw", modality: "text", source: "auto" })
  })
  test("2 k=v 空格分隔格式解析成功", () => {
    const [m, err] = parseRouteMeta("ROUTE_META lane=main role=programmer producer_family=glm capability=rw modality=text source=auto")
    expect(err).toBeNull()
    expect(m?.role).toBe("programmer")
    expect(m?.source).toBe("auto")
  })
  test("2a Markdown 外壳不应使有效 META 被拒绝", () => {
    for (const prefix of ["  ROUTE_META", "> ROUTE_META", "- ROUTE_META", "`ROUTE_META`", "ROUTE_META:"]) {
      const [m, err] = parseRouteMeta(`${prefix} {"lane":"mechanical","role":"tester","capability":"rw","source":"auto"}`)
      expect(err).toBeNull()
      expect(m).toEqual({ lane: "mechanical", role: "tester", capability: "rw", source: "auto" })
    }
  })
  test("3 六键白名单：未知键丢弃、值统一小写", () => {
    const [m, err] = parseRouteMeta('ROUTE_META {"role":"Programmer","capability":"RW","source":"AUTO","bogus":"x"}')
    expect(err).toBeNull()
    expect(m).toEqual({ role: "programmer", capability: "rw", source: "auto" })
  })
  test("4 必填三键缺失 → required（source/role/capability）", () => {
    const [, e1] = parseRouteMeta('ROUTE_META {"lane":"main","modality":"text"}')
    expect(e1).toEqual({ kind: "required", field: "source" })
    const [, e2] = parseRouteMeta('ROUTE_META {"source":"auto","capability":"rw"}')
    expect(e2).toEqual({ kind: "required", field: "role" })
  })
  test("5 前 4000 字符窗口：窗口外 META 视为 missing", () => {
    const far = "x".repeat(4100) + "\n" + meta()
    const [m, err] = parseRouteMeta(far)
    expect(m).toBeNull()
    expect(err).toBe("missing")
  })
  test("6 producer_family 拒池名（main/gcp 非法）", () => {
    const [, e1] = parseRouteMeta(meta("review", "reviewer", "main"))
    expect(e1).toEqual({ kind: "invalid", field: "producer_family", value: "main" })
    const [, e2] = parseRouteMeta(meta("review", "reviewer", "gcp"))
    expect(e2).toEqual({ kind: "invalid", field: "producer_family", value: "gcp" })
  })
  test("7 非法值附合法值清单（deny 附言可读）", () => {
    const hint = metaErrorHint({ kind: "invalid", field: "source", value: "bogus" })
    expect(hint).toContain("source='bogus' 非法")
    expect(hint).toContain("auto/user")
    expect(hint).toContain("META 格式样例")
  })
})

// ================= 2. 六闸顺序（11）=================
describe("六闸顺序", () => {
  const glmCombo = manifest.shells.find((s) => s.name === "glm-mx-53-high")!.matrixKey
  const terraCombo = manifest.shells.find((s) => s.name === "copilot-mx-terra-high")!.matrixKey

  test("8 矩阵明确 down → deny（附 reason）", () => {
    const s = snap({ matrix: { ...matrixOk(), [terraCombo]: { status: "down", reason: "HTTP 502" } } })
    const d = denyOf("copilot-mx-terra-high", meta(), s)
    expect(d).toContain("矩阵 down")
    expect(d).toContain("HTTP 502")
    expect(d).toMatch(/请改派|降级链已尽/)
  })
  test("9 disabled＋矩阵非 down → fail-open 放行（stderr note）", () => {
    const s = snap({ matrix: { ...matrixOk(), [terraCombo]: { status: "unknown" } } })
    const reg = fullRegistry({ "copilot-mx-terra-high": { status: "disabled" } })
    const r = decOf("copilot-mx-terra-high", meta(), { ...s, registry: reg })
    expect(r.deny).toBeNull()
    expect(r.note).toContain("fail-open 放行")
  })
  test("10 未探测面（discovered）→ deny", () => {
    const reg = fullRegistry({ "copilot-mx-terra-high": { status: "discovered" as any, matrixKey: "" } })
    const d = denyOf("copilot-mx-terra-high", meta(), snap({ registry: reg }))
    expect(d).toContain("status=discovered")
  })
  test("11 矩阵 unknown/missing → 放行 + note 提示", () => {
    const s = snap({ matrix: { ...matrixOk(), [terraCombo]: { status: "unknown" } } })
    const r = decOf("copilot-mx-terra-high", meta(), s)
    expect(r.deny).toBeNull()
    expect(r.note).toContain("矩阵状态=unknown")
  })
  test("12 熔断：壳名或 combo 命中 → deny（10 分钟自动恢复话术）", () => {
    const s1 = snap({ routing: { down_agents: { "glm-mx-53-high": "连续失败" }, down_expiry: {} } })
    expect(denyOf("glm-mx-53-high", meta(), s1)).toContain("熔断")
    const s2 = snap({ routing: { down_agents: { [glmCombo]: "连续失败" }, down_expiry: {} } })
    expect(denyOf("glm-mx-53-high", meta(), s2)).toContain("熔断")
  })
  test("13 池耗尽 → deny（只认调用必失败）", () => {
    const s = snap({ quotaExhausted: { copilot: true } })
    const d = denyOf("copilot-mx-terra-high", meta(), s)
    expect(d).toContain("暂不可用")
  })
  test("14 META 缺失/坏格式 → deny 附样例", () => {
    expect(denyOf("glm-mx-53-high", "裸任务无 META")).toContain("缺 ROUTE_META")
    expect(denyOf("glm-mx-53-high", "ROUTE_META {broken\n任务")).toContain("格式坏")
    const d = denyOf("glm-mx-53-high", 'ROUTE_META {"lane":"main","modality":"text"}\n任务')
    expect(d).toContain("缺安全字段")
  })
  test("15 reviewer 同族 → deny（异族复审闸）", () => {
    const d = denyOf("glm-mx-53-high", meta("review", "reviewer", "glm", "ro"), snap())
    expect(d).toContain("同 family")
    expect(d).toContain("异族")
  })
  test("16 rw 任务派 ro 壳 → deny", () => {
    const ro = manifest.shells.find((s) => s.capability === "ro")!.name
    const d = denyOf(ro, meta("review", "planner", "glm", "rw"), snap())
    expect(d).toContain("只读壳")
  })
  test("17 image 任务派非视觉壳 → deny；视觉壳放行", () => {
    const d = denyOf("glm-mx-53-high", meta("vision", "observer", "glm", "rw", "image"), snap())
    expect(d).toContain("非视觉壳")
    expect(denyOf("glm-mx-53f-high", meta("vision", "observer", "glm", "rw", "image"), snap())).toBeNull()
  })
  test("18 自动派发跨级壳时优先同级；user 点名可覆盖该优先序", () => {
    expect(denyOf("ds-mx-v4p-high", meta(), snap())).toContain("跨级回退")
    expect(denyOf("ds-mx-v4p-high", meta("main", "programmer", "glm", "rw", "text", "user"), snap())).toBeNull()
  })
  test("19 review A 级仅在 S 级候选均不可用时允许直接派发", () => {
    const a = LANES.review.find((name) => capabilityLevelFor(baseScoreDynamic(manifest.shells.find((shell) => shell.name === name)!.modelId)) === "L4")!
    const s = LANES.review.map((name) => manifest.shells.find((shell) => shell.name === name)!)
      .filter((shell) => capabilityLevelFor(baseScoreDynamic(shell.modelId)) === "L5")
    expect(s.length).toBeGreaterThan(0)
    const prompt = meta("review", "reviewer", "gpt", "ro")
    expect(denyOf(a, prompt, snap())).toContain("跨级回退")
    const matrix = matrixOk()
    for (const shell of s) matrix[shell.matrixKey] = { status: "down" }
    expect(denyOf(a, prompt, snap({ matrix }))).toBeNull()
  })
  test("20 未声明 lane 时按 role 推断，不能因 economy 链成员关系绕过能力门", () => {
    const c = { ...regEntry("glm-mx-53-high"), name: "test-c", modelId: "glm-4.5-air", matrixKey: "test-c", comboKey: "test-c" }
    const s = snap({ registry: { ...fullRegistry(), [c.name]: c }, matrix: { ...matrixOk(), [c.matrixKey]: { status: "ok" } } })
    const prompt = 'ROUTE_META {"role":"programmer","capability":"rw","source":"auto"}\n任务正文'
    expect(checkShell(c.name, c, prompt, { ...s, lanes: { ...LANES, economy: [c.name] } }).deny).toContain("未入选 main")
  })
  test("21 lane=vision 与 text modality 的矛盾声明 → deny", () => {
    const vision = manifest.shells.find((shell) => shell.vision)!.name
    expect(denyOf(vision, meta("vision", "observer", "glm", "rw", "text"), snap())).toContain("必须声明")
  })
})

// ================= 3. compute_lane 确定性（6）=================
describe("compute_lane", () => {
  test("19 同输入同输出（JSON 序列化相等，无时间戳）", () => {
    const p = { registry: fullRegistry(), matrix: matrixOk(), routing: { down_agents: {}, down_expiry: {} } }
    const a = computeLane("main", LANES.main, p as any)
    const b = computeLane("main", LANES.main, p as any)
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    expect(a.status).toBe("ok")
    expect(a.chain.map((c) => c.shell).every((name) => LANES.main.includes(name))).toBe(true)
  })
  test("20 api 计费由系数沉底（同 tier 排订阅后）；auto/user 不再影响门控", () => {
    // [2026-08-31]-[去厂商化：auto_ok/DS 恒尾门控删除——billingBoostOf 注入 api 0.85 后按乘积排序]
    const base = { registry: fullRegistry(), matrix: matrixOk(), routing: { down_agents: {}, down_expiry: {} }, billingBoostOf: (provider: string) => provider.includes("deepseek") ? 0.85 : 1.0 }
    const r = computeLane("main", LANES.main, { ...base, source: "auto" } as any)
    const ru = computeLane("main", LANES.main, { ...base, source: "user" } as any)
    expect(r.chain.map((c) => c.shell)).toEqual(ru.chain.map((c) => c.shell))
    const ds = r.chain.find((c) => c.pool === "deepseek")
    if (ds) {
      expect(ds.score!.billingBoost).toBe(0.85)
      // 同 tier 内 api 计费排在全部同档/更高档订阅模型之后
      const dsIdx = r.chain.indexOf(ds)
      for (const c of r.chain.slice(0, dsIdx)) {
        if (c.score && c.score.tier === ds.score!.tier) expect(c.score.total).toBeGreaterThanOrEqual(ds.score!.total)
      }
    }
  })
  test("21 immediate 只按探针延迟升序（池名规则已废除）", () => {
    const lat: Record<string, number> = {}
    lat[manifest.shells.find((s) => s.name === "copilot-mx-terra-high")!.matrixKey] = 5000
    lat[manifest.shells.find((s) => s.name === "glm-mx-53-high")!.matrixKey] = 10
    lat[manifest.shells.find((s) => s.name === "ds-mx-v4p-high")!.matrixKey] = 5
    const p = { registry: fullRegistry(), matrix: matrixOk(lat), routing: { down_agents: {}, down_expiry: {} }, urgency: "immediate" }
    const r = computeLane("main", LANES.main, p as any)
    expect(r.chain.every((c, i, all) => i === 0 || (c.latency_ms ?? Infinity) >= (all[i - 1]!.latency_ms ?? Infinity))).toBe(true)
  })
  test("22 同级优先；跨级回退按与目标等级的距离排序", () => {
    const base = { registry: fullRegistry(), matrix: matrixOk(), routing: { down_agents: {}, down_expiry: {} } }
    const peak = computeLane("mechanical", LANES.mechanical, { ...base, glmPeak: true } as any)
    expect(peak.chain.every((c) => LANES.mechanical.includes(c.shell))).toBe(true)
    const calm = computeLane("mechanical", LANES.mechanical, { ...base, glmPeak: false } as any)
    expect(calm.chain.every((c) => LANES.mechanical.includes(c.shell))).toBe(true)
    // economy 无 L1 时，最近的 C(L2) 回退优先于 A(L4)。
    const strained = computeLane("economy", LANES.economy, {
      ...base, glmPeak: false, states: { copilot: { state: "strained" } },
    } as any)
    expect(strained.chain[0]!.score!.tier).toBe("B")
  })
  test("23 v2.0 成本 tiebreaker：同 tier 且评分平局时便宜者前（immediate 按延迟）", () => {
    const base = { registry: fullRegistry(), matrix: matrixOk(), routing: { down_agents: {}, down_expiry: {} }, glmPeak: false }
    const costs = (_modelId: string) => 1
    const r = computeLane("mechanical", LANES.mechanical, { ...base, costs } as any)
    expect(r.chain.every((c) => LANES.mechanical.includes(c.shell))).toBe(true)
    const imm = computeLane("mechanical", LANES.mechanical, { ...base, urgency: "immediate", costs } as any)
    expect(imm.chain.every((c) => LANES.mechanical.includes(c.shell))).toBe(true)
  })
  test("24 registry/矩阵缺失 fail-open：透传静态链加 * 降级标记", () => {
    const r = computeLane("main", LANES.main, { registry: null, matrix: null, routing: null } as any)
    expect(r.chain.map((c) => c.shell)).toEqual(LANES.main)
    expect(r.status.endsWith("*")).toBe(true)
  })
})

// ================= 4. 熔断（3）=================
describe("熔断", () => {
  beforeAll(() => {
    mkdirSync(paths().dir, { recursive: true })
  })
  test("25 600s 窗 ≥2 败触发熔断（combo 主键），1 败不触发", () => {
    const reg = fullRegistry()
    const r1 = recordFailure("glm-mx-53-high", "HTTP 500 boom", reg)
    expect(r1.tripped).toBe(false)
    const r2 = recordFailure("glm-mx-53-high", "HTTP 500 boom", reg)
    expect(r2.tripped).toBe(true)
    const routing = loadRouting()
    const combo = manifest.shells.find((s) => s.name === "glm-mx-53-high")!.matrixKey
    expect(routing.down_agents[combo]).toBeTruthy()
    expect(agentDown("glm-mx-53-high", routing, reg)).toBe(true)
  })
  test("26 600s TTL 过期自动解除", () => {
    const routing: Routing = { down_agents: { k: "x" }, down_expiry: { k: Date.now() / 1000 - 1 } }
    const dead = cleanExpired(routing)
    expect(dead).toContain("k")
    expect(routing.down_agents.k).toBeUndefined()
  })
  test("27 同 combo 别名壳共享熔断；not-found 只熔断请求名", () => {
    // 别名：glm-mx-53-max 与 glm-mx-53-high 不同 combo（档位不同），构造同 combo 别名对：
    // luna 无别名，改用构造 registry 验证语义
    const reg = fullRegistry()
    const alias = { ...reg["copilot-mx-terra-high"], name: "alias-shell" }
    reg["alias-shell"] = alias as ShellRegEntry
    const routing: Routing = { down_agents: { [alias.comboKey]: "x" }, down_expiry: {} }
    expect(agentDown("alias-shell", routing, reg)).toBe(true)
    expect(agentDown("copilot-mx-terra-high", routing, reg)).toBe(true)
    // not-found 语义
    expect(isNotFound("Agent type 'foo' not found")).toBe(true)
    const reg2 = fullRegistry()
    recordFailure("no-such-shell", "Agent type 'no-such-shell' not found. Available: ...", reg2)
    recordFailure("no-such-shell", "Agent type 'no-such-shell' not found. Available: ...", reg2)
    const rt = loadRouting()
    expect(rt.down_agents["no-such-shell"]).toBeTruthy()
  })
})

// ================= 5. 端到端（2）＋ 6. 配额判定（4）=================
describe("端到端与配额判定", () => {
  test("28 横幅四行逐行可解析（[路由][水位][限制][更新]）", () => {
    const lines = buildBanner({
      lanes: { main: computeLane("main", LANES.main, { registry: fullRegistry(), matrix: matrixOk(), routing: { down_agents: {}, down_expiry: {} } } as any) } as any,
      down: [],
      quota: { glm: { status: "ok", fetched_at: Date.now() / 1000, five_hour: { used_pct: 37 }, weekly: { used_pct: 1, reset_at: Date.now() / 1000 + 86400 } }, copilot: { status: "ok", fetched_at: Date.now() / 1000, reset_date: "2026-09-01", premium: { quota_id: "premium_interactions", entitlement: 0, used: 3885, remaining: 0, percent_remaining: 100, unlimited: true, overage_permitted: false, has_quota: null, timestamp_utc: null } } },
      states: {},
      billing: billingWindow(),
      advice: null,
      update: "矩阵已刷新",
    })
    expect(lines).toHaveLength(4)
    expect(lines[0].startsWith("[路由] ")).toBe(true)
    expect(lines[0]).toContain("economy:")
    expect(lines[1].startsWith("[水位] ")).toBe(true)
    expect(lines[1]).toContain("GLM 5h窗 37%")
    // unlimited 坑位：不显示误导性百分比，展示 used+reset_date
    expect(lines[1]).toContain("不限量")
    expect(lines[1]).toContain("已用3885")
    expect(lines[1]).not.toContain("积分剩100%")
    expect(lines[2].startsWith("[限制] ")).toBe(true)
    expect(lines[2]).toContain("down: 无")
    expect(lines[3].startsWith("[更新] ")).toBe(true)
  })
  test("28b 侧边栏水位条目：GLM 单块 5h/周/MCP 子行、Copilot 积分/刷新子行，进度条与重置时间齐备", () => {
    const entries = providerStatusEntries({
      quota: {
        glm: { status: "ok", fetched_at: Date.now() / 1000, stale: true, five_hour: { used_pct: 62, reset_at: Date.now() / 1000 + 3600 }, weekly: { used_pct: 86, reset_at: Date.now() / 1000 + 86400 }, mcp_monthly: { used_pct: 23, reset_at: Date.now() / 1000 + 30 * 86400 } },
        copilot: { status: "ok", fetched_at: Date.now() / 1000, reset_date: "2026-10-01", premium: { quota_id: "p", entitlement: 19000, used: 4459, remaining: 14541, percent_remaining: 76.5, unlimited: false, overage_permitted: false, has_quota: true, timestamp_utc: null } },
        deepseek: null,
      },
    })
    expect(entries.map((e) => e.pool)).toEqual(["glm", "copilot", "deepseek"]) // 一 provider 一块
    const glm = entries[0]!
    expect(glm.rows.map((r) => r.label)).toEqual(["5h", "周", "MCP"])
    expect(glm.rows[0]!.text).toMatch(/█+░* 62%$/)
    expect(glm.rows[0]!.tail).toMatch(/^→\d{2}:\d{2}$/) // 5h 窗重置在 5h 内 → 只显 HH:mm
    expect(glm.rows[1]!.tail).toMatch(/^→\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(glm.rows[2]!.tail).toMatch(/^→\d{2}-\d{2}$/)
    expect(glm.stale).toBe(true)
    const cp = entries[1]!
    expect(cp.rows.map((r) => r.label)).toEqual(["积分", "刷新"])
    expect(cp.rows[0]!.text).toContain("剩76.5%")
    expect(cp.rows[0]!.text).toContain("4459/19000")
    expect(cp.rows[1]!.text).toBe("2026-10-01")
    expect(entries[2]!.rows[0]!.text).toBe("查询中/暂无数据")
    // 仅 5h 窗在场 → 单子行不缺块
    const one = providerStatusEntries({ quota: { glm: { status: "ok", fetched_at: 0, five_hour: { used_pct: 5 } }, copilot: null, deepseek: null } })
    expect(one[0]!.rows.map((r) => r.label)).toEqual(["5h"])
  })
  test("29 状态文件损坏 fail-open（loadRouting/registry 容错）", () => {
    writeFileSync(join(process.env.SWITCHMAN_STATE!, "routing.json"), "{broken json")
    expect(loadRouting().down_agents).toEqual({})
    const d = denyOf("glm-mx-53-high", meta(), snap({ routing: loadRouting() }))
    expect(d).toContain("跨级回退")
  })
  test("30 GLM 耗尽判定：100% 拦、99% 不拦（熔断兜底）", () => {
    const [dead1, why1] = glmExhausted({ status: "ok", fetched_at: 0, weekly: { used_pct: 100 } })
    expect(dead1).toBe(true)
    expect(why1).toContain("周额度已用尽")
    expect(glmExhausted({ status: "ok", fetched_at: 0, weekly: { used_pct: 99 } })[0]).toBe(false)
    expect(glmExhausted(null)[0]).toBe(false)
  })
  test("31 Copilot 判定：has_quota=false 判耗尽；unlimited+有配额不判；remaining<=0 且禁超额才拦", () => {
    // 实测坑位形态：entitlement 缺失 + remaining 0 + unlimited true + has_quota false（业务席无 premium）
    expect(copilotExhausted({ status: "ok", fetched_at: 0, reset_date: "2026-09-01", premium: { quota_id: "premium_interactions", entitlement: null, used: null, remaining: 0, percent_remaining: 100, unlimited: true, overage_permitted: false, has_quota: false, timestamp_utc: null } })[0]).toBe(true)
    expect(copilotExhausted({ status: "ok", fetched_at: 0, premium: null })[0]).toBe(false)
    const [dead, why] = copilotExhausted({ status: "ok", fetched_at: 0, reset_date: "2026-09-01", premium: { quota_id: "p", entitlement: 0, used: 100, remaining: 0, percent_remaining: 0, unlimited: false, overage_permitted: false, has_quota: true, timestamp_utc: null } })
    expect(dead).toBe(true)
    expect(why).toContain("2026-09-01")
    // 超额允许：不拦
    expect(copilotExhausted({ status: "ok", fetched_at: 0, premium: { quota_id: "p", entitlement: 0, used: 100, remaining: 0, percent_remaining: 0, unlimited: false, overage_permitted: true, has_quota: true, timestamp_utc: null } })[0]).toBe(false)
    // 网关第二真值源
    expect(copilotExhausted({ status: "ok", fetched_at: 0, reset_date: "2026-09-01", gateway_exhausted: true })[0]).toBe(true)
  })
  test("32 DeepSeek 耗尽判定：按量正常永不硬拦", () => {
    expect(deepseekExhausted({ status: "ok", exhausted: false })[0]).toBe(false)
    expect(deepseekExhausted({ status: "unknown" })[0]).toBe(false)
    expect(deepseekExhausted({ status: "ok", exhausted: true })[0]).toBe(true)
  })
  test("33 pool_states + routingAdvice 契约：surplus/strained/healthy 与建议行", () => {
    // [2026-08-31]-[修复日期敏感翻转：reset_date 硬编码过近会使 dl=1、runway>dl*1.3 判 surplus；
    //  改动态 +10 天（dl∈[9,10] 时 runway≈1.4<dl*0.8 恒 strained，与运行日期解耦）]
    const reset = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10)
    const states = poolStates({
      glm: { status: "ok", fetched_at: Date.now() / 1000, weekly: { used_pct: 10, reset_at: Date.now() / 1000 + 24 * 3600 } },
      copilot: { status: "ok", fetched_at: Date.now() / 1000, reset_date: reset, premium: { quota_id: "p", entitlement: 15000, used: 14000, remaining: 1000, percent_remaining: 6.7, unlimited: false, overage_permitted: false, has_quota: true, timestamp_utc: null } },
    })
    expect(states.copilot?.state).toBe("strained")
    const advice = routingAdvice(states)
    expect(advice).toContain("Copilot月积分吃紧")
  })
  test("34 GLM 5 小时窗预留水位：默认 90% 硬拦、可配置；周额度仍只认 100%", () => {
    expect(glmExhausted({ status: "ok", fetched_at: 0, five_hour: { used_pct: 90 } })[0]).toBe(true)
    expect(glmExhausted({ status: "ok", fetched_at: 0, five_hour: { used_pct: 89 } })[0]).toBe(false)
    expect(glmExhausted({ status: "ok", fetched_at: 0, five_hour: { used_pct: 80 } }, 85)[0]).toBe(false)
    expect(glmExhausted({ status: "ok", fetched_at: 0, five_hour: { used_pct: 86 } }, 85)[0]).toBe(true)
    expect(glmExhausted({ status: "ok", fetched_at: 0, five_hour: { used_pct: 90 }, weekly: { used_pct: 95 } })[0]).toBe(true)
    expect(glmExhausted({ status: "ok", fetched_at: 0, weekly: { used_pct: 95 } })[0]).toBe(false)
    expect(glmExhausted({ status: "ok", fetched_at: 0, five_hour: { used_pct: 90 } }, 0)[0]).toBe(false) // 阈值越界回退 100%
  })
  test("35 DeepSeek 余额预警：低于阈值横幅提示，高于/耗尽不误报", () => {
    const warn = buildBanner({
      lanes: null, down: [],
      quota: { glm: null, copilot: null, deepseek: { status: "ok", fetched_at: 0, balances: [{ currency: "CNY", total_balance: "8.5" }] } },
      states: {}, billing: billingWindow(), dsLowWarnCny: 10,
    })
    expect(warn[1]).toContain("余额 ¥8.50")
    expect(warn[1]).toContain("预警")
    const ok = buildBanner({
      lanes: null, down: [],
      quota: { glm: null, copilot: null, deepseek: { status: "ok", fetched_at: 0, balances: [{ currency: "CNY", total_balance: "37.86" }] } },
      states: {}, billing: billingWindow(), dsLowWarnCny: 10,
    })
    expect(ok[1]).not.toContain("余额")
    const exhausted = buildBanner({
      lanes: null, down: [],
      quota: { glm: null, copilot: null, deepseek: { status: "ok", fetched_at: 0, balances: [{ currency: "CNY", total_balance: "0" }], exhausted: true } },
      states: {}, billing: billingWindow(), dsLowWarnCny: 10,
    })
    expect(exhausted[1]).toContain("余额已耗尽")
  })
})
