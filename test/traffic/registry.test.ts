import { describe, expect, it } from 'vitest';
import { VIOLATIONS } from '../../src/traffic/data';
import {
  PLATE_SPACE,
  REGISTRY_POPULATION,
  plateOf,
  vehicleIdFromPlate,
  vehicleRecord,
  type VehicleRecord,
} from '../../src/traffic/registry';
import { FAULT } from '../../src/vehicles/components';
import { canBeOnRoad, plateReportedStolen } from '../../src/records/vehicle';
import { lineGraph, makeHarness } from './helpers';
import { TRAFFIC_MODELS, VEHICLE_MODELS } from '../../src/vehicles/model';

const SEED = 1234;

describe('plates', () => {
  it('round-trips 10k ids and matches ABC 1234', () => {
    const seen = new Set<string>();
    for (let id = 0; id < 10000; id++) {
      const plate = plateOf(SEED, id);
      expect(plate).toMatch(/^[A-Z]{3} \d{4}$/);
      expect(vehicleIdFromPlate(SEED, plate)).toBe(id);
      seen.add(plate);
    }
    expect(seen.size).toBe(10000);
  });

  it('round-trips the top of the population and depends on the seed', () => {
    const last = REGISTRY_POPULATION - 1;
    expect(vehicleIdFromPlate(SEED, plateOf(SEED, last))).toBe(last);
    expect(plateOf(SEED, 5)).not.toBe(plateOf(SEED + 1, 5));
    expect(vehicleIdFromPlate(SEED, plateOf(SEED, 5).toLowerCase())).toBe(5);
  });

  it('rejects malformed plates and ids outside the population', () => {
    for (const bad of ['', 'AB 1234', 'ABCD 1234', 'ABC1234', 'ABC 123', 'AB1 1234', 'ABC 12345']) {
      expect(vehicleIdFromPlate(SEED, bad)).toBeNull();
    }
    // Most plates in the 175M space decode to ids beyond the 60k population.
    let outside = 0;
    for (let n = 0; n < 200; n++) {
      const letters = String.fromCharCode(65 + (n % 26), 65 + ((n * 7) % 26), 65 + ((n * 11) % 26));
      const plate = `${letters} ${String((n * 37) % 10000).padStart(4, '0')}`;
      const id = vehicleIdFromPlate(SEED, plate);
      if (id === null) outside++;
      else expect(plateOf(SEED, id)).toBe(plate);
    }
    expect(outside).toBeGreaterThan(190);
    expect(PLATE_SPACE).toBe(175760000);
  });
});

describe('vehicleRecord', () => {
  it('is a pure function of (seed, id)', () => {
    expect(vehicleRecord(SEED, 42)).toEqual(vehicleRecord(SEED, 42));
    expect(vehicleRecord(SEED, 42)).not.toEqual(vehicleRecord(SEED + 1, 42));
    const r = vehicleRecord(SEED, 42);
    expect(r.plate).toBe(plateOf(SEED, 42));
    expect(VEHICLE_MODELS[r.modelIndex]?.id).toBe(r.modelId);
    expect(TRAFFIC_MODELS.some((m) => m.id === r.modelId)).toBe(true);
    expect(VEHICLE_MODELS[r.modelIndex]?.colors.some((c) => c.rgb === r.color)).toBe(true);
    expect(() => vehicleRecord(SEED, -1)).toThrow(RangeError);
    expect(() => vehicleRecord(SEED, REGISTRY_POPULATION)).toThrow(RangeError);
  });

  it('flag, fault and tendency rates match the data within 30% over 20k ids', () => {
    const N = 20000;
    const records: VehicleRecord[] = [];
    for (let id = 0; id < N; id++) records.push(vehicleRecord(SEED, id));
    const rate = (pred: (r: VehicleRecord) => boolean): number => records.filter(pred).length / N;
    const f = VIOLATIONS.vehicleFlags;
    const b = VIOLATIONS.behaviors;
    const checks: [number, number][] = [
      [rate((r) => r.registrationExpired), f.expiredRegistration],
      [rate((r) => !r.insured), f.noInsurance],
      [rate((r) => r.stolen), f.stolen],
      [rate((r) => (r.faults & (FAULT.headLeftOut | FAULT.headRightOut)) !== 0), f.headlightOut],
      [rate((r) => (r.faults & FAULT.tailOut) !== 0), f.taillightOut],
      [rate((r) => (r.faults & FAULT.brakeOut) !== 0), f.brakeLightOut],
      [rate((r) => r.tendencies.speeding), b.speeding.share],
      [rate((r) => r.tendencies.tailgating), b.tailgating.share],
      [rate((r) => r.tendencies.redLight), b.redLight.share],
      [rate((r) => r.tendencies.rollingStop), b.rollingStop.share],
      [records.reduce((sum, r) => sum + r.tendencies.duiRisk, 0) / N, b.dui.share],
    ];
    for (const [got, want] of checks) {
      expect(got).toBeGreaterThan(want * 0.7);
      expect(got).toBeLessThan(want * 1.3);
    }
  });

  it('picks models by trafficWeight', () => {
    const N = 20000;
    const counts = new Map<string, number>();
    for (let id = 0; id < N; id++) {
      const m = vehicleRecord(SEED, id).modelId;
      counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    const total = TRAFFIC_MODELS.reduce((s, m) => s + m.trafficWeight, 0);
    for (const m of TRAFFIC_MODELS) {
      const want = m.trafficWeight / total;
      const got = (counts.get(m.id) ?? 0) / N;
      expect(Math.abs(got - want)).toBeLessThan(Math.max(want * 0.3, 0.005));
    }
    expect(counts.has('patrol_sedan')).toBe(false);
  });
});

describe('spawn walk', () => {
  it('never spawns a registration whose plates were reported stolen', async () => {
    const h = await makeHarness(lineGraph(), 42);
    const walk = h.sys as unknown as { nextVehicleId(): number };
    let skipped = 0;
    const seen = new Set<number>();
    for (let i = 0; i < 20000; i++) {
      const id = walk.nextVehicleId();
      expect(canBeOnRoad(42, id), `vehicle ${id}`).toBe(true);
      seen.add(id);
    }
    for (let id = 0; id < REGISTRY_POPULATION; id++) if (plateReportedStolen(42, id)) skipped++;
    expect(skipped).toBeGreaterThan(0);
    expect(seen.size).toBe(20000);
  });
});
