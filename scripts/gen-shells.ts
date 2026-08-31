// 全量矩阵生成器：权威启用面 × 思考档位 → src/shells.json
// [2026-08-28]-[启用面第一真源=scripts/visible-models.txt（桌面端模型管理 UI 打开的模型，手工同步）；
//  文件缺失时降级为 opencode models − 桌面端 hide 过滤（自动兜底，已知与 app 内嵌核心目录存在版本差）]-
// [档位真源=models.dev reasoning_options（三池统一，含 GLM/DeepSeek；toggle=可关思考→off，
//  Copilot 目录 none 同义 off）；vision=attachment/modalities；Copilot 目录为 fallback]
// [2026-08-29]-[命名/家族/档位/壳展开逻辑抽取至 src/catalog.ts 共享（运行期动态超集同源生成），
//  本脚本只保留启用面收集与产物落盘；gen:shells 产物语义不变]
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

// ---- 1) 启用面：pin 文件优先，自动兜底 ----
async function enabledVisibleModels(): Promise<string[]> {
  const pinPath = new URL("./visible-models.txt", import.meta.url)
  if (existsSync(pinPath)) {
    const lines = readFileSync(pinPath, "utf8").split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("/"))
    if (lines.length > 0) {
      console.log(`[gen-shells] 启用面=visible-models.txt（权威 pin，${lines.length} 个模型）`)
      return lines
    }
  }
  const proc = Bun.spawnSync(["opencode", "models"], { stdout: "pipe", stderr: "pipe" })
  const out = new TextDecoder().decode(proc.stdout)
  if (proc.exitCode !== 0 || !out.trim()) {
    throw new Error(`opencode models 失败（exit=${proc.exitCode}）：${new TextDecoder().decode(proc.stderr).slice(0, 200)}`)
  }
  const all = out.split("\n").map((l) => l.trim()).filter((l) => l.includes("/"))
  const hidden = managementHidden()
  const vis = all.filter((full) => {
    const slash = full.indexOf("/")
    return !hidden.has(`${full.slice(0, slash)}|${full.slice(slash + 1)}`)
  })
  console.warn(`[gen-shells] 未找到 visible-models.txt，降级自动模式：opencode models=${all.length}，模型管理隐藏=${hidden.size}，可见=${vis.length}（注意：与 app 内嵌核心目录可能存在版本差）`)
  return vis
}

/** 桌面端模型管理 hide 集（自动模式用） */
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
    } catch { /* 下一个候选 */ }
  }
  return new Set()
}

// ---- 2) 档位源：models.dev（解析在 src/catalog；脚本直连不走状态目录缓存）----


// Copilot 官方目录（fallback：models.dev 缺项时用）
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
  } catch { /* endpoints.api 兜底 */ }
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
    } catch { /* 下一个候选 */ }
  }
  return undefined
}

async function main() {
  const enabled = await enabledVisibleModels()
  const [devIndex, cpCatalog] = await Promise.all([
    fetchModelsDevIndex().then((r) => r.index).catch((e) => {
      console.warn(`[gen-shells] models.dev 拉取失败：${e}`)
      return {} as Record<string, EffortInfo>
    }),
    copilotCatalog().catch(() => ({}) as Record<string, EffortInfo>),
  ])
  // models.dev 优先，Copilot 目录补缺（与原 devIndex[full] ?? cpCatalog[full] 同义）
  const metaIndex: Record<string, EffortInfo> = { ...bundledModelIndex(), ...cpCatalog, ...devIndex }
  const shells = buildShells(enabled, metaIndex, { roAliases: true })
  const bundled = loadBundledCapability()
  // [2026-08-31]-[终审P0-1：capabilityOf 返回 {score,tier}，链生成 tier 分组主键与运行期 rankCandidates 同源]
  const capabilityOf = (modelId: string) => baseScoreFromCapabilityIndex(modelId, bundled) ?? baseScore(modelId)
  // [2026-08-31]-[去厂商化：链生成乘 billingBoost×unknownPenalty——生成期无用户 jsonc，
  //  billing 取内置出厂缺省（subscription/api），unknown 由能力分级回退链推导（global=未知组）；
  //  运行期 laneBaseChain 用同一算法换成用户配置解析，语义同源]
  const knownOf = (modelId: string) =>
    (baseScoreFromCapabilityIndex(modelId, bundled)?.source ?? baseScore(modelId).source) !== "global"
  const billingBoostOf = (provider: string) => defaultBillingOf(provider) === "subscription" ? 1.0 : BILLING_API_BOOST
  const resolvers = { billingBoostOf, unknownOf: (modelId: string) => !knownOf(modelId) }
  const lanes = Object.fromEntries(["economy", "mechanical", "main", "hard", "vision", "review"].map((lane) => [lane, computeLaneChain(shells, capabilityOf, lane as any, resolvers)])) as Record<string, string[]>
  const seen = new Set(shells.map((s) => s.name))

  const missing = Object.values(lanes).flat().filter((n) => !seen.has(n))
  if (missing.length > 0) throw new Error(`六档链引用的壳不在可见矩阵中（启用面/档位漂移？）：${missing.join(", ")}`)

  const doc = {
    _note: `opencode-switchman 全量矩阵：权威启用面（模型管理打开的模型，scripts/visible-models.txt）× 全部声明思考档位（models.dev reasoning_options，toggle→off）。scripts/gen-shells.ts 生成，勿手改；模型开关变化后同步 pin 文件并重跑 bun run gen:shells。六档链由能力分×档位亲和×结构门×计费系数计算（api 计费 ${BILLING_API_BOOST}、未知组 ${UNKNOWN_PENALTY} 按系数沉底，无厂商预留席位）。`,
    generated_at: new Date().toISOString(),
    counts: { shells: shells.length, visible_models: enabled.length },
    shells,
    lanes,
  }
  writeFileSync(new URL("../src/shells.json", import.meta.url), `${JSON.stringify(doc, null, 2)}\n`)
  const byPool: Record<string, number> = {}
  for (const s of shells) byPool[s.pool] = (byPool[s.pool] ?? 0) + 1
  console.log(`[gen-shells] 可见模型 ${enabled.length} → 壳 ${shells.length} 只（${JSON.stringify(byPool)}）；六档链引用 ${Object.values(lanes).flat().length} 壳全部命中`)
}

main()
