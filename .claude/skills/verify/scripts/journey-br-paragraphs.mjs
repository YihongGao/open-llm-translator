// Journey: a post whose paragraphs are separated by <br><br> (no <p>) gets one
// translation per paragraph, each between its two breaks, keeping the gap.
// Usage: node .claude/skills/verify/scripts/journey-br-paragraphs.mjs
// Exit 0 = every check passed. Evidence in the printed artifacts dir.
import { MOCK_PREFIX, launch, segmentsOf, waitForPage } from "./harness.mjs";

const PARAGRAPHS = [
  "In 3.30 we fundamentally changed how Items are generated in Path of Exile, with the goal of killing harder monsters resulting in better items.",
  "For currency specifically, with the more item rarity a monster had, the higher the chance they had to drop the highest category of currency.",
  "Another new Currency, the Primordial Exalted Orb will transform into one of the following special Exalted Orbs at random when used: Hunter's Exalted Orb, Warlord's Exalted Orb, Veiled Exalted Orb.",
  "So, that's the problem. What are we doing about it?",
];

const run = await launch({ name: "br-paragraphs" });
const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
};

try {
  const page = await run.newPage(run.fixture("forum-br.html"));
  const popup = await run.openPopup();
  await popup.click("#toggle");
  const s = await waitForPage(page, (st) => st.done >= 5 && st.pending === 0, { label: "post translated" });
  await run.writeJson("01-page-state.json", s);
  await run.screenshot(page, "01-translated.png");

  const post = s.byHost.filter((n) => n.host === "post");
  check(
    "one block translation per paragraph",
    JSON.stringify(post.map((n) => n.text)) === JSON.stringify(PARAGRAPHS.map((p) => MOCK_PREFIX + p)) &&
      post.every((n) => n.layout === "block"),
    post,
  );

  const sent = run.calls.flatMap((c) => segmentsOf(c.body));
  await run.writeJson("02-segments-sent.json", sent);
  check("API received each paragraph as its own segment", PARAGRAPHS.every((p) => sent.includes(p)), sent);

  // Each translation sits between the <br><br> that follows its paragraph, and
  // the gap below it matches the gap between two original paragraphs.
  const layout = await page.evaluate(() => {
    const box = document.getElementById("post");
    const nodes = [...box.querySelectorAll(":scope > llmt-translation")];
    const placement = nodes.map((n) => [n.previousSibling?.nodeName, n.nextSibling?.nodeName]);
    const rectOf = (n) => {
      const r = document.createRange();
      r.selectNodeContents(n);
      return r.getBoundingClientRect();
    };
    const texts = [...box.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
    const nextText = (el) => {
      for (let n = el.nextSibling; n; n = n.nextSibling) if (n.nodeType === 3 && n.textContent.trim()) return n;
      return null;
    };
    const gapsBelow = nodes.slice(0, -1).map((n) => rectOf(nextText(n)).top - n.getBoundingClientRect().bottom);
    return { placement, gapsBelow, lineHeight: parseFloat(getComputedStyle(box).lineHeight), texts: texts.length };
  });
  await run.writeJson("03-layout.json", layout);
  check(
    "translations sit between the two <br>s (last one ends the post)",
    layout.placement.slice(0, -1).every(([a, b]) => a === "BR" && b === "BR") && layout.placement.at(-1)?.[1] !== "BR",
    layout.placement,
  );
  check(
    "gap below each translation is one blank line, not two",
    layout.gapsBelow.every((g) => g > 0 && g < 1.5 * layout.lineHeight),
    layout,
  );
} catch (err) {
  check("journey ran to completion", false, String(err?.stack ?? err));
} finally {
  await run.writeJson("result.json", results);
  await run.close();
}
const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `${failed.length} check(s) failed` : "all checks passed");
process.exit(failed.length ? 1 : 0);
