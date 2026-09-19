# opencode-switchman

[English](./README.md) | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | **Deutsch** | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **Du nutzt auch zcode?** Wirf einen Blick auf [zcode-switchman](https://github.com/mrzturn/zcode-switchman) — ein Schwesterprojekt desselben Autors, das dieselbe Orchestrierung für zcode-Nutzer bereitstellt.

> Kontext auf dem Tacho. Aufgaben verteilen sich von selbst.

![opencode-switchman — the context water level drives the switchman and throws the route](docs/assets/hero.svg)

> Interaktive Demo-Präsentation: [opencode-switchman in Aktion](https://mrzturn.github.io/opencode-switchman/)

Ein Orchestrierungs-Plugin für [OpenCode](https://opencode.ai). Es tut zwei Dinge — und tut sie richtig gut:

**1. Kontext-Pegelstandskontrolle.** Der Kontext deiner Session wird in jeder Runde gemessen. Lesevorgänge laufen gegen ein Budget pro Runde, sodass das Modell nicht im Stillen das ganze Repo schlürfen kann; Soft-/Hard-/Force-Wassermarken lösen erst Hinweise aus, dann Aufräumen, dann eine automatische Übergabe mit Backup und Komprimierung; jeder abgeschickte Subagent trägt sein eigenes hartes Limit. Der Kontext hört auf, sich wie ein Schneeball aufzublähen — eine Session kann den ganzen Tag laufen, ohne dass Tokens von der eigenen History aufgefressen werden.

**2. Automatisierte Entscheidungs-Delegation.** Dein primäres Modell wird zum Dispatcher: Es profiliert jede Aufgabe und delegiert sie an Subagent-Shells über sechs kognitive Spuren (economy / mechanical / main / hard / vision / review). Das Plugin erzwingt deterministische Gates, gewichtetes Modell-Scoring und selbstheilende Fehlerisolierung und protokolliert jede Routing-Entscheidung.

Darüber hinaus:

- **Mehrere Modelle oder Abos? Dieses Plugin wurde genau dafür gebaut.** GitHub Copilot, GLM Coding Plan, DeepSeek — oder jeder andere opencode-Provider — werden als ein einziger Pool orchestriert: kontingentbewusste Reihenfolge, Vermeidung von Spitzenfenstern, erzwungenes Review über Modellfamilien hinweg.
- **Nur ein Modell? Trotzdem lohnt es sich.** Die Kontextkontrolle und das smarte Dispatching allein halten ein einzelnes Modell unbegrenzt nutzbar — egal wie lange die Session läuft, der Kontext bläht sich nie auf.

## Installation

Ein Befehl — deckt die Erstinstallation und spätere Updates ab. Danach opencode neu starten.

```bash
curl -fsSL https://raw.githubusercontent.com/mrzturn/opencode-switchman/main/scripts/setup.sh | bash
```

oder

```bash
npx -y opencode-switchman@latest
```

oder

```bash
bunx opencode-switchman@latest
```

Beide Wege schreiben den `plugin`-Eintrag in deiner opencode-Konfiguration auf die exakte neueste Version um und räumen veraltete Caches weg. Manuelle npm-Installation, Build aus dem Quellcode und der Hinweis „Warum exakte Versionen": [Installationsdetails](./docs/reference.md#installation).

Lieber alles delegieren? Lass deine KI die Installation erledigen — füge diesen Prompt in die KI deiner Wahl ein:

<details open>
<summary><strong>KI-gestützter Installations-Prompt</strong></summary>

```text
Bitte installiere und konfiguriere das opencode-switchman-Plugin für mein opencode, strikt nach seinen offiziellen Anweisungen.

Offizielle Quellen (maßgeblich, nicht aus dem Gedächtnis raten):
- GitHub-Repo: https://github.com/mrzturn/opencode-switchman
- npm-Paket: https://www.npmjs.com/package/opencode-switchman
Lies den Abschnitt „Installation" in der README des Repos und befolge ihn exakt.

Schritte:
1. Installiere die auf npm veröffentlichte neueste Version: führe `npx -y opencode-switchman@latest` aus (oder `bunx opencode-switchman@latest`) — es schreibt den `plugin`-Eintrag in meiner opencode-Konfiguration auf die exakte neueste Version um (es funktioniert auch in der `opencode.json` auf Projektebene, falls ich diese verwende).
2. Vervollständige die funktionale Konfiguration: alle Plugin-Einstellungen liegen in der eigenständigen `opencode-switchman.jsonc` in meinem opencode-Konfigurationsverzeichnis, die beim ersten Start automatisch mit Standardwerten und Inline-Kommentaren erzeugt wird; prüfe sie gegen meine Provider (z. B. `zhipuai-coding-plan` / `deepseek` / `github-copilot`) und passe sie bei Bedarf an.
3. Verifiziere, dass opencode das Plugin lädt, startet und ausführt: führe `/switchman-doctor` in opencode aus für einen lokalen Diagnosebericht ohne Zugangsdaten und behebe jeden gemeldeten Fehler; starte opencode dann neu und bestätige, dass das Plugin tatsächlich geladen wurde — das Log sollte `[opencode-switchman] injected N model shells (agents)` enthalten und der System-Prompt meines primären Modells sollte den aktuellen `[ROUTES]/[WATERMARK]/[LIMITS]`-Bannerblock tragen.

Erkläre keinen Erfolg, bevor alle drei Schritte bestanden sind; berichte, was du geändert hast, und zeige die Verifikationsnachweise.
```

</details>

**Voraussetzungen**: [opencode](https://opencode.ai), CLI/TUI empfohlen (Dialoge, Seitenleiste und Banner sind dort am umfangreichsten; die Desktop-App teilt dieselbe Konfiguration und denselben Zustand). Jeder Provider funktioniert; Copilot / GLM / DeepSeek erhalten zusätzlich kontingentbewusstes Routing. Zugangsdaten werden ausschließlich lesend aus opencodes eigener Auth gelesen — das Plugin speichert niemals Secrets.

## Schnellstart

Sechs Schritte. Komplette Anleitung mit Screenshots: **[docs/quick-start.md](./docs/quick-start.md)** / [中文](./docs/quick-start.zh.md).

1. **Provider verbinden** — `/connect` in der TUI: Copilot-OAuth, DeepSeek-API-Key; GLM Coding Plan landet als benutzerdefinierter Provider `zhipuai-coding-plan` in der `opencode.json`.
2. **Modelle auswählen, die an der Orchestrierung teilnehmen** — `/models`, dann `ctrl+f` zum Favorisieren (Desktop-App: Schalter unter „Modelle verwalten").
3. **`/switchman-setup`** *(einmalig erforderlich)* — der geführte Assistent deckt die gesamte Matrix in einem Durchgang ab: wähle für jeden der sechs Task-Pools mindestens ein Modell aus (economy / mechanical / main / hard / vision / review) und ordne die gewählten Modelle dann vom stärksten zum schwächsten. Keine TUI? `/switchman-setup-chat` führt denselben geführten Ablauf im Chat aus. Bis zum Abschluss des Setups ist Task-Dispatching hart blockiert — unkonfigurierte Pools fallen nicht mehr auf „alle Modelle" zurück. Gespeicherte Konfiguration wird per Hot-Reload übernommen; ein Neustart ist nur nötig, um völlig neue Provider zu registrieren.
4. **Feintuning** *(optional)* — **`/modelRank`** stimmt das Fähigkeits-Ranking von Hand ab und **`/poolConfig`** kuratiert die Kandidatenlisten pro Pool in TUI-Dialogen (`-chat`-Varianten im Chat); manuelle Einträge überschreiben überall die anfänglichen Standardwerte.
5. **Kontext-Befehle**
   - **`/handover`** — sichert die Session und komprimiert sie selbst. Nutze sie, wenn die `[WATERMARK:SESSION]`-Zeile groß wird oder die Aufgabe einen guten Stopp-Punkt erreicht, statt auf die automatische Übergabe zu warten.
   - **`/ctx-pause`** — schaltet die Lese-Limits dieser Session und die Auto-Übergabe aus. Nutze sie, wenn du viele große Dateien auf einmal lesen musst und Tokens auszugeben dir nichts ausmacht; die Messung läuft weiter.
   - **`/ctx-resume`** — schaltet die Limits wieder ein. Nutze sie, sobald das intensive Lesen erledigt ist; ein Neustart von opencode hat denselben Effekt.
6. **Neu starten und prüfen** — kontrolliere das `[ROUTES]`/`[LIMITS]`-Banner und das `switchman`-Panel in der Seitenleiste; führe `/switchman-doctor` aus, falls etwas ungewöhnlich wirkt. Danach nutze opencode einfach wie gewohnt.

## Was du bekommst

**Kernfunktionen**

- **Kontext-Pegelstandskontrolle** — Live-Messung der Session (`[WATERMARK:SESSION]`), Soft-/Hard-/Force-Schwellenwerte, ein Lese-Budget pro Runde, das übermäßige Lesevorgänge automatisch begrenzt, ein hartes Limit mit Zusammenfassung und Abbruch für jeden Subagenten sowie eine automatische Übergabe (vollständiges Backup-Fork + Komprimierung) auf Force-Level.
- **Automatisierte Entscheidungs-Delegation** — ein mitgeliefertes Dispatcher-Protokoll macht dein primäres Modell zum Dispatcher; sechs kognitive Spuren leiten Arbeit an das richtige Modell mit dem richtigen Aufwand; sechs deterministische Gates prüfen jede Delegation; Ausfälle lösen Circuit-Breaker und Isolierung aus, und das System heilt sich selbst.

**Extras**

- **Multi-Abo-Orchestrierung** — kontingentbewusstes Routing über Copilot / GLM / DeepSeek hinweg (jeder Provider nimmt teil), Ausweichen bei Spitzenfenstern, abrechnungsbewusstes Scoring, erzwungenes Review über Modellfamilien hinweg.
- **Manuelle Steuerung** — `/switchman-setup`, `/poolConfig`, `/modelRank`, `/expert`, `/handover`, `/ctx-pause`, `/ctx-resume`, `/switchman-doctor`, `/switchman-update`.
- **Sichtbarkeit** — Live-Banner mit vier Zeilen in jedem System-Prompt, TUI-Seitenleisten-Panel, tmux-Pane-Spiegelung, ein Artefakt-Arbeitsbereich pro Session und ein Audit-Log jeder Routing-Entscheidung.

Vollständige Optionstabelle, Architektur und Interna: [docs/reference.md](./docs/reference.md) (中文: [docs/reference.zh.md](./docs/reference.zh.md)).

## Dokumentation

- Schnellstart (illustriert): [English](./docs/quick-start.md) · [中文](./docs/quick-start.zh.md)
- Vollständiges Handbuch (Konfiguration, Befehle, Architektur): [English](./docs/reference.md) · [中文](./docs/reference.zh.md)
- Technische Spezifikation (Verträge / Algorithmen / Praxistest-Notizen): [docs/2026-08-28-opencode-switchman-technical-design.md](./docs/2026-08-28-opencode-switchman-technical-design.md)
- Versionshinweise: [CHANGELOG.md](./CHANGELOG.md)

## Roadmap

Kurzfristig: Kontingent-Unterstützung für weitere Provider — mehr Abo-Pläne und Pay-as-you-go-Pools über Copilot / GLM / DeepSeek hinaus. Falls dein Provider noch nicht abgedeckt ist, [öffne ein Issue](https://github.com/mrzturn/opencode-switchman/issues): Die reale Nutzung entscheidet, was als Nächstes gebaut wird. Vorschläge und Fehlerberichte sind gleichermaßen willkommen.

## Unterstütze den Autor

Dieses Plugin ist Open Source und kostenlos nutzbar — und das bleibt auch so. Am Leben zu halten ist es trotzdem nicht gratis: Die Pflege und das Testen der Adapter-Kompatibilität über Provider hinweg bedeuten, mehrere Abos zu halten und sie einzeln durchzudebuggen — jede Runde kostet echtes Geld.

Wenn das Plugin dir wirklich geholfen hat und dein Budget es erlaubt, spendiere mir einen Kaffee. Danke — von Herzen.

👇

<details>
<summary>☕ Hier klicken 【Dem Autor einen Kaffee ausgeben】</summary>

| Alipay | WeChat Pay | Mit WeChat scannen und ihm ein Like geben |
|:---:|:---:|:---:|
| <img src="docs/pay/alipay.png" width="150" alt="Alipay QR code" /> | <img src="docs/pay/wechat_pay.jpg" width="150" alt="WeChat Pay QR code" /> | <img src="docs/pay/wechat_pay_2.jpg" width="150" alt="WeChat scan-to-like QR code" /> |

</details>

## Lizenz

[MIT](./LICENSE)
