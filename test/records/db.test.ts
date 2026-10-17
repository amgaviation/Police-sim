import { describe, expect, it } from 'vitest';
import { CALENDAR, epochDayOfGameSeconds, formatDate } from '../../src/records/calendar';
import { BOLO_DATA } from '../../src/records/data';
import {
  QUERY_LOG_CAP,
  RecordsDb,
  SNAPSHOT_CAP,
  emptyRecordsSave,
  homeEdgesOf,
  isRecordsSave,
  normalizePlate,
  plateSummary,
  type RecordsSave,
} from '../../src/records/db';
import { PERSON_POPULATION, dlNumberOf, ownerOfVehicle, vehicleOfOwner, vinOf } from '../../src/records/ids';
import { generatePerson, personIdentity, type PersonRecord } from '../../src/records/person';
import {
  PLATE_FLAG,
  canBeOnRoad,
  generateRegistration,
  mountedPlate,
  observedVehicle,
  plateFlags,
  vehicleDescription,
} from '../../src/records/vehicle';
import { REGISTRY_POPULATION, plateOf, vehicleRecord } from '../../src/traffic/registry';
import type { City } from '../../src/world/city';
import { DISTRICT, ROAD_CLASS } from '../../src/world/ids';
import { SEEDS, fakeCtx, spreadIds } from './helpers';

function roundTrip<T>(x: T): T {
  return JSON.parse(JSON.stringify(x)) as T;
}

describe.each(SEEDS)('RecordsDb lookups (seed %i)', (seed) => {
  it('is deterministic across repeated lookups and separate instances', () => {
    const a = new RecordsDb(seed, fakeCtx());
    const b = new RecordsDb(seed, fakeCtx());
    for (const id of [0, 5, 777, 54321, PERSON_POPULATION - 1]) {
      const p = a.person(id);
      expect(a.person(id)).toEqual(p);
      expect(b.person(id)).toEqual(p);
      expect(p).toEqual(generatePerson(seed, id, fakeCtx()));
      expect(a.personSummary(id)).toEqual(b.personSummary(id));
    }
    for (const id of [0, 9, 31337, REGISTRY_POPULATION - 1]) {
      const r = a.registration(id);
      expect(a.registration(id)).toEqual(r);
      expect(b.registration(id)).toEqual(r);
      expect(r).toEqual(generateRegistration(seed, id));
    }
    expect(() => a.person(PERSON_POPULATION)).toThrow(RangeError);
    expect(() => a.person(-1)).toThrow(RangeError);
    expect(() => a.person(1.5)).toThrow(RangeError);
    expect(() => a.registration(REGISTRY_POPULATION)).toThrow(RangeError);
    const other = new RecordsDb(seed + 1, fakeCtx());
    expect(other.person(5)).not.toEqual(a.person(5));
  });

  it('resolves every traffic vehicle plate to a registered owner person', () => {
    const db = new RecordsDb(seed, fakeCtx());
    const ids = spreadIds(REGISTRY_POPULATION, 2000);
    expect(ids).toContain(0);
    expect(ids).toContain(REGISTRY_POPULATION - 1);
    expect(ids.length).toBeGreaterThanOrEqual(2000);
    for (const id of ids) {
      const r = db.runPlate(plateOf(seed, id));
      expect(r.found).toBe(true);
      expect(r.registration?.vehicleId).toBe(id);
      expect(r.owner?.id).toBe(ownerOfVehicle(seed, id));
      expect(vehicleOfOwner(seed, r.owner?.id ?? -1)).toBe(id);
      expect(db.person(ownerOfVehicle(seed, id)).id).toBe(ownerOfVehicle(seed, id));
    }
    expect(db.queryLog.length).toBe(QUERY_LOG_CAP);
  });

  it('normalises plates and reports unknown plates', () => {
    const db = new RecordsDb(seed, fakeCtx());
    const plate = plateOf(seed, 12);
    expect(normalizePlate(plate.replace(' ', '').toLowerCase())).toBe(plate);
    expect(normalizePlate(' abc 1234 ')).toBe('ABC 1234');
    expect(normalizePlate('AB 1234')).toBeNull();
    expect(db.runPlate(plate.replace(' ', '').toLowerCase()).registration?.vehicleId).toBe(12);
    // Find a well-formed plate outside the registry.
    let unknown = '';
    for (let n = 0; n < 10000 && unknown === ''; n++) {
      const p = `ZZ${String.fromCharCode(65 + (n % 26))} ${String(n).padStart(4, '0')}`;
      if (!db.runPlate(p).found) unknown = p;
    }
    const r = db.runPlate(unknown, observedVehicle(seed, 3), 500);
    expect(r).toEqual({ plate: unknown, found: false, registration: null, owner: null, hits: [], flags: 0, observed: observedVehicle(seed, 3) });
    expect(plateSummary(r)).toEqual({ plate: unknown, found: false, description: '', owner: '', ownerPersonId: -1, hits: [], severity: 'clear' });
    expect(db.queryLog[db.queryLog.length - 1]).toEqual({ gameSeconds: 500, kind: 'plate', text: unknown, summary: 'NO RECORD', severity: 'clear' });
    expect(db.runPlate('garbage').found).toBe(false);
  });

  it('produces every plate state and detects it from the mounted plate', () => {
    const db = new RecordsDb(seed, fakeCtx());
    const wanted = ['stolenVehicle', 'stolenPlate', 'cloned', 'mismatched', 'expired', 'flagged'] as const;
    const found = new Map<string, number>();
    for (let id = 0; id < REGISTRY_POPULATION && found.size < wanted.length; id++) {
      const rec = vehicleRecord(seed, id);
      const mp = mountedPlate(seed, id);
      const flags = plateFlags(seed, id);
      if (rec.stolen && !found.has('stolenVehicle')) found.set('stolenVehicle', id);
      if (mp.anomaly === 'stolenPlate' && !found.has('stolenPlate')) found.set('stolenPlate', id);
      if (mp.anomaly === 'cloned' && !found.has('cloned')) found.set('cloned', id);
      if (mp.anomaly === 'mismatched' && !found.has('mismatched')) found.set('mismatched', id);
      if (flags & PLATE_FLAG.expired && !found.has('expired')) found.set('expired', id);
      if (flags & PLATE_FLAG.flagged && !found.has('flagged')) found.set('flagged', id);
    }
    for (const state of wanted) expect(found.has(state), `no ${state} car in the population`).toBe(true);

    const bit = { stolenVehicle: PLATE_FLAG.stolen, stolenPlate: PLATE_FLAG.stolen, cloned: PLATE_FLAG.cloned, mismatched: PLATE_FLAG.mismatched, expired: PLATE_FLAG.expired, flagged: PLATE_FLAG.flagged } as const;
    const hitText = {
      stolenVehicle: /^STOLEN VEHICLE$/,
      stolenPlate: /^PLATES REPORTED STOLEN$/,
      cloned: /^POSSIBLE CLONED PLATE - VERIFY VIN$/,
      mismatched: /^DESCRIPTION MISMATCH: RETURNS TO /,
      expired: /^REGISTRATION EXPIRED \d\d\/\d\d\/\d{4}$/,
      flagged: /^(FLAG: |RO WANTED: |BOLO: )/,
    } as const;
    for (const state of wanted) {
      const id = found.get(state) ?? -1;
      const mp = mountedPlate(seed, id);
      expect(plateFlags(seed, id) & bit[state]).toBe(bit[state]);
      const r = db.runPlate(mp.plate, observedVehicle(seed, id), 3600);
      expect(r.flags & bit[state], state).toBe(bit[state]);
      expect(r.hits.some((h) => hitText[state].test(h.text)), `${state}: ${r.hits.map((h) => h.text).join(' | ')}`).toBe(true);
      expect(plateSummary(r).severity).not.toBe('clear');
      if (state === 'cloned') {
        // The VIN check returns the car's own registration, whose plate is not the mounted one.
        const vin = db.runVin(vinOf(seed, id));
        expect(vin.found).toBe(true);
        expect(vin.registration?.vehicleId).toBe(id);
        expect(vin.registration?.plate).not.toBe(mp.plate);
      }
      if (state === 'mismatched') {
        const reg = generateRegistration(seed, mp.plateVehicleId);
        expect(r.hits.map((h) => h.text)).toContain(`DESCRIPTION MISMATCH: RETURNS TO ${vehicleDescription(reg).toUpperCase()}`);
      }
    }

    // Clean cars (no truth flags, no clone alert on file) run with no flags; some are fully clear.
    let checked = 0;
    let clear = 0;
    for (let id = 0; checked < 200; id++) {
      if (!canBeOnRoad(seed, id) || plateFlags(seed, id) !== 0 || generateRegistration(seed, id).cloneAlert) continue;
      checked++;
      const r = db.runPlate(plateOf(seed, id), observedVehicle(seed, id));
      expect(r.flags, `vehicle ${id}`).toBe(0);
      if (plateSummary(r).severity === 'clear') {
        clear++;
        expect(r.hits.filter((h) => h.severity !== 'info')).toEqual([]);
      }
    }
    expect(clear).toBeGreaterThan(50);
  });

  it('summarises plate runs in the cad readback shape', () => {
    const db = new RecordsDb(seed, fakeCtx());
    const r = db.runPlate(plateOf(seed, 40), observedVehicle(seed, 40), 7200);
    const s = plateSummary(r);
    const reg = generateRegistration(seed, 40);
    const owner = personIdentity(seed, reg.ownerId);
    expect(s.plate).toBe(reg.plate);
    expect(s.found).toBe(true);
    expect(s.description).toBe(vehicleDescription(reg));
    expect(s.owner).toBe(`${owner.last}, ${owner.first} ${owner.middle}`.toUpperCase());
    expect(s.ownerPersonId).toBe(reg.ownerId);
    expect(s.hits).toEqual(r.hits.map((h) => h.text));
    for (const t of s.hits) expect(t).toBe(t.toUpperCase());
    const last = db.queryLog[db.queryLog.length - 1];
    expect(last?.kind).toBe('plate');
    expect(last?.gameSeconds).toBe(7200);
    expect(last?.severity).toBe(s.severity);
  });
});

describe.each(SEEDS)('RecordsDb overlay and persistence (seed %i)', (seed) => {
  function personWithWarrant(db: RecordsDb, from = 0): PersonRecord {
    for (let id = from; ; id++) {
      const p = db.person(id);
      if (p.warrants.length > 0) return p;
    }
  }

  it('applies contacts, served warrants and added BOLOs', () => {
    const today = CALENDAR.startEpochDay + 2;
    const db = new RecordsDb(seed, fakeCtx(today));
    const p = personWithWarrant(db);
    const w = p.warrants[0];
    if (!w) throw new Error('no warrant');
    expect(db.personHits(p.id).some((h) => h.kind === 'warrant' && h.text.startsWith(`WARRANT: ${w.offense.toUpperCase()}`))).toBe(true);
    db.serveWarrant(p.id, w.id);
    expect(db.person(p.id).warrants.map((x) => x.id)).not.toContain(w.id);
    expect(db.personHits(p.id).filter((h) => h.kind === 'warrant')).toHaveLength(p.warrants.length - 1);

    const gs = 2 * 86400 + 3600;
    db.addContact(p.id, { gameSeconds: gs, kind: 'citation', ref: 'CT-000001', summary: 'Speeding 45 in a 30' });
    db.addContact(p.id, { gameSeconds: gs + 60, kind: 'warning', ref: '', summary: 'Verbal warning' });
    const priors = db.person(p.id).priors;
    expect(priors[0]).toEqual({ day: epochDayOfGameSeconds(gs + 60), kind: 'warning', location: '', summary: 'Verbal warning', ref: '' });
    expect(priors[1]).toEqual({ day: epochDayOfGameSeconds(gs), kind: 'citation', location: '', summary: 'Speeding 45 in a 30', ref: 'CT-000001' });
    expect(priors.slice(2)).toEqual(p.priors);

    // An added vehicle BOLO shows on a plate run and sets the flagged bit.
    const vid = 4321;
    const bolo = db.addBolo({ day: today, kind: 'vehicle', vehicleId: vid, personId: -1, text: 'Suspect vehicle in a burglary' });
    expect(bolo.id).toBe('BOLO-A0001');
    expect(db.bolos(today)).toContainEqual(bolo);
    expect(db.bolos(today - 1)).not.toContainEqual(bolo);
    const r = db.runPlate(plateOf(seed, vid));
    expect(r.hits.map((h) => h.text)).toContain('BOLO: SUSPECT VEHICLE IN A BURGLARY');
    expect(r.flags & PLATE_FLAG.flagged).toBe(PLATE_FLAG.flagged);
    const pb = db.addBolo({ day: today, kind: 'person', vehicleId: -1, personId: 10, text: 'Missing person' });
    expect(pb.id).toBe('BOLO-A0002');
    expect(db.personHits(10).map((h) => h.text)).toContain('BOLO: MISSING PERSON');

    expect(() => db.addContact(PERSON_POPULATION, { gameSeconds: 0, kind: 'warning', ref: '', summary: '' })).toThrow(RangeError);
    expect(() => db.serveWarrant(-1, 'W')).toThrow(RangeError);
  });

  it('persists touched records, the overlay and the query log across save/load', () => {
    const ctx = fakeCtx(CALENDAR.startEpochDay + 1);
    const db = new RecordsDb(seed, ctx);
    const personIds = Array.from({ length: 50 }, (_, i) => i * 1999 + 3);
    const vehicleIds = Array.from({ length: 50 }, (_, i) => i * 1187 + 5);
    for (const id of personIds) db.person(id);
    for (const id of vehicleIds) db.registration(id);
    const wanted = personWithWarrant(db, 50000);
    const servedId = wanted.warrants[0]?.id ?? '';
    db.serveWarrant(wanted.id, servedId);
    db.addContact(personIds[3] ?? 0, { gameSeconds: 90000, kind: 'arrest', ref: 'B-0001', summary: 'Booked' });
    db.addBolo({ day: ctx.today(), kind: 'vehicle', vehicleId: 59000, personId: -1, text: 'Wanted in a robbery' });
    db.runPlate(plateOf(seed, 777), observedVehicle(seed, 777), 1234);
    db.runVin(vinOf(seed, 778), 1300);
    db.findPersons({ last: personIdentity(seed, 9).last }, 5, 1400);

    const save = roundTrip(db.serialize());
    expect(isRecordsSave(save)).toBe(true);
    expect(save.persons.length).toBeLessThanOrEqual(SNAPSHOT_CAP);
    const loaded = new RecordsDb(seed, ctx);
    loaded.restore(save);
    expect(loaded.queryLog).toEqual(db.queryLog);
    expect(loaded.queryLog.map((q) => q.kind)).toEqual(['plate', 'vin', 'person']);

    for (const id of personIds) expect(loaded.person(id)).toEqual(db.person(id));
    for (const id of vehicleIds) expect(loaded.registration(id)).toEqual(db.registration(id));
    expect(loaded.person(wanted.id).warrants.map((w) => w.id)).not.toContain(servedId);
    expect(loaded.person(personIds[3] ?? 0).priors[0]?.ref).toBe('B-0001');
    expect(loaded.bolos(ctx.today())).toEqual(db.bolos(ctx.today()));
    expect(loaded.runPlate(plateOf(seed, 59000)).hits.map((h) => h.text)).toContain('BOLO: WANTED IN A ROBBERY');
    // Untouched records equal regeneration.
    for (const id of [11, 22222, 99998]) expect(loaded.person(id)).toEqual(generatePerson(seed, id, ctx));
    expect(loaded.registration(33333)).toEqual(generateRegistration(seed, 33333));
    // A second save from the loaded game equals the first one (plus the new touches).
    const again = roundTrip(loaded.serialize());
    expect(again.contacts).toEqual(save.contacts);
    expect(again.served).toEqual(save.served);
    expect(again.bolos).toEqual(save.bolos);
    // New added BOLOs continue the numbering.
    expect(loaded.addBolo({ day: ctx.today(), kind: 'person', vehicleId: -1, personId: 1, text: 'x' }).id).toBe('BOLO-A0002');
  });

  it('snapshots take precedence over regeneration; malformed entries are dropped', () => {
    const ctx = fakeCtx();
    const db = new RecordsDb(seed, ctx);
    db.person(123);
    db.registration(456);
    const save = roundTrip(db.serialize());
    const p = save.persons.find((x) => x.id === 123);
    const r = save.vehicles.find((x) => x.vehicleId === 456);
    if (!p || !r) throw new Error('snapshot missing');
    (p as { last: string }).last = 'Altered';
    (r as { colorName: string }).colorName = 'purple';
    save.persons.push({ id: 124, broken: true } as unknown as PersonRecord);
    save.vehicles.push({ vehicleId: 'x' } as unknown as RecordsSave['vehicles'][number]);
    const loaded = new RecordsDb(seed, ctx);
    loaded.restore(save);
    expect(loaded.person(123).last).toBe('Altered');
    expect(loaded.registration(456).colorName).toBe('purple');
    expect(loaded.person(124)).toEqual(generatePerson(seed, 124, ctx));
    // The altered snapshot survives another save/load.
    const second = new RecordsDb(seed, ctx);
    second.restore(roundTrip(loaded.serialize()));
    expect(second.person(123).last).toBe('Altered');
  });

  it('caps snapshots, evicting the least recently touched but keeping referenced records', () => {
    const db = new RecordsDb(seed, fakeCtx());
    db.addContact(1, { gameSeconds: 0, kind: 'trafficStop', ref: '', summary: 'Stop' });
    for (let id = 2; id < 2 + SNAPSHOT_CAP + 100; id++) db.person(id);
    for (let id = 0; id < SNAPSHOT_CAP + 100; id++) db.registration(id);
    db.person(2); // re-touched: now most recent
    const save = db.serialize();
    const ids = save.persons.map((p) => p.id);
    expect(ids.length).toBe(SNAPSHOT_CAP);
    expect(ids).toContain(1);
    expect(ids).toContain(2);
    expect(ids).not.toContain(3);
    expect(ids[ids.length - 1]).toBe(2);
    expect(save.vehicles.length).toBe(SNAPSHOT_CAP);
    expect(save.vehicles[0]?.vehicleId).toBe(100);
  });

  it('validates save blocks structurally', () => {
    const db = new RecordsDb(seed, fakeCtx());
    db.runPlate(plateOf(seed, 1));
    expect(isRecordsSave(emptyRecordsSave())).toBe(true);
    expect(isRecordsSave(roundTrip(db.serialize()))).toBe(true);
    for (const bad of [
      null, 42, 'save', [], {}, { ...emptyRecordsSave(), version: 2 }, { ...emptyRecordsSave(), persons: {} },
      { ...emptyRecordsSave(), contacts: [[1, [{ gameSeconds: 0, kind: 'hug', ref: '', summary: '' }]]] },
      { ...emptyRecordsSave(), served: [[1, [5]]] }, { ...emptyRecordsSave(), served: [['1', ['W1-1']]] },
      { ...emptyRecordsSave(), bolos: [{ id: 'B', day: 1, kind: 'boat', vehicleId: 1, personId: -1, text: '' }] },
      { ...emptyRecordsSave(), queries: [{ gameSeconds: 0, kind: 'plate', text: '', summary: '', severity: 'red' }] },
    ]) {
      expect(isRecordsSave(bad)).toBe(false);
    }
    // restore tolerates garbage (resets to empty).
    db.restore({ version: 1 } as unknown as RecordsSave);
    expect(db.queryLog).toEqual([]);
    expect(db.serialize()).toEqual(emptyRecordsSave());
  });
});

describe.each(SEEDS)('RecordsDb search and BOLOs (seed %i)', (seed) => {
  it('finds people by name, DOB and DL number in a deterministic order', () => {
    const db = new RecordsDb(seed, fakeCtx());
    const t0 = performance.now();
    db.findPersons({ last: 'Sm' });
    expect(performance.now() - t0).toBeLessThan(200);

    for (let i = 0; i < 200; i++) {
      const id = (i * 49999 + 17) % PERSON_POPULATION;
      const p = personIdentity(seed, id);
      const res = db.findPersons({ last: p.last.toLowerCase(), first: p.first }, 100);
      expect(res.map((s) => s.personId), `${p.last} ${p.first}`).toContain(id);
      const byDob = db.findPersons({ last: p.last, first: p.first, dob: p.dob }, 100);
      expect(byDob.map((s) => s.personId)).toContain(id);
      expect(byDob.length).toBeLessThanOrEqual(res.length);
      for (const s of byDob) expect(s.dob).toBe(formatDate(p.dob));
    }

    const res = db.findPersons({ last: 'Ma' }, 20);
    expect(res).toHaveLength(20);
    expect(db.findPersons({ last: 'MA' }, 20)).toEqual(res);
    expect(new RecordsDb(seed, fakeCtx()).findPersons({ last: 'ma' }, 20)).toEqual(res);
    const keys = res.map((s) => {
      const p = personIdentity(seed, s.personId);
      return [p.last.toUpperCase(), p.first.toUpperCase(), p.dob, p.id] as const;
    });
    for (let i = 1; i < keys.length; i++) {
      const a = keys[i - 1]!;
      const b = keys[i]!;
      const order = a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : a[2] - b[2] || a[3] - b[3];
      expect(order).toBeLessThan(0);
    }
    for (const s of res) expect(personIdentity(seed, s.personId).last.toUpperCase().startsWith('MA')).toBe(true);

    let withDl = 0;
    for (let id = 0; id < 300; id++) {
      const p = db.person(id);
      const found = db.findPersons({ dl: dlNumberOf(seed, id) });
      if (p.license.status === 'none') expect(found).toEqual([]);
      else {
        withDl++;
        expect(found.map((s) => s.personId)).toEqual([id]);
        expect(found[0]?.dl).toBe(p.license.number);
        expect(found[0]?.dlStatus).toBe(p.license.status.toUpperCase());
      }
    }
    expect(withDl).toBeGreaterThan(250);
    expect(db.findPersons({ dl: 'D000' })).toEqual([]);
    expect(db.findPersons({ last: 'S' })).toEqual([]);
    expect(db.findPersons({ first: 'John' })).toEqual([]);
    const log = db.queryLog[db.queryLog.length - 1];
    expect(log?.kind).toBe('person');
  });

  it('publishes a deterministic daily BOLO bulletin', () => {
    const day = CALENDAR.startEpochDay + 3;
    const a = new RecordsDb(seed, fakeCtx(day));
    const b = new RecordsDb(seed, fakeCtx(day));
    const list = a.bolos(day);
    expect(b.bolos(day)).toEqual(list);
    expect(a.bolos(day)).toEqual(list);
    expect(list.length).toBeGreaterThanOrEqual(BOLO_DATA.perDay[0]);
    expect(list.length).toBeLessThanOrEqual(BOLO_DATA.perDay[1]);
    expect(a.bolos(day + 1)).not.toEqual(list);
    let sawVehicle = false;
    for (let d = day; d < day + 10; d++) {
      for (const bolo of a.bolos(d)) {
        expect(bolo.day).toBe(d);
        if (bolo.kind === 'person') {
          const wanted = generatePerson(seed, bolo.personId, fakeCtx()).warrants.length > 0;
          expect(wanted).toBe(!/Missing person/.test(bolo.text));
          continue;
        }
        const reg = generateRegistration(seed, bolo.vehicleId);
        expect(reg.stolen || reg.flag !== null).toBe(true);
        if (d === day) {
          sawVehicle = true;
          const r = a.runPlate(reg.plate);
          expect(r.hits.map((h) => h.text)).toContain(`BOLO: ${bolo.text.toUpperCase()}`);
          expect(r.flags & PLATE_FLAG.flagged).toBe(PLATE_FLAG.flagged);
        }
      }
    }
    // The first day may only hold person BOLOs; any vehicle BOLO of today must show on its plate.
    if (!sawVehicle) expect(list.every((x) => x.kind === 'person')).toBe(true);
  });

  it('lists home edges: local and collector roads in suburbs, downtown and rural districts', () => {
    const edges = [
      { id: 0, roadClass: ROAD_CLASS.local, district: DISTRICT.suburbs },
      { id: 1, roadClass: ROAD_CLASS.arterial, district: DISTRICT.suburbs },
      { id: 2, roadClass: ROAD_CLASS.collector, district: DISTRICT.downtown },
      { id: 3, roadClass: ROAD_CLASS.local, district: DISTRICT.industrial },
      { id: 4, roadClass: ROAD_CLASS.local, district: DISTRICT.rural },
      { id: 5, roadClass: ROAD_CLASS.highway, district: DISTRICT.rural },
    ];
    const city = { graph: { edges } } as unknown as City;
    expect(homeEdgesOf(city)).toEqual([0, 2, 4]);
  });

  it('answers single lookups well within 0.5 ms', () => {
    const db = new RecordsDb(seed, fakeCtx());
    db.runPlate(plateOf(seed, 0));
    const n = 300;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) {
      const id = (i * 197 + 11) % REGISTRY_POPULATION;
      db.runPlate(plateOf(seed, id), observedVehicle(seed, id));
      db.person((i * 331 + 7) % PERSON_POPULATION);
    }
    expect((performance.now() - t0) / n).toBeLessThan(0.5);
  });
});
