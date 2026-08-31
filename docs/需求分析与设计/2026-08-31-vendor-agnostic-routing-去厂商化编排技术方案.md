# vendor-agnostic-routing — 去厂商化编排技术方案

> 版本：v1.0　　日期：2026-08-31　　关联模块：`src/scoring.ts`、`src/lane-policy.ts`、`src/provider-config.ts`、`src/gates.ts`、`src/quota.ts`、`scripts/gen-shells.ts`
>
> **已确认决策（2026-08-31，用户拍板）**：
> - **零厂商硬编码**：编排规则（排序/门控/链生成）中不写死任何厂商与模型；只消费 opencode 官方 provider/模型命名与用户自定义 provider。
> - **billing 显式配置**：供应商在 `opencode-switchman.jsonc` 中显式标记 `billing: "subscription"` 才享受订阅打分优先；未配置一律按 api 系数。
> - **水位系数**：开了用量水位考量（`enabled: true`）的供应商在计算时引入水位系数（沿用 2026-08-31 已落地的切面语义）。
> - **未知模型兜底**：未命中已知体系的模型按近似体系归类；全部匹配不上→未知组，算法保证排在已知模型/厂商之后。
> - **DeepSeek 链尾等池名规则全部废除**，由 billing/unknown 系数取代。

## 1. 需求概述

当前插件的候选链生成与运行期排序虽已算法化（能力分×effort 亲和×结构门），但仍有按池名（copilot/glm/deepseek）写死的商务策略：DeepSeek 恒链尾、auto 误选 DS 被 deny、DS 预留链尾席位。本方案把这些硬编码替换为**配置驱动的一般化系数**（订阅优先、水位、未知组惩罚），使插件对任意厂商/模型中立：新增供应商只需出现在 opencode 配置与 models.dev 元数据中，无需改编排代码。

基线：2026-08-31 工作区（水位配置 + 链算法化 + ro 去重已落地，165 pass / typecheck / build 全绿；终审因新需求取消，并入本方案 W6）。

## 2. 现状分析（带代码证据）

> 行号基于 2026-08-31 工作区，可能漂移；引用同时给方法名。

### 2.1 关键调用链

```
gen-shells / 运行期 MatrixManager
  └─ computeLaneChain()                        // src/lane-policy.ts:41-74
       ├─ 结构门（vision 仅视觉壳 / review 仅 ro 面）
       ├─ 评分 = capabilityBase × effortFit × visionPenalty
       ├─ 每模型每链单面（非 review 取 rw，review 取 ro）
       └─ DS 预留链尾席位                        // ★D3 改造点
运行期评分 rankCandidates()                     // src/scoring.ts:202-224
  ├─ 硬门剔除（down/退休/额度/review 同族/视觉/ro↔rw）
  ├─ dsLast：DeepSeek 永远靠后                  // ★D2 改造点
  ├─ tier 分组 → total 降序 → 成本升序
  └─ total = base × effortFit × health × water × costBias × peak   // ★D4 扩展点
META 校验 source=auto 误选 DS deny              // src/meta.ts（template 引述）★D2
```

### 2.2 现有逻辑清单

| 块 | 触发条件 | 逻辑 | 对本需求影响 |
|---|---|---|---|
| 内部池枚举 | `Pool = copilot\|glm\|deepseek`（`src/types.ts:7-8`） | 池贯穿配额/评分/横幅 | ❌ 需降级为"仅配额基础设施" |
| DS 链尾（排序） | `rankCandidates` 内 dsLast（`src/scoring.ts:202-224`） | DeepSeek 恒排非 DS 后 | ❌ 删除，改 billing 系数 |
| DS 链尾（链生成） | `computeLaneChain` 预留尾席（`src/lane-policy.ts:41-74`） | DS 保底进前 4 | ❌ 删除 |
| auto→DS deny | META `source=auto` 且 DS 壳（`src/meta.ts`） | 拒绝并附"套餐首候选" | ❌ 删除，改系数软排序 |
| 三池配额抓取 | `src/quota.ts:23-25` 三端点 | GLM/DS/Copilot 各自 API | ✅ 保留（有抓取器的 provider 才有水位） |
| provider 注册表 | `src/provider-config.ts`（三内置键+前缀归池） | 固定三键 | ❌ 开放化：任意键+动态发现 |
| SWM020 未知键 error | `src/doctor.ts` | providers 未知键报错 | ❌ 改合法（近似拼写降 warn） |
| 能力分回退 | `src/capability.ts` + `src/model-ranks.ts`（精确→前缀→family→全局 0.7） | 无指数时兜底 | ✅ 复用为"近似体系归类" |
| billingWindow/quota 旧 options | own-property 显式覆盖（`src/index.ts:350` 附近） | 一代兼容 | ✅ 保留不动 |
| water 切面 | `enabled=false` → water=1、硬拦解除（四消费点） | 2026-08-31 落地 | ✅ 直接复用 |

### 2.3 可参照样板

- `computeLaneChain`（`src/lane-policy.ts`）：纯函数、生成期/运行期共用——billing/unknown 系数照此模式插入。
- `billingWindowForConfig` 旧 options 覆盖（`src/lane.ts:36-44`）：显式配置优先于默认的实现样板。
- `provider-config.ts` 注册表：开放化的骨架就在这改。

### 2.4 表/接口现状

| 关注点 | 现状 | 影响 |
|---|---|---|
| `billing` 字段 | 全仓库不存在 | ❌ 需新增（配置 schema v2 + 类型 + 系数） |
| 未知组（unknown pool/classification） | 不存在（未命中走全局 0.7 无标记） | ❌ 需新增显式分组与惩罚 |
| 自定义 provider 发现 | 仅 `collectCreds` 读 auth.json 候选路径（`src/quota.ts:129-153`） | ❌ 需扩展为 provider 枚举源 |

## 3. 差异点对比表

| # | 差异点 | 现状 | 本需求要求 |
|---|---|---|---|
| D1 | 供应商来源 | 三内置键写死 | opencode 官方 provider + 用户自定义 provider，任意键合法 |
| D2 | DS 链尾/auto deny | 池名硬编码（排序+链生成+META deny） | 全部删除，改系数 |
| D3 | 链尾预留席位 | 按 DS 池名预留 | 按 unknown/api 系数自然沉底，不预留 |
| D4 | 评分系数链 | base×effortFit×health×water×costBias×peak | 追加 `billingBoost × unknownPenalty` |
| D5 | billing 标记 | 无 | 配置显式 `billing: "subscription"\|"api"`，默认 api；订阅系数优先 |
| D6 | 未知模型 | 静默全局 0.7 | 显式未知组 + 近似归类优先 + 排已知之后 |
| D7 | doctor SWM020 | 未知 provider 键 error | 合法（自定义 provider）；仅近似拼写 warn |

## 4. 技术方案

### 4.1 配置 schema 扩展（对应 D1/D5/D7）

`opencode-switchman.jsonc` 每供应商键新增 `billing` 字段（`"subscription" | "api"`，缺省 `"api"`）；providers 接受任意键（opencode 官方 provider id 与用户自定义 id）；三内置键保留默认生成。内存补缺/不写回/doctor 机制沿用。SWM020 语义改为：未知键合法（可附 info「未在 models.dev 命中，将按近似体系归类」），对三内置键的编辑距离近似拼写降为 warn 建议。

### 4.2 provider 注册表开放化（对应 D1/D6）

`src/provider-config.ts` 注册表改为三层：内置定义（三键，含各自配额抓取器）→ opencode 配置发现的 provider（auth.json 与 opencode.jsonc `provider` 段的自定义条目）→ models.dev 元数据命名。归类判定顺序：精确 provider id → 已知前缀（zhipuai/glm/zai 等）→ model family 近似（`model-ranks.ts` 体系）→ 全不命中标记 `unknown`。内部 `Pool` 概念**仅**保留给配额抓取基础设施（有抓取器的 provider 才有水位数据），禁止再参与排序/门控/链生成。

### 4.3 排序系数链重写（对应 D2/D3/D4）

`total = base × effortFit × health × water × costBias × peak × billingBoost × unknownPenalty`

- `billingBoost`：`subscription=1.0`、`api=0.85`（可配，落 `opencode-switchman.jsonc` 顶层 `scoring` 段或常量首期）；
- `unknownPenalty`：未知组模型 `0.75`（同上可配），确保同 tier 下排已知模型之后、链内只作尾部填充；
- 删除：`rankCandidates` 的 dsLast 分组、`computeLaneChain` 的 DS 尾席预留、META `source=auto` 选 DS 的 deny（deny 改为仅校验 META 格式与 review 异族/ro/vision 结构门）；
- `immediate`：只按延迟+成本，不看厂商与能力（现状已不看能力，需去掉"非 DS 优先"残留）；
- 水位系数仅对 `enabled: true` 的 provider 生效（复用既有四消费点切面）。

> ⚠️ 系数数值（0.85/0.75）为首期默认，须与 `capabilityBase` 量纲匹配（S=1.0/A=0.85），避免 api 订阅惩罚把 S 级 api 模型压到 B 级订阅模型之下过狠——建议补一个"tier 分组优先、组内 total 排序"还是"纯乘积"的对照测试再定。

### 4.4 doctor 与横幅（对应 D7）

横幅 `[路由]`/`[水位]`/`[限制]` 文案去除池名商务语义（如"DS 空闲 5 折"改由 billing/成本数据驱动）；doctor 新增：未知组清点（info）、subscription 未配置提示（info）、近似归类命中报告（info）。

### 4.5 文档与规程同步

仓库 `AGENTS.md`、`README(.zh).md` 中「deepseek 仅链尾兜底」「套餐池优先」「auto 误选 DS deny」等表述改为 billing 系数说明。`~/.config/opencode/opencode-switchman/delegation-template.md` 为用户侧文件，需手动同步 `source` 字段语义。

### 4.6 测试改造

DS 链尾/auto-deny 断言全部改写为 billing/unknown 系数断言；新增：自定义 provider 解析、未知组排序（同 tier 已知>未知）、subscription 显式标记生效与缺省不生效、SWM020 新语义、165 项全量回归。

### 4.7 已知边界（范围外）

壳名 `<池>-mx-<模型>-<档位>` 前缀仍含厂商词——改名破坏现有委派 prompt 兼容，本期不动（可选后续：provider-slug 直接取 provider id）。配额抓取器仍只有三家的 API 实现（其余 provider 无水位数据，fail-open），属数据面不属编排面。

## 5. 数据来源口径

1. **【已定】provider 枚举**：opencode 官方（`opencode models` / models.dev 索引）＋ 用户 opencode 配置 `provider` 段自定义条目＋ auth.json 凭据存在性（`src/quota.ts:129-153` 候选路径机制）。
2. **【已定】能力分**：沿用 `src/capability.ts` 三级回退（AA API→OpenRouter→随包快照→`model-ranks.ts` 策展）。
3. **【已定】billing**：仅 `opencode-switchman.jsonc` 显式 `billing: "subscription"` 生效；models.dev/auth 不推断。
4. **【待定】系数数值**：billingBoost api=0.85、unknownPenalty=0.75。倾向：首期此值＋对照测试校准，配置化留扩展位。

## 6. 影响面与风险

| 风险 | 说明 | 应对 |
|---|---|---|
| 行为翻转 | 现依赖 DS 恒尾/auto-deny 的既有部署升级后排序变化 | README 迁移说明＋横幅提示新系数；旧 options 不承载此类语义，无兼容开关负担 |
| 系数量纲失衡 | 惩罚过狠导致订阅 B 级压过 api S 级或反之 | 4.3 对照测试校准；系数可配 |
| 未知组误判 | 自定义 provider 命名与已知前缀意外碰撞 | 近似归类前先精确匹配；doctor 报告归类依据 |
| provider 发现不全 | opencode 配置格式演进导致漏发现 | fail-open：漏发现的 provider 仍可经 models.dev/未知组进入编排 |
| META deny 删减后滥用 | auto 任务流向高价 api 模型 | billing 系数软排序兜底＋横幅水位/成本提示 |

## 7. 待确认问题清单

1. **【已定】** 零厂商硬编码／billing 显式配置／水位系数语义／未知组排尾：见文首决策块。
2. **【待定】系数数值**：0.85/0.75 是否合适？倾向：先落默认值＋对照测试，下轮校准。
3. **【待定】tier 分组 vs 纯乘积**：倾向纯乘积（实现最简、与现有 total 一致），对照测试若失衡再引入分组。
4. **【待定】壳名去厂商前缀**：倾向范围外（破坏委派兼容），需要时另立方案。

## 8. 落地方案概览

```
config(用户JSONC) ──┐
opencode provider ──┼─→ provider 注册表(开放化) ─→ 归类(精确/前缀/family/unknown)
models.dev ─────────┘                                    │
                                                         ▼
computeLaneChain(结构门+能力×亲和×billing×unknown) ─→ 候选链
                                                         ▼
rankCandidates(硬门 + total 全系数乘积) ─→ 链首/横幅/doctor
```

**文件清单**：`src/provider-config.ts`（开放化注册表）、`src/config.ts`（billing 字段）、`src/scoring.ts`（系数链+删 dsLast）、`src/lane-policy.ts`（删尾席预留）、`src/meta.ts`+`src/gates.ts`（删 auto-DS deny）、`src/doctor.ts`（SWM020 新语义+未知组报告）、`src/banner.ts`（去池名商务文案）、`src/types.ts`（billing/unknown 类型）、`scripts/gen-shells.ts`（重生成）、`AGENTS.md`/`README(.zh).md`（文档）、`test/`（断言改造）。

**实施批次（checkbox，供新会话直接执行）**：

- [x] W1 配置扩展：billing 字段＋任意 provider 键＋SWM020 新语义（验证：`bun test test/config.test.ts test/doctor.test.ts`＋typecheck）
- [x] W2 注册表开放化＋近似归类＋未知组（验证：新增归类单测＋全量）
- [x] W3 排序重写：系数链＋删 dsLast/尾席/auto-deny＋immediate 清理（验证：`test/routing.test.ts test/scoring.test.ts test/lane-policy.test.ts`＋全量）
- [x] W4 横幅/doctor/文档同步（含 AGENTS.md 与 src/assets/agents-md.ts、delegation-template.ts；提醒用户手动同步 ~/.config 委派模板）
- [x] W5 `bun run gen:shells` 重生成＋全量回归（`bun test`/`typecheck`/`build`；171 pass / 0 fail，矩阵幂等仅 generated_at 差异）
- [x] W6 tester 独立回归＋异族 reviewer 终审（**合并 2026-08-31 被取消的链算法化终审**）

## 9. 实施与终审记录（2026-08-31）

### 实施摘要（W1-W5 全勾）

- 系数链 `total=base×effortFit×health×water×costBias×peak×billingBoost×unknownPenalty` 落地于 `src/scoring.ts`；`BILLING_API_BOOST=0.85`/`UNKNOWN_PENALTY=0.75`（常量首期，配置化留扩展位）；costBias 恒 1.0（厂商规则废除，成本数据预留位）。
- 池名规则全删：dsLast（rankCandidates/legacySort）、DS 尾席预留（computeLaneChain）、auto-DS deny（gates）、auto_ok/deepseek-only（lane.ts）；immediate 纯延迟；peak 泛化为任意 provider 高峰 ×0.93。
- provider 开放化：任意键合法＋缺省静默补齐＋坏值 SWM030/031/036；SWM020 新语义（自定义 info／近似拼写 warn）；doctor 新增 SWM060 未知组清点/SWM061 billing 未显式/SWM062 近似归类命中。
- 验证基线：174 pass / 0 fail（649 断言）、typecheck、build 双产物、gen:shells 幂等（仅 generated_at）、doctor CLI 冒烟全过。

### tester 独立回归（copilot-mx-terra-medium）

全绿，无问题。171 项全量＋重点文件抽查、幂等、闭包时效与 deny 候选同源性定点核实均通过。

### 异族 reviewer 终审（copilot-mx-terra-max，family=gpt≠producer glm）结论与处置

总评：初版「阻断」→ 全部修复后转为「可合并」（见下）。逐项：

- **P0-1 基础链缺 tier 分组**：成立。`computeLaneChain` 增加 tier 分组主键（`TIER_RANK` 迁至 model-ranks 共享，capabilityOf 升级返回 `{score,tier}`，gen-shells/index 同源）。注意与 §7-3「倾向纯乘积」的偏离：对照测试证实 S/api(0.85) 与 A/sub(0.85) 打平后成本/名称可反超，且 B-unknown(0.525) 会被 C-known(0.55) 挤出——tier 分组与运行期 rankCandidates 语义一致，判定采纳。
- **P0-2 排序路径池名残留**：legacySort 的 poolScore 池偏好排序已删（回退=入参序/immediate 延迟）；waterOf 按池名取水位**保留**——属工单明示的配额数据面切面（有抓取器的 provider 才有水位数据，池名仅作数据映射），已补注释固化口径。
- **P1-1 enabled:false 未关 peak**：成立。新增 `routingPeakActive`（enabled 门控）；`providerPeakActive` 保留为展示口径事实计算。
- **P1-2 旧 billingWindow 未覆盖实际评分**：成立。index.ts 收敛为唯一 peak 解析器：显式 legacy billingWindow 覆盖期内对 glm/deepseek 池生效（policy.routing 门控），否则走 jsonc routingPeakActive；横幅/评分/deny 三路共用。
- **P1-3 deny 附言候选缺 water/costs/states**：成立。GateSnapshot 扩展 water/glmPeak/states，buildParams 透传；tool.execute.before 计算 gateExtras 供 checkShell 与 firstCandidateHint（未注入壳）两条 deny 路径共用，与横幅同源。
- **P2-1 doctor 重复校验放大计数**：成立。runDoctor 按 code+path+level+hint 去重。
- 覆盖缺口补齐：computeLaneChain S/api vs A/sub 与 B-unknown vs C-known 断言、routingPeakActive 路由/展示口径、providerEntry 精确键优先反例。
- 遗留（范围外，知悉即可）：壳名前缀仍含厂商词（4.7）；配额抓取器仍仅三家 API（数据面）；waterOf 池名映射（见 P0-2 口径）。

## 附录 A：关键文件与行号速查

| 内容 | 位置 |
|---|---|
| 链生成纯函数 | `src/lane-policy.ts:41-74`（`computeLaneChain`） |
| 运行期排序/dsLast | `src/scoring.ts:202-224`（`rankCandidates`） |
| total 乘积链 | `src/scoring.ts:104-126` |
| META 校验/auto-DS deny | `src/meta.ts`（`META_LEGAL`） |
| 硬门（含 ro/vision/异族） | `src/gates.ts:97-183`（`checkShell`）、`src/scoring.ts:160-174` |
| provider 注册表 | `src/provider-config.ts`（三内置键+前缀归池） |
| 能力分回退 | `src/capability.ts:72-104,365-385`；`src/model-ranks.ts:52-115` |
| 配额三池端点 | `src/quota.ts:23-25` |
| 用户配置装载 | `src/config.ts`（JSONC/锁/备份/补缺） |
| 水位切面四消费点 | `src/index.ts:272-275`、`src/lane.ts:306`、`src/scoring.ts:170`、`src/gates.ts:128` |
| 壳生成器 | `scripts/gen-shells.ts:127-157` |
