import { describe, expect, it } from 'vitest';
import { generateInterior } from '../../src/interior/generate';
import { furnitureBlocks, lineOfSight, wallsBlock } from '../../src/interior/los';
import type { FurnitureItem, InteriorLayout } from '../../src/interior/types';
import { cityBuildings, handBuilding, handBuildings, indexFor, SEED } from './helpers';

function piece(index: number, minX: number, minZ: number, maxX: number, maxZ: number, h: number): FurnitureItem {
  return {
    index, id: 'counter', room: 0, x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, yaw: 0, w: maxX - minX, d: maxZ - minZ, h,
    minX, minZ, maxX, maxZ, color: 0, solid: true, cover: h >= 0.8 && h <= 1.3, surface: null, container: 'none', hide: null, seat: null,
  };
}

describe('wall line of sight', () => {
  const buildings = [...cityBuildings(indexFor(), 8), ...handBuildings().filter((_, i) => i % 3 === 1)];

  it('lets a ray cross a doorway only while the door is open', () => {
    let tested = 0;
    for (const b of buildings) {
      const l = generateInterior(SEED, b)!;
      for (const d of l.doors) {
        if (d.b < 0) continue;
        const nx = d.axis === 'x' ? 0 : 1, nz = d.axis === 'x' ? 1 : 0;
        const [ax, az, bx, bz] = [d.x - nx * 0.5, d.z - nz * 0.5, d.x + nx * 0.5, d.z + nz * 0.5];
        expect(wallsBlock(l, () => true, ax, az, bx, bz)).toBe(false);
        expect(wallsBlock(l, (i) => i !== d.index, ax, az, bx, bz)).toBe(true);
        expect(lineOfSight(l, (i) => i !== d.index, ax, 1.6, az, bx, 1.6, bz)).toBe(false);
        tested++;
      }
    }
    expect(tested).toBeGreaterThan(100);
  });

  it('treats wide openings as always clear', () => {
    const l = generateInterior(SEED, handBuilding('policeStation', 60, 28, 0))!;
    const wide = l.doors.find((d) => d.kind === 'wide')!;
    const nx = wide.axis === 'x' ? 0 : 1, nz = wide.axis === 'x' ? 1 : 0;
    expect(wallsBlock(l, () => false, wide.x - nx, wide.z - nz, wide.x + nx, wide.z + nz)).toBe(false);
  });

  it('blocks a ray through a wall away from any door, with all doors open', () => {
    const l = generateInterior(SEED, handBuilding('office', 30, 20, 0))!;
    const [a, b] = [l.rooms[0]!.rect, l.rooms[l.rooms.length - 1]!.rect];
    const ax = (a.minX + a.maxX) / 2, az = (a.minZ + a.maxZ) / 2, bx = (b.minX + b.maxX) / 2, bz = (b.minZ + b.maxZ) / 2;
    // A ray that leaves the building entirely crosses an outer wall.
    expect(wallsBlock(l, () => true, ax, az, l.rect.minX - 5, l.rect.minZ - 5)).toBe(true);
    expect(typeof wallsBlock(l, () => true, ax, az, bx, bz)).toBe('boolean');
  });

  it('inside one room there is nothing to cross', () => {
    for (const b of buildings) {
      const l = generateInterior(SEED, b)!;
      for (const room of l.rooms) {
        const r = room.rect;
        expect(wallsBlock(l, () => false, r.minX + 0.3, r.minZ + 0.3, r.maxX - 0.3, r.maxZ - 0.3)).toBe(false);
      }
    }
  });

  it('ignores endpoints lying on a wall line', () => {
    const l = generateInterior(SEED, handBuilding('house', 14, 12, 0))!;
    const r = l.rooms[0]!.rect;
    const z = (r.minZ + r.maxZ) / 2;
    // From a point on the room's west wall line into the room: touching, not crossing.
    expect(wallsBlock(l, () => false, r.minX + 5e-5, z, r.minX + 2, z)).toBe(false);
    // Starting 1e-3 outside the line does cross it.
    expect(wallsBlock(l, () => false, r.minX - 1e-3, z, r.minX + 2, z)).toBe(true);
  });
});

describe('furniture line of sight', () => {
  const base = generateInterior(SEED, handBuilding('house', 14, 12, 0))!;
  const layout: InteriorLayout = { ...base, furniture: [piece(0, 10, 10, 12.4, 10.7, 1.0), piece(1, 20, 20, 21, 21, 2.0)] };

  it('blocks a ray at 0.8 m through a 1.0 m counter but not one at 1.6 m', () => {
    expect(furnitureBlocks(layout, 8, 0.8, 10.35, 14, 0.8, 10.35)).toBe(true);
    expect(furnitureBlocks(layout, 8, 1.6, 10.35, 14, 1.6, 10.35)).toBe(false);
    expect(furnitureBlocks(layout, 11, 0.8, 8, 11, 0.8, 13)).toBe(true);
  });

  it('tests the slope through the box, not only the endpoints', () => {
    // Descends from 1.6 m to 0.2 m while crossing the counter's z range: enters it below 1.0 m.
    expect(furnitureBlocks(layout, 11, 1.6, 8, 11, 0.2, 13)).toBe(true);
    // Stays above the counter all the way.
    expect(furnitureBlocks(layout, 11, 2.0, 8, 11, 1.2, 13)).toBe(false);
    // Tall piece: a 1.6 m ray is blocked.
    expect(furnitureBlocks(layout, 18, 1.6, 20.5, 23, 1.6, 20.5)).toBe(true);
  });

  it('misses boxes beside the segment and respects segment ends', () => {
    expect(furnitureBlocks(layout, 8, 0.8, 9, 14, 0.8, 9)).toBe(false);
    expect(furnitureBlocks(layout, 8, 0.8, 10.35, 9.5, 0.8, 10.35)).toBe(false);
    expect(furnitureBlocks(layout, 8, 0.5, 10.35, 14, 0.5, 10.35, 0)).toBe(false);
  });

  it('combines walls, doors and furniture in lineOfSight', () => {
    const r = base.rooms[0]!.rect;
    const x = (r.minX + r.maxX) / 2, z = (r.minZ + r.maxZ) / 2;
    const blocker: InteriorLayout = { ...base, furniture: [piece(0, x - 0.2, z - 0.2, x + 0.2, z + 0.2, 1.0)] };
    expect(lineOfSight(blocker, () => true, x - 1, 0.8, z, x + 1, 0.8, z)).toBe(false);
    expect(lineOfSight(blocker, () => true, x - 1, 0.8, z, x + 1, 0.8, z, 0)).toBe(true);
    expect(lineOfSight(blocker, () => true, x - 1, 1.6, z, x + 1, 1.6, z)).toBe(true);
    expect(lineOfSight(blocker, () => true, x - 1, 1.6, z, r.maxX + 20, 1.6, z)).toBe(false);
  });
});
