/**
 * Camera modes (on-foot orbit, chase, hood, cockpit). The pose maths are pure functions writing into
 * `out` objects; `CameraRig` adds smoothing state and writes an existing camera without allocating.
 */
import * as THREE from 'three';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import { MOUSE_LOOK_RATE, STICK_LOOK_RATE, cameraPosition, wrapAngle, type Vec3Like } from '../game/playerController';
import type { CameraModeName } from './events';

export const CAMERA_MODE = { onFoot: 0, chase: 1, hood: 2, cockpit: 3 } as const;
export type CameraModeId = (typeof CAMERA_MODE)[keyof typeof CAMERA_MODE];
export type VehicleCameraModeId = (typeof CAMERA_MODE)['chase' | 'hood' | 'cockpit'];
/** Event/save name of each mode, indexed by id. */
export const CAMERA_MODE_NAMES: readonly CameraModeName[] = ['onFoot', 'chase', 'hood', 'cockpit'];

/** Seconds for the chase camera to catch up with the vehicle's heading. */
export const CHASE_SMOOTH_TIME = 0.25;
/** Smoothing of the velocity used for look-ahead. */
export const CHASE_VELOCITY_SMOOTH_TIME = 0.3;
/** Seconds to move back out after a wall pulled the camera in (pulling in is instant). */
export const CHASE_PULL_OUT_TIME = 0.5;
/** Closest the chase camera gets when pulled in by the raycast. */
export const CHASE_MIN_DISTANCE = 1.5;
/** Distance kept between the camera and a raycast hit. */
export const CHASE_RAY_MARGIN = 0.3;
/** Base elevation (rad) of the chase camera above the pivot. */
export const CHASE_ELEVATION = 0.15;
/** Seconds of velocity the chase camera looks ahead, capped at `CHASE_MAX_LOOK_AHEAD` m. */
export const CHASE_LOOK_AHEAD_TIME = 0.3;
export const CHASE_MAX_LOOK_AHEAD = 6;
/** Seconds without look input before the chase orbit re-centres, and its smoothing time. */
export const CHASE_RECENTRE_DELAY = 1.5;
export const CHASE_RECENTRE_TIME = 0.35;
/** Chase orbit pitch offset range (rad, positive = higher, looking down more). */
export const CHASE_MIN_PITCH = -0.25;
export const CHASE_MAX_PITCH = 0.9;
/** Cockpit free-look limits (rad). */
export const COCKPIT_MAX_YAW = (100 * Math.PI) / 180;
export const COCKPIT_MAX_PITCH = (60 * Math.PI) / 180;
/** The camera never goes below this height (the world is flat at y = 0). */
export const CAMERA_MIN_Y = 0.3;
/** Distance of the look-at point for the fixed vehicle views. */
const LOOK_DISTANCE = 10;

/** Interpolated pose of the followed vehicle: body-centre position, rotation and horizontal velocity. */
export interface FollowTarget {
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  vx: number;
  vz: number;
}

/** Body box of the vehicle (`VehicleModel.body` satisfies it). */
export interface BodyDims {
  readonly length: number;
  readonly width: number;
  readonly height: number;
  readonly groundClearance: number;
}

/** One frame of look input: mouse pixels and -1..1 stick deflection. */
export interface LookInput {
  mouseX: number;
  mouseY: number;
  stickX: number;
  stickY: number;
  sensitivity: number;
  invertY: boolean;
}

/** Distance along the unit direction to the first hit, `Infinity` for none. Must ignore the followed vehicle. */
export type CameraRaycast = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDistance: number) => number;

/** Camera position and the world point it looks at. */
export interface CameraPose {
  x: number;
  y: number;
  z: number;
  lookX: number;
  lookY: number;
  lookZ: number;
}

export interface SmoothState {
  value: number;
  velocity: number;
}

/**
 * Critically damped spring towards `target` (Game Programming Gems 4, 1.10), clamped so it never
 * overshoots. Updates `state` and returns the new value.
 */
export function smoothDamp(state: SmoothState, target: number, smoothTime: number, dt: number): number {
  if (dt <= 0) return state.value;
  if (smoothTime <= 0) {
    state.value = target;
    state.velocity = 0;
    return target;
  }
  const omega = 2 / smoothTime;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = state.value - target;
  const temp = (state.velocity + omega * change) * dt;
  let next = target + (change + temp) * exp;
  state.velocity = (state.velocity - omega * temp) * exp;
  if (target - state.value > 0 === (next > target)) {
    next = target;
    state.velocity = 0;
  }
  state.value = next;
  return next;
}

/** `smoothDamp` for angles: takes the short way round and keeps the value wrapped to [-pi, pi]. */
export function smoothDampAngle(state: SmoothState, target: number, smoothTime: number, dt: number): number {
  smoothDamp(state, state.value + wrapAngle(target - state.value), smoothTime, dt);
  state.value = wrapAngle(state.value);
  return state.value;
}

const local: Vec3Like = { x: 0, y: 0, z: 0 };

/** World position of the local point (lx, ly, lz) of `t` (local -Z is the front); valid until the next call. */
function toWorld(t: FollowTarget, lx: number, ly: number, lz: number): Vec3Like {
  // v' = v + w * c + q x c, with c = 2 * (q x v)
  const cx = 2 * (t.qy * lz - t.qz * ly);
  const cy = 2 * (t.qz * lx - t.qx * lz);
  const cz = 2 * (t.qx * ly - t.qy * lx);
  local.x = t.x + lx + t.qw * cx + (t.qy * cz - t.qz * cy);
  local.y = t.y + ly + t.qw * cy + (t.qz * cx - t.qx * cz);
  local.z = t.z + lz + t.qw * cz + (t.qx * cy - t.qy * cx);
  return local;
}

/** Heading (yaw about +Y, 0 = facing -Z) of the target's forward axis, ignoring pitch and roll. */
export function vehicleYaw(t: FollowTarget): number {
  const fx = -2 * (t.qw * t.qy + t.qz * t.qx);
  const fz = -1 + 2 * (t.qx * t.qx + t.qy * t.qy);
  return Math.atan2(-fx, -fz);
}

/** Unpulled chase distance from the pivot, scaled with the body length. */
export function chaseDistance(dims: BodyDims): number {
  return dims.length * 1.1 + 3;
}

/** Height of the chase pivot (orbit centre and look-at height) above the body centre: just above the roof. */
export function chasePivotHeight(dims: BodyDims): number {
  return dims.height * 0.5 + 0.4;
}

/**
 * Chase camera orbiting the pivot above the target from behind at world `yaw` (the camera sits on the
 * +Z side at yaw 0, like the on-foot camera), `pitch` above the base elevation, `distance` from the pivot.
 * It looks at the pivot moved ahead along the target's velocity.
 */
export function chaseCameraPose(
  target: FollowTarget,
  dims: BodyDims,
  yaw: number,
  pitch: number,
  out: CameraPose,
  distance = chaseDistance(dims),
): CameraPose {
  const elevation = CHASE_ELEVATION + pitch;
  const horizontal = Math.cos(elevation) * distance;
  const pivotY = target.y + chasePivotHeight(dims);
  out.x = target.x + Math.sin(yaw) * horizontal;
  out.y = Math.max(CAMERA_MIN_Y, pivotY + Math.sin(elevation) * distance);
  out.z = target.z + Math.cos(yaw) * horizontal;
  let ax = target.vx * CHASE_LOOK_AHEAD_TIME;
  let az = target.vz * CHASE_LOOK_AHEAD_TIME;
  const ahead = Math.hypot(ax, az);
  if (ahead > CHASE_MAX_LOOK_AHEAD) {
    ax *= CHASE_MAX_LOOK_AHEAD / ahead;
    az *= CHASE_MAX_LOOK_AHEAD / ahead;
  }
  out.lookX = target.x + ax;
  out.lookY = pivotY;
  out.lookZ = target.z + az;
  return out;
}

function writeLocalPose(t: FollowTarget, ex: number, ey: number, ez: number, dx: number, dy: number, dz: number, out: CameraPose): CameraPose {
  const eye = toWorld(t, ex, ey, ez);
  out.x = eye.x;
  out.y = eye.y;
  out.z = eye.z;
  const look = toWorld(t, ex + dx * LOOK_DISTANCE, ey + dy * LOOK_DISTANCE, ez + dz * LOOK_DISTANCE);
  out.lookX = look.x;
  out.lookY = look.y;
  out.lookZ = look.z;
  return out;
}

/** Fixed view from the bonnet, looking straight ahead (local -Z). */
export function hoodCameraPose(target: FollowTarget, dims: BodyDims, out: CameraPose): CameraPose {
  return writeLocalPose(target, 0, dims.height * 0.2, -dims.length * 0.3, 0, 0, -1, out);
}

/**
 * Driver's eye (left seat). `yawOffset` turns the view left (positive, like yaw) and `pitchOffset`
 * tilts it down (positive, matching the on-foot mouse direction); callers clamp them.
 */
export function cockpitCameraPose(target: FollowTarget, dims: BodyDims, yawOffset: number, pitchOffset: number, out: CameraPose): CameraPose {
  const cp = Math.cos(pitchOffset);
  return writeLocalPose(
    target,
    -dims.width * 0.22,
    dims.height * 0.2,
    -dims.length * 0.05,
    -Math.sin(yawOffset) * cp,
    -Math.sin(pitchOffset),
    -Math.cos(yawOffset) * cp,
    out,
  );
}

/**
 * First-person pose: the camera sits at (x + eye.x, feetY + eye.y, z + eye.z) and looks along `yaw` / `pitch`
 * (yaw 0 faces -Z; positive pitch looks down, like the on-foot mouse look). Writes `out` and returns it.
 */
export function firstPersonPose(
  x: number,
  feetY: number,
  z: number,
  yaw: number,
  pitch: number,
  eye: { readonly x: number; readonly y: number; readonly z: number },
  out: CameraPose,
): CameraPose {
  const cp = Math.cos(pitch);
  out.x = x + eye.x;
  out.y = feetY + eye.y;
  out.z = z + eye.z;
  out.lookX = out.x - Math.sin(yaw) * cp * LOOK_DISTANCE;
  out.lookY = out.y - Math.sin(pitch) * LOOK_DISTANCE;
  out.lookZ = out.z - Math.cos(yaw) * cp * LOOK_DISTANCE;
  return out;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
const reset = (s: SmoothState, value: number): void => {
  s.value = value;
  s.velocity = 0;
};

const scratchPos = new THREE.Vector3();
const scratchLook = new THREE.Vector3();

/** Drives the game camera for the current mode. Emits `camera:mode` on change when given a bus. */
export class CameraRig {
  private readonly bus: EventBus<EventMap> | undefined;
  private modeValue: CameraModeId = CAMERA_MODE.onFoot;
  private vehicleModeValue: VehicleCameraModeId = CAMERA_MODE.chase;
  private dims: BodyDims | null = null;
  private needsSnap = true;
  private idle = 0;
  private readonly orbitYaw: SmoothState = { value: 0, velocity: 0 };
  private readonly orbitPitch: SmoothState = { value: 0, velocity: 0 };
  private readonly heading: SmoothState = { value: 0, velocity: 0 };
  private readonly velX: SmoothState = { value: 0, velocity: 0 };
  private readonly velZ: SmoothState = { value: 0, velocity: 0 };
  private readonly distance: SmoothState = { value: 0, velocity: 0 };
  private readonly smoothed: FollowTarget = { x: 0, y: 0, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vz: 0 };
  private readonly pose: CameraPose = { x: 0, y: 0, z: 0, lookX: 0, lookY: 0, lookZ: 0 };

  constructor(bus?: EventBus<EventMap>) {
    this.bus = bus;
  }

  get mode(): CameraModeId {
    return this.modeValue;
  }

  /** Mode used when driving; remembered while on foot (saved as `camera.mode`). */
  get vehicleMode(): VehicleCameraModeId {
    return this.vehicleModeValue;
  }

  /** Orbit (chase) or free-look (cockpit) yaw offset from the vehicle's heading; positive = left. */
  get yawOffset(): number {
    return this.orbitYaw.value;
  }

  /** Orbit (chase) or free-look (cockpit) pitch offset; positive = viewing more downwards. */
  get pitchOffset(): number {
    return this.orbitPitch.value;
  }

  /** Enters the remembered vehicle mode for a body of `dims`, or returns to on foot for `null`. */
  setVehicle(dims: BodyDims | null): void {
    this.dims = dims;
    this.setMode(dims === null ? CAMERA_MODE.onFoot : this.vehicleModeValue);
    this.snap();
  }

  /** chase -> hood -> cockpit -> chase. Only while driving. */
  cycleVehicleMode(): void {
    if (this.modeValue === CAMERA_MODE.onFoot) return;
    const next = this.vehicleModeValue === CAMERA_MODE.cockpit ? CAMERA_MODE.chase : ((this.vehicleModeValue + 1) as VehicleCameraModeId);
    this.setVehicleMode(next);
  }

  /** Sets the remembered vehicle mode (e.g. from a save); applied at once while driving. Other ids are ignored. */
  setVehicleMode(mode: number): void {
    if (mode !== CAMERA_MODE.chase && mode !== CAMERA_MODE.hood && mode !== CAMERA_MODE.cockpit) return;
    this.vehicleModeValue = mode;
    if (this.modeValue !== CAMERA_MODE.onFoot) {
      this.setMode(mode);
      this.snap();
    }
  }

  /** Drops all smoothing lag and look offsets so the next update shows the exact target pose. */
  snap(): void {
    this.needsSnap = true;
    this.idle = 0;
    reset(this.orbitYaw, 0);
    reset(this.orbitPitch, 0);
  }

  /** Phase 0 on-foot orbit camera around `target` (the player's interpolated position). */
  updateOnFoot(target: Vec3Like, yaw: number, pitch: number, camera: THREE.PerspectiveCamera): void {
    cameraPosition(target, yaw, pitch, scratchPos);
    camera.position.copy(scratchPos);
    scratchLook.set(target.x, target.y + 1, target.z);
    camera.lookAt(scratchLook);
  }

  /**
   * First-person camera at the officer's eye (`feetY` is the level's floor height; `eye` comes from the tactical
   * stance), rolled by `eye.roll` radians (negative = leaning right, clockwise). Does not touch the vehicle state.
   */
  updateFirstPerson(
    x: number,
    feetY: number,
    z: number,
    yaw: number,
    pitch: number,
    eye: { readonly x: number; readonly y: number; readonly z: number; readonly roll: number },
    camera: THREE.PerspectiveCamera,
  ): void {
    const pose = firstPersonPose(x, feetY, z, yaw, pitch, eye, this.pose);
    camera.position.set(pose.x, pose.y, pose.z);
    scratchLook.set(pose.lookX, pose.lookY, pose.lookZ);
    camera.lookAt(scratchLook);
    if (eye.roll !== 0) camera.rotateZ(eye.roll);
  }

  /** Follows the driven vehicle in the current vehicle mode. Does nothing without `setVehicle(dims)`. */
  updateVehicle(dt: number, target: FollowTarget, look: LookInput, camera: THREE.PerspectiveCamera, raycast?: CameraRaycast): void {
    const dims = this.dims;
    if (dims === null || this.modeValue === CAMERA_MODE.onFoot) return;
    this.applyLook(dt, look);
    const pose = this.pose;
    if (this.modeValue === CAMERA_MODE.hood) hoodCameraPose(target, dims, pose);
    else if (this.modeValue === CAMERA_MODE.cockpit) cockpitCameraPose(target, dims, this.orbitYaw.value, this.orbitPitch.value, pose);
    else this.chase(dt, target, dims, raycast);
    this.needsSnap = false;
    camera.position.set(pose.x, pose.y, pose.z);
    scratchLook.set(pose.lookX, pose.lookY, pose.lookZ);
    camera.lookAt(scratchLook);
  }

  private chase(dt: number, target: FollowTarget, dims: BodyDims, raycast: CameraRaycast | undefined): void {
    const yaw = vehicleYaw(target);
    if (this.needsSnap) {
      reset(this.heading, yaw);
      reset(this.velX, target.vx);
      reset(this.velZ, target.vz);
    } else {
      smoothDampAngle(this.heading, yaw, CHASE_SMOOTH_TIME, dt);
      smoothDamp(this.velX, target.vx, CHASE_VELOCITY_SMOOTH_TIME, dt);
      smoothDamp(this.velZ, target.vz, CHASE_VELOCITY_SMOOTH_TIME, dt);
    }
    const orbitYaw = this.heading.value + this.orbitYaw.value;
    const full = chaseDistance(dims);
    let wanted = full;
    if (raycast) {
      const elevation = CHASE_ELEVATION + this.orbitPitch.value;
      const ch = Math.cos(elevation);
      const hit = raycast(
        target.x,
        target.y + chasePivotHeight(dims),
        target.z,
        Math.sin(orbitYaw) * ch,
        Math.sin(elevation),
        Math.cos(orbitYaw) * ch,
        full + CHASE_RAY_MARGIN,
      );
      if (hit < full + CHASE_RAY_MARGIN) wanted = Math.max(CHASE_MIN_DISTANCE, hit - CHASE_RAY_MARGIN);
    }
    if (this.needsSnap || wanted < this.distance.value) reset(this.distance, wanted);
    else smoothDamp(this.distance, wanted, CHASE_PULL_OUT_TIME, dt);

    const s = this.smoothed;
    s.x = target.x;
    s.y = target.y;
    s.z = target.z;
    s.vx = this.velX.value;
    s.vz = this.velZ.value;
    chaseCameraPose(s, dims, orbitYaw, this.orbitPitch.value, this.pose, this.distance.value);
  }

  private applyLook(dt: number, look: LookInput): void {
    const mode = this.modeValue;
    if (mode === CAMERA_MODE.hood) return;
    const rate = MOUSE_LOOK_RATE * look.sensitivity;
    const dy = (look.mouseY * rate + look.stickY * STICK_LOOK_RATE * dt) * (look.invertY ? -1 : 1);
    const dx = -look.mouseX * rate - look.stickX * STICK_LOOK_RATE * dt;
    const yaw = this.orbitYaw;
    const pitch = this.orbitPitch;
    if (dx !== 0 || dy !== 0) {
      this.idle = 0;
      yaw.velocity = 0;
      pitch.velocity = 0;
      if (mode === CAMERA_MODE.cockpit) {
        yaw.value = clamp(yaw.value + dx, -COCKPIT_MAX_YAW, COCKPIT_MAX_YAW);
        pitch.value = clamp(pitch.value + dy, -COCKPIT_MAX_PITCH, COCKPIT_MAX_PITCH);
      } else {
        yaw.value = wrapAngle(yaw.value + dx);
        pitch.value = clamp(pitch.value + dy, CHASE_MIN_PITCH, CHASE_MAX_PITCH);
      }
      return;
    }
    if (mode !== CAMERA_MODE.chase) return;
    this.idle += dt;
    if (this.idle >= CHASE_RECENTRE_DELAY) {
      smoothDampAngle(yaw, 0, CHASE_RECENTRE_TIME, dt);
      smoothDamp(pitch, 0, CHASE_RECENTRE_TIME, dt);
    }
  }

  private setMode(mode: CameraModeId): void {
    if (mode === this.modeValue) return;
    this.modeValue = mode;
    this.bus?.emit('camera:mode', { mode: CAMERA_MODE_NAMES[mode] ?? 'onFoot' });
  }
}
