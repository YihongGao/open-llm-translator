// Journey: translate a page from the toolbar popup, scroll, then restore the original.
// Usage: node .claude/skills/verify/scripts/journey-page-translation.mjs
// Exit 0 = every check passed. Evidence in the printed artifacts dir.
import { MOCK_PREFIX, launch, segmentsOf, waitForPage } from "./harness.mjs";

const run = await launch({ name: "page-translation" });
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
};
const hostState = (s, id) => s.byHost.filter((n) => n.host === id);

try {
  const page = await run.newPage(run.fixture("article.html"));

  // 1. Popup before translating.
  let popup = await run.openPopup();
  const before = await popup.state();
  await run.writeJson("01-popup-before.json", before);
  check("popup offers 翻譯此頁 with no key warning", before.toggle.startsWith("翻譯此頁") && before.warn === null, before);

  // 2. Click 翻譯此頁: popup closes, visible segments translate.
  await popup.click("#toggle");
  const s1 = await waitForPage(page, (s) => s.done >= 5 && s.pending === 0, { label: "first-screen translations" });
  await run.writeJson("02-page-translated.json", s1);
  await run.screenshot(page, "02-page-translated.png");
  check("popup closed after toggle", !(await popup.isOpen()));
  check("heading translated inline-or-block with mock text", hostState(s1, "title")[0]?.text === `${MOCK_PREFIX}Scheduling basics`, hostState(s1, "title"));
  check("paragraph translated from the API", hostState(s1, "intro")[0]?.source === "api", hostState(s1, "intro"));
  check("button, pre and translate=no untouched", ["btn", "code", "no-translate"].every((id) => hostState(s1, id).length === 0));
  check("below-the-fold paragraph not translated yet", hostState(s1, "far").length === 0);
  check("no error toast", s1.toast === null, s1.toast);

  // 3. Scroll: the far paragraph translates once in view.
  await page.locator("#far").scrollIntoViewIfNeeded();
  const s2 = await waitForPage(page, (s) => hostState(s, "far").some((n) => n.state === "done"), { label: "far paragraph" });
  await run.screenshot(page, "03-after-scroll.png");
  check("far paragraph translated after scroll", hostState(s2, "far")[0]?.text.startsWith(MOCK_PREFIX), hostState(s2, "far"));

  // 4. Popup now offers 顯示原文; clicking hides translations.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.bringToFront();
  popup = await run.openPopup();
  const during = await popup.state();
  await run.writeJson("04-popup-while-active.json", during);
  check("popup offers 顯示原文 while active", during.toggle.startsWith("顯示原文"), during);
  await popup.click("#toggle");
  const s3 = await waitForPage(page, (s) => s.hidden, { label: "translations hidden" });
  await run.screenshot(page, "05-restored.png");
  check("translations hidden after 顯示原文", s3.hidden && (await page.locator("llmt-translation").first().isHidden()));

  // Side effect: what actually went over the wire.
  const segmentsSent = run.calls.flatMap((c) => segmentsOf(c.body));
  await run.writeJson("06-segments-sent.json", segmentsSent);
  check("API saw page text but not the button/pre/translate=no text", segmentsSent.includes("Scheduling basics") && !segmentsSent.some((t) => /Do not translate|kubectl get pods|opts out/.test(t)), segmentsSent);
} catch (err) {
  check("journey ran to completion", false, String(err?.stack ?? err));
} finally {
  await run.writeJson("result.json", results);
  await run.close();
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} check(s) failed` : "all checks passed");
process.exit(failed.length ? 1 : 0);
