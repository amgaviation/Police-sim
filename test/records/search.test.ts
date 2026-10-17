import { describe, expect, it } from 'vitest';
import { NAMES } from '../../src/records/data';
import { PERSON_POPULATION } from '../../src/records/ids';
import { lastNameIndex } from '../../src/records/person';
import { NameIndex } from '../../src/records/search';
import { SEEDS } from './helpers';

describe('NameIndex.bucket', () => {
  for (const seed of SEEDS) {
    it(`lists exactly the ids with that last-name index, ascending (seed ${seed})`, () => {
      const index = new NameIndex(seed);
      let total = 0;
      for (let b = 0; b < NAMES.last.length; b++) {
        const ids = index.bucket(b, []);
        total += ids.length;
        for (let i = 0; i < ids.length; i++) {
          expect(lastNameIndex(seed, ids[i] ?? -1)).toBe(b);
          if (i > 0) expect(ids[i] ?? 0).toBeGreaterThan(ids[i - 1] ?? 0);
        }
      }
      expect(total).toBe(PERSON_POPULATION);
    });
  }

  it('appends to and returns `out`; out-of-range buckets add nothing', () => {
    const index = new NameIndex(42);
    const out = [-7];
    expect(index.bucket(3, out)).toBe(out);
    expect(out[0]).toBe(-7);
    expect(out.length).toBeGreaterThan(1);
    const before = out.length;
    index.bucket(-1, out);
    index.bucket(NAMES.last.length, out);
    index.bucket(1.5, out);
    expect(out).toHaveLength(before);
  });

  it('agrees with candidates() for an exact last name', () => {
    const index = new NameIndex(42);
    const name = NAMES.last[10] ?? '';
    const viaBucket = index.bucket(10, []);
    const viaCandidates = index.candidates(name, []).filter((id) => lastNameIndex(42, id) === 10);
    expect(viaBucket).toEqual(viaCandidates);
  });
});
