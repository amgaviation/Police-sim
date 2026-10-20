import { callNumber } from '../cad/cadState';
import type { CadTime } from '../cad/types';
import { createRng } from '../core/rng';
import type { Offense, ReportRecord } from '../legal/types';
import { formatStamp } from '../records/calendar';
import { COURT_CONFIG, type CourtConfig } from './data';
import { generateCrossExam, scoreTestimony } from './crossExam';
import { convictionChance, evidenceStrength, motionRulings, scheduleHearing } from './rulings';
import { MAX_CASES, type CourtSave } from './save';
import type { Answer, CourtCase, CourtDeps, CourtRequest, MotionRuling, TestimonyResult, Verdict } from './types';

import './events';

const MINUTE = 60;

function pad(n: number): string {
  return String(n).padStart(4, '0');
}

function finished(c: CourtCase): boolean {
  return c.verdict !== null;
}

function copyRequest(r: CourtRequest): CourtRequest {
  if (r.kind === 'open') return { ...r, statutes: [...r.statutes] };
  if (r.kind === 'testify') return { ...r, answers: [...r.answers] };
  return { ...r };
}

/**
 * Cases, pleas, subpoenas, hearings and verdicts (design 11.3). Requests are queued by the UI and the integrator
 * bridges and applied at the start of the next `step`. Draws from the injected `court` stream: 2 per case opened,
 * 1 per verdict decided by chance (none when the case is dismissed).
 */
export class CourtState {
  private readonly deps: CourtDeps;
  private readonly cfg: CourtConfig;
  private readonly queue: CourtRequest[] = [];
  private list: CourtCase[] = [];
  private nextId = 1;
  private lastMinute = -1;
  private rev = 0;

  constructor(deps: CourtDeps) {
    this.deps = deps;
    this.cfg = deps.config ?? COURT_CONFIG;
  }

  /** Bumps whenever anything a UI shows changed. */
  get revision(): number {
    return this.rev;
  }

  /** Every case, newest first (the array and cases are live; read them when `revision` changes). */
  cases(): readonly CourtCase[] {
    return this.list;
  }

  case(id: string): CourtCase | null {
    return this.list.find((c) => c.id === id) ?? null;
  }

  /** The soonest scheduled or resumable (in session) hearing that is not yet missed (for the HUD and the calendar). */
  next(game: number): CourtCase | null {
    let best: CourtCase | null = null;
    for (const c of this.list) {
      if ((c.status !== 'scheduled' && c.status !== 'inSession') || c.hearingGame + this.cfg.windowAfterMin * MINUTE < game) continue;
      if (best === null || c.hearingGame < best.hearingGame) best = c;
    }
    return best;
  }

  /**
   * Scheduled and within `[hearing - windowBefore, hearing + windowAfter]`, or in session (a player who left the courtroom
   * resumes the same hearing until the window ends).
   */
  canAttend(id: string, game: number): boolean {
    const c = this.case(id);
    if (c === null) return false;
    if (c.status === 'inSession') return true;
    if (c.status !== 'scheduled') return false;
    return game >= c.hearingGame - this.cfg.windowBeforeMin * MINUTE && game <= c.hearingGame + this.cfg.windowAfterMin * MINUTE;
  }

  request(r: CourtRequest): void {
    this.queue.push(copyRequest(r));
  }

  /** Fixed step (order -656): requests; once per game minute: reminders and missed hearings. */
  step(_dt: number, t: CadTime): void {
    if (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.queue.length);
      for (const r of batch) this.handle(r, t.game);
    }
    const minute = Math.floor(t.game / MINUTE);
    if (minute === this.lastMinute) return;
    this.lastMinute = minute;
    this.perMinute(t.game);
  }

  serialize(): CourtSave {
    return structuredClone({
      version: 1 as const,
      rng: this.deps.rng.state(),
      nextId: this.nextId,
      cases: this.list,
      lastMinute: this.lastMinute,
      queue: this.queue,
    });
  }

  restore(s: CourtSave): void {
    this.deps.rng.restore(s.rng);
    const c = structuredClone(s);
    this.nextId = c.nextId;
    this.list = c.cases;
    this.lastMinute = c.lastMinute;
    this.queue.length = 0;
    this.queue.push(...c.queue);
    this.rev++;
  }

  // --- Requests ----------------------------------------------------------------------------------

  private handle(r: CourtRequest, game: number): void {
    switch (r.kind) {
      case 'open': this.open(r, game); break;
      case 'attend': this.attend(r.caseId, game); break;
      case 'testify': this.testify(r.caseId, r.answers); break;
      case 'advance': this.advance(r.caseId, game); break;
    }
  }

  private flash(text: string): void {
    this.deps.bus.emit('court:flash', { text });
  }

  private open(r: Extract<CourtRequest, { kind: 'open' }>, game: number): void {
    if (this.list.some((c) => c.docId === r.docId)) return;
    const rs = this.deps.ruleset();
    const offenses: string[] = [];
    for (const s of r.statutes) {
      const o = rs.statuteOffense[s];
      if (o !== undefined && !offenses.includes(o)) offenses.push(o);
    }
    const key = this.deps.incidents.keyOfDoc?.(r.docId) ?? (r.callId > 0 ? callNumber(r.callId) : (r.key ?? ''));
    const c: CourtCase = {
      id: `CR-${pad(this.nextId++)}`, docId: r.docId, docKind: r.docKind, personId: r.personId, personLabel: r.personLabel, key,
      callId: r.callId, statutes: [...r.statutes], offenses, createdGame: game, hearingGame: -1, status: 'pending', questions: [],
      motions: [], verdict: null, reason: '', testimony: null, reminded: false,
    };
    // Exactly two draws, whichever branch is taken.
    const u1 = this.deps.rng.next();
    const u2 = this.deps.rng.next();
    this.list.unshift(c);
    this.trim();
    this.rev++;
    // An unlawful arrest or stop, or evidence that is all suppressed, ends the case at once: no plea, payment or hearing.
    const a = this.deps.incidents.assessment(key);
    const motions = a === null ? [] : motionRulings(a, c.personId, c.offenses as Offense[], rs);
    const dismissed = this.dismissal(c, motions);
    if (dismissed !== null) {
      c.motions = motions;
      this.finish(c, 'dismissed', dismissed, 'closed', null, false);
      return;
    }
    if (r.docKind === 'citation') {
      if (u1 < this.cfg.citationContest) this.schedule(c, u2);
      else this.finish(c, 'paid', 'paid', 'closed', null, false);
      return;
    }
    const plea = this.cfg.plea.base + this.cfg.plea.strongBonus * this.maxStrength(c);
    if (u1 < plea) this.finish(c, 'convicted', 'plea', 'pleaded', null, false);
    else this.schedule(c, u2);
  }

  private schedule(c: CourtCase, u: number): void {
    c.hearingGame = scheduleHearing(c.createdGame, u, this.cfg);
    c.status = 'scheduled';
    const label = `Hearing for ${c.personLabel} (${c.id}) ${formatStamp(c.hearingGame)}`;
    this.deps.bus.emit('court:subpoena', { caseId: c.id, hearingGame: c.hearingGame, label });
    this.flash(`Subpoena: ${label}`);
  }

  private attend(id: string, game: number): void {
    const c = this.case(id);
    if (c === null) return;
    if (c.status === 'inSession') {
      // After a load the app has lost its panel: announce the session again.
      this.deps.bus.emit('court:session', { caseId: c.id });
      return;
    }
    if (!this.canAttend(id, game)) {
      this.flash(c.status === 'scheduled' ? `${c.id}: the hearing is not open yet` : `${c.id}: no hearing to attend`);
      return;
    }
    const d = this.deps;
    const a = d.incidents.assessment(c.key);
    const log = d.incidents.log(c.key);
    c.motions = [];
    c.questions = [];
    if (a !== null && log !== null) {
      c.motions = motionRulings(a, c.personId, c.offenses as Offense[], d.ruleset());
      let report: ReportRecord | null = null;
      for (const rep of log.reports) if (report === null || rep.game >= report.game) report = rep;
      const questions = generateCrossExam(
        {
          caseId: c.id, personId: c.personId, log, assessment: a, choices: d.incidents.reportChoices(c.key),
          assertions: report === null ? null : report.assertions,
        },
        createRng(d.seed).stream('court:' + c.id),
        this.cfg,
      );
      c.questions = c.motions.some((m) => m.dismissesCase) ? questions.slice(0, 3) : questions;
    }
    c.status = 'inSession';
    this.rev++;
    d.bus.emit('court:session', { caseId: c.id });
  }

  private testify(id: string, answers: readonly Answer[]): void {
    const c = this.case(id);
    if (c === null || c.status !== 'inSession') return;
    if (answers.length !== c.questions.length) {
      this.flash(`${c.id}: the testimony is incomplete`);
      return;
    }
    const testimony = scoreTestimony(c.questions, answers, this.cfg);
    c.testimony = testimony;
    c.status = 'heard';
    const [verdict, reason] = this.decide(c, testimony.score, false);
    this.finish(c, verdict, reason, 'closed', testimony, false);
  }

  private advance(id: string, game: number): void {
    const c = this.case(id);
    if (c === null || c.status !== 'scheduled') return;
    c.hearingGame = game;
    c.reminded = true;
    this.rev++;
    this.flash(`${c.id}: the hearing is now`);
  }

  // --- Per game minute ---------------------------------------------------------------------------

  private perMinute(game: number): void {
    // Snapshot: a handler may queue requests but never edits the list synchronously.
    for (const c of this.list.slice()) {
      if (c.status !== 'scheduled' && c.status !== 'inSession') continue;
      if (game > c.hearingGame + this.cfg.windowAfterMin * MINUTE) {
        this.miss(c);
      } else if (c.status === 'scheduled' && !c.reminded && game >= c.hearingGame - this.cfg.reminderMin * MINUTE) {
        c.reminded = true;
        this.rev++;
        this.deps.bus.emit('court:reminder', { caseId: c.id, hearingGame: c.hearingGame });
        this.flash(`Court reminder: ${c.id} at ${formatStamp(c.hearingGame)}`);
      }
    }
  }

  private miss(c: CourtCase): void {
    const a = this.deps.incidents.assessment(c.key);
    c.motions = a === null ? [] : motionRulings(a, c.personId, c.offenses as Offense[], this.deps.ruleset());
    const [verdict, reason] = this.decide(c, null, true);
    this.finish(c, verdict, reason, 'missed', null, true);
  }

  // --- Verdicts ----------------------------------------------------------------------------------

  /** Per-offense strengths, or null when the incident is not available. */
  private strengths(c: CourtCase): number[] | null {
    const a = this.deps.incidents.assessment(c.key);
    const log = this.deps.incidents.log(c.key);
    if (a === null || log === null) return null;
    const rs = this.deps.ruleset();
    return c.offenses.map((o) => evidenceStrength(a, log, c.personId, o as Offense, rs));
  }

  /** The strongest offense (0.5 when the incident or the offenses are unknown). */
  private maxStrength(c: CourtCase): number {
    const s = this.strengths(c);
    return s === null || s.length === 0 ? 0.5 : Math.max(...s);
  }

  /** The reason the case is dismissed (a granted dismissal motion, or no admissible evidence left), else null. */
  private dismissal(c: CourtCase, motions: readonly MotionRuling[]): string | null {
    if (motions.some((m) => m.dismissesCase)) return 'unlawfulArrest';
    const s = this.strengths(c);
    return s !== null && s.length > 0 && s.every((x) => x <= 0) ? 'suppression' : null;
  }

  /** Dismissal by motion or by lack of evidence, else one draw against the conviction chance. */
  private decide(c: CourtCase, testimony: number | null, missed: boolean): [Verdict, string] {
    const dismissed = this.dismissal(c, c.motions);
    if (dismissed !== null) return ['dismissed', dismissed];
    const s = this.strengths(c);
    const strength = s === null || s.length === 0 ? 0.5 : Math.max(...s);
    const p = convictionChance(strength, testimony, this.deps.reportGrade(c.key), missed, this.cfg);
    const convicted = this.deps.rng.next() < p;
    if (missed) return [convicted ? 'convicted' : 'acquitted', 'missed'];
    return convicted ? ['convicted', 'proven'] : ['acquitted', 'reasonableDoubt'];
  }

  private finish(
    c: CourtCase, verdict: Verdict, reason: string, status: CourtCase['status'], testimony: TestimonyResult | null, missed: boolean,
  ): void {
    c.verdict = verdict;
    c.reason = reason;
    c.status = status;
    this.rev++;
    this.deps.bus.emit('court:verdict', {
      caseId: c.id, key: c.key, verdict, reason, credibilityDelta: testimony === null ? 0 : testimony.credibilityDelta,
      impeached: testimony !== null && testimony.impeached > 0, missed,
    });
    this.flash(missed ? `${c.id}: hearing missed, ${verdict}` : `${c.id}: ${verdict}`);
  }

  private trim(): void {
    while (this.list.length > MAX_CASES) {
      let drop = this.list.length - 1;
      for (let i = this.list.length - 1; i >= 0; i--) {
        const c = this.list[i];
        if (c !== undefined && finished(c)) {
          drop = i;
          break;
        }
      }
      this.list.splice(drop, 1);
    }
  }
}
