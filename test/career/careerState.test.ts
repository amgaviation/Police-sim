/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- tests mutate loosely typed raw JSON */
import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import {
  ACADEMY_MODULES, CAREER_CONFIG, CareerState, aiBidders, isCareerSave, legacyCareerSave, newCareerSave, performanceMods,
  type Bidder, type CareerRequest, type CareerSave, type PerformanceMods,
} from '../../src/career';
import { DAY, GOOD_CTX, harness, saveAt, stepAt, type Harness } from './helpers';

const H = 3600;
const NIGHT_START = DAY + 22 * H;
const epochDay = (game: number): number => Math.floor(game / DAY);

/** A patrol officer who ended the first night shift on time: off duty with 15 h before the next shift. */
function offDutyHarness(mutate?: (s: CareerSave) => void): Harness {
  const save = saveAt('patrol');
  mutate?.(save);
  const h = harness(save);
  stepAt(h, NIGHT_START);
  h.career.request({ kind: 'endShift', ctx: GOOD_CTX, suspended: false });
  stepAt(h, NIGHT_START + 8 * H);
  return h;
}

describe('new careers', () => {
  it('a default CareerState starts in the academy, off duty, with nothing passed', () => {
    const { career } = harness();
    const v = career.view;
    expect(v.stage).toBe('academy');
    expect(v.shift.onDuty).toBe(false);
    expect(ACADEMY_MODULES.every((m) => v.academy[m].best === -1 && !v.academy[m].passed)).toBe(true);
    expect(v.money).toBe(1500);
    expect(v.probationShiftsLeft).toBe(0);
  });

  it('newCareerSave for a non-academy stage grandfathers the academy and starts shift 1', () => {
    const s = newCareerSave(createRng(1).state(), { stage: 'probation', rank: 'officer', startGame: 12 * H });
    expect(s.probationShiftsLeft).toBe(5);
    expect(s.shift).toEqual({ onDuty: true, shiftNo: 1, startGame: 12 * H, endGame: 20 * H, overFlashed: false });
    expect(ACADEMY_MODULES.every((m) => s.academy[m].passed && s.academy[m].best === -1)).toBe(true);
    expect(isCareerSave(s)).toBe(true);
  });

  it('legacyCareerSave is a patrol officer on a night shift from now', () => {
    const s = legacyCareerSave(createRng(1).state(), 5 * DAY + 3 * H);
    expect(s).toMatchObject({ stage: 'patrol', rank: 'officer', assignment: 'patrol', seniorityShifts: 0, money: 1500 });
    expect(s.slot).toEqual({ slot: 'night', beat: 'downtown' });
    expect(s.shift).toMatchObject({ onDuty: true, startGame: 5 * DAY + 3 * H, endGame: 5 * DAY + 11 * H });
    expect(ACADEMY_MODULES.every((m) => s.academy[m].passed && s.academy[m].best === -1 && s.academy[m].attempts === 0)).toBe(true);
    expect(isCareerSave(s)).toBe(true);
  });

  it('the view is cached per revision', () => {
    const h = harness(saveAt('patrol'));
    const a = h.career.view;
    expect(h.career.view).toBe(a);
    const rev = h.career.revision;
    h.career.request({ kind: 'stat', key: 'calls', delta: 1 });
    expect(h.career.revision).toBe(rev);
    stepAt(h, NIGHT_START);
    expect(h.career.revision).toBeGreaterThan(rev);
    expect(h.career.view).not.toBe(a);
    expect(h.career.view.stats.calls).toBe(1);
  });
});

describe('requests', () => {
  it('stress, injury and stat requests change the state in the next step', () => {
    const h = harness(saveAt('patrol'));
    h.career.request({ kind: 'stress', event: 'firearmDischarged' });
    h.career.request({ kind: 'injury', amount: 0.2 });
    h.career.request({ kind: 'stat', key: 'arrests', delta: 2 });
    h.career.request({ kind: 'stat', key: 'fleetPoints', delta: -5 });
    expect(h.career.view.wellbeing.health).toBe(1);
    stepAt(h, NIGHT_START);
    const w = h.career.view.wellbeing;
    expect(w.health).toBeCloseTo(0.8, 10);
    expect(w.stress).toBeCloseTo(0.15 + 0.2 * (1.2 - 0.12 - 0.14) + 0.1, 10);
    expect(h.career.view.stats.arrests).toBe(2);
    expect(h.career.view.stats.fleetPoints).toBe(-5);
    expect(h.stages).toEqual([]);
  });

  it('academy scores are recorded in the academy and only firearms / driving afterwards', () => {
    const h = harness(saveAt('patrol'));
    h.career.request({ kind: 'academyScore', module: 'firearms', score: 90 });
    h.career.request({ kind: 'academyScore', module: 'legal', score: 90 });
    stepAt(h, NIGHT_START);
    expect(h.career.view.academy.firearms).toEqual({ best: 90, attempts: 1, passed: true });
    expect(h.career.view.academy.legal.attempts).toBe(0);
    const a = harness();
    a.career.request({ kind: 'academyScore', module: 'legal', score: 130 });
    stepAt(a, 0);
    expect(a.career.view.academy.legal).toEqual({ best: 100, attempts: 1, passed: true });
  });

  it('keeps the history within 100 entries, dropping the oldest', () => {
    const h = harness(saveAt('patrol'), []);
    const s = h.career.serialize();
    s.history = Array.from({ length: 100 }, (_, i) => ({ game: i, kind: 'note' as const, text: `n${i}` }));
    h.career.restore(s);
    h.career.request({ kind: 'applyFto', ctx: { ...GOOD_CTX, points: 1 } });
    stepAt(h, NIGHT_START);
    h.career.request({ kind: 'returnToPatrol' });
    stepAt(h, NIGHT_START + 60);
    expect(h.career.view.history).toHaveLength(100);
    expect(h.career.view.history[0]?.text).toBe('n0');
  });
});

describe('academy -> probation -> patrol', () => {
  it('runs a whole early career', () => {
    const h = harness();
    const G0 = 100000;
    for (const module of ['driving', 'firearms', 'defensive', 'report'] as const) {
      h.career.request({ kind: 'academyScore', module, score: 100 });
    }
    h.career.request({ kind: 'graduate' });
    stepAt(h, G0);
    expect(h.career.view.stage).toBe('academy');
    expect(h.flashes).toEqual(['Graduation needs every academy module passed']);

    h.career.request({ kind: 'academyScore', module: 'legal', score: 60 });
    stepAt(h, G0 + 1);
    expect(h.career.view.academy.legal).toEqual({ best: 60, attempts: 1, passed: false });
    h.career.request({ kind: 'academyScore', module: 'legal', score: 70 });
    h.career.request({ kind: 'graduate' });
    stepAt(h, G0 + 2);
    let v = h.career.view;
    expect(v.academy.legal).toEqual({ best: 70, attempts: 2, passed: true });
    expect(v.stage).toBe('probation');
    expect(v.probationShiftsLeft).toBe(5);
    expect(v.slot).toEqual({ slot: 'night', beat: 'downtown' });
    expect(v.shift).toMatchObject({ onDuty: true, shiftNo: 1, startGame: G0 + 2, endGame: G0 + 2 + 8 * H });
    expect(v.history.map((e) => e.kind)).toEqual(['graduated']);
    expect(h.stages).toEqual([{ stage: 'probation', rank: 'officer', assignment: 'patrol' }]);

    for (let shift = 1; shift <= 5; shift++) {
      expect(h.career.view.shift.shiftNo).toBe(shift);
      const end = h.career.view.shift.endGame;
      h.career.request({ kind: 'stat', key: 'calls', delta: 4 });
      h.career.request({ kind: 'stat', key: 'reports', delta: 2 });
      h.career.request({ kind: 'stat', key: 'reportSum', delta: 180 });
      h.career.request({ kind: 'endShift', ctx: GOOD_CTX, suspended: false });
      stepAt(h, end);
      v = h.career.view;
      expect(h.summaries).toHaveLength(shift);
      expect(h.summaries[shift - 1]?.shiftNo).toBe(shift);
      expect(h.summaries[shift - 1]?.dor?.average).toBeGreaterThanOrEqual(3);
      expect(v.shift.onDuty).toBe(false);
      expect(v.offDuty).not.toBeNull();
      expect(v.dor).toHaveLength(shift);
      if (shift < 5) {
        expect(v.stage).toBe('probation');
        expect(v.probationShiftsLeft).toBe(5 - shift);
        const r = h.career.reportForDuty(epochDay(v.offDuty?.nextStartGame ?? 0));
        expect(r.ok).toBe(true);
        stepAt(h, h.career.view.shift.startGame);
      }
    }
    expect(v.stage).toBe('patrol');
    expect(v.seniorityShifts).toBe(0);
    expect(v.history.map((e) => e.kind)).toEqual(['graduated', 'probationPassed']);
    expect(h.stages.at(-1)).toEqual({ stage: 'patrol', rank: 'officer', assignment: 'patrol' });
    expect(h.summaries[4]?.events.map((e) => e.kind)).toEqual(['probationPassed']);
    expect(h.career.reportForDuty(epochDay(v.offDuty?.nextStartGame ?? 0)).ok).toBe(true);
    stepAt(h, h.career.view.shift.startGame);
    expect(h.career.view.shift.shiftNo).toBe(6);

    h.career.request({ kind: 'endShift', ctx: GOOD_CTX, suspended: false });
    stepAt(h, h.career.view.shift.endGame);
    expect(h.career.view.seniorityShifts).toBe(1);
    expect(h.career.view.dor).toHaveLength(5);
    expect(h.career.view.pay).toHaveLength(6);
    // Six night shifts of 256, minus the one week of rent (600) that elapsed during the run.
    expect(h.career.view.money).toBe(1500 + 6 * 256 - 600);
  });

  it('extends a weak probation once and then separates the officer', () => {
    const h = harness(saveAt('probation'));
    let game = NIGHT_START;
    stepAt(h, game);
    const bad = (): void => {
      h.career.request({ kind: 'stat', key: 'unjustifiedForce', delta: 2 });
      h.career.request({ kind: 'stat', key: 'unlawfulDeterminations', delta: 2 });
      h.career.request({ kind: 'endShift', ctx: GOOD_CTX, suspended: false });
      stepAt(h, h.career.view.shift.endGame);
    };
    const next = (): void => {
      expect(h.career.reportForDuty(epochDay(h.career.view.offDuty?.nextStartGame ?? 0)).ok).toBe(true);
      game = h.career.view.shift.startGame;
      stepAt(h, game);
    };
    for (let i = 0; i < 4; i++) {
      bad();
      next();
    }
    bad();
    let v = h.career.view;
    expect(v.stage).toBe('probation');
    expect(v.probationShiftsLeft).toBe(3);
    expect(h.career.serialize().probationExtended).toBe(true);
    expect(v.history.at(-1)?.kind).toBe('probationExtended');
    for (let i = 0; i < 2; i++) {
      next();
      bad();
      expect(h.career.view.stage).toBe('probation');
    }
    next();
    bad();
    v = h.career.view;
    expect(v.stage).toBe('separated');
    expect(v.offDuty).toBeNull();
    expect(v.history.at(-1)?.kind).toBe('separated');
    expect(h.stages.at(-1)?.stage).toBe('separated');
    expect(h.career.reportForDuty(1)).toEqual({ ok: false, reason: 'Separated from service' });
  });
});

describe('shift clock', () => {
  it('ticks fatigue once per game minute while on duty', () => {
    const h = harness(saveAt('patrol'));
    stepAt(h, NIGHT_START);
    expect(h.career.view.wellbeing.fatigue).toBeCloseTo(0.1, 10);
    stepAt(h, NIGHT_START + 30);
    expect(h.career.view.wellbeing.fatigue).toBeCloseTo(0.1, 10);
    stepAt(h, NIGHT_START + H);
    expect(h.career.view.wellbeing.fatigue).toBeCloseTo(0.1 + 0.06 * 1.35 * 0.96, 10);
    expect(h.career.view.wellbeing.stress).toBeCloseTo(0.14, 10);
    const f = h.career.view.wellbeing.fatigue;
    stepAt(h, NIGHT_START + H + 59);
    expect(h.career.view.wellbeing.fatigue).toBe(f);
  });

  it('does not tick off duty', () => {
    const h = harness();
    stepAt(h, 0);
    stepAt(h, 10 * H);
    expect(h.career.view.wellbeing.fatigue).toBeCloseTo(0.1, 10);
  });

  it('counts overtime after endGame with exactly one flash', () => {
    const h = harness(saveAt('patrol'));
    const end = NIGHT_START + 8 * H;
    stepAt(h, NIGHT_START);
    stepAt(h, end);
    stepAt(h, end + 30);
    expect(h.flashes).toEqual([]);
    expect(h.career.view.stats.overtimeMinutes).toBe(0);
    stepAt(h, end + 60);
    expect(h.career.view.stats.overtimeMinutes).toBe(1);
    expect(h.flashes).toEqual(['Shift over — return to the station and End shift (overtime counts)']);
    stepAt(h, end + 120);
    stepAt(h, end + 180);
    expect(h.career.view.stats.overtimeMinutes).toBe(3);
    expect(h.flashes).toHaveLength(1);
    expect(h.career.view.shift.overFlashed).toBe(true);
  });

  it('draws no random numbers while stepping', () => {
    const h = harness(saveAt('patrol'));
    const before = h.career.serialize().rng;
    for (let m = 0; m < 600; m++) stepAt(h, NIGHT_START + m * 60);
    expect(h.career.serialize().rng).toEqual(before);
  });

  it('steps cheaply when idle', () => {
    const h = harness(saveAt('patrol'));
    const t = { sim: 0, game: NIGHT_START };
    h.career.step(0, t);
    const N = 200000;
    const start = performance.now();
    for (let i = 0; i < N; i++) {
      t.game = NIGHT_START + (i % 3000) / 100;
      h.career.step(1 / 60, t);
    }
    expect((performance.now() - start) / N).toBeLessThan(0.005);
  });

  it('performance() follows the wellbeing and is allocation-free', () => {
    const h = harness(saveAt('patrol'));
    const out: PerformanceMods = { aimSpread: 0, steerLagS: 0, vignette: 0 };
    expect(h.career.performance(out)).toBe(out);
    expect(out).toEqual({ aimSpread: 1, steerLagS: 0, vignette: 0 });
    const s = h.career.serialize();
    s.wellbeing.fatigue = 0.9;
    s.wellbeing.stress = 0.8;
    h.career.restore(s);
    h.career.performance(out);
    expect(out.aimSpread).toBeCloseTo(1.5, 10);
    expect(out.steerLagS).toBeCloseTo(0.1875, 10);
    expect(h.career.view.performance).toEqual(performanceMods(s.wellbeing, { aimSpread: 0, steerLagS: 0, vignette: 0 }));
  });
});

describe('end of shift', () => {
  it('pays, opens the off-duty period with the right hours and emits the summary', () => {
    const h = offDutyHarness();
    const v = h.career.view;
    expect(v.money).toBe(1500 + 256);
    expect(v.pay).toHaveLength(1);
    expect(v.shift.onDuty).toBe(false);
    expect(v.offDuty).toEqual({
      hoursLeft: 15, plan: [], nextStartGame: 2 * DAY + 22 * H, nextEndGame: 2 * DAY + 30 * H,
    });
    expect(h.summaries).toHaveLength(1);
    const s = h.summaries[0];
    expect(s).toMatchObject({ shiftNo: 1, dor: null, nextStartGame: 2 * DAY + 22 * H, nextEndGame: 2 * DAY + 30 * H });
    expect(s?.pay).toMatchObject({ base: 240, night: 16, total: 256, hours: 8 });
    expect(s?.wellbeing.fatigue).toBeCloseTo(0.1, 10);
    expect(v.seniorityShifts).toBe(1);
  });

  it('a suspended shift pays only overtime and court time', () => {
    const h = harness(saveAt('patrol'));
    stepAt(h, NIGHT_START);
    h.career.request({ kind: 'stat', key: 'courtMinutes', delta: 60 });
    h.career.request({ kind: 'endShift', ctx: GOOD_CTX, suspended: true });
    stepAt(h, NIGHT_START + 8 * H);
    expect(h.summaries[0]?.pay.total).toBe(45);
    expect(h.career.view.money).toBe(1545);
  });

  it('is ignored when not on duty', () => {
    const h = offDutyHarness();
    h.career.request({ kind: 'endShift', ctx: GOOD_CTX, suspended: false });
    stepAt(h, NIGHT_START + 9 * H);
    expect(h.summaries).toHaveLength(1);
    expect(h.career.view.pay).toHaveLength(1);
  });

  it('caps the pay and dor lists', () => {
    const save = saveAt('probation');
    save.pay = Array.from({ length: 30 }, (_, i) => ({
      shiftNo: i, hours: 8, base: 0, night: 0, specialty: 0, fto: 0, overtime: 0, court: 0, deductions: 0, total: 0,
    }));
    save.dor = Array.from({ length: 20 }, (_, i) => ({
      shiftNo: i, scores: { safety: 3, procedure: 3, reports: 3, community: 3, driving: 3 }, average: 3, notes: [],
    }));
    const h = harness(save);
    stepAt(h, NIGHT_START);
    h.career.request({ kind: 'endShift', ctx: GOOD_CTX, suspended: false });
    stepAt(h, NIGHT_START + 8 * H);
    expect(h.career.view.pay).toHaveLength(30);
    expect(h.career.view.pay[0]?.shiftNo).toBe(1);
    expect(h.career.view.pay.at(-1)?.shiftNo).toBe(1);
    expect(h.career.view.dor).toHaveLength(20);
    expect(h.career.view.dor[0]?.shiftNo).toBe(1);
  });
});

describe('planActivity', () => {
  it('refuses when not off duty', () => {
    const h = harness(saveAt('patrol'));
    expect(h.career.planActivity('rest', 1)).toEqual({ ok: false, reason: 'Not off duty' });
  });

  it('applies the activity immediately and spends the hours', () => {
    const h = offDutyHarness();
    const money = h.career.view.money;
    expect(h.career.planActivity('secondJob', 2)).toEqual({ ok: true, reason: '' });
    expect(h.career.view.money).toBe(money + 50);
    expect(h.career.view.offDuty?.hoursLeft).toBe(13);
    expect(h.career.planActivity('secondJob', 1).ok).toBe(true);
    expect(h.career.view.offDuty?.plan).toEqual([{ activity: 'secondJob', hours: 3 }]);
    expect(h.career.view.wellbeing.family).toBeCloseTo(0.7 - 0.02 * 3, 10);
  });

  it('limits hours: positive, within the hours left, within the per-day cap', () => {
    const h = offDutyHarness();
    expect(h.career.planActivity('rest', 0).ok).toBe(false);
    expect(h.career.planActivity('rest', -2).ok).toBe(false);
    expect(h.career.planActivity('rest', Number.NaN).ok).toBe(false);
    const tooMany = h.career.planActivity('rest', 16);
    expect(tooMany.ok).toBe(false);
    expect(tooMany.reason).toContain('15');
    const cap = h.career.planActivity('exercise', 4);
    expect(cap.ok).toBe(false);
    expect(cap.reason).toContain('At most 3 h');
    expect(h.career.planActivity('exercise', 3).ok).toBe(true);
    const more = h.career.planActivity('exercise', 0.5);
    expect(more.ok).toBe(false);
    expect(more.reason).toContain('3 h planned');
    expect(h.career.planActivity('rest', 12).ok).toBe(true);
    const none = h.career.planActivity('family', 1);
    expect(none.ok).toBe(false);
    expect(none.reason).toContain('0 h left');
    expect(h.career.view.offDuty?.hoursLeft).toBe(0);
  });
});

describe('reportForDuty', () => {
  it('applies the plan, idle, neglect and starts the next shift', () => {
    const h = offDutyHarness();
    h.career.request({ kind: 'stat', key: 'calls', delta: 3 });
    h.career.planActivity('rest', 8);
    h.career.planActivity('family', 3);
    h.career.planActivity('exercise', 2);
    const r = h.career.reportForDuty(2);
    expect(r).toEqual({ ok: true, reason: '' });
    const v = h.career.view;
    expect(v.shift).toEqual({ onDuty: true, shiftNo: 2, startGame: 2 * DAY + 22 * H, endGame: 2 * DAY + 30 * H, overFlashed: false });
    expect(v.offDuty).toBeNull();
    expect(v.stats.calls).toBe(0);
    expect(v.wellbeing.fitness).toBeCloseTo(0.66, 10);
    expect(v.wellbeing.family).toBeCloseTo(0.94, 10);
    expect(v.wellbeing.fatigue).toBe(0);
    expect(v.wellbeing.sleepDebtH).toBe(0);
    expect(v.trainee).toBeNull();
    expect(h.career.serialize().neglect).toEqual({ daysWithoutFamily: 0, daysWithoutExercise: 0 });
  });

  it('applies the neglect rules and tracks sleep debt when nothing is planned', () => {
    const h = offDutyHarness();
    expect(h.career.reportForDuty(2).ok).toBe(true);
    const v = h.career.view;
    expect(v.wellbeing.family).toBeCloseTo(0.65, 10);
    expect(v.wellbeing.sleepDebtH).toBeCloseTo(0.5, 10);
    expect(v.wellbeing.fatigue).toBe(0);
    expect(v.wellbeing.stress).toBeCloseTo(0.15 - 0.005 * 15, 10);
    expect(h.career.serialize().neglect).toEqual({ daysWithoutFamily: 1, daysWithoutExercise: 1 });
  });

  it('charges rent when the week number advanced', () => {
    const h = offDutyHarness();
    const money = h.career.view.money;
    expect(h.career.reportForDuty(7).ok).toBe(true);
    expect(h.career.view.money).toBe(money - 600);
    expect(h.career.view.history.at(-1)).toMatchObject({ kind: 'rent' });
    expect(h.career.view.history.at(-1)?.text).toContain('$600');
    expect(h.career.serialize().lastRentDay).toBe(7);
  });

  it('negative money adds debt stress', () => {
    const broke = offDutyHarness((s) => {
      s.money = -5000;
    });
    const fine = offDutyHarness();
    broke.career.reportForDuty(2);
    fine.career.reportForDuty(2);
    expect(broke.career.view.wellbeing.stress - fine.career.view.wellbeing.stress).toBeCloseTo(0.05, 10);
  });

  it('refuses when not off duty', () => {
    const h = harness(saveAt('patrol'));
    expect(h.career.reportForDuty(2)).toEqual({ ok: false, reason: 'Not off duty' });
  });

  it('an unfit officer takes mandatory leave and the shift is skipped', () => {
    const h = offDutyHarness();
    h.career.request({ kind: 'injury', amount: 0.8 });
    const r = h.career.reportForDuty(2);
    expect(r).toEqual({ ok: false, reason: 'Injured: light duty' });
    const v = h.career.view;
    expect(v.shift.onDuty).toBe(false);
    expect(v.shift.shiftNo).toBe(1);
    expect(v.history.at(-1)?.kind).toBe('stressLeave');
    expect(v.offDuty).toEqual({ hoursLeft: 15, plan: [], nextStartGame: 3 * DAY + 22 * H, nextEndGame: 3 * DAY + 30 * H });
    h.career.planActivity('rest', 12);
    // Health recovers 0.05 per period; a few periods of leave bring the officer back.
    let ok = false;
    for (let i = 0; i < 6 && !ok; i++) {
      ok = h.career.reportForDuty(3 + i).ok;
    }
    expect(ok).toBe(true);
    expect(h.career.view.shift.onDuty).toBe(true);
    expect(h.career.view.shift.shiftNo).toBe(2);
  });

  it('does not count the off-duty gap as on-duty time in the next step', () => {
    const h = offDutyHarness();
    h.career.planActivity('rest', 12);
    h.career.reportForDuty(2);
    const fatigue = h.career.view.wellbeing.fatigue;
    stepAt(h, h.career.view.shift.startGame);
    expect(h.career.view.wellbeing.fatigue).toBe(fatigue);
  });

  it('creates a trainee for an FTO assignment', () => {
    const h = offDutyHarness((s) => {
      s.assignment = 'fto';
    });
    expect(h.career.reportForDuty(2).ok).toBe(true);
    const t = h.career.view.trainee;
    expect(t).not.toBeNull();
    expect(['Avery', 'Blake', 'Casey']).toContain(t?.name);
  });
});

describe('bidding', () => {
  const bidder = (id: string, seniority: number, prefs: string[]): Bidder => ({
    id, name: id, seniority, probation: false,
    prefs: prefs.map((p) => {
      const [slot, beat] = p.split(':');
      return { slot: slot as 'day', beat: beat as 'downtown' };
    }),
  });

  it('stores up to maxPrefs unique preferences', () => {
    const h = harness(saveAt('patrol'));
    h.career.request({
      kind: 'submitBid',
      prefs: [
        { slot: 'day', beat: 'downtown' }, { slot: 'day', beat: 'downtown' }, { slot: 'swing', beat: 'suburbs' },
        { slot: 'night', beat: 'highway' }, { slot: 'night', beat: 'industrial' }, { slot: 'day', beat: 'highway' },
      ],
    });
    stepAt(h, NIGHT_START);
    expect(h.career.view.bid.prefs).toHaveLength(4);
    expect(h.career.view.bid.prefs.map((p) => `${p.slot}:${p.beat}`)).toEqual(['day:downtown', 'swing:suburbs', 'night:highway', 'night:industrial']);
  });

  it('resolves the player against the other bidders by seniority', () => {
    const save = saveAt('patrol');
    save.shift.shiftNo = 10;
    const h = harness(save);
    h.career.request({ kind: 'submitBid', prefs: [{ slot: 'day', beat: 'downtown' }, { slot: 'swing', beat: 'suburbs' }] });
    h.career.request({
      kind: 'resolveBids',
      bidders: [
        bidder('B1', 300, ['day:downtown']), bidder('B2', 200, ['day:downtown']), bidder('B3', 100, ['day:downtown']),
      ],
    });
    stepAt(h, NIGHT_START);
    const v = h.career.view;
    expect(v.slot).toEqual({ slot: 'swing', beat: 'suburbs' });
    expect(v.bid.lastAwards.map((a) => [a.id, a.slot, a.beat, a.prefRank])).toEqual([
      ['B1', 'day', 'downtown', 0], ['B2', 'day', 'downtown', 0], ['B3', 'day', 'suburbs', -1], ['player', 'swing', 'suburbs', 1],
    ]);
    expect(v.bid.nextBidShift).toBe(20);
    expect(v.history.at(-1)).toMatchObject({ kind: 'bidAwarded' });
    expect(v.history.at(-1)?.text).toContain('swing');
  });

  it('without prefs the player keeps the current slot when seats allow, and bids with AI officers', () => {
    const h = harness(saveAt('patrol'));
    const ai = aiBidders(9, [{ id: 'A-1', name: 'Lee' }], ['Pat', 'Sam']);
    h.career.request({ kind: 'resolveBids', bidders: ai });
    stepAt(h, NIGHT_START);
    expect(h.career.view.bid.lastAwards).toHaveLength(ai.length + 1);
    const mine = h.career.view.bid.lastAwards.find((a) => a.id === 'player');
    expect(mine).toBeDefined();
    expect(h.career.view.slot).toEqual({ slot: mine?.slot, beat: mine?.beat });
    expect(h.career.view.bid.nextBidShift).toBe(10 + CAREER_CONFIG.bidding.everyShifts);
  });

  it('a probationer bids last', () => {
    const h = harness(saveAt('probation'));
    h.career.request({ kind: 'submitBid', prefs: [{ slot: 'day', beat: 'downtown' }] });
    const full = ['B1', 'B2'].map((id, i) => bidder(id, 100 - i, ['day:downtown']));
    h.career.request({ kind: 'resolveBids', bidders: full });
    stepAt(h, NIGHT_START);
    expect(h.career.view.bid.lastAwards.at(-1)).toMatchObject({ id: 'player', prefRank: -1 });
  });

  it('a resolveBids request queued before reportForDuty is applied by it', () => {
    const h = offDutyHarness();
    h.career.request({ kind: 'submitBid', prefs: [{ slot: 'day', beat: 'suburbs' }] });
    h.career.request({ kind: 'resolveBids', bidders: [] });
    h.career.reportForDuty(2);
    expect(h.career.view.slot).toEqual({ slot: 'day', beat: 'suburbs' });
    expect(h.career.view.bid.nextBidShift).toBe(20);
  });
});

describe('specialties and FTO', () => {
  function seasoned(): CareerSave {
    const s = saveAt('patrol');
    s.seniorityShifts = 15;
    s.academy.driving = { best: 90, attempts: 1, passed: true };
    return s;
  }

  it('applies to a specialty unit and emits the stage change', () => {
    const h = harness(seasoned());
    h.career.request({ kind: 'applySpecialty', unit: 'traffic', ctx: GOOD_CTX });
    stepAt(h, NIGHT_START);
    expect(h.career.view.assignment).toBe('traffic');
    expect(h.stages).toEqual([{ stage: 'patrol', rank: 'officer', assignment: 'traffic' }]);
    expect(h.career.view.history.at(-1)).toMatchObject({ kind: 'assigned' });
    expect(h.career.view.history.at(-1)?.text).toContain('Traffic Unit');
    h.career.request({ kind: 'returnToPatrol' });
    stepAt(h, NIGHT_START + 60);
    expect(h.career.view.assignment).toBe('patrol');
    expect(h.stages.at(-1)).toEqual({ stage: 'patrol', rank: 'officer', assignment: 'patrol' });
  });

  it('refuses with a flash naming the first reason', () => {
    const s = seasoned();
    s.seniorityShifts = 5;
    const h = harness(s);
    h.career.request({ kind: 'applySpecialty', unit: 'traffic', ctx: GOOD_CTX });
    h.career.request({ kind: 'applySpecialty', unit: 'swat', ctx: GOOD_CTX });
    stepAt(h, NIGHT_START);
    expect(h.career.view.assignment).toBe('patrol');
    expect(h.flashes).toEqual(['Needs 10 shifts of seniority (have 5)', 'Needs 30 shifts of seniority (have 5)']);
    expect(h.stages).toEqual([]);
  });

  it('applies for FTO, pays the premium, gets a trainee and rates it', () => {
    const s = saveAt('patrol');
    s.seniorityShifts = 40;
    const h = harness(s);
    h.career.request({ kind: 'applyFto', ctx: GOOD_CTX });
    stepAt(h, NIGHT_START);
    expect(h.career.view.assignment).toBe('fto');
    h.career.request({ kind: 'endShift', ctx: GOOD_CTX, suspended: false });
    stepAt(h, NIGHT_START + 8 * H);
    expect(h.summaries[0]?.pay).toMatchObject({ fto: 24, specialty: 0, total: 280 });
    h.career.reportForDuty(2);
    const t = h.career.view.trainee;
    expect(t).not.toBeNull();
    const truth = t?.truth ?? { safety: 3, procedure: 3, reports: 3, community: 3, driving: 3 };
    h.career.request({ kind: 'traineeRating', ratings: { ...truth } });
    stepAt(h, h.career.view.shift.startGame);
    expect(h.points).toEqual([{ delta: 10, reason: 'Trainee evaluation (100% accurate)', key: 'fto:2' }]);
    expect(h.career.view.trainee).toBeNull();
    h.career.request({ kind: 'traineeRating', ratings: { ...truth } });
    stepAt(h, h.career.view.shift.startGame + 60);
    expect(h.points).toHaveLength(1);
  });

  it('a poor trainee rating earns fewer points', () => {
    const save = saveAt('patrol');
    save.assignment = 'fto';
    save.trainee = { name: 'Pat', truth: { safety: 3, procedure: 3, reports: 3, community: 3, driving: 3 } };
    const h = harness(save);
    h.career.request({ kind: 'traineeRating', ratings: { safety: 4, procedure: 2, reports: 4, community: 2, driving: 4 } });
    stepAt(h, NIGHT_START);
    expect(h.points[0]).toMatchObject({ delta: 8, key: 'fto:1' });
  });

  it('refuses FTO without enough seniority', () => {
    const h = harness(saveAt('patrol'));
    h.career.request({ kind: 'applyFto', ctx: GOOD_CTX });
    stepAt(h, NIGHT_START);
    expect(h.career.view.assignment).toBe('patrol');
    expect(h.flashes[0]).toBe('Needs 40 shifts of seniority (have 0)');
  });
});

describe('promotion', () => {
  it('promotes to corporal without an exam and awards points', () => {
    const s = saveAt('patrol');
    s.seniorityShifts = 40;
    const h = harness(s);
    h.career.request({ kind: 'promotion', rank: 'corporal', examScore: 0, ctx: { ...GOOD_CTX, points: 100 } });
    stepAt(h, NIGHT_START);
    expect(h.career.view.rank).toBe('corporal');
    expect(h.points).toEqual([{ delta: 25, reason: 'Promotion', key: 'promo:corporal' }]);
    expect(h.stages).toEqual([{ stage: 'patrol', rank: 'corporal', assignment: 'patrol' }]);
    expect(h.career.view.history.at(-1)).toMatchObject({ kind: 'promoted' });
  });

  it('needs the exam score for sergeant', () => {
    const s = saveAt('patrol');
    s.rank = 'corporal';
    s.seniorityShifts = 80;
    const h = harness(s);
    const ctx = { ...GOOD_CTX, points: 250 };
    h.career.request({ kind: 'promotion', rank: 'sergeant', examScore: 74, ctx });
    stepAt(h, NIGHT_START);
    expect(h.career.view.rank).toBe('corporal');
    expect(h.flashes).toEqual(['Exam score 74 is below the 75 required']);
    h.career.request({ kind: 'promotion', rank: 'sergeant', examScore: 75, ctx });
    stepAt(h, NIGHT_START + 60);
    expect(h.career.view.rank).toBe('sergeant');
    expect(h.points).toEqual([{ delta: 25, reason: 'Promotion', key: 'promo:sergeant' }]);
  });

  it('refuses skipping a rank or missing requirements', () => {
    const h = harness(saveAt('patrol'));
    h.career.request({ kind: 'promotion', rank: 'sergeant', examScore: 100, ctx: GOOD_CTX });
    h.career.request({ kind: 'promotion', rank: 'corporal', examScore: 100, ctx: GOOD_CTX });
    stepAt(h, NIGHT_START);
    expect(h.career.view.rank).toBe('officer');
    expect(h.flashes).toEqual(['Only the next rank (corporal) is available', 'Needs 40 shifts of seniority (have 0)']);
    expect(h.points).toEqual([]);
  });
});

describe('persistence', () => {
  function busy(): Harness {
    const h = harness(saveAt('patrol'));
    stepAt(h, NIGHT_START);
    h.career.request({ kind: 'stress', event: 'pursuit' });
    h.career.request({ kind: 'stat', key: 'calls', delta: 5 });
    h.career.request({ kind: 'submitBid', prefs: [{ slot: 'swing', beat: 'highway' }] });
    h.career.request({ kind: 'endShift', ctx: GOOD_CTX, suspended: false });
    stepAt(h, NIGHT_START + 8 * H);
    h.career.planActivity('family', 2);
    h.career.planActivity('exercise', 1);
    return h;
  }

  it('serialize -> restore -> serialize is identical', () => {
    const a = busy();
    const s1 = a.career.serialize();
    expect(isCareerSave(s1)).toBe(true);
    const b = harness(s1);
    expect(b.career.serialize()).toEqual(s1);
    const c = harness(saveAt('academy'));
    c.career.restore(s1);
    expect(c.career.serialize()).toEqual(s1);
    expect(JSON.parse(JSON.stringify(s1))).toEqual(s1);
    expect(c.career.view.offDuty?.plan).toEqual(s1.offDuty?.plan);
  });

  it('the serialized copy does not alias the live state', () => {
    const a = busy();
    const s1 = a.career.serialize();
    s1.money = 12345;
    s1.wellbeing.fatigue = 1;
    s1.offDuty?.plan.push({ activity: 'rest', hours: 1 });
    expect(a.career.view.money).not.toBe(12345);
    expect(a.career.view.wellbeing.fatigue).not.toBe(1);
    expect(a.career.view.offDuty?.plan).toHaveLength(2);
  });

  it('keeps queued requests and the rng state across the round trip', () => {
    const a = harness(saveAt('patrol'));
    a.career.request({ kind: 'stat', key: 'calls', delta: 2 });
    const s = a.career.serialize();
    expect(s.queue).toHaveLength(1);
    const b = harness(s);
    stepAt(b, NIGHT_START);
    expect(b.career.view.stats.calls).toBe(2);
    expect(b.career.serialize().rng).toEqual(s.rng);
  });

  it('two runs of the same inputs give identical saves', () => {
    expect(busy().career.serialize()).toEqual(busy().career.serialize());
  });
});

describe('isCareerSave', () => {
  const valid = (): CareerSave => {
    const h = harness(saveAt('patrol'));
    stepAt(h, NIGHT_START);
    h.career.request({ kind: 'endShift', ctx: GOOD_CTX, suspended: false });
    stepAt(h, NIGHT_START + 8 * H);
    h.career.planActivity('rest', 2);
    h.career.request({ kind: 'resolveBids', bidders: [{ id: 'B', name: 'B', seniority: 1, probation: false, prefs: [{ slot: 'day', beat: 'downtown' }] }] });
    h.career.request({ kind: 'promotion', rank: 'corporal', examScore: 0, ctx: GOOD_CTX });
    const s = h.career.serialize();
    s.trainee = { name: 'T', truth: { safety: 1, procedure: 2, reports: 3, community: 4, driving: 5 } };
    return s;
  };

  it('accepts a populated save and every fresh stage', () => {
    expect(isCareerSave(valid())).toBe(true);
    for (const stage of ['academy', 'probation', 'patrol', 'separated'] as const) {
      expect(isCareerSave(saveAt(stage)), stage).toBe(true);
    }
  });

  it('rejects non-objects', () => {
    for (const x of [null, undefined, 0, 'x', [], true]) expect(isCareerSave(x)).toBe(false);
  });

  const MUTATIONS: [string, (s: Record<string, any>) => void][] = [
    ['version', (s) => { s.version = 2; }],
    ['rng seed', (s) => { s.rng.seed = 1.5; }],
    ['rng words', (s) => { s.rng.s = [1, 2, 3]; }],
    ['rng range', (s) => { s.rng.s[0] = -1; }],
    ['stage', (s) => { s.stage = 'retired'; }],
    ['rank', (s) => { s.rank = 'chief'; }],
    ['assignment', (s) => { s.assignment = 'mounted'; }],
    ['seniority', (s) => { s.seniorityShifts = -1; }],
    ['seniority NaN', (s) => { s.seniorityShifts = Number.NaN; }],
    ['probation left', (s) => { s.probationShiftsLeft = 1.5; }],
    ['probation extended', (s) => { s.probationExtended = 'no'; }],
    ['academy missing', (s) => { delete s.academy.legal; }],
    ['academy best', (s) => { s.academy.driving.best = 101; }],
    ['academy best low', (s) => { s.academy.driving.best = -2; }],
    ['academy attempts', (s) => { s.academy.driving.attempts = -1; }],
    ['academy passed', (s) => { s.academy.driving.passed = 1; }],
    ['wellbeing fatigue', (s) => { s.wellbeing.fatigue = 1.1; }],
    ['wellbeing stress', (s) => { s.wellbeing.stress = Number.NaN; }],
    ['wellbeing debt', (s) => { s.wellbeing.sleepDebtH = 25; }],
    ['wellbeing missing', (s) => { delete s.wellbeing.family; }],
    ['money', (s) => { s.money = Number.POSITIVE_INFINITY; }],
    ['lastRentDay', (s) => { s.lastRentDay = 0.5; }],
    ['shift onDuty', (s) => { s.shift.onDuty = 'yes'; }],
    ['shift number', (s) => { s.shift.shiftNo = -1; }],
    ['shift start', (s) => { s.shift.startGame = Number.NaN; }],
    ['slot', (s) => { s.slot.slot = 'noon'; }],
    ['beat', (s) => { s.slot.beat = 'harbor'; }],
    ['bid missing', (s) => { delete s.bid; }],
    ['bid next', (s) => { s.bid.nextBidShift = 1.5; }],
    ['bid prefs', (s) => { s.bid.prefs = [{ slot: 'day', beat: 'nowhere' }]; }],
    ['bid prefs long', (s) => { s.bid.prefs = Array.from({ length: 13 }, () => ({ slot: 'day', beat: 'downtown' })); }],
    ['bid awards', (s) => { s.bid.lastAwards = [{ id: 'x', slot: 'day', beat: 'downtown', prefRank: -2 }]; }],
    ['stats missing', (s) => { delete s.stats.calls; }],
    ['stats NaN', (s) => { s.stats.trustDelta = Number.NaN; }],
    ['pay not array', (s) => { s.pay = {}; }],
    ['pay too long', (s) => { s.pay = Array.from({ length: 31 }, () => s.pay[0]); }],
    ['pay entry', (s) => { s.pay[0].total = 'x'; }],
    ['dor too long', (s) => { s.dor = Array.from({ length: 21 }, () => ({ shiftNo: 1, scores: { safety: 1, procedure: 1, reports: 1, community: 1, driving: 1 }, average: 1, notes: [] })); }],
    ['dor entry', (s) => { s.dor = [{ shiftNo: 1, scores: { safety: 1 }, average: 1, notes: [] }]; }],
    ['history too long', (s) => { s.history = Array.from({ length: 101 }, () => ({ game: 0, kind: 'note', text: 'x' })); }],
    ['history kind', (s) => { s.history = [{ game: 0, kind: 'party', text: 'x' }]; }],
    ['history text', (s) => { s.history = [{ game: 0, kind: 'note', text: 5 }]; }],
    ['neglect', (s) => { s.neglect.daysWithoutFamily = -1; }],
    ['neglect missing', (s) => { delete s.neglect; }],
    ['offDuty hours', (s) => { s.offDuty.hoursLeft = -1; }],
    ['offDuty plan', (s) => { s.offDuty.plan = [{ activity: 'sleep', hours: 1 }]; }],
    ['offDuty plan hours', (s) => { s.offDuty.plan = [{ activity: 'rest', hours: 0 }]; }],
    ['offDuty type', (s) => { s.offDuty = 'x'; }],
    ['offDuty next', (s) => { s.offDuty.nextStartGame = Number.NaN; }],
    ['trainee name', (s) => { s.trainee.name = 3; }],
    ['trainee truth', (s) => { delete s.trainee.truth.driving; }],
    ['queue not array', (s) => { s.queue = null; }],
    ['queue unknown kind', (s) => { s.queue = [{ kind: 'dance' }]; }],
    ['queue bad stress', (s) => { s.queue = [{ kind: 'stress', event: 'nap' }]; }],
    ['queue bad stat key', (s) => { s.queue = [{ kind: 'stat', key: 'bogus', delta: 1 }]; }],
    ['queue bad delta', (s) => { s.queue = [{ kind: 'stat', key: 'calls', delta: Number.NaN }]; }],
    ['queue bad module', (s) => { s.queue = [{ kind: 'academyScore', module: 'x', score: 1 }]; }],
    ['queue bad ctx', (s) => { s.queue = [{ kind: 'endShift', ctx: { points: 1 }, suspended: false }]; }],
    ['queue bad suspended', (s) => { s.queue = [{ kind: 'endShift', ctx: { points: 1, credibility: 1, sustainedIaRecent: 0, avgReport: 1 }, suspended: 'no' }]; }],
    ['queue bad bidders', (s) => { s.queue = [{ kind: 'resolveBids', bidders: [{ id: 1 }] }]; }],
    ['queue bad unit', (s) => { s.queue = [{ kind: 'applySpecialty', unit: 'mounted', ctx: { points: 1, credibility: 1, sustainedIaRecent: 0, avgReport: 1 } }]; }],
    ['queue bad ratings', (s) => { s.queue = [{ kind: 'traineeRating', ratings: { safety: 3 } }]; }],
    ['queue bad rank', (s) => { s.queue = [{ kind: 'promotion', rank: 'chief', examScore: 1, ctx: { points: 1, credibility: 1, sustainedIaRecent: 0, avgReport: 1 } }]; }],
    ['queue too long', (s) => { s.queue = Array.from({ length: 513 }, () => ({ kind: 'graduate' })); }],
  ];

  it.each(MUTATIONS)('rejects a bad %s', (_name, mutate) => {
    const s = JSON.parse(JSON.stringify(valid())) as Record<string, any>;
    mutate(s);
    expect(isCareerSave(s)).toBe(false);
  });

  it('accepts every queued request kind', () => {
    const ctx = { points: 1, credibility: 1, sustainedIaRecent: 0, avgReport: 1 };
    const queue: CareerRequest[] = [
      { kind: 'stress', event: 'pursuit' }, { kind: 'injury', amount: 0.1 }, { kind: 'stat', key: 'calls', delta: 1 },
      { kind: 'academyScore', module: 'legal', score: 80 }, { kind: 'graduate' }, { kind: 'endShift', ctx, suspended: false },
      { kind: 'submitBid', prefs: [{ slot: 'day', beat: 'downtown' }] }, { kind: 'resolveBids', bidders: [] },
      { kind: 'applySpecialty', unit: 'k9', ctx }, { kind: 'applyFto', ctx }, { kind: 'returnToPatrol' },
      { kind: 'promotion', rank: 'corporal', examScore: 1, ctx },
      { kind: 'traineeRating', ratings: { safety: 1, procedure: 2, reports: 3, community: 4, driving: 5 } },
    ];
    const s = valid();
    s.queue = queue;
    expect(isCareerSave(s)).toBe(true);
  });
});

describe('CareerState type', () => {
  it('is a class', () => {
    expect(typeof CareerState).toBe('function');
  });
});
