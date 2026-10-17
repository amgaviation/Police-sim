/**
 * Small DOM building blocks of the MDT: a keyboard-navigable list that reuses its row elements, a
 * read-only section renderer and labelled form fields. Only constructed when a document exists.
 */
import { clearChildren, el } from '../ui';
import type { MdtSection } from './model';

let uid = 0;
/** Unique element id for label/control pairs. */
export function nextId(prefix: string): string {
  uid += 1;
  return `mdt-${prefix}-${uid}`;
}

export function setText(node: HTMLElement, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function setClass(node: HTMLElement, cls: string): void {
  if (node.className !== cls) node.className = cls;
}

// --- List ---------------------------------------------------------------------------------------

export interface Column<R> {
  readonly label: string;
  readonly cls?: string;
  text(row: R): string;
}

export interface ListOptions<R> {
  key(row: R): string | number;
  rowClass?(row: R): string;
  /** Click or keyboard move onto a row. */
  onSelect?(row: R): void;
  /** Enter or double click. */
  onActivate?(row: R): void;
  empty?: string;
}

/**
 * Table of rows with a roving tabindex: one row is tabbable, Up/Down move focus, Enter activates.
 * `render` reuses row and cell elements and only writes text that changed.
 */
export class ListView<R> {
  readonly element: HTMLElement;
  private readonly body: HTMLTableSectionElement;
  private readonly emptyRow: HTMLTableRowElement;
  private readonly columns: readonly Column<R>[];
  private readonly opts: ListOptions<R>;
  private rows: readonly R[] = [];
  private readonly trs: HTMLTableRowElement[] = [];
  private activeKey: string | number | null = null;

  constructor(label: string, columns: readonly Column<R>[], opts: ListOptions<R>) {
    this.columns = columns;
    this.opts = opts;
    const head = el('tr', null, ...columns.map((c) => el('th', { scope: 'col', class: c.cls ?? '' }, c.label)));
    this.body = el('tbody');
    this.emptyRow = el('tr', { class: 'mdt-empty' }, el('td', { colspan: columns.length }, opts.empty ?? 'Nothing to show'));
    this.element = el('table', { class: 'mdt-list', 'aria-label': label }, el('thead', null, head), this.body);
    this.body.appendChild(this.emptyRow);
  }

  get selected(): R | null {
    const i = this.indexOfKey(this.activeKey);
    return i >= 0 ? (this.rows[i] ?? null) : null;
  }

  get selectedKey(): string | number | null {
    return this.activeKey;
  }

  /** Makes `key` the active row; a key not in the list keeps the first row active (one row stays tabbable). */
  select(key: string | number | null): void {
    this.activeKey = key;
    if (this.indexOfKey(key) < 0) this.activeKey = this.rows.length > 0 ? this.opts.key(this.rows[0] as R) : null;
    this.syncActive();
  }

  render(rows: readonly R[]): void {
    this.rows = rows;
    const n = rows.length;
    this.emptyRow.hidden = n > 0;
    while (this.trs.length < n) this.trs.push(this.createRow(this.trs.length));
    for (let i = 0; i < this.trs.length; i++) {
      const tr = this.trs[i] as HTMLTableRowElement;
      if (i >= n) {
        if (tr.parentNode) tr.remove();
        continue;
      }
      if (!tr.parentNode) this.body.appendChild(tr);
      const row = rows[i] as R;
      for (let c = 0; c < this.columns.length; c++) {
        const td = tr.children[c] as HTMLElement | undefined;
        const col = this.columns[c];
        if (td && col) setText(td, col.text(row));
      }
      setClass(tr, `mdt-row ${this.opts.rowClass?.(row) ?? ''}`.trim());
      tr.dataset['key'] = String(this.opts.key(row));
    }
    if (this.indexOfKey(this.activeKey) < 0) this.activeKey = n > 0 ? this.opts.key(rows[0] as R) : null;
    this.syncActive();
    // Rows shifted under the focus (a new call sorted to the top): focus follows the active row, so
    // the focus ring and Enter both mean the same item.
    const focused = typeof document !== 'undefined' ? document.activeElement : null;
    if (focused instanceof HTMLElement && focused.parentNode === this.body) {
      const active = this.indexOfKey(this.activeKey);
      if (active >= 0 && focused.dataset['key'] !== String(this.activeKey)) this.trs[active]?.focus();
    }
  }

  /** Moves the active row by `delta` and focuses it; false when there are no rows. */
  move(delta: number): boolean {
    const n = this.rows.length;
    if (n === 0) return false;
    const cur = this.indexOfKey(this.activeKey);
    // Without an active row the first move lands on the first (down) or last (up) row.
    const next = cur < 0 ? (delta > 0 ? 0 : n - 1) : Math.min(n - 1, Math.max(0, cur + delta));
    const row = this.rows[next] as R;
    this.activeKey = this.opts.key(row);
    this.syncActive();
    this.trs[next]?.focus();
    this.opts.onSelect?.(row);
    return true;
  }

  activate(): boolean {
    const row = this.selected;
    if (!row || !this.opts.onActivate) return false;
    this.opts.onActivate(row);
    return true;
  }

  focus(): void {
    const i = this.indexOfKey(this.activeKey);
    this.trs[i >= 0 ? i : 0]?.focus();
  }

  contains(node: unknown): boolean {
    return node instanceof Node && this.element.contains(node);
  }

  private indexOfKey(key: string | number | null): number {
    if (key === null) return -1;
    for (let i = 0; i < this.rows.length; i++) if (this.opts.key(this.rows[i] as R) === key) return i;
    return -1;
  }

  private syncActive(): void {
    const active = this.indexOfKey(this.activeKey);
    for (let i = 0; i < this.trs.length; i++) {
      const tr = this.trs[i] as HTMLTableRowElement;
      const on = i === active;
      const tab = on ? '0' : '-1';
      if (tr.getAttribute('tabindex') !== tab) tr.setAttribute('tabindex', tab);
      const sel = on ? 'true' : 'false';
      if (tr.getAttribute('aria-selected') !== sel) tr.setAttribute('aria-selected', sel);
    }
  }

  private createRow(index: number): HTMLTableRowElement {
    const tr = el('tr', { class: 'mdt-row', tabindex: -1, 'data-mdt-row': '' }, ...this.columns.map((c) => el('td', { class: c.cls ?? '' })));
    tr.addEventListener('click', () => {
      const row = this.rows[index];
      if (row === undefined) return;
      this.activeKey = this.opts.key(row);
      this.syncActive();
      this.opts.onSelect?.(row);
    });
    tr.addEventListener('dblclick', () => {
      const row = this.rows[index];
      if (row !== undefined) this.opts.onActivate?.(row);
    });
    return tr;
  }
}

// --- Sections -----------------------------------------------------------------------------------

export interface SectionLinks {
  person?(personId: number): void;
  doc?(docId: string): void;
}

/** Replaces `container`'s content with read-only sections (person/vehicle records, documents). */
export function renderSections(container: HTMLElement, sections: readonly MdtSection[], links: SectionLinks = {}): void {
  clearChildren(container);
  for (const s of sections) {
    const list = el('dl', { class: 'mdt-lines' });
    for (const l of s.lines) {
      let value: HTMLElement;
      if (l.personId !== undefined && l.personId >= 0 && links.person) {
        const id = l.personId;
        value = el('button', { type: 'button', class: 'mdt-link', onclick: () => links.person?.(id) }, l.text);
      } else if (l.docId !== undefined && l.docId !== '' && links.doc) {
        const id = l.docId;
        value = el('button', { type: 'button', class: 'mdt-link', onclick: () => links.doc?.(id) }, l.text);
      } else {
        value = el('span', null, l.text);
      }
      list.append(el('dt', null, l.label), el('dd', { class: `mdt-sev-${l.severity}` }, value));
    }
    container.appendChild(el('section', { class: `mdt-section mdt-section-${s.id}`, 'aria-label': s.title }, el('h3', null, s.title), list));
  }
}

// --- Fields -------------------------------------------------------------------------------------

export interface Field<T extends HTMLElement> {
  readonly element: HTMLElement;
  readonly control: T;
}

export function textField(label: string, value = '', attrs: Record<string, string | number | boolean> = {}): Field<HTMLInputElement> {
  const id = nextId('f');
  const control = el('input', { type: 'text', id, autocomplete: 'off', spellcheck: false, ...attrs });
  control.value = value;
  return { element: el('div', { class: 'mdt-field' }, el('label', { for: id }, label), control), control };
}

export function numberField(label: string, value: number | null, attrs: Record<string, string | number | boolean> = {}): Field<HTMLInputElement> {
  const id = nextId('n');
  const control = el('input', { type: 'number', id, autocomplete: 'off', ...attrs });
  control.value = value === null || !Number.isFinite(value) ? '' : String(value);
  return { element: el('div', { class: 'mdt-field' }, el('label', { for: id }, label), control), control };
}

export function areaField(label: string, value = '', rows = 5): Field<HTMLTextAreaElement> {
  const id = nextId('a');
  const control = el('textarea', { id, rows, spellcheck: true });
  control.value = value;
  return { element: el('div', { class: 'mdt-field mdt-field-wide' }, el('label', { for: id }, label), control), control };
}

export interface Option {
  readonly value: string;
  readonly label: string;
}

export function selectField(label: string, options: readonly Option[], value: string): Field<HTMLSelectElement> {
  const id = nextId('s');
  const control = el('select', { id }, ...options.map((o) => el('option', { value: o.value }, o.label)));
  control.value = value;
  return { element: el('div', { class: 'mdt-field' }, el('label', { for: id }, label), control), control };
}

export function fillSelect(select: HTMLSelectElement, options: readonly Option[]): void {
  const value = select.value;
  clearChildren(select);
  for (const o of options) select.appendChild(el('option', { value: o.value }, o.label));
  if (options.some((o) => o.value === value)) select.value = value;
}

/** Group of labelled checkboxes; `values()` returns the checked values in option order. */
export function checkList(legend: string, options: readonly Option[], checked: readonly string[]): { element: HTMLElement; values(): string[] } {
  const boxes: HTMLInputElement[] = [];
  const items = options.map((o) => {
    const id = nextId('c');
    const box = el('input', { type: 'checkbox', id, value: o.value });
    box.checked = checked.includes(o.value);
    boxes.push(box);
    return el('div', { class: 'mdt-check' }, box, el('label', { for: id }, o.label));
  });
  const element = el('fieldset', { class: 'mdt-checklist' }, el('legend', null, legend), items.length > 0 ? items : el('p', { class: 'mdt-hint' }, 'None available'));
  return { element, values: () => boxes.filter((b) => b.checked).map((b) => b.value) };
}

export function button(label: string, onClick: () => void, cls = ''): HTMLButtonElement {
  return el('button', { type: 'button', class: cls, onclick: onClick }, label);
}
