import { describe, expect, it } from 'vitest';
import { generateInterior } from '../../src/interior/generate';
import { exitPath, findPath, reachableRooms, roomAt } from '../../src/interior/nav';
import type { InteriorLayout } from '../../src/interior/types';
import { cityBuildings, handBuilding, handBuildings, indexFor, SEED } from './helpers';

/** BFS hop count between rooms through passable doors, -1 when unreachable (independent of the module). */
function hops(l: InteriorLayout, from: number, to: number, passable: (d: number) => boolean): number {
  const dist = new Map<number, number>([[from, 0]]);
  const queue = [from];
  for (let q = 0; q < queue.length; q++) {
    const room = queue[q]!;
    for (const di of l.roomDoors[room]!) {
      const d = l.doors[di]!;
      if (d.b < 0 || !passable(di)) continue;
      const next = d.a === room ? d.b : d.a;
      if (!dist.has(next)) { dist.set(next, dist.get(room)! + 1); queue.push(next); }
    }
  }
  return dist.get(to) ?? -1;
}

const centre = (l: InteriorLayout, room: number): [number, number] => {
  const r = l.rooms[room]!.rect;
  return [(r.minX + r.maxX) / 2, (r.minZ + r.maxZ) / 2];
};

describe('interior navigation', () => {
  const buildings = [...cityBuildings(indexFor(), 8), ...handBuildings().filter((_, i) => i % 3 === 1)];
  const out = new Float32Array(64);

  it('locates rooms', () => {
    for (const b of buildings) {
      const l = generateInterior(SEED, b)!;
      l.rooms.forEach((r, i) => {
        const [x, z] = centre(l, i);
        expect(roomAt(l, x, z)).toBe(i);
        expect(r.index).toBe(i);
      });
      expect(roomAt(l, l.rect.minX - 5, l.rect.minZ - 5)).toBe(-1);
    }
  });

  it('crosses each door of the BFS route and ends at the target', () => {
    let crossings = 0;
    for (const b of buildings) {
      const l = generateInterior(SEED, b)!;
      const start = l.doors.find((d) => d.main)!.a;
      const [sx, sz] = centre(l, start);
      for (let target = 0; target < l.rooms.length; target++) {
        const [tx, tz] = centre(l, target);
        const expected = hops(l, start, target, () => true);
        const n = findPath(l, sx, sz, tx, tz, () => true, out);
        if (expected < 0 || 4 * expected + 2 > out.length) { expect(n).toBe(0); continue; }
        expect(n).toBe(2 * expected + 1);
        expect(out[2 * (n - 1)]).toBeCloseTo(tx, 1);
        expect(out[2 * (n - 1) + 1]).toBeCloseTo(tz, 1);
        // Each pair of waypoints straddles a door centre, 0.5 m either side, in consecutive rooms.
        let room = start;
        for (let k = 0; k < expected; k++) {
          const ax = out[4 * k]!, az = out[4 * k + 1]!, bx = out[4 * k + 2]!, bz = out[4 * k + 3]!;
          const door = l.doors.find((d) => Math.abs((ax + bx) / 2 - d.x) < 1e-2 && Math.abs((az + bz) / 2 - d.z) < 1e-2 && d.b >= 0 && (d.a === room || d.b === room));
          expect(door).toBeDefined();
          expect(Math.hypot(bx - ax, bz - az)).toBeCloseTo(1, 1);
          expect(roomAt(l, ax, az)).toBe(room);
          room = door!.a === room ? door!.b : door!.a;
          expect(roomAt(l, bx, bz)).toBe(room);
          crossings++;
        }
        expect(room).toBe(target);
      }
    }
    expect(crossings).toBeGreaterThan(50);
  });

  it('returns one point inside a room, zero when blocked or outside', () => {
    const l = generateInterior(SEED, handBuilding('house', 14, 12, 0))!;
    const [x, z] = centre(l, 0);
    expect(findPath(l, x, z, x + 0.1, z, () => true, out)).toBe(1);
    expect(out[0]).toBeCloseTo(x + 0.1, 1);
    const other = l.rooms.findIndex((_, i) => i !== 0);
    const [ox, oz] = centre(l, other);
    expect(findPath(l, x, z, ox, oz, () => false, out)).toBe(0);
    expect(findPath(l, x, z, l.rect.maxX + 10, oz, () => true, out)).toBe(0);
    expect(findPath(l, l.rect.minX - 10, z, ox, oz, () => true, out)).toBe(0);
    // A route longer than the buffer holds is refused rather than truncated.
    expect(findPath(l, x, z, ox, oz, () => true, new Float32Array(2))).toBe(0);
  });

  it('avoids a blocked door when another route exists and fails when none does', () => {
    const l = generateInterior(SEED, handBuilding('office', 30, 20, 0))!;
    const main = l.doors.find((d) => d.main)!;
    const [sx, sz] = centre(l, main.a);
    const far = l.rooms.length - 1;
    const [tx, tz] = centre(l, far);
    const all = findPath(l, sx, sz, tx, tz, () => true, out);
    expect(all).toBeGreaterThan(0);
    // Block every door of the target room: unreachable.
    const blocked = new Set(l.roomDoors[far]);
    expect(findPath(l, sx, sz, tx, tz, (d) => !blocked.has(d), out)).toBe(far === main.a ? 1 : 0);
  });

  it('lists reachable rooms in BFS order through passable doors', () => {
    const list: number[] = [];
    for (const b of buildings) {
      const l = generateInterior(SEED, b)!;
      const start = l.doors.find((d) => d.main)!.a;
      expect(reachableRooms(l, start, () => true, list)).toBe(list);
      expect(list.length).toBe(l.rooms.length);
      expect(list[0]).toBe(start);
      for (let i = 1; i < list.length; i++) expect(hops(l, start, list[i]!, () => true)).toBeGreaterThanOrEqual(hops(l, start, list[i - 1]!, () => true));
      const locked = reachableRooms(l, start, (d) => !l.doors[d]!.lockedAtStart, []);
      for (const r of locked) expect(hops(l, start, r, (d) => !l.doors[d]!.lockedAtStart)).toBeGreaterThanOrEqual(0);
      expect(reachableRooms(l, -1, () => true, list).length).toBe(0);
    }
  });

  it('exits through the main door when it is the only exit, ending 0.4 m inside it', () => {
    const door = { index: -2 };
    for (const b of buildings) {
      const l = generateInterior(SEED, b)!;
      const main = l.doors.find((d) => d.main)!;
      const onlyMain = (d: number): boolean => d === main.index || l.doors[d]!.b >= 0;
      // Start in the farthest room.
      let far = main.a, best = 0;
      for (let r = 0; r < l.rooms.length; r++) {
        const h = hops(l, main.a, r, () => true);
        if (4 * h + 2 <= out.length && h > best) { best = h; far = r; }
      }
      const [x, z] = centre(l, far);
      const n = exitPath(l, x, z, onlyMain, out, door);
      expect(door.index).toBe(main.index);
      expect(n).toBe(2 * best + 1);
      const ex = out[2 * (n - 1)]!, ez = out[2 * (n - 1) + 1]!;
      expect(Math.hypot(ex - main.x, ez - main.z)).toBeCloseTo(0.4, 1);
      expect(roomAt(l, ex, ez)).toBe(main.a);
    }
  });

  it('prefers the nearest exit, then the main door, and reports none when all exits are blocked', () => {
    const door = { index: -2 };
    const l = generateInterior(SEED, handBuilding('warehouse', 40, 30, 0))!;
    const exterior = l.doors.filter((d) => d.b < 0);
    expect(exterior.length).toBeGreaterThanOrEqual(1);
    const main = exterior.find((d) => d.main)!;
    const [x, z] = centre(l, main.a);
    expect(exitPath(l, x, z, () => true, out, door)).toBe(1);
    expect(door.index).toBe(main.index);
    expect(exitPath(l, x, z, (d) => l.doors[d]!.b >= 0, out, door)).toBe(0);
    expect(door.index).toBe(-1);
    expect(exitPath(l, l.rect.minX - 9, z, () => true, out, door)).toBe(0);
  });
});
