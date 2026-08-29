# opencode-switchman — OpenCode 六档壳矩阵编排插件技术方案

> 版本：v1.2　　日期：2026-08-28
>
> **已确认决策（2026-08-28）**：
> - **目标形态**：OpenCode 插件（TypeScript，`@opencode-ai/plugin` API）＋ AGENTS.md 调度员规程，实现「多池多模型、按认知档位路由、插件层硬校验、配额感知、熔断自愈」的六档壳矩阵编排体系。
> - **模型层**：GitHub Copilot 原生 provider 直连（claude/gpt 系模型）；GLM 与 DeepSeek 以自定义 provider（baseURL+apiKey）保留。池概念：`copilot` / `glm` / `deepseek`（+`zen` 免费池不参与配额感知）。
> - **方法论**：四维任务画像、六档链、委派纪律、上下文水位、异族复审、终端失败协议、fail-open 原则，全部落地为仓库 AGENTS.md 规程与插件行为。
> - 本文档自包含：全部契约、常量、schema、算法在文中给全。
>
> **变更记录**：
> - v1.0：方案定稿（壳矩阵/六闸/ROUTE_META/熔断/配额感知/成本感知）。
> - v1.1：实现期核验勘误——横幅挂点改 `experimental.chat.system.transform`；壳落地改 config 钩子注入（无文件生成）；`tools` 字段弃用改 `permission`；思考档位改 agent `options`；task 参数名确认 `subagent_type`；失败记账主路径改 `event`；Copilot 用量端点与模型目录实测关闭两项待定；新增三池配额开关、成本 tiebreaker、token 只读红线。
> - v1.2：全量矩阵形态确立——激活模型 × 全部声明思考档位；启用面以模型管理 pin 清单为第一真源；档位真源切换 models.dev `reasoning_options`。

## 1. 需求概述

opencode-switchman 让 OpenCode 获得完整的编排能力：**主模型作为调度员，把任务按六档链委派给「模型×档位」空壳子代理，插件层做确定性拦截（配额/熔断/协议校验），系统提示实时注入路由与水位状态**。

核心能力点（验收对照）：

1. **壳矩阵**：`<池>-mx-<模型短名>-<档位>` 空壳 agent（config 钩子注入），角色由委派 prompt 动态赋予；
2. **六档链横幅**：系统提示注入 `[路由][水位][限制][更新]` 四行实时状态；
3. **ROUTE_META 硬校验**：task 派发前置拦截，坏协议 deny 并附当前最优改派候选；
4. **熔断与配额感知**：失败记账→10 分钟熔断；三池水位驱动排序与硬拦（逐池可开关）；
5. **DELEGATION_V1 委派协议**：固定头＋角色 contract＋可变任务块；
6. **探针**：真实请求探活、矩阵落盘、能力目录校准壳映射；
7. **成本感知调度**：models.dev 计价快照参与链内排序 tiebreaker；
8. **思考等级**：壳级 `options` 直接声明。

## 2. 编排体系契约（行为规范）

### 2.1 生命周期 × 组件交互

```
opencode 启动
  └─ [config 钩子] 壳注入（shells.json → cfg.agent）＋凭证收集（auth.json / provider options）
  └─ 后台预热：探针矩阵刷新（TTL 600s）＋三池配额拉取＋models.dev 成本快照；10min 周期自愈
主模型工作（AGENTS.md 规程）
  └─ task 派发（壳名）
       └─ [tool.execute.before] 六闸判定 → deny（throw Error＋reason＋改派候选）或放行 → 子代理执行
       └─ [event] message.part.updated（tool part error）→ failures.log 记账
            → 600s 窗 ≥2 败 → routing.json 熔断 600s
每轮 LLM 请求
  └─ [experimental.chat.system.transform] 追加四行横幅（内存态、幂等、fail-open）
```

横幅实例（端口契约，逐行可解析）：

```
[路由] economy: cp-luna-low→glm-53f-low→ds-v4fv-off | mechanical: … | main: … | hard: … | vision: … | review: …
[水位] GLM 5h窗 20% 周 7%(09-04 10:00刷新) | Copilot 月度池已耗尽(2026-09-01恢复) | GLM高峰(5.3×3/Flash×1.2) · DS高峰全价 | 建议: <分层动态选池一句话>
[限制] down: 无 | reviewer 须异族（producer family ≠ 壳 family，ROUTE_META 校验） | DeepSeek 仅链尾兜底
[更新] <仅发生清单/矩阵更新等事件时出现>
```

### 2.2 方法论（AGENTS.md 规程，正文见仓库 AGENTS.md）

**Token 经济学为第一性原则**：返工是最贵的 token；省过程与废话，不省验证与关键推理。由此派生：

| 规则 | 内容 | 实现载体 |
|---|---|---|
| 四维任务画像 | 认知强度（L 机械/M 常规/H 架构/X 核心安全）×机械度×上下文（S/M/L）×紧急度（immediate/normal/deferable）；自做＝≤2 小文件＋认知 L/M＋省<6k 底价 | 规程文字 |
| 六档典型角色 | economy=clerk/scouter 扫描清点；mechanical=tester/ops 回归脚本；main=programmer/uiux/data-analyst；hard=planner 架构核心；vision=observer 看图；review=reviewer/planner 审案、专家席 | 六档链（shells.json lanes） |
| 委派纪律 | 预期收益>6k 才委派；prompt 自包含（目标/已知事实/路径/输出格式）；只要摘要；标准编排 scouter→planner→reviewer 审案→programmer→tester→reviewer 复审（按规模裁剪） | DELEGATION_V1 模板 |
| 上下文水位 | 单口径＝本会话累计读入 token；软水位 ≈60k 起扫描/读取默认委派；硬水位 ≈80k 停新委派新读取、收尾交付或拆会话 | 规程文字 |
| 验证与复审 | 逻辑改动必验证；>20 行或多处调用交 tester；>300 行或核心/安全/数据逻辑交 reviewer，且**必须异模型族**（防同族盲区） | 六闸语义闸（同族 deny） |
| 终端失败协议 | 任何委派/降级链尽头＝显式告知用户原因＋给 2 个可选项；认知角色（planner/reviewer/专家席）降级必须声明「已降级」 | 规程文字＋deny 附言兜底句 |
| fail-open | 所有插件钩子异常只写 stderr，绝不阻塞主流程 | 四钩子统一 |

### 2.3 数据结构（全部 schema）

**壳（运行时注入的 AgentConfig）**＝「模型×档位」空壳：

```typescript
cfg.agent["copilot-mx-luna-low"] = {
  description: "模型空壳〔池=copilot·gpt-5.6-luna·档=low·rw〕。只绑定模型与档位，角色由委派 prompt 动态赋予。",
  mode: "subagent",
  model: "github-copilot/gpt-5.6-luna",
  options: { reasoningEffort: "low" },          // 思考档位按 family 映射（§3.6）
  permission: { edit: "deny", bash: "deny" },   // ro 壳只读；rw 壳不加此键
  prompt: "<5 条通用守则正文>",                   // 角色契约/事实采信不重查/最小必要 file:line/交付前验证/如实报告
}
```

**壳清单 shells.json（全量矩阵）**：权威启用面（模型管理打开的模型，`scripts/visible-models.txt` pin）× 全部声明思考档位（models.dev `reasoning_options`；toggle→off；Copilot 目录 none 同义 off）。字段：`{name, pool, provider, modelId, effort, family, capability(ro|rw), vision, matrixKey(provider|modelId|effort)}`＋`lanes`（六档静态偏好序，链内壳名必须在矩阵内）。生成器：`bun run gen:shells`。

**探针矩阵 model-matrix.json**：`{combos: {"provider|modelId|effort": {status:"ok|down|unknown", reason?, latency_ms?, checked_at}}, generated_at}`。探测＝真实 HTTP 请求；TTL 600s；**30s 内有响应＝慢而可用不判 down**（超时 45s 判 down）；并发 8-32；矩阵缺失→派发面 fail-open（横幅链加 `*` 降级标记）。

**熔断 routing.json**：`{down_agents: {key:原因}, down_expiry: {key:unix秒}, updated_at}`，主键 `comboKey`（同 combo 别名壳共享熔断）；记账 failures.log JSONL：`{agent, key, shell, combo, reason(≤200字), ts}`。常量：`FAIL_WINDOW=600s / FAIL_THRESHOLD=2 / DOWN_TTL=600s`。

**配额缓存**：`glm-quota.json`（five_hour/weekly{used_pct,reset_at}＋mcp_monthly）、`copilot-quota.json`（premium 快照＋reset_date＋gateway_exhausted）、`ds-balance.json`（balances＋exhausted）。分层 TTL：常规 300s／高水位 60s／失败回退旧缓存≤7200s。

**成本快照 costs.json**：models.dev 每模型 `(input+output)/2` 计价分，TTL 24h＋last-good。

### 2.4 六闸判定（顺序即优先级，任一命中即 deny）

deny 返回 `throw Error("<人读原因>，请改派 <候选>")`，错误文本作为 task 工具报错回给主模型：

| 闸 | 判定 | deny 语义 |
|---|---|---|
| 1 注册表 | 壳 status≠enabled | enabled 唯一可派发：disabled 且矩阵**非** down→fail-open 放行＋stderr 提示（探针下轮纠正）；disabled 且矩阵 down→deny（附矩阵 reason）；未探测面→deny |
| 2 探针矩阵 | combo status=="down" | 只拦明确 down；unknown/missing/unprobed→放行＋stderr 提示 |
| 3 熔断 | 壳名或 comboKey ∈ down_agents（600s 窗内 ≥2 败） | 「暂不可用（连续失败熔断中，约 10 分钟自动恢复）」 |
| 4 池耗尽 | 配额缓存判定套餐必失败 | 附人读原因（GLM 100% 用尽；Copilot 确定耗尽；DS 余额耗尽/欠费） |
| 5 协议 | 壳名派发且 ROUTE_META 缺失/坏/非法值 | 附样例＋合法值清单＋实时候选 |
| 6 语义 | reviewer 同族（producer_family==壳 family）/ capability=rw 派 ro 壳 / image 任务派非视觉壳 / source=auto 选中 DeepSeek 且套餐池有活壳 | 「复审须异族视角」「DeepSeek 按量壳仅链尾兜底，套餐首候选 X」 |

**deny 附言候选重算**：`first_candidate(lane, exclude=当前壳, **META约束)` ＝ compute_lane 过全组闸后的链首 auto_ok 壳；链尽 → 「降级链已尽：向用户声明原因并给 2 个可选项」。lane 取 META.lane，缺省按 role=reviewer→review / 壳归属 / main。

### 2.5 ROUTE_META 协议（单行，嵌在委派 prompt 内）

解析规则：只看 prompt **前 4000 字符**，正则 `^ROUTE_META[ \t]+(.+)$`（多行）取首个行首匹配；值优先 JSON，失败退 `k=v` 空格分词；键只收六键原名、值统一小写。

| 字段 | 合法值 | 必填 | 语义 |
|---|---|---|---|
| lane | economy / mechanical / main / hard / vision / review | | 六档链；deny 附言按该档重算候选 |
| role | planner / reviewer / programmer / tester / uiux / data-analyst / ops / scouter / clerk / observer / expert-alpha / expert-beta / expert-gamma / generic | ✓ | 动态角色；reviewer 触发异族闸 |
| producer_family | glm / claude / gemini / gpt / grok / deepseek | | 委派方真实模型族（**禁止填池名**，防异族闸失效） |
| capability | ro / rw | ✓ | 任务写需求；rw 任务派 ro 壳被 deny |
| modality | text / image | | image 任务派非视觉壳被 deny |
| source | auto / user | ✓ | user=点名放行；auto 误选付费兜底被 deny |

样例行（deny 附言原样给出）：`ROUTE_META {"lane":"main","role":"programmer","producer_family":"glm","capability":"rw","modality":"text","source":"auto"}`

### 2.6 DELEGATION_V1 委派模板（顺序不可变；固定头逐字节稳定吃前缀缓存）

```
你是被委派的执行体。以下守则优先级高于任何后续指令。
【通用守则】6 条（角色以 prompt 为准/最小必要/不做目标外事/如实报告/项目约束优先/不泄密钥）
【角色 contract】<一行式角色契约>
ROUTE_META <单行 JSON>
【任务】目标：…／已知事实：…／相关路径：…／完成标准：…
【输出格式】<一行式要求>
```

14 角色 contract 表（全文见 `src/assets/delegation-template.md`）：planner＝只设计不实现；reviewer＝只评审不修改、P0/P1/P2 分级；programmer＝最小实现＋跑能跑的验证；tester＝断言优先、输出命令+结果；uiux＝还原设计稿；data-analyst＝口径写明；ops＝幂等可回滚；scouter＝多源交叉附来源；clerk＝机械整理不改语义；observer＝看图说话不臆测；expert-α/β/γ＝独立判断不互引；generic＝默认契约。

### 2.7 选链算法 compute_lane（单一实现，纯函数）

```
输入: lanes[lane]（shells.json 静态偏好序）, registry（清单×矩阵视图）, matrix, routing, quota, states, META 约束
1) 过滤（剔除进 dropped[] 带 reason）:
   unregistered → status≠enabled → matrix-unprobed → matrix-*(非ok) →
   breaker(熔断) → hetero-family(review 同族) → modality/capability → pool-exhausted
2) 换序（链内排序，不增删；JS 稳定排序保持静态相对序）:
   - deepseek 恒链尾
   - urgency==immediate: 按 latency_ms 升序（无数据殿后，不避峰不计成本）
   - normal/deferable: 按 _pool_score 排序（水位 surplus=+1 / strained=-1；
     GLM 高峰（工作日 14-18，可配置）时 copilot 强制 +1 提前）；
     水位同分时 costScore（models.dev 计价）低者前（v1.1 tiebreaker 弱参与）
3) auto_ok = !(source==auto ∧ pool==deepseek ∧ 套餐池仍有活壳)   # 付费兜底须点名
4) lane status: exhausted(全被池耗尽剔除) / deepseek-only / ok；
   registry 或矩阵缺失 → fail-open 透传静态链并加 "*" 降级标记
```

### 2.8 配额感知口径

**水位语义**：水位只影响排序（用满不浪费），唯一硬拦＝「调用必失败」（GLM 100% 用尽；Copilot 确定耗尽；DeepSeek 余额耗尽/欠费）；`unknown` 永不硬拦。智能选池建议（把负载推向将作废的积分、避让吃紧的池）注入横幅 `[水位]` 行。

**三池独立开关**（插件 options，默认全开、有凭证才实际发起查询）：

```json
"plugin": [["<插件>", { "quota": {
  "glm":      { "enabled": true },
  "deepseek": { "enabled": true },
  "copilot":  { "enabled": true }
}}]]
```

**三层 fail-open 兜底**（任一层失败绝不阻塞插件）：
1. 网络失败/超时 10s → 回退旧缓存（≤7200s）→ 再失败置 `unknown`；
2. 无凭证/401/403/字段缺失 → 该池置 `unknown`，横幅显示「配额未知」，不参与硬拦；
3. 状态文件损坏 → 忽略当 `unknown`。
熔断器＋探针 down 为第二真值源，不受开关影响。

### 2.9 思考等级

壳级 `options` 直接声明，覆盖全局 model options：openai/copilot gpt 系 `reasoningEffort`；claude 系 `thinking:{type:"enabled",budgetTokens}`（按 min/max_thinking_budget 钳制）；GLM/DS openai-compatible 系 `reasoning_effort`。`off`＝不附带推理参数。

## 3. 技术方案（逐项落地）

### 3.1 模型层

- claude/gpt 系壳 model 指向 Copilot provider（`github-copilot/<modelId>`）；family 判定沿用模型名前缀（claude\*/gpt\*/glm\*/deepseek\*/gemini\*/grok\*/kimi\*/mai\*），异族闸与 producer_family 校验共用。
- GLM 与 DeepSeek 用自定义 provider（`npm:"@ai-sdk/openai-compatible"`＋baseURL/apiKey）；GLM coding plan baseURL 默认 `https://open.bigmodel.cn/api/coding/paas/v4`。
- 池概念：`copilot`（github-copilot）/ `glm`（zhipuai-coding-plan）/ `deepseek` / `zen`（免费池，无配额感知）；壳名前缀 `copilot-mx-* / glm-mx-* / ds-mx-* / zen-mx-*`。

### 3.2 配额感知：直查三端点（已实测）

插件**不另存任何密钥、不经任何代理**：凭证从 opencode 鉴权层（`~/.local/share/opencode/auth.json`）只读获取——GitHub Copilot OAuth access、GLM key、DeepSeek key；provider config options 与环境变量为次级来源。

| 池 | 端点（实测 200） | 鉴权 | 耗尽判定 |
|---|---|---|---|
| glm | `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit` | Bearer GLM key | five_hour/weekly `used_pct ≥ 100` |
| deepseek | `GET https://api.deepseek.com/user/balance` | Bearer DS key | 余额耗尽/欠费（按量正常**永不硬拦**） |
| copilot | `GET https://api.github.com/copilot_internal/user`（VS Code 同款端点） | Bearer GitHub OAuth token | premium_interactions 池「确定耗尽」 |

**Copilot 请求头**：`User-Agent: GitHubCopilotChat/0.35.0`、`Editor-Version: vscode/1.107.0`、`Editor-Plugin-Version: copilot-chat/0.35.0`、`Copilot-Integration-Id: vscode-chat`。

**快照坑位（实测坐实）**：快照字段语义浮动——`entitlement/credits_used` 会缺失、`quota_remaining:0`＋`unlimited:true`＋`has_quota:false` 组合可出现，且快照可能与网关实况背离（快照报 100% 而网关 402）。移植规则：

1. 归一化：`remaining = remaining ?? quota_remaining`；数值字段允许缺失（置 null）；
2. **确定耗尽**仅两条：`unlimited==false && remaining<=0 && !overage_permitted`，或派发网关返回 monthly-quota 类错误（HTTP 402/429 quota 错误体）→ 置 `gateway_exhausted` **信任至 `quota_reset_date`**（探针 402 占比 ≥50% 且 ≥3 组合自动触发）；
3. 其余一切浮动组合 → 状态 `unknown`：横幅展示 `used` 与 `reset_date`（有则展示），不显示误导性百分比、不参与硬拦；
4. 熔断器与探针 down 为第二真值源。

**token 安全红线**：插件对 GitHub OAuth token **只读、绝不自行 refresh**——refresh token 使用即轮转，插件私自刷新会作废 opencode 核心凭证。401/403 置 `unknown`（fail-open），核心刷新后自愈。

### 3.3 壳＝config 钩子注入

- 插件 `config(cfg)` 钩子加载 `shells.json`，对每个 enabled 壳注入 `cfg.agent[壳名]`（形态见 §2.3）；不覆盖用户显式定义。
- frontmatter 映射：`tools` 字段已弃用 → `permission`（ro 壳 deny `edit`/`bash`）；`thoughtLevel` 无对应字段 → `options`（§2.9）。
- 全局 AGENTS.md 注入无 per-agent 开关，接受固定 token 成本。
- 风险兜底：config 注入若不生效，退化为启动时写 `~/.config/opencode/agent/*.md`（两轨备选，shells.ts 单文件隔离切换）。

### 3.4 ROUTE_META 校验器（核心件）

插件 `tool.execute.before` 拦 `input.tool === "task"`：

1. 参数：`output.args.subagent_type`（壳名）、`output.args.prompt`（委派文本）；
2. 壳名命中清单 → 按 §2.4 六闸判定（数据源：shells.json×矩阵/routing/quota 缓存）；
3. deny → throw Error（reason＋first_candidate 改派候选）；callID 记入 skip 集合防自记账；
4. 未命中壳名（旧名/裸角色名/内置代理）→ fail-open 放行＋stderr 提示。
解析/合法值/必填/错误码按 §2.5 逐字段执行——由 fixture 锁死行为契约（§6）。

### 3.5 横幅注入

`experimental.chat.system.transform`（`output.system: string[]`）：每次 LLM 请求前追加四行横幅（数据来自内存态，零额外往返；内容幂等；全链 try/catch fail-open；15s 结果缓存）。注：`chat.params` 钩子只能修改 LLM 参数，无法触及 system prompt，不可行。

### 3.6 思考等级落地

effort → options 按 family 映射：gpt/grok/gemini 系 `{reasoningEffort}`；claude 系 `{thinking:{type:"enabled",budgetTokens}}`（low=1024/medium=2048/high=16384/xhigh=32768/max=32768）；glm/deepseek 系 `{reasoning_effort}`；`off`＝省略。

### 3.7 失败记账与熔断

- **主路径 `event` 钩子**：`message.part.updated` 且 part.type==="tool" 且 `state.status==="error"` 时记账；`tool.execute.after` 为辅助；自身 deny（callID skip 集合）不记账；
- 记账字段 §2.3；600s 窗 ≥2 败 → down（TTL 600s，读取时惰性清理）；窗口统计读日志尾部 256KB/最近 2000 行；
- not-found 类错误只熔断请求名，不牵连 combo（配置缺失≠组合不可用）。

### 3.8 探针

- **Copilot 直连方案（对齐 opencode 核心）**：GitHub OAuth token（gho_）直接作 `Authorization: Bearer` 打 `https://api.githubcopilot.com`（免 v2/token 交换；gho_ 走交换会 403）；headers：`User-Agent: opencode/<ver>`、`X-GitHub-Api-Version: 2026-06-01`、`x-initiator: agent`；端点按模型分形态：claude→`/v1/messages`（anthropic 协议＋thinking budget）、gpt/grok/claude→`/responses`（`reasoning:{effort}`）、gemini/kimi/mai→`/chat/completions`（`reasoning_effort`）。
- **GLM/DS**：各自 baseURL `/chat/completions`＋`reasoning_effort`（off 不附带）。
- 口径：TTL 600s；2xx=ok；45s 超时判 down；并发 8-32；10min 周期自愈刷新（矩阵 TTL 内自动跳过）。
- 矩阵写盘 `model-matrix.json`；启动预热＋周期刷新，全程 fail-open。

### 3.9 目录布局与状态文件

```
~/.config/opencode/
  opencode-switchman/
    shells.json            # 全量矩阵（生成基线，可人工校准）
    model-matrix.json      # 探针矩阵
    routing.json           # 熔断状态
    failures.log           # 失败记账 JSONL
    glm-quota.json / copilot-quota.json / ds-balance.json
    costs.json             # models.dev 计价快照
    delegation-template.md # DELEGATION_V1 全文（启动时落盘）
<repo opencode-switchman>/
  src/
    index.ts               # 唯一 API 适配层（四钩子＋全链 fail-open 包裹）
    meta.ts gates.ts lane.ts   # 纯函数核心（零依赖，fixture 锁死）
    shells.ts breaker.ts probe.ts quota.ts cost.ts banner.ts state.ts types.ts
    assets/delegation-template.md
  scripts/gen-shells.ts    # 全量矩阵生成器（bun run gen:shells）
  scripts/visible-models.txt  # 权威启用面 pin（模型管理打开的模型清单）
  test/routing.test.ts     # 行为契约 fixture
  AGENTS.md README.md docs/
```

### 3.10 成本感知调度

- 数据源：`https://models.dev/api.json`（公开 JSON、无鉴权），三池计价同源；`costScore=(input+output)/2`。
- 参与方式（tiebreaker 弱参与）：compute_lane 水位分相同时便宜者前；immediate 档纯 latency 序。
- 横幅 `[水位]` 行注入计价提示；拉取失败 fail-open（tiebreaker 自动失效）。

## 4. 数据来源口径

1. **latency_ms**：探针实测（矩阵 combos），非厂商标称。
2. **family 判定**：模型名前缀；异族闸与 producer_family 校验共用。
3. **水位硬拦口径**：仅「调用必失败」；`unknown` 永不硬拦。
4. **Copilot 模型目录**：`{api.githubcopilot.com}/models`（Bearer OAuth token，X-GitHub-Api-Version 2026-06-01），capabilities 含 reasoning_effort 档位/thinking budget/vision/context window。
5. **Copilot 用量端点**：`api.github.com/copilot_internal/user`；premium 倍率无公开 API，可选静态表（默认关）。
6. **GLM 高峰窗口**：默认工作日 14-18，插件 options `billingWindow` 可配。
7. **task 工具参数名**：`subagent_type`/`prompt`。
8. **凭证路径**：`~/.local/share/opencode/auth.json`（0600；OAuth{refresh,access,expires}/Api{key}）。

## 5. 影响面与风险

| 风险 | 说明 | 应对 |
|---|---|---|
| 插件 API 漂移 | 钩子签名随 OpenCode 版本变化 | API 触点集中在 index.ts 单文件适配层；六闸+META 解析纯函数零依赖；fixture 锁行为 |
| config 注入时序 | cfg.agent 运行时注入的生效时序无文档明示 | 已实测生效；兜底写 `~/.config/opencode/agent/*.md`（shells.ts 两轨隔离） |
| 桌面端运行时差异 | 桌面 app 内嵌核心跑 Node 而非 Bun | bundle 单文件（`bun run deploy`）部署 plugins 自动发现目录；禁用 Bun-only API |
| 模型目录变动 | 模型名/档位集随 provider 更新漂移 | 探针＋目录自校准；壳名与目录解耦（shells.json 映射）；down 模型走熔断/降级 |
| 快照语义浮动 | 配额快照字段缺失/语义漂移（实测两种形态） | 归一化；仅「确定耗尽」硬拦；网关 402 第二真值源；其余置 unknown |
| token 轮转冲突 | 插件私自 refresh 会作废 opencode 凭证 | **红线：只读不刷新**；401→unknown→核心自愈 |
| 探针限流噪音 | 高峰并发探测触发 429 | 探针结果按组合落盘，单次 429 不判池级状态；下一轮自愈纠正 |
| 4000 字符窗口 | META 超窗不被解析 | DELEGATION_V1 固定头很短（<1k），规程要求 ROUTE_META 紧随角色契约之后 |
| 多工具并用 | 与其他编排工具并用时状态互不感知 | 状态文件目录完全隔离（opencode-switchman/），无共享冲突 |

## 6. 验收标准（行为契约 fixture，124 项）

1. **META 解析**：JSON/k=v 双格式、六键白名单、必填三键、前 4000 字符窗口、producer_family 拒池名（main/gcp 非法）、值小写；
2. **六闸顺序**：矩阵 down deny / disabled＋矩阵非 down fail-open / 未探测面 deny、熔断 deny、池耗尽 deny、坏 META deny 附样例、同族 reviewer deny、rw→ro deny、image→非视觉 deny、auto→DeepSeek deny 附套餐首候选、user 点名放行；
3. **compute_lane 确定性**：同输入同输出（无时间戳）；deepseek 恒链尾；immediate 按 latency、normal 按水位；水位同分时 costScore 低者前（immediate 不受影响）；registry 缺失 fail-open 加 `*`；
4. **熔断**：600s 窗 ≥2 败触发、600s TTL 过期解除、同 combo 别名共享、not-found 只熔断请求名；
5. **端到端**：壳派发带合法 META 放行并收到 DELEGATION_V1 prompt；横幅四行可逐行解析；状态文件损坏 fail-open；
6. **配额判定**：GLM 100% 拦/99% 不拦；Copilot 坑位形态（unlimited/字段缺失）不判耗尽、remaining≤0 且禁超额才拦、网关 402 置耗尽信任至 reset_date；DS 按量正常永不硬拦；池开关关闭不查询不硬拦。

## 7. 落地布局与里程碑

```
插件本体（本仓库）
  index.ts        注册钩子（config / experimental.chat.system.transform /
                  tool.execute.before / event）＋全链 fail-open 包裹
  meta.ts         ROUTE_META 解析+合法值+错误码（纯函数）
  gates.ts        六闸判定（纯函数，输入=状态快照）
  lane.ts         compute_lane 选链（纯函数；水位主序＋cost tiebreaker）
  cost.ts         models.dev 计价快照＋costScore
  breaker.ts      failures.log 记账+熔断窗口
  probe.ts        并发探活+矩阵写入（TTL 600s；Copilot 直连 api.githubcopilot.com）
  quota.ts        三端点配额探测（逐池开关；分层 TTL 缓存；坑位兜底）
  banner.ts       四行横幅生成
  shells.ts       shells.json → cfg.agent 注入（effort→options、ro→permission）
  state.ts types.ts
shells.json       全量矩阵（gen:shells 产出）
AGENTS.md         调度员规程
```

里程碑（已全部交付）：M1 纯函数核心＋fixture 全绿 → M2 钩子接入（壳注入+横幅+deny 端到端）→ M3 探针/三端点配额/成本/熔断自愈＋真机校准。

## 附录：实测与核验记录（v1.1/v1.2 依据）

- **OpenCode 源码核验**（github.com/anomalyco/opencode）：`packages/opencode/src/tool/task.ts`（task 参数）；`packages/plugin/src/index.ts`（全部钩子签名，含 `experimental.chat.system.transform`）；config schema（AgentConfig `tools` @deprecated、无 thoughtLevel、agent `options`）；`packages/sdk/openapi.json`（`/provider/auth` 仅返回鉴权方式非 token）；桌面端内嵌核心为 Node 运行时（插件需 bundle 为纯 JS 部署 plugins 目录）。
- **Copilot 官方端点实测**（2026-08-28，business 席位，只读）：
  - `copilot_internal/user` 200：quota_snapshots 三池＋quota_reset_date；快照字段两种形态并存（坑位坐实）；
  - `{api.githubcopilot.com}` 直连（Bearer gho_ token）：`/models` 44 条目录含 capabilities；月度池耗尽时模型请求返回 402 "exceeded monthly quota"（与快照 unlimited:true 背离——网关为真值源）；
  - `copilot_internal/v2/token` 用 gho_ token 换取 403：opencode 核心方案为免交换直连（`packages/opencode/src/plugin/github-copilot/copilot.ts`）。
- **GLM 端点实测**：coding plan baseURL 为 `https://open.bigmodel.cn/api/coding/paas/v4`（普通 paas/v4 会 429 余额错误）；monitor 配额端点两条 TOKENS_LIMIT 按 (unit,number)=(3,5)/(6,1) 区分 5h 窗/周额度。
- **本地代理仓库**（github-copilot-proxy，仅作端点/请求头早期参考，opencode-switchman 不依赖）。
- **计价数据源**：models.dev `api.json`（三池计价同源＋reasoning_options 档位声明）；premium 倍率无公开 API（社区确认），docs.github.com 仅有静态表。

## v2.0 增补（2026-08-29）

> 追加说明：本节只记录 v2.0 相对 v1.2 的能力增量与设计约束，不重写前文历史方案。

1. **动态激活矩阵升级**：desktop 可见模型与 TUI favorites 双向自动同步，`mtime` 仲裁更新方向；同毫秒平局不写入任一侧，避免来回抖动。CLI 路径缺省时使用默认路径 fallback。任一配置面变化立即触发激活矩阵重算与全量探针刷新，不等待 TTL；10 分钟周期刷新保留为常态自愈。
2. **模型评分引擎**：选链从弱 tiebreaker 升级为显式加权评分。base 策展能力分按 exact → 前缀 → family → global 四路匹配，并记录命中来源；S/A/B/C tier 分组不可逆，低档永远不能靠水位、成本或高峰系数反超高档。
3. **评分系数与硬门**：最终分数为 `base × effortFit × health × water × costBias × peak`。`health`：ok=1.0、strained=0.6；`water` 取两类额度窗口中最吃紧者，Copilot 富余且临期时可反向提权以消耗积分；`costBias`：订阅池 1.0、按量池 0.7、DeepSeek 空闲 0.85；`peak`：GLM 高峰仅 ×0.93 做同档让位，永不跨能力级出局。down、熔断、池耗尽、retired、实调隔离等硬门候选先出局，不参与打分；immediate 紧急档按探针延迟排序。
4. **决策日志**：每次横幅重建将各档候选、剔除原因与六因子评分写入 `state/routing-decisions.jsonl`，按 200 行环形保留，用于解释「为什么链首是它」。
5. **厂商无关失败分类层**：`classifyFailure` 统一归一 `rate_limit / quota / auth / not_found / server / network / unknown`。探针 429 置 `strained`，只降权不整链跳 DeepSeek；实调 429 不再误置 Copilot 池耗尽，仅 402 或 403 且含 quota 文案才置耗尽。1 小时窗内连续 3 次 404 自动 retired：链路排除、闸 deny、横幅 `[限制]` 标注「n 模型已下线」。
6. **实调失败隔离**：探针 ok 但实际委派失败时，将 combo 写入进程内隔离表：普通失败 30 分钟，`rate_limit` 类 10 分钟；所有会话即时感知，重启即清。该隔离与既有 600s 熔断并行，分别处理「统计性连续失败」与「探针未覆盖的实调失败」。
7. **自更新通知与命令**：启动检查带 24 小时缓存；prod 模式对比 npm registry，注册 `/switchman-update`（静默升级、横幅改「已升级待重启」、提示重启）与 `/switchman-ignore`（本会话忽略，重启恢复提示）。local 模式对比 `origin/main`，只提示手动更新并仅注册 `/switchman-ignore`。会话级忽略标记通过 `mtime` 与进程启动时间对比判定，早于本进程启动的忽略记录不生效。
8. **本地/正式模式切换**：新增幂等脚本 `bun run mode:local`（build 后指向当前仓库）与 `bun run mode:prod`（切回 npm 包；未安装时拒绝并打印安装命令），切换后重启 opencode 生效。
9. **横幅契约补强**：四行 `[路由][水位][限制][更新]` 继续逐行可解析；`[限制]` 行承载 retired 数量与降级标注，`[更新]` 行承载新版本提示及升级/忽略入口。
