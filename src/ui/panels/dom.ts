/** Small DOM helpers shared by the panels (only called when a DOM exists). */

/** Writes `text` only when it differs from the current text. */
export function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

/** Writes `className` only when it differs. */
export function setClass(e: HTMLElement, className: string): void {
  if (e.className !== className) e.className = className;
}

export function div(className: string, parent: HTMLElement | null = null): HTMLDivElement {
  const e = document.createElement('div');
  e.className = className;
  parent?.appendChild(e);
  return e;
}

/**
 * The left column above the minimap that stacks the radio menu over the radio log. Shared by
 * `RadioPanel` and `RadioMenuView` whatever order they are created in.
 */
export function radioColumn(parent: HTMLElement): HTMLElement {
  for (const child of Array.from(parent.children)) {
    if (child instanceof HTMLElement && child.classList.contains('radio-column')) return child;
  }
  return div('radio-column', parent);
}

/** Removes `e` and the radio column it sat in once the column is empty. */
export function removeFromColumn(e: HTMLElement): void {
  const column = e.parentElement;
  e.remove();
  if (column?.classList.contains('radio-column') && column.childElementCount === 0) column.remove();
}
