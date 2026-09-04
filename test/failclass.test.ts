// [2026-09-04]-[English localization: translate comments and expectation strings; no test-logic change]
// Vendor-agnostic failure classification layer + model retirement fixtures (bun test)
import { describe, test, expect, beforeAll } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

process.env.SWITCHMAN_STATE = mkdtempSync(join(tmpdir(), "switchman-fc-"))

import { classifyFailure } from "../src/failclass"
import {
  REAL_FAIL_TTL_MS, RATE_LIMIT_TTL_MS, ENDPOINT_TTL_MS, markRealFailure, isRealFailedCombo,
  recordIsolation, recordInjection, recordFailure, realFailedRemainingMs,
  noteModelNotFound, isModelRetired, retiredModelKeys, filterRetiredShells,
} from "../src/breaker"
import { checkShell } from "../src/gates"
import { buildBanner } from "../src/banner"
import { billingWindow } from "../src/lane"
import type { ShellRegEntry } from "../src/types"

const META = 'ROUTE_META {"lane":"main","role":"programmer","capability":"rw","source":"auto"}'

function shell(provider = "p", modelId = "model"): ShellRegEntry {
  return {
    name: `test-mx-${modelId}-high`, pool: "glm", provider, modelId,
    effort: "high", family: "glm", capability: "rw", vision: false,
    matrixKey: `${provider}|${modelId}|high`, comboKey: `${provider}|${modelId}|high`,
    status: "enabled",
  } as ShellRegEntry
}

// ================= 1. classifyFailure verdict table =================
describe("failure classification classifyFailure", () => {
  test("not_found: 404 and stale/decommissioned model names", () => {
    expect(classifyFailure("HTTP 404: model not found")).toBe("not_found")
    expect(classifyFailure("Model unknown model or decommissioned")).toBe("not_found")
    expect(classifyFailure("已下线")).toBe("not_found") // fixture: Chinese sentinel emitted by local probe
  })
  test("rate_limit: 429 and throttling wording", () => {
    expect(classifyFailure("HTTP 429: rate limited")).toBe("rate_limit")
    expect(classifyFailure("too many requests, throttled")).toBe("rate_limit")
  })
  test("quota: 402/balance/quota and the 403-quota special case", () => {
    expect(classifyFailure("HTTP 402: payment required")).toBe("quota")
    expect(classifyFailure("insufficient balance")).toBe("quota")
    expect(classifyFailure("HTTP 403: monthly quota exceeded")).toBe("quota")
    expect(classifyFailure("HTTP 403: credit limit reached")).toBe("quota")
  })
  test("auth: 401/api key and 403-forbidden classified as auth", () => {
    expect(classifyFailure("HTTP 401: unauthorized")).toBe("auth")
    expect(classifyFailure("invalid api key")).toBe("auth")
    expect(classifyFailure("HTTP 403: Forbidden")).toBe("auth")
  })
  test("server: 5xx and overload", () => {
    expect(classifyFailure("HTTP 500")).toBe("server")
    expect(classifyFailure("HTTP 502 bad gateway")).toBe("server")
  })
  test("network: timeouts and connection-layer errors", () => {
    expect(classifyFailure("TimeoutError")).toBe("network")
    expect(classifyFailure("ECONNREFUSED")).toBe("network")
  })
  test("fallback unknown", () => {
    expect(classifyFailure("some random gibberish")).toBe("unknown")
  })
  // [2026-09-01]-[config-layer failures separated: dispatch-layer (shell unregistered) does not poison probe-ok models;
  //  incompatible endpoint = permanent config error]
  test("shell_injection: unregistered shell name (dispatch-layer failure)", () => {
    expect(classifyFailure("Unknown agent type: copilot-mx-x-high is not a valid agent type")).toBe("shell_injection")
    expect(classifyFailure("Error: no such agent: foo")).toBe("shell_injection")
  })
  test("endpoint: incompatible endpoint/shape (permanent config error)", () => {
    expect(classifyFailure('model "m" is not accessible via the /chat/completions endpoint')).toBe("endpoint")
    expect(classifyFailure("responses API does not support this model")).toBe("endpoint")
    expect(classifyFailure("unsupported endpoint")).toBe("endpoint")
  })
})

// ================= 2. rate_limit short TTL vs default long TTL =================
describe("real-call failure TTL separation", () => {
  test("rate-limit short mark expires after 10 minutes, real-failure long mark persists", () => {
    const now = Date.now()
    markRealFailure("rl|combo", now, RATE_LIMIT_TTL_MS)
    markRealFailure("lf|combo", now)
    expect(isRealFailedCombo("rl|combo", now)).toBe(true)
    expect(isRealFailedCombo("lf|combo", now)).toBe(true)
    // After the short TTL: the rate-limit mark expired, the long-lived mark still holds
    expect(isRealFailedCombo("rl|combo", now + RATE_LIMIT_TTL_MS + 1)).toBe(false)
    expect(isRealFailedCombo("lf|combo", now + RATE_LIMIT_TTL_MS + 1)).toBe(true)
    // After the long TTL: both expired
    expect(isRealFailedCombo("lf|combo", now + REAL_FAIL_TTL_MS + 1)).toBe(false)
  })
  // [2026-09-01]-[endpoint 6h long TTL; remaining-ms query (banner TTL display)]
  test("endpoint long TTL and realFailedRemainingMs", () => {
    const now = Date.now()
    markRealFailure("ep|combo", now, ENDPOINT_TTL_MS)
    expect(isRealFailedCombo("ep|combo", now + REAL_FAIL_TTL_MS + 1)).toBe(true) // still held after 30m
    expect(isRealFailedCombo("ep|combo", now + ENDPOINT_TTL_MS + 1)).toBe(false) // expired after 6h
    markRealFailure("rem|combo", now, 60_000)
    expect(realFailedRemainingMs("rem|combo", now + 20_000)).toBe(40_000)
    expect(realFailedRemainingMs("rem|combo", now + 61_000)).toBeNull()
    expect(realFailedRemainingMs("absent", now)).toBeNull()
  })
  test("recordIsolation/recordInjection persist kind entries without entering the breaker count", () => {
    recordIsolation("iso-agent", "p|iso-model|high", "endpoint", ENDPOINT_TTL_MS, "boom")
    recordInjection("inj-agent", "Unknown agent type: inj-agent is not a valid agent type")
    const lines = readFileSync(join(process.env.SWITCHMAN_STATE!, "failures.log"), "utf8").trim().split("\n")
    const iso = JSON.parse(lines[lines.length - 2])
    const inj = JSON.parse(lines[lines.length - 1])
    expect(iso.kind).toBe("isolated")
    expect(iso.key).toBe("p|iso-model|high")
    expect(iso.reason).toContain("endpoint")
    expect(inj.kind).toBe("injection")
    // kind entries do not count into the breaker window: after 2 consecutive isolated entries for the same key,
    // 1 real failure must not trip the breaker (threshold 2)
    recordIsolation("cnt-agent", "cnt-key", "server", 600_000, "x")
    recordIsolation("cnt-agent", "cnt-key", "server", 600_000, "x")
    const rec = recordFailure("cnt-key", "real failure one", null)
    expect(rec.tripped).toBe(false)
    const rec2 = recordFailure("cnt-key", "real failure two", null)
    expect(rec2.tripped).toBe(true) // 2 real failures are required to trip
  })
})

// ================= 3. Model retirement (consecutive 404s) =================
describe("model retirement noteModelNotFound", () => {
  test("3 hits within the 1h window trigger retirement, returning true exactly at the trigger", () => {
    const now = Date.now()
    expect(noteModelNotFound("p/retire-me", now)).toBe(false)
    expect(noteModelNotFound("p/retire-me", now + 1)).toBe(false)
    expect(noteModelNotFound("p/retire-me", now + 2)).toBe(true) // third hit triggers exactly
    expect(isModelRetired("p/retire-me")).toBe(true)
    expect(retiredModelKeys()).toContain("p/retire-me")
    // Already retired: further notes do not re-trigger
    expect(noteModelNotFound("p/retire-me", now + 3)).toBe(false)
  })
  test("fewer than 3 hits does not retire", () => {
    const now = Date.now()
    noteModelNotFound("p/not-yet", now)
    noteModelNotFound("p/not-yet", now + 1)
    expect(isModelRetired("p/not-yet")).toBe(false)
  })
  test("filterRetiredShells filters out retired-model shells", () => {
    noteModelNotFound("p/filtered", Date.now())
    noteModelNotFound("p/filtered", Date.now() + 1)
    noteModelNotFound("p/filtered", Date.now() + 2)
    const kept = filterRetiredShells([
      { provider: "p", modelId: "filtered" },
      { provider: "p", modelId: "alive" },
    ])
    expect(kept.map((s) => s.modelId)).toEqual(["alive"])
  })
})

// ================= 4. Retirement gate deny =================
describe("retirement gate checkShell deny", () => {
  test("retiredModels hit on provider/modelId → deny carries the retired-model mark", () => {
    const s = shell("p", "retired-gate")
    const r = checkShell(s.name, s, META, {
      registry: { [s.name]: s },
      matrix: null,
      routing: { down_agents: {}, down_expiry: {} },
      quotaExhausted: {},
      retiredModels: new Set(["p/retired-gate"]),
      lanes: { main: [s.name] },
    })
    expect(r.deny).toContain("model retired")
  })
  test("no hit on the retired set → not blocked (fail-open)", () => {
    const s = shell("p", "glm-5.3-flash")
    const r = checkShell(s.name, s, META, {
      registry: { [s.name]: s },
      matrix: null,
      routing: { down_agents: {}, down_expiry: {} },
      quotaExhausted: {},
      retiredModels: new Set<string>(),
      lanes: { main: [s.name] },
    })
    expect(r.deny).toBeNull()
  })
})

// ================= 5. Banner [LIMITS] carries retired marks =================
describe("banner retired marks", () => {
  test("with retiredModels>0 the [LIMITS] line carries the retired mark", () => {
    const lines = buildBanner({
      lanes: null, down: [],
      quota: { glm: null, copilot: null },
      states: {}, billing: billingWindow(),
      matrixInfo: { mode: "desktop", configStatus: "ok", watch: true, retiredModels: 3 },
    })
    expect(lines[2]).toContain("3 models retired")
  })
  test("with retiredModels=0 nothing is appended", () => {
    const lines = buildBanner({
      lanes: null, down: [],
      quota: { glm: null, copilot: null },
      states: {}, billing: billingWindow(),
      matrixInfo: { mode: "desktop", configStatus: "ok", watch: true, retiredModels: 0 },
    })
    expect(lines[2]).not.toContain("retired")
  })
  // [2026-09-01]-[down source annotation: Map form shows the source per name (breaker / real-fail isolation·time left),
  //  Set/array form stays as-is; source labels mirror index.ts/banner.ts wording]
  test("down Map annotates source and remaining time", () => {
    const lines = buildBanner({
      lanes: null,
      down: new Map<string, string>([
        ["github-copilot|gpt-5.6-luna|high", "real-fail isolation·12m left"],
        ["other-pool|some-model|low", "breaker"],
      ]),
      quota: { glm: null, copilot: null },
      states: {}, billing: billingWindow(),
    })
    expect(lines[2]).toContain("github-copilot|gpt-5.6-luna|high (real-fail isolation·12m left)")
    expect(lines[2]).toContain("other-pool|some-model|low (breaker)")
    expect(lines[2]).toContain("not dispatchable")
  })
  test("down array form has no annotation (backward compatible)", () => {
    const lines = buildBanner({
      lanes: null, down: ["p|m|high"],
      quota: { glm: null, copilot: null },
      states: {}, billing: billingWindow(),
    })
    expect(lines[2]).toContain("p|m|high (not dispatchable")
    expect(lines[2]).not.toContain("breaker")
  })
})
