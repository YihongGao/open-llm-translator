# Open LLM Translator

[English](README.md) | 繁體中文

用您選擇的大型語言模型（LLM）翻譯網頁，譯文直接顯示在每段原文下方，原文和譯文對照閱讀。也能為 YouTube 影片加上雙語字幕。

使用您自己的 Anthropic（Claude）、OpenAI（GPT）或 Google（Gemini）API key。不用註冊帳號、不用訂閱，中間也沒有任何伺服器：瀏覽器直接連到服務商。

![文章的雙語翻譯](docs/store-assets/screenshot-2-article.png)

## 功能

- **雙語對照**：譯文插在每段原文下方，沿用原頁面的字型、顏色與連結。
- **只翻看得到的段落**：只送出畫面上的段落，捲動時再翻下一批，省 token。
- **邊產生邊顯示**：每段譯文一收到就顯示，不用等整頁翻完。
- **支援動態內容**：之後才載入的內容與單頁應用（SPA）會自動補翻。
- **本機快取**：同一網站上的同一段文字不會重複翻譯，也不會重複計費。
- **YouTube 雙語字幕**：原文和譯文字幕一起顯示在播放器內，全螢幕也看得到。字幕會先合併成完整句子再翻，自動產生的字幕也能翻得通順。
- **目標語言**：繁體中文（台灣）、简体中文、English、日本語、한국어。

介面提供 English、日本語、简体中文、繁體中文，預設跟著瀏覽器的語言自動切換，其他語言一律顯示英文。想自己選的話，到設定頁的「介面語言」改選跟隨瀏覽器、English、日本語、简体中文或繁體中文，選了立即生效。chrome://extensions/shortcuts 的快捷鍵說明和 Chrome 線上應用程式商店的說明，一律跟隨瀏覽器的語言。剛安裝時的目標語言也會對應瀏覽器的語言（不在這五種之內就用 English），之後隨時可以更改。

| 工具列選單 | YouTube 雙語字幕 |
|---|---|
| ![工具列選單](docs/store-assets/screenshot-1-docs-popup.png) | ![YouTube 雙語字幕](docs/store-assets/screenshot-3-youtube.png) |

## 安裝

**Chrome Web Store**：審核中，上架後會在這裡補上連結。

**從 GitHub Release 手動安裝**：

1. 從[最新版本](https://github.com/YihongGao/open-llm-translator/releases/latest)下載 `open-llm-translator-<version>.zip` 並解壓縮。
2. 開啟 `chrome://extensions`，打開右上角的「開發人員模式」。
3. 點「載入未封裝項目」，選擇解壓縮後的資料夾。

手動安裝不會自動更新。每個 release 的 zip 都附有 [build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations)，可以驗證它是由這個 repo 的 CI 建置的：

```bash
gh attestation verify open-llm-translator-<version>.zip --repo YihongGao/open-llm-translator
```

## 開始使用

1. 向任一家服務商申請 API key，只需要一家：
   - Anthropic：[console.anthropic.com](https://console.anthropic.com/settings/keys)
   - OpenAI：[platform.openai.com](https://platform.openai.com/api-keys)
   - Google Gemini：[aistudio.google.com](https://aistudio.google.com/apikey)

   擔心 key 被竊取嗎？網頁、其他擴充功能和開發者都讀不到它，它也只會從您的電腦送到服務商，不會送到其他地方。能防範什麼、不能防範什麼，見 [API key 如何受到保護](docs/api-key-security.zh-TW.md)。若想多一層保障，建議為這個擴充功能另建專用的 key，並在服務商那邊設定費用上限（[Anthropic](https://console.anthropic.com/settings/limits)、[OpenAI](https://platform.openai.com/settings/organization/limits)、[Google](https://aistudio.google.com/spend)），萬一 key 外洩，損失也有限。
2. 在擴充功能圖示上按右鍵，選「選項」。選擇 model，填入該家的 API key，按「測試連線」確認。
3. 在任何網頁點擴充功能圖示，按「翻譯此頁」，或按快捷鍵 `Alt+A`（macOS 為 `Option+A`）。再按一次就只顯示原文。
4. 在 YouTube 影片頁，選單會多一個「開啟雙語字幕」，快捷鍵 `Alt+S`（macOS 為 `Option+S`）。字幕和網頁翻譯是兩個獨立開關，可以只翻字幕或只翻留言。在同一分頁換到其他影片時，字幕會繼續作用；重新整理頁面後要再開一次。

目標語言要和網頁本身的語言不同：目標語言是 English 時，在英文網頁上不會翻譯任何內容，頁面會跳出提示，請到工具列選單的「翻譯成」改選其他語言。目標語言和 model 隨時可以在工具列選單切換，已翻譯的頁面會立即用新設定重翻。快捷鍵可以在 `chrome://extensions/shortcuts` 修改。

翻譯失敗時（例如 API key 沒設定或無效），頁面右上角會出現提示框。點段落旁的 ⚠ 可以看該段失敗的原因；關閉再開啟翻譯，就會重試失敗的段落。

## 費用

費用依各服務商的 API 價格，由您的帳號直接支付。每家各有三個檔位（價格為每百萬 token 的 input / output，2026 年 11 月）：

| 檔位 | Anthropic | OpenAI | Gemini |
|---|---|---|---|
| 便宜、快 | `claude-haiku-5-5`（預設）$0.10 / $0.50 | `gpt-6-luna` $0.10 / $0.50 | `gemini-3.5-flash-lite` $0.30 / $2.50 |
| 平衡 | `claude-sonnet-5-5` $2 / $10 | `gpt-6.2-sol` $2 / $10 | `gemini-4-hydrogen` $1.50 / $7.50 |
| 旗艦 | `claude-opus-5-5` $4 / $20 | `gpt-6.2-astra` $8 / $40 | `gemini-4-carbon` $4 / $20（2026-12-01 起；之前 $2 / $10） |

實際例子：翻譯一整頁技術文件（約 75 段），Claude Haiku 約 $0.0013、GPT-6 Luna 約 $0.0015、Gemini Flash-Lite 約 $0.005；較大的 model 同一頁約 $0.03 到 $0.05。

reasoning（thinking）都設在各 model 允許的最低檔，因為這些 token 以 output 計價。

## 隱私

- 在您對分頁按下翻譯之前，不會送出任何資料。按下之後，只有畫面上的段落、頁面標題與網址（不含查詢字串）會用您的 key 送到您選擇的服務商。
- 沒有開發者伺服器，不蒐集分析或遙測資料。
- API key 只存在您的裝置上（`chrome.storage.local`），不經 Chrome Sync 同步，網頁和其他擴充功能都讀不到。能防範什麼、不能防範什麼，見 [API key 如何受到保護](docs/api-key-security.zh-TW.md)。
- 送到 OpenAI 和 Gemini 的請求都帶 `store: false`。

完整說明見[隱私權政策](docs/privacy-policy.md)。

## 已知限制

- 譯文是純文字：段落中的連結和粗體不會帶進譯文。
- 按鈕、程式碼區塊、可編輯欄位，以及標記 `translate="no"` 的內容不翻譯。
- iframe 和 Shadow DOM 裡的內容不翻譯。
- 隱藏的內容（下拉選單、手風琴、捲動時才出現的動畫）會在顯示後約一秒內翻譯。
- 翻譯快取不會自動清除。移除擴充功能時會一併刪除。
- 頁面文字會被當成資料而非指令處理，但網頁仍可能試圖影響自己文字的翻譯結果，影響範圍限於該網站的譯文。
- YouTube 字幕只支援 `www.youtube.com/watch`。Shorts、嵌入式播放器、m.youtube.com、YouTube Music 與直播都不支援；影片沒有字幕時不會產生字幕。YouTube 改版時，這個功能可能在擴充功能更新前失效。

## 問題回報與參與開發

- 發現 bug 或想要新功能？請[開 issue](https://github.com/YihongGao/open-llm-translator/issues/new/choose)，中文或英文都可以。
- 資安問題請私下回報，見 [SECURITY.md](SECURITY.md)。
- 想自己 build 或送 pull request？見 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[Apache License 2.0](LICENSE)

YouTube 與 Gemini 是 Google LLC 的商標，Claude 是 Anthropic PBC 的商標，OpenAI 與 GPT 是 OpenAI 的商標。本擴充功能與這些公司無關，也未經它們認可。
