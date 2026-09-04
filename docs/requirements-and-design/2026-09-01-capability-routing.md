<!-- [2026-09-04]-[English localization: translated from Chinese; no semantic change] -->

# capability-routing — Capability Tiering and Task-Pool Split Technical Design

> Version: v1.0　　Date: 2026-09-01　　Related modules: `src/model-ranks.ts`, `src/capability.ts`, `src/lane-policy.ts`, `src/scoring.ts`
>
> **Confirmed decisions (2026-09-01)**:
> - `vision` is the only task pool that mandatorily requires image-reading capability.
> - The capability-level order for text tasks is: `economy < mechanical < main < hard < review`.
> - Routing has two steps: first enter the task pool by model capability level, then optimize within the pool by dynamic factors; price, quota, or latency must never promote a low-capability model into a high-capability pool.

## 1. Goal

Make the current mechanism — which generates six candidate chains from a single capability tier and effort affinity — explicit as an interpretable two-stage routing:

```text
model capability data -> capability level -> task-pool admission -> in-pool dynamic scoring -> candidate order
```

This separates "does the model have the minimum capability to complete this class of task" from "among multiple qualified models, which one is currently more worth using". The former is stable and prudent; only the latter is influenced by quota, health, cost, and latency.

## 2. Status Quo and Problems

### 2.1 Current call chain

```text
baseScoreDynamic(modelId)                 // src/capability.ts
  -> { score, tier, rawScore, source }
computeLaneChain(shells, capabilityOf)    // src/lane-policy.ts:60
  -> structural gate + tier grouping + capability x effort x billing x unknown
rankCandidates(shells, context)           // src/scoring.ts:204
  -> hard gates + tier grouping + dynamic product score
```

Existing assets:

| Capability | Existing implementation | Reusability |
|---|---|---|
| Base capability score | `baseScore()`: exact, prefix, family, global four-level fallback, `src/model-ranks.ts:98` | Reuse directly |
| Discrete capability tier | `S/A/B/C` and `1.00/0.85/0.70/0.55`, `src/model-ranks.ts:4-14` | Needs extension into a business-level mapping |
| Dynamic capability index | `rawScore` of `baseScoreDynamic()`, used for secondary sorting within the same tier, `src/scoring.ts:121-144,243-247` | Reuse directly |
| Text/vision structural gate | vision tasks keep only vision shells, `src/lane-policy.ts:61-69`; revalidated at runtime, `src/scoring.ts:193-195` | Reuse directly |
| Runtime hard gates | down, breaker, quota, ro/rw, review cross-family, `src/scoring.ts:182-196` | Reuse directly |
| Dynamic weights | health, water, peak, billing, unknown, `src/scoring.ts:117-145` | Reuse directly, reorganized into in-pool factors |

The current `tier` already guarantees that S/A/B/C cannot be overtaken by the product score across tiers (`src/lane-policy.ts:86-94`, `src/scoring.ts:240-249`). But it does not define "which tiers may enter which task pool": every lane picks from all non-vision models and only spreads them apart via effortFit. Therefore B/C-tier models can still appear in the base chains of `hard` or `review` — especially visible when candidates are scarce — making task recommendations inconsistent with the user-defined capability stratification.

## 3. Tiering and Pool-Split Design

### 3.1 Two distinct concepts

| Concept | Role | Changed by real-time factors |
|---|---|---|
| `capabilityLevel` | Describes the model's intrinsic overall capability; determines the highest text task pool it may enter | No |
| `poolScore` | Compares current availability and fit within an admitted task pool | Yes |

`capabilityLevel` may come only from capability assessment data; provider, billing, quota, watermark, peak, price, or current failure state must not be mixed in. That information may only influence `poolScore` or eliminate candidates as hard gates.

### 3.2 Proposed model capability levels

Five levels serve the five text task classes, with configurable score boundaries. The initial phase keeps the existing curated `S/A/B/C` layer as a conservative fallback and does not promote unverified models.

| Level | Proposed score range | Default mapping from existing tier | Capability description | Highest text pool |
|---|---:|---|---|---|
| L1 | No reliable hit, `source=global` | No reliable capability data | Only very low-risk, verifiable clerical work | `economy` |
| L2 | C | C | Handles rule-explicit, easily verifiable process tasks | `mechanical` |
| L3 | B | B | Completes routine implementation, debugging, and analysis independently | `main` |
| L4 | A | A | Handles cross-module reasoning, complex design, and hard-problem localization | `hard` |
| L5 | S | S | Performs high-risk independent review, falsification, and key-conclusion verification | `review` |

Capability levels rely solely on the existing normalized `tier`, not directly on `rawScore`. This is a necessary constraint: Artificial Analysis uses an absolute index scale, while OpenRouter and the bundled snapshot may use a rank/quantile scale; directly defining unified raw-score ranges would drift as sources switch. `rawScore` is used only for secondary sorting within the same tier; level adjustments must have a traceable source via data version or manual configuration.

### 3.3 Task-pool admission rules

Adopt "same-level first, cross-level fallback" rather than "meeting the minimum level grants entry". As long as usable models exist at the target level, other levels do not participate in that pool's runtime ordering; only after the entire level is eliminated by hard gates does fallback proceed level by level, ordered by distance to the target level. A user explicitly naming a model can override auto-routing's same-level preference.

| Task pool | Minimum capability level | Mandatory structural condition | Typical tasks | Downgrade rule |
|---|---|---|---|---|
| `economy` | L1 | None | Inventory, extraction, formatting, simple retrieval | L1 first; when absent, fall back L2→L3→L4→L5 |
| `mechanical` | L2 | rw preferred | Testing, building, scripting, deterministic batch work | L1 does not fill across levels |
| `main` | L3 | rw preferred | Ordinary features, bug fixes, refactoring | Top two by in-pool composite score at L2 may fill in a controlled way |
| `hard` | L4 | rw preferred | Architecture, cross-module hard problems, complex reasoning | Top two by in-pool composite score at L3 may fill in a controlled way |
| `review` | L5 | ro preferred and family != producerFamily | Review, security boundaries, falsification, final review | Top two by in-pool composite score at L4 may fill in a controlled way; with no candidates, explicitly report the inability to re-review independently |
| `vision` | Configured separately | `vision=true` | Screenshots, charts, UI, flowchart understanding | Not admitted via the L1–L5 text pools; the existing vision hard gate is kept |

Unknown global-fallback models may only serve as `economy` same-level candidates and cannot take on text tasks above. Static candidate chains keep at most four same-level candidates and two fallback candidates; at runtime, a fallback entry is actually dispatched only when all same-level candidates are unavailable due to down, breaker, quota, cross-family, or structural gates. Other gaps continue to follow the existing routing failure protocol.

## 4. In-Pool Weighted Selection

### 4.1 Ordering

In-pool ordering is also layered, so dynamic factors cannot move the quality floor:

```text
hard gates -> admission gate -> capability level (higher first) -> poolScore (higher first) -> rawCapability -> actual cost -> stable input order
```

Within the same task pool, L5 should precede L4 unless the pool declares "capability cap / cost-first". If `economy` should not always dispatch L5, define that pool's target level as L1 and reduce the extra capability benefit by capability distance, instead of letting L1 exceed L5's quality floor.

### 4.2 Scoring formula

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

| Factor | Initial proposal | Data source | Purpose |
|---|---|---|---|
| `suitability` | Match between the task pool and the model's declared specialty, default `1.00` | Future model profiles | Leaves an entry point for differentiated abilities such as coding, review, and tool execution |
| `capabilityFit` | Distance to the pool's target level, `1.00-1.10` | `capabilityLevel` and lane | When models are equally admitted, preserves a bounded capability advantage; must not replace the admission gate |
| `effortFit` | Reuse existing `0.60-1.00` | `LANE_SPEC` | Matches the model's thinking effort to task complexity |
| `health` | Reuse `1.00/0.60` | Model matrix | Down remains a hard gate; strained only downweights |
| `water` | Reuse `0.60-1.00` | Quota data | Only affects providers with reliable watermark data |
| `peak` | Reuse `0.93/1.00` | Provider config | Yields slightly at billing peak |
| `billing` | Reuse subscription `1.00`, API `0.85` | User JSONC | Business policy; must not affect admission |
| `knownModel` | Reuse known `1.00`, unknown `0.75` | Capability source | Lowers unknown models' priority only within the same level |
| `cost` | Keep `1.00` for now, or tiebreak only | Real model price data | No fabricated price factor before trustworthy price data exists |
| `latency` | normal: tiebreak only; immediate: promoted to primary sort | Probe | Consistent with the current immediate semantics |

Do not turn all factors into strong products in the first phase. With `billing=0.85`, `unknown=0.75`, and `strained=0.60` active simultaneously, candidates get over-suppressed. Keep existing values, add only `suitability` and a small-range `capabilityFit`, output all details in the decision log, and calibrate after data accumulates.

### 4.3 Per-pool capability preference

| Task pool | Target level | `capabilityFit` principle | Selection goal |
|---|---|---|---|
| `economy` | L1 | L1/L2 `1.00`, no extra credit for L3+ | Sufficient, stable, low consumption |
| `mechanical` | L2 | L2/L3 `1.00`, no extra credit for L4+ | Rule-following, tool execution, verifiability |
| `main` | L3 | `+0.03` per level above, capped at `1.06` | Balance of routine engineering quality and availability |
| `hard` | L4 | `+0.05` per level above, capped at `1.05` | Strong reasoning and long-horizon consistency |
| `review` | L5 | L5 preferred; L4 backup only when all L5 are unavailable | Independent review and risk finding, no capability discount |

This rule resolves two opposite problems: low-risk tasks do not always consume the strongest models just because capability scores are uncapped, and high-risk tasks are not stolen by low-capability models due to subscription, quota, or slight latency differences.

## 5. Implementation Plan

### 5.1 Types and capability mapping

1. Add `CapabilityLevel = "L1" | "L2" | "L3" | "L4" | "L5"` and a pure `levelOf(tier, source)` function in `src/model-ranks.ts`.
2. Extend `baseScoreDynamic()`'s return shape with `level` while keeping the existing `score/tier/rawScore/source/version`, avoiding breakage of the decision log and dynamic data source.
3. `levelOf()` maps `source=global` fixedly to L1; the remaining `C/B/A/S` map to L2/L3/L4/L5 respectively. This prevents unknown models from reaching L3 directly via the global median `0.70`.

### 5.2 Admission gate

1. Add `minimumLevel(lane)` and `isEligibleForLane(shell, lane, capability)` in `src/lane-policy.ts`.
2. `computeLaneChain()` first applies the existing vision gate, then the capability admission gate, and finally per-model single-face selection, in-pool scoring, and truncation.
3. Add a same-source admission check after `isGated()` in `src/scoring.ts`, so generation-time chains and runtime re-ranking do not drift semantically.
4. `vision` does not read the text `minimumLevel`; it only applies the vision structural gate, with a separate vision capability tiering possible later.

### 5.3 In-pool ordering and traceability

1. Replace the "global S/A/B/C sort primary key" with an "admitted `capabilityLevel` primary key"; keep the old tier and rawScore as same-level adjudication information until historical data migration completes.
2. `scoreShell()` gains `suitability`, `capabilityFit`, `level`, `eligible` fields; all values are written to the existing `routing-decisions.jsonl`.
3. `rankCandidates()` sorts stably per section 4.1. `immediate` may still order by latency first, but must pass the hard gates and the admission gate first.
4. The banner gains a per-lane "minimum level" and chain-head score summary; doctor gains an "excluded for insufficient capability" inventory item, so users do not mistake it for a model outage.

### 5.4 Configuration boundary

The initial phase keeps L1–L5 boundaries, per-pool minimum levels, and `capabilityFit` as code constants for single, testable behavior. After one stable version with real decision-log samples, expose overrides in `opencode-switchman.jsonc`; configuration must be schema-validated, and implicit privilege escalation for arbitrary model names is forbidden.

## 6. Acceptance and Tests

| Scenario | Expected |
|---|---|
| L2 model in `main` | Excluded by the admission gate at both generation and runtime |
| L3 model in `main` | Participates; priority is then decided by in-pool factors |
| L4 and L5 both in `hard` | L5 precedes L4; `hard`'s bounded capability bonus is explainable in the log |
| L4 model in `review` | Must be excluded even with better subscription, watermark, or latency |
| L5 same-family model in `review` | Still excluded by the existing cross-family hard gate |
| Non-vision L5 model in `vision` | Must be excluded |
| Unknown global model | Fixed at L1, may only enter `economy`; `0.70` must not admit it to `main` |
| `economy` with both L1 and L5 | L1/L2 are not unconditionally suppressed by L5's fixed capability; still affected by health, quota, and explicit billing config |
| `main/hard/review` with no qualified candidates | No silent downgrade; return an explainable failure and alternative suggestions |

## 7. Risks and Open Items

| Item | Risk or issue | Disposition |
|---|---|---|
| L5 threshold | Few existing S-tier models may shorten the review candidate chain | Stay strict; review's value is independence, not availability |
| Dynamic leaderboard volatility | Third-party rawScore may swing across versions, causing models to jump levels | Use data version, hysteresis thresholds, or manual confirmation; no immediate level jump on a single refresh |
| `economy` cost goal | Users may care more about price than capability | Keep the capability cap where L1/L2 get no bonus; add the cost factor when real price data exists |
| `mechanical` downgrade | L1 finishing test runs is usually manageable but may misedit scripts | Enable only when the task declares verifiability and the user allows downgrade; output a downgrade mark by default |
| Vision capability | Image reading does not imply consistent visual quality | This phase keeps only the structural gate; a separate vision capability tiering may follow |

## Appendix A: Key File Quick Reference

| Content | Location |
|---|---|
| S/A/B/C and curated fallback | `src/model-ranks.ts:4-14,98-122` (`baseScore`) |
| Six-lane efforts and vision/ro structure | `src/lane-policy.ts:35-43` (`LANE_SPEC`) |
| Base chain generation and tier grouping | `src/lane-policy.ts:60-96` (`computeLaneChain`) |
| Per-shell dynamic scoring | `src/scoring.ts:117-145` (`scoreShell`) |
| Hard gates and review/vision constraints | `src/scoring.ts:182-196` (`isGated`) |
| Runtime ordering | `src/scoring.ts:204-251` (`rankCandidates`) |
