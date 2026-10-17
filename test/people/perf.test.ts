import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../../src/people/identity';
import { CALENDAR } from '../../src/records/calendar';
import { RecordsDb } from '../../src/records/db';
import { fakeCtx } from '../records/helpers';
import { SEED, ids } from './helpers';

describe('people performance', () => {
  it('2000 generateIdentity calls take at most 400 ms', () => {
    const records = new RecordsDb(SEED, fakeCtx());
    const list = ids(2000);
    const recs = list.map((id) => records.peekPerson(id)); // record generation is Phase 2's cost
    const t0 = performance.now();
    for (let i = 0; i < list.length; i++) generateIdentity(SEED, list[i] ?? 0, recs[i]!, CALENDAR.startEpochDay);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThanOrEqual(400);
  });
});
