import './court.css';
import type { Answer, CourtCase } from '../../court/types';
import { div, setClass, setText } from '../panels/dom';
import type { Menu, UIRoot } from '../ui';

/** The bench the hearing takes place at (generic wording, no real court). */
export const COURT_NAME = 'Superior Court — Department 3';

/** What the panel shows. Built from a `CourtCase` by `courtroomViewOf`, which keeps the cross-examination's truth hidden. */
export interface CourtroomView {
  caseId: string;
  /** Defendant line, e.g. 'Defendant: DOE, JANE'. */
  title: string;
  motions: readonly { text: string; granted: boolean }[];
  questions: readonly { id: string; text: string }[];
}

export type CourtroomPhase = 'motions' | 'questions' | 'review';

export interface CourtroomState {
  phase: CourtroomPhase;
  /** Question being answered (`questions` phase); the last one in `review`. */
  index: number;
  answers: (Answer | null)[];
}

export type CourtroomEmit = { kind: 'submit'; answers: Answer[] } | { kind: 'close' };

export interface CourtroomKeyResult {
  state: CourtroomState;
  emit: CourtroomEmit | null;
  consumed: boolean;
}

/** Display text of an answer. */
export const ANSWER_LABELS: Readonly<Record<Answer, string>> = { yes: 'Yes', no: 'No', dontRecall: "Don't recall" };

const ANSWER_KEYS: Readonly<Record<string, Answer>> = { '1': 'yes', '2': 'no', '3': 'dontRecall' };

/** The view of a case about to be heard: the judge's rulings and the question texts only (no truth, report line or camera flag). */
export function courtroomViewOf(c: Pick<CourtCase, 'id' | 'personLabel' | 'motions' | 'questions'>): CourtroomView {
  return {
    caseId: c.id,
    title: c.personLabel === '' ? 'Defendant unknown' : `Defendant: ${c.personLabel}`,
    motions: c.motions.map((m) => ({ text: m.text, granted: m.granted })),
    questions: c.questions.map((q) => ({ id: q.id, text: q.text })),
  };
}

/** A fresh state at the rulings, nothing answered. */
export function createCourtroomState(view: CourtroomView): CourtroomState {
  return { phase: 'motions', index: 0, answers: new Array<Answer | null>(view.questions.length).fill(null) };
}

/** "Digit1" / "Numpad2" -> "1" / "2"; other keys unchanged. */
function plainKey(key: string): string {
  const m = /^(?:Digit|Numpad)([0-9])$/.exec(key);
  return m ? (m[1] as string) : key;
}

/** Index of the first unanswered question, -1 when all are answered. */
export function firstUnanswered(answers: readonly (Answer | null)[]): number {
  return answers.indexOf(null);
}

/**
 * Pure key reducer of the courtroom. Rulings: Enter starts the testimony, Escape leaves (the only place it does).
 * Questions: 1 yes, 2 no, 3 don't recall (then the next question; after the last one the review), Enter keeps an
 * answer already given, Backspace goes to the previous question. Review: Enter submits (or returns to an unanswered
 * question), Backspace goes back. Once the testimony has begun Escape is consumed and does nothing: it must be
 * finished. Keys it does not use are not consumed.
 */
export function reduceCourtKey(s: CourtroomState, view: CourtroomView, key: string): CourtroomKeyResult {
  const k = plainKey(key);
  const idle = (consumed: boolean): CourtroomKeyResult => ({ state: s, emit: null, consumed });
  const n = view.questions.length;
  const go = (state: CourtroomState): CourtroomKeyResult => ({ state, emit: null, consumed: true });
  switch (s.phase) {
    case 'motions':
      if (k === 'Enter') return go(n === 0 ? { ...s, phase: 'review', index: 0 } : { ...s, phase: 'questions', index: 0 });
      if (k === 'Escape') return { state: s, emit: { kind: 'close' }, consumed: true };
      return idle(false);
    case 'questions': {
      const answer = ANSWER_KEYS[k];
      if (answer !== undefined || (k === 'Enter' && s.answers[s.index] != null)) {
        const answers = s.answers.slice();
        if (answer !== undefined) answers[s.index] = answer;
        return go(s.index + 1 >= n ? { phase: 'review', index: Math.max(0, n - 1), answers } : { phase: 'questions', index: s.index + 1, answers });
      }
      if (k === 'Backspace') return s.index > 0 ? go({ ...s, index: s.index - 1 }) : idle(true);
      return idle(k === 'Escape' || k === 'Enter');
    }
    case 'review': {
      if (k === 'Enter') {
        const open = firstUnanswered(s.answers);
        if (open >= 0) return go({ ...s, phase: 'questions', index: open });
        return { state: s, emit: { kind: 'submit', answers: s.answers.filter((a): a is Answer => a !== null) }, consumed: true };
      }
      if (k === 'Backspace') return n > 0 ? go({ ...s, phase: 'questions', index: n - 1 }) : idle(true);
      return idle(k === 'Escape');
    }
  }
}

interface CourtDom {
  readonly root: HTMLDivElement;
  readonly bench: HTMLDivElement;
  readonly caseLine: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly progress: HTMLDivElement;
  readonly hint: HTMLDivElement;
}

const HEADLESS_ELEMENT = {} as HTMLElement;

const HINTS: Readonly<Record<CourtroomPhase, string>> = {
  motions: 'Enter begin testimony · Esc leave the courtroom',
  questions: '1 Yes · 2 No · 3 Don\'t recall · Backspace previous question',
  review: 'Enter submit testimony · Backspace go back',
};

/**
 * The courtroom (design phase 5 §12.2): a pausing `Menu` that shows the judge's rulings on the motions, then the
 * cross-examination one question at a time, then a review of the answers. Keys go through `reduceCourtKey`. On submit
 * the panel closes itself and calls `onSubmit(caseId, answers)` (the app turns it into a court `testify` request).
 * Headless (no `document` or no `UIRoot`) it keeps the state machine and key handling but builds no DOM.
 */
export class CourtroomPanel implements Menu {
  readonly id = 'courtroom' as const;
  readonly element: HTMLElement;
  readonly pausesGame = true as const;

  private readonly ui: UIRoot | null;
  private readonly onSubmit: (caseId: string, answers: readonly Answer[]) => void;
  private readonly dom: CourtDom | null;
  private shown: CourtroomView | null = null;
  private st: CourtroomState = { phase: 'motions', index: 0, answers: [] };
  private openFlag = false;
  private renderedKey = '';

  constructor(ui: UIRoot | null, onSubmit: (caseId: string, answers: readonly Answer[]) => void) {
    this.ui = ui;
    this.onSubmit = onSubmit;
    this.dom = ui !== null && typeof document !== 'undefined' ? this.build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  get state(): CourtroomState {
    return this.st;
  }

  get view(): CourtroomView | null {
    return this.shown;
  }

  /** Escape may leave the courtroom only before the testimony has begun (the app's own Escape handling should check this). */
  get canLeave(): boolean {
    return this.openFlag && this.st.phase === 'motions';
  }

  /** Opens the hearing at the rulings (an open hearing is replaced). */
  open(view: CourtroomView): void {
    this.shown = view;
    this.st = createCourtroomState(view);
    this.openFlag = true;
    this.renderedKey = '';
    this.render();
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
  }

  /** Closes the panel without submitting. */
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
    return this.press(event.key, event.repeat);
  }

  /** Applies a key as the keyboard would (also used by the on-screen buttons); true when it was consumed. */
  press(key: string, repeat = false): boolean {
    const view = this.shown;
    if (!this.openFlag || !view) return false;
    const result = reduceCourtKey(this.st, view, key);
    // Holding a key must not answer several questions.
    if (repeat) return result.consumed;
    this.st = result.state;
    const emit = result.emit;
    if (emit?.kind === 'close') {
      this.close();
      return true;
    }
    if (emit?.kind === 'submit') {
      const caseId = view.caseId;
      this.close();
      this.onSubmit(caseId, emit.answers);
      return true;
    }
    this.render();
    return result.consumed;
  }

  dispose(): void {
    this.close();
    this.dom?.root.remove();
  }

  // --- DOM ----------------------------------------------------------------------------------------

  private render(): void {
    const dom = this.dom;
    const view = this.shown;
    if (!dom || !view) return;
    const st = this.st;
    // Rebuilt only when what is shown changes (a page or a question), never per frame.
    const key = `${view.caseId}|${st.phase}|${String(st.index)}|${st.answers.map((a) => a ?? '-').join(',')}`;
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    setText(dom.bench, COURT_NAME);
    setText(dom.caseLine, `${view.caseId} · ${view.title}`);
    setText(dom.hint, HINTS[st.phase]);
    while (dom.body.firstChild) dom.body.removeChild(dom.body.firstChild);
    switch (st.phase) {
      case 'motions':
        this.renderMotions(dom.body, view);
        break;
      case 'questions':
        this.renderQuestion(dom.body, view, st);
        break;
      case 'review':
        this.renderReview(dom.body, view, st);
        break;
    }
    this.renderProgress(dom.progress, view, st);
  }

  private renderMotions(body: HTMLElement, view: CourtroomView): void {
    div('crt-heading', body).textContent = 'The court rules on the motions';
    const list = div('crt-motions', body);
    if (view.motions.length === 0) div('crt-empty', list).textContent = 'No motions were argued.';
    for (const m of view.motions) {
      const row = div(m.granted ? 'crt-motion crt-granted' : 'crt-motion crt-denied', list);
      div('crt-badge', row).textContent = m.granted ? 'GRANTED' : 'DENIED';
      div('crt-motion-text', row).textContent = m.text;
    }
    const actions = div('crt-actions', body);
    this.action(actions, view.questions.length > 0 ? 'Begin testimony (Enter)' : 'Continue (Enter)', 'Enter', true);
    this.action(actions, 'Leave (Esc)', 'Escape', false);
  }

  private renderQuestion(body: HTMLElement, view: CourtroomView, st: CourtroomState): void {
    const q = view.questions[st.index];
    div('crt-qcount', body).textContent = `Q ${String(st.index + 1)} / ${String(view.questions.length)}`;
    div('crt-question', body).textContent = q?.text ?? '';
    const given = st.answers[st.index] ?? null;
    const actions = div('crt-actions crt-answers', body);
    (['yes', 'no', 'dontRecall'] as const).forEach((a, i) => {
      this.action(actions, `${String(i + 1)}  ${ANSWER_LABELS[a]}`, String(i + 1), given === a);
    });
    if (st.index > 0) this.action(div('crt-actions', body), 'Previous (Backspace)', 'Backspace', false);
  }

  private renderReview(body: HTMLElement, view: CourtroomView, st: CourtroomState): void {
    div('crt-heading', body).textContent = 'Review your testimony';
    const list = div('crt-review', body);
    view.questions.forEach((q, i) => {
      const row = div('crt-review-row', list);
      div('crt-review-q', row).textContent = `${String(i + 1)}. ${q.text}`;
      const a = st.answers[i] ?? null;
      div(a === null ? 'crt-review-a crt-unanswered' : 'crt-review-a', row).textContent = a === null ? 'unanswered' : ANSWER_LABELS[a];
    });
    if (view.questions.length === 0) div('crt-empty', list).textContent = 'The prosecution has no questions for you.';
    const actions = div('crt-actions', body);
    this.action(actions, 'Submit testimony (Enter)', 'Enter', true);
    if (view.questions.length > 0) this.action(actions, 'Back (Backspace)', 'Backspace', false);
  }

  private renderProgress(strip: HTMLElement, view: CourtroomView, st: CourtroomState): void {
    while (strip.firstChild) strip.removeChild(strip.firstChild);
    view.questions.forEach((_, i) => {
      const done = st.answers[i] != null;
      const current = st.phase === 'questions' && i === st.index;
      div(current ? 'crt-step crt-step-current' : done ? 'crt-step crt-step-done' : 'crt-step', strip);
    });
  }

  private action(parent: HTMLElement, label: string, key: string, primary: boolean): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    setClass(b, primary ? 'crt-btn crt-primary' : 'crt-btn');
    b.textContent = label;
    b.addEventListener('click', () => this.press(key));
    parent.appendChild(b);
    return b;
  }

  private build(): CourtDom {
    const root = div('crt-panel');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Courtroom');
    const head = div('crt-head', root);
    const bench = div('crt-bench', head);
    const caseLine = div('crt-case', head);
    const body = div('crt-body', root);
    body.setAttribute('aria-live', 'polite');
    const progress = div('crt-progress', root);
    const hint = div('crt-hint', root);
    return { root, bench, caseLine, body, progress, hint };
  }
}
