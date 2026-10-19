import './station.css';
import type { Menu, UIRoot } from '../ui';
import { div, setText } from '../panels/dom';
import type { BriefingView } from '../../station/briefing';

const HEADLESS_ELEMENT = {} as HTMLElement;

interface BriefingDom {
  readonly root: HTMLDivElement;
  readonly title: HTMLDivElement;
  readonly date: HTMLDivElement;
  readonly assignment: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly button: HTMLButtonElement;
}

/**
 * The roll-call sheet (design §11.2): a paper-like page with the briefing sections. A pausing `Menu`; Enter, Escape or a
 * click on the button closes it and calls `onClose` once (the integrator then completes the `briefing` step).
 * Headless (no `document` or no `UIRoot`) it keeps the open state and the key handling but builds no DOM.
 */
export class BriefingScreen implements Menu {
  readonly id = 'briefing' as const;
  readonly element: HTMLElement;
  readonly pausesGame = true as const;

  private readonly ui: UIRoot | null;
  private readonly dom: BriefingDom | null;
  private shown: BriefingView | null = null;
  private closeFn: (() => void) | null = null;
  private openFlag = false;

  constructor(ui: UIRoot | null) {
    this.ui = ui;
    this.dom = ui !== null && typeof document !== 'undefined' ? build(() => this.close()) : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  /** The view shown (null before the first open). */
  get view(): BriefingView | null {
    return this.shown;
  }

  open(view: BriefingView, onClose: () => void): void {
    this.shown = view;
    this.closeFn = onClose;
    this.openFlag = true;
    this.render();
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
  }

  /** Closes the sheet and calls `onClose` once. */
  close(): void {
    if (!this.openFlag) return;
    this.finish();
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  onHide(): void {
    // Popped by someone else (e.g. the menu stack was cleared): treat as closed.
    if (this.openFlag && this.ui && !this.ui.isOpen(this)) this.finish();
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.openFlag) return false;
    if (event.key === 'Enter' || event.key === 'Escape') {
      if (!event.repeat) this.close();
      return true;
    }
    return false;
  }

  dispose(): void {
    this.close();
    this.dom?.root.remove();
  }

  private finish(): void {
    this.openFlag = false;
    const cb = this.closeFn;
    this.closeFn = null;
    cb?.();
  }

  private render(): void {
    const dom = this.dom;
    const view = this.shown;
    if (!dom || !view) return;
    setText(dom.title, view.title);
    setText(dom.date, view.date);
    setText(dom.assignment, view.assignment);
    while (dom.body.firstChild) dom.body.removeChild(dom.body.firstChild);
    for (const section of view.sections) {
      const block = div('brf-section', dom.body);
      const heading = div('brf-heading', block);
      heading.textContent = section.heading;
      for (const line of section.lines) {
        const row = div('brf-line', block);
        row.textContent = line;
      }
    }
  }
}

function build(onContinue: () => void): BriefingDom {
  const root = div('brf-screen');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Roll call briefing');
  const head = div('brf-head', root);
  const title = div('brf-title', head);
  const date = div('brf-date', head);
  const assignment = div('brf-assignment', root);
  const body = div('brf-body', root);
  const foot = div('brf-foot', root);
  const hint = div('brf-hint', foot);
  hint.textContent = 'Enter or Esc to leave roll call';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'brf-button';
  button.textContent = 'Continue';
  button.setAttribute('autofocus', '');
  button.addEventListener('click', onContinue);
  foot.appendChild(button);
  return { root, title, date, assignment, body, button };
}
