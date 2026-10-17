import { describe, expect, it } from 'vitest';
import { findStatute } from '../../src/cad/data';
import { RecordsDb } from '../../src/records/db';
import { hasGeneratedWarrant } from '../../src/records/person';
import { generateRegistration, mountedPlate, observedVehicle, PLATE_FLAG } from '../../src/records/vehicle';
import {
  canCompleteBooking,
  citationDraftFromStop,
  docRows,
  docSections,
  personSections,
  stopSections,
  suggestedCharges,
  vehicleSections,
  type MdtSection,
} from '../../src/ui/mdt';
import { fakeCtx } from '../records/helpers';
import { at, fixture, SEED, startStop } from './helpers';

const db = (): RecordsDb => new RecordsDb(SEED, fakeCtx());

function section(sections: readonly MdtSection[], id: string): MdtSection {
  const s = sections.find((x) => x.id === id);
  if (!s) throw new Error(`no section ${id}`);
  return s;
}

function findId(limit: number, ok: (id: number) => boolean): number {
  for (let id = 0; id < limit; id++) if (ok(id)) return id;
  throw new Error('no matching id');
}

describe('personSections', () => {
  it('lists warrants and hits with their severities', () => {
    const records = db();
    const id = findId(100000, (i) => hasGeneratedWarrant(SEED, i));
    const person = records.person(id);
    expect(person.warrants.length).toBeGreaterThan(0);
    const sections = personSections(person, records.personHits(id), records.today());
    expect(sections.map((s) => s.id)).toEqual([
      'identity', 'hits', 'license', 'warrants', 'supervision', 'gang', 'mentalHealth', 'officerSafety', 'firearms', 'protectiveOrders', 'priors',
    ]);
    const warrants = section(sections, 'warrants').lines;
    expect(warrants).toHaveLength(person.warrants.length);
    for (const [i, w] of person.warrants.entries()) {
      expect(warrants[i]).toMatchObject({ label: w.id, severity: 'alert' });
      expect(warrants[i]?.text).toContain(w.offense);
      expect(warrants[i]?.text).toContain(`$${w.bail}`);
    }
    const hits = section(sections, 'hits').lines;
    expect(hits.some((l) => l.severity === 'alert' && l.text.startsWith('WARRANT:'))).toBe(true);
    const identity = section(sections, 'identity').lines;
    expect(identity[0]).toMatchObject({ label: 'Name', personId: id });
    expect(identity.find((l) => l.label === 'DOB')?.text).toMatch(/^\d\d\/\d\d\/\d{4} \(age \d+\)$/);
  });

  it('flags officer safety, supervision and licence problems; a clean record says so', () => {
    const records = db();
    const flagged = findId(100000, (i) => {
      const p = records.person(i);
      return p.officerSafety.length > 0 && p.supervision.kind !== 'none' && p.license.status !== 'valid' && p.license.status !== 'none';
    });
    const s = personSections(records.person(flagged), records.personHits(flagged), records.today());
    expect(section(s, 'officerSafety').lines.every((l) => l.severity === 'alert')).toBe(true);
    expect(section(s, 'supervision').lines[0]?.severity).toBe('caution');
    expect(section(s, 'license').lines.find((l) => l.label === 'Status')?.severity).toBe('caution');

    const clean = findId(100000, (i) => records.personHits(i).length === 0);
    const c = personSections(records.person(clean), [], records.today());
    expect(section(c, 'hits').lines).toEqual([{ label: '', text: 'NO WANTS, WARRANTS OR FLAGS', severity: 'none' }]);
    expect(section(c, 'warrants').lines[0]?.text).toBe('NONE');
  });
});

describe('vehicleSections', () => {
  it('shows registration, owner, hits and the description mismatch with the observed car', () => {
    const records = db();
    const a = 1234;
    const regA = generateRegistration(SEED, a);
    const other = findId(60000, (i) => observedVehicle(SEED, i).modelId !== regA.modelId);
    const result = records.runPlate(regA.plate, observedVehicle(SEED, other), at(0).game);
    expect(result.flags & PLATE_FLAG.mismatched).toBeTruthy();
    const s = vehicleSections(result);
    expect(s.map((x) => x.id)).toEqual(['query', 'registration', 'owner', 'observed', 'hits']);
    expect(section(s, 'registration').lines.find((l) => l.label === 'VIN')?.text).toBe(regA.vin);
    expect(section(s, 'owner').lines[0]).toMatchObject({ label: 'Name', personId: regA.ownerId });
    expect(section(s, 'observed').lines[0]?.severity).toBe('alert');
    const hits = section(s, 'hits').lines;
    expect(hits.some((l) => l.severity === 'alert' && l.text.startsWith('DESCRIPTION MISMATCH'))).toBe(true);
    expect(section(s, 'query').lines[1]?.severity).toBe('alert');
  });

  it('shows stolen and expired hits; unknown plates and VINs show no record', () => {
    const records = db();
    const stolen = findId(60000, (i) => generateRegistration(SEED, i).stolen);
    const reg = generateRegistration(SEED, stolen);
    const s = vehicleSections(records.runPlate(reg.plate));
    expect(section(s, 'hits').lines.some((l) => l.text === 'STOLEN VEHICLE' && l.severity === 'alert')).toBe(true);
    expect(section(s, 'registration').lines.find((l) => l.label === 'Status')).toMatchObject({ text: 'STOLEN', severity: 'alert' });

    const expired = findId(60000, (i) => generateRegistration(SEED, i).expired);
    const e = vehicleSections(records.runPlate(generateRegistration(SEED, expired).plate));
    expect(section(e, 'hits').lines.some((l) => l.text.startsWith('REGISTRATION EXPIRED') && l.severity === 'caution')).toBe(true);

    const vin = vehicleSections(records.runVin(reg.vin));
    expect(section(vin, 'query').lines[0]).toMatchObject({ label: 'VIN', text: reg.vin });
    expect(section(vin, 'owner').lines[0]).toMatchObject({ personId: reg.ownerId });

    const none = vehicleSections(records.runPlate('ZZZ'));
    expect(none).toHaveLength(1);
    expect(none[0]?.lines[1]).toMatchObject({ text: 'NO RECORD' });
  });
});

describe('citationDraftFromStop', () => {
  it('maps observed violations to statutes with fines, recorded speed and total', () => {
    const f = fixture();
    const v = findId(60000, (i) => {
      const reg = generateRegistration(SEED, mountedPlate(SEED, i).plateVehicleId);
      return mountedPlate(SEED, i).anomaly === 'none' && !reg.expired && reg.insured && !reg.stolen && !reg.plateReportedStolen && !reg.cloneAlert;
    });
    const stop = startStop(f, v, { driverId: 321 });
    const draft = citationDraftFromStop(f.cad.trafficStop ?? stop, f.records, { redLight: 2, speeding: 1, rollingStop: 0, unknownThing: 1 }, { speedMph: 52.4, limitMph: 35 }, '400 S Elm Street');
    expect(draft.violations.map((x) => x.statuteId)).toEqual(['TR-301', 'TR-302']);
    expect(draft.violations[0]).toEqual({ statuteId: 'TR-301', fine: findStatute('TR-301')?.fine, detail: '52 mph in a 35 mph zone' });
    expect(draft.violations[1]?.detail).toBe('Observed 2 times');
    expect(draft.totalFine).toBe(150 + 238);
    expect(draft).toMatchObject({
      personId: 321, idUnverified: false, vehicleId: v, plate: stop.plate, location: '400 S Elm Street',
      recordedSpeedMph: 52, limitMph: 35, callId: stop.callId, notes: '',
    });
  });

  it('prefills the registered owner as ID unverified when the driver was not identified', () => {
    const f = fixture();
    const v = findId(60000, (i) => mountedPlate(SEED, i).anomaly === 'cloned');
    const stop = startStop(f, v);
    const draft = citationDraftFromStop(stop, f.records, {}, null, 'here');
    const plateOwner = generateRegistration(SEED, mountedPlate(SEED, v).plateVehicleId).ownerId;
    expect(draft).toMatchObject({ personId: plateOwner, idUnverified: true, recordedSpeedMph: null, limitMph: null });
    expect(draft.notes).toContain('ID unverified');
    expect(draft.violations).toEqual([]);
  });

  it('maps plate issues of the last run (expired, uninsured; clones only after a VIN check)', () => {
    const f = fixture();
    const v = findId(60000, (i) => {
      const mp = mountedPlate(SEED, i);
      const reg = generateRegistration(SEED, mp.plateVehicleId);
      return mp.anomaly === 'none' && reg.expired && !reg.insured && !reg.stolen && !reg.plateReportedStolen;
    });
    const stop = startStop(f, v, { plateRun: true });
    const run = f.records.runPlate(stop.plate, observedVehicle(SEED, v));
    const draft = citationDraftFromStop(stop, f.records, {}, null, 'here', run);
    expect(draft.violations.map((x) => x.statuteId)).toEqual(['TR-320', 'TR-321']);
    expect(draft.totalFine).toBe(120 + 300);
    // Without the run result, a radio run (plateRun) still gives the registration issues.
    expect(citationDraftFromStop(stop, f.records, {}, null, 'here').violations.map((x) => x.statuteId)).toEqual(['TR-320', 'TR-321']);
    // Not run at all: no plate issues.
    const f2 = fixture();
    expect(citationDraftFromStop(startStop(f2, v), f2.records, {}, null, 'here').violations).toEqual([]);

    const c = findId(60000, (i) => mountedPlate(SEED, i).anomaly === 'cloned');
    const f3 = fixture();
    const cloneStop = startStop(f3, c, { plateRun: true });
    const cloneRun = f3.records.runPlate(cloneStop.plate, observedVehicle(SEED, c));
    expect(cloneRun.flags & PLATE_FLAG.cloned).toBeTruthy();
    expect(citationDraftFromStop(cloneStop, f3.records, {}, null, 'x', cloneRun).violations.map((x) => x.statuteId)).not.toContain('PC-211');
    const checked = { ...cloneStop, vinChecked: true };
    expect(citationDraftFromStop(checked, f3.records, {}, null, 'x', cloneRun).violations.map((x) => x.statuteId)).toContain('PC-211');
  });

  it('leaves non-citeable plate issues (stolen) to a booking', () => {
    const f = fixture();
    const v = findId(60000, (i) => generateRegistration(SEED, i).stolen);
    const stop = startStop(f, v, { plateRun: true });
    const run = f.records.runPlate(stop.plate, observedVehicle(SEED, v));
    const ids = citationDraftFromStop(stop, f.records, {}, null, 'x', run).violations.map((x) => x.statuteId);
    expect(ids).not.toContain('PC-210');
    expect(suggestedCharges(f.records, -1, f.cad.trafficStop)).toEqual(['PC-210']);
  });
});

describe('bookings', () => {
  it('suggests PC-220 for a person with warrants', () => {
    const records = db();
    const wanted = findId(100000, (i) => hasGeneratedWarrant(SEED, i));
    expect(suggestedCharges(records, wanted, null)).toEqual(['PC-220']);
    const clean = findId(100000, (i) => !hasGeneratedWarrant(SEED, i));
    expect(suggestedCharges(records, clean, null)).toEqual([]);
  });

  it('allows completing only at the station, for the seated prisoner, once', () => {
    const b = { personId: 55, status: 'draft' as const };
    expect(canCompleteBooking(b, 55, true)).toBe(true);
    expect(canCompleteBooking(b, 55, false)).toBe(false);
    expect(canCompleteBooking(b, 56, true)).toBe(false);
    expect(canCompleteBooking({ personId: -1 }, -1, true)).toBe(false);
    expect(canCompleteBooking({ personId: 55, status: 'final' }, 55, true)).toBe(false);
    expect(canCompleteBooking(null, 55, true)).toBe(false);
  });
});

describe('documents and stop views', () => {
  it('lists documents newest first and renders read-only sections', () => {
    const f = fixture();
    const author = 'Officer Doe #4071';
    f.cad.docs.create('citation', { plate: 'ABC 1234', violations: [{ statuteId: 'TR-301', fine: 150, detail: '' }] }, at(0), author);
    f.cad.docs.create('citation', { plate: 'XYZ 9876' }, at(60), author);
    const rows = docRows(f.cad.docs, 'citation');
    expect(rows.map((r) => r.id)).toEqual(['CT-000002', 'CT-000001']);
    expect(rows[1]).toMatchObject({ status: 'DRAFT', time: '06/01/2026 14:00', summary: 'ABC 1234 TR-301 $150' });
    const ev = f.cad.docs.create('evidence', { description: 'Knife', category: 'weapon', custody: [{ game: 50400, action: 'collected', by: author, note: '' }] }, at(0), author);
    const s = docSections(ev);
    expect(section(s, 'custody').lines[0]?.text).toBe(`COLLECTED by ${author}`);
  });

  it('shows the stop vehicle, last run, driver and citations', () => {
    const f = fixture();
    const v = findId(60000, (i) => mountedPlate(SEED, i).anomaly === 'none');
    const stop = startStop(f, v, { driverId: 99, citations: ['CT-000001'] });
    const run = f.records.runPlate(stop.plate, observedVehicle(SEED, v));
    const s = stopSections(stop, f.records, observedVehicle(SEED, v), run);
    expect(section(s, 'vehicle').lines[0]).toMatchObject({ label: 'Plate', text: stop.plate });
    expect(section(s, 'driver').lines[0]).toMatchObject({ label: 'Name', personId: 99 });
    expect(section(s, 'citations').lines[0]).toMatchObject({ text: 'CT-000001', docId: 'CT-000001' });
    expect(section(stopSections({ ...stop, driverId: -1 }, f.records, null, null), 'run').lines[0]?.text).toBe('NOT RUN');
  });
});
