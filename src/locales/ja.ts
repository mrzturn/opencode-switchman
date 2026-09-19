// [2026-09-19]-[Japanese message catalog: full-coverage translation of src/locales/en.ts;
//  key completeness and {param} parity are enforced by test/i18n.test.ts]
import type { MsgKey } from "../i18n"

export const ja: Partial<Record<MsgKey, string>> = {
  // ---- notices (status log; appendStatusLog) ----

  // src/breaker.ts:37
  "notice.breaker.realCallIsolated": "{agent}のreal-callを{mins}分間分離しました（{category}）：{reason}",
  // src/breaker.ts:48
  "notice.breaker.shellNotInjected": "shellがopencodeに注入されていません（分離なし）：{agent} {reason}",
  // src/breaker.ts:200
  "notice.breaker.failOpen": "breakerのfail-open：{exc}",
  // src/capability.ts:246
  "notice.capability.snapshotCorrupted": "同梱のcapability rankスナップショットが破損しています（スキップし、curated tableにフォールバックします）",
  // src/capability.ts:299
  "notice.capability.primarySourceFailed": "capability indexのprimary source AAに失敗しました（{exc}）{nextStep}",
  // src/capability.ts:311
  "notice.capability.backupSourceFailed": "capability indexのbackup source OpenRouterに失敗しました（{exc}）→ last-good／同梱のdefault rankを維持します",
  // src/capability.ts:316
  "notice.capability.parsedEmpty": "capability indexの解析結果が空でした（{source}）→ last-good／同梱のdefault rankを維持します",
  // src/capability.ts:333
  "notice.capability.refreshed": "capability indexを更新しました：{source}、{modelCount} models（version={version}）",
  // src/capability.ts:336
  "notice.capability.refreshFailOpen": "capability index更新のfail-open（last-good／同梱のdefault rankを維持します）：{exc}",
  // src/capability.ts:372
  "notice.capability.lmarenaDisagreement": "capabilityのLMArena cross-check：tier-orderとELO-orderの一致率は{rate}%のみ（{overlapCount} modelsが重複）——データソースに異常の可能性があります。手動レビューを推奨します",
  // src/capability.ts:375
  "notice.capability.lmarenaFailOpen": "capabilityのLMArena cross-checkのfail-open（スキップしました）：{exc}",
  // src/catalog.ts:153
  "notice.catalog.unavailableNoCache": "models.dev catalogが利用不可でcacheもありません（fail-open degradation）：{exc}",
  // src/copilot-thinking.ts:71
  "notice.copilot.shapeCacheRefreshed": "Copilot thinking-parameter shape cacheを更新しました：{modelCount} models",
  // src/copilot-thinking.ts:73
  "notice.copilot.shapeRefreshFailOpen": "Copilot thinking-parameter shape更新のfail-open：{exc}",
  // src/cost.ts:44
  "notice.cost.refreshFailed": "cost snapshotの更新に失敗しました（古いデータを維持します）：{exc}",
  // src/dispatch-mode.ts:60 (log callback defaults to appendStatusLog)
  "notice.lang.settingsInvalidJson": "[opencode-switchman] {workspaceDirname}/{langSettingsFile}は有効なJSONではありません——無視しました（lang設定はAGENTS.md markerにフォールバックします；\"dispatch\":\"off\"は適用されません）",
  // src/dispatch-mode.ts:66 (log callback defaults to appendStatusLog)
  "notice.lang.dispatchNotOff": "[opencode-switchman] {workspaceDirname}/{langSettingsFile}に\"dispatch\"がありますが、正確に\"off\"ではありません（取得値：{rawValue}）——無視し、fleet動作を継続します",
  // src/index.ts:262
  "notice.ctx.paused": "session {sid}のctx controlを一時停止しました（/ctx-pause）：read gate＋self-read budget＋auto-handoverを停止します。計測は継続します",
  // src/index.ts:264
  "notice.ctx.resumed": "session {sid}のctx controlを再開しました（/ctx-resume）：read gate＋auto-handoverが再び有効です",
  // src/index.ts:467
  "notice.workspace.created": "artifact workspaceを作成しました：{rel}",
  // src/index.ts:468
  "notice.workspace.renamed": "artifact workspaceの名前を変更しました：{oldRel} → {rel}",
  // src/index.ts:542
  "notice.dispatch.mirrorResumeReuse": "tmux pane mirroring：resume dispatch ses_{taskId}（{shellName}）——task_idを再利用し、paneを直接開きました（session.createdは発火しません）",
  // src/index.ts:546
  "notice.dispatch.mirrorResumeLookupFailed": "tmux pane mirroring：resume dispatch ses_{taskId}（{shellName}）——session lookupに失敗したため、fail-open paneを開きました",
  // src/index.ts:574
  "notice.capability.selectionChanged": "capability rank／task-pool selectionが変更されました：bannerとsidebarを即時更新します",
  // src/index.ts:589
  "notice.capability.overrideWatchError": "fs.watch({dir})のoverride-config監視エラー（mtime pollingにフォールバックします）：{exc}",
  // src/index.ts:647
  "notice.matrix.configSurfaceFailOpen": "config surface読み取りのfail-open：{exc}",
  // src/index.ts:675
  "notice.matrix.floorFreeModels": "floor＝{floorCount}のOpenCode Zen free models（catalog {catalogStatus}）",
  // src/index.ts:676
  "notice.matrix.floorFallback": "floorはstatic manifestにフォールバックしました（catalog {catalogStatus}、0 free models）",
  // src/index.ts:680
  "notice.matrix.invalidModelsUnknownProvider": "visible set／favoritesに不明なproviderの無効なmodelが含まれています（provider未接続のため無視し、shellは構築しません）：{modelList}",
  // src/index.ts:778
  "notice.provider.probeAttemptSucceeded": "provider.listのattempt {attempt}が成功しました（直前の{prevAttempts}回はnot ready）",
  // src/index.ts:783
  "notice.provider.probeAttemptBackoff": "provider.listのattempt {attempt}はnot readyのため、backoffします：{exc}",
  // src/index.ts:789
  "notice.provider.unavailableCfgFallback": "provider.listが利用不可です（{attemptCount}回のattempt後、{keyCount}件のcfg.provider keyにフォールバックしました）：{exc}",
  // src/index.ts:814 (alert)
  "notice.provider.probeNewProvider": "provider.list background probe：新しいproviderが接続されました（{providers}）——shell登録を完了するにはopencodeを再起動してください",
  // src/index.ts:832 (alert)
  "notice.provider.probeModelDrift": "provider.list background probe：model listがdriftしました（{drift}）——superset manifestを再構築し、/modelRank・/poolConfig listを更新しました{restartHint}",
  // src/index.ts:834
  "notice.provider.probeRebuildFailed": "provider.list background probe：supersetの再構築に失敗しました（以前のmanifestを維持します）：{exc}",
  // src/index.ts:886
  "notice.probe.warmupFailOpen": "warmupのfail-open：{exc}",
  // src/index.ts:900
  "notice.skills.synced": "skillを同期しました：{installedCount}件インストール、{updatedCount}件更新、{removedCount}件削除（{skillNames}）",
  // src/index.ts:903
  "notice.skills.syncFailOpen": "skill同期のfail-open：{exc}",
  // src/index.ts:1145
  "notice.banner.failOpen": "bannerのfail-open：{exc}",
  // src/index.ts:1241
  "notice.ctx.readBudgetContinuation": "read budget継続完了（file {fileName}、{offset}から+{granted} lines、turn {turnUsed}/{turnBudget}）",
  // src/index.ts:1251
  "notice.ctx.readBudgetGateCap": "read budget gate cap（tool read、file {fileName}、推定約{totalTokens}→limit {suggestedLimit}、turn {turnUsed}/{turnBudget}）",
  // src/index.ts:1277 (template built at src/index.ts:1259 as denyLog)
  "notice.ctx.readBudgetGate": "read budget gate {action}（tool {tool}、推定約{totalTokens}{contRem}、C約{wmTokens}、T_est約{turnsToHard}、turn {turnUsed}/{turnBudget}）",
  // src/index.ts:1281
  "notice.ctx.readBudgetGateFailOpen": "read budget gateのfail-open（許可しました）：{exc}",
  // src/index.ts:1306
  "notice.image.readGuardDenied": "image read guard：model {modelKey}にはvision inputがありません。{fileName}の読み取りを拒否しました（session {sid}）",
  // src/index.ts:1310
  "notice.image.readGuardFailOpen": "image read guardのfail-open（許可しました）：{exc}",
  // src/index.ts:1358
  "notice.doctor.summary": "doctorが{errorCount}件のerror／{warnCount}件のwarnを検出しました。/switchman-doctorで確認してください",
  // src/index.ts:1393
  "notice.injection.legacyStaticMatrix": "{shellCount}件のmodel shellを注入しました（agents、legacy static matrix）",
  // src/index.ts:1412
  "notice.provider.cacheUsed": "provider.listはcross-restart cacheを使用しています（{providerCount} providers、{cachedAt}にcache）。追加分をbackgroundで検証中です",
  // src/index.ts:1419
  "notice.provider.cacheStale": "provider.list cacheが古くなっています（{cachedAt}にcache）。superset構築前にlive probeを実行します",
  // src/index.ts:1469
  "notice.matrix.recomputed": "activation matrixを再計算しました（gen={generation}、active shell {activeShellCount}件、probe {source}×{targetCount}）",
  // src/index.ts:1474
  "notice.injection.shellCount": "{shellCount}件のshellを注入しました（mode={runMode}、injection surface={injectionMode}＝curation後に{fullSupersetCount}→{faceCount}、conflict {conflictCount}件；activation gating有効）",
  // src/index.ts:1479
  "notice.injection.configHookFailOpen": "config hookのfail-open：{exc}",
  // src/index.ts:1541
  "notice.lang.askLocale": "lang ask locale={locale}（{source}）",
  // src/index.ts:1604
  "notice.banner.rulesFailOpen": "rules／bannerのfail-open：{exc}",
  // src/index.ts:1677
  "notice.relay.persisted": "image relay：model {modelKey}にはvision inputがありません。{written}件のimageをdiskに保存しました（session履歴全体で{relayed}件のimage partをrelay、session {sid}）",
  // src/index.ts:1679
  "notice.relay.failOpen": "image relayのfail-open（passthroughしました）：{exc}",
  // src/index.ts:1694
  "notice.ctx.capToolDenied": "subagent context cap：終了済みsession {sid}ではtool '{tool}'を拒否しました",
  // src/index.ts:1701
  "notice.ctx.capResumeDenied": "subagent context cap：終了済みsession ses_{taskId}のresumeを拒否しました（permanent）",
  // src/index.ts:1727
  "notice.lang.gateDenied": "lang gate：未設定projectのsession {sid}ではtool '{tool}'を拒否しました",
  // src/index.ts:1751
  "notice.search.clarifyFailOpen": "search clarify gate：askなしで{maxDenies}回拒否後のfail-open——session {sid}のgateを開きました",
  // src/index.ts:1754
  "notice.search.clarifyDenied": "search clarify gate：tool '{tool}'を拒否しました（broad searchのためask-first、session {sid}、{denyCount}/{maxDenies}）",
  // src/index.ts:1774
  "notice.dispatch.offUngoverned": "dispatch off：task callをungovernedで許可しました（subagent_type='{subagentType}'）",
  // src/index.ts:1853
  "notice.dispatch.redirectUninjected": "auto-redirect {agent} → {candidate}（未注入shellのため、chain-head候補にredirectしました）",
  // src/index.ts:1874
  "notice.dispatch.redirectBuiltinBlocked": "auto-redirect {agent} → {candidate}（built-in agentはブロックされています）",
  // src/index.ts:1883 (via src/gates.ts:331 noteUnknownAgent)
  "notice.dispatch.unknownAgentAllowed": "[opencode-switchman] 不明なsubagent_type='{agent}'：許可しました（shell listにありません。built-in agentはroutingの管理対象外です）",
  // src/index.ts:1889 (r.note via src/gates.ts:156)
  "notice.dispatch.registryDisabledNote": "[opencode-switchman] {agent}はregistry=disabledですがmatrix status={matrixStatus}（downではありません）：fail-openです。次回probe更新後に自動修正されます",
  // src/index.ts:1889 (r.note via src/gates.ts:175)
  "notice.dispatch.matrixStatusNote": "[opencode-switchman] {agent}のmatrix status={matrixStatus}（downではありません）：ブロックしません。次roundのprobeで更新されます",
  // src/index.ts:1889 (r.note via src/gates.ts:63 ROUTE_META_SYNTH_NOTE)
  "notice.dispatch.routeMetaSynthNote": "[opencode-switchman] ROUTE_METAが欠落／不正です——laneから合成しました。review cross-family／source=user semanticsを有効にするには宣言してください",
  // src/index.ts:1889 (r.note via src/gates.ts:240 REVIEW_SELF_REVIEW_NOTE)
  "notice.dispatch.reviewSelfNote": "[opencode-switchman] DOWNGRADED：利用可能なcross-family reviewerがありません——same-family self-reviewを許可します。review結論でDOWNGRADEDを宣言してください",
  // src/index.ts:1889 (r.note via src/gates.ts:288 poolOverrideNote)
  "notice.dispatch.poolOverrideNote": "pool-config override：このtask poolに明示的に選択されました（capability level floorを免除します）",
  // src/index.ts:1897
  "notice.dispatch.redirectDenied": "auto-redirect {agent} → {redirect}（{deny}）",
  // src/index.ts:1910
  "notice.dispatch.gatesFailOpen": "six gatesのfail-open（許可しました）：{exc}",
  // src/index.ts:1934
  "notice.lang.prefsSaved": "project言語設定を保存しました（{rel}）：conversation={conversation} comments={comments} docs={docs}",
  // src/index.ts:1937
  "notice.lang.gateWaived": "lang gate：marker質問は完了しましたが設定が保存されなかったため、session {sid}のgateを免除しました",
  // src/index.ts:1943
  "notice.search.scopeAskDone": "search clarify：scope askが完了しました——session {sid}のgateを開きました",
  // src/index.ts:1956
  "notice.ctx.readBudgetCharge": "read budget charge +{charge}（tool {tool}、turn {turnUsed}/{turnBudget}）",
  // src/index.ts:1970
  "notice.handover.autoTriggered": "auto-handoverをtriggerしました（{tool}実行後、約{wmTokens}がforce-compaction watermarkを超過）：現在のsessionのfull backup＋compactionをqueueしました",
  // src/index.ts:1981
  "notice.handover.backupResult": "auto-handover backup {outcome}：{message}",
  // src/index.ts:1996 (variant 1 of 3)
  "notice.handover.compactionAccepted": "auto-handover compactionを受理しました：session.summarizeが戻りました（session loop上でcompactionを実行しました）",
  // src/index.ts:1996 (variant 2 of 3)
  "notice.handover.compactionRejected": "auto-handover compactionに失敗しました：session.summarizeが拒否されました（backupは維持されます）",
  // src/index.ts:1996 (variant 3 of 3)
  "notice.handover.compactionNoModel": "auto-handover compactionに失敗しました：session modelが記録されていません（chat.params未発火）。backupは維持されます",
  // src/index.ts:2008
  "notice.handover.failOpen": "auto-handoverのfail-open：{exc}",
  // src/index.ts:2114
  "notice.ctx.capTerminated": "subagent context cap：session {sid}{agentSuffix}が約{estTokens}k tokensに到達しました（cap {capTokens}k）——toolを拒否し、進捗サマリーを要求してsessionを終了しました（task_id resume不可）",
  // src/index.ts:2205
  "notice.provider.modelRetired": "modelをretireしました（404連続）。候補から除外します：{provider}/{modelId}",
  // src/index.ts:2208
  "notice.breaker.agentTripped": "{agent}のbreakerがtrippedしました（600s）：{reason}",
  // src/index.ts:2210
  "notice.breaker.accountingFailOpen": "failure accountingのfail-open：{exc}",
  // src/lane.ts:410
  "notice.lane.scoringFallback": "scoringに失敗し、rule-based orderingにフォールバックしました：{exc}",
  // src/lane.ts:494
  "notice.lane.backfillFailed": "backfill rankingに失敗しました（laneはemptyのままです）：{exc}",
  // src/matrix-manager.ts:196
  "notice.matrix.favoritesScanNoChange": "favorites／visible setをscanしました：activationに変更ありません（gen={generation}。再計算・再probeなし）",
  // src/matrix-manager.ts:204
  "notice.matrix.invalidModels": "visible set／favoritesに無効なmodelが含まれています（providerは既知ですがmodelIdが存在しないため、shellは生成しません）：{modelList}",
  // src/matrix-manager.ts:217
  "notice.matrix.persistFailOpen": "activation matrix保存のfail-open：{exc}",
  // src/matrix-manager.ts:222
  "notice.matrix.callbackFailOpen": "activation matrix callbackのfail-open：{exc}",
  // src/matrix-manager.ts:250
  "notice.matrix.configReadFailOpen": "config surface読み取りのfail-open（emptyとして扱います）：{exc}",
  // src/matrix-manager.ts:272
  "notice.matrix.watchError": "fs.watch({dir})でエラーが発生し、mtime pollingにフォールバックします：{exc}",
  // src/matrix-manager.ts:277
  "notice.matrix.watchStartFailed": "fs.watch({dir})の開始に失敗し、mtime pollingにフォールバックします：{exc}",
  // src/matrix-manager.ts:308
  "notice.matrix.recomputeFailOpen": "recomputeのfail-open：{exc}",
  // src/probe.ts:144
  "notice.probe.failOpen": "probeのfail-open：{exc}",
  // src/probe.ts:162
  "notice.probe.incrementalFailOpen": "incremental probeのfail-open：{exc}",
  // src/probe.ts:201
  "notice.probe.copilotPoolExhausted": "Copilot monthly poolが枯渇しました（gateway second source of truth）。reset_dateまでtrustedです",
  // src/probe.ts:207
  "notice.probe.resultsDiscarded": "probe結果を破棄しました（matrix generationが{oldGen}→{newGen}に変更。新generationの再計算で再スケジュールします）",
  // src/probe.ts:214
  "notice.probe.matrixRefreshed": "matrixを更新しました：{comboCount} combos中{okCount} ok（合計{totalCount}）",
  // src/probe.ts:233
  "notice.probe.schedulingFailOpen": "probe schedulingのfail-open：{exc}",
  // src/scoring.ts:399
  "notice.scoring.decisionLogFailOpen": "decision logのfail-open：{exc}",
  // src/selfupdate.ts:122
  "notice.selfupdate.checkFailOpen": "self-update checkのfail-open：{exc}",
  // src/selfupdate.ts:255
  "notice.selfupdate.upgradeAssetsFailOpen": "upgrade command assetsのfail-open：{exc}",
  // src/tmux.ts:149 (via log callback wired to appendStatusLog at src/index.ts:236)
  "notice.dispatch.mirrorDisabled": "tmux pane mirroringを無効化しました（init失敗）：{message}",
  // src/tmux.ts:221
  "notice.dispatch.mirrorOpFailed": "tmux pane mirroring opに失敗しました（継続します）：{message}",
  // src/tmux.ts:230
  "notice.dispatch.mirrorPaneFull": "tmux pane mirroring：columnがfullです（{slotCount} panes）。ses_{sessionId}（{agent}）をqueueしました",
  // src/tmux.ts:280
  "notice.dispatch.mirrorAllClosed": "tmux pane mirroring：すべてのsubagent paneを閉じ、main paneを復元しました",
  // src/tmux.ts:290
  "notice.dispatch.mirrorDisplayed": "tmux pane mirroring：ses_{sessionId}（{agent}）をpane {pane}に表示しました",
  // src/tmux.ts:303
  "notice.dispatch.mirrorReconciling": "tmux pane mirroring：閉じられたpaneを検出し、layoutを調整中です",

  // ---- sidebar (tui.tsx sidebar chrome) ----

  // src/tui.tsx:308
  "sidebar.peakTag": " ·ピーク",
  // src/tui.tsx:309
  "sidebar.staleTag": " ·古い",
  // src/tui.tsx:310
  "sidebar.observeOnlyTag": " ·参照のみ",
  // src/tui.tsx:346
  "sidebar.updateAvailable": " → {updateVersion}",
  // src/tui.tsx:351
  "sidebar.restartNeeded": " [要再起動]",
  // src/tui.tsx:358
  "sidebar.noneAvailable": "なし",
  // src/tui.tsx:391 (six-lane panel labels — display-only; runtime lane identifiers/config keys stay English)
  "sidebar.lane.economy": "エコノミー",
  "sidebar.lane.mechanical": "機械",
  "sidebar.lane.main": "メイン",
  "sidebar.lane.hard": "ハード",
  "sidebar.lane.vision": "ビジョン",
  "sidebar.lane.review": "レビュー",
  // src/tui.tsx:368
  "sidebar.noticeLabel": "通知",

  // ---- dialogs (tui.tsx: pool picker / pool models / rank / handover) ----

  // src/tui.tsx:426 (pool picker title)
  "dialog.pool.title": "Task pool（task poolを選択；Escで終了）",
  // src/tui.tsx:428 (pool picker lane row)
  "dialog.pool.laneRow": "{pinMark}{lane}",
  // src/tui.tsx:430 (pool picker option description)
  "dialog.pool.manualSelection": "manual selection：{selCount}/{totalCount} modelsが参加中",
  // src/tui.tsx:432 (pool picker option description)
  "dialog.pool.notConfigured": "未設定：system default（利用可能な全modelが参加）",
  // src/tui.tsx:453 (pool models dialog, toggle persist)
  "dialog.pool.toggleWriteFailed": "書き込みに失敗しました：{message}",
  // src/tui.tsx:458 (pool models dialog, toggle toast)
  "dialog.pool.modelToggled": "{lane} pool：{modelKey}を{verb}{direction}しました（即時反映、sidebar更新）",
  // src/tui.tsx:469 (pool models dialog, min-selection guard toast)
  "dialog.pool.keepOneModel": "参加中のmodelを1件以上残してください。system defaultに戻すには「設定をクリア」を使います",
  // src/tui.tsx:482 (pool models dialog, bulk select-all persist)
  "dialog.pool.bulkWriteFailed": "書き込みに失敗しました：{message}",
  // src/tui.tsx:485 (pool models dialog, bulk toast)
  "dialog.pool.allSelected": "{lane} pool：全modelを選択しました",
  // src/tui.tsx:490 (pool models dialog, clear-config toast)
  "dialog.pool.configCleared": "{lane} poolの設定をクリアしました（system default候補セットに戻しました）",
  // src/tui.tsx:499 (pool models dialog, uncheck-all toast)
  "dialog.pool.allUnchecked": "{lane} pool：すべて外しました——残すmodelをcheckしてください。何もcheckせず終了すると以前の選択を維持します",
  // src/tui.tsx:503 (pool models dialog option)
  "dialog.pool.back": "← pool listに戻る",
  // src/tui.tsx:504 (pool models dialog option)
  "dialog.pool.selectAll": "☑ すべて選択",
  // src/tui.tsx:505 (pool models dialog option)
  "dialog.pool.uncheckAll": "☐ すべて外す（残すmodelだけcheck；何もcheckせず終了すると以前のlistを維持）",
  // src/tui.tsx:506 (pool models dialog option)
  "dialog.pool.clearConfig": "✕ 設定をクリア（system default：利用可能な全modelが参加）",
  // src/tui.tsx:508 (pool models dialog model row)
  "dialog.pool.modelRow": "{checkMark} {modelId}",
  // src/tui.tsx:510 (pool models dialog row description)
  "dialog.pool.rowMeta": "{tier}-tier{manualSuffix}",
  // src/tui.tsx:516 (pool models dialog title)
  "dialog.pool.selectionTitle": "{lane} pool selection（{selCount}/{rowCount}が参加中；選択でtoggle、pool間の重複可）",
  // src/tui.tsx:538 (rank universe-empty dialog option)
  "dialog.rank.openPoolSelection": "→ task-pool selectionを開く（各poolが使うmodelを選んでからrankします）",
  // src/tui.tsx:539 (rank universe-empty dialog option)
  "dialog.rank.close": "✕ 閉じる",
  // src/tui.tsx:543 (rank universe-empty dialog title)
  "dialog.rank.universeEmptyTitle": "task poolを設定するまでmodel rankingは無効です——task poolに選択されたmodelのみrank可能なので、dispatchできないmodelをrankすることはありません",
  // src/tui.tsx:561 (rank move at edge toast)
  "dialog.rank.alreadyAtEdge": "{modelName}はmerged capability listの{edge}にあります",
  // src/tui.tsx:568 (rank move persist)
  "dialog.rank.moveWriteFailed": "書き込みに失敗しました：{message}",
  // src/tui.tsx:573 (rank move/pin toast)
  "dialog.rank.pinnedOrMoved": "{modelName}を{verb}して#{position}に移動しました（manual score {tier}/{raw}、隣接model間にanchor；即時反映、sidebar更新）",
  // src/tui.tsx:627 (rank picker title)
  "dialog.rank.title": "Model capability ranking——merged order（#1が最強；task-pool selectionにscoped；manual entryはbase-score modelとinterleave；ctrl+up／ctrl+downで1つ移動；enterでper-model操作）",
  // src/tui.tsx:628 (rank picker placeholder)
  "dialog.rank.searchHint": "Search · alt+up／alt+downはctrl+up／ctrl+downと同等（こちらも使用可）",
  // src/tui.tsx:630 (rank picker row)
  "dialog.rank.row": "#{rankPadded} {modelId}",
  // src/tui.tsx:632 (rank picker row description)
  "dialog.rank.rowMeta": "{tier}-tier · {scoreSource}{poolSuffix}",
  // src/tui.tsx:662 (rank actions, remove persist)
  "dialog.rank.removeWriteFailed": "書き込みに失敗しました：{message}",
  // src/tui.tsx:665 (rank actions, remove toast)
  "dialog.rank.removed": "manual rankingから{model}を削除しました（base capability scoreにフォールバックします。即時反映、sidebar更新）",
  // src/tui.tsx:669 (rank actions option)
  "dialog.rank.pinTop": "▲ 先頭に固定（全modelの上）",
  // src/tui.tsx:670 (rank actions option)
  "dialog.rank.moveUp": "↑ 1つ上に移動（上のmodelと入替；隣接間にmanual scoreをanchor）",
  // src/tui.tsx:671 (rank actions option)
  "dialog.rank.moveDown": "↓ 1つ下に移動（下のmodelと入替）",
  // src/tui.tsx:673 (rank actions option)
  "dialog.rank.remove": "✕ rankingから削除（base scoreにフォールバック）",
  // src/tui.tsx:675 (rank actions option)
  "dialog.rank.back": "← ranking listに戻る",
  // src/tui.tsx:680 (rank actions title)
  "dialog.rank.detailTitle": "{model}（{rankState}）",
  // src/tui.tsx:734 (handover toast)
  "dialog.handover.noSession": "/handover：session外のため、backup対象がありません",
  // src/tui.tsx:739 (handover toast)
  "dialog.handover.inProgress": "/handover：現在のsessionをfull backup＋compact中…",
  // src/tui.tsx:744 (handover toast)
  "dialog.handover.resultStay": "{resultMessage}。元のsessionに留まっており、切替はしていません",
  // src/tui.tsx:747 (handover toast)
  "dialog.handover.result": "/handover {resultMessage}",

  // ---- palette (command palette entries) ----

  // src/tui.tsx:770
  "palette.handover.title": "現在のsessionをbackup＋compactする",
  // src/tui.tsx:771
  "palette.handover.desc": "現在のsessionのfull forkをbackup（[backup] title tag）として作成し、現在のsessionをcompactします。session切替なし（built-in /forkとは異なります）",
  // src/tui.tsx:772 (palette category label)
  "palette.category.label": "switchman",
  // src/tui.tsx:779
  "palette.poolConfig.title": "Task pool selection",
  // src/tui.tsx:780
  "palette.poolConfig.desc": "task poolごとに参加modelを選択します（economy／mechanical／main／hard／vision／review）",
  // src/tui.tsx:788
  "palette.modelRank.title": "Model capability ranking",
  // src/tui.tsx:789
  "palette.modelRank.desc": "Manual capability ranking（base scoreより優先；上位ほど強力）",

  // ---- quota (quota-brief.json rows; banner.ts builders) ----

  // src/banner.ts:142 (POOL_LABEL)
  "quota.poolGlm": "GLM",
  // src/banner.ts:142 (POOL_LABEL)
  "quota.poolCopilot": "Copilot",
  // src/banner.ts:142 (POOL_LABEL)
  "quota.poolDeepSeek": "DeepSeek",
  // src/banner.ts:166
  "quota.queryingNoData": "取得中／データなし",
  // src/banner.ts:173
  "quota.resetLater": "→後",
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
  "quota.rowWeek": "週",
  // src/banner.ts:180 (row label)
  "quota.rowMcp": "MCP",
  // src/banner.ts:181
  "quota.noData": "quotaデータなし",
  // src/banner.ts:187 (row label)
  "quota.rowRefresh": "更新",
  // src/banner.ts:188 (row label)
  "quota.rowCredits": "クレジット",
  // src/banner.ts:188
  "quota.monthlyExhausted": "monthly pool枯渇",
  // src/banner.ts:193
  "quota.unlimited": "無制限{usedSuffix}",
  // src/banner.ts:199
  "quota.exhaustedOverage": "枯渇·overage課金{usage}",
  // src/banner.ts:202
  "quota.barPctLeft": "{bar8} 残り{pctTxt}%{usage}",
  // src/banner.ts:207 (row label)
  "quota.rowBalance": "残高",
  // src/banner.ts:207
  "quota.exhausted": "枯渇",
  // src/banner.ts:209
  "quota.unknownPayg": "不明（pay-as-you-go）",
  // src/banner.ts:213
  "quota.barBalance": "{bar8} ¥{balance}",
  // src/banner.ts:213
  "quota.balanceWarn": "(<¥{thr} 警告)",

  // ---- cli (switchman-config / switchman-doctor) ----

  // src/config-cli.ts:67 (fmtRow, printed at :87)
  "cli.config.poolRow": "#{rankPadded} {checkMark} {modelId} ({tier}-tier{manualTag})",
  // src/config-cli.ts:73 (thrown, surfaced via console.error at :267)
  "cli.config.unknownPool": "不明なtask pool：{lane}（6 task pools：{laneList}）",
  // src/config-cli.ts:81 (head, printed at :85/:90)
  "cli.config.poolHeader": "Task-pool selection（config file {poolConfigPath}；selection＝そのtask poolに参加するmodel；同一modelは複数poolに参加可；未設定poolはsystem default決定を使用）",
  // src/config-cli.ts:86
  "cli.config.poolSection": "== {lane} ==（{selection}）",
  // src/config-cli.ts:93
  "cli.config.poolSectionBrief": "== {lane} =={detail}",
  // src/config-cli.ts:95
  "cli.config.poolListHint": "（単一poolの番号付きfull listを表示：pool list <{laneList}>）",
  // src/config-cli.ts:105 (thrown, surfaced via console.error at :267)
  "cli.config.indexOutOfRange": "indexが範囲外です #{index}（listは{rowCount}件）",
  // src/config-cli.ts:110 (thrown, surfaced via console.error at :267)
  "cli.config.invalidModel": "無効なmodel名：{model}",
  // src/config-cli.ts:124 (thrown, surfaced via console.error at :267)
  "cli.config.noManifest": "利用可能なmodel manifestがありません（provider接続とsuperset manifestを確認してください）",
  // src/config-cli.ts:129 (thrown, surfaced via console.error at :267)
  "cli.config.poolRequiresArg": "pool {sub}にはindexまたはmodel名が必要です",
  // src/config-cli.ts:138
  "cli.config.poolSelectionCleared": "{lane} task-pool selectionをクリアしました（system default候補セットに戻ります。即時反映、sidebarも同期更新）",
  // src/config-cli.ts:139
  "cli.config.poolUpdated": "{lane} task-pool selectionを更新しました（{modelCount} modelsが参加中。即時反映、sidebarも同期更新）",
  // src/config-cli.ts:145
  "cli.config.poolConfigCleared": "{lane} task-pool selection設定をクリアしました（そのpoolはsystem default候補セットに戻ります。即時反映、sidebarも同期更新）",
  // src/config-cli.ts:148 (thrown, surfaced via console.error at :267)
  "cli.config.unknownPoolSub": "不明なsubcommand pool {sub}（list／add／remove／set／clear）",
  // src/config-cli.ts:186
  "cli.config.rankDisabledUntilPools": "Manual capability ranking（config file {capabilityRankPath}）はtask pool設定まで無効です：task poolに選択されたmodelのみrank可能です。",
  // src/config-cli.ts:187
  "cli.config.rankHowTo": "先に/poolConfig（TUI dialog）またはpool set <task-pool> <index|model...>を実行し、実際に使うmodelのみrankしてください。",
  // src/config-cli.ts:190
  "cli.config.legacyHeader": "== Legacy manual entry（cleanup専用；rank remove／clearは有効、またはtask poolに選択してrankします）==",
  // src/config-cli.ts:191
  "cli.config.legacyRow": "#{rankPadded} {modelKey}",
  // src/config-cli.ts:197
  "cli.config.rankHeader": "Model capability ranking（config file {capabilityRankPath}；/poolConfigでtask poolに選択された{universeCount} modelsにscoped——1つのmerged ordering、manual entryはeffective score順でbase-score modelとinterleave；上位ほど強力）",
  // src/config-cli.ts:198
  "cli.config.mergedHeader": "== Merged ordering（{manualCount} manual{manualSuffix}；CLI set／addはlegacy ladder順にentry、TUI moveは隣接間にscoreをanchor）==",
  // src/config-cli.ts:201
  "cli.config.manualTag": "·manual{score}",
  // src/config-cli.ts:203
  "cli.config.notInPoolTag": "·task pool不参加",
  // src/config-cli.ts:204
  "cli.config.rankRow": "#{rankPadded} {modelId} ({tier}-tier{manualTag}{poolTag})",
  // src/config-cli.ts:210 (thrown, surfaced via console.error at :267)
  "cli.config.rankNoPools": "task-pool selectionが未設定です——rankingはpool selectionに従います。先に/poolConfig（またはpool set）を実行してください",
  // src/config-cli.ts:212 (thrown, surfaced via console.error at :267)
  "cli.config.rankRequiresArg": "rank {sub}にはindexまたはmodel名が必要です",
  // src/config-cli.ts:237
  "cli.config.rankUpdated": "manual capability rankingを更新しました（{modelCount} models。即時反映、sidebarも同期更新）",
  // src/config-cli.ts:242
  "cli.config.rankCleared": "manual capability rankingをクリアしました（すべてbase capability scoreにフォールバックします。即時反映、sidebarも同期更新）",
  // src/config-cli.ts:245 (thrown, surfaced via console.error at :267)
  "cli.config.unknownRankSub": "不明なsubcommand rank {sub}（list／set／add／remove／clear）",
  // src/config-cli.ts:254
  "cli.config.usage": "Usage: switchman-config <pool|rank> ...",
  // src/config-cli.ts:255
  "cli.config.usagePoolList": "  pool list [task-pool]             Pool selection概要（economy／mechanical／main／hard／vision／review；pool名付きで番号付きfull list）",
  // src/config-cli.ts:256
  "cli.config.usagePoolAdd": "  pool add <task-pool> <index|model...>    そのtask poolに参加するmodelをcheck",
  // src/config-cli.ts:257
  "cli.config.usagePoolRemove": "  pool remove <task-pool> <index|model...> 参加をuncheck",
  // src/config-cli.ts:258
  "cli.config.usagePoolSet": "  pool set <task-pool> <index|model...>    そのpoolの参加listを完全置換（同一modelは複数poolに参加可）",
  // src/config-cli.ts:259
  "cli.config.usagePoolClear": "  pool clear <task-pool>                そのpoolの設定をクリア（system default候補セットに戻す）",
  // src/config-cli.ts:260
  "cli.config.usageRankList": "  rank list                      manual capability rankingを表示（task-pool selectionにscoped；pool未設定時は/poolConfigに案内）",
  // src/config-cli.ts:261
  "cli.config.usageRankSet": "  rank set <index|model...>         完全並替（指定順、#1が最強；pool選択済みmodelのみ）",
  // src/config-cli.ts:262
  "cli.config.usageRankAdd": "  rank add <index|model...>         ranking末尾に追加（pool選択済みmodelのみ）",
  // src/config-cli.ts:263
  "cli.config.usageRankRemove": "  rank remove <index|model...>      rankingから削除",
  // src/config-cli.ts:264
  "cli.config.usageRankClear": "  rank clear                     rankingをクリア（base capability scoreにフォールバック）",
  // src/config-cli.ts:267
  "cli.config.errorPrefix": "switchman-config: {message}",
  // src/doctor-cli.ts:5
  "cli.doctor.usage": "Usage: switchman-doctorはopencode-switchman設定を検査します；OPENCODE_CONFIG_DIR env varでconfig directoryを選択；exit code 0=問題なし、1=警告、2=エラー",
  // src/doctor.ts:56 (SWM060 hint)
  "cli.doctor.unknownModelsHint": "{unknownCount} modelsが既知systemにマッチしませんでした（unknown group、係数により最下位にrank）",
  // src/doctor.ts:58 (SWM062 hint)
  "cli.doctor.approxModelsHint": "{approxCount} modelsをprefix／familyで近似分類しました",
  // src/doctor.ts:72 (SWM044 hint)
  "cli.doctor.configFileHint": "opencode-switchman.jsonc",
  // src/doctor.ts:87
  "cli.doctor.noIssues": "opencode-switchman doctor：問題は見つかりませんでした",
  // src/doctor.ts:89
  "cli.doctor.findingLine": "{level} {code}{pathPart}{hintPart}",
}
