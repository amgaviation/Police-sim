import { describe, expect, it } from 'vitest';
import { generateInterior } from '../../src/interior/generate';
import type { InteriorLayout, Rect } from '../../src/interior/types';
import { PLAYER_SIZE } from '../../src/game/session';
import { cityBuildings, handBuildings, indexFor, SEED } from './helpers';

function bfs(l: InteriorLayout, start: number, passable: (d: number) => boolean): Set<number> {
  const seen = new Set<number>([start]);
  const queue = [start];
  for (let q = 0; q < queue.length; q++) {
    for (const di of l.roomDoors[queue[q] as number] as readonly number[]) {
      const d = l.doors[di]!;
      if (!passable(di) || d.b < 0) continue;
      const next = d.a === queue[q] ? d.b : d.a;
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

describe('reachability', () => {
  const buildings = [...cityBuildings(indexFor(), 15), ...handBuildings()];

  it('reaches every room from the main door room, ignoring locks', () => {
    for (const b of buildings) {
      for (const seed of [SEED, 7]) {
        const l = generateInterior(seed, b)!;
        const main = l.doors.find((d) => d.main)!;
        expect(bfs(l, main.a, () => true).size).toBe(l.rooms.length);
      }
    }
  });

  it('keeps exactly the rooms behind locked doors out of reach until those doors pass', () => {
    let sawLocked = false;
    for (const b of buildings) {
      const l = generateInterior(SEED, b)!;
      const main = l.doors.find((d) => d.main)!;
      const free = bfs(l, main.a, (d) => !l.doors[d]!.lockedAtStart);
      // Independent computation: union-find over the unlocked interior doors.
      const parent = l.rooms.map((_, i) => i);
      const find = (x: number): number => (parent[x] === x ? x : (parent[x] = find(parent[x] as number)));
      for (const d of l.doors) if (!d.lockedAtStart && d.b >= 0) parent[find(d.a)] = find(d.b);
      const expectedBehind = l.rooms.map((_, i) => i).filter((i) => find(i) !== find(main.a));
      const behind = l.rooms.map((_, i) => i).filter((i) => !free.has(i));
      expect(behind).toEqual(expectedBehind);
      if (behind.length > 0) sawLocked = true;
      // Every cut-off room is behind a locked door and becomes reachable when locked doors pass.
      const all = bfs(l, main.a, () => true);
      for (const r of behind) expect(all.has(r)).toBe(true);
      if (behind.length > 0) expect(l.doors.some((d) => d.lockedAtStart)).toBe(true);
      // Passing the locked doors reaches everything again.
      expect(bfs(l, main.a, () => true).size).toBe(l.rooms.length);
    }
    expect(sawLocked).toBe(true);
  });
});

describe('walkable floor', () => {
  // The officer is a cylinder of PLAYER_SIZE.x / 2 plus the character controller skin (game/session.ts).
  const R = PLAYER_SIZE.x / 2 + 0.02 + 0.005;
  const STEP = 0.1;
  const dist = (r: Rect, x: number, z: number): number => Math.hypot(Math.max(r.minX - x, 0, x - r.maxX), Math.max(r.minZ - z, 0, z - r.maxZ));
  const all = [...cityBuildings(indexFor(), 8), ...handBuildings()];

  function nodesOf(l: InteriorLayout, ri: number): { x: number; z: number; what: string }[] {
    const room = l.rooms[ri]!.rect;
    const cx = (room.minX + room.maxX) / 2, cz = (room.minZ + room.maxZ) / 2;
    const out: { x: number; z: number; what: string }[] = [];
    for (const di of l.roomDoors[ri]!) {
      const d = l.doors[di]!;
      const sx = d.axis === 'z' ? (cx >= d.x ? 1 : -1) : 0, sz = d.axis === 'x' ? (cz >= d.z ? 1 : -1) : 0;
      out.push({ x: d.x + sx * 0.5, z: d.z + sz * 0.5, what: `door ${String(di)}` });
      if (d.b < 0) out.push({ x: d.x + sx, z: d.z + sz, what: `arrival ${String(di)}` });
    }
    for (const p of l.points) if (p.room === ri) out.push({ x: p.x, z: p.z, what: `point ${p.kind}` });
    return out;
  }

  it('keeps the arrival pose of every exterior door and every stand point off solid furniture', () => {
    let arrivals = 0, stands = 0;
    for (const b of all) {
      for (const seed of [SEED, 7]) {
        const l = generateInterior(seed, b)!;
        const solids = l.furniture.filter((f) => f.solid);
        const clear = (x: number, z: number): boolean => solids.every((f) => dist(f, x, z) >= R);
        expect(clear(l.entry.x, l.entry.z)).toBe(true);
        for (const d of l.doors) {
          if (d.b >= 0) continue;
          const room = l.rooms[d.a]!.rect;
          const sx = d.axis === 'z' ? ((room.minX + room.maxX) / 2 >= d.x ? 1 : -1) : 0, sz = d.axis === 'x' ? ((room.minZ + room.maxZ) / 2 >= d.z ? 1 : -1) : 0;
          expect(clear(d.x + sx, d.z + sz)).toBe(true);
          arrivals++;
        }
        for (const p of l.points) {
          const room = l.rooms[p.room]!.rect;
          expect(clear(p.x, p.z)).toBe(true);
          expect(p.x).toBeGreaterThanOrEqual(room.minX + 0.5 - 1e-6);
          expect(p.x).toBeLessThanOrEqual(room.maxX - 0.5 + 1e-6);
          expect(p.z).toBeGreaterThanOrEqual(room.minZ + 0.5 - 1e-6);
          expect(p.z).toBeLessThanOrEqual(room.maxZ - 0.5 + 1e-6);
          stands++;
        }
      }
    }
    expect(arrivals).toBeGreaterThan(300);
    expect(stands).toBeGreaterThan(50);
  });

  it('lets the officer walk between the doors, the arrival poses and the stand points of every room', () => {
    let rooms = 0;
    for (const b of all) {
      for (const seed of [SEED, 99]) {
        const l = generateInterior(seed, b)!;
        l.rooms.forEach((room, ri) => {
          const nodes = nodesOf(l, ri);
          if (nodes.length < 2) return;
          rooms++;
          const r = room.rect;
          const x0 = r.minX + 0.5, z0 = r.minZ + 0.5;
          const nx = Math.floor((r.maxX - r.minX - 1) / STEP + 1e-6) + 1, nz = Math.floor((r.maxZ - r.minZ - 1) / STEP + 1e-6) + 1;
          const solids = l.furniture.filter((f) => f.solid && f.room === ri);
          const free = (ix: number, iz: number): boolean => solids.every((f) => dist(f, x0 + ix * STEP, z0 + iz * STEP) >= R);
          const cell = (n: { x: number; z: number }): [number, number] => [
            Math.min(nx - 1, Math.max(0, Math.round((n.x - x0) / STEP))), Math.min(nz - 1, Math.max(0, Math.round((n.z - z0) / STEP))),
          ];
          const [sx, sz] = cell(nodes[0]!);
          const seen = new Uint8Array(nx * nz);
          seen[sz * nx + sx] = 1;
          const queue: number[] = [sz * nx + sx];
          for (let q = 0; q < queue.length; q++) {
            const c = queue[q]!;
            const ix = c % nx, iz = (c - ix) / nx;
            for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
              const jx = ix + ax, jz = iz + az;
              if (jx < 0 || jz < 0 || jx >= nx || jz >= nz || seen[jz * nx + jx] === 1 || !free(jx, jz)) continue;
              seen[jz * nx + jx] = 1;
              queue.push(jz * nx + jx);
            }
          }
          for (const n of nodes) {
            const [ix, iz] = cell(n);
            expect(seen[iz * nx + ix] === 1, `${b.kind} ${String(b.id)} seed ${String(seed)} room ${String(ri)} ${room.kind}: ${n.what} unreachable`).toBe(true);
          }
        });
      }
    }
    expect(rooms).toBeGreaterThan(1000);
  }, 120_000);
});
