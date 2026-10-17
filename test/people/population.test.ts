import { describe, expect, it } from 'vitest';
import { PEOPLE_CAP, PER_PERSON_CAP, Population, isPeopleSave } from '../../src/people/population';
import type { PeopleSave, PersonFact, Statement } from '../../src/people/types';
import { ownerOfVehicle } from '../../src/records/ids';
import { driverOf } from '../../src/records/vehicle';
import { REGISTRY_POPULATION } from '../../src/traffic/registry';
import { DAY, SEED, makeRig } from './helpers';

function statement(incident: string, n = 0): Statement {
  return { incident, fact: 'name', value: `v${n}`, text: `text ${n}`, game: n, truthful: n % 2 === 0, confused: false };
}

function fact(incident: string, n = 0): Omit<PersonFact, 'id'> {
  return { incident, topic: 'name', value: `v${n}`, source: 'claim', display: `d${n}`, detail: '', game: n };
}

function roundTrip(p: Population): PeopleSave {
  return JSON.parse(JSON.stringify(p.serialize())) as PeopleSave;
}

describe('Population deltas', () => {
  it('starts untouched with the base state', () => {
    const { pop } = makeRig();
    expect(pop.isTouched(5)).toBe(false);
    const s = pop.state(5);
    expect(s).toMatchObject({ mood: 0, custody: 'none', injured: 0, deceased: false, missing: false });
    expect(pop.revision).toBe(0);
    expect(pop.statements(5)).toEqual([]);
    expect(pop.facts(5)).toEqual([]);
    expect(pop.officerHistory(5)).toEqual({ count: 0, lastGame: 0, lastOutcome: '', rapport: 0 });
    expect(pop.lieFor(5, 'C-1', 'name')).toBeNull();
    expect(pop.hasFlag(5, 'x')).toBe(false);
    expect(pop.serialize()).toEqual({ version: 1, identityVersion: 1, persons: [] });
  });

  it('sets and clears every state field, bumping the revision', () => {
    const { pop, clock } = makeRig();
    clock.t = 1000;
    let rev = pop.revision;
    const bumped = (): boolean => {
      const r = pop.revision;
      const b = r > rev;
      rev = r;
      return b;
    };
    pop.setMood(8, 0.4);
    expect(bumped()).toBe(true);
    expect(pop.state(8).mood).toBe(0.4);
    expect(pop.isTouched(8)).toBe(true);
    pop.setMood(8, 0);
    expect(bumped()).toBe(true);
    expect(pop.state(8).mood).toBe(0);
    expect(pop.isTouched(8)).toBe(false);

    pop.setCustody(8, 'arrested');
    expect(pop.state(8).custody).toBe('arrested');
    expect(pop.serialize().persons[0]).toMatchObject({ id: 8, custody: 'arrested', custodySince: 1000, touched: 1000 });
    pop.setCustody(8, 'none');
    expect(pop.state(8).custody).toBe('none');
    expect(pop.isTouched(8)).toBe(false);
    expect(() => pop.setCustody(8, 'bogus' as never)).toThrow(RangeError);

    pop.setInjured(8, 0.7);
    expect(pop.state(8).injured).toBe(0.7);
    pop.setInjured(8, 5);
    expect(pop.state(8).injured).toBe(1);
    pop.setInjured(8, 0);
    expect(pop.isTouched(8)).toBe(false);

    pop.setMissing(8, true);
    expect(pop.state(8).missing).toBe(true);
    pop.setMissing(8, false);
    expect(pop.state(8).missing).toBe(false);
    expect(pop.isTouched(8)).toBe(false);

    pop.setDeceased(8);
    expect(pop.state(8).deceased).toBe(true);
    expect(bumped()).toBe(true);

    // A no-op clear does not bump the revision.
    pop.setMood(99, 0);
    pop.setMissing(99, false);
    expect(bumped()).toBe(false);
    expect(() => pop.setMood(100000, 1)).toThrow(RangeError);
    expect(() => pop.identity(-1)).toThrow(RangeError);
  });

  it('intoxication: explicit values decay, ensureIntoxicated only raises', () => {
    const { pop, clock } = makeRig();
    clock.t = 10 * 3600;
    pop.ensureIntoxicated(3, 0.09);
    expect(pop.intoxication(3).bac).toBeCloseTo(0.09, 9);
    pop.ensureIntoxicated(3, 0.05);
    expect(pop.intoxication(3).bac).toBeCloseTo(0.09, 9);
    clock.t += 3600;
    expect(pop.intoxication(3).bac).toBeCloseTo(0.075, 9);
    pop.setIntoxication(4, 0.2, 'opioid');
    const x = pop.intoxication(4);
    expect(x.drug).toBe('opioid');
    expect(x.level).toBe(1);
    clock.t += 5 * 3600;
    expect(pop.intoxication(4).drug).toBe('none');
    expect(pop.state(4).intoxication).toEqual(pop.intoxication(4));
  });

  it('adds and seizes person items; instance ids stay unique', () => {
    const { pop } = makeRig();
    const id = 21;
    const before = pop.itemsOn(id);
    expect(pop.itemsOn(id)).toBe(before); // untouched: the cached base array
    const first = before[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(pop.seize({ kind: 'person', id }, first.instance)).toBe(true);
    expect(pop.seize({ kind: 'person', id }, first.instance)).toBe(false);
    expect(pop.seize({ kind: 'person', id }, 'p21:nothing:0')).toBe(false);
    expect(pop.seize({ kind: 'person', id: 22 }, first.instance)).toBe(false);
    expect(pop.itemsOn(id).map((i) => i.instance)).not.toContain(first.instance);
    expect(pop.itemsOn(id)).toHaveLength(before.length - 1);

    const a = pop.addItem({ kind: 'person', id }, 'knife', 'waistband', false);
    const b = pop.addItem({ kind: 'person', id }, 'knife', 'hand', true);
    expect(a.instance).not.toBe(b.instance);
    expect(a.instance).toMatch(/^p21:knife:\d+$/);
    expect(pop.itemsOn(id).filter((i) => i.item === 'knife').map((i) => i.instance)).toContain(b.instance);
    expect(pop.seize({ kind: 'person', id }, a.instance)).toBe(true);
    const c = pop.addItem({ kind: 'person', id }, 'knife', 'pocket', false);
    expect(new Set([a.instance, b.instance, c.instance]).size).toBe(3);
    expect(() => pop.addItem({ kind: 'person', id }, 'bazooka', 'hand', true)).toThrow('Unknown item');

    const loaded = makeRig();
    loaded.pop.restore(roundTrip(pop));
    expect(loaded.pop.itemsOn(id)).toEqual(pop.itemsOn(id));
  });

  it('keeps vehicle-owned items on the delta of the vehicle owner', () => {
    const { pop, clock } = makeRig();
    clock.t = 22 * 3600;
    let vehicle = -1;
    for (let v = 0; v < 400; v++) {
      const driver = driverOf(SEED, v);
      pop.setIntoxication(driver, 0.15, 'none');
      if (pop.vehicleItems(v, driver).some((i) => i.item === 'openContainer')) {
        vehicle = v;
        break;
      }
    }
    expect(vehicle).toBeGreaterThanOrEqual(0);
    const driver = driverOf(SEED, vehicle);
    const items = pop.vehicleItems(vehicle, driver);
    const open = items.find((i) => i.item === 'openContainer');
    expect(open).toMatchObject({ where: 'cabin', visible: true, instance: `v${vehicle}:openContainer:0` });
    const owner = ownerOfVehicle(SEED, vehicle);
    expect(pop.seize({ kind: 'vehicle', id: vehicle }, `v${vehicle}:openContainer:0`)).toBe(true);
    expect(pop.vehicleItems(vehicle, driver).some((i) => i.item === 'openContainer')).toBe(false);
    const placed = pop.addItem({ kind: 'vehicle', id: vehicle }, 'suspiciousPackage', 'trunk', false);
    expect(placed.instance).toMatch(new RegExp(`^v${vehicle}:suspiciousPackage:\\d+$`));
    expect(pop.vehicleItems(vehicle, driver).map((i) => i.instance)).toContain(placed.instance);
    // Stored on the owner's delta, not the driver's (unless they are the same person).
    const save = pop.serialize();
    const ownerDelta = save.persons.find((p) => p.id === owner);
    expect(ownerDelta?.added?.some((a) => a.instance === placed.instance && a.owner === 'vehicle' && a.ownerId === vehicle)).toBe(true);
    expect(ownerDelta?.seized).toContain(`v${vehicle}:openContainer:0`);
    // The owner's own person items are untouched by vehicle-owned entries.
    expect(pop.itemsOn(owner).some((i) => i.instance === placed.instance)).toBe(false);

    const loaded = makeRig(SEED, clock.t);
    loaded.pop.restore(JSON.parse(JSON.stringify(save)) as PeopleSave);
    loaded.pop.setIntoxication(driver, 0.15, 'none');
    expect(loaded.pop.vehicleItems(vehicle, driver).map((i) => i.instance)).toEqual(pop.vehicleItems(vehicle, driver).map((i) => i.instance));
  });

  it('rejects fleet vehicles for scenario items and returns no contents for them', () => {
    const { pop } = makeRig();
    expect(pop.vehicleItems(1 << 20, 5)).toEqual([]);
    expect(() => pop.addItem({ kind: 'vehicle', id: 1 << 20 }, 'knife', 'cabin', true)).toThrow(RangeError);
    expect(() => pop.addItem({ kind: 'vehicle', id: REGISTRY_POPULATION }, 'knife', 'cabin', true)).toThrow(RangeError);
  });

  it('caps statements, facts and lies per person; fact ids are unique and never reused', () => {
    const { pop } = makeRig();
    for (let n = 0; n < PER_PERSON_CAP + 40; n++) {
      pop.addStatement(9, statement(n % 2 === 0 ? 'C-1' : 'C-2', n));
      pop.addFact(9, fact('C-1', n));
      pop.rememberLie(9, 'C-1', `topic${n}`, `v${n}`);
    }
    expect(pop.statements(9)).toHaveLength(PER_PERSON_CAP);
    expect(pop.statements(9)[0]?.value).toBe('v40');
    expect(pop.statements(9).at(-1)?.value).toBe(`v${PER_PERSON_CAP + 39}`);
    expect(pop.statements(9, 'C-2').every((s) => s.incident === 'C-2')).toBe(true);
    const facts = pop.facts(9);
    expect(facts).toHaveLength(PER_PERSON_CAP);
    expect(facts[0]?.id).toBe(41);
    expect(facts.at(-1)?.id).toBe(PER_PERSON_CAP + 40);
    expect(new Set(facts.map((f) => f.id)).size).toBe(PER_PERSON_CAP);
    expect(pop.facts(9, 'C-9')).toEqual([]);
    expect(pop.lieFor(9, 'C-1', 'topic0')).toBeNull();
    expect(pop.lieFor(9, 'C-1', `topic${PER_PERSON_CAP + 39}`)).toBe(`v${PER_PERSON_CAP + 39}`);
    // Ids continue across a save / load.
    const loaded = makeRig();
    loaded.pop.restore(roundTrip(pop));
    expect(loaded.pop.addFact(9, fact('C-1', 1)).id).toBe(PER_PERSON_CAP + 41);
    // Per-person ids.
    expect(pop.addFact(10, fact('C-1')).id).toBe(1);
    expect(pop.addFact(10, fact('C-1')).id).toBe(2);
  });

  it('remembers lies per incident and fact, overwriting the value', () => {
    const { pop } = makeRig();
    pop.rememberLie(2, 'C-1', 'address', '12 Elm St');
    pop.rememberLie(2, 'C-2', 'address', '99 Oak St');
    expect(pop.lieFor(2, 'C-1', 'address')).toBe('12 Elm St');
    expect(pop.lieFor(2, 'C-2', 'address')).toBe('99 Oak St');
    pop.rememberLie(2, 'C-1', 'address', '5 Pine St');
    expect(pop.lieFor(2, 'C-1', 'address')).toBe('5 Pine St');
    expect(pop.lieFor(2, 'C-1', 'name')).toBeNull();
  });

  it('tracks contacts with the officer and flags', () => {
    const { pop, clock } = makeRig();
    clock.t = 5000;
    pop.recordContact(6, 'warning', 0.3);
    clock.t = 9000;
    pop.recordContact(6, 'arrest', -0.8);
    expect(pop.officerHistory(6)).toEqual({ count: 2, lastGame: 9000, lastOutcome: 'arrest', rapport: -0.5 });
    pop.recordContact(6, 'cite', 5);
    expect(pop.officerHistory(6).rapport).toBe(1);
    pop.setFlag(6, 'knownInformant', true);
    pop.setFlag(6, 'knownInformant', true);
    expect(pop.hasFlag(6, 'knownInformant')).toBe(true);
    expect(pop.serialize().persons[0]?.flags).toEqual(['knownInformant']);
    pop.setFlag(6, 'knownInformant', false);
    expect(pop.hasFlag(6, 'knownInformant')).toBe(false);
  });

  it('caps the stored persons, dropping only the least recently touched droppable ones', () => {
    const { pop, clock } = makeRig();
    const keepers = [11, 12, 13, 14, 15];
    clock.t = 1;
    pop.addStatement(keepers[0] ?? 0, statement('C-1'));
    pop.addFact(keepers[1] ?? 0, fact('C-1'));
    pop.setCustody(keepers[2] ?? 0, 'detained');
    pop.recordContact(keepers[3] ?? 0, 'warning', 0.1);
    pop.addItem({ kind: 'person', id: keepers[4] ?? 0 }, 'knife', 'hand', true);
    const total = PEOPLE_CAP + 600;
    for (let n = 0; n < total; n++) {
      clock.t = 10 + n;
      pop.setMood(1000 + n, 0.5);
    }
    const save = pop.serialize();
    expect(save.persons.length).toBeLessThanOrEqual(PEOPLE_CAP);
    expect(save.persons.length).toBeGreaterThan(PEOPLE_CAP - 400);
    const have = new Set(save.persons.map((p) => p.id));
    for (const k of keepers) expect(have.has(k)).toBe(true);
    expect(have.has(1000)).toBe(false); // the oldest droppable were evicted
    expect(have.has(1000 + total - 1)).toBe(true); // the newest remain
    expect(pop.isTouched(1000)).toBe(false);
    // Sorted ascending for stable saves.
    const sorted = [...save.persons].sort((a, b) => a.id - b.id);
    expect(save.persons).toEqual(sorted);
  });

  it('keeps protected persons even when they alone exceed the cap', () => {
    const { pop } = makeRig();
    for (let n = 0; n < PEOPLE_CAP + 50; n++) pop.addStatement(n, statement('C-1'));
    expect(pop.serialize().persons).toHaveLength(PEOPLE_CAP + 50);
    const loaded = makeRig();
    loaded.pop.restore(roundTrip(pop));
    expect(loaded.pop.serialize().persons).toHaveLength(PEOPLE_CAP + 50);
  });

  it('enforces the cap on restore for droppable persons', () => {
    const { pop } = makeRig();
    const persons = Array.from({ length: PEOPLE_CAP + 300 }, (_, n) => ({ id: n, touched: n, mood: 0.3 }));
    pop.restore({ version: 1, identityVersion: 1, persons });
    const out = pop.serialize().persons;
    expect(out.length).toBeLessThanOrEqual(PEOPLE_CAP);
    expect(out.some((p) => p.id === PEOPLE_CAP + 299)).toBe(true);
    expect(out.some((p) => p.id === 0)).toBe(false);
  });

  it('drops expired explicit intoxication from the save', () => {
    const { pop, clock } = makeRig();
    pop.setIntoxication(30, 0.04, 'none');
    clock.t += DAY;
    expect(pop.serialize().persons).toEqual([]);
    clock.t = 0;
    pop.setIntoxication(31, 0.12, 'none');
    clock.t = 3600;
    expect(pop.serialize().persons.find((p) => p.id === 31)?.intox).toMatchObject({ bac: 0.12, setAt: 0 });
  });
});

describe('PeopleSave validation', () => {
  it('isPeopleSave checks the envelope', () => {
    expect(isPeopleSave({ version: 1, identityVersion: 1, persons: [] })).toBe(true);
    expect(isPeopleSave({ version: 1, identityVersion: 1, persons: [{ id: 1, touched: 0 }] })).toBe(true);
    expect(isPeopleSave({ version: 2, identityVersion: 1, persons: [] })).toBe(false);
    expect(isPeopleSave({ version: 1, identityVersion: 2, persons: [] })).toBe(false);
    expect(isPeopleSave({ version: 1, identityVersion: 1, persons: {} })).toBe(false);
    expect(isPeopleSave({ version: 1, identityVersion: 1, persons: [1] })).toBe(true); // entries are dropped one by one on restore
    expect(isPeopleSave(null)).toBe(false);
    expect(isPeopleSave('x')).toBe(false);
  });

  it('restore drops malformed entries silently and keeps the valid ones', () => {
    const { pop } = makeRig();
    const good = statement('C-1', 3);
    const save = {
      version: 1,
      identityVersion: 1,
      persons: [
        { id: -1, touched: 0, mood: 1 },
        { id: 100000, touched: 0, mood: 1 },
        { id: 1.5, mood: 1 },
        { id: 'a', mood: 1 },
        { id: 5, touched: 'late', mood: 'sad', custody: 'nowhere', injured: -3 },
        {
          id: 7,
          touched: 12,
          mood: 0.5,
          custody: 'jailed',
          custodySince: 9,
          injured: 0.2,
          intox: { bac: 'high', drug: 'none', level: 0, setAt: 0 },
          seized: ['p7:knife:0', 42, 'garbage'],
          added: [
            { instance: 'p7:knife:100', item: 'knife', owner: 'person', ownerId: 7, where: 'hand', visible: true },
            { instance: 'p7:bazooka:100', item: 'bazooka', owner: 'person', ownerId: 7, where: 'hand', visible: true },
            { instance: 'p8:knife:100', item: 'knife', owner: 'person', ownerId: 8, where: 'hand', visible: true },
            { instance: 'p7:knife:101', item: 'knife', owner: 'person', ownerId: 7, where: 'moon', visible: true },
            { instance: 'v3:knife:100', item: 'knife', owner: 'vehicle', ownerId: 3, where: 'cabin', visible: true },
          ],
          officer: { count: 2, lastGame: 4, lastOutcome: 'warning', rapport: 7 },
          statements: [good, { nope: true }, null],
          facts: [{ ...fact('C-1', 1), id: 4 }, { id: 'x' }],
          lies: [{ incident: 'C-1', fact: 'name', value: 'Bob' }, { incident: 1 }],
          flags: ['a', 3, 'a'],
        },
        'junk',
        null,
      ],
    } as unknown as PeopleSave;
    pop.restore(save);
    expect(pop.isTouched(5)).toBe(false);
    expect(pop.isTouched(-1)).toBe(false);
    expect(pop.isTouched(7)).toBe(true);
    const s = pop.state(7);
    expect(s).toMatchObject({ mood: 0.5, custody: 'jailed', injured: 0.2 });
    expect(pop.statements(7)).toEqual([good]);
    expect(pop.facts(7).map((f) => f.id)).toEqual([4]);
    expect(pop.addFact(7, fact('C-1')).id).toBe(5);
    expect(pop.lieFor(7, 'C-1', 'name')).toBe('Bob');
    expect(pop.officerHistory(7)).toEqual({ count: 2, lastGame: 4, lastOutcome: 'warning', rapport: 1 });
    expect(pop.hasFlag(7, 'a')).toBe(true);
    const d = pop.serialize().persons[0];
    expect(d?.seized).toEqual(['p7:knife:0']);
    expect(d?.added?.map((a) => a.instance)).toEqual(['p7:knife:100']);
    expect(d?.intox).toBeUndefined();
    expect(d?.flags).toEqual(['a']);
  });

  it('restore of garbage leaves an empty population', () => {
    const { pop } = makeRig();
    pop.setMood(1, 0.2);
    pop.restore(null as never);
    expect(pop.isTouched(1)).toBe(false);
    pop.setMood(1, 0.2);
    pop.restore({ version: 9 } as never);
    expect(pop.serialize().persons).toEqual([]);
  });

  it('serialize returns copies, not live state', () => {
    const { pop } = makeRig();
    pop.addStatement(1, statement('C-1'));
    const save = pop.serialize();
    save.persons[0]?.statements?.push(statement('C-1', 9));
    expect(pop.statements(1)).toHaveLength(1);
  });

  it('serialize -> restore round-trips all delta kinds', () => {
    const a = makeRig(SEED, 4000);
    a.pop.setMood(1, -0.3);
    a.pop.setCustody(1, 'hospital');
    a.pop.setInjured(1, 0.5);
    a.pop.setDeceased(2);
    a.pop.setMissing(3, true);
    a.pop.setIntoxication(4, 0.1, 'stimulant');
    a.pop.addItem({ kind: 'person', id: 5 }, 'handgun', 'waistband', false);
    a.pop.recordContact(6, 'warning', 0.2);
    a.pop.addStatement(7, statement('C-3', 1));
    a.pop.addFact(7, fact('C-3', 1));
    a.pop.rememberLie(7, 'C-3', 'name', 'Zed');
    a.pop.setFlag(8, 'f', true);
    const save = roundTrip(a.pop);
    const b = makeRig(SEED, 4000);
    b.pop.restore(save);
    expect(b.pop.serialize()).toEqual(save);
    for (let id = 1; id <= 8; id++) expect(b.pop.state(id)).toEqual(a.pop.state(id));
  });
});
