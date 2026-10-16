/** Player movement and third-person camera maths; pure so it is unit-testable. */

export const WALK_SPEED = 4;
export const SPRINT_SPEED = 8;
/** Radians of yaw per mouse pixel at sensitivity 1. */
export const MOUSE_LOOK_RATE = 0.0022;
/** Radians per second of yaw at full stick deflection. */
export const STICK_LOOK_RATE = 2.5;
export const MAX_PITCH = 1.2;
export const MIN_PITCH = -0.35;
export const CAMERA_DISTANCE = 7;
export const CAMERA_HEIGHT = 2.5;

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface QuatLike {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface MoveInput {
  /** -1..1, positive is forward. */
  forward: number;
  /** -1..1, positive is right. */
  strafe: number;
  sprint: boolean;
}

export function wrapAngle(angle: number): number {
  const twoPi = Math.PI * 2;
  let a = angle % twoPi;
  if (a > Math.PI) a -= twoPi;
  if (a < -Math.PI) a += twoPi;
  return a;
}

export function clampPitch(pitch: number): number {
  return Math.min(MAX_PITCH, Math.max(MIN_PITCH, pitch));
}

/**
 * Horizontal world-space velocity for `input` when the player faces `yaw`
 * (rotation about +Y; yaw 0 faces -Z). Diagonal input is normalised so
 * strafing forward is not faster than walking forward.
 */
export function moveVelocity(input: MoveInput, yaw: number, out: Vec3Like): Vec3Like {
  let f = Math.max(-1, Math.min(1, input.forward));
  let s = Math.max(-1, Math.min(1, input.strafe));
  const len = Math.hypot(f, s);
  if (len > 1) {
    f /= len;
    s /= len;
  }
  const speed = input.sprint ? SPRINT_SPEED : WALK_SPEED;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  // forward = (-sin, 0, -cos); right = (cos, 0, -sin)
  out.x = (-sin * f + cos * s) * speed;
  out.y = 0;
  out.z = (-cos * f - sin * s) * speed;
  return out;
}

/** Unit quaternion for a rotation of `yaw` radians about +Y. */
export function yawQuaternion(yaw: number, out: QuatLike): QuatLike {
  out.x = 0;
  out.y = Math.sin(yaw / 2);
  out.z = 0;
  out.w = Math.cos(yaw / 2);
  return out;
}

/** Yaw (about +Y) encoded in a quaternion that only rotates about Y. */
export function yawFromQuaternion(q: QuatLike): number {
  return wrapAngle(2 * Math.atan2(q.y, q.w));
}

/** Position of a camera orbiting `target` from behind at the rig's yaw/pitch. */
export function cameraPosition(
  target: Vec3Like,
  yaw: number,
  pitch: number,
  out: Vec3Like,
  distance = CAMERA_DISTANCE,
  height = CAMERA_HEIGHT,
): Vec3Like {
  const horizontal = Math.cos(pitch) * distance;
  out.x = target.x + Math.sin(yaw) * horizontal;
  out.y = target.y + height + Math.sin(pitch) * distance;
  out.z = target.z + Math.cos(yaw) * horizontal;
  return out;
}

/** Holds the look direction and turns raw look input into yaw/pitch. */
export class PlayerController {
  yaw = 0;
  pitch = 0.25;

  /** Applies a mouse delta in pixels (`invertY` flips the vertical axis). */
  lookByMouse(dx: number, dy: number, sensitivity = 1, invertY = false): void {
    this.yaw = wrapAngle(this.yaw - dx * MOUSE_LOOK_RATE * sensitivity);
    this.pitch = clampPitch(this.pitch + (invertY ? -dy : dy) * MOUSE_LOOK_RATE * sensitivity);
  }

  /** Applies a -1..1 stick deflection for `dt` seconds. */
  lookByStick(x: number, y: number, dt: number, invertY = false): void {
    this.yaw = wrapAngle(this.yaw - x * STICK_LOOK_RATE * dt);
    this.pitch = clampPitch(this.pitch + (invertY ? -y : y) * STICK_LOOK_RATE * dt);
  }
}
