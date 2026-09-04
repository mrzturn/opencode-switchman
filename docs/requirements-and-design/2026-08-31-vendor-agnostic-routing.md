<!-- [2026-09-04]-[English localization: translated from Chinese; no semantic change] -->

# vendor-agnostic-routing — Vendor-Agnostic Orchestration Technical Design

> Version: v1.0　　Date: 2026-08-31　　Related modules: `src/scoring.ts`, `src/lane-policy.ts`, `src/provider-config.ts`, `src/gates.ts`, `src/quota.ts`, `scripts/gen-shells.ts`
>
> **Confirmed decisions (2026-08-31, user-approved)**:
> - **Zero vendor hard-coding**: orchestration rules (ordering/gating/chain generation) hard-code no vendor or model; they consume only opencode's official provider/model naming and user-defined providers.
> - **Explicit billing configuration**: a provider enjoys subscription-score priority only when explicitly marked `billing: "subscription"` in `opencode-switchman.jsonc`; unconfigured ones always use the api factor.
> - **Watermark factor**: providers with usage-watermark awareness enabled (`enabled: true`) introduce a watermark factor into scoring (reusing the aspect semantics landed on 2026-08-31).
> - **Unknown-model fallback**: models not matching the known system are classified into the nearest system; if nothing matches → unknown group, which the algorithm guarantees to rank after known models/vendors.
> - **DeepSeek chain-tail and all other pool-name rules are abolished**, replaced by billing/unknown factors.

## 1. Requirement Overview

The plugin's candidate-chain generation and runtime ordering are already algorithmic (capability score × effort affinity × structural gate), but commercial strategies are still hard-coded by pool name (copilot/glm/deepseek): DeepSeek always at the chain tail, auto mis-selecting DS denied, DS holding a reserved tail seat. This design replaces these hard-codings with **configuration-driven generalized factors** (subscription preference, watermark, unknown-group penalty), making the plugin vendor/model-neutral: adding a provider only requires it to appear in the opencode config and models.dev metadata, with no orchestration-code changes.

Baseline: 2026-08-31 workspace (watermark config + chain algorithmization + ro dedup landed, 165 pass / typecheck / build all green; final review canceled due to new requirements, merged into this design's W6).

## 2. Status Analysis (with code evidence)

> Line numbers are based on the 2026-08-31 workspace and may drift; method names are given alongside references.

### 2.1 Key call chain

```
gen-shells / runtime MatrixManager
  └─ computeLaneChain()                        // src/lane-policy.ts:41-74
       ├─ structural gate (vision keeps only vision shells / review keeps only ro faces)
       ├─ score = capabilityBase × effortFit × visionPenalty
       ├─ single face per model per chain (rw for non-review, ro for review)
       └─ DS reserved chain-tail seat          // ★D3 change point
Runtime scoring rankCandidates()               // src/scoring.ts:202-224
  ├─ hard-gate elimination (down/retired/quota/review same-family/vision/ro↔rw)
  ├─ dsLast: DeepSeek always last              // ★D2 change point
  ├─ tier grouping → total descending → cost ascending
  └─ total = base × effortFit × health × water × costBias × peak   // ★D4 extension point
META check denies source=auto mis-selecting DS // src/meta.ts (template quotes) ★D2
```

### 2.2 Inventory of existing logic

| Block | Trigger | Logic | Impact on this requirement |
|---|---|---|---|
| Internal pool enum | `Pool = copilot\|glm\|deepseek` (`src/types.ts:7-8`) | Pools run through quota/scoring/banner | ❌ Must be demoted to "quota infrastructure only" |
| DS chain tail (ordering) | dsLast inside `rankCandidates` (`src/scoring.ts:202-224`) | DeepSeek always after non-DS | ❌ Delete; use the billing factor |
| DS chain tail (chain generation) | `computeLaneChain` reserves a tail seat (`src/lane-policy.ts:41-74`) | DS guaranteed into the top 4 | ❌ Delete |
| auto→DS deny | META `source=auto` on a DS shell (`src/meta.ts`) | Reject with "plan first candidate" | ❌ Delete; use factor soft ordering |
| Three-pool quota fetch | `src/quota.ts:23-25` three endpoints | GLM/DS/Copilot each API | ✅ Keep (only providers with fetchers have watermark data) |
| Provider registry | `src/provider-config.ts` (three built-in keys + prefix pooling) | Fixed three keys | ❌ Open up: any key + dynamic discovery |
| SWM020 unknown-key error | `src/doctor.ts` | errors on unknown providers keys | ❌ Make legal (near-spelling downgraded to warn) |
| Capability-score fallback | `src/capability.ts` + `src/model-ranks.ts` (exact→prefix→family→global 0.7) | Fallback when no index | ✅ Reuse as "nearest-system classification" |
| billingWindow/quota legacy options | own-property explicit override (near `src/index.ts:350`) | First-gen compatibility | ✅ Keep untouched |
| water aspect | `enabled=false` → water=1, hard blocks lifted (four consumption points) | Landed 2026-08-31 | ✅ Reuse directly |

### 2.3 Reference exemplars

- `computeLaneChain` (`src/lane-policy.ts`): pure function shared by generation/runtime — insert billing/unknown factors following this pattern.
- `billingWindowForConfig` legacy-options override (`src/lane.ts:36-44`): exemplar of explicit config taking precedence over defaults.
- `provider-config.ts` registry: the skeleton to open up lives here.

### 2.4 Table/interface status

| Concern | Status | Impact |
|---|---|---|
| `billing` field | Absent repo-wide | ❌ Must add (config schema v2 + types + factor) |
| Unknown group (unknown pool/classification) | Absent (unmatched goes to global 0.7 unmarked) | ❌ Must add explicit grouping and penalty |
| Custom provider discovery | Only `collectCreds` reading auth.json candidate paths (`src/quota.ts:129-153`) | ❌ Extend into a provider enumeration source |

## 3. Diff-Point Comparison Table

| # | Diff point | Status | This requirement |
|---|---|---|---|
| D1 | Provider sources | Three built-in keys hard-coded | opencode official providers + user-defined providers; any key legal |
| D2 | DS chain tail / auto deny | Pool-name hard-coding (ordering + chain generation + META deny) | Delete all; use factors |
| D3 | Reserved chain-tail seat | Reserved by DS pool name | Sink naturally via unknown/api factors; no reservation |
| D4 | Score factor chain | base×effortFit×health×water×costBias×peak | Append `billingBoost × unknownPenalty` |
| D5 | billing mark | None | Explicit `billing: "subscription"\|"api"` in config, default api; subscription factor preferred |
| D6 | Unknown models | Silent global 0.7 | Explicit unknown group + nearest-system classification first + ranked after known |
| D7 | doctor SWM020 | Unknown provider key errors | Legal (custom provider); only near-spelling warns |

## 4. Technical Design

### 4.1 Config schema extension (D1/D5/D7)

Each provider key in `opencode-switchman.jsonc` gains a `billing` field (`"subscription" | "api"`, default `"api"`); providers accepts any key (opencode official provider ids and user-defined ids); the three built-in keys keep default generation. In-memory gap filling / no write-back / doctor mechanisms carry over. SWM020 semantics change: unknown keys are legal (optionally with an info note "not matched on models.dev; will be classified into the nearest system"), and edit-distance near-spellings of the three built-in keys downgrade to a warn suggestion.

### 4.2 Opening up the provider registry (D1/D6)

The `src/provider-config.ts` registry becomes three layers: built-in definitions (three keys, each with its quota fetcher) → providers discovered from opencode config (custom entries in auth.json and the opencode.jsonc `provider` section) → models.dev metadata naming. Classification order: exact provider id → known prefixes (zhipuai/glm/zai etc.) → model-family nearest match (`model-ranks.ts` system) → none matched marks `unknown`. The internal `Pool` concept is kept **only** for quota-fetch infrastructure (only providers with fetchers have watermark data) and is forbidden from participating in ordering/gating/chain generation again.

### 4.3 Ordering factor chain rewrite (D2/D3/D4)

`total = base × effortFit × health × water × costBias × peak × billingBoost × unknownPenalty`

- `billingBoost`: `subscription=1.0`, `api=0.85` (configurable, landing in the `opencode-switchman.jsonc` top-level `scoring` section, or constants initially);
- `unknownPenalty`: unknown-group models `0.75` (configurable likewise), ensuring they rank after known models within the same tier and only fill the chain tail;
- Delete: the dsLast grouping in `rankCandidates`, the DS tail-seat reservation in `computeLaneChain`, and the deny for META `source=auto` selecting DS (deny now only validates META format and the review cross-family/ro/vision structural gates);
- `immediate`: latency + cost only, no vendor or capability (capability is already ignored; the "non-DS first" residue must go);
- The watermark factor applies only to providers with `enabled: true` (reusing the existing four consumption points).

> ⚠️ The factor values (0.85/0.75) are initial defaults and must match `capabilityBase`'s scale (S=1.0/A=0.85), lest the api subscription penalty press S-tier api models too far below B-tier subscription models — recommend adding an A/B comparison of "tier grouping first, in-group total ordering" vs "pure product" before deciding.

### 4.4 Doctor and banner (D7)

The banner's `[ROUTES]`/`[WATERMARK]`/`[LIMITS]` copy drops pool-name commerce semantics (e.g. "DS idle 50% off" becomes billing/cost-data-driven); doctor adds: unknown-group inventory (info), unconfigured-subscription hint (info), nearest-classification hit report (info).

### 4.5 Docs and protocol sync

In the repo's `AGENTS.md` and `README(.zh).md`, wording such as "deepseek as chain-tail fallback only", "plan-pool preference", "auto mis-selecting DS denied" changes to billing-factor descriptions. `~/.config/opencode/opencode-switchman/delegation-template.md` is a user-side file; the `source` field semantics need manual sync.

### 4.6 Test changes

DS-chain-tail/auto-deny assertions are all rewritten as billing/unknown factor assertions; add: custom provider resolution, unknown-group ordering (same tier, known > unknown), subscription explicit-mark effect and default non-effect, SWM020's new semantics, and the 165-item full regression.

### 4.7 Known boundaries (out of scope)

Shell names `<pool>-mx-<model>-<lane>` still contain vendor words — renaming would break existing delegation-prompt compatibility, so it stays untouched this phase (optional later: take the provider slug directly from the provider id). Quota fetchers still have only three vendors' API implementations (other providers have no watermark data, fail-open); this is the data plane, not the orchestration plane.

## 5. Data-Source Semantics

1. **[Decided] provider enumeration**: opencode official (`opencode models` / models.dev index) + user-defined entries in the opencode config `provider` section + auth.json credential existence (`src/quota.ts:129-153` candidate-path mechanism).
2. **[Decided] capability score**: keep `src/capability.ts`'s three-level fallback (AA API→OpenRouter→bundled snapshot→`model-ranks.ts` curation).
3. **[Decided] billing**: only an explicit `billing: "subscription"` in `opencode-switchman.jsonc` takes effect; no inference from models.dev/auth.
4. **[Open] factor values**: billingBoost api=0.85, unknownPenalty=0.75. Lean: land these defaults first + calibrate with A/B tests; leave a config extension slot.

## 6. Impact and Risks

| Risk | Description | Mitigation |
|---|---|---|
| Behavior flip | Existing deployments relying on DS-always-tail/auto-deny see ordering changes after upgrade | README migration notes + banner hints of the new factors; legacy options never carried such semantics, so no compatibility-switch burden |
| Factor-scale imbalance | Over-harsh penalties let subscription B-tier outrank api S-tier or vice versa | Calibrate via the 4.3 A/B test; factors configurable |
| Unknown-group misjudgment | Custom provider naming colliding unexpectedly with known prefixes | Exact match before nearest classification; doctor reports the classification basis |
| Incomplete provider discovery | opencode config format evolution misses discovery | fail-open: undiscovered providers still enter orchestration via models.dev/unknown group |
| META deny removal abuse | auto tasks flowing to expensive api models | billing-factor soft ordering as backstop + banner watermark/cost hints |

## 7. Open Questions

1. **[Decided]** Zero vendor hard-coding / explicit billing config / watermark-factor semantics / unknown group sinks: see the decision block at the top.
2. **[Open] factor values**: are 0.85/0.75 appropriate? Lean: land defaults first + A/B tests, calibrate next round.
3. **[Open] tier grouping vs pure product**: lean pure product (simplest, consistent with the existing total); introduce grouping if the A/B test shows imbalance.
4. **[Open] de-vendoring shell-name prefixes**: lean out of scope (breaks delegation compatibility); a separate design if needed.

## 8. Implementation Overview

```
config(user JSONC) ──┐
opencode provider ──┼─→ provider registry (opened up) ─→ classification (exact/prefix/family/unknown)
models.dev ─────────┘                                    │
                                                         ▼
computeLaneChain(structural gate + capability×affinity×billing×unknown) ─→ candidate chain
                                                         ▼
rankCandidates(hard gates + total full-factor product) ─→ chain head/banner/doctor
```

**File list**: `src/provider-config.ts` (opened-up registry), `src/config.ts` (billing field), `src/scoring.ts` (factor chain + remove dsLast), `src/lane-policy.ts` (remove tail-seat reservation), `src/meta.ts`+`src/gates.ts` (remove auto-DS deny), `src/doctor.ts` (SWM020 new semantics + unknown-group report), `src/banner.ts` (drop pool-name commerce copy), `src/types.ts` (billing/unknown types), `scripts/gen-shells.ts` (regenerate), `AGENTS.md`/`README(.zh).md` (docs), `test/` (assertion changes).

**Implementation batches (checkboxes, for direct execution in a new session)**:

- [x] W1 config extension: billing field + any provider key + SWM020 new semantics (verify: `bun test test/config.test.ts test/doctor.test.ts` + typecheck)
- [x] W2 registry opened up + nearest classification + unknown group (verify: new classification unit tests + full suite)
- [x] W3 ordering rewrite: factor chain + remove dsLast/tail seat/auto-deny + immediate cleanup (verify: `test/routing.test.ts test/scoring.test.ts test/lane-policy.test.ts` + full suite)
- [x] W4 banner/doctor/docs sync (incl. AGENTS.md and src/assets/agents-md.ts, delegation-template.ts; remind the user to manually sync the ~/.config delegation template)
- [x] W5 `bun run gen:shells` regeneration + full regression (`bun test`/`typecheck`/`build`; 171 pass / 0 fail, matrix idempotent except generated_at)
- [x] W6 tester independent regression + cross-family reviewer final review (**merging the 2026-08-31 canceled chain-algorithmization final review**)

## 9. Implementation and Final-Review Record (2026-08-31)

### Implementation summary (W1–W5 all checked)

- Factor chain `total=base×effortFit×health×water×costBias×peak×billingBoost×unknownPenalty` landed in `src/scoring.ts`; `BILLING_API_BOOST=0.85`/`UNKNOWN_PENALTY=0.75` (constants initially, config extension slot reserved); costBias always 1.0 (vendor rules abolished, cost data slot reserved).
- Pool-name rules fully removed: dsLast (rankCandidates/legacySort), DS tail-seat reservation (computeLaneChain), auto-DS deny (gates), auto_ok/deepseek-only (lane.ts); immediate is pure latency; peak generalized to any provider's peak ×0.93.
- Provider opening: any key legal + silent default gap-filling + bad values SWM030/031/036; SWM020 new semantics (custom info / near-spelling warn); doctor adds SWM060 unknown-group inventory / SWM061 billing not explicit / SWM062 nearest-classification hits.
- Verification baseline: 174 pass / 0 fail (649 assertions), typecheck, build dual artifacts, gen:shells idempotent (only generated_at), doctor CLI smoke all green.

### Tester independent regression (copilot-mx-terra-medium)

All green, no issues. 171-item full run + targeted spot checks of key files, idempotency, closure freshness, and deny-candidate same-source all pass.

### Cross-family reviewer final review (copilot-mx-terra-max, family=gpt≠producer glm) conclusion and disposition

Overall verdict: initial "block" → after all fixes, "mergeable" (see below). Item by item:

- **P0-1 base chain lacks tier grouping**: valid. `computeLaneChain` adds a tier-grouping primary key (`TIER_RANK` moved to model-ranks for sharing, capabilityOf upgraded to return `{score,tier}`, gen-shells/index same source). Note the deviation from §7-3 "lean pure product": the A/B test showed S/api(0.85) and A/sub(0.85) tie and cost/name can overtake, and B-unknown(0.525) would be squeezed out by C-known(0.55) — tier grouping is semantically consistent with runtime rankCandidates, so it was adopted.
- **P0-2 ordering-path pool-name residue**: legacySort's poolScore pool-preference ordering removed (fallback = input order / immediate latency); waterOf taking water by pool name is **kept** — it belongs to the quota data-plane aspect explicitly mandated by the ticket (only providers with fetchers have watermark data; the pool name is only a data mapping), with a comment added to fix the semantics.
- **P1-1 enabled:false did not turn off peak**: valid. Added `routingPeakActive` (enabled-gated); `providerPeakActive` kept as the display-side factual computation.
- **P1-2 legacy billingWindow did not cover actual scoring**: valid. index.ts converged to the single peak resolver: within an explicit legacy billingWindow's coverage it applies to the glm/deepseek pools (policy.routing gated), otherwise the jsonc routingPeakActive; banner/scoring/deny share all three paths.
- **P1-3 deny postscript candidate lacks water/costs/states**: valid. GateSnapshot extended with water/glmPeak/states, buildParams passes them through; tool.execute.before computes gateExtras shared by the two deny paths — checkShell and firstCandidateHint (no shell injected) — same source as the banner.
- **P2-1 doctor duplicate validation inflates counts**: valid. runDoctor dedupes by code+path+level+hint.
- Coverage gaps closed: computeLaneChain S/api vs A/sub and B-unknown vs C-known assertions, routingPeakActive routing/display semantics, providerEntry exact-key-first counterexample.
- Leftovers (out of scope, for awareness): shell-name prefixes still contain vendor words (4.7); quota fetchers still only three vendors' APIs (data plane); waterOf pool-name mapping (see P0-2 semantics).

## Appendix A: Key Files and Line Numbers Quick Reference

| Content | Location |
|---|---|
| Chain-generation pure function | `src/lane-policy.ts:41-74` (`computeLaneChain`) |
| Runtime ordering/dsLast | `src/scoring.ts:202-224` (`rankCandidates`) |
| total product chain | `src/scoring.ts:104-126` |
| META check/auto-DS deny | `src/meta.ts` (`META_LEGAL`) |
| Hard gates (incl. ro/vision/cross-family) | `src/gates.ts:97-183` (`checkShell`), `src/scoring.ts:160-174` |
| Provider registry | `src/provider-config.ts` (three built-in keys + prefix pooling) |
| Capability-score fallback | `src/capability.ts:72-104,365-385`; `src/model-ranks.ts:52-115` |
| Quota three-pool endpoints | `src/quota.ts:23-25` |
| User config loading | `src/config.ts` (JSONC/lock/backup/gap-fill) |
| Watermark aspect's four consumption points | `src/index.ts:272-275`, `src/lane.ts:306`, `src/scoring.ts:170`, `src/gates.ts:128` |
| Shell generator | `scripts/gen-shells.ts:127-157` |
