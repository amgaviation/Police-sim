import { createRng } from '../../core/rng';
import { CAREER_CONFIG, DEFENSIVE_DRILLS, DEFENSIVE_TIME_LIMIT_S, gradeDefensive, type DefensiveDrill, type DrillGrade } from '../../career';
import { clearChildren, el } from '../ui';
import { div, setText } from '../panels/dom';
import type { UIRoot } from '../ui';
import './career.css';
import { HEADLESS_ELEMENT, canBuildDom, type MinigameOptions, type MinigameScreen } from './types';

/** Drills per attempt. */
export const DRILLS_PER_ATTEMPT = 8;

export type DefensivePhase = 'question' | 'feedback' | 'done';

/** Feedback wording per grade; -1 is the timeout. */
export function gradeLabel(grade: DrillGrade | 'timeout'): string {
  switch (grade) {
    case 'correct': return 'Correct: this is the appropriate response';
    case 'partial': return 'Acceptable, but not the best response';
    case 'wrong': return 'Not appropriate for this level of resistance';
    case 'timeout': return 'Time expired: no response';
  }
}

/**
 * The defensive-tactics drill as a state machine: `DRILLS_PER_ATTEMPT` drills drawn with
 * `createRng(seed).stream('academy:defensive:<attempt>')`, a time bar of `timeLimitS` per drill (timeout = pick -1),
 * feedback after each, `gradeDefensive` at the end. The clock only runs in the 'question' phase.
 */
export class DefensiveRun {
  readonly ids: string[];
  readonly picks: number[] = [];
  index = 0;
  phase: DefensivePhase = 'question';
  elapsedS = 0;
  score: number | null = null;

  readonly timeLimitS: number;
  private readonly drills: readonly DefensiveDrill[];

  constructor(
    seed: number,
    attempt: number,
    drills: readonly DefensiveDrill[] = DEFENSIVE_DRILLS,
    timeLimitS: number = DEFENSIVE_TIME_LIMIT_S,
    count: number = DRILLS_PER_ATTEMPT,
  ) {
    this.drills = drills;
    this.timeLimitS = timeLimitS;
    const rng = createRng(seed).stream(`academy:defensive:${attempt}`);
    const all = drills.map((d) => d.id);
    rng.shuffle(all);
    this.ids = all.slice(0, Math.max(0, Math.min(count, all.length)));
    if (this.ids.length === 0) this.finish();
  }

  get total(): number {
    return this.ids.length;
  }

  /** The drill being asked (or just answered); null once done. */
  get drill(): DefensiveDrill | null {
    const id = this.ids[this.index];
    return id === undefined ? null : (this.drills.find((d) => d.id === id) ?? null);
  }

  /** Seconds left on the current drill. */
  get remainingS(): number {
    return this.phase === 'question' ? Math.max(0, this.timeLimitS - this.elapsedS) : 0;
  }

  /** 0..1 of the time bar left. */
  get fraction(): number {
    return this.timeLimitS > 0 ? this.remainingS / this.timeLimitS : 0;
  }

  /** The pick of the current drill (-1 = timeout); undefined before it is answered. */
  get lastPick(): number | undefined {
    return this.picks[this.index];
  }

  /** Grade of the answered drill ('timeout' for -1); null while asking. */
  get lastGrade(): DrillGrade | 'timeout' | null {
    if (this.phase !== 'feedback') return null;
    const pick = this.picks[this.index];
    if (pick === undefined) return null;
    if (pick < 0) return 'timeout';
    return this.drill?.options[pick]?.grade ?? 'wrong';
  }

  /** Index of the best option of the current drill (the first 'correct'), -1 when none. */
  get bestOption(): number {
    return this.drill?.options.findIndex((o) => o.grade === 'correct') ?? -1;
  }

  /** Answers the current drill with option `option` (0-based); false when not asking or out of range. */
  answer(option: number): boolean {
    if (this.phase !== 'question') return false;
    const d = this.drill;
    if (!d || !Number.isInteger(option) || option < 0 || option >= d.options.length) return false;
    this.picks[this.index] = option;
    this.phase = 'feedback';
    return true;
  }

  /** Advances the clock; at the limit the drill times out (pick -1). Returns true when it timed out. */
  tick(dt: number): boolean {
    if (this.phase !== 'question' || !(dt > 0)) return false;
    this.elapsedS += dt;
    if (this.elapsedS >= this.timeLimitS) {
      this.picks[this.index] = -1;
      this.phase = 'feedback';
      return true;
    }
    return false;
  }

  /** Leaves the feedback: the next drill, or the end with the score. */
  next(): boolean {
    if (this.phase !== 'feedback') return false;
    this.index++;
    this.elapsedS = 0;
    if (this.index >= this.ids.length) this.finish();
    else this.phase = 'question';
    return true;
  }

  private finish(): void {
    this.phase = 'done';
    this.score = gradeDefensive(this.ids, this.picks, this.drills);
  }
}

interface DefensiveDom {
  readonly root: HTMLDivElement;
  readonly title: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly bar: HTMLDivElement;
  readonly barFill: HTMLDivElement;
  readonly hint: HTMLDivElement;
}

/**
 * Defensive tactics drill screen (pausing Menu, id 'defensive'). Keys 1-4 pick an option, Enter continues after the
 * feedback, Escape leaves (the attempt is abandoned and nothing is submitted). The score goes to `onScore` at the end.
 */
export class DefensiveDrillScreen implements MinigameScreen {
  readonly id = 'defensive' as const;
  readonly element: HTMLElement;
  readonly pausesGame = true as const;

  private readonly dom: DefensiveDom | null;
  private run: DefensiveRun;
  private openFlag = false;
  private submitted = false;
  private raf = 0;
  private lastFrame = -1;
  private renderedKey = '';
  private barShown = -1;

  private readonly ui: UIRoot | null;
  private readonly opts: MinigameOptions;

  constructor(ui: UIRoot | null, opts: MinigameOptions) {
    this.ui = ui;
    this.opts = opts;
    this.run = new DefensiveRun(opts.seed, opts.attempt);
    this.dom = canBuildDom(ui) ? this.build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  get state(): DefensiveRun {
    return this.run;
  }

  open(): void {
    this.run = new DefensiveRun(this.opts.seed, this.opts.attempt);
    this.submitted = false;
    this.openFlag = true;
    this.renderedKey = '';
    this.render();
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
    this.startLoop();
  }

  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    this.stopLoop();
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  exit(): void {
    this.close();
    this.opts.onExit();
  }

  onShow(): void {
    this.startLoop();
  }

  onHide(): void {
    this.stopLoop();
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
      if (!repeat) this.pick(Number(digit[1]) - 1);
      return true;
    }
    if (key === 'Enter') {
      if (!repeat) this.advanceScreen();
      return true;
    }
    return false;
  }

  /** Picks option `option` (0-based). */
  pick(option: number): void {
    if (this.run.answer(option)) this.render();
  }

  /** Continues after feedback, or leaves after the result. */
  advanceScreen(): void {
    const run = this.run;
    if (run.phase === 'done') {
      this.exit();
      return;
    }
    if (run.next()) {
      this.afterNext();
    }
  }

  /** Feeds the clock (the frame loop; tests call it directly). */
  advance(dt: number): void {
    if (!this.openFlag) return;
    if (this.run.tick(dt)) this.render();
    else this.paintBar();
  }

  dispose(): void {
    this.close();
    this.dom?.root.remove();
  }

  private afterNext(): void {
    if (this.run.phase === 'done' && !this.submitted) {
      this.submitted = true;
      if (this.run.score !== null) this.opts.onScore(this.run.score);
    }
    this.render();
  }

  private startLoop(): void {
    if (!this.dom || this.raf !== 0 || !this.openFlag || typeof requestAnimationFrame === 'undefined') return;
    const tick = (nowMs: number): void => {
      this.raf = 0;
      if (!this.openFlag) return;
      const dt = this.lastFrame < 0 ? 0 : Math.min(0.25, (nowMs - this.lastFrame) / 1000);
      this.lastFrame = nowMs;
      this.advance(dt);
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.raf !== 0 && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lastFrame = -1;
  }

  private paintBar(): void {
    const dom = this.dom;
    if (!dom) return;
    const pct = Math.round(this.run.fraction * 100);
    if (pct === this.barShown) return;
    this.barShown = pct;
    dom.barFill.style.width = `${String(pct)}%`;
    dom.bar.setAttribute('aria-valuenow', String(pct));
  }

  private render(): void {
    const dom = this.dom;
    if (!dom) return;
    const run = this.run;
    const key = `${String(run.index)}|${run.phase}|${String(run.picks[run.index] ?? '-')}`;
    if (key === this.renderedKey) return;
    this.renderedKey = key;
    clearChildren(dom.body);
    dom.bar.hidden = run.phase !== 'question';
    if (run.phase === 'done') {
      setText(dom.title, 'Defensive tactics: result');
      const pass = CAREER_CONFIG.academy.pass.defensive;
      dom.body.append(
        el('div', { class: 'cr-result-score' }, `Score ${String(run.score ?? 0)}`),
        el('div', { class: 'cr-result-detail' }, `${String(run.total)} drills · pass mark ${String(pass)}`),
        el('button', { type: 'button', class: 'cr-btn cr-primary', onclick: () => { this.exit(); } }, 'Continue'),
      );
      setText(dom.hint, 'Enter to continue');
      return;
    }
    const drill = run.drill;
    setText(dom.title, `Drill ${String(run.index + 1)} / ${String(run.total)}`);
    if (!drill) return;
    dom.body.append(
      el('div', { class: 'cr-situation' }, drill.situation),
      el('div', { class: 'cr-level' }, `Subject resistance: ${drill.resistance}`),
    );
    const list = el('div', { class: 'cr-options', role: 'group', 'aria-label': 'Responses' });
    const feedback = run.phase === 'feedback';
    const best = run.bestOption;
    drill.options.forEach((o, i) => {
      const picked = run.picks[run.index] === i;
      const cls = `cr-btn cr-option${picked ? ' cr-picked' : ''}${feedback && i === best ? ' cr-best' : ''}${feedback && picked ? ` cr-${o.grade}` : ''}`;
      list.appendChild(el('button', { type: 'button', class: cls, disabled: feedback, onclick: () => { this.pick(i); } }, `${String(i + 1)}  ${o.text}`));
    });
    dom.body.appendChild(list);
    if (feedback) {
      const grade = run.lastGrade;
      dom.body.appendChild(el('div', { class: `cr-feedback cr-fb-${grade ?? 'wrong'}`, role: 'status' }, grade ? gradeLabel(grade) : ''));
      dom.body.appendChild(el('button', { type: 'button', class: 'cr-btn cr-primary', onclick: () => { this.advanceScreen(); } }, run.index + 1 >= run.total ? 'Finish (Enter)' : 'Next drill (Enter)'));
      setText(dom.hint, 'Enter continues · Esc abandons the attempt');
    } else {
      setText(dom.hint, '1-4 choose a response · Esc abandons the attempt');
    }
    this.barShown = -1;
    this.paintBar();
  }

  private build(): DefensiveDom {
    const root = div('cr-panel cr-defensive');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Defensive tactics drill');
    const title = div('cr-title', root);
    const bar = div('cr-timebar', root);
    bar.setAttribute('role', 'progressbar');
    bar.setAttribute('aria-label', 'Time left');
    bar.setAttribute('aria-valuemin', '0');
    bar.setAttribute('aria-valuemax', '100');
    const barFill = div('cr-timebar-fill', bar);
    const body = div('cr-body', root);
    body.setAttribute('aria-live', 'polite');
    const hint = div('cr-hint', root);
    return { root, title, body, bar, barFill, hint };
  }
}
