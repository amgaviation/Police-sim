import { describe, expect, it } from 'vitest';
import {
  CAMERA_DISTANCE,
  CAMERA_HEIGHT,
  MAX_PITCH,
  MIN_PITCH,
  PlayerController,
  SPRINT_SPEED,
  WALK_SPEED,
  cameraPosition,
  clampPitch,
  moveVelocity,
  wrapAngle,
  yawFromQuaternion,
  yawQuaternion,
} from '../../src/game/playerController';

const vec = () => ({ x: 0, y: 0, z: 0 });

describe('moveVelocity', () => {
  it('walks forward along -Z at yaw 0', () => {
    const v = moveVelocity({ forward: 1, strafe: 0, sprint: false }, 0, vec());
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBe(0);
    expect(v.z).toBeCloseTo(-WALK_SPEED);
  });

  it('strafes right along +X at yaw 0 and sprints faster', () => {
    const v = moveVelocity({ forward: 0, strafe: 1, sprint: true }, 0, vec());
    expect(v.x).toBeCloseTo(SPRINT_SPEED);
    expect(v.z).toBeCloseTo(0);
  });

  it('rotates with yaw', () => {
    const v = moveVelocity({ forward: 1, strafe: 0, sprint: false }, Math.PI / 2, vec());
    expect(v.x).toBeCloseTo(-WALK_SPEED);
    expect(v.z).toBeCloseTo(0);
  });

  it('normalises diagonal input to the walk speed', () => {
    const v = moveVelocity({ forward: 1, strafe: 1, sprint: false }, 0.3, vec());
    expect(Math.hypot(v.x, v.z)).toBeCloseTo(WALK_SPEED);
  });

  it('is zero with no input', () => {
    const v = moveVelocity({ forward: 0, strafe: 0, sprint: true }, 1, vec());
    expect(v.x).toBeCloseTo(0);
    expect(v.y).toBe(0);
    expect(v.z).toBeCloseTo(0);
  });
});

describe('yaw helpers', () => {
  it('yawQuaternion round-trips through yawFromQuaternion', () => {
    for (const yaw of [0, 0.5, -1.2, 2.9, -3]) {
      expect(yawFromQuaternion(yawQuaternion(yaw, { x: 0, y: 0, z: 0, w: 1 }))).toBeCloseTo(yaw);
    }
  });

  it('wrapAngle keeps angles in (-pi, pi]', () => {
    expect(wrapAngle(Math.PI * 3)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI * 2.5)).toBeCloseTo(-Math.PI / 2);
    expect(wrapAngle(0.25)).toBeCloseTo(0.25);
  });

  it('clampPitch stays within the limits', () => {
    expect(clampPitch(10)).toBe(MAX_PITCH);
    expect(clampPitch(-10)).toBe(MIN_PITCH);
    expect(clampPitch(0.1)).toBe(0.1);
  });
});

describe('cameraPosition', () => {
  it('sits behind and above the target at yaw 0, pitch 0', () => {
    const p = cameraPosition({ x: 1, y: 2, z: 3 }, 0, 0, vec());
    expect(p.x).toBeCloseTo(1);
    expect(p.y).toBeCloseTo(2 + CAMERA_HEIGHT);
    expect(p.z).toBeCloseTo(3 + CAMERA_DISTANCE);
  });

  it('rises with positive pitch', () => {
    const low = cameraPosition(vec(), 0, 0, vec());
    const high = cameraPosition(vec(), 0, 0.5, vec());
    expect(high.y).toBeGreaterThan(low.y);
    expect(high.z).toBeLessThan(low.z);
  });
});

describe('PlayerController', () => {
  it('mouse look turns yaw and clamps pitch, honouring invertY', () => {
    const c = new PlayerController();
    const yaw0 = c.yaw;
    c.lookByMouse(100, 0);
    expect(c.yaw).toBeLessThan(yaw0);
    c.lookByMouse(0, 100000);
    expect(c.pitch).toBe(MAX_PITCH);
    c.lookByMouse(0, 100000, 1, true);
    expect(c.pitch).toBe(MIN_PITCH);
  });

  it('stick look scales with dt', () => {
    const a = new PlayerController();
    const b = new PlayerController();
    a.lookByStick(1, 0, 0.1);
    b.lookByStick(1, 0, 0.2);
    expect(Math.abs(b.yaw)).toBeGreaterThan(Math.abs(a.yaw));
    expect(a.yaw).toBeLessThan(0);
  });
});
