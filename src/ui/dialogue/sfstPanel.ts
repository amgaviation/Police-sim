import '../panels/panels.css';
import './dialogue.css';
import type { Menu, UIRoot } from '../ui';
import { div, setText } from '../panels/dom';
import type { SfstHandlers, SfstView } from './types';

/** Keys the field sobriety test understands. */
export type SfstKey = 'space' | 'a' | 'd' | 'w';

/** Maps a keyboard event to an SFST key: Space, A / Left, D / Right, W / Up; null for anything else. */
export function sfstKeyName(event: { key: string; code: string }): SfstKey | null {
  switch (event.key.toLowerCase()) {
    case ' ':
    case 'spacebar':
      return 'space';
    case 'a':
    case 'arrowleft':
      return 'a';
    case 'd':
    case 'arrowright':
      return 'd';
    case 'w':
    case 'arrowup':
      return 'w';
    default:
      return event.code === 'Space' ? 'space' : null;
  }
}

interface PanelDom {
  readonly root: HTMLDivElement;
  readonly title: HTMLDivElement;
  readonly instruction: HTMLDivElement;
  readonly prompt: HTMLDivElement;
  readonly timerTrack: HTMLDivElement;
  readonly timerBar: HTMLDivElement;
  readonly progressBar: HTMLDivElement;
  readonly summary: HTMLDivElement;
  readonly footer: HTMLDivElement;
}

const HEADLESS_ELEMENT = {} as HTMLElement;
const SUMMARY_LINES = 10;

/** Percentage width in 2 % steps, so the bar style changes at most 50 times across its range. */
function barWidth(fraction: number): string {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return `${String(Math.round(f * 50) * 2)}%`;
}

/**
 * Field sobriety test panel (design §12.3): a centred, non-pausing `Menu` with the test's instruction, a large
 * key prompt with the time left in its window, the test progress, and (when finished) the result summary.
 * Keys go to `handlers.key` as `sfstKeyName` values (the arrows are the test's own A / D / W keys, Enter is
 * Space); Escape closes (`handlers.close`, also when the test is finished, where Enter closes too). `close()` called by the app does not call `handlers.close`. Headless it keeps the state only.
 */
export class SfstPanel implements Menu {
  readonly id = 'sfst' as const;
  readonly element: HTMLElement;
  readonly pausesGame = false as const;

  private readonly ui: UIRoot | null;
  private readonly dom: PanelDom | null;
  private handlers: SfstHandlers | null = null;
  private current: SfstView | null = null;
  private openFlag = false;

  constructor(ui: UIRoot | null) {
    this.ui = ui;
    this.dom = ui !== null && typeof document !== 'undefined' ? build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  /** The view shown (null before the first open). */
  get view(): SfstView | null {
    return this.current;
  }

  open(view: SfstView, handlers: SfstHandlers): void {
    this.current = view;
    this.handlers = handlers;
    this.openFlag = true;
    this.render();
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
  }

  update(view: SfstView): void {
    if (!this.openFlag) return;
    this.current = view;
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
    if (!this.openFlag || event.ctrlKey || event.altKey || event.metaKey) return false;
    if (event.key === 'Escape') {
      this.finish();
      return true;
    }
    // Enter (the gamepad's A) is the Space key of the test, and leaves once the test is finished.
    if (event.key === 'Enter') {
      if (event.repeat) return true;
      if (this.current?.finished) this.finish();
      else this.handlers?.key('space');
      return true;
    }
    const key = sfstKeyName(event);
    if (key === null) return false;
    if (!event.repeat && !this.current?.finished) this.handlers?.key(key);
    return true;
  }

  dispose(): void {
    this.close();
    this.dom?.root.remove();
  }

  private finish(): void {
    const handlers = this.handlers;
    this.openFlag = false;
    this.handlers = null;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
    handlers?.close();
  }

  private render(): void {
    const dom = this.dom;
    const view = this.current;
    if (!dom || !view) return;
    setText(dom.title, view.title);
    setText(dom.instruction, view.instruction);
    const prompting = view.prompt !== null && !view.finished;
    setText(dom.prompt, prompting ? (view.prompt ?? '') : '');
    dom.prompt.hidden = !prompting;
    dom.timerTrack.hidden = !prompting;
    const timer = barWidth(view.promptRemaining);
    if (dom.timerBar.style.width !== timer) dom.timerBar.style.width = timer;
    const progress = barWidth(view.progress);
    if (dom.progressBar.style.width !== progress) dom.progressBar.style.width = progress;
    setText(dom.summary, view.finished ? view.summary.slice(0, SUMMARY_LINES).join('\n') : '');
    dom.summary.hidden = !view.finished;
    setText(dom.footer, view.finished ? 'Enter / Esc  finish' : 'Press the key shown (Enter = Space) · Esc  stop the test');
  }
}

function build(): PanelDom {
  const root = div('dlg-sfst');
  root.setAttribute('role', 'dialog');
  // Focusable so UIRoot moves focus into the panel.
  root.tabIndex = 0;
  const title = div('dlg-title', root);
  const instruction = div('dlg-instruction', root);
  const prompt = div('dlg-prompt', root);
  const timer = div('dlg-bar dlg-bar-timer', root);
  const timerBar = div('dlg-bar-fill', timer);
  const progress = div('dlg-bar', root);
  const progressBar = div('dlg-bar-fill', progress);
  const summary = div('dlg-summary', root);
  const footer = div('dlg-footer', root);
  prompt.hidden = true;
  summary.hidden = true;
  return { root, title, instruction, prompt, timerTrack: timer, timerBar, progressBar, summary, footer };
}
