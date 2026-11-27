# Contributing

Thanks for helping. Issues and pull requests are welcome in English or Chinese.

For how the extension is put together, read [docs/architecture.md](docs/architecture.md) first.

## Setup

You need Node.js 24 and Chrome 120 or later.

```bash
npm install
npm run build        # writes dist/
```

Load it: open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select `dist/`.

While developing, run `npm run dev` (esbuild watch) and press reload on `chrome://extensions` after each change. Files in `public/` are copied only when `dev` starts, so restart it after editing them.

Each batch logs its stats (segments, cache hits, segments sent, time, token usage and estimated cost) to the service worker console: on `chrome://extensions`, click **Service Worker** under the extension.

## Commands

```bash
npm run build        # esbuild → dist/
npm run dev          # watch mode
npm run typecheck    # tsc --noEmit (src, scripts, tests)
npm test             # vitest
npx vitest run tests/segmenter.test.ts            # one file
npx vitest run tests/segmenter.test.ts -t "name"  # one test
npm run check:dist   # Chrome Web Store rejection checks on dist/ (build first)
npm run package      # typecheck + test + build + check:dist → release/*.zip
```

## Tests

- Unit tests run in Node by default. Tests that touch the DOM need `// @vitest-environment happy-dom` as their first line.
- Provider tests run against a local mock SSE server, never the real APIs.
- Tests run under a zh_TW browser with the UI language setting on "Follow browser" (`tests/helpers/setup-i18n.ts` resets both before each test). `t()` reads the catalogs itself and asks `chrome.i18n` only for `getUILanguage()`, so a test that replaces `globalThis.chrome` must keep `i18n`: add `i18n: i18nStub()` from `tests/helpers/i18n.ts`, or call `useLocale("ja")` to change the browser language. To test the user's choice, call `setUiLanguage("ja")` from `src/shared/i18n.ts`.
- A behavior change comes with a test that fails without the change.

### End-to-end

The E2E harness loads the extension into Playwright's Chromium and drives it like a user (toolbar popup, page, options page), with the LLM API mocked at the network boundary. It is free and needs no API key.

```bash
npx playwright install chromium   # once
npm run build:e2e                 # writes dist-e2e/ (adds <all_urls>; never ship it)
node .claude/skills/verify/scripts/doctor.mjs
node .claude/skills/verify/scripts/journey-page-translation.mjs
```

The harness and feature recipes are documented in [.claude/skills/verify/SKILL.md](.claude/skills/verify/SKILL.md). CI runs every `.claude/skills/verify/scripts/journey-*.mjs`, so a new journey must use the mock and exit non-zero on failure. If you change something users see (popup, options page, rendered translations, notices, YouTube subtitles), run or add the matching journey.

`scripts/e2e.mjs` covers what the mock cannot: `no-key` and `measure` are free, but `translate <url>` **makes real API calls and costs money**. Keys come from the environment or `.env.local` (gitignored); see the header of `scripts/e2e.mjs`.

## Pull requests

- `main` only accepts changes through pull requests.
- **Commits must be signed** (GPG or SSH) and show as Verified on GitHub. To sign with your existing SSH key:
  ```bash
  git config --global gpg.format ssh
  git config --global user.signingkey ~/.ssh/id_ed25519.pub
  git config --global commit.gpgsign true
  ```
  Then add the same public key on GitHub under Settings → SSH and GPG keys → **New SSH key** with key type **Signing Key**. See [GitHub's guide](https://docs.github.com/authentication/managing-commit-signature-verification).
- The `ci-ok` check must pass. It covers typecheck, unit tests on Linux and Windows, the build, the store checks and the E2E journeys.
- Merge with a merge commit or squash; rebase merging is blocked by the signature rule.

### Things to keep in step

- **Adding or changing a user-facing string**: the catalog is `public/_locales/{en,ja,zh_CN,zh_TW}/messages.json`. Add the key to all four files (zh_CN is natural mainland wording, not a conversion of zh_TW) (a test fails if one lacks it, or if placeholders differ), then use `t("key", ...subs)` from `src/shared/i18n.ts`, which looks the key up in the bundled catalogs itself (it does not call `chrome.i18n.getMessage`, which cannot follow the options page's UI language setting). Strings set by code rather than markup must be rebuilt when the language changes: the options page does that in `fillGeneratedText()`. In HTML, put English text in the element with `data-i18n="key"` (also `data-i18n-aria-label` and `data-i18n-title`); `localizePage()` fills it at run time and a test checks the English fallback against the catalog. Use named placeholders (`$provider$` with `"content": "$1"`), numbered in order of first appearance in the English text, and pass substitutions in that order. Write raw UTF-8, never `\uXXXX`. Use full-width punctuation only in ja, zh_CN and zh_TW. Set strings with `textContent` or attributes, never `innerHTML`. Not translated: the LLM prompt in `protocol.ts` and `console.*` logs. Language names in the target-language picker stay in their own language.
- **Adding or changing a model**: update `MODELS` in `src/shared/settings.ts`, `PRICES` in `src/background/pricing.ts`, and the model table in both `README.md` and `README.zh-TW.md`.
- **Changing what data is sent or stored**: update [docs/privacy-policy.md](docs/privacy-policy.md).
- **Store constraints**: the shipped bundle must not contain source maps, `eval(`, `new Function(`, `importScripts(` or remote `import()`, and must not request broad host permissions. `npm run check:dist` enforces this; keep new code and dependencies compatible with it.

## Releases (maintainers)

1. Bump `version` in both `package.json` and `public/manifest.json` and merge that change.
2. Tag the merge commit and push the tag:
   ```bash
   git tag v0.2.0 && git push origin v0.2.0
   ```
3. `.github/workflows/release.yml` checks that the tag matches both versions, runs `npm run package`, attests the zip and attaches it to a GitHub Release.
4. Upload that zip to the Chrome Web Store by hand. Listing text is in [docs/store-submission.md](docs/store-submission.md).
