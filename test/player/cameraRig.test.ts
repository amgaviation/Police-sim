import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { cameraPosition } from '../../src/game/playerController';
import {
  CAMERA_MODE,
  CHASE_MIN_DISTANCE,
  COCKPIT_MAX_PITCH,
  COCKPIT_MAX_YAW,
  CameraRig,
  chaseCameraPose,
  chaseDistance,
  cockpitCameraPose,
  hoodCameraPose,
  smoothDamp,
  smoothDampAngle,
  vehicleYaw,
  type BodyDims,
  type CameraPose,
  type FollowTarget,
  type LookInput,
} from '../../src/player/cameraRig';

const DIMS: BodyDims = { length: 4.8, width: 1.9, height: 1.45, groundClearance: 0.15 };
const pose = (): CameraPose => ({ x: 0, y: 0, z: 0, lookX: 0, lookY: 0, lookZ: 0 });
const NO_LOOK: LookInput = { mouseX: 0, mouseY: 0, stickX: 0, stickY: 0, sensitivity: 1, invertY: false };

function target(yaw = 0, over: Partial<FollowTarget> = {}): FollowTarget {
  return { x: 0, y: 0.875, z: 0, qx: 0, qy: Math.sin(yaw / 2), qz: 0, qw: Math.cos(yaw / 2), vx: 0, vz: 0, ...over };
}

/** Pose in the vehicle's local frame (vehicle at the origin, centre height subtracted). */
function toLocal(t: FollowTarget, x: number, y: number, z: number): THREE.Vector3 {
  const q = new THREE.Quaternion(t.qx, t.qy, t.qz, t.qw).invert();
  return new THREE.Vector3(x - t.x, y - t.y, z - t.z).applyQuaternion(q);
}

function expectInsideBody(t: FollowTarget, p: CameraPose): void {
  const l = toLocal(t, p.x, p.y, p.z);
  expect(Math.abs(l.x)).toBeLessThanOrEqual(DIMS.width / 2);
  expect(Math.abs(l.y)).toBeLessThanOrEqual(DIMS.height / 2);
  expect(Math.abs(l.z)).toBeLessThanOrEqual(DIMS.length / 2);
}

/** Unit view direction in the vehicle's local frame. */
function localDir(t: FollowTarget, p: CameraPose): THREE.Vector3 {
  const eye = toLocal(t, p.x, p.y, p.z);
  return toLocal(t, p.lookX, p.lookY, p.lookZ).sub(eye).normalize();
}

describe('smoothDamp', () => {
  it('converges to the target without overshooting', () => {
    const s = { value: 0, velocity: 0 };
    let prev = 0;
    for (let i = 0; i < 300; i++) {
      const v = smoothDamp(s, 10, 0.3, 1 / 60);
      expect(v).toBeLessThanOrEqual(10);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
    expect(s.value).toBeCloseTo(10, 3);
  });

  it('never overshoots with large steps and handles dt 0', () => {
    const s = { value: 5, velocity: 40 };
    for (let i = 0; i < 20; i++) expect(smoothDamp(s, 0, 0.1, 0.5)).toBeGreaterThanOrEqual(0);
    expect(s.value).toBeCloseTo(0, 6);
    expect(smoothDamp(s, 3, 0.1, 0)).toBe(s.value);
  });

  it('takes the short way round for angles', () => {
    const s = { value: 3, velocity: 0 };
    smoothDampAngle(s, -3, 0.2, 1 / 60);
    // From 3 rad to -3 rad the short way crosses pi, so the value grows (or wraps negative).
    expect(s.value > 3 || s.value < -3).toBe(true);
    for (let i = 0; i < 300; i++) smoothDampAngle(s, -3, 0.2, 1 / 60);
    expect(s.value).toBeCloseTo(-3, 3);
  });
});

describe('pure camera poses', () => {
  it('chase sits behind (+Z) and above at yaw 0, looking ahead along velocity', () => {
    const t = target(0);
    const p = chaseCameraPose(t, DIMS, vehicleYaw(t), 0, pose());
    expect(p.x).toBeCloseTo(0);
    expect(p.z).toBeGreaterThan(DIMS.length / 2);
    expect(p.y).toBeGreaterThan(t.y + DIMS.height / 2);
    expect(Math.hypot(p.x, p.z)).toBeLessThan(chaseDistance(DIMS));
    expect(p.lookZ).toBeCloseTo(0);
    const moving = chaseCameraPose(target(0, { vz: -20 }), DIMS, 0, 0, pose());
    expect(moving.lookZ).toBeLessThan(-1);
    expect(moving.lookZ).toBeGreaterThanOrEqual(-6);
  });

  it('chase rotates with the target', () => {
    const t = target(Math.PI / 2, { x: 5, z: -3 });
    expect(vehicleYaw(t)).toBeCloseTo(Math.PI / 2);
    const p = chaseCameraPose(t, DIMS, vehicleYaw(t), 0, pose());
    // Facing -X, so the camera is on the +X side.
    expect(p.x).toBeGreaterThan(5 + DIMS.length / 2);
    expect(p.z).toBeCloseTo(-3);
  });

  it('vehicleYaw ignores pitch and roll', () => {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.2, 1.1, -0.15, 'YXZ'));
    expect(vehicleYaw(target(0, { qx: q.x, qy: q.y, qz: q.z, qw: q.w }))).toBeCloseTo(1.1);
  });

  it('hood and cockpit eyes lie inside the body and look forward (-Z local)', () => {
    for (const yaw of [0, 1, -2.5]) {
      const t = target(yaw, { x: 12, z: -40 });
      const hood = hoodCameraPose(t, DIMS, pose());
      expectInsideBody(t, hood);
      const hd = localDir(t, hood);
      expect(hd.z).toBeCloseTo(-1);
      const cockpit = cockpitCameraPose(t, DIMS, 0, 0, pose());
      expectInsideBody(t, cockpit);
      expect(toLocal(t, cockpit.x, cockpit.y, cockpit.z).x).toBeLessThan(0);
      expect(localDir(t, cockpit).z).toBeCloseTo(-1);
    }
  });

  it('cockpit offsets turn left and look down', () => {
    const t = target(0);
    const d = localDir(t, cockpitCameraPose(t, DIMS, 0.5, 0.3, pose()));
    expect(d.x).toBeLessThan(0);
    expect(d.y).toBeLessThan(0);
  });
});

describe('CameraRig', () => {
  function rig() {
    const bus = new EventBus<EventMap>();
    const modes: string[] = [];
    bus.on('camera:mode', (e) => modes.push(e.mode));
    return { rig: new CameraRig(bus), modes, camera: new THREE.PerspectiveCamera(75, 1, 0.1, 1000) };
  }

  it('cycles chase -> hood -> cockpit -> chase and remembers the mode on foot', () => {
    const { rig: r, modes } = rig();
    expect(r.mode).toBe(CAMERA_MODE.onFoot);
    r.cycleVehicleMode();
    expect(r.mode).toBe(CAMERA_MODE.onFoot);
    r.setVehicle(DIMS);
    expect(r.mode).toBe(CAMERA_MODE.chase);
    r.cycleVehicleMode();
    expect(r.mode).toBe(CAMERA_MODE.hood);
    r.cycleVehicleMode();
    expect(r.mode).toBe(CAMERA_MODE.cockpit);
    r.cycleVehicleMode();
    expect(r.mode).toBe(CAMERA_MODE.chase);
    r.cycleVehicleMode();
    r.setVehicle(null);
    expect(r.mode).toBe(CAMERA_MODE.onFoot);
    expect(r.vehicleMode).toBe(CAMERA_MODE.hood);
    r.setVehicle(DIMS);
    expect(r.mode).toBe(CAMERA_MODE.hood);
    expect(modes).toEqual(['chase', 'hood', 'cockpit', 'chase', 'hood', 'onFoot', 'hood']);
  });

  it('setVehicleMode restores a saved mode and ignores invalid ids', () => {
    const { rig: r } = rig();
    r.setVehicleMode(CAMERA_MODE.cockpit);
    r.setVehicleMode(CAMERA_MODE.onFoot);
    r.setVehicleMode(42);
    expect(r.mode).toBe(CAMERA_MODE.onFoot);
    r.setVehicle(DIMS);
    expect(r.mode).toBe(CAMERA_MODE.cockpit);
  });

  it('keeps the Phase 0 on-foot view', () => {
    const { rig: r, camera } = rig();
    const p = { x: 3, y: 1, z: -2 };
    r.updateOnFoot(p, 0.4, 0.25, camera);
    const expected = cameraPosition(p, 0.4, 0.25, { x: 0, y: 0, z: 0 });
    expect(camera.position.x).toBeCloseTo(expected.x);
    expect(camera.position.y).toBeCloseTo(expected.y);
    expect(camera.position.z).toBeCloseTo(expected.z);
  });

  it('lags behind a turn, and snap() removes the lag', () => {
    const { rig: r, camera } = rig();
    r.setVehicle(DIMS);
    r.updateVehicle(1 / 60, target(0), NO_LOOK, camera);
    const exact = chaseCameraPose(target(1), DIMS, 1, 0, pose());
    r.updateVehicle(1 / 60, target(1), NO_LOOK, camera);
    expect(camera.position.distanceTo(new THREE.Vector3(exact.x, exact.y, exact.z))).toBeGreaterThan(1);
    r.snap();
    r.updateVehicle(1 / 60, target(1), NO_LOOK, camera);
    expect(camera.position.x).toBeCloseTo(exact.x);
    expect(camera.position.y).toBeCloseTo(exact.y);
    expect(camera.position.z).toBeCloseTo(exact.z);
    // The camera looks at the target pose's look point.
    const dir = camera.getWorldDirection(new THREE.Vector3());
    const want = new THREE.Vector3(exact.lookX - exact.x, exact.lookY - exact.y, exact.lookZ - exact.z).normalize();
    expect(dir.dot(want)).toBeCloseTo(1);
  });

  it('is pulled in by the raycast but never closer than the minimum', () => {
    const { rig: r, camera } = rig();
    r.setVehicle(DIMS);
    const t = target(0);
    r.updateVehicle(1 / 60, t, NO_LOOK, camera, () => 3);
    const at3 = Math.hypot(camera.position.x, camera.position.z);
    expect(at3).toBeLessThan(3);
    expect(at3).toBeGreaterThan(2);
    r.updateVehicle(1 / 60, t, NO_LOOK, camera, () => 0.2);
    expect(camera.position.z).toBeCloseTo(CHASE_MIN_DISTANCE * Math.cos(0.15), 1);
    // A clear path lets it ease back out rather than jump.
    r.updateVehicle(1 / 60, t, NO_LOOK, camera, () => Infinity);
    expect(camera.position.z).toBeLessThan(chaseDistance(DIMS) * 0.5);
    for (let i = 0; i < 240; i++) r.updateVehicle(1 / 60, t, NO_LOOK, camera, () => Infinity);
    expect(camera.position.z).toBeCloseTo(chaseDistance(DIMS) * Math.cos(0.15), 1);
  });

  it('orbits with the mouse and re-centres after 1.5 s idle', () => {
    const { rig: r, camera } = rig();
    r.setVehicle(DIMS);
    r.updateVehicle(1 / 60, target(0), { ...NO_LOOK, mouseX: -300 }, camera);
    expect(r.yawOffset).toBeGreaterThan(0.3);
    // Mouse left turns the view left (like on foot), so the camera swings out to +X.
    expect(camera.position.x).toBeGreaterThan(1);
    const held = r.yawOffset;
    for (let i = 0; i < 80; i++) r.updateVehicle(1 / 60, target(0), NO_LOOK, camera);
    expect(r.yawOffset).toBe(held);
    for (let i = 0; i < 120; i++) r.updateVehicle(1 / 60, target(0), NO_LOOK, camera);
    expect(Math.abs(r.yawOffset)).toBeLessThan(0.01);
  });

  it('clamps cockpit free look and ignores look in hood view', () => {
    const { rig: r, camera } = rig();
    r.setVehicleMode(CAMERA_MODE.cockpit);
    r.setVehicle(DIMS);
    r.updateVehicle(1 / 60, target(0), { ...NO_LOOK, mouseX: -1e5, mouseY: 1e5 }, camera);
    expect(r.yawOffset).toBeCloseTo(COCKPIT_MAX_YAW);
    expect(r.pitchOffset).toBeCloseTo(COCKPIT_MAX_PITCH);
    r.updateVehicle(1 / 60, target(0), { ...NO_LOOK, mouseX: 1e5, mouseY: -1e5, invertY: true }, camera);
    expect(r.yawOffset).toBeCloseTo(-COCKPIT_MAX_YAW);
    expect(r.pitchOffset).toBeCloseTo(COCKPIT_MAX_PITCH);
    r.cycleVehicleMode();
    expect(r.mode).toBe(CAMERA_MODE.chase);
    r.setVehicleMode(CAMERA_MODE.hood);
    r.updateVehicle(1 / 60, target(0), { ...NO_LOOK, stickX: 1 }, camera);
    expect(r.yawOffset).toBe(0);
  });

  it('does nothing without a vehicle', () => {
    const { rig: r, camera } = rig();
    camera.position.set(1, 2, 3);
    r.updateVehicle(1 / 60, target(0), NO_LOOK, camera);
    expect(camera.position.toArray()).toEqual([1, 2, 3]);
  });
});
