import { describe, expect, it } from 'vitest';
import { FLEET_DATA, fleetYard, type YardLayout } from '../../src/fleet';
import { driverDoorPoint } from '../../src/player/mode';
import { BLOCK_KIND, type Block, type City } from '../../src/world/city';
import { LANDMARKS } from '../../src/world/data';
import { generateCity } from '../../src/world/generate';
import { stationLayout } from '../../src/world/stationLayout';

const SEEDS = [1, 2, 3, 42];
const cities = new Map<number, { city: City; yard: YardLayout; block: Block }>();

function setup(seed: number): { city: City; yard: YardLayout; block: Block } {
  let s = cities.get(seed);
  if (s === undefined) {
    const city = generateCity(seed);
    const block = city.blocks.find(
      (b) => b.kind === BLOCK_KIND.parking && city.spawn.x >= b.minX && city.spawn.x <= b.maxX && city.spawn.z >= b.minZ && city.spawn.z <= b.maxZ,
    ) as Block;
    s = { city, yard: fleetYard(city), block };
    cities.set(seed, s);
  }
  return s;
}

function rectDistance(r: readonly [number, number, number, number], x: number, z: number): number {
  return Math.hypot(Math.max(r[0] - x, 0, x - r[2]), Math.max(r[1] - z, 0, z - r[3]));
}

describe.each(SEEDS)('fleetYard (seed %i)', (seed) => {
  it('has at least 10 slots, the six originals first', () => {
    const { city, yard } = setup(seed);
    expect(yard.slots.length).toBeGreaterThanOrEqual(10);
    for (let i = 0; i < 6; i++) expect(yard.slots[i]).toEqual(city.parking[i]);
  });

  it('spaces the slots at least 3.4 m apart', () => {
    const { yard } = setup(seed);
    for (let i = 0; i < yard.slots.length; i++) {
      for (let j = i + 1; j < yard.slots.length; j++) {
        const a = yard.slots[i]!;
        const b = yard.slots[j]!;
        expect(Math.hypot(a.x - b.x, a.z - b.z), `${i}-${j}`).toBeGreaterThanOrEqual(3.4);
      }
    }
  });

  it('keeps the slots inside the block, clear of the building and the pump', () => {
    const { yard, block } = setup(seed);
    const layout = stationLayout(block, LANDMARKS.station.yaw);
    expect(yard.service).toEqual({ x: layout.pump.x, z: layout.pump.z });
    yard.slots.forEach((s, i) => {
      expect(s.x).toBeGreaterThan(block.minX);
      expect(s.x).toBeLessThan(block.maxX);
      expect(s.z).toBeGreaterThan(block.minZ);
      expect(s.z).toBeLessThan(block.maxZ);
      expect(rectDistance(layout.building, s.x, s.z), `slot ${i} building`).toBeGreaterThan(0);
      if (i >= 6) {
        expect(rectDistance(layout.building, s.x, s.z), `slot ${i} building`).toBeGreaterThanOrEqual(2);
        expect(Math.hypot(s.x - layout.pump.x, s.z - layout.pump.z), `slot ${i} pump`).toBeGreaterThanOrEqual(5);
        expect(s.x).toBeGreaterThanOrEqual(block.minX + 2.5);
        expect(s.x).toBeLessThanOrEqual(block.maxX - 2.5);
        expect(s.z).toBeGreaterThanOrEqual(block.minZ + 2.5);
        expect(s.z).toBeLessThanOrEqual(block.maxZ - 2.5);
      }
      expect(s.yaw).toBe(layout.slots[0]?.yaw);
    });
  });

  it('the garage is the configured slot', () => {
    const { yard } = setup(seed);
    expect(yard.garage).toBe(yard.slots[FLEET_DATA.garageSlot]);
  });

  it('the helipad is null or at least 10 m from every slot, inside the block, away from the building', () => {
    const { yard, block } = setup(seed);
    if (yard.helipad === null) return;
    const h = yard.helipad;
    for (const s of yard.slots) expect(Math.hypot(h.x - s.x, h.z - s.z)).toBeGreaterThanOrEqual(10);
    expect(h.x).toBeGreaterThan(block.minX);
    expect(h.x).toBeLessThan(block.maxX);
    expect(h.z).toBeGreaterThan(block.minZ);
    expect(h.z).toBeLessThan(block.maxZ);
    const layout = stationLayout(block, LANDMARKS.station.yaw);
    expect(rectDistance(layout.building, h.x, h.z)).toBeGreaterThanOrEqual(12);
    expect(Math.hypot(h.x - layout.pump.x, h.z - layout.pump.z)).toBeGreaterThanOrEqual(12);
  });

  it('the boat slip is in a water block with the driver door at the quay', () => {
    const { city, yard } = setup(seed);
    const slip = yard.boatSlip;
    expect(slip).not.toBeNull();
    if (slip === null) return;
    const water = city.blocks.find(
      (b) => b.kind === BLOCK_KIND.water && slip.x > b.minX && slip.x < b.maxX && slip.z > b.minZ && slip.z < b.maxZ,
    );
    expect(water).toBeDefined();
    if (water === undefined) return;
    const door = driverDoorPoint({ eid: 0, x: slip.x, z: slip.z, yaw: slip.yaw, halfWidth: 1.3, halfLength: 4, speed: 0 }, { x: 0, z: 0 });
    const toEdge = Math.min(Math.abs(door.x - water.minX), Math.abs(door.x - water.maxX), Math.abs(door.z - water.minZ), Math.abs(door.z - water.maxZ));
    expect(toEdge).toBeLessThanOrEqual(1.2);
    // The door is still on the water side of the quay, and the boat itself sits 2 m inside.
    expect(door.x).toBeGreaterThanOrEqual(water.minX - 0.01);
    expect(door.x).toBeLessThanOrEqual(water.maxX + 0.01);
    expect(door.z).toBeGreaterThanOrEqual(water.minZ - 0.01);
    expect(door.z).toBeLessThanOrEqual(water.maxZ + 0.01);
    const edge = Math.min(slip.x - water.minX, water.maxX - slip.x, slip.z - water.minZ, water.maxZ - slip.z);
    expect(edge).toBeCloseTo(2, 6);
  });

  it('is deterministic', () => {
    const { city, yard } = setup(seed);
    expect(fleetYard(city)).toEqual(yard);
  });
});

describe('fleetYard errors', () => {
  it('throws when the city has no station lot block', () => {
    const city = generateCity(1);
    const broken = { ...city, spawn: { x: 1e6, z: 1e6, yaw: 0 }, blocks: city.blocks } as City;
    expect(() => fleetYard(broken)).toThrow(/station/);
  });

  it('has no boat slip without a harbor POI or water block', () => {
    const city = generateCity(1);
    const noHarbor = { ...city, pois: city.pois.filter((p) => p.kind !== 'harbor') } as City;
    expect(fleetYard(noHarbor).boatSlip).toBeNull();
    const noWater = { ...city, blocks: city.blocks.filter((b) => b.kind !== BLOCK_KIND.water) } as City;
    expect(fleetYard(noWater).boatSlip).toBeNull();
  });
});
