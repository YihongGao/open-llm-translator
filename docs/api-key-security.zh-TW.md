# API key 如何受到保護

[English](api-key-security.md) | 繁體中文

**簡單說：** 網頁、其他擴充功能和 Chrome Sync 都拿不到您的 key，而且沒有開發者伺服器，開發者不會收到您的 key；但您電腦上的惡意程式拿得到。請使用專為這個擴充功能建立、並設有用量上限的 key，這樣最壞的情況損失也有限。

## key 存在哪裡

您的 key 存在擴充功能自己的儲存空間 [`chrome.storage.local`](https://developer.chrome.com/docs/extensions/reference/api/storage#storage-areas)，位於您的電腦上。

- **沒有加密**。Chrome 以明文存在您的 Chrome 設定檔資料夾裡。
- **不會同步**：擴充功能不使用 `chrome.storage.sync`，key 不會傳到您的 Google 帳號或其他裝置。
- **隨時可以刪除**：設定頁每個 key 旁邊都有「清除」按鈕。移除擴充功能時也會一併刪除。清除瀏覽資料則不會刪掉它。

key 只在擴充功能的背景 service worker 裡使用，透過 HTTPS 呼叫您選擇的服務商（`api.anthropic.com`、`api.openai.com` 或 `generativelanguage.googleapis.com`），不會送到其他地方。

## 哪些情況擋得住

| 誰可能想拿您的 key | 擋得住嗎 | 怎麼擋 |
|---|---|---|
| 您瀏覽的網頁 | 是 | 網頁讀不到擴充功能的儲存空間。擴充功能放進網頁裡的程式（content script）也被擋在外面：注入之前，擴充功能會先呼叫 `chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })`，只允許擴充功能自己的頁面和 service worker 存取；這個呼叫失敗就不注入。key 也從不傳到網頁。 |
| 其他擴充功能 | 是 | 每個擴充功能的 `chrome.storage` 各自獨立，彼此讀不到。 |
| Google（透過 Chrome Sync） | 是 | key 只存在 `local`，不存在 `sync`。 |
| 開發者的伺服器 | 是 | 根本沒有開發者伺服器，瀏覽器直接連到服務商。原始碼公開，可以自行檢查。 |
| 顯示在網頁上的錯誤訊息 | 是 | 有些服務商會在錯誤訊息裡重複 key。錯誤訊息送到網頁之前，看起來像 key 的字串（`sk-…`、`AIza…`）會先被遮掉。 |
| **您電腦上的惡意程式，或能登入您電腦帳號的人** | **否** | 能讀您檔案的程式就能讀 Chrome 設定檔資料夾，key 以明文存在那裡。 |
| 被入侵的擴充功能更新（例如開發者的 Chrome Web Store 帳號被盜） | 部分 | 原始碼開源、每個 commit 都有簽章、release 附 [build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations)，Chrome Web Store 也會審查每次更新，但無法完全排除。 |

最後兩項並非這個擴充功能獨有。所有要自備 API key 的工具（瀏覽器擴充功能、命令列工具、編輯器外掛）都會把 key 存在電腦某處，電腦上的惡意程式都找得到。

### 為什麼不加密？

加密需要另一把金鑰來解密，而擴充功能沒有比自己的儲存空間更安全的地方可以放那把金鑰。能讀到其中一個的惡意程式就能讀到另一個，所以加密只是看起來比較安全。Chrome 也沒有開放擴充功能使用作業系統的密碼管理（Keychain、Windows 認證管理員）。

## 您可以怎麼做

以下做法能在 key 被盜時把損失降到最低：

1. **為這個擴充功能另建專用的 key**，不要和其他專案共用。這樣能單獨看到它的用量，撤銷時也不會影響其他服務。
2. **在服務商那邊設定費用上限**：[Anthropic](https://console.anthropic.com/settings/limits)、[OpenAI](https://platform.openai.com/settings/organization/limits)、[Google AI Studio](https://aistudio.google.com/spend)（**Monthly spend cap**；Google 標示為實驗性功能，並說明實際花費可能超出約 10 分鐘的用量）。採用預付額度並關閉自動儲值，也是一道硬上限：餘額用完，請求就會停止。

   Gemini 的 key 請在 [AI Studio](https://aistudio.google.com/apikey) 建立。2026 年 5 月之後在那裡建立的 key 只能呼叫 Gemini API，即使外洩也無法拿去用其他 Google Cloud 服務。在 AI Studio 顯示 **Unrestricted** 的舊 key 會被 Gemini API 拒絕；請點 **Add restrictions** → **Restrict to Gemini API only**。詳見 Google 的 [API key 說明](https://aistudio.google.com/docs/api-key)。
3. **懷疑外洩時，請到服務商網站撤銷 key**，再建一把新的，舊 key 隨即失效。只在擴充功能裡按「清除」並不夠，已經被偷走的副本在撤銷之前仍然有效。
4. 保持電腦沒有惡意程式：這是擴充功能唯一無法替您防範的情況。

## 自行查證

Chrome 官方文件：

- [`chrome.storage` API](https://developer.chrome.com/docs/extensions/reference/api/storage)：各儲存區、`setAccessLevel()`、資料何時被清除。
- [Stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure)：為什麼不能把機密資料交給 content script。

本 repo 的程式碼：

- [`src/shared/settings.ts`](../src/shared/settings.ts)：設定（包括 key）只讀寫 `chrome.storage.local`。
- [`src/shared/tab-control.ts`](../src/shared/tab-control.ts)：注入任何程式到網頁之前，先執行 `setAccessLevel("TRUSTED_CONTEXTS")`。
- [`src/background/redact.ts`](../src/background/redact.ts)：遮掉錯誤訊息裡像 key 的字串。
- [`public/manifest.json`](../public/manifest.json)：擴充功能只有三家服務商 API 的 host permission。

如果您發現上面沒列到的方法能拿到 key，請私下回報，見 [SECURITY.md](../SECURITY.md)。
