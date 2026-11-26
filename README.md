# LLM Bilingual Translator

Chrome extension (MV3)：保留原文，在原文旁或下方插入 LLM 翻譯（雙語對照）。使用自己的 API key，支援 Anthropic（Claude）、OpenAI（GPT）、Google（Gemini）。

## 安裝

```bash
npm install
npm run build        # 產出 dist/
```

1. 開啟 `chrome://extensions`，打開右上角「開發人員模式」
2. 點「載入未封裝項目」，選擇 `dist/`
3. 在擴充功能圖示上按右鍵 →「選項」，選 model 並填入該家的 API key，按「測試連線」確認

開發時用 `npm run dev`（esbuild watch）。改完後到 `chrome://extensions` 按重新載入；`public/` 底下的檔案只在啟動時複製一次。

## 上架

```bash
npm run package      # typecheck + test 通過後才 build + 檢查（無 E2E 設定、無 source map、無 remote code）→ release/*.zip
```

送審各欄位要填的內容在 `docs/store-submission.md`，隱私權政策草稿在 `docs/privacy-policy.md`。

## Model

每家三檔，依價格與定位對應（價格為每百萬 token 的 input / output，2026-11）：

| 檔位 | Anthropic | OpenAI | Gemini |
|---|---|---|---|
| 便宜、快 | `claude-haiku-5-5`（預設）$0.10 / $0.50 | `gpt-6-luna` $0.10 / $0.50 | `gemini-3.5-flash-lite` $0.30 / $2.50 |
| 平衡 | `claude-sonnet-5-5` $2 / $10 | `gpt-6.2-sol` $2 / $10 | `gemini-4-hydrogen` $1.50 / $7.50 |
| 旗艦 | `claude-opus-5-5` $4 / $20 | `gpt-6.2-astra` $8 / $40 | `gemini-4-carbon` $4 / $20（2026-12-01 起；之前 $2 / $10） |

reasoning／thinking 都設在該 model 允許的最低檔（OpenAI `reasoning.effort`、Gemini `thinking_level`、Claude `effort: low`），因為這些 token 以 output 計價。實測 kube-scheduler 頁面（約 75 段）：Haiku ≈ $0.0013、GPT-6 Luna ≈ $0.0015、Flash-Lite ≈ $0.005、GPT-6.2 Sol ≈ $0.026、Hydrogen ≈ $0.044（`low` 仍有大量 thinking）、Carbon ≈ $0.051（12 月價格）。GPT-6.2 Astra 只做過小請求測試。

## 使用

- 點擴充功能圖示開啟選單：切換目標語言或 model、翻譯此頁或顯示原文、進入設定。換語言時，已翻譯的頁面會立即用新語言重翻。
- 也可以直接按快捷鍵切換翻譯，預設是 `Alt+A`（macOS 為 `⌥A`）。快捷鍵可以在 `chrome://extensions/shortcuts` 修改，選單上的按鈕會顯示目前實際綁定的鍵。
- **YouTube 雙語字幕**：在 YouTube 影片頁，選單會多一個「開啟雙語字幕」，快捷鍵預設 `Alt+S`（macOS 為 `⌥S`）。和網頁翻譯是兩個獨立開關，可以只翻字幕或只翻留言。換到同一分頁的其他影片時，字幕會繼續作用；重新整理頁面後要再開一次。
- 翻譯失敗時，右上角會出現提示框，例如 API key 沒設定或無效時附「開啟設定」按鈕。點段落旁的 ⚠ 可以看該段失敗的原因；修正後關閉再開啟翻譯，就會重試失敗的段落。
- 每批翻譯會在 `chrome://extensions` →「Service Worker」→ Console 印出統計：段數、命中 cache 的數量、送出 API 的數量、耗時、token 用量。

## 架構

```
content script (按下時才注入)            background service worker
  segmenter: 切出 inline run            translator: 去重 → IndexedDB cache → provider
  IntersectionObserver: 只翻可視範圍  ──Port──►  providers/: Anthropic SDK、OpenAI／Gemini fetch + SSE
  MutationObserver: SPA / 動態內容     ◄──────  protocol: "[n] text" 逐行格式，邊收邊解析
  render: 在原元素內插入 <llmt-translation>
```

| 檔案 | 責任 |
|---|---|
| `src/content/segmenter.ts` | 決定哪些文字算一段、譯文插在哪、同行或換行 |
| `src/content/index.ts` | 可視範圍排程、batching（每批最多 3000 字元或 40 段）、渲染、SPA 重新掃描 |
| `src/background/translator.ts` | 每批的處理流程；保證每段一定會收到譯文或錯誤 |
| `src/background/protocol.ts` | prompt，以及 streaming 輸出的 parser |
| `src/background/providers/` | `TranslationProvider` 介面與三家實作；`registry.ts` 依 model 選 provider |
| `src/popup/popup.ts` | 工具列選單 |
| `src/shared/tab-control.ts` | 分頁的注入、切換與狀態查詢（選單與快捷鍵共用） |
| `src/content/toast.ts` | 錯誤提示框（Shadow DOM） |
| `src/page/youtube-hook.ts` | 注入 YouTube 頁面 main world 的唯讀 hook：讀播放器自己下載的字幕（`/api/timedtext`），轉給 content script |
| `src/shared/youtube-bridge.ts` | hook 與 content script 之間的訊息格式（`document` 上的 CustomEvent，JSON 字串）與驗證 |
| `src/content/youtube/captions.ts` | json3 解析、字幕合併成句子、選要翻譯的原文軌道 |
| `src/content/youtube/refill.ts` | 補貨式排程：一次翻 5 分鐘，前方剩不到 60 秒時再補 |
| `src/content/youtube/controller.ts` | 字幕的生命週期：開關、換影片、送翻譯、對時間軸顯示 |
| `src/content/youtube/overlay.ts` | 播放器內的雙語字幕框 |

設計決策：

- **逐行格式，不用 JSON**：每行一段，收到一行就能先渲染，譯文會一段段出現。
- **譯文插在原元素內**：自動繼承字型、顏色和連結樣式。只有單一 `<a>` 的段落，譯文放進 `<a>` 裡，點譯文也能觸發連結。
- **按下時才注入**：用 `activeTab` 加 `scripting`，不會在每個頁面常駐 content script，也不需要 `<all_urls>` 權限。
- **OpenAI 與 Gemini 直接用 `fetch` 打 REST**：不引入 SDK（兩者都在密集發版），請求格式依官方 API reference；兩家都送 `store: false`，頁面內容不在對方保存。只有 Anthropic 需要明確的 prompt cache breakpoint 與 warm-up；另外兩家是自動快取。
- **YouTube 字幕讀播放器自己的請求，不自己抓**：YouTube 的字幕網址有簽章和播放器產生的 `pot` token，自己組的請求常拿到空內容或 429。hook 只讀不改 response，並只收主播放器（`#movie_player`）目前影片的字幕，縮圖預覽的請求會被丟掉。開啟時切一次 CC 逼播放器重抓，所以不需要常駐或 youtube.com 的 host permission。播放器選的軌道已經是目標語言時（例如 TED 的中文字幕），改抓「跟自動字幕同語言的人工字幕」當原文；判斷不出原文就不翻。
- **API key 只存在 `chrome.storage.local`**：不經 Chrome Sync，並設定 `setAccessLevel("TRUSTED_CONTEXTS")`，content script 讀不到。

## 測試

```bash
npm test             # vitest：parser、batch 流程、segmenter（happy-dom）、provider（本機 mock SSE server）
npm run typecheck
```

## 已知限制（MVP）

- 段落中的連結和粗體等格式不會帶進譯文，譯文是純文字
- cache 沒有淘汰機制
- `<button>`、`<pre>`、`[translate=no]`、contenteditable 都不翻譯
- Shadow DOM 和 iframe 內的內容不會被掃到
- 隱藏文字過濾是 best-effort：會擋下常見手法，包括 display/visibility/opacity、sr-only clip、零寬或零高的 overflow 容器、小於 2px 的字、透明字，以及不可見的 Unicode 字元。同色字（白字白底）、頁面上方 600px 內的絕對定位文字、`transform` 等手法擋不住。主要防線是 system prompt（把頁面文字當資料，不當指令）和 cache 依 origin 分區；注入最多只能竄改同一頁的譯文。
- YouTube 字幕只支援 `www.youtube.com/watch`：Shorts、embed、m.youtube.com、YouTube Music 與直播都還不支援；影片沒有字幕時不會產生字幕。依賴 YouTube 內部的 DOM（`#movie_player`、`.caption-window`、`.ytp-subtitles-button`）與播放器 API，YouTube 改版時可能失效。
- 隱藏的區塊在畫面內時每秒重查一次，捲動揭露（AOS、WOW.js）、下拉選單、手風琴打開後才會翻譯。
