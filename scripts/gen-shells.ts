// 全量矩阵生成器：权威启用面 × 思考档位 → src/shells.json
// [2026-08-28]-[启用面第一真源=scripts/visible-models.txt（桌面端模型管理 UI 打开的模型，手工同步）；
//  文件缺失时降级为 opencode models − 桌面端 hide 过滤（自动兜底，已知与 app 内嵌核心目录存在版本差）]-
// [档位真源=models.dev reasoning_options（三池统一，含 GLM/DeepSeek；toggle=可关思考→off，
//  Copilot 目录 none 同义 off）；vision=attachment/modalities；Copilot 目录为 fallback]
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

type Effort = string
interface Shell {
  name: string
  pool: "copilot" | "glm" | "deepseek" | "zen"
  provider: string
  modelId: string
  effort: Effort
  family: string
  capability: "ro" | "rw"
  vision: boolean
  matrixKey: string
}

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

// ---- 2) 档位源：models.dev reasoning_options（三池统一）----
interface EffortInfo { efforts: string[]; toggle: boolean; vision: boolean }
async function modelsDevIndex(): Promise<Record<string, EffortInfo>> {
  const res = await fetch("https://models.dev/api.json", {
    headers: { Accept: "application/json", "User-Agent": "opencode-switchman-gen/0.1" },
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`models.dev HTTP ${res.status}`)
  const data = (await res.json()) as Record<string, any>
  const out: Record<string, EffortInfo> = {}
  for (const [prov, p] of Object.entries(data)) {
    for (const [mid, m] of Object.entries((p as any)?.models ?? {})) {
      const opts = Array.isArray(m?.reasoning_options) ? m.reasoning_options : []
      const efforts: string[] = []
      let toggle = false
      for (const o of opts) {
        if (o?.type === "toggle") toggle = true
        if (o?.type === "effort" && Array.isArray(o.values)) {
          for (const v of o.values) efforts.push(String(v))
        }
      }
      const modalIn = Array.isArray(m?.modalities?.input) ? m.modalities.input : []
      out[`${prov}/${mid}`] = {
        efforts,
        toggle,
        vision: m?.attachment === true || modalIn.includes("image"),
      }
    }
  }
  return out
}

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

// ---- 3) 命名与家族 ----
const SHORT: Record<string, string> = {
  "gpt-5.6-luna": "luna", "gpt-5.6-terra": "terra", "gpt-5.6-sol": "sol",
  "gpt-5.5": "55", "gpt-5.4": "54", "gpt-5.4-mini": "54mini", "gpt-5.4-nano": "54nano",
  "gpt-5.3-codex": "53codex", "gpt-5.2": "52", "gpt-5.2-codex": "52codex", "gpt-5-mini": "5mini",
  "claude-sonnet-5": "claude5", "claude-sonnet-4.6": "claude46", "claude-sonnet-4.5": "claude45", "claude-sonnet-4": "claude4",
  "claude-opus-5": "opus5", "claude-opus-4.8": "opus48", "claude-opus-4.7": "opus47", "claude-opus-4.6": "opus46",
  "claude-opus-4.5": "opus45", "claude-fable-5": "fable5", "claude-haiku-4.5": "haiku45",
  "gemini-3.1-pro-preview": "gem31pro", "gemini-3.5-flash": "gem35f", "gemini-3.6-flash": "gem36f", "gemini-3.7-flash": "gem37f",
  "grok-4.5": "grok45", "grok-4.6": "grok46",
  "kimi-k2.7-code": "k27code", "kimi-k3": "k3",
  "mai-code-1-flash-picker": "mai1fp", "mai-code-1.1-flash": "mai11f",
  "glm-5.3": "53", "glm-5.3-flash": "53f", "glm-5.3-highspeed": "53hs", "glm-5.2-highspeed": "52hs",
  "glm-5.2": "52", "glm-5.1": "51", "glm-5-turbo": "5t", "glm-4.7": "47",
  "glm-4.6v": "46v", "glm-5v-turbo": "5vt", "glm-4.5-air": "45air",
  "deepseek-v4-flash": "v4f", "deepseek-v4-flash-vision-exp": "v4fv", "deepseek-v4-pro": "v4p",
  "big-pickle": "bigpickle", "hy3-free": "hy3", "mimo-v2.5-free": "mimo",
  "muse-spark-1.2-contributor-free": "muse", "nemotron-3-ultra-free": "nemo3u", "nemotron-3.5-lightning-free": "nemo35l",
}
function shortOf(modelId: string): string {
  if (SHORT[modelId]) return SHORT[modelId]
  if (modelId.endsWith("-fast") && SHORT[modelId.slice(0, -5)]) return `${SHORT[modelId.slice(0, -5)]}fast`
  return modelId.replace(/[^a-zA-Z0-9]/g, "")
}
function familyOf(modelId: string): string {
  const m = /^(claude|gpt|gemini|grok|kimi|glm|deepseek|mai)/.exec(modelId)
  return m ? m[1] : modelId.split(/[^a-zA-Z]/)[0] || "unknown"
}
const EFFORT_ORDER = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
function canonEffort(e: string): string {
  return e === "none" ? "off" : e
}
function sortEfforts(efforts: Iterable<string>): string[] {
  return [...new Set(efforts)].sort((a, b) => {
    const ia = EFFORT_ORDER.indexOf(a), ib = EFFORT_ORDER.indexOf(b)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
  })
}
function poolOf(provider: string): Shell["pool"] {
  if (provider === "github-copilot") return "copilot"
  if (provider.startsWith("zhipuai") || provider.startsWith("glm") || provider.startsWith("zai")) return "glm"
  if (provider === "deepseek") return "deepseek"
  return "zen"
}

// ---- 4) 六档链＝矩阵上的静态偏好序（引用壳名必须在可见矩阵内）----
const lanes: Record<string, string[]> = {
  economy: ["copilot-mx-luna-low", "glm-mx-53f-low", "ds-mx-v4fv-off"],
  mechanical: ["glm-mx-53f-high", "copilot-mx-terra-medium", "ds-mx-v4fv-off"],
  main: ["glm-mx-53-high", "copilot-mx-terra-high", "ds-mx-v4p-high"],
  hard: ["copilot-mx-sol-xhigh", "glm-mx-53-max", "ds-mx-v4p-max"],
  vision: ["glm-mx-53f-high", "copilot-mx-terra-high", "ds-mx-v4fv-high"],
  review: ["copilot-mx-claude5-high", "copilot-mx-terra-max"],
}
const REVIEW_RO = new Set(["copilot-mx-claude5-high", "copilot-mx-terra-max", "copilot-mx-opus5-high", "copilot-mx-fable5-high"])

async function main() {
  const enabled = await enabledVisibleModels()
  const [devIndex, cpCatalog] = await Promise.all([
    modelsDevIndex().catch((e) => {
      console.warn(`[gen-shells] models.dev 拉取失败：${e}`)
      return {} as Record<string, EffortInfo>
    }),
    copilotCatalog().catch(() => ({}) as Record<string, EffortInfo>),
  ])

  const shells: Shell[] = []
  const seen = new Set<string>()
  const seenShort = new Set<string>()
  for (const full of enabled) {
    const slash = full.indexOf("/")
    const provider = full.slice(0, slash)
    const modelId = full.slice(slash + 1)
    const pool = poolOf(provider)
    const family = familyOf(modelId)
    let baseShort = shortOf(modelId)
    while (seenShort.has(`${pool}|${baseShort}`)) baseShort += "x"
    seenShort.add(`${pool}|${baseShort}`)

    // 档位装配：models.dev（toggle→off；effort 值照收）→ Copilot 目录（none→off）→ off 单档
    const info = devIndex[full] ?? cpCatalog[full]
    let efforts: string[] = ["off"]
    let vision = false
    if (info) {
      const vals = info.efforts.map(canonEffort).filter((e) => e !== "none")
      if (vals.length > 0 || info.toggle) {
        efforts = sortEfforts(info.toggle ? ["off", ...vals] : vals.length > 0 ? vals : ["off"])
      }
      vision = info.vision
    }

    for (const effort of efforts) {
      const name = `${pool === "deepseek" ? "ds" : pool}-mx-${baseShort}-${effort}`
      if (seen.has(name)) continue
      seen.add(name)
      shells.push({
        name,
        pool,
        provider,
        modelId,
        effort,
        family,
        capability: REVIEW_RO.has(name) ? "ro" : "rw",
        vision,
        matrixKey: `${provider}|${modelId}|${effort}`,
      })
    }
  }

  const missing = Object.values(lanes).flat().filter((n) => !seen.has(n))
  if (missing.length > 0) throw new Error(`六档链引用的壳不在可见矩阵中（启用面/档位漂移？）：${missing.join(", ")}`)

  const doc = {
    _note: "opencode-switchman 全量矩阵：权威启用面（模型管理打开的模型，scripts/visible-models.txt）× 全部声明思考档位（models.dev reasoning_options，toggle→off）。scripts/gen-shells.ts 生成，勿手改；模型开关变化后同步 pin 文件并重跑 bun run gen:shells。六档链 lanes＝矩阵上的静态偏好序。",
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
