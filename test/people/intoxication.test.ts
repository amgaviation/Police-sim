import { describe, expect, it } from 'vitest';
import { PEOPLE_DATA } from '../../src/people/data';
import { baseIntoxication, weekdayOfEpochDay } from '../../src/people/intoxication';
import { CALENDAR } from '../../src/records/calendar';
import { DAY, SEED, makeRig } from './helpers';

const STEP = 900;

/** Hourly-ish BAC series over game days [from, to). */
function series(id: number, from: number, to: number, drinker: number): number[] {
  const out: number[] = [];
  for (let t = from * DAY; t < to * DAY; t += STEP) out.push(baseIntoxication(SEED, id, t, drinker, 'none').bac);
  return out;
}

/** True for a series that is zero, then one rise (non-decreasing) and one fall (non-increasing), then zero. */
function isSingleSession(s: readonly number[]): boolean {
  const first = s.findIndex((v) => v > 0);
  if (first <= 0) return false;
  let last = s.length - 1;
  while (last > 0 && (s[last] ?? 0) === 0) last--;
  if (last >= s.length - 1) return false;
  const peak = s.indexOf(Math.max(...s));
  for (let i = first + 1; i <= peak; i++) if ((s[i] ?? 0) < (s[i - 1] ?? 0) - 1e-12) return false;
  for (let i = peak + 1; i <= last; i++) if ((s[i] ?? 0) > (s[i - 1] ?? 0) + 1e-12) return false;
  return true;
}

describe('intoxication curve', () => {
  const dr = PEOPLE_DATA.drinking;

  it('is zero without a drinking propensity', () => {
    for (let id = 0; id < 50; id++) for (const v of series(id, 0, 10, 0)) expect(v).toBe(0);
  });

  it('is deterministic', () => {
    for (let id = 0; id < 30; id++) {
      expect(series(id, 0, 6, 0.9)).toEqual(series(id, 0, 6, 0.9));
    }
  });

  it('rises to a peak inside a session, holds, then falls monotonically at the elimination rate', () => {
    let found = 0;
    for (let id = 0; id < 400 && found < 6; id++) {
      for (let d = 1; d < 30 && found < 6; d++) {
        const s = series(id, d - 1, d + 2, 1);
        if (!isSingleSession(s)) continue;
        found++;
        const peak = Math.max(...s);
        expect(peak).toBeGreaterThanOrEqual(dr.peakBac[0] - 1e-9);
        expect(peak).toBeLessThanOrEqual(dr.peakBac[1] + 1e-9);
        // Zero before the session, and the session starts in the evening window of that day.
        const startIdx = s.findIndex((v) => v > 0);
        const startHour = ((startIdx * STEP) / 3600) % 24;
        expect(startHour).toBeGreaterThanOrEqual(dr.startHour[0] - STEP / 3600);
        // The tail falls linearly: after the hold the slope per hour is the elimination rate.
        const peakIdx = s.indexOf(peak);
        let lastPos = s.length - 1;
        while ((s[lastPos] ?? 0) === 0) lastPos--;
        for (let i = lastPos - 3; i < lastPos; i++) {
          const slopePerHour = (((s[i] ?? 0) - (s[i + 1] ?? 0)) / STEP) * 3600;
          expect(slopePerHour).toBeCloseTo(dr.eliminationPerHour, 6);
        }
        expect(peakIdx).toBeLessThan(lastPos);
      }
    }
    expect(found).toBe(6);
  });

  it('level is bac / 0.2 clamped, and a drug user is influenced only in the evening window', () => {
    let seenDrug = false;
    for (let id = 0; id < 200; id++) {
      for (let d = 0; d < 6; d++) {
        for (let h = 0; h < 24; h += 0.5) {
          const x = baseIntoxication(SEED, id, d * DAY + h * 3600, 0, 'cannabis');
          expect(x.bac).toBe(0);
          if (x.drug !== 'none') {
            seenDrug = true;
            expect(x.drug).toBe('cannabis');
            expect(x.level).toBeGreaterThanOrEqual(0.3);
            expect(x.level).toBeLessThanOrEqual(0.8);
            expect(h >= 18 || h < 2).toBe(true);
          } else {
            expect(x.level).toBe(0);
          }
        }
      }
    }
    expect(seenDrug).toBe(true);
    const sober = baseIntoxication(SEED, 5, 5 * DAY, 0, 'none');
    expect(sober).toEqual({ bac: 0, drug: 'none', level: 0 });
    let maxLevel = 0;
    for (let id = 0; id < 100; id++) for (let t = 0; t < 14 * DAY; t += 3600) maxLevel = Math.max(maxLevel, baseIntoxication(SEED, id, t, 1, 'none').level);
    expect(maxLevel).toBeLessThanOrEqual(1);
    expect(maxLevel).toBeGreaterThan(0.3);
  });

  it('weekday of game day 0 is Monday', () => {
    expect(weekdayOfEpochDay(CALENDAR.startEpochDay)).toBe(0);
    expect(weekdayOfEpochDay(CALENDAR.startEpochDay + 6)).toBe(6);
    expect(weekdayOfEpochDay(CALENDAR.startEpochDay + 7)).toBe(0);
  });

  it('weekends see more sessions than Mondays', () => {
    let monday = 0;
    let saturday = 0;
    for (let id = 0; id < 3000; id++) {
      for (let w = 0; w < 4; w++) {
        const peakOf = (d: number): number => baseIntoxication(SEED, id, d * DAY + 23.5 * 3600, 1, 'none').bac;
        if (peakOf(w * 7) > 0) monday++;
        if (peakOf(w * 7 + 5) > 0) saturday++;
      }
    }
    expect(saturday).toBeGreaterThan(monday * 1.5);
  });

  it('the population mixes base intoxication with explicit overrides that decay', () => {
    const rig = makeRig();
    rig.clock.t = 12 * 3600;
    rig.pop.setIntoxication(10, 0.12, 'none');
    expect(rig.pop.intoxication(10).bac).toBeCloseTo(0.12, 9);
    expect(rig.pop.intoxication(10).level).toBeCloseTo(0.6, 9);
    rig.clock.t += 2 * 3600;
    expect(rig.pop.intoxication(10).bac).toBeCloseTo(0.12 - 2 * dr.eliminationPerHour, 9);
    rig.clock.t += 20 * 3600;
    const ident = rig.pop.identity(10);
    expect(rig.pop.intoxication(10)).toEqual(baseIntoxication(SEED, 10, rig.clock.t, ident.drinker, ident.drugUse));
  });
});
