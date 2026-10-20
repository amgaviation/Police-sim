import type { CadTime } from '../cad/types';
import type { LegalAssessment } from '../legal/types';
import { commendationsFor } from './commendations';
import { CONDUCT_CONFIGS, commendationRule, type ConductConfigs } from './data';
import { disciplineFor, iaTriggers, maxSeverity, resolveIa, ruleLabel } from './ia';
import { gradeReport } from './report';
import { newConductSave, type ConductSave } from './save';
import {
  applyTrustDelta, driftTrust, trustBaselines, trustDeltaForIncident, trustEffects, type TrustEffects, type TrustState,
} from './trust';
import type {
  CareerStats, CareerView, Commendation, ConductDeps, ConductRequest, DisciplineAction, DutyStatus, IaCase, IaStatement, ReportGrade,
} from './types';

import './events';

const MINUTE = 60;
const DAY = 86400;
/** Smallest trust change worth announcing. */
const TRUST_EVENT_MIN = 0.005;
const MAX_REPORTS = 50;
const MAX_COMMENDATIONS = 200;

export interface TrustRow {
  district: string;
  value: number;
  baseline: number;
  /** Change since the last game midnight. */
  trend: number;
}

function pad(n: number): string {
  return String(n).padStart(4, '0');
}

/**
 * Report grading, internal affairs, discipline, commendations, community trust and the career record (design 10.3).
 * Requests are queued by the UI and the integrator bridges and applied at the start of the next `step`.
 */
export class ConductState {
  private readonly deps: ConductDeps;
  private readonly cfg: ConductConfigs;
  private readonly baselines = trustBaselines();
  private readonly queue: ConductRequest[] = [];

  private rev = 0;
  private trustState: TrustState = { values: {} };
  private dayAgo: Record<string, number> = {};
  private lastDriftGame = -1;
  private status: DutyStatus = 'active';
  private statusUntil = -1;
  private statusReason = '';
  private points = 0;
  private credibility = 0.85;
  private commendations: Commendation[] = [];
  private discipline: DisciplineAction[] = [];
  private ia: IaCase[] = [];
  private nextIa = 1;
  private reports: ReportGrade[] = [];
  private stats: CareerStats;

  private careerCache: CareerView | null = null;
  private careerRev = -1;
  private rowsCache: TrustRow[] = [];
  private rowsRev = -1;

  constructor(deps: ConductDeps) {
    this.deps = deps;
    this.cfg = { ...CONDUCT_CONFIGS, ...deps.configs };
    this.stats = newConductSave(deps.rng.state()).stats;
    this.apply(newConductSave(deps.rng.state()));
  }

  /** Bumps whenever anything a UI shows changed. */
  get revision(): number {
    return this.rev;
  }

  /** The career record (a new object per revision; the arrays are live). */
  get career(): CareerView {
    if (this.careerCache === null || this.careerRev !== this.rev) {
      this.careerCache = {
        status: this.status, statusUntilGame: this.statusUntil, statusReason: this.statusReason, points: this.points,
        credibility: this.credibility, commendations: this.commendations, discipline: this.discipline, ia: this.ia,
        reports: this.reports, stats: this.stats,
      };
      this.careerRev = this.rev;
    }
    return this.careerCache;
  }

  /** Trust in a district; an unknown district (or '') reads the average over all districts. */
  trust(district: string): number {
    const v = this.trustState.values[district];
    if (v !== undefined) return v;
    const all = Object.values(this.trustState.values);
    return all.length === 0 ? 0.5 : all.reduce((s, x) => s + x, 0) / all.length;
  }

  trustRows(): readonly TrustRow[] {
    if (this.rowsRev !== this.rev) {
      this.rowsCache = [];
      for (const [district, baseline] of this.baselines) {
        const value = this.trustState.values[district] ?? baseline;
        this.rowsCache.push({ district, value, baseline, trend: value - (this.dayAgo[district] ?? value) });
      }
      this.rowsRev = this.rev;
    }
    return this.rowsCache;
  }

  effects(district: string): TrustEffects {
    return trustEffects(this.trust(district), this.cfg.trust);
  }

  /** Duty status at a game time (a suspension that has run out reads as active). */
  dutyStatus(game: number): { status: DutyStatus; untilGame: number; reason: string } {
    if (this.status === 'suspended' && game >= this.statusUntil) return { status: 'active', untilGame: -1, reason: '' };
    return { status: this.status, untilGame: this.statusUntil, reason: this.statusReason };
  }

  reportGrade(docId: string): ReportGrade | null {
    return this.reports.find((r) => r.docId === docId) ?? null;
  }

  iaCase(id: string): IaCase | null {
    return this.ia.find((c) => c.id === id) ?? null;
  }

  request(r: ConductRequest): void {
    this.queue.push(r);
  }

  /** Fixed step (order -658): requests; once per game minute: trust drift, suspension end, IA auto-resolve. */
  step(_dt: number, t: CadTime): void {
    if (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.queue.length);
      for (const r of batch) this.handle(r, t);
    }
    this.perMinute(t);
  }

  serialize(): ConductSave {
    return structuredClone({
      version: 1 as const,
      rng: this.deps.rng.state(),
      trust: this.trustState.values,
      trustDayAgo: this.dayAgo,
      lastDriftGame: this.lastDriftGame,
      status: this.status,
      statusUntilGame: this.statusUntil,
      statusReason: this.statusReason,
      points: this.points,
      credibility: this.credibility,
      commendations: this.commendations,
      discipline: this.discipline,
      ia: this.ia,
      nextIa: this.nextIa,
      reports: this.reports,
      stats: this.stats,
      queue: this.queue,
    });
  }

  restore(s: ConductSave): void {
    this.deps.rng.restore(s.rng);
    this.apply(structuredClone(s));
    this.rev++;
  }

  // --- Internals ---------------------------------------------------------------------------------

  private apply(s: ConductSave): void {
    const values: Record<string, number> = {};
    const dayAgo: Record<string, number> = {};
    for (const [k, base] of this.baselines) {
      values[k] = s.trust[k] ?? base;
      dayAgo[k] = s.trustDayAgo[k] ?? values[k];
    }
    this.trustState = { values };
    this.dayAgo = dayAgo;
    this.lastDriftGame = s.lastDriftGame;
    this.status = s.status;
    this.statusUntil = s.statusUntilGame;
    this.statusReason = s.statusReason;
    this.points = s.points;
    this.credibility = s.credibility;
    this.commendations = s.commendations;
    this.discipline = s.discipline;
    this.ia = s.ia;
    this.nextIa = s.nextIa;
    this.reports = s.reports;
    this.stats = s.stats;
    this.queue.length = 0;
    this.queue.push(...s.queue);
  }

  private handle(r: ConductRequest, t: CadTime): void {
    switch (r.kind) {
      case 'incidentClosed':
        this.incidentClosed(r.key, r.aggressiveLines, t);
        break;
      case 'report':
        this.fileReport(r.key, r.docId, r.assertions, t);
        break;
      case 'iaStatement': {
        const c = this.iaCase(r.caseId);
        if (c && c.status === 'open') this.resolveCase(c, r.statement, t);
        break;
      }
      case 'verdict':
        this.verdict(r, t);
        break;
      case 'trust':
        this.changeTrust(r.district, r.delta, r.reason);
        break;
      case 'reinstate':
        this.setStatus('active', -1, '');
        break;
    }
    this.rev++;
  }

  private changeTrust(district: string, delta: number, reason: string): void {
    if (delta === 0) return;
    applyTrustDelta(this.trustState, district, delta, this.cfg.trust);
    if (Math.abs(delta) >= TRUST_EVENT_MIN) {
      this.deps.bus.emit('conduct:trust', { district, value: this.trust(district), delta, reason });
    }
    this.rev++;
  }

  private setStatus(status: DutyStatus, untilGame: number, reason: string): void {
    this.status = status;
    this.statusUntil = untilGame;
    this.statusReason = reason;
    this.deps.bus.emit('conduct:status', { status, untilGame, reason });
    this.rev++;
  }

  private addCommendation(id: string, key: string, game: number, district: string): void {
    const rule = commendationRule(this.cfg.commendations, id);
    if (!rule) return;
    this.commendations.push({ id, label: rule.label, key, game, points: rule.points });
    if (this.commendations.length > MAX_COMMENDATIONS) this.commendations.splice(0, this.commendations.length - MAX_COMMENDATIONS);
    this.points += rule.points;
    this.deps.bus.emit('conduct:commendation', { id, label: rule.label, key });
    this.changeTrust(district, this.cfg.trust.deltas.commendation, 'commendation');
  }

  private incidentClosed(key: string, aggressiveLines: number, t: CadTime): void {
    const log = this.deps.incidents.log(key);
    const a = this.deps.incidents.assessment(key);
    if (!log || !a) return;
    const district = this.deps.districtOf(key);
    this.changeTrust(district, trustDeltaForIncident(a, log, aggressiveLines, this.cfg.trust, this.cfg.commendations), `incident ${key}`);

    const roll = this.deps.rng.next();
    const triggers = iaTriggers(a, log, this.cfg.ia, roll, this.trust(district), aggressiveLines, (id) => this.deps.injuryOf(id));
    if (triggers.length > 0) {
      const c: IaCase = {
        id: `IA-${pad(this.nextIa++)}`, key, openedGame: t.game, triggers,
        severity: triggers.reduce((s, x) => maxSeverity(s, x.severity), triggers[0]?.severity ?? 'minor'),
        status: 'open', statement: null, finding: null, untruthful: false, discipline: [], closedGame: -1,
      };
      this.ia.push(c);
      this.deps.bus.emit('conduct:ia', { caseId: c.id, key, reasons: triggers.map((x) => ruleLabel(x.rule)) });
    }

    for (const id of commendationsFor(log, a, this.cfg.commendations)) this.addCommendation(id, key, t.game, district);

    this.stats.incidents++;
    for (const p of a.persons) {
      if (p.arrested) this.stats.arrests++;
      if (p.arrested && p.arrestLawful === true) this.stats.lawfulArrests++;
    }
    this.stats.excessiveForce += a.summary.excessiveForce;
  }

  private fileReport(key: string, docId: string, assertions: readonly string[], t: CadTime): void {
    const log = this.deps.incidents.log(key);
    if (!log) return;
    const grade = gradeReport(this.deps.incidents.reportChoices(key), assertions, log, docId, t.game);
    const at = this.reports.findIndex((r) => r.docId === docId);
    const old = at >= 0 ? this.reports[at] : undefined;
    if (at >= 0) this.reports[at] = grade;
    else {
      this.reports.push(grade);
      if (this.reports.length > MAX_REPORTS) this.reports.splice(0, this.reports.length - MAX_REPORTS);
      this.stats.reportsFiled++;
    }
    const n = this.stats.reportsFiled;
    this.stats.avgReport = old ? this.stats.avgReport + (grade.score - old.score) / n : this.stats.avgReport + (grade.score - this.stats.avgReport) / n;
    this.points += this.reportPoints(grade) - (old ? this.reportPoints(old) : 0);
    this.deps.bus.emit('conduct:report', { docId, key, score: grade.score, letter: grade.letter });
    const excellent = commendationRule(this.cfg.commendations, 'excellentReport');
    if (excellent && grade.score >= (excellent.minScore ?? 95) && !this.commendations.some((c) => c.id === 'excellentReport' && c.key === key)) {
      this.addCommendation('excellentReport', key, t.game, this.deps.districtOf(key));
    }
  }

  private reportPoints(g: ReportGrade): number {
    return Math.round((g.score - 70) / 5);
  }

  private verdict(r: Extract<ConductRequest, { kind: 'verdict' }>, t: CadTime): void {
    const d = this.cfg.trust.deltas;
    const district = this.deps.districtOf(r.key);
    this.credibility = Math.min(1, Math.max(0, this.credibility + r.credibilityDelta));
    const convicted = r.verdict === 'convicted';
    if (convicted) {
      this.stats.convictions++;
      this.changeTrust(district, d.conviction, 'conviction');
    }
    if (r.verdict === 'dismissed') {
      this.stats.dismissals++;
      if (r.reason === 'suppression' || r.reason === 'unlawfulArrest') this.changeTrust(district, d.dismissedMisconduct, 'dismissed case');
    }
    if (r.missed) this.changeTrust(district, d.missedCourt, 'missed court');
    if (!convicted) return;
    const clean = commendationRule(this.cfg.commendations, 'cleanCase');
    const grade = this.reports.findLast((g) => g.key === r.key);
    if (clean && grade && grade.score >= (clean.minReport ?? 80)) this.addCommendation('cleanCase', r.key, t.game, district);
    if (!r.impeached && !r.missed) this.addCommendation('credibleTestimony', r.key, t.game, district);
  }

  /** Judges an open case with a statement, applies the discipline and closes it. */
  private resolveCase(c: IaCase, statement: IaStatement, t: CadTime): void {
    const log = this.deps.incidents.log(c.key);
    const a: LegalAssessment | null = this.deps.incidents.assessment(c.key);
    c.statement = statement;
    c.status = 'closed';
    c.closedGame = t.game;
    const district = this.deps.districtOf(c.key);
    if (!log || !a) {
      c.finding = 'exonerated';
      this.deps.bus.emit('conduct:iaResolved', { caseId: c.id, finding: c.finding, discipline: [] });
      this.rev++;
      return;
    }
    const r = resolveIa(c, a, log, statement, this.cfg.ia);
    c.finding = r.finding;
    c.untruthful = r.untruthful;

    let prior = this.ia.filter((x) => x !== c && x.status === 'closed' && x.finding === 'sustained').length;
    if (statement.kind === 'acknowledge') prior = Math.max(0, prior - 1);
    let maxInjury = 0;
    let fatal = false;
    let firearm = false;
    for (const e of log.events) {
      if (e.kind !== 'force' || !e.hit) continue;
      maxInjury = Math.max(maxInjury, e.injury, this.deps.injuryOf(e.personId));
      if (e.fatal) fatal = true;
      if (e.level === 'firearm') firearm = true;
    }
    const actions = disciplineFor(r.finding, c.severity, prior, maxInjury, fatal, firearm, this.cfg.discipline);
    const credibility = this.cfg.discipline.credibility;
    if (r.untruthful) this.credibility += credibility.untruthful;
    if (r.finding === 'sustained') {
      this.credibility += credibility.sustained;
      this.changeTrust(district, this.cfg.trust.deltas.sustainedIa, 'sustained IA finding');
    }
    this.credibility = Math.min(1, Math.max(0, this.credibility));
    for (const action of actions) this.impose(c, { ...action, caseId: c.id, game: t.game }, district);
    this.deps.bus.emit('conduct:iaResolved', { caseId: c.id, finding: r.finding, discipline: c.discipline.map((d) => d.action) });
    this.rev++;
  }

  private impose(c: IaCase, d: DisciplineAction, district: string): void {
    c.discipline.push(d);
    this.discipline.push(d);
    this.points += this.cfg.discipline.points[d.action] ?? 0;
    this.deps.bus.emit('conduct:discipline', { action: d.action, hours: d.hours, amount: d.amount, caseId: d.caseId });
    switch (d.action) {
      case 'suspension':
        if (this.status === 'terminated') break;
        if (this.status === 'suspended' && this.statusUntil > d.game) this.setStatus('suspended', this.statusUntil + d.hours * 3600, `Suspended (${c.id})`);
        else this.setStatus('suspended', d.game + d.hours * 3600, `Suspended (${c.id})`);
        break;
      case 'termination':
        if (this.status !== 'terminated') this.setStatus('terminated', -1, `Terminated (${c.id})`);
        break;
      case 'criminalCharges':
        this.setStatus('terminated', -1, 'Criminal charges filed');
        break;
      case 'civilSuit':
        this.changeTrust(district, this.cfg.trust.deltas.civilSuit, 'civil suit');
        break;
      default:
        break;
    }
  }

  private perMinute(t: CadTime): void {
    const game = t.game;
    if (this.lastDriftGame < 0 || game < this.lastDriftGame) {
      this.lastDriftGame = game;
      return;
    }
    const minutes = Math.floor((game - this.lastDriftGame) / MINUTE);
    if (minutes < 1) return;
    const from = this.lastDriftGame;
    this.lastDriftGame += minutes * MINUTE;
    driftTrust(this.trustState, (minutes * MINUTE) / DAY, this.cfg.trust, this.baselines);
    if (Math.floor(this.lastDriftGame / DAY) > Math.floor(from / DAY)) this.dayAgo = { ...this.trustState.values };
    if (this.status === 'suspended' && game >= this.statusUntil) this.setStatus('active', -1, '');
    const limit = this.cfg.ia.autoResolveH * 3600;
    for (const c of this.ia) if (c.status === 'open' && game - c.openedGame >= limit) this.resolveCase(c, { kind: 'none' }, t);
    this.rev++;
  }
}
