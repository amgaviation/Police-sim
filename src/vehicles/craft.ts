import type { CraftSpec } from './model';

/** Kinematic craft kinds, a subset of `CONTROL_KINDS`. */
export const CRAFT_KINDS = ['boat', 'helicopter', 'drone'] as const;
export type CraftKind = (typeof CRAFT_KINDS)[number];

/**
 * Integrator state of one craft. `x`, `y`, `z` are the body-centre position owned by the caller (the physics body after
 * collisions); `stepCraft` advances `speed`, `vy`, `yaw`, `pitch` and `roll`. Yaw 0 faces -Z and a positive yaw turns left.
 */
export interface CraftState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  /** Signed speed along the heading (m/s, + = ahead). */
  speed: number;
  vy: number;
  /** Visual attitude (rad): + pitch = nose up, + roll = right side up. */
  pitch: number;
  roll: number;
}

/** forward -1..1 (+ = ahead), steer -1..1 (+ = right), lift -1..1 (+ = climb). */
export interface CraftInput {
  forward: number;
  steer: number;
  lift: number;
}

/** What the craft needs from the world each step. */
export interface CraftEnv {
  groundY: number;
  waterY: number;
  engineOk: boolean;
  /** Leash anchor (only used when `spec.rangeM > 0`). */
  anchorX: number;
  anchorZ: number;
}

/** Desired translation (before collisions) and attitude of the step. */
export interface CraftStep {
  dx: number;
  dy: number;
  dz: number;
  yaw: number;
  pitch: number;
  roll: number;
  /** The craft sits on the floor (helicopter / drone) at the end of the step. */
  landed: boolean;
}

/** Vertical acceleration limit of the aircraft (m/s²) and the descent rate with a dead engine (m/s). */
const VERTICAL_ACCEL = 4;
const DEAD_ENGINE_SINK = 6;
/** Descent rate (m/s) a pilot-commanded landing flares down to at touchdown; well under the hard-landing threshold. */
const FLARE_TOUCHDOWN_MPS = 1;
/** Speed (m/s) from which the boat steers fully, and its floor factor at rest. */
const STEER_FULL_SPEED = 3;
const BOAT_MIN_STEER = 0.15;
const DEG = Math.PI / 180;

export function createCraftState(x: number, y: number, z: number, yaw: number): CraftState {
  return { x, y, z, yaw, speed: 0, vy: 0, pitch: 0, roll: 0 };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * One fixed step of a boat, helicopter or drone (design §5.3). Advances `s.speed`, `s.vy`, `s.yaw`, `s.pitch`
 * and `s.roll` in place and writes the desired translation and attitude into `out`; the caller moves the body
 * (through the character controller) and keeps `s.x`, `s.y`, `s.z` in sync. Allocation-free.
 */
export function stepCraft(
  kind: CraftKind,
  spec: CraftSpec,
  clearance: number,
  s: CraftState,
  input: CraftInput,
  dt: number,
  env: CraftEnv,
  out: CraftStep,
): CraftStep {
  const forward = clamp(input.forward, -1, 1) || 0;
  const steer = clamp(input.steer, -1, 1) || 0;
  const lift = clamp(input.lift, -1, 1) || 0;
  const boat = kind === 'boat';

  // 1. Speed.
  let accel = 0;
  if (env.engineOk) {
    if (forward > 0) accel = forward * spec.accelMps2;
    else if (forward < 0) accel = s.speed > 0.5 ? forward * spec.brakeMps2 : forward * spec.accelMps2;
  }
  s.speed += accel * dt;
  const drag = spec.dragPerS * (env.engineOk ? 1 : 3) * dt;
  s.speed -= s.speed * (drag < 1 ? drag : 1);
  s.speed = clamp(s.speed, -spec.reverseMps, spec.maxSpeedMps);

  // 2. Yaw: steering right decreases the yaw. Hovering crafts turn in place, the boat needs way on.
  let rate = steer * spec.turnRateDegS * DEG * clamp(Math.abs(s.speed) / STEER_FULL_SPEED, boat ? BOAT_MIN_STEER : 1, 1);
  if (boat && s.speed < -0.1) rate = -rate;
  out.yaw = s.yaw - rate * dt;
  s.yaw = out.yaw;

  // 3. Vertical.
  out.landed = false;
  if (boat) {
    out.dy = env.waterY + clearance - s.y;
    s.vy = 0;
  } else {
    const floor = env.groundY + clearance;
    let targetVy = env.engineOk ? lift * spec.climbMps : -DEAD_ENGINE_SINK;
    if (env.engineOk && lift < 0) {
      // Landing flare: a commanded descent slows so the craft can always stop within the height that is left.
      const h = Math.max(0, s.y - floor);
      targetVy = Math.max(targetVy, -(FLARE_TOUCHDOWN_MPS + 2 * Math.sqrt(h)));
    }
    s.vy += clamp(targetVy - s.vy, -VERTICAL_ACCEL * dt, VERTICAL_ACCEL * dt);
    let ny = s.y + s.vy * dt;
    const ceiling = floor + spec.maxAltitudeM;
    if (ny <= floor) {
      ny = floor;
      s.vy = 0;
      out.landed = true;
    } else if (ny >= ceiling) {
      ny = ceiling;
      if (s.vy > 0) s.vy = 0;
    }
    if (out.landed && lift <= 0) s.speed *= Math.max(0, 1 - 4 * dt);
    out.dy = ny - s.y;
  }

  // 4. Horizontal, with the drone's leash.
  const fx = -Math.sin(s.yaw);
  const fz = -Math.cos(s.yaw);
  const d = s.speed * dt;
  out.dx = fx * d;
  out.dz = fz * d;
  if (spec.rangeM > 0) {
    const range = spec.rangeM;
    const cx = s.x - env.anchorX;
    const cz = s.z - env.anchorZ;
    const nx = cx + out.dx;
    const nz = cz + out.dz;
    const nSq = nx * nx + nz * nz;
    if (nSq > range * range && nSq > cx * cx + cz * cz) {
      // Drop the outward radial component of the move, then pull what is left back onto the circle.
      const cLen = Math.hypot(cx, cz);
      if (cLen > 1e-9) {
        const radial = (out.dx * cx + out.dz * cz) / cLen;
        if (radial > 0) {
          out.dx -= (radial * cx) / cLen;
          out.dz -= (radial * cz) / cLen;
        }
      }
      const px = cx + out.dx;
      const pz = cz + out.dz;
      const pLen = Math.hypot(px, pz);
      if (pLen > range) {
        const k = range / pLen;
        out.dx = px * k - cx;
        out.dz = pz * k - cz;
      }
      s.speed *= 0.5;
    }
  }

  // 5. Attitude (visual only).
  const tilt = spec.tiltDeg * DEG;
  const lean = (s.speed / spec.maxSpeedMps) * tilt;
  // `0 -` rather than a negation keeps +0 (not -0) at rest, so saves and comparisons stay tidy.
  out.pitch = boat ? 0.3 * lean : 0 - lean;
  out.roll = 0 - steer * tilt * Math.min(Math.abs(s.speed) / 10, 1) * 0.5;
  s.pitch = out.pitch;
  s.roll = out.roll;
  return out;
}
