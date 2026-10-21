/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call -- tests mutate loosely typed raw JSON */
import { describe, expect, it } from 'vitest';
import careerJson from '../../src/data/career/career.json';
import defensiveJson from '../../src/data/career/defensive.json';
import legalQuizJson from '../../src/data/career/legalQuiz.json';
import reportJson from '../../src/data/career/reportExercises.json';
import specialtiesJson from '../../src/data/career/specialties.json';
import { CRIME_CATEGORIES } from '../../src/environment/crime';
import {
  ACADEMY_MODULES, CAREER_CONFIG, CAREER_RANKS, DEFENSIVE_DRILLS, DEFENSIVE_TIME_LIMIT_S, LEGAL_QUIZ, REPORT_EXERCISES, SPECIALTIES,
  SPECIALTY_IDS, parseCareerConfig, parseDefensive, parseLegalQuiz, parseReportExercises, parseSpecialties,
} from '../../src/career';

type Json = Record<string, any>;
const clone = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;

describe('career.json', () => {
  it('parses to the design values', () => {
    expect(CAREER_CONFIG.academy).toEqual({ pass: { driving: 70, firearms: 75, defensive: 70, report: 70, legal: 70 }, quizQuestions: 10 });
    expect(CAREER_CONFIG.probation).toEqual({ shifts: 5, passAverage: 3, extensionShifts: 3 });
    expect(CAREER_CONFIG.shift).toEqual({
      hours: 8, startHour: { day: 6, swing: 14, night: 22 }, rotation: [1, 1, 1, 1, 1, 0, 0], minRestH: 8, commuteH: 1,
    });
    expect(CAREER_CONFIG.bidding).toEqual({ everyShifts: 10, capacity: 2, maxPrefs: 4, syntheticBidders: 9 });
    expect(CAREER_CONFIG.pay.hourly).toEqual({ officer: 30, corporal: 33, sergeant: 38, lieutenant: 44, captain: 50 });
    expect(CAREER_CONFIG.pay).toMatchObject({ nightPerHour: 2, ftoPerHour: 3, overtimeMultiplier: 1.5, courtMultiplier: 1.5, rentPerWeek: 600, startingMoney: 1500 });
    expect(CAREER_CONFIG.wellbeing.stress.firearmDischarged).toBe(0.2);
    expect(CAREER_CONFIG.wellbeing.activities.secondJob).toEqual({ fatigue: 0.05, stress: 0.02, fitness: 0, family: -0.02, money: 25, sleep: 0, maxPerDay: 8 });
    expect(CAREER_CONFIG.wellbeing.performance).toEqual({ aimFatigue: 0.8, aimStress: 0.6, lagMaxS: 0.25, lagFrom: 0.6, vignetteFrom: 0.7 });
    expect(CAREER_CONFIG.range).toEqual({ targets: 12, noShoot: 3, durationS: 45, radius: 0.06, showS: [1.6, 2.6], swayBase: 0.012 });
    expect(CAREER_CONFIG.fto).toEqual({ minSeniorityShifts: 40, minAvgReport: 70, minPoints: 50, pointsPerAccuracy: 10 });
    expect(CAREER_CONFIG.promotions.captain).toEqual({ minSeniorityShifts: 250, minPoints: 900, exam: 85, maxSustainedIa: 0 });
    expect(Object.keys(CAREER_CONFIG.promotions)).toEqual(CAREER_RANKS.slice(1));
  });

  const bad: [string, (j: Json) => void, RegExp][] = [
    ['version', (j) => { j.version = 2; }, /career\.json: version must be 1/],
    ['missing section', (j) => { delete j.academy; }, /career\.json: academy must be an object/],
    ['pass mark range', (j) => { j.academy.pass.driving = 120; }, /academy\.pass\.driving must be in \[0, 100\]/],
    ['unknown academy module', (j) => { j.academy.pass.flying = 70; }, /academy\.pass\.flying is not a known key/],
    ['missing academy module', (j) => { delete j.academy.pass.legal; }, /academy\.pass\.legal is missing/],
    ['non-integer shifts', (j) => { j.probation.shifts = 2.5; }, /probation\.shifts must be an integer/],
    ['rotation length', (j) => { j.shift.rotation = [1, 1, 1]; }, /shift\.rotation must have at least 7 items/],
    ['rotation value', (j) => { j.shift.rotation[2] = 2; }, /shift\.rotation\[2\]/],
    ['rotation all off', (j) => { j.shift.rotation = [0, 0, 0, 0, 0, 0, 0]; }, /shift\.rotation must contain at least one working day/],
    ['start hour', (j) => { j.shift.startHour.night = 30; }, /shift\.startHour\.night/],
    ['missing slot', (j) => { delete j.shift.startHour.swing; }, /shift\.startHour\.swing is missing/],
    ['stress event', (j) => { delete j.wellbeing.stress.pursuit; }, /wellbeing\.stress\.pursuit is missing/],
    ['stress value', (j) => { j.wellbeing.stress.forceUsed = 'high'; }, /wellbeing\.stress\.forceUsed must be a finite number/],
    ['activity', (j) => { j.wellbeing.activities.rest.maxPerDay = 99; }, /wellbeing\.activities\.rest\.maxPerDay/],
    ['unknown activity', (j) => { j.wellbeing.activities.nap = j.wellbeing.activities.rest; }, /wellbeing\.activities\.nap is not a known key/],
    ['lagFrom', (j) => { j.wellbeing.performance.lagFrom = 1; }, /wellbeing\.performance\.lagFrom/],
    ['range showS', (j) => { j.range.showS = [3, 1]; }, /range\.showS must be \[min, max\]/],
    ['range noShoot', (j) => { j.range.noShoot = 12; }, /range\.noShoot must be less than range\.targets/],
    ['promotion rank', (j) => { delete j.promotions.captain; }, /promotions\.captain is missing/],
    ['pay rank', (j) => { j.pay.hourly.chief = 1; }, /pay\.hourly\.chief is not a known key/],
  ];

  it.each(bad)('rejects bad %s', (_name, mutate, pattern) => {
    const j = clone(careerJson);
    mutate(j);
    expect(() => parseCareerConfig(j, 'career.json')).toThrow(pattern);
  });

  it('rejects a non-object', () => {
    expect(() => parseCareerConfig(null, 'career.json')).toThrow(/career\.json: must be an object/);
  });
});

describe('specialties.json', () => {
  it('has every unit with valid enums', () => {
    expect(Object.keys(SPECIALTIES)).toEqual([...SPECIALTY_IDS]);
    for (const id of SPECIALTY_IDS) {
      const def = SPECIALTIES[id];
      for (const key of Object.keys(def.callWeights)) expect(CRIME_CATEGORIES as readonly string[]).toContain(key);
      for (const key of Object.keys(def.academy)) expect(ACADEMY_MODULES as readonly string[]).toContain(key);
      expect(CAREER_RANKS).toContain(def.minRank);
      expect(def.payPerHour).toBeGreaterThan(0);
    }
    expect(SPECIALTIES.traffic.callWeights).toEqual({ traffic: 3, dui: 2 });
    expect(SPECIALTIES.swat.academy).toEqual({ firearms: 85, defensive: 80 });
    expect(SPECIALTIES.air.minSeniorityShifts).toBe(40);
  });

  const bad: [string, (j: Json) => void, RegExp][] = [
    ['call weight key', (j) => { j.units.k9.callWeights.nope = 2; }, /units\.k9\.callWeights\.nope \(key\) must be one of traffic, dui/],
    ['call weight value', (j) => { j.units.k9.callWeights.theft = -1; }, /units\.k9\.callWeights\.theft must be in \[0, 100\]/],
    ['academy key', (j) => { j.units.swat.academy.flying = 80; }, /units\.swat\.academy\.flying \(key\) must be one of driving, firearms/],
    ['academy score', (j) => { j.units.swat.academy.firearms = 101; }, /units\.swat\.academy\.firearms must be in/],
    ['rank', (j) => { j.units.air.minRank = 'chief'; }, /units\.air\.minRank must be one of officer, corporal/],
    ['missing unit', (j) => { delete j.units.narcotics; }, /units\.narcotics is missing/],
    ['unknown unit', (j) => { j.units.mounted = j.units.air; }, /units\.mounted is not a known key/],
    ['label', (j) => { j.units.traffic.label = ''; }, /units\.traffic\.label must be a non-empty string/],
    ['health', (j) => { j.units.traffic.minHealth = 2; }, /units\.traffic\.minHealth/],
    ['version', (j) => { j.version = 0; }, /specialties\.json: version must be 1/],
  ];

  it.each(bad)('rejects bad %s', (_name, mutate, pattern) => {
    const j = clone(specialtiesJson);
    mutate(j);
    expect(() => parseSpecialties(j, 'specialties.json')).toThrow(pattern);
  });
});

describe('legalQuiz.json', () => {
  it('has enough questions per level with unique ids and valid answers', () => {
    const count = (level: string): number => LEGAL_QUIZ.filter((q) => q.level === level).length;
    expect(count('academy')).toBeGreaterThanOrEqual(30);
    expect(count('sergeant')).toBeGreaterThanOrEqual(12);
    expect(count('lieutenant')).toBeGreaterThanOrEqual(12);
    expect(count('captain')).toBeGreaterThanOrEqual(12);
    expect(new Set(LEGAL_QUIZ.map((q) => q.id)).size).toBe(LEGAL_QUIZ.length);
    for (const q of LEGAL_QUIZ) {
      expect(q.options).toHaveLength(4);
      expect(new Set(q.options).size).toBe(4);
      expect(q.answer).toBeGreaterThanOrEqual(0);
      expect(q.answer).toBeLessThanOrEqual(3);
      expect(q.explain.length).toBeGreaterThan(10);
    }
  });

  it('spreads the right answers over all four positions', () => {
    for (let i = 0; i < 4; i++) expect(LEGAL_QUIZ.filter((q) => q.answer === i).length).toBeGreaterThan(8);
  });

  it('has no real agency or case names', () => {
    const text = JSON.stringify(legalQuizJson).toLowerCase();
    for (const word of ['miranda', 'lapd', 'nypd', 'fbi', 'v.', 'u.s.c', 'terry']) expect(text).not.toContain(word);
  });

  const bad: [string, (j: Json) => void, RegExp][] = [
    ['duplicate id', (j) => { j.questions[1].id = j.questions[0].id; }, /questions\[1\]\.id duplicates/],
    ['answer range', (j) => { j.questions[3].answer = 4; }, /questions\[3\]\.answer must be in \[0, 3\]/],
    ['answer fraction', (j) => { j.questions[3].answer = 1.5; }, /questions\[3\]\.answer must be an integer/],
    ['option count', (j) => { j.questions[2].options.pop(); }, /questions\[2\]\.options must have exactly 4 options, got 3/],
    ['option text', (j) => { j.questions[2].options[1] = ''; }, /questions\[2\]\.options\[1\] must be a non-empty string/],
    ['level', (j) => { j.questions[0].level = 'chief'; }, /questions\[0\]\.level must be one of academy, sergeant/],
    ['too few', (j) => { j.questions = j.questions.filter((q: Json) => q.level !== 'captain').concat(j.questions.filter((q: Json) => q.level === 'captain').slice(0, 5)); }, /must have at least 12 "captain" questions, got 5/],
    ['empty explain', (j) => { j.questions[5].explain = ''; }, /questions\[5\]\.explain/],
    ['version', (j) => { j.version = 3; }, /legalQuiz\.json: version must be 1/],
  ];

  it.each(bad)('rejects bad %s', (_name, mutate, pattern) => {
    const j = clone(legalQuizJson);
    mutate(j);
    expect(() => parseLegalQuiz(j, 'legalQuiz.json')).toThrow(pattern);
  });
});

describe('defensive.json', () => {
  it('has at least 16 drills, each with exactly one correct option', () => {
    expect(DEFENSIVE_TIME_LIMIT_S).toBe(8);
    expect(DEFENSIVE_DRILLS.length).toBeGreaterThanOrEqual(16);
    expect(new Set(DEFENSIVE_DRILLS.map((d) => d.id)).size).toBe(DEFENSIVE_DRILLS.length);
    for (const d of DEFENSIVE_DRILLS) {
      expect(d.options.length).toBeGreaterThanOrEqual(3);
      expect(d.options.length).toBeLessThanOrEqual(4);
      expect(d.options.filter((o) => o.grade === 'correct')).toHaveLength(1);
    }
    for (let i = 0; i < 3; i++) expect(DEFENSIVE_DRILLS.filter((d) => d.options.findIndex((o) => o.grade === 'correct') === i).length).toBeGreaterThanOrEqual(2);
  });

  const bad: [string, (j: Json) => void, RegExp][] = [
    ['two correct', (j) => { j.drills[0].options[0].grade = 'correct'; j.drills[0].options[1].grade = 'correct'; }, /drills\[0\]\.options must have exactly one "correct" option, got 2/],
    ['no correct', (j) => { for (const o of j.drills[4].options) o.grade = 'wrong'; }, /drills\[4\]\.options must have exactly one "correct" option, got 0/],
    ['option count', (j) => { j.drills[1].options = j.drills[1].options.slice(0, 2); }, /drills\[1\]\.options must have 3 or 4 options/],
    ['grade', (j) => { j.drills[2].options[0].grade = 'great'; }, /drills\[2\]\.options\[0\]\.grade must be one of correct, partial, wrong/],
    ['resistance', (j) => { j.drills[2].resistance = 'angry'; }, /drills\[2\]\.resistance must be one of compliant/],
    ['too few', (j) => { j.drills = j.drills.slice(0, 10); }, /drills must have at least 16 items, got 10/],
    ['time limit', (j) => { j.timeLimitS = 0; }, /timeLimitS must be in/],
    ['duplicate', (j) => { j.drills[3].id = j.drills[2].id; }, /drills\[3\]\.id duplicates/],
  ];

  it.each(bad)('rejects bad %s', (_name, mutate, pattern) => {
    const j = clone(defensiveJson);
    mutate(j);
    expect(() => parseDefensive(j, 'defensive.json')).toThrow(pattern);
  });
});

describe('reportExercises.json', () => {
  it('has the six scenarios with 8-12 statements and at least 3 key statements', () => {
    expect(REPORT_EXERCISES.length).toBeGreaterThanOrEqual(6);
    expect(REPORT_EXERCISES.map((e) => e.id)).toEqual(
      expect.arrayContaining(['traffic-stop', 'shoplifting', 'domestic-disturbance', 'burglary', 'collision', 'welfare-check']),
    );
    for (const e of REPORT_EXERCISES) {
      expect(e.statements.length).toBeGreaterThanOrEqual(8);
      expect(e.statements.length).toBeLessThanOrEqual(12);
      expect(e.statements.filter((s) => s.key).length).toBeGreaterThanOrEqual(3);
      for (const s of e.statements) if (s.key) expect(s.truth).toBe(true);
      expect(e.statements.some((s) => !s.truth)).toBe(true);
      expect(e.narrative.length).toBeGreaterThan(0);
      expect(new Set(e.statements.map((s) => s.id)).size).toBe(e.statements.length);
    }
  });

  const bad: [string, (j: Json) => void, RegExp][] = [
    ['key on a false statement', (j) => { const s = j.exercises[0].statements.find((x: Json) => !x.truth); s.key = true; }, /exercises\[0\]\.statements\[\d+\]\.key is only allowed on true statements/],
    ['too few key statements', (j) => { for (const s of j.exercises[1].statements) s.key = false; }, /exercises\[1\]\.statements must have at least 3 key statements, got 0/],
    ['too few statements', (j) => { j.exercises[2].statements = j.exercises[2].statements.slice(0, 7); }, /exercises\[2\]\.statements must have at least 8 items, got 7/],
    ['too many statements', (j) => { const s = j.exercises[2].statements; j.exercises[2].statements = s.concat(s.slice(0, 3).map((x: Json, i: number) => ({ ...x, id: `extra${i}` }))); }, /exercises\[2\]\.statements must have at most 12 statements, got 13/],
    ['truth type', (j) => { j.exercises[0].statements[0].truth = 'yes'; }, /exercises\[0\]\.statements\[0\]\.truth must be true or false/],
    ['duplicate statement id', (j) => { j.exercises[0].statements[1].id = j.exercises[0].statements[0].id; }, /exercises\[0\]\.statements\[1\]\.id duplicates/],
    ['too few exercises', (j) => { j.exercises = j.exercises.slice(0, 5); }, /exercises must have at least 6 items, got 5/],
    ['narrative', (j) => { j.exercises[0].narrative = []; }, /exercises\[0\]\.narrative must have at least 1 items/],
    ['duplicate exercise id', (j) => { j.exercises[1].id = j.exercises[0].id; }, /exercises\[1\]\.id duplicates/],
  ];

  it.each(bad)('rejects %s', (_name, mutate, pattern) => {
    const j = clone(reportJson);
    mutate(j);
    expect(() => parseReportExercises(j, 'reportExercises.json')).toThrow(pattern);
  });
});
