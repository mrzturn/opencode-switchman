# opencode-switchman

[English](./README.md) | [简体中文](./README.zh.md) | **繁體中文** | [日本語](./README.ja.md) | [한국어](./README.ko.md) | [Español](./README.es.md) | [Français](./README.fr.md) | [Deutsch](./README.de.md) | [Italiano](./README.it.md) | [Português](./README.pt.md) | [Русский](./README.ru.md)

> **也在用 zcode？** 看看 [zcode-switchman](https://github.com/mrzturn/zcode-switchman)——同作者的開源姊妹專案，為 zcode 使用者帶來同樣的編排能力。

> 上下文有水位，任務自己派。

![opencode-switchman —— 上下文水位驅動轉轍員自動扳道](docs/assets/hero.svg)

> 互動式展示：[opencode-switchman 宣傳頁](https://mrzturn.github.io/opencode-switchman/index.zh.html)

一套 [OpenCode](https://opencode.ai) 編排外掛，核心就兩件事：

**1. 上下文水位控制。** 外掛每輪實測你的工作階段上下文：讀取有每輪預算閘門，模型沒辦法悶頭把整個儲存庫吞進上下文；軟/硬/強制三檔水位依次觸發提醒、收尾、自動備份壓縮交接；派出去的每個子代理各有一條硬頂。上下文不再滾雪球——工作階段跑一整天，token 也不會被自己的歷史累積一口口吃掉。

**2. 自動化決策調度。** 主模型轉型調度員：為任務描繪輪廓，按六個認知檔位（economy / mechanical / main / hard / vision / review）派給子代理空殼執行；外掛進行確定性攔截、加權評分、失敗自癒隔離，每一條路由決策都可追溯。

在此之上：

- **有多個模型或多個訂閱？這個外掛就是為你準備的。** GitHub Copilot、智譜 GLM Coding Plan、DeepSeek——或任意 opencode 供應商——都會被編排成一個池子統一調度：配額感知排序、避開高峰時段、強制跨家族審查。
- **只有一個模型？照樣好用。** 光是上下文控制與智慧派發，就夠你把這一個模型長久用下去——工作階段再久，上下文也不會失控膨脹。

## 安裝

一個指令，首次安裝與後續更新一把罩。裝完重新啟動 opencode。

```bash
curl -fsSL https://raw.githubusercontent.com/mrzturn/opencode-switchman/main/scripts/setup.sh | bash
```

或

```bash
npx -y opencode-switchman@latest
```

或

```bash
bunx opencode-switchman@latest
```

兩種方式都會把 opencode 設定裡的 `plugin` 項目改寫為最新的精確版本，並清除過期的外掛快取。手動 npm 安裝、原始碼建置，以及「為什麼必須使用精確版本號」的說明：[安裝細節](./docs/reference.zh.md#安裝)。

怕麻煩？讓 AI 幫你裝——把下面這段話貼給你正在用的 AI：

<details open>
<summary><strong>AI 代安裝提示詞</strong></summary>

```text
請嚴格按照官方說明為我的 opencode 安裝並設定 opencode-switchman 外掛。

官方來源（以此為準，不要憑記憶猜測）：
- GitHub 儲存庫：https://github.com/mrzturn/opencode-switchman
- npm 套件：https://www.npmjs.com/package/opencode-switchman
請先閱讀儲存庫 README 的「安裝」章節，然後嚴格照做。

步驟：
1. 安裝 npm 上釋出的最新版本：執行 `npx -y opencode-switchman@latest`（或 `bunx opencode-switchman@latest`），它會把我的 opencode 設定裡的 `plugin` 項目改寫為精確的最新版本（若我用的是專案層級的 `opencode.json`，它同樣適用）。
2. 完成功能設定：外掛全部設定都在我 opencode 設定目錄下獨立的 `opencode-switchman.jsonc` 檔案中，首次啟動時自動產生並附有註解；請對照我的 provider（如 `zhipuai-coding-plan` / `deepseek` / `github-copilot`）檢查並視需要調整。
3. 驗證設定正確、確保 opencode 能正常載入、啟動並執行該外掛：在 opencode 內執行 `/switchman-doctor` 產出本機、不含憑證的診斷報告，並修復所有回報的錯誤；然後重新啟動 opencode 確認外掛確實已載入——日誌應出現 `[opencode-switchman] injected N model shells (agents)`，且主模型的系統提示中應帶有即時的 `[ROUTES]/[WATERMARK]/[LIMITS]` 橫幅區塊。

三個步驟全部通過才算完成；請回報你做的修改並提出驗證證據。
```

</details>

**前置需求**：[opencode](https://opencode.ai)，建議使用 CLI/TUI（彈出視窗、側邊欄與橫幅在 TUI 中最完整；桌面版共用同一份設定與狀態）。任意供應商皆可使用；Copilot / GLM / DeepSeek 另享配額感知路由。憑證以唯讀方式取自 opencode 自身的驗證層，外掛不儲存任何金鑰。

## 快速上手

六個步驟完成設定。完整圖文版：**[docs/quick-start.zh.md](./docs/quick-start.zh.md)** / [English](./docs/quick-start.md)。

1. **連接 provider** —— 在 TUI 執行 `/connect`：Copilot 走 OAuth、DeepSeek 貼上 API key；GLM Coding Plan 則在 `opencode.json` 加入 `zhipuai-coding-plan` 自訂 provider。
2. **挑選參與編排的模型** —— `/models` 後按 `ctrl+f` 加入最愛（桌面版：「管理模型」開關）。
3. **`/switchman-setup`** *（首次必做）* —— 引導式精靈一次完成整個矩陣：為六個任務池（economy / mechanical / main / hard / vision / review）各多選至少一個模型，再將入選模型按能力由強到弱排出名次。沒有 TUI？`/switchman-setup-chat` 可在對話中走同樣的引導流程。設定完成前任務派發會被強制攔截——未設定的池不再預設「全部模型參與」。設定儲存後立即熱載入；只有選到 opencode 尚未註冊的全新 provider 時才需要重新啟動。
4. **微調** *（選做）* —— **`/modelRank`** 手動調整能力排名，**`/poolConfig`** 為各任務池自訂候選清單（TUI 彈出視窗，`-chat` 後綴走對話）；手動項目在所有決策環節都會覆蓋初始預設。
5. **上下文指令**
   - **`/handover`** —— 手動備份並壓縮目前的工作階段。`[WATERMARK:SESSION]` 行的數字偏高、或任務告一段落時使用，不必等自動交接。
   - **`/ctx-pause`** —— 暫時關閉本工作階段的讀取限制與自動交接。需要一次讀取大量大檔案、不在意多花 token 時使用；測量照常運作。
   - **`/ctx-resume`** —— 重新開啟限制。大檔案讀完就恢復；重新啟動 opencode 效果相同。
6. **重新啟動、驗證** —— 確認 `[ROUTES]`/`[LIMITS]` 橫幅與側邊欄的 `switchman` 面板，有異常就執行 `/switchman-doctor`。之後照常使用 opencode 即可。

## 核心功能

**核心**

- **上下文水位控制** —— 工作階段上下文每輪實測（`[WATERMARK:SESSION]`），軟/硬/強制三檔水位；每輪讀取預算閘門自動約束過度讀取；每個子代理一條硬頂（觸頂時交回總結並終止）；強制水位自動交接（完整分叉備份＋壓縮），任務不中斷。
- **自動化決策調度** —— 內建調度員規程讓主模型學會派工；六個認知檔位把任務交給合適的模型與思考檔位；六道確定性閘門逐一檢驗每次派發；失敗自動熔斷隔離、自癒恢復。

**附加**

- **多訂閱編排** —— Copilot / GLM / DeepSeek 跨池配額感知路由（任意供應商皆可參與）、避開高峰時段、計費加權、強制跨家族審查。
- **手動覆蓋** —— `/switchman-setup`、`/poolConfig`、`/modelRank`、`/expert`、`/handover`、`/ctx-pause`、`/ctx-resume`、`/switchman-doctor`、`/switchman-update`。
- **看得見** —— 每輪系統提示注入即時四行橫幅、TUI 側邊欄狀態面板、tmux 窗格鏡像、按工作階段歸檔的產物工作區、路由決策稽核日誌。

完整設定項目表、架構與內部機制：[docs/reference.zh.md](./docs/reference.zh.md)（English: [docs/reference.md](./docs/reference.md)）。

## 文件

- 快速上手（圖文）：[中文](./docs/quick-start.zh.md) · [English](./docs/quick-start.md)
- 完整手冊（設定、指令、架構）：[中文](./docs/reference.zh.md) · [English](./docs/reference.md)
- 技術方案（契約/演算法/實測紀錄）：[docs/2026-08-28-opencode-switchman-technical-design.md](./docs/2026-08-28-opencode-switchman-technical-design.md)
- 發行記錄：[CHANGELOG.md](./CHANGELOG.md)

## 路線圖

近期規劃是支援更多供應商的配額——在 Copilot / GLM / DeepSeek 之外，涵蓋更多訂閱制與按量計費池。你的供應商還沒被支援？歡迎[提出 issue](https://github.com/mrzturn/opencode-switchman/issues)，我會依實際使用情況安排開發。功能建議與 bug 回報同樣歡迎。

## 用愛發電

本專案開源、免費，也會一直免費下去。但維護它並不免費：要支援並測試各家供應商對本外掛的相容性，需要開通多個訂閱、一一實地除錯，每一輪都是真金白銀的消耗。

如果這個外掛真的幫到了你，手頭也寬裕，不妨請作者喝杯咖啡。在此由衷感謝。

👇

<details>
<summary>☕ 點擊此處【請作者喝杯咖啡】</summary>

| 支付寶 | 微信支付 | 用微信掃碼替他按個讚 |
|:---:|:---:|:---:|
| <img src="docs/pay/alipay.png" width="150" alt="支付寶收款 QR Code" /> | <img src="docs/pay/wechat_pay.jpg" width="150" alt="微信收款 QR Code" /> | <img src="docs/pay/wechat_pay_2.jpg" width="150" alt="微信掃碼按讚 QR Code" /> |

</details>

## License

[MIT](./LICENSE)
