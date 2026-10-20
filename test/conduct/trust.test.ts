import { describe, expect, it } from 'vitest';
import { commendationsFor } from '../../src/conduct/commendations';
import { TRUST_CONFIG } from '../../src/conduct/data';
import {
  applyTrustDelta, driftTrust, newTrustState, trustBaselines, trustDeltaForIncident, trustEffects,
} from '../../src/conduct/trust';
import { TRUST } from '../../src/dialogue/data';
import { LogBuilder, assess, det, forceEvent, ruling } from './helpers';

const cfg = TRUST_CONFIG;
const d = cfg.deltas;

describe('trust state', () => {
  it('starts at the dialogue baselines', () => {
    const s = newTrustState();
    expect(Object.keys(s.values).sort()).toEqual([...TRUST.keys()].sort());
    for (const [k, v] of TRUST) expect(s.values[k]).toBe(v);
    expect(trustBaselines()).toBe(TRUST);
  });

  it('applies a delta to the district and a spilled share to every other', () => {
    const s = newTrustState();
    applyTrustDelta(s, 'downtown', -0.04, cfg);
    expect(s.values.downtown).toBeCloseTo(0.45 - 0.04, 10);
    expect(s.values.suburbs).toBeCloseTo(0.65 - 0.04 * cfg.spill, 10);
    expect(s.values.water).toBeCloseTo(0.5 - 0.04 * cfg.spill, 10);
  });

  it('clamps to the configured bounds', () => {
    const s = newTrustState();
    applyTrustDelta(s, 'downtown', -5, cfg);
    expect(s.values.downtown).toBe(cfg.min);
    expect(s.values.suburbs).toBe(cfg.min);
    applyTrustDelta(s, 'downtown', 5, cfg);
    expect(s.values.downtown).toBe(cfg.max);
    expect(s.values.suburbs).toBe(cfg.max);
  });

  it('spills to every district for an unknown district', () => {
    const s = newTrustState();
    applyTrustDelta(s, 'nowhere', 0.1, cfg);
    expect(s.values.downtown).toBeCloseTo(0.45 + 0.1 * cfg.spill, 10);
    expect(s.values.suburbs).toBeCloseTo(0.65 + 0.1 * cfg.spill, 10);
    expect(s.values.nowhere).toBeUndefined();
    applyTrustDelta(s, '', 0.1, cfg);
    expect(Object.keys(s.values)).toHaveLength(TRUST.size);
  });

  it('drifts exponentially: the gap halves after ln2 / driftPerDay days', () => {
    const s = newTrustState();
    applyTrustDelta(s, 'park', -0.3, cfg);
    const gap = (TRUST.get('park') ?? 0) - (s.values.park ?? 0);
    expect(gap).toBeGreaterThan(0.29);
    driftTrust(s, Math.LN2 / cfg.driftPerDay, cfg);
    expect((TRUST.get('park') ?? 0) - (s.values.park ?? 0)).toBeCloseTo(gap / 2, 10);
  });

  it('drift composes (many small steps equal one big step) and approaches the baseline from above and below', () => {
    const a = newTrustState();
    const b = newTrustState();
    applyTrustDelta(a, 'harbor', 0.2, cfg);
    applyTrustDelta(b, 'harbor', 0.2, cfg);
    driftTrust(a, 2, cfg);
    for (let i = 0; i < 2880; i++) driftTrust(b, 1 / 1440, cfg);
    expect(b.values.harbor).toBeCloseTo(a.values.harbor ?? 0, 9);
    expect(a.values.harbor).toBeGreaterThan(TRUST.get('harbor') ?? 0);
    applyTrustDelta(a, 'harbor', -2, cfg);
    driftTrust(a, 100, cfg);
    expect(a.values.harbor).toBeCloseTo(TRUST.get('harbor') ?? 0, 6);
    driftTrust(a, 0, cfg);
    expect(a.values.harbor).toBeCloseTo(TRUST.get('harbor') ?? 0, 6);
  });
});

describe('trust effects', () => {
  it('hits the documented endpoints', () => {
    const lo = trustEffects(0, cfg);
    const hi = trustEffects(1, cfg);
    expect(lo.errorScale).toBeCloseTo(1.6, 10);
    expect(hi.errorScale).toBeCloseTo(0.4, 10);
    expect(lo.crimeFactor).toBeCloseTo(1.3, 10);
    expect(hi.crimeFactor).toBeCloseTo(0.8, 10);
    expect(lo.cooperation).toBe(0);
    expect(hi.cooperation).toBe(1);
    expect(lo.hostility).toBeCloseTo(0.6 * 0.8, 10);
    expect(hi.hostility).toBe(0);
  });

  it('is monotonic in trust', () => {
    let prev = trustEffects(0, cfg);
    for (let v = 0.05; v <= 1.0001; v += 0.05) {
      const e = trustEffects(v, cfg);
      expect(e.cooperation).toBeGreaterThan(prev.cooperation);
      expect(e.errorScale).toBeLessThan(prev.errorScale);
      expect(e.crimeFactor).toBeLessThan(prev.crimeFactor);
      expect(e.hostility).toBeLessThanOrEqual(prev.hostility);
      prev = e;
    }
  });

  it('has no hostility at or above the threshold', () => {
    expect(trustEffects(0.6, cfg).hostility).toBe(0);
    expect(trustEffects(0.59, cfg).hostility).toBeCloseTo(0.01 * 0.8, 10);
    expect(trustEffects(0.2, cfg).hostility).toBeCloseTo(0.4 * 0.8, 10);
  });
});

describe('trustDeltaForIncident', () => {
  it('is zero for an empty incident and charges aggressive lines', () => {
    const log = new LogBuilder().start().person(1, 'suspect').build();
    const a = assess(log.key);
    expect(trustDeltaForIncident(a, log, 0, cfg)).toBe(0);
    expect(trustDeltaForIncident(a, log, 3, cfg)).toBeCloseTo(3 * d.aggressiveLine, 10);
    expect(trustDeltaForIncident(a, log, -4, cfg)).toBe(0);
  });

  it('charges each unlawful determination by doctrine and ignores lawful / questionable ones', () => {
    const log = new LogBuilder().start().person(1, 'suspect').build();
    const cases: [Parameters<typeof det>[0], number][] = [
      ['detention', d.unlawfulDetention], ['search', d.unlawfulSearch], ['frisk', d.unlawfulSearch], ['friskScope', d.unlawfulSearch],
      ['entry', d.unlawfulSearch], ['arrest', d.unlawfulArrest], ['miranda', d.mirandaViolation],
    ];
    for (const [doctrine, delta] of cases) {
      expect(trustDeltaForIncident(assess(log.key, { dets: [det(doctrine, 'unlawful', [1])] }), log, 0, cfg)).toBeCloseTo(delta, 10);
      expect(trustDeltaForIncident(assess(log.key, { dets: [det(doctrine, 'questionable', [1])] }), log, 0, cfg)).toBe(0);
    }
    expect(trustDeltaForIncident(assess(log.key, { dets: [det('consent', 'unlawful', [1])] }), log, 0, cfg)).toBe(0);
    expect(trustDeltaForIncident(assess(log.key, { dets: [det('detention', 'unlawful', [1]), det('search', 'unlawful', [2])] }), log, 0, cfg))
      .toBeCloseTo(d.unlawfulDetention + d.unlawfulSearch, 10);
  });

  it('rewards a lawful arrest', () => {
    const log = new LogBuilder().start().person(1, 'suspect').arrest(1).build();
    expect(trustDeltaForIncident(assess(log.key, { dets: [det('arrest', 'lawful', [3])] }), log, 0, cfg)).toBeCloseTo(d.lawfulArrest, 10);
  });

  it('scores force rulings, amplified by injury and by a fatal outcome, and halves a fellow officer', () => {
    const b = new LogBuilder().start().person(1, 'suspect').force(1, 'taser', 'active');
    const id = b.lastId;
    const log = b.build();
    const one = (verdict: 'justified' | 'questionable' | 'excessive'): number =>
      trustDeltaForIncident(assess(log.key, { force: [ruling(id, verdict)] }), log, 0, cfg);
    expect(one('justified')).toBeCloseTo(d.justifiedForce, 10);
    expect(one('questionable')).toBeCloseTo(d.questionableForce, 10);
    expect(one('excessive')).toBeCloseTo(d.excessiveForce, 10);

    forceEvent(log, id).injury = 0.29;
    expect(one('excessive')).toBeCloseTo(d.excessiveForce, 10);
    forceEvent(log, id).injury = 0.3;
    expect(one('excessive')).toBeCloseTo(d.excessiveForce * d.injuryMultiplier, 10);
    forceEvent(log, id).injury = 1;
    forceEvent(log, id).fatal = true;
    expect(one('excessive')).toBeCloseTo(d.excessiveForce * d.fatalMultiplier, 10);

    expect(trustDeltaForIncident(assess(log.key, { force: [ruling(99, 'excessive', { other: true })] }), log, 0, cfg))
      .toBeCloseTo(d.excessiveForce / 2, 10);
  });

  it('rewards de-escalation and a courteous contact only without force or unlawful determinations', () => {
    const calm = new LogBuilder().start().person(1, 'suspect').indicator(1, 'weaponSeen').release(1).build();
    expect(commendationsFor(calm, assess(calm.key))).toEqual(['deEscalation']);
    expect(trustDeltaForIncident(assess(calm.key), calm, 0, cfg)).toBeCloseTo(d.deEscalation + d.courteousContact, 10);

    const plain = new LogBuilder().start().person(1, 'suspect').release(1).build();
    expect(trustDeltaForIncident(assess(plain.key), plain, 0, cfg)).toBeCloseTo(d.courteousContact, 10);
    expect(trustDeltaForIncident(assess(plain.key, { dets: [det('detention', 'unlawful', [2])] }), plain, 0, cfg)).toBeCloseTo(d.unlawfulDetention, 10);

    const forced = new LogBuilder().start().person(1, 'suspect').force(1, 'hardHands', 'active').release(1).build();
    expect(trustDeltaForIncident(assess(forced.key), forced, 0, cfg)).toBe(0);
  });
});
