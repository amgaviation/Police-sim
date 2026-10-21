import './panels.css';
import { div, radioColumn, removeFromColumn, setClass, setText } from './dom';
import { radioMenuOptionText } from './text';

export interface RadioMenuOption {
  readonly key: number;
  readonly label: string;
  readonly enabled: boolean;
}

/** Shape of the radio's `MenuView` (design §9.7). */
export interface RadioMenuModel {
  readonly title: string;
  readonly options: readonly RadioMenuOption[];
}

interface MenuDom {
  readonly root: HTMLDivElement;
  readonly title: HTMLDivElement;
  readonly rows: HTMLDivElement[];
}

function sameView(a: RadioMenuModel | null, b: RadioMenuModel | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.title !== b.title || a.options.length !== b.options.length) return false;
  for (let i = 0; i < a.options.length; i++) {
    const x = a.options[i] as RadioMenuOption;
    const y = b.options[i] as RadioMenuOption;
    if (x.key !== y.key || x.label !== y.label || x.enabled !== y.enabled) return false;
  }
  return true;
}

function copyView(v: RadioMenuModel): RadioMenuModel {
  return { title: v.title, options: v.options.map((o) => ({ key: o.key, label: o.label, enabled: o.enabled })) };
}

/**
 * Number-key radio menu display (left, above the radio log): the title and one line per
 * option ('1 Status ▸'), disabled options greyed; hidden for null. `show` may be called every
 * frame: it compares by value and touches the DOM only when the menu changed. Headless it
 * keeps the last view. The row at `cursor` (D-pad / PageUp / PageDown driven, Phase 9) is highlighted with
 * `is-selected` + `aria-selected="true"`; a cursor-only change toggles classes without rebuilding the rows.
 */
export class RadioMenuView {
  private readonly dom: MenuDom | null;
  private shown: RadioMenuModel | null = null;
  private shownCursor = -1;
  private writes = 0;

  constructor(parent: HTMLElement | null) {
    this.dom = parent !== null && typeof document !== 'undefined' ? build(parent) : null;
  }

  /** The menu shown (a copy), null while hidden. */
  get view(): RadioMenuModel | null {
    return this.shown;
  }

  /** Changes applied so far (tests and diagnostics). */
  get renders(): number {
    return this.writes;
  }

  /** The highlighted option index (-1 none). */
  get cursor(): number {
    return this.shownCursor;
  }

  show(view: RadioMenuModel | null, cursor = -1): void {
    const at = view === null ? -1 : cursor;
    const sameRows = sameView(this.shown, view);
    if (sameRows && at === this.shownCursor) return;
    this.shownCursor = at;
    this.writes += 1;
    const dom = this.dom;
    if (!sameRows) this.shown = view ? copyView(view) : null;
    if (!dom) return;
    if (sameRows) {
      this.markCursor(dom, at);
      return;
    }
    dom.root.hidden = view === null;
    if (!view) return;
    setText(dom.title, view.title);
    while (dom.rows.length < view.options.length) {
      const row = div('radio-menu-option', dom.root);
      row.setAttribute('role', 'option');
      dom.rows.push(row);
    }
    for (let i = 0; i < dom.rows.length; i++) {
      const row = dom.rows[i] as HTMLDivElement;
      const o = view.options[i];
      row.hidden = o === undefined;
      if (!o) continue;
      setText(row, radioMenuOptionText(o));
    }
    this.markCursor(dom, at);
  }

  /** Class and `aria-selected` of every visible row (a row's classes only change when its state does). */
  private markCursor(dom: MenuDom, cursor: number): void {
    const view = this.shown;
    if (!view) return;
    for (let i = 0; i < view.options.length; i++) {
      const row = dom.rows[i];
      const o = view.options[i];
      if (!row || !o) continue;
      const selected = i === cursor;
      setClass(row, `radio-menu-option${o.enabled ? '' : ' radio-menu-disabled'}${selected ? ' is-selected' : ''}`);
      const aria = selected ? 'true' : 'false';
      if (row.getAttribute('aria-selected') !== aria) row.setAttribute('aria-selected', aria);
    }
  }

  dispose(): void {
    if (this.dom) removeFromColumn(this.dom.root);
  }
}

function build(parent: HTMLElement): MenuDom {
  const column = radioColumn(parent);
  const root = div('radio-menu');
  // The menu sits above the log whichever was created first.
  column.insertBefore(root, column.firstChild);
  root.hidden = true;
  root.setAttribute('role', 'listbox');
  root.setAttribute('aria-label', 'Radio menu');
  const title = div('radio-menu-title', root);
  return { root, title, rows: [] };
}
