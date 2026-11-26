# Privacy Policy — LLM Bilingual Translator

_Last updated: 2026-11-26_

LLM Bilingual Translator ("the extension") translates web pages with a large language model (LLM) and shows each translation below the original text. This policy explains what data the extension handles and where it goes.

The extension has no server of its own. The developer does not receive, collect, or store any of your data.

## What is sent, and to whom

Only when you start a translation (by clicking the toolbar button or pressing the keyboard shortcut) on a tab, the extension sends the following to the LLM provider of the model you selected, using **your own API key**:

| Data | Details |
|---|---|
| Text to translate | The paragraphs of the current page that are on screen or scrolled into view while translation is on |
| Page title | Up to 200 characters, used as translation context |
| Page address | Origin and path only (for example `https://example.com/docs/intro`). Query strings and fragments are removed before sending |
| Video subtitles (YouTube only) | When you turn on bilingual subtitles on a YouTube video: the video's caption text, a few minutes ahead of playback, with the video title as the page title. The video ID is not sent: the address is reduced to `https://www.youtube.com/watch` |

To get the captions, the extension reads the caption data that YouTube's player downloads in that tab. When the player shows captions already in your target language, the extension downloads the original-language captions from YouTube itself, in the same way the player does. This happens only while subtitles are on.

Depending on the model you selected, the data goes to exactly one of these providers:

| Provider | Endpoint | Provider's terms |
|---|---|---|
| Anthropic (Claude models) | `api.anthropic.com` | https://www.anthropic.com/legal/privacy |
| OpenAI (GPT models) | `api.openai.com` | https://openai.com/policies/privacy-policy |
| Google (Gemini models) | `generativelanguage.googleapis.com` | https://policies.google.com/privacy |

How the provider stores or uses this data is governed by your agreement with that provider under your API key, not by this extension. Nothing is sent from pages where you have not started a translation.

## What is stored on your device

| Data | Where | Purpose |
|---|---|---|
| Your API keys, selected model, target language | `chrome.storage.local` | Settings. Not synced through Chrome Sync, and not readable by web pages or content scripts |
| Translations | IndexedDB inside the extension | Cache, so the same text is not translated (and billed) twice. Each entry holds the translated text, the model name and a timestamp, under a hashed key |

This data stays on your device. Removing the extension deletes all of it.

## What the extension does not do

- It does not collect analytics, telemetry, or usage statistics.
- It does not sell or transfer your data to anyone other than the LLM provider you chose, and only to perform the translation you asked for.
- It does not use your data for advertising, creditworthiness, or any purpose unrelated to translation.
- It does not run on pages until you start a translation (or turn on subtitles) on them.

The extension's handling of user data complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements.

## Changes

Changes to this policy will be published at this address with a new "Last updated" date.

## Contact

<!-- TODO: replace with the publisher's contact address before publishing -->
Questions: `<contact email>`

---

# 隱私權政策（繁體中文）

_最後更新：2026-11-26_

LLM Bilingual Translator（以下稱「本擴充功能」）用大型語言模型（LLM）翻譯網頁，並把譯文顯示在原文下方。本政策說明本擴充功能處理哪些資料、送到哪裡。

本擴充功能沒有自己的伺服器，開發者不會收到、蒐集或儲存你的任何資料。

## 送出哪些資料、送給誰

只有在你於某個分頁開始翻譯（點工具列按鈕或按快捷鍵）時，本擴充功能才會用**你自己的 API key**，把以下資料送到你所選 model 的服務商：

| 資料 | 說明 |
|---|---|
| 要翻譯的文字 | 翻譯開啟期間，畫面上或捲動進入畫面的段落 |
| 頁面標題 | 最多 200 字，作為翻譯的上下文 |
| 頁面網址 | 只含網域與路徑（例如 `https://example.com/docs/intro`），送出前會移除查詢字串與 `#` 之後的部分 |
| 影片字幕（僅 YouTube） | 你在 YouTube 影片開啟雙語字幕時：影片的字幕文字（翻譯播放位置前方幾分鐘的內容），並以影片標題作為頁面標題。不會送出影片 ID：網址只剩 `https://www.youtube.com/watch` |

為了取得字幕，本擴充功能會讀取 YouTube 播放器在該分頁下載的字幕資料。播放器顯示的字幕已經是目標語言時，本擴充功能會用和播放器相同的方式，向 YouTube 下載原文字幕。只有在字幕開啟期間才會這樣做。

依你選的 model，資料只會送到以下其中一家：Anthropic（`api.anthropic.com`）、OpenAI（`api.openai.com`）、Google（`generativelanguage.googleapis.com`）。服務商如何保存與使用這些資料，依你和該服務商之間的 API 條款而定。沒有開始翻譯的頁面，不會送出任何資料。

## 存在你電腦上的資料

- **API key、所選 model、目標語言**：存在 `chrome.storage.local`，不經 Chrome Sync 同步，網頁與 content script 都讀不到。
- **譯文快取**：存在本擴充功能的 IndexedDB，避免同一段文字重複翻譯和計費。每筆只有譯文、model 名稱和時間，key 是雜湊值。

這些資料只留在你的電腦上，移除本擴充功能就會一併刪除。

## 本擴充功能不會做的事

- 不蒐集分析、遙測或使用統計。
- 除了為完成你要求的翻譯而送到你選的服務商之外，不出售、不轉交資料給任何人。
- 不把資料用於廣告、信用評估或任何與翻譯無關的用途。
- 在你開始翻譯（或開啟字幕）之前，不會在頁面上執行。

## 聯絡方式

<!-- TODO: 發佈前換成發佈者的聯絡信箱 -->
`<contact email>`
