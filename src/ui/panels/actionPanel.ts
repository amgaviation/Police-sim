import './panels.css';
import type { Menu, UIRoot } from '../ui';
import { div, setClass, setText } from './dom';
import { panelBadge, panelKeyToIndex } from './text';

export interface PanelOption {
  readonly label: string;
  /** Second, dimmer text on the row (e.g. 'x2', 'Locked'). */
  readonly detail?: string;
  /** Default true. */
  readonly enabled?: boolean;
}

export interface ActionPanelModel {
  readonly title: string;
  readonly subtitle?: string;
  readonly options: readonly PanelOption[];
  readonly footer?: string;
}

export function optionEnabled(o: PanelOption | undefined): boolean {
  return o !== undefined && o.enabled !== false;
}

/** First enabled option index from `start` searching `dir` (wrapping), -1 when none is enabled. */
export function nextEnabled(options: readonly PanelOption[], start: number, dir: 1 | -1): number {
  const n = options.length;
  if (n === 0) return -1;
  for (let k = 0; k < n; k++) {
    const i = (((start + dir * k) % n) + n) % n;
    if (optionEnabled(options[i])) return i;
  }
  return -1;
}

interface Row {
  readonly root: HTMLDivElement;
  readonly badge: HTMLSpanElement;
  readonly label: HTMLSpanElement;
  readonly detail: HTMLSpanElement;
}

interface PanelDom {
  readonly root: HTMLDivElement;
  readonly title: HTMLDivElement;
  readonly subtitle: HTMLDivElement;
  readonly list: HTMLDivElement;
  readonly footer: HTMLDivElement;
  readonly rows: Row[];
}

const HEADLESS_ELEMENT = {} as HTMLElement;
const DEFAULT_FOOTER = '1-9 select · ↑↓ Enter · Esc close';

/**
 * Generic keyboard list panel (trunk, rack/equipment, traffic-stop driver contact): a
 * non-pausing `Menu` with a title, subtitle, numbered options and a footer. Digits select
 * enabled options, Up/Down move the highlight, Enter selects it and Escape closes (onClose).
 * Selecting does not close the panel: the caller updates or closes it. `update` refreshes the
 * rows in place and keeps the highlight. Headless (no `document` or no `UIRoot`) it keeps the
 * model and the key handling but builds no DOM.
 */
export class ActionPanel implements Menu {
  readonly id = 'action-panel' as const;
  readonly element: HTMLElement;
  readonly pausesGame = false as const;

  private readonly ui: UIRoot | null;
  private readonly dom: PanelDom | null;
  private current: ActionPanelModel | null = null;
  private selectFn: ((index: number) => void) | null = null;
  private closeFn: (() => void) | null = null;
  private openFlag = false;
  private focusIdx = -1;

  constructor(ui: UIRoot | null) {
    this.ui = ui;
    this.dom = ui !== null && typeof document !== 'undefined' ? build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  /** The model shown (null before the first open). */
  get model(): ActionPanelModel | null {
    return this.current;
  }

  /** Highlighted option, -1 when no option is enabled. */
  get focusIndex(): number {
    return this.focusIdx;
  }

  open(model: ActionPanelModel, onSelect: (index: number) => void, onClose?: () => void): void {
    this.current = model;
    this.selectFn = onSelect;
    this.closeFn = onClose ?? null;
    this.openFlag = true;
    this.focusIdx = nextEnabled(model.options, 0, 1);
    this.render();
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
  }

  /** Replaces the model in place; the highlight stays on the same index (or the next enabled one). */
  update(model: ActionPanelModel): void {
    this.current = model;
    const opts = model.options;
    if (!optionEnabled(opts[this.focusIdx])) {
      const start = Math.min(Math.max(this.focusIdx, 0), Math.max(opts.length - 1, 0));
      this.focusIdx = nextEnabled(opts, start, 1);
    }
    this.render();
  }

  /** Closes the panel and calls onClose once. */
  close(): void {
    if (!this.openFlag) return;
    this.finish();
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  /** Selects option `index` when it exists and is enabled; returns whether onSelect ran. */
  select(index: number): boolean {
    const model = this.current;
    if (!this.openFlag || !model || !optionEnabled(model.options[index])) return false;
    this.focusIdx = index;
    this.render();
    this.selectFn?.(index);
    return true;
  }

  onHide(): void {
    // Popped by someone else (e.g. the menu stack was cleared): treat as closed.
    if (this.openFlag && this.ui && !this.ui.isOpen(this)) this.finish();
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.openFlag || !this.current) return false;
    const key = event.key;
    const digit = panelKeyToIndex(key);
    if (digit !== null) {
      if (!event.repeat) this.select(digit);
      return true;
    }
    switch (key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        const dir = key === 'ArrowDown' ? 1 : -1;
        const next = nextEnabled(this.current.options, this.focusIdx + dir, dir);
        if (next !== -1 && next !== this.focusIdx) {
          this.focusIdx = next;
          this.render();
        }
        return true;
      }
      case 'Enter':
        if (!event.repeat && this.focusIdx >= 0) this.select(this.focusIdx);
        return true;
      case 'Escape':
        this.close();
        return true;
      default:
        return false;
    }
  }

  private finish(): void {
    this.openFlag = false;
    const cb = this.closeFn;
    this.closeFn = null;
    this.selectFn = null;
    cb?.();
  }

  private render(): void {
    const dom = this.dom;
    const model = this.current;
    if (!dom || !model) return;
    setText(dom.title, model.title);
    const subtitle = model.subtitle ?? '';
    setText(dom.subtitle, subtitle);
    dom.subtitle.hidden = subtitle === '';
    setText(dom.footer, model.footer ?? DEFAULT_FOOTER);
    const opts = model.options;
    while (dom.rows.length < opts.length) dom.rows.push(this.row(dom, dom.rows.length));
    for (let i = 0; i < dom.rows.length; i++) {
      const row = dom.rows[i] as Row;
      const o = opts[i];
      row.root.hidden = o === undefined;
      if (!o) continue;
      const enabled = optionEnabled(o);
      setText(row.badge, panelBadge(i));
      setText(row.label, o.label);
      setText(row.detail, o.detail ?? '');
      const cls = `panel-option${enabled ? '' : ' panel-disabled'}${i === this.focusIdx ? ' panel-focused' : ''}`;
      setClass(row.root, cls);
      const selected = i === this.focusIdx ? 'true' : 'false';
      if (row.root.getAttribute('aria-selected') !== selected) row.root.setAttribute('aria-selected', selected);
      const disabled = enabled ? 'false' : 'true';
      if (row.root.getAttribute('aria-disabled') !== disabled) row.root.setAttribute('aria-disabled', disabled);
    }
  }

  private row(dom: PanelDom, index: number): Row {
    const root = div('panel-option', dom.list);
    root.setAttribute('role', 'option');
    root.addEventListener('click', () => {
      this.select(index);
    });
    const badge = document.createElement('span');
    badge.className = 'panel-badge';
    const label = document.createElement('span');
    label.className = 'panel-label';
    const detail = document.createElement('span');
    detail.className = 'panel-detail';
    root.append(badge, label, detail);
    return { root, badge, label, detail };
  }
}

function build(): PanelDom {
  const root = div('panel-action');
  root.setAttribute('role', 'dialog');
  const title = div('panel-title', root);
  const subtitle = div('panel-subtitle', root);
  const list = div('panel-list', root);
  list.setAttribute('role', 'listbox');
  // Focusable so UIRoot moves focus into the panel (rows are not buttons: Enter is handled in onKeyDown).
  list.tabIndex = 0;
  const footer = div('panel-footer', root);
  return { root, title, subtitle, list, footer, rows: [] };
}
