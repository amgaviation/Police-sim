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
 * keeps the last view.
 */
export class RadioMenuView {
  private readonly dom: MenuDom | null;
  private shown: RadioMenuModel | null = null;
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

  show(view: RadioMenuModel | null): void {
    if (sameView(this.shown, view)) return;
    this.shown = view ? copyView(view) : null;
    this.writes += 1;
    const dom = this.dom;
    if (!dom) return;
    dom.root.hidden = view === null;
    if (!view) return;
    setText(dom.title, view.title);
    while (dom.rows.length < view.options.length) dom.rows.push(div('radio-menu-option', dom.root));
    for (let i = 0; i < dom.rows.length; i++) {
      const row = dom.rows[i] as HTMLDivElement;
      const o = view.options[i];
      row.hidden = o === undefined;
      if (!o) continue;
      setText(row, radioMenuOptionText(o));
      setClass(row, o.enabled ? 'radio-menu-option' : 'radio-menu-option radio-menu-disabled');
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
  const title = div('radio-menu-title', root);
  return { root, title, rows: [] };
}
