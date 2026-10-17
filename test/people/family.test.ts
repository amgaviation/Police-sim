import { describe, expect, it } from 'vitest';
import { familyOf, nameIndexFor } from '../../src/people/family';
import type { Relation } from '../../src/people/types';
import { lastNameIndex, personIdentity } from '../../src/records/person';
import { SEEDS } from '../records/helpers';

const INVERSE: Record<Relation, Relation> = { parent: 'child', child: 'parent', partner: 'partner', sibling: 'sibling', relative: 'relative' };

describe('family links', () => {
  for (const seed of SEEDS) {
    it(`are symmetric inside last-name buckets (seed ${seed})`, () => {
      const index = nameIndexFor(seed);
      const seen = new Set<Relation>();
      let links = 0;
      for (let id = 0; id < 100000; id += 37) {
        const fam = familyOf(seed, id, index);
        const last = personIdentity(seed, id).last;
        const sorted = [...fam].sort((a, b) => a.personId - b.personId);
        expect(fam).toEqual(sorted);
        for (const l of fam) {
          expect(l.personId).not.toBe(id);
          expect(personIdentity(seed, l.personId).last).toBe(last);
          expect(lastNameIndex(seed, l.personId)).toBe(lastNameIndex(seed, id));
          const back = familyOf(seed, l.personId, index).find((b) => b.personId === id);
          expect(back?.relation).toBe(INVERSE[l.relation]);
          seen.add(l.relation);
          links++;
        }
      }
      expect(links).toBeGreaterThan(1000);
      expect([...seen].sort()).toEqual(['child', 'parent', 'partner', 'relative', 'sibling']);
    });
  }

  it('has at most one partner per cluster pair and respects the age rules', () => {
    const seed = 42;
    const index = nameIndexFor(seed);
    for (let id = 0; id < 20000; id += 13) {
      const fam = familyOf(seed, id, index);
      const dob = personIdentity(seed, id).dob;
      expect(fam.filter((f) => f.relation === 'partner').length).toBeLessThanOrEqual(1);
      for (const f of fam) {
        const otherDob = personIdentity(seed, f.personId).dob;
        const gapYears = Math.abs(dob - otherDob) / 365.25;
        if (f.relation === 'parent') expect(otherDob).toBeLessThan(dob);
        if (f.relation === 'child') expect(otherDob).toBeGreaterThan(dob);
        if (f.relation === 'parent' || f.relation === 'child') expect(gapYears).toBeGreaterThan(17);
        if (f.relation === 'sibling' || f.relation === 'partner') expect(gapYears).toBeLessThan(18);
      }
    }
  });

  it('is deterministic', () => {
    const index = nameIndexFor(42);
    for (let id = 0; id < 100000; id += 1111) expect(familyOf(42, id, index)).toEqual(familyOf(42, id, index));
  });
});
