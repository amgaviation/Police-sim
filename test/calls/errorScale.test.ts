import { describe, expect, it } from 'vitest';
import { CALL_CATALOG } from '../../src/calls/catalog';
import { buildScenario, type Scenario } from '../../src/calls/scenario';
import { rngFor, stubInput } from './stub';

const N = 400;

function build(callId: number, errorScale?: number): Scenario {
  const input = { ...stubInput({ typeId: 'armedPerson', callId }), ...(errorScale === undefined ? {} : { errorScale }) };
  return buildScenario(input, rngFor(input.seed, input.callId));
}

function counts(scale?: number): { address: number; description: number; weapon: number } {
  const c = { address: 0, description: 0, weapon: 0 };
  for (let i = 1; i <= N; i++) {
    const e = build(i, scale).errors;
    if (e.wrongAddress) c.address++;
    if (e.wrongDescription) c.description++;
    if (e.missingWeapon) c.weapon++;
  }
  return c;
}

describe('ScenarioInput.errorScale', () => {
  it('defaults to 1: absent and 1 build identical scenarios', () => {
    for (let i = 1; i <= 40; i++) expect(build(i, 1)).toEqual(build(i));
  });

  it('0 gives no dispatch errors and no corrections', () => {
    const c = counts(0);
    expect(c).toEqual({ address: 0, description: 0, weapon: 0 });
    for (let i = 1; i <= 60; i++) {
      const s = build(i, 0);
      expect(s.timeline.some((e) => e.kind === 'correction')).toBe(false);
    }
  });

  it('3 gives more errors than 1 of every kind (seeded counts over 400 scenarios)', () => {
    const base = counts(1);
    const tripled = counts(3);
    expect(tripled.address).toBeGreaterThan(base.address);
    expect(tripled.description).toBeGreaterThan(base.description);
    expect(tripled.weapon).toBeGreaterThan(base.weapon);
    const rates = CALL_CATALOG.variants.dispatchErrors;
    // Roughly three times the base rate (a rate scaled past 1 saturates).
    expect(tripled.description).toBeGreaterThan(N * rates.wrongDescription * 2);
    expect(tripled.description).toBeLessThan(N * Math.min(1, rates.wrongDescription * 3) * 1.3);
  });

  it('uses the same draws: the scenario differs only where an error flips', () => {
    for (let i = 1; i <= 60; i++) {
      const a = build(i, 0);
      const b = build(i, 3);
      expect(b.participants.map((p) => p.personId)).toEqual(a.participants.map((p) => p.personId));
      expect(b.variants).toEqual(a.variants);
      expect(b.branch).toBe(a.branch);
      expect(b.vehicles).toEqual(a.vehicles);
    }
  });

  it('a scale above 1/rate makes every error certain', () => {
    for (let i = 1; i <= 30; i++) {
      const e = build(i, 1000).errors;
      expect(e.wrongDescription).toBe(true);
      expect(e.missingWeapon).toBe(true);
    }
  });
});
