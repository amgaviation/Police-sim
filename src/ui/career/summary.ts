import { DOR_CATEGORIES, dorCategoryLabel, type ShiftStats, type ShiftSummary } from '../../career';
import { formatStamp } from '../../records/calendar';
import { div } from '../panels/dom';
import { clearChildren, el } from '../ui';
import type { Menu, UIRoot } from '../ui';
import './career.css';
import { meter, tagOf } from './dom';
import { WELLBEING_LEVELS, formatMoney, formatPercent, highIsBad, hoursText, lowIsBad, windowText, type Severity } from './format';
import { HEADLESS_ELEMENT, canBuildDom } from './types';

export interface SummaryModel {
  title: string;
  pay: { rows: { label: string; amount: number }[]; total: number; hours: number };
  dor: { average: number; rows: { label: string; value: number }[]; notes: string[] } | null;
  stats: { label: string; text: string }[];
  events: { when: string; text: string }[];
  bars: { label: string; value: number; severity: Severity }[];
  next: string;
}

function trustText(delta: number): string {
  const points = Math.round(delta * 1000) / 10;
  return `${points > 0 ? '+' : ''}${String(points)} points`;
}

/** Stat lines of a shift (zero-valued optional lines are kept: the summary is a record, not a highlight reel). */
export function statLines(s: Readonly<ShiftStats>): { label: string; text: string }[] {
  const avg = s.reports > 0 ? Math.round(s.reportSum / s.reports) : null;
  return [
    { label: 'Calls handled', text: String(s.calls) },
    { label: 'Arrests', text: String(s.arrests) },
    { label: 'Reports', text: avg === null ? '0' : `${String(s.reports)} (average grade ${String(avg)})` },
    { label: 'Use of force', text: s.forceEvents === 0 ? 'none' : `${String(s.forceEvents)} (${String(s.unjustifiedForce)} unjustified)` },
    { label: 'Unlawful determinations', text: String(s.unlawfulDeterminations) },
    { label: 'Pursuits', text: String(s.pursuits) },
    { label: 'Fleet points', text: String(s.fleetPoints) },
    { label: 'Community trust', text: trustText(s.trustDelta) },
    { label: 'Court time', text: `${String(s.courtMinutes)} min` },
    { label: 'Overtime', text: `${String(s.overtimeMinutes)} min` },
  ];
}

/** The shift summary as a model: pay breakdown (non-zero parts), DOR, stats, events and the wellbeing after the shift. */
export function summaryModel(s: ShiftSummary): SummaryModel {
  const p = s.pay;
  const parts: [string, number][] = [
    ['Base pay', p.base], ['Night differential', p.night], ['Specialty premium', p.specialty], ['FTO premium', p.fto],
    ['Overtime', p.overtime], ['Court time', p.court], ['Deductions', -p.deductions],
  ];
  const w = s.wellbeing;
  return {
    title: `Shift ${String(s.shiftNo)} complete`,
    pay: { rows: parts.filter(([, a]) => a !== 0).map(([label, amount]) => ({ label, amount })), total: p.total, hours: p.hours },
    dor: s.dor === null ? null : {
      average: s.dor.average,
      rows: DOR_CATEGORIES.map((c) => ({ label: dorCategoryLabel(c), value: s.dor?.scores[c] ?? 0 })),
      notes: s.dor.notes.slice(),
    },
    stats: statLines(s.stats),
    events: s.events.map((e) => ({ when: formatStamp(e.game), text: e.text })),
    bars: [
      { label: 'Fatigue', value: w.fatigue, severity: highIsBad(w.fatigue, WELLBEING_LEVELS.fatigue.caution, WELLBEING_LEVELS.fatigue.alert) },
      { label: 'Stress', value: w.stress, severity: highIsBad(w.stress, WELLBEING_LEVELS.stress.caution, WELLBEING_LEVELS.stress.alert) },
      { label: 'Health', value: w.health, severity: lowIsBad(w.health, WELLBEING_LEVELS.health.caution, WELLBEING_LEVELS.health.alert) },
    ],
    next: windowText(s.nextStartGame, s.nextEndGame),
  };
}

/** What the summary screen reports back to. */
export interface SummaryHost {
  /** Continue: the integrator opens the apartment. */
  continue(summary: ShiftSummary): void;
  /** FTO assignment: opens the trainee rating. Optional; the button shows only when given. */
  rateTrainee?(): void;
}

/**
 * Shift summary (pausing Menu, id 'shift-summary'): pay breakdown, the daily observation report on probation, stats,
 * events and the wellbeing after the shift. Enter / Escape / Continue hand over to the host.
 */
export class ShiftSummaryScreen implements Menu {
  readonly id = 'shift-summary' as const;
  readonly element: HTMLElement;
  readonly pausesGame = true as const;

  private readonly body: HTMLDivElement | null;
  private openFlag = false;
  private shown: ShiftSummary | null = null;

  private readonly ui: UIRoot | null;
  private readonly host: SummaryHost;

  constructor(ui: UIRoot | null, host: SummaryHost) {
    this.ui = ui;
    this.host = host;
    if (canBuildDom(ui)) {
      const root = div('cr-panel cr-summary');
      root.setAttribute('role', 'dialog');
      root.setAttribute('aria-label', 'Shift summary');
      this.body = div('cr-body cr-scroll', root);
      this.element = root;
    } else {
      this.body = null;
      this.element = HEADLESS_ELEMENT;
    }
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  get summary(): ShiftSummary | null {
    return this.shown;
  }

  open(summary: ShiftSummary): void {
    this.shown = summary;
    this.openFlag = true;
    this.render(summaryModel(summary));
    if (this.ui && !this.ui.isOpen(this)) this.ui.push(this);
  }

  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    if (this.ui?.isOpen(this)) this.ui.pop(this);
  }

  /** Continue: closes the screen and tells the host. */
  proceed(): void {
    const s = this.shown;
    if (!this.openFlag || s === null) return;
    this.close();
    this.host.continue(s);
  }

  onHide(): void {
    this.openFlag = this.openFlag && (this.ui?.isOpen(this) ?? false);
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.openFlag || event.ctrlKey || event.altKey || event.metaKey) return false;
    if (event.key === 'Escape' || (event.key === 'Enter' && tagOf(event.target) !== 'BUTTON')) {
      if (!event.repeat) this.proceed();
      return true;
    }
    return false;
  }

  dispose(): void {
    this.close();
    if (this.body) this.element.remove();
  }

  private render(m: SummaryModel): void {
    const body = this.body;
    if (!body) return;
    clearChildren(body);
    body.appendChild(el('h2', { class: 'cr-title' }, m.title));
    body.appendChild(el('div', { class: 'cr-heading' }, `Pay · ${hoursText(m.pay.hours)}`));
    const pay = el('dl', { class: 'cr-lines' });
    for (const r of m.pay.rows) pay.append(el('dt', null, r.label), el('dd', { class: 'cr-num' }, formatMoney(r.amount)));
    pay.append(el('dt', { class: 'cr-total' }, 'Total'), el('dd', { class: 'cr-num cr-total' }, formatMoney(m.pay.total)));
    body.appendChild(pay);
    if (m.dor) {
      body.appendChild(el('div', { class: 'cr-heading' }, `Daily observation report · average ${m.dor.average.toFixed(2)} / 5`));
      body.appendChild(el('dl', { class: 'cr-lines' }, m.dor.rows.flatMap((r) => [el('dt', null, r.label), el('dd', { class: 'cr-num' }, r.value.toFixed(1))])));
      if (m.dor.notes.length > 0) body.appendChild(el('ul', { class: 'cr-reasons' }, m.dor.notes.map((n) => el('li', null, n))));
    }
    body.appendChild(el('div', { class: 'cr-heading' }, 'Shift record'));
    body.appendChild(el('dl', { class: 'cr-lines' }, m.stats.flatMap((r) => [el('dt', null, r.label), el('dd', null, r.text)])));
    if (m.events.length > 0) {
      body.appendChild(el('div', { class: 'cr-heading' }, 'Events'));
      body.appendChild(el('ul', { class: 'cr-list' }, m.events.map((e) => el('li', null, el('time', null, e.when), ` ${e.text}`))));
    }
    body.appendChild(el('div', { class: 'cr-heading' }, 'After the shift'));
    body.appendChild(el('div', { class: 'cr-meters' }, m.bars.map((b) =>
      el('div', { class: 'cr-meter-row' }, el('span', { class: 'cr-meter-label' }, b.label), meter(b.value, b.severity, b.label), el('span', { class: 'cr-num' }, formatPercent(b.value))))));
    body.appendChild(el('p', { class: 'cr-dim' }, `Next shift ${m.next}`));
    const actions = el('div', { class: 'cr-actions' });
    if (this.host.rateTrainee) {
      actions.appendChild(el('button', { type: 'button', class: 'cr-btn', onclick: () => { this.host.rateTrainee?.(); } }, 'Rate trainee'));
    }
    actions.appendChild(el('button', { type: 'button', class: 'cr-btn cr-primary', autofocus: true, onclick: () => { this.proceed(); } }, 'Continue'));
    body.appendChild(actions);
  }
}
