import type { TutorialView } from '../../tutorial/runner';
import { formatTutorialText } from '../../tutorial/format';
import { el, type Menu, type UIRoot } from '../ui';
import './tutorial.css';

const HEADLESS_ELEMENT = {} as HTMLElement;

/** What the dialog buttons do. */
export interface TutorialDialogActions {
  /** Continue (the runner's `ack()`). */
  ack(): void;
  /** End tutorial (the runner's `end()`). */
  end(): void;
}

/**
 * The prompt of an ack step (welcome, done): a pausing Menu, id `tutorial-dialog`. `sync` opens it once per step index and
 * closes it otherwise. Continue closes it at once, because the paused simulation applies the queued ack only after the
 * menu is gone. Enter and Escape = Continue (a stray Escape never ends the tutorial).
 */
export class TutorialDialog implements Menu {
  readonly id = 'tutorial-dialog' as const;
  readonly element: HTMLElement;
  readonly pausesGame = true as const;

  private readonly ui: UIRoot | null;
  private readonly actions: TutorialDialogActions;
  private readonly titleEl: HTMLElement | null;
  private readonly textEl: HTMLElement | null;
  private openFlag = false;
  private shownIndex = -1;
  private shownScript = '';
  private titleText = '';
  private bodyText = '';

  constructor(ui: UIRoot | null, actions: TutorialDialogActions) {
    this.ui = ui;
    this.actions = actions;
    if (ui === null || typeof document === 'undefined') {
      this.element = HEADLESS_ELEMENT;
      this.titleEl = null;
      this.textEl = null;
      return;
    }
    this.titleEl = el('h2', { class: 'tut-title' });
    this.textEl = el('p', { class: 'tut-text' });
    this.element = el(
      'div',
      { class: 'panel tut-dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Guided first shift' },
      this.titleEl,
      this.textEl,
      el(
        'div',
        { class: 'tut-actions' },
        el('button', { onclick: () => this.endTutorial() }, 'End tutorial'),
        el('button', { class: 'primary', autofocus: true, onclick: () => this.proceed() }, 'Continue'),
      ),
    );
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  /** The title and text last shown (headless-friendly). */
  get content(): { title: string; text: string } {
    return { title: this.titleText, text: this.bodyText };
  }

  /** Opens for an ack step (once per step index), closes when the view is anything else. */
  sync(view: TutorialView, labelOf: (actionId: string) => string): void {
    const step = view.step;
    if (!view.active || step === null || !step.ack) {
      this.close();
      this.shownIndex = -1; // a later ack step (or a restarted tutorial) opens again
      return;
    }
    if (this.openFlag) {
      if (this.shownIndex === view.index && this.shownScript === view.scriptId) return;
      this.close();
    }
    if (this.shownIndex === view.index && this.shownScript === view.scriptId) return; // already answered: wait for the runner
    this.shownIndex = view.index;
    this.shownScript = view.scriptId;
    this.titleText = step.title;
    this.bodyText = formatTutorialText(step.text, labelOf);
    if (this.titleEl && this.textEl) {
      this.titleEl.textContent = this.titleText;
      this.textEl.textContent = this.bodyText;
    }
    this.openFlag = true;
    this.ui?.push(this);
  }

  /** Continue: closes the dialog and queues the ack. */
  proceed(): void {
    if (!this.openFlag) return;
    this.close();
    this.actions.ack();
  }

  /** End tutorial: closes the dialog and queues the end. */
  endTutorial(): void {
    if (!this.openFlag) return;
    this.close();
    this.actions.end();
  }

  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  onHide(): void {
    this.openFlag = this.openFlag && (this.ui?.isOpen(this) ?? false);
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.openFlag || event.ctrlKey || event.altKey || event.metaKey) return false;
    if (event.key === 'Escape') {
      if (!event.repeat) this.proceed();
      return true;
    }
    if (event.key === 'Enter') {
      // On a focused button Enter clicks that button (End tutorial stays reachable by keyboard).
      const tag = (event.target as { tagName?: string } | null)?.tagName;
      if (typeof tag === 'string' && tag.toLowerCase() === 'button') return false;
      if (!event.repeat) this.proceed();
      return true;
    }
    return false;
  }

  dispose(): void {
    this.close();
    if (this.element !== HEADLESS_ELEMENT) this.element.remove();
  }
}
