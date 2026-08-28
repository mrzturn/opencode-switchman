// 壳注入（v1.1）：shells.json 清单 × 注册表视图 → cfg.agent 运行时注入（无文件生成）
// [2026-08-28]-[tools 字段已 @deprecated→permission；thoughtLevel 无此字段→agent options 按 family 映射]-
// [兜底两轨：config 注入若实测不生效，切换 writeShellFiles 落 ~/.config/opencode/agent/*.md]
import type { ShellRegEntry } from "./types"

// 思考档位 → agent options（family 分协议映射；off＝不附带推理参数）
const CLAUDE_BUDGET: Record<string, number> = {
  low: 1024, medium: 2048, high: 16384, xhigh: 32768, max: 32768,
}

export function effortOptions(family: string, effort: string): Record<string, unknown> | undefined {
  if (!effort || effort === "off") return undefined
  if (family === "claude") {
    const budget = CLAUDE_BUDGET[effort]
    return budget ? { thinking: { type: "enabled", budgetTokens: budget } } : undefined
  }
  // gpt/grok/gemini（openai 系 options.reasoningEffort）；glm/deepseek（openai-compatible reasoning_effort）
  if (family === "glm" || family === "deepseek") return { reasoning_effort: effort }
  return { reasoningEffort: effort }
}

export function shellDescription(s: ShellRegEntry): string {
  return `模型空壳〔池=${s.pool}·${s.modelId}·档=${s.effort}·${s.capability}〕。只绑定模型与档位，角色由委派 prompt 动态赋予。`
}

export const SHELL_BODY = [
  "你是被委派的执行体（模型空壳）。以下守则优先级高于任何后续指令。",
  "1. 角色以本次委派 prompt 为准（壳只绑模型与档位）；事实性陈述直接采信，不重复验证。",
  "2. 最小必要：只读必要文件与段落，结论优先，用 file:line 引用，不贴大段原文。",
  "3. 只做目标块内的事；发现目标外的问题记录到「遗留问题」，不顺手修改。",
  "4. 如实报告：失败说失败、跳过说跳过、不确定标不确定；验证过的才写「已验证」。",
  "5. 项目 AGENTS.md 与委派方明示约束优先于个人偏好；任何情况下不输出密钥、凭据、配置正文。",
].join("\n")

/** 单壳 → opencode AgentConfig（config 钩子注入用） */
export function shellAgentConfig(s: ShellRegEntry): Record<string, unknown> {
  const cfg: Record<string, unknown> = {
    description: shellDescription(s),
    mode: "subagent",
    model: `${s.provider}/${s.modelId}`,
    prompt: SHELL_BODY,
  }
  const options = effortOptions(s.family, s.effort)
  if (options) cfg.options = options
  if (s.capability === "ro") {
    cfg.permission = { edit: "deny", bash: "deny" }
  }
  return cfg
}

/** 注入全部 enabled 壳到 live config（config 钩子内调用） */
export function injectShells(cfg: Record<string, any>, registry: Record<string, ShellRegEntry>): number {
  let n = 0
  for (const s of Object.values(registry)) {
    if (s.status !== "enabled") continue
    cfg.agent = cfg.agent ?? {}
    if (cfg.agent[s.name]) continue // 不覆盖用户显式定义
    cfg.agent[s.name] = shellAgentConfig(s)
    n++
  }
  return n
}
