import type { Rng } from '../core/rng';
import { CAREER_CONFIG, SPECIALTIES } from './data';
import {
  ACADEMY_MODULES, CAREER_RANKS, DOR_CATEGORIES,
  type AcademyModule, type AcademyRecord, type CareerConfig, type CareerRank, type CareerStage, type DorCategory, type DorReport,
  type DutyAssignment, type Eligibility, type EligibilityContext, type ShiftStats, type SpecialtyDef, type SpecialtyId, type Trainee,
  type Wellbeing,
} from './types';

/** Career progression rules (Phase 8 design §5.5). Pure. */

export interface CareerEligibilityInput {
  stage: CareerStage;
  rank: CareerRank;
  assignment: DutyAssignment;
  seniorityShifts: number;
  academy: Readonly<Record<AcademyModule, AcademyRecord>>;
  wellbeing: Readonly<Wellbeing>;
}

const MODULE_LABEL: Readonly<Record<AcademyModule, string>> = {
  driving: 'Driving', firearms: 'Firearms', defensive: 'Defensive tactics', report: 'Report writing', legal: 'Legal',
};

const DOR_LABEL: Readonly<Record<DorCategory, string>> = {
  safety: 'Officer safety', procedure: 'Procedure', reports: 'Report writing', community: 'Community relations', driving: 'Driving',
};

/** Display label of an academy module ('Defensive tactics'). */
export function academyModuleLabel(module: AcademyModule): string {
  return MODULE_LABEL[module];
}

/** Display label of a DOR category ('Report writing'). */
export function dorCategoryLabel(category: DorCategory): string {
  return DOR_LABEL[category];
}

/** True when every academy module is passed. */
export function academyPassed(academy: Readonly<Record<AcademyModule, AcademyRecord>>, _cfg: CareerConfig = CAREER_CONFIG): boolean {
  return ACADEMY_MODULES.every((m) => academy[m].passed);
}

/** Records an attempt: `attempts++`, `best = max(best, score)`, `passed ||= score >= pass[module]`. Returns a new record. */
export function recordAcademyScore(r: AcademyRecord, module: AcademyModule, score: number, cfg: CareerConfig = CAREER_CONFIG): AcademyRecord {
  return { best: Math.max(r.best, score), attempts: r.attempts + 1, passed: r.passed || score >= cfg.academy.pass[module] };
}

/** A shift counts for seniority and probation only when at least this fraction of its scheduled window was worked. */
export const MIN_WORKED_FRACTION = 0.5;

/** True when `workedS` of a `windowS` shift is enough for the shift to count (seniority, probation, DOR). */
export function shiftCounts(workedS: number, windowS: number): boolean {
  return workedS + 1e-9 >= windowS * MIN_WORKED_FRACTION;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function dorRound(v: number): number {
  return clamp(Math.round(v * 2) / 2, 1, 5);
}

/**
 * Daily observation report from a shift's stats: scores 1..5 rounded to 0.5. safety = 5 - 2 x unjustifiedForce - (forceEvents
 * > 3 ? 1 : 0); procedure = 5 - 1.5 x unlawfulDeterminations; reports = 3 without reports else 1 + 4 x average / 100;
 * community = 3 + clamp(trustDelta x 100, -2, 2); driving = 5 + fleetPoints / 10. Notes name every category below 3.
 */
export function dorFromStats(shiftNo: number, s: Readonly<ShiftStats>): DorReport {
  const scores: Record<DorCategory, number> = {
    safety: dorRound(5 - 2 * s.unjustifiedForce - (s.forceEvents > 3 ? 1 : 0)),
    procedure: dorRound(5 - 1.5 * s.unlawfulDeterminations),
    reports: dorRound(s.reports === 0 ? 3 : 1 + (4 * (s.reportSum / s.reports)) / 100),
    community: dorRound(3 + clamp(s.trustDelta * 100, -2, 2)),
    driving: dorRound(5 + s.fleetPoints / 10),
  };
  let sum = 0;
  const notes: string[] = [];
  for (const category of DOR_CATEGORIES) {
    const score = scores[category];
    sum += score;
    if (score < 3) notes.push(`${DOR_LABEL[category]} needs work`);
  }
  return { shiftNo, scores, average: Math.round((sum / DOR_CATEGORIES.length) * 100) / 100, notes };
}

export type ProbationOutcome = 'continue' | 'passed' | 'extended' | 'separated';

/**
 * After a probation shift: `left - 1`; at 0 the average of `dors` (this probation's reports) decides: >= `passAverage` ->
 * 'passed'; else not extended yet -> 'extended' (left = `extensionShifts`) else 'separated'; above 0 -> 'continue'.
 */
export function probationStep(
  left: number, extended: boolean, dors: readonly DorReport[], cfg: CareerConfig['probation'] = CAREER_CONFIG.probation,
): { outcome: ProbationOutcome; left: number; extended: boolean } {
  const remaining = left - 1;
  if (remaining > 0) return { outcome: 'continue', left: remaining, extended };
  const average = dors.length === 0 ? 0 : dors.reduce((sum, d) => sum + d.average, 0) / dors.length;
  if (average >= cfg.passAverage) return { outcome: 'passed', left: 0, extended };
  if (!extended) return { outcome: 'extended', left: cfg.extensionShifts, extended: true };
  return { outcome: 'separated', left: 0, extended: true };
}

/** Index of a rank in `CAREER_RANKS` (0 = officer). */
export function rankIndex(r: CareerRank): number {
  return CAREER_RANKS.indexOf(r);
}

function pct(v: number): number {
  return Math.round(v * 100);
}

function iaReason(max: number, have: number): string {
  return max === 0 ? 'No sustained IA findings allowed' : `At most ${max} sustained IA findings allowed (have ${have})`;
}

/**
 * Every unmet requirement of a specialty unit as a reason text (with the numbers). The officer must be in the 'patrol'
 * stage and not already in the unit.
 */
export function specialtyEligibility(
  unit: SpecialtyId, c: CareerEligibilityInput, ctx: EligibilityContext, defs: Readonly<Record<SpecialtyId, SpecialtyDef>> = SPECIALTIES,
): Eligibility {
  const def = defs[unit];
  const reasons: string[] = [];
  if (c.stage !== 'patrol') reasons.push(`Only patrol officers can apply (current stage: ${c.stage})`);
  if (c.assignment === unit) reasons.push(`Already assigned to ${def.label}`);
  if (c.seniorityShifts < def.minSeniorityShifts) {
    reasons.push(`Needs ${def.minSeniorityShifts} shifts of seniority (have ${c.seniorityShifts})`);
  }
  if (rankIndex(c.rank) < rankIndex(def.minRank)) reasons.push(`Rank ${def.minRank} required (have ${c.rank})`);
  for (const module of ACADEMY_MODULES) {
    const need = def.academy[module];
    if (need === undefined) continue;
    const best = c.academy[module].best;
    if (best < need) reasons.push(`${MODULE_LABEL[module]} score ${need} required (best ${best < 0 ? 'none' : best})`);
  }
  if (ctx.points < def.minPoints) reasons.push(`Career points ${def.minPoints} required (have ${ctx.points})`);
  if (ctx.sustainedIaRecent > def.maxSustainedIa) reasons.push(iaReason(def.maxSustainedIa, ctx.sustainedIaRecent));
  if (c.wellbeing.health < def.minHealth) reasons.push(`Health ${pct(def.minHealth)}% required (have ${pct(c.wellbeing.health)}%)`);
  if (c.wellbeing.fitness < def.minFitness) reasons.push(`Fitness ${pct(def.minFitness)}% required (have ${pct(c.wellbeing.fitness)}%)`);
  return { ok: reasons.length === 0, reasons };
}

/** Field training officer eligibility: stage patrol, seniority, average report grade and career points. */
export function ftoEligibility(c: CareerEligibilityInput, ctx: EligibilityContext, cfg: CareerConfig = CAREER_CONFIG): Eligibility {
  const reasons: string[] = [];
  if (c.stage !== 'patrol') reasons.push(`Only patrol officers can apply (current stage: ${c.stage})`);
  if (c.assignment === 'fto') reasons.push('Already a field training officer');
  if (c.seniorityShifts < cfg.fto.minSeniorityShifts) {
    reasons.push(`Needs ${cfg.fto.minSeniorityShifts} shifts of seniority (have ${c.seniorityShifts})`);
  }
  if (ctx.avgReport < cfg.fto.minAvgReport) {
    reasons.push(`Average report grade ${cfg.fto.minAvgReport} required (have ${Math.round(ctx.avgReport)})`);
  }
  if (ctx.points < cfg.fto.minPoints) reasons.push(`Career points ${cfg.fto.minPoints} required (have ${ctx.points})`);
  return { ok: reasons.length === 0, reasons };
}

/**
 * Promotion to the next rank only (`rankIndex + 1`): seniority, points and sustained IA. `exam` > 0 is the pass mark of
 * the exam the UI must run (0 = none).
 */
export function promotionEligibility(
  target: CareerRank, c: CareerEligibilityInput, ctx: EligibilityContext, cfg: CareerConfig = CAREER_CONFIG,
): Eligibility & { exam: number } {
  const reasons: string[] = [];
  const next = CAREER_RANKS[rankIndex(c.rank) + 1];
  if (next === undefined) return { ok: false, reasons: ['Already at the highest rank'], exam: 0 };
  if (c.stage !== 'patrol') reasons.push(`Only patrol officers can be promoted (current stage: ${c.stage})`);
  if (target !== next) {
    reasons.push(`Only the next rank (${next}) is available`);
    return { ok: false, reasons, exam: 0 };
  }
  const def = cfg.promotions[next as Exclude<CareerRank, 'officer'>];
  if (c.seniorityShifts < def.minSeniorityShifts) {
    reasons.push(`Needs ${def.minSeniorityShifts} shifts of seniority (have ${c.seniorityShifts})`);
  }
  if (ctx.points < def.minPoints) reasons.push(`Career points ${def.minPoints} required (have ${ctx.points})`);
  if (ctx.sustainedIaRecent > def.maxSustainedIa) reasons.push(iaReason(def.maxSustainedIa, ctx.sustainedIaRecent));
  return { ok: reasons.length === 0, reasons, exam: def.exam };
}

/** Accuracy a blind guess (every category 3) earns on average; points count only the accuracy above it. */
export const BLIND_ACCURACY = 0.7;

/**
 * `accuracy = 1 - mean(|rating - truth|) / 4` over the categories; `points = round(max(0, (accuracy - BLIND_ACCURACY) /
 * (1 - BLIND_ACCURACY)) x pointsPerAccuracy)`, so rating without observing earns about nothing.
 */
export function rateTrainee(
  ratings: Readonly<Record<DorCategory, number>>, t: Readonly<Trainee>, cfg: CareerConfig['fto'] = CAREER_CONFIG.fto,
): { accuracy: number; points: number } {
  let sum = 0;
  for (const category of DOR_CATEGORIES) sum += Math.abs(ratings[category] - t.truth[category]);
  const accuracy = 1 - sum / DOR_CATEGORIES.length / 4;
  const above = Math.max(0, (accuracy - BLIND_ACCURACY) / (1 - BLIND_ACCURACY));
  return { accuracy, points: Math.round(above * cfg.pointsPerAccuracy) };
}

/** A trainee with hidden true scores (`rng.nextInt(1, 5)` per DOR category, then the name from `names`). */
export function newTrainee(rng: Rng, names: readonly string[]): Trainee {
  const truth = {} as Record<DorCategory, number>;
  for (const category of DOR_CATEGORIES) truth[category] = rng.nextInt(1, 5);
  return { name: names.length > 0 ? rng.pick(names) : 'Recruit', truth };
}

/** Effects of an assignment: the specialty row, or the patrol / fto defaults. */
export function assignmentEffects(
  a: DutyAssignment, cfg: CareerConfig = CAREER_CONFIG,
): { callWeights: Readonly<Record<string, number>>; fleetClass: string; uniformClass: string; payPerHour: number } {
  if (a === 'patrol') return { callWeights: {}, fleetClass: 'patrol', uniformClass: 'classB', payPerHour: 0 };
  if (a === 'fto') return { callWeights: {}, fleetClass: 'patrol', uniformClass: 'classB', payPerHour: cfg.pay.ftoPerHour };
  const def = SPECIALTIES[a];
  return { callWeights: def.callWeights, fleetClass: def.fleetClass, uniformClass: def.uniformClass, payPerHour: def.payPerHour };
}
