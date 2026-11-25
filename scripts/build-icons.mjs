// Renders the extension icon (proposal F: an "L" frame holding 文) to PNG.
// Usage: npm run icons   → public/icons/icon-{16,32,48,128}.png
//
// The drawing lives here as SVG so the icon can be tweaked and re-rendered;
// the PNGs are committed because manifest icons must be raster images.
// Playwright's Chromium does the rasterising (already a devDependency).
import { chromium } from "playwright";
import { mkdir } from "node:fs/promises";

// Stroke glyph 文 in a 100×100 box.
const WEN = ["M50 8V22", "M12 32H88", "M68 32C62 60 42 82 12 92", "M32 32C38 60 58 82 88 92"];

/**
 * Artwork in a 128 canvas whose content box is 16..112.
 * k thickens strokes at small sizes so they don't fade to sub-pixel lines.
 */
function artwork(k) {
  const wen = WEN.map((d) => `<path d="${d}"/>`).join("");
  return (
    `<rect x="17" y="17" width="94" height="94" rx="21" fill="#fff4e8" stroke="#e8cbae" stroke-width="2"/>` +
    `<path d="M36 28V96H96" fill="none" stroke="#c2410c" stroke-width="${(14 * Math.min(k, 1.3)).toFixed(2)}" ` +
    `stroke-linecap="round" stroke-linejoin="round"/>` +
    `<g transform="translate(50 30) scale(0.44)" fill="none" stroke="#1f2937" stroke-width="${(10 * k).toFixed(2)}" ` +
    `stroke-linecap="round" stroke-linejoin="round">${wen}</g>`
  );
}

// 128: Chrome Web Store spec, 96×96 artwork with 16px transparent padding.
// 16/32/48: toolbar and chrome://extensions, artwork fills the square.
const SIZES = [
  { px: 16, k: 1.7, padded: false },
  { px: 32, k: 1.35, padded: false },
  { px: 48, k: 1.15, padded: false },
  { px: 128, k: 1, padded: true },
];

const outdir = "public/icons";
await mkdir(outdir, { recursive: true });

const browser = await chromium.launch();
try {
  for (const { px, k, padded } of SIZES) {
    const page = await browser.newPage({ viewport: { width: px, height: px }, deviceScaleFactor: 1 });
    const viewBox = padded ? "0 0 128 128" : "16 16 96 96";
    await page.setContent(
      `<html><body style="margin:0;background:transparent">` +
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${px}" height="${px}" style="display:block">` +
        `${artwork(k)}</svg></body></html>`,
    );
    const path = `${outdir}/icon-${px}.png`;
    await page.screenshot({ path, omitBackground: true, clip: { x: 0, y: 0, width: px, height: px } });
    await page.close();
    console.log(`wrote ${path}`);
  }
} finally {
  await browser.close();
}
