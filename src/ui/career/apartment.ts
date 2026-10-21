import { isReducedFlash, pulse } from '../../a11y';
import {
  CAREER_CONFIG, OFF_DUTY_ACTIVITIES, fitForDuty,
  type ActivityDef, type CareerView, type OffDutyActivity,
} from '../../career';
import { formatStamp } from '../../records/calendar';
import { div, setText } from '../panels/dom';
import { clearChildren, el } from '../ui';
import type { Menu, UIRoot } from '../ui';
import './career.css';
import { keepFocus, meter } from './dom';
import {
  WELLBEING_LEVELS, formatMoney, formatPercent, highIsBad, hoursText, lowIsBad, windowText, type Severity,
} from './format';
import { HEADLESS_ELEMENT, canBuildDom } from './types';

/** What the apartment needs from the session (design §11.2). */
export interface ApartmentHost {
  view(): CareerView;
  plan(a: OffDutyActivity, hours: number): { ok: boolean; reason: string };
  /** Court dates, one line each (from the court system). */
  courtLines(): readonly string[];
  /** Ends the off-duty period. A `{ ok: false, reason }` result (unfit for duty) is shown and the screen stays open. */
  reportForDuty(): void | { ok: boolean; reason: string };
  openCareer(): void;
  /** Days without family time / exercise (`CareerSave.neglect`); optional, the warnings fall back to the wellbeing values. */
  neglect?(): { daysWithoutFamily: number; daysWithoutExercise: number };
}

export const ACTIVITY_LABELS: Readonly<Record<OffDutyActivity, string>> = {
  rest: 'Rest',
  exercise: 'Exercise',
  family: 'Family time',
  secondJob: 'Second job',
};

export interface ApartmentBar {
  key: string;
  label: string;
  value: number;
  severity: Severity;
}

export interface ApartmentActivity {
  id: OffDutyActivity;
  label: string;
  /** Hours that can still be planned for it (min of the hours left and the daily limit left). */
  maxHours: number;
  enabled: boolean;
  /** Per-hour effects in words. */
  hint: string;
}

export interface ApartmentModel {
  hoursLeft: number;
  nextShift: string;
  money: number;
  bars: ApartmentBar[];
  warnings: string[];
  activities: ApartmentActivity[];
  /** Planned hours per activity so far. */
  plan: { activity: OffDutyActivity; label: string; hours: number }[];
  /** Whether Report for duty can be pressed (off duty and not separated). */
  canReport: boolean;
}

/** '-12 % fatigue, -5 % stress, +0.9 h sleep, $ 24' per hour of an activity (zero effects skipped). */
export function activityHint(def: Readonly<ActivityDef>): string {
  const parts: string[] = [];
  const pct = (v: number, label: string): void => {
    if (v !== 0) parts.push(`${v > 0 ? '+' : '-'}${String(Math.round(Math.abs(v) * 100))} % ${label}`);
  };
  pct(def.fatigue, 'fatigue');
  pct(def.stress, 'stress');
  pct(def.fitness, 'fitness');
  pct(def.family, 'family');
  if (def.sleep > 0) parts.push(`${String(Math.round(def.sleep * 10) / 10)} h sleep`);
  if (def.money !== 0) parts.push(formatMoney(def.money));
  return `Per hour: ${parts.length > 0 ? parts.join(', ') : 'no effect'} · up to ${String(def.maxPerDay)} h`;
}

/**
 * The apartment (off-duty hub) as a model: hours left, the next shift window, wellbeing bars with severity, warnings
 * (family neglect, sleep debt, money below zero, falling fitness, critical stress, unfit for duty) and which activities
 * can still be planned. `neglect` (optional) gives the day counts; without it the warnings use the wellbeing values.
 */
export function apartmentModel(v: CareerView, neglect?: { daysWithoutFamily: number; daysWithoutExercise: number }): ApartmentModel {
  const w = v.wellbeing;
  const cfg = CAREER_CONFIG.wellbeing;
  const off = v.offDuty;
  const hoursLeft = off ? Math.max(0, off.hoursLeft) : 0;
  const planned = (a: OffDutyActivity): number => (off ? off.plan.reduce((sum, p) => sum + (p.activity === a ? p.hours : 0), 0) : 0);
  const warnings: string[] = [];
  const fit = fitForDuty(w);
  if (!fit.ok) warnings.push(`Not fit for duty: ${fit.reason}`);
  if (neglect && neglect.daysWithoutFamily >= 1) warnings.push(`Family time neglected for ${String(neglect.daysWithoutFamily)} day${neglect.daysWithoutFamily === 1 ? '' : 's'}`);
  else if (!neglect && w.family < cfg.neglect.familyStressBelow) warnings.push('Family time neglected');
  if (w.sleepDebtH >= 1) warnings.push(`Sleep debt ${String(Math.round(w.sleepDebtH))}h`);
  if (v.money < 0) warnings.push('Money below zero');
  if (neglect ? neglect.daysWithoutExercise > cfg.neglect.exerciseGraceDays : w.fitness < WELLBEING_LEVELS.fitness.caution) warnings.push('Fitness falling');
  if (w.stress >= WELLBEING_LEVELS.stress.alert) warnings.push('Critical stress');
  return {
    hoursLeft,
    nextShift: off ? windowText(off.nextStartGame, off.nextEndGame) : '',
    money: v.money,
    bars: [
      { key: 'fatigue', label: 'Fatigue', value: w.fatigue, severity: highIsBad(w.fatigue, WELLBEING_LEVELS.fatigue.caution, WELLBEING_LEVELS.fatigue.alert) },
      { key: 'stress', label: 'Stress', value: w.stress, severity: highIsBad(w.stress, WELLBEING_LEVELS.stress.caution, WELLBEING_LEVELS.stress.alert) },
      { key: 'health', label: 'Health', value: w.health, severity: lowIsBad(w.health, WELLBEING_LEVELS.health.caution, WELLBEING_LEVELS.health.alert) },
      { key: 'fitness', label: 'Fitness', value: w.fitness, severity: lowIsBad(w.fitness, WELLBEING_LEVELS.fitness.caution, WELLBEING_LEVELS.fitness.alert) },
      { key: 'family', label: 'Family', value: w.family, severity: lowIsBad(w.family, WELLBEING_LEVELS.family.caution, WELLBEING_LEVELS.family.alert) },
    ],
    warnings,
    activities: OFF_DUTY_ACTIVITIES.map((id): ApartmentActivity => {
      const def = cfg.activities[id];
      const maxHours = off ? Math.max(0, Math.min(hoursLeft, def.maxPerDay - planned(id))) : 0;
      return { id, label: ACTIVITY_LABELS[id], maxHours, enabled: maxHours > 0, hint: activityHint(def) };
    }),
    plan: (off?.plan ?? []).map((p) => ({ activity: p.activity, label: ACTIVITY_LABELS[p.activity], hours: p.hours })),
    canReport: off !== null && v.stage !== 'separated',
  };
}

/** The hours a stepper may offer: whole hours up to `maxHours`, or the fraction itself when under one hour. */
export function clampActivityHours(hours: number, maxHours: number): number {
  if (!(maxHours > 0)) return 0;
  if (maxHours < 1) return maxHours;
  return Math.min(Math.floor(maxHours), Math.max(1, Math.floor(Number.isFinite(hours) ? hours : 1)));
}

interface ApartmentDom {
  readonly root: HTMLDivElement;
  readonly body: HTMLDivElement;
  readonly status: HTMLDivElement;
  readonly hint: HTMLDivElement;
}

/** Refresh period of the highlight pulse (10 Hz). */
const PULSE_MS = 100;

/**
 * The apartment screen (pausing Menu, id 'apartment'): wellbeing bars, money, hours left, the next shift, court dates,
 * neglect warnings, an hours stepper and a Go button per activity, the plan so far and the career log. Report for duty
 * ends the off-duty period. Warnings pulse softly with `pulse()` (constant with reduced flash). Escape is not consumed.
 */
export class ApartmentScreen implements Menu {
  readonly id = 'apartment' as const;
  readonly element: HTMLElement;
  readonly pausesGame = true as const;

  private readonly dom: ApartmentDom | null;
  private openFlag = false;
  private shownView: CareerView | null = null;
  private readonly hours: Record<OffDutyActivity, number> = { rest: 1, exercise: 1, family: 1, secondJob: 1 };
  private message = '';
  private lastPulse = -Infinity;

  private readonly ui: UIRoot | null;
  private readonly host: ApartmentHost;

  constructor(ui: UIRoot | null, host: ApartmentHost) {
    this.ui = ui;
    this.host = host;
    this.dom = canBuildDom(ui) ? this.build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  /** Hours chosen on the stepper of an activity. */
  stepperHours(a: OffDutyActivity): number {
    return this.hours[a];
  }

  get model(): ApartmentModel {
    return apartmentModel(this.host.view(), this.host.neglect?.());
  }

  open(): void {
    this.openFlag = true;
    this.message = '';
    this.shownView = null;
    this.refresh();
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
  }

  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  onShow(): void {
    this.refresh();
  }

  onHide(): void {
    this.openFlag = this.openFlag && (this.ui?.isOpen(this) ?? false);
  }

  onKeyDown(): boolean {
    return false;
  }

  /** Moves an activity stepper by `delta` hours within what is left. */
  step(a: OffDutyActivity, delta: number): void {
    const max = this.model.activities.find((x) => x.id === a)?.maxHours ?? 0;
    this.hours[a] = max < 1 ? max : Math.min(Math.floor(max), Math.max(1, this.hours[a] + delta));
    this.refresh(true);
  }

  /** Plans the stepper's hours of an activity. */
  go(a: OffDutyActivity): { ok: boolean; reason: string } {
    const max = this.model.activities.find((x) => x.id === a)?.maxHours ?? 0;
    const hours = clampActivityHours(this.hours[a], max);
    const result = hours > 0 ? this.host.plan(a, hours) : { ok: false, reason: 'No hours left for that' };
    this.message = result.ok ? `${ACTIVITY_LABELS[a]}: ${hoursText(hours)} planned` : result.reason;
    this.refresh(true);
    return result;
  }

  /** Report for duty; a refusal is shown and the screen stays. */
  reportForDuty(): void {
    const result = this.host.reportForDuty();
    if (result && !result.ok) {
      this.message = result.reason;
      this.refresh(true);
    }
  }

  /** Re-reads the view; rebuilds only when it is a new revision (or `force`). */
  refresh(force = false): void {
    const view = this.host.view();
    if (!force && view === this.shownView) return;
    this.shownView = view;
    const dom = this.dom;
    if (!dom) return;
    const m = apartmentModel(view, this.host.neglect?.());
    keepFocus(dom.body, () => {
      clearChildren(dom.body);
      this.renderBody(dom.body, view, m);
    });
    setText(dom.status, this.message);
    setText(dom.hint, 'Tab moves between activities · Report for duty ends the off-duty period');
  }

  /** Per-frame hook (10 Hz at most): pulses the warning highlight. */
  update(nowMs: number): void {
    const dom = this.dom;
    if (!dom || !this.openFlag || nowMs - this.lastPulse < PULSE_MS) return;
    this.lastPulse = nowMs;
    dom.root.style.setProperty('--cr-pulse', pulse(nowMs, isReducedFlash()).toFixed(2));
  }

  dispose(): void {
    this.close();
    this.dom?.root.remove();
  }

  private renderBody(body: HTMLElement, v: CareerView, m: ApartmentModel): void {
    if (v.offDuty === null) {
      body.appendChild(el('p', { class: 'cr-dim' }, v.stage === 'separated' ? 'You are no longer with the department.' : 'You are not off duty.'));
    } else {
      body.appendChild(el('dl', { class: 'cr-lines' },
        el('dt', null, 'Hours left'), el('dd', null, hoursText(m.hoursLeft)),
        el('dt', null, 'Next shift'), el('dd', null, m.nextShift),
        el('dt', null, 'Money'), el('dd', { class: m.money < 0 ? 'cr-alert' : '' }, formatMoney(m.money)),
      ));
    }
    const bars = el('div', { class: 'cr-meters' });
    for (const b of m.bars) {
      bars.appendChild(el('div', { class: 'cr-meter-row' }, el('span', { class: 'cr-meter-label' }, b.label), meter(b.value, b.severity, b.label), el('span', { class: 'cr-num' }, formatPercent(b.value))));
    }
    body.appendChild(bars);
    if (m.warnings.length > 0) {
      body.appendChild(el('ul', { class: 'cr-warnings', role: 'alert' }, m.warnings.map((w) => el('li', { class: 'cr-warn' }, w))));
    }
    const court = this.host.courtLines();
    if (court.length > 0) {
      body.appendChild(el('div', { class: 'cr-heading' }, 'Court'));
      body.appendChild(el('ul', { class: 'cr-list' }, court.map((c) => el('li', null, c))));
    }
    if (v.offDuty !== null) {
      body.appendChild(el('div', { class: 'cr-heading' }, 'Plan your time'));
      for (const a of m.activities) {
        const hours = clampActivityHours(this.hours[a.id], a.maxHours);
        body.appendChild(el('div', { class: 'cr-activity' },
          el('div', { class: 'cr-activity-name' }, el('strong', null, a.label), el('span', { class: 'cr-dim' }, a.hint)),
          el('div', { class: 'cr-stepper', role: 'group', 'aria-label': `${a.label} hours` },
            el('button', { type: 'button', class: 'cr-btn', 'data-focus': `${a.id}:minus`, disabled: !a.enabled || hours <= 1, 'aria-label': `Fewer hours of ${a.label}`, onclick: () => { this.step(a.id, -1); } }, '-'),
            el('span', { class: 'cr-stepper-value' }, hoursText(hours)),
            el('button', { type: 'button', class: 'cr-btn', 'data-focus': `${a.id}:plus`, disabled: !a.enabled || hours + 1 > a.maxHours, 'aria-label': `More hours of ${a.label}`, onclick: () => { this.step(a.id, 1); } }, '+'),
            el('button', { type: 'button', class: 'cr-btn', 'data-focus': `${a.id}:go`, disabled: !a.enabled, onclick: () => { this.go(a.id); } }, 'Go')),
        ));
      }
      if (m.plan.length > 0) {
        body.appendChild(el('div', { class: 'cr-heading' }, 'Planned'));
        body.appendChild(el('ul', { class: 'cr-list' }, m.plan.map((p) => el('li', null, `${p.label}: ${hoursText(p.hours)}`))));
      }
    }
    if (v.history.length > 0) {
      body.appendChild(el('div', { class: 'cr-heading' }, 'Log'));
      body.appendChild(el('ul', { class: 'cr-list' }, v.history.slice(-5).reverse().map((h) => el('li', null, el('time', null, formatStamp(h.game)), ` ${h.text}`))));
    }
    body.appendChild(el('div', { class: 'cr-actions' },
      el('button', { type: 'button', class: 'cr-btn', 'data-focus': 'career', onclick: () => { this.host.openCareer(); } }, 'Career'),
      el('button', { type: 'button', class: 'cr-btn cr-primary', 'data-focus': 'report', disabled: !m.canReport, onclick: () => { this.reportForDuty(); } }, 'Report for duty'),
    ));
  }

  private build(): ApartmentDom {
    const root = div('cr-panel cr-apartment');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Apartment');
    div('cr-title', root).textContent = 'Apartment';
    const body = div('cr-body cr-scroll', root);
    const status = div('cr-status', root);
    status.setAttribute('role', 'status');
    const hint = div('cr-hint', root);
    return { root, body, status, hint };
  }
}
