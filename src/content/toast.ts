// A single notice in the page's top-right corner. Rendered in a Shadow DOM so
// page CSS cannot restyle it and our CSS cannot leak into the page.

import { t } from "../shared/i18n";

export interface ToastOptions {
  message: string;
  detail?: string;
  action?: { label: string; onClick: () => void };
  /** Auto-dismiss after this many ms; omitted = stays until closed. */
  autoHideMs?: number;
}

const HOST_TAG = "llmt-toast";

const CSS = `
:host { all: initial; }
.box {
  --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --border: #d1d9e0; --accent: #0969da; --accent-fg: #ffffff;
  position: fixed; top: 16px; right: 16px; z-index: 2147483647;
  box-sizing: border-box; width: min(360px, calc(100vw - 32px));
  padding: 12px 14px; border-radius: 10px; border: 1px solid var(--border);
  background: var(--bg); color: var(--fg); box-shadow: 0 8px 24px rgba(0,0,0,.18);
  font: 14px/1.5 var(--font);
  display: grid; grid-template-columns: auto 1fr auto; gap: 4px 10px; align-items: start;
}
@media (prefers-color-scheme: dark) {
  .box { --bg: #262c36; --fg: #f0f6fc; --muted: #9198a1; --border: #3d444d; --accent: #4493f8; --accent-fg: #ffffff; }
}
/* system-ui draws CJK text in the browser locale's font (on Windows it never falls through to the
   next family), so each UI language lists its own CJK fonts ahead of system-ui; "Segoe UI" has no CJK
   glyphs, so Windows keeps its Latin font. Keep in sync with popup.html and options.html. lang is set on .box. */
.box { --font: "Segoe UI", "PingFang TC", "Microsoft JhengHei UI", "Microsoft JhengHei", "Noto Sans TC", system-ui, sans-serif; }
.box:lang(en) { --font: system-ui, -apple-system, sans-serif; }
.box:lang(ja) { --font: "Segoe UI", "Hiragino Sans", "Yu Gothic UI", Meiryo, "Noto Sans JP", system-ui, sans-serif; }
.box:lang(zh-CN) { --font: "Segoe UI", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif; }
.icon { font-size: 16px; line-height: 1.4; }
.msg { font-weight: 600; word-break: break-word; }
.detail { grid-column: 2; color: var(--muted); font-size: 12px; }
.close { all: unset; cursor: pointer; color: var(--muted); padding: 0 4px; font-size: 16px; line-height: 1.3; }
.close:hover, .close:focus-visible { color: var(--fg); outline: none; }
.action {
  all: unset; grid-column: 2; justify-self: start; margin-top: 6px; cursor: pointer;
  padding: 4px 12px; border-radius: 6px; background: var(--accent); color: var(--accent-fg); font-weight: 600; font-size: 13px;
}
.action:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
`;

let current: { host: HTMLElement; message: string; timer?: number } | null = null;

export function showToast(opts: ToastOptions): void {
  if (current && current.host.isConnected) {
    if (current.message === opts.message) return; // already showing
    hideToast();
  }

  const host = document.createElement(HOST_TAG);
  host.setAttribute("translate", "no");
  const root = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;

  const box = document.createElement("div");
  box.className = "box";
  box.lang = t("pageLang");
  box.setAttribute("role", "alert");

  const icon = document.createElement("span");
  icon.className = "icon";
  icon.textContent = "⚠";
  const msg = document.createElement("div");
  msg.className = "msg";
  msg.textContent = opts.message;
  const close = document.createElement("button");
  close.className = "close";
  close.type = "button";
  close.setAttribute("aria-label", t("toastClose"));
  close.textContent = "✕";
  close.addEventListener("click", hideToast);
  box.append(icon, msg, close);

  if (opts.detail) {
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = opts.detail;
    box.append(detail);
  }
  if (opts.action) {
    const action = document.createElement("button");
    action.className = "action";
    action.type = "button";
    action.textContent = opts.action.label;
    const { onClick } = opts.action;
    action.addEventListener("click", () => {
      onClick();
      hideToast();
    });
    box.append(action);
  }

  root.append(style, box);
  document.documentElement.append(host);
  current = { host, message: opts.message };
  if (opts.autoHideMs) current.timer = window.setTimeout(hideToast, opts.autoHideMs);
}

export function hideToast(): void {
  if (!current) return;
  window.clearTimeout(current.timer);
  current.host.remove();
  current = null;
}
