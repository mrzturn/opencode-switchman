# Changelog

This project follows [Semantic Versioning](https://semver.org/). Release notes describe user-visible behavior; implementation details remain in the technical specification and commit history.

## [1.0.0] - 2026-09-05

First stable release: the feature surface is complete and the English-first global surface (code, comments, bundled assets, docs, and UI copy) is done — ready for publication beyond the Chinese-language user base.

### Added

- **Per-call read budget (always on)** — every read-class tool call is costed against `context.readBudgetTokens` (default 1500, clamped 200..20000) from turn 1; over-budget reads are auto-bounded (limit appended in place) or denied with exact bounded-retry params. Replaces the old per-tool one-time watermark nudge (a coupon models rationally burned via retry/probing). Watermarks keep lifecycle duties only (soft=advice, hard=wrap-up deny, force=auto-handover); per-turn 2x self-read cap with idle failsafe; unbounded archaeology git denied at all tiers with a scoping hint; `[WATERMARK:SESSION]` banner extended with growth / turns-to-hard / self-read-used segments.

- **Context-window-capped watermarks** — the models.dev context window feeds the runtime model registry (fail-open); effective thresholds clamp to force ≤ 90% of the window with soft/hard ordered below it, and the default force watermark rises from 100k to 120k for a longer wrap-up runway.

- **`/expert` expert consultation + bundled agent skills** — a new command routes expert-consultation prompts, and the plugin materializes bundled agent skills into the opencode global skills dir at startup (add/overwrite-only sync, marker-gated cleanup, fail-open).

- **Per-session artifact workspace** — each main session gets `<project>/.switchman/<yyyy-mm-dd>/<sessionId>-<title>/` (SESSION.md, dispatches.jsonl, media/) so delegated artifacts stop scattering across the repo.

- **Per-project language preference (`[LANG]`)** — conversation / comments / docs language persisted per project (first-use ask, `.switchman/settings.json`), enforced by a per-turn iron-rule line; bundled skills defer to it.

### Fixed

- **Auto-handover compaction deadlock** — handover now routes compaction through `session.summarize` (the `session.command` API has no compact command) and numbers backup sessions itself (the server fork counter always returns "fork #1").
- **Review-lane self-review fallback** — same-family reviewers become a DOWNGRADED last resort instead of an empty chain: last-resort ro seats survive when no S/A-tier cross-family shell does, gate 7 denies same-family only while a cross-family candidate exists.
- **Image relay hardening** — vision-less main sessions relay image parts in every user message (was: last only; stored clipboard parts leaked the recurring host error back into later turns), raw-bytes parts persist to disk instead of leaking, and reading an image file in a text-only session denies early with a vision-shell redirect.
- **Stale todo list** — protocol §0.7 todo discipline plus a per-turn `[TODO]` status line keeps the list truthful across handovers.
- **Git UX split for read gates** — delivery git (commit/push/tag) is exempt at every tier; only unbounded archaeology reads get scoped or denied.

### Changed

- **English localization** — protocol assets (dispatcher rules, delegation template), runtime messages, code comments, and docs translated to English; no behavior change. Banner anchors renamed: `[路由]`→`[ROUTES]`, `[水位]`→`[WATERMARK]`, `[水位·会话]`→`[WATERMARK:SESSION]`, `[限制]`→`[LIMITS]`, `[更新]`→`[UPDATE]` (inline markers `【调度】`→`[DISPATCH]`, `【强制】`→`[MANDATORY]`). The technical design doc is now `docs/2026-08-28-opencode-switchman-technical-design.md` (full English translation; the Chinese original path removed). The Chinese README remains at `README.zh.md`; historical Chinese entries below are preserved as-is.

- **Sidebar panel layout/color polish** — quota sub-row labels pad to a global 8-column grid so progress bars and values align across provider blocks (fixes glued label-value pairs like `refresh2026-10-01`/`balanceexhausted`), the `░` track renders muted under the gradient fill with a leading space before reset-time tails, the watermark gradient and lane/model palette are brightened to the 400-level for contrast, sections get one blank line of separation, and per-provider `·observe-only` tags collapse when every provider is observe-only. Progress bars clamp to at least one filled cell for any pct>0, so small quotas (e.g. MCP 5%) no longer render an empty bar.

- **READMEs refreshed for v1.x** — What's New restructured around the read budget, `[LANG]`, `[TODO]`, `/expert` + bundled skills, and DOWNGRADED review semantics; the TUI is now the recommended primary interface; 4 new screenshots (sidebar status, `/poolConfig`, `/modelRank`).

## [0.2.7] - 2026-09-04

### Added

- **Deny auto-redirect (`dispatch.autoRedirect`, default on)** — wrong-shell dispatches no longer burn retries on deny-and-guess: when a dispatch gate denies, the plugin now rewrites `subagent_type` in-flight to the chain-head candidate the deny message already names (same-snapshot guard re-check, single hop, status-log entry `自动改派 X → Y`), so the first dispatch lands directly on the best available shell. Covers every candidate-bearing deny (quota/circuit/retired/pool-config/semantic gates), the `denyUninjected` path (valid ROUTE_META + chain-head candidate), built-in `explore`/`general` blocking (a synthetic economy/main ROUTE_META line is appended to the prompt), and gate-6 invalid-META on non-review lanes (a per-lane synthetic META is composed; review lanes keep the hard deny — cross-family review needs a real `producer_family`). A target that still fails the guard keeps the original deny. Set `dispatch.autoRedirect:false` in `opencode-switchman.jsonc` to restore deny-and-retry.

- **Image relay for vision-less main models (`relay.image`, default on)** — when the main session model has no vision input, pictures attached by the user used to surface as a host error with no one able to read them. The plugin now intercepts the last user message at request time (`experimental.chat.messages.transform`), decodes `data:` URL images to `~/.config/opencode/opencode-switchman/media/<sessionID>/` and replaces the picture parts with a single text part carrying the on-disk paths plus reading guidance (delegate a vision-lane shell with an image-modality ROUTE_META, or pass the paths to an MCP vision tool). Local paths and http URLs pass through by reference; models with vision metadata (or unknown metadata) are untouched; the hook is fully fail-open so chat streaming can never break.

### Fixed

- `denyUninjected` denies were silently swallowed by the hook's fail-open catch (the callID was never marked as a self-deny), so naming an uninjected shell never actually blocked the dispatch; the deny now propagates.

## [0.2.6] - 2026-09-04

### Added

- **Measured session watermark gate (`context.*`)** — delegation bias fix, mechanism level. The dispatcher rules previously relied on the main model self-reporting context watermarks (60k/80k/100k), which it cannot actually measure: sessions routinely sailed past 100k on self-served reads. The plugin now tracks each main session's context size from `message.updated` token usage (input + cache.read + reasoning + output) and injects a live `[水位·会话]` line every turn. Past `softTokens` (default 60k), read-class tools (`read`/`glob`/`grep`/`list`/`bash`) get a one-time deny nudge per tool naming the current economy chain head to re-dispatch to; past `hardTokens` (80k) they are denied outright, with `bash` only letting verification and delivery commands through (git, test/lint/typecheck, build — delivery and verification are never blocked); past `forceTokens` (100k) the banner demands immediate compaction. Shell subagent sessions are exempt (they *are* the delegated workers). Thresholds and the gate itself are configurable (`context.gates/softTokens/hardTokens/forceTokens`).

- **Built-in subagent block (`builtinAgents.mode=deny`, default)** — opencode core's task-tool description actively advertises `explore`/`general` for exactly the exploration tasks the economy lane exists for, and the dispatch gate fail-opened them. They are now denied with an economy/main re-dispatch hint; set `builtinAgents.mode="allow"` to restore the old pass-through.

- **Injection face modes (`injection.mode`)** — `chain` (new default) injects the six lane chains ∪ favorites/visible models into the task-tool description, saving ~6-10k tokens per session versus injecting every usable model; naming an off-chain model gets the existing `denyUninjected` hint (enable it in model management). `all` restores the previous behavior. Startup-level: restart to apply.

- `rules.delegationFloor` (default 3000, was a hardcoded 6k in the rules text) is now a jsonc knob interpolated into the bundled rules on injection.

### Changed

- **Bundled dispatcher rules slimmed ~45%** (≈2.2k → ≈1.2k tokens/session): watermark prose replaced by the plugin-enforced mechanism (the `[水位·会话]` line carries live numbers and directives), the four-dimension classification collapsed into a stricter "default-delegate" rule (self-do only for L/M cognition with <200-line single-file reads or <50-line edits), a minimal fill-in delegation sample is now inline, and the rules explicitly forbid built-in `explore`/`general`. `rules.delegationFloor` and the three watermark thresholds are interpolated from user config.

## [0.2.5] - 2026-09-03

### Added

- **Interactive manual overrides** — two new commands let user configuration beat system defaults, persisted to editable state files with mtime hot-reload:

  - `/poolConfig` (per-lane model assignment): pick a task pool (economy / mechanical / main / hard / vision / review), then toggle models in a native TUI select dialog (select to include, select again to exclude; capability tier shown per model). Assignment makes each pool's candidates deliberately different — a pool's manual list **overrides the system default candidate set**, and models inside it are still recommended by capability level; **the same model may join multiple pools**; pools without a configured (or with an empty) list keep the system default; "clear config" restores the system default for that pool. Outside the TUI the conversational `/poolConfig-chat` command drives the same flow, backed by the bundled `switchman-config.js` CLI (`pool list|add|remove|set|clear`, pool name = one of the six task pools). Config: `~/.config/opencode/opencode-switchman/pool-config.json` (key = task pool name, value = participating modelId array).
  - `/modelRank` (capability ranking): reorder models in the same dialog (pin to top / move up / move down / remove); the conversational variant is `/modelRank-chat`. A manual rank entry **takes priority over the base capability score** (realtime index → bundled snapshot → curated table all yield): matched models — including their prefix variants — get a rank-position score and S/A/B/C tier (rankings with ≤4 entries map positions to S/A/B/C in order; ≥5 entries use quantile buckets with the same semantics as the OpenRouter rank source — top 20% S, next 20% A, next 20% B, rest C; the linear rank position breaks ties within a tier). Unranked models are unaffected. The override feeds every decision surface: lane chains, effort affinity, capability-level gates and deny hints. Config: `~/.config/opencode/opencode-switchman/capability-rank.json` (`models` array order = strongest first).
  - The banner `[限制]` line reports active overrides ("手动能力排名 N 模型 / 任务池选配 M 池"), and `computeLane`/gates gained a `pool-config` drop reason plus a new gate 5.5 deny so shells outside their lane's assignment list never dispatch and never appear in fallback hints.
  - **Instant effect**: edits to either config file — hand-edited, via the TUI dialogs, or via the bundled CLI — are picked up by a directory watcher (5s mtime poll fallback) that immediately rebuilds the banner and sidebar panels; no need to wait for the next chat message.

## [0.2.4] - 2026-09-02

### Fixed

- Sidebar candidate chains now update immediately when favorites change. The recompute is fully synchronous (new activation set lands before the callback), but the sidebar snapshot rewrite was chained after the forced full probe (`probeP.then`) — during the probe window (seconds to tens of seconds) the sidebar kept showing the old chains while the status notification already reported the recompute. The snapshot is now rewritten immediately on recompute (new chains computed with the new favorites preference, health/latency carried over from the previous probe round) and refreshed once more after the probe converges latency ordering.

- Capability scores no longer punish unbenchmarked models as "weakest": the OpenRouter fallback source actually ships the official Artificial Analysis indices in `benchmarks.artificial_analysis` (179/421 models) — the parser now reads them (real absolute scores, `score_kind=index`) instead of missing them and falling into rank-position mode, which mapped models with **no** eval data (listed at the sort tail, e.g. `glm-5-turbo` #419/421) to ~0-point C-tier scores. Rank mode now also excludes models without any benchmark payload, letting them fall back to the bundled snapshot / curated tiers ("no data" ≠ "weakest"). The bundled `capability-default.json` was regenerated from the official indices (GLM family: glm-5.3 A 59.5 / coding 74.8, glm-5.3-flash A 57.5; glm-5-turbo correctly falls to its curated B tier).

- Context-diet injection no longer drops usable models: the injected superset is now the union of the six lane chains **plus every configured/usable model face** (`keepModels`), so models that merely lose chain competition (e.g. `glm-5.3-flash`, `glm-5-turbo`) stay injected instead of being flagged as "invalid favorites" in the banner. User favorites (and active session models) additionally get a same-tier preference boost in lane chains and runtime ranking — explicit user intent now beats score/name tiebreaks within a tier, while tier and level-distance invariants still dominate across tiers, and immediate (latency-only) ranking ignores it entirely. `off` fallback partitions remain last as before. Denied-shell messages now read "provider not connected / no credentials / non-chat model" instead of the misleading "not selected by any lane".

### Changed

- Vision-capable models are no longer score-penalized (÷2) in text lanes. The capability score already measures text/coding ability; vision is an orthogonal modality flag whose only job is to keep non-vision models out of the vision lane (unchanged: vision-lane filter + image-modality hard gate). Text-lane chains now rank vision-capable shells by the same capability × effort-affinity × billing factors as everyone else — same-tier vision shells (e.g. copilot gpt-5.6 family variants) reclaim their natural positions. The bundled manifest lanes were regenerated accordingly.

- **ro/rw pool partition**: lanes are now strictly partitioned by shell capability face before any preference ranking — the review lane draws only from `ro` shells, every other lane draws only from `rw` shells, and a lane falls back to the opposite face only when its own pool is empty (fail-open; the dispatch gate still denies `rw` tasks on `ro` shells). Fixes `rw` variants of the same model being cut from the injection face by name-order tiebreaks while only their `ro` alias survived via the review lane, which made non-review lanes (e.g. hard) banner an `ro` shell as their best candidate. Also adds a rawScore tiebreak to the cross-level fallback slots so stronger models no longer lose their slot to name ordering.
- Effort-preference routing layer: each lane now carries an explicit thinking-effort preference order — hard/review prefer `high→xhigh→max`, main/mechanical/vision prefer `medium→high→xhigh→max`, economy prefers `low→medium→high` (the first level the model supports is the default). `off`-effort shells no longer appear in any lane preference list; they are demoted to a lane-level fallback partition and only fill chain slots after every thinking-level candidate (e.g. models that only support on/off, or when all thinking shells are unavailable). Capability-tier ordering is preserved within each partition, at both chain generation and runtime ranking — including immediate mode, where latency now orders within the thinking partition before off shells. This stops off-effort shells (e.g. `glm-47-off`) from heading thinking lanes such as hard/main while thinking-capable candidates exist.

## [0.2.2] - 2026-09-02

### Fixed

- `bun run mode:local` / `mode:prod` were blind to the pinned-version plugin entries introduced by the updater (`opencode-switchman@x.y.z`): switching to local left both entries active (double-loading the plugin) and broke JSONC commas; switching back to prod could not reach the npm latest. The switcher now rewrites the whole `plugin` array block (comment/activate/insert with comma and indent normalization), fetches npm latest on `prod` (or `--version x.y.z`), prunes stale caches, and keeps the main config's `$schema` pointing at the in-repo schema on `local` and GitHub main on `prod`. The repo root is auto-detected instead of a hard-coded home path.

### Changed

- Context diet: the shell superset injected as dispatchable agents is now pruned to the union of the six lane chains (same algorithm and resolvers as runtime routing) plus user-defined custom lane entries — in real setups ~260 shells shrink to ~30, cutting the per-session task-tool description from ~6-10k tokens to well under 1k. Shells not selected are no longer injected; dispatching to them is denied with the usual best-candidate hint. Lane unions that come out empty fail open to the full superset.
- Shell agent descriptions drop the per-shell boilerplate sentence (the semantics already live in the subagent body prompt); each description is now just the matrix tag, shrinking the agent list by a further ~70%.
- The built-in dispatcher rulebook is no longer injected when the assembled system prompt already contains it (e.g. developing inside this repo, where the project `AGENTS.md` carries the same text) — saves ~2.2k tokens per session for those setups; unchanged for everyone else.

## [0.2.1] - 2026-09-01

### Added

- npm bin entry: the package now ships an updater CLI — `npx -y opencode-switchman@latest` (or `bunx opencode-switchman@latest`) covers first install and upgrades, the same idempotent path as the one-line script. The updater rewrites the `plugin` entry to the exact latest version and prunes stale OpenCode plugin-cache directories — OpenCode ≤1.18.x pins bare plugin specs to whatever was installed first, so bare names and `@latest` never upgrade.

### Fixed

- The updater now creates `tui.jsonc` whenever it is missing (create-if-missing) instead of only on fresh installs — upgrades on machines that had an opencode config but no tui config previously skipped the TUI sidebar registration silently.

### Changed

- `/switchman-update` now runs the bundled updater; the previous `npm install opencode-switchman@latest` approach wrote to a directory OpenCode does not load plugins from.

## [0.2.0] - 2026-09-01

### Highlights

- Added the optional OpenCode TUI `switchman` sidebar panel. It shows observed provider water levels, peak periods, six lane leaders, restart-required state, and the latest status message without obscuring the input area.
- Replaced the static shell list with a dynamic activation matrix. Desktop visible models and CLI/TUI favorites synchronize bidirectionally; active session models provide a fallback; a model-surface change recomputes the matrix and refreshes probes immediately.
- Added capability-tier routing and transparent scoring. Higher capability tiers remain ahead, while effort fit, health, water level, peak window, explicit billing, and unknown-model confidence resolve same-tier ordering.
- Made routing provider-neutral. Any official or custom OpenCode provider is valid; the explicit `billing` setting now controls the subscription/API preference instead of vendor-specific rules.
- Added real-dispatch isolation, repeatedly-missing model retirement, route-decision audit logs, restart-required indicators, and production self-update commands.
- Added `/handover`, which creates a compact continuation session while preserving the active model, agent, and reasoning effort.

### Configuration and upgrade notes

- Plugin configuration now lives in generated `opencode-switchman.jsonc`. Keep only the package entry in OpenCode's `plugin` array.
- Legacy tuple configuration (`["opencode-switchman", { ... }]`) remains supported for this compatibility release. `/switchman-doctor` identifies migration work with `SWM042` through `SWM044`; migrate before the next major version.
- If upgrading from the renamed `switchman.js` plugin, remove `~/.config/opencode/plugins/switchman.js` to prevent duplicate injection. The current state directory is `~/.config/opencode/opencode-switchman/`.
- To use the sidebar, ensure the same package spec is present in `tui.jsonc` or `tui.json`. `opencode plugin <spec>`, `bun run mode:local`, and `bun run mode:prod` manage this automatically.

### Screenshot assets

The release documentation uses these repository assets:

- `docs/assets/tui-sidebar-status.png`
- `docs/assets/tui-model-picker.png`

## [0.1.0]

- Initial public release.

---

# 更新日志

[English](#changelog)

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。此处记录面向使用者的行为变化；实现细节见技术方案与提交历史。

## [0.2.7] - 2026-09-04

### 新增

- **派发 deny 自动改派（`dispatch.autoRedirect`，默认开）**——错误壳派发不再靠 deny-重试烧 token：派发闸 deny 时直接把 `subagent_type` 在途改写为附言已算出的链首候选（同快照一跳守卫复检、状态日志记 `自动改派 X → Y`），首发即落最优壳。覆盖全部带候选的 deny（配额/熔断/退休/任务池/语义门）、`denyUninjected`（META 有效+链首候选）、explore/general 封堵（prompt 末尾追加合成 economy/main ROUTE_META）与非 review lane 的闸6无效 META（按 lane 合成；review 保持硬 deny——异族复审需真实 `producer_family`）。守卫仍拒则维持原 deny。jsonc 设 `dispatch.autoRedirect:false` 恢复旧行为。

- **无视觉主会话图片中继（`relay.image`，默认开）**——主会话模型无视觉输入时，用户贴图此前只剩宿主报错无人能读。现于请求时拦截最后一条用户消息（`experimental.chat.messages.transform`），把 `data:` 图片解码落盘到 `~/.config/opencode/opencode-switchman/media/<sessionID>/`，图片部件替换为携带路径与读图指引的单个文本部件（委派 image-modality ROUTE_META 的 vision 壳，或把路径传给 MCP 视觉工具）。本地路径/http URL 原值引用；有视觉元数据（或元数据未知）的模型不动；钩子全 fail-open，聊天永不中断。

### 修复

- `denyUninjected` 的 deny 此前被钩子兜底 fail-open catch 静默吞掉（callID 未标记为自deny），点名未注入壳从未真正阻断；现如实上抛。

## [0.2.6] - 2026-09-04

### 新增

- **会话上下文水位实测闸（`context.*`）**——派发偏向修复（机制层）。此前水位规则全靠主模型自报（它实际上测不了自己多少 token，会话常常自读冲过 100k）。插件现从 `message.updated` 的 token usage 实测每个主会话上下文（input+cache.read+reasoning+output），每轮注入 `[水位·会话]` 实时行：超 `softTokens`（默认 60k）读取类工具（read/glob/grep/list/bash）每工具首次 deny 提醒并附 economy 链首改派建议；超 `hardTokens`（80k）一律拦截，bash 仅放行验证与交付类命令（git 全系/测试/lint/typecheck/构建——交付与验证不被阻塞）；超 `forceTokens`（100k）横幅强制要求立即压缩。壳子代理会话豁免（它们就是被委派的执行体）。阈值与总开关可配（`context.gates/softTokens/hardTokens/forceTokens`）。

- **内置 subagent 封堵（`builtinAgents.mode=deny`，默认）**——opencode 核心的 task 工具描述会主动推销 explore/general，恰好与 economy 档抢同类的探索任务，而派发闸此前对非壳名 fail-open 放行。现默认 deny 并附 economy/main 改派建议；设 `builtinAgents.mode="allow"` 恢复旧行为。

- **注入面模式（`injection.mode`）**——`chain`（新默认）＝task 工具描述只注入六档链精选∪favorites/可见集，每会话省约 6-10k token；点名链外模型走既有 `denyUninjected` 提示（去模型管理开启即可）。`all` 恢复全量注入旧行为。启动级配置，重启生效。

- `rules.delegationFloor`（默认 3000，原规程硬编码 6k）成为 jsonc 配置项，注入规程时插值。

### 变更

- **内置调度员规程瘦身约 45%**（≈2.2k → ≈1.2k token/会话）：水位长文由插件机制取代（`[水位·会话]` 行携带实时数字与分级指令）；四维分类压缩为更严的「默认委派」规则（自做仅限认知 L/M 且单文件读取 <200 行或改动 <50 行）；新增最小委派样例内联；显式禁用内置 explore/general。委派底价与三水位阈值按用户配置插值。

## [0.2.4] - 2026-09-02

### 修复

- favorites 变更后侧栏候选链立即更新。重算本为全同步（新激活集在回调前已落盘），但侧栏快照重写挂在强制全量探针之后（`probeP.then`）——探针窗口（秒级~数十秒）内状态通知已报重算、侧栏却停留旧链。现改为重算完成即立即重写快照（新链按新收藏偏好计算，健康/延迟沿用上轮探针），探针完成后再刷新一次收敛延迟排序。

- 能力分不再把「没测过」当「最弱」：OpenRouter 备源其实随 `benchmarks.artificial_analysis` 字段带了官方 Artificial Analysis 真实指数（179/421 模型）——解析器现优先读取（绝对指数，`score_kind=index`），不再因漏读而落入 rank 序位模式、把无评测数据的模型（排在列表尾部，如 glm-5-turbo #419/421）线性映射成 0.x 的 C 档分。rank 模式也改为剔除无 benchmarks 数据的模型（回退内置快照/策展分档，未知≠最弱）。随包 `capability-default.json` 已按官方指数重生成（GLM 家族：glm-5.3 A 59.5/coding 74.8、glm-5.3-flash A 57.5；glm-5-turbo 正确落回策展 B 档）。

- 上下文瘦身不再裁掉可用模型：注入超集现为六档链并集**外加全部已配置/可用模型面**（`keepModels`），链竞争落选的模型（如 `glm-5.3-flash`、`glm-5-turbo`）保持注入，不再被横幅误报「收藏含无效模型」。用户 favorites（与活跃会话模型）额外获得同级优先加权：lane 链与运行时排序中，同级内显式用户意图压过分数/名称平决；跨级仍由能力档与等级距离硬键主导，immediate（仅延迟）排序完全不受影响。`off` 兜底分区照旧殿后。拒派文案由误导性的「未入选任一 lane」改为「provider 未连接/无凭证/非对话模型」。

### 变更

- 删除文本 lane 对视觉模型的 ÷2 评分惩罚：能力分（coding/intelligence 指数）已完整度量文本能力，视觉是正交模态属性，其唯一职责是把非视觉模型挡在 vision 池之外（vision 池过滤与 image modality 硬门不变）。文本 lane 中视觉壳改用与其他壳相同的能力×亲和×计费因子排序——同档视觉系壳（如 copilot gpt-5.6 家族变体）回归自然位次。随包 manifest 六链已同步重生成。

## [0.2.2] - 2026-09-02

### 修复

- `bun run mode:local` / `mode:prod` 此前不识别更新器写入的精确版本 plugin 条目（`opencode-switchman@x.y.z`）：切 local 会留下双份条目（插件重复加载）并破坏 JSONC 逗号；切回 prod 又找不到 npm latest。切换器现在整体重写 `plugin` 数组块（注释/激活/插入并规范逗号与缩进），`prod`（或 `--version x.y.z`）时拉取 npm latest、清理旧缓存，并让主配置 `$schema` 在 local 指向仓库内 schema、prod 指向 GitHub main；仓库根目录改为自动探测，不再硬编码家目录路径。

### 变更

- 会话上下文瘦身：注入为可委派 agent 的壳超集现裁剪为六档链的并集（与运行时路由同一算法与解析器）外加用户自定义 lane 条目——真实环境约 260 个壳缩到约 30 个，每会话 task 工具描述从 ~6-10k token 降到 1k 以内。未选中的壳不再注入；向其委派会被拒绝并附常见最优候选提示。lane 并集为空时兜底放行全量超集。
- 壳 agent 描述去掉逐壳样板句（语义已在子代理正文里）；描述现在只有矩阵标签，agent 列表再缩 ~70%。
- 组装系统提示里已含内置调度守则时不再重复注入（如在本仓库内开发、项目 `AGENTS.md` 携带同一文本）——这类环境每会话再省 ~2.2k token；其他环境不变。

## [0.2.1] - 2026-09-01

### 新增

- 新增 npm bin 入口：包内自带更新器 CLI——`npx -y opencode-switchman@latest`（或 `bunx opencode-switchman@latest`）首装、升级通吃，与一键脚本同一条幂等路径。更新器把 `plugin` 条目改写为最新精确版本并清理 opencode 插件缓存旧目录——opencode ≤1.18.x 会把裸包名 spec 钉死在首次安装的版本，裸名与 `@latest` 永不升级。

### 修复

- 更新器对缺失的 `tui.jsonc` 一律补建（create-if-missing），不再只在全新安装时创建——此前已有 opencode 配置但缺 tui 配置的机器升级时会被静默跳过，侧边栏不注册。

### 变更

- `/switchman-update` 改为调用随包更新器；旧的 `npm install opencode-switchman@latest` 方式写入的目录 opencode 实际并不加载。

## [0.2.0] - 2026-09-01

### 重点更新

- 新增可选的 OpenCode TUI `switchman` 侧边栏面板：展示已观察 provider 的水位、高峰时段、六档链首、待重启状态和最新通知，输入区不再被运行日志遮挡。
- 静态壳清单升级为动态激活矩阵：desktop 可见模型与 CLI/TUI favorites 双向同步；活跃会话模型负责兜底；模型面变化会立即重算矩阵并刷新探针。
- 新增能力分级与透明评分：高能力级始终优先；同级再按档位亲和、健康、水位、高峰、显式计费和未知模型置信度排序。
- 编排策略去厂商化：任意 OpenCode 官方或自定义 provider 都合法；订阅/按量偏好改由显式 `billing` 配置决定，不再依赖厂商专属规则。
- 新增实调失败隔离、重复缺失模型自动下线、路由决策审计日志、待重启提示和生产环境自更新命令。
- 新增 `/handover`：创建带压缩上下文的续接会话，并保留当前模型、agent 与思考档位。

### 配置与升级说明

- 插件配置现统一写入自动生成的 `opencode-switchman.jsonc`；OpenCode 配置的 `plugin` 数组只保留包引用。
- 旧元组配置（`["opencode-switchman", { ... }]`）在此兼容版本继续可用。`/switchman-doctor` 会用 `SWM042` 至 `SWM044` 标出迁移项；请在下一个大版本前完成迁移。
- 从旧名 `switchman.js` 升级时，删除 `~/.config/opencode/plugins/switchman.js`，避免重复注入。当前状态目录为 `~/.config/opencode/opencode-switchman/`。
- 如需侧边栏，确认 `tui.jsonc` 或 `tui.json` 的 `plugin` 数组也包含同一个包引用。`opencode plugin <spec>`、`bun run mode:local` 和 `bun run mode:prod` 会自动维护这一项。

### 截图资源

发布文档引用以下仓库资源：

- `docs/assets/tui-sidebar-status.png`
- `docs/assets/tui-model-picker.png`

## [0.1.0]

- 首个公开版本。
