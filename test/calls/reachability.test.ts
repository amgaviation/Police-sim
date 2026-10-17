import { describe, expect, it } from 'vitest';
import { CALL_CATALOG } from '../../src/calls/catalog';
import { outcomeFor, reachableOutcomes } from '../../src/calls/conditions';
import type { FamilyDef } from '../../src/calls/types';
import { clone } from './helpers';

describe('outcome reachability', () => {
  for (const family of CALL_CATALOG.families) {
    it(`${family.id}: every outcome is reachable and the witness selects it`, () => {
      const result = reachableOutcomes(family);
      expect(result.map((r) => r.outcome)).toEqual(family.outcomes.map((o) => o.id));
      for (const r of result) {
        expect(r.reachable, `${family.id}/${r.outcome}`).toBe(true);
        expect(outcomeFor(family, new Set(r.witness)).id, `${family.id}/${r.outcome}`).toBe(r.outcome);
      }
    });
  }

  it('reports an outcome that no branch can satisfy as unreachable', () => {
    const family = clone(CALL_CATALOG.families.find((f) => f.id === 'domestic') as FamilyDef) as { outcomes: unknown[] } & FamilyDef;
    const broken: FamilyDef = {
      ...family,
      outcomes: [
        { id: 'impossible', when: { all: ['branch:verbal', 'branch:assault'] }, disposition: 'handled', grade: 'ok' },
        { id: 'ghostRole', when: 'custody:resident', disposition: 'handled', grade: 'ok' },
        ...family.outcomes,
      ] as FamilyDef['outcomes'],
    };
    const result = reachableOutcomes(broken);
    expect(result.find((r) => r.outcome === 'impossible')?.reachable).toBe(false);
    expect(result.find((r) => r.outcome === 'impossible')?.witness).toEqual([]);
    expect(result.find((r) => r.outcome === 'ghostRole')?.reachable).toBe(false);
    expect(result.find((r) => r.outcome === 'default')?.reachable).toBe(true);
  });

  it('reaches a later outcome only past the earlier ones it would otherwise shadow', () => {
    const medical = CALL_CATALOG.families.find((f) => f.id === 'medical');
    expect(medical).toBeDefined();
    const result = reachableOutcomes(medical as FamilyDef);
    // "noEms" (!service:ems) would shadow the default; the witness adds service:ems.
    const def = result.find((r) => r.outcome === 'default');
    expect(def?.witness).toContain('service:ems');
  });
});
