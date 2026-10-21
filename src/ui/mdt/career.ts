/**
 * Career and Community tabs of the MDT (design phase 5 §12.1): pure view models plus the DOM renderers that copy them
 * into a container. The overlay rebuilds the containers only when the revision (or the game minute, for the calendar)
 * changes, so these functions may allocate freely.
 */
import type { CadTime } from '../../cad/types';
import type { CareerView, DisciplineActionId, DutyStatus, IaCase, ReportLetter } from '../../conduct/types';
import type { CourtCase } from '../../court/types';
import type { LedgerEntry } from '../../fleet/types';
import { formatStamp } from '../../records/calendar';
import { ruleLabel } from '../../conduct/ia';
import { districtLabel as modDistrictLabel } from '../../mods/registry';
import { clearChildren, el } from '../ui';
import { formatMoney, formatPoints } from '../fleet/format';
import { trustBand, type TrustBand } from '../hud/law';
import { button } from './dom';
import type { LineSeverity } from './model';
import type { MdtCareerSummaryLine, MdtDeps } from './types';

const MINUTE = 60;

export type CareerSectionId = 'career' | 'duty' | 'stats' | 'calendar' | 'cases' | 'incidents' | 'ia' | 'commendations' | 'discipline' | 'reports' | 'fleet';

/** The fleet's career summary (Phase 7 §12.6). */
export interface MdtFleetSummary {
  /** Career points charged (<= 0). */
  readonly points: number;
  readonly departmentCost: number;
  readonly incidents: number;
  /** Damage incidents without a report. */
  readonly unreported: number;
}

/** Fleet feed of the Career tab (Phase 7 §12.6): optional, absent in older sessions and tests. */
export interface MdtFleetDeps {
  summary(): MdtFleetSummary;
  /** The ledger's career charges (any order; non-charge entries are ignored). */
  charges(): readonly LedgerEntry[];
}

/**
 * `MdtDeps` with the optional fleet feed. `MdtDeps` itself lives in `types.ts`; until that gains `fleet?: MdtFleetDeps`
 * (integrator), sessions pass this type where they build the deps.
 */
export type MdtDepsWithFleet = MdtDeps & { readonly fleet?: MdtFleetDeps };

/** What a button on a career line does. */
export interface CareerAction {
  /** `review`: an internal affairs case id; `watch`: an incident key (read-only playback). */
  readonly kind: 'attend' | 'review' | 'watch';
  readonly id: string;
}

export interface CareerLine {
  readonly label: string;
  readonly text: string;
  readonly severity: LineSeverity;
  readonly action?: CareerAction;
}

export interface CareerSection {
  readonly id: CareerSectionId;
  readonly title: string;
  readonly lines: readonly CareerLine[];
  /** Shown when there are no lines. */
  readonly empty: string;
}

export interface CareerModel {
  readonly sections: readonly CareerSection[];
}

export interface CareerOptions {
  /** ATTEND is offered for cases this says yes to (default: none). */
  canAttend?(caseId: string): boolean;
  /** The recorded incidents, newest first (an Incidents section with a REVIEW action per row; absent = no section). */
  incidents?: readonly CareerIncident[];
  /** REVIEW is offered on court cases whose incident this says is still on file (default: none). */
  canReview?(key: string): boolean;
  jurisdiction?: { readonly id: string; readonly name: string };
  /** A Fleet block (points, department cost, unreported damage, the last charges); absent = no block. */
  fleet?: MdtFleetDeps;
  /** Phase 8: the CAREER section at the top (stage, rank, shift, wellbeing); absent = no section. */
  summary?: readonly MdtCareerSummaryLine[];
}

/** One recorded incident of the Career tab's list. */
export interface CareerIncident {
  readonly key: string;
  readonly typeId: string;
  readonly district: string;
  readonly game: number;
  readonly closed: boolean;
}

/** Rows each list shows at most. */
export const CAREER_LIST_MAX = 12;
/** Fleet charges the Fleet block lists. */
export const FLEET_CHARGES_MAX = 10;

const DUTY_LABELS: Readonly<Record<DutyStatus, string>> = {
  active: 'ON DUTY',
  suspended: 'SUSPENDED',
  adminLeave: 'ADMINISTRATIVE LEAVE',
  terminated: 'TERMINATED',
};

const DISCIPLINE_LABELS: Readonly<Record<DisciplineActionId, string>> = {
  counseling: 'Counseling',
  writtenReprimand: 'Written reprimand',
  suspension: 'Suspension',
  termination: 'Termination',
  civilSuit: 'Civil suit',
  criminalCharges: 'Criminal charges',
};

const CASE_STATUS_LABELS: Readonly<Record<CourtCase['status'], string>> = {
  pending: 'pending',
  pleaded: 'pleaded',
  scheduled: 'hearing scheduled',
  inSession: 'in session',
  heard: 'heard',
  missed: 'hearing missed',
  closed: 'closed',
};

const FINDING_LABELS: Readonly<Record<string, string>> = {
  exonerated: 'exonerated',
  unfounded: 'unfounded',
  notSustained: 'not sustained',
  sustained: 'SUSTAINED',
};

/** "writtenReprimand" -> "Written reprimand" for ids without a label (a future discipline action). */
function humanize(id: string): string {
  const words = id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "in 1 h 20 min", "in 45 min", "now" (within a minute) or "overdue 12 min"; `deltaSeconds` = hearing - now. */
export function formatUntil(deltaSeconds: number): string {
  if (!Number.isFinite(deltaSeconds)) return '';
  const minutes = Math.round(Math.abs(deltaSeconds) / MINUTE);
  if (minutes === 0) return 'now';
  const text = minutes >= 60 ? `${String(Math.floor(minutes / 60))} h${minutes % 60 > 0 ? ` ${String(minutes % 60)} min` : ''}` : `${String(minutes)} min`;
  return deltaSeconds > 0 ? `in ${text}` : `overdue ${text}`;
}

function line(label: string, text: string, severity: LineSeverity = 'none', action?: CareerAction): CareerLine {
  return action ? { label, text, severity, action } : { label, text, severity };
}

function letterSeverity(letter: ReportLetter): LineSeverity {
  if (letter === 'A' || letter === 'B') return 'none';
  return letter === 'C' ? 'caution' : 'alert';
}

/** The duty status text: 'ON DUTY', 'SUSPENDED until 01/05/2030 06:00', 'TERMINATED'. */
export function dutyText(status: DutyStatus, untilGame: number): string {
  const base = DUTY_LABELS[status] ?? status.toUpperCase();
  return (status === 'suspended' || status === 'adminLeave') && untilGame > 0 ? `${base} until ${formatStamp(untilGame)}` : base;
}

function dutySection(view: CareerView, opts: CareerOptions): CareerSection {
  const lines: CareerLine[] = [
    line('Status', dutyText(view.status, view.statusUntilGame), view.status === 'active' ? 'none' : view.status === 'terminated' ? 'alert' : 'caution'),
  ];
  if (view.statusReason !== '') lines.push(line('Reason', view.statusReason, 'caution'));
  if (opts.jurisdiction) lines.push(line('Jurisdiction', `${opts.jurisdiction.name} (${opts.jurisdiction.id})`));
  lines.push(line('Points', String(view.points)));
  const cred = Math.round(view.credibility * 100);
  lines.push(line('Credibility', `${String(cred)} %`, cred < 50 ? 'alert' : cred < 70 ? 'caution' : 'none'));
  return { id: 'duty', title: 'Duty', lines, empty: '' };
}

function statsSection(view: CareerView): CareerSection {
  const s = view.stats;
  return {
    id: 'stats',
    title: 'Record',
    empty: '',
    lines: [
      line('Incidents', String(s.incidents)),
      line('Arrests', `${String(s.arrests)} (${String(s.lawfulArrests)} lawful)`),
      line('Excessive force', String(s.excessiveForce), s.excessiveForce > 0 ? 'alert' : 'none'),
      line('Convictions', String(s.convictions)),
      line('Dismissals', String(s.dismissals), s.dismissals > 0 ? 'caution' : 'none'),
      line('Reports filed', `${String(s.reportsFiled)} (average ${String(Math.round(s.avgReport))})`),
    ],
  };
}

/** Scheduled hearings soonest first, each with the time left and an ATTEND action when `canAttend` says so. */
function calendarSection(cases: readonly CourtCase[], now: CadTime, opts: CareerOptions): CareerSection {
  const scheduled = cases.filter((c) => (c.status === 'scheduled' || c.status === 'inSession') && c.hearingGame >= 0).sort((a, b) => a.hearingGame - b.hearingGame || (a.id < b.id ? -1 : 1));
  const lines = scheduled.slice(0, CAREER_LIST_MAX).map((c) => {
    const attend = opts.canAttend?.(c.id) === true;
    const text = `${c.id} ${c.personLabel} · ${c.status === 'inSession' ? 'in session, resume' : formatUntil(c.hearingGame - now.game)}`;
    return line(formatStamp(c.hearingGame), text, attend ? 'caution' : 'none', attend ? { kind: 'attend', id: c.id } : undefined);
  });
  return { id: 'calendar', title: 'Court calendar', lines, empty: 'No hearings scheduled' };
}

function verdictText(c: CourtCase): string {
  if (c.verdict === null) return '';
  return c.reason !== '' ? ` · ${c.verdict} (${c.reason})` : ` · ${c.verdict}`;
}

function verdictSeverity(c: CourtCase): LineSeverity {
  if (c.status === 'missed' || c.reason === 'missed') return 'alert';
  if (c.verdict === 'dismissed') return c.reason === 'suppression' || c.reason === 'unlawfulArrest' ? 'alert' : 'caution';
  if (c.verdict === 'acquitted') return 'caution';
  return 'none';
}

function casesSection(cases: readonly CourtCase[], opts: CareerOptions): CareerSection {
  const lines = cases.slice(0, CAREER_LIST_MAX).map((c) =>
    line(
      c.id,
      `${c.personLabel} · ${c.docKind} ${c.docId} · ${CASE_STATUS_LABELS[c.status] ?? c.status}${verdictText(c)}`,
      verdictSeverity(c),
      c.key !== '' && opts.canReview?.(c.key) === true ? { kind: 'watch', id: c.key } : undefined,
    ),
  );
  return { id: 'cases', title: 'Cases', lines, empty: 'No court cases' };
}

/** Recorded incidents, newest first, each with a read-only REVIEW of its bodycam / dashcam record. */
function incidentsSection(list: readonly CareerIncident[]): CareerSection {
  const lines = list.slice(0, CAREER_LIST_MAX).map((i) =>
    line(
      i.key,
      `${humanize(i.typeId)}${i.district !== '' ? ` · ${districtLabel(i.district)}` : ''} · ${formatStamp(i.game)} · ${i.closed ? 'closed' : 'in progress'}`,
      i.closed ? 'none' : 'caution',
      { kind: 'watch', id: i.key },
    ),
  );
  return { id: 'incidents', title: 'Incident footage', lines, empty: 'No recorded incidents' };
}

function iaLine(c: IaCase): CareerLine {
  const reasons = c.triggers.map((t) => ruleLabel(t.rule)).join(', ');
  const finding = c.finding !== null ? ` · ${FINDING_LABELS[c.finding] ?? c.finding}` : '';
  const text = `${c.key} · ${c.severity} · ${c.status}${finding}${reasons !== '' ? ` · ${reasons}` : ''}`;
  const severity: LineSeverity = c.finding === 'sustained' ? 'alert' : c.status === 'open' ? 'caution' : 'none';
  return line(c.id, text, severity, { kind: 'review', id: c.id });
}

function iaSection(view: CareerView): CareerSection {
  const lines: CareerLine[] = [];
  for (let i = view.ia.length - 1; i >= 0 && lines.length < CAREER_LIST_MAX; i--) lines.push(iaLine(view.ia[i] as IaCase));
  return { id: 'ia', title: 'Internal affairs', lines, empty: 'No internal affairs cases' };
}

/** The Fleet block: points charged, department cost, damage incidents, unreported damage and the last charges (newest first). */
export function fleetSection(fleet: MdtFleetDeps): CareerSection {
  const sum = fleet.summary();
  const charges = fleet
    .charges()
    .filter((c) => c.kind === 'charge')
    .sort((a, b) => b.game - a.game || b.seq - a.seq)
    .slice(0, FLEET_CHARGES_MAX);
  const lines: CareerLine[] = [
    line('Points charged', formatPoints(sum.points), sum.points < 0 ? 'caution' : 'none'),
    line('Department cost', formatMoney(sum.departmentCost)),
    line('Damage incidents', String(sum.incidents)),
    line('Unreported damage', String(sum.unreported), sum.unreported > 0 ? 'alert' : 'none'),
  ];
  if (charges.length === 0) lines.push(line('Charges', 'None'));
  for (const c of charges) {
    lines.push(line(formatStamp(c.game), `${c.unitId} \u00b7 ${c.note} \u00b7 ${formatMoney(c.cost)} \u00b7 ${formatPoints(c.points)} pts`, c.points < 0 ? 'caution' : 'none'));
  }
  return { id: 'fleet', title: 'Fleet', lines, empty: 'No fleet data' };
}

function newestFirst<T>(list: readonly T[], map: (item: T) => CareerLine): CareerLine[] {
  const out: CareerLine[] = [];
  for (let i = list.length - 1; i >= 0 && out.length < CAREER_LIST_MAX; i--) out.push(map(list[i] as T));
  return out;
}

/**
 * The Career tab's sections (design 12.1): duty, record, court calendar, cases, internal affairs, commendations,
 * discipline and the last graded reports. Lists are newest first (the calendar soonest first) and capped.
 */
/** The CAREER section of the Career tab from the Phase 8 career summary lines. */
export function careerSummarySection(lines: readonly MdtCareerSummaryLine[]): CareerSection {
  return {
    id: 'career',
    title: 'CAREER',
    empty: 'No career data',
    lines: lines.map((l) => line(l.label, l.text)),
  };
}

export function careerModel(view: CareerView, cases: readonly CourtCase[], now: CadTime, opts: CareerOptions = {}): CareerModel {
  return {
    sections: [
      ...(opts.summary ? [careerSummarySection(opts.summary)] : []),
      dutySection(view, opts),
      calendarSection(cases, now, opts),
      casesSection(cases, opts),
      ...(opts.incidents ? [incidentsSection(opts.incidents)] : []),
      iaSection(view),
      {
        id: 'commendations',
        title: 'Commendations',
        empty: 'No commendations yet',
        lines: newestFirst(view.commendations, (c) => line(formatStamp(c.game), `${c.label} (${c.key}) +${String(c.points)}`)),
      },
      {
        id: 'discipline',
        title: 'Discipline',
        empty: 'No discipline on file',
        lines: newestFirst(view.discipline, (d) => {
          const extra = d.hours > 0 ? ` ${String(d.hours)} h` : d.amount > 0 ? ` $${String(d.amount)}` : '';
          return line(formatStamp(d.game), `${DISCIPLINE_LABELS[d.action] ?? humanize(d.action)}${extra} (${d.caseId})`, 'caution');
        }),
      },
      {
        id: 'reports',
        title: 'Last reports',
        empty: 'No graded reports yet',
        lines: newestFirst(view.reports, (r) => line(r.docId, `${String(Math.round(r.score))} (${r.letter}) · ${r.key}`, letterSeverity(r.letter))),
      },
      ...(opts.fleet ? [fleetSection(opts.fleet)] : []),
      statsSection(view),
    ],
  };
}

// --- Community ------------------------------------------------------------------------------------

export interface CommunityInput {
  readonly district: string;
  readonly value: number;
  readonly baseline: number;
  readonly trend: number;
}

export type TrendArrow = '▲' | '▼' | '–';

export interface CommunityRow {
  readonly district: string;
  readonly label: string;
  readonly value: number;
  readonly baseline: number;
  readonly trend: number;
  /** '62 %'. */
  readonly percent: string;
  /** Bar fill and baseline marker positions, 0..100. */
  readonly fillPct: number;
  readonly baselinePct: number;
  readonly arrow: TrendArrow;
  /** '+2' / '-1' / '0' percentage points since the last game midnight. */
  readonly trendText: string;
  readonly band: TrustBand;
}

/** Trend that counts as movement. */
export const TREND_EPS = 0.01;

/** "industrialPark" -> "Industrial park". */
export function districtLabel(district: string): string {
  if (district === '') return 'Unknown';
  const label = modDistrictLabel(district);
  return label === district ? humanize(district) : label;
}

function pct(v: number): number {
  return Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v * 100))) : 0;
}

/** Arrow of a trend: ▲ at +0.01 or more, ▼ at -0.01 or less, else a dash. */
export function trendArrow(trend: number): TrendArrow {
  // Compare with a hair of tolerance so 0.01 written as 0.0100000000001 minus noise still counts.
  if (trend >= TREND_EPS - 1e-9) return '▲';
  if (trend <= -TREND_EPS + 1e-9) return '▼';
  return '–';
}

/** One row per district (in the order given): label, bar, baseline marker, trend arrow, percent text, colour band. */
export function communityModel(rows: readonly CommunityInput[]): CommunityRow[] {
  return rows.map((r) => {
    const points = Math.round(r.trend * 100);
    return {
      district: r.district,
      label: districtLabel(r.district),
      value: r.value,
      baseline: r.baseline,
      trend: r.trend,
      percent: `${String(pct(r.value))} %`,
      fillPct: pct(r.value),
      baselinePct: pct(r.baseline),
      arrow: trendArrow(r.trend),
      trendText: points > 0 ? `+${String(points)}` : String(points),
      band: trustBand(r.value),
    };
  });
}

// --- DOM ------------------------------------------------------------------------------------------

export interface CareerHandlers {
  attend(caseId: string): void;
  review(caseId: string): void;
  /** Opens the read-only review of an incident (optional: no button works without it). */
  watch?(key: string): void;
}

/** Replaces `container`'s content with the model: a heading and a label / text list per section, buttons on actions. */
export function renderCareer(container: HTMLElement, model: CareerModel, handlers: CareerHandlers): void {
  clearChildren(container);
  for (const s of model.sections) {
    const list = el('dl', { class: 'mdt-lines' });
    for (const l of s.lines) {
      const value = el('dd', { class: `mdt-sev-${l.severity}` }, el('span', null, l.text));
      const a = l.action;
      if (a) {
        const label = a.kind === 'attend' ? 'ATTEND' : 'REVIEW';
        const act = (): void => {
          if (a.kind === 'attend') handlers.attend(a.id);
          else if (a.kind === 'watch') handlers.watch?.(a.id);
          else handlers.review(a.id);
        };
        const b = button(label, act, 'small primary');
        b.setAttribute('aria-label', `${label} ${a.id}`);
        value.append(' ', b);
      }
      list.append(el('dt', null, l.label), value);
    }
    container.appendChild(
      el('section', { class: `mdt-section mdt-section-${s.id}`, 'aria-label': s.title }, el('h3', null, s.title), s.lines.length > 0 ? list : el('p', { class: 'mdt-hint' }, s.empty)),
    );
  }
}

/** Replaces `container`'s content with one bar row per district. */
export function renderCommunity(container: HTMLElement, rows: readonly CommunityRow[]): void {
  clearChildren(container);
  if (rows.length === 0) {
    container.appendChild(el('p', { class: 'mdt-hint' }, 'No community data'));
    return;
  }
  for (const r of rows) {
    const fill = el('div', { class: `mdt-bar-fill mdt-band-${r.band}` });
    fill.style.width = `${String(r.fillPct)}%`;
    const base = el('div', { class: 'mdt-bar-base', title: `Baseline ${String(r.baselinePct)} %` });
    base.style.left = `${String(r.baselinePct)}%`;
    const bar = el('div', { class: 'mdt-bar', role: 'meter', 'aria-label': `${r.label} trust`, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': r.fillPct }, fill, base);
    container.appendChild(
      el('div', { class: 'mdt-trust-row' },
        el('span', { class: 'mdt-trust-label' }, r.label),
        bar,
        el('span', { class: `mdt-trust-pct mdt-band-${r.band}` }, r.percent),
        el('span', { class: `mdt-trust-trend ${r.arrow === '▲' ? 'mdt-up' : r.arrow === '▼' ? 'mdt-down' : ''}`, title: `${r.trendText} points since midnight` }, r.arrow)),
    );
  }
}
