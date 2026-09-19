# opencode-switchman

[English](./README.md) | [简体中文](./README.zh.md) | [繁體中文](./README.zh-TW.md) | **日本語** | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **zcode も使っているなら**、同じ作者による姉妹オープンソースプロジェクト [zcode-switchman](https://github.com/mrzturn/zcode-switchman) をチェック — 同じオーケストレーションを zcode ユーザーに届けている。

> コンテキストはメーター管理。タスクは自らディスパッチされる。

![opencode-switchman — the context water level drives the switchman and throws the route](docs/assets/hero.svg)

> インタラクティブなデモスライド: [opencode-switchman in action](https://mrzturn.github.io/opencode-switchman/)

[OpenCode](https://opencode.ai) 向けオーケストレーションプラグイン。やることは 2 つ、どちらも確実に仕上げる:

**1. コンテキスト水位制御。** セッションのコンテキストを毎ターン計測。読み込みはターンごとの予算内で走るため、モデルがリポジトリ全体を黙って飲み込むことはない。soft / hard / force の各ウォーターマークが、まず助言、次に締め、そして自動のバックアップ＆コンパクト化ハンドオーバーを発火させる。ディスパッチされた各サブエージェントも固有のハード上限を担う。コンテキストの雪だるま化はここで止まる — セッションは丸一日回り続けても、トークンが自らの履歴に食い潰されることはない。

**2. 自動ディシジョンディスパッチ。** プライマリモデルはディスパッチャーに変わる: 各タスクをプロファイリングし、6 つの認知レーン (economy / mechanical / main / hard / vision / review) にわたるサブエージェントシェルへ委譲する。プラグインは決定論的ゲート、重み付きモデルスコアリング、自己修復型の障害分離を強制し、すべてのルーティング判断を記録する。

さらに:

- **モデルもサブスクリプションも複数？ このプラグインはまさにそのために作られた。** GitHub Copilot、GLM Coding Plan、DeepSeek — あるいは任意の opencode プロバイダー — が 1 つのプールとしてオーケストレーションされる: クォータを考慮した順序付け、ピーク時間帯の回避、強制クロスファミリーレビュー。
- **モデルが 1 つだけ？ それでも導入する価値はある。** コンテキスト制御とスマートディスパッチだけでも、単一モデルを無期限に使い続けられる — セッションがどれだけ長引いても、コンテキストが肥大化することはない。

## インストール

コマンドは 1 つ — 初回インストールも以後の更新もこれで完結。実行後は opencode を再起動する。

```bash
curl -fsSL https://raw.githubusercontent.com/mrzturn/opencode-switchman/main/scripts/setup.sh | bash
```

または

```bash
npx -y opencode-switchman@latest
```

または

```bash
bunx opencode-switchman@latest
```

どちらの方法でも、opencode 設定の `plugin` エントリが正確な最新バージョンに書き換わり、古いキャッシュは削除される。手動 npm インストール、ソースからのビルド、「バージョン固定なのはなぜか」の注記: [インストールの詳細](./docs/reference.md#installation)。

手間をかけたくないなら、AI にインストールを任せる — 以下のプロンプトを利用中の AI に貼り付ける:

<details open>
<summary><strong>AI 支援インストール用プロンプト</strong></summary>

```text
私の opencode に opencode-switchman プラグインをインストールし、設定してください。公式の手順に厳密に従うこと。

公式ソース (必ずこちらを正とすること。記憶からの推測はしない):
- GitHub リポジトリ: https://github.com/mrzturn/opencode-switchman
- npm パッケージ: https://www.npmjs.com/package/opencode-switchman
リポジトリ README の「Installation」セクションを読み、そこに書かれた通りに実行すること。

手順:
1. npm で公開されている最新版をインストール: `npx -y opencode-switchman@latest` (または `bunx opencode-switchman@latest`) を実行 — 私の opencode 設定の `plugin` エントリが正確な最新バージョンに書き換わる (私が使っているのがプロジェクト直下の `opencode.json` であれば、そちらにも同様に有効)。
2. 機能設定を完了させる: プラグイン設定はすべて、opencode 設定ディレクトリ内の独立した `opencode-switchman.jsonc` に置かれ、初回起動時にデフォルト値とインラインコメント付きで自動生成される。私のプロバイダー (`zhipuai-coding-plan` / `deepseek` / `github-copilot` など) と突き合わせ、必要に応じて調整すること。
3. opencode がプラグインをロードし、起動して動作させられることを検証する: opencode 内で `/switchman-doctor` を実行し、資格情報不要のローカル診断レポートを取得して、報告されたエラーをすべて修正する; その後 opencode を再起動し、プラグインが実際にロードされたことを確認する — ログに `[opencode-switchman] injected N model shells (agents)` が含まれ、プライマリモデルのシステムプロンプトに生きた `[ROUTES]/[WATERMARK]/[LIMITS]` バナーブロックが載っているはず。

3 つの手順すべてが通るまで成功と宣言しないこと。変更した内容を報告し、検証の証拠を見せること。
```

</details>

**前提条件**: [opencode](https://opencode.ai)。CLI/TUI 推奨 (ダイアログ、サイドバー、バナーの表示が最も充実。デスクトップアプリも同じ設定と状態を共有する)。プロバイダーはどれでも動作し、Copilot / GLM / DeepSeek はさらにクォータ対応ルーティングの対象になる。認証情報は opencode 自身の auth から読み取り専用で取得 — プラグインがシークレットを保存することはない。

## クイックスタート

ステップは 6 つ。スクリーンショット付きの完全ウォークスルー: **[docs/quick-start.md](./docs/quick-start.md)** / [中文](./docs/quick-start.zh.md)。

1. **プロバイダーを接続** — TUI で `/connect`: Copilot OAuth、DeepSeek API キー。GLM Coding Plan は `zhipuai-coding-plan` カスタムプロバイダーとして `opencode.json` に記載する。
2. **オーケストレーションに参加するモデルを選ぶ** — `/models` を開いて `ctrl+f` でお気に入り登録 (デスクトップアプリは「Manage models」トグル)。
3. **`/switchman-setup`** *(必須・初回のみ)* — ガイド付きウィザードがマトリクス全体を一巡でカバー: 6 つのタスクプール (economy / mechanical / main / hard / vision / review) のそれぞれに対し最低 1 つのモデルを選択し、選んだモデルを強い順にランク付けする。TUI が使えない環境なら `/switchman-setup-chat` がチャット上で同じガイドフローを実行する。セットアップが完了するまでタスクディスパッチはハードブロック — 未設定のプールが「全モデル」にフォールバックすることはもうない。保存済みの設定はホットリロードされ、再起動が必要なのは全く新しいプロバイダーの登録時のみ。
4. **微調整** *(任意)* — **`/modelRank`** で能力ランキングを手動調整、**`/poolConfig`** でプール別の候補リストを TUI ダイアログ内で編集する (チャットでは `-chat` 版)。手動エントリは初期デフォルトをどこでも上書きする。
5. **コンテキストコマンド**
   - **`/handover`** — セッションをバックアップし、自分で圧縮する。`[WATERMARK:SESSION]` 行が大きくなってきたとき、あるいはタスクが良い区切りに差しかかったとき、自動ハンドオーバーを待たずに使う。
   - **`/ctx-pause`** — このセッションの読み込み制限と自動ハンドオーバーを止める。大量の大きなファイルを一気に読みたいとき、トークン消費を気にしないときに使う。計測自体は継続する。
   - **`/ctx-resume`** — 制限を再度有効にする。重い読み込みが終わり次第すぐ使う。opencode の再起動でも同じ効果が得られる。
6. **再起動して検証** — `[ROUTES]`/`[LIMITS]` バナーとサイドバーの `switchman` パネルを確認する; 引っかかる点があれば `/switchman-doctor` を実行。あとは opencode を普通に使うだけ。

## 得られるもの

**コア**

- **コンテキスト水位制御** — セッションのライブ計測 (`[WATERMARK:SESSION]`)、soft/hard/force の各しきい値、食い気味の読み込みを自動で上限内に収めるターン別読み込み予算、各サブエージェントに課される要約して終了のハード上限、そして force レベルでの自動ハンドオーバー (完全バックアップフォーク + 圧縮)。
- **自動ディシジョンディスパッチ** — 同梱のディスパッチャープロトコルがプライマリモデルをディスパッチャーへ変える; 6 つの認知レーンが作業を適切なモデル・適切な負荷へルーティングする; 6 つの決定論的ゲートが全ディスパッチを検査する; 障害はブレーカーと分離を作動させ、システムは自己修復する。

**拡張機能**

- **マルチサブスクリプションオーケストレーション** — Copilot / GLM / DeepSeek にまたがるクォータ対応ルーティング (どのプロバイダーでも参加可)、ピーク時間帯の譲り合い、課金を考慮したスコアリング、クロスファミリーレビューの強制。
- **手動オーバーライド** — `/switchman-setup`、`/poolConfig`、`/modelRank`、`/expert`、`/handover`、`/ctx-pause`、`/ctx-resume`、`/switchman-doctor`、`/switchman-update`。
- **可視性** — すべてのシステムプロンプトに載るライブ 4 行バナー、TUI サイドバーパネル、tmux ペインのミラーリング、セッション単位の成果物ワークスペース、全ルーティング判断の監査ログ。

オプション一覧、アーキテクチャ、内部構造の全体: [docs/reference.md](./docs/reference.md) (中文: [docs/reference.zh.md](./docs/reference.zh.md))。

## ドキュメント

- クイックスタート (図解付き): [English](./docs/quick-start.md) · [中文](./docs/quick-start.zh.md)
- 完全マニュアル (設定、コマンド、アーキテクチャ): [English](./docs/reference.md) · [中文](./docs/reference.zh.md)
- 技術仕様 (契約 / アルゴリズム / 実運用テストメモ): [docs/2026-08-28-opencode-switchman-technical-design.md](./docs/2026-08-28-opencode-switchman-technical-design.md)
- リリースノート: [CHANGELOG.md](./CHANGELOG.md)

## ロードマップ

直近の計画: より多くのプロバイダーへのクォータ対応 — Copilot / GLM / DeepSeek 以外のサブスクリプションプランと従量課金プールの拡充。まだ対応のないプロバイダーを使っているなら [issue を立ててほしい](https://github.com/mrzturn/opencode-switchman/issues): 次に何を作るかは実際の使用が決める。提案もバグ報告も同じく歓迎。

## 作者を支援する

このプラグインはオープンソースで無料、これからもそのままだ。ただし維持にはコストが伴う: プロバイダー横断のアダプタ互換性の保守とテストには複数のサブスクリプション契約と一件ずつのデバッグが必要 — 一巡するごとに実際の金が消えていく。

プラグインが本当に役に立ったと感じたら、予算の許す範囲でコーヒーを一杯おごってほしい。感謝を — 心から。

👇

<details>
<summary>☕ ここをクリック 【作者にコーヒーをおごる】</summary>

| Alipay | WeChat Pay | WeChat でスキャンして拍手を送る |
|:---:|:---:|:---:|
| <img src="docs/pay/alipay.png" width="150" alt="Alipay QRコード" /> | <img src="docs/pay/wechat_pay.jpg" width="150" alt="WeChat Pay QRコード" /> | <img src="docs/pay/wechat_pay_2.jpg" width="150" alt="WeChat スキャン拍手 QRコード" /> |

</details>

## ライセンス

[MIT](./LICENSE)
