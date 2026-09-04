<!-- [2026-09-04]-[English localization: translated in full from the Chinese-language original of this document (former filename docs/2026-08-28-opencode-switchman-*.md, see git history); no semantic change] -->

# opencode-switchman — Technical Design of the OpenCode Six-Lane Shell Matrix Orchestration Plugin

> Version: v1.2　　Date: 2026-08-28
>
> **Confirmed decisions (2026-08-28)**:
> - **Target shape**: an OpenCode plugin (TypeScript, `@opencode-ai/plugin` API) plus the AGENTS.md dispatcher protocol, delivering a six-lane shell matrix orchestration system with "multi-pool multi-model, routing by cognitive lane, plugin-level hard validation, quota awareness, breaker self-healing".
> - **Model layer**: GitHub Copilot native provider direct connection (claude/gpt families); GLM and DeepSeek kept as custom providers (baseURL+apiKey). Pool concept: `copilot` / `glm` / `deepseek` (+ the free `zen` pool, not part of quota awareness).
> - **Methodology**: four-dimension task profile, six lanes, delegation discipline, context watermark, cross-family re-review, terminal failure protocol, fail-open principle — all materialized as the repo's AGENTS.md protocol and plugin behavior.
> - This document is self-contained: all contracts, constants, schemas, and algorithms are given in full.
>
> **Change log**:
> - v1.0: design finalized (shell matrix / six gates / ROUTE_META / breaker / quota awareness / cost awareness).
> - v1.1: implementation-stage verification errata — banner hook moved to `experimental.chat.system.transform`; shell landing changed to config-hook injection (no file generation); the `tools` field deprecated in favor of `permission`; thinking efforts moved to agent `options`; task argument name confirmed as `subagent_type`; failure bookkeeping main path moved to `event`; the Copilot usage endpoint and model catalog were field-tested, closing two pending items; added the three-pool quota switches, cost tiebreaker, and the token read-only red line.
> - v1.2: full-matrix shape established — enabled models × all declared thinking efforts; the enabled surface takes the model-management pin list as its first source of truth; the effort source of truth moved to models.dev `reasoning_options`.

## 1. Requirements Overview

opencode-switchman gives OpenCode full orchestration capability: **the main model acts as the dispatcher, delegating tasks along six lane chains to "model × lane" empty-shell subagents, while the plugin performs deterministic interception (quota / breaker / protocol validation) and injects live routing and watermark state into the system prompt**.

Core capability points (acceptance cross-reference):

1. **Shell matrix**: `<pool>-mx-<model-short-name>-<lane>` empty-shell agents (config-hook injection); the role is assigned dynamically by the delegation prompt;
2. **Six-lane chain banner**: four lines of live state — `[ROUTES][WATERMARK][LIMITS][UPDATE]` — injected into the system prompt;
3. **ROUTE_META hard validation**: pre-dispatch interception on task; bad protocol is denied with the current best redirect candidate attached;
4. **Breaker and quota awareness**: failure bookkeeping → 10-minute breaker; three-pool watermarks drive ordering and hard blocking (per-pool switches);
5. **DELEGATION_V1 delegation protocol**: fixed header + role contract + variable task block;
6. **Probes**: liveness via real requests, matrix persisted to disk, capability catalog calibrates shell mapping;
7. **Cost-aware dispatch**: models.dev pricing snapshot participates as an in-chain ordering tiebreaker;
8. **Thinking levels**: declared directly at shell level via `options`.

## 2. Orchestration Contracts (Behavioral Specification)

### 2.1 Lifecycle × Component Interactions

```
opencode startup
  └─ [config hook] shell injection (shells.json → cfg.agent) + credential collection (auth.json / provider options)
  └─ background warm-up: probe matrix refresh (TTL 600s) + three-pool quota fetch + models.dev cost snapshot; 10-min periodic self-healing
Main model working (AGENTS.md protocol)
  └─ task dispatch (shell name)
       └─ [tool.execute.before] six-gate evaluation → deny (throw Error + reason + redirect candidates) or pass → subagent executes
       └─ [event] message.part.updated (tool part error) → failures.log bookkeeping
            → ≥2 failures within a 600s window → routing.json breaker for 600s
Each LLM request
  └─ [experimental.chat.system.transform] appends the four banner lines (in-memory, idempotent, fail-open)
```

Banner example (port contract, line-by-line parseable):

```
[ROUTES] economy: cp-luna-low→glm-53f-low→ds-v4fv-off | mechanical: … | main: … | hard: … | vision: … | review: …
[WATERMARK] GLM 5h window 20%, weekly 7% (refreshed 09-04 10:00) | Copilot monthly pool exhausted (recovers 2026-09-01) | GLM peak (5.3×3/Flash×1.2) · DS peak full price | advice: <one-line tiered pool-selection advice>
[LIMITS] down: none | reviewer must be cross-family (producer family ≠ shell family, ROUTE_META validated) | DeepSeek only as chain-tail fallback
[UPDATE] <only appears on events such as list/matrix updates>
```

### 2.2 Methodology (AGENTS.md protocol; full text in the repo's AGENTS.md)

**Token economics as the first principle**: rework is the most expensive token; skimp on process and filler, never on verification and critical reasoning. Derived rules:

| Rule | Content | Implementation vehicle |
|---|---|---|
| Four-dimension task profile | cognitive intensity (L mechanical / M routine / H architecture / X core-safety) × mechanicalness × context (S/M/L) × urgency (immediate/normal/deferable); self-do = ≤2 small files + cognition L/M + expected benefit <6k floor | protocol text |
| Six-lane typical roles | economy = clerk/scouter scanning & inventory; mechanical = tester/ops regression scripts; main = programmer/uiux/data-analyst; hard = planner core architecture; vision = observer image viewing; review = reviewer/planner case review, expert seats | six lane chains (shells.json lanes) |
| Delegation discipline | delegate only when expected benefit >6k; self-contained prompt (goal / known facts / paths / output format); summaries only; standard orchestration scouter→planner→reviewer case review→programmer→tester→reviewer re-review (scaled to size) | DELEGATION_V1 template |
| Context watermark | single metric = tokens cumulatively read into this session; soft watermark ≈60k — scanning/reading delegates to economy by default; hard watermark ≈80k — no new delegation or reads, wrap up or split the session; [MANDATORY, non-negotiable] force-compaction watermark ≈100k — compress session context immediately (summarize-archive / split session; declare retention boundaries before compression, verify key facts after; no new delegation or bulk reads until done) | protocol text |
| Verification and re-review | logic changes must be verified; >20 lines or multiple call sites → tester; >300 lines or core/security/data logic → reviewer, and **must be a different model family** (guards against same-family blind spots) | six-gate semantic gate (same-family deny) |
| Terminal failure protocol | the end of any delegation/downgrade chain = explicitly tell the user the reason + offer 2 options; cognitive roles (planner/reviewer/expert seats) must declare "downgraded" when downgraded | protocol text + deny postscript fallback line |
| fail-open | all plugin hook exceptions only write to stderr and never block the main flow | uniform across the four hooks |

### 2.3 Data Structures (all schemas)

**Shell (the runtime-injected AgentConfig)** = a "model × lane" empty shell:

```typescript
cfg.agent["copilot-mx-luna-low"] = {
  description: "Empty model shell [pool=copilot · gpt-5.6-luna · lane=low · rw]. Binds only the model and lane; the role is assigned dynamically by the delegation prompt.",
  mode: "subagent",
  model: "github-copilot/gpt-5.6-luna",
  options: { reasoningEffort: "low" },          // thinking effort mapped per family (§3.6)
  permission: { edit: "deny", bash: "deny" },   // ro shells are read-only; rw shells omit this key
  prompt: "<body of the 5 general rules>",      // role contract / trust stated facts without re-checking / minimal necessity with file:line / verify before delivery / report honestly
}
```

**Shell list shells.json (full matrix)**: authoritative enabled surface (models enabled in model management, pinned in `scripts/visible-models.txt`) × all declared thinking efforts (models.dev `reasoning_options`; toggle→off; in the Copilot catalog none is a synonym for off). Fields: `{name, pool, provider, modelId, effort, family, capability(ro|rw), vision, matrixKey(provider|modelId|effort)}` + `lanes` (six-lane static preference order; shell names within a chain must exist in the matrix). Generator: `bun run gen:shells`.

**Probe matrix model-matrix.json**: `{combos: {"provider|modelId|effort": {status:"ok|down|unknown", reason?, latency_ms?, checked_at}}, generated_at}`. Probing = real HTTP requests; TTL 600s; **a response within 30s means slow-but-usable, not down** (a 45s timeout is judged down); concurrency 8–32; missing matrix → dispatch surface fail-opens (banner chains get a `*` downgrade marker).

**Breaker routing.json**: `{down_agents: {key: reason}, down_expiry: {key: unix-seconds}, updated_at}`, keyed by `comboKey` (alias shells of the same combo share the breaker); bookkeeping failures.log JSONL: `{agent, key, shell, combo, reason(≤200 chars), ts}`. Constants: `FAIL_WINDOW=600s / FAIL_THRESHOLD=2 / DOWN_TTL=600s`.

**Quota caches**: `glm-quota.json` (five_hour/weekly{used_pct,reset_at} + mcp_monthly), `copilot-quota.json` (premium snapshot + reset_date + gateway_exhausted), `ds-balance.json` (balances + exhausted). Tiered TTL: normal 300s / high-watermark 60s / on failure fall back to the old cache ≤7200s.

**Cost snapshot costs.json**: a pricing score of `(input+output)/2` per model from models.dev, TTL 24h + last-good.

### 2.4 Six-Gate Evaluation (order = priority; any hit denies)

A deny returns `throw Error("<human-readable reason>, please redirect to <candidate>")`; the error text is surfaced back to the main model as the task tool's error:

| Gate | Evaluation | Deny semantics |
|---|---|---|
| 1 Registry | shell status≠enabled | enabled is the only dispatchable state: disabled and matrix **not** down → fail-open pass + stderr note (the probe corrects next round); disabled and matrix down → deny (matrix reason attached); unprobed surface → deny |
| 2 Probe matrix | combo status=="down" | only an explicit down blocks; unknown/missing/unprobed → pass + stderr note |
| 3 Breaker | shell name or comboKey ∈ down_agents (≥2 failures within the 600s window) | "temporarily unavailable (breaker tripped by consecutive failures, auto-recovers in ~10 minutes)" |
| 4 Pool exhausted | quota cache determines the plan will certainly fail | human-readable reason attached (GLM 100% used; Copilot certainly exhausted; DS balance depleted / arrears) |
| 5 Protocol | shell-name dispatch with ROUTE_META missing/bad/illegal values | sample + legal-value list + live candidates attached |
| 6 Semantic | same-family reviewer (producer_family==shell family) / capability=rw task to an ro shell / image task to a non-vision shell / source=auto picking DeepSeek while the plan pools have live shells | "re-review requires a cross-family perspective", "DeepSeek pay-per-use shells only as chain-tail fallback; plan first candidate X" |

**Deny-postscript candidate recomputation**: `first_candidate(lane, exclude=current shell, **META constraints)` = the chain-head auto_ok shell of compute_lane after the whole-group gates; chain exhausted → "downgrade chain exhausted: declare the reason to the user and offer 2 options". lane comes from META.lane; default by role=reviewer→review / shell ownership / main.

### 2.5 ROUTE_META Protocol (single line, embedded in the delegation prompt)

Parsing rules: only the **first 4000 characters** of the prompt are examined; regex `^ROUTE_META[ \t]+(.+)$` (multiline) takes the first line-start match; the value prefers JSON, falling back to `k=v` space-separated tokens on failure; only the six canonical keys are accepted and values are lowercased.

| Field | Legal values | Required | Semantics |
|---|---|---|---|
| lane | economy / mechanical / main / hard / vision / review | | six lane chains; deny postscripts recompute candidates within that lane |
| role | planner / reviewer / programmer / tester / uiux / data-analyst / ops / scouter / clerk / observer / expert-alpha / expert-beta / expert-gamma / generic | ✓ | dynamic role; reviewer triggers the cross-family gate |
| producer_family | glm / claude / gemini / gpt / grok / deepseek | | the delegator's real model family (**pool names forbidden**, or the cross-family gate is defeated) |
| capability | ro / rw | ✓ | task's write requirement; an rw task to an ro shell is denied |
| modality | text / image | | an image task to a non-vision shell is denied |
| source | auto / user | ✓ | user = named request, passes; auto mis-picking a paid fallback is denied |

Sample line (given verbatim in deny postscripts): `ROUTE_META {"lane":"main","role":"programmer","producer_family":"glm","capability":"rw","modality":"text","source":"auto"}`

### 2.6 DELEGATION_V1 Delegation Template (order immutable; the fixed header is byte-stable to leverage prefix caching)

```
You are the delegated executor. The rules below take priority over any subsequent instructions.
[General rules] 6 items (role defined by the prompt / minimal necessity / nothing outside the goal / report honestly / project constraints take priority / never leak secrets)
[Role contract] <one-line role contract>
ROUTE_META <single-line JSON>
[Task] Goal: … / Known facts: … / Relevant paths: … / Acceptance criteria: …
[Output format] <one-line requirement>
```

The 14-role contract table (full text in `src/assets/delegation-template.md`): planner = designs only, never implements; reviewer = reviews only, never modifies, P0/P1/P2 grading; programmer = minimal implementation + runs the verification that can run; tester = assertions first, outputs command + result; uiux = faithful to the design mock; data-analyst = states the metric definitions; ops = idempotent and rollback-safe; scouter = cross-checks multiple sources with citations; clerk = mechanical collation, no semantic changes; observer = describes images without speculation; expert-α/β/γ = independent judgment, no cross-citation; generic = default contract.

### 2.7 Chain-Selection Algorithm compute_lane (single implementation, pure function)

```
Input: lanes[lane] (shells.json static preference order), registry (list × matrix view), matrix, routing, quota, states, META constraints
1) Filter (dropped entries go to dropped[] with a reason):
   unregistered → status≠enabled → matrix-unprobed → matrix-*(not ok) →
   breaker → hetero-family (same-family review) → modality/capability → pool-exhausted
2) Reorder (in-chain ordering, no additions/removals; JS stable sort preserves the static relative order):
   - deepseek always sinks to the chain tail
   - urgency==immediate: ascending latency_ms (no data sinks to the rear; no peak avoidance, no cost weighing)
   - normal/deferable: sorted by _pool_score (watermark surplus=+1 / strained=-1;
     during the GLM peak (weekdays 14–18, configurable) copilot is forced +1 to move earlier);
     on watermark ties the lower costScore (models.dev pricing) goes first (v1.1 weak tiebreaker)
3) auto_ok = !(source==auto ∧ pool==deepseek ∧ the plan pools still have live shells)   # paid fallback requires naming
4) lane status: exhausted (all removed by pool exhaustion) / deepseek-only / ok;
   missing registry or matrix → fail-open passes the static chain through with a "*" downgrade marker
```

### 2.8 Quota-Awareness Semantics

**Watermark semantics**: watermarks only affect ordering (used-up quota is wasted quota); the only hard block = "the call will certainly fail" (GLM 100% used; Copilot certainly exhausted; DeepSeek balance depleted / arrears); `unknown` never hard-blocks. Smart pool-selection advice (pushing load toward credits about to expire, steering away from strained pools) is injected into the `[WATERMARK]` banner line.

**Three independent pool switches** (plugin options; all on by default, queries only fire when credentials exist):

```json
"plugin": [["<plugin>", { "quota": {
  "glm":      { "enabled": true },
  "deepseek": { "enabled": true },
  "copilot":  { "enabled": true }
}}]]
```

**Three-layer fail-open fallback** (a failure at any layer never blocks the plugin):
1. network failure / 10s timeout → fall back to the old cache (≤7200s) → on failure again set `unknown`;
2. missing credentials / 401 / 403 / missing fields → set that pool to `unknown`, the banner shows "quota unknown", no hard blocking;
3. corrupted state file → ignore and treat as `unknown`.
The breaker + probe down form the second source of truth and are unaffected by the switches.

### 2.9 Thinking Levels

Declared directly at shell level via `options`, overriding global model options: openai/copilot gpt families use `reasoningEffort`; claude families use `thinking:{type:"enabled",budgetTokens}` (clamped by min/max_thinking_budget); GLM/DS openai-compatible families use `reasoning_effort`. `off` = no reasoning parameter attached.

## 3. Technical Design (item-by-item implementation)

### 3.1 Model Layer

- claude/gpt family shells point model at the Copilot provider (`github-copilot/<modelId>`); family determination reuses model-name prefixes (claude\*/gpt\*/glm\*/deepseek\*/gemini\*/grok\*/kimi\*/mai\*), shared by the cross-family gate and producer_family validation.
- GLM and DeepSeek use custom providers (`npm:"@ai-sdk/openai-compatible"` + baseURL/apiKey); the GLM coding plan baseURL defaults to `https://open.bigmodel.cn/api/coding/paas/v4`.
- Pool concept: `copilot` (github-copilot) / `glm` (zhipuai-coding-plan) / `deepseek` / `zen` (free pool, no quota awareness); shell-name prefixes `copilot-mx-* / glm-mx-* / ds-mx-* / zen-mx-*`.

### 3.2 Quota Awareness: Direct Queries to Three Endpoints (field-tested)

The plugin **stores no keys of its own and goes through no proxy**: credentials are read-only from opencode's auth layer (`~/.local/share/opencode/auth.json`) — GitHub Copilot OAuth access, GLM key, DeepSeek key; provider config options and environment variables are secondary sources.

| Pool | Endpoint (tested 200) | Auth | Exhaustion criterion |
|---|---|---|---|
| glm | `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit` | Bearer GLM key | five_hour/weekly `used_pct ≥ 100` |
| deepseek | `GET https://api.deepseek.com/user/balance` | Bearer DS key | balance depleted / arrears (normal pay-per-use **never hard-blocks**) |
| copilot | `GET https://api.github.com/copilot_internal/user` (same endpoint as VS Code) | Bearer GitHub OAuth token | premium_interactions pool "certainly exhausted" |

**Copilot request headers**: `User-Agent: GitHubCopilotChat/0.35.0`, `Editor-Version: vscode/1.107.0`, `Editor-Plugin-Version: copilot-chat/0.35.0`, `Copilot-Integration-Id: vscode-chat`.

**Snapshot pitfalls (confirmed in the field)**: snapshot field semantics float — `entitlement/credits_used` may be missing; the combination `quota_remaining:0` + `unlimited:true` + `has_quota:false` can occur; and the snapshot may diverge from the gateway's live state (snapshot says 100% while the gateway returns 402). Porting rules:

1. Normalization: `remaining = remaining ?? quota_remaining`; numeric fields may be missing (set null);
2. **Certainly exhausted** has only two conditions: `unlimited==false && remaining<=0 && !overage_permitted`, or the dispatch gateway returns a monthly-quota-type error (HTTP 402/429 quota error body) → set `gateway_exhausted`, **trusted until `quota_reset_date`** (auto-triggered when probe 402s are ≥50% of the round and ≥3 combos);
3. All other floating combinations → status `unknown`: the banner shows `used` and `reset_date` (when present), shows no misleading percentages, and does not hard-block;
4. The breaker and probe down form the second source of truth.

**Token security red line**: the plugin treats the GitHub OAuth token as **read-only and never refreshes it itself** — refresh tokens rotate on use, and the plugin refreshing on its own would invalidate opencode's core credentials. 401/403 set `unknown` (fail-open); after the core refreshes, it self-heals.

### 3.3 Shells = Config-Hook Injection

- The plugin's `config(cfg)` hook loads `shells.json` and injects `cfg.agent[shell name]` for every enabled shell (shape in §2.3); user-defined agents are never overwritten.
- Frontmatter mapping: the `tools` field is deprecated → `permission` (ro shells deny `edit`/`bash`); `thoughtLevel` has no corresponding field → `options` (§2.9).
- Global AGENTS.md injection has no per-agent switch; the fixed token cost is accepted.
- Risk fallback: if config injection does not take effect, degrade to writing `~/.config/opencode/agent/*.md` at startup (dual-track alternative, isolated behind a single switch in shells.ts).

### 3.4 ROUTE_META Validator (core component)

The plugin's `tool.execute.before` intercepts `input.tool === "task"`:

1. Arguments: `output.args.subagent_type` (shell name), `output.args.prompt` (delegation text);
2. Shell name hits the list → six-gate evaluation per §2.4 (data sources: shells.json × matrix/routing/quota caches);
3. Deny → throw Error (reason + first_candidate redirect candidates); the callID enters the skip set to prevent self-bookkeeping;
4. Shell name not matched (old names / bare role names / built-in agents) → fail-open pass + stderr note.
Parsing / legal values / required fields / error codes follow §2.5 field by field — behavior locked by fixtures (§6).

### 3.5 Banner Injection

`experimental.chat.system.transform` (`output.system: string[]`): the four banner lines are appended before every LLM request (data comes from in-memory state, zero extra round trips; content idempotent; try/catch fail-open across the whole chain; 15s result cache). Note: the `chat.params` hook can only modify LLM parameters and cannot touch the system prompt — not viable.

### 3.6 Thinking Levels in Practice

effort → options mapped per family: gpt/grok/gemini families `{reasoningEffort}`; claude families `{thinking:{type:"enabled",budgetTokens}}` (low=1024/medium=2048/high=16384/xhigh=32768/max=32768); glm/deepseek families `{reasoning_effort}`; `off` = omit.

### 3.7 Failure Bookkeeping and the Breaker

- **Main path, the `event` hook**: bookkeeping when `message.part.updated` and part.type==="tool" and `state.status==="error"`; `tool.execute.after` is auxiliary; own denies (callID skip set) are not booked;
- Bookkeeping fields per §2.3; ≥2 failures in a 600s window → down (TTL 600s, lazily cleaned on read); window statistics read the last 256KB / most recent 2000 lines of the log;
- not-found-type errors only break the requested name, never the combo (missing config ≠ combo unusable).

### 3.8 Probes

- **Copilot direct scheme (aligned with opencode core)**: the GitHub OAuth token (gho_) is used directly as `Authorization: Bearer` against `https://api.githubcopilot.com` (skipping the v2/token exchange; gho_ via the exchange gets 403); headers: `User-Agent: opencode/<ver>`, `X-GitHub-Api-Version: 2026-06-01`, `x-initiator: agent`; endpoints vary by model family: claude→`/v1/messages` (anthropic protocol + thinking budget), gpt/grok/claude→`/responses` (`reasoning:{effort}`), gemini/kimi/mai→`/chat/completions` (`reasoning_effort`).
- **GLM/DS**: their own baseURL `/chat/completions` + `reasoning_effort` (omitted for off).
- Criteria: TTL 600s; 2xx=ok; a 45s timeout is judged down; concurrency 8–32; 10-min periodic self-healing refresh (automatically skipped within the matrix TTL).
- The matrix is written to `model-matrix.json`; startup warm-up + periodic refresh, fail-open throughout.

### 3.9 Directory Layout and State Files

```
~/.config/opencode/
  opencode-switchman/
    shells.json            # full matrix (generated baseline, hand-tunable)
    model-matrix.json      # probe matrix
    routing.json           # breaker state
    failures.log           # failure bookkeeping JSONL
    glm-quota.json / copilot-quota.json / ds-balance.json
    costs.json             # models.dev pricing snapshot
    delegation-template.md # DELEGATION_V1 full text (written at startup)
<repo opencode-switchman>/
  src/
    index.ts               # the only API adapter layer (four hooks + whole-chain fail-open wrapping)
    meta.ts gates.ts lane.ts   # pure-function core (zero dependencies, locked by fixtures)
    shells.ts breaker.ts probe.ts quota.ts cost.ts banner.ts state.ts types.ts
    assets/delegation-template.md
  scripts/gen-shells.ts    # full-matrix generator (bun run gen:shells)
  scripts/visible-models.txt  # authoritative enabled-surface pin (list of models enabled in model management)
  test/routing.test.ts     # behavioral contract fixture
  AGENTS.md README.md docs/
```

### 3.10 Cost-Aware Dispatch

- Data source: `https://models.dev/api.json` (public JSON, no auth); pricing for the three pools from the same source; `costScore=(input+output)/2`.
- Participation (weak, as a tiebreaker): in compute_lane, when watermark scores tie, the cheaper one goes first; the immediate lane is purely latency-ordered.
- The `[WATERMARK]` banner line carries pricing hints; a fetch failure fail-opens (the tiebreaker silently disengages).

## 4. Data-Source Criteria

1. **latency_ms**: measured by probes (matrix combos), not vendor marketing figures.
2. **Family determination**: model-name prefixes; shared by the cross-family gate and producer_family validation.
3. **Watermark hard-block criterion**: only "the call will certainly fail"; `unknown` never hard-blocks.
4. **Copilot model catalog**: `{api.githubcopilot.com}/models` (Bearer OAuth token, X-GitHub-Api-Version 2026-06-01); capabilities include reasoning_effort levels / thinking budget / vision / context window.
5. **Copilot usage endpoint**: `api.github.com/copilot_internal/user`; no public API for premium multipliers — an optional static table exists (off by default).
6. **GLM peak window**: default weekdays 14–18, configurable via the plugin option `billingWindow`.
7. **Task tool argument names**: `subagent_type`/`prompt`.
8. **Credential path**: `~/.local/share/opencode/auth.json` (0600; OAuth{refresh,access,expires}/Api{key}).

## 5. Impact Surface and Risks

| Risk | Description | Mitigation |
|---|---|---|
| Plugin API drift | hook signatures change with OpenCode versions | API touchpoints are concentrated in the single-file adapter layer index.ts; the six gates + META parsing are zero-dependency pure functions; fixtures lock behavior |
| Config-injection timing | the effective timing of runtime cfg.agent injection is undocumented | field-tested to work; fallback writes `~/.config/opencode/agent/*.md` (dual-track isolation in shells.ts) |
| Desktop runtime differences | the desktop app's embedded core runs Node, not Bun | bundle a single file (`bun run deploy`) into the plugins auto-discovery directory; Bun-only APIs forbidden |
| Model catalog drift | model names / effort sets drift with provider updates | probe + catalog self-calibration; shell names decoupled from the catalog (shells.json mapping); down models go through breaker/downgrade |
| Floating snapshot semantics | quota snapshot fields missing / semantically drifting (two shapes confirmed in the field) | normalization; only "certainly exhausted" hard-blocks; the gateway 402 is the second source of truth; everything else set to unknown |
| Token rotation conflict | the plugin refreshing on its own would invalidate opencode credentials | **red line: read-only, never refresh**; 401→unknown→core self-heals |
| Probe rate-limit noise | high-concurrency probing at peak triggers 429 | probe results persist per combo; a single 429 never sets a pool-level status; the next self-healing round corrects |
| 4000-character window | META beyond the window goes unparsed | the DELEGATION_V1 fixed header is very short (<1k); the protocol requires ROUTE_META right after the role contract |
| Coexisting with other tools | state is invisible between orchestration tools running together | the state directory is fully isolated (opencode-switchman/); no shared conflicts |

## 6. Acceptance Criteria (behavioral-contract fixtures, 124 items)

1. **META parsing**: both JSON/k=v formats, six-key whitelist, three required keys, first-4000-characters window, producer_family rejects pool names (main/gcp illegal), values lowercased;
2. **Six-gate order**: matrix down deny / disabled + matrix not down fail-open / unprobed surface deny, breaker deny, pool-exhausted deny, bad-META deny with sample, same-family reviewer deny, rw→ro deny, image→non-vision deny, auto→DeepSeek deny with the plan's first candidate, user-named pass;
3. **compute_lane determinism**: same input, same output (no timestamps); deepseek always at the chain tail; immediate by latency, normal by watermark; on watermark ties the lower costScore first (immediate unaffected); missing registry fail-opens with `*`;
4. **Breaker**: ≥2 failures in a 600s window trips, 600s TTL expiry clears, aliases of the same combo share, not-found only breaks the requested name;
5. **End-to-end**: shell dispatch with a legal META passes and receives the DELEGATION_V1 prompt; the four banner lines are line-by-line parseable; corrupted state files fail-open;
6. **Quota evaluation**: GLM 100% blocks / 99% doesn't; Copilot pitfall shapes (unlimited/missing fields) don't judge exhaustion, remaining≤0 with overage forbidden does block, gateway 402 sets exhaustion trusted until reset_date; DS normal pay-per-use never hard-blocks; a pool switch turned off means no queries and no hard blocking.

## 7. Landing Layout and Milestones

```
Plugin proper (this repo)
  index.ts        registers hooks (config / experimental.chat.system.transform /
                  tool.execute.before / event) + whole-chain fail-open wrapping
  meta.ts         ROUTE_META parsing + legal values + error codes (pure functions)
  gates.ts        six-gate evaluation (pure functions; input = state snapshot)
  lane.ts         compute_lane chain selection (pure function; watermark primary order + cost tiebreaker)
  cost.ts         models.dev pricing snapshot + costScore
  breaker.ts      failures.log bookkeeping + breaker window
  probe.ts        concurrent liveness probing + matrix writing (TTL 600s; Copilot direct to api.githubcopilot.com)
  quota.ts        three-endpoint quota probing (per-pool switches; tiered TTL cache; pitfall fallbacks)
  banner.ts       four-line banner generation
  shells.ts       shells.json → cfg.agent injection (effort→options, ro→permission)
  state.ts types.ts
shells.json       full matrix (produced by gen:shells)
AGENTS.md         dispatcher protocol
```

Milestones (all delivered): M1 pure-function core + all-green fixtures → M2 hook integration (shell injection + banner + deny end-to-end) → M3 probe / three-endpoint quota / cost / breaker self-healing + real-machine calibration.

## Appendix: Field Tests and Verification Records (basis for v1.1/v1.2)

- **OpenCode source verification** (github.com/anomalyco/opencode): `packages/opencode/src/tool/task.ts` (task arguments); `packages/plugin/src/index.ts` (all hook signatures, incl. `experimental.chat.system.transform`); config schema (AgentConfig `tools` @deprecated, no thoughtLevel, agent `options`); `packages/sdk/openapi.json` (`/provider/auth` returns only auth methods, not tokens); the desktop app's embedded core runs on the Node runtime (plugins must be bundled as pure JS into the plugins directory).
- **Official Copilot endpoint field tests** (2026-08-28, business seat, read-only):
  - `copilot_internal/user` 200: quota_snapshots for the three pools + quota_reset_date; both snapshot field shapes coexist (pitfalls confirmed);
  - `{api.githubcopilot.com}` direct (Bearer gho_ token): `/models` returns a 44-entry catalog with capabilities; when the monthly pool is exhausted, model requests return 402 "exceeded monthly quota" (diverging from the snapshot's unlimited:true — the gateway is the source of truth);
  - `copilot_internal/v2/token` exchange with a gho_ token gets 403: opencode core's scheme is exchange-free direct connection (`packages/opencode/src/plugin/github-copilot/copilot.ts`).
- **GLM endpoint field tests**: the coding plan baseURL is `https://open.bigmodel.cn/api/coding/paas/v4` (the plain paas/v4 returns 429 balance errors); the monitor quota endpoint's two TOKENS_LIMIT entries distinguish the 5h window / weekly quota by (unit,number)=(3,5)/(6,1).
- **Local proxy repo** (github-copilot-proxy; only an early reference for endpoints/headers; opencode-switchman does not depend on it).
- **Pricing data source**: models.dev `api.json` (pricing for the three pools from the same source + reasoning_options effort declarations); no public API for premium multipliers (community-confirmed); docs.github.com only has a static table.

## v2.0 Addendum (2026-08-29)

> Note: this section records only v2.0's capability increments and design constraints relative to v1.2; the historical design above is not rewritten.

1. **Dynamic activation matrix upgrade**: desktop visible models and TUI favorites auto-sync both ways, with `mtime` arbitrating the update direction; same-millisecond ties write to neither side, avoiding flip-flopping. When the CLI path is absent, a default-path fallback applies. Any change on either config surface immediately triggers activation-matrix recomputation and a full probe refresh without waiting for the TTL; the 10-minute periodic refresh remains as routine self-healing.
2. **Model scoring engine**: chain selection upgraded from a weak tiebreaker to an explicit weighted score. The base curated capability score matches along four routes — exact → prefix → family → global — recording the hit source; S/A/B/C tier grouping is irreversible: lower tiers can never overtake higher tiers via watermark, cost, or peak factors.
3. **Scoring factors and hard gates**: the final score is `base × effortFit × health × water × costBias × peak`. `health`: ok=1.0, strained=0.6; `water` takes the tighter of the two quota windows, and when Copilot is flush and near expiry it may be boosted in reverse to burn credits; `costBias`: subscription pool 1.0, pay-per-use pool 0.7, DeepSeek idle 0.85; `peak`: during the GLM peak only ×0.93 to yield within the same lane, never eliminating across capability levels. Hard-gated candidates — down, breaker, pool exhaustion, retired, real-call isolation — are eliminated first and never scored; the immediate urgency lane orders by probe latency.
4. **Decision log**: each banner rebuild writes each lane's candidates, removal reasons, and six-factor scores into `state/routing-decisions.jsonl`, kept as a 200-line ring, to explain "why it is chain head".
5. **Vendor-neutral failure classification layer**: `classifyFailure` uniformly normalizes `rate_limit / quota / auth / not_found / server / network / unknown`. A probe 429 sets `strained`, only down-weighting rather than jumping the whole chain to DeepSeek; a real-call 429 no longer mis-sets Copilot pool exhaustion — only a 402, or a 403 with quota wording, sets exhaustion. Three consecutive 404s within a 1-hour window auto-retire the model: excluded from chains, gates deny, and the `[LIMITS]` banner notes "n models retired".
6. **Real-call failure isolation**: when a probe says ok but an actual delegation fails, the combo enters an in-process isolation table: 30 minutes for ordinary failures, 10 minutes for `rate_limit`-type; all sessions perceive it immediately, and a restart clears it. This isolation runs in parallel with the existing 600s breaker, handling "statistical consecutive failures" and "real-call failures probes didn't cover" respectively.
7. **Self-update notification and commands**: the startup check carries a 24-hour cache; prod mode compares against the npm registry and registers `/switchman-update` (silent upgrade, banner switches to "upgraded, restart pending", restart prompted) and `/switchman-ignore` (ignored for this session; the prompt returns after restart). local mode compares against `origin/main`, only suggesting a manual update and registering only `/switchman-ignore`. The session-level ignore mark is judged by comparing `mtime` against the process start time; ignore records older than this process's start do not take effect.
8. **Local/prod mode switching**: new idempotent scripts `bun run mode:local` (builds, then points at the current repo) and `bun run mode:prod` (switches back to the npm package; refuses and prints the install command when not installed); restart opencode after switching to take effect.
9. **Banner contract reinforcement**: the four `[ROUTES][WATERMARK][LIMITS][UPDATE]` lines remain line-by-line parseable; the `[LIMITS]` line carries retired counts and downgrade marks, and the `[UPDATE]` line carries new-version notices plus the upgrade/ignore entries.
