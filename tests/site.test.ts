import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { pickSiteLang } from "../site/lang.js";

const SITE = "https://yihonggao.github.io/open-llm-translator/";
// The root page only redirects; the two language versions are the real pages.
const LANG_PAGES = { "zh-Hant-TW": "zh-tw/index.html", en: "en/index.html" } as const;
const PAGES = ["index.html", ...Object.values(LANG_PAGES)];
const PRIVACY = "privacy/index.html";

const read = (page: string) => readFileSync(posix.join("dist-site", page), "utf8");
const attrs = (html: string, re: RegExp) => [...html.matchAll(re)].map((m) => m[1] ?? "");

// The <body> as tags only: no text, no line-break wrappers (<span class="nw">,
// <span data-alt>), wording-only attribute values replaced by *, and each lang
// recorded as the page's own language or the other one. Two language versions
// with the same skeleton differ only in wording.
function skeleton(html: string): string[] {
  const pageLang = /<html lang="([^"]+)"/.exec(html)?.[1];
  const body = html.slice(html.indexOf("<body"), html.indexOf("</body>"));
  const out: string[] = [];
  const spans: boolean[] = []; // per open <span>: left out of the skeleton?
  for (const [, close, tag, rest = ""] of body.matchAll(/<(\/?)([a-z][\w-]*)([^>]*)>/g)) {
    if (tag === "span") {
      if (close) {
        if (spans.pop()) continue;
      } else if (/^ (?:class="nw"|data-alt)$/.test(rest)) {
        spans.push(true);
        continue;
      } else spans.push(false);
    }
    const normalized = rest.replace(/([\w-]+)="([^"]*)"/g, (_, name: string, value: string) => {
      if (name === "lang") return `lang="${value === pageLang ? "page" : "other"}"`;
      if (name === "href") return `href="${value.startsWith("#") ? value : "*"}"`;
      if (["data-tr", "aria-label", "hreflang", "data-site-lang"].includes(name)) return `${name}="*"`;
      return `${name}="${value}"`;
    });
    out.push(`<${close}${tag}${normalized}>`);
  }
  return out;
}

// The site is deployed from dist-site/ as-is, so every local file a page
// references must be in the build output.
describe("landing page build", () => {
  beforeAll(() => {
    execFileSync(process.execPath, ["scripts/build-site.mjs"]);
  });

  it.each([...PAGES, PRIVACY])("%s ships every local file it references", (page) => {
    const html = read(page);
    const refs = [...attrs(html, /\b(?:href|src)="([^"#][^"]*)"/g), ...attrs(html, /\bfrom "(\.[^"]+)"/g)].filter(
      (r) => !/^(?:https?:|mailto:)/.test(r),
    );
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs.map((r) => r.split("#")[0]!)) {
      // Pages serves dist-site/ under /open-llm-translator/, so paths must stay inside it.
      const target = posix.normalize(posix.join(posix.dirname(page), ref));
      expect(target, `${page}: ${ref}`).not.toMatch(/^(?:\.\.|\/)/);
      expect(existsSync(posix.join("dist-site", target.endsWith("/") ? `${target}index.html` : target)), `${page}: ${ref}`).toBe(true);
    }
  });

  it.each(Object.entries(LANG_PAGES))("the %s page renders the demo with the extension's own stylesheet", (lang, page) => {
    const html = read(page);
    expect(html).toContain(`<html lang="${lang}"`);
    expect(attrs(html, /\bhref="([^"]*)"/g)).toContain("../content.css");
    expect(attrs(html, /\bsrc="([^"]*)"/g)).toContain("../demo.js");
  });

  it("ships the extension's stylesheet unchanged", () => {
    expect(read("content.css")).toBe(readFileSync("public/content.css", "utf8"));
  });

  it.each(PAGES)("%s lists every language version as an alternate", (page) => {
    const alternates = Object.fromEntries(
      [...read(page).matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)">/g)].map((m) => [m[1], m[2]]),
    );
    expect(alternates).toEqual({ "zh-Hant-TW": `${SITE}zh-tw/`, en: `${SITE}en/`, "x-default": SITE });
  });

  it("publishes docs/privacy-policy.md as a page with both languages", () => {
    const policy = readFileSync("docs/privacy-policy.md", "utf8");
    const html = read(PRIVACY);
    expect(html).toContain('<article id="en" lang="en">');
    expect(html).toContain('<article id="zh-tw" lang="zh-Hant-TW">');
    const updated = /_(Last updated: [^_]+)_/.exec(policy)?.[1];
    expect(updated).toBeDefined();
    expect(html).toContain(updated);
    // No Markdown left in the rendered text.
    const text = html.slice(html.indexOf("<main>")).replace(/<[^>]*>/g, "\n");
    expect(text).not.toMatch(/\*\*|\]\(|`|^\s*\|/m);
  });

  it("gives both language versions the same structure", () => {
    const [zh, en] = Object.values(LANG_PAGES).map(read);
    expect(skeleton(en!)).toEqual(skeleton(zh!));
  });
});

describe("pickSiteLang", () => {
  it.each([
    [["zh-TW", "en-US"], "zh-tw"],
    [["zh-CN"], "zh-tw"],
    [["zh-Hant-HK"], "zh-tw"],
    [["en-GB", "zh-TW"], "en"],
    [["ja", "zh-TW"], "zh-tw"],
    [["ja", "ko"], "en"],
    [[], "en"],
  ])("sends browser languages %j to %s", (langs, expected) => {
    expect(pickSiteLang(langs, null)).toBe(expected);
  });

  it("prefers the version the visitor picked over the browser language", () => {
    expect(pickSiteLang(["zh-TW"], "en")).toBe("en");
    expect(pickSiteLang(["en-US"], "zh-tw")).toBe("zh-tw");
  });

  it("ignores a stored value that is not a language version", () => {
    expect(pickSiteLang(["zh-TW"], "fr")).toBe("zh-tw");
  });
});
