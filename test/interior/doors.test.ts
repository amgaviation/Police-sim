import { describe, expect, it } from 'vitest';
import { generateInterior } from '../../src/interior/generate';
import { DOOR_WIDTH } from '../../src/interior/constants';
import type { InteriorDoor, InteriorLayout } from '../../src/interior/types';
import type { BuildingInfo } from '../../src/world/buildings';
import { cityBuildings, handBuildings, indexFor, SEED } from './helpers';

const TOL = 1e-3;

function covers(l: InteriorLayout, x: number, z: number): boolean {
  const w = l.walls;
  for (let i = 0; i < w.length; i += 4) {
    const x0 = w[i]!, z0 = w[i + 1]!, x1 = w[i + 2]!, z1 = w[i + 3]!;
    if (x0 === x1 && Math.abs(x - x0) < TOL && z >= Math.min(z0, z1) - TOL && z <= Math.max(z0, z1) + TOL) return true;
    if (z0 === z1 && Math.abs(z - z0) < TOL && x >= Math.min(x0, x1) - TOL && x <= Math.max(x0, x1) + TOL) return true;
  }
  return false;
}

function inOpening(d: InteriorDoor, x: number, z: number, slack: number): boolean {
  const half = d.width / 2 + slack;
  return d.axis === 'x' ? Math.abs(z - d.z) < TOL && Math.abs(x - d.x) < half : Math.abs(x - d.x) < TOL && Math.abs(z - d.z) < half;
}

describe('doors and locks', () => {
  const buildings: BuildingInfo[] = [...cityBuildings(indexFor(), 15), ...handBuildings()];

  it('has exactly one main door, distinct rooms and consistent exterior flags', () => {
    for (const b of buildings) {
      const l = generateInterior(SEED, b)!;
      expect(l.doors.filter((d) => d.main).length).toBe(1);
      for (const d of l.doors) {
        expect(d.a).not.toBe(d.b);
        expect(d.a).toBeGreaterThanOrEqual(0);
        expect(d.a).toBeLessThan(l.rooms.length);
        expect(d.b).toBeLessThan(l.rooms.length);
        expect(d.b >= -1).toBe(true);
        expect(d.b === -1).toBe(d.exit !== null);
        expect(d.kind === 'exterior' || d.kind === 'wide').toBe(d.b === -1);
        if (d.main) expect(d.b).toBe(-1);
        if (d.lockedAtStart) expect(d.lockable).toBe(true);
        if (d.kind === 'wide') { expect(d.lockable).toBe(false); expect(d.width).toBeGreaterThanOrEqual(2); }
        if (d.exit) {
          const inside = d.exit.x > b.minX && d.exit.x < b.maxX && d.exit.z > b.minZ && d.exit.z < b.maxZ;
          expect(inside).toBe(false);
        }
        if (d.b >= 0 && d.lockable) expect([d.a, d.b]).toContain(d.lockSide);
        else expect(d.lockSide).toBe(-1);
        expect(d.strength).toBeGreaterThanOrEqual(0);
        expect(d.strength).toBeLessThanOrEqual(1);
      }
      expect(l.roomDoors.flat().length).toBe(l.doors.reduce((n, d) => n + (d.b >= 0 ? 2 : 1), 0));
    }
  });

  it('puts every door on the shared boundary of its rooms with a 0.2 m margin', () => {
    for (const b of buildings) {
      const l = generateInterior(SEED, b)!;
      for (const d of l.doors) {
        const half = d.width / 2;
        const ra = l.rooms[d.a]!.rect;
        const rb = d.b >= 0 ? l.rooms[d.b]!.rect : null;
        // Position along the wall and range available on both sides.
        const along = d.axis === 'x' ? d.x : d.z;
        const lo = d.axis === 'x' ? Math.max(ra.minX, rb?.minX ?? -Infinity) : Math.max(ra.minZ, rb?.minZ ?? -Infinity);
        const hi = d.axis === 'x' ? Math.min(ra.maxX, rb?.maxX ?? Infinity) : Math.min(ra.maxZ, rb?.maxZ ?? Infinity);
        expect(along - half).toBeGreaterThanOrEqual(lo + 0.2 - TOL);
        expect(along + half).toBeLessThanOrEqual(hi - 0.2 + TOL);
        // Line coordinate: on an edge of room a, and the opposite edge of room b (or the extent edge outside).
        const line = d.axis === 'x' ? d.z : d.x;
        const aEdges = d.axis === 'x' ? [ra.minZ, ra.maxZ] : [ra.minX, ra.maxX];
        expect(aEdges.some((e) => Math.abs(e - line) < TOL)).toBe(true);
        if (rb) {
          const bEdges = d.axis === 'x' ? [rb.minZ, rb.maxZ] : [rb.minX, rb.maxX];
          expect(bEdges.some((e) => Math.abs(e - line) < TOL)).toBe(true);
          // The rooms sit on opposite sides of the line.
          const ac = d.axis === 'x' ? (ra.minZ + ra.maxZ) / 2 : (ra.minX + ra.maxX) / 2;
          const bc = d.axis === 'x' ? (rb.minZ + rb.maxZ) / 2 : (rb.minX + rb.maxX) / 2;
          expect(Math.sign(ac - line)).toBe(-Math.sign(bc - line));
        } else {
          const ext = l.rect;
          const edges = d.axis === 'x' ? [ext.minZ, ext.maxZ] : [ext.minX, ext.maxX];
          expect(edges.some((e) => Math.abs(e - line) < TOL)).toBe(true);
        }
      }
    }
  });

  it('lets lockable interior doors have a thumb-turn room and uses the main door width', () => {
    for (const b of buildings) {
      const l = generateInterior(SEED, b)!;
      const main = l.doors.find((d) => d.main)!;
      expect(main.width).toBeGreaterThanOrEqual(DOOR_WIDTH);
      if (b.kind === 'parkingStructure') {
        expect(main.kind).toBe('wide');
        expect(main.lockedAtStart).toBe(false);
      }
      if (b.kind === 'house') expect(main.lockedAtStart).toBe(true);
    }
  });

  it('never lets wall segments cover an opening and covers every other room edge point', () => {
    for (const b of buildings) {
      const l = generateInterior(SEED, b)!;
      for (const d of l.doors) {
        for (const t of [-0.4, -0.2, 0, 0.2, 0.4]) {
          const x = d.axis === 'x' ? d.x + t * d.width : d.x;
          const z = d.axis === 'x' ? d.z : d.z + t * d.width;
          expect(covers(l, x, z)).toBe(false);
        }
      }
      for (const room of l.rooms) {
        const r = room.rect;
        const check = (x: number, z: number): void => {
          if (l.doors.some((d) => inOpening(d, x, z, TOL))) return;
          expect(covers(l, x, z)).toBe(true);
        };
        for (let x = r.minX; x <= r.maxX + 1e-9; x += 0.25) { check(x, r.minZ); check(x, r.maxZ); }
        for (let z = r.minZ; z <= r.maxZ + 1e-9; z += 0.25) { check(r.minX, z); check(r.maxX, z); }
        check(r.maxX, r.maxZ);
        check(r.minX, r.minZ);
      }
    }
  });
});
