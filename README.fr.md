# opencode-switchman

[English](./README.md) | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | **Français** | [Deutsch](./README.de.md) | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **Vous utilisez aussi zcode ?** Découvrez [zcode-switchman](https://github.com/mrzturn/zcode-switchman) — un projet open source frère du même auteur, qui apporte la même orchestration aux utilisateurs de zcode.

> Le contexte au compteur. Les tâches se dispatchent toutes seules.

![opencode-switchman — the context water level drives the switchman and throws the route](docs/assets/hero.svg)

> Diaporama de démonstration interactive : [opencode-switchman en action](https://mrzturn.github.io/opencode-switchman/)

Un plugin d'orchestration pour [OpenCode](https://opencode.ai). Il fait deux choses, et les fait bien :

**1. Contrôle du niveau d'eau du contexte.** Le contexte de votre session est mesuré à chaque tour. Les lectures sont soumises à un budget par tour, si bien que le modèle ne peut pas discrètement avaler tout le dépôt ; les watermarks soft / hard / force déclenchent d'abord des conseils, puis une clôture, puis un handover automatique (sauvegarde + compactage) ; chaque sous-agent dispatché embarque son propre plafond strict. Le contexte ne fait plus boule de neige — une session peut tourner toute la journée sans que ses tokens soient dévorés par son propre historique.

**2. Dispatch décisionnel automatisé.** Votre modèle principal devient un dispatcher : il profile chaque tâche et la délègue à des shells de sous-agents répartis sur six couloirs cognitifs (economy / mechanical / main / hard / vision / review). Le plugin impose des gates déterministes, un score pondéré des modèles et une isolation des pannes auto-réparatrice, et journalise chaque décision de routage.

Et par-dessus le marché :

- **Plusieurs modèles ou abonnements ? Ce plugin a été conçu pour vous.** GitHub Copilot, GLM Coding Plan, DeepSeek — ou n'importe quel fournisseur opencode — sont orchestrés comme un seul pool : ordonnancement conscient des quotas, évitement des fenêtres de pointe, review forcée inter-familles.
- **Un seul modèle ? Ça vaut quand même le coup.** Le contrôle du contexte et le dispatch intelligent suffisent à garder un modèle unique utilisable indéfiniment — aussi longue que soit la session, le contexte ne gonfle jamais.

## Installation

Une seule commande — gère la première installation comme les mises à jour ultérieures. Redémarrez opencode ensuite.

```bash
curl -fsSL https://raw.githubusercontent.com/mrzturn/opencode-switchman/main/scripts/setup.sh | bash
```

ou

```bash
npx -y opencode-switchman@latest
```

ou

```bash
bunx opencode-switchman@latest
```

Les deux chemins réécrivent l'entrée `plugin` de votre configuration opencode vers la dernière version exacte et purgent les caches obsolètes. Installation npm manuelle, build depuis les sources et la note « pourquoi des versions exactes » : [Détails d'installation](./docs/reference.md#installation).

Vous préférez ne rien faire ? Laissez votre IA faire l'installation — collez ce prompt dans l'IA que vous utilisez :

<details open>
<summary><strong>Prompt d'installation assistée par IA</strong></summary>

```text
Veuillez installer et configurer le plugin opencode-switchman pour mon opencode, en suivant strictement ses instructions officielles.

Sources officielles (faire foi, ne pas deviner de mémoire) :
- Dépôt GitHub : https://github.com/mrzturn/opencode-switchman
- Paquet npm : https://www.npmjs.com/package/opencode-switchman
Lisez la section « Installation » du README du dépôt et suivez-la à la lettre.

Étapes :
1. Installez la dernière version publiée sur npm : exécutez `npx -y opencode-switchman@latest` (ou `bunx opencode-switchman@latest`) — cela réécrit l'entrée `plugin` de ma configuration opencode vers la dernière version exacte (cela fonctionne aussi dans le `opencode.json` au niveau du projet si c'est ce que j'utilise).
2. Terminez la configuration fonctionnelle : tous les réglages du plugin vivent dans le fichier autonome `opencode-switchman.jsonc` de mon répertoire de configuration opencode, généré automatiquement avec des valeurs par défaut et des commentaires en ligne au premier démarrage ; vérifiez-le par rapport à mes fournisseurs (par ex. `zhipuai-coding-plan` / `deepseek` / `github-copilot`) et ajustez si besoin.
3. Vérifiez que tout est correct pour qu'opencode se charge, démarre et exécute le plugin : lancez `/switchman-doctor` dans opencode pour obtenir un rapport de diagnostic local sans identifiants et corrigez chaque erreur signalée ; puis redémarrez opencode et confirmez que le plugin est réellement chargé — le journal doit contenir `[opencode-switchman] injected N model shells (agents)` et le prompt système de mon modèle principal doit porter le bloc de bannière `[ROUTES]/[WATERMARK]/[LIMITS]` à jour.

Ne déclarez pas la réussite tant que les trois étapes ne sont pas passées ; rapportez ce que vous avez modifié et montrez les preuves de vérification.
```

</details>

**Prérequis** : [opencode](https://opencode.ai), CLI/TUI recommandée (dialogues, panneau latéral et bannières y sont les plus riches ; l'application de bureau partage la même configuration et le même état). N'importe quel fournisseur fonctionne ; Copilot / GLM / DeepSeek bénéficient en plus du routage conscient des quotas. Les identifiants sont lus en lecture seule depuis l'auth d'opencode — le plugin ne stocke jamais de secrets.

## Démarrage rapide

Six étapes. Guide complet illustré : **[docs/quick-start.md](./docs/quick-start.md)** / [中文](./docs/quick-start.zh.md).

1. **Connectez les fournisseurs** — `/connect` dans la TUI : OAuth Copilot, clé API DeepSeek ; le GLM Coding Plan se configure dans `opencode.json` comme fournisseur personnalisé `zhipuai-coding-plan`.
2. **Choisissez les modèles qui rejoignent l'orchestration** — `/models` puis `ctrl+f` pour mettre en favori (application de bureau : interrupteurs « Manage models »).
3. **`/switchman-setup`** *(obligatoire une fois)* — l'assistant guidé couvre toute la matrice en une passe : multi-sélection d'au moins un modèle pour chacun des six pools de tâches (economy / mechanical / main / hard / vision / review), puis classement des modèles sélectionnés du plus fort au plus faible. Pas de TUI ? `/switchman-setup-chat` déroule le même parcours guidé en chat. Jusqu'à la fin de la configuration, le dispatch de tâches est carrément bloqué — les pools non configurés ne basculent plus par défaut sur « tous les modèles ». La configuration enregistrée se recharge à chaud ; un redémarrage n'est nécessaire que pour enregistrer des fournisseurs tout neufs.
4. **Réglage fin** *(optionnel)* — **`/modelRank`** ajuste à la main le classement de capacités et **`/poolConfig`** cuisine les listes de candidats par pool dans des dialogues TUI (variantes `-chat` en chat) ; les entrées manuelles priment partout sur les valeurs par défaut initiales.
5. **Commandes de contexte**
   - **`/handover`** — sauvegardez la session et compactez-la vous-même. À utiliser quand la ligne `[WATERMARK:SESSION]` grossit ou que la tâche atteint un bon point d'arrêt, au lieu d'attendre le handover automatique.
   - **`/ctx-pause`** — coupez les limites de lecture et le handover automatique de cette session. À utiliser quand vous devez lire d'un coup beaucoup de gros fichiers et que dépenser les tokens ne vous fait pas peur ; la mesure continue de tourner.
   - **`/ctx-resume`** — remettez les limites en route. À faire dès que les lourdes lectures sont terminées ; redémarrer opencode produit le même effet.
6. **Redémarrez et vérifiez** — contrôlez la bannière `[ROUTES]`/`[LIMITS]` et le panneau `switchman` de la barre latérale ; lancez `/switchman-doctor` si quelque chose cloche. Ensuite, utilisez opencode normalement.

## Ce que vous y gagnez

**L'essentiel**

- **Contrôle du niveau d'eau du contexte** — mesure en direct de la session (`[WATERMARK:SESSION]`), seuils soft/hard/force, budget de lecture par tour qui borne automatiquement les lectures trop gourmandes, plafond strict avec résumé-puis-arrêt pour chaque sous-agent, et handover automatique (fork de sauvegarde complet + compactage) au niveau force.
- **Dispatch décisionnel automatisé** — un protocole de dispatcher embarqué transforme votre modèle principal en dispatcher ; six couloirs cognitifs aiguillent le travail vers le bon modèle au bon niveau d'effort ; six gates déterministes contrôlent chaque dispatch ; les échecs déclenchent des disjoncteurs et une isolation, et le système se répare tout seul.

**En supplément**

- **Orchestration multi-abonnements** — routage conscient des quotas sur Copilot / GLM / DeepSeek (tout fournisseur peut participer), cédure aux fenêtres de pointe, score sensible à la facturation, review inter-familles imposée.
- **Overrides manuels** — `/switchman-setup`, `/poolConfig`, `/modelRank`, `/expert`, `/handover`, `/ctx-pause`, `/ctx-resume`, `/switchman-doctor`, `/switchman-update`.
- **Visibilité** — bannière live de quatre lignes dans chaque prompt système, panneau latéral TUI, miroir tmux, espace de travail d'artefacts par session et journal d'audit de chaque décision de routage.

Table complète des options, architecture et fonctionnement interne : [docs/reference.md](./docs/reference.md) (中文 : [docs/reference.zh.md](./docs/reference.zh.md)).

## Documentation

- Quick start (illustré) : [English](./docs/quick-start.md) · [中文](./docs/quick-start.zh.md)
- Manuel complet (config, commandes, architecture) : [English](./docs/reference.md) · [中文](./docs/reference.zh.md)
- Spécification technique (contrats / algorithmes / notes de terrain) : [docs/2026-08-28-opencode-switchman-technical-design.md](./docs/2026-08-28-opencode-switchman-technical-design.md)
- Notes de version : [CHANGELOG.md](./CHANGELOG.md)

## Feuille de route

À court terme : le support des quotas pour davantage de fournisseurs — davantage de plans d'abonnement et de pools à l'usage au-delà de Copilot / GLM / DeepSeek. Si votre fournisseur n'est pas encore couvert, [ouvrez une issue](https://github.com/mrzturn/opencode-switchman/issues) : l'usage réel décide de ce qui sera construit ensuite. Suggestions et rapports de bugs sont tout aussi bienvenus.

## Soutenir l'auteur

Ce plugin est open source et gratuit, et il le restera. Le maintenir en vie ne l'est pas, pourtant : soutenir et tester la compatibilité des adaptateurs chez les fournisseurs suppose de détenir plusieurs abonnements et de les déboguer un par un — chaque cycle coûte de l'argent réel.

Si le plugin vous a vraiment aidé et que votre budget le permet, offrez-moi un café. Merci — sincèrement.

👇

<details>
<summary>☕ Cliquez ici 【Offrir un café à l'auteur】</summary>

| Alipay | WeChat Pay | Scannez avec WeChat pour lui témoigner votre soutien |
|:---:|:---:|:---:|
| <img src="docs/pay/alipay.png" width="150" alt="QR code Alipay" /> | <img src="docs/pay/wechat_pay.jpg" width="150" alt="QR code WeChat Pay" /> | <img src="docs/pay/wechat_pay_2.jpg" width="150" alt="QR code scan-to-like WeChat" /> |

</details>

## Licence

[MIT](./LICENSE)
