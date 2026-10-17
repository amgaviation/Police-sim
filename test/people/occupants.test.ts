import { describe, expect, it } from 'vitest';
import { occupantsOf } from '../../src/people';
import { PERSON_POPULATION } from '../../src/records/ids';
import { driverOf } from '../../src/records/vehicle';
import { FLEET_ID_BASE, isFleetVehicleId } from '../../src/traffic/trafficSystem';
import { REGISTRY_POPULATION } from '../../src/traffic/registry';
import { SEEDS } from '../records/helpers';
import { makeRig } from './helpers';

describe('occupantsOf', () => {
  for (const seed of SEEDS) {
    it(`puts the driver first, never repeats a person and follows the passenger table (seed ${seed})`, () => {
      const counts = [0, 0, 0, 0];
      const n = 3000;
      for (let k = 0; k < n; k++) {
        const v = (k * 19) % REGISTRY_POPULATION;
        const o = occupantsOf(seed, v);
        expect(o[0]).toBe(driverOf(seed, v));
        expect(new Set(o).size).toBe(o.length);
        expect(o.length).toBeGreaterThanOrEqual(1);
        expect(o.length).toBeLessThanOrEqual(4);
        for (const id of o) {
          expect(Number.isInteger(id)).toBe(true);
          expect(id).toBeGreaterThanOrEqual(0);
          expect(id).toBeLessThan(PERSON_POPULATION);
        }
        expect(occupantsOf(seed, v)).toEqual(o);
        counts[o.length - 1] = (counts[o.length - 1] ?? 0) + 1;
      }
      const expected = [0.6, 0.28, 0.09, 0.03];
      for (let i = 0; i < 4; i++) expect((counts[i] ?? 0) / n).toBeCloseTo(expected[i] ?? 0, 1);
    });
  }

  it('gives [] for fleet and unregistered vehicle ids', () => {
    expect(isFleetVehicleId(FLEET_ID_BASE)).toBe(true);
    expect(occupantsOf(42, FLEET_ID_BASE)).toEqual([]);
    expect(occupantsOf(42, FLEET_ID_BASE + 7)).toEqual([]);
    expect(occupantsOf(42, REGISTRY_POPULATION)).toEqual([]);
    expect(occupantsOf(42, -1)).toEqual([]);
    expect(occupantsOf(42, 1.5)).toEqual([]);
  });

  it('is exposed by the population', () => {
    const rig = makeRig();
    expect(rig.pop.occupantsOf(77)).toEqual(occupantsOf(42, 77));
    expect(rig.pop.occupantsOf(FLEET_ID_BASE)).toEqual([]);
  });
});
