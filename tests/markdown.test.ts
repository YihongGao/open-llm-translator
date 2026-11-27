import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../scripts/markdown.mjs";

describe("renderMarkdown", () => {
  it("renders headings, rules and paragraphs", () => {
    expect(renderMarkdown("# Title\n\n## Part\n\nline one\nline two\n\n---\n")).toBe(
      "<h1>Title</h1>\n<h2>Part</h2>\n<p>line one line two</p>\n<hr>",
    );
  });

  it("renders a table with a header row and body rows", () => {
    const html = renderMarkdown("| A | B |\n|---|---|\n| 1 | **two** |\n| 3 | 4 |\n\nafter");
    expect(html).toContain("<thead><tr><th>A</th><th>B</th></tr></thead>");
    expect(html).toContain("<tbody><tr><td>1</td><td><strong>two</strong></td></tr><tr><td>3</td><td>4</td></tr></tbody>");
    expect(html).toContain("<p>after</p>");
  });

  it("renders a bullet list", () => {
    expect(renderMarkdown("- one\n- `two`\n\ntext")).toBe("<ul><li>one</li><li><code>two</code></li></ul>\n<p>text</p>");
  });

  it("escapes HTML, including inside code", () => {
    expect(renderMarkdown("a <b> & c `<i>`")).toBe("<p>a &lt;b&gt; &amp; c <code>&lt;i&gt;</code></p>");
  });

  it("escapes HTML inside bold and italic exactly once", () => {
    expect(renderMarkdown("**a & b** _c < d_")).toBe("<p><strong>a &amp; b</strong> <em>c &lt; d</em></p>");
  });

  it("links [text](url) and bare URLs once each", () => {
    const html = renderMarkdown("see [the policy](https://a.example/p) and https://b.example/q.");
    expect(html).toBe('<p>see <a href="https://a.example/p">the policy</a> and <a href="https://b.example/q">https://b.example/q</a>.</p>');
  });

  it("does not link a URL inside code", () => {
    expect(renderMarkdown("`https://example.com/docs/intro`")).toBe("<p><code>https://example.com/docs/intro</code></p>");
  });

  it("italicizes whole-word underscores only", () => {
    expect(renderMarkdown("_Last updated: 2026-11-26_")).toBe("<p><em>Last updated: 2026-11-26</em></p>");
    expect(renderMarkdown("snake_case_name and `chrome.storage.local`")).toBe(
      "<p>snake_case_name and <code>chrome.storage.local</code></p>",
    );
    expect(renderMarkdown("`X-Stainless-*` headers, a_b and c_d")).toBe("<p><code>X-Stainless-*</code> headers, a_b and c_d</p>");
  });

  it.each([
    ["### deeper heading", 1],
    ["ok\n\n> quote", 3],
    ["1. first", 1],
    ["* star bullet", 1],
    ["```\ncode\n```", 1],
    ["ok\n\n    indented", 3],
    ["| A |\nnot a separator", 2],
  ])("throws on unsupported block %j with its line number", (md, line) => {
    expect(() => renderMarkdown(md)).toThrow(`at line ${line}:`);
  });
});
