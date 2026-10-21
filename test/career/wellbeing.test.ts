import { describe, expect, it } from 'vitest';
import {
  CAREER_CONFIG, applyActivity, applyIdle, applyInjury, applyNeglect, applyStressEvent, fatigueRatePerHour, fitForDuty, newWellbeing,
  performanceMods, tickOnDuty, type PerformanceMods, type Wellbeing,
} from '../../src/career';

const W = CAREER_CONFIG.wellbeing;

function w(over: Partial<Wellbeing> = {}): Wellbeing {
  return { ...newWellbeing(), ...over };
}

describe('newWellbeing', () => {
  it('starts rested and healthy', () => {
    expect(newWellbeing()).toEqual({ fatigue: 0.1, stress: 0.15, health: 1, fitness: 0.6, family: 0.7, sleepDebtH: 0 });
  });
});

describe('fatigue', () => {
  it('a night shift tires faster than a day shift over the same 8 hours', () => {
    const day = w();
    const night = w();
    tickOnDuty(day, 480, 'day');
    tickOnDuty(night, 480, 'night');
    expect(night.fatigue).toBeGreaterThan(day.fatigue);
    expect(fatigueRatePerHour('night', w())).toBeCloseTo(0.06 * 1.35 * (1.2 - 0.4 * 0.6), 10);
    expect(fatigueRatePerHour('day', w())).toBeCloseTo(0.06 * (1.2 - 0.4 * 0.6), 10);
    expect(day.fatigue).toBeCloseTo(0.1 + 8 * 0.0576, 10);
  });

  it('sleep debt raises the rate (capped at 16 h) and low fitness raises it too', () => {
    const base = fatigueRatePerHour('day', w());
    expect(fatigueRatePerHour('day', w({ sleepDebtH: 8 }))).toBeCloseTo(base * 1.5, 10);
    expect(fatigueRatePerHour('day', w({ sleepDebtH: 16 }))).toBeCloseTo(base * 2, 10);
    expect(fatigueRatePerHour('day', w({ sleepDebtH: 24 }))).toBeCloseTo(base * 2, 10);
    expect(fatigueRatePerHour('day', w({ fitness: 0 }))).toBeGreaterThan(base);
    expect(fatigueRatePerHour('day', w({ fitness: 1 }))).toBeLessThan(base);
    expect(fatigueRatePerHour('day', w({ fitness: 0 }))).toBeCloseTo(0.06 * 1.2, 10);
  });

  it('stress decays slowly on duty and every value clamps at 0 and 1', () => {
    const a = w({ stress: 0.5 });
    tickOnDuty(a, 60, 'day');
    expect(a.stress).toBeCloseTo(0.49, 10);
    const b = w({ fatigue: 0.99, stress: 0.001 });
    tickOnDuty(b, 600, 'night');
    expect(b.fatigue).toBe(1);
    expect(b.stress).toBe(0);
  });
});

describe('stress events', () => {
  it('adds the table delta scaled by resilience for positive deltas', () => {
    const a = w();
    const applied = applyStressEvent(a, 'forceUsed');
    const scale = 1.2 - 0.2 * 0.6 - 0.2 * 0.7;
    expect(applied).toBeCloseTo(0.05 * scale, 10);
    expect(a.stress).toBeCloseTo(0.15 + 0.05 * scale, 10);
    const resilient = w({ fitness: 1, family: 1 });
    expect(applyStressEvent(resilient, 'firearmDischarged')).toBeCloseTo(0.2 * 0.8, 10);
    const fragile = w({ fitness: 0, family: 0 });
    expect(applyStressEvent(fragile, 'firearmDischarged')).toBeCloseTo(0.2 * 1.2, 10);
  });

  it('negative deltas are not scaled and a commendation lowers stress', () => {
    const a = w({ stress: 0.3 });
    expect(applyStressEvent(a, 'commendation')).toBe(-0.05);
    expect(a.stress).toBeCloseTo(0.25, 10);
    applyStressEvent(a, 'callCleared');
    expect(a.stress).toBeCloseTo(0.245, 10);
  });

  it('clamps at 0 and 1', () => {
    const a = w({ stress: 0.01 });
    applyStressEvent(a, 'commendation');
    expect(a.stress).toBe(0);
    const b = w({ stress: 0.95 });
    applyStressEvent(b, 'officerInjured');
    expect(b.stress).toBe(1);
  });

  it('an injury lowers health and adds half of it as stress', () => {
    const a = w();
    applyInjury(a, 0.4);
    expect(a.health).toBeCloseTo(0.6, 10);
    expect(a.stress).toBeCloseTo(0.35, 10);
    applyInjury(a, 5);
    expect(a.health).toBe(0);
    expect(a.stress).toBe(1);
  });
});

describe('off-duty activities', () => {
  it('rest lowers fatigue and counts sleep', () => {
    const a = w({ fatigue: 0.7 });
    const r = applyActivity(a, 'rest', 4);
    expect(a.fatigue).toBeCloseTo(0.7 - 0.36, 10);
    expect(a.stress).toBeCloseTo(0.15 - 0.04, 10);
    expect(r).toEqual({ moneyDelta: 0, sleptH: 4 });
  });

  it('exercise raises fitness and fatigue and lowers stress', () => {
    const a = w();
    const r = applyActivity(a, 'exercise', 2);
    expect(a.fitness).toBeCloseTo(0.66, 10);
    expect(a.fatigue).toBeCloseTo(0.16, 10);
    expect(a.stress).toBeCloseTo(0.05, 10);
    expect(r.sleptH).toBe(0);
  });

  it('family time raises family', () => {
    const a = w({ family: 0.5 });
    applyActivity(a, 'family', 2);
    expect(a.family).toBeCloseTo(0.66, 10);
    expect(a.stress).toBeCloseTo(0.03, 10);
  });

  it('a second job earns 25 per hour and costs family time', () => {
    const a = w();
    const r = applyActivity(a, 'secondJob', 4);
    expect(r.moneyDelta).toBe(100);
    expect(a.family).toBeCloseTo(0.62, 10);
    expect(a.fatigue).toBeCloseTo(0.3, 10);
  });

  it('idle hours recover a little and count half as sleep', () => {
    const a = w({ fatigue: 0.5 });
    const slept = applyIdle(a, 6);
    expect(slept).toBe(3);
    expect(a.fatigue).toBeCloseTo(0.32, 10);
    expect(a.stress).toBeCloseTo(0.12, 10);
  });
});

describe('neglect', () => {
  const day = { family: false, exercise: true, sleptH: 8, money: 100, days: 1 };

  it('no family time two periods in a row lowers family by 0.05 then 0.10', () => {
    const a = w();
    const n = { daysWithoutFamily: 0, daysWithoutExercise: 0 };
    applyNeglect(a, n, day);
    expect(a.family).toBeCloseTo(0.65, 10);
    expect(n.daysWithoutFamily).toBe(1);
    applyNeglect(a, n, day);
    expect(a.family).toBeCloseTo(0.55, 10);
    expect(n.daysWithoutFamily).toBe(2);
    applyNeglect(a, n, { ...day, family: true });
    expect(n.daysWithoutFamily).toBe(0);
    expect(a.family).toBeCloseTo(0.55, 10);
  });

  it('adds stress when family falls below 0.3', () => {
    const a = w({ family: 0.32, stress: 0.2 });
    applyNeglect(a, { daysWithoutFamily: 0, daysWithoutExercise: 0 }, day);
    expect(a.family).toBeCloseTo(0.27, 10);
    expect(a.stress).toBeCloseTo(0.24, 10);
  });

  it('exercise has a grace period, then fitness falls per period', () => {
    const a = w();
    const n = { daysWithoutFamily: 0, daysWithoutExercise: 0 };
    const lazy = { ...day, family: true, exercise: false };
    for (let i = 0; i < 3; i++) applyNeglect(a, n, lazy);
    expect(a.fitness).toBeCloseTo(0.6, 10);
    applyNeglect(a, n, lazy);
    expect(a.fitness).toBeCloseTo(0.58, 10);
    applyNeglect(a, n, { ...lazy, exercise: true });
    expect(n.daysWithoutExercise).toBe(0);
    expect(a.fitness).toBeCloseTo(0.58, 10);
  });

  it('debt adds stress and health recovers per day', () => {
    const a = w({ health: 0.5, stress: 0.2 });
    applyNeglect(a, { daysWithoutFamily: 0, daysWithoutExercise: 0 }, { ...day, family: true, money: -1, days: 3 });
    expect(a.stress).toBeCloseTo(0.25, 10);
    expect(a.health).toBeCloseTo(0.65, 10);
    const b = w({ health: 0.98 });
    applyNeglect(b, { daysWithoutFamily: 0, daysWithoutExercise: 0 }, { ...day, family: true, days: 5 });
    expect(b.health).toBe(1);
  });

  it('sleep debt accumulates on short sleep and recovers on long sleep, never below 0', () => {
    const a = w();
    const n = { daysWithoutFamily: 0, daysWithoutExercise: 0 };
    const base = { ...day, family: true };
    applyNeglect(a, n, { ...base, sleptH: 5 });
    expect(a.sleepDebtH).toBe(3);
    applyNeglect(a, n, { ...base, sleptH: 6 });
    expect(a.sleepDebtH).toBe(5);
    applyNeglect(a, n, { ...base, sleptH: 10 });
    expect(a.sleepDebtH).toBe(3);
    applyNeglect(a, n, { ...base, sleptH: 12 });
    expect(a.sleepDebtH).toBe(0);
    applyNeglect(a, n, { ...base, sleptH: 0 });
    applyNeglect(a, n, { ...base, sleptH: 0 });
    applyNeglect(a, n, { ...base, sleptH: 0 });
    applyNeglect(a, n, { ...base, sleptH: 0 });
    expect(a.sleepDebtH).toBe(24);
  });
});

describe('performanceMods', () => {
  it('is exactly neutral at fatigue 0.2 stress 0.2', () => {
    const out: PerformanceMods = { aimSpread: 9, steerLagS: 9, vignette: 9 };
    expect(performanceMods(w({ fatigue: 0.2, stress: 0.2 }), out)).toEqual({ aimSpread: 1, steerLagS: 0, vignette: 0 });
  });

  it('matches the design numbers at fatigue 0.9 stress 0.8', () => {
    const out: PerformanceMods = { aimSpread: 0, steerLagS: 0, vignette: 0 };
    performanceMods(w({ fatigue: 0.9, stress: 0.8 }), out);
    expect(out.aimSpread).toBeCloseTo(1 + 0.32 + 0.18, 10);
    expect(out.aimSpread).toBeCloseTo(1.5, 10);
    expect(out.steerLagS).toBeCloseTo(0.1875, 10);
    expect(out.vignette).toBeCloseTo(0.6667, 4);
  });

  it('reaches the maximum lag at full fatigue and reuses the output object', () => {
    const out: PerformanceMods = { aimSpread: 0, steerLagS: 0, vignette: 0 };
    const again = performanceMods(w({ fatigue: 1, stress: 0 }), out);
    expect(again).toBe(out);
    expect(out.steerLagS).toBeCloseTo(0.25, 10);
    expect(out.vignette).toBe(1);
    expect(performanceMods(w({ fatigue: 0.1, stress: 1 }), out)).toBe(out);
    expect(out.aimSpread).toBeCloseTo(1.3, 10);
  });
});

describe('fitForDuty', () => {
  it('uses the health and stress thresholds', () => {
    expect(fitForDuty(w())).toEqual({ ok: true, reason: '' });
    expect(fitForDuty(w({ health: 0.35 })).ok).toBe(true);
    expect(fitForDuty(w({ health: 0.34 }))).toEqual({ ok: false, reason: 'Injured: light duty' });
    expect(fitForDuty(w({ stress: 0.94 })).ok).toBe(true);
    expect(fitForDuty(w({ stress: 0.95 }))).toEqual({ ok: false, reason: 'Critical stress: mandatory leave' });
    expect(W.fit.minHealth).toBe(0.35);
  });
});
