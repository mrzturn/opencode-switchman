# Changelog

[中文](#更新日志)

This project follows [Semantic Versioning](https://semver.org/). Release notes describe user-visible behavior; implementation details remain in the technical specification and commit history.

## [Unreleased]

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
