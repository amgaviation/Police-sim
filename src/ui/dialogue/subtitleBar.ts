import './dialogue.css';

/** Base time a subtitle stays up (ms) and the extra time per character. */
export const SUBTITLE_BASE_MS = 4000;
export const SUBTITLE_PER_CHAR_MS = 50;

/**
 * Subtitle line (bottom-centre, above the radio caption): `"Name: text"` for the latest spoken line, shown
 * for `4000 + 50 * length` ms unless a duration is given, and replaced by the next line. The caller drives the
 * time (`nowMs` of `show` / `update`), so it stays deterministic in tests. Headless (null parent or no
 * `document`) it keeps `current`.
 */
export class SubtitleBar {
  private readonly el: HTMLDivElement | null;
  private text: string | null = null;
  private until = 0;
  private visible = true;

  constructor(parent: HTMLElement | null) {
    if (parent && typeof document !== 'undefined') {
      const el = document.createElement('div');
      el.className = 'dlg-subtitle';
      el.setAttribute('aria-live', 'polite');
      el.hidden = true;
      parent.appendChild(el);
      this.el = el;
    } else {
      this.el = null;
    }
  }

  /** The line being shown, null when none (also while subtitles are switched off). */
  get current(): string | null {
    return this.text;
  }

  show(speaker: string, text: string, nowMs: number, durationMs?: number): void {
    const line = speaker === '' ? text : `${speaker}: ${text}`;
    if (line === '' || !this.visible) return;
    this.text = line;
    this.until = nowMs + (durationMs ?? SUBTITLE_BASE_MS + SUBTITLE_PER_CHAR_MS * line.length);
    this.render();
  }

  /** Hides the line once its time is up. */
  update(nowMs: number): void {
    if (this.text !== null && nowMs >= this.until) this.clear();
  }

  clear(): void {
    if (this.text === null) return;
    this.text = null;
    this.render();
  }

  /** Switches subtitles on or off (the `accessibility.subtitles` setting); off clears the current line. */
  setVisible(visible: boolean): void {
    this.visible = visible;
    if (!visible) this.text = null;
    this.render();
  }

  dispose(): void {
    this.text = null;
    this.el?.remove();
  }

  private render(): void {
    const el = this.el;
    if (!el) return;
    const text = this.visible ? this.text : null;
    el.hidden = text === null;
    const shown = text ?? '';
    if (el.textContent !== shown) el.textContent = shown;
  }
}
