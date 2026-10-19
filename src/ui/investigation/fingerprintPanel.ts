import './investigation.css';
import type { Menu, UIRoot } from '../ui';
import { div, setClass, setText } from '../panels/dom';
import type { DustView } from '../../investigation/types';

/** Brush time one Space key event applies (s): key repeat fires about 30 times a second. */
export const BRUSH_STEP_S = 1 / 30;
const GRID = 4;

export type DustDir = 'up' | 'down' | 'left' | 'right';

export type DustEmit =
  | { readonly kind: 'move'; readonly dir: DustDir }
  | { readonly kind: 'brush'; readonly seconds: number }
  | { readonly kind: 'lift' }
  | { readonly kind: 'cancel' };

export interface DustHandlers {
  move(dir: DustDir): void;
  /** Brush the cursor cell for `seconds` (the app may also call `InvestigationSystem.request` itself while a key is held). */
  brush(seconds: number): void;
  lift(): void;
  cancel(): void;
}

/** Pure key map: arrows / WASD move the cursor, Space brushes, Enter lifts, Escape cancels; null for other keys. */
export function reduceDustKey(key: string): DustEmit | null {
  switch (key) {
    case 'ArrowUp':
    case 'w':
    case 'W':
      return { kind: 'move', dir: 'up' };
    case 'ArrowDown':
    case 's':
    case 'S':
      return { kind: 'move', dir: 'down' };
    case 'ArrowLeft':
    case 'a':
    case 'A':
      return { kind: 'move', dir: 'left' };
    case 'ArrowRight':
    case 'd':
    case 'D':
      return { kind: 'move', dir: 'right' };
    case ' ':
      return { kind: 'brush', seconds: BRUSH_STEP_S };
    case 'Enter':
      return { kind: 'lift' };
    case 'Escape':
      return { kind: 'cancel' };
    default:
      return null;
  }
}

interface DustDom {
  readonly root: HTMLDivElement;
  readonly sub: HTMLDivElement;
  readonly cells: HTMLDivElement[];
  readonly fill: HTMLDivElement;
  readonly quality: HTMLDivElement;
}

const HEADLESS_ELEMENT = {} as HTMLElement;

/**
 * Fingerprint dusting (design §10.4): a non-pausing `Menu` with a 4x4 grid coloured by brush coverage, the cursor and
 * a quality bar. Keys go through `reduceDustKey`; the handlers queue the matching `InvestigationRequest`s. The app calls
 * `update(system.dust)` when `revision` changes and closes the panel when `system.dust` becomes null.
 * Headless it keeps the key handling but builds no DOM.
 */
export class FingerprintPanel implements Menu {
  readonly id = 'inv-dust' as const;
  readonly element: HTMLElement;
  readonly pausesGame = false as const;

  private readonly ui: UIRoot | null;
  private readonly dom: DustDom | null;
  private shown: DustView | null = null;
  private handlers: DustHandlers | null = null;
  private openFlag = false;
  private readonly lastCov: number[] = new Array<number>(GRID * GRID).fill(-1);

  constructor(ui: UIRoot | null) {
    this.ui = ui;
    this.dom = ui !== null && typeof document !== 'undefined' ? build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  get view(): DustView | null {
    return this.shown;
  }

  open(view: DustView, handlers: DustHandlers): void {
    this.shown = view;
    this.handlers = handlers;
    this.openFlag = true;
    this.lastCov.fill(-1);
    this.render();
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
  }

  update(view: DustView): void {
    if (!this.openFlag) return;
    this.shown = view;
    this.render();
  }

  /** Closes the panel without calling a handler. */
  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    this.handlers = null;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  onHide(): void {
    // Popped by someone else (the menu stack was cleared): abandon the dusting.
    if (this.openFlag && this.ui && !this.ui.isOpen(this)) this.finish(true);
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.openFlag || event.ctrlKey || event.altKey || event.metaKey) return false;
    const emit = reduceDustKey(event.key);
    if (emit === null) return false;
    const h = this.handlers;
    if (!h) return true;
    switch (emit.kind) {
      case 'move':
        h.move(emit.dir);
        break;
      case 'brush':
        h.brush(emit.seconds);
        break;
      case 'lift':
        if (!event.repeat) this.finish(false);
        break;
      case 'cancel':
        if (!event.repeat) this.finish(true);
        break;
    }
    return true;
  }

  dispose(): void {
    this.close();
    this.dom?.root.remove();
  }

  /** Lift (cancelled false) or cancel: pops the panel and calls the handler once. */
  private finish(cancelled: boolean): void {
    const h = this.handlers;
    this.openFlag = false;
    this.handlers = null;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
    if (cancelled) h?.cancel();
    else h?.lift();
  }

  private render(): void {
    const dom = this.dom;
    const v = this.shown;
    if (!dom || !v) return;
    setText(dom.sub, `${v.label} · ${v.surface}`);
    for (let i = 0; i < dom.cells.length; i++) {
      const cell = dom.cells[i] as HTMLDivElement;
      const cov = v.coverage[i] ?? 0;
      if (this.lastCov[i] !== cov) {
        this.lastCov[i] = cov;
        cell.style.setProperty('--cov', String(Math.min(1, cov)));
      }
      setClass(cell, `inv-cell${cov > 1 ? ' inv-over' : ''}${i === v.cursor ? ' inv-cursor' : ''}`);
    }
    const pct = Math.round(v.quality * 100);
    setText(dom.quality, `Print quality ${String(pct)}%`);
    dom.fill.style.width = `${String(pct)}%`;
    setClass(dom.fill, v.quality < 0.35 ? 'inv-quality-fill inv-low' : 'inv-quality-fill');
  }
}

function build(): DustDom {
  const root = div('inv-dust');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Fingerprint dusting');
  const title = div('inv-dust-title', root);
  title.textContent = 'Dust for prints';
  const sub = div('inv-dust-sub', root);
  const grid = div('inv-grid', root);
  const cells: HTMLDivElement[] = [];
  for (let i = 0; i < GRID * GRID; i++) cells.push(div('inv-cell', grid));
  const bar = div('inv-quality', root);
  const fill = div('inv-quality-fill', bar);
  const quality = div('inv-dust-sub', root);
  const hint = div('inv-dust-sub', root);
  hint.textContent = 'Arrows / WASD move · Space brush · Enter lift · Esc cancel';
  return { root, sub, cells, fill, quality };
}
