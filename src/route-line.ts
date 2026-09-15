// [2026-09-14]-[D2 per-turn [ROUTE] line: single pure renderer for the routing-discipline surface — ops has exactly one
//  per-request injection surface (experimental.chat.system.transform), so one module keeps the line from ever drifting
//  between "surfaces". It carries only what the injected lines lack today: the token cost-model sentence and the §6
//  declaration discipline elevated to every substantive action (the watermark line keeps the numbers/tier directives).
//  The caller-side gate lives in index.ts (rules||banner block; the dispatch-mode opt-out gate lands with dispatch: "off")]
// [English-only repo iron rule applies to this line — it is model-facing protocol copy]

/** The per-turn routing line: one sentence of declaration discipline + the hands-on vs dispatch token cost model */
export function renderRouteLine(): string {
  return "[ROUTE] token economy (IRON RULE): before each substantive action, declare in one sentence — [DISPATCH] self or delegate (§6) — weighing the measured context ([WATERMARK:SESSION]): hands-on spends and grows this session's context on every later turn, a dispatch spends a fresh shell context and returns a summary; long or heavy context favors dispatch, trivia (below the delegation floor, known-path reads, workspace bookkeeping, fleet coordination) stays hands-on."
}

/** Pure gate rule: the line rides the same rules||banner visibility wish as the watermark/TODO lines (zero-injection
 *  respected); [2026-09-14]-[D3: dispatch:"off" hides it too — the single opt-out switch for the whole routing-
 *  discipline surface (zcode semantics), while the watermark/TODO/banner lines stay on (information, not governance)] */
export function routeLineEnabled(rulesEnabled: boolean, bannerEnabled: boolean, dispatchOff: boolean): boolean {
  return (rulesEnabled || bannerEnabled) && !dispatchOff
}
