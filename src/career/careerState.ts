import type { EventBus } from '../core/events';
import type { EventMap } from '../core/event-map';
import type { Rng } from '../core/rng';
import { SECONDS_PER_DAY } from '../environment/time';
import type { CadTime } from '../cad/types';
import { nextShiftStart, positionKey, resolveBids, uniformCapacity } from './bidding';
import { CAREER_CONFIG, SPECIALTIES } from './data';
import { payForShift, rentDue } from './pay';
import {
  academyPassed, dorFromStats, ftoEligibility, probationStep, promotionEligibility, rankIndex, rateTrainee, newTrainee,
  recordAcademyScore, specialtyEligibility, type CareerEligibilityInput,
} from './progression';
import {
  emptyShiftStats, isStatKey, newCareerSave, MAX_DOR, MAX_HISTORY, MAX_PAY, type CareerRequest, type CareerSave,
} from './save';
import {
  BEATS, CAREER_RANKS, type Bidder, type BidPref, type CareerConfig, type CareerEvent, type CareerEventKind, type CareerView,
  type DutyAssignment, type OffDutyActivity, type PerformanceMods, type ShiftSummary, type CareerRank, type CareerStage, type DorReport,
} from './types';
import {
  applyActivity, applyIdle, applyInjury, applyNeglect, applyStressEvent, fitForDuty, performanceMods, tickOnDuty,
} from './wellbeing';

/** Career state machine (Phase 8 design §5.6): requests, the per-minute wellbeing tick, off-duty planning and rollover. */

export interface CareerDeps {
  readonly bus: EventBus<EventMap>;
  /** The session stream 'career'. */
  readonly rng: Rng;
  readonly config?: CareerConfig;
  /** Trainee / bidder names (the integrator passes roster officer names). */
  readonly names: readonly string[];
}

const EPS = 1e-9;

function fmtHours(h: number): string {
  return String(Math.round(h * 100) / 100);
}

export class CareerState {
  private readonly deps: CareerDeps;
  private readonly cfg: CareerConfig;
  private save: CareerSave;
  private rev = 1;
  private cached: CareerView | null = null;
  private cachedRev = 0;
  private lastMinute = -1;
  private lastGame: number;
  private emittedStage: CareerStage;
  private emittedRank: CareerRank;
  private emittedAssignment: DutyAssignment;

  constructor(deps: CareerDeps, save?: CareerSave) {
    this.deps = deps;
    this.cfg = deps.config ?? CAREER_CONFIG;
    if (save !== undefined) {
      this.save = structuredClone(save);
      deps.rng.restore(save.rng);
    } else {
      this.save = newCareerSave(deps.rng.state(), { stage: 'academy', startGame: 0 }, this.cfg);
    }
    this.lastGame = this.save.shift.startGame;
    this.emittedStage = this.save.stage;
    this.emittedRank = this.save.rank;
    this.emittedAssignment = this.save.assignment;
  }

  /** Bumped by every change to the state (requests, minute ticks, planning). */
  get revision(): number {
    return this.rev;
  }

  /** Read-only snapshot, cached per revision. */
  get view(): CareerView {
    if (this.cached !== null && this.cachedRev === this.rev) return this.cached;
    const s = this.save;
    const view: CareerView = {
      stage: s.stage, rank: s.rank, assignment: s.assignment, seniorityShifts: s.seniorityShifts,
      probationShiftsLeft: s.probationShiftsLeft, academy: s.academy, wellbeing: s.wellbeing, money: s.money, shift: s.shift,
      slot: s.slot, bid: s.bid, stats: s.stats, pay: s.pay, dor: s.dor, history: s.history, offDuty: s.offDuty, trainee: s.trainee,
      performance: this.performance({ aimSpread: 1, steerLagS: 0, vignette: 0 }),
    };
    this.cached = view;
    this.cachedRev = this.rev;
    return view;
  }

  /** Performance penalties of the current wellbeing, written into `out` (allocation-free). */
  performance(out: PerformanceMods): PerformanceMods {
    return performanceMods(this.save.wellbeing, out, this.cfg.wellbeing);
  }

  /** Queues a request for the next `step` (or `reportForDuty`). */
  request(r: CareerRequest): void {
    this.save.queue.push(r);
  }

  /**
   * Fixed step (-654): drains the requests, then once per game minute (when `floor(t.game / 60)` changed) ticks the
   * wellbeing while on duty and counts overtime after `shift.endGame` (one flash). Never draws random numbers per minute;
   * allocates nothing when the queue is empty.
   */
  step(_dt: number, t: CadTime): void {
    this.lastGame = t.game;
    if (this.save.queue.length > 0) this.drain(t.game);
    const minute = Math.floor(t.game / 60);
    if (minute === this.lastMinute) return;
    const elapsed = this.lastMinute < 0 ? 0 : Math.min(minute - this.lastMinute, 1440);
    this.lastMinute = minute;
    const shift = this.save.shift;
    if (elapsed <= 0 || !shift.onDuty) return;
    tickOnDuty(this.save.wellbeing, elapsed, this.save.slot.slot, this.cfg.wellbeing);
    if (t.game > shift.endGame) {
      this.save.stats.overtimeMinutes += Math.min(elapsed, Math.max(1, minute - Math.floor(shift.endGame / 60)));
      if (!shift.overFlashed) {
        shift.overFlashed = true;
        this.flash('Shift over — return to the station and End shift (overtime counts)');
      }
    }
    this.rev++;
  }

  /**
   * Plans `hours` of an off-duty activity (applied immediately, money included). Needs `hours > 0`, at most the hours left,
   * and at most `maxPerDay` of that activity in total.
   */
  planActivity(a: OffDutyActivity, hours: number): { ok: boolean; reason: string } {
    const od = this.save.offDuty;
    if (od === null) return { ok: false, reason: 'Not off duty' };
    if (!Number.isFinite(hours) || hours <= 0) return { ok: false, reason: 'Hours must be greater than zero' };
    if (hours > od.hoursLeft + EPS) return { ok: false, reason: `Only ${fmtHours(od.hoursLeft)} h left before the next shift` };
    const def = this.cfg.wellbeing.activities[a];
    const planned = od.plan.reduce((sum, p) => (p.activity === a ? sum + p.hours : sum), 0);
    if (planned + hours > def.maxPerDay + EPS) {
      return { ok: false, reason: `At most ${def.maxPerDay} h of ${a} per day (${fmtHours(planned)} h planned)` };
    }
    const r = applyActivity(this.save.wellbeing, a, hours, this.cfg.wellbeing);
    this.save.money += r.moneyDelta;
    od.hoursLeft = Math.max(0, od.hoursLeft - hours);
    const existing = od.plan.find((p) => p.activity === a);
    if (existing === undefined) od.plan.push({ activity: a, hours });
    else existing.hours += hours;
    this.rev++;
    return { ok: true, reason: '' };
  }

  /**
   * Ends the off-duty period: applies queued requests (resolve bids first), idles the hours left, applies the neglect
   * rules and rent, then starts the next shift (shift number + 1, stats reset, a new trainee when assignment 'fto').
   * An officer who is not fit for duty (injured or in critical stress) takes mandatory leave instead: the shift is skipped,
   * a new off-duty period to the following shift opens and `ok` is false with the reason. Returns `fitForDuty`.
   */
  reportForDuty(epochDay: number): { ok: boolean; reason: string } {
    if (this.save.stage === 'separated') return { ok: false, reason: 'Separated from service' };
    if (this.save.queue.length > 0) this.drain(this.lastGame);
    const s = this.save;
    const od = s.offDuty;
    if (od === null) return { ok: false, reason: 'Not off duty' };
    const w = s.wellbeing;
    const wc = this.cfg.wellbeing;
    let sleptH = applyIdle(w, od.hoursLeft, wc);
    let family = false;
    let exercise = false;
    for (const p of od.plan) {
      sleptH += p.hours * wc.activities[p.activity].sleep;
      if (p.activity === 'family') family = true;
      if (p.activity === 'exercise') exercise = true;
    }
    const days = Math.min(3, Math.max(1, Math.round((od.nextStartGame - s.shift.endGame) / SECONDS_PER_DAY)));
    applyNeglect(w, s.neglect, { family, exercise, sleptH, money: s.money, days }, wc);
    const rent = rentDue(s.lastRentDay, epochDay, this.cfg);
    if (rent.amount > 0) {
      s.money -= rent.amount;
      this.log(od.nextStartGame, 'rent', `Rent paid: $${rent.amount} for ${rent.weeks} week${rent.weeks === 1 ? '' : 's'}`);
    }
    s.lastRentDay = Math.max(s.lastRentDay, epochDay);
    // The time between shifts is not on-duty time: the next step restarts the minute clock.
    this.lastMinute = -1;
    const fit = fitForDuty(w, wc);
    if (fit.ok) {
      s.shift = { onDuty: true, shiftNo: s.shift.shiftNo + 1, startGame: od.nextStartGame, endGame: od.nextEndGame, overFlashed: false };
      s.stats = emptyShiftStats();
      s.offDuty = null;
      s.trainee = s.assignment === 'fto' ? newTrainee(this.deps.rng, this.deps.names) : null;
    } else {
      this.log(od.nextStartGame, 'stressLeave', `Shift skipped: ${fit.reason}`);
      s.shift.startGame = od.nextStartGame;
      s.shift.endGame = od.nextEndGame;
      const after = nextShiftStart(od.nextEndGame, s.slot.slot, this.cfg.shift);
      s.offDuty = {
        hoursLeft: Math.max(0, (after.startGame - od.nextEndGame) / 3600 - this.cfg.shift.commuteH), plan: [],
        nextStartGame: after.startGame, nextEndGame: after.endGame,
      };
    }
    this.rev++;
    return fit;
  }

  /** A deep copy of the persisted state (the rng state included). */
  serialize(): CareerSave {
    const out = structuredClone(this.save);
    out.rng = this.deps.rng.state();
    return out;
  }

  /** Replaces the state (a deep copy of `s`) and the career rng state. */
  restore(s: CareerSave): void {
    this.save = structuredClone(s);
    this.deps.rng.restore(s.rng);
    this.lastMinute = -1;
    this.lastGame = s.shift.startGame;
    this.emittedStage = s.stage;
    this.emittedRank = s.rank;
    this.emittedAssignment = s.assignment;
    this.rev++;
  }

  // --- internals ---------------------------------------------------------------------------------

  private flash(text: string): void {
    this.deps.bus.emit('career:flash', { text });
  }

  private log(game: number, kind: CareerEventKind, text: string): CareerEvent {
    const event: CareerEvent = { game, kind, text };
    const h = this.save.history;
    h.push(event);
    if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY);
    return event;
  }

  private syncStage(): void {
    const s = this.save;
    if (s.stage === this.emittedStage && s.rank === this.emittedRank && s.assignment === this.emittedAssignment) return;
    this.emittedStage = s.stage;
    this.emittedRank = s.rank;
    this.emittedAssignment = s.assignment;
    this.deps.bus.emit('career:stage', { stage: s.stage, rank: s.rank, assignment: s.assignment });
  }

  private eligibilityInput(): CareerEligibilityInput {
    const s = this.save;
    return {
      stage: s.stage, rank: s.rank, assignment: s.assignment, seniorityShifts: s.seniorityShifts, academy: s.academy,
      wellbeing: s.wellbeing,
    };
  }

  private drain(game: number): void {
    const queue = this.save.queue;
    this.save.queue = [];
    for (const r of queue) {
      this.apply(r, game);
      this.syncStage();
    }
    this.rev++;
  }

  private apply(r: CareerRequest, game: number): void {
    const s = this.save;
    switch (r.kind) {
      case 'stress':
        applyStressEvent(s.wellbeing, r.event, this.cfg.wellbeing);
        break;
      case 'injury':
        if (Number.isFinite(r.amount)) applyInjury(s.wellbeing, r.amount);
        break;
      case 'stat':
        if (isStatKey(r.key) && Number.isFinite(r.delta)) s.stats[r.key] += r.delta;
        break;
      case 'academyScore':
        if ((s.stage === 'academy' || r.module === 'firearms' || r.module === 'driving') && Number.isFinite(r.score)) {
          s.academy[r.module] = recordAcademyScore(s.academy[r.module], r.module, Math.min(100, Math.max(0, r.score)), this.cfg);
        }
        break;
      case 'graduate':
        this.graduate(game);
        break;
      case 'endShift':
        this.endShift(game, r.suspended);
        break;
      case 'submitBid': {
        const seen = new Set<string>();
        const prefs: BidPref[] = [];
        for (const p of r.prefs) {
          const key = positionKey(p);
          if (seen.has(key) || prefs.length >= this.cfg.bidding.maxPrefs) continue;
          seen.add(key);
          prefs.push({ slot: p.slot, beat: p.beat });
        }
        s.bid.prefs = prefs;
        break;
      }
      case 'resolveBids':
        this.resolveBidRequest(game, r.bidders);
        break;
      case 'applySpecialty': {
        const e = specialtyEligibility(r.unit, this.eligibilityInput(), r.ctx);
        if (e.ok) this.assign(game, r.unit, `Assigned to ${SPECIALTIES[r.unit].label}`);
        else this.flash(e.reasons[0] ?? 'Application refused');
        break;
      }
      case 'applyFto': {
        const e = ftoEligibility(this.eligibilityInput(), r.ctx, this.cfg);
        if (e.ok) this.assign(game, 'fto', 'Assigned as a field training officer');
        else this.flash(e.reasons[0] ?? 'Application refused');
        break;
      }
      case 'returnToPatrol':
        if (s.assignment !== 'patrol') this.assign(game, 'patrol', 'Returned to patrol');
        break;
      case 'promotion':
        this.promote(game, r.rank, r.examScore, r.ctx);
        break;
      case 'traineeRating':
        if (s.assignment === 'fto' && s.trainee !== null) {
          const { accuracy, points } = rateTrainee(r.ratings, s.trainee, this.cfg.fto);
          this.deps.bus.emit('career:points', {
            delta: points, reason: `Trainee evaluation (${Math.round(accuracy * 100)}% accurate)`, key: `fto:${s.shift.shiftNo}`,
          });
          s.trainee = null;
        }
        break;
    }
  }

  private assign(game: number, assignment: DutyAssignment, text: string): void {
    this.save.assignment = assignment;
    this.save.trainee = null;
    this.log(game, 'assigned', text);
  }

  private graduate(game: number): void {
    const s = this.save;
    if (s.stage !== 'academy') return;
    if (!academyPassed(s.academy, this.cfg)) {
      this.flash('Graduation needs every academy module passed');
      return;
    }
    s.stage = 'probation';
    s.probationShiftsLeft = this.cfg.probation.shifts;
    s.probationExtended = false;
    s.slot = { slot: 'night', beat: BEATS[0] };
    s.shift = { onDuty: true, shiftNo: 1, startGame: game, endGame: game + this.cfg.shift.hours * 3600, overFlashed: false };
    s.stats = emptyShiftStats();
    this.log(game, 'graduated', 'Graduated from the academy; probation begins');
    this.flash('Academy complete: probation begins');
  }

  private endShift(game: number, suspended: boolean): void {
    const s = this.save;
    if (!s.shift.onDuty) return;
    const events: CareerEvent[] = [];
    const stageAtStart = s.stage;
    const shiftNo = s.shift.shiftNo;
    const pay = payForShift({
      shiftNo, rank: s.rank, assignment: s.assignment, slot: s.slot.slot, startGame: s.shift.startGame, endGame: s.shift.endGame,
      stats: s.stats, suspended,
    }, this.cfg);
    s.money += pay.total;
    s.pay.push(pay);
    if (s.pay.length > MAX_PAY) s.pay.splice(0, s.pay.length - MAX_PAY);

    let dor: DorReport | null = null;
    if (stageAtStart === 'probation') {
      const p = this.cfg.probation;
      dor = dorFromStats(shiftNo, s.stats);
      s.dor.push(dor);
      if (s.dor.length > MAX_DOR) s.dor.splice(0, s.dor.length - MAX_DOR);
      const done = (s.probationExtended ? p.shifts + p.extensionShifts - s.probationShiftsLeft : p.shifts - s.probationShiftsLeft) + 1;
      const step = probationStep(s.probationShiftsLeft, s.probationExtended, s.dor.slice(-done), p);
      s.probationShiftsLeft = step.left;
      s.probationExtended = step.extended;
      if (step.outcome === 'passed') {
        s.stage = 'patrol';
        events.push(this.log(game, 'probationPassed', 'Probation passed: you are now a patrol officer'));
        this.flash('Probation passed');
      } else if (step.outcome === 'extended') {
        events.push(this.log(game, 'probationExtended', `Probation extended by ${p.extensionShifts} shifts`));
        this.flash(`Probation extended by ${p.extensionShifts} shifts`);
      } else if (step.outcome === 'separated') {
        s.stage = 'separated';
        events.push(this.log(game, 'separated', 'Separated from service after probation'));
        this.flash('Separated from service after probation');
      }
    }
    if (stageAtStart === 'patrol') s.seniorityShifts++;

    s.shift.onDuty = false;
    if (s.stage === 'separated') {
      s.offDuty = null;
    } else {
      const next = nextShiftStart(game, s.slot.slot, this.cfg.shift);
      s.offDuty = {
        hoursLeft: Math.max(0, (next.startGame - game) / 3600 - this.cfg.shift.commuteH), plan: [],
        nextStartGame: next.startGame, nextEndGame: next.endGame,
      };
    }
    this.syncStage();
    const summary: ShiftSummary = {
      shiftNo, pay, dor, stats: { ...s.stats }, events, wellbeing: { ...s.wellbeing },
      nextStartGame: s.offDuty?.nextStartGame ?? game, nextEndGame: s.offDuty?.nextEndGame ?? game,
    };
    this.deps.bus.emit('career:shiftSummary', summary);
  }

  private resolveBidRequest(game: number, others: Bidder[]): void {
    const s = this.save;
    const player: Bidder = {
      id: 'player', name: 'You', seniority: s.seniorityShifts, probation: s.stage !== 'patrol',
      prefs: s.bid.prefs.length > 0 ? s.bid.prefs : [{ slot: s.slot.slot, beat: s.slot.beat }],
    };
    const awards = resolveBids([...others.filter((b) => b.id !== player.id), player], uniformCapacity(this.cfg.bidding.capacity));
    s.bid.lastAwards = awards;
    const mine = awards.find((a) => a.id === player.id);
    if (mine !== undefined) {
      s.slot = { slot: mine.slot, beat: mine.beat };
      const how = mine.prefRank < 0 ? 'fallback position' : `choice ${mine.prefRank + 1}`;
      this.log(game, 'bidAwarded', `Bid awarded: ${mine.slot} shift, ${mine.beat} beat (${how})`);
    } else {
      this.log(game, 'bidAwarded', `No seat available: keeping the ${s.slot.slot} shift, ${s.slot.beat} beat`);
    }
    s.bid.nextBidShift += this.cfg.bidding.everyShifts;
    while (s.bid.nextBidShift <= s.shift.shiftNo) s.bid.nextBidShift += this.cfg.bidding.everyShifts;
  }

  private promote(game: number, target: CareerRank, examScore: number, ctx: Parameters<typeof promotionEligibility>[2]): void {
    const s = this.save;
    const e = promotionEligibility(target, this.eligibilityInput(), ctx, this.cfg);
    if (!e.ok) {
      this.flash(e.reasons[0] ?? 'Promotion refused');
      return;
    }
    if (e.exam > 0 && !(examScore >= e.exam)) {
      this.flash(`Exam score ${Math.round(examScore)} is below the ${e.exam} required`);
      return;
    }
    s.rank = CAREER_RANKS[rankIndex(s.rank) + 1] ?? s.rank;
    this.log(game, 'promoted', `Promoted to ${s.rank}`);
    this.deps.bus.emit('career:points', { delta: 25, reason: 'Promotion', key: `promo:${s.rank}` });
    this.flash(`Promoted to ${s.rank}`);
  }
}
