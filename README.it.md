# opencode-switchman

[English](./README.md) | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | **Italiano** | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **Usi anche zcode?** Dai un'occhiata a [zcode-switchman](https://github.com/mrzturn/zcode-switchman) — un progetto open source gemello, dello stesso autore, che porta la stessa orchestrazione agli utenti di zcode.

> Il contesto ha un contatore. I task si dispacciano da soli.

![opencode-switchman — il livello dell'acqua del contesto guida lo switchman e traccia la rotta](docs/assets/hero.svg)

> Demo interattiva: [opencode-switchman in azione](https://mrzturn.github.io/opencode-switchman/)

Un plugin di orchestrazione per [OpenCode](https://opencode.ai). Fa due cose, e le fa bene:

**1. Controllo del livello del contesto.** Il contesto della tua sessione viene misurato a ogni turno. Le letture girano su un budget per turno, così il modello non può divorarsi l'intero repo in silenzio; le soglie soft / hard / force attivano prima un consiglio, poi il wrap-up, infine un handover automatico con backup e compattazione; ogni subagent dispacciato porta con sé il proprio hard cap. Il contesto smette di valicare — una sessione può girare tutto il giorno senza che i token vengano divorati dalla propria storia.

**2. Dispatch automatico delle decisioni.** Il tuo modello primario diventa un dispatcher: profila ogni task e lo delega a shell subagent su sei corsie cognitive (economy / mechanical / main / hard / vision / review). Il plugin impone gate deterministici, punteggi pesati per modello e isolamento auto-riparante dei guasti, e registra ogni decisione di routing.

E in più:

- **Più modelli o abbonamenti? Questo plugin è fatto per te.** GitHub Copilot, GLM Coding Plan, DeepSeek — o qualsiasi provider opencode — vengono orchestrati come un unico pool: ordinamento consapevole delle quote, evitamento delle finestre di picco, review cross-family forzata.
- **Un solo modello? Vale comunque la pena.** Il controllo del contesto e il dispatch intelligente da soli mantengono un singolo modello usabile all'infinito — per quanto lunga sia la sessione, il contesto non esplode mai.

## Installazione

Un solo comando — copre prima installazione e aggiornamenti successivi. Riavvia opencode dopo.

```bash
curl -fsSL https://raw.githubusercontent.com/mrzturn/opencode-switchman/main/scripts/setup.sh | bash
```

oppure

```bash
npx -y opencode-switchman@latest
```

oppure

```bash
bunx opencode-switchman@latest
```

Entrambi i percorsi riscrivono la voce `plugin` nella tua configurazione opencode sulla versione esatta più recente e ripuliscono le cache stantie. Installazione npm manuale, build dai sorgenti e la nota sul «perché versioni esatte»: [Dettagli di installazione](./docs/reference.md#installation).

Preferisci non toccare nulla? Lascia fare alla tua IA — incolla questo prompt nell'IA che stai usando:

<details open>
<summary><strong>Prompt di installazione assistita dall'IA</strong></summary>

```text
Installa e configura il plugin opencode-switchman per il mio opencode, seguendo rigorosamente le istruzioni ufficiali.

Fonti ufficiali (autoritative, non indovinare a memoria):
- Repo GitHub: https://github.com/mrzturn/opencode-switchman
- Pacchetto npm: https://www.npmjs.com/package/opencode-switchman
Leggi la sezione "Installazione" del README del repo e seguila esattamente.

Passaggi:
1. Installa l'ultima versione pubblicata su npm: esegui `npx -y opencode-switchman@latest` (o `bunx opencode-switchman@latest`) — riscrive la voce `plugin` nella mia configurazione opencode sulla versione esatta più recente (funziona anche nell'`opencode.json` di progetto, se è quello che uso).
2. Completa la configurazione funzionale: tutte le impostazioni del plugin vivono nel file autonomo `opencode-switchman.jsonc` nella directory di configurazione di opencode, generato automaticamente con default e commenti inline al primo avvio; controllalo rispetto ai miei provider (es. `zhipuai-coding-plan` / `deepseek` / `github-copilot`) e adattalo se serve.
3. Verifica che opencode carichi, avvii ed esegua il plugin: esegui `/switchman-doctor` dentro opencode per un rapporto diagnostico locale senza credenziali e correggi ogni errore riportato; poi riavvia opencode e conferma che il plugin sia effettivamente caricato — il log deve contenere `[opencode-switchman] injected N model shells (agents)` e il system prompt del mio modello primario deve portare il blocco banner live `[ROUTES]/[WATERMARK]/[LIMITS]`.

Non dichiarare successo finché tutti e tre i passaggi non passano; riporta cosa hai modificato e mostra le evidenze di verifica.
```

</details>

**Prerequisiti**: [opencode](https://opencode.ai), consigliata la CLI/TUI (finestre di dialogo, sidebar e banner sono lì al massimo; l'app desktop condivide stessa configurazione e stato). Qualsiasi provider funziona; Copilot / GLM / DeepSeek ottengono in più il routing consapevole delle quote. Le credenziali sono lette in sola lettura dall'autenticazione di opencode — il plugin non archivia mai segreti.

## Inizio rapido

Sei passi. Guida completa con screenshot: **[docs/quick-start.md](./docs/quick-start.md)** / [中文](./docs/quick-start.zh.md).

1. **Connetti i provider** — `/connect` nella TUI: OAuth per Copilot, API key per DeepSeek; GLM Coding Plan va in `opencode.json` come provider personalizzato `zhipuai-coding-plan`.
2. **Scegli i modelli che entrano nell'orchestrazione** — `/models` poi `ctrl+f` per aggiungere ai preferiti (app desktop: interruttori in "Gestisci modelli").
3. **`/switchman-setup`** *(obbligatorio una volta)* — la procedura guidata copre l'intera matrice in un colpo solo: multi-selezione di almeno un modello per ciascuno dei sei task pool (economy / mechanical / main / hard / vision / review), poi ordina i modelli selezionati dal più forte al più debole. Niente TUI? `/switchman-setup-chat` esegue lo stesso flusso guidato in chat. Fino al completamento della configurazione, il dispatch dei task è bloccato — i pool non configurati non ricadono più su «tutti i modelli». La configurazione salvata si ricarica a caldo; serve un riavvio solo per registrare provider del tutto nuovi.
4. **Messa a punto** *(opzionale)* — **`/modelRank`** regola a mano la classifica di capacità e **`/poolConfig`** cura le liste candidate per pool nelle finestre TUI (varianti `-chat` in chat); le voci manuali sovrascrivono i default iniziali ovunque.
5. **Comandi di contesto**
   - **`/handover`** — fai tu il backup della sessione e la compattazione. Usalo quando la riga `[WATERMARK:SESSION]` cresce o il task raggiunge un buon punto di arresto, invece di aspettare l'handover automatico.
   - **`/ctx-pause`** — disattiva i limiti di lettura e l'handover automatico di questa sessione. Usalo quando devi leggere molti file grandi in una volta e non ti dispiace spendere token; la misurazione continua.
   - **`/ctx-resume`** — riattiva i limiti. Usalo appena finita la lettura pesante; riavviare opencode ha lo stesso effetto.
6. **Riavvia e verifica** — controlla il banner `[ROUTES]`/`[LIMITS]` e il pannello `switchman` nella sidebar; esegui `/switchman-doctor` se qualcosa non torna. Poi usa opencode normalmente.

## Cosa ottieni

**Nucleo**

- **Controllo del livello del contesto** — misurazione live della sessione (`[WATERMARK:SESSION]`), soglie soft/hard/force, un budget di lettura per turno che limita da solo le letture troppo avide, un hard cap con riepilogo-e-terminazione per ogni subagent, e un handover automatico (fork di backup completo + compattazione) al livello force.
- **Dispatch automatico delle decisioni** — un protocollo dispatcher incluso trasforma il tuo modello primario in un dispatcher; sei corsie cognitive instradano il lavoro al modello giusto con lo sforzo giusto; sei gate deterministici controllano ogni dispatch; i guasti azionano breaker e isolamento, e il sistema si ripara da sé.

**Extra**

- **Orchestrazione multi-abbonamento** — routing consapevole delle quote tra Copilot / GLM / DeepSeek (qualsiasi provider partecipa), cedenza nelle finestre di picco, punteggio consapevole della fatturazione, review cross-family imposta.
- **Override manuali** — `/switchman-setup`, `/poolConfig`, `/modelRank`, `/expert`, `/handover`, `/ctx-pause`, `/ctx-resume`, `/switchman-doctor`, `/switchman-update`.
- **Visibilità** — banner live di quattro righe in ogni system prompt, pannello sidebar TUI, mirroring dei riquadri tmux, workspace di artefatti per sessione, e un log di audit di ogni decisione di routing.

Tabella completa delle opzioni, architettura e interni: [docs/reference.md](./docs/reference.md) (中文: [docs/reference.zh.md](./docs/reference.zh.md)).

## Documentazione

- Inizio rapido (illustrato): [English](./docs/quick-start.md) · [中文](./docs/quick-start.zh.md)
- Manuale completo (configurazione, comandi, architettura): [English](./docs/reference.md) · [中文](./docs/reference.zh.md)
- Specifica tecnica (contratti / algoritmi / note sul campo): [docs/2026-08-28-opencode-switchman-technical-design.md](./docs/2026-08-28-opencode-switchman-technical-design.md)
- Note di rilascio: [CHANGELOG.md](./CHANGELOG.md)

## Roadmap

Brevi termine: supporto quote per più provider — più piani in abbonamento e pool pay-as-you-go oltre Copilot / GLM / DeepSeek. Se il tuo provider non è ancora coperto, [apri una issue](https://github.com/mrzturn/opencode-switchman/issues): l'uso reale decide cosa viene costruito dopo. Suggerimenti e bug report sono ugualmente benvenuti.

## Sostieni l'autore

Questo plugin è open source e gratuito, e lo resterà. Tenerlo in vita però non è gratis: supportare e testare la compatibilità degli adattatori tra provider significa mantenere più abbonamenti e fare debug uno per uno — ogni giro costa denaro vero.

Se il plugin ti è stato davvero d'aiuto e il tuo budget lo permette, offrimi un caffè. Grazie — sinceramente.

👇

<details>
<summary>☕ Clicca qui 【Offri un caffè all'autore】</summary>

| Alipay | WeChat Pay | Scansiona con WeChat e lascia un like |
|:---:|:---:|:---:|
| <img src="docs/pay/alipay.png" width="150" alt="Codice QR Alipay" /> | <img src="docs/pay/wechat_pay.jpg" width="150" alt="Codice QR WeChat Pay" /> | <img src="docs/pay/wechat_pay_2.jpg" width="150" alt="Codice QR Wechat scan-to-like" /> |

</details>

## Licenza

[MIT](./LICENSE)
