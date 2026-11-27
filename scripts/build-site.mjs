// Assembles the landing site into dist-site/ for GitHub Pages: the files in
// site/ (the zh-tw/ and en/ pages and the root redirect) plus the extension's
// own content.css and icon, so the demo renders translations with exactly the
// stylesheet the extension ships. lang.d.ts only types lang.js for the tests.
import { cpSync, mkdirSync, rmSync } from "node:fs";

const OUT = "dist-site";

rmSync(OUT, { recursive: true, force: true });
cpSync("site", OUT, { recursive: true, filter: (src) => !src.endsWith(".d.ts") });
cpSync("public/content.css", `${OUT}/content.css`);
mkdirSync(`${OUT}/icons`);
cpSync("public/icons/icon-32.png", `${OUT}/icons/icon-32.png`);
console.log(`built ${OUT}/`);
