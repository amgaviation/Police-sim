import { describe, expect, it } from 'vitest';
import { WORLD_CONFIG, offenderRisk, pickRecidivist, releaseAfterVerdict } from '../../src/worldstate';
import { DAY, T0, offender, scripted } from './helpers';

const always = (): boolean => true;
const O = WORLD_CONFIG.offenders;

describe('offenderRisk', () => {
  it('follows base + perPrior * priors + juvenile + convicted, clamped', () => {
    expect(offenderRisk(0, false, false)).toBeCloseTo(0.25);
    expect(offenderRisk(2, false, false)).toBeCloseTo(0.25 + 0.24);
    expect(offenderRisk(1, true, true)).toBeCloseTo(0.25 + 0.12 + 0.15 + 0.05);
    expect(offenderRisk(50, true, true)).toBe(O.riskMax);
    expect(offenderRisk(-5, false, false)).toBeCloseTo(0.25);
    expect(offenderRisk(0, false, false, { ...O, riskBase: 0, riskMin: 0.05 })).toBe(0.05);
  });
});

describe('releaseAfterVerdict', () => {
  it('jails a convicted felon for the class term', () => {
    const o = offender({ custody: 'released', offenseClass: 'felony', convicted: false });
    releaseAfterVerdict(o, 'convicted', T0);
    expect(o.custody).toBe('jailed');
    expect(o.releaseGame).toBe(T0 + 10 * DAY);
    expect(o.convicted).toBe(true);
  });

  it('uses the class term for pleas', () => {
    const o = offender({ offenseClass: 'misdemeanor', convicted: false });
    releaseAfterVerdict(o, 'plea', T0);
    expect(o.custody).toBe('jailed');
    expect(o.releaseGame).toBe(T0 + 2 * DAY);
    expect(o.convicted).toBe(true);
  });

  it('releases at once on acquittal or dismissal', () => {
    for (const v of ['acquitted', 'dismissed'] as const) {
      const o = offender({ custody: 'jailed', releaseGame: T0 + 5 * DAY, convicted: false });
      releaseAfterVerdict(o, v, T0);
      expect(o.custody).toBe('released');
      expect(o.releaseGame).toBe(T0);
      expect(o.convicted).toBe(false);
    }
  });
});

describe('pickRecidivist', () => {
  it('never picks a jailed offender', () => {
    const list = [offender({ personId: 1, custody: 'jailed' })];
    const s = scripted([0, 0]);
    expect(pickRecidivist(list, T0, 'downtown', always, s.draw)).toBe(-1);
    expect(s.calls()).toBe(0);
  });

  it('does not pick before releaseGame', () => {
    const list = [offender({ personId: 1, releaseGame: T0 + 1 })];
    const s = scripted([0, 0]);
    expect(pickRecidivist(list, T0, 'downtown', always, s.draw)).toBe(-1);
    expect(s.calls()).toBe(0);
  });

  it('picks a released offender on low draws and an atLarge one too', () => {
    expect(pickRecidivist([offender({ personId: 4 })], T0, 'downtown', always, scripted([0, 0]).draw)).toBe(4);
    expect(pickRecidivist([offender({ personId: 5, custody: 'atLarge' })], T0, 'downtown', always, scripted([0, 0]).draw)).toBe(5);
  });

  it('never calls draw for an empty pool (spy)', () => {
    let calls = 0;
    const draw = (): number => {
      calls++;
      return 0;
    };
    expect(pickRecidivist([], T0, 'downtown', always, draw)).toBe(-1);
    expect(pickRecidivist([offender()], T0, 'downtown', () => false, draw)).toBe(-1);
    expect(pickRecidivist([offender({ custody: 'jailed' })], T0, 'downtown', always, draw)).toBe(-1);
    expect(calls).toBe(0);
  });

  it('rejects with one draw when u >= pAny', () => {
    const s = scripted([0.3, 0]);
    // pAny = min(0.45, 0.6 * 0.5) = 0.3: u = 0.3 is not below it.
    expect(pickRecidivist([offender({ risk: 0.5 })], T0, 'downtown', always, s.draw)).toBe(-1);
    expect(s.calls()).toBe(1);
    const t = scripted([0.29, 0]);
    expect(pickRecidivist([offender({ risk: 0.5 })], T0, 'downtown', always, t.draw)).toBe(1);
    expect(t.calls()).toBe(2);
  });

  it('caps the pick chance at maxPickChance', () => {
    const list = [offender({ risk: 0.9 })];
    expect(pickRecidivist(list, T0, 'downtown', always, scripted([0.44, 0]).draw)).toBe(1);
    expect(pickRecidivist(list, T0, 'downtown', always, scripted([0.45, 0]).draw)).toBe(-1);
  });

  it('weights by risk (mid draw picks the higher-risk offender)', () => {
    // Both in another district: weights 0.2 and 0.6 -> total 0.8; v = 0.5 * 0.8 = 0.4 lands in the second.
    const list = [offender({ personId: 1, risk: 0.2, district: 'park' }), offender({ personId: 2, risk: 0.6, district: 'park' })];
    expect(pickRecidivist(list, T0, 'downtown', always, scripted([0, 0.5]).draw)).toBe(2);
    expect(pickRecidivist(list, T0, 'downtown', always, scripted([0, 0.1]).draw)).toBe(1);
  });

  it('doubles the weight of the same district', () => {
    const list = [offender({ personId: 1, risk: 0.4, district: 'park' }), offender({ personId: 2, risk: 0.4, district: 'downtown' })];
    // Weights 0.4 and 0.8; v = 0.4 / 1.2 ... draw 0.3 * 1.2 = 0.36 -> first; draw 0.4 * 1.2 = 0.48 -> second.
    expect(pickRecidivist(list, T0, 'downtown', always, scripted([0, 0.3]).draw)).toBe(1);
    expect(pickRecidivist(list, T0, 'downtown', always, scripted([0, 0.4]).draw)).toBe(2);
    // Without the district match the split is even: 0.4 * 0.8 = 0.32 < 0.4 -> first.
    expect(pickRecidivist(list, T0, 'harbor', always, scripted([0, 0.4]).draw)).toBe(1);
  });

  it('applies the fits filter before anything else', () => {
    const list = [offender({ personId: 1, risk: 0.9 }), offender({ personId: 2, risk: 0.1 })];
    const s = scripted([0, 0]);
    expect(pickRecidivist(list, T0, 'downtown', (id) => id === 2, s.draw)).toBe(2);
    expect(pickRecidivist(list, T0, 'downtown', () => false, scripted([0, 0]).draw)).toBe(-1);
  });

  it('uses personId order whatever the input order', () => {
    const a = offender({ personId: 9, risk: 0.5, district: 'park' });
    const b = offender({ personId: 3, risk: 0.5, district: 'park' });
    expect(pickRecidivist([a, b], T0, 'downtown', always, scripted([0, 0]).draw)).toBe(3);
  });

  it('takes the pick chance from the highest risk in the pool', () => {
    const list = [offender({ personId: 1, risk: 0.1 }), offender({ personId: 2, risk: 0.5 })];
    // pAny = 0.3: a draw of 0.2 passes although the first offender alone would give 0.06.
    expect(pickRecidivist(list, T0, 'downtown', always, scripted([0.2, 0.99]).draw)).toBe(2);
  });
});
