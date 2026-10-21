import type { TutorialView } from '../../tutorial/runner';
import { formatTutorialText } from '../../tutorial/format';
import { el } from '../ui';
import './tutorial.css';

/** What the card shows (kept headless too, for tests). */
export interface TutorialCardModel {
  readonly visible: boolean;
  readonly title: string;
  readonly text: string;
  readonly hint: string;
  /** 'Step 3 of 14'. */
  readonly progress: string;
}

const EMPTY_MODEL: TutorialCardModel = { visible: false, title: '', text: '', hint: '', progress: '' };

/**
 * The tutorial prompt in the HUD (not a Menu): never takes input, `role="status"` with `aria-live="polite"`. Rebuilt only
 * when the view's revision (or script) changes; hidden when there is no tutorial or the step is an ack step (the dialog
 * shows those). Headless (no parent or no `document`) it builds no DOM but keeps the model.
 */
export class TutorialCard {
  readonly element: HTMLElement | null;
  private readonly titleEl: HTMLElement | null;
  private readonly textEl: HTMLElement | null;
  private readonly hintEl: HTMLElement | null;
  private readonly stepEl: HTMLElement | null;
  private revision = -2;
  private scriptId = '';
  private current: TutorialCardModel = EMPTY_MODEL;

  constructor(hudParent: HTMLElement | null) {
    if (hudParent === null || typeof document === 'undefined') {
      this.element = null;
      this.titleEl = null;
      this.textEl = null;
      this.hintEl = null;
      this.stepEl = null;
      return;
    }
    this.titleEl = el('div', { class: 'tut-title' });
    this.textEl = el('div', { class: 'tut-text' });
    this.hintEl = el('div', { class: 'tut-hint' });
    this.stepEl = el('div', { class: 'tut-step' });
    this.element = el(
      'div',
      { class: 'tut-card', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', hidden: true },
      this.titleEl,
      this.textEl,
      this.hintEl,
      this.stepEl,
    );
    hudParent.appendChild(this.element);
  }

  /** The text last built. */
  get model(): TutorialCardModel {
    return this.current;
  }

  get visible(): boolean {
    return this.current.visible;
  }

  /** Rebuilds only when `view.revision` or the script changed. */
  update(view: TutorialView, labelOf: (actionId: string) => string): void {
    if (view.revision === this.revision && view.scriptId === this.scriptId) return;
    this.revision = view.revision;
    this.scriptId = view.scriptId;
    const step = view.step;
    if (!view.active || step === null || step.ack) {
      this.current = EMPTY_MODEL;
    } else {
      this.current = {
        visible: true,
        title: step.title,
        text: formatTutorialText(step.text, labelOf),
        hint: formatTutorialText(step.hint, labelOf),
        progress: `Step ${String(view.index + 1)} of ${String(view.count)}`,
      };
    }
    this.apply();
  }

  dispose(): void {
    this.element?.remove();
    this.current = EMPTY_MODEL;
  }

  private apply(): void {
    const m = this.current;
    if (this.element === null || this.titleEl === null || this.textEl === null || this.hintEl === null || this.stepEl === null) return;
    this.element.hidden = !m.visible;
    this.titleEl.textContent = m.title;
    this.textEl.textContent = m.text;
    this.hintEl.textContent = m.hint;
    this.hintEl.hidden = m.hint === '';
    this.stepEl.textContent = m.progress;
  }
}
