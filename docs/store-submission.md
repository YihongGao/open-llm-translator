# Chrome Web Store 送審資料

Developer Dashboard 各欄位要填的內容。理由類欄位用英文寫，給審查人員看；商店說明用繁中，給使用者看。

送審前檢查：

- [ ] `npm run package` 通過，上傳 `release/llm-bilingual-translator-<version>.zip`
- [ ] `public/manifest.json` 的 `version` 比上一次上傳的高
- [ ] `docs/privacy-policy.md` 已合併進 `main`（隱私權政策網址指向 `main` 上的檔案），`<contact email>` 已替換
- [ ] 測試用 API key 已建立，放在有花費上限的 workspace（見「Test instructions」）

---

## Store listing

**Description（manifest，132 字元內）**：取自 `public/manifest.json`

> 在原文下方顯示 LLM 翻譯（雙語對照）

**Detailed description**

```
用大型語言模型（LLM）翻譯網頁，譯文直接顯示在每段原文下方，原文和譯文對照閱讀。

【需要自備 API key】
本擴充功能不提供翻譯額度。請在設定頁填入你自己的 API key，支援：
• Anthropic（Claude Haiku／Sonnet／Opus）
• OpenAI（GPT）
• Google（Gemini）
只需要填你要用的那一家。費用依各服務商的 API 價格，由你的帳號支付。

【功能】
• 雙語對照：譯文插在原文下方，沿用原頁面的字型與連結
• 只翻畫面上看得到的段落，捲動時再翻下一批，省 token
• 譯文邊產生邊顯示，不用等整頁翻完
• 支援動態載入的內容與單頁應用（SPA）
• 譯文快取在本機，同一段文字不重複計費
• 目標語言：繁體中文（台灣）、简体中文、English、日本語、한국어

【YouTube 雙語字幕】
在 YouTube 影片上開啟雙語字幕，原文和譯文一起顯示在影片下方，全螢幕也看得到。
• 把字幕合併成完整句子再翻，自動產生的字幕也能翻得通順
• 只翻播放位置前方幾分鐘，看多少翻多少
• 和網頁翻譯分開：可以只翻字幕，或只翻留言

【使用方式】
點工具列圖示開啟選單，按「翻譯此頁」；或直接按快捷鍵 Alt+A（macOS 為 Option+A）。
在 YouTube 影片頁，選單會多一個「開啟雙語字幕」，快捷鍵 Alt+S（macOS 為 Option+S）。

【隱私】
只有你按下翻譯（或開啟字幕）的分頁，才會把要翻譯的文字、頁面標題與網址（不含查詢字串）送到你選擇的服務商。沒有開發者伺服器，不蒐集分析或遙測資料。API key 只存在本機，不經 Chrome Sync 同步。

YouTube 與 Gemini 是 Google LLC 的商標，Claude 是 Anthropic PBC 的商標，OpenAI 與 GPT 是 OpenAI 的商標。本擴充功能與這些公司無關，也未經它們認可。
```

**Category**：Tools（或 Productivity）

**Language**：Chinese (Traditional)

**Graphic assets**

| 素材 | 規格 | 狀態 |
|---|---|---|
| Store icon | 128×128 | `public/icons/icon-128.png` |
| Screenshot | 1280×800 或 640×400，1 到 5 張 | `docs/store-assets/screenshot-1-docs-popup.png`、`docs/store-assets/screenshot-2-article.png`；YouTube 字幕截圖待補 |
| Small promo tile | 440×280 | `docs/store-assets/promo-small-440x280.png` |

---

## Privacy practices

**Single purpose description**

```
Translates the text of the current web page with a large language model chosen by the user and shows each translation directly below the original paragraph, so the page can be read bilingually. On YouTube video pages, the same translation can be applied to the video's subtitles, shown bilingually in the player.
```

**Permission justification**

| Permission | Justification |
|---|---|
| `activeTab` | When the user clicks the toolbar button or presses the keyboard shortcut, the extension gets temporary access to the current tab so it can read the paragraphs to translate and insert the translations below them. It has no access to other tabs, and no access before the user acts. |
| `scripting` | Used only after the user acts. When the user starts a translation, it injects the packaged content.js and content.css into the active tab with chrome.scripting.executeScript and insertCSS. When the user turns on bilingual subtitles on a YouTube video, it also injects the packaged youtube-hook.js into the page's main world. While subtitles are on, that script: (1) wraps XMLHttpRequest.prototype.open and send to copy the caption responses (/api/timedtext) that the player downloads, without changing any request or response; (2) clicks the player's CC button so that the player requests captions (off and on again if CC is already on), and turns CC off afterwards if it turned CC on; (3) if the player's captions are already in the target language, fetches the original-language track from YouTube's /api/timedtext in the page's own context. When subtitles are off, every request passes through unchanged. No content scripts run automatically on any site. |
| `storage` | Stores the user's settings (selected model, target language) and the API keys the user enters, in chrome.storage.local only (never synced). Access is restricted to extension pages with setAccessLevel(TRUSTED_CONTEXTS). |
| Host permission `https://api.anthropic.com/*` | Sends the text to translate to the Anthropic API with the user's own API key, only when the user has selected a Claude model. |
| Host permission `https://api.openai.com/*` | Sends the text to translate to the OpenAI API with the user's own API key, only when the user has selected a GPT model. |
| Host permission `https://generativelanguage.googleapis.com/*` | Sends the text to translate to the Google Gemini API with the user's own API key, only when the user has selected a Gemini model. |

**Are you using remote code?**：No, I am not using remote code.（所有 JS 都打包在 zip 裡，`npm run package` 會檢查 `eval`、`new Function`、`importScripts` 與遠端 `import()`）

**Data usage — What user data do you plan to collect?**

| 類別 | 勾選 | 理由 |
|---|---|---|
| Personally identifiable information | 否 | |
| Health information | 否 | |
| Financial and payment information | 否 | |
| Authentication information | **是** | 使用者的 LLM API key（只存在本機，只送到對應服務商） |
| Personal communications | **是** | 見下方說明 |
| Location | 否 | |
| Web history | **是** | 送出所翻譯頁面的網域與路徑，保守起見申報 |
| User activity | 否 | |
| Website content | **是** | 要翻譯的段落文字與頁面標題；YouTube 上開啟雙語字幕時，還有影片字幕文字 |

說明：使用者在 webmail 或聊天頁面上按翻譯時，送出的文字可能包含私人訊息，所以「Personal communications」也勾選。多申報不會被罰，少申報才會被審查挑出來。

**Certifications**：三項全部勾選

- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL**：

```
https://github.com/YihongGao/llm-translator/blob/main/docs/privacy-policy.md
```

這個網址要等 `docs/privacy-policy.md` 合併進 `main` 才有效，且檔案不能改名或搬移。之後改成獨立網頁時，記得同步更新 dashboard 的這個欄位。

---

## Test instructions

測試用 key 的建議做法：在 Anthropic Console 為審查開一個獨立 workspace，設定低的月花費上限，在該 workspace 建 key。過審後不要 revoke，之後每次送審都會再用到。

Username：留空

Password：測試用 API key

Additional instructions：

```
This extension needs the user's own LLM API key. A test key for Anthropic with a small spend limit is in the Password field.

The UI is in Traditional Chinese; English equivalents are given below.

1. Right-click the toolbar icon and choose "Options" (選項).
2. In "Model", keep the default "Claude Haiku 5.5".
3. Paste the key into "Anthropic API key", click 儲存 (Save), then 測試連線 (Test connection). A sample translation appears next to the buttons.
4. Open an English article, for example https://kubernetes.io/docs/concepts/overview/
5. Click the toolbar icon and press 翻譯此頁 (Translate this page), or press Alt+A (Option+A on macOS).
   Traditional Chinese translations appear below each paragraph as they stream in.
6. The popup button now reads 顯示原文 (Show original). Press it, or the shortcut, to hide the translations.
7. To test YouTube subtitles, open https://www.youtube.com/watch?v=arj7oStGLkU (a TED talk with English subtitles).
8. Click the toolbar icon and press 開啟雙語字幕 (Turn on bilingual subtitles), or press Alt+S (Option+S on macOS).
   The English subtitles and their Traditional Chinese translation appear at the bottom of the player.

Without an API key, the popup shows "尚未設定 Anthropic（Claude） 的 API key。" (Anthropic API key not set), and the page shows the same notice with a 開啟設定 (Open settings) button.
```
