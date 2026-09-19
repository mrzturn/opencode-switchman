// [2026-09-19]-[German message catalog: full-coverage translation of src/locales/en.ts;
//  key completeness and {param} parity are enforced by test/i18n.test.ts]
import type { MsgKey } from "../i18n"

export const de: Partial<Record<MsgKey, string>> = {
  // ---- notices (status log; appendStatusLog) ----

  // src/breaker.ts:37
  "notice.breaker.realCallIsolated": "{agent}-Echtaufruf für {mins} Min. isoliert ({category}): {reason}",
  // src/breaker.ts:48
  "notice.breaker.shellNotInjected": "Shell nicht in opencode injiziert (keine Isolation): {agent} {reason}",
  // src/breaker.ts:200
  "notice.breaker.failOpen": "Breaker fail-open: {exc}",
  // src/capability.ts:246
  "notice.capability.snapshotCorrupted": "Gebündelter Capability-Rank-Snapshot beschädigt (übersprungen, Rückfall auf die kuratierte Tabelle)",
  // src/capability.ts:299
  "notice.capability.primarySourceFailed": "Capability-Index-Primärquelle AA fehlgeschlagen ({exc}){nextStep}",
  // src/capability.ts:311
  "notice.capability.backupSourceFailed": "Capability-Index-Backupquelle OpenRouter fehlgeschlagen ({exc}) -> behalte letzte gute/gebündelte Standardränge",
  // src/capability.ts:316
  "notice.capability.parsedEmpty": "Capability-Index leer geparst ({source}) -> behalte letzte gute/gebündelte Standardränge",
  // src/capability.ts:333
  "notice.capability.refreshed": "Capability-Index aktualisiert: {source} {modelCount} Modelle (version={version})",
  // src/capability.ts:336
  "notice.capability.refreshFailOpen": "Capability-Index-Aktualisierung fail-open (behalte letzte gute/gebündelte Standardränge): {exc}",
  // src/capability.ts:372
  "notice.capability.lmarenaDisagreement": "Capability-LMArena-Quervergleich: Tier-Reihenfolge vs. ELO-Reihenfolge nur {rate}% Übereinstimmung ({overlapCount} überlappende Modelle) -- Datenquelle möglicherweise anomal, manuelle Prüfung empfohlen",
  // src/capability.ts:375
  "notice.capability.lmarenaFailOpen": "Capability-LMArena-Quervergleich fail-open (übersprungen): {exc}",
  // src/catalog.ts:153
  "notice.catalog.unavailableNoCache": "models.dev-Katalog nicht verfügbar und kein Cache (fail-open-Degradation): {exc}",
  // src/copilot-thinking.ts:71
  "notice.copilot.shapeCacheRefreshed": "Copilot-Thinking-Parameter-Shape-Cache aktualisiert: {modelCount} Modelle",
  // src/copilot-thinking.ts:73
  "notice.copilot.shapeRefreshFailOpen": "Copilot-Thinking-Parameter-Shape-Aktualisierung fail-open: {exc}",
  // src/cost.ts:44
  "notice.cost.refreshFailed": "Kosten-Snapshot-Aktualisierung fehlgeschlagen (behalte veraltete Daten): {exc}",
  // src/dispatch-mode.ts:60 (log callback defaults to appendStatusLog)
  "notice.lang.settingsInvalidJson": "[opencode-switchman] {workspaceDirname}/{langSettingsFile} ist kein gültiges JSON — ignoriert (Lang-Konfiguration fällt auf den AGENTS.md-Marker zurück; \"dispatch\":\"off\" nicht angewendet)",
  // src/dispatch-mode.ts:66 (log callback defaults to appendStatusLog)
  "notice.lang.dispatchNotOff": "[opencode-switchman] {workspaceDirname}/{langSettingsFile} \"dispatch\" vorhanden, aber nicht exakt \"off\" (erhalten: {rawValue}) — ignoriert, Fleet-Verhalten",
  // src/index.ts:262
  "notice.ctx.paused": "ctx-Steuerung für Sitzung {sid} pausiert (/ctx-pause): Read-Gates + Self-Read-Budget + Auto-Handover ausgesetzt; Messung läuft weiter",
  // src/index.ts:264
  "notice.ctx.resumed": "ctx-Steuerung für Sitzung {sid} fortgesetzt (/ctx-resume): Read-Gates + Auto-Handover wieder aktiv",
  // src/index.ts:467
  "notice.workspace.created": "Artefakt-Workspace erstellt: {rel}",
  // src/index.ts:468
  "notice.workspace.renamed": "Artefakt-Workspace umbenannt: {oldRel} → {rel}",
  // src/index.ts:542
  "notice.dispatch.mirrorResumeReuse": "tmux-Pane-Spiegelung: Resume-Dispatch ses_{taskId} ({shellName}) — task_id wiederverwendet, Pane direkt geöffnet (kein session.created wird ausgelöst)",
  // src/index.ts:546
  "notice.dispatch.mirrorResumeLookupFailed": "tmux-Pane-Spiegelung: Resume-Dispatch ses_{taskId} ({shellName}) — Sitzungslookup fehlgeschlagen, fail-open-Pane",
  // src/index.ts:574
  "notice.capability.selectionChanged": "Capability-Rang/Task-Pool-Auswahl geändert: Banner und Sidebar werden sofort aktualisiert",
  // src/index.ts:589
  "notice.capability.overrideWatchError": "fs.watch({dir}) Override-Konfigurations-Beobachtungsfehler (mtime-Polling-Fallback): {exc}",
  // src/index.ts:647
  "notice.matrix.configSurfaceFailOpen": "Konfigurationsoberfläche-Lesen fail-open: {exc}",
  // src/index.ts:675
  "notice.matrix.floorFreeModels": "floor = {floorCount} OpenCode-Zen-Free-Modelle (Katalog {catalogStatus})",
  // src/index.ts:676
  "notice.matrix.floorFallback": "floor auf das statische Manifest zurückgefallen (Katalog {catalogStatus}, 0 Free-Modelle)",
  // src/index.ts:680
  "notice.matrix.invalidModelsUnknownProvider": "Sichtbare Menge/Favoriten enthalten ungültige Modelle mit unbekanntem Provider (Provider nicht verbunden; ignoriert, keine Shells gebaut): {modelList}",
  // src/index.ts:778
  "notice.provider.probeAttemptSucceeded": "provider.list-Versuch {attempt} erfolgreich (vorherige {prevAttempts} nicht bereit)",
  // src/index.ts:783
  "notice.provider.probeAttemptBackoff": "provider.list-Versuch {attempt} nicht bereit, warte: {exc}",
  // src/index.ts:789
  "notice.provider.unavailableCfgFallback": "provider.list nicht verfügbar (Rückfall auf {keyCount} cfg.provider-Schlüssel nach {attemptCount} Versuchen): {exc}",
  // src/index.ts:814 (alert)
  "notice.provider.probeNewProvider": "provider.list-Hintergrundprobe: neue Provider verbunden ({providers}) — starten Sie opencode neu, um die Shell-Registrierung abzuschließen",
  // src/index.ts:832 (alert)
  "notice.provider.probeModelDrift": "provider.list-Hintergrundprobe: Modellliste gedriftet ({drift}) — Superset-Manifest neu gebaut, /modelRank-//poolConfig-Listen aktualisiert{restartHint}",
  // src/index.ts:834
  "notice.provider.probeRebuildFailed": "provider.list-Hintergrundprobe: Superset-Neubau fehlgeschlagen (vorheriges Manifest behalten): {exc}",
  // src/index.ts:886
  "notice.probe.warmupFailOpen": "Warmup fail-open: {exc}",
  // src/index.ts:900
  "notice.skills.synced": "Skills synchronisiert: {installedCount} installiert, {updatedCount} aktualisiert, {removedCount} entfernt ({skillNames})",
  // src/index.ts:903
  "notice.skills.syncFailOpen": "Skill-Sync fail-open: {exc}",
  // src/index.ts:1145
  "notice.banner.failOpen": "Banner fail-open: {exc}",
  // src/index.ts:1241
  "notice.ctx.readBudgetContinuation": "Read-Budget-Fortsetzungsabschluss (Datei {fileName}, +{granted} Zeilen ab {offset}, Turn {turnUsed}/{turnBudget})",
  // src/index.ts:1251
  "notice.ctx.readBudgetGateCap": "Read-Budget-Gate-Cap (Tool read, Datei {fileName}, gesch. ~{totalTokens} -> Limit {suggestedLimit}, Turn {turnUsed}/{turnBudget})",
  // src/index.ts:1277 (template built at src/index.ts:1259 as denyLog)
  "notice.ctx.readBudgetGate": "Read-Budget-Gate {action} (Tool {tool}, gesch. ~{totalTokens}{contRem}, C~{wmTokens}, T_est≈{turnsToHard}, Turn {turnUsed}/{turnBudget})",
  // src/index.ts:1281
  "notice.ctx.readBudgetGateFailOpen": "Read-Budget-Gate fail-open (erlaubt): {exc}",
  // src/index.ts:1306
  "notice.image.readGuardDenied": "Bild-Leseschutz: Modell {modelKey} hat keinen Vision-Input; Lesen von {fileName} verweigert (Sitzung {sid})",
  // src/index.ts:1310
  "notice.image.readGuardFailOpen": "Bild-Leseschutz fail-open (erlaubt): {exc}",
  // src/index.ts:1358
  "notice.doctor.summary": "Doctor fand {errorCount} Fehler / {warnCount} Warnungen; /switchman-doctor zur Ansicht ausführen",
  // src/index.ts:1393
  "notice.injection.legacyStaticMatrix": "{shellCount} Modell-Shells injiziert (Agents, legacy statische Matrix)",
  // src/index.ts:1412
  "notice.provider.cacheUsed": "provider.list nutzt Restart-übergreifenden Cache ({providerCount} Provider, gecacht um {cachedAt}); Ergänzungen werden im Hintergrund geprüft",
  // src/index.ts:1419
  "notice.provider.cacheStale": "provider.list-Cache veraltet (gecacht um {cachedAt}), Live-Probe vor dem Superset-Bau",
  // src/index.ts:1469
  "notice.matrix.recomputed": "Aktivierungsmatrix neu berechnet (gen={generation}, aktive Shells {activeShellCount}, Proben {source}×{targetCount})",
  // src/index.ts:1474
  "notice.injection.shellCount": "{shellCount} Shells injiziert (mode={runMode}, Injektionsoberfläche={injectionMode}={fullSupersetCount}→{faceCount} nach Kuratierung, Konflikte {conflictCount}; Aktivierungs-Gating aktiv)",
  // src/index.ts:1479
  "notice.injection.configHookFailOpen": "Konfigurations-Hook fail-open: {exc}",
  // src/index.ts:1541
  "notice.lang.askLocale": "lang-Abfrage locale={locale} ({source})",
  // src/index.ts:1604
  "notice.banner.rulesFailOpen": "Regel/Banner fail-open: {exc}",
  // src/index.ts:1677
  "notice.relay.persisted": "Bild-Relay: Modell {modelKey} hat keinen Vision-Input; {written} Bild(er) auf Platte gespeichert ({relayed} Bildteil(e) über den Sitzungsverlauf weitergeleitet, Sitzung {sid})",
  // src/index.ts:1679
  "notice.relay.failOpen": "Bild-Relay fail-open (durchgereicht): {exc}",
  // src/index.ts:1694
  "notice.ctx.capToolDenied": "Subagent-Kontext-Cap: Tool '{tool}' in beendeter Sitzung {sid} verweigert",
  // src/index.ts:1701
  "notice.ctx.capResumeDenied": "Subagent-Kontext-Cap: Resume der beendeten Sitzung ses_{taskId} verweigert (permanent)",
  // src/index.ts:1727
  "notice.lang.gateDenied": "Lang-Gate: Tool '{tool}' in unkonfigurierter Projektsitzung {sid} verweigert",
  // src/index.ts:1751
  "notice.search.clarifyFailOpen": "Search-Clarify-Gate: fail-open nach {maxDenies} Verweigerungen ohne Nachfrage — Gate offen für Sitzung {sid}",
  // src/index.ts:1754
  "notice.search.clarifyDenied": "Search-Clarify-Gate: Tool '{tool}' verweigert (breite Suche, zuerst fragen) in Sitzung {sid} ({denyCount}/{maxDenies})",
  // src/index.ts:1774
  "notice.dispatch.offUngoverned": "Dispatch off: Task-Aufruf ungeregelt erlaubt (subagent_type='{subagentType}')",
  // src/index.ts:1853
  "notice.dispatch.redirectUninjected": "Auto-Redirect {agent} → {candidate} (nicht injizierte Shell; zum Chain-Head-Kandidaten umgeleitet)",
  // src/index.ts:1874
  "notice.dispatch.redirectBuiltinBlocked": "Auto-Redirect {agent} → {candidate} (eingebauter Agent blockiert)",
  // src/index.ts:1883 (via src/gates.ts:331 noteUnknownAgent)
  "notice.dispatch.unknownAgentAllowed": "[opencode-switchman] unbekannter subagent_type='{agent}': erlaubt (nicht in der Shell-Liste; eingebaute Agents werden nicht durch Routing gesteuert)",
  // src/index.ts:1889 (r.note via src/gates.ts:156)
  "notice.dispatch.registryDisabledNote": "[opencode-switchman] {agent} registry=disabled, aber Matrix-Status={matrixStatus} (nicht down): fail-open, nach der nächsten Probe-Aktualisierung automatisch korrigiert",
  // src/index.ts:1889 (r.note via src/gates.ts:175)
  "notice.dispatch.matrixStatusNote": "[opencode-switchman] {agent} Matrix-Status={matrixStatus} (nicht down): nicht blockiert, Probe aktualisiert nächste Runde",
  // src/index.ts:1889 (r.note via src/gates.ts:63 ROUTE_META_SYNTH_NOTE)
  "notice.dispatch.routeMetaSynthNote": "[opencode-switchman] ROUTE_META fehlt/fehlerhaft — aus lane synthetisiert; deklarieren Sie es, um Review-Cross-Family-/source=user-Semantik zu aktivieren",
  // src/index.ts:1889 (r.note via src/gates.ts:240 REVIEW_SELF_REVIEW_NOTE)
  "notice.dispatch.reviewSelfNote": "[opencode-switchman] DOWNGRADED: kein Cross-Family-Reviewer verfügbar — gleichfamiliäres Self-Review erlaubt; DOWNGRADED im Review-Fazit deklarieren",
  // src/index.ts:1889 (r.note via src/gates.ts:288 poolOverrideNote)
  "notice.dispatch.poolOverrideNote": "Pool-Konfigurations-Override: explizit in diesen Task-Pool gewählt (Capability-Level-Floor aufgehoben)",
  // src/index.ts:1897
  "notice.dispatch.redirectDenied": "Auto-Redirect {agent} → {redirect} ({deny})",
  // src/index.ts:1910
  "notice.dispatch.gatesFailOpen": "Sechs Gates fail-open (erlaubt): {exc}",
  // src/index.ts:1934
  "notice.lang.prefsSaved": "Projekt-Spracheinstellung gespeichert ({rel}): conversation={conversation} comments={comments} docs={docs}",
  // src/index.ts:1937
  "notice.lang.gateWaived": "Lang-Gate: Marker-Frage ohne gespeicherte Konfiguration abgeschlossen — Gate für Sitzung {sid} aufgehoben",
  // src/index.ts:1943
  "notice.search.scopeAskDone": "Search-Clarify: Scope-Abfrage abgeschlossen — Gate offen für Sitzung {sid}",
  // src/index.ts:1956
  "notice.ctx.readBudgetCharge": "Read-Budget-Belastung +{charge} (Tool {tool}, Turn {turnUsed}/{turnBudget})",
  // src/index.ts:1970
  "notice.handover.autoTriggered": "Auto-Handover ausgelöst (nach {tool}, ~{wmTokens} überschreitet die Force-Compaction-Watermark): Vollbackup + eingereihte Kompaktierung der aktuellen Sitzung",
  // src/index.ts:1981
  "notice.handover.backupResult": "Auto-Handover-Backup {outcome}: {message}",
  // src/index.ts:1996 (variant 1 of 3)
  "notice.handover.compactionAccepted": "Auto-Handover-Kompaktierung akzeptiert: session.summarize zurückgekehrt (Kompaktierung lief auf der Session-Loop)",
  // src/index.ts:1996 (variant 2 of 3)
  "notice.handover.compactionRejected": "Auto-Handover-Kompaktierung fehlgeschlagen: session.summarize abgelehnt (Backup besteht)",
  // src/index.ts:1996 (variant 3 of 3)
  "notice.handover.compactionNoModel": "Auto-Handover-Kompaktierung fehlgeschlagen: kein Sitzungsmodell erfasst (chat.params nie ausgelöst); Backup besteht",
  // src/index.ts:2008
  "notice.handover.failOpen": "Auto-Handover fail-open: {exc}",
  // src/index.ts:2114
  "notice.ctx.capTerminated": "Subagent-Kontext-Cap: Sitzung {sid}{agentSuffix} erreichte ~{estTokens}k Tokens (Cap {capTokens}k) — Tools verweigert, Fortschrittszusammenfassung gefordert, Sitzung beendet (kein task_id-Resume)",
  // src/index.ts:2205
  "notice.provider.modelRetired": "Modell außer Dienst (aufeinanderfolgende 404s), aus Kandidaten entfernt: {provider}/{modelId}",
  // src/index.ts:2208
  "notice.breaker.agentTripped": "{agent}-Breaker ausgelöst (600s): {reason}",
  // src/index.ts:2210
  "notice.breaker.accountingFailOpen": "Fehlerabrechnung fail-open: {exc}",
  // src/lane.ts:410
  "notice.lane.scoringFallback": "Scoring fehlgeschlagen, Rückfall auf regelbasierte Reihenfolge: {exc}",
  // src/lane.ts:494
  "notice.lane.backfillFailed": "Backfill-Ranking fehlgeschlagen (lane bleibt leer): {exc}",
  // src/matrix-manager.ts:196
  "notice.matrix.favoritesScanNoChange": "Favoriten/sichtbare Menge gescannt: Aktivierung unverändert (gen={generation}; kein Recompute, kein Re-Probe)",
  // src/matrix-manager.ts:204
  "notice.matrix.invalidModels": "Sichtbare Menge/Favoriten enthalten ungültige Modelle (Provider bekannt, aber keine solche modelId, keine Shell erzeugt): {modelList}",
  // src/matrix-manager.ts:217
  "notice.matrix.persistFailOpen": "Aktivierungsmatrix-Persistierung fail-open: {exc}",
  // src/matrix-manager.ts:222
  "notice.matrix.callbackFailOpen": "Aktivierungsmatrix-Callback fail-open: {exc}",
  // src/matrix-manager.ts:250
  "notice.matrix.configReadFailOpen": "Konfigurationsoberfläche-Lesen fail-open (als leer behandelt): {exc}",
  // src/matrix-manager.ts:272
  "notice.matrix.watchError": "fs.watch({dir}) fehlerhaft, Rückfall auf mtime-Polling: {exc}",
  // src/matrix-manager.ts:277
  "notice.matrix.watchStartFailed": "fs.watch({dir}) Start fehlgeschlagen, Rückfall auf mtime-Polling: {exc}",
  // src/matrix-manager.ts:308
  "notice.matrix.recomputeFailOpen": "Recompute fail-open: {exc}",
  // src/probe.ts:144
  "notice.probe.failOpen": "Probe fail-open: {exc}",
  // src/probe.ts:162
  "notice.probe.incrementalFailOpen": "Inkrementelle Probe fail-open: {exc}",
  // src/probe.ts:201
  "notice.probe.copilotPoolExhausted": "Copilot-Monatspool erschöpft (Gateway zweite Source of Truth), vertraut bis reset_date",
  // src/probe.ts:207
  "notice.probe.resultsDiscarded": "Proben-Ergebnisse verworfen (Matrix-Generation wechselte {oldGen}->{newGen}; durch Recompute der neuen Generation neu geplant)",
  // src/probe.ts:214
  "notice.probe.matrixRefreshed": "Matrix aktualisiert: {comboCount} Kombos {okCount} ok (gesamt {totalCount})",
  // src/probe.ts:233
  "notice.probe.schedulingFailOpen": "Probe-Planung fail-open: {exc}",
  // src/scoring.ts:399
  "notice.scoring.decisionLogFailOpen": "Entscheidungslog fail-open: {exc}",
  // src/selfupdate.ts:122
  "notice.selfupdate.checkFailOpen": "Self-Update-Prüfung fail-open: {exc}",
  // src/selfupdate.ts:255
  "notice.selfupdate.upgradeAssetsFailOpen": "Upgrade-Command-Assets fail-open: {exc}",
  // src/tmux.ts:149 (via log callback wired to appendStatusLog at src/index.ts:236)
  "notice.dispatch.mirrorDisabled": "tmux-Pane-Spiegelung deaktiviert (Init fehlgeschlagen): {message}",
  // src/tmux.ts:221
  "notice.dispatch.mirrorOpFailed": "tmux-Pane-Spiegelungs-Op fehlgeschlagen (wird fortgesetzt): {message}",
  // src/tmux.ts:230
  "notice.dispatch.mirrorPaneFull": "tmux-Pane-Spiegelung: Spalte voll ({slotCount} Panes), ses_{sessionId} ({agent}) eingereiht",
  // src/tmux.ts:280
  "notice.dispatch.mirrorAllClosed": "tmux-Pane-Spiegelung: alle Subagent-Panes geschlossen, Haupt-Pane wiederhergestellt",
  // src/tmux.ts:290
  "notice.dispatch.mirrorDisplayed": "tmux-Pane-Spiegelung: ses_{sessionId} ({agent}) in Pane {pane} angezeigt",
  // src/tmux.ts:303
  "notice.dispatch.mirrorReconciling": "tmux-Pane-Spiegelung: geschlossene Pane(s) erkannt, Layout wird abgeglichen",

  // ---- sidebar (tui.tsx sidebar chrome) ----

  // src/tui.tsx:308
  "sidebar.peakTag": " ·Peak",
  // src/tui.tsx:309
  "sidebar.staleTag": " ·veraltet",
  // src/tui.tsx:310
  "sidebar.observeOnlyTag": " ·observe-only",
  // src/tui.tsx:346
  "sidebar.updateAvailable": " → {updateVersion}",
  // src/tui.tsx:351
  "sidebar.restartNeeded": " [NEUSTART ERFORDERLICH]",
  // src/tui.tsx:358
  "sidebar.noneAvailable": "keine verfügbar",
  // src/tui.tsx:391 (six-lane panel labels — display-only; runtime lane identifiers/config keys stay English)
  "sidebar.lane.economy": "Ökonomie",
  "sidebar.lane.mechanical": "Mechanik",
  "sidebar.lane.main": "Haupt",
  "sidebar.lane.hard": "Schwer",
  "sidebar.lane.vision": "Vision",
  "sidebar.lane.review": "Review",
  // src/tui.tsx:368
  "sidebar.noticeLabel": "Hinweis",

  // ---- dialogs (tui.tsx: pool picker / pool models / rank / handover) ----

  // src/tui.tsx:426 (pool picker title)
  "dialog.pool.title": "Task-Pools (Task-Pool wählen; Esc zum Beenden)",
  // src/tui.tsx:428 (pool picker lane row)
  "dialog.pool.laneRow": "{pinMark}{lane}",
  // src/tui.tsx:431 (pool picker option description)
  "dialog.pool.manualSelection": "manuelle Auswahl: {selCount}/{totalCount} Modelle nehmen teil",
  // src/tui.tsx:432 (pool picker option description)
  "dialog.pool.notConfigured": "nicht konfiguriert: Systemstandard (alle verfügbaren Modelle nehmen teil)",
  // src/tui.tsx:453 (pool models dialog, toggle persist)
  "dialog.pool.toggleWriteFailed": "Schreiben fehlgeschlagen: {message}",
  // src/tui.tsx:458 (pool models dialog, toggle toast)
  "dialog.pool.modelToggled": "{verb} {modelKey} {direction} den {lane}-Pool (sofort wirksam, Sidebar aktualisiert)",
  // src/tui.tsx:469 (pool models dialog, min-selection guard toast)
  "dialog.pool.keepOneModel": "Behalten Sie mindestens ein teilnehmendes Modell; nutzen Sie \"Clear config\", um den Systemstandard wiederherzustellen",
  // src/tui.tsx:482 (pool models dialog, bulk select-all persist)
  "dialog.pool.bulkWriteFailed": "Schreiben fehlgeschlagen: {message}",
  // src/tui.tsx:485 (pool models dialog, bulk toast)
  "dialog.pool.allSelected": "{lane}-Pool: alle Modelle ausgewählt",
  // src/tui.tsx:490 (pool models dialog, clear-config toast)
  "dialog.pool.configCleared": "{lane}-Pool-Konfiguration gelöscht (Systemstandard-Kandidatenmenge wiederhergestellt)",
  // src/tui.tsx:499 (pool models dialog, uncheck-all toast)
  "dialog.pool.allUnchecked": "{lane}-Pool: alle abgewählt — markieren Sie die zu behaltenden Modelle; Beenden ohne Auswahl behält die vorherige Auswahl",
  // src/tui.tsx:503 (pool models dialog option)
  "dialog.pool.back": "← Zurück zur Pool-Liste",
  // src/tui.tsx:504 (pool models dialog option)
  "dialog.pool.selectAll": "☑ Alle auswählen",
  // src/tui.tsx:505 (pool models dialog option)
  "dialog.pool.uncheckAll": "☐ Alle abwählen (dann die wenigen zu behaltenden markieren; Beenden ohne Auswahl behält die alte Liste)",
  // src/tui.tsx:506 (pool models dialog option)
  "dialog.pool.clearConfig": "✕ Konfiguration löschen (Systemstandard: alle verfügbaren Modelle nehmen teil)",
  // src/tui.tsx:508 (pool models dialog model row)
  "dialog.pool.modelRow": "{checkMark} {modelId}",
  // src/tui.tsx:510 (pool models dialog row description)
  "dialog.pool.rowMeta": "{tier}-Tier{manualSuffix}",
  // src/tui.tsx:516 (pool models dialog title)
  "dialog.pool.selectionTitle": "{lane}-Pool-Auswahl ({selCount}/{rowCount} teilnehmend; Auswahl schaltet um, Duplikate über Pools erlaubt)",
  // src/tui.tsx:538 (rank universe-empty dialog option)
  "dialog.rank.openPoolSelection": "→ Task-Pool-Auswahl öffnen (wählen Sie die Modelle pro Pool, dann ranken)",
  // src/tui.tsx:539 (rank universe-empty dialog option)
  "dialog.rank.close": "✕ Schließen",
  // src/tui.tsx:543 (rank universe-empty dialog title)
  "dialog.rank.universeEmptyTitle": "Modellranking ist deaktiviert, bis Task-Pools konfiguriert sind — nur in Task-Pools gewählte Modelle sind rankbar, so ranken Sie nie Modelle, die Sie nicht dispatchen können",
  // src/tui.tsx:561 (rank move at edge toast)
  "dialog.rank.alreadyAtEdge": "{modelName} ist bereits am {edge} der zusammengeführten Capability-Liste",
  // src/tui.tsx:568 (rank move persist)
  "dialog.rank.moveWriteFailed": "Schreiben fehlgeschlagen: {message}",
  // src/tui.tsx:573 (rank move/pin toast)
  "dialog.rank.pinnedOrMoved": "{verb} {modelName} auf #{position} (manueller Score {tier}/{raw}, zwischen Nachbarn verankert; sofort wirksam, Sidebar aktualisiert)",
  // src/tui.tsx:627 (rank picker title)
  "dialog.rank.title": "Modell-Capability-Ranking — zusammengeführte Reihenfolge (#1 stärkstes; begrenzt auf die Task-Pool-Auswahl; manuelle Einträge mischen sich mit Basis-Score-Modellen; Strg+hoch/Strg+runter bewegt einen Platz; Enter = Aktionen pro Modell)",
  // src/tui.tsx:628 (rank picker placeholder)
  "dialog.rank.searchHint": "Suche · Alt+hoch/Alt+runter spiegelt Strg+hoch/Strg+runter (funktioniert auch)",
  // src/tui.tsx:630 (rank picker row)
  "dialog.rank.row": "#{rankPadded} {modelId}",
  // src/tui.tsx:632 (rank picker row description)
  "dialog.rank.rowMeta": "{tier}-Tier · {scoreSource}{poolSuffix}",
  // src/tui.tsx:662 (rank actions, remove persist)
  "dialog.rank.removeWriteFailed": "Schreiben fehlgeschlagen: {message}",
  // src/tui.tsx:665 (rank actions, remove toast)
  "dialog.rank.removed": "{model} aus dem manuellen Ranking entfernt (fällt auf den Basis-Capability-Score zurück, sofort wirksam, Sidebar aktualisiert)",
  // src/tui.tsx:669 (rank actions option)
  "dialog.rank.pinTop": "▲ Ganz oben anpinnen (über allen Modellen)",
  // src/tui.tsx:670 (rank actions option)
  "dialog.rank.moveUp": "↑ Einen nach oben (tauscht mit dem Modell darüber; verankert manuellen Score zwischen Nachbarn)",
  // src/tui.tsx:671 (rank actions option)
  "dialog.rank.moveDown": "↓ Einen nach unten (tauscht mit dem Modell darunter)",
  // src/tui.tsx:673 (rank actions option)
  "dialog.rank.remove": "✕ Aus Ranking entfernen (zum Basisscore zurück)",
  // src/tui.tsx:675 (rank actions option)
  "dialog.rank.back": "← Zurück zur Ranking-Liste",
  // src/tui.tsx:680 (rank actions title)
  "dialog.rank.detailTitle": "{model} ({rankState})",
  // src/tui.tsx:734 (handover toast)
  "dialog.handover.noSession": "/handover: nicht in einer Sitzung, nichts zu sichern",
  // src/tui.tsx:739 (handover toast)
  "dialog.handover.inProgress": "/handover: aktuelle Sitzung wird vollständig gesichert und kompaktiert…",
  // src/tui.tsx:744 (handover toast)
  "dialog.handover.resultStay": "{resultMessage}; noch in der ursprünglichen Sitzung, nicht gewechselt",
  // src/tui.tsx:747 (handover toast)
  "dialog.handover.result": "/handover {resultMessage}",

  // ---- palette (command palette entries) ----

  // src/tui.tsx:770
  "palette.handover.title": "Aktuelle Sitzung sichern und kompaktieren",
  // src/tui.tsx:771
  "palette.handover.desc": "Vollständiger Fork der aktuellen Sitzung als Backup ([backup]-Titel-Tag) plus Kompaktierung der aktuellen Sitzung; kein Sitzungswechsel (anders als eingebautes /fork)",
  // src/tui.tsx:772 (palette category label)
  "palette.category.label": "switchman",
  // src/tui.tsx:779
  "palette.poolConfig.title": "Task-Pool-Auswahl",
  // src/tui.tsx:780
  "palette.poolConfig.desc": "Teilnehmende Modelle pro Task-Pool wählen (economy/mechanical/main/hard/vision/review)",
  // src/tui.tsx:788
  "palette.modelRank.title": "Modell-Capability-Ranking",
  // src/tui.tsx:789
  "palette.modelRank.desc": "Manuelles Capability-Ranking (hat Vorrang vor Basisscores; weiter oben = stärker)",

  // ---- quota (quota-brief.json rows; banner.ts builders) ----

  // src/banner.ts:142 (POOL_LABEL)
  "quota.poolGlm": "GLM",
  // src/banner.ts:142 (POOL_LABEL)
  "quota.poolCopilot": "Copilot",
  // src/banner.ts:142 (POOL_LABEL)
  "quota.poolDeepSeek": "DeepSeek",
  // src/banner.ts:166
  "quota.queryingNoData": "Abfrage/keine Daten",
  // src/banner.ts:173
  "quota.resetLater": "→später",
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
  "quota.rowWeek": "Woche",
  // src/banner.ts:180 (row label)
  "quota.rowMcp": "MCP",
  // src/banner.ts:181
  "quota.noData": "keine Kontingentdaten",
  // src/banner.ts:187 (row label)
  "quota.rowRefresh": "Aktualisierung",
  // src/banner.ts:188 (row label)
  "quota.rowCredits": "Guthaben",
  // src/banner.ts:188
  "quota.monthlyExhausted": "Monatspool erschöpft",
  // src/banner.ts:193
  "quota.unlimited": "unbegrenzt{usedSuffix}",
  // src/banner.ts:199
  "quota.exhaustedOverage": "erschöpft·Overage-Abrechnung{usage}",
  // src/banner.ts:202
  "quota.barPctLeft": "{bar8} {pctTxt}% übrig{usage}",
  // src/banner.ts:207 (row label)
  "quota.rowBalance": "Saldo",
  // src/banner.ts:207
  "quota.exhausted": "erschöpft",
  // src/banner.ts:209
  "quota.unknownPayg": "unbekannt (Pay-as-you-go)",
  // src/banner.ts:213
  "quota.barBalance": "{bar8} ¥{balance}",
  // src/banner.ts:213
  "quota.balanceWarn": "(<¥{thr} Warnung)",

  // ---- cli (switchman-config / switchman-doctor) ----

  // src/config-cli.ts:67 (fmtRow, printed at :87)
  "cli.config.poolRow": "#{rankPadded} {checkMark} {modelId} ({tier}-Tier{manualTag})",
  // src/config-cli.ts:73 (thrown, surfaced via console.error at :267)
  "cli.config.unknownPool": "unbekannter Task-Pool: {lane} (sechs Task-Pools: {laneList})",
  // src/config-cli.ts:81 (head, printed at :85/:90)
  "cli.config.poolHeader": "Task-Pool-Auswahl (Konfigurationsdatei {poolConfigPath}; Auswahl = die Modelle, die diesem Task-Pool beitreten; dasselbe Modell kann mehreren Pools beitreten; unkonfigurierte Pools nutzen die Systemstandard-Entscheidung)",
  // src/config-cli.ts:86
  "cli.config.poolSection": "== {lane} == ({selection})",
  // src/config-cli.ts:93
  "cli.config.poolSectionBrief": "== {lane} =={detail}",
  // src/config-cli.ts:95
  "cli.config.poolListHint": "(vollständige Liste eines einzelnen Pools mit Nummern anzeigen: pool list <{laneList}>)",
  // src/config-cli.ts:105 (thrown, surfaced via console.error at :267)
  "cli.config.indexOutOfRange": "Index außerhalb des Bereichs #{index} (Liste hat {rowCount} Einträge)",
  // src/config-cli.ts:110 (thrown, surfaced via console.error at :267)
  "cli.config.invalidModel": "ungültiger Modellname: {model}",
  // src/config-cli.ts:124 (thrown, surfaced via console.error at :267)
  "cli.config.noManifest": "kein verfügbares Modellmanifest (Provider-Verbindungen und Superset-Manifest prüfen)",
  // src/config-cli.ts:129 (thrown, surfaced via console.error at :267)
  "cli.config.poolRequiresArg": "pool {sub} erfordert einen Index oder Modellnamen",
  // src/config-cli.ts:138
  "cli.config.poolSelectionCleared": "{lane}-Task-Pool-Auswahl gelöscht (zurück zur Systemstandard-Kandidatenmenge, sofort wirksam, Sidebar aktualisiert synchron)",
  // src/config-cli.ts:139
  "cli.config.poolUpdated": "{lane}-Task-Pool-Auswahl aktualisiert ({modelCount} teilnehmende Modelle, sofort wirksam, Sidebar aktualisiert synchron)",
  // src/config-cli.ts:145
  "cli.config.poolConfigCleared": "{lane}-Task-Pool-Auswahlkonfiguration gelöscht (dieser Pool kehrt zur Systemstandard-Kandidatenmenge zurück, sofort wirksam, Sidebar aktualisiert synchron)",
  // src/config-cli.ts:148 (thrown, surfaced via console.error at :267)
  "cli.config.unknownPoolSub": "unbekannter Unterbefehl pool {sub} (list/add/remove/set/clear)",
  // src/config-cli.ts:186
  "cli.config.rankDisabledUntilPools": "Manuelles Capability-Ranking (Konfigurationsdatei {capabilityRankPath}) ist deaktiviert, bis Task-Pools konfiguriert sind: nur in Task-Pools gewählte Modelle sind rankbar.",
  // src/config-cli.ts:187
  "cli.config.rankHowTo": "Führen Sie hier zuerst /poolConfig (TUI-Dialog) oder pool set <task-pool> <index|model...> aus, dann ranken Sie nur die Modelle, die Sie tatsächlich nutzen.",
  // src/config-cli.ts:190
  "cli.config.legacyHeader": "== Legacy manuelle Einträge (nur Bereinigung; rank remove/clear funktionieren weiter, oder wählen Sie die Modelle in einen Task-Pool, um sie zu ranken) ==",
  // src/config-cli.ts:191
  "cli.config.legacyRow": "#{rankPadded} {modelKey}",
  // src/config-cli.ts:197
  "cli.config.rankHeader": "Modell-Capability-Ranking (Konfigurationsdatei {capabilityRankPath}; begrenzt auf die {universeCount} via /poolConfig in Task-Pools gewählten Modelle — eine zusammengeführte Reihenfolge, manuelle Einträge mischen sich per effektivem Score mit Basis-Score-Modellen; weiter oben = stärker)",
  // src/config-cli.ts:198
  "cli.config.mergedHeader": "== Zusammengeführte Reihenfolge ({manualCount} manuell{manualSuffix}; CLI set/add ordnet Einträge per Legacy-Leiter, TUI-Moves verankern Scores zwischen Nachbarn) ==",
  // src/config-cli.ts:201
  "cli.config.manualTag": "·manuell{score}",
  // src/config-cli.ts:203
  "cli.config.notInPoolTag": "·in keinem Task-Pool",
  // src/config-cli.ts:204
  "cli.config.rankRow": "#{rankPadded} {modelId} ({tier}-Tier{manualTag}{poolTag})",
  // src/config-cli.ts:210 (thrown, surfaced via console.error at :267)
  "cli.config.rankNoPools": "noch keine Task-Pool-Auswahl — Ranking folgt der Pool-Auswahl; zuerst /poolConfig (oder pool set) ausführen",
  // src/config-cli.ts:212 (thrown, surfaced via console.error at :267)
  "cli.config.rankRequiresArg": "rank {sub} erfordert einen Index oder Modellnamen",
  // src/config-cli.ts:237
  "cli.config.rankUpdated": "Manuelles Capability-Ranking aktualisiert ({modelCount} Modelle, sofort wirksam, Sidebar aktualisiert synchron)",
  // src/config-cli.ts:242
  "cli.config.rankCleared": "Manuelles Capability-Ranking gelöscht (alles fällt auf den Basis-Capability-Score zurück, sofort wirksam, Sidebar aktualisiert synchron)",
  // src/config-cli.ts:245 (thrown, surfaced via console.error at :267)
  "cli.config.unknownRankSub": "unbekannter Unterbefehl rank {sub} (list/set/add/remove/clear)",
  // src/config-cli.ts:254
  "cli.config.usage": "Verwendung: switchman-config <pool|rank> ...",
  // src/config-cli.ts:255
  "cli.config.usagePoolList": "  pool list [task-pool]             Pool-Auswahlübersicht (economy/mechanical/main/hard/vision/review; mit Pool-Namen = vollständige Liste mit Indizes)",
  // src/config-cli.ts:256
  "cli.config.usagePoolAdd": "  pool add <task-pool> <index|model...>    Modelle für diesen Task-Pool markieren",
  // src/config-cli.ts:257
  "cli.config.usagePoolRemove": "  pool remove <task-pool> <index|model...> Teilnahme entmarkieren",
  // src/config-cli.ts:258
  "cli.config.usagePoolSet": "  pool set <task-pool> <index|model...>    Teilnahmeliste dieses Pools vollständig ersetzen (dasselbe Modell kann mehreren Pools beitreten)",
  // src/config-cli.ts:259
  "cli.config.usagePoolClear": "  pool clear <task-pool>                Konfiguration dieses Pools löschen (zurück zur Systemstandard-Kandidatenmenge)",
  // src/config-cli.ts:260
  "cli.config.usageRankList": "  rank list                      Manuelles Capability-Ranking anzeigen (begrenzt auf die Task-Pool-Auswahl; verweist auf /poolConfig, wenn kein Pool konfiguriert ist)",
  // src/config-cli.ts:261
  "cli.config.usageRankSet": "  rank set <index|model...>         Vollständig neu ordnen (in der angegebenen Reihenfolge, #1 ist stärkstes; nur Pool-gewählte Modelle)",
  // src/config-cli.ts:262
  "cli.config.usageRankAdd": "  rank add <index|model...>         Ans Ende des Rankings anhängen (nur Pool-gewählte Modelle)",
  // src/config-cli.ts:263
  "cli.config.usageRankRemove": "  rank remove <index|model...>      Aus dem Ranking entfernen",
  // src/config-cli.ts:264
  "cli.config.usageRankClear": "  rank clear                     Ranking löschen (zum Basis-Capability-Score zurück)",
  // src/config-cli.ts:267
  "cli.config.errorPrefix": "switchman-config: {message}",
  // src/doctor-cli.ts:5
  "cli.doctor.usage": "Verwendung: switchman-doctor prüft die opencode-switchman-Konfiguration; die Umgebungsvariable OPENCODE_CONFIG_DIR wählt das Konfigurationsverzeichnis; Exit-Codes 0=keine Probleme, 1=Warnungen, 2=Fehler",
  // src/doctor.ts:56 (SWM060 hint)
  "cli.doctor.unknownModelsHint": "{unknownCount} Modelle vom bekannten System nicht zugeordnet (unbekannte Gruppe, per Koeffizient nach unten gerankt)",
  // src/doctor.ts:58 (SWM062 hint)
  "cli.doctor.approxModelsHint": "{approxCount} Modelle approximativ per Präfix/Familie klassifiziert",
  // src/doctor.ts:72 (SWM044 hint)
  "cli.doctor.configFileHint": "opencode-switchman.jsonc",
  // src/doctor.ts:87
  "cli.doctor.noIssues": "opencode-switchman doctor: keine Probleme gefunden",
  // src/doctor.ts:89
  "cli.doctor.findingLine": "{level} {code}{pathPart}{hintPart}",
}
