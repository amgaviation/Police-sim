import { describe, expect, it } from 'vitest';
import { generateInterior } from '../../src/interior/generate';
import type { InteriorLayout } from '../../src/interior/types';
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
