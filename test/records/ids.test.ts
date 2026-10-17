import { describe, expect, it } from 'vitest';
import { VIN_ALPHABET } from '../../src/records/data';
import {
  PERSON_POPULATION,
  dlNumberOf,
  ownerOfVehicle,
  personIdFromDl,
  vehicleIdFromVin,
  vehicleOfOwner,
  vinOf,
} from '../../src/records/ids';
import { REGISTRY_POPULATION } from '../../src/traffic/registry';
import { SEEDS } from './helpers';

describe.each(SEEDS)('identity bijections (seed %i)', (seed) => {
  it('maps every registered vehicle to a distinct owner and back', () => {
    expect(PERSON_POPULATION).toBe(100000);
    const owners = new Set<number>();
    for (let v = 0; v < REGISTRY_POPULATION; v++) {
      const owner = ownerOfVehicle(seed, v);
      expect(owner >= 0 && owner < PERSON_POPULATION).toBe(true);
      owners.add(owner);
      if (vehicleOfOwner(seed, owner) !== v) expect(vehicleOfOwner(seed, owner)).toBe(v);
    }
    expect(owners.size).toBe(REGISTRY_POPULATION);
    let nonOwners = 0;
    for (let p = 0; p < PERSON_POPULATION; p++) if (vehicleOfOwner(seed, p) === -1) nonOwners++;
    expect(nonOwners).toBe(PERSON_POPULATION - REGISTRY_POPULATION);
    expect(vehicleOfOwner(seed, -1)).toBe(-1);
    expect(vehicleOfOwner(seed, PERSON_POPULATION)).toBe(-1);
    expect(() => ownerOfVehicle(seed, REGISTRY_POPULATION)).toThrow(RangeError);
  });

  it('round-trips DL numbers and rejects malformed or out-of-range ones', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const id = Math.floor((i * PERSON_POPULATION) / 5000) + (i % 17);
      const dl = dlNumberOf(seed, id);
      expect(dl).toMatch(/^D\d{7}$/);
      expect(personIdFromDl(seed, dl)).toBe(id);
      expect(personIdFromDl(seed, ` ${dl.toLowerCase()} `)).toBe(id);
      seen.add(dl);
    }
    expect(seen.size).toBe(5000);
    expect(personIdFromDl(seed, dlNumberOf(seed, PERSON_POPULATION - 1))).toBe(PERSON_POPULATION - 1);
    for (const bad of ['', 'D123456', 'D12345678', 'X1234567', '1234567', 'D12345A7', 'DD123456']) {
      expect(personIdFromDl(seed, bad)).toBeNull();
    }
    // 10^7 numbers for 10^5 persons: most valid-looking numbers belong to nobody.
    let outside = 0;
    for (let n = 0; n < 1000; n++) if (personIdFromDl(seed, `D${String(n * 9973).padStart(7, '0')}`) === null) outside++;
    expect(outside).toBeGreaterThan(950);
    expect(() => dlNumberOf(seed, PERSON_POPULATION)).toThrow(RangeError);
  });

  it('round-trips VINs: 17 characters of the VIN alphabet; tampering is rejected', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      const id = Math.floor((i * REGISTRY_POPULATION) / 5000) + (i % 11);
      const vin = vinOf(seed, id);
      expect(vin).toHaveLength(17);
      for (const ch of vin) expect(VIN_ALPHABET.includes(ch)).toBe(true);
      expect(vin.startsWith('PT')).toBe(true);
      expect(vehicleIdFromVin(seed, vin)).toBe(id);
      seen.add(vin);
      if (i % 50 === 0) {
        for (let pos = 0; pos < 17; pos++) {
          const ch = vin.charAt(pos);
          const other = VIN_ALPHABET.charAt((VIN_ALPHABET.indexOf(ch) + 1 + (i % 31)) % VIN_ALPHABET.length);
          expect(vehicleIdFromVin(seed, vin.slice(0, pos) + other + vin.slice(pos + 1))).toBeNull();
        }
      }
    }
    expect(seen.size).toBe(5000);
    expect(vehicleIdFromVin(seed, vinOf(seed, REGISTRY_POPULATION - 1))).toBe(REGISTRY_POPULATION - 1);
    expect(vehicleIdFromVin(seed, vinOf(seed, 7).toLowerCase())).toBe(7);
    for (const bad of ['', 'PT', 'PTI00000000000000', 'PTO00000000000000', 'PTQ00000000000000', '0'.repeat(18)]) {
      expect(vehicleIdFromVin(seed, bad)).toBeNull();
    }
    expect(() => vinOf(seed, REGISTRY_POPULATION)).toThrow(RangeError);
  });

  it('depends on the seed', () => {
    const other = seed + 1;
    expect(ownerOfVehicle(seed, 5)).not.toBe(ownerOfVehicle(other, 5));
    expect(dlNumberOf(seed, 5)).not.toBe(dlNumberOf(other, 5));
    expect(vinOf(seed, 5)).not.toBe(vinOf(other, 5));
    expect(vehicleIdFromVin(other, vinOf(seed, 5))).not.toBe(5);
  });
});
