/**
 * Air unit flight (design §8.3): a pure, allocation-free step. The aircraft flies straight at the goal at the
 * cruise speed, switches to an orbit of `ORBIT_R` metres around it, and climbs / descends at `CLIMB_MPS`.
 * Yaw follows the velocity with a limited turn rate (presentation only; the position does not depend on it).
 */

/** Orbit radius around the target (m). */
export const ORBIT_R = 120;
/** The unit is "on target" within this horizontal distance (m). */
export const ON_TARGET_M = 200;
/** Take-off / landing vertical speed (m/s). */
export const CLIMB_MPS = 8;
/** Maximum yaw rate (rad/s). */
export const MAX_TURN = 0.6;
/** FLIR reveal radius around the target (m) and scan interval (s). */
export const REVEAL_M = 80;
export const REVEAL_EVERY_S = 0.5;
/** Time on station after arrival before the unit returns to base (sim s). */
export const ON_STATION_S = 900;
/** The orbit angular speed is this fraction of cruise speed / radius. */
const ORBIT_SPEED_FACTOR = 0.5;

export const AIR_TARGET_KINDS = ['vehicle', 'actor', 'point', 'none'] as const;
export type AirTargetKind = (typeof AIR_TARGET_KINDS)[number];

/** Pose and target of the air unit. `tx`, `tz` hold the last resolved target point. */
export interface AirState {
  x: number;
  y: number;
  z: number;
  yaw: number;
  targetKind: AirTargetKind;
  targetId: number;
  tx: number;
  tz: number;
  onStationUntil: number;
}

/** A parked aircraft at (x, z) with no target. */
export function newAirState(x: number, z: number): AirState {
  return { x, y: 0, z, yaw: 0, targetKind: 'none', targetId: 0, tx: x, tz: z, onStationUntil: -1 };
}

function wrapPi(a: number): number {
  const twoPi = Math.PI * 2;
  let r = (a + Math.PI) % twoPi;
  if (r < 0) r += twoPi;
  return r - Math.PI;
}

/**
 * Advances the aircraft one step toward (goalX, goalZ). With `orbit` true it circles the goal once within
 * `ORBIT_R + 1` m of it; otherwise it flies to the goal and stops there. `targetY` is the height it climbs or
 * descends to. Returns nothing; mutates `s`.
 */
export function stepAir(s: AirState, dt: number, goalX: number, goalZ: number, orbit: boolean, targetY: number, speedMps: number): void {
  const ox = s.x;
  const oz = s.z;
  const dx = goalX - s.x;
  const dz = goalZ - s.z;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (orbit && d <= ORBIT_R + 1) {
    const theta = Math.atan2(s.z - goalZ, s.x - goalX) + ((speedMps * ORBIT_SPEED_FACTOR) / ORBIT_R) * dt;
    const maxRadial = speedMps * dt;
    const diff = ORBIT_R - d;
    const radius = d + (diff < -maxRadial ? -maxRadial : diff > maxRadial ? maxRadial : diff);
    s.x = goalX + Math.cos(theta) * radius;
    s.z = goalZ + Math.sin(theta) * radius;
  } else if (d > 1e-6) {
    const step = Math.min(speedMps * dt, d);
    s.x += (dx / d) * step;
    s.z += (dz / d) * step;
  }
  const vx = s.x - ox;
  const vz = s.z - oz;
  if (vx * vx + vz * vz > 1e-12) {
    const diff = wrapPi(Math.atan2(-vx, -vz) - s.yaw);
    const maxTurn = MAX_TURN * dt;
    s.yaw = wrapPi(s.yaw + (diff < -maxTurn ? -maxTurn : diff > maxTurn ? maxTurn : diff));
  }
  const dy = targetY - s.y;
  const maxClimb = CLIMB_MPS * dt;
  s.y += dy < -maxClimb ? -maxClimb : dy > maxClimb ? maxClimb : dy;
}

/** Within `ON_TARGET_M` (horizontal) of the target point. */
export function airOnTarget(s: AirState, tx: number, tz: number): boolean {
  const dx = tx - s.x;
  const dz = tz - s.z;
  return dx * dx + dz * dz <= ON_TARGET_M * ON_TARGET_M;
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'] as const;

/** Compass word of the direction from (fromX, fromZ) to (toX, toZ); north is -Z, east is +X. */
export function compassWord(fromX: number, fromZ: number, toX: number, toZ: number): string {
  const a = Math.atan2(toX - fromX, -(toZ - fromZ));
  const k = Math.round((a < 0 ? a + Math.PI * 2 : a) / (Math.PI / 4)) % 8;
  return COMPASS[k] ?? 'north';
}
