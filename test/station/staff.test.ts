import { describe, expect, it } from 'vitest';
import { generateInterior } from '../../src/interior/generate';
import { roomAt } from '../../src/interior/nav';
import { createHumanoidSource, POSE } from '../../src/render/people/pose';
import { defaultLoadout, uniformColors } from '../../src/station/locker';
import { stationStaff, type StaffLayout } from '../../src/station/staff';
import { handBuilding, indexFor } from '../interior/helpers';

const points = [
  { kind: 'locker', room: 0, furniture: 0, x: 1, z: 1, yaw: 0 },
  { kind: 'frontDesk', room: 0, furniture: 1, x: 10, z: 20, yaw: 0 },
  { kind: 'briefing', room: 0, furniture: 2, x: 30, z: 5, yaw: Math.PI / 2 },
  { kind: 'armory', room: 0, furniture: 3, x: 0, z: 0, yaw: Math.PI },
  { kind: 'evidence', room: 0, furniture: 4, x: -4, z: 8, yaw: -Math.PI / 2 },
  { kind: 'booking', room: 0, furniture: 5, x: 7, z: 7, yaw: 0 },
  { kind: 'interview', room: 0, furniture: 6, x: 9, z: 9, yaw: 0 },
];
/** One big empty room, each piece a 1 x 1 box 1 m in front of its point's facing: the far side is free floor. */
const layout = (pts: StaffLayout['points'], floorY: number): StaffLayout => ({
  floorY,
  points: pts,
  rooms: [{ rect: { minX: -100, minZ: -100, maxX: 100, maxZ: 100 } }],
  furniture: pts.map((p) => {
    const x = p.x - Math.sin(p.yaw) * 1, z = p.z - Math.cos(p.yaw) * 1;
    return { minX: x - 0.5, maxX: x + 0.5, minZ: z - 0.5, maxZ: z + 0.5, solid: true };
  }),
});

describe('stationStaff', () => {
  it('writes one figure for each staff point present', () => {
    const out = createHumanoidSource(8);
    expect(stationStaff(layout(points, -40), out)).toBe(5);
    expect(out.count).toBe(5);
    expect(stationStaff(layout(points.filter((p) => p.kind === 'armory' || p.kind === 'locker'), -40), out)).toBe(1);
    expect(out.count).toBe(1);
    expect(stationStaff(layout([], -40), out)).toBe(0);
    expect(out.count).toBe(0);
  });

  it('stands beyond free furniture, facing the point, on the floor', () => {
    const out = createHumanoidSource(8);
    stationStaff(layout(points, -40), out);
    // frontDesk (yaw 0 faces -Z): the box spans z 18.5..19.5 (stand z 20), so the figure stands at z 19.5 - 0.5 = 18.5 - ... beyond it.
    expect(out.x[0]).toBeCloseTo(10, 5);
    expect(out.z[0]).toBeCloseTo(18, 5);
    expect(Math.cos(out.yaw[0] ?? 0)).toBeCloseTo(-1, 5);
    for (let i = 0; i < out.count; i++) {
      const p = points.find((q) => q.kind === ['frontDesk', 'briefing', 'armory', 'evidence', 'booking'][i]);
      expect(p).toBeDefined();
      if (!p) continue;
      // Looking at the point: forward = (-sin yaw, -cos yaw) points from the figure to the point.
      const fx = -Math.sin(out.yaw[i] ?? 0);
      const fz = -Math.cos(out.yaw[i] ?? 0);
      const dx = p.x - (out.x[i] ?? 0), dz = p.z - (out.z[i] ?? 0);
      expect(fx * dx + fz * dz).toBeCloseTo(Math.hypot(dx, dz), 4);
      expect(out.y[i]).toBe(-40);
      expect(out.prevX[i]).toBe(out.x[i]);
      expect(out.prevYaw[i]).toBe(out.yaw[i]);
    }
  });

  it('uses uniform colours, the stand pose and no held item', () => {
    const out = createHumanoidSource(8);
    stationStaff(layout(points, 0), out);
    const c = uniformColors(defaultLoadout());
    for (let i = 0; i < out.count; i++) {
      expect(out.top[i]).toBe(c.top);
      expect(out.bottom[i]).toBe(c.bottom);
      expect(out.pose[i]).toBe(POSE.stand);
      expect(out.held[i]).toBe(0);
      expect(out.anchor[i]).toBe(0);
    }
  });

  it('never writes past the capacity', () => {
    const out = createHumanoidSource(2);
    expect(stationStaff(layout(points, 0), out)).toBe(2);
  });

  it('keeps every figure of a generated station in the room of its point, outside the furniture and off the stand point', () => {
    const buildings = [indexFor().station()!, handBuilding('policeStation', 60, 28), handBuilding('policeStation', 44, 24, 1, 900_001), handBuilding('jail', 50, 26, 2, 900_002)];
    let figures = 0;
    for (const b of buildings) {
      for (const seed of [42, 7, 18, 99]) {
        const l = generateInterior(seed, b);
        if (l === null) continue;
        const out = createHumanoidSource(8);
        const n = stationStaff(l, out);
        const roles = ['frontDesk', 'briefing', 'armory', 'evidence', 'booking'].filter((k) => l.points.some((p) => p.kind === k));
        expect(n).toBe(roles.length);
        roles.forEach((role, i) => {
          const p = l.points.find((q) => q.kind === role)!;
          const x = out.x[i]!, z = out.z[i]!;
          expect(roomAt(l, x, z), `${role} room`).toBe(p.room);
          for (const f of l.furniture) {
            if (!f.solid) continue;
            const d = Math.hypot(Math.max(f.minX - x, 0, x - f.maxX), Math.max(f.minZ - z, 0, z - f.maxZ));
            expect(d, `${role} inside ${f.id}`).toBeGreaterThanOrEqual(0.35);
          }
          expect(Math.hypot(x - p.x, z - p.z), `${role} on the stand point`).toBeGreaterThan(0.75);
          figures++;
        });
      }
    }
    expect(figures).toBeGreaterThan(30);
  });
});
