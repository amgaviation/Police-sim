import './investigation.css';
import type { Menu, UIRoot } from '../ui';
import { div, setClass, setText } from '../panels/dom';
import { CASE_TABS, CASE_TAB_LABELS, type CaseFileView, type CaseRow, type CaseTab } from '../../investigation/caseView';
import type { CustodyAction } from '../../evidence';

export interface CaseFilePanelState {
  /** Index into `CASE_TABS`. */
  readonly tab: number;
  /** Highlighted row of the tab. */
  readonly focus: number;
}

export type CaseFileEmit =
  | { readonly kind: 'custody'; readonly itemId: string; readonly action: CustodyAction }
  | { readonly kind: 'close' };

export interface CaseFileKeyResult {
  readonly state: CaseFilePanelState;
  readonly emit: CaseFileEmit | null;
  readonly consumed: boolean;
}

export interface CaseFileHandlers {
  /** Enter on an item row: perform the next custody step (the app maps it to a request; deposit only at the evidence room). */
  custody(itemId: string, action: CustodyAction): void;
  close(): void;
}

/** Rows of a tab. */
export function tabRows(view: CaseFileView, tab: number): readonly CaseRow[] {
  const name: CaseTab = CASE_TABS[tab] ?? 'items';
  return view.tabs[name];
}

export function createCaseFileState(): CaseFilePanelState {
  return { tab: 0, focus: 0 };
}

/** Keeps the state valid for a new view (tab and focus in range). */
export function clampCaseState(state: CaseFilePanelState, view: CaseFileView): CaseFilePanelState {
  const tab = Math.min(CASE_TABS.length - 1, Math.max(0, state.tab));
  const rows = tabRows(view, tab).length;
  const focus = rows === 0 ? 0 : Math.min(state.focus, rows - 1);
  return tab === state.tab && focus === state.focus ? state : { tab, focus };
}

/**
 * Pure key reducer of the case file. Tab and Right go to the next tab, Left to the previous one, 1-7 jump to a tab;
 * Up / Down move the highlight (wrapping); Enter on an item row performs its next custody step (collect, bag, tag,
 * deposit); Escape closes. Keys it does not use are not consumed.
 */
export function reduceCaseKey(state: CaseFilePanelState, view: CaseFileView, key: string): CaseFileKeyResult {
  const idle = (consumed: boolean): CaseFileKeyResult => ({ state, emit: null, consumed });
  const goTab = (tab: number): CaseFileKeyResult => ({ state: { tab, focus: 0 }, emit: null, consumed: true });
  const n = CASE_TABS.length;
  switch (key) {
    case 'Tab':
    case 'ArrowRight':
      return goTab((state.tab + 1) % n);
    case 'ArrowLeft':
      return goTab((state.tab + n - 1) % n);
    case 'ArrowDown':
    case 'ArrowUp': {
      const rows = tabRows(view, state.tab).length;
      if (rows === 0) return idle(true);
      const focus = (state.focus + (key === 'ArrowDown' ? 1 : rows - 1)) % rows;
      return { state: { ...state, focus }, emit: null, consumed: true };
    }
    case 'Enter': {
      const row = tabRows(view, state.tab)[state.focus];
      if (row === undefined || row.itemId === null || row.next === null || CASE_TABS[state.tab] !== 'items') return idle(true);
      return { state, emit: { kind: 'custody', itemId: row.itemId, action: row.next }, consumed: true };
    }
    case 'Escape':
      return { state, emit: { kind: 'close' }, consumed: true };
    default: {
      if (key.length === 1 && key >= '1' && key <= String(n)) return goTab(Number(key) - 1);
      return idle(false);
    }
  }
}

interface Row {
  readonly root: HTMLDivElement;
  readonly img: HTMLImageElement;
  readonly text: HTMLSpanElement;
  readonly detail: HTMLSpanElement;
}

interface CaseDom {
  readonly root: HTMLDivElement;
  readonly title: HTMLDivElement;
  readonly verdict: HTMLDivElement;
  readonly tabs: HTMLDivElement[];
  readonly list: HTMLDivElement;
  readonly empty: HTMLDivElement;
  readonly rows: Row[];
  readonly footer: HTMLDivElement;
}

const HEADLESS_ELEMENT = {} as HTMLElement;
const FOOTER = 'Tab / 1-7 tabs · ↑↓ select · Enter next custody step · Esc close';

/**
 * Case file (design §10.4): a non-pausing `Menu` with the tabs Items, Photos, Prints, Canvass, Custody, Consents and
 * Statements, the custody chain verdict, and photo thumbnails. Keys go through `reduceCaseKey`. `update` re-renders in
 * place and keeps the selection (call it when `InvestigationSystem.revision` changes). Headless it keeps the state and
 * key handling but builds no DOM.
 */
export class CaseFilePanel implements Menu {
  readonly id = 'inv-case' as const;
  readonly element: HTMLElement;
  readonly pausesGame = false as const;

  private readonly ui: UIRoot | null;
  private readonly dom: CaseDom | null;
  private shown: CaseFileView | null = null;
  private handlers: CaseFileHandlers | null = null;
  private st: CaseFilePanelState = createCaseFileState();
  private openFlag = false;
  private lastFocusKey = '';

  constructor(ui: UIRoot | null) {
    this.ui = ui;
    this.dom = ui !== null && typeof document !== 'undefined' ? this.build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  get state(): CaseFilePanelState {
    return this.st;
  }

  get view(): CaseFileView | null {
    return this.shown;
  }

  open(view: CaseFileView, handlers: CaseFileHandlers): void {
    this.shown = view;
    this.handlers = handlers;
    this.st = createCaseFileState();
    this.openFlag = true;
    this.render();
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
  }

  update(view: CaseFileView): void {
    if (!this.openFlag) return;
    this.shown = view;
    this.st = clampCaseState(this.st, view);
    this.render();
  }

  /** Closes the panel without calling `handlers.close`. */
  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    this.handlers = null;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  onHide(): void {
    if (this.openFlag && this.ui && !this.ui.isOpen(this)) this.finish();
  }

  onKeyDown(event: KeyboardEvent): boolean {
    const view = this.shown;
    if (!this.openFlag || !view || event.ctrlKey || event.altKey || event.metaKey) return false;
    return this.apply(reduceCaseKey(this.st, view, event.key), event.repeat);
  }

  dispose(): void {
    this.close();
    this.dom?.root.remove();
  }

  private apply(result: CaseFileKeyResult, repeat: boolean): boolean {
    this.st = result.state;
    const emit = result.emit;
    if (emit?.kind === 'close') {
      this.finish();
      return true;
    }
    // Holding Enter repeats navigation, never a custody step.
    if (emit?.kind === 'custody' && !repeat) this.handlers?.custody(emit.itemId, emit.action);
    this.render();
    return result.consumed;
  }

  private finish(): void {
    const h = this.handlers;
    this.openFlag = false;
    this.handlers = null;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
    h?.close();
  }

  private render(): void {
    const dom = this.dom;
    const view = this.shown;
    if (!dom || !view) return;
    const st = this.st;
    setText(dom.title, `${view.incident === '' ? 'Case file' : view.incident}${view.title !== '' && view.title !== view.incident ? ` · ${view.title}` : ''}`);
    setText(dom.verdict, view.verdict);
    setClass(dom.verdict, view.chainOk ? 'inv-case-verdict' : 'inv-case-verdict inv-bad');
    for (let i = 0; i < dom.tabs.length; i++) {
      const tab = dom.tabs[i] as HTMLDivElement;
      const name = CASE_TABS[i] as CaseTab;
      setText(tab, `${CASE_TAB_LABELS[name]} ${String(view.tabs[name].length)}`);
      setClass(tab, i === st.tab ? 'inv-tab inv-on' : 'inv-tab');
    }
    const rows = tabRows(view, st.tab);
    dom.empty.hidden = rows.length > 0;
    while (dom.rows.length < rows.length) dom.rows.push(this.row(dom));
    for (let i = 0; i < dom.rows.length; i++) {
      const row = dom.rows[i] as Row;
      const data = rows[i];
      row.root.hidden = data === undefined;
      if (!data) continue;
      setClass(row.root, i === st.focus ? 'inv-row inv-focus' : 'inv-row');
      row.root.dataset['index'] = String(i);
      setText(row.text, data.text);
      setText(row.detail, data.detail);
      const thumb = data.thumb ?? '';
      row.img.hidden = thumb === '';
      if (thumb !== '' && row.img.getAttribute('src') !== thumb) row.img.setAttribute('src', thumb);
    }
    const focusKey = `${String(st.tab)}:${String(st.focus)}`;
    if (focusKey !== this.lastFocusKey) {
      this.lastFocusKey = focusKey;
      const el = rows[st.focus] !== undefined ? dom.rows[st.focus]?.root : undefined;
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
    }
  }

  private row(dom: CaseDom): Row {
    const root = div('inv-row', dom.list);
    root.setAttribute('role', 'option');
    root.addEventListener('click', () => {
      const i = Number(root.dataset['index']);
      const view = this.shown;
      if (!Number.isInteger(i) || !view) return;
      this.st = { ...this.st, focus: i };
      this.apply(reduceCaseKey(this.st, view, 'Enter'), false);
    });
    const img = document.createElement('img');
    img.className = 'inv-row-thumb';
    img.alt = 'Photo thumbnail';
    img.hidden = true;
    const text = document.createElement('span');
    text.className = 'inv-row-text';
    const detail = document.createElement('span');
    detail.className = 'inv-row-detail';
    root.append(img, text, detail);
    return { root, img, text, detail };
  }

  private build(): CaseDom {
    const root = div('inv-case');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Case file');
    const head = div('inv-case-head', root);
    const title = div('inv-case-title', head);
    const verdict = div('inv-case-verdict', head);
    const tabBar = div('inv-tabs', root);
    const tabs = CASE_TABS.map((_, i) => {
      const el = div('inv-tab', tabBar);
      el.addEventListener('click', () => {
        const view = this.shown;
        if (!view) return;
        this.st = clampCaseState({ tab: i, focus: 0 }, view);
        this.render();
      });
      return el;
    });
    const list = div('inv-list', root);
    list.setAttribute('role', 'listbox');
    // Focusable so UIRoot moves focus into the panel (rows are not buttons: keys are handled in onKeyDown).
    list.tabIndex = 0;
    const empty = div('inv-empty', list);
    empty.textContent = 'Nothing recorded yet.';
    const footer = div('inv-footer', root);
    footer.textContent = FOOTER;
    return { root, title, verdict, tabs, list, empty, rows: [], footer };
  }
}
