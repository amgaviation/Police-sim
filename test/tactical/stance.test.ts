import { describe, expect, it } from 'vitest';
import { generateInterior } from '../../src/interior/generate';
import { lineOfSight } from '../../src/interior/los';
import { TACTICS } from '../../src/tactical/data';
import { bodyPoints, exposure } from '../../src/tactical/exposure';
import { createSliceDoor, pickSliceDoor, sliceStep, type SliceDoor } from '../../src/tactical/slice';
import { createStance, eyeOffset, speedFactor, stepLean, type StanceState } from '../../src/tactical/stance';
import type { DoorStateName } from '../../src/tactical/types';
import { handBuilding } from '../interior/helpers';
import { box, door, layoutOf, room, twoRooms } from './helpers';

const cfg = TACTICS;
const stance = (over: Partial<StanceState> = {}): StanceState => ({ ...createStance(), ...over });

describe('stance', () => {
  it('moves the lean amount towards the held lean at leanRate per second without overshoot', () => {
    const s = stance({ lean: 1 });
    stepLean(s, 0.05, cfg);
    expect(s.leanAmount).toBeCloseTo(0.3, 9);
    stepLean(s, 0.05, cfg);
    expect(s.leanAmount).toBeCloseTo(0.6, 9);
    for (let i = 0; i < 10; i++) stepLean(s, 0.05, cfg);
    expect(s.leanAmount).toBe(1);
    s.lean = -1;
    stepLean(s, 0.1, cfg);
    expect(s.leanAmount).toBeCloseTo(0.4, 9);
    for (let i = 0; i < 20; i++) stepLean(s, 0.1, cfg);
    expect(s.leanAmount).toBe(-1);
    s.lean = 0;
    for (let i = 0; i < 20; i++) stepLean(s, 0.1, cfg);
    expect(s.leanAmount).toBe(0);
  });

  it('speed factors multiply', () => {
    expect(speedFactor(stance(), cfg)).toBe(1);
    expect(speedFactor(stance({ crouched: true }), cfg)).toBe(0.5);
    expect(speedFactor(stance({ lean: -1 }), cfg)).toBe(0.5);
    expect(speedFactor(stance({ crouched: true, lean: 1 }), cfg)).toBeCloseTo(0.25, 9);
  });

  it('eye height follows the stance', () => {
    const out = { x: 0, y: 0, z: 0, roll: 0 };
    eyeOffset(stance(), 0, cfg, out);
    expect(out).toEqual({ x: 0, y: 1.65, z: 0, roll: 0 });
    eyeOffset(stance({ crouched: true }), 0, cfg, out);
    expect(out.y).toBe(1.05);
  });

  it('leaning right moves the eye to the officer right and rolls clockwise', () => {
    const out = { x: 0, y: 0, z: 0, roll: 0 };
    // Facing -Z (yaw 0): right is +X.
    eyeOffset(stance({ lean: 1, leanAmount: 1 }), 0, cfg, out);
    expect(out.x).toBeCloseTo(0.35, 9);
    expect(out.z).toBeCloseTo(0, 9);
    expect(out.roll).toBeCloseTo(-0.17, 9);
    // Facing +X (yaw -pi/2): right is +Z.
    eyeOffset(stance({ lean: 1, leanAmount: 1 }), -Math.PI / 2, cfg, out);
    expect(out.x).toBeCloseTo(0, 9);
    expect(out.z).toBeCloseTo(0.35, 9);
    // Left lean mirrors it and half a lean is half the offset.
    eyeOffset(stance({ lean: -1, leanAmount: -0.5 }), 0, cfg, out);
    expect(out.x).toBeCloseTo(-0.175, 9);
    expect(out.roll).toBeCloseTo(0.085, 9);
  });
});

describe('bodyPoints', () => {
  it('standing points are 1.6 / 1.2 / 0.8 and crouched 1.0 / 0.75 / 0.45', () => {
    const out = new Float32Array(9);
    bodyPoints(3, 4, 0, stance(), cfg, out);
    expect(Array.from(out)).toEqual([3, 1.600000023841858, 4, 3, 1.2000000476837158, 4, 3, 0.800000011920929, 4]);
    bodyPoints(3, 4, 0, stance({ crouched: true }), cfg, out);
    expect(out[1]).toBeCloseTo(1.0, 5);
    expect(out[4]).toBeCloseTo(0.75, 5);
    expect(out[7]).toBeCloseTo(0.45, 5);
  });

  it('shifts only the head point by the lean offset towards the officer right', () => {
    const out = new Float32Array(9);
    bodyPoints(3, 4, 0, stance({ lean: 1, leanAmount: 1 }), cfg, out);
    expect(out[0]).toBeCloseTo(3.35, 5);
    expect(out[2]).toBeCloseTo(4, 5);
    expect(out[3]).toBeCloseTo(3, 5);
    expect(out[6]).toBeCloseTo(3, 5);
    bodyPoints(3, 4, 0, stance({ lean: -1, leanAmount: -1 }), cfg, out);
    expect(out[0]).toBeCloseTo(2.65, 5);
    // Facing +X: right is +Z.
    bodyPoints(3, 4, -Math.PI / 2, stance({ lean: 1, leanAmount: 1 }), cfg, out);
    expect(out[0]).toBeCloseTo(3, 5);
    expect(out[2]).toBeCloseTo(4.35, 5);
  });
});

describe('exposure', () => {
  const open = (): boolean => true;
  const closed = (): boolean => false;

  it('is 1 outdoors', () => {
    expect(exposure(null, closed, 0, 1.6, 0, new Float32Array(9))).toBe(1);
  });

  it('a closed door blocks the view, an open one does not', () => {
    const layout = twoRooms();
    const pts = bodyPoints(7, 2.5, 0, stance(), cfg, new Float32Array(9));
    expect(exposure(layout, closed, 3, 1.6, 2.5, pts)).toBe(0);
    expect(exposure(layout, open, 3, 1.6, 2.5, pts)).toBe(1);
    // Same room: always visible.
    const near = bodyPoints(4, 2, 0, stance(), cfg, new Float32Array(9));
    expect(exposure(layout, closed, 1, 1.6, 2.5, near)).toBe(1);
  });

  it('crouching behind a 1.0 m counter lowers exposure from 2/3+ to 1/3 or less', () => {
    const layout = twoRooms([box(0, 0, 2, 1.5, 2.7, 3.5, 1.0)]);
    const standing = bodyPoints(3.2, 2.5, 0, stance(), cfg, new Float32Array(9));
    const crouched = bodyPoints(3.2, 2.5, 0, stance({ crouched: true }), cfg, new Float32Array(9));
    expect(exposure(layout, open, 0.5, 1.6, 2.5, standing)).toBeGreaterThanOrEqual(2 / 3 - 1e-9);
    expect(exposure(layout, open, 0.5, 1.6, 2.5, crouched)).toBeLessThanOrEqual(1 / 3 + 1e-9);
    // Without the counter both are fully visible.
    const bare = twoRooms();
    expect(exposure(bare, open, 0.5, 1.6, 2.5, standing)).toBe(1);
    expect(exposure(bare, open, 0.5, 1.6, 2.5, crouched)).toBe(1);
  });
});

describe('door slicing', () => {
  // The doorway of twoRooms(): door 0 at (5, 2.5), axis 'z' (normal +-X).
  const layout = twoRooms();
  const states = (map: Record<number, DoorStateName>) => (d: number): DoorStateName => map[d] ?? 'closed';
  const out = (): SliceDoor => createSliceDoor();

  it('picks an open doorway ahead and ignores closed ones', () => {
    const d = out();
    // Standing at (3, 2.5) facing +X (yaw -pi/2), 2 m from the door.
    expect(pickSliceDoor(layout, states({ 0: 'open' }), 3, 2.5, -Math.PI / 2, cfg, d)).toBe(0);
    expect(d.x).toBe(5);
    expect(d.z).toBe(2.5);
    // The normal points to the officer's side (-X here).
    expect(d.nx).toBe(-1);
    expect(d.nz).toBe(0);
    expect(pickSliceDoor(layout, states({ 0: 'broken' }), 3, 2.5, -Math.PI / 2, cfg, d)).toBe(0);
    expect(pickSliceDoor(layout, states({ 0: 'closed' }), 3, 2.5, -Math.PI / 2, cfg, d)).toBe(-1);
    expect(pickSliceDoor(layout, states({ 0: 'locked' }), 3, 2.5, -Math.PI / 2, cfg, d)).toBe(-1);
  });

  it('needs the doorway close and in front', () => {
    const d = out();
    const open = states({ 0: 'open' });
    expect(pickSliceDoor(layout, open, 0.5, 2.5, -Math.PI / 2, cfg, d)).toBe(-1); // 4.5 m away
    expect(pickSliceDoor(layout, open, 3, 2.5, Math.PI / 2, cfg, d)).toBe(-1); // facing away
    // From the other side the normal flips.
    expect(pickSliceDoor(layout, open, 7, 2.5, Math.PI / 2, cfg, d)).toBe(0);
    expect(d.nx).toBe(1);
  });

  it('keeps the officer on its side of the door plane and clamps the radius', () => {
    const d = out();
    pickSliceDoor(layout, states({ 0: 'open' }), 3, 2.5, -Math.PI / 2, cfg, d);
    const p = { x: 3, z: 2.5, yaw: 0 };
    // Strafe a long time in both directions.
    for (const strafe of [1, -1]) {
      for (let i = 0; i < 2000; i++) {
        sliceStep(p.x, p.z, d, 0, strafe, 1 / 60, cfg, p);
        expect(p.x).toBeLessThan(5);
        expect(Math.hypot(p.x - 5, p.z - 2.5)).toBeGreaterThanOrEqual(cfg.slice.radiusMin - 1e-9);
      }
    }
    // Backing off stops at radiusMax, pushing forward at radiusMin.
    const q = { x: 3, z: 2.5, yaw: 0 };
    for (let i = 0; i < 1000; i++) sliceStep(q.x, q.z, d, -1, 0, 1 / 60, cfg, q);
    expect(Math.hypot(q.x - 5, q.z - 2.5)).toBeCloseTo(cfg.slice.radiusMax, 6);
    for (let i = 0; i < 1000; i++) sliceStep(q.x, q.z, d, 1, 0, 1 / 60, cfg, q);
    expect(Math.hypot(q.x - 5, q.z - 2.5)).toBeCloseTo(cfg.slice.radiusMin, 6);
  });

  it('strafing right increases the angle (the officer moves to its right) and left decreases it', () => {
    const d = out();
    pickSliceDoor(layout, states({ 0: 'open' }), 3, 2.5, -Math.PI / 2, cfg, d);
    // Facing +X, the officer's right is +Z.
    const right = { x: 3, z: 2.5, yaw: 0 };
    sliceStep(3, 2.5, d, 0, 1, 0.1, cfg, right);
    expect(right.z).toBeGreaterThan(2.5);
    const left = { x: 3, z: 2.5, yaw: 0 };
    sliceStep(3, 2.5, d, 0, -1, 0.1, cfg, left);
    expect(left.z).toBeLessThan(2.5);
    // Angular speed is speed / r: 0.6 m/s at r = 2 -> 0.3 rad/s -> 0.03 rad in 0.1 s.
    expect(Math.atan2(right.z - 2.5, 5 - right.x)).toBeCloseTo(0.03, 3);
    // The angle is clamped at maxAngle.
    const far = { x: 3, z: 2.5, yaw: 0 };
    for (let i = 0; i < 5000; i++) sliceStep(far.x, far.z, d, 0, 1, 1 / 60, cfg, far);
    expect(Math.atan2(far.z - 2.5, 5 - far.x)).toBeCloseTo(cfg.slice.maxAngle, 6);
  });

  it('faces the door centre', () => {
    const d = out();
    pickSliceDoor(layout, states({ 0: 'open' }), 3, 2.5, -Math.PI / 2, cfg, d);
    const p = { x: 3, z: 2.5, yaw: 0 };
    for (let i = 0; i < 60; i++) sliceStep(p.x, p.z, d, 0, 1, 1 / 60, cfg, p);
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    const tx = 5 - p.x;
    const tz = 2.5 - p.z;
    const len = Math.hypot(tx, tz);
    expect(fx).toBeCloseTo(tx / len, 6);
    expect(fz).toBeCloseTo(tz / len, 6);
  });

  it('works on an x-axis door (normal along Z)', () => {
    const l = layoutOf(
      { minX: 0, minZ: 0, maxX: 5, maxZ: 10 },
      [room(0, 'living', { minX: 0, minZ: 0, maxX: 5, maxZ: 5 }), room(1, 'kitchen', { minX: 0, minZ: 5, maxX: 5, maxZ: 10 })],
      [door(0, 0, 1, 2.5, 5, 'x')],
      [],
    );
    const d = out();
    expect(pickSliceDoor(l, () => 'open', 2.5, 3, 0, cfg, d)).toBe(-1); // facing -Z, away from the door at +Z
    // Facing +Z (yaw pi).
    expect(pickSliceDoor(l, () => 'open', 2.5, 3, Math.PI, cfg, d)).toBe(0);
    expect(d.nz).toBe(-1);
    const p = { x: 2.5, z: 3, yaw: 0 };
    sliceStep(2.5, 3, d, 0, 1, 0.1, cfg, p);
    // Facing +Z, the officer's right is -X.
    expect(p.x).toBeLessThan(2.5);
  });
});

describe('exposure equals the interior line of sight', () => {
  it('agrees with lineOfSight on random rays through generated layouts', () => {
    const layouts = [twoRooms([box(0, 0, 2, 1.5, 2.7, 3.5, 1.0)])];
    for (const kind of ['house', 'apartment', 'office'] as const) {
      const l = generateInterior(42, handBuilding(kind, kind === 'house' ? 14 : 30, kind === 'house' ? 12 : 22, 0, 900_400));
      if (l === null) throw new Error('no layout');
      layouts.push(l);
    }
    let state = 12345;
    const rand = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    let blockedSome = false;
    let clearSome = false;
    for (const layout of layouts) {
      const r = layout.rect;
      const open = (d: number): boolean => d % 3 === 0;
      const pts = new Float32Array(9);
      for (let n = 0; n < 150; n++) {
        const ex = r.minX + rand() * (r.maxX - r.minX);
        const ez = r.minZ + rand() * (r.maxZ - r.minZ);
        const ey = 0.3 + rand() * 1.4;
        const st = stance({ crouched: rand() < 0.5, leanAmount: rand() * 2 - 1 });
        bodyPoints(r.minX + rand() * (r.maxX - r.minX), r.minZ + rand() * (r.maxZ - r.minZ), rand() * 6, st, cfg, pts);
        let expected = 0;
        for (let i = 0; i < 3; i++) if (lineOfSight(layout, open, ex, ey, ez, pts[3 * i] as number, pts[3 * i + 1] as number, pts[3 * i + 2] as number)) expected++;
        const got = exposure(layout, open, ex, ey, ez, pts);
        expect(got).toBeCloseTo(expected / 3, 12);
        if (expected < 3) blockedSome = true;
        if (expected > 0) clearSome = true;
      }
    }
    expect(blockedSome).toBe(true);
    expect(clearSome).toBe(true);
  });
});
