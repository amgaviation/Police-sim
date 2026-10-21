import {
  CAREER_CONFIG, CAREER_RANKS, SPECIALTIES, SPECIALTY_IDS, ACADEMY_MODULES, DOR_CATEGORIES,
  academyModuleLabel, dorCategoryLabel, ftoEligibility, parsePositionKey, positionKey, positionKeys, promotionEligibility, rankIndex,
  specialtyEligibility,
  type BidPref, type CareerEligibilityInput, type CareerRank, type CareerRequest, type CareerView, type DutyAssignment,
  type EligibilityContext, type SpecialtyId,
} from '../../career';
import { formatStamp } from '../../records/calendar';
import { div, setText } from '../panels/dom';
import { clearChildren, el } from '../ui';
import type { Menu, UIRoot } from '../ui';
import './career.css';
import { keepFocus, meter, tagOf } from './dom';
import {
  WELLBEING_LEVELS, capitalize, formatMoney, formatPercent, highIsBad, hoursText, lowIsBad, positionLabel, windowText, type Severity,
} from './format';
import { HEADLESS_ELEMENT, canBuildDom } from './types';

/** What the career screen needs from the session (design §11.2). */
export interface CareerHost {
  view(): CareerView;
  eligibility(): EligibilityContext;
  names(): readonly string[];
  /** Queued for the next career step; in a paused session the host should apply it at once (request + step with dt 0). */
  request(r: CareerRequest): void;
  /** Opens `LegalQuizScreen` in exam mode and calls `done` with the score. */
  startExam(rank: CareerRank, done: (score: number) => void): void;
  /** Opens the training hub (academy modules and driving courses) to raise the scores the unit requirements read. */
  openTraining?(): void;
  close(): void;
}

export const CAREER_TABS = ['overview', 'schedule', 'units', 'promotion', 'pay', 'evaluations'] as const;
export type CareerTab = (typeof CAREER_TABS)[number];
export const CAREER_TAB_LABELS: Readonly<Record<CareerTab, string>> = {
  overview: 'Overview',
  schedule: 'Schedule & bids',
  units: 'Units',
  promotion: 'Promotion',
  pay: 'Pay',
  evaluations: 'Evaluations',
};

export interface OverviewLine {
  label: string;
  text: string;
  severity: Severity;
}

/** Display name of a duty assignment ('Field training officer', the specialty label, 'Patrol'). */
export function assignmentLabel(a: DutyAssignment): string {
  if (a === 'patrol') return 'Patrol';
  if (a === 'fto') return 'Field training officer';
  return SPECIALTIES[a].label;
}

function stageText(v: CareerView): { text: string; severity: Severity } {
  switch (v.stage) {
    case 'academy': return { text: 'Academy recruit', severity: 'clear' };
    case 'probation': return { text: `Probation · ${String(v.probationShiftsLeft)} shift${v.probationShiftsLeft === 1 ? '' : 's'} left`, severity: 'clear' };
    case 'patrol': return { text: 'Sworn patrol officer', severity: 'clear' };
    case 'separated': return { text: 'Separated from the department', severity: 'alert' };
  }
}

/** The Overview tab: stage, rank, assignment, schedule, money and the wellbeing values with their severity. */
export function careerOverviewModel(v: CareerView): { lines: OverviewLine[] } {
  const w = v.wellbeing;
  const stage = stageText(v);
  const lines: OverviewLine[] = [
    { label: 'Stage', text: stage.text, severity: stage.severity },
    { label: 'Rank', text: capitalize(v.rank), severity: 'clear' },
    { label: 'Assignment', text: assignmentLabel(v.assignment), severity: 'clear' },
    { label: 'Seniority', text: `${String(v.seniorityShifts)} shifts`, severity: 'clear' },
    { label: 'Position', text: positionLabel(v.slot.slot, v.slot.beat), severity: 'clear' },
    {
      label: 'Shift',
      text: v.shift.onDuty
        ? `Shift ${String(v.shift.shiftNo)} on duty ${windowText(v.shift.startGame, v.shift.endGame)}`
        : v.offDuty
          ? `Off duty · next ${windowText(v.offDuty.nextStartGame, v.offDuty.nextEndGame)}`
          : v.stage === 'separated' ? 'No shifts' : `Shift ${String(v.shift.shiftNo)} ${windowText(v.shift.startGame, v.shift.endGame)}`,
      severity: 'clear',
    },
    { label: 'Money', text: formatMoney(v.money), severity: v.money < 0 ? 'alert' : 'clear' },
    { label: 'Fatigue', text: formatPercent(w.fatigue), severity: highIsBad(w.fatigue, WELLBEING_LEVELS.fatigue.caution, WELLBEING_LEVELS.fatigue.alert) },
    { label: 'Stress', text: formatPercent(w.stress), severity: highIsBad(w.stress, WELLBEING_LEVELS.stress.caution, WELLBEING_LEVELS.stress.alert) },
    { label: 'Health', text: formatPercent(w.health), severity: lowIsBad(w.health, WELLBEING_LEVELS.health.caution, WELLBEING_LEVELS.health.alert) },
    { label: 'Fitness', text: formatPercent(w.fitness), severity: lowIsBad(w.fitness, WELLBEING_LEVELS.fitness.caution, WELLBEING_LEVELS.fitness.alert) },
    { label: 'Family', text: formatPercent(w.family), severity: lowIsBad(w.family, WELLBEING_LEVELS.family.caution, WELLBEING_LEVELS.family.alert) },
    { label: 'Sleep debt', text: hoursText(w.sleepDebtH), severity: w.sleepDebtH >= 8 ? 'alert' : w.sleepDebtH >= 4 ? 'caution' : 'clear' },
    {
      label: 'Performance',
      text: `Aim spread x${v.performance.aimSpread.toFixed(2)} · steering lag ${v.performance.steerLagS.toFixed(2)} s`,
      severity: v.performance.aimSpread >= 1.25 ? 'alert' : v.performance.aimSpread > 1.05 ? 'caution' : 'clear',
    },
  ];
  return { lines };
}

/** The eligibility input the career rules take, from a view. */
export function eligibilityInput(v: CareerView): CareerEligibilityInput {
  return { stage: v.stage, rank: v.rank, assignment: v.assignment, seniorityShifts: v.seniorityShifts, academy: v.academy, wellbeing: v.wellbeing };
}

export interface UnitRow {
  id: SpecialtyId | 'fto';
  label: string;
  eligible: boolean;
  reasons: string[];
  current: boolean;
  description: string;
}

/** Units tab: the six specialty units and the FTO assignment with every unmet requirement as a reason. */
export function unitsModel(v: CareerView, ctx: EligibilityContext): UnitRow[] {
  const input = eligibilityInput(v);
  const rows: UnitRow[] = SPECIALTY_IDS.map((id) => {
    const e = specialtyEligibility(id, input, ctx);
    return { id, label: SPECIALTIES[id].label, eligible: e.ok, reasons: e.reasons, current: v.assignment === id, description: SPECIALTIES[id].description };
  });
  const fto = ftoEligibility(input, ctx);
  rows.push({
    id: 'fto', label: 'Field training officer', eligible: fto.ok, reasons: fto.reasons, current: v.assignment === 'fto',
    description: 'Ride with a recruit and rate their daily performance for extra pay and career points.',
  });
  return rows;
}

/** 'day:downtown' -> 'Day · Downtown'. */
export function positionKeyLabel(key: string): string {
  const p = parsePositionKey(key);
  return positionLabel(p.slot, p.beat);
}

export interface BidModel {
  prefs: BidPref[];
  nextBidShift: number;
  /** Shifts until the bid resolves (0 = at the next report for duty). */
  shiftsUntilBid: number;
  options: { key: string; label: string }[];
  maxPrefs: number;
}

/** Schedule tab: the 12 positions, the stored preferences (in order) and when the bid resolves. */
export function bidModel(v: CareerView): BidModel {
  return {
    prefs: v.bid.prefs.map((p) => ({ slot: p.slot, beat: p.beat })),
    nextBidShift: v.bid.nextBidShift,
    shiftsUntilBid: Math.max(0, v.bid.nextBidShift - v.shift.shiftNo - 1),
    options: positionKeys().map((key) => ({ key, label: positionKeyLabel(key) })),
    maxPrefs: CAREER_CONFIG.bidding.maxPrefs,
  };
}

/** Adds the position when absent (up to `max`), removes it when present; returns a new list. */
export function toggleBidPref(prefs: readonly BidPref[], pref: Readonly<BidPref>, max: number = CAREER_CONFIG.bidding.maxPrefs): BidPref[] {
  const key = positionKey(pref);
  const i = prefs.findIndex((p) => positionKey(p) === key);
  if (i >= 0) return prefs.filter((_, k) => k !== i).map((p) => ({ slot: p.slot, beat: p.beat }));
  if (prefs.length >= max) return prefs.map((p) => ({ slot: p.slot, beat: p.beat }));
  return [...prefs.map((p) => ({ slot: p.slot, beat: p.beat })), { slot: pref.slot, beat: pref.beat }];
}

export interface PromotionModel {
  current: CareerRank;
  next: CareerRank | null;
  ok: boolean;
  reasons: string[];
  /** Exam pass mark, 0 = no exam. */
  exam: number;
}

/** Promotion tab: the next rank, its requirements and the exam mark. */
export function promotionModel(v: CareerView, ctx: EligibilityContext): PromotionModel {
  const next = CAREER_RANKS[rankIndex(v.rank) + 1] ?? null;
  if (next === null) return { current: v.rank, next: null, ok: false, reasons: ['Already at the highest rank'], exam: 0 };
  const e = promotionEligibility(next, eligibilityInput(v), ctx);
  return { current: v.rank, next, ok: e.ok, reasons: e.reasons, exam: e.exam };
}

export interface PayRow {
  shiftNo: number;
  hours: number;
  total: number;
  lines: { label: string; amount: number }[];
}

/** Pay tab: the last shifts' pay (newest first) with every non-zero component. */
export function payModel(v: CareerView, max = 10): { money: number; rentPerWeek: number; rows: PayRow[] } {
  const rows = v.pay.slice(-max).reverse().map((p): PayRow => {
    const parts: [string, number][] = [
      ['Base', p.base], ['Night differential', p.night], ['Specialty premium', p.specialty], ['FTO premium', p.fto],
      ['Overtime', p.overtime], ['Court time', p.court], ['Deductions', -p.deductions],
    ];
    return { shiftNo: p.shiftNo, hours: p.hours, total: p.total, lines: parts.filter(([, amount]) => amount !== 0).map(([label, amount]) => ({ label, amount })) };
  });
  return { money: v.money, rentPerWeek: CAREER_CONFIG.pay.rentPerWeek, rows };
}

export interface EvaluationsModel {
  dor: { shiftNo: number; average: number; scores: { label: string; value: number }[]; notes: string[] }[];
  academy: { label: string; best: string; passed: boolean }[];
  history: { when: string; kind: string; text: string }[];
}

/** Evaluations tab: probation reports (newest first), academy results and the career history (newest first). */
export function evaluationsModel(v: CareerView, maxHistory = 12): EvaluationsModel {
  return {
    dor: v.dor.slice().reverse().map((d) => ({
      shiftNo: d.shiftNo,
      average: d.average,
      scores: DOR_CATEGORIES.map((c) => ({ label: dorCategoryLabel(c), value: d.scores[c] })),
      notes: d.notes.slice(),
    })),
    academy: ACADEMY_MODULES.map((m) => ({ label: academyModuleLabel(m), best: v.academy[m].best < 0 ? 'none' : String(Math.round(v.academy[m].best)), passed: v.academy[m].passed })),
    history: v.history.slice(-maxHistory).reverse().map((e) => ({ when: formatStamp(e.game), kind: e.kind, text: e.text })),
  };
}

interface CareerDom {
  readonly root: HTMLDivElement;
  readonly tabs: Record<CareerTab, HTMLButtonElement>;
  readonly body: HTMLDivElement;
  readonly status: HTMLDivElement;
  readonly hint: HTMLDivElement;
}

/**
 * The career screen (pausing Menu, id 'career'): tabs Overview / Schedule & bids / Units / Promotion / Pay /
 * Evaluations. Left/Right or 1-6 switch tabs, Escape closes through `host.close()`. The body is rebuilt only when the tab,
 * the career view (a new revision is a new object) or the bid draft changed.
 */
export class CareerScreen implements Menu {
  readonly id = 'career' as const;
  readonly element: HTMLElement;
  readonly pausesGame = true as const;

  private readonly dom: CareerDom | null;
  private openFlag = false;
  private current: CareerTab = 'overview';
  private shownView: CareerView | null = null;
  private draft: BidPref[] = [];
  private draftDirty = false;
  private message = '';

  private readonly ui: UIRoot | null;
  private readonly host: CareerHost;

  constructor(ui: UIRoot | null, host: CareerHost) {
    this.ui = ui;
    this.host = host;
    this.dom = canBuildDom(ui) ? this.build() : null;
    this.element = this.dom?.root ?? HEADLESS_ELEMENT;
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  get tab(): CareerTab {
    return this.current;
  }

  /** The bid preferences being edited. */
  get bidDraft(): readonly BidPref[] {
    return this.draft;
  }

  open(tab?: CareerTab): void {
    if (tab !== undefined) this.current = tab;
    this.openFlag = true;
    this.draft = this.host.view().bid.prefs.map((p) => ({ slot: p.slot, beat: p.beat }));
    this.draftDirty = false;
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

  setTab(tab: CareerTab): void {
    if (tab === this.current) return;
    this.current = tab;
    this.shownView = null;
    const dom = this.dom;
    if (dom) {
      for (const t of CAREER_TABS) {
        dom.tabs[t].setAttribute('aria-selected', t === tab ? 'true' : 'false');
        dom.tabs[t].tabIndex = t === tab ? 0 : -1;
      }
    }
    this.refresh();
  }

  onKeyDown(event: KeyboardEvent): boolean {
    if (!this.openFlag || event.ctrlKey || event.altKey || event.metaKey) return false;
    const target = event.target;
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tagOf(target))) return false;
    if (event.key === 'Escape') {
      this.host.close();
      return true;
    }
    const digit = /^(?:Digit|Numpad)?([1-6])$/.exec(event.key);
    if (digit) {
      this.setTab(CAREER_TABS[Number(digit[1]) - 1] as CareerTab);
      this.dom?.tabs[this.current].focus();
      return true;
    }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const i = CAREER_TABS.indexOf(this.current);
      const n = CAREER_TABS.length;
      this.setTab(CAREER_TABS[(i + (event.key === 'ArrowLeft' ? n - 1 : 1)) % n] as CareerTab);
      this.dom?.tabs[this.current].focus();
      return true;
    }
    return false;
  }

  // --- Actions ------------------------------------------------------------------------------------

  /** Toggles a position in the bid draft. */
  toggleBid(pref: BidPref): void {
    this.draft = toggleBidPref(this.draft, pref);
    this.draftDirty = true;
    this.refresh(true);
  }

  /** Sends the draft as the next bid. */
  submitBid(): void {
    this.host.request({ kind: 'submitBid', prefs: this.draft.map((p) => ({ slot: p.slot, beat: p.beat })) });
    this.draftDirty = false;
    this.message = 'Bid preferences submitted';
    this.refresh(true);
  }

  applyUnit(unit: SpecialtyId | 'fto'): void {
    const ctx = this.host.eligibility();
    this.host.request(unit === 'fto' ? { kind: 'applyFto', ctx } : { kind: 'applySpecialty', unit, ctx });
    this.message = `Application sent: ${unit === 'fto' ? 'field training officer' : SPECIALTIES[unit].label}`;
    this.refresh(true);
  }

  returnToPatrol(): void {
    this.host.request({ kind: 'returnToPatrol' });
    this.message = 'Returning to patrol';
    this.refresh(true);
  }

  /** Promotion: runs the exam when the rank has one, then sends the request. */
  promote(): void {
    const m = promotionModel(this.host.view(), this.host.eligibility());
    const next = m.next;
    if (next === null || !m.ok) return;
    const send = (score: number): void => {
      this.host.request({ kind: 'promotion', rank: next, examScore: score, ctx: this.host.eligibility() });
      this.message = `Promotion to ${next} requested`;
      this.refresh(true);
    };
    if (m.exam > 0) this.host.startExam(next, send);
    else send(100);
  }

  /** Rebuilds the visible tab when the tab, the view or the draft changed (`force`: always). */
  refresh(force = false): void {
    const view = this.host.view();
    if (!force && view === this.shownView && !this.draftDirty) return;
    if (view !== this.shownView && !this.draftDirty) {
      this.draft = view.bid.prefs.map((p) => ({ slot: p.slot, beat: p.beat }));
    }
    this.shownView = view;
    const dom = this.dom;
    if (!dom) return;
    keepFocus(dom.body, () => {
      clearChildren(dom.body);
      switch (this.current) {
        case 'overview': this.renderOverview(dom.body, view); break;
        case 'schedule': this.renderSchedule(dom.body, view); break;
        case 'units': this.renderUnits(dom.body, view); break;
        case 'promotion': this.renderPromotion(dom.body, view); break;
        case 'pay': this.renderPay(dom.body, view); break;
        case 'evaluations': this.renderEvaluations(dom.body, view); break;
      }
    });
    setText(dom.status, this.message);
    setText(dom.hint, '1-6 or ←/→ switch tabs · Esc closes');
  }

  dispose(): void {
    this.close();
    this.dom?.root.remove();
  }

  // --- Tab bodies ---------------------------------------------------------------------------------

  private renderOverview(body: HTMLElement, v: CareerView): void {
    const model = careerOverviewModel(v);
    const dl = el('dl', { class: 'cr-lines' });
    for (const line of model.lines) {
      dl.append(el('dt', null, line.label), el('dd', { class: `cr-${line.severity}` }, line.text));
    }
    body.appendChild(dl);
    const w = v.wellbeing;
    body.appendChild(el('div', { class: 'cr-meters' },
      this.meterRow('Fatigue', w.fatigue, highIsBad(w.fatigue, WELLBEING_LEVELS.fatigue.caution, WELLBEING_LEVELS.fatigue.alert)),
      this.meterRow('Stress', w.stress, highIsBad(w.stress, WELLBEING_LEVELS.stress.caution, WELLBEING_LEVELS.stress.alert)),
      this.meterRow('Health', w.health, lowIsBad(w.health, WELLBEING_LEVELS.health.caution, WELLBEING_LEVELS.health.alert)),
    ));
    if (v.assignment !== 'patrol') {
      body.appendChild(el('button', { type: 'button', class: 'cr-btn', 'data-focus': 'patrol', onclick: () => { this.returnToPatrol(); } }, 'Return to patrol'));
    }
  }

  private meterRow(label: string, value: number, severity: Severity): HTMLElement {
    return el('div', { class: 'cr-meter-row' }, el('span', { class: 'cr-meter-label' }, label), meter(value, severity, label), el('span', { class: 'cr-num' }, formatPercent(value)));
  }

  private renderSchedule(body: HTMLElement, v: CareerView): void {
    const m = bidModel(v);
    body.appendChild(el('p', null,
      `Current position: ${positionLabel(v.slot.slot, v.slot.beat)}. `,
      m.shiftsUntilBid === 0 ? 'The bid resolves when you report for duty.' : `The next bid resolves in ${String(m.shiftsUntilBid)} shift${m.shiftsUntilBid === 1 ? '' : 's'} (shift ${String(m.nextBidShift)}).`));
    body.appendChild(el('p', { class: 'cr-dim' }, `Choose up to ${String(m.maxPrefs)} positions in order of preference. Seniority decides who gets what.`));
    const grid = el('div', { class: 'cr-bid-grid', role: 'group', 'aria-label': 'Bid positions' });
    for (const o of m.options) {
      const rank = this.draft.findIndex((p) => positionKey(p) === o.key);
      const pref = parsePositionKey(o.key);
      grid.appendChild(el('button', {
        type: 'button', class: `cr-btn cr-bid${rank >= 0 ? ' cr-picked' : ''}`, 'aria-pressed': rank >= 0 ? 'true' : 'false', 'data-focus': `bid:${o.key}`,
        onclick: () => { this.toggleBid(pref); },
      }, rank >= 0 ? `${String(rank + 1)}. ${o.label}` : o.label));
    }
    body.appendChild(grid);
    body.appendChild(el('button', { type: 'button', class: 'cr-btn cr-primary', 'data-focus': 'submitBid', disabled: this.draft.length === 0, onclick: () => { this.submitBid(); } }, 'Submit bid'));
    if (v.bid.lastAwards.length > 0) {
      body.appendChild(el('div', { class: 'cr-heading' }, 'Last awards'));
      const list = el('ul', { class: 'cr-list' });
      for (const a of v.bid.lastAwards.slice(0, 10)) {
        list.appendChild(el('li', { class: a.id === 'player' ? 'cr-you' : '' },
          `${a.id === 'player' ? 'You' : a.id}: ${positionLabel(a.slot, a.beat)}${a.prefRank >= 0 ? ` (choice ${String(a.prefRank + 1)})` : ' (assigned)'}`));
      }
      body.appendChild(list);
    }
  }

  private renderUnits(body: HTMLElement, v: CareerView): void {
    const ctx = this.host.eligibility();
    const host = this.host;
    if (host.openTraining !== undefined) {
      body.appendChild(el('p', { class: 'cr-dim' }, 'Unit entry needs academy scores. Practise a module in training: your best score counts.'));
      body.appendChild(el('button', { type: 'button', class: 'cr-btn', 'data-focus': 'training', onclick: () => { host.openTraining?.(); } }, 'Training'));
    }
    for (const row of unitsModel(v, ctx)) {
      const card = el('section', { class: `cr-card${row.current ? ' cr-current' : ''}` },
        el('h3', null, row.label, row.current ? el('span', { class: 'cr-badge' }, 'CURRENT') : null),
        el('p', { class: 'cr-dim' }, row.description));
      if (row.reasons.length > 0 && !row.current) {
        card.appendChild(el('ul', { class: 'cr-reasons' }, row.reasons.map((r) => el('li', null, r))));
      }
      if (!row.current) {
        card.appendChild(el('button', {
          type: 'button', class: 'cr-btn', 'data-focus': `unit:${row.id}`, disabled: !row.eligible, onclick: () => { this.applyUnit(row.id); },
        }, row.eligible ? 'Apply' : 'Not eligible'));
      }
      body.appendChild(card);
    }
  }

  private renderPromotion(body: HTMLElement, v: CareerView): void {
    const m = promotionModel(v, this.host.eligibility());
    body.appendChild(el('p', null, `Current rank: ${capitalize(m.current)}`));
    if (m.next === null) {
      body.appendChild(el('p', { class: 'cr-dim' }, 'You hold the highest rank.'));
      return;
    }
    body.appendChild(el('p', null, `Next rank: ${capitalize(m.next)}${m.exam > 0 ? ` · exam pass mark ${String(m.exam)}` : ' · no exam'}`));
    if (m.reasons.length > 0) body.appendChild(el('ul', { class: 'cr-reasons' }, m.reasons.map((r) => el('li', null, r))));
    body.appendChild(el('button', {
      type: 'button', class: 'cr-btn cr-primary', 'data-focus': 'promote', disabled: !m.ok, onclick: () => { this.promote(); },
    }, m.exam > 0 ? 'Take the promotion exam' : 'Apply for promotion'));
  }

  private renderPay(body: HTMLElement, v: CareerView): void {
    const m = payModel(v);
    body.appendChild(el('p', null, `Money ${formatMoney(m.money)} · rent ${formatMoney(m.rentPerWeek)} per week`));
    if (m.rows.length === 0) body.appendChild(el('p', { class: 'cr-dim' }, 'No pay slips yet. Finish a shift to be paid.'));
    for (const row of m.rows) {
      const card = el('section', { class: 'cr-card' }, el('h3', null, `Shift ${String(row.shiftNo)} · ${hoursText(row.hours)} · ${formatMoney(row.total)}`));
      const dl = el('dl', { class: 'cr-lines' });
      for (const l of row.lines) dl.append(el('dt', null, l.label), el('dd', { class: 'cr-num' }, formatMoney(l.amount)));
      card.appendChild(dl);
      body.appendChild(card);
    }
  }

  private renderEvaluations(body: HTMLElement, v: CareerView): void {
    const m = evaluationsModel(v);
    body.appendChild(el('div', { class: 'cr-heading' }, 'Academy'));
    body.appendChild(el('ul', { class: 'cr-list' }, m.academy.map((a) => el('li', { class: a.passed ? 'cr-ok' : '' }, `${a.label}: best ${a.best}${a.passed ? ' · passed' : ''}`))));
    body.appendChild(el('div', { class: 'cr-heading' }, 'Daily observation reports'));
    if (m.dor.length === 0) body.appendChild(el('p', { class: 'cr-dim' }, 'No reports on file.'));
    for (const d of m.dor) {
      body.appendChild(el('section', { class: 'cr-card' },
        el('h3', null, `Shift ${String(d.shiftNo)} · average ${d.average.toFixed(2)} / 5`),
        el('p', null, d.scores.map((s) => `${s.label} ${s.value.toFixed(1)}`).join(' · ')),
        d.notes.length > 0 ? el('ul', { class: 'cr-reasons' }, d.notes.map((n) => el('li', null, n))) : null));
    }
    body.appendChild(el('div', { class: 'cr-heading' }, 'History'));
    if (m.history.length === 0) body.appendChild(el('p', { class: 'cr-dim' }, 'Nothing recorded yet.'));
    body.appendChild(el('ul', { class: 'cr-list' }, m.history.map((h) => el('li', null, el('time', null, h.when), ` ${h.text}`))));
  }

  private build(): CareerDom {
    const root = div('cr-panel cr-career');
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-label', 'Career');
    const head = div('cr-head', root);
    div('cr-title', head).textContent = 'Career';
    head.appendChild(el('button', { type: 'button', class: 'cr-btn', onclick: () => { this.host.close(); } }, 'Close'));
    const tablist = div('cr-tabs', root);
    tablist.setAttribute('role', 'tablist');
    tablist.setAttribute('aria-label', 'Career sections');
    const tabs = {} as Record<CareerTab, HTMLButtonElement>;
    CAREER_TABS.forEach((t, i) => {
      const on = t === this.current;
      const b = el('button', {
        type: 'button', role: 'tab', class: 'cr-tab', 'aria-selected': on ? 'true' : 'false', tabindex: on ? 0 : -1,
        onclick: () => { this.setTab(t); },
      }, `${String(i + 1)} ${CAREER_TAB_LABELS[t]}`);
      tabs[t] = b;
      tablist.appendChild(b);
    });
    const body = div('cr-body cr-scroll', root);
    body.setAttribute('role', 'tabpanel');
    const status = div('cr-status', root);
    status.setAttribute('role', 'status');
    const hint = div('cr-hint', root);
    return { root, tabs, body, status, hint };
  }
}
