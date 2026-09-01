# capability-routing — 能力分级分池技术方案

> 版本：v1.0　　日期：2026-09-01　　关联模块：`src/model-ranks.ts`、`src/capability.ts`、`src/lane-policy.ts`、`src/scoring.ts`
>
> **已确认决策（2026-09-01）**：
> - `vision` 是唯一强制要求读图能力的任务池。
> - 文本任务的能力等级顺序为：`economy < mechanical < main < hard < review`。
> - 路由分两步：先按模型能力级别进入任务池，再在池内按动态系数优选；不得用价格、额度或延迟将低能力模型提升至高能力池。

## 1. 目标

将当前以单一能力档和 effort 亲和度生成六条候选链的机制，明确为可解释的两阶段路由：

```text
模型能力数据 -> 能力级别 -> 任务池准入 -> 池内动态评分 -> 候选顺序
```

这样把“模型是否具备完成该类任务的最低能力”和“多个合格模型当前哪个更值得使用”分开。前者稳定、审慎；后者才受额度、健康、成本和延迟影响。

## 2. 现状与问题

### 2.1 当前调用链

```text
baseScoreDynamic(modelId)                 // src/capability.ts
  -> { score, tier, rawScore, source }
computeLaneChain(shells, capabilityOf)    // src/lane-policy.ts:60
  -> 结构门 + tier 分组 + 能力 x effort x billing x unknown
rankCandidates(shells, context)           // src/scoring.ts:204
  -> 硬门 + tier 分组 + 动态乘积分
```

已有资产：

| 能力 | 现有实现 | 可复用性 |
|---|---|---|
| 基础能力分 | `baseScore()`：精确、前缀、family、global 四级回退，`src/model-ranks.ts:98` | 直接复用 |
| 离散能力档 | `S/A/B/C` 和 `1.00/0.85/0.70/0.55`，`src/model-ranks.ts:4-14` | 需扩展为业务级别映射 |
| 动态能力指数 | `baseScoreDynamic()` 的 `rawScore`，被同 tier 的次级排序使用，`src/scoring.ts:121-144,243-247` | 直接复用 |
| 文本/视觉结构门 | vision 任务仅保留视觉壳，`src/lane-policy.ts:61-69`；运行期再次校验，`src/scoring.ts:193-195` | 直接复用 |
| runtime 硬门 | 下线、熔断、额度、ro/rw、review 异族，`src/scoring.ts:182-196` | 直接复用 |
| 动态权重 | health、water、peak、billing、unknown，`src/scoring.ts:117-145` | 直接复用，重组为池内因素 |

当前的 `tier` 已保证跨 S/A/B/C 不会被乘积分反超（`src/lane-policy.ts:86-94`、`src/scoring.ts:240-249`）。但它并未定义“哪些 tier 能进入哪个任务池”：每条 lane 都从全部非视觉模型中选取，只是通过 effortFit 拉开差距。因此 B/C 级模型仍可能出现在 `hard` 或 `review` 基础链中，候选不足时尤其明显，任务推荐与用户定义的能力分层不一致。

## 3. 分级与分池设计

### 3.1 两个不同概念

| 概念 | 作用 | 是否被实时因素改变 |
|---|---|---|
| `capabilityLevel` | 说明模型固有综合能力，决定可进入的最高文本任务池 | 否 |
| `poolScore` | 在某一已准入任务池中比较当前可用性与适配度 | 是 |

`capabilityLevel` 只来自能力评估数据；不能掺入 provider、billing、额度、水位、高峰、延迟、价格或当前失败状态。这些信息只允许影响 `poolScore` 或作为硬门淘汰候选。

### 3.2 建议的模型能力级别

以五级承接五类文本任务，分数为可配置边界。首期继续使用现有 `S/A/B/C` 策展层作为保守兜底，不把未验证模型抬高。

| 级别 | 建议分数区间 | 现有 tier 的默认映射 | 能力说明 | 最高可进入文本池 |
|---|---:|---|---|---|
| L1 | 无可靠命中，`source=global` | 无可靠能力数据 | 仅允许极低风险、可复核的整理类工作 | `economy` |
| L2 | C | C | 可执行规则明确、结果易验证的流程任务 | `mechanical` |
| L3 | B | B | 能独立完成常规实现、调试和分析 | `main` |
| L4 | A | A | 可承担跨模块推理、复杂设计与难题定位 | `hard` |
| L5 | S | S | 可进行高风险独立审查、反证与关键结论验证 | `review` |

能力级别以现有归一化后的 `tier` 为唯一依据，而非直接使用 `rawScore`。这是必要约束：Artificial Analysis 是绝对指数口径，OpenRouter 和随包快照可能是 rank/quantile 口径，直接定义统一的原始分数区间会随来源切换而漂移。`rawScore` 仅用于相同 tier 的次级排序；级别调整必须有数据版本或人工配置的可追溯来源。

### 3.3 任务池准入规则

采用“同级优先、跨级回退”而非“达到最低等级即可进入”。只要本级存在可用模型，其他等级不参与该任务池的运行期排序；本级全部被硬门淘汰后，才按与目标等级的距离逐级回退。用户显式点名模型可覆盖自动路由的同级优先序。

| 任务池 | 最低能力级别 | 强制结构条件 | 典型任务 | 降级规则 |
|---|---|---|---|---|
| `economy` | L1 | 无 | 清点、提取、格式整理、简单检索 | L1 优先；缺席时 L2→L3→L4→L5 回退 |
| `mechanical` | L2 | rw 优先 | 测试、构建、脚本、确定性批处理 | L1 不跨级补位 |
| `main` | L3 | rw 优先 | 普通功能、Bug 修复、重构 | L2 的池内综合评分前二可受控补位 |
| `hard` | L4 | rw 优先 | 架构、跨模块疑难、复杂推理 | L3 的池内综合评分前二可受控补位 |
| `review` | L5 | ro 优先且 family != producerFamily | 审查、安全边界、反证、终审 | L4 的池内综合评分前二可受控补位；无候选时明确报告无法独立复审 |
| `vision` | 单独配置 | `vision=true` | 截图、图表、UI、流程图理解 | 不按 L1-L5 文本池准入；保留现有视觉硬门 |

未知 global 兜底模型只可作为 `economy` 同级候选，不能向上承担文本任务。静态候选链保留最多四个本级候选和两个回退候选；运行期只有本级候选均因下线、熔断、额度、异族或结构门不可用时才实际派发回退项。其余断档仍沿用现有路由失败协议。

## 4. 池内加权优选

### 4.1 排序顺序

池内排序也分层，避免动态系数改变质量底线：

```text
硬门 -> 准入门 -> 能力级别（高优先） -> poolScore（高优先） -> rawCapability -> 实际成本 -> 稳定入参序
```

同一任务池中 L5 应优先于 L4，除非该池声明了“能力封顶/节约优先”。若希望 `economy` 不总是调度 L5，可定义该池的目标级别为 L1，并根据能力距离降低额外能力收益，而不是让 L1 超过 L5 的质量下限。

### 4.2 评分公式

```text
poolScore = suitability
          x capabilityFit
          x effortFit
          x health
          x water
          x peak
          x billing
          x knownModel
          x cost
          x latency
```

| 因子 | 首期建议 | 数据来源 | 用途 |
|---|---|---|---|
| `suitability` | 任务池与模型已声明专长的匹配度，默认 `1.00` | 后续模型画像 | 给代码、审查、工具执行等差异化能力留入口 |
| `capabilityFit` | 与任务池目标级别的距离，`1.00-1.10` | `capabilityLevel` 与 lane | 同为准入模型时，保留有限能力优势；不得替代准入门 |
| `effortFit` | 复用现有 `0.60-1.00` | `LANE_SPEC` | 模型思考档与任务复杂度匹配 |
| `health` | 复用 `1.00/0.60` | 模型矩阵 | 下线仍为硬门，受压仅降权 |
| `water` | 复用 `0.60-1.00` | 配额数据 | 仅影响有可靠水位数据的 provider |
| `peak` | 复用 `0.93/1.00` | provider 配置 | 高峰时轻微让位 |
| `billing` | 复用订阅 `1.00`、API `0.85` | 用户 JSONC | 商务策略，不能影响准入 |
| `knownModel` | 复用已知 `1.00`、未知 `0.75` | 能力来源 | 仅在同级别中降低未知模型优先级 |
| `cost` | 暂保持 `1.00` 或仅作平分裁决 | 真实模型价格数据 | 无可信价格前不得伪造价格系数 |
| `latency` | normal 仅平分裁决；immediate 改为主排序 | 探针 | 与当前 immediate 语义一致 |

首期不要将所有因素都改为强乘积。已有 `billing=0.85`、`unknown=0.75`、`strained=0.60` 同时生效时会过度压低候选。建议保留既有值，仅新增 `suitability` 与小范围 `capabilityFit`，并在决策日志中输出所有明细，累积数据后再校准。

### 4.3 各池的能力偏好

| 任务池 | 目标级别 | `capabilityFit` 原则 | 优选目标 |
|---|---|---|---|
| `economy` | L1 | L1/L2 为 `1.00`，L3+ 不额外加分 | 够用、稳定、低消耗 |
| `mechanical` | L2 | L2/L3 为 `1.00`，L4+ 不额外加分 | 规则遵循、工具执行、可验证 |
| `main` | L3 | 每高一级 `+0.03`，上限 `1.06` | 常规工程质量与可用性平衡 |
| `hard` | L4 | 每高一级 `+0.05`，上限 `1.05` | 强推理与长程一致性 |
| `review` | L5 | L5 首选；仅在全部 L5 不可用时使用 L4 后备 | 独立审查和风险发现，不做能力折价 |

该规则解决两个相反的问题：低风险任务不会因能力分无上限而总耗用最强模型；高风险任务也不会因订阅、额度或轻微延迟差被低能力模型抢占。

## 5. 实现方案

### 5.1 类型与能力映射

1. 在 `src/model-ranks.ts` 新增 `CapabilityLevel = "L1" | "L2" | "L3" | "L4" | "L5"` 和 `levelOf(tier, source)` 纯函数。
2. `baseScoreDynamic()` 的返回形状补充 `level`，同时保留现有 `score/tier/rawScore/source/version`，避免破坏决策日志与动态数据来源。
3. `levelOf()` 将 `source=global` 固定映射 L1；其余 `C/B/A/S` 分别映射 L2/L3/L4/L5。这样未知模型不会凭全局中位数 `0.70` 直接取得 L3。

### 5.2 准入门

1. 在 `src/lane-policy.ts` 新增 `minimumLevel(lane)` 和 `isEligibleForLane(shell, lane, capability)`。
2. `computeLaneChain()` 首先应用现有视觉门，再应用能力准入门，最后做每模型单面、池内评分和截断。
3. 在 `src/scoring.ts` 的 `isGated()` 后增加同源准入检查，使生成期链和运行期重排不会发生语义漂移。
4. `vision` 不读取文本 `minimumLevel`；仅执行视觉结构门，并可后续增加独立的视觉能力等级。

### 5.3 池内排序与可追溯性

1. 替换“全局 S/A/B/C 排序主键”为“已准入后的 `capabilityLevel` 主键”；保留旧 tier 和 rawScore 作为同级裁决信息，直到历史数据迁移完毕。
2. `scoreShell()` 增加 `suitability`、`capabilityFit`、`level`、`eligible` 字段，所有值写入现有 `routing-decisions.jsonl`。
3. `rankCandidates()` 按第 4.1 节稳定排序。`immediate` 仍可先按 latency，但必须先通过硬门和准入门。
4. 横幅增加每个 lane 的“最低等级”和链首评分摘要；doctor 增加“因能力不足被排除”的清点项，避免用户误认为模型掉线。

### 5.4 配置边界

首期把 L1-L5 分界、每池最低级别和 `capabilityFit` 留在代码常量中，确保行为单一可测。稳定一个版本并有真实决策日志样本后，再开放 `opencode-switchman.jsonc` 覆盖；配置必须受 schema 校验，禁止任意模型名的隐式提权。

## 6. 验收与测试

| 场景 | 预期 |
|---|---|
| L2 模型参与 `main` | 生成期与运行期均被准入门排除 |
| L3 模型参与 `main` | 可参与；优先级再由池内因素决定 |
| L4 与 L5 同时参与 `hard` | L5 先于 L4；`hard` 的有限能力加成可在日志中解释 |
| L4 模型参与 `review` | 即使订阅、水位、延迟较优也必须排除 |
| L5 同族模型参与 `review` | 继续被现有异族硬门排除 |
| 非视觉 L5 模型参与 `vision` | 必须排除 |
| global 未知模型 | 固定 L1，只可进入 `economy`；不能因 `0.70` 进入 `main` |
| `economy` 同时存在 L1 与 L5 | L1/L2 不因 L5 固有能力而被无条件压制；仍受健康、额度和显式计费配置影响 |
| `main/hard/review` 无合格候选 | 不静默降级，返回可解释的失败与替代建议 |

## 7. 风险与待确认项

| 项目 | 风险或问题 | 倾向 |
|---|---|---|
| L5 的门槛 | 现有 S 档模型可能较少，review 候选链会变短 | 保持严格；review 的价值在独立性而非可用率 |
| 动态榜单波动 | 第三方 rawScore 可能跨版本波动导致模型跳级 | 使用数据版本、滞后阈值或人工确认，不按单次刷新立即越级 |
| `economy` 成本目标 | 用户可能更在意价格而非能力 | 保持 L1/L2 不加分的能力封顶，待有真实价格数据再加 cost 因子 |
| `mechanical` 的降级 | L1 完成测试执行一般可控，但可能误改脚本 | 仅在任务声明可验证且用户允许降级时启用；默认输出降级标记 |
| 视觉能力 | 有读图能力不代表视觉质量一致 | 本期只保持结构门，后续单立视觉能力分级 |

## 附录 A：关键文件速查

| 内容 | 位置 |
|---|---|
| S/A/B/C 及策展回退 | `src/model-ranks.ts:4-14,98-122`（`baseScore`） |
| 六档 effort 与视觉/ro 结构 | `src/lane-policy.ts:35-43`（`LANE_SPEC`） |
| 基础链生成与 tier 分组 | `src/lane-policy.ts:60-96`（`computeLaneChain`） |
| 单壳动态评分 | `src/scoring.ts:117-145`（`scoreShell`） |
| 硬门与 review/vision 约束 | `src/scoring.ts:182-196`（`isGated`） |
| 运行期排序 | `src/scoring.ts:204-251`（`rankCandidates`） |
