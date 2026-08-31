// [2026-08-31]-[新增 /handover 交接技能：复制当前会话→开新会话→原模型/agent/思考档位做上下文
//  压缩→自动切到新会话，原会话保留不动。
//  [2026-08-31]-[修复实测反馈：guessed 的 executeCommand("session_fork") 并非真实命令名——
//  TUI 里不创建新会话，session_compact 直接压缩了当前会话；桌面 app 里干脆不生效。改为只信任
//  两个确定存在的公开面：① REST `session.fork`（SDK 文档化端点，保证真的产生新会话，且据
//  keybinds 文档 session_child_first/session_child_cycle 的存在推断 fork 会把新会话挂为当前
//  会话的 child）；② executeCommand("session_child_first")（keybinds.md 文档化的真实命令名，
//  用于导航到当前会话的第一个 child）做前台切换——不再猜测未经证实的命令名]-
//  [影响：新增 tool+command，无既有钩子改动；若某端未实现 session_child_first 则仅切换失败，
//  新会话与压缩仍已生效，工具会如实告知需手动切换]
import { tool } from "@opencode-ai/plugin"
import type { PluginInput } from "@opencode-ai/plugin"

function lastModelOf(messages: Array<{ info: any }> | null | undefined): { providerID: string; modelID: string } | null {
  if (!Array.isArray(messages)) return null
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info
    if (info?.providerID && info?.modelID) return { providerID: info.providerID, modelID: info.modelID }
  }
  return null
}

export const HANDOVER_COMMAND_TEMPLATE = [
  "请立即调用 `handover` 工具完成会话交接，不要先做任何解释或确认，也不要自己额外总结上下文。",
  "工具会自动：复制当前会话为新会话→在新会话上用当前模型/agent/思考档位做上下文压缩→自动切换过去；原会话保持不变可随时切回。",
  "工具执行完毕后，只需用一句话向用户复述工具返回的结果（成功/回退模式/失败原因），不要额外发挥。",
].join("\n")

export const HANDOVER_COMMAND_DESCRIPTION = "复制当前会话为新会话并压缩上下文交接，原会话保留，自动切到新会话"

export function createHandoverTool(input: PluginInput) {
  return tool({
    description:
      "复制当前会话为一个新会话，对新会话做上下文压缩（沿用当前模型/agent/思考档位，剔除无用信息、保留关键细节），" +
      "完成后自动切换到新会话；原会话原样保留、可随时切回。无需参数，用户输入 /handover 时调用。",
    args: {},
    async execute(_args, context) {
      const client = input.client
      const directory = context.directory
      const sessionID = context.sessionID

      // ① 真正创建新会话：REST session.fork（文档化端点，保证生效，不依赖任何猜测的命令名）。
      const forkRes: any = await client.session.fork({ path: { id: sessionID }, body: {}, query: { directory } })
      const newID: string | undefined = forkRes?.data?.id
      if (!newID) throw new Error("交接失败：session.fork 未返回新会话 ID")

      // ② 同模型/agent/思考档位压缩新会话：取原会话最后一条带 providerID/modelID 的消息。
      const msgsRes: any = await client.session.messages({ path: { id: sessionID }, query: { directory } }).catch(() => null)
      const model = lastModelOf(msgsRes?.data)
      let compacted = false
      if (model) {
        await client.session.summarize({ path: { id: newID }, body: model, query: { directory } })
        compacted = true
      }

      // ③ 尽力切换前台：session_child_first 是 keybinds 文档化的真实命令名（导航到当前会话的
      // 第一个 child）；session.fork 产生的新会话通常挂为 parentID=当前会话的 child。此步失败
      // 不影响①②已生效的结果，仅退化为需要用户手动切换。
      let switched = true
      try {
        await client.tui.executeCommand({ body: { command: "session_child_first" }, query: { directory } })
      } catch {
        switched = false
      }

      const parts = [`已复制当前会话为新会话（${newID}）`]
      parts.push(compacted ? "并完成同模型/agent 上下文压缩" : "，但未取到当前模型信息，跳过了压缩")
      parts.push(switched ? "，已自动切换到新会话" : "，自动切换未生效，请手动在会话列表中切到该会话")
      parts.push("；原会话保持不变，可随时切回继续。")
      return { title: switched ? "会话已交接" : "会话已交接（需手动切换）", output: parts.join("") }
    },
  })
}
