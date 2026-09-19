// [2026-09-19]-[Traditional Chinese message catalog: full-coverage translation of src/locales/en.ts;
//  key completeness and {param} parity are enforced by test/i18n.test.ts]
import type { MsgKey } from "../i18n"

export const zhTW: Partial<Record<MsgKey, string>> = {
  // ---- notices (status log; appendStatusLog) ----

  // src/breaker.ts:37
  "notice.breaker.realCallIsolated": "{agent} 實際呼叫已隔離 {mins} 分鐘（{category}）：{reason}",
  // src/breaker.ts:48
  "notice.breaker.shellNotInjected": "shell 未注入 opencode（無隔離）：{agent} {reason}",
  // src/breaker.ts:200
  "notice.breaker.failOpen": "斷路器 fail-open：{exc}",
  // src/capability.ts:246
  "notice.capability.snapshotCorrupted": "內建能力排名快照損毀（略過，改用精選表）",
  // src/capability.ts:299
  "notice.capability.primarySourceFailed": "能力索引主來源 AA 失敗（{exc}）{nextStep}",
  // src/capability.ts:311
  "notice.capability.backupSourceFailed": "能力索引備援來源 OpenRouter 失敗（{exc}）-> 保留最近可用/內建預設排名",
  // src/capability.ts:316
  "notice.capability.parsedEmpty": "能力索引解析結果為空（{source}）-> 保留最近可用/內建預設排名",
  // src/capability.ts:333
  "notice.capability.refreshed": "能力索引已重新整理：{source} 共 {modelCount} 個模型（version={version}）",
  // src/capability.ts:336
  "notice.capability.refreshFailOpen": "能力索引重新整理 fail-open（保留最近可用/內建預設排名）：{exc}",
  // src/capability.ts:372
  "notice.capability.lmarenaDisagreement": "能力 LMArena 交叉檢核：層級排序與 ELO 排序一致率僅 {rate}%（重疊 {overlapCount} 個模型）-- 資料來源可能異常，建議人工檢查",
  // src/capability.ts:375
  "notice.capability.lmarenaFailOpen": "能力 LMArena 交叉檢核 fail-open（已略過）：{exc}",
  // src/catalog.ts:153
  "notice.catalog.unavailableNoCache": "models.dev 目錄無法使用且無快取（fail-open 降級）：{exc}",
  // src/copilot-thinking.ts:71
  "notice.copilot.shapeCacheRefreshed": "Copilot 思考參數 shape 快取已重新整理：{modelCount} 個模型",
  // src/copilot-thinking.ts:73
  "notice.copilot.shapeRefreshFailOpen": "Copilot 思考參數 shape 重新整理 fail-open：{exc}",
  // src/cost.ts:44
  "notice.cost.refreshFailed": "成本快照重新整理失敗（保留過期資料）：{exc}",
  // src/dispatch-mode.ts:60 (log callback defaults to appendStatusLog)
  "notice.lang.settingsInvalidJson": "[opencode-switchman] {workspaceDirname}/{langSettingsFile} 不是有效的 JSON — 已忽略（語言設定退回 AGENTS.md 標記；\"dispatch\":\"off\" 未套用）",
  // src/dispatch-mode.ts:66 (log callback defaults to appendStatusLog)
  "notice.lang.dispatchNotOff": "[opencode-switchman] {workspaceDirname}/{langSettingsFile} 有 \"dispatch\" 但值不是精確的 \"off\"（實際值：{rawValue}）— 已忽略，維持 fleet 行為",
  // src/index.ts:262
  "notice.ctx.paused": "工作階段 {sid} 的 ctx 控制已暫停（/ctx-pause）：讀取閘門 + 自我讀取預算 + 自動交接均已暫停；用量量測持續進行",
  // src/index.ts:264
  "notice.ctx.resumed": "工作階段 {sid} 的 ctx 控制已恢復（/ctx-resume）：讀取閘門 + 自動交接重新生效",
  // src/index.ts:467
  "notice.workspace.created": "產物工作區已建立：{rel}",
  // src/index.ts:468
  "notice.workspace.renamed": "產物工作區已重新命名：{oldRel} → {rel}",
  // src/index.ts:542
  "notice.dispatch.mirrorResumeReuse": "tmux 窗格鏡射：恢復派發 ses_{taskId}（{shellName}）— task_id 重複使用，直接開啟窗格（不會觸發 session.created）",
  // src/index.ts:546
  "notice.dispatch.mirrorResumeLookupFailed": "tmux 窗格鏡射：恢復派發 ses_{taskId}（{shellName}）— 查找工作階段失敗，fail-open 改開一般窗格",
  // src/index.ts:574
  "notice.capability.selectionChanged": "能力排名/任務池選擇已變更：banner 與側邊欄立即重新整理",
  // src/index.ts:589
  "notice.capability.overrideWatchError": "fs.watch({dir}) 覆寫設定監看錯誤（退回 mtime 輪詢）：{exc}",
  // src/index.ts:647
  "notice.matrix.configSurfaceFailOpen": "設定介面讀取 fail-open：{exc}",
  // src/index.ts:675
  "notice.matrix.floorFreeModels": "floor = {floorCount} 個 OpenCode Zen 免費模型（catalog {catalogStatus}）",
  // src/index.ts:676
  "notice.matrix.floorFallback": "floor 退回靜態資訊清單（catalog {catalogStatus}，0 個免費模型）",
  // src/index.ts:680
  "notice.matrix.invalidModelsUnknownProvider": "可見集合/最愛包含提供者未知的無效模型（provider 未連線；已忽略，未建立 shell）：{modelList}",
  // src/index.ts:778
  "notice.provider.probeAttemptSucceeded": "provider.list 第 {attempt} 次嘗試成功（前 {prevAttempts} 次尚未就緒）",
  // src/index.ts:783
  "notice.provider.probeAttemptBackoff": "provider.list 第 {attempt} 次嘗試尚未就緒，退避中：{exc}",
  // src/index.ts:789
  "notice.provider.unavailableCfgFallback": "provider.list 無法使用（{attemptCount} 次嘗試後退回 {keyCount} 個 cfg.provider 設定鍵）：{exc}",
  // src/index.ts:814 (alert)
  "notice.provider.probeNewProvider": "provider.list 背景探測：有新的 provider 連上（{providers}）— 請重新啟動 opencode 以完成 shell 註冊",
  // src/index.ts:832 (alert)
  "notice.provider.probeModelDrift": "provider.list 背景探測：模型清單已變動（{drift}）— 超集資訊清單已重建，/modelRank //poolConfig 清單已更新{restartHint}",
  // src/index.ts:834
  "notice.provider.probeRebuildFailed": "provider.list 背景探測：超集資訊清單重建失敗（保留原資訊清單）：{exc}",
  // src/index.ts:886
  "notice.probe.warmupFailOpen": "預熱 fail-open：{exc}",
  // src/index.ts:900
  "notice.skills.synced": "skills 已同步：已安裝 {installedCount} 個、已更新 {updatedCount} 個、已移除 {removedCount} 個（{skillNames}）",
  // src/index.ts:903
  "notice.skills.syncFailOpen": "skill 同步 fail-open：{exc}",
  // src/index.ts:1145
  "notice.banner.failOpen": "banner fail-open：{exc}",
  // src/index.ts:1241
  "notice.ctx.readBudgetContinuation": "讀取預算續讀完成（檔案 {fileName}，自 {offset} 起再 +{granted} 行，回合 {turnUsed}/{turnBudget}）",
  // src/index.ts:1251
  "notice.ctx.readBudgetGateCap": "讀取預算閘門上限（tool read，檔案 {fileName}，估計 ~{totalTokens} -> 上限 {suggestedLimit}，回合 {turnUsed}/{turnBudget}）",
  // src/index.ts:1277 (template built at src/index.ts:1259 as denyLog)
  "notice.ctx.readBudgetGate": "讀取預算閘門 {action}（工具 {tool}，估計 ~{totalTokens}{contRem}，C~{wmTokens}，T_est≈{turnsToHard}，回合 {turnUsed}/{turnBudget}）",
  // src/index.ts:1281
  "notice.ctx.readBudgetGateFailOpen": "讀取預算閘門 fail-open（放行）：{exc}",
  // src/index.ts:1306
  "notice.image.readGuardDenied": "圖片讀取防護：模型 {modelKey} 不支援視覺輸入；拒絕讀取 {fileName}（工作階段 {sid}）",
  // src/index.ts:1310
  "notice.image.readGuardFailOpen": "圖片讀取防護 fail-open（放行）：{exc}",
  // src/index.ts:1358
  "notice.doctor.summary": "doctor 發現 {errorCount} 個錯誤 / {warnCount} 個警告；執行 /switchman-doctor 檢視",
  // src/index.ts:1393
  "notice.injection.legacyStaticMatrix": "已注入 {shellCount} 個模型 shell（agents，舊版靜態矩陣）",
  // src/index.ts:1412
  "notice.provider.cacheUsed": "provider.list 使用跨重啟快取（{providerCount} 個 provider，快取於 {cachedAt}）；正在背景驗證新增項目",
  // src/index.ts:1419
  "notice.provider.cacheStale": "provider.list 快取已過期（快取於 {cachedAt}），建立超集前先即時探測",
  // src/index.ts:1469
  "notice.matrix.recomputed": "啟用矩陣已重算（gen={generation}，作用中 shell {activeShellCount} 個，探測 {source}×{targetCount}）",
  // src/index.ts:1474
  "notice.injection.shellCount": "已注入 {shellCount} 個 shell（mode={runMode}，注入面={injectionMode} 精選後 {fullSupersetCount}→{faceCount}，衝突 {conflictCount}；啟用閘控生效中）",
  // src/index.ts:1479
  "notice.injection.configHookFailOpen": "config hook fail-open：{exc}",
  // src/index.ts:1541
  "notice.lang.askLocale": "lang ask locale={locale}（{source}）",
  // src/index.ts:1604
  "notice.banner.rulesFailOpen": "rules/banner fail-open：{exc}",
  // src/index.ts:1677
  "notice.relay.persisted": "圖片中繼：模型 {modelKey} 不支援視覺輸入；已將 {written} 張圖片存入磁碟（{relayed} 個圖片區段跨工作階段歷史中繼，工作階段 {sid}）",
  // src/index.ts:1679
  "notice.relay.failOpen": "圖片中繼 fail-open（直接放行）：{exc}",
  // src/index.ts:1694
  "notice.ctx.capToolDenied": "子代理 context 上限：已終止的工作階段 {sid} 中拒絕工具 '{tool}'",
  // src/index.ts:1701
  "notice.ctx.capResumeDenied": "子代理 context 上限：拒絕恢復已終止的工作階段 ses_{taskId}（永久性）",
  // src/index.ts:1727
  "notice.lang.gateDenied": "語言閘門：未設定專案的工作階段 {sid} 中拒絕工具 '{tool}'",
  // src/index.ts:1751
  "notice.search.clarifyFailOpen": "搜尋釐清閘門：連續 {maxDenies} 次拒絕且未提問後 fail-open — 工作階段 {sid} 閘門開啟",
  // src/index.ts:1754
  "notice.search.clarifyDenied": "搜尋釐清閘門：工作階段 {sid} 中拒絕工具 '{tool}'（搜尋範圍過廣，先提問）（{denyCount}/{maxDenies}）",
  // src/index.ts:1774
  "notice.dispatch.offUngoverned": "dispatch 關閉：任務呼叫放行、不受治理（subagent_type='{subagentType}'）",
  // src/index.ts:1853
  "notice.dispatch.redirectUninjected": "自動轉向 {agent} → {candidate}（shell 未注入；已轉向鏈首候選）",
  // src/index.ts:1874
  "notice.dispatch.redirectBuiltinBlocked": "自動轉向 {agent} → {candidate}（內建 agent 已阻擋）",
  // src/index.ts:1883 (via src/gates.ts:331 noteUnknownAgent)
  "notice.dispatch.unknownAgentAllowed": "[opencode-switchman] 未知 subagent_type='{agent}'：放行（不在 shell 清單中；內建 agent 不受路由治理）",
  // src/index.ts:1889 (r.note via src/gates.ts:156)
  "notice.dispatch.registryDisabledNote": "[opencode-switchman] {agent} registry=disabled 但矩陣 status={matrixStatus}（非 down）：fail-open，下次探測重新整理後自動修正",
  // src/index.ts:1889 (r.note via src/gates.ts:175)
  "notice.dispatch.matrixStatusNote": "[opencode-switchman] {agent} 矩陣 status={matrixStatus}（非 down）：未阻擋，探測將於下一輪重新整理",
  // src/index.ts:1889 (r.note via src/gates.ts:63 ROUTE_META_SYNTH_NOTE)
  "notice.dispatch.routeMetaSynthNote": "[opencode-switchman] ROUTE_META 缺失/格式錯誤 — 已由 lane 合成；宣告它以啟用 review 跨家族 / source=user 語意",
  // src/index.ts:1889 (r.note via src/gates.ts:240 REVIEW_SELF_REVIEW_NOTE)
  "notice.dispatch.reviewSelfNote": "[opencode-switchman] DOWNGRADED：無跨家族審查者可用 — 允許同家族自我審查；請在審查結論中宣告 DOWNGRADED",
  // src/index.ts:1889 (r.note via src/gates.ts:288 poolOverrideNote)
  "notice.dispatch.poolOverrideNote": "pool 設定覆寫：已明確選入此任務池（免除能力層級 floor 限制）",
  // src/index.ts:1897
  "notice.dispatch.redirectDenied": "自動轉向 {agent} → {redirect}（{deny}）",
  // src/index.ts:1910
  "notice.dispatch.gatesFailOpen": "六道閘門 fail-open（放行）：{exc}",
  // src/index.ts:1934
  "notice.lang.prefsSaved": "專案語言偏好已儲存（{rel}）：conversation={conversation} comments={comments} docs={docs}",
  // src/index.ts:1937
  "notice.lang.gateWaived": "語言閘門：已完成標記提問但未儲存設定 — 工作階段 {sid} 免除閘門",
  // src/index.ts:1943
  "notice.search.scopeAskDone": "搜尋釐清：範圍提問已完成 — 工作階段 {sid} 閘門開啟",
  // src/index.ts:1956
  "notice.ctx.readBudgetCharge": "讀取預算計費 +{charge}（工具 {tool}，回合 {turnUsed}/{turnBudget}）",
  // src/index.ts:1970
  "notice.handover.autoTriggered": "自動交接已觸發（{tool} 之後，~{wmTokens} 超過強制壓縮 watermark）：完整備份 + 將目前工作階段的壓縮排入佇列",
  // src/index.ts:1981
  "notice.handover.backupResult": "自動交接備份 {outcome}：{message}",
  // src/index.ts:1996 (variant 1 of 3)
  "notice.handover.compactionAccepted": "自動交接壓縮已接受：session.summarize 已回傳（壓縮在工作階段迴圈上執行）",
  // src/index.ts:1996 (variant 2 of 3)
  "notice.handover.compactionRejected": "自動交接壓縮失敗：session.summarize 已拒絕（備份仍有效）",
  // src/index.ts:1996 (variant 3 of 3)
  "notice.handover.compactionNoModel": "自動交接壓縮失敗：未記錄工作階段模型（chat.params 從未觸發）；備份仍有效",
  // src/index.ts:2008
  "notice.handover.failOpen": "自動交接 fail-open：{exc}",
  // src/index.ts:2114
  "notice.ctx.capTerminated": "子代理 context 上限：工作階段 {sid}{agentSuffix} 已達 ~{estTokens}k tokens（上限 {capTokens}k）— 工具已拒絕、要求進度摘要、工作階段已終止（不得以 task_id 恢復）",
  // src/index.ts:2205
  "notice.provider.modelRetired": "模型已除役（連續 404），自候選中移除：{provider}/{modelId}",
  // src/index.ts:2208
  "notice.breaker.agentTripped": "{agent} 斷路器跳脫（600 秒）：{reason}",
  // src/index.ts:2210
  "notice.breaker.accountingFailOpen": "失敗計數 fail-open：{exc}",
  // src/lane.ts:410
  "notice.lane.scoringFallback": "評分失敗，退回規則排序：{exc}",
  // src/lane.ts:494
  "notice.lane.backfillFailed": "回填排名失敗（lane 維持空白）：{exc}",
  // src/matrix-manager.ts:196
  "notice.matrix.favoritesScanNoChange": "已掃描最愛/可見集合：啟用狀態不變（gen={generation}；不重算、不重新探測）",
  // src/matrix-manager.ts:204
  "notice.matrix.invalidModels": "可見集合/最愛包含無效模型（provider 存在但無此 modelId，未產生 shell）：{modelList}",
  // src/matrix-manager.ts:217
  "notice.matrix.persistFailOpen": "啟用矩陣持久化 fail-open：{exc}",
  // src/matrix-manager.ts:222
  "notice.matrix.callbackFailOpen": "啟用矩陣回呼 fail-open：{exc}",
  // src/matrix-manager.ts:250
  "notice.matrix.configReadFailOpen": "設定介面讀取 fail-open（視為空）：{exc}",
  // src/matrix-manager.ts:272
  "notice.matrix.watchError": "fs.watch({dir}) 發生錯誤，退回 mtime 輪詢：{exc}",
  // src/matrix-manager.ts:277
  "notice.matrix.watchStartFailed": "fs.watch({dir}) 無法啟動，退回 mtime 輪詢：{exc}",
  // src/matrix-manager.ts:308
  "notice.matrix.recomputeFailOpen": "重算 fail-open：{exc}",
  // src/probe.ts:144
  "notice.probe.failOpen": "探測 fail-open：{exc}",
  // src/probe.ts:162
  "notice.probe.incrementalFailOpen": "增量探測 fail-open：{exc}",
  // src/probe.ts:201
  "notice.probe.copilotPoolExhausted": "Copilot 每月額度池已用盡（閘道為第二資料來源），reset_date 前視為可信",
  // src/probe.ts:207
  "notice.probe.resultsDiscarded": "探測結果已捨棄（矩陣 generation 已變更 {oldGen}->{newGen}；由新 generation 重算重新排程）",
  // src/probe.ts:214
  "notice.probe.matrixRefreshed": "矩陣已重新整理：{comboCount} 個組合中 {okCount} 個成功（共 {totalCount}）",
  // src/probe.ts:233
  "notice.probe.schedulingFailOpen": "探測排程 fail-open：{exc}",
  // src/scoring.ts:399
  "notice.scoring.decisionLogFailOpen": "決策記錄 fail-open：{exc}",
  // src/selfupdate.ts:122
  "notice.selfupdate.checkFailOpen": "自我更新檢查 fail-open：{exc}",
  // src/selfupdate.ts:255
  "notice.selfupdate.upgradeAssetsFailOpen": "upgrade 指令資產 fail-open：{exc}",
  // src/tmux.ts:149 (via log callback wired to appendStatusLog at src/index.ts:236)
  "notice.dispatch.mirrorDisabled": "tmux 窗格鏡射已停用（初始化失敗）：{message}",
  // src/tmux.ts:221
  "notice.dispatch.mirrorOpFailed": "tmux 窗格鏡射操作失敗（繼續執行）：{message}",
  // src/tmux.ts:230
  "notice.dispatch.mirrorPaneFull": "tmux 窗格鏡射：欄位已滿（{slotCount} 個窗格），ses_{sessionId}（{agent}）已排入佇列",
  // src/tmux.ts:280
  "notice.dispatch.mirrorAllClosed": "tmux 窗格鏡射：所有子代理窗格已關閉，主窗格已還原",
  // src/tmux.ts:290
  "notice.dispatch.mirrorDisplayed": "tmux 窗格鏡射：ses_{sessionId}（{agent}）顯示於窗格 {pane}",
  // src/tmux.ts:303
  "notice.dispatch.mirrorReconciling": "tmux 窗格鏡射：偵測到已關閉的窗格，正在重新校準版面",

  // ---- sidebar (tui.tsx sidebar chrome) ----
  // [2026-09-19]-[sidebar.restartHintPattern (the old RESTART_HINT_RE regex) deliberately NOT a message key: the
  //  structured alert flag on status-log entries replaces regex highlighting; keys are translatable prose only]

  // src/tui.tsx:308
  "sidebar.peakTag": " ·尖峰",
  // src/tui.tsx:309
  "sidebar.staleTag": " ·過期",
  // src/tui.tsx:310
  "sidebar.observeOnlyTag": " ·僅觀察",
  // src/tui.tsx:346
  "sidebar.updateAvailable": " → {updateVersion}",
  // src/tui.tsx:351
  "sidebar.restartNeeded": " [需重新啟動]",
  // src/tui.tsx:358
  "sidebar.noneAvailable": "無可用項目",
  // src/tui.tsx:391 (six-lane panel labels — display-only; runtime lane identifiers/config keys stay English)
  "sidebar.lane.economy": "經濟",
  "sidebar.lane.mechanical": "機械",
  "sidebar.lane.main": "主力",
  "sidebar.lane.hard": "困難",
  "sidebar.lane.vision": "視覺",
  "sidebar.lane.review": "評審",
  // src/tui.tsx:368
  "sidebar.noticeLabel": "通知",

  // ---- dialogs (tui.tsx: pool picker / pool models / rank / handover) ----

  // src/tui.tsx:426 (pool picker title)
  "dialog.pool.title": "任務池（選擇一個任務池；按 Esc 結束）",
  // src/tui.tsx:428 (pool picker lane row)
  "dialog.pool.laneRow": "{pinMark}{lane}",
  // src/tui.tsx:431 (pool picker option description)
  "dialog.pool.manualSelection": "手動選擇：{selCount}/{totalCount} 個模型參與",
  // src/tui.tsx:432 (pool picker option description)
  "dialog.pool.notConfigured": "未設定：系統預設（所有可用模型皆參與）",
  // src/tui.tsx:453 (pool models dialog, toggle persist)
  "dialog.pool.toggleWriteFailed": "寫入失敗：{message}",
  // src/tui.tsx:458 (pool models dialog, toggle toast)
  "dialog.pool.modelToggled": "{verb} {modelKey} {direction} {lane} 任務池（立即生效，側邊欄重新整理）",
  // src/tui.tsx:469 (pool models dialog, min-selection guard toast)
  "dialog.pool.keepOneModel": "至少須保留一個參與模型；使用「清除設定」可還原系統預設",
  // src/tui.tsx:482 (pool models dialog, bulk select-all persist)
  "dialog.pool.bulkWriteFailed": "寫入失敗：{message}",
  // src/tui.tsx:485 (pool models dialog, bulk toast)
  "dialog.pool.allSelected": "{lane} 任務池：已選取所有模型",
  // src/tui.tsx:490 (pool models dialog, clear-config toast)
  "dialog.pool.configCleared": "{lane} 任務池設定已清除（已還原系統預設候選集）",
  // src/tui.tsx:499 (pool models dialog, uncheck-all toast)
  "dialog.pool.allUnchecked": "{lane} 任務池：已全部取消勾選 — 請勾選要保留的模型；全部未勾選時結束將維持原選擇",
  // src/tui.tsx:503 (pool models dialog option)
  "dialog.pool.back": "← 返回任務池清單",
  // src/tui.tsx:504 (pool models dialog option)
  "dialog.pool.selectAll": "☑ 全選",
  // src/tui.tsx:505 (pool models dialog option)
  "dialog.pool.uncheckAll": "☐ 全部取消勾選（之後勾選少數要保留的；全部未勾選時結束將保留原清單）",
  // src/tui.tsx:506 (pool models dialog option)
  "dialog.pool.clearConfig": "✕ 清除設定（系統預設：所有可用模型皆參與）",
  // src/tui.tsx:508 (pool models dialog model row)
  "dialog.pool.modelRow": "{checkMark} {modelId}",
  // src/tui.tsx:510 (pool models dialog row description)
  "dialog.pool.rowMeta": "{tier} 層級{manualSuffix}",
  // src/tui.tsx:516 (pool models dialog title)
  "dialog.pool.selectionTitle": "{lane} 任務池選擇（{selCount}/{rowCount} 個參與；點選即切換，允許跨池重複）",
  // src/tui.tsx:538 (rank universe-empty dialog option)
  "dialog.rank.openPoolSelection": "→ 開啟任務池選擇（先挑選各任務池可用的模型，再進行排名）",
  // src/tui.tsx:539 (rank universe-empty dialog option)
  "dialog.rank.close": "✕ 關閉",
  // src/tui.tsx:543 (rank universe-empty dialog title)
  "dialog.rank.universeEmptyTitle": "設定任務池之前無法使用模型排名 — 只有獲選進入任務池的模型才能排名，因此不會排到無法派發的模型",
  // src/tui.tsx:561 (rank move at edge toast)
  "dialog.rank.alreadyAtEdge": "{modelName} 已位於合併能力清單的{edge}端",
  // src/tui.tsx:568 (rank move persist)
  "dialog.rank.moveWriteFailed": "寫入失敗：{message}",
  // src/tui.tsx:573 (rank move/pin toast)
  "dialog.rank.pinnedOrMoved": "{verb} {modelName} 至 #{position}（手動分數 {tier}/{raw}，錨定於相鄰模型之間；立即生效，側邊欄重新整理）",
  // src/tui.tsx:627 (rank picker title)
  "dialog.rank.title": "模型能力排名 — 合併順序（#1 最強；範圍限任務池選擇；手動項目與基礎分數模型交錯排列；ctrl+up/ctrl+down 移動一位；enter = 開啟個別模型動作）",
  // src/tui.tsx:628 (rank picker placeholder)
  "dialog.rank.searchHint": "搜尋 · alt+up/alt+down 與 ctrl+up/ctrl+down 同義（同樣有效）",
  // src/tui.tsx:630 (rank picker row)
  "dialog.rank.row": "#{rankPadded} {modelId}",
  // src/tui.tsx:632 (rank picker row description)
  "dialog.rank.rowMeta": "{tier} 層級 · {scoreSource}{poolSuffix}",
  // src/tui.tsx:662 (rank actions, remove persist)
  "dialog.rank.removeWriteFailed": "寫入失敗：{message}",
  // src/tui.tsx:665 (rank actions, remove toast)
  "dialog.rank.removed": "已將 {model} 自手動排名移除（退回基礎能力分數，立即生效，側邊欄重新整理）",
  // src/tui.tsx:669 (rank actions option)
  "dialog.rank.pinTop": "▲ 釘選至頂端（高於所有模型）",
  // src/tui.tsx:670 (rank actions option)
  "dialog.rank.moveUp": "↑ 上移一位（與上方模型交換；將手動分數錨定於相鄰模型之間）",
  // src/tui.tsx:671 (rank actions option)
  "dialog.rank.moveDown": "↓ 下移一位（與下方模型交換）",
  // src/tui.tsx:673 (rank actions option)
  "dialog.rank.remove": "✕ 自排名移除（退回基礎分數）",
  // src/tui.tsx:675 (rank actions option)
  "dialog.rank.back": "← 返回排名清單",
  // src/tui.tsx:680 (rank actions title)
  "dialog.rank.detailTitle": "{model}（{rankState}）",
  // src/tui.tsx:734 (handover toast)
  "dialog.handover.noSession": "/handover：不在工作階段中，沒有可備份的內容",
  // src/tui.tsx:739 (handover toast)
  "dialog.handover.inProgress": "/handover：正在完整備份目前工作階段並壓縮…",
  // src/tui.tsx:744 (handover toast)
  "dialog.handover.resultStay": "{resultMessage}；仍在原工作階段，未切換",
  // src/tui.tsx:747 (handover toast)
  "dialog.handover.result": "/handover {resultMessage}",

  // ---- palette (command palette entries) ----

  // src/tui.tsx:770
  "palette.handover.title": "備份並壓縮目前的工作階段",
  // src/tui.tsx:771
  "palette.handover.desc": "完整分支（fork）目前工作階段作為備份（標題附加 [backup] 標籤），並對目前工作階段進行壓縮；不切換工作階段（有別於內建 /fork）",
  // src/tui.tsx:772 (palette category label)
  "palette.category.label": "switchman",
  // src/tui.tsx:779
  "palette.poolConfig.title": "任務池選擇",
  // src/tui.tsx:780
  "palette.poolConfig.desc": "為每個任務池挑選參與的模型（economy/mechanical/main/hard/vision/review）",
  // src/tui.tsx:788
  "palette.modelRank.title": "模型能力排名",
  // src/tui.tsx:789
  "palette.modelRank.desc": "手動能力排名（優先於基礎分數；越前面 = 越強）",

  // ---- quota (quota-brief.json rows; banner.ts builders) ----

  // src/banner.ts:142 (POOL_LABEL)
  "quota.poolGlm": "GLM",
  // src/banner.ts:142 (POOL_LABEL)
  "quota.poolCopilot": "Copilot",
  // src/banner.ts:142 (POOL_LABEL)
  "quota.poolDeepSeek": "DeepSeek",
  // src/banner.ts:166
  "quota.queryingNoData": "查詢中/無資料",
  // src/banner.ts:173
  "quota.resetLater": "→稍後",
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
  "quota.noData": "無額度資料",
  // src/banner.ts:187 (row label)
  "quota.rowRefresh": "重新整理",
  // src/banner.ts:188 (row label)
  "quota.rowCredits": "點數",
  // src/banner.ts:188
  "quota.monthlyExhausted": "每月額度已用盡",
  // src/banner.ts:193
  "quota.unlimited": "無上限{usedSuffix}",
  // src/banner.ts:199
  "quota.exhaustedOverage": "已用盡·超額計費{usage}",
  // src/banner.ts:202
  "quota.barPctLeft": "{bar8} 剩餘 {pctTxt}%{usage}",
  // src/banner.ts:207 (row label)
  "quota.rowBalance": "餘額",
  // src/banner.ts:207
  "quota.exhausted": "已用盡",
  // src/banner.ts:209
  "quota.unknownPayg": "未知（隨用隨付）",
  // src/banner.ts:213
  "quota.barBalance": "{bar8} ¥{balance}",
  // src/banner.ts:213
  "quota.balanceWarn": "（<¥{thr} 警告）",

  // ---- cli (switchman-config / switchman-doctor) ----

  // src/config-cli.ts:67 (fmtRow, printed at :87)
  "cli.config.poolRow": "#{rankPadded} {checkMark} {modelId}（{tier} 層級{manualTag}）",
  // src/config-cli.ts:73 (thrown, surfaced via console.error at :267)
  "cli.config.unknownPool": "未知任務池：{lane}（六個任務池：{laneList}）",
  // src/config-cli.ts:81 (head, printed at :85/:90)
  "cli.config.poolHeader": "任務池選擇（設定檔 {poolConfigPath}；選擇 = 加入該任務池的模型；同一模型可加入多個任務池；未設定的任務池採系統預設決策）",
  // src/config-cli.ts:86
  "cli.config.poolSection": "== {lane} ==（{selection}）",
  // src/config-cli.ts:93
  "cli.config.poolSectionBrief": "== {lane} =={detail}",
  // src/config-cli.ts:95
  "cli.config.poolListHint": "（以編號檢視單一任務池的完整清單：pool list <{laneList}>）",
  // src/config-cli.ts:105 (thrown, surfaced via console.error at :267)
  "cli.config.indexOutOfRange": "索引超出範圍 #{index}（清單共 {rowCount} 項）",
  // src/config-cli.ts:110 (thrown, surfaced via console.error at :267)
  "cli.config.invalidModel": "無效的模型名稱：{model}",
  // src/config-cli.ts:124 (thrown, surfaced via console.error at :267)
  "cli.config.noManifest": "沒有可用的模型資訊清單（請檢查 provider 連線與超集資訊清單）",
  // src/config-cli.ts:129 (thrown, surfaced via console.error at :267)
  "cli.config.poolRequiresArg": "pool {sub} 需要索引或模型名稱",
  // src/config-cli.ts:138
  "cli.config.poolSelectionCleared": "{lane} 任務池選擇已清除（回到系統預設候選集，立即生效，側邊欄同步重新整理）",
  // src/config-cli.ts:139
  "cli.config.poolUpdated": "已更新 {lane} 任務池選擇（{modelCount} 個模型參與，立即生效，側邊欄同步重新整理）",
  // src/config-cli.ts:145
  "cli.config.poolConfigCleared": "已清除 {lane} 任務池選擇設定（該任務池回到系統預設候選集，立即生效，側邊欄同步重新整理）",
  // src/config-cli.ts:148 (thrown, surfaced via console.error at :267)
  "cli.config.unknownPoolSub": "未知子指令 pool {sub}（list/add/remove/set/clear）",
  // src/config-cli.ts:186
  "cli.config.rankDisabledUntilPools": "在設定任務池之前，手動能力排名（設定檔 {capabilityRankPath}）為停用：只有獲選進入任務池的模型才能排名。",
  // src/config-cli.ts:187
  "cli.config.rankHowTo": "先在此執行 /poolConfig（TUI 對話框）或 pool set <task-pool> <index|model...>，再只為實際使用的模型排名。",
  // src/config-cli.ts:190
  "cli.config.legacyHeader": "== 舊版手動項目（僅供清理；rank remove/clear 仍可使用，或將模型選入任務池以進行排名）==",
  // src/config-cli.ts:191
  "cli.config.legacyRow": "#{rankPadded} {modelKey}",
  // src/config-cli.ts:197
  "cli.config.rankHeader": "模型能力排名（設定檔 {capabilityRankPath}；範圍限透過 /poolConfig 選入任務池的 {universeCount} 個模型 — 單一合併排序，手動項目依有效分數與基礎分數模型交錯排列；越上面 = 越強）",
  // src/config-cli.ts:198
  "cli.config.mergedHeader": "== 合併排序（{manualCount} 個手動{manualSuffix}；CLI set/add 依舊版階梯排序項目，TUI 則將分數錨定於相鄰模型之間）==",
  // src/config-cli.ts:201
  "cli.config.manualTag": "·手動{score}",
  // src/config-cli.ts:203
  "cli.config.notInPoolTag": "·未加入任何任務池",
  // src/config-cli.ts:204
  "cli.config.rankRow": "#{rankPadded} {modelId}（{tier} 層級{manualTag}{poolTag}）",
  // src/config-cli.ts:210 (thrown, surfaced via console.error at :267)
  "cli.config.rankNoPools": "尚未選擇任務池 — 排名遵循任務池選擇；請先執行 /poolConfig（或 pool set）",
  // src/config-cli.ts:212 (thrown, surfaced via console.error at :267)
  "cli.config.rankRequiresArg": "rank {sub} 需要索引或模型名稱",
  // src/config-cli.ts:237
  "cli.config.rankUpdated": "已更新手動能力排名（{modelCount} 個模型，立即生效，側邊欄同步重新整理）",
  // src/config-cli.ts:242
  "cli.config.rankCleared": "已清除手動能力排名（全部退回基礎能力分數，立即生效，側邊欄同步重新整理）",
  // src/config-cli.ts:245 (thrown, surfaced via console.error at :267)
  "cli.config.unknownRankSub": "未知子指令 rank {sub}（list/set/add/remove/clear）",
  // src/config-cli.ts:254
  "cli.config.usage": "用法：switchman-config <pool|rank> ...",
  // src/config-cli.ts:255
  "cli.config.usagePoolList": "  pool list [task-pool]             任務池選擇總覽（economy/mechanical/main/hard/vision/review；加上任務池名稱 = 顯示含編號的完整清單）",
  // src/config-cli.ts:256
  "cli.config.usagePoolAdd": "  pool add <task-pool> <index|model...>    勾選加入該任務池的模型",
  // src/config-cli.ts:257
  "cli.config.usagePoolRemove": "  pool remove <task-pool> <index|model...> 取消勾選參與",
  // src/config-cli.ts:258
  "cli.config.usagePoolSet": "  pool set <task-pool> <index|model...>    完整取代該任務池的參與清單（同一模型可加入多個任務池）",
  // src/config-cli.ts:259
  "cli.config.usagePoolClear": "  pool clear <task-pool>                清除該任務池的設定（回到系統預設候選集）",
  // src/config-cli.ts:260
  "cli.config.usageRankList": "  rank list                      檢視手動能力排名（範圍限任務池選擇；未設定任務池時會引導至 /poolConfig）",
  // src/config-cli.ts:261
  "cli.config.usageRankSet": "  rank set <index|model...>         完整重排（依給定順序，#1 最強；僅限已選入任務池的模型）",
  // src/config-cli.ts:262
  "cli.config.usageRankAdd": "  rank add <index|model...>         附加到排名尾端（僅限已選入任務池的模型）",
  // src/config-cli.ts:263
  "cli.config.usageRankRemove": "  rank remove <index|model...>      自排名移除",
  // src/config-cli.ts:264
  "cli.config.usageRankClear": "  rank clear                     清除排名（退回基礎能力分數）",
  // src/config-cli.ts:267
  "cli.config.errorPrefix": "switchman-config: {message}",
  // src/doctor-cli.ts:5
  "cli.doctor.usage": "用法：switchman-doctor 會檢查 opencode-switchman 設定；以 OPENCODE_CONFIG_DIR 環境變數選擇設定目錄；結束代碼 0=無問題、1=警告、2=錯誤",
  // src/doctor.ts:56 (SWM060 hint)
  "cli.doctor.unknownModelsHint": "{unknownCount} 個模型未被已知系統比對到（未知群組，依係數排到最後）",
  // src/doctor.ts:58 (SWM062 hint)
  "cli.doctor.approxModelsHint": "{approxCount} 個模型以前綴/家族近似分類",
  // src/doctor.ts:72 (SWM044 hint)
  "cli.doctor.configFileHint": "opencode-switchman.jsonc",
  // src/doctor.ts:87
  "cli.doctor.noIssues": "opencode-switchman doctor：未發現問題",
  // src/doctor.ts:89
  "cli.doctor.findingLine": "{level} {code}{pathPart}{hintPart}",
}
