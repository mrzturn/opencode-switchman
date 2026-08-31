// 生成随包内置的「官方能力排名默认快照」src/capability-default.json
// [2026-08-31]-[离线/拉取失败时的默认能力排名：实时链（capability.json）缺失时回退此快照；
//  随版本手动迭代——每次发版前重跑 `bun run gen:capability` 刷新（有 AA key 时自动优先 AA 绝对指数口径）]
// 数据口径：主源 Artificial Analysis（ARTIFICIAL_ANALYSIS_API_KEY 环境变量，绝对指数）；
//           备源 OpenRouter /api/v1/models?sort=coding-high-to-low（公开，coding 序位派生 rank 分）。
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
    console.log(`主源 AA 解析成功：${Object.keys(parsed.models).length} 模型`)
  } catch (exc) {
    console.error(`主源 AA 失败（${exc}）→ 转备源 OpenRouter`)
  }
}
if (!parsed) {
  const json = await fetchJson("https://openrouter.ai/api/v1/models?sort=coding-high-to-low", {})
  parsed = parseOpenRouterModels(json)
  version = `bundled-or-${parsed.versionHint ?? new Date().toISOString().slice(0, 10)}`
}
if (Object.keys(parsed.models).length === 0) throw new Error("解析为空，拒绝生成空快照")

const scores = Object.values(parsed.models).map((e) => e.score)
const idx: CapabilityIndex & { bundled: true; _meta: Record<string, string> } = {
  _meta: {
    generated_at: new Date().toISOString(),
    generator: "bun run gen:capability",
    upstream: source === "artificial-analysis"
      ? "artificialanalysis.ai /api/v2/data/llms/models（绝对指数）"
      : "openrouter.ai /api/v1/models?sort=coding-high-to-low（coding 序位 rank 分）",
    note: "离线/拉取失败的随包默认能力排名；随版本手动迭代（重跑 gen:capability 刷新）",
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
console.log(`已生成 src/capability-default.json：${source} ${scores.length} 模型（score_kind=${parsed.scoreKind}，version=${version}）`)
