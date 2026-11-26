# How your API key is protected

English | [繁體中文](api-key-security.zh-TW.md)

**Short version:** web pages, other extensions and Chrome Sync cannot get your key, and there is no developer server, so the developer never receives it. Malware running on your computer can. Use a key made only for this extension, with a spending limit, and the worst case stays small.

## Where the key is stored

Your key is saved in the extension's own storage, [`chrome.storage.local`](https://developer.chrome.com/docs/extensions/reference/api/storage#storage-areas), on your computer.

- It is **not encrypted**. Chrome keeps it as plain text in your Chrome profile folder.
- It is **not synced**: the extension does not use `chrome.storage.sync`, so the key never goes to your Google account or your other devices.
- You can **delete it at any time** with the **清除** (Clear) button next to each key on the options page. Removing the extension also deletes it. Clearing browsing data does not.

The key is used only in the extension's background service worker, to call the provider you selected (`api.anthropic.com`, `api.openai.com` or `generativelanguage.googleapis.com`) over HTTPS. It goes nowhere else.

## What protects it

| Who might try to get your key | Protected? | How |
|---|---|---|
| A web page you visit | Yes | Web pages cannot read an extension's storage. The extension's script inside the page (its *content script*) is also locked out: before it is injected, the extension calls `chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })`, which limits storage to the extension's own pages and service worker. If that call fails, nothing is injected. The key is never sent to the page. |
| Another extension | Yes | Each extension's `chrome.storage` is separate. Other extensions cannot read it. |
| Google, through Chrome Sync | Yes | The key is stored only in `local`, never in `sync`. |
| The developer's server | Yes | There is none. Your browser talks to the provider directly. The source code is public, so you can check this. |
| An error message shown on the page | Yes | Some providers repeat the key in their error messages. Key-shaped text (`sk-…`, `AIza…`) is masked before any error reaches the page. |
| **Malware on your computer, or someone who can sign in to your computer account** | **No** | Anything that can read your files can read the Chrome profile folder, and the key is there in plain text. |
| A compromised update of this extension (for example, if the developer's Chrome Web Store account were hijacked) | Partly | The code is open source, every commit is signed, release builds carry a [build provenance attestation](https://docs.github.com/actions/security-for-github-actions/using-artifact-attestations), and Chrome Web Store reviews each update. None of this makes it impossible. |

The last two rows are not specific to this extension. Every tool where you bring your own API key (browser extensions, command-line tools, editor plugins) stores the key somewhere on your computer, and malware on that computer can find it.

### Why not encrypt it?

Encryption needs a second key to decrypt with, and an extension has nowhere safer than its own storage to put that second key. Malware that can read one can read the other, so encryption would look safer without being safer. Chrome does not give extensions access to the operating system's password store (Keychain, Windows Credential Manager).

## What you can do

These steps limit the damage even if your key is stolen:

1. **Create a key only for this extension.** Do not reuse a key from other projects. You can then see this extension's usage on its own and revoke the key without breaking anything else.
2. **Set a spending limit with your provider**: [Anthropic](https://console.anthropic.com/settings/limits), [OpenAI](https://platform.openai.com/settings/organization/limits), [Google AI Studio](https://aistudio.google.com/spend) (**Monthly spend cap**; Google marks it experimental and notes spending can overshoot it by about 10 minutes of usage). Prepaid credit with automatic top-up turned off is a hard ceiling too: when the balance reaches zero, requests stop.

   For Gemini, create the key in [AI Studio](https://aistudio.google.com/apikey). Keys created there since May 2026 can call only the Gemini API, so a leaked key cannot be used for other Google Cloud services. An older key that shows **Unrestricted** in AI Studio is rejected by the Gemini API; use **Add restrictions** → **Restrict to Gemini API only**. See Google's [API key guide](https://aistudio.google.com/docs/api-key).
3. **Revoke the key** on the provider's site if you think it leaked, then create a new one. The old key then stops working. Deleting it from the extension (**清除** on the options page) is not enough on its own, because a copy that was already stolen keeps working until you revoke it.
4. Keep your computer free of malware: this is the one case the extension cannot protect against.

## Check it yourself

Chrome documentation:

- [`chrome.storage` API](https://developer.chrome.com/docs/extensions/reference/api/storage): storage areas, `setAccessLevel()`, and when data is cleared.
- [Stay secure](https://developer.chrome.com/docs/extensions/develop/security-privacy/stay-secure): why content scripts must not receive secrets.

In this repository:

- [`src/shared/settings.ts`](../src/shared/settings.ts): settings, including the key, are read from and written to `chrome.storage.local` only.
- [`src/shared/tab-control.ts`](../src/shared/tab-control.ts): `setAccessLevel("TRUSTED_CONTEXTS")` runs before any script is injected into a page.
- [`src/background/redact.ts`](../src/background/redact.ts): masks key-shaped text in error messages.
- [`public/manifest.json`](../public/manifest.json): the extension has host permission only for the three provider APIs.

Found a way to get the key that is not listed above? Please report it privately: see [SECURITY.md](../SECURITY.md).
