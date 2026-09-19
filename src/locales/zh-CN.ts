// [2026-09-19]-[Simplified Chinese message catalog: full-coverage translation of src/locales/en.ts;
//  key completeness and {param} parity are enforced by test/i18n.test.ts]
import type { MsgKey } from "../i18n"

export const zhCN: Partial<Record<MsgKey, string>> = {
  // ---- notices (status log; appendStatusLog) ----

  // src/breaker.ts:37
  "notice.breaker.realCallIsolated": "{agent} 真实调用已隔离 {mins} 分钟（{category}）：{reason}",
  // src/breaker.ts:48
  "notice.breaker.shellNotInjected": "shell 未注入 opencode（无隔离）：{agent} {reason}",
  // src/breaker.ts:200
  "notice.breaker.failOpen": "断路器 fail-open：{exc}",
  // src/capability.ts:246
  "notice.capability.snapshotCorrupted": "内置能力排名快照损坏（跳过，回退到精选表）",
  // src/capability.ts:299
  "notice.capability.primarySourceFailed": "能力索引主来源 AA 失败（{exc}）{nextStep}",
  // src/capability.ts:311
  "notice.capability.backupSourceFailed": "能力索引备用来源 OpenRouter 失败（{exc}）-> 保留最近可用/内置默认排名",
  // src/capability.ts:316
  "notice.capability.parsedEmpty": "能力索引解析结果为空（{source}）-> 保留最近可用/内置默认排名",
  // src/capability.ts:333
  "notice.capability.refreshed": "能力索引已刷新：{source} 共 {modelCount} 个模型（version={version}）",
  // src/capability.ts:336
  "notice.capability.refreshFailOpen": "能力索引刷新 fail-open（保留最近可用/内置默认排名）：{exc}",
  // src/capability.ts:372
  "notice.capability.lmarenaDisagreement": "能力 LMArena 交叉核对：层级排序与 ELO 排序一致率仅 {rate}%（重叠 {overlapCount} 个模型）-- 数据来源可能异常，建议人工复查",
  // src/capability.ts:375
  "notice.capability.lmarenaFailOpen": "能力 LMArena 交叉核对 fail-open（已跳过）：{exc}",
  // src/catalog.ts:153
  "notice.catalog.unavailableNoCache": "models.dev 目录不可用且无缓存（fail-open 降级）：{exc}",
  // src/copilot-thinking.ts:71
  "notice.copilot.shapeCacheRefreshed": "Copilot 思考参数 shape 缓存已刷新：{modelCount} 个模型",
  // src/copilot-thinking.ts:73
  "notice.copilot.shapeRefreshFailOpen": "Copilot 思考参数 shape 刷新 fail-open：{exc}",
  // src/cost.ts:44
  "notice.cost.refreshFailed": "成本快照刷新失败（保留过期数据）：{exc}",
  // src/dispatch-mode.ts:60 (log callback defaults to appendStatusLog)
  "notice.lang.settingsInvalidJson": "[opencode-switchman] {workspaceDirname}/{langSettingsFile} 不是有效的 JSON — 已忽略（lang 配置回退到 AGENTS.md 标记；\"dispatch\":\"off\" 未生效）",
  // src/dispatch-mode.ts:66 (log callback defaults to appendStatusLog)
  "notice.lang.dispatchNotOff": "[opencode-switchman] {workspaceDirname}/{langSettingsFile} 存在 \"dispatch\" 但值不是精确的 \"off\"（实际值：{rawValue}）— 已忽略，保持 fleet 行为",
  // src/index.ts:262
  "notice.ctx.paused": "会话 {sid} 的 ctx 控制已暂停（/ctx-pause）：读取闸门 + 自读预算 + 自动交接均已暂停；用量测量继续进行",
  // src/index.ts:264
  "notice.ctx.resumed": "会话 {sid} 的 ctx 控制已恢复（/ctx-resume）：读取闸门 + 自动交接重新生效",
  // src/index.ts:467
  "notice.workspace.created": "产物工作区已创建：{rel}",
  // src/index.ts:468
  "notice.workspace.renamed": "产物工作区已重命名：{oldRel} → {rel}",
  // src/index.ts:542
  "notice.dispatch.mirrorResumeReuse": "tmux 面板镜像：恢复派发 ses_{taskId}（{shellName}）— task_id 复用，直接打开面板（不会触发 session.created）",
  // src/index.ts:546
  "notice.dispatch.mirrorResumeLookupFailed": "tmux 面板镜像：恢复派发 ses_{taskId}（{shellName}）— 会话查找失败，fail-open 改开普通面板",
  // src/index.ts:574
  "notice.capability.selectionChanged": "能力排名/任务池选择已变更：banner 与侧边栏立即刷新",
  // src/index.ts:589
  "notice.capability.overrideWatchError": "fs.watch({dir}) 覆盖配置监听出错（回退 mtime 轮询）：{exc}",
  // src/index.ts:647
  "notice.matrix.configSurfaceFailOpen": "配置界面读取 fail-open：{exc}",
  // src/index.ts:675
  "notice.matrix.floorFreeModels": "floor = {floorCount} 个 OpenCode Zen 免费模型（catalog {catalogStatus}）",
  // src/index.ts:676
  "notice.matrix.floorFallback": "floor 回退到静态清单（catalog {catalogStatus}，0 个免费模型）",
  // src/index.ts:680
  "notice.matrix.invalidModelsUnknownProvider": "可见集合/收藏包含 provider 未知的无效模型（provider 未连接；已忽略，未生成 shell）：{modelList}",
  // src/index.ts:778
  "notice.provider.probeAttemptSucceeded": "provider.list 第 {attempt} 次尝试成功（此前 {prevAttempts} 次尚未就绪）",
  // src/index.ts:783
  "notice.provider.probeAttemptBackoff": "provider.list 第 {attempt} 次尝试尚未就绪，退避中：{exc}",
  // src/index.ts:789
  "notice.provider.unavailableCfgFallback": "provider.list 不可用（{attemptCount} 次尝试后回退到 {keyCount} 个 cfg.provider 配置键）：{exc}",
  // src/index.ts:814 (alert)
  "notice.provider.probeNewProvider": "provider.list 后台探测：有新的 provider 连接（{providers}）— 请重启 opencode 以完成 shell 注册",
  // src/index.ts:832 (alert)
  "notice.provider.probeModelDrift": "provider.list 后台探测：模型列表已变动（{drift}）— 超集清单已重建，/modelRank //poolConfig 列表已更新{restartHint}",
  // src/index.ts:834
  "notice.provider.probeRebuildFailed": "provider.list 后台探测：超集清单重建失败（保留原清单）：{exc}",
  // src/index.ts:886
  "notice.probe.warmupFailOpen": "预热 fail-open：{exc}",
  // src/index.ts:900
  "notice.skills.synced": "skills 已同步：安装 {installedCount} 个、更新 {updatedCount} 个、移除 {removedCount} 个（{skillNames}）",
  // src/index.ts:903
  "notice.skills.syncFailOpen": "skill 同步 fail-open：{exc}",
  // src/index.ts:1145
  "notice.banner.failOpen": "banner fail-open：{exc}",
  // src/index.ts:1241
  "notice.ctx.readBudgetContinuation": "读取预算续读完成（文件 {fileName}，自 {offset} 起再读 +{granted} 行，回合 {turnUsed}/{turnBudget}）",
  // src/index.ts:1251
  "notice.ctx.readBudgetGateCap": "读取预算闸门上限（tool read，文件 {fileName}，估计 ~{totalTokens} -> 上限 {suggestedLimit}，回合 {turnUsed}/{turnBudget}）",
  // src/index.ts:1277 (template built at src/index.ts:1259 as denyLog)
  "notice.ctx.readBudgetGate": "读取预算闸门 {action}（工具 {tool}，估计 ~{totalTokens}{contRem}，C~{wmTokens}，T_est≈{turnsToHard}，回合 {turnUsed}/{turnBudget}）",
  // src/index.ts:1281
  "notice.ctx.readBudgetGateFailOpen": "读取预算闸门 fail-open（放行）：{exc}",
  // src/index.ts:1306
  "notice.image.readGuardDenied": "图片读取防护：模型 {modelKey} 无视觉输入；拒绝读取 {fileName}（会话 {sid}）",
  // src/index.ts:1310
  "notice.image.readGuardFailOpen": "图片读取防护 fail-open（放行）：{exc}",
  // src/index.ts:1358
  "notice.doctor.summary": "doctor 发现 {errorCount} 个错误 / {warnCount} 个警告；运行 /switchman-doctor 查看",
  // src/index.ts:1393
  "notice.injection.legacyStaticMatrix": "已注入 {shellCount} 个模型 shell（agents，旧版静态矩阵）",
  // src/index.ts:1412
  "notice.provider.cacheUsed": "provider.list 使用跨重启缓存（{providerCount} 个 provider，缓存于 {cachedAt}）；正在后台验证新增项",
  // src/index.ts:1419
  "notice.provider.cacheStale": "provider.list 缓存已过期（缓存于 {cachedAt}），构建超集前先实时探测",
  // src/index.ts:1469
  "notice.matrix.recomputed": "激活矩阵已重算（gen={generation}，活跃 shell {activeShellCount} 个，探测 {source}×{targetCount}）",
  // src/index.ts:1474
  "notice.injection.shellCount": "已注入 {shellCount} 个 shell（mode={runMode}，注入面={injectionMode} 精选后 {fullSupersetCount}→{faceCount}，冲突 {conflictCount}；激活闸控生效中）",
  // src/index.ts:1479
  "notice.injection.configHookFailOpen": "config hook fail-open：{exc}",
  // src/index.ts:1541
  "notice.lang.askLocale": "lang ask locale={locale}（{source}）",
  // src/index.ts:1604
  "notice.banner.rulesFailOpen": "rules/banner fail-open：{exc}",
  // src/index.ts:1677
  "notice.relay.persisted": "图片中继：模型 {modelKey} 无视觉输入；已将 {written} 张图片写入磁盘（{relayed} 个图片分段经会话历史中继，会话 {sid}）",
  // src/index.ts:1679
  "notice.relay.failOpen": "图片中继 fail-open（直接放行）：{exc}",
  // src/index.ts:1694
  "notice.ctx.capToolDenied": "子代理 context 上限：已在已终止的会话 {sid} 中拒绝工具 '{tool}'",
  // src/index.ts:1701
  "notice.ctx.capResumeDenied": "子代理 context 上限：拒绝恢复已终止的会话 ses_{taskId}（永久性）",
  // src/index.ts:1727
  "notice.lang.gateDenied": "语言闸门：已在未配置项目的会话 {sid} 中拒绝工具 '{tool}'",
  // src/index.ts:1751
  "notice.search.clarifyFailOpen": "搜索澄清闸门：连续 {maxDenies} 次拒绝且未提问后 fail-open — 会话 {sid} 闸门打开",
  // src/index.ts:1754
  "notice.search.clarifyDenied": "搜索澄清闸门：已在会话 {sid} 中拒绝工具 '{tool}'（搜索范围过广，先提问）（{denyCount}/{maxDenies}）",
  // src/index.ts:1774
  "notice.dispatch.offUngoverned": "dispatch 关闭：任务调用放行、不受治理（subagent_type='{subagentType}'）",
  // src/index.ts:1853
  "notice.dispatch.redirectUninjected": "自动转向 {agent} → {candidate}（shell 未注入；已转向链首候选）",
  // src/index.ts:1874
  "notice.dispatch.redirectBuiltinBlocked": "自动转向 {agent} → {candidate}（内置 agent 已拦截）",
  // src/index.ts:1883 (via src/gates.ts:331 noteUnknownAgent)
  "notice.dispatch.unknownAgentAllowed": "[opencode-switchman] 未知 subagent_type='{agent}'：放行（不在 shell 列表中；内置 agent 不受路由治理）",
  // src/index.ts:1889 (r.note via src/gates.ts:156)
  "notice.dispatch.registryDisabledNote": "[opencode-switchman] {agent} registry=disabled 但矩阵 status={matrixStatus}（非 down）：fail-open，下次探测刷新后自动修正",
  // src/index.ts:1889 (r.note via src/gates.ts:175)
  "notice.dispatch.matrixStatusNote": "[opencode-switchman] {agent} 矩阵 status={matrixStatus}（非 down）：未拦截，探测将在下一轮刷新",
  // src/index.ts:1889 (r.note via src/gates.ts:63 ROUTE_META_SYNTH_NOTE)
  "notice.dispatch.routeMetaSynthNote": "[opencode-switchman] ROUTE_META 缺失/格式错误 — 已由 lane 合成；声明它以启用 review 跨家族 / source=user 语义",
  // src/index.ts:1889 (r.note via src/gates.ts:240 REVIEW_SELF_REVIEW_NOTE)
  "notice.dispatch.reviewSelfNote": "[opencode-switchman] DOWNGRADED：无跨家族审查者可用 — 允许同家族自审；请在审查结论中声明 DOWNGRADED",
  // src/index.ts:1889 (r.note via src/gates.ts:288 poolOverrideNote)
  "notice.dispatch.poolOverrideNote": "pool 配置覆盖：已明确选入此任务池（免除能力层级 floor 限制）",
  // src/index.ts:1897
  "notice.dispatch.redirectDenied": "自动转向 {agent} → {redirect}（{deny}）",
  // src/index.ts:1910
  "notice.dispatch.gatesFailOpen": "六道闸门 fail-open（放行）：{exc}",
  // src/index.ts:1934
  "notice.lang.prefsSaved": "项目语言偏好已保存（{rel}）：conversation={conversation} comments={comments} docs={docs}",
  // src/index.ts:1937
  "notice.lang.gateWaived": "语言闸门：标记提问已完成但未保存配置 — 会话 {sid} 免除闸门",
  // src/index.ts:1943
  "notice.search.scopeAskDone": "搜索澄清：范围提问已完成 — 会话 {sid} 闸门打开",
  // src/index.ts:1956
  "notice.ctx.readBudgetCharge": "读取预算计费 +{charge}（工具 {tool}，回合 {turnUsed}/{turnBudget}）",
  // src/index.ts:1970
  "notice.handover.autoTriggered": "自动交接已触发（{tool} 之后，~{wmTokens} 超过强制压缩 watermark）：完整备份 + 将当前会话的压缩排入队列",
  // src/index.ts:1981
  "notice.handover.backupResult": "自动交接备份 {outcome}：{message}",
  // src/index.ts:1996 (variant 1 of 3)
  "notice.handover.compactionAccepted": "自动交接压缩已接受：session.summarize 已返回（压缩在会话循环上执行）",
  // src/index.ts:1996 (variant 2 of 3)
  "notice.handover.compactionRejected": "自动交接压缩失败：session.summarize 已拒绝（备份仍然有效）",
  // src/index.ts:1996 (variant 3 of 3)
  "notice.handover.compactionNoModel": "自动交接压缩失败：未记录会话模型（chat.params 从未触发）；备份仍然有效",
  // src/index.ts:2008
  "notice.handover.failOpen": "自动交接 fail-open：{exc}",
  // src/index.ts:2114
  "notice.ctx.capTerminated": "子代理 context 上限：会话 {sid}{agentSuffix} 已达 ~{estTokens}k tokens（上限 {capTokens}k）— 工具已拒绝、已要求进度摘要、会话已终止（不得以 task_id 恢复）",
  // src/index.ts:2205
  "notice.provider.modelRetired": "模型已退役（连续 404），已从候选中移除：{provider}/{modelId}",
  // src/index.ts:2208
  "notice.breaker.agentTripped": "{agent} 断路器跳闸（600 秒）：{reason}",
  // src/index.ts:2210
  "notice.breaker.accountingFailOpen": "失败计数 fail-open：{exc}",
  // src/lane.ts:410
  "notice.lane.scoringFallback": "评分失败，回退到规则排序：{exc}",
  // src/lane.ts:494
  "notice.lane.backfillFailed": "回填排名失败（lane 保持为空）：{exc}",
  // src/matrix-manager.ts:196
  "notice.matrix.favoritesScanNoChange": "已扫描收藏/可见集合：激活状态不变（gen={generation}；不重算、不重新探测）",
  // src/matrix-manager.ts:204
  "notice.matrix.invalidModels": "可见集合/收藏包含无效模型（provider 存在但无此 modelId，未生成 shell）：{modelList}",
  // src/matrix-manager.ts:217
  "notice.matrix.persistFailOpen": "激活矩阵持久化 fail-open：{exc}",
  // src/matrix-manager.ts:222
  "notice.matrix.callbackFailOpen": "激活矩阵回调 fail-open：{exc}",
  // src/matrix-manager.ts:250
  "notice.matrix.configReadFailOpen": "配置界面读取 fail-open（视为空）：{exc}",
  // src/matrix-manager.ts:272
  "notice.matrix.watchError": "fs.watch({dir}) 出错，回退 mtime 轮询：{exc}",
  // src/matrix-manager.ts:277
  "notice.matrix.watchStartFailed": "fs.watch({dir}) 启动失败，回退 mtime 轮询：{exc}",
  // src/matrix-manager.ts:308
  "notice.matrix.recomputeFailOpen": "重算 fail-open：{exc}",
  // src/probe.ts:144
  "notice.probe.failOpen": "探测 fail-open：{exc}",
  // src/probe.ts:162
  "notice.probe.incrementalFailOpen": "增量探测 fail-open：{exc}",
  // src/probe.ts:201
  "notice.probe.copilotPoolExhausted": "Copilot 月度额度池已用尽（网关为第二数据源），reset_date 前视为可信",
  // src/probe.ts:207
  "notice.probe.resultsDiscarded": "探测结果已丢弃（矩阵 generation 已变更 {oldGen}->{newGen}；由新 generation 的重算重新调度）",
  // src/probe.ts:214
  "notice.probe.matrixRefreshed": "矩阵已刷新：{comboCount} 个组合中 {okCount} 个成功（共 {totalCount}）",
  // src/probe.ts:233
  "notice.probe.schedulingFailOpen": "探测调度 fail-open：{exc}",
  // src/scoring.ts:399
  "notice.scoring.decisionLogFailOpen": "决策记录 fail-open：{exc}",
  // src/selfupdate.ts:122
  "notice.selfupdate.checkFailOpen": "自更新检查 fail-open：{exc}",
  // src/selfupdate.ts:255
  "notice.selfupdate.upgradeAssetsFailOpen": "upgrade 命令资产 fail-open：{exc}",
  // src/tmux.ts:149 (via log callback wired to appendStatusLog at src/index.ts:236)
  "notice.dispatch.mirrorDisabled": "tmux 面板镜像已禁用（初始化失败）：{message}",
  // src/tmux.ts:221
  "notice.dispatch.mirrorOpFailed": "tmux 面板镜像操作失败（继续执行）：{message}",
  // src/tmux.ts:230
  "notice.dispatch.mirrorPaneFull": "tmux 面板镜像：列已满（{slotCount} 个面板），ses_{sessionId}（{agent}）已排队",
  // src/tmux.ts:280
  "notice.dispatch.mirrorAllClosed": "tmux 面板镜像：所有子代理面板已关闭，主面板已恢复",
  // src/tmux.ts:290
  "notice.dispatch.mirrorDisplayed": "tmux 面板镜像：ses_{sessionId}（{agent}）显示于面板 {pane}",
  // src/tmux.ts:303
  "notice.dispatch.mirrorReconciling": "tmux 面板镜像：检测到已关闭的面板，正在重新校准布局",

  // ---- sidebar (tui.tsx sidebar chrome) ----
  // [2026-09-19]-[sidebar.restartHintPattern (the old RESTART_HINT_RE regex) deliberately NOT a message key: the
  //  structured alert flag on status-log entries replaces regex highlighting; keys are translatable prose only]

  // src/tui.tsx:308
  "sidebar.peakTag": " ·峰值",
  // src/tui.tsx:309
  "sidebar.staleTag": " ·过期",
  // src/tui.tsx:310
  "sidebar.observeOnlyTag": " ·仅观察",
  // src/tui.tsx:346
  "sidebar.updateAvailable": " → {updateVersion}",
  // src/tui.tsx:351
  "sidebar.restartNeeded": " [需重启]",
  // src/tui.tsx:358
  "sidebar.noneAvailable": "无可用项",
  // src/tui.tsx:391 (six-lane panel labels — display-only; runtime lane identifiers/config keys stay English)
  "sidebar.lane.economy": "经济",
  "sidebar.lane.mechanical": "机械",
  "sidebar.lane.main": "主力",
  "sidebar.lane.hard": "困难",
  "sidebar.lane.vision": "视觉",
  "sidebar.lane.review": "评审",
  // src/tui.tsx:368
  "sidebar.noticeLabel": "通知",

  // ---- dialogs (tui.tsx: pool picker / pool models / rank / handover) ----

  // src/tui.tsx:426 (pool picker title)
  "dialog.pool.title": "任务池（选择一个任务池；按 Esc 退出）",
  // src/tui.tsx:428 (pool picker lane row)
  "dialog.pool.laneRow": "{pinMark}{lane}",
  // src/tui.tsx:431 (pool picker option description)
  "dialog.pool.manualSelection": "手动选择：{selCount}/{totalCount} 个模型参与",
  // src/tui.tsx:432 (pool picker option description)
  "dialog.pool.notConfigured": "未配置：系统默认（所有可用模型均参与）",
  // src/tui.tsx:453 (pool models dialog, toggle persist)
  "dialog.pool.toggleWriteFailed": "写入失败：{message}",
  // src/tui.tsx:458 (pool models dialog, toggle toast)
  "dialog.pool.modelToggled": "{verb} {modelKey} {direction} {lane} 任务池（立即生效，侧边栏刷新）",
  // src/tui.tsx:469 (pool models dialog, min-selection guard toast)
  "dialog.pool.keepOneModel": "至少保留一个参与模型；使用“清除配置”可恢复系统默认",
  // src/tui.tsx:482 (pool models dialog, bulk select-all persist)
  "dialog.pool.bulkWriteFailed": "写入失败：{message}",
  // src/tui.tsx:485 (pool models dialog, bulk toast)
  "dialog.pool.allSelected": "{lane} 任务池：已选择所有模型",
  // src/tui.tsx:490 (pool models dialog, clear-config toast)
  "dialog.pool.configCleared": "{lane} 任务池配置已清除（已恢复系统默认候选集）",
  // src/tui.tsx:499 (pool models dialog, uncheck-all toast)
  "dialog.pool.allUnchecked": "{lane} 任务池：已全部取消勾选 — 请勾选要保留的模型；全部未勾选时退出将保持原选择",
  // src/tui.tsx:503 (pool models dialog option)
  "dialog.pool.back": "← 返回任务池列表",
  // src/tui.tsx:504 (pool models dialog option)
  "dialog.pool.selectAll": "☑ 全选",
  // src/tui.tsx:505 (pool models dialog option)
  "dialog.pool.uncheckAll": "☐ 全部取消勾选（之后勾选少数要保留的；全部未勾选时退出将保留原列表）",
  // src/tui.tsx:506 (pool models dialog option)
  "dialog.pool.clearConfig": "✕ 清除配置（系统默认：所有可用模型均参与）",
  // src/tui.tsx:508 (pool models dialog model row)
  "dialog.pool.modelRow": "{checkMark} {modelId}",
  // src/tui.tsx:510 (pool models dialog row description)
  "dialog.pool.rowMeta": "{tier} 级{manualSuffix}",
  // src/tui.tsx:516 (pool models dialog title)
  "dialog.pool.selectionTitle": "{lane} 任务池选择（{selCount}/{rowCount} 个参与；点击切换，允许跨池重复）",
  // src/tui.tsx:538 (rank universe-empty dialog option)
  "dialog.rank.openPoolSelection": "→ 打开任务池选择（先挑选各任务池可用的模型，再进行排名）",
  // src/tui.tsx:539 (rank universe-empty dialog option)
  "dialog.rank.close": "✕ 关闭",
  // src/tui.tsx:543 (rank universe-empty dialog title)
  "dialog.rank.universeEmptyTitle": "配置任务池之前模型排名不可用 — 只有被选入任务池的模型才能排名，绝不会为无法派发的模型排名",
  // src/tui.tsx:561 (rank move at edge toast)
  "dialog.rank.alreadyAtEdge": "{modelName} 已位于合并能力列表的{edge}端",
  // src/tui.tsx:568 (rank move persist)
  "dialog.rank.moveWriteFailed": "写入失败：{message}",
  // src/tui.tsx:573 (rank move/pin toast)
  "dialog.rank.pinnedOrMoved": "{verb} {modelName} 至 #{position}（手动分数 {tier}/{raw}，锚定于相邻模型之间；立即生效，侧边栏刷新）",
  // src/tui.tsx:627 (rank picker title)
  "dialog.rank.title": "模型能力排名 — 合并顺序（#1 最强；范围限任务池选择；手动条目与基础分数模型交错排列；ctrl+up/ctrl+down 移动一位；enter = 单模型操作）",
  // src/tui.tsx:628 (rank picker placeholder)
  "dialog.rank.searchHint": "搜索 · alt+up/alt+down 与 ctrl+up/ctrl+down 等效（同样可用）",
  // src/tui.tsx:630 (rank picker row)
  "dialog.rank.row": "#{rankPadded} {modelId}",
  // src/tui.tsx:632 (rank picker row description)
  "dialog.rank.rowMeta": "{tier} 级 · {scoreSource}{poolSuffix}",
  // src/tui.tsx:662 (rank actions, remove persist)
  "dialog.rank.removeWriteFailed": "写入失败：{message}",
  // src/tui.tsx:665 (rank actions, remove toast)
  "dialog.rank.removed": "已将 {model} 从手动排名中移除（回退到基础能力分数，立即生效，侧边栏刷新）",
  // src/tui.tsx:669 (rank actions option)
  "dialog.rank.pinTop": "▲ 置顶（高于所有模型）",
  // src/tui.tsx:670 (rank actions option)
  "dialog.rank.moveUp": "↑ 上移一位（与上方模型交换；将手动分数锚定于相邻模型之间）",
  // src/tui.tsx:671 (rank actions option)
  "dialog.rank.moveDown": "↓ 下移一位（与下方模型交换）",
  // src/tui.tsx:673 (rank actions option)
  "dialog.rank.remove": "✕ 从排名中移除（回退到基础分数）",
  // src/tui.tsx:675 (rank actions option)
  "dialog.rank.back": "← 返回排名列表",
  // src/tui.tsx:680 (rank actions title)
  "dialog.rank.detailTitle": "{model}（{rankState}）",
  // src/tui.tsx:734 (handover toast)
  "dialog.handover.noSession": "/handover：不在会话中，没有可备份的内容",
  // src/tui.tsx:739 (handover toast)
  "dialog.handover.inProgress": "/handover：正在完整备份当前会话并压缩…",
  // src/tui.tsx:744 (handover toast)
  "dialog.handover.resultStay": "{resultMessage}；仍在原会话，未切换",
  // src/tui.tsx:747 (handover toast)
  "dialog.handover.result": "/handover {resultMessage}",

  // ---- palette (command palette entries) ----

  // src/tui.tsx:770
  "palette.handover.title": "备份并压缩当前会话",
  // src/tui.tsx:771
  "palette.handover.desc": "完整分叉（fork）当前会话作为备份（标题附加 [backup] 标签），并对当前会话进行压缩；不切换会话（有别于内置 /fork）",
  // src/tui.tsx:772 (palette category label)
  "palette.category.label": "switchman",
  // src/tui.tsx:779
  "palette.poolConfig.title": "任务池选择",
  // src/tui.tsx:780
  "palette.poolConfig.desc": "为每个任务池挑选参与的模型（economy/mechanical/main/hard/vision/review）",
  // src/tui.tsx:788
  "palette.modelRank.title": "模型能力排名",
  // src/tui.tsx:789
  "palette.modelRank.desc": "手动能力排名（优先于基础分数；越靠前 = 越强）",

  // ---- quota (quota-brief.json rows; banner.ts builders) ----

  // src/banner.ts:142 (POOL_LABEL)
  "quota.poolGlm": "GLM",
  // src/banner.ts:142 (POOL_LABEL)
  "quota.poolCopilot": "Copilot",
  // src/banner.ts:142 (POOL_LABEL)
  "quota.poolDeepSeek": "DeepSeek",
  // src/banner.ts:166
  "quota.queryingNoData": "查询中/无数据",
  // src/banner.ts:173
  "quota.resetLater": "→稍后",
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
  "quota.rowWeek": "周",
  // src/banner.ts:180 (row label)
  "quota.rowMcp": "MCP",
  // src/banner.ts:181
  "quota.noData": "无额度数据",
  // src/banner.ts:187 (row label)
  "quota.rowRefresh": "刷新",
  // src/banner.ts:188 (row label)
  "quota.rowCredits": "积分",
  // src/banner.ts:188
  "quota.monthlyExhausted": "月度额度已用尽",
  // src/banner.ts:193
  "quota.unlimited": "无上限{usedSuffix}",
  // src/banner.ts:199
  "quota.exhaustedOverage": "已用尽·超额计费{usage}",
  // src/banner.ts:202
  "quota.barPctLeft": "{bar8} 剩余 {pctTxt}%{usage}",
  // src/banner.ts:207 (row label)
  "quota.rowBalance": "余额",
  // src/banner.ts:207
  "quota.exhausted": "已用尽",
  // src/banner.ts:209
  "quota.unknownPayg": "未知（按量付费）",
  // src/banner.ts:213
  "quota.barBalance": "{bar8} ¥{balance}",
  // src/banner.ts:213
  "quota.balanceWarn": "（<¥{thr} 警告）",

  // ---- cli (switchman-config / switchman-doctor) ----

  // src/config-cli.ts:67 (fmtRow, printed at :87)
  "cli.config.poolRow": "#{rankPadded} {checkMark} {modelId}（{tier} 级{manualTag}）",
  // src/config-cli.ts:73 (thrown, surfaced via console.error at :267)
  "cli.config.unknownPool": "未知任务池：{lane}（六个任务池：{laneList}）",
  // src/config-cli.ts:81 (head, printed at :85/:90)
  "cli.config.poolHeader": "任务池选择（配置文件 {poolConfigPath}；选择 = 加入该任务池的模型；同一模型可加入多个任务池；未配置的任务池采用系统默认决策）",
  // src/config-cli.ts:86
  "cli.config.poolSection": "== {lane} ==（{selection}）",
  // src/config-cli.ts:93
  "cli.config.poolSectionBrief": "== {lane} =={detail}",
  // src/config-cli.ts:95
  "cli.config.poolListHint": "（查看单个任务池带编号的完整列表：pool list <{laneList}>）",
  // src/config-cli.ts:105 (thrown, surfaced via console.error at :267)
  "cli.config.indexOutOfRange": "索引超出范围 #{index}（列表共 {rowCount} 项）",
  // src/config-cli.ts:110 (thrown, surfaced via console.error at :267)
  "cli.config.invalidModel": "无效的模型名称：{model}",
  // src/config-cli.ts:124 (thrown, surfaced via console.error at :267)
  "cli.config.noManifest": "没有可用的模型清单（请检查 provider 连接与超集清单）",
  // src/config-cli.ts:129 (thrown, surfaced via console.error at :267)
  "cli.config.poolRequiresArg": "pool {sub} 需要索引或模型名称",
  // src/config-cli.ts:138
  "cli.config.poolSelectionCleared": "{lane} 任务池选择已清除（回到系统默认候选集，立即生效，侧边栏同步刷新）",
  // src/config-cli.ts:139
  "cli.config.poolUpdated": "已更新 {lane} 任务池选择（{modelCount} 个模型参与，立即生效，侧边栏同步刷新）",
  // src/config-cli.ts:145
  "cli.config.poolConfigCleared": "已清除 {lane} 任务池选择配置（该任务池回到系统默认候选集，立即生效，侧边栏同步刷新）",
  // src/config-cli.ts:148 (thrown, surfaced via console.error at :267)
  "cli.config.unknownPoolSub": "未知子命令 pool {sub}（list/add/remove/set/clear）",
  // src/config-cli.ts:186
  "cli.config.rankDisabledUntilPools": "配置任务池之前，手动能力排名（配置文件 {capabilityRankPath}）处于禁用状态：只有被选入任务池的模型才能排名。",
  // src/config-cli.ts:187
  "cli.config.rankHowTo": "请先在此运行 /poolConfig（TUI 对话框）或 pool set <task-pool> <index|model...>，再只为实际使用的模型排名。",
  // src/config-cli.ts:190
  "cli.config.legacyHeader": "== 旧版手动条目（仅用于清理；rank remove/clear 仍可用，或将模型选入任务池以排名）==",
  // src/config-cli.ts:191
  "cli.config.legacyRow": "#{rankPadded} {modelKey}",
  // src/config-cli.ts:197
  "cli.config.rankHeader": "模型能力排名（配置文件 {capabilityRankPath}；范围限通过 /poolConfig 选入任务池的 {universeCount} 个模型 — 单一合并排序，手动条目按有效分数与基础分数模型交错排列；越靠上 = 越强）",
  // src/config-cli.ts:198
  "cli.config.mergedHeader": "== 合并排序（{manualCount} 个手动{manualSuffix}；CLI set/add 按旧版阶梯为条目排序，TUI 将锚定分数移至相邻模型之间）==",
  // src/config-cli.ts:201
  "cli.config.manualTag": "·手动{score}",
  // src/config-cli.ts:203
  "cli.config.notInPoolTag": "·未加入任何任务池",
  // src/config-cli.ts:204
  "cli.config.rankRow": "#{rankPadded} {modelId}（{tier} 级{manualTag}{poolTag}）",
  // src/config-cli.ts:210 (thrown, surfaced via console.error at :267)
  "cli.config.rankNoPools": "尚未进行任务池选择 — 排名遵循任务池选择；请先运行 /poolConfig（或 pool set）",
  // src/config-cli.ts:212 (thrown, surfaced via console.error at :267)
  "cli.config.rankRequiresArg": "rank {sub} 需要索引或模型名称",
  // src/config-cli.ts:237
  "cli.config.rankUpdated": "已更新手动能力排名（{modelCount} 个模型，立即生效，侧边栏同步刷新）",
  // src/config-cli.ts:242
  "cli.config.rankCleared": "已清除手动能力排名（全部回退到基础能力分数，立即生效，侧边栏同步刷新）",
  // src/config-cli.ts:245 (thrown, surfaced via console.error at :267)
  "cli.config.unknownRankSub": "未知子命令 rank {sub}（list/set/add/remove/clear）",
  // src/config-cli.ts:254
  "cli.config.usage": "用法：switchman-config <pool|rank> ...",
  // src/config-cli.ts:255
  "cli.config.usagePoolList": "  pool list [task-pool]             任务池选择概览（economy/mechanical/main/hard/vision/review；带池名 = 显示带索引的完整列表）",
  // src/config-cli.ts:256
  "cli.config.usagePoolAdd": "  pool add <task-pool> <index|model...>    勾选加入该任务池的模型",
  // src/config-cli.ts:257
  "cli.config.usagePoolRemove": "  pool remove <task-pool> <index|model...> 取消勾选参与",
  // src/config-cli.ts:258
  "cli.config.usagePoolSet": "  pool set <task-pool> <index|model...>    完全替换该任务池的参与列表（同一模型可加入多个任务池）",
  // src/config-cli.ts:259
  "cli.config.usagePoolClear": "  pool clear <task-pool>                清除该任务池的配置（回到系统默认候选集）",
  // src/config-cli.ts:260
  "cli.config.usageRankList": "  rank list                      查看手动能力排名（范围限任务池选择；未配置任务池时引导至 /poolConfig）",
  // src/config-cli.ts:261
  "cli.config.usageRankSet": "  rank set <index|model...>         完全重排（按给定顺序，#1 最强；仅限已选入任务池的模型）",
  // src/config-cli.ts:262
  "cli.config.usageRankAdd": "  rank add <index|model...>         追加到排名末尾（仅限已选入任务池的模型）",
  // src/config-cli.ts:263
  "cli.config.usageRankRemove": "  rank remove <index|model...>      从排名中移除",
  // src/config-cli.ts:264
  "cli.config.usageRankClear": "  rank clear                     清除排名（回退到基础能力分数）",
  // src/config-cli.ts:267
  "cli.config.errorPrefix": "switchman-config: {message}",
  // src/doctor-cli.ts:5
  "cli.doctor.usage": "用法：switchman-doctor 检查 opencode-switchman 配置；通过 OPENCODE_CONFIG_DIR 环境变量选择配置目录；退出码 0=无问题、1=警告、2=错误",
  // src/doctor.ts:56 (SWM060 hint)
  "cli.doctor.unknownModelsHint": "{unknownCount} 个模型未被已知系统匹配（未知分组，按系数排到最后）",
  // src/doctor.ts:58 (SWM062 hint)
  "cli.doctor.approxModelsHint": "{approxCount} 个模型按前缀/家族近似分类",
  // src/doctor.ts:72 (SWM044 hint)
  "cli.doctor.configFileHint": "opencode-switchman.jsonc",
  // src/doctor.ts:87
  "cli.doctor.noIssues": "opencode-switchman doctor：未发现问题",
  // src/doctor.ts:89
  "cli.doctor.findingLine": "{level} {code}{pathPart}{hintPart}",
}
