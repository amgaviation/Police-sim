import type { RngState } from '../core/rng';
import { SECONDS_PER_DAY } from '../environment/time';
import { CAREER_CONFIG } from './data';
import { newWellbeing } from './wellbeing';
import {
  ACADEMY_MODULES, BEATS, CAREER_EVENT_KINDS, CAREER_RANKS, CAREER_STAGES, DOR_CATEGORIES, DUTY_ASSIGNMENTS, OFF_DUTY_ACTIVITIES,
  SHIFT_SLOTS, SPECIALTY_IDS, STRESS_EVENTS,
  type AcademyModule, type AcademyRecord, type BidAward, type BidPref, type Bidder, type CareerConfig, type CareerEvent, type CareerRank, type CareerStage,
  type DorCategory, type DorReport, type DutyAssignment, type EligibilityContext, type OffDutyPlanItem, type OffDutyState,
  type PayBreakdown, type ShiftAssignment, type ShiftClock, type ShiftStats, type SpecialtyId, type StressEvent, type Trainee, type Wellbeing,
} from './types';

/** Persisted career state and its requests (Phase 8 design §5.6). */

/** Requests queued by the UI and the bridges; applied at the start of the next career step. */
export type CareerRequest =
  | { kind: 'stress'; event: StressEvent }
  | { kind: 'injury'; amount: number }
  | { kind: 'stat'; key: keyof ShiftStats; delta: number }
  | { kind: 'academyScore'; module: AcademyModule; score: number }
  | { kind: 'graduate' }
  | { kind: 'endShift'; ctx: EligibilityContext; suspended: boolean }
  | { kind: 'submitBid'; prefs: BidPref[] }
  | { kind: 'resolveBids'; bidders: Bidder[] }
  | { kind: 'applySpecialty'; unit: SpecialtyId; ctx: EligibilityContext }
  | { kind: 'applyFto'; ctx: EligibilityContext }
  | { kind: 'returnToPatrol' }
  | { kind: 'promotion'; rank: CareerRank; examScore: number; ctx: EligibilityContext }
  | { kind: 'traineeRating'; ratings: Record<DorCategory, number> };

export interface CareerSave {
  version: 1;
  /** Session stream 'career'. */
  rng: RngState;
  stage: CareerStage;
  rank: CareerRank;
  assignment: DutyAssignment;
  seniorityShifts: number;
  probationShiftsLeft: number;
  probationExtended: boolean;
  academy: Record<AcademyModule, AcademyRecord>;
  wellbeing: Wellbeing;
  money: number;
  lastRentDay: number;
  shift: ShiftClock;
  slot: ShiftAssignment;
  bid: { nextBidShift: number; prefs: BidPref[]; lastAwards: BidAward[] };
  stats: ShiftStats;
  /** Newest last, at most `MAX_PAY`. */
  pay: PayBreakdown[];
  /** Newest last, at most `MAX_DOR` (probation DORs carry the probation's shift number). */
  dor: DorReport[];
  /** Newest last, at most `MAX_HISTORY`. */
  history: CareerEvent[];
  neglect: { daysWithoutFamily: number; daysWithoutExercise: number };
  offDuty: OffDutyState | null;
  trainee: Trainee | null;
  queue: CareerRequest[];
}

export const MAX_PAY = 30;
export const MAX_DOR = 20;
export const MAX_HISTORY = 100;
export const MAX_QUEUE = 512;
const MAX_BIDDERS = 256;
const MAX_PLAN = 64;

/** A zeroed stats block. */
export function emptyShiftStats(): ShiftStats {
  return {
    calls: 0, arrests: 0, reports: 0, reportSum: 0, forceEvents: 0, unjustifiedForce: 0, unlawfulDeterminations: 0, pursuits: 0,
    fleetPoints: 0, trustDelta: 0, courtMinutes: 0, overtimeMinutes: 0,
  };
}

function emptyAcademy(passed: boolean): Record<AcademyModule, AcademyRecord> {
  const out = {} as Record<AcademyModule, AcademyRecord>;
  for (const m of ACADEMY_MODULES) out[m] = { best: -1, attempts: 0, passed };
  return out;
}

/**
 * A fresh career. Stage 'academy' starts off duty with all five modules untried; any other stage starts on duty in shift 1
 * with the academy grandfathered as passed (best -1). Slot night / downtown, `startingMoney`.
 */
export function newCareerSave(
  rng: RngState, opts: { stage: CareerStage; rank?: CareerRank; startGame: number }, cfg: CareerConfig = CAREER_CONFIG,
): CareerSave {
  const onDuty = opts.stage !== 'academy' && opts.stage !== 'separated';
  return {
    version: 1,
    rng,
    stage: opts.stage,
    rank: opts.rank ?? 'officer',
    assignment: 'patrol',
    seniorityShifts: 0,
    probationShiftsLeft: opts.stage === 'probation' ? cfg.probation.shifts : 0,
    probationExtended: false,
    academy: emptyAcademy(opts.stage !== 'academy'),
    wellbeing: newWellbeing(),
    money: cfg.pay.startingMoney,
    lastRentDay: Math.floor(opts.startGame / SECONDS_PER_DAY),
    shift: {
      onDuty, shiftNo: onDuty ? 1 : 0, startGame: opts.startGame, endGame: opts.startGame + cfg.shift.hours * 3600,
      overFlashed: false,
    },
    slot: { slot: 'night', beat: 'downtown' },
    bid: { nextBidShift: cfg.bidding.everyShifts, prefs: [], lastAwards: [] },
    stats: emptyShiftStats(),
    pay: [],
    dor: [],
    history: [],
    neglect: { daysWithoutFamily: 0, daysWithoutExercise: 0 },
    offDuty: null,
    trainee: null,
    queue: [],
  };
}

/** v9 -> v10: a patrol officer, academy grandfathered as passed (best -1), night / downtown, on duty from `nowGame` for 8 h. */
export function legacyCareerSave(rng: RngState, nowGame: number): CareerSave {
  return newCareerSave(rng, { stage: 'patrol', startGame: nowGame });
}

// --- Validation --------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function int(v: unknown): v is number {
  return num(v) && Number.isInteger(v);
}

function nonNeg(v: unknown): v is number {
  return num(v) && v >= 0;
}

function str(v: unknown): v is string {
  return typeof v === 'string';
}

function oneOf<T extends string>(v: unknown, ids: readonly T[]): v is T {
  return typeof v === 'string' && (ids as readonly string[]).includes(v);
}

function unit01(v: unknown): v is number {
  return num(v) && v >= 0 && v <= 1;
}

function isRngState(v: unknown): boolean {
  if (!isRecord(v) || !int(v.seed)) return false;
  const s = v.s;
  return Array.isArray(s) && s.length === 4 && s.every((x) => int(x) && x >= 0 && x < 4294967296);
}

function isWellbeing(v: unknown): v is Wellbeing {
  return (
    isRecord(v) && unit01(v.fatigue) && unit01(v.stress) && unit01(v.health) && unit01(v.fitness) && unit01(v.family) &&
    num(v.sleepDebtH) && v.sleepDebtH >= 0 && v.sleepDebtH <= 24
  );
}

function isAcademy(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return ACADEMY_MODULES.every((m) => {
    const r = v[m];
    return isRecord(r) && num(r.best) && r.best >= -1 && r.best <= 100 && int(r.attempts) && r.attempts >= 0 && typeof r.passed === 'boolean';
  });
}

const STATS_KEYS: readonly (keyof ShiftStats)[] = [
  'calls', 'arrests', 'reports', 'reportSum', 'forceEvents', 'unjustifiedForce', 'unlawfulDeterminations', 'pursuits', 'fleetPoints',
  'trustDelta', 'courtMinutes', 'overtimeMinutes',
];

function isStats(v: unknown): v is ShiftStats {
  return isRecord(v) && STATS_KEYS.every((k) => num(v[k]));
}

/** True for a key of `ShiftStats`. */
export function isStatKey(k: unknown): k is keyof ShiftStats {
  return typeof k === 'string' && (STATS_KEYS as readonly string[]).includes(k);
}

function isShiftClock(v: unknown): v is ShiftClock {
  return isRecord(v) && typeof v.onDuty === 'boolean' && int(v.shiftNo) && v.shiftNo >= 0 && num(v.startGame) && num(v.endGame) && typeof v.overFlashed === 'boolean';
}

function isPref(v: unknown): v is BidPref {
  return isRecord(v) && oneOf(v.slot, SHIFT_SLOTS) && oneOf(v.beat, BEATS);
}

function isAward(v: unknown): v is BidAward {
  return isRecord(v) && str(v.id) && oneOf(v.slot, SHIFT_SLOTS) && oneOf(v.beat, BEATS) && int(v.prefRank) && v.prefRank >= -1;
}

function isPay(v: unknown): v is PayBreakdown {
  return (
    isRecord(v) && int(v.shiftNo) && ['hours', 'base', 'night', 'specialty', 'fto', 'overtime', 'court', 'deductions', 'total'].every((k) => num(v[k]))
  );
}

function scoresOk(v: unknown): v is Record<DorCategory, number> {
  return isRecord(v) && DOR_CATEGORIES.every((c) => num(v[c]));
}

function isDor(v: unknown): v is DorReport {
  return isRecord(v) && int(v.shiftNo) && scoresOk(v.scores) && num(v.average) && Array.isArray(v.notes) && v.notes.every(str);
}

function isEvent(v: unknown): v is CareerEvent {
  return isRecord(v) && num(v.game) && oneOf(v.kind, CAREER_EVENT_KINDS) && str(v.text);
}

function isPlanItem(v: unknown): v is OffDutyPlanItem {
  return isRecord(v) && oneOf(v.activity, OFF_DUTY_ACTIVITIES) && num(v.hours) && v.hours > 0;
}

function isOffDuty(v: unknown): boolean {
  return (
    isRecord(v) && nonNeg(v.hoursLeft) && Array.isArray(v.plan) && v.plan.length <= MAX_PLAN && v.plan.every(isPlanItem) &&
    num(v.nextStartGame) && num(v.nextEndGame)
  );
}

function isTrainee(v: unknown): boolean {
  return isRecord(v) && str(v.name) && isRecord(v.truth) && DOR_CATEGORIES.every((c) => num((v.truth as Record<string, unknown>)[c]));
}

function isCtx(v: unknown): v is EligibilityContext {
  return isRecord(v) && num(v.points) && num(v.credibility) && num(v.sustainedIaRecent) && num(v.avgReport);
}

function isBidder(v: unknown): v is Bidder {
  return (
    isRecord(v) && str(v.id) && str(v.name) && num(v.seniority) && typeof v.probation === 'boolean' && Array.isArray(v.prefs) &&
    v.prefs.length <= 12 && v.prefs.every(isPref)
  );
}

/** Structural check of one queued request (kind, enums, finite numbers, list caps). */
export function isCareerRequest(v: unknown): v is CareerRequest {
  if (!isRecord(v)) return false;
  switch (v.kind) {
    case 'stress': return oneOf(v.event, STRESS_EVENTS);
    case 'injury': return num(v.amount);
    case 'stat': return isStatKey(v.key) && num(v.delta);
    case 'academyScore': return oneOf(v.module, ACADEMY_MODULES) && num(v.score);
    case 'graduate':
    case 'returnToPatrol': return true;
    case 'endShift': return isCtx(v.ctx) && typeof v.suspended === 'boolean';
    case 'submitBid': return Array.isArray(v.prefs) && v.prefs.length <= 12 && v.prefs.every(isPref);
    case 'resolveBids': return Array.isArray(v.bidders) && v.bidders.length <= MAX_BIDDERS && v.bidders.every(isBidder);
    case 'applySpecialty': return oneOf(v.unit, SPECIALTY_IDS) && isCtx(v.ctx);
    case 'applyFto': return isCtx(v.ctx);
    case 'promotion': return oneOf(v.rank, CAREER_RANKS) && num(v.examScore) && isCtx(v.ctx);
    case 'traineeRating': return scoresOk(v.ratings);
    default: return false;
  }
}

/** Full structural check of a persisted career block: every field, enum, finite number, list cap and queue entry. */
export function isCareerSave(x: unknown): x is CareerSave {
  if (!isRecord(x) || x.version !== 1 || !isRngState(x.rng)) return false;
  if (!oneOf(x.stage, CAREER_STAGES) || !oneOf(x.rank, CAREER_RANKS) || !oneOf(x.assignment, DUTY_ASSIGNMENTS)) return false;
  if (!int(x.seniorityShifts) || x.seniorityShifts < 0 || !int(x.probationShiftsLeft) || x.probationShiftsLeft < 0) return false;
  if (typeof x.probationExtended !== 'boolean' || !isAcademy(x.academy) || !isWellbeing(x.wellbeing)) return false;
  if (!num(x.money) || !int(x.lastRentDay) || !isShiftClock(x.shift)) return false;
  if (!isRecord(x.slot) || !oneOf(x.slot.slot, SHIFT_SLOTS) || !oneOf(x.slot.beat, BEATS)) return false;
  const bid = x.bid;
  if (!isRecord(bid) || !int(bid.nextBidShift) || !Array.isArray(bid.prefs) || bid.prefs.length > 12 || !bid.prefs.every(isPref)) return false;
  if (!Array.isArray(bid.lastAwards) || bid.lastAwards.length > MAX_BIDDERS || !bid.lastAwards.every(isAward)) return false;
  if (!isStats(x.stats)) return false;
  if (!Array.isArray(x.pay) || x.pay.length > MAX_PAY || !x.pay.every(isPay)) return false;
  if (!Array.isArray(x.dor) || x.dor.length > MAX_DOR || !x.dor.every(isDor)) return false;
  if (!Array.isArray(x.history) || x.history.length > MAX_HISTORY || !x.history.every(isEvent)) return false;
  const neglect = x.neglect;
  if (!isRecord(neglect) || !int(neglect.daysWithoutFamily) || neglect.daysWithoutFamily < 0) return false;
  if (!int(neglect.daysWithoutExercise) || neglect.daysWithoutExercise < 0) return false;
  if (x.offDuty !== null && !isOffDuty(x.offDuty)) return false;
  if (x.trainee !== null && !isTrainee(x.trainee)) return false;
  return Array.isArray(x.queue) && x.queue.length <= MAX_QUEUE && x.queue.every(isCareerRequest);
}
