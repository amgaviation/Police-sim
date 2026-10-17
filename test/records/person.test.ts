import { describe, expect, it } from 'vitest';
import { CALENDAR, ageOn } from '../../src/records/calendar';
import { NAMES, PERSON_DATA } from '../../src/records/data';
import { PERSON_POPULATION, dlNumberOf } from '../../src/records/ids';
import {
  DETACHED_CONTEXT,
  NO_FIXED_ADDRESS,
  displayName,
  generatePerson,
  personIdentity,
  type PersonRecord,
} from '../../src/records/person';
import { SEEDS, fakeCtx } from './helpers';

describe.each(SEEDS)('person records (seed %i)', (seed) => {
  it('identity is pure hashing: names from the lists, ages in range, skewed to 20-60', () => {
    let core = 0;
    let female = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const id = (i * 7) % PERSON_POPULATION;
      const p = personIdentity(seed, id);
      expect(p).toEqual(personIdentity(seed, id));
      expect(p.id).toBe(id);
      expect((p.sex === 'M' ? NAMES.male : NAMES.female).includes(p.first)).toBe(true);
      expect(NAMES.last.includes(p.last)).toBe(true);
      expect(NAMES.middleInitials.includes(p.middle)).toBe(true);
      const age = ageOn(p.dob, CALENDAR.startEpochDay);
      expect(age).toBeGreaterThanOrEqual(PERSON_DATA.ageRange[0]);
      expect(age).toBeLessThanOrEqual(PERSON_DATA.ageRange[1]);
      if (age >= 20 && age <= 60) core++;
      if (p.sex === 'F') female++;
    }
    expect(core / n).toBeGreaterThan(0.75);
    expect(female / n).toBeGreaterThan(0.45);
    expect(female / n).toBeLessThan(0.55);
    expect(() => personIdentity(seed, PERSON_POPULATION)).toThrow(RangeError);
    expect(() => personIdentity(seed, -1)).toThrow(RangeError);
  });

  it('generatePerson is deterministic and seed dependent', () => {
    const ctx = fakeCtx();
    for (const id of [0, 1, 17, 4242, 99999]) {
      const a = generatePerson(seed, id, ctx);
      expect(generatePerson(seed, id, fakeCtx())).toEqual(a);
      expect({ ...a }).toMatchObject(personIdentity(seed, id));
      expect(JSON.parse(JSON.stringify(a))).toEqual(a);
    }
    let differs = 0;
    for (let id = 0; id < 50; id++) {
      if (JSON.stringify(generatePerson(seed, id, ctx)) !== JSON.stringify(generatePerson(seed + 7, id, ctx))) differs++;
    }
    expect(differs).toBe(50);
  });

  it('does not depend on today; the context only supplies address texts', () => {
    const a = generatePerson(seed, 321, fakeCtx(CALENDAR.startEpochDay));
    const b = generatePerson(seed, 321, fakeCtx(CALENDAR.startEpochDay + 400));
    expect(b).toEqual(a);
    const detached = generatePerson(seed, 321, DETACHED_CONTEXT);
    expect(detached.address).toBe(NO_FIXED_ADDRESS);
    expect(a.address).toMatch(/^10\d Test Street$/);
    // Same draws whatever the context: everything but texts from the city agrees.
    const strip = (p: PersonRecord): unknown => ({ ...p, address: '', priors: p.priors.map((c) => ({ ...c, location: '' })) });
    expect(strip(detached)).toEqual(strip(a));
  });

  it('fills every field consistently', () => {
    const ctx = fakeCtx();
    for (let id = 0; id < 3000; id++) {
      const p = generatePerson(seed, id, ctx);
      const [hLo, hHi] = PERSON_DATA.physical.heightCm[p.sex];
      expect(p.heightCm >= hLo && p.heightCm <= hHi).toBe(true);
      expect(p.phone).toMatch(/^555-\d{4}$/);
      if (p.license.status === 'none') {
        expect(p.license).toEqual({ number: '', cls: '', status: 'none', expires: 0 });
      } else {
        expect(p.license.number).toBe(dlNumberOf(seed, id));
        if (p.license.status === 'expired') expect(p.license.expires).toBeLessThan(CALENDAR.startEpochDay);
        else expect(p.license.expires).toBeGreaterThan(CALENDAR.startEpochDay);
      }
      p.warrants.forEach((w, i) => {
        expect(w.id).toBe(`W${id}-${i + 1}`);
        expect(w.bail % 50).toBe(0);
        expect(w.issued).toBeLessThan(CALENDAR.startEpochDay);
        expect(PERSON_DATA.warrants.courts.includes(w.court)).toBe(true);
      });
      expect(p.warrants.length).toBeLessThanOrEqual(PERSON_DATA.warrants.max);
      for (const f of p.firearms) expect(f.serial).toMatch(/^F[0-9A-HJ-NPR-Z]{7}$/);
      for (const o of p.protectiveOrders) {
        expect(o.protectedId).not.toBe(id);
        expect(o.protectedId >= 0 && o.protectedId < PERSON_POPULATION).toBe(true);
      }
      expect(p.priors.length).toBeLessThanOrEqual(PERSON_DATA.priors.max);
      for (let i = 1; i < p.priors.length; i++) expect(p.priors[i - 1]!.day).toBeGreaterThanOrEqual(p.priors[i]!.day);
      for (const c of p.priors) {
        expect(c.day).toBeLessThan(CALENDAR.startEpochDay);
        expect(c.location).toMatch(/Test Street$/);
      }
      if (p.supervision.kind === 'none') expect(p.supervision).toEqual({ kind: 'none', agent: '', until: 0, conditions: [] });
      else expect(p.supervision.conditions.length).toBeGreaterThan(0);
    }
  });

  it('produces loosely sane rates, and criminal flags cluster on the same people', () => {
    const ctx = fakeCtx();
    const n = 20000;
    const count = { warrant: 0, none: 0, suspended: 0, revoked: 0, expired: 0, probation: 0, parole: 0, gang: 0, mh: 0, os: 0, firearms: 0, po: 0 };
    let priors = 0;
    let priorsOfWanted = 0;
    let osOfWanted = 0;
    for (let id = 0; id < n; id++) {
      const p = generatePerson(seed, id * 5, ctx);
      const wanted = p.warrants.length > 0;
      if (wanted) count.warrant++;
      if (p.license.status !== 'valid') count[p.license.status]++;
      if (p.supervision.kind !== 'none') count[p.supervision.kind]++;
      if (p.gang) count.gang++;
      if (p.mentalHealth !== null) count.mh++;
      if (p.officerSafety.length > 0) count.os++;
      if (p.firearms.length > 0) count.firearms++;
      if (p.protectiveOrders.length > 0) count.po++;
      priors += p.priors.length;
      if (wanted) {
        priorsOfWanted += p.priors.length;
        if (p.officerSafety.length > 0) osOfWanted++;
      }
    }
    const d = PERSON_DATA;
    const near = (k: number, rate: number): void => {
      expect(k / n).toBeGreaterThan(rate * 0.6);
      expect(k / n).toBeLessThan(rate * 1.4);
    };
    near(count.warrant, d.warrants.rate);
    near(count.none, d.license.none);
    near(count.suspended, d.license.suspended);
    near(count.expired, d.license.expired);
    near(count.probation, d.supervision.probation);
    near(count.gang, d.gang.rate);
    near(count.mh, d.mentalHealth.rate);
    near(count.firearms, d.firearms.rate);
    expect(count.revoked).toBeGreaterThan(0);
    expect(count.parole).toBeGreaterThan(0);
    expect(count.os).toBeGreaterThan(0);
    expect(count.po).toBeGreaterThan(0);
    near(priors, d.priors.mean);
    // Latent risk: wanted people have more priors and more officer-safety notes than average.
    expect(priorsOfWanted / count.warrant).toBeGreaterThan(1.5 * (priors / n));
    // E[rf^2] / E[rf] = 1.72 for rf = 0.25 + 3u^3.
    expect(osOfWanted / count.warrant).toBeGreaterThan(1.3 * (count.os / n));
  });

  it('keeps warrants, supervision, priors, firearms and licence consistent with each other and with age', () => {
    const ctx = fakeCtx();
    const start = CALENDAR.startEpochDay;
    let supervised = 0, probationViolations = 0, young = 0, prohibited = 0, benchWanted = 0, safety = 0;
    for (let id = 0; id < 30000; id++) {
      const p = generatePerson(seed, id, ctx);
      const age = Math.floor((start - p.dob) / 365.25);
      if (p.warrants.some((w) => w.offense === 'Probation violation')) {
        probationViolations++;
        expect(p.supervision.kind, `person ${id}`).toBe('probation');
      }
      if (p.supervision.kind !== 'none') {
        supervised++;
        expect(p.priors.some((x) => x.kind === PERSON_DATA.supervision.priorKind), `person ${id}`).toBe(true);
      }
      // Officer-safety notes (e.g. 'Prior assault on officer') come with an arrest on record.
      if (p.officerSafety.length > 0) {
        safety++;
        expect(p.priors.some((x) => x.kind === PERSON_DATA.officerSafety.priorKind), `person ${id} officer safety`).toBe(true);
      }
      if (age < 21) young++;
      if (age < PERSON_DATA.firearms.minAge) expect(p.firearms, `person ${id}`).toEqual([]);
      // No firearm registered before the holder's minAge birthday, none for a prohibited possessor.
      for (const f of p.firearms) {
        expect(ageOn(p.dob, f.registered), `person ${id} firearm ${f.serial}`).toBeGreaterThanOrEqual(PERSON_DATA.firearms.minAge);
        expect(f.registered).toBeLessThan(start);
      }
      const surrender = p.protectiveOrders.some((o) => o.conditions.includes('Surrender firearms'));
      if (p.supervision.kind === 'parole' || surrender) {
        prohibited++;
        expect(p.firearms, `person ${id} prohibited`).toEqual([]);
      }
      // A bench warrant follows an earlier citation or arrest.
      const bench = p.warrants.filter((x) => x.kind === 'bench');
      if (bench.length > 0) {
        benchWanted++;
        const benchDay = Math.min(...bench.map((x) => x.issued));
        const court = p.priors.filter((x) => x.kind === 'citation' || x.kind === 'arrest');
        expect(court.length, `person ${id} bench warrant priors`).toBeGreaterThan(0);
        expect(Math.min(...court.map((x) => x.day)), `person ${id} bench prior day`).toBeLessThanOrEqual(benchDay);
        if (benchDay > p.dob + 5845) expect(Math.min(...court.map((x) => x.day))).toBeLessThan(benchDay);
      }
      const minAge = PERSON_DATA.license.classMinAge[p.license.cls] ?? 0;
      expect(age, `person ${id} class ${p.license.cls}`).toBeGreaterThanOrEqual(minAge);
      if (p.license.status === 'expired') {
        expect(p.license.expires).toBeGreaterThan(p.dob + 5844);
        expect(p.license.expires).toBeLessThan(start);
      }
    }
    expect(supervised).toBeGreaterThan(500);
    expect(safety).toBeGreaterThan(100);
    expect(PERSON_DATA.officerSafety.priorKind).toBe('arrest');
    expect(probationViolations).toBeGreaterThan(0);
    expect(young).toBeGreaterThan(100);
    expect(prohibited).toBeGreaterThan(100);
    expect(benchWanted).toBeGreaterThan(100);
  });

  it('regression: firearms respect the minAge birthday, prohibited possessors hold none, bench warrants have a prior', () => {
    if (seed !== 42) return;
    const p110 = generatePerson(seed, 110, DETACHED_CONTEXT);
    for (const f of p110.firearms) expect(ageOn(p110.dob, f.registered)).toBeGreaterThanOrEqual(PERSON_DATA.firearms.minAge);
    const p587 = generatePerson(seed, 587, DETACHED_CONTEXT);
    expect(p587.supervision.kind).toBe('parole');
    expect(p587.firearms).toEqual([]);
    const p221 = generatePerson(seed, 221, DETACHED_CONTEXT);
    expect(p221.protectiveOrders.some((o) => o.conditions.includes('Surrender firearms'))).toBe(true);
    expect(p221.firearms).toEqual([]);
    const p163 = generatePerson(seed, 163, DETACHED_CONTEXT);
    expect(p163.warrants.some((x) => x.kind === 'bench')).toBe(true);
    expect(p163.priors.some((x) => x.kind === 'citation' || x.kind === 'arrest')).toBe(true);
  });

  it('formats display names', () => {
    expect(displayName({ first: 'John', middle: 'A', last: 'Smith' })).toBe('SMITH, JOHN A');
    expect(displayName({ first: 'Ann', middle: '', last: 'Lee' })).toBe('LEE, ANN');
  });
});
