// [2026-09-04]-[English localization: translate comments and messages; no logic change]
// Full-matrix generator: authoritative enabled surface × thinking efforts → src/shells.json
// [2026-08-28]-[First source of truth for the enabled surface = scripts/visible-models.txt (models
//  enabled in the desktop model-management UI, kept in sync by hand); when the file is missing,
//  fall back to `opencode models` minus the desktop hide filter (automatic fallback, known to drift
//  from the core bundled with the app)]-
// [Effort source of truth = models.dev reasoning_options (unified across the three pools, incl.
//  GLM/DeepSeek; toggle = thinking can be turned off → off; in the Copilot catalog none is a synonym
//  for off); vision = attachment/modalities; the Copilot catalog is the fallback]
// [2026-08-29]-[naming/family/effort/shell expansion logic extracted into src/catalog.ts for sharing
//  (the runtime dynamic superset is generated from the same source); this script keeps only enabled
//  surface collection and artifact writing; gen:shells output semantics unchanged]
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { buildShells, bundledModelIndex, fetchModelsDevIndex } from "../src/catalog"
import type { EffortInfo } from "../src/catalog"
import { baseScoreFromCapabilityIndex, loadBundledCapability } from "../src/capability"
import { baseScore, UNKNOWN_PENALTY } from "../src/model-ranks"
import { BILLING_API_BOOST } from "../src/scoring"
import { defaultBillingOf } from "../src/provider-config"
import { computeLaneChain } from "../src/lane-policy"

type Effort = string

// ---- 1) Enabled surface: pin file first, automatic fallback ----
async function enabledVisibleModels(): Promise<string[]> {
  const pinPath = new URL("./visible-models.txt", import.meta.url)
  if (existsSync(pinPath)) {
    const lines = readFileSync(pinPath, "utf8").split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("/"))
    if (lines.length > 0) {
      console.log(`[gen-shells] enabled surface = visible-models.txt (authoritative pin, ${lines.length} models)`)
      return lines
    }
  }
  const proc = Bun.spawnSync(["opencode", "models"], { stdout: "pipe", stderr: "pipe" })
  const out = new TextDecoder().decode(proc.stdout)
  if (proc.exitCode !== 0 || !out.trim()) {
    throw new Error(`opencode models failed (exit=${proc.exitCode}): ${new TextDecoder().decode(proc.stderr).slice(0, 200)}`)
  }
  const all = out.split("\n").map((l) => l.trim()).filter((l) => l.includes("/"))
  const hidden = managementHidden()
  const vis = all.filter((full) => {
    const slash = full.indexOf("/")
    return !hidden.has(`${full.slice(0, slash)}|${full.slice(slash + 1)}`)
  })
  console.warn(`[gen-shells] visible-models.txt not found; falling back to automatic mode: opencode models=${all.length}, hidden by model management=${hidden.size}, visible=${vis.length} (note: may drift from the core bundled with the app)`)
  return vis
}

/** Desktop model-management hide set (for automatic mode) */
function managementHidden(): Set<string> {
  const candidates = [
    join(homedir(), "Library", "Application Support", "ai.opencode.desktop", "opencode.global.dat"),
    join(homedir(), ".config", "ai.opencode.desktop", "opencode.global.dat"),
    join(process.env.XDG_DATA_HOME ?? "", "ai.opencode.desktop", "opencode.global.dat"),
  ]
  for (const p of candidates) {
    try {
      if (!p || !existsSync(p)) continue
      const dat = JSON.parse(readFileSync(p, "utf8"))
      if (!dat?.model) continue
      const modelState = typeof dat.model === "string" ? JSON.parse(dat.model) : dat.model
      const user = Array.isArray(modelState?.user) ? modelState.user : []
      const hide = new Set<string>()
      for (const e of user) {
        if (e?.visibility === "hide" && e.providerID && e.modelID) hide.add(`${e.providerID}|${e.modelID}`)
      }
      return hide
    } catch { /* next candidate */ }
  }
  return new Set()
}

// ---- 2) Effort source: models.dev (parsing lives in src/catalog; the script connects directly, bypassing the state-dir cache) ----


// Official Copilot catalog (fallback: used when models.dev has gaps)
async function copilotCatalog(): Promise<Record<string, EffortInfo>> {
  const token = resolveGithubToken()
  if (!token) return {}
  const H = {
    Accept: "application/json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "GitHubCopilotChat/0.35.0",
    "Editor-Version": "vscode/1.107.0",
    "Editor-Plugin-Version": "copilot-chat/0.35.0",
    "Copilot-Integration-Id": "vscode-chat",
  }
  const xchg = await fetch("https://api.github.com/copilot_internal/v2/token", { headers: H, signal: AbortSignal.timeout(10_000) })
  if (!xchg.ok) return {}
  const xj = await xchg.json() as any
  let apiBase: string | undefined = xj.endpoints?.api
  try {
    const payload = JSON.parse(Buffer.from(xj.token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"))
    const ep = /proxy-ep=([^;\s]+)/.exec(payload)?.[1]
    if (ep) apiBase = ep.replace("proxy.", "api.")
  } catch { /* fall back to endpoints.api */ }
  apiBase = apiBase || "https://api.individual.githubcopilot.com"
  const res = await fetch(`${apiBase}/models`, { headers: { ...H, Authorization: `Bearer ${xj.token}` }, signal: AbortSignal.timeout(10_000) })
  if (!res.ok) return {}
  const list = (await res.json() as any).data ?? []
  const out: Record<string, EffortInfo> = {}
  for (const m of list) {
    const sup = m?.capabilities?.supports ?? {}
    const lim = m?.capabilities?.limits ?? {}
    const efforts: string[] = Array.isArray(sup.reasoning_effort) ? sup.reasoning_effort.map(String) : []
    out[`github-copilot/${String(m.id)}`] = {
      efforts,
      toggle: efforts.includes("none"),
      vision: Boolean(lim.vision) || sup.vision === true,
    }
  }
  return out
}

function resolveGithubToken(): string | undefined {
  const argIdx = process.argv.indexOf("--token")
  if (argIdx > 0 && process.argv[argIdx + 1]) return process.argv[argIdx + 1]
  if (process.env.SWITCHMAN_GITHUB_TOKEN) return process.env.SWITCHMAN_GITHUB_TOKEN
  for (const p of [join(homedir(), ".opencode", "auth.json"), join(homedir(), ".github-copilot-proxy", "auth.json")]) {
    try {
      if (!existsSync(p)) continue
      const j = JSON.parse(readFileSync(p, "utf8"))
      const t = j?.["github-copilot"]?.access ?? j?.githubToken
      if (typeof t === "string" && t) return t
    } catch { /* next candidate */ }
  }
  return undefined
}

async function main() {
  const enabled = await enabledVisibleModels()
  const [devIndex, cpCatalog] = await Promise.all([
    fetchModelsDevIndex().then((r) => r.index).catch((e) => {
      console.warn(`[gen-shells] models.dev fetch failed: ${e}`)
      return {} as Record<string, EffortInfo>
    }),
    copilotCatalog().catch(() => ({}) as Record<string, EffortInfo>),
  ])
  // models.dev wins, Copilot catalog fills gaps (same semantics as the original devIndex[full] ?? cpCatalog[full])
  const metaIndex: Record<string, EffortInfo> = { ...bundledModelIndex(), ...cpCatalog, ...devIndex }
  const shells = buildShells(enabled, metaIndex, { roAliases: true })
  const bundled = loadBundledCapability()
  // [2026-08-31]-[Final-review P0-1: capabilityOf returns {score,tier}; chain generation groups by tier, the same key used by runtime rankCandidates]
  const capabilityOf = (modelId: string) => baseScoreFromCapabilityIndex(modelId, bundled) ?? baseScore(modelId)
  // [2026-08-31]-[Vendor-neutral: chain generation multiplies billingBoost×unknownPenalty — at
  //  generation time there is no user jsonc, so billing takes the bundled factory default
  //  (subscription/api) and unknown is derived from the capability-tier fallback chain
  //  (global = unknown group); at runtime laneBaseChain runs the same algorithm over the parsed user
  //  config, keeping the semantics identical]
  const knownOf = (modelId: string) =>
    (baseScoreFromCapabilityIndex(modelId, bundled)?.source ?? baseScore(modelId).source) !== "global"
  const billingBoostOf = (provider: string) => defaultBillingOf(provider) === "subscription" ? 1.0 : BILLING_API_BOOST
  const resolvers = { billingBoostOf, unknownOf: (modelId: string) => !knownOf(modelId) }
  const lanes = Object.fromEntries(["economy", "mechanical", "main", "hard", "vision", "review"].map((lane) => [lane, computeLaneChain(shells, capabilityOf, lane as any, resolvers)])) as Record<string, string[]>
  const seen = new Set(shells.map((s) => s.name))

  const missing = Object.values(lanes).flat().filter((n) => !seen.has(n))
  if (missing.length > 0) throw new Error(`six-lane chains reference shells absent from the visible matrix (enabled-surface/effort drift?): ${missing.join(", ")}`)

  const doc = {
    _note: `opencode-switchman full matrix: authoritative enabled surface (models enabled in model management, scripts/visible-models.txt) × all declared thinking efforts (models.dev reasoning_options, toggle→off). Generated by scripts/gen-shells.ts — do not edit by hand; after model on/off changes, sync the pin file and re-run bun run gen:shells. The six lane chains are computed from capability score × lane affinity × structural gate × billing factor (api billing ${BILLING_API_BOOST}, unknown group ${UNKNOWN_PENALTY}, sunk by coefficient; no vendor-reserved seats).`,
    generated_at: new Date().toISOString(),
    counts: { shells: shells.length, visible_models: enabled.length },
    shells,
    lanes,
  }
  writeFileSync(new URL("../src/shells.json", import.meta.url), `${JSON.stringify(doc, null, 2)}\n`)
  const byPool: Record<string, number> = {}
  for (const s of shells) byPool[s.pool] = (byPool[s.pool] ?? 0) + 1
  console.log(`[gen-shells] visible models ${enabled.length} → shells ${shells.length} (${JSON.stringify(byPool)}); all ${Object.values(lanes).flat().length} shells referenced by the six lane chains resolved`)
}

main()
