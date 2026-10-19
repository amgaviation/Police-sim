import { describe, expect, it } from 'vitest';
import { generateInterior } from '../../src/interior/generate';
import { INTERIOR_FLOOR_Y } from '../../src/interior/constants';
import { BuildingIndex, BUILDING_KINDS } from '../../src/world/buildings';
import { generateCity } from '../../src/world/generate';
import { cityBuildings, handBuilding, handBuildings, indexFor, SEED } from './helpers';

describe('generateInterior', () => {
  const index = indexFor();
  const city = cityBuildings(index, 12);
  const hand = handBuildings();

  it('finds buildings of most kinds in the city', () => {
    const kinds = new Set(city.map((b) => b.kind));
    for (const k of ['house', 'apartment', 'office', 'warehouse', 'convenienceStore', 'policeStation', 'jail']) expect(kinds.has(k as never)).toBe(true);
  });

  it('is deterministic per building id and seed, also from a fresh city and index', () => {
    const fresh = new BuildingIndex(generateCity(SEED));
    for (const b of city) {
      const a = generateInterior(SEED, b);
      const again = generateInterior(SEED, b);
      const other = fresh.building(b.id);
      expect(a).not.toBeNull();
      expect(again).toEqual(a);
      expect(other).not.toBeNull();
      expect(generateInterior(SEED, other!)).toEqual(a);
    }
    for (const b of hand) expect(generateInterior(5, b)).toEqual(generateInterior(5, b));
  });

  it('returns a complete layout with the building facts', () => {
    for (const b of [...city, ...hand]) {
      const l = generateInterior(SEED, b)!;
      expect(l.buildingId).toBe(b.id);
      expect(l.kind).toBe(b.kind);
      expect(l.floorY).toBe(INTERIOR_FLOOR_Y);
      expect(l.rooms.length).toBeGreaterThanOrEqual(1);
      expect(l.roomDoors.length).toBe(l.rooms.length);
      expect(l.walls.length % 4).toBe(0);
      expect(l.rect.minX).toBeGreaterThanOrEqual(b.minX - 1e-6);
      expect(l.rect.maxX).toBeLessThanOrEqual(b.maxX + 1e-6);
      expect(l.rect.minZ).toBeGreaterThanOrEqual(b.minZ - 1e-6);
      expect(l.rect.maxZ).toBeLessThanOrEqual(b.maxZ + 1e-6);
      l.rooms.forEach((r, i) => expect(r.index).toBe(i));
      l.doors.forEach((d, i) => expect(d.index).toBe(i));
    }
  });

  it('returns null for a building without a kind and for one below the template minimum', () => {
    expect(generateInterior(SEED, { ...handBuilding('house', 10, 10), kind: null })).toBeNull();
    expect(generateInterior(SEED, handBuilding('house', 5, 5))).toBeNull();
    expect(generateInterior(SEED, handBuilding('policeStation', 30, 28))).toBeNull();
  });

  it('rounds coordinates to 0.05 m', () => {
    const l = generateInterior(SEED, handBuilding('office', 30, 20))!;
    const onGrid = (v: number): boolean => Math.abs(v * 20 - Math.round(v * 20)) < 1e-6;
    for (const r of l.rooms) for (const v of [r.rect.minX, r.rect.minZ, r.rect.maxX, r.rect.maxZ]) expect(onGrid(v)).toBe(true);
    for (const d of l.doors) { expect(onGrid(d.x)).toBe(true); expect(onGrid(d.z)).toBe(true); }
  });

  it('changes at least one room rectangle for a different building id or seed in >= 90 % of samples', () => {
    const samples = [...city, ...hand.filter((_, i) => i % 3 === 1)];
    let seedDiff = 0, idDiff = 0;
    const sig = (l: NonNullable<ReturnType<typeof generateInterior>>): string => JSON.stringify(l.rooms.map((r) => [r.kind, r.rect]));
    for (const b of samples) {
      const base = sig(generateInterior(SEED, b)!);
      if (sig(generateInterior(SEED + 1, b)!) !== base) seedDiff++;
      if (sig(generateInterior(SEED, { ...b, id: b.id + 1 })!) !== base) idDiff++;
    }
    expect(seedDiff / samples.length).toBeGreaterThanOrEqual(0.9);
    expect(idDiff / samples.length).toBeGreaterThanOrEqual(0.9);
  });

  it('generates every kind from the city or the hand-made samples', () => {
    for (const kind of BUILDING_KINDS) {
      expect(hand.some((b) => b.kind === kind)).toBe(true);
    }
  });
});
