import { createRng } from '../../core/rng';
import { CAREER_CONFIG, LEGAL_QUIZ, drawQuiz, gradeQuiz, type CareerRank, type QuizLevel, type QuizQuestion } from '../../career';
import { div, setText } from '../panels/dom';
import { clearChildren, el } from '../ui';
import type { UIRoot } from '../ui';
import './career.css';
import { HEADLESS_ELEMENT, canBuildDom, type MinigameScreen } from './types';

export type QuizPhase = 'question' | 'explain' | 'done';

/** The quiz level of a promotion exam: sergeant / lieutenant / captain have their own question sets, the rest use the academy set. */
export function examLevelFor(rank: CareerRank): QuizLevel {
  return rank === 'sergeant' ? 'sergeant' : rank === 'lieutenant' ? 'lieutenant' : rank === 'captain' ? 'captain' : 'academy';
}

/**
 * The legal quiz as a state machine: `drawQuiz(level, n, rng)` ids, one question at a time with 4 options, an
 * explanation after each answer, `gradeQuiz` at the end.
 */
export class QuizRun {
  readonly ids: string[];
  readonly answers: number[] = [];
  index = 0;
  phase: QuizPhase = 'question';
  score: number | null = null;
  correct = 0;

  private readonly questions: readonly QuizQuestion[];

  constructor(
    seed: number, streamKey: string, level: QuizLevel,
    n: number = CAREER_CONFIG.academy.quizQuestions,
    questions: readonly QuizQuestion[] = LEGAL_QUIZ,
  ) {
    this.questions = questions;
    this.ids = drawQuiz(level, n, createRng(seed).stream(streamKey), questions);
    if (this.ids.length === 0) this.finish();
  }

  get total(): number {
    return this.ids.length;
  }

  get done(): boolean {
    return this.phase === 'done';
  }

  get question(): QuizQuestion | null {
    const id = this.ids[this.index];
    return id === undefined ? null : (this.questions.find((q) => q.id === id) ?? null);
  }

  /** Answers with option 0..3; false when not asking or out of range. */
  answer(option: number): boolean {
    if (this.phase !== 'question' || !Number.isInteger(option) || option < 0 || option > 3) return false;
    this.answers[this.index] = option;
    this.phase = 'explain';
    return true;
  }

  /** Whether the given answer to the current question was right (null before answering). */
  get wasCorrect(): boolean | null {
    const a = this.answers[this.index];
    const q = this.question;
    return a === undefined || q === null ? null : a === q.answer;
  }

  /** Leaves the explanation: the next question, or the result. */
  next(): boolean {
    if (this.phase !== 'explain') return false;
    this.index++;
    if (this.index >= this.ids.length) this.finish();
    else this.phase = 'question';
    return true;
  }

  private finish(): void {
    this.phase = 'done';
    const graded = gradeQuiz(this.ids, this.answers, this.questions);
    this.score = graded.score;
    this.correct = graded.correct;
  }
}

export type LegalQuizOptions =
  | {
      /** Academy module: the score goes to `onScore` (the host submits 'legal'). */
      readonly mode: 'academy'; readonly seed: number; readonly attempt: number;
      readonly onScore: (score: number) => void; readonly onExit: () => void;
    }
  | {
      /** Promotion exam: `level` picks the question set, the score goes to `done`. */
      readonly mode: 'exam'; readonly level: QuizLevel; readonly seed: number; readonly attempt: number;
      readonly questions?: number;
      readonly onScore: (score: number) => void; readonly onExit: () => void;
    };

interface QuizDom {
  readonly root: HTMLDivElement;
  readonly title: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly hint: HTMLDivElement;
}

/**
 * Legal quiz screen (pausing Menu, id 'legal-quiz'), modes `academy` and `exam`. Keys 1-4 answer, Enter continues,
 * Escape leaves without a score.
 */
export class LegalQuizScreen implements MinigameScreen {
  readonly id = 'legal-quiz' as const;
  readonly element: HTMLElement;
  readonly pausesGame = true as const;

  private readonly dom: QuizDom | null;
  private run: QuizRun;
  private openFlag = false;
  private reported = false;

  private readonly ui: UIRoot | null;
  private readonly opts: LegalQuizOptions;

  constructor(ui: UIRoot | null, opts: LegalQuizOptions) {
    this.ui = ui;
    this.opts = opts;
    this.run = this.newRun();
    this.dom = canBuildDom(ui) ? this.build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  get state(): QuizRun {
    return this.run;
  }

  get mode(): 'academy' | 'exam' {
    return this.opts.mode;
  }

  open(): void {
    this.run = this.newRun();
    this.reported = false;
    this.openFlag = true;
    this.render();
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
  }

  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  exit(): void {
    this.close();
    this.opts.onExit();
  }

  onHide(): void {
    this.openFlag = this.openFlag && (this.ui?.isOpen(this) ?? false);
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.openFlag || event.ctrlKey || event.altKey || event.metaKey) return false;
    return this.press(event.key, event.repeat);
  }

  press(key: string, repeat = false): boolean {
    if (key === 'Escape') {
      this.exit();
      return true;
    }
    const digit = /^(?:Digit|Numpad)?([1-4])$/.exec(key);
    if (digit) {
      if (!repeat) this.answer(Number(digit[1]) - 1);
      return true;
    }
    if (key === 'Enter') {
      if (!repeat) this.advance();
      return true;
    }
    return false;
  }

  answer(option: number): void {
    if (this.run.answer(option)) this.render();
  }

  /** Continue: next question, the result, or leave after the result. */
  advance(): void {
    const run = this.run;
    if (run.phase === 'done') {
      this.exit();
      return;
    }
    if (!run.next()) return;
    if (run.done && !this.reported) {
      this.reported = true;
      this.opts.onScore(run.score ?? 0);
    }
    this.render();
  }

  dispose(): void {
    this.close();
    this.dom?.root.remove();
  }

  private newRun(): QuizRun {
    const o = this.opts;
    return o.mode === 'academy'
      ? new QuizRun(o.seed, `academy:legal:${o.attempt}`, 'academy')
      : new QuizRun(o.seed, `exam:${o.level}:${o.attempt}`, o.level, o.questions ?? CAREER_CONFIG.academy.quizQuestions);
  }

  private render(): void {
    const dom = this.dom;
    if (!dom) return;
    const run = this.run;
    clearChildren(dom.body);
    const exam = this.opts.mode === 'exam';
    if (run.phase === 'done') {
      setText(dom.title, exam ? 'Promotion exam: result' : 'Legal quiz: result');
      dom.body.append(
        el('div', { class: 'cr-result-score' }, `Score ${String(run.score ?? 0)}`),
        el('div', { class: 'cr-result-detail' }, `${String(run.correct)} of ${String(run.total)} correct`),
        el('button', { type: 'button', class: 'cr-btn cr-primary', onclick: () => { this.advance(); } }, 'Continue'),
      );
      setText(dom.hint, 'Enter to continue');
      return;
    }
    const q = run.question;
    setText(dom.title, `${exam ? 'Promotion exam' : 'Legal quiz'} · question ${String(run.index + 1)} / ${String(run.total)}`);
    if (!q) return;
    dom.body.appendChild(el('div', { class: 'cr-topic' }, q.topic));
    dom.body.appendChild(el('div', { class: 'cr-question' }, q.q));
    const explain = run.phase === 'explain';
    const list = el('div', { class: 'cr-options', role: 'group', 'aria-label': 'Answers' });
    q.options.forEach((text, i) => {
      const picked = run.answers[run.index] === i;
      const cls = `cr-btn cr-option${picked ? ' cr-picked' : ''}${explain && i === q.answer ? ' cr-best' : ''}${explain && picked && i !== q.answer ? ' cr-wrong' : ''}`;
      list.appendChild(el('button', { type: 'button', class: cls, disabled: explain, onclick: () => { this.answer(i); } }, `${String(i + 1)}  ${text}`));
    });
    dom.body.appendChild(list);
    if (explain) {
      dom.body.appendChild(el('div', { class: `cr-feedback ${run.wasCorrect === true ? 'cr-fb-correct' : 'cr-fb-wrong'}`, role: 'status' },
        el('strong', null, run.wasCorrect === true ? 'Correct. ' : 'Not quite. '), q.explain));
      dom.body.appendChild(el('button', { type: 'button', class: 'cr-btn cr-primary', onclick: () => { this.advance(); } }, run.index + 1 >= run.total ? 'Finish (Enter)' : 'Next question (Enter)'));
      setText(dom.hint, 'Enter continues · Esc leaves without a score');
    } else {
      setText(dom.hint, '1-4 choose an answer · Esc leaves without a score');
    }
  }

  private build(): QuizDom {
    const root = div('cr-panel cr-quiz');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Legal quiz');
    const title = div('cr-title', root);
    const body = div('cr-body', root);
    body.setAttribute('aria-live', 'polite');
    const hint = div('cr-hint', root);
    return { root, title, body, hint };
  }
}
