/** DOM helpers of the career screens (only called when a document exists). */

/**
 * Runs `build` (which clears and refills `container`) and puts focus back on the element carrying the same
 * `data-focus` key when the focus was inside the container before, so a rebuild does not drop keyboard focus.
 */
export function keepFocus(container: HTMLElement, build: () => void): void {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  const key = active instanceof HTMLElement && container.contains(active) ? (active.dataset['focus'] ?? '') : '';
  build();
  if (key === '') return;
  for (const candidate of Array.from(container.querySelectorAll<HTMLElement>('[data-focus]'))) {
    if (candidate.dataset['focus'] === key) {
      candidate.focus();
      return;
    }
  }
}

/** A 0..1 meter: `<div class="cr-meter cr-<severity>"><div class="cr-meter-fill" style="width:NN%"></div></div>`. */
export function meter(value: number, severity: string, label: string): HTMLElement {
  const bar = document.createElement('div');
  bar.className = `cr-meter cr-${severity}`;
  bar.setAttribute('role', 'meter');
  bar.setAttribute('aria-label', label);
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  const pct = Math.round(Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0)) * 100);
  bar.setAttribute('aria-valuenow', String(pct));
  const fill = document.createElement('div');
  fill.className = 'cr-meter-fill';
  fill.style.width = `${String(pct)}%`;
  bar.appendChild(fill);
  return bar;
}

/** Tag name of an event target, '' when it is not an element (or there is no DOM). */
export function tagOf(target: EventTarget | null): string {
  return typeof HTMLElement !== 'undefined' && target instanceof HTMLElement ? target.tagName : '';
}

/** `data-focus` key of an event target, '' when it has none. */
export function focusKeyOf(target: EventTarget | null): string {
  return typeof HTMLElement !== 'undefined' && target instanceof HTMLElement ? (target.dataset['focus'] ?? '') : '';
}
