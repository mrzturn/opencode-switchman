// [2026-09-04]-[English localization: translate comments and messages; no logic change]
// Generates the bundled "official capability-rank default snapshot" src/capability-default.json
// [2026-08-31]-[Default capability rank for offline/fetch-failure: the runtime chain (capability.json)
//  falls back to this snapshot when missing; iterated manually per release — re-run
//  `bun run gen:capability` before each release to refresh (with an AA key, the AA absolute-index
//  source automatically takes priority)]
// Data sources: primary Artificial Analysis (ARTIFICIAL_ANALYSIS_API_KEY env var, absolute index);
//                fallback OpenRouter /api/v1/models?sort=coding-high-to-low (public, rank score derived from coding position).
import { writeFileSync } from "node:fs"
import { parseAaModels, parseOpenRouterModels, resolveThresholds } from "../src/capability"
import type { CapabilityIndex } from "../src/capability"

const FETCH_TIMEOUT_MS = 30_000

async function fetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", "User-Agent": "opencode-switchman/0.1", ...headers },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return await res.json()
}

let parsed: ReturnType<typeof parseAaModels> | null = null
let source: CapabilityIndex["source"] = "openrouter"
let version: string

const aaKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY ?? process.env.AA_API_KEY
if (aaKey) {
  try {
    parsed = parseAaModels(await fetchJson("https://artificialanalysis.ai/api/v2/data/llms/models", { "x-api-key": aaKey }))
    source = "artificial-analysis"
    version = `bundled-aa-${parsed.versionHint ?? new Date().toISOString().slice(0, 10)}`
    console.log(`primary source AA parsed: ${Object.keys(parsed.models).length} models`)
  } catch (exc) {
    console.error(`primary source AA failed (${exc}) → switching to fallback OpenRouter`)
  }
}
if (!parsed) {
  const json = await fetchJson("https://openrouter.ai/api/v1/models?sort=coding-high-to-low", {})
  parsed = parseOpenRouterModels(json)
  version = `bundled-or-${parsed.versionHint ?? new Date().toISOString().slice(0, 10)}`
}
if (Object.keys(parsed.models).length === 0) throw new Error("parsed result is empty; refusing to generate an empty snapshot")

const scores = Object.values(parsed.models).map((e) => e.score)
const idx: CapabilityIndex & { bundled: true; _meta: Record<string, string> } = {
  _meta: {
    generated_at: new Date().toISOString(),
    generator: "bun run gen:capability",
    upstream: source === "artificial-analysis"
      ? "artificialanalysis.ai /api/v2/data/llms/models (absolute index)"
      : "openrouter.ai /api/v1/models?sort=coding-high-to-low (rank score from coding position)",
    note: "Bundled default capability rank for offline/fetch-failure; iterated manually per release (re-run gen:capability to refresh)",
  },
  bundled: true,
  source,
  version,
  fetched_at: Date.now() / 1000,
  score_kind: parsed.scoreKind,
  thresholds: resolveThresholds(parsed.scoreKind === "rank" ? "quantile" : undefined, scores),
  models: parsed.models,
  counts: { models: scores.length },
}

writeFileSync(new URL("../src/capability-default.json", import.meta.url).pathname, `${JSON.stringify(idx, null, 2)}\n`)
console.log(`generated src/capability-default.json: ${source} ${scores.length} models (score_kind=${parsed.scoreKind}, version=${version})`)
