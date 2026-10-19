import { describe, expect, it } from 'vitest';
import { generateInterior } from '../../src/interior/generate';
import type { InteriorLayout, Rect } from '../../src/interior/types';
import { cityBuildings, handBuildings, indexFor, SEED } from './helpers';

const inside = (r: Rect, x: number, z: number, inset = 0): boolean =>
  x >= r.minX + inset - 1e-6 && x <= r.maxX - inset + 1e-6 && z >= r.minZ + inset - 1e-6 && z <= r.maxZ - inset + 1e-6;

function clearanceBoxes(l: InteriorLayout): Rect[] {
  return l.doors.map((d) => d.axis === 'x'
    ? { minX: d.x - d.width / 2 - 0.3, maxX: d.x + d.width / 2 + 0.3, minZ: d.z - 1, maxZ: d.z + 1 }
    : { minX: d.x - 1, maxX: d.x + 1, minZ: d.z - d.width / 2 - 0.3, maxZ: d.z + d.width / 2 + 0.3 });
}

describe('interior geometry', () => {
  const buildings = [...cityBuildings(indexFor(), 15), ...handBuildings()];
  const layouts = [SEED, 11].flatMap((seed) => buildings.map((b) => generateInterior(seed, b)!));

  it('keeps furniture inside its room, apart from other pieces and out of door clearance', () => {
    let pieces = 0;
    for (const l of layouts) {
      const boxes = clearanceBoxes(l);
      l.furniture.forEach((p, i) => {
        pieces++;
        expect(p.index).toBe(i);
        const room = l.rooms[p.room]!.rect;
        expect(p.minX).toBeGreaterThanOrEqual(room.minX + 0.05 - 1e-6);
        expect(p.maxX).toBeLessThanOrEqual(room.maxX - 0.05 + 1e-6);
        expect(p.minZ).toBeGreaterThanOrEqual(room.minZ + 0.05 - 1e-6);
        expect(p.maxZ).toBeLessThanOrEqual(room.maxZ - 0.05 + 1e-6);
        expect(Math.abs((p.maxX - p.minX) * (p.maxZ - p.minZ) - p.w * p.d)).toBeLessThan(1e-6);
        expect([0, Math.PI / 2, Math.PI, -Math.PI / 2]).toContain(p.yaw);
        expect(p.cover).toBe(p.h >= 0.8 && p.h <= 1.3);
        for (const o of l.furniture.slice(i + 1)) {
          if (o.room !== p.room) continue;
          const overlap = p.minX < o.maxX && p.maxX > o.minX && p.minZ < o.maxZ && p.maxZ > o.minZ;
          expect(overlap).toBe(false);
        }
        for (const c of boxes) {
          const hit = p.minX < c.maxX - 1e-6 && p.maxX > c.minX + 1e-6 && p.minZ < c.maxZ - 1e-6 && p.maxZ > c.minZ + 1e-6;
          expect(hit).toBe(false);
        }
      });
    }
    expect(pieces).toBeGreaterThan(500);
  });

  it('keeps spots and points inside their rooms and consistent with their furniture', () => {
    for (const l of layouts) {
      for (const h of l.hidingSpots) {
        expect(inside(l.rooms[h.room]!.rect, h.x, h.z)).toBe(true);
        expect(l.furniture[h.furniture]!.hide).toBe(h.kind);
      }
      for (const s of l.spawnSpots) expect(inside(l.rooms[s.room]!.rect, s.x, s.z)).toBe(true);
      l.itemSpots.forEach((s, i) => {
        expect(s.index).toBe(i);
        expect(inside(l.rooms[s.room]!.rect, s.x, s.z)).toBe(true);
        if (s.furniture >= 0) {
          const p = l.furniture[s.furniture]!;
          expect(s.y).toBeGreaterThan(0);
          expect(s.y).toBeLessThanOrEqual(p.h + 1e-9);
          expect(s.concealed).toBe(s.container !== 'none');
        } else {
          expect(s.y).toBe(0);
          expect(s.concealed).toBe(false);
          expect(l.furniture.some((p) => s.x > p.minX && s.x < p.maxX && s.z > p.minZ && s.z < p.maxZ)).toBe(false);
        }
      });
      for (const p of l.points) {
        expect(inside(l.rooms[p.room]!.rect, p.x, p.z)).toBe(true);
        expect(l.furniture[p.furniture]!.room).toBe(p.room);
      }
      for (const r of l.rooms) {
        if (r.light) expect(inside(r.rect, r.light.x, r.light.z)).toBe(true);
        expect(r.switchAt !== null).toBe(r.light !== null);
        if (r.switchAt) expect(inside(r.rect, r.switchAt.x, r.switchAt.z, -0.2)).toBe(true);
      }
      expect(inside(l.rect, l.entry.x, l.entry.z)).toBe(true);
      const main = l.doors.find((d) => d.main)!;
      expect(Math.hypot(l.entry.x - main.x, l.entry.z - main.z)).toBeCloseTo(1, 1);
    }
  });

  it('tiles the extent with rooms that never overlap and keeps the minimum sides', () => {
    for (const l of layouts) {
      const area = l.rooms.reduce((n, r) => n + (r.rect.maxX - r.rect.minX) * (r.rect.maxZ - r.rect.minZ), 0);
      expect(Math.abs(area - (l.rect.maxX - l.rect.minX) * (l.rect.maxZ - l.rect.minZ))).toBeLessThan(0.5);
      l.rooms.forEach((a, i) => {
        const ra = a.rect;
        expect(inside(l.rect, ra.minX, ra.minZ)).toBe(true);
        expect(inside(l.rect, ra.maxX, ra.maxZ)).toBe(true);
        const side = Math.min(ra.maxX - ra.minX, ra.maxZ - ra.minZ);
        expect(side).toBeGreaterThanOrEqual(a.kind === 'corridor' ? 2.0 - 1e-6 : 2.5);
        for (const b of l.rooms.slice(i + 1)) {
          const rb = b.rect;
          const overlap = ra.minX < rb.maxX - 1e-6 && ra.maxX > rb.minX + 1e-6 && ra.minZ < rb.maxZ - 1e-6 && ra.maxZ > rb.minZ + 1e-6;
          expect(overlap).toBe(false);
        }
      });
    }
  });

  it('seats, hides and stores according to the furniture flags', () => {
    for (const l of layouts) {
      const seats = l.furniture.filter((p) => p.seat !== null).length;
      expect(l.spawnSpots.filter((s) => s.pose !== 'stand').length).toBe(seats);
      expect(l.hidingSpots.length).toBe(l.furniture.filter((p) => p.hide !== null).length);
    }
  });
});
