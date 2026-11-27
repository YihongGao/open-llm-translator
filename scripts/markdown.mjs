// A converter for the Markdown subset docs/privacy-policy.md uses: h1/h2,
// hr, GFM tables, "- " lists, paragraphs, and `code`, **bold**, _italic_,
// [text](url) and bare https:// links inline. Anything else throws, so
// editing the policy with other syntax fails the site build instead of
// shipping raw Markdown.

const escapeHtml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Escaped text is scanned once, so a URL inside [..](..) or `..` is never linked twice.
const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|(?<!\w)_(.+?)_(?!\w)|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s<]*[^\s<.,;:!?)])/g;

/** @param {string} escaped already HTML-escaped */
function marks(escaped) {
  return escaped.replace(INLINE, (_, code, bold, italic, label, href, bare) => {
    if (code) return `<code>${code}</code>`;
    if (bold) return `<strong>${marks(bold)}</strong>`;
    if (italic) return `<em>${marks(italic)}</em>`;
    const url = href ?? bare;
    return `<a href="${url}">${label ?? url}</a>`;
  });
}

/** @param {string} text */
const inline = (text) => marks(escapeHtml(text));

const UNSUPPORTED = /^(?:#{3,}\s|>|\d+[.)]\s|[*+]\s|```|~~~|\s{4}|\t)/;
const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
const row = (tag, line) => `<tr>${cells(line).map((c) => `<${tag}>${inline(c)}</${tag}>`).join("")}</tr>`;

/**
 * @param {string} md
 * @returns {string}
 */
export function renderMarkdown(md) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  /** @param {number} i @param {string} what @returns {never} */
  const fail = (i, what) => {
    throw new Error(`markdown.mjs: unsupported ${what} at line ${i + 1}: ${lines[i]}`);
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i++;
    } else if (UNSUPPORTED.test(line)) {
      fail(i, "block");
    } else if (line === "---") {
      out.push("<hr>");
      i++;
    } else if (/^#{1,2} /.test(line)) {
      const level = line.startsWith("## ") ? 2 : 1;
      out.push(`<h${level}>${inline(line.slice(level + 1))}</h${level}>`);
      i++;
    } else if (line.startsWith("|")) {
      if (!/^\|(?:\s*:?-+:?\s*\|)+$/.test(lines[i + 1] ?? "")) fail(i + 1, "table separator");
      const body = [];
      for (i += 2; (lines[i] ?? "").startsWith("|"); i++) body.push(row("td", lines[i] ?? ""));
      out.push(`<div class="table-wrap"><table><thead>${row("th", line)}</thead><tbody>${body.join("")}</tbody></table></div>`);
    } else if (line.startsWith("- ")) {
      const items = [];
      for (; (lines[i] ?? "").startsWith("- "); i++) items.push(`<li>${inline((lines[i] ?? "").slice(2))}</li>`);
      out.push(`<ul>${items.join("")}</ul>`);
    } else {
      const para = [];
      for (; (lines[i] ?? "").trim() !== "" && !/^(?:#|---$|\||- )/.test(lines[i] ?? ""); i++) {
        if (UNSUPPORTED.test(lines[i] ?? "")) fail(i, "block");
        para.push((lines[i] ?? "").trim());
      }
      if (para.length === 0) fail(i, "block");
      out.push(`<p>${inline(para.join(" "))}</p>`);
    }
  }
  return out.join("\n");
}
