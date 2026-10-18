import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { CALL_CATALOG, VARIANT_KINDS, type VariantKind } from '../../src/calls/catalog';
import { pickBranch, pickVariants } from '../../src/calls/scenario';
import { callTypeDef, familyDef } from '../../src/calls/catalog';
import { outcomeFor, objectivesFor } from '../../src/calls/conditions';
import { buildScenario } from '../../src/calls/scenario';
import { scriptFor } from '../../src/scene/director';
import { ScriptedRng } from '../../src/scene/text';
import { rngFor, stubInput } from './stub';

const RATES = CALL_CATALOG.variants.rates;
const ONES = Object.fromEntries(VARIANT_KINDS.map((k) => [k, 1])) as Record<VariantKind, number>;
const ZEROS = Object.fromEntries(VARIANT_KINDS.map((k) => [k, 0])) as Record<VariantKind, number>;

function frequencies(multipliers: Record<VariantKind, number>, draws: number, seed: string): Record<VariantKind, number> {
  const rng = createRng(seed);
  const counts = Object.fromEntries(VARIANT_KINDS.map((k) => [k, 0])) as Record<VariantKind, number>;
  for (let i = 0; i < draws; i++) for (const k of pickVariants(RATES, multipliers, rng)) counts[k]++;
  return counts;
}

function within4Sigma(count: number, n: number, p: number): boolean {
  const sd = Math.sqrt(n * p * (1 - p));
  return Math.abs(count - n * p) <= 4 * sd;
}

describe('pickVariants', () => {
  it('draws each kind at its configured rate over 20000 draws', () => {
    const n = 20000;
    const counts = frequencies(ONES, n, 'variants-1');
    const exclusive = RATES.false + RATES.swatting + RATES.ambush;
    const expected: Record<VariantKind, number> = {
      false: RATES.false,
      swatting: RATES.swatting,
      ambush: RATES.ambush,
      duplicate: RATES.duplicate,
      escalation: (1 - exclusive) * RATES.escalation,
      deescalation: (1 - exclusive) * RATES.deescalation,
    };
    for (const k of VARIANT_KINDS) {
      expect(within4Sigma(counts[k], n, expected[k]), `${k}: ${counts[k]} of ${n} (p ${expected[k]})`).toBe(true);
    }
  });

  it('scales rates by the multipliers and never draws a kind with multiplier 0', () => {
    const n = 20000;
    const counts = frequencies({ ...ONES, false: 0, swatting: 0, ambush: 0, duplicate: 0, escalation: 0 }, n, 'variants-2');
    expect(counts.false).toBe(0);
    expect(counts.swatting).toBe(0);
    expect(counts.ambush).toBe(0);
    expect(counts.duplicate).toBe(0);
    expect(counts.escalation).toBe(0);
    expect(within4Sigma(counts.deescalation, n, RATES.deescalation), `${counts.deescalation}`).toBe(true);
    expect(Object.values(frequencies(ZEROS, n, 'variants-3')).every((c) => c === 0)).toBe(true);
    const doubled = frequencies({ ...ZEROS, duplicate: 2 }, n, 'variants-4');
    expect(within4Sigma(doubled.duplicate, n, RATES.duplicate * 2)).toBe(true);
  });

  it('excludes escalation and de-escalation after false, swatting and ambush', () => {
    const rng = createRng('variants-5');
    for (let i = 0; i < 20000; i++) {
      const v = pickVariants(RATES, ONES, rng);
      if (v.includes('false') || v.includes('swatting') || v.includes('ambush')) {
        expect(v.includes('escalation') || v.includes('deescalation')).toBe(false);
      }
      expect(v.filter((k) => k === 'false' || k === 'swatting' || k === 'ambush').length).toBeLessThanOrEqual(1);
      expect(v.includes('escalation') && v.includes('deescalation')).toBe(false);
    }
  });

  it('always consumes three draws', () => {
    const a = createRng('d');
    const b = createRng('d');
    pickVariants(RATES, ZEROS, a);
    pickVariants(RATES, ONES, b);
    expect(a.next()).toBe(b.next());
  });
});

describe('pickBranch', () => {
  const dui = familyDef('dui');
  it('follows family weights and honours type overrides (0 disables)', () => {
    if (!dui) throw new Error('dui');
    const n = 4000;
    const rng = createRng('branches');
    const counts: Record<string, number> = {};
    for (let i = 0; i < n; i++) {
      const b = pickBranch(dui, null, rng);
      counts[b.id] = (counts[b.id] ?? 0) + 1;
    }
    expect(counts.asleepParked).toBeUndefined();
    const total = 6 + 2 + 1 + 1;
    expect(within4Sigma(counts.drunk ?? 0, n, 6 / total)).toBe(true);
    expect(within4Sigma(counts.drugged ?? 0, n, 2 / total)).toBe(true);

    const asleep = callTypeDef('driverAsleepAtWheel');
    const ids = new Set<string>();
    for (let i = 0; i < 200; i++) ids.add(pickBranch(dui, asleep, rng).id);
    expect([...ids]).toEqual(['asleepParked']);
  });

  it('draws exactly one number', () => {
    if (!dui) throw new Error('dui');
    const a = createRng('one');
    const b = createRng('one');
    pickBranch(dui, null, a);
    b.next();
    expect(a.next()).toBe(b.next());
  });
});

describe('ambush scenarios', () => {
  const ambushFamilies = CALL_CATALOG.families.filter((f) => f.variants.ambush > 0);

  it('every family that can be ambushed has an outcome for it', () => {
    expect(ambushFamilies.length).toBeGreaterThanOrEqual(7);
    for (const f of ambushFamilies) {
      expect(JSON.stringify(f.outcomes.map((o) => o.when)), f.id).toContain('variant:ambush');
      expect(JSON.stringify(f.outcomes.map((o) => o.when)), f.id).toContain('custody:ambusher');
    }
  });

  it('keeps the branch flags of removed roles out of an ambush, so outcomes and objectives are about the ambush', () => {
    let built = 0;
    for (const f of ambushFamilies) {
      const type = CALL_CATALOG.types.find((t) => t.family === f.id);
      if (!type) continue;
      for (let seed = 1; seed <= 30; seed++) {
        const sc = buildScenario(stubInput({ typeId: type.id, seed }), new ScriptedRng(rngFor(seed, 1), scriptFor(['ambush'], type.variants ?? f.variants)));
        expect(sc.variants, `${f.id} seed ${String(seed)}`).toContain('ambush');
        built++;
        const flags = new Set(sc.flags);
        const branch = f.branches.find((b) => b.id === sc.branch);
        for (const flag of branch?.flags ?? []) expect(flags.has(flag), `${f.id}/${sc.branch} ${flag}`).toBe(false);
        expect(outcomeFor(f, flags).id, `${f.id}/${sc.branch}`).toBe('ambushed');
        flags.add('custody:ambusher');
        expect(outcomeFor(f, flags).disposition).toBe('arrestMade');
        for (const o of objectivesFor(f, flags)) expect(o.text).not.toMatch(/Victim injured/);
      }
    }
    expect(built).toBe(ambushFamilies.length * 30);
  });
});
