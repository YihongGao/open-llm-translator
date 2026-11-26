// The bilingual subtitle box, placed inside the player element so it stays
// visible in fullscreen (only the fullscreen element's subtree is rendered).
// Styles live in content.css; YouTube's own caption window is hidden there
// while html.llmt-yt-on is set.

export const OVERLAY_CLASS = "llmt-yt-overlay";
export const SUBTITLES_ON_CLASS = "llmt-yt-on";

export class SubtitleOverlay {
  private readonly root: HTMLDivElement;
  private readonly src: HTMLSpanElement;
  private readonly tr: HTMLSpanElement;
  private readonly trRow: HTMLDivElement;
  private readonly resize: ResizeObserver | null;
  private player: HTMLElement | null = null;

  constructor() {
    this.root = document.createElement("div");
    this.root.className = OVERLAY_CLASS;
    // Keeps page translation (and browser translation) away from it.
    this.root.setAttribute("translate", "no");
    this.root.hidden = true;
    const row = (cls: string): [HTMLDivElement, HTMLSpanElement] => {
      const r = document.createElement("div");
      r.className = "llmt-yt-row";
      const s = document.createElement("span");
      s.className = `llmt-yt-line ${cls}`;
      r.append(s);
      this.root.append(r);
      return [r, s];
    };
    [, this.src] = row("llmt-yt-src");
    [this.trRow, this.tr] = row("llmt-yt-tr");
    this.resize =
      typeof ResizeObserver === "function" ? new ResizeObserver(() => this.updateSize()) : null;
  }

  /** (Re)attaches to the player; YouTube may rebuild it on navigation. */
  attach(player: HTMLElement): void {
    if (this.player !== player) {
      this.resize?.disconnect();
      this.player = player;
      this.resize?.observe(player);
      this.updateSize();
    }
    if (this.root.parentElement !== player) player.append(this.root);
  }

  /** `translation` null: not translated yet (or same as the source), show the source alone. */
  show(source: string, translation: string | null): void {
    if (this.src.textContent !== source) this.src.textContent = source;
    const tr = translation ?? "";
    if (this.tr.textContent !== tr) this.tr.textContent = tr;
    this.trRow.hidden = translation === null;
    this.root.hidden = false;
  }

  hide(): void {
    this.root.hidden = true;
  }

  destroy(): void {
    this.resize?.disconnect();
    this.root.remove();
    this.player = null;
  }

  /** Scales the text with the player, as YouTube does with its own captions. */
  private updateSize(): void {
    const h = this.player?.clientHeight ?? 0;
    const px = Math.round(Math.min(40, Math.max(13, h * 0.034)));
    this.root.style.setProperty("--llmt-yt-size", `${px}px`);
  }
}
