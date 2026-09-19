// [2026-09-19]-[English message catalog: single source of truth for the MsgKey set (src/i18n.ts keyof typeof en);
//  values verbatim from the i18n inventory, dynamic parts as {camelCase} placeholders]
// Conventions for downstream locales/rewrite agents:
// - One entry per UNIQUE inventory template; sites marked `dup` in the inventory share the earlier line's key.
// - `{a|b}` fixed-variant groups from the inventory are flattened into ONE camelCase param whose runtime value is the
//   chosen variant text (see i18n-keys.md "variant flattening" notes), e.g. `{done|failed}` -> `{outcome}`.
// - Comments above each entry cite the inventory site (file:line, plus the inventory's parenthetical qualifier).
export const en = {
  // ---- notices (status log; appendStatusLog) ----

  // src/breaker.ts:37
  "notice.breaker.realCallIsolated": "{agent} real-call isolated for {mins}m ({category}): {reason}",
  // src/breaker.ts:48
  "notice.breaker.shellNotInjected": "shell not injected into opencode (no isolation): {agent} {reason}",
  // src/breaker.ts:200
  "notice.breaker.failOpen": "breaker fail-open: {exc}",
  // src/capability.ts:246
  "notice.capability.snapshotCorrupted": "bundled capability rank snapshot corrupted (skipping, falling back to the curated table)",
  // src/capability.ts:299
  "notice.capability.primarySourceFailed": "capability index primary source AA failed ({exc}){nextStep}",
  // src/capability.ts:311
  "notice.capability.backupSourceFailed": "capability index backup source OpenRouter failed ({exc}) -> keeping last-good/bundled default ranks",
  // src/capability.ts:316
  "notice.capability.parsedEmpty": "capability index parsed empty ({source}) -> keeping last-good/bundled default ranks",
  // src/capability.ts:333
  "notice.capability.refreshed": "capability index refreshed: {source} {modelCount} models (version={version})",
  // src/capability.ts:336
  "notice.capability.refreshFailOpen": "capability index refresh fail-open (keeping last-good/bundled default ranks): {exc}",
  // src/capability.ts:372
  "notice.capability.lmarenaDisagreement": "capability LMArena cross-check: tier-order vs ELO-order agreement only {rate}% ({overlapCount} overlapping models) -- data source may be anomalous, manual review advised",
  // src/capability.ts:375
  "notice.capability.lmarenaFailOpen": "capability LMArena cross-check fail-open (skipped): {exc}",
  // src/catalog.ts:153
  "notice.catalog.unavailableNoCache": "models.dev catalog unavailable and no cache (fail-open degradation): {exc}",
  // src/copilot-thinking.ts:71
  "notice.copilot.shapeCacheRefreshed": "Copilot thinking-parameter shape cache refreshed: {modelCount} models",
  // src/copilot-thinking.ts:73
  "notice.copilot.shapeRefreshFailOpen": "Copilot thinking-parameter shape refresh fail-open: {exc}",
  // src/cost.ts:44
  "notice.cost.refreshFailed": "cost snapshot refresh failed (keeping stale data): {exc}",
  // src/dispatch-mode.ts:60 (log callback defaults to appendStatusLog)
  "notice.lang.settingsInvalidJson": "[opencode-switchman] {workspaceDirname}/{langSettingsFile} is not valid JSON — ignored (lang config falls back to the AGENTS.md marker; \"dispatch\":\"off\" not applied)",
  // src/dispatch-mode.ts:66 (log callback defaults to appendStatusLog)
  "notice.lang.dispatchNotOff": "[opencode-switchman] {workspaceDirname}/{langSettingsFile} \"dispatch\" present but not exactly \"off\" (got: {rawValue}) — ignored, fleet behavior",
  // src/index.ts:262
  "notice.ctx.paused": "ctx control paused for session {sid} (/ctx-pause): read gates + self-read budget + auto-handover suspended; measurement continues",
  // src/index.ts:264
  "notice.ctx.resumed": "ctx control resumed for session {sid} (/ctx-resume): read gates + auto-handover live again",
  // src/index.ts:467
  "notice.workspace.created": "artifact workspace created: {rel}",
  // src/index.ts:468
  "notice.workspace.renamed": "artifact workspace renamed: {oldRel} → {rel}",
  // src/index.ts:542
  "notice.dispatch.mirrorResumeReuse": "tmux pane mirroring: resume dispatch ses_{taskId} ({shellName}) — task_id reuse, pane opened directly (no session.created will fire)",
  // src/index.ts:546
  "notice.dispatch.mirrorResumeLookupFailed": "tmux pane mirroring: resume dispatch ses_{taskId} ({shellName}) — session lookup failed, fail-open pane",
  // src/index.ts:574
  "notice.capability.selectionChanged": "capability rank/task-pool selection changed: banner and sidebar refresh immediately",
  // src/index.ts:589
  "notice.capability.overrideWatchError": "fs.watch({dir}) override-config watch error (mtime polling fallback): {exc}",
  // src/index.ts:647
  "notice.matrix.configSurfaceFailOpen": "config surface read fail-open: {exc}",
  // src/index.ts:675
  "notice.matrix.floorFreeModels": "floor = {floorCount} OpenCode Zen free models (catalog {catalogStatus})",
  // src/index.ts:676
  "notice.matrix.floorFallback": "floor fell back to the static manifest (catalog {catalogStatus}, 0 free models)",
  // src/index.ts:680
  "notice.matrix.invalidModelsUnknownProvider": "visible set/favorites contain invalid models with unknown provider (provider not connected; ignored, no shells built): {modelList}",
  // src/index.ts:778
  "notice.provider.probeAttemptSucceeded": "provider.list attempt {attempt} succeeded (previous {prevAttempts} not ready)",
  // src/index.ts:783
  "notice.provider.probeAttemptBackoff": "provider.list attempt {attempt} not ready, backing off: {exc}",
  // src/index.ts:789
  "notice.provider.unavailableCfgFallback": "provider.list unavailable (fell back to {keyCount} cfg.provider keys after {attemptCount} attempts): {exc}",
  // src/index.ts:814 (alert)
  "notice.provider.probeNewProvider": "provider.list background probe: new provider(s) connected ({providers}) — restart opencode to complete shell registration",
  // src/index.ts:832 (alert)
  "notice.provider.probeModelDrift": "provider.list background probe: model list drifted ({drift}) — superset manifest rebuilt, /modelRank //poolConfig lists updated{restartHint}",
  // src/index.ts:834
  "notice.provider.probeRebuildFailed": "provider.list background probe: superset rebuild failed (kept previous manifest): {exc}",
  // src/index.ts:886
  "notice.probe.warmupFailOpen": "warmup fail-open: {exc}",
  // src/index.ts:900
  "notice.skills.synced": "skills synced: {installedCount} installed, {updatedCount} updated, {removedCount} removed ({skillNames})",
  // src/index.ts:903
  "notice.skills.syncFailOpen": "skill sync fail-open: {exc}",
  // src/index.ts:1145
  "notice.banner.failOpen": "banner fail-open: {exc}",
  // src/index.ts:1241
  "notice.ctx.readBudgetContinuation": "read budget continuation completion (file {fileName}, +{granted} lines from {offset}, turn {turnUsed}/{turnBudget})",
  // src/index.ts:1251
  "notice.ctx.readBudgetGateCap": "read budget gate cap (tool read, file {fileName}, est ~{totalTokens} -> limit {suggestedLimit}, turn {turnUsed}/{turnBudget})",
  // src/index.ts:1277 (template built at src/index.ts:1259 as denyLog)
  "notice.ctx.readBudgetGate": "read budget gate {action} (tool {tool}, est ~{totalTokens}{contRem}, C~{wmTokens}, T_est≈{turnsToHard}, turn {turnUsed}/{turnBudget})",
  // src/index.ts:1281
  "notice.ctx.readBudgetGateFailOpen": "read budget gate fail-open (allowed): {exc}",
  // src/index.ts:1306
  "notice.image.readGuardDenied": "image read guard: model {modelKey} has no vision input; denied read {fileName} (session {sid})",
  // src/index.ts:1310
  "notice.image.readGuardFailOpen": "image read guard fail-open (allowed): {exc}",
  // src/index.ts:1358
  "notice.doctor.summary": "doctor found {errorCount} error / {warnCount} warn; run /switchman-doctor to view",
  // src/index.ts:1393
  "notice.injection.legacyStaticMatrix": "injected {shellCount} model shells (agents, legacy static matrix)",
  // src/index.ts:1412
  "notice.provider.cacheUsed": "provider.list using cross-restart cache ({providerCount} providers, cached at {cachedAt}); verifying additions in background",
  // src/index.ts:1419
  "notice.provider.cacheStale": "provider.list cache stale (cached at {cachedAt}), probing live before the superset build",
  // src/index.ts:1469
  "notice.matrix.recomputed": "activation matrix recomputed (gen={generation}, active shells {activeShellCount}, probes {source}×{targetCount})",
  // src/index.ts:1474
  "notice.injection.shellCount": "injected {shellCount} shells (mode={runMode}, injection surface={injectionMode}={fullSupersetCount}→{faceCount} after curation, conflicts {conflictCount}; activation gating active)",
  // src/index.ts:1479
  "notice.injection.configHookFailOpen": "config hook fail-open: {exc}",
  // src/index.ts:1541
  "notice.lang.askLocale": "lang ask locale={locale} ({source})",
  // src/index.ts:1604
  "notice.banner.rulesFailOpen": "rules/banner fail-open: {exc}",
  // src/index.ts:1677
  "notice.relay.persisted": "image relay: model {modelKey} has no vision input; persisted {written} image(s) to disk ({relayed} image part(s) relayed across session history, session {sid})",
  // src/index.ts:1679
  "notice.relay.failOpen": "image relay fail-open (passed through): {exc}",
  // src/index.ts:1694
  "notice.ctx.capToolDenied": "subagent context cap: tool '{tool}' denied in terminated session {sid}",
  // src/index.ts:1701
  "notice.ctx.capResumeDenied": "subagent context cap: resume of terminated session ses_{taskId} denied (permanent)",
  // src/index.ts:1727
  "notice.lang.gateDenied": "lang gate: tool '{tool}' denied in unconfigured project session {sid}",
  // src/index.ts:1751
  "notice.search.clarifyFailOpen": "search clarify gate: fail-open after {maxDenies} denies without an ask — gate open for session {sid}",
  // src/index.ts:1754
  "notice.search.clarifyDenied": "search clarify gate: tool '{tool}' denied (broad search, ask-first) in session {sid} ({denyCount}/{maxDenies})",
  // src/index.ts:1774
  "notice.dispatch.offUngoverned": "dispatch off: task call allowed ungoverned (subagent_type='{subagentType}')",
  // src/index.ts:1853
  "notice.dispatch.redirectUninjected": "auto-redirect {agent} → {candidate} (uninjected shell; redirected to the chain-head candidate)",
  // src/index.ts:1874
  "notice.dispatch.redirectBuiltinBlocked": "auto-redirect {agent} → {candidate} (built-in agent blocked)",
  // src/index.ts:1883 (via src/gates.ts:331 noteUnknownAgent)
  "notice.dispatch.unknownAgentAllowed": "[opencode-switchman] unknown subagent_type='{agent}': allowed (not in the shell list; built-in agents are not governed by routing)",
  // src/index.ts:1889 (r.note via src/gates.ts:156)
  "notice.dispatch.registryDisabledNote": "[opencode-switchman] {agent} registry=disabled but matrix status={matrixStatus} (not down): fail-open, auto-corrected after the next probe refresh",
  // src/index.ts:1889 (r.note via src/gates.ts:175)
  "notice.dispatch.matrixStatusNote": "[opencode-switchman] {agent} matrix status={matrixStatus} (not down): not blocked, probe refreshes next round",
  // src/index.ts:1889 (r.note via src/gates.ts:63 ROUTE_META_SYNTH_NOTE)
  "notice.dispatch.routeMetaSynthNote": "[opencode-switchman] ROUTE_META missing/malformed — synthesized from lane; declare it to enable review cross-family / source=user semantics",
  // src/index.ts:1889 (r.note via src/gates.ts:240 REVIEW_SELF_REVIEW_NOTE)
  "notice.dispatch.reviewSelfNote": "[opencode-switchman] DOWNGRADED: no cross-family reviewer available — same-family self-review allowed; declare DOWNGRADED in the review conclusion",
  // src/index.ts:1889 (r.note via src/gates.ts:288 poolOverrideNote)
  "notice.dispatch.poolOverrideNote": "pool-config override: explicitly selected into this task pool (capability level floor waived)",
  // src/index.ts:1897
  "notice.dispatch.redirectDenied": "auto-redirect {agent} → {redirect} ({deny})",
  // src/index.ts:1910
  "notice.dispatch.gatesFailOpen": "six gates fail-open (allowed): {exc}",
  // src/index.ts:1934
  "notice.lang.prefsSaved": "project language preference saved ({rel}): conversation={conversation} comments={comments} docs={docs}",
  // src/index.ts:1937
  "notice.lang.gateWaived": "lang gate: marker question completed without a saved config — gate waived for session {sid}",
  // src/index.ts:1943
  "notice.search.scopeAskDone": "search clarify: scope ask completed — gate open for session {sid}",
  // src/index.ts:1956
  "notice.ctx.readBudgetCharge": "read budget charge +{charge} (tool {tool}, turn {turnUsed}/{turnBudget})",
  // src/index.ts:1970
  "notice.handover.autoTriggered": "auto-handover triggered (after {tool}, ~{wmTokens} exceeds the force-compaction watermark): full backup + queued compaction of the current session",
  // src/index.ts:1981
  "notice.handover.backupResult": "auto-handover backup {outcome}: {message}",
  // src/index.ts:1996 (variant 1 of 3)
  "notice.handover.compactionAccepted": "auto-handover compaction accepted: session.summarize returned (compaction ran on the session loop)",
  // src/index.ts:1996 (variant 2 of 3)
  "notice.handover.compactionRejected": "auto-handover compaction failed: session.summarize rejected (backup stands)",
  // src/index.ts:1996 (variant 3 of 3)
  "notice.handover.compactionNoModel": "auto-handover compaction failed: no session model recorded (chat.params never fired); backup stands",
  // src/index.ts:2008
  "notice.handover.failOpen": "auto-handover fail-open: {exc}",
  // src/index.ts:2114
  "notice.ctx.capTerminated": "subagent context cap: session {sid}{agentSuffix} reached ~{estTokens}k tokens (cap {capTokens}k) — tools denied, progress summary demanded, session terminated (no task_id resume)",
  // src/index.ts:2205
  "notice.provider.modelRetired": "model retired (consecutive 404s), removed from candidates: {provider}/{modelId}",
  // src/index.ts:2208
  "notice.breaker.agentTripped": "{agent} breaker tripped (600s): {reason}",
  // src/index.ts:2210
  "notice.breaker.accountingFailOpen": "failure accounting fail-open: {exc}",
  // src/lane.ts:410
  "notice.lane.scoringFallback": "scoring failed, fell back to rule-based ordering: {exc}",
  // src/lane.ts:494
  "notice.lane.backfillFailed": "backfill ranking failed (lane stays empty): {exc}",
  // src/matrix-manager.ts:196
  "notice.matrix.favoritesScanNoChange": "favorites/visible set scanned: activation unchanged (gen={generation}; no recompute, no re-probe)",
  // src/matrix-manager.ts:204
  "notice.matrix.invalidModels": "visible set/favorites contain invalid models (provider known but no such modelId, no shell generated): {modelList}",
  // src/matrix-manager.ts:217
  "notice.matrix.persistFailOpen": "activation matrix persist fail-open: {exc}",
  // src/matrix-manager.ts:222
  "notice.matrix.callbackFailOpen": "activation matrix callback fail-open: {exc}",
  // src/matrix-manager.ts:250
  "notice.matrix.configReadFailOpen": "config surface read fail-open (treated as empty): {exc}",
  // src/matrix-manager.ts:272
  "notice.matrix.watchError": "fs.watch({dir}) errored, falling back to mtime polling: {exc}",
  // src/matrix-manager.ts:277
  "notice.matrix.watchStartFailed": "fs.watch({dir}) failed to start, falling back to mtime polling: {exc}",
  // src/matrix-manager.ts:308
  "notice.matrix.recomputeFailOpen": "recompute fail-open: {exc}",
  // src/probe.ts:144
  "notice.probe.failOpen": "probe fail-open: {exc}",
  // src/probe.ts:162
  "notice.probe.incrementalFailOpen": "incremental probe fail-open: {exc}",
  // src/probe.ts:201
  "notice.probe.copilotPoolExhausted": "Copilot monthly pool exhausted (gateway second source of truth), trusted until reset_date",
  // src/probe.ts:207
  "notice.probe.resultsDiscarded": "probe results discarded (matrix generation changed {oldGen}->{newGen}; rescheduled by the new generation recompute)",
  // src/probe.ts:214
  "notice.probe.matrixRefreshed": "matrix refreshed: {comboCount} combos {okCount} ok (total {totalCount})",
  // src/probe.ts:233
  "notice.probe.schedulingFailOpen": "probe scheduling fail-open: {exc}",
  // src/scoring.ts:399
  "notice.scoring.decisionLogFailOpen": "decision log fail-open: {exc}",
  // src/selfupdate.ts:122
  "notice.selfupdate.checkFailOpen": "self-update check fail-open: {exc}",
  // src/selfupdate.ts:255
  "notice.selfupdate.upgradeAssetsFailOpen": "upgrade command assets fail-open: {exc}",
  // src/tmux.ts:149 (via log callback wired to appendStatusLog at src/index.ts:236)
  "notice.dispatch.mirrorDisabled": "tmux pane mirroring disabled (init failed): {message}",
  // src/tmux.ts:221
  "notice.dispatch.mirrorOpFailed": "tmux pane mirroring op failed (continuing): {message}",
  // src/tmux.ts:230
  "notice.dispatch.mirrorPaneFull": "tmux pane mirroring: column full ({slotCount} panes), queued ses_{sessionId} ({agent})",
  // src/tmux.ts:280
  "notice.dispatch.mirrorAllClosed": "tmux pane mirroring: all subagent panes closed, main pane restored",
  // src/tmux.ts:290
  "notice.dispatch.mirrorDisplayed": "tmux pane mirroring: ses_{sessionId} ({agent}) displayed in pane {pane}",
  // src/tmux.ts:303
  "notice.dispatch.mirrorReconciling": "tmux pane mirroring: detected closed pane(s), reconciling layout",
  // src/index.ts (setup gate)
  "notice.setup.gateDenied": "Setup required ({missing}) — run /switchman-setup (or /switchman-setup-chat); dispatch blocked until configured",

  // ---- sidebar (tui.tsx sidebar chrome) ----
  // [2026-09-19]-[sidebar.restartHintPattern (the old RESTART_HINT_RE regex) deliberately NOT a message key: the
  //  structured alert flag on status-log entries replaces regex highlighting; keys are translatable prose only]

  // src/tui.tsx:308
  "sidebar.peakTag": " ·peak",
  // src/tui.tsx:309
  "sidebar.staleTag": " ·stale",
  // src/tui.tsx:310
  "sidebar.observeOnlyTag": " ·observe-only",
  // src/tui.tsx:346
  "sidebar.updateAvailable": " → {updateVersion}",
  // src/tui.tsx:351
  "sidebar.restartNeeded": " [RESTART NEEDED]",
  // src/tui.tsx:358
  "sidebar.noneAvailable": "none available",
  // src/tui.tsx:391 (six-lane panel labels — display-only; runtime lane identifiers/config keys stay English)
  // [2026-09-19]-[sidebar lane names localized for display only: t() falls back to the raw lane identifier for
  //  unknown/custom lanes, so runtime LANE_ORDER, pool-config.json keys and the protocol are untouched]
  "sidebar.lane.economy": "economy",
  "sidebar.lane.mechanical": "mechanical",
  "sidebar.lane.main": "main",
  "sidebar.lane.hard": "hard",
  "sidebar.lane.vision": "vision",
  "sidebar.lane.review": "review",
  // src/tui.tsx:368
  "sidebar.noticeLabel": "notice",

  // ---- dialogs (tui.tsx: pool picker / pool models / rank / handover) ----

  // src/tui.tsx:426 (pool picker title)
  "dialog.pool.title": "Task pools (pick a task pool; Esc to exit)",
  // src/tui.tsx:428 (pool picker lane row)
  "dialog.pool.laneRow": "{pinMark}{lane}",
  // src/tui.tsx:431 (pool picker option description)
  "dialog.pool.manualSelection": "manual selection: {selCount}/{totalCount} models participating",
  // src/tui.tsx:432 (pool picker option description)
  "dialog.pool.notConfigured": "not configured: system default (all available models participate)",
  // src/tui.tsx:453 (pool models dialog, toggle persist)
  "dialog.pool.toggleWriteFailed": "write failed: {message}",
  // src/tui.tsx:458 (pool models dialog, toggle toast)
  "dialog.pool.modelToggled": "{verb} {modelKey} {direction} the {lane} pool (effective immediately, sidebar refreshes)",
  // src/tui.tsx:469 (pool models dialog, min-selection guard toast)
  "dialog.pool.keepOneModel": "Keep at least one participating model; use \"Clear config\" to restore the system default",
  // src/tui.tsx:482 (pool models dialog, bulk select-all persist)
  "dialog.pool.bulkWriteFailed": "write failed: {message}",
  // src/tui.tsx:485 (pool models dialog, bulk toast)
  "dialog.pool.allSelected": "{lane} pool: all models selected",
  // src/tui.tsx:490 (pool models dialog, clear-config toast)
  "dialog.pool.configCleared": "{lane} pool config cleared (system default candidate set restored)",
  // src/tui.tsx:499 (pool models dialog, uncheck-all toast)
  "dialog.pool.allUnchecked": "{lane} pool: all unchecked — check the models to keep; exiting with none checked keeps the previous selection",
  // src/tui.tsx:503 (pool models dialog option)
  "dialog.pool.back": "← Back to pool list",
  // src/tui.tsx:504 (pool models dialog option)
  "dialog.pool.selectAll": "☑ Select all",
  // src/tui.tsx:505 (pool models dialog option)
  "dialog.pool.uncheckAll": "☐ Uncheck all (then check the few to keep; exit with none checked keeps the old list)",
  // src/tui.tsx:506 (pool models dialog option)
  "dialog.pool.clearConfig": "✕ Clear config (system default: all available models participate)",
  // src/tui.tsx:508 (pool models dialog model row)
  "dialog.pool.modelRow": "{checkMark} {modelId}",
  // src/tui.tsx:510 (pool models dialog row description)
  "dialog.pool.rowMeta": "{tier}-tier{manualSuffix}",
  // src/tui.tsx:516 (pool models dialog title)
  "dialog.pool.selectionTitle": "{lane} pool selection ({selCount}/{rowCount} participating; select toggles, duplicates across pools allowed)",
  // src/tui.tsx:538 (rank universe-empty dialog option)
  "dialog.rank.openPoolSelection": "→ Open task-pool selection (pick the models each pool may use, then rank them)",
  // src/tui.tsx:539 (rank universe-empty dialog option)
  "dialog.rank.close": "✕ Close",
  // src/tui.tsx:543 (rank universe-empty dialog title)
  "dialog.rank.universeEmptyTitle": "Model ranking is disabled until task pools are configured — only models selected into task pools are rankable, so you never rank models you cannot dispatch",
  // src/tui.tsx:561 (rank move at edge toast)
  "dialog.rank.alreadyAtEdge": "{modelName} is already at the {edge} of the merged capability list",
  // src/tui.tsx:568 (rank move persist)
  "dialog.rank.moveWriteFailed": "write failed: {message}",
  // src/tui.tsx:573 (rank move/pin toast)
  "dialog.rank.pinnedOrMoved": "{verb} {modelName} to #{position} (manual score {tier}/{raw}, anchored between its neighbors; effective immediately, sidebar refreshes)",
  // src/tui.tsx:627 (rank picker title)
  "dialog.rank.title": "Model capability ranking — merged order (#1 strongest; scoped to the task-pool selection; manual entries interleave with base-score models; ctrl+up/ctrl+down move one spot; enter = per-model actions)",
  // src/tui.tsx:628 (rank picker placeholder)
  "dialog.rank.searchHint": "Search · alt+up/alt+down mirror ctrl+up/ctrl+down (also work)",
  // src/tui.tsx:630 (rank picker row)
  "dialog.rank.row": "#{rankPadded} {modelId}",
  // src/tui.tsx:632 (rank picker row description)
  "dialog.rank.rowMeta": "{tier}-tier · {scoreSource}{poolSuffix}",
  // src/tui.tsx:662 (rank actions, remove persist)
  "dialog.rank.removeWriteFailed": "write failed: {message}",
  // src/tui.tsx:665 (rank actions, remove toast)
  "dialog.rank.removed": "Removed {model} from the manual ranking (falls back to the base capability score, effective immediately, sidebar refreshes)",
  // src/tui.tsx:669 (rank actions option)
  "dialog.rank.pinTop": "▲ Pin to top (above every model)",
  // src/tui.tsx:670 (rank actions option)
  "dialog.rank.moveUp": "↑ Move up one (swaps with the model above; anchors a manual score between neighbors)",
  // src/tui.tsx:671 (rank actions option)
  "dialog.rank.moveDown": "↓ Move down one (swaps with the model below)",
  // src/tui.tsx:673 (rank actions option)
  "dialog.rank.remove": "✕ Remove from ranking (fall back to the base score)",
  // src/tui.tsx:675 (rank actions option)
  "dialog.rank.back": "← Back to ranking list",
  // src/tui.tsx:680 (rank actions title)
  "dialog.rank.detailTitle": "{model} ({rankState})",
  // src/tui.tsx (setup wizard)
  "dialog.setup.title": "switchman setup — task pools & capability ranking",
  "dialog.setup.intro": "Guided setup: pick models for each of the 6 task pools, then rank them (strongest first). Esc exits anytime; confirmed pools are saved immediately.",
  "dialog.setup.start": "Start (first unfinished step)",
  "dialog.setup.statePools": "pools configured: {count}/6",
  "dialog.setup.stateRank": "ranking: {state}",
  "dialog.setup.laneTitle": "Task pool {index}/6 — {lane} ({count} selected; Enter toggles, min 1)",
  "dialog.setup.laneRow": "{checkMark} {modelId}",
  "dialog.setup.selectAll": "[*] Select all",
  "dialog.setup.clearAll": "[ ] Clear all",
  "dialog.setup.confirmLane": "Confirm {lane} ({count} models) and continue",
  "dialog.setup.back": "Back",
  "dialog.setup.keepOne": "Keep at least one model in this pool",
  "dialog.setup.rankTitle": "Capability ranking — pick #{n} (strongest first, {remaining} models left)",
  "dialog.setup.rankFinish": "Finish ranking ({count} picked; the rest keep system base scores)",
  "dialog.setup.rankMinOne": "Rank at least one model before finishing",
  "dialog.setup.doneTitle": "Setup complete — active immediately (hot-reload)",
  "dialog.setup.donePools": "Pools: {summary}",
  "dialog.setup.doneRank": "Ranking: {order}",
  "dialog.setup.restartHint": "Restart opencode to register new provider(s): {providers}",
  // src/tui.tsx:734 (handover toast)
  "dialog.handover.noSession": "/handover: not in a session, nothing to back up",
  // src/tui.tsx:739 (handover toast)
  "dialog.handover.inProgress": "/handover: backing up the current session in full and compacting…",
  // src/tui.tsx:744 (handover toast)
  "dialog.handover.resultStay": "{resultMessage}; still in the original session, not switched",
  // src/tui.tsx:747 (handover toast)
  "dialog.handover.result": "/handover {resultMessage}",

  // ---- palette (command palette entries) ----

  // src/tui.tsx:770
  "palette.handover.title": "Back up and compact the current session",
  // src/tui.tsx:771
  "palette.handover.desc": "Full fork of the current session as a backup ([backup] title tag) plus compaction of the current session; no session switch (distinct from built-in /fork)",
  // src/tui.tsx:772 (palette category label)
  "palette.category.label": "switchman",
  // src/tui.tsx:779
  "palette.poolConfig.title": "Task pool selection",
  // src/tui.tsx:780
  "palette.poolConfig.desc": "Pick the participating models per task pool (economy/mechanical/main/hard/vision/review)",
  // src/tui.tsx:788
  "palette.modelRank.title": "Model capability ranking",
  // src/tui.tsx:789
  "palette.modelRank.desc": "Manual capability ranking (takes precedence over base scores; earlier = stronger)",
  // src/tui.tsx (setup wizard)
  "palette.setup.title": "Guided setup (pools + ranking)",
  "palette.setup.desc": "Wizard: multi-select models per task pool, then rank them — required before dispatch works",

  // ---- quota (quota-brief.json rows; banner.ts builders) ----

  // src/banner.ts:142 (POOL_LABEL)
  "quota.poolGlm": "GLM",
  // src/banner.ts:142 (POOL_LABEL)
  "quota.poolCopilot": "Copilot",
  // src/banner.ts:142 (POOL_LABEL)
  "quota.poolDeepSeek": "DeepSeek",
  // src/banner.ts:166
  "quota.queryingNoData": "querying/no data",
  // src/banner.ts:173
  "quota.resetLater": "→later",
  // src/banner.ts:173
  "quota.resetTime": "→{hhmm}",
  // src/banner.ts:173
  "quota.resetDate": "→{mmdd}",
  // src/banner.ts:173
  "quota.resetDateTime": "→{mmdd} {hhmm}",
  // src/banner.ts:174
  "quota.barPct": "{bar8} {pct}%",
  // src/banner.ts:177 (row label)
  "quota.row5h": "5h",
  // src/banner.ts:178 (row label)
  "quota.rowWeek": "week",
  // src/banner.ts:180 (row label)
  "quota.rowMcp": "MCP",
  // src/banner.ts:181
  "quota.noData": "no quota data",
  // src/banner.ts:187 (row label)
  "quota.rowRefresh": "refresh",
  // src/banner.ts:188 (row label)
  "quota.rowCredits": "credits",
  // src/banner.ts:188
  "quota.monthlyExhausted": "monthly pool exhausted",
  // src/banner.ts:193
  "quota.unlimited": "unlimited{usedSuffix}",
  // src/banner.ts:199
  "quota.exhaustedOverage": "exhausted·overage billing{usage}",
  // src/banner.ts:202
  "quota.barPctLeft": "{bar8} {pctTxt}% left{usage}",
  // src/banner.ts:207 (row label)
  "quota.rowBalance": "balance",
  // src/banner.ts:207
  "quota.exhausted": "exhausted",
  // src/banner.ts:209
  "quota.unknownPayg": "unknown (pay-as-you-go)",
  // src/banner.ts:213
  "quota.barBalance": "{bar8} ¥{balance}",
  // src/banner.ts:213
  "quota.balanceWarn": "(<¥{thr} warn)",

  // ---- cli (switchman-config / switchman-doctor) ----

  // src/config-cli.ts:67 (fmtRow, printed at :87)
  "cli.config.poolRow": "#{rankPadded} {checkMark} {modelId} ({tier}-tier{manualTag})",
  // src/config-cli.ts:73 (thrown, surfaced via console.error at :267)
  "cli.config.unknownPool": "unknown task pool: {lane} (six task pools: {laneList})",
  // src/config-cli.ts:81 (head, printed at :85/:90)
  "cli.config.poolHeader": "Task-pool selection (config file {poolConfigPath}; selection = the models joining that task pool; the same model may join multiple pools; unconfigured pools use the system default decision)",
  // src/config-cli.ts:86
  "cli.config.poolSection": "== {lane} == ({selection})",
  // src/config-cli.ts:93
  "cli.config.poolSectionBrief": "== {lane} =={detail}",
  // src/config-cli.ts:95
  "cli.config.poolListHint": "(view a single pool's full list with numbers: pool list <{laneList}>)",
  // src/config-cli.ts:105 (thrown, surfaced via console.error at :267)
  "cli.config.indexOutOfRange": "index out of range #{index} (list has {rowCount} items)",
  // src/config-cli.ts:110 (thrown, surfaced via console.error at :267)
  "cli.config.invalidModel": "invalid model name: {model}",
  // src/config-cli.ts:124 (thrown, surfaced via console.error at :267)
  "cli.config.noManifest": "no available model manifest (check provider connections and the superset manifest)",
  // src/config-cli.ts:129 (thrown, surfaced via console.error at :267)
  "cli.config.poolRequiresArg": "pool {sub} requires an index or model name",
  // src/config-cli.ts:138
  "cli.config.poolSelectionCleared": "{lane} task-pool selection cleared (back to the system default candidate set, effective immediately, sidebar refreshes in sync)",
  // src/config-cli.ts:139
  "cli.config.poolUpdated": "Updated {lane} task-pool selection ({modelCount} models participating, effective immediately, sidebar refreshes in sync)",
  // src/config-cli.ts:145
  "cli.config.poolConfigCleared": "Cleared the {lane} task-pool selection config (that pool returns to the system default candidate set, effective immediately, sidebar refreshes in sync)",
  // src/config-cli.ts:148 (thrown, surfaced via console.error at :267)
  "cli.config.unknownPoolSub": "unknown subcommand pool {sub} (list/add/remove/set/clear)",
  // src/config-cli.ts:186
  "cli.config.rankDisabledUntilPools": "Manual capability ranking (config file {capabilityRankPath}) is disabled until task pools are configured: only models selected into task pools are rankable.",
  // src/config-cli.ts:187
  "cli.config.rankHowTo": "Run /poolConfig (TUI dialog) or pool set <task-pool> <index|model...> here first, then rank only the models you actually use.",
  // src/config-cli.ts:190
  "cli.config.legacyHeader": "== Legacy manual entries (cleanup only; rank remove/clear still work, or select the models into a task pool to rank them) ==",
  // src/config-cli.ts:191
  "cli.config.legacyRow": "#{rankPadded} {modelKey}",
  // src/config-cli.ts:197
  "cli.config.rankHeader": "Model capability ranking (config file {capabilityRankPath}; scoped to the {universeCount} models selected into task pools via /poolConfig — one merged ordering, manual entries interleave with base-score models by effective score; higher up = stronger)",
  // src/config-cli.ts:198
  "cli.config.mergedHeader": "== Merged ordering ({manualCount} manual{manualSuffix}; CLI set/add order entries by the legacy ladder, TUI moves anchor scores between neighbors) ==",
  // src/config-cli.ts:201
  "cli.config.manualTag": "·manual{score}",
  // src/config-cli.ts:203
  "cli.config.notInPoolTag": "·not in any task pool",
  // src/config-cli.ts:204
  "cli.config.rankRow": "#{rankPadded} {modelId} ({tier}-tier{manualTag}{poolTag})",
  // src/config-cli.ts:210 (thrown, surfaced via console.error at :267)
  "cli.config.rankNoPools": "no task-pool selection yet — ranking follows the pool selection; run /poolConfig (or pool set) first",
  // src/config-cli.ts:212 (thrown, surfaced via console.error at :267)
  "cli.config.rankRequiresArg": "rank {sub} requires an index or model name",
  // src/config-cli.ts:237
  "cli.config.rankUpdated": "Updated the manual capability ranking ({modelCount} models, effective immediately, sidebar refreshes in sync)",
  // src/config-cli.ts:242
  "cli.config.rankCleared": "Cleared the manual capability ranking (everything falls back to the base capability score, effective immediately, sidebar refreshes in sync)",
  // src/config-cli.ts:245 (thrown, surfaced via console.error at :267)
  "cli.config.unknownRankSub": "unknown subcommand rank {sub} (list/set/add/remove/clear)",
  // src/config-cli.ts:254
  "cli.config.usage": "Usage: switchman-config <pool|rank> ...",
  // src/config-cli.ts:255
  "cli.config.usagePoolList": "  pool list [task-pool]             Pool selection overview (economy/mechanical/main/hard/vision/review; with a pool name = full list with indices)",
  // src/config-cli.ts:256
  "cli.config.usagePoolAdd": "  pool add <task-pool> <index|model...>    Check models joining that task pool",
  // src/config-cli.ts:257
  "cli.config.usagePoolRemove": "  pool remove <task-pool> <index|model...> Uncheck participation",
  // src/config-cli.ts:258
  "cli.config.usagePoolSet": "  pool set <task-pool> <index|model...>    Fully replace that pool's participation list (the same model may join multiple pools)",
  // src/config-cli.ts:259
  "cli.config.usagePoolClear": "  pool clear <task-pool>                Clear that pool's config (back to the system default candidate set)",
  // src/config-cli.ts:260
  "cli.config.usageRankList": "  rank list                      View the manual capability ranking (scoped to the task-pool selection; guides to /poolConfig when no pool is configured)",
  // src/config-cli.ts:261
  "cli.config.usageRankSet": "  rank set <index|model...>         Fully reorder (in the given order, #1 is strongest; only pool-selected models)",
  // src/config-cli.ts:262
  "cli.config.usageRankAdd": "  rank add <index|model...>         Append to the end of the ranking (pool-selected models only)",
  // src/config-cli.ts:263
  "cli.config.usageRankRemove": "  rank remove <index|model...>      Remove from the ranking",
  // src/config-cli.ts:264
  "cli.config.usageRankClear": "  rank clear                     Clear the ranking (fall back to the base capability score)",
  // src/config-cli.ts:267
  "cli.config.errorPrefix": "switchman-config: {message}",
  // src/doctor-cli.ts:5
  "cli.doctor.usage": "Usage: switchman-doctor checks the opencode-switchman config; the OPENCODE_CONFIG_DIR env var selects the config directory; exit codes 0=no issues, 1=warnings, 2=errors",
  // src/doctor.ts:56 (SWM060 hint)
  "cli.doctor.unknownModelsHint": "{unknownCount} models not matched by the known system (unknown group, ranked to the bottom by coefficient)",
  // src/doctor.ts:58 (SWM062 hint)
  "cli.doctor.approxModelsHint": "{approxCount} models classified approximately by prefix/family",
  // src/doctor.ts:72 (SWM044 hint)
  "cli.doctor.configFileHint": "opencode-switchman.jsonc",
  // src/doctor.ts:87
  "cli.doctor.noIssues": "opencode-switchman doctor: no issues found",
  // src/doctor.ts:89
  "cli.doctor.findingLine": "{level} {code}{pathPart}{hintPart}",
} as const
