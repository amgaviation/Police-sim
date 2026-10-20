import { describe, expect, it } from 'vitest';
import { createRng, type Rng } from '../../src/core/rng';
import { FORCE_CONFIG, toolDef } from '../../src/force/data';
import { gauss } from '../../src/force/math';
import { firearmShot, isPregnant, lessLethalShot, meleeApply, riskFactors, sigmaDeg, taserShot, type ShotContext } from '../../src/force/models';

const cfg = FORCE_CONFIG;
const BASE: ShotContext = { distance: 3, officerMoving: false, officerCrouched: false, targetRunning: false };
const N = 10_000;

/** After `fn(a)`, is `a` in the state of a fresh generator that made `draws` `next()` calls? */
function drew(fn: (r: Rng) => unknown, draws: number): boolean {
  const a = createRng(99);
  const b = createRng(99);
  fn(a);
  for (let i = 0; i < draws; i++) b.next();
  return JSON.stringify(a.state()) === JSON.stringify(b.state());
}

describe('gauss', () => {
  it('draws exactly two numbers', () => {
    expect(drew((r) => gauss(r), 2)).toBe(true);
  });

  it('is finite when u1 is 0 and roughly standard normal', () => {
    const zero: Rng = { ...createRng(1), next: () => 0 };
    expect(Number.isFinite(gauss(zero))).toBe(true);
    const rng = createRng(5);
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < N; i++) {
      const z = gauss(rng);
      sum += z;
      sq += z * z;
    }
    expect(Math.abs(sum / N)).toBeLessThan(0.05);
    expect(Math.abs(sq / N - 1)).toBeLessThan(0.07);
  });
});

describe('sigmaDeg', () => {
  const m = cfg.modifiers;
  it('scales with movement, running and crouching', () => {
    expect(sigmaDeg(2, BASE, m)).toBeCloseTo(2);
    expect(sigmaDeg(2, { ...BASE, officerMoving: true }, m)).toBeCloseTo(2 * 1.6);
    expect(sigmaDeg(2, { ...BASE, targetRunning: true }, m)).toBeCloseTo(2 * 1.8);
    expect(sigmaDeg(2, { ...BASE, officerCrouched: true }, m)).toBeCloseTo(2 * 0.8);
    expect(sigmaDeg(2, { ...BASE, officerMoving: true, targetRunning: true, officerCrouched: true }, m)).toBeCloseTo(2 * 2.2);
  });

  it('never drops below 0.2 x base', () => {
    expect(sigmaDeg(2, { ...BASE, officerCrouched: true }, { officerMoving: 0, targetRunning: 0, crouched: -5 })).toBeCloseTo(0.4);
  });
});

describe('taserShot', () => {
  const t = cfg.taser;
  const range = toolDef(cfg, 'taser').rangeM[1];
  const ctx = (distance: number, cold = false): ShotContext & { cold: boolean } => ({ ...BASE, distance, cold });

  it('draws exactly five numbers in every branch', () => {
    expect(drew((r) => taserShot(ctx(3), t, range, r), 5)).toBe(true);
    expect(drew((r) => taserShot(ctx(20), t, range, r), 5)).toBe(true);
    expect(drew((r) => taserShot(ctx(0.5, true), t, range, r), 5)).toBe(true);
  });

  function rates(distance: number, cold = false): { hit: number; nmi: number } {
    const rng = createRng(17);
    let hit = 0;
    let nmi = 0;
    for (let i = 0; i < N; i++) {
      const s = taserShot(ctx(distance, cold), t, range, rng);
      if (s.probes > 0) hit++;
      if (s.nmi) nmi++;
    }
    return { hit: hit / N, nmi: nmi / N };
  }

  it('hits at least 90 % at 3 m and less at 7 m', () => {
    const near = rates(3);
    const far = rates(7);
    expect(near.hit).toBeGreaterThanOrEqual(0.9);
    expect(far.hit).toBeLessThan(near.hit);
    expect(far.hit).toBeGreaterThan(0.3);
  });

  it('never reaches neuromuscular incapacitation when the probe spread is under the minimum', () => {
    const rng = createRng(3);
    for (let i = 0; i < N; i++) {
      const s = taserShot(ctx(0.5), t, range, rng);
      expect(s.spreadM).toBeLessThan(t.minSpreadM);
      expect(s.nmi).toBe(false);
    }
  });

  it('puts no probe out of range', () => {
    const rng = createRng(4);
    for (let i = 0; i < 500; i++) {
      const s = taserShot(ctx(range + 0.5), t, range, rng);
      expect(s).toMatchObject({ inRange: false, probes: 0, nmi: false, painOnly: false });
    }
  });

  it('succeeds less often in the cold', () => {
    expect(rates(3, true).nmi).toBeLessThan(rates(3, false).nmi);
  });

  it('reports pain only for one probe and 2 probes at a wide spread', () => {
    const rng = createRng(8);
    let painOnly = 0;
    for (let i = 0; i < N; i++) {
      const s = taserShot(ctx(3, true), t, range, rng);
      expect(s.painOnly).toBe(s.probes >= 1 && !s.nmi);
      if (s.painOnly) painOnly++;
    }
    expect(painOnly).toBeGreaterThan(0);
  });

  it('does worse when the officer moves or the target runs', () => {
    const rng = (): Rng => createRng(21);
    const count = (c: ShotContext & { cold: boolean }): number => {
      const r = rng();
      let h = 0;
      for (let i = 0; i < N; i++) if (taserShot(c, t, range, r).probes > 0) h++;
      return h;
    };
    expect(count({ ...ctx(5), officerMoving: true, targetRunning: true })).toBeLessThan(count(ctx(5)));
  });
});

describe('firearmShot', () => {
  const f = cfg.firearm;
  const hitRate = (c: ShotContext, seed = 11): number => {
    const rng = createRng(seed);
    let h = 0;
    for (let i = 0; i < N; i++) if (firearmShot(c, f, rng, cfg.modifiers).hit) h++;
    return h / N;
  };

  it('draws exactly five numbers, hit or miss', () => {
    expect(drew((r) => firearmShot({ ...BASE, distance: 2 }, f, r), 5)).toBe(true);
    expect(drew((r) => firearmShot({ ...BASE, distance: 90 }, f, r), 5)).toBe(true);
  });

  it('hit rate falls with distance and with movement', () => {
    const r5 = hitRate({ ...BASE, distance: 5 });
    const r15 = hitRate({ ...BASE, distance: 15 });
    const r35 = hitRate({ ...BASE, distance: 35 });
    expect(r5).toBeGreaterThan(r15);
    expect(r15).toBeGreaterThan(r35);
    expect(hitRate({ ...BASE, distance: 15, officerMoving: true })).toBeLessThan(r15);
    expect(hitRate({ ...BASE, distance: 15, targetRunning: true })).toBeLessThan(r15);
    expect(hitRate({ ...BASE, distance: 15, officerCrouched: true })).toBeGreaterThan(r15);
  });

  it('a miss has no injury and zone miss', () => {
    const rng = createRng(2);
    let misses = 0;
    for (let i = 0; i < 2000; i++) {
      const s = firearmShot({ ...BASE, distance: 60 }, f, rng, cfg.modifiers);
      if (!s.hit) {
        misses++;
        expect(s).toEqual({ hit: false, zone: 'miss', injury: 0, fatal: false });
      }
    }
    expect(misses).toBeGreaterThan(0);
  });

  it('zone frequencies match the weights within 3 %', () => {
    const rng = createRng(31);
    const counts = { torso: 0, limb: 0, head: 0 };
    let hits = 0;
    for (let i = 0; i < 20_000; i++) {
      const s = firearmShot({ ...BASE, distance: 1 }, f, rng, cfg.modifiers);
      if (s.zone === 'miss') continue;
      hits++;
      counts[s.zone]++;
    }
    expect(hits).toBeGreaterThan(19_000);
    expect(Math.abs(counts.torso / hits - f.zoneWeights.torso)).toBeLessThan(0.03);
    expect(Math.abs(counts.limb / hits - f.zoneWeights.limb)).toBeLessThan(0.03);
    expect(Math.abs(counts.head / hits - f.zoneWeights.head)).toBeLessThan(0.03);
  });

  it('keeps injury in the zone range and fatality near the configured rates', () => {
    const rng = createRng(77);
    const fatal = { torso: 0, limb: 0, head: 0 };
    const total = { torso: 0, limb: 0, head: 0 };
    for (let i = 0; i < 40_000; i++) {
      const s = firearmShot({ ...BASE, distance: 1 }, f, rng, cfg.modifiers);
      if (s.zone === 'miss') continue;
      const [lo, hi] = f.injury[s.zone];
      expect(s.injury).toBeGreaterThanOrEqual(lo);
      expect(s.injury).toBeLessThanOrEqual(hi);
      total[s.zone]++;
      if (s.fatal) fatal[s.zone]++;
    }
    expect(Math.abs(fatal.torso / total.torso - f.fatal.torso)).toBeLessThan(0.03);
    expect(Math.abs(fatal.head / total.head - f.fatal.head)).toBeLessThan(0.1);
    expect(fatal.limb / total.limb).toBeLessThan(0.06);
  });
});

describe('lessLethalShot', () => {
  const tool = toolDef(cfg, 'lessLethal');
  const ll = cfg.lessLethal;
  const shoot = (distance: number, rng: Rng) => lessLethalShot({ ...BASE, distance }, tool, ll, rng, cfg.modifiers, cfg.firearm.zoneWeights);

  it('draws exactly five numbers', () => {
    expect(drew((r) => shoot(4, r), 5)).toBe(true);
    expect(drew((r) => shoot(80, r), 5)).toBe(true);
  });

  it('is fatal only for a head hit closer than the safe distance', () => {
    const rng = createRng(61);
    let fatalClose = 0;
    for (let i = 0; i < 20_000; i++) {
      const far = shoot(12, rng);
      expect(far.fatal).toBe(false);
      const close = shoot(4, rng);
      if (close.fatal) {
        expect(close.zone).toBe('head');
        fatalClose++;
      }
    }
    expect(fatalClose).toBeGreaterThan(0);
  });

  it('injures from the tool range at a safe distance and from closeInjury when close or on the head', () => {
    const rng = createRng(62);
    for (let i = 0; i < 3000; i++) {
      const s = shoot(10, rng);
      if (!s.hit) continue;
      const range = s.zone === 'head' ? ll.closeInjury : tool.injury;
      expect(s.injury).toBeGreaterThanOrEqual(range[0]);
      expect(s.injury).toBeLessThanOrEqual(range[1]);
      const c = shoot(3, rng);
      if (c.hit) {
        expect(c.injury).toBeGreaterThanOrEqual(ll.closeInjury[0]);
        expect(c.injury).toBeLessThanOrEqual(ll.closeInjury[1]);
      }
    }
  });
});

describe('meleeApply', () => {
  const hands = toolDef(cfg, 'hands');
  const oc = toolDef(cfg, 'ocSpray');

  it('draws exactly three numbers, hit or not', () => {
    expect(drew((r) => meleeApply(hands, false, r), 3)).toBe(true);
    expect(drew((r) => meleeApply({ ...hands, hit: 0 }, false, r), 3)).toBe(true);
  });

  it('hit and incapacitation rates follow the tool', () => {
    const rng = createRng(40);
    let hit = 0;
    let inc = 0;
    for (let i = 0; i < N; i++) {
      const r = meleeApply(hands, false, rng);
      if (r.hit) hit++;
      if (r.incapacitated) {
        inc++;
        expect(r.hit).toBe(true);
      }
    }
    expect(Math.abs(hit / N - hands.hit)).toBeLessThan(0.02);
    expect(Math.abs(inc / N - hands.hit * hands.incapacitate.chance)).toBeLessThan(0.02);
  });

  it('OC spray works less often on an impaired target', () => {
    const count = (impaired: boolean): number => {
      const rng = createRng(41);
      let n = 0;
      for (let i = 0; i < N; i++) if (meleeApply(oc, impaired, rng).incapacitated) n++;
      return n;
    };
    expect(count(true)).toBeLessThan(count(false));
    expect(Math.abs(count(true) / N - 0.9 * 0.85 * 0.7)).toBeLessThan(0.02);
  });

  it('impairment does not change hands', () => {
    const a = createRng(5);
    const b = createRng(5);
    for (let i = 0; i < 200; i++) expect(meleeApply(hands, true, a)).toEqual(meleeApply(hands, false, b));
  });
});

describe('isPregnant', () => {
  const risk = cfg.risk;

  it('is only true for women in the age range', () => {
    for (let id = 0; id < 5000; id++) {
      expect(isPregnant(7, id, 'M', 30, risk)).toBe(false);
      expect(isPregnant(7, id, 'F', 17, risk)).toBe(false);
      expect(isPregnant(7, id, 'F', 43, risk)).toBe(false);
    }
  });

  it('is about 4 % of women in range', () => {
    let n = 0;
    for (let id = 0; id < 20_000; id++) if (isPregnant(7, id, 'F', 30, risk)) n++;
    expect(Math.abs(n / 20_000 - risk.pregnancyRate)).toBeLessThan(0.01);
  });

  it('is deterministic per (seed, id) and accepts "female"', () => {
    for (let id = 0; id < 300; id++) {
      expect(isPregnant(7, id, 'F', 25, risk)).toBe(isPregnant(7, id, 'F', 25, risk));
      expect(isPregnant(7, id, 'female', 25, risk)).toBe(isPregnant(7, id, 'F', 25, risk));
    }
    let differs = false;
    for (let id = 0; id < 2000 && !differs; id++) differs = isPregnant(7, id, 'F', 25, risk) !== isPregnant(8, id, 'F', 25, risk);
    expect(differs).toBe(true);
  });

  it('includes the age bounds', () => {
    const [lo, hi] = risk.pregnancyAge;
    let atLo = false;
    let atHi = false;
    for (let id = 0; id < 5000; id++) {
      atLo ||= isPregnant(7, id, 'F', lo, risk);
      atHi ||= isPregnant(7, id, 'F', hi, risk);
    }
    expect(atLo && atHi).toBe(true);
  });
});

describe('riskFactors', () => {
  const none = { elderly: false, juvenile: false, pregnant: false, elevated: false, running: false, restrained: false };

  it('is empty when nothing applies', () => {
    expect(riskFactors(none)).toEqual([]);
  });

  it('lists names in the fixed order', () => {
    expect(riskFactors({ elderly: true, juvenile: true, pregnant: true, elevated: true, running: true, restrained: true })).toEqual([
      'elderly', 'juvenile', 'pregnant', 'elevated', 'running', 'restrained',
    ]);
    expect(riskFactors({ ...none, restrained: true, elevated: true, elderly: true })).toEqual(['elderly', 'elevated', 'restrained']);
  });
});
