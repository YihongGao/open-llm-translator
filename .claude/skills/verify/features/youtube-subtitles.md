# YouTube bilingual subtitles

On a `www.youtube.com/watch` page the user turns on bilingual subtitles, independently of page translation. The player's own captions are read, merged into sentences, translated ahead of playback, and shown as a two-line overlay (source + translation) inside the player. Subtitles keep working when the user moves to another video in the same tab.

## Sub-features

- `yt-button` the popup shows 開啟雙語字幕 only on `youtube.com/watch`, or while subtitles are on.
- `yt-on` turning on shows the overlay `.llmt-yt-overlay` with `.llmt-yt-src` and `.llmt-yt-tr` lines in sync with playback, and sets `html.llmt-yt-on`.
- `yt-refill` translation runs in 5-minute windows and refills when less than 60 s of translated subtitles remain ahead.
- `yt-nav` switching videos in the same tab keeps subtitles on for the new video.
- `yt-off` 關閉雙語字幕 removes the overlay.
- `yt-notices` toasts for no captions (這部影片沒有字幕), live streams (還不支援直播的字幕), missing player (無法連接 YouTube 播放器) and no caption data (沒有收到 YouTube 字幕).
- `yt-shortcut` toggles with `Alt+S`.

## How to get to it (user POV)

- On a YouTube video page, click the toolbar icon, then 開啟雙語字幕（Alt+S）.
- Press `Alt+S` on a YouTube video page.

## Driving it with harness.mjs

Preconditions:

- Network access to `www.youtube.com`. The mock covers only the LLM API, so YouTube is live.
- A public video that has captions (manual or auto-generated) in a language other than the target.
- Default `launch({ name })`. Consider `HEADED=1`, because headless Chromium may not play video.

- **Button visible.** Open a video with `page = await run.newPage("https://www.youtube.com/watch?v=<id>")` and wait for `#movie_player`. `(await run.openPopup()).state().subs` starts with `開啟雙語字幕`.
- **Turn on.** Click `popup.click("#subs")` and start playback with `page.locator("#movie_player").click()` or the `k` key. `page.locator(".llmt-yt-overlay .llmt-yt-tr")` becomes visible with text starting `〔譯〕`. `html` has class `llmt-yt-on`, and `run.calls` has requests whose `segmentsOf` lines are caption sentences.
- **Off.** Reopen the popup. `state().subs` starts with `關閉雙語字幕`. Click it and the overlay is gone.
- **Proof.** Take a player screenshot with the overlay visible, record the popup state before and after, and save the first caption request's `segmentsOf` lines.

## Gotchas

- **Blocked in Playwright as of 2026-11-26.** The YouTube player shows 「發生錯誤，請重新整理或稍後再試。」 in Playwright's Chromium, headless and headed, so the `<video>` never loads (`readyState` 0) and subtitles never turn on. The popup part works: `state().subs` reads `開啟雙語字幕（Alt+S）` on a watch page. Prove subtitles by hand in a normal Chrome with `dist/` loaded, and report the automated path as not verified. Do not change browser flags to get past the player's automation check.
- The rest of this recipe is derived from source (`src/content/youtube/`, `src/page/youtube-hook.ts`), not from a run.
- The hook only sees caption requests the player makes after it is installed, so turning subtitles on flips CC once to force a refetch. If `沒有收到 YouTube 字幕` appears, try a different video before blaming the change.
- Consent or sign-in interstitials (EU), ads before the video, and A/B DOM changes can block `#movie_player`. Report the blocker rather than weakening the journey.
- Unsupported: Shorts, embeds, `m.youtube.com`, YouTube Music, and live streams. They are expected to show a notice or no button.
- `yt-shortcut` cannot be driven (same reason as `Alt+A`). Report it as skipped.
