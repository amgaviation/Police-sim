import { describe, expect, it } from 'vitest';
import { PEOPLE_DATA } from '../../src/people/data';
import { describePerson } from '../../src/people/identity';
import { hasCarryNote, hasRegisteredHandgun } from '../../src/people/items';
import { CALENDAR, ageOn } from '../../src/records/calendar';
import { vehicleOfOwner } from '../../src/records/ids';
import { SEEDS } from '../records/helpers';
import { ids, makeRig } from './helpers';

const HAIR_HEX: Record<string, number | null> = { black: 0x1b1b1b, brown: 0x4b3621, blond: 0xc9a54e, red: 0x8d3b1f, gray: 0x9c9c9c, bald: null };

describe('identity never contradicts the Phase 2 CAD record', () => {
  for (const seed of SEEDS) {
    it(`2000 persons, seed ${seed}`, () => {
      const rig = makeRig(seed);
      const day = CALENDAR.startEpochDay;
      let handguns = 0;
      let licences = 0;
      let mentals = 0;
      let dementias = 0;
      let juveniles = 0;
      for (const id of ids(2000)) {
        const i = rig.pop.identity(id);
        const r = rig.records.person(id);
        expect(i.record).toEqual(r);
        expect(i.id).toBe(id);
        expect(i.age).toBe(ageOn(r.dob, day));
        expect(i.juvenile).toBe(i.age < 18);
        expect(i.elderly).toBe(i.age >= 70);
        expect(i.vehicleId).toBe(vehicleOfOwner(seed, id));
        expect(i.appearance.hair).toBe(HAIR_HEX[r.hair]);
        expect(Math.round(i.appearance.heightM * 100)).toBe(r.heightCm);
        if (r.mentalHealth !== null) {
          expect(i.mental).not.toBe('none');
          mentals++;
        }
        if (i.dementia) {
          expect(i.age).toBeGreaterThanOrEqual(70);
          dementias++;
        }
        expect(i.wanted).toBe(r.warrants.length > 0);
        const dl = i.baseItems.find((b) => b.item === 'driversLicense');
        if (dl) {
          expect(r.license.status).not.toBe('none');
          licences++;
        }
        if (i.baseItems.some((b) => b.item === 'handgun')) {
          expect(hasCarryNote(r) || hasRegisteredHandgun(r)).toBe(true);
          expect(r.officerSafety.length > 0 || r.firearms.length > 0).toBe(true);
          handguns++;
        }
        if (i.baseItems.some((b) => b.item === 'brassKnuckles')) expect(r.gang).not.toBeNull();
        if (i.juvenile) {
          juveniles++;
          if (i.guardianId >= 0) expect(i.family.find((f) => f.personId === i.guardianId)?.relation).toBe('parent');
        } else {
          expect(i.guardianId).toBe(-1);
        }
        expect(i.honesty).toBeGreaterThanOrEqual(0);
        expect(i.honesty).toBeLessThanOrEqual(1);
        expect(i.attitude).toBeGreaterThanOrEqual(-1);
        expect(i.attitude).toBeLessThanOrEqual(1);
        expect(i.appearance.build).toBeGreaterThanOrEqual(0.85);
        expect(i.appearance.build).toBeLessThanOrEqual(1.25);
        expect(i.baseItems.every((b) => b.instance.startsWith(`p${id}:${b.item}:`))).toBe(true);
        expect(new Set(i.baseItems.map((b) => b.instance)).size).toBe(i.baseItems.length);
      }
      // The checks above are not vacuous.
      expect(licences).toBeGreaterThan(1000);
      expect(mentals).toBeGreaterThan(5);
      expect(juveniles).toBeGreaterThan(10);
      expect(dementias + handguns).toBeGreaterThan(0);
    });
  }

  it('wanted turns false after serving every warrant', () => {
    const rig = makeRig();
    const wanted: number[] = [];
    for (let id = 0; id < 20000 && wanted.length < 12; id++) if (rig.records.peekPerson(id).warrants.length > 0) wanted.push(id);
    expect(wanted.length).toBe(12);
    for (const id of wanted) {
      expect(rig.pop.identity(id).wanted).toBe(true); // cached
      for (const w of rig.records.peekPerson(id).warrants) rig.records.serveWarrant(id, w.id);
      const after = rig.pop.identity(id);
      expect(after.wanted).toBe(false);
      expect(after.record.warrants).toHaveLength(0);
      expect(after.record).toEqual(rig.records.person(id));
    }
  });

  it('a juvenile has no dementia and a guardian only from the parent links', () => {
    const rig = makeRig();
    let withGuardian = 0;
    for (let id = 0; id < 30000; id++) {
      const i = rig.pop.identity(id);
      if (!i.juvenile) continue;
      expect(i.dementia).toBe(false);
      if (i.guardianId >= 0) withGuardian++;
    }
    expect(withGuardian).toBeGreaterThan(0);
  });

  it('employment follows age', () => {
    const rig = makeRig();
    for (const id of ids(1500)) {
      const i = rig.pop.identity(id);
      if (i.age >= PEOPLE_DATA.employment.retiredAge) expect(i.employer).toBe('Retired');
      else expect(i.employer).not.toBe('Retired');
      if (i.employer === 'Student') expect(i.age).toBeLessThanOrEqual(PEOPLE_DATA.employment.studentMaxAge);
    }
  });

  it('describes a person for radio traffic', () => {
    const rig = makeRig();
    const i = rig.pop.identity(1234);
    const d = describePerson(i);
    expect(d.sex).toBe(i.record.sex);
    expect(d.ageBand).toMatch(/^in their (teens|\d0s)$/);
    expect(d.top).toBe(`${i.appearance.topName} shirt`);
    expect(d.bottom).toBe(i.appearance.bottomName);
    expect(d.hair).toBe(i.record.hair === 'bald' ? 'bald' : `${i.record.hair} hair`);
    expect(d.heightText).toMatch(/^\d foot \d{1,2}$/);
    const inches = Math.round(i.record.heightCm / 2.54);
    expect(d.heightText).toBe(`${Math.floor(inches / 12)} foot ${inches % 12}`);
  });
});
