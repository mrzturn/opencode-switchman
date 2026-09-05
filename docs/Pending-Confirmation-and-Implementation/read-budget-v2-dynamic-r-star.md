# Read Budget v2 — Dynamic R*(t) (PENDING MANUAL TRIGGER; DO NOT IMPLEMENT)

- Status: **parked, awaiting owner decision**. The owner will run v1 (shipped 2026-09-05) for a period of real sessions, then explicitly ask to re-open this doc. An agent must not implement this without that request.
- v1 as shipped: always-on per-call read budget `context.readBudgetTokens` (default 1500, flat for the whole session), per-turn cap 2×, post-hoc charging in `tool.execute.after`, deny copies with exact bounded-retry params, no internal-semantics disclosure. See `src/context-watch.ts` (`budgetGateDecision`) and `src/index.ts` (`handleReadGate`).

## 1. Background and the economics that produced v1

Marginal-cost model (self-read vs delegate):

```
self-read marginal cost   = R × T          R = injected tokens, re-sent every remaining turn
delegate marginal cost    = (P + summary) × T + S   S = subagent boot (system prompt + tools), paid once, never enters the main session
break-even R*             = P + summary + S / T
```

Existing context C is sunk cost — paid every turn regardless of the choice — so the watermark level plays no part in the read decision (v1 enforces exactly this; the user's original "short context → self-serve" condition was a sunk-cost intuition and was dropped by design).

With S≈6000, P≈500, summary≈400 and an assumed T=10, the flat default R* ≈ 1500 tokens (~200 source lines).

## 2. What v2 would change

Replace the flat R* with a per-turn dynamic value computed from measured quantities:

```
T_est(t) = (hardTokens − C(t)) / Δ̄(t)        Δ̄ = mean of the last 5 positive per-turn context deltas (already tracked in wmHistory)
R*(t)    = P + summary + S / T_est(t)         clamped to [1000, 3000]
```

Expected effect (Δ̄=1k/turn, hard=80k, S=6k, P+summary=0.9k):

| Session phase | T_est | v2 R* | v1 R* (flat) |
|---|---|---|---|
| C=20k (early) | ~60 | ~1.0k (tighter) | 1.5k |
| C=50k (mid) | ~30 | ~1.1k | 1.5k |
| C=70k (late) | ~10 | ~1.5k | 1.5k |
| C=78k (near hard) | ~2 | ~4.4k → clamped 3.0k | 1.5k |

Honest assessment agreed with the owner:

1. v2's real theoretical gain is **early-session tightness** (T large → compounding worst), not late relaxation.
2. T_est is systematically unreliable: true T = min(turns-to-task-completion, turns-to-hard) and task completion is unknowable — short tasks make an early tight budget over-delegate.
3. A time-varying gate re-opens probe behavior ("wait for the budget to change, retry") — the exact behavior v1 was built to kill. Δ̄ noise makes verdicts oscillate. Hence the mandatory clamp.

## 3. Decision checklist (run this BEFORE implementing; the v1 data substrate is the status log)

v1 logs every gate event to the switchman status log (`appendStatusLog`). After ≥1–2 weeks of real sessions:

1. Extract `read budget gate` lines: `rg "read budget gate (deny-budget|deny-turn|cap|deny-hard)" <status log>`.
2. Count `deny-budget` by session phase (C at deny time is in the log line). If a large share of denies cluster at C < soft with est only marginally above 1500 (would have passed a 1.0k-early/3.0k-late dynamic budget), v2's early tightness has real value; if denies at C < soft carry est ≫ 1500, they were correct under any budget — v2 adds nothing there.
3. Count `deny-turn` events: frequent hits mean the per-turn 2× cap binds (chunking guard firing), not R* — tune the multiplier before touching R*.
4. Count `cap` events with immediate subsequent identical-file delegation (in dispatch traces) — that is auto-bound reads being re-fetched by economy anyway (double pay); if frequent, raise the auto-bound limit or widen R* instead of dynamizing it.
5. Only if (2) shows phase-correlated misjudgment: implement v2 with the clamp. Otherwise keep v1 and consider only adjusting the flat `context.readBudgetTokens` default.

## 4. Implementation sketch (if confirmed)

- `src/context-watch.ts`: `budgetGateDecision` signature is unchanged — it already receives `readBudget` per call. Add nothing here except (optionally) pure helpers `estimateTrend(samples: number[]): { delta: number } | null` and `dynamicReadBudget(delta, current, thresholds, base): number` with the clamp, both unit-tested.
- `src/index.ts`: in `handleReadGate`, replace `readBudgetOf(options.context)` with the dynamic computation (watermarkPace already exists; reuse it, it already returns `{ delta, turns }`). Turn budget stays `2 × R*` computed from the same dynamic value. The deny copy already interpolates the live cap — no copy changes needed. Banner already shows Δ̄ and T_est.
- Config: `context.readBudgetTokens` becomes the **clamp ceiling anchor / fallback** (rename NOT required; document that with v2 on it means "base"; add `context.readBudgetDynamic?: boolean` default false to gate the feature).
- Protocol asset `src/assets/agents-md.ts` §5: no text change required (it already describes budgeting generically; numbers live in the per-turn banner).
- Tests: extend `test/dispatch-gates.test.ts` with the two new pure helpers (monotone samples, all-decreasing samples → null, clamp bounds); index-level behavior is covered by the existing decision-function tests since the dynamic value only changes the `readBudget` input.
- Estimated size: ~80 lines including tests. No schema/config-format break.

## 5. Explicitly rejected alternatives (do not resurrect without new evidence)

- Gating reads on inferred task type/intent (bugfix vs refactor) — intent guessing is less reliable than the flat number it would replace.
- Per-tool one-time nudges (the pre-v1 design) — consumable state is a coupon the model rationally burns; retired 2026-09-05.
- Comparing existing context C against subagent boot cost S+P (owner's original formula) — sunk-cost fallacy; would delegate nearly everything past the first few turns.
