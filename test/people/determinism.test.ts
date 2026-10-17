import { describe, expect, it } from 'vitest';
import { generateIdentity } from '../../src/people/identity';
import type { PeopleSave } from '../../src/people/types';
import { CALENDAR } from '../../src/records/calendar';
import { RecordsDb } from '../../src/records/db';
import { fakeCtx } from '../records/helpers';
import { DAY, SEED, ids, makeRig } from './helpers';

const DAY0 = CALENDAR.startEpochDay;

describe('identity determinism', () => {
  const list = ids(2000);
  const records = new RecordsDb(SEED, fakeCtx());

  it('generateIdentity is a pure function of (seed, id, record, day): twice and in reverse order', () => {
    const first = list.map((id) => generateIdentity(SEED, id, records.peekPerson(id), DAY0));
    const second = list.map((id) => generateIdentity(SEED, id, records.peekPerson(id), DAY0));
    expect(second).toEqual(first);
    const reversed = [...list].reverse().map((id) => generateIdentity(SEED, id, records.peekPerson(id), DAY0)).reverse();
    expect(reversed).toEqual(first);
  });

  it('a second Population (new session, same seed) produces the same identities and states', () => {
    const a = makeRig();
    const b = makeRig();
    for (const id of list.slice(0, 500)) {
      expect(b.pop.identity(id)).toEqual(a.pop.identity(id));
      expect(b.pop.state(id)).toEqual(a.pop.state(id));
    }
  });

  it('survives serialize -> JSON -> restore into a fresh Population (identities and states equal)', () => {
    const a = makeRig(SEED, 20 * 3600);
    const sample = list.slice(0, 300);
    // Touch some persons so deltas exist.
    for (const id of sample.slice(0, 40)) {
      a.pop.setMood(id, 0.25);
      a.pop.setIntoxication(id, 0.11, 'cannabis');
      a.pop.addStatement(id, { incident: 'C-00001', fact: 'name', value: 'x', text: 'my name is x', game: a.clock.t, truthful: true, confused: false });
    }
    a.pop.setCustody(sample[1] ?? 0, 'arrested');
    const json = JSON.parse(JSON.stringify(a.pop.serialize())) as PeopleSave;
    const b = makeRig(SEED, 20 * 3600);
    b.pop.restore(json);
    for (const id of sample) {
      expect(b.pop.identity(id)).toEqual(a.pop.identity(id));
      expect(b.pop.state(id)).toEqual(a.pop.state(id));
      expect(b.pop.statements(id)).toEqual(a.pop.statements(id));
    }
    expect(b.pop.serialize()).toEqual(a.pop.serialize());
  });

  it('different seeds give different identities', () => {
    const other = new RecordsDb(1234, fakeCtx());
    let differing = 0;
    for (const id of list.slice(0, 200)) {
      const a = generateIdentity(SEED, id, records.peekPerson(id), DAY0);
      const b = generateIdentity(1234, id, other.peekPerson(id), DAY0);
      if (a.record.last !== b.record.last || a.temperament !== b.temperament || a.honesty !== b.honesty) differing++;
    }
    expect(differing).toBeGreaterThan(190);
  });

  it('daily traits change with the day, persistent traits do not', () => {
    const rig = makeRig();
    let clothesChanged = 0;
    let temperamentSame = 0;
    const sample = list.slice(0, 100);
    const day0 = sample.map((id) => rig.pop.identity(id));
    rig.clock.t = 3 * DAY;
    for (let i = 0; i < sample.length; i++) {
      const today = rig.pop.identity(sample[i] ?? 0);
      const before = day0[i];
      if (!before) continue;
      if (today.appearance.top !== before.appearance.top || today.appearance.bottom !== before.appearance.bottom) clothesChanged++;
      if (today.temperament === before.temperament && today.honesty === before.honesty && today.appearance.skin === before.appearance.skin) temperamentSame++;
    }
    expect(clothesChanged).toBeGreaterThan(30);
    expect(temperamentSame).toBe(sample.length);
  });

  it('peeking identities does not touch the records snapshot', () => {
    const rig = makeRig();
    for (const id of list.slice(0, 100)) rig.pop.identity(id);
    expect(rig.records.serialize().persons).toHaveLength(0);
    expect(rig.pop.isTouched(list[0] ?? 0)).toBe(false);
    expect(rig.pop.serialize().persons).toHaveLength(0);
  });
});
