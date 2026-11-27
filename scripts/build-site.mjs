// Assembles the landing page into dist-site/ for GitHub Pages: the files in
// site/ plus the extension's own content.css and icon, so the demo renders
// translations with exactly the stylesheet the extension ships.
import { cpSync, mkdirSync, rmSync } from "node:fs";

const OUT = "dist-site";

rmSync(OUT, { recursive: true, force: true });
cpSync("site", OUT, { recursive: true });
cpSync("public/content.css", `${OUT}/content.css`);
mkdirSync(`${OUT}/icons`);
cpSync("public/icons/icon-32.png", `${OUT}/icons/icon-32.png`);
console.log(`built ${OUT}/`);
