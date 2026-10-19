/** Door slicing: a slow "pie" around a doorway (design §7.2). Pure. */
import type { InteriorDoor, InteriorLayout } from '../interior/types';
import type { TacticsConfig } from './data';
import type { DoorStateName } from './types';

export interface SliceDoor {
  x: number;
  z: number;
  /** Unit normal of the door plane pointing to the officer's side. */
  nx: number;
  nz: number;
}

export function createSliceDoor(): SliceDoor {
  return { x: 0, z: 0, nx: 0, nz: 1 };
}

/**
 * Picks the open doorway (open, broken or wide) within `engageM` of the officer and within `engageCone` of its facing
 * direction (the nearest one; ties: lower index). Writes the door centre and the normal pointing to the officer's
 * side into `out`; returns the door index, -1 for none.
 */
export function pickSliceDoor(layout: InteriorLayout, state: (door: number) => DoorStateName, x: number, z: number, yaw: number, cfg: TacticsConfig, out: SliceDoor): number {
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const cosCone = Math.cos(cfg.slice.engageCone);
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < layout.doors.length; i++) {
    const d = layout.doors[i] as InteriorDoor;
    if (d.kind !== 'wide') {
      const s = state(i);
      if (s !== 'open' && s !== 'broken') continue;
    }
    const dx = d.x - x;
    const dz = d.z - z;
    const dist = Math.hypot(dx, dz);
    if (dist > cfg.slice.engageM || dist >= bestD) continue;
    if (dist > 1e-6 && (dx * fx + dz * fz) / dist < cosCone) continue;
    best = i;
    bestD = dist;
  }
  if (best < 0) return -1;
  const d = layout.doors[best] as InteriorDoor;
  out.x = d.x;
  out.z = d.z;
  // axis 'x': the opening runs along X, so the normal is +-Z.
  const side = (d.axis === 'x' ? z - d.z : x - d.x) < 0 ? -1 : 1;
  out.nx = d.axis === 'x' ? 0 : side;
  out.nz = d.axis === 'x' ? side : 0;
  return best;
}

/**
 * One slicing step. Polar coordinates around the door centre: strafe changes the angle from the door normal at
 * `speed / r` rad/s (right = +), forward / back change the radius at `radialSpeed` m/s within [radiusMin, radiusMax];
 * the angle is clamped to +-`maxAngle` (under a quarter turn, so the officer never crosses the door plane). Writes the
 * target position and the yaw that faces the door centre.
 */
export function sliceStep(x: number, z: number, door: SliceDoor, forward: number, strafe: number, dt: number, cfg: TacticsConfig, out: { x: number; z: number; yaw: number }): void {
  // Tangent such that a positive angle moves to the right of an officer facing the door (facing -normal).
  const tx = door.nz;
  const tz = -door.nx;
  const dx = x - door.x;
  const dz = z - door.z;
  let r = Math.hypot(dx, dz);
  let angle = Math.atan2(dx * tx + dz * tz, dx * door.nx + dz * door.nz);
  const c = cfg.slice;
  r = Math.min(c.radiusMax, Math.max(c.radiusMin, r - forward * c.radialSpeed * dt));
  angle += (strafe * c.speed * dt) / r;
  angle = Math.min(c.maxAngle, Math.max(-c.maxAngle, angle));
  const ca = Math.cos(angle) * r;
  const sa = Math.sin(angle) * r;
  out.x = door.x + door.nx * ca + tx * sa;
  out.z = door.z + door.nz * ca + tz * sa;
  out.yaw = Math.atan2(out.x - door.x, out.z - door.z);
}
