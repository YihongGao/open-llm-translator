// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  chooseLayout,
  collectSegments,
  insertionPoint,
  isTranslatable,
  type SegmentCandidate,
} from "../src/content/segmenter";

// Structure modelled on the kubernetes.io docs page in the reference screenshot.
const FIXTURE = `
<nav>
  <a class="logo" href="/"><svg><text>logo</text></svg>kubernetes</a>
  <ul>
    <li><a href="/docs">Documentation</a></li>
    <li><a href="/blog">Kubernetes Blog</a></li>
    <li><button>English</button></li>
  </ul>
</nav>
<h1>Kubernetes Documentation</h1>
<aside>
  <ul>
    <li>Documentation
      <ul><li><a href="/v">Available Documentation Versions</a></li></ul>
    </li>
  </ul>
</aside>
<main>
  <p>Kubernetes is an open source container orchestration engine for automating deployment,
     scaling, and management of containerized applications. The open source project is hosted by
     the Cloud Native Computing Foundation (<a href="https://cncf.io">CNCF</a>).</p>
  <pre><code>kubectl get pods</code></pre>
  <p>Run <code>kubectl apply</code> to deploy.</p>
  <p translate="no">Do not translate me</p>
  <p>已經是中文的段落，不需要再翻譯。</p>
  <p>12345</p>
  <a class="card" href="/x"><div>Understand Kubernetes</div><div>Learn about Kubernetes and its fundamental concepts.</div></a>
</main>
`;

// happy-dom has no layout; treat everything per default HTML display.
const displayOf = () => "inline";

let segs: SegmentCandidate[];
beforeEach(() => {
  document.body.innerHTML = FIXTURE;
  segs = collectSegments(document.body, { targetLang: "zh-TW", displayOf });
});

describe("collectSegments", () => {
  it("finds nav labels, headings, sidebar items, paragraphs and card content", () => {
    expect(segs.map((s) => s.text)).toEqual([
      "kubernetes",
      "Documentation",
      "Kubernetes Blog",
      "Kubernetes Documentation",
      "Documentation",
      "Available Documentation Versions",
      "Kubernetes is an open source container orchestration engine for automating deployment, scaling, and management of containerized applications. The open source project is hosted by the Cloud Native Computing Foundation (CNCF).",
      "Run kubectl apply to deploy.",
      "Understand Kubernetes",
      "Learn about Kubernetes and its fundamental concepts.",
    ]);
  });

  it("splits a list item's own label from its nested list", () => {
    const li = document.querySelector("aside li")!;
    const own = segs.find((s) => s.container === li)!;
    expect(own.text).toBe("Documentation");
    expect(own.nodes.every((n) => li.contains(n) && !n.parentElement!.closest("aside li ul"))).toBe(true);
  });

  it("is stable across rescans after translation nodes are inserted", () => {
    for (const s of segs) {
      const { parent, before } = insertionPoint(s);
      const node = document.createElement("llmt-translation");
      node.textContent = "譯文";
      parent.insertBefore(node, before);
    }
    const again = collectSegments(document.body, { targetLang: "zh-TW", displayOf });
    expect(again.map((s) => s.text)).toEqual(segs.map((s) => s.text));
    expect(again.map((s) => s.anchor)).toEqual(segs.map((s) => s.anchor));
  });

  it("treats inline-tagged elements styled as blocks as their own segments", () => {
    document.body.innerHTML = `<div><a href="#">Docs</a><a href="#">Blog</a></div>`;
    const byDisplay = collectSegments(document.body, {
      targetLang: "zh-TW",
      displayOf: (el) => (el.tagName === "A" ? "block" : "inline"),
    });
    expect(byDisplay.map((s) => s.text)).toEqual(["Docs", "Blog"]);
    const asInline = collectSegments(document.body, { targetLang: "zh-TW", displayOf });
    expect(asInline.map((s) => s.text)).toEqual(["DocsBlog"]);
  });
});

describe("insertionPoint", () => {
  it("puts the translation inside a lone link so it keeps link styling", () => {
    const blog = segs.find((s) => s.text === "Kubernetes Blog")!;
    expect(insertionPoint(blog)).toEqual({ parent: document.querySelector('a[href="/blog"]'), before: null });
  });

  it("puts the translation after the run, before a nested block", () => {
    const li = document.querySelector("aside li")!;
    const own = segs.find((s) => s.container === li)!;
    const { parent, before } = insertionPoint(own);
    expect(parent).toBe(li);
    expect(before).toBe(li.querySelector("ul"));
  });
});

describe("chooseLayout", () => {
  it.each([
    ["Documentation", "inline"],
    ["Kubernetes Documentation", "inline"],
    ["Learn about Kubernetes and its fundamental concepts.", "block"],
    ["Hello. World", "block"],
    ["文件", "inline"],
    ["這是一段比較長的中文句子，應該放在原文下方顯示。", "block"],
  ])("%s -> %s", (text, layout) => {
    expect(chooseLayout(text)).toBe(layout);
  });
});

describe("isTranslatable", () => {
  it.each([
    ["Hello world", "zh-TW", true],
    ["已經是中文", "zh-TW", false],
    ["日本語のテキストです", "zh-TW", true],
    ["Already English", "en", false],
    ["12345", "zh-TW", false],
    ["a", "zh-TW", false],
  ])("%s (target %s) -> %s", (text, lang, expected) => {
    expect(isTranslatable(text, lang)).toBe(expected);
  });
});
