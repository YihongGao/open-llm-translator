// Assembles the landing site into dist-site/ for GitHub Pages: the files in
// site/ (the zh-tw/ and en/ pages and the root redirect) plus the extension's
// own content.css and icon, so the demo renders translations with exactly the
// stylesheet the extension ships. lang.d.ts only types lang.js for the tests.
// privacy/index.html is rendered from docs/privacy-policy.md, the single
// source of the policy text, because the Chrome Web Store's crawler cannot
// reach github.com blob pages.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { renderMarkdown } from "./markdown.mjs";

const OUT = "dist-site";

const STYLE = `
:root { color-scheme: light dark; --bg: #fff; --ink: #16191a; --line: #cfd4cf; --accent: #1a6342; --wash: #f3f5f3; }
@media (prefers-color-scheme: dark) { :root { --bg: #14171a; --ink: #e6e9e6; --line: #3a4040; --accent: #6fcf9f; --wash: #1d2124; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16.5px/1.75 "IBM Plex Sans", "Noto Sans TC", system-ui, "PingFang TC", "Microsoft JhengHei", sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 24px 20px 64px; }
nav { display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 14.5px; margin-bottom: 32px; }
a { color: var(--accent); text-underline-offset: 3px; overflow-wrap: anywhere; }
h1 { font-size: 1.7rem; line-height: 1.3; margin: 0 0 .5em; }
h2 { font-size: 1.25rem; margin: 2em 0 .5em; }
code { font: .9em ui-monospace, "IBM Plex Mono", monospace; background: var(--wash); padding: .1em .35em; border-radius: 3px; overflow-wrap: anywhere; }
hr { border: 0; border-top: 1px solid var(--line); margin: 56px 0 40px; }
.table-wrap { overflow-x: auto; margin: 1em 0; }
table { border-collapse: collapse; width: 100%; font-size: .93em; }
th, td { border: 1px solid var(--line); padding: 8px 12px; text-align: left; vertical-align: top; }
th { background: var(--wash); }
td:first-child { min-width: 9em; }
`;

function privacyPage(policy) {
  const [en, zh, ...extra] = policy.split(/^---\r?$/m);
  if (!zh || extra.length) throw new Error("docs/privacy-policy.md needs exactly one --- line, between the English and Chinese parts");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy Policy — Open LLM Translator</title>
<link rel="icon" href="../icons/icon-32.png">
<style>${STYLE}</style>
</head>
<body>
<main>
<nav><a href="../">Open LLM Translator</a><a href="#en">English</a><a href="#zh-tw" lang="zh-Hant-TW">繁體中文</a></nav>
<article id="en" lang="en">
${renderMarkdown(en)}
</article>
<hr>
<article id="zh-tw" lang="zh-Hant-TW">
${renderMarkdown(zh)}
</article>
</main>
</body>
</html>
`;
}

rmSync(OUT, { recursive: true, force: true });
cpSync("site", OUT, { recursive: true, filter: (src) => !src.endsWith(".d.ts") });
cpSync("public/content.css", `${OUT}/content.css`);
mkdirSync(`${OUT}/icons`);
cpSync("public/icons/icon-32.png", `${OUT}/icons/icon-32.png`);
mkdirSync(`${OUT}/privacy`);
writeFileSync(`${OUT}/privacy/index.html`, privacyPage(readFileSync("docs/privacy-policy.md", "utf8")));
console.log(`built ${OUT}/`);
