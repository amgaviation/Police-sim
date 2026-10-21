/**
 * Full-screen black overlay for the 0.6 s door transitions (design §11.3). `set(level)` takes 0 (clear) to 1 (black);
 * the opacity is written only when the level changes. Headless (no parent or no `document`) it only keeps the level.
 */
export class FadeOverlay {
  private readonly element: HTMLDivElement | null = null;
  private current = 0;

  constructor(parent: HTMLElement | null) {
    if (parent === null || typeof document === 'undefined') return;
    const e = document.createElement('div');
    e.id = 'fade-overlay';
    e.setAttribute('aria-hidden', 'true');
    // Above the HUD (900), below the menus (950).
    e.setAttribute('style', 'position:absolute;inset:0;z-index:920;background:var(--black);pointer-events:none;opacity:0;display:none');
    parent.appendChild(e);
    this.element = e;
  }

  /** The level last set (clamped to 0..1). */
  get level(): number {
    return this.current;
  }

  set(level: number): void {
    const v = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    if (v === this.current) return;
    this.current = v;
    const e = this.element;
    if (!e) return;
    e.style.opacity = String(v);
    e.style.display = v > 0 ? 'block' : 'none';
  }

  dispose(): void {
    this.element?.remove();
  }
}
