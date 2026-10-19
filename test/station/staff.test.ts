import { describe, expect, it } from 'vitest';
import { createHumanoidSource, POSE } from '../../src/render/people/pose';
import { defaultLoadout, uniformColors } from '../../src/station/locker';
import { stationStaff } from '../../src/station/staff';

const points = [
  { kind: 'locker', x: 1, z: 1, yaw: 0 },
  { kind: 'frontDesk', x: 10, z: 20, yaw: 0 },
  { kind: 'briefing', x: 30, z: 5, yaw: Math.PI / 2 },
  { kind: 'armory', x: 0, z: 0, yaw: Math.PI },
  { kind: 'evidence', x: -4, z: 8, yaw: -Math.PI / 2 },
  { kind: 'booking', x: 7, z: 7, yaw: 0 },
  { kind: 'interview', x: 9, z: 9, yaw: 0 },
];

describe('stationStaff', () => {
  it('writes one figure for each staff point present', () => {
    const out = createHumanoidSource(8);
    expect(stationStaff(points, -40, out)).toBe(5);
    expect(out.count).toBe(5);
    expect(stationStaff(points.filter((p) => p.kind === 'armory' || p.kind === 'locker'), -40, out)).toBe(1);
    expect(out.count).toBe(1);
    expect(stationStaff([], -40, out)).toBe(0);
    expect(out.count).toBe(0);
  });

  it('puts each figure 1.2 m beyond its point, facing back at it, on the floor', () => {
    const out = createHumanoidSource(8);
    stationStaff(points, -40, out);
    // frontDesk (yaw 0 faces -Z): the figure stands at z - 1.2 and looks +Z (yaw pi).
    expect(out.x[0]).toBeCloseTo(10, 5);
    expect(out.z[0]).toBeCloseTo(18.8, 5);
    expect(Math.cos(out.yaw[0] ?? 0)).toBeCloseTo(-1, 5);
    for (let i = 0; i < out.count; i++) {
      const p = points.find((q) => q.kind === ['frontDesk', 'briefing', 'armory', 'evidence', 'booking'][i]);
      expect(p).toBeDefined();
      if (!p) continue;
      expect(Math.hypot((out.x[i] ?? 0) - p.x, (out.z[i] ?? 0) - p.z)).toBeCloseTo(1.2, 4);
      // Looking at the point: forward = (-sin yaw, -cos yaw) points from the figure to the point.
      const fx = -Math.sin(out.yaw[i] ?? 0);
      const fz = -Math.cos(out.yaw[i] ?? 0);
      expect(fx * (p.x - (out.x[i] ?? 0)) + fz * (p.z - (out.z[i] ?? 0))).toBeCloseTo(1.2, 4);
      expect(out.y[i]).toBe(-40);
      expect(out.prevX[i]).toBe(out.x[i]);
      expect(out.prevYaw[i]).toBe(out.yaw[i]);
    }
  });

  it('uses uniform colours, the stand pose and no held item', () => {
    const out = createHumanoidSource(8);
    stationStaff(points, 0, out);
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
    expect(stationStaff(points, 0, out)).toBe(2);
  });
});
