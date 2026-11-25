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

## Model

每家三檔，依價格與定位對應（價格為每百萬 token 的 input / output，2026-11）：

| 檔位 | Anthropic | OpenAI | Gemini |
|---|---|---|---|
| 便宜、快 | `claude-haiku-5-5`（預設）$0.10 / $0.50 | `gpt-6-luna` $0.10 / $0.50 | `gemini-3.5-flash-lite` $0.30 / $2.50 |
| 平衡 | `claude-sonnet-5-5` $2 / $10 | `gpt-6.2-sol` $2 / $10 | `gemini-4-hydrogen` $1.50 / $7.50 |
| 旗艦 | `claude-opus-5-5` $4 / $20 | `gpt-6.2-astra` $8 / $40 | `gemini-4-carbon` $4 / $20（2026-12-01 起；之前 $2 / $10） |

reasoning／thinking 都設在該 model 允許的最低檔（OpenAI `reasoning.effort`、Gemini `thinking_level`、Claude `effort: low`），因為這些 token 以 output 計價。實測 kube-scheduler 頁面（約 75 段）：Flash-Lite ≈ $0.005、Hydrogen ≈ $0.044（`low` 仍有大量 thinking）、Carbon ≈ $0.051（12 月價格）、Haiku ≈ $0.0013。

## 使用

- 點擴充功能圖示開啟選單：切換目標語言或 model、翻譯此頁或顯示原文、進入設定。換語言時，已翻譯的頁面會立即用新語言重翻。
- 也可以直接按快捷鍵切換翻譯，預設是 `Alt+A`（macOS 為 `⌥A`）。快捷鍵可以在 `chrome://extensions/shortcuts` 修改，選單上的按鈕會顯示目前實際綁定的鍵。
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

設計決策：

- **逐行格式，不用 JSON**：每行一段，收到一行就能先渲染，譯文會一段段出現。
- **譯文插在原元素內**：自動繼承字型、顏色和連結樣式。只有單一 `<a>` 的段落，譯文放進 `<a>` 裡，點譯文也能觸發連結。
- **按下時才注入**：用 `activeTab` 加 `scripting`，不會在每個頁面常駐 content script，也不需要 `<all_urls>` 權限。
- **OpenAI 與 Gemini 直接用 `fetch` 打 REST**：不引入 SDK（兩者都在密集發版），請求格式依官方 API reference；兩家都送 `store: false`，頁面內容不在對方保存。只有 Anthropic 需要明確的 prompt cache breakpoint 與 warm-up；另外兩家是自動快取。
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
