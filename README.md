# opencode-switchman

**English** | [中文](./README.zh.md)

> Context on a meter. Tasks dispatch themselves.

[![opencode-switchman capability overview](docs/assets/preview-en.png)](https://mrzturn.github.io/opencode-switchman/)

An orchestration plugin for [OpenCode](https://opencode.ai). It does two things, and does them well:

**1. Context water-level control.** Your session's context is measured every turn. Reads run against a per-turn budget, so the model can't quietly gulp the whole repo; soft / hard / force watermarks trigger advice, then wrap-up, then an automatic backup-and-compact handover; every dispatched subagent carries its own hard cap. Context stops snowballing — a session can run all day without tokens being devoured by its own history.

**2. Automated decision dispatching.** Your primary model becomes a dispatcher: it profiles each task and delegates it to subagent shells across six cognitive lanes (economy / mechanical / main / hard / vision / review). The plugin enforces deterministic gates, weighted model scoring, and self-healing failure isolation, and logs every routing decision.

On top of that:

- **Multiple models or subscriptions? This plugin was built for you.** GitHub Copilot, GLM Coding Plan, DeepSeek — or any opencode provider — get orchestrated as one pool: quota-aware ordering, peak-window avoidance, forced cross-family review.
- **Only one model? Still worth it.** The context control and smart dispatch alone keep a single model usable indefinitely — no matter how long the session runs, the context never balloons.

## Install

One command — covers first install and later updates. Restart opencode afterwards.

```bash
curl -fsSL https://raw.githubusercontent.com/mrzturn/opencode-switchman/main/scripts/setup.sh | bash
```

or

```bash
npx -y opencode-switchman@latest    # or: bunx opencode-switchman@latest
```

Either path rewrites the `plugin` entry in your opencode config to the exact latest version and prunes stale caches. Manual npm install, from-source build, and the "why exact versions" note: [Installation details](./docs/reference.md#installation).

Prefer hands-off? Let your AI do the installation — paste this prompt into the AI you're using:

<details open>
<summary><strong>AI-assisted install prompt</strong></summary>

```text
Please install and configure the opencode-switchman plugin for my opencode, strictly following its official instructions.

Official sources (authoritative, do not guess from memory):
- GitHub repo: https://github.com/mrzturn/opencode-switchman
- npm package: https://www.npmjs.com/package/opencode-switchman
Read the repo README's "Installation" section and follow it exactly.

Steps:
1. Install the latest version published on npm: run `npx -y opencode-switchman@latest` (or `bunx opencode-switchman@latest`) — it rewrites the `plugin` entry in my opencode config to the exact latest version (it also works in the project-level `opencode.json` if that is what I use).
2. Complete the functional configuration: all plugin settings live in the standalone `opencode-switchman.jsonc` in my opencode config directory, auto-generated with defaults and inline comments on first start; check it against my providers (e.g. `zhipuai-coding-plan` / `deepseek` / `github-copilot`) and adjust as needed.
3. Verify correctness so opencode loads, starts, and runs the plugin: run `/switchman-doctor` inside opencode for a local credential-free diagnostic report and fix every error it reports; then restart opencode and confirm the plugin actually loaded — the log should contain `[opencode-switchman] injected N model shells (agents)` and my primary model's system prompt should carry the live `[ROUTES]/[WATERMARK]/[LIMITS]` banner block.

Do not declare success until all three steps pass; report what you changed and show the verification evidence.
```

</details>

**Prerequisites**: [opencode](https://opencode.ai), CLI/TUI recommended (dialogs, sidebar, and banners are richest there; the desktop app shares the same config and state). Any provider works; Copilot / GLM / DeepSeek additionally get quota-aware routing. Credentials are read-only from opencode's own auth — the plugin never stores secrets.

## Quick start

Five steps. Full walkthrough with screenshots: **[docs/quick-start.md](./docs/quick-start.md)** / [中文](./docs/quick-start.zh.md).

1. **Connect providers** — `/connect` in the TUI: Copilot OAuth, DeepSeek API key; GLM Coding Plan goes into `opencode.json` as the `zhipuai-coding-plan` custom provider.
2. **Pick the models that join orchestration** — `/models` then `ctrl+f` to favorite (desktop app: "Manage models" toggles).
3. *(Optional)* **`/modelRank`** — pin your own capability ranking; it overrides system scoring everywhere.
4. *(Optional)* **`/poolConfig`** — curate per-pool candidate lists for the six task pools.
5. **Restart and verify** — check the `[ROUTES]`/`[LIMITS]` banner and the sidebar `switchman` panel; run `/switchman-doctor` if anything looks off. Then just use opencode normally.

## What you get

**Core**

- **Context water-level control** — live session measurement (`[WATERMARK:SESSION]`), soft/hard/force thresholds, a per-turn read budget that auto-bounds over-eager reads, a hard cap with summary-and-terminate for every subagent, and an auto handover (full backup fork + compaction) at force level.
- **Automated decision dispatching** — a bundled dispatcher protocol turns your primary model into a dispatcher; six cognitive lanes route work to the right model at the right effort; six deterministic gates check every dispatch; failures trip breakers and isolation, and the system heals itself.

**Extras**

- **Multi-subscription orchestration** — quota-aware routing across Copilot / GLM / DeepSeek (any provider participates), peak-window yield, billing-aware scoring, cross-family review enforcement.
- **Manual overrides** — `/poolConfig`, `/modelRank`, `/expert`, `/handover`, `/switchman-doctor`, `/switchman-update`.
- **Visibility** — live four-line banner in every system prompt, TUI sidebar panel, tmux pane mirroring, per-session artifact workspace, and an audit log of every routing decision.

Full options table, architecture, and internals: [docs/reference.md](./docs/reference.md) (中文: [docs/reference.zh.md](./docs/reference.zh.md)).

## Documentation

- Quick start (illustrated): [English](./docs/quick-start.md) · [中文](./docs/quick-start.zh.md)
- Full manual (config, commands, architecture): [English](./docs/reference.md) · [中文](./docs/reference.zh.md)
- Technical spec (contracts / algorithms / field-test notes): [docs/2026-08-28-opencode-switchman-technical-design.md](./docs/2026-08-28-opencode-switchman-technical-design.md)
- Release notes: [CHANGELOG.md](./CHANGELOG.md)

## Roadmap

Near-term: quota support for more providers — more subscription plans and pay-as-you-go pools beyond Copilot / GLM / DeepSeek. If your provider isn't covered yet, [open an issue](https://github.com/mrzturn/opencode-switchman/issues): real usage decides what gets built next. Suggestions and bug reports are equally welcome.

## Support the author

This plugin is open source and free to use, and it will stay that way. Keeping it alive isn't free, though: supporting and testing adapter compatibility across providers means holding multiple subscriptions and debugging them one by one — every round costs real money.

If the plugin has genuinely helped you and your budget allows, buy me a coffee. Thank you — sincerely.

| Alipay | WeChat Pay | WeChat Pay |
|:---:|:---:|:---:|
| ![Alipay](docs/pay/alipay.png) | ![WeChat Pay](docs/pay/wechat_pay.jpg) | ![WeChat Pay](docs/pay/wechat_pay_2.jpg) |

## License

[MIT](./LICENSE)
