import careerJson from '../data/career/career.json';
import defensiveJson from '../data/career/defensive.json';
import legalQuizJson from '../data/career/legalQuiz.json';
import reportExercisesJson from '../data/career/reportExercises.json';
import specialtiesJson from '../data/career/specialties.json';
import { CRIME_CATEGORIES } from '../environment/crime';
import {
  fail, readArray, readBoolean, readNumber, readObject, readOneOf, readString, readVersion, type JsonObject,
} from '../vehicles/json';
import {
  ACADEMY_MODULES, CAREER_RANKS, DRILL_GRADES, OFF_DUTY_ACTIVITIES, QUIZ_LEVELS, RESISTANCE_LEVELS, SHIFT_SLOTS,
  SPECIALTY_IDS, STRESS_EVENTS,
  type AcademyModule, type ActivityDef, type CareerConfig, type CareerRank, type DefensiveData, type DefensiveDrill,
  type DrillGrade, type PromotionDef, type QuizLevel, type QuizQuestion, type ReportExercise,
  type SpecialtyDef, type SpecialtyId, type WellbeingConfig,
} from './types';

/**
 * Career data (Phase 8 design §5.2): `src/data/career/*.json` validated at import. Every failure throws
 * `Error('<file>: <dotted.path> <problem>')`.
 */

/** Minimum question counts per quiz level. */
export const QUIZ_MINIMUMS: Readonly<Record<QuizLevel, number>> = { academy: 30, sergeant: 12, lieutenant: 12, captain: 12 };

function num(o: JsonObject, key: string, file: string, path: string, min = -Infinity, max = Infinity): number {
  return readNumber(o[key], file, path === '' ? key : `${path}.${key}`, min, max);
}

function int(o: JsonObject, key: string, file: string, path: string, min: number, max: number): number {
  const n = num(o, key, file, path, min, max);
  if (!Number.isInteger(n)) fail(file, path === '' ? key : `${path}.${key}`, `must be an integer, got ${n}`);
  return n;
}

function obj(o: JsonObject, key: string, file: string, path: string): JsonObject {
  return readObject(o[key], file, path === '' ? key : `${path}.${key}`);
}

/** Requires exactly the keys of `ids` (no unknown or missing key) and reads each with `read`. */
function readKeyed<K extends string, V>(
  value: unknown, ids: readonly K[], file: string, path: string, read: (v: unknown, p: string) => V,
): Record<K, V> {
  const o = readObject(value, file, path);
  for (const key of Object.keys(o)) {
    if (!(ids as readonly string[]).includes(key)) fail(file, `${path}.${key}`, `is not a known key (expected ${ids.join(', ')})`);
  }
  const out = {} as Record<K, V>;
  for (const id of ids) {
    if (!(id in o)) fail(file, `${path}.${id}`, 'is missing');
    out[id] = read(o[id], `${path}.${id}`);
  }
  return out;
}

function readNum(min: number, max: number, file: string): (v: unknown, p: string) => number {
  return (v, p) => readNumber(v, file, p, min, max);
}

function readActivity(v: unknown, file: string, path: string): ActivityDef {
  const o = readObject(v, file, path);
  return {
    fatigue: num(o, 'fatigue', file, path, -1, 1),
    stress: num(o, 'stress', file, path, -1, 1),
    fitness: num(o, 'fitness', file, path, -1, 1),
    family: num(o, 'family', file, path, -1, 1),
    money: num(o, 'money', file, path, -1000, 1000),
    sleep: num(o, 'sleep', file, path, 0, 1),
    maxPerDay: num(o, 'maxPerDay', file, path, 0, 24),
  };
}

function readWellbeing(v: unknown, file: string, path: string): WellbeingConfig {
  const o = readObject(v, file, path);
  const idle = obj(o, 'idle', file, path);
  const neglect = obj(o, 'neglect', file, path);
  const perf = obj(o, 'performance', file, path);
  const fit = obj(o, 'fit', file, path);
  const lagFrom = num(perf, 'lagFrom', file, `${path}.performance`, 0, 0.99);
  const vignetteFrom = num(perf, 'vignetteFrom', file, `${path}.performance`, 0, 0.99);
  return {
    fatiguePerHour: num(o, 'fatiguePerHour', file, path, 0, 1),
    slotFactor: readKeyed(o.slotFactor, SHIFT_SLOTS, file, `${path}.slotFactor`, readNum(0, 10, file)),
    sleepDebtFactor: num(o, 'sleepDebtFactor', file, path, 0, 10),
    stressDecayOnDutyPerHour: num(o, 'stressDecayOnDutyPerHour', file, path, 0, 1),
    stress: readKeyed(o.stress, STRESS_EVENTS, file, `${path}.stress`, readNum(-1, 1, file)),
    activities: readKeyed(o.activities, OFF_DUTY_ACTIVITIES, file, `${path}.activities`, (a, p) => readActivity(a, file, p)),
    idle: {
      fatigue: num(idle, 'fatigue', file, `${path}.idle`, -1, 1),
      stress: num(idle, 'stress', file, `${path}.idle`, -1, 1),
      sleep: num(idle, 'sleep', file, `${path}.idle`, 0, 1),
    },
    neglect: {
      familyPerDay: num(neglect, 'familyPerDay', file, `${path}.neglect`, 0, 1),
      familyStressBelow: num(neglect, 'familyStressBelow', file, `${path}.neglect`, 0, 1),
      familyStress: num(neglect, 'familyStress', file, `${path}.neglect`, 0, 1),
      exerciseGraceDays: int(neglect, 'exerciseGraceDays', file, `${path}.neglect`, 0, 365),
      fitnessPerDay: num(neglect, 'fitnessPerDay', file, `${path}.neglect`, 0, 1),
      debtStress: num(neglect, 'debtStress', file, `${path}.neglect`, 0, 1),
      sleepNeedH: num(neglect, 'sleepNeedH', file, `${path}.neglect`, 0, 24),
      healthRecoveryPerDay: num(neglect, 'healthRecoveryPerDay', file, `${path}.neglect`, 0, 1),
    },
    performance: {
      aimFatigue: num(perf, 'aimFatigue', file, `${path}.performance`, 0, 10),
      aimStress: num(perf, 'aimStress', file, `${path}.performance`, 0, 10),
      lagMaxS: num(perf, 'lagMaxS', file, `${path}.performance`, 0, 2),
      lagFrom,
      vignetteFrom,
    },
    fit: { minHealth: num(fit, 'minHealth', file, `${path}.fit`, 0, 1), maxStress: num(fit, 'maxStress', file, `${path}.fit`, 0, 1) },
  };
}

function readPromotion(v: unknown, file: string, path: string): PromotionDef {
  const o = readObject(v, file, path);
  return {
    minSeniorityShifts: int(o, 'minSeniorityShifts', file, path, 0, 100000),
    minPoints: num(o, 'minPoints', file, path, 0, 1e6),
    exam: num(o, 'exam', file, path, 0, 100),
    maxSustainedIa: int(o, 'maxSustainedIa', file, path, 0, 1000),
  };
}

/** Validates `career.json`. */
export function parseCareerConfig(json: unknown, file: string): CareerConfig {
  const root = readObject(json, file, '');
  readVersion(root, file);
  const academy = obj(root, 'academy', file, '');
  const probation = obj(root, 'probation', file, '');
  const shift = obj(root, 'shift', file, '');
  const bidding = obj(root, 'bidding', file, '');
  const pay = obj(root, 'pay', file, '');
  const range = obj(root, 'range', file, '');
  const fto = obj(root, 'fto', file, '');

  const rotation = readArray(shift.rotation, file, 'shift.rotation', 7).map((r, i) => {
    const n = readNumber(r, file, `shift.rotation[${i}]`, 0, 1);
    if (n !== 0 && n !== 1) fail(file, `shift.rotation[${i}]`, `must be 0 or 1, got ${n}`);
    return n;
  });
  if (rotation.length !== 7) fail(file, 'shift.rotation', `must have 7 entries, got ${rotation.length}`);
  if (!rotation.includes(1)) fail(file, 'shift.rotation', 'must contain at least one working day (1)');

  const showS = readArray(range.showS, file, 'range.showS', 2).map((s, i) => readNumber(s, file, `range.showS[${i}]`, 0.1, 60));
  const showLo = showS[0] ?? 0;
  const showHi = showS[1] ?? 0;
  if (showS.length !== 2 || showLo > showHi) fail(file, 'range.showS', `must be [min, max] with min <= max, got ${JSON.stringify(showS)}`);
  const targets = int(range, 'targets', file, 'range', 1, 100);
  const noShoot = int(range, 'noShoot', file, 'range', 0, 100);
  if (noShoot >= targets) fail(file, 'range.noShoot', `must be less than range.targets (${targets}), got ${noShoot}`);
  const durationS = num(range, 'durationS', file, 'range', 5, 600);

  const promotionsJson = obj(root, 'promotions', file, '');
  const promotionRanks = CAREER_RANKS.filter((r): r is Exclude<CareerRank, 'officer'> => r !== 'officer');
  const promotions = readKeyed(promotionsJson, promotionRanks, file, 'promotions', (p, path) => readPromotion(p, file, path));

  return {
    academy: {
      pass: readKeyed(academy.pass, ACADEMY_MODULES, file, 'academy.pass', readNum(0, 100, file)),
      quizQuestions: int(academy, 'quizQuestions', file, 'academy', 1, 30),
    },
    probation: {
      shifts: int(probation, 'shifts', file, 'probation', 1, 100),
      passAverage: num(probation, 'passAverage', file, 'probation', 1, 5),
      extensionShifts: int(probation, 'extensionShifts', file, 'probation', 1, 100),
    },
    shift: {
      hours: num(shift, 'hours', file, 'shift', 1, 24),
      startHour: readKeyed(shift.startHour, SHIFT_SLOTS, file, 'shift.startHour', readNum(0, 23, file)),
      rotation,
      minRestH: num(shift, 'minRestH', file, 'shift', 0, 48),
      commuteH: num(shift, 'commuteH', file, 'shift', 0, 12),
    },
    bidding: {
      everyShifts: int(bidding, 'everyShifts', file, 'bidding', 1, 1000),
      capacity: int(bidding, 'capacity', file, 'bidding', 1, 100),
      maxPrefs: int(bidding, 'maxPrefs', file, 'bidding', 1, 12),
      syntheticBidders: int(bidding, 'syntheticBidders', file, 'bidding', 0, 200),
    },
    pay: {
      hourly: readKeyed(pay.hourly, CAREER_RANKS, file, 'pay.hourly', readNum(0, 1000, file)),
      nightPerHour: num(pay, 'nightPerHour', file, 'pay', 0, 1000),
      ftoPerHour: num(pay, 'ftoPerHour', file, 'pay', 0, 1000),
      overtimeMultiplier: num(pay, 'overtimeMultiplier', file, 'pay', 1, 10),
      courtMultiplier: num(pay, 'courtMultiplier', file, 'pay', 1, 10),
      rentPerWeek: num(pay, 'rentPerWeek', file, 'pay', 0, 1e6),
      startingMoney: num(pay, 'startingMoney', file, 'pay', -1e6, 1e9),
    },
    wellbeing: readWellbeing(root.wellbeing, file, 'wellbeing'),
    range: {
      targets,
      noShoot,
      durationS,
      radius: num(range, 'radius', file, 'range', 0.001, 0.5),
      showS: [showLo, showHi],
      swayBase: num(range, 'swayBase', file, 'range', 0, 1),
    },
    fto: {
      minSeniorityShifts: int(fto, 'minSeniorityShifts', file, 'fto', 0, 100000),
      minAvgReport: num(fto, 'minAvgReport', file, 'fto', 0, 100),
      minPoints: num(fto, 'minPoints', file, 'fto', 0, 1e6),
      pointsPerAccuracy: num(fto, 'pointsPerAccuracy', file, 'fto', 0, 1000),
    },
    promotions,
  };
}

/** Validates `specialties.json`; call weight keys must be `CRIME_CATEGORIES`, academy keys `ACADEMY_MODULES`. */
export function parseSpecialties(json: unknown, file: string): Readonly<Record<SpecialtyId, SpecialtyDef>> {
  const root = readObject(json, file, '');
  readVersion(root, file);
  return readKeyed(root.units, SPECIALTY_IDS, file, 'units', (v, path): SpecialtyDef => {
    const o = readObject(v, file, path);
    const academyJson = obj(o, 'academy', file, path);
    const academy: Partial<Record<AcademyModule, number>> = {};
    for (const key of Object.keys(academyJson)) {
      const module = readOneOf<AcademyModule>(key, ACADEMY_MODULES, file, `${path}.academy.${key} (key)`);
      academy[module] = readNumber(academyJson[key], file, `${path}.academy.${key}`, 0, 100);
    }
    const weightsJson = obj(o, 'callWeights', file, path);
    const callWeights: Record<string, number> = {};
    for (const key of Object.keys(weightsJson)) {
      readOneOf(key, CRIME_CATEGORIES, file, `${path}.callWeights.${key} (key)`);
      callWeights[key] = readNumber(weightsJson[key], file, `${path}.callWeights.${key}`, 0, 100);
    }
    return {
      label: readString(o.label, file, `${path}.label`),
      description: readString(o.description, file, `${path}.description`),
      minSeniorityShifts: int(o, 'minSeniorityShifts', file, path, 0, 100000),
      minRank: readOneOf<CareerRank>(o.minRank, CAREER_RANKS, file, `${path}.minRank`),
      academy,
      minPoints: num(o, 'minPoints', file, path, 0, 1e6),
      maxSustainedIa: int(o, 'maxSustainedIa', file, path, 0, 1000),
      minHealth: num(o, 'minHealth', file, path, 0, 1),
      minFitness: num(o, 'minFitness', file, path, 0, 1),
      payPerHour: num(o, 'payPerHour', file, path, 0, 1000),
      fleetClass: readString(o.fleetClass, file, `${path}.fleetClass`),
      uniformClass: readString(o.uniformClass, file, `${path}.uniformClass`),
      callWeights,
    };
  });
}

/** Validates `legalQuiz.json`: unique ids, 4 options, answer 0..3, and the minimum count per level. */
export function parseLegalQuiz(json: unknown, file: string): QuizQuestion[] {
  const root = readObject(json, file, '');
  readVersion(root, file);
  const seen = new Set<string>();
  const counts: Record<QuizLevel, number> = { academy: 0, sergeant: 0, lieutenant: 0, captain: 0 };
  const questions = readArray(root.questions, file, 'questions', 1).map((v, i): QuizQuestion => {
    const path = `questions[${i}]`;
    const o = readObject(v, file, path);
    const id = readString(o.id, file, `${path}.id`);
    if (seen.has(id)) fail(file, `${path}.id`, `duplicates "${id}"`);
    seen.add(id);
    const level = readOneOf<QuizLevel>(o.level, QUIZ_LEVELS, file, `${path}.level`);
    counts[level]++;
    const options = readArray(o.options, file, `${path}.options`).map((opt, k) => readString(opt, file, `${path}.options[${k}]`));
    if (options.length !== 4) fail(file, `${path}.options`, `must have exactly 4 options, got ${options.length}`);
    const answer = int(o, 'answer', file, path, 0, 3);
    return {
      id, level, topic: readString(o.topic, file, `${path}.topic`), q: readString(o.q, file, `${path}.q`),
      options: [options[0] ?? '', options[1] ?? '', options[2] ?? '', options[3] ?? ''], answer,
      explain: readString(o.explain, file, `${path}.explain`),
    };
  });
  for (const level of QUIZ_LEVELS) {
    if (counts[level] < QUIZ_MINIMUMS[level]) {
      fail(file, 'questions', `must have at least ${QUIZ_MINIMUMS[level]} "${level}" questions, got ${counts[level]}`);
    }
  }
  return questions;
}

/** Validates `defensive.json`: 3-4 options per drill, exactly one "correct". */
export function parseDefensive(json: unknown, file: string): DefensiveData {
  const root = readObject(json, file, '');
  readVersion(root, file);
  const timeLimitS = readNumber(root.timeLimitS, file, 'timeLimitS', 1, 120);
  const seen = new Set<string>();
  const drills = readArray(root.drills, file, 'drills', 16).map((v, i): DefensiveDrill => {
    const path = `drills[${i}]`;
    const o = readObject(v, file, path);
    const id = readString(o.id, file, `${path}.id`);
    if (seen.has(id)) fail(file, `${path}.id`, `duplicates "${id}"`);
    seen.add(id);
    const options = readArray(o.options, file, `${path}.options`).map((opt, k) => {
      const p = `${path}.options[${k}]`;
      const oo = readObject(opt, file, p);
      return { text: readString(oo.text, file, `${p}.text`), grade: readOneOf<DrillGrade>(oo.grade, DRILL_GRADES, file, `${p}.grade`) };
    });
    if (options.length < 3 || options.length > 4) fail(file, `${path}.options`, `must have 3 or 4 options, got ${options.length}`);
    const correct = options.filter((opt) => opt.grade === 'correct').length;
    if (correct !== 1) fail(file, `${path}.options`, `must have exactly one "correct" option, got ${correct}`);
    return {
      id, situation: readString(o.situation, file, `${path}.situation`),
      resistance: readOneOf(o.resistance, RESISTANCE_LEVELS, file, `${path}.resistance`), options,
    };
  });
  return { timeLimitS, drills };
}

/** Validates `reportExercises.json`: 8-12 statements, `key` only on true statements, at least 3 key statements. */
export function parseReportExercises(json: unknown, file: string): ReportExercise[] {
  const root = readObject(json, file, '');
  readVersion(root, file);
  const seen = new Set<string>();
  return readArray(root.exercises, file, 'exercises', 6).map((v, i): ReportExercise => {
    const path = `exercises[${i}]`;
    const o = readObject(v, file, path);
    const id = readString(o.id, file, `${path}.id`);
    if (seen.has(id)) fail(file, `${path}.id`, `duplicates "${id}"`);
    seen.add(id);
    const narrative = readArray(o.narrative, file, `${path}.narrative`, 1).map((p, k) => readString(p, file, `${path}.narrative[${k}]`));
    const statementIds = new Set<string>();
    const statements = readArray(o.statements, file, `${path}.statements`, 8).map((s, k) => {
      const sp = `${path}.statements[${k}]`;
      const so = readObject(s, file, sp);
      const sid = readString(so.id, file, `${sp}.id`);
      if (statementIds.has(sid)) fail(file, `${sp}.id`, `duplicates "${sid}"`);
      statementIds.add(sid);
      const truth = readBoolean(so.truth, file, `${sp}.truth`);
      const key = readBoolean(so.key, file, `${sp}.key`);
      if (key && !truth) fail(file, `${sp}.key`, 'is only allowed on true statements');
      return { id: sid, text: readString(so.text, file, `${sp}.text`), truth, key };
    });
    if (statements.length > 12) fail(file, `${path}.statements`, `must have at most 12 statements, got ${statements.length}`);
    const keys = statements.filter((s) => s.key).length;
    if (keys < 3) fail(file, `${path}.statements`, `must have at least 3 key statements, got ${keys}`);
    return { id, title: readString(o.title, file, `${path}.title`), narrative, statements };
  });
}

export const CAREER_CONFIG: CareerConfig = parseCareerConfig(careerJson, 'career.json');
export const SPECIALTIES: Readonly<Record<SpecialtyId, SpecialtyDef>> = parseSpecialties(specialtiesJson, 'specialties.json');
export const LEGAL_QUIZ: readonly QuizQuestion[] = parseLegalQuiz(legalQuizJson, 'legalQuiz.json');
export const DEFENSIVE_DATA: DefensiveData = parseDefensive(defensiveJson, 'defensive.json');
export const DEFENSIVE_DRILLS: readonly DefensiveDrill[] = DEFENSIVE_DATA.drills;
/** Seconds the player has per defensive tactics drill. */
export const DEFENSIVE_TIME_LIMIT_S: number = DEFENSIVE_DATA.timeLimitS;
export const REPORT_EXERCISES: readonly ReportExercise[] = parseReportExercises(reportExercisesJson, 'reportExercises.json');
