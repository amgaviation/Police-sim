import { describe, expect, it } from 'vitest';
import { CALENDAR } from '../../src/records/calendar';
import { VEHICLE_DATA } from '../../src/records/data';
import { PERSON_POPULATION, ownerOfVehicle, vinOf } from '../../src/records/ids';
import {
  PLATE_FLAG,
  canBeOnRoad,
  cloneAlert,
  colorName,
  driverOf,
  generateRegistration,
  modelName,
  mountedPlate,
  observedVehicle,
  plateFlags,
  plateReportedStolen,
  vehicleDescription,
} from '../../src/records/vehicle';
import { REGISTRY_POPULATION, plateOf, vehicleRecord } from '../../src/traffic/registry';
import { VEHICLE_MODELS } from '../../src/vehicles/model';
import { SEEDS } from './helpers';

describe('colours and models', () => {
  it('names every colour used by a vehicle model exactly, and others by the nearest entry', () => {
    for (const m of VEHICLE_MODELS) {
      for (const c of m.colors) {
        const entry = VEHICLE_DATA.colors.find((e) => e.rgb === c.rgb);
        expect(entry, `${m.id} ${c.hex}`).toBeDefined();
        expect(colorName(c.rgb)).toBe(entry?.name);
      }
    }
    expect(colorName(0x000000)).toBe('black');
    expect(colorName(0xfefefe)).toBe('white');
    expect(colorName(0xd01010)).toBe('red');
    expect(modelName('sedan')).toBe('Sedan');
    expect(modelName('unknown_model')).toBe('unknown_model');
    expect(vehicleDescription({ year: 2019, colorName: 'black', modelName: 'Sedan' })).toBe('2019 black Sedan');
  });
});

describe.each(SEEDS)('registrations and plates (seed %i)', (seed) => {
  it('builds registrations on the unchanged Phase 1 registry record', () => {
    for (let id = 0; id < 2000; id++) {
      const r = generateRegistration(seed, id);
      const rec = vehicleRecord(seed, id);
      expect(r).toEqual(generateRegistration(seed, id));
      expect(r.vehicleId).toBe(id);
      expect(r.plate).toBe(plateOf(seed, id));
      expect(r.vin).toBe(vinOf(seed, id));
      expect(r.ownerId).toBe(ownerOfVehicle(seed, id));
      expect([r.modelId, r.color, r.year, r.expired, r.insured, r.stolen]).toEqual([
        rec.modelId, rec.color, rec.year, rec.registrationExpired, rec.insured, rec.stolen,
      ]);
      expect(r.colorName).toBe(colorName(rec.color));
      expect(r.insurer === '').toBe(!r.insured);
      const reg = VEHICLE_DATA.registration;
      if (r.expired) {
        expect(r.expires).toBeLessThan(CALENDAR.startEpochDay);
        expect(r.expires).toBeGreaterThanOrEqual(CALENDAR.startEpochDay - reg.expiredMaxDays);
      } else {
        expect(r.expires).toBeGreaterThanOrEqual(CALENDAR.startEpochDay + reg.validMinDays);
        expect(r.expires).toBeLessThanOrEqual(CALENDAR.startEpochDay + reg.validMaxDays);
      }
      expect(r.plateReportedStolen).toBe(plateReportedStolen(seed, id));
      expect(r.cloneAlert).toBe(cloneAlert(seed, id));
      expect(JSON.parse(JSON.stringify(r))).toEqual(r);
    }
    expect(JSON.stringify(generateRegistration(seed, 9))).not.toBe(JSON.stringify(generateRegistration(seed + 1, 9)));
    expect(() => generateRegistration(seed, REGISTRY_POPULATION)).toThrow(RangeError);
  });

  it('mounts exclusive plate anomalies with valid donors', () => {
    const counts = { none: 0, cloned: 0, mismatched: 0, stolenPlate: 0 };
    const n = 20000;
    for (let id = 0; id < n; id++) {
      const mp = mountedPlate(seed, id);
      expect(mp).toEqual(mountedPlate(seed, id));
      counts[mp.anomaly]++;
      const own = vehicleRecord(seed, id);
      expect(observedVehicle(seed, id)).toEqual({ modelId: own.modelId, color: own.color });
      if (mp.anomaly === 'none') {
        expect(mp.plateVehicleId).toBe(id);
        expect(mp.plate).toBe(own.plate);
        continue;
      }
      expect(own.stolen).toBe(false); // a stolen vehicle keeps its own plate
      expect(mp.plateVehicleId).not.toBe(id);
      const donor = vehicleRecord(seed, mp.plateVehicleId);
      expect(mp.plate).toBe(donor.plate);
      if (mp.anomaly === 'cloned') {
        expect([donor.modelId, donor.color]).toEqual([own.modelId, own.color]);
        expect(cloneAlert(seed, mp.plateVehicleId)).toBe(true);
      } else if (mp.anomaly === 'mismatched') {
        expect(donor.modelId).not.toBe(own.modelId);
      } else {
        expect(plateReportedStolen(seed, mp.plateVehicleId)).toBe(true);
      }
    }
    const a = VEHICLE_DATA.plateAnomalies;
    expect(counts.cloned / n).toBeGreaterThan(a.cloned * 0.4);
    expect(counts.cloned / n).toBeLessThan(a.cloned * 1.8);
    expect(counts.mismatched / n).toBeGreaterThan(a.mismatched * 0.5);
    expect(counts.mismatched / n).toBeLessThan(a.mismatched * 1.6);
    expect(counts.stolenPlate / n).toBeGreaterThan(a.stolenPlate * 0.4);
    expect(counts.stolenPlate / n).toBeLessThan(a.stolenPlate * 1.8);
  });

  it('vehicle flags describe the vehicle, never its registered owner', () => {
    for (const reason of VEHICLE_DATA.flags.reasons) expect(reason, reason).not.toMatch(/owner|missing/i);
  });

  it('plate flags follow the anomaly and the mounted registration', () => {
    for (let id = 0; id < 3000; id++) {
      const flags = plateFlags(seed, id);
      expect(plateFlags(seed, id)).toBe(flags);
      const mp = mountedPlate(seed, id);
      const reg = generateRegistration(seed, mp.plateVehicleId);
      expect((flags & PLATE_FLAG.cloned) !== 0).toBe(mp.anomaly === 'cloned');
      const otherLook = mp.anomaly === 'mismatched' || (mp.anomaly === 'stolenPlate' && (reg.modelId !== vehicleRecord(seed, id).modelId || reg.color !== vehicleRecord(seed, id).color));
      if (mp.anomaly === 'none' || mp.anomaly === 'cloned' || mp.anomaly === 'mismatched') expect((flags & PLATE_FLAG.mismatched) !== 0).toBe(otherLook);
      expect((flags & PLATE_FLAG.expired) !== 0).toBe(reg.expired);
      if (vehicleRecord(seed, id).stolen || mp.anomaly === 'stolenPlate') expect(flags & PLATE_FLAG.stolen).toBe(PLATE_FLAG.stolen);
      if (reg.flag !== null) expect(flags & PLATE_FLAG.flagged).toBe(PLATE_FLAG.flagged);
    }
  });

  it('picks drivers deterministically: never the owner of a stolen or anomalous car, else mostly the owner', () => {
    let clean = 0;
    let owner = 0;
    let checkedStolen = 0;
    let checkedAnomalous = 0;
    for (let id = 0; clean < 5000 && id < REGISTRY_POPULATION; id++) {
      const d = driverOf(seed, id);
      expect(driverOf(seed, id)).toBe(d);
      expect(d >= 0 && d < PERSON_POPULATION).toBe(true);
      const isOwner = d === ownerOfVehicle(seed, id);
      if (vehicleRecord(seed, id).stolen) {
        checkedStolen++;
        expect(isOwner).toBe(false);
      } else if (mountedPlate(seed, id).anomaly !== 'none') {
        checkedAnomalous++;
        expect(isOwner).toBe(false);
      } else {
        clean++;
        if (isOwner) owner++;
      }
    }
    expect(checkedStolen).toBeGreaterThan(0);
    expect(checkedAnomalous).toBeGreaterThan(0);
    expect(Math.abs(owner / clean - VEHICLE_DATA.driverIsOwner)).toBeLessThan(0.05);
  });
});

describe.each(SEEDS)('reported-stolen plates stay off the road (seed %i)', (seed) => {
  it('never lets a car drive on its own reported-stolen plate, so stolen means a stolen car or a stolen plate', () => {
    let offRoad = 0;
    for (let id = 0; id < 20000; id++) {
      const own = plateReportedStolen(seed, id);
      expect(canBeOnRoad(seed, id)).toBe(!own);
      if (own) {
        offRoad++;
        continue;
      }
      const mp = mountedPlate(seed, id);
      const stolen = (plateFlags(seed, id) & PLATE_FLAG.stolen) !== 0;
      expect(stolen, `vehicle ${id}`).toBe(vehicleRecord(seed, id).stolen || mp.anomaly === 'stolenPlate');
      // A reported-stolen plate is only ever seen on another car.
      if (generateRegistration(seed, mp.plateVehicleId).plateReportedStolen) expect(mp.plateVehicleId).not.toBe(id);
    }
    expect(offRoad).toBeGreaterThan(20);
  });
});
