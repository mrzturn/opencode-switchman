// 会话式配置命令模板（cfg.command 注入）：/poolConfig-chat 与 /modelRank-chat
// （手动交互弹窗为 TUI 插件的 /poolConfig //modelRank，两者互补）。
// [2026-09-03]-[opencode 命令 `!` 块为非交互执行（stdin=ignore/输出捕获），交互式弹窗由 TUI 插件
//  （src/tui.tsx DialogSelect）承载；本模板为非 TUI 客户端与会话内的会话式等价流程：
//  命令注入当前配置清单 → 用户回复勾选/排序意图 → agent 调 switchman-config.js 落盘]
import { paths } from "./state"

const q = (p: string): string => JSON.stringify(p)

export function poolConfigCommandMd(cliPath: string): string {
  const cli = q(cliPath)
  const run = (args: string): string => `!\`node ${cli} ${args} 2>/dev/null || bun ${cli} ${args}\``
  return [
    "---",
    "description: 交互式配置各任务池（economy/mechanical/main/hard/vision/review）参与模型，手动选配优先于系统默认",
    "---",
    "",
    run("pool list"),
    "",
    "以上是六个任务池的选配总览（选配=参与该任务池的模型，让各池候选体现差异化；同一模型可参与多个池；未配置的池由系统默认决策）。请：",
    "1. 让用户选择要配置的任务池（economy/mechanical/main/hard/vision/review 之一），需要完整编号清单时运行 `pool list <任务池>`。",
    "2. 用户用编号或模型名表达勾选/取消（如「main 只留 2 5」「economy 勾 1 3、取消 4」「清空恢复默认」），你负责换成对应命令执行：",
    `   - 勾选参与：${run("pool add <任务池> <编号或modelId...>")}`,
    `   - 取消参与：${run("pool remove <任务池> <编号或modelId...>")}`,
    `   - 全量替换：${run("pool set <任务池> <编号或modelId...>")}`,
    `   - 清除配置（该池恢复系统默认候选集）：${run("pool clear <任务池>")}`,
    "3. 执行后再运行一次 `pool list <任务池>` 核对，用一句话报告变更与生效时机（即时生效）。",
    "注意：`#编号` 仅对最近一次 list 输出有效；两次操作之间若配置/可用面可能已变化，先重新 list 再换算编号。",
    "",
    `配置文件：${paths().poolConfig}（键=任务池名，值=参与该池的 modelId 数组，同一模型可出现在多个池；可直接手改，保存即热加载）。`,
    "",
  ].join("\n")
}

export function modelRankCommandMd(cliPath: string): string {
  const cli = q(cliPath)
  const run = (args: string): string => `!\`node ${cli} ${args} 2>/dev/null || bun ${cli} ${args}\``
  return [
    "---",
    "description: 交互式配置模型能力排名（手动排名优先于基础能力分，越靠前能力越强）",
    "---",
    "",
    run("rank list"),
    "",
    "以上第一段是手动能力排名（#1 最强，命中模型的能力分/档位以此为准），第二段是当前可用模型的参考排序。请：",
    "1. 让用户表达调整意图（如「把 glm-5.3 排到最前」「kimi-k3 和 glm-5.2 互换」「去掉 deepseek-v4-pro」「清空排名」）。",
    "2. 换成对应命令执行（编号引用两段的全局序号）：",
    `   - 全量重排（按给定顺序）：${run("rank set <编号或modelId...>")}`,
    `   - 追加到排名末尾（最弱端）：${run("rank add <编号或modelId...>")}`,
    `   - 移出排名：${run("rank remove <编号或modelId...>")}`,
    `   - 清空（全部回退基础能力分）：${run("rank clear")}`,
    "3. 执行后再运行一次 `rank list` 核对，用一句话报告新排名与生效时机（即时生效）。",
    "注意：`#编号` 仅对最近一次 list 输出有效；两次操作之间若排名可能已变化，先重新 list 再换算编号。",
    "",
    `配置文件：${paths().capabilityRank}（可直接手改，models 数组顺序=能力降序，保存即热加载）。`,
    "",
  ].join("\n")
}
