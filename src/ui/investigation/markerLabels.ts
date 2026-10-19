import './investigation.css';
import { div, setText } from '../panels/dom';

/** One label to draw: screen pixels (the anchor is the bottom centre of the label). */
export interface MarkerLabel {
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

/**
 * Evidence marker number labels (design §10.4): absolutely positioned tags over the canvas. The app projects the
 * markers within 8 m to screen pixels about ten times a second and calls `update`. Pooled elements, nothing is
 * created per update once the pool is large enough. Headless (no parent or no `document`) it only counts.
 */
export class MarkerLabels {
  private readonly root: HTMLDivElement | null = null;
  private readonly pool: HTMLDivElement[] = [];
  private shownCount = 0;

  constructor(parent: HTMLElement | null) {
    if (parent === null || typeof document === 'undefined') return;
    this.root = div('inv-labels', parent);
    this.root.setAttribute('aria-hidden', 'true');
  }

  /** Labels currently shown. */
  get count(): number {
    return this.shownCount;
  }

  update(labels: readonly MarkerLabel[]): void {
    this.shownCount = labels.length;
    const root = this.root;
    if (!root) return;
    while (this.pool.length < labels.length) {
      const el = div('inv-label', root);
      el.hidden = true;
      this.pool.push(el);
    }
    for (let i = 0; i < this.pool.length; i++) {
      const el = this.pool[i] as HTMLDivElement;
      const label = labels[i];
      if (label === undefined) {
        if (!el.hidden) el.hidden = true;
        continue;
      }
      if (el.hidden) el.hidden = false;
      setText(el, label.text);
      el.style.left = `${String(Math.round(label.x))}px`;
      el.style.top = `${String(Math.round(label.y))}px`;
    }
  }

  dispose(): void {
    this.root?.remove();
    this.pool.length = 0;
    this.shownCount = 0;
  }
}
