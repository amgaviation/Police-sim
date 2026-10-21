import { createRng } from '../../core/rng';
import { CAREER_CONFIG, REPORT_EXERCISES, gradeReportExercise, type ReportExercise, type ReportStatement } from '../../career';
import { div, setText } from '../panels/dom';
import { clearChildren, el } from '../ui';
import type { UIRoot } from '../ui';
import './career.css';
import { HEADLESS_ELEMENT, canBuildDom, type MinigameOptions, type MinigameScreen } from './types';

/** The exercise for an attempt: round robin over the shipped exercises (`attempt` is the module's attempts so far). */
export function exerciseForAttempt(attempt: number, exercises: readonly ReportExercise[] = REPORT_EXERCISES): ReportExercise | null {
  if (exercises.length === 0) return null;
  const i = ((Math.floor(attempt) % exercises.length) + exercises.length) % exercises.length;
  return exercises[i] ?? null;
}

export interface ReportFeedback {
  score: number;
  /** Key statements the officer left out (text). */
  missing: string[];
  /** Untrue statements the officer ticked (text). */
  falseSelected: string[];
}

/**
 * The report-writing exercise as a state machine (design §11.1): the narrative, the statements in a seeded order, a set
 * of ticked ids, `submit()` grades with `gradeReportExercise` and lists what is missing and what is false.
 */
export class ReportRun {
  readonly exercise: ReportExercise;
  /** Statement ids in display order (seeded shuffle of the exercise's statements). */
  readonly order: string[];
  private readonly picked = new Set<string>();
  private final: ReportFeedback | null = null;

  readonly attempt: number;

  constructor(seed: number, attempt: number, exercises: readonly ReportExercise[] = REPORT_EXERCISES) {
    this.attempt = attempt;
    const exercise = exerciseForAttempt(attempt, exercises);
    if (exercise === null) throw new RangeError('ReportRun: no report exercises');
    this.exercise = exercise;
    const ids = exercise.statements.map((s) => s.id);
    createRng(seed).stream(`academy:report:${attempt}`).shuffle(ids);
    this.order = ids;
  }

  get submitted(): boolean {
    return this.final !== null;
  }

  get feedback(): ReportFeedback | null {
    return this.final;
  }

  /** Statements in display order. */
  statements(): ReportStatement[] {
    const out: ReportStatement[] = [];
    for (const id of this.order) {
      const s = this.exercise.statements.find((x) => x.id === id);
      if (s) out.push(s);
    }
    return out;
  }

  isPicked(id: string): boolean {
    return this.picked.has(id);
  }

  get selected(): string[] {
    return this.order.filter((id) => this.picked.has(id));
  }

  /** Ticks or unticks a statement; ignored after submitting or for an unknown id. */
  toggle(id: string): boolean {
    if (this.final !== null || !this.order.includes(id)) return false;
    if (this.picked.has(id)) this.picked.delete(id);
    else this.picked.add(id);
    return true;
  }

  /** Grades the ticks. Returns the feedback (the same object on repeated calls). */
  submit(): ReportFeedback {
    if (this.final !== null) return this.final;
    const graded = gradeReportExercise(this.exercise.id, this.selected, [this.exercise]);
    const text = (id: string): string => this.exercise.statements.find((s) => s.id === id)?.text ?? id;
    this.final = { score: graded.score, missing: graded.missing.map(text), falseSelected: graded.falseSelected.map(text) };
    return this.final;
  }
}

interface ReportDom {
  readonly root: HTMLDivElement;
  readonly title: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly hint: HTMLDivElement;
}

/**
 * Report writing exercise (pausing Menu, id 'report-exercise'): a narrative, statement checkboxes, Submit. Used by the
 * academy hub and, with `standaloneAcademyHost`, as the report-writing-only mode. Escape leaves (nothing is submitted
 * unless the report was already graded).
 */
export class ReportExerciseScreen implements MinigameScreen {
  readonly id = 'report-exercise' as const;
  readonly element: HTMLElement;
  readonly pausesGame = true as const;

  private readonly dom: ReportDom | null;
  private run: ReportRun;
  private openFlag = false;
  private reported = false;

  private readonly ui: UIRoot | null;
  private readonly opts: MinigameOptions;

  constructor(ui: UIRoot | null, opts: MinigameOptions) {
    this.ui = ui;
    this.opts = opts;
    this.run = new ReportRun(opts.seed, opts.attempt);
    this.dom = canBuildDom(ui) ? this.build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  get state(): ReportRun {
    return this.run;
  }

  open(): void {
    this.run = new ReportRun(this.opts.seed, this.opts.attempt);
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
    if (event.key === 'Escape') {
      this.exit();
      return true;
    }
    return false;
  }

  /** Ticks a statement (checkbox). */
  toggle(id: string): void {
    if (this.run.toggle(id)) this.render();
  }

  /** Grades the report and hands the score to the host once. */
  submit(): ReportFeedback {
    const feedback = this.run.submit();
    if (!this.reported) {
      this.reported = true;
      this.opts.onScore(feedback.score);
    }
    this.render();
    return feedback;
  }

  dispose(): void {
    this.close();
    this.dom?.root.remove();
  }

  private render(): void {
    const dom = this.dom;
    if (!dom) return;
    const run = this.run;
    setText(dom.title, `Report writing: ${run.exercise.title}`);
    clearChildren(dom.body);
    dom.body.appendChild(el('div', { class: 'cr-narrative' }, run.exercise.narrative.map((p) => el('p', null, p))));
    dom.body.appendChild(el('div', { class: 'cr-heading' }, 'Tick the statements your report can state as fact'));
    const list = el('div', { class: 'cr-statements', role: 'group', 'aria-label': 'Statements' });
    const feedback = run.feedback;
    for (const s of run.statements()) {
      const id = `cr-st-${s.id}`;
      const box = el('input', { type: 'checkbox', id, checked: run.isPicked(s.id) || null, disabled: feedback !== null, onchange: () => { this.toggle(s.id); } });
      box.checked = run.isPicked(s.id);
      list.appendChild(el('label', { class: 'cr-statement', for: id }, box, ' ', s.text));
    }
    dom.body.appendChild(list);
    if (feedback === null) {
      dom.body.appendChild(el('button', { type: 'button', class: 'cr-btn cr-primary', onclick: () => { this.submit(); } }, 'Submit report'));
      setText(dom.hint, 'Space ticks a statement · Esc leaves without submitting');
      return;
    }
    const pass = CAREER_CONFIG.academy.pass.report;
    dom.body.appendChild(el('div', { class: 'cr-result' },
      el('div', { class: 'cr-result-score' }, `Score ${String(feedback.score)}`),
      el('div', { class: 'cr-result-detail' }, `Pass mark ${String(pass)} · ${feedback.score >= pass ? 'PASSED' : 'not passed'}`),
      feedback.missing.length > 0 ? el('div', { class: 'cr-missing' }, el('strong', null, 'Missing from your report'), el('ul', null, feedback.missing.map((t) => el('li', null, t)))) : null,
      feedback.falseSelected.length > 0 ? el('div', { class: 'cr-false' }, el('strong', null, 'Not supported by the facts'), el('ul', null, feedback.falseSelected.map((t) => el('li', null, t)))) : null,
      el('button', { type: 'button', class: 'cr-btn cr-primary', onclick: () => { this.exit(); } }, 'Continue'),
    ));
    setText(dom.hint, 'Esc or Continue to leave');
  }

  private build(): ReportDom {
    const root = div('cr-panel cr-report');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Report writing exercise');
    const title = div('cr-title', root);
    const body = div('cr-body', root);
    body.setAttribute('aria-live', 'polite');
    const hint = div('cr-hint', root);
    return { root, title, body, hint };
  }
}
