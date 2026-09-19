# 快速上手 — 六步从零到矩阵路由

**[English](./quick-start.md)** | 中文

这篇指南面向刚装好插件（或正准备装）的用户，目标是用最短路径达到「一切正常工作，而且我知道为什么」。每一步都会告诉你确切要输入什么、展示你应看到界面的截图，并说明该配置的**生效范围与条件**。

> **在哪里配置**：**先用 CLI/TUI**——弹窗、侧边栏面板与实时横幅等操作面在 TUI 里最完整。之后可选换用**桌面 app**；两端共享同一份配置与状态，下述所有手动覆盖在任一端都能操作。

六个步骤：

1. [连接 provider](#step-1)——给 opencode 凭证，让模型可用
2. [挑选参与编排的模型](#step-2)——TUI 收藏、app 开关
3. [引导式配置（必做）](#step-3)——`/switchman-setup` / `/switchman-setup-chat`
4. [调整能力排名（可选）](#step-4)——`/modelRank` / `/modelRank-chat`
5. [定制任务池（可选）](#step-5)——`/poolConfig` / `/poolConfig-chat`
6. [重启、验证、观察路由](#step-6)——横幅、侧栏、`/switchman-doctor`

---

## <a id="step-1"></a>Step 1 — 连接 provider

插件可以在**任意 opencode provider** 之间路由——凡在 opencode 里有凭证的 provider 都会进入编排面。以下三家额外获得**配额感知路由**（水位、高峰区间、耗尽处理）：GitHub Copilot、GLM、DeepSeek。

在 TUI 中运行：

```text
/connect
```

- **GitHub Copilot**——搜索 *GitHub Copilot*，走 OAuth 设备码流程（在 github.com/login/device 输入代码），无需 API key。
- **DeepSeek**——搜索 *DeepSeek*，粘贴 platform.deepseek.com 的 API key。
- **GLM Coding Plan**——不在 `/connect` 列表中；作为自定义 provider 写进 opencode 配置（`~/.config/opencode/opencode.json` 或项目级 `opencode.json`），API key 来自 open.bigmodel.cn：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "zhipuai-coding-plan": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Zhipu AI Coding Plan",
      "options": {
        "baseURL": "https://open.bigmodel.cn/api/coding/paas/v4",
        "apiKey": "你的_GLM_CODING_PLAN_API_KEY"
      }
    }
  }
}
```

桌面 app 端可从模型管理对话框右上角的**「连接提供商」**按钮进入登录（见 Step 2 截图右上角）。

> **生效范围与条件**
> - 插件对凭证**只读**（读 opencode 的 auth.json / provider options / 环境变量），自身不存储、不刷新任何密钥。
> - provider 键名有讲究：`zhipuai-coding-plan`、`deepseek`、`github-copilot` 是插件识别配额路由的稳定键（近似拼写会被 `/switchman-doctor` 警告）；其他任意 provider 键均合法，按通用缺省参与编排。
> - 改完 `opencode.json` 后重启 opencode，provider 面才会被拾取。

## <a id="step-2"></a>Step 2 — 挑选参与编排的模型（收藏 / 可见集）

不是 provider 提供的每个模型都要进矩阵。**启用面**由你决定——插件据此构建壳与六档链：

- **TUI**：打开模型选择器（`/models`），对模型按 `ctrl+f` **收藏 / 取消收藏**。收藏项会置顶分组显示。

![OpenCode 模型选择器——ctrl+f 收藏、ctrl+a 连接 provider](assets/tui-model-picker.png)

- **桌面 app**：打开「管理模型」对话框，用开关把模型**打开（显示）或关闭（隐藏）**。

![app 端管理模型——开关决定哪些模型显示](assets/app-model-management.png)

> **生效范围与条件**
> - 默认 `matrix.mode=auto` 下：**CLI/TUI 启用面 = 收藏（favorites）**；**桌面 app 启用面 = 打开开关的模型（可见集 visible set）**。
> - 两端**双向同步**（按文件 mtime 取更新的一侧）——TUI 里收藏，app 里即刻可见，反之亦然。
> - **完全没配置？** 插件回落到「活跃会话模型」（所有运行中主会话当前模型的并集）——矩阵照样工作，只是规模最小。
> - 收藏还带路由语义：同一能力档内，收藏的模型在链中优先。
> - 启用面变化（收藏增删、开关切换）会立即触发重算与探针刷新——这一步无需重启。

## <a id="step-3"></a>Step 3 —（必做）引导式配置：/switchman-setup 与 /switchman-setup-chat

未配置的任务池不再回落到「全部模型参与」。在配置完成之前——六个任务池（`economy` / `mechanical` / `main` / `hard` / `vision` / `review`）**每池至少选了一个模型**，且能力排名**至少有一条**——**任务派发会被硬性拦截**。配置向导一次引导帮你跑完全程。

**TUI**：运行 `/switchman-setup`。

1. **首页**——显示当前状态（已配置池数 n/6、排名缺失与否）；「开始」直接跳到第一个未完成的步骤，向导随时可续。
2. **六个任务池弹窗**（economy → mechanical → main → hard → vision → review）——逐池多选模型：Enter 在内存中切换 `[x]`/`[ ]` 标记，每行展示能力档，内置全选 / 全部取消与返回上一池；每池「确认」即刻落盘（每池至少一个模型），每次保存都热加载运行中的插件，向导逐池可续。
3. **排名**——按能力强到弱逐个点选排名模型（至少一个）；候选恰好是你在各池选入模型的并集。「完成」落盘排名。
4. **完成页**——各池汇总与排名次序。配置即刻生效（热加载）；页面同时点名仍需重启的 provider（仅限 opencode 尚未注册的全新 provider）。

**会话式**（TUI 与桌面 app）：运行 `/switchman-setup-chat`——对话里走同样的引导流程：agent 展示当前池/排名状态，逐池询问哪些模型入选（多选提问），再询问能力强到弱的排名，通过内置 CLI 逐条落盘，最后校验六池加排名全部就绪才收尾。

配置未完成期间，主会话每轮携带 `[SETUP]` 提示、引导模型指引用户打开向导，每次任务派发也会以同样指引被拒绝。该门槛叠加在首跑语言询问之上：语言未配置前，语言闸是拦截任务调用的唯一声音。最后一个配置文件写入的瞬间门槛即开——mtime 热加载，无需重启。

> **生效范围与条件**
> - 门槛范围：仅主会话——被派发的壳子代理与内部会话永不被拦。没有豁免开关：唯一通路就是完成配置（或直接手改下列文件）。
> - 文件：向导写入的与 Step 4–5 相同的 `~/.config/opencode/opencode-switchman/pool-config.json` + `capability-rank.json`——可安全手改，保存即热加载（横幅 `[LIMITS]` 行标注 `task-pool selection: M pools` / `manual capability rank: N models`）。
> - 不知道怎么选？合理默认：economy = 便宜快速的模型，mechanical = 中坚主力，main = 最强通才，hard = 最强推理，vision = 支持图像的模型，review = 与 main 池链首不同家族的模型（跨家族评审优先）。
> - CLI 直操作：`node <包目录>/dist/switchman-config.js pool list|set …` + `rank list|set …`（同文件、同热加载）。

## <a id="step-4"></a>Step 4 —（可选）调整能力排名：/modelRank 与 /modelRank-chat

Step 3 已根据向导选择落盘了基础排名；这一步用于之后的调整。默认模型能力来自自动级联（实时第三方指数 → 内置快照 → 策展表）。不同意？你的工作负载你说了算。

**TUI**：运行 `/modelRank`——弹窗按有效能力列出所有模型，手动条目与基础分模型交错；上移/下移会给模型锚定一个介于新上下邻居之间的手动分（一次挪一格），另有置顶/移出排名。

![/modelRank——模型能力排名：手动命中优先于基础能力分](assets/tui-model-rank.png)

**会话式**（TUI 与桌面 app 流程一致）：运行 `/modelRank-chat`——agent 展示当前排名并询问调整意图，你用自然语言回答（「新建排名：先 glm-5.3，再 gpt-5.4，再 claude-opus-4.7」），由它换算落盘。

![在 app 输入框键入 /modelRank-chat](assets/app-modelrank-chat-command.png)

![/modelRank-chat——agent 询问你的调整意图](assets/app-modelrank-chat.png)

> **生效范围与条件**
> - 手动排名对命中的模型（含其前缀变体）**优先于基础能力分**；未排名模型不受影响。清空排名（或把模型移出）即恢复基础分。
> - 命中模型按排名序位获得 S/A/B/C 档：≤4 项时依次映射 S/A/B/C；≥5 项按分位桶（top 20% S / 次 20% A / 次 20% B / 其余 C）；同档内按序位线性细分。
> - 排名参与**所有**决策面：六档链排序、档位亲和、能力等级闸、deny 改派建议。
> - 落盘于 `~/.config/opencode/opencode-switchman/capability-rank.json`（数组顺序 = 能力降序）；文件改动 mtime 热加载、即时生效，侧栏同步刷新。横幅 `[LIMITS]` 行标注 `manual capability rank: N models`。
> - CLI 直操作：`node <包目录>/dist/switchman-config.js rank list|set|add|remove|clear`。

## <a id="step-5"></a>Step 5 —（可选）定制任务池：/poolConfig 与 /poolConfig-chat

派发会落入六个任务池之一——`economy` / `mechanical` / `main` / `hard` / `vision` / `review`。Step 3 已完成配置；这一步用于之后的重新定制——provider 变化后替换候选，或让各池**体现差异化**（economy 只配轻量模型、hard 只配重思考模型）。

**TUI**：运行 `/poolConfig`——先选任务池，再逐个勾选/取消模型。

![/poolConfig 第一步——选择任务池，各池显示已参与模型数](assets/tui-pool-config-pools.png)

![/poolConfig 第二步——按能力档逐个勾选模型，支持全选/全部取消/清除快捷项](assets/tui-pool-config-models.png)

**会话式**（TUI 与桌面 app）：运行 `/poolConfig-chat`——agent 展示各池选配总览，你用自然语言回答（「economy 只留 flash 系」），由它换算落盘。

![/poolConfig-chat——agent 询问要配置哪个任务池](assets/app-poolconfig-chat.png)

> **生效范围与条件**
> - 某池的手动清单**替换该池系统默认候选集**；清单内模型仍按能力等级排序推荐。未配置/空清单的池走系统默认；「清除配置」= 恢复该池默认。
> - 同一模型可重复参与多个池。
> - 只有启用面（Step 2）里的模型能配进池——清单里缺谁，先回去收藏/打开它。
> - 落盘于 `~/.config/opencode/opencode-switchman/pool-config.json`（键 = 池名，值 = 模型数组）；改动热加载、即时生效。横幅 `[LIMITS]` 行标注 `task-pool selection: M pools`。
> - CLI 直操作：`node <包目录>/dist/switchman-config.js pool list|add|remove|set|clear`（池名 = economy/mechanical/main/hard/vision/review）。

## <a id="step-6"></a>Step 6 — 重启、验证、观察路由

1. **重启 opencode**（Step 1 改过配置文件后必须；其余情况重启也无害）。
2. **看横幅**——主模型每轮系统提示现在携带实时 `[ROUTES]` / `[WATERMARK]` / `[LIMITS]` 块。`[ROUTES]` 展示六档链；`[LIMITS]` 报告你的手动覆盖（`manual capability rank: N models, task-pool selection: M pools`）。
3. **看日志**中的 `[opencode-switchman] injected N model shells (agents)`——N 随 Step 2 的启用面动态变化。
4. **盯侧边栏** `switchman` 面板——provider 水位、高峰标记、六档当前链首，每 2 秒刷新。

![侧边栏状态面板——水位、档位候选与状态通知](assets/tui-sidebar-status.png)

5. **有不对劲？** 运行 `/switchman-doctor`——本地、脱敏、不联网的诊断报告，定位缺失凭证、配置错误与 provider 键近似拼写。

到此完成——之后正常使用 opencode 即可。你的主模型现在是调度员：按认知档位派发、遵守水位与高峰、每个路由决策都能在横幅、侧栏与 `.switchman/` 工作区中追溯。

---

## 速查表：命令 × 界面 × 生效范围

| 命令 / 操作 | 可用界面 | 控制什么 | 生效时机 | 落盘位置 |
| --- | --- | --- | --- | --- |
| `/connect` | TUI & app | provider 凭证 | 有凭证 provider 的模型进入可选面（改 `opencode.json` 后需重启） | opencode auth 层（插件只读） |
| 模型选择器内 `ctrl+f`（`/models`） | TUI | 收藏 = CLI/TUI 启用面；同档内优先 | 即时（重算 + 探针刷新） | opencode 状态（`model.json`），与 app 双向同步 |
| 「管理模型」开关 | 桌面 app | 可见集 = app 启用面；与 TUI 收藏同步 | 即时（重算 + 探针刷新） | opencode 状态（`opencode.global.dat`），与 TUI 双向同步 |
| `/switchman-setup` | TUI | 引导式一次配齐：6 个任务池 + 能力排名（必做——完成前派发被拦截） | 即时（热加载） | `~/.config/opencode/opencode-switchman/pool-config.json` + `capability-rank.json` |
| `/switchman-setup-chat` | TUI & app | 同 `/switchman-setup`，会话式 | 即时（热加载） | 与 `/switchman-setup` 同文件 |
| `/modelRank` | TUI | 手动能力排名，压过基础分 | 即时（热加载） | `~/.config/opencode/opencode-switchman/capability-rank.json` |
| `/modelRank-chat` | TUI & app | 同 `/modelRank`，会话式 | 即时（热加载） | 与 `/modelRank` 同文件 |
| `/poolConfig` | TUI | 各任务池候选清单，替换池默认 | 即时（热加载） | `~/.config/opencode/opencode-switchman/pool-config.json` |
| `/poolConfig-chat` | TUI & app | 同 `/poolConfig`，会话式 | 即时（热加载） | 与 `/poolConfig` 同文件 |
| `/expert <问题>` | TUI & app | 经最强只读壳的一次性专家咨询 | 单次调用 | — |
| `/switchman-doctor` | TUI & app | 本地、脱敏诊断 | 单次调用 | — |
| `/switchman-update` | TUI & app | 升级插件到最新版 | 重启后生效 | opencode 插件配置 |

> 延伸阅读（[reference.zh.md](./reference.zh.md)）：手动覆盖层 · 配置项（opencode-switchman.jsonc） · 工作原理
