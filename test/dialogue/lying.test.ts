import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { dlNumberOf, personIdFromDl } from '../../src/records/ids';
import { NAMES } from '../../src/records/data';
import { lieChance, respond, truthFor, utterance, type DialogueResult, type SubjectMemory, type SubjectProfile } from '../../src/dialogue';
import { ctxOf, directory, idsWithRelatives, item, memoryOf, rig, SEED, subjectOf } from './helpers';

function ask(uid: string, subject: SubjectProfile, memory: SubjectMemory, seed: number, ctx = ctxOf()): DialogueResult {
  return respond(utterance(uid), subject, ctx, memory, createRng(seed));
}

const ID = 11;
const sd = (p: number, n: number): number => Math.sqrt((p * (1 - p)) / n);

/** A subject whose true answers are all incriminating. */
function offender(over: Partial<SubjectProfile> = {}, honesty = 0.2): SubjectProfile {
  return subjectOf(
    ID,
    {
      guilty: true,
      intoxication: { bac: 0.12, drug: 'cannabis', level: 0.4 },
      items: [item('handgun', 'waistband'), item('narcotics')],
      vehicleItems: [item('openContainer', 'cabin', true)],
      vehicleOwnerId: 5,
      inVehicle: false,
      ...over,
    },
    { honesty, wanted: false },
  );
}

describe('truth values', () => {
  it('derives each answer from the subject state', () => {
    const ctx = ctxOf();
    const s = offender();
    const m = memoryOf(s, ctx);
    expect(truthFor('destination', s, ctx, m)).toBe('home');
    expect(truthFor('account', s, ctx, m)).toBe('It got loud.');
    expect(truthFor('suspectWhereabouts', s, ctx, m)).toBe('They ran that way.');
    expect(truthFor('drinking', s, ctx, m)).toBe('yes');
    expect(truthFor('drinking', subjectOf(ID, { intoxication: { bac: 0.03, drug: 'none', level: 0.1 } }), ctx, m)).toBe('some');
    expect(truthFor('drinking', subjectOf(ID, { intoxication: { bac: 0.01, drug: 'none', level: 0 } }), ctx, m)).toBe('no');
    expect(truthFor('drugs', s, ctx, m)).toBe('yes');
    expect(truthFor('drugs', subjectOf(ID, { items: [item('pills')] }), ctx, m)).toBe('yes');
    expect(truthFor('drugs', subjectOf(ID), ctx, m)).toBe('no');
    expect(truthFor('weapons', s, ctx, m)).toBe('yes');
    expect(truthFor('weapons', subjectOf(ID, { items: [item('phone')] }), ctx, m)).toBe('no');
    expect(truthFor('vehicleContents', s, ctx, m)).toBe('item:openContainer');
    expect(truthFor('vehicleContents', subjectOf(ID, { vehicleItems: [item('keys', 'cabin')] }), ctx, m)).toBe('nothing');
    expect(truthFor('vehicleOwner', s, ctx, m)).toBe('friend');
    expect(truthFor('vehicleOwner', subjectOf(ID, { vehicleOwnerId: ID }), ctx, m)).toBe('self');
    const kin = idsWithRelatives(1)[0] as number;
    const relOf = subjectOf(kin, {}, {}).identity.family[0]?.personId ?? -1;
    expect(truthFor('vehicleOwner', subjectOf(kin, { vehicleOwnerId: relOf }), ctx, m)).toBe('relative');
    expect(truthFor('injured', subjectOf(ID, { injured: true }), ctx, m)).toBe('yes');
    expect(truthFor('address', s, ctx, m)).toBe(s.identity.record.address);
  });

  it('computes the lie chance from the spec formula', () => {
    const ctx = ctxOf();
    const mem = (r: number) => memoryOf(offender(), ctx, r);
    expect(lieChance(offender({}, 0.2), mem(0))).toBeCloseTo(0.64, 10);
    expect(lieChance(offender({}, 0.2), mem(0.5))).toBeCloseTo(0.54, 10);
    expect(lieChance(offender({}, 0.2), mem(-1))).toBeCloseTo(0.84, 10);
    expect(lieChance(offender({}, 0), mem(-1))).toBe(0.95);
    expect(lieChance(offender({ guilty: false }, 0.2), mem(0))).toBeCloseTo(0.64 * 0.2, 10);
    const wanted = subjectOf(ID, { guilty: true }, { honesty: 0.5, wanted: true });
    expect(lieChance(wanted, mem(0))).toBeCloseTo(0.4 + 0.4, 10);
    const suspendedDriver = subjectOf(
      ID,
      { guilty: true, inVehicle: true },
      { honesty: 0.5, wanted: false, record: { ...subjectOf(ID).identity.record, license: { number: '', cls: '', status: 'suspended', expires: 0 } } },
    );
    expect(lieChance(suspendedDriver, mem(0))).toBeCloseTo(0.4 + 0.2, 10);
    expect(lieChance(subjectOf(ID, {}, { honesty: 1 }), mem(-1))).toBe(0);
  });
});

describe('lying', () => {
  const facts: [string, string][] = [
    ['askDrinking', 'drinking'],
    ['askDrugs', 'drugs'],
    ['askWeapons', 'weapons'],
    ['askVehicleContents', 'vehicleContents'],
    ['askVehicleOwner', 'vehicleOwner'],
    ['askDestination', 'destination'],
    ['askOrigin', 'origin'],
    ['askAccount', 'account'],
  ];

  it('never lets an honest subject lie over 500 seeded asks', () => {
    const s = offender({ guilty: false }, 1);
    const ctx = ctxOf();
    let answered = 0;
    for (let i = 0; i < 500; i++) {
      const [uid] = facts[i % facts.length] as [string, string];
      const r = ask(uid, s, memoryOf(s, ctx, i % 3 === 0 ? -0.9 : 0.2), i);
      if (r.statement) {
        answered++;
        expect(r.statement.truthful, `${uid} #${i}`).toBe(true);
        expect(r.statement.confused).toBe(false);
        expect(Object.keys(r.memory.lies)).toEqual([]);
      }
    }
    expect(answered).toBeGreaterThan(350);
  });

  it('lies at about L for a guilty low-honesty subject (4 sigma)', () => {
    const s = offender({}, 0.2);
    const ctx = ctxOf();
    const n = 3000;
    let answered = 0;
    let lies = 0;
    for (let i = 0; i < n; i++) {
      const r = ask('askDestination', s, memoryOf(s, ctx, 0, 0.2), 1000 + i);
      if (r.statement) {
        answered++;
        if (!r.statement.truthful) {
          lies++;
          expect(r.memory.lies.destination).toBe(r.statement.value);
          expect(r.statement.value).not.toBe('home');
        }
      }
    }
    const L = lieChance(s, memoryOf(s, ctx, 0, 0.2));
    expect(answered).toBeGreaterThan(2400);
    expect(Math.abs(lies / answered - L)).toBeLessThan(4 * sd(L, answered));
  });

  it('lies with the documented values per fact', () => {
    const s = offender({}, 0);
    const ctx = ctxOf();
    const seen = new Map<string, Set<string>>();
    for (let i = 0; i < 800; i++) {
      const [uid, fact] = facts[i % facts.length] as [string, string];
      const r = ask(uid, s, memoryOf(s, ctx, -0.5, 0.2), 5000 + i);
      if (r.statement && !r.statement.truthful) {
        const set = seen.get(fact) ?? new Set<string>();
        set.add(r.statement.value);
        seen.set(fact, set);
      }
    }
    expect([...(seen.get('drinking') ?? [])].sort()).toEqual(['no', 'some']);
    expect([...(seen.get('drugs') ?? [])]).toEqual(['no']);
    expect([...(seen.get('weapons') ?? [])]).toEqual(['no']);
    expect([...(seen.get('vehicleContents') ?? [])]).toEqual(['nothing']);
    expect([...(seen.get('vehicleOwner') ?? [])]).toEqual(['self']);
    expect((seen.get('destination')?.size ?? 0)).toBeGreaterThan(3);
  });

  it('changes the story with probability 0.3 + 0.3 stress, else repeats the stored lie', () => {
    const s = offender({}, 0.2);
    const ctx = ctxOf();
    for (const stress of [0, 0.5, 1]) {
      const n = 2000;
      let answered = 0;
      let changed = 0;
      for (let i = 0; i < n; i++) {
        const m = memoryOf(s, ctx, 0, stress);
        m.lies.destination = 'the store';
        m.asked.destination = 1;
        const r = ask('askDestination', s, m, 9000 + i);
        if (!r.statement) continue;
        answered++;
        if (r.statement.value !== 'the store') {
          changed++;
          expect(r.statement.value).not.toBe('home');
          expect(r.memory.lies.destination).toBe(r.statement.value);
        } else expect(r.memory.lies.destination).toBe('the store');
      }
      const p = 0.3 + 0.3 * stress;
      expect(Math.abs(changed / answered - p), `stress ${stress}`).toBeLessThan(4 * sd(p, answered));
    }
  });

  it('keeps a first truthful answer and an unchanged lie consistent over repeated asks', () => {
    const s = offender({}, 0.2);
    const ctx = ctxOf();
    // A subject who told the truth first never lies later.
    let m: SubjectMemory | null = null;
    for (let seed = 0; seed < 100 && m === null; seed++) {
      const r = ask('askWeapons', s, memoryOf(s, ctx, 0.3, 0.2), seed);
      if (r.statement?.truthful === true) m = r.memory;
    }
    expect(m).not.toBeNull();
    let cur = m as SubjectMemory;
    for (let i = 0; i < 60; i++) {
      const r = ask('askWeapons', s, cur, 200 + i);
      if (r.statement) expect(r.statement.truthful).toBe(true);
      cur = { ...r.memory, stress: 0.2 };
    }
    // A liar's story only ever moves to a new stored lie.
    let liar: SubjectMemory | null = null;
    for (let seed = 0; seed < 200 && liar === null; seed++) {
      const r = ask('askDestination', offender({}, 0), memoryOf(s, ctx, -0.5, 0.2), seed);
      if (r.statement && !r.statement.truthful) liar = r.memory;
    }
    expect(liar).not.toBeNull();
    let state = liar as SubjectMemory;
    let repeats = 0;
    for (let i = 0; i < 80; i++) {
      const prior = state.lies.destination;
      const r = ask('askDestination', offender({}, 0), { ...state, stress: 0.2 }, 400 + i);
      if (!r.statement) continue;
      expect(r.statement.truthful).toBe(false);
      expect(r.memory.lies.destination).toBe(r.statement.value);
      if (r.statement.value === prior) repeats++;
      state = r.memory;
    }
    expect(repeats).toBeGreaterThan(30);
  });

  it('confuses a person with dementia about half the time and refuses at the documented rate', () => {
    const s = subjectOf(ID, {}, { dementia: true, honesty: 1 });
    const ctx = ctxOf({ commMode: 'interpreter' });
    // Interpreter makes the gate 1 for hearing/language but dementia still halves it: count only understood asks.
    let answered = 0;
    let confused = 0;
    for (let i = 0; i < 3000; i++) {
      const r = ask('askDestination', s, memoryOf(s, ctx, 0, 0.2), i, ctx);
      if (r.statement) {
        answered++;
        if (r.statement.confused) {
          confused++;
          expect(r.lineKey).toBe('ask.confused');
        }
      }
    }
    expect(Math.abs(confused / answered - 0.5)).toBeLessThan(4 * sd(0.5, answered));
    const calm = subjectOf(ID, { demeanor: 'cooperative' }, { honesty: 1 });
    let refused = 0;
    const n = 3000;
    for (let i = 0; i < n; i++) if (ask('askOrigin', calm, memoryOf(calm, ctxOf(), 0, 0.1), i).lineKey === 'ask.refuse') refused++;
    expect(Math.abs(refused / n - 0.15)).toBeLessThan(4 * sd(0.15, n));
    const hostile = subjectOf(ID, { demeanor: 'hostile' }, { honesty: 1 });
    refused = 0;
    for (let i = 0; i < n; i++) if (ask('askOrigin', hostile, memoryOf(hostile, ctxOf(), 0, 0.1), i).lineKey === 'ask.refuse') refused++;
    expect(Math.abs(refused / n - 0.45)).toBeLessThan(4 * sd(0.45, n));
  });

  it('uses drinking line keys and phrases for statements', () => {
    const s = offender({}, 1);
    const r = ask('askDrinking', { ...s, guilty: false }, memoryOf(s, ctxOf(), 0.9), 3);
    if (r.statement) {
      expect(r.lineKey).toBe('drinking.yes');
      expect(r.statement.display).toBe('Yes, I had a few drinks');
    }
    const c = ask('askVehicleContents', { ...s, guilty: false }, memoryOf(s, ctxOf(), 0.9), 3);
    if (c.statement) expect(c.statement.display).toBe('A open container of alcohol in the vehicle');
  });
});

describe('identity claims', () => {
  const liar = (id: number, over: Partial<SubjectProfile> = {}): SubjectProfile => subjectOf(id, { guilty: true, ...over }, { honesty: 0, wanted: false });

  it('makes relative, invented and altered-DOB claims at about 50/30/20 with consistent fields', () => {
    const ids = idsWithRelatives(20);
    const ctx = ctxOf({ directory: directory() });
    const counts = { relative: 0, invented: 0, alteredDob: 0, true: 0 };
    let made = 0;
    const r = rig();
    for (let i = 0; i < 1500; i++) {
      const id = ids[i % ids.length] as number;
      const s = liar(id);
      const res = ask('requestId', s, memoryOf(s, ctx, 0, 0.2), 20000 + i, ctx);
      const claim = res.identity;
      if (!claim) continue;
      counts[claim.kind]++;
      if (claim.kind === 'true') continue;
      made++;
      const truth = r.records.person(id);
      expect(claim.document).toBe('none');
      expect(claim.dlNumber).toBe('');
      expect(res.lineKey).toBe('requestId.lieVerbal');
      expect(res.statement).toMatchObject({ fact: 'identity', value: String(claim.personId), truthful: false });
      expect(res.text).toContain(claim.first);
      if (claim.kind === 'relative') {
        const link = s.identity.family.find((l) => l.personId === claim.personId);
        expect(link && (link.relation === 'sibling' || link.relation === 'relative')).toBe(true);
        const rec = r.records.person(claim.personId);
        expect([claim.first, claim.middle, claim.last, claim.dob, claim.address]).toEqual([rec.first, rec.middle, rec.last, rec.dob, rec.address]);
        expect(claim.personId).not.toBe(id);
      } else if (claim.kind === 'invented') {
        expect(claim.personId).toBe(-1);
        const gap = Math.abs(claim.dob - truth.dob);
        expect(gap).toBeGreaterThanOrEqual(365 - 30);
        expect(gap).toBeLessThanOrEqual(4 * 365 + 30);
        expect(NAMES.last).toContain(claim.last);
        expect(claim.address).toMatch(/^\d+ \S/);
      } else {
        expect(claim.personId).toBe(id);
        expect([claim.first, claim.last, claim.address]).toEqual([truth.first, truth.last, truth.address]);
        const gap = Math.abs(claim.dob - truth.dob);
        expect(gap).toBeGreaterThanOrEqual(365 - 30);
        expect(gap).toBeLessThanOrEqual(5 * 365 + 30);
      }
    }
    expect(counts.true).toBeGreaterThan(100);
    expect(counts.true).toBeLessThan(500);
    expect(made).toBeGreaterThan(1000);
    const share = (k: 'relative' | 'invented' | 'alteredDob', p: number): void => {
      expect(Math.abs(counts[k] / made - p), k).toBeLessThan(4 * sd(p, made));
    };
    share('relative', 0.5);
    share('invented', 0.3);
    share('alteredDob', 0.2);
  });

  it('falls back to invented claims when no relative record is available', () => {
    const ctx = ctxOf();
    const kinds = new Set<string>();
    const s = liar(idsWithRelatives(1)[0] as number);
    for (let i = 0; i < 300; i++) {
      const c = ask('requestId', s, memoryOf(s, ctx, 0, 0.2), 700 + i, ctx).identity;
      if (c && c.kind !== 'true') kinds.add(c.kind);
    }
    expect([...kinds].sort()).toEqual(['alteredDob', 'invented']);
  });

  it('hands a fake ID only when one is carried (relative or invented, with a licence number)', () => {
    const ids = idsWithRelatives(20);
    const ctx = ctxOf({ directory: directory() });
    const r = rig();
    const docs = new Set<string>();
    let relatives = 0;
    let invented = 0;
    for (let i = 0; i < 600; i++) {
      const id = ids[i % ids.length] as number;
      const withFake = liar(id, { items: [item('fakeId')] });
      const res = ask('requestId', withFake, memoryOf(withFake, ctx, 0, 0.2), 30000 + i, ctx);
      const claim = res.identity;
      if (!claim || claim.kind === 'true') continue;
      docs.add(claim.document);
      expect(res.lineKey).toBe('requestId.handFake');
      expect(['relative', 'invented']).toContain(claim.kind);
      if (claim.kind === 'relative') {
        relatives++;
        expect(claim.dlNumber).toBe(r.records.person(claim.personId).license.number || claim.dlNumber);
        if (r.records.person(claim.personId).license.number !== '') expect(claim.dlNumber).toBe(dlNumberOf(SEED, claim.personId));
      } else {
        invented++;
      }
      const without = liar(id);
      const plain = ask('requestId', without, memoryOf(without, ctx, 0, 0.2), 30000 + i, ctx).identity;
      if (plain && plain.kind !== 'true') expect(plain.document).toBe('none');
    }
    expect([...docs]).toEqual(['fakeId']);
    expect(relatives).toBeGreaterThan(50);
    // Nobody to borrow a card from: an invented identity with a number that is not on file.
    for (let i = 0; i < 100; i++) {
      const alone = subjectOf(ids[0] as number, { guilty: true, items: [item('fakeId')] }, { honesty: 0, wanted: false, family: [] });
      const claim = ask('requestId', alone, memoryOf(alone, ctx, 0, 0.2), 40000 + i, ctx).identity;
      if (!claim || claim.kind === 'true') continue;
      invented++;
      expect(claim.kind).toBe('invented');
      expect(claim.document).toBe('fakeId');
      expect(claim.dlNumber).toMatch(/^D\d{7}$/);
      expect(personIdFromDl(SEED, claim.dlNumber)).toBeNull();
    }
    expect(invented).toBeGreaterThan(50);
    // A liar who named themselves first hands the fake card matching that name when pressed.
    const s = liar(ids[0] as number, { items: [item('fakeId')] });
    const named = ask('askName', s, memoryOf(s, ctx, 0, 0.2), 1, ctx);
    if (named.memory.identity && named.memory.identity.kind !== 'true') {
      const pressed = ask('requestId', s, named.memory, 2, ctx);
      expect(pressed.lineKey).toBe('requestId.handFake');
      expect(pressed.identity?.document).toBe('fakeId');
      expect(pressed.identity?.first).toBe(named.memory.identity.first);
      expect(pressed.identity?.dob).toBe(named.memory.identity.dob);
      expect(pressed.identity?.dlNumber).toMatch(/^D\d{7}$/);
    }
  });

  it('gives a true claim that matches the CAD record and licence', () => {
    const r = rig();
    const ctx = ctxOf({ directory: directory() });
    let checked = 0;
    for (let id = 0; id < 400 && checked < 25; id++) {
      const rec = r.records.person(id);
      if (rec.license.number === '') continue;
      const s = subjectOf(id, { items: [{ instance: `p${id}:driversLicense:0`, item: 'driversLicense', where: 'pocket', visible: false }] }, { honesty: 1 });
      let claim = null as DialogueResult['identity'];
      for (let seed = 0; seed < 30 && claim === null; seed++) claim = ask('requestId', s, memoryOf(s, ctx, 0.8, 0.1), seed, ctx).identity;
      expect(claim).not.toBeNull();
      expect(claim).toMatchObject({ kind: 'true', personId: id, first: rec.first, middle: rec.middle, last: rec.last, dob: rec.dob, address: rec.address, document: 'dl' });
      expect(claim?.dlNumber).toBe(dlNumberOf(SEED, id));
      expect(personIdFromDl(SEED, claim?.dlNumber ?? '')).toBe(id);
      checked++;
    }
    expect(checked).toBe(25);
  });

  it('answers address questions with the claimed identity address', () => {
    const ctx = ctxOf({ directory: directory() });
    const s = liar(idsWithRelatives(1)[0] as number);
    for (let seed = 0; seed < 100; seed++) {
      const named = ask('requestId', s, memoryOf(s, ctx, 0, 0.2), seed, ctx);
      const claim = named.memory.identity;
      if (!claim) continue;
      const addr = ask('askAddress', s, named.memory, seed, ctx);
      if (addr.statement) {
        expect(addr.statement.value).toBe(claim.address);
        return;
      }
    }
    throw new Error('no address answer');
  });
});
