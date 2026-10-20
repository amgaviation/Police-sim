/**
 * Cover geometry of the backup officers (design §9.3), pure. World convention: yaw 0 faces -Z, so the yaw that faces
 * from (fx, fz) towards (tx, tz) is `atan2(-(tx - fx), -(tz - fz))`.
 */
import type { BackupConfig } from './types';

export interface SpotOut {
  x: number;
  z: number;
  yaw: number;
}

const DEG = Math.PI / 180;

/** Yaw that faces from (fx, fz) towards (tx, tz); 0 when they coincide. */
export function yawToward(fx: number, fz: number, tx: number, tz: number): number {
  const dx = tx - fx;
  const dz = tz - fz;
  return dx * dx + dz * dz > 1e-10 ? Math.atan2(-dx, -dz) : 0;
}

/** Spot at `distance` from the subject along the subject -> player vector rotated by `side * angleRad`. */
function rotatedSpot(px: number, pz: number, sx: number, sz: number, angleRad: number, distance: number, side: 1 | -1, out: SpotOut): void {
  let vx = px - sx;
  let vz = pz - sz;
  const len = Math.sqrt(vx * vx + vz * vz);
  if (len > 1e-6) {
    vx /= len;
    vz /= len;
  } else {
    vx = 0;
    vz = 1;
  }
  const a = side * angleRad;
  const c = Math.cos(a);
  const s = Math.sin(a);
  out.x = sx + (vx * c - vz * s) * distance;
  out.z = sz + (vx * s + vz * c) * distance;
  out.yaw = yawToward(out.x, out.z, sx, sz);
}

/**
 * Cover spot for an officer covering the player (px, pz) talking to subject (sx, sz): rotate the subject -> player
 * vector by +-angle (side = +1 / -1, the side away from traffic chosen by the caller), at `distance` from the subject.
 * The officer faces the subject.
 */
export function coverSpot(px: number, pz: number, sx: number, sz: number, angleRad: number, distance: number, side: 1 | -1, out: SpotOut): void {
  rotatedSpot(px, pz, sx, sz, angleRad, distance, side, out);
}

/** Poor position (mistake): beyond the subject on the line from the player (crossfire, `poorAngleDeg`) at `poorDistanceM`. */
export function poorCoverSpot(px: number, pz: number, sx: number, sz: number, cfg: BackupConfig, out: SpotOut): void {
  rotatedSpot(px, pz, sx, sz, cfg.cover.poorAngleDeg * DEG, cfg.cover.poorDistanceM, 1, out);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 0..1: 1 = ideal (45-60 degrees off the contact line and 4.5-6.5 m from the subject); 0 = in the crossfire line
 * (`poorAngleDeg` or more) or closer than `poorDistanceM`. The worse of the angle and distance scores.
 */
export function positionQuality(px: number, pz: number, sx: number, sz: number, ox: number, oz: number, cfg: BackupConfig): number {
  const ax = px - sx;
  const az = pz - sz;
  const bx = ox - sx;
  const bz = oz - sz;
  const dist = Math.sqrt(bx * bx + bz * bz);
  const angle = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz)) / DEG;
  const [aMin, aMax] = cfg.cover.angleDeg;
  let angleQ = 1;
  if (angle < aMin) angleQ = aMin > 0 ? angle / aMin : 1;
  else if (angle > aMax) angleQ = (cfg.cover.poorAngleDeg - angle) / (cfg.cover.poorAngleDeg - aMax);
  const [dMin, dMax] = cfg.cover.distanceM;
  let distQ = 1;
  if (dist < dMin) distQ = (dist - cfg.cover.poorDistanceM) / (dMin - cfg.cover.poorDistanceM);
  else if (dist > dMax) distQ = 1 - (dist - dMax) / dMax;
  return clamp01(Math.min(angleQ, distQ));
}
