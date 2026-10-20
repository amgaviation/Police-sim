/**
 * Jurisdiction: the city limits are a rectangle (design §10.2, §21). Pure functions.
 */
import { PURSUIT_CONFIG } from './data';
import type { PursuitConfig } from './types';

/** Is (x, z) inside the city limits (borders included)? */
export function inCity(x: number, z: number, cfg: PursuitConfig = PURSUIT_CONFIG): boolean {
  const c = cfg.handoff.cityLimits;
  return x >= c.minX && x <= c.maxX && z >= c.minZ && z <= c.maxZ;
}

/**
 * Seconds until the point leaves the city limits moving at `speedMps` along `yaw` (0 = facing -Z) in a straight
 * line: 0 when already outside, Infinity when it is not moving (or never reaches a border).
 */
export function timeToBoundary(x: number, z: number, yaw: number, speedMps: number, cfg: PursuitConfig = PURSUIT_CONFIG): number {
  if (!inCity(x, z, cfg)) return 0;
  if (!(speedMps > 0)) return Infinity;
  const c = cfg.handoff.cityLimits;
  const dx = -Math.sin(yaw), dz = -Math.cos(yaw);
  const tx = dx > 1e-12 ? (c.maxX - x) / dx : dx < -1e-12 ? (c.minX - x) / dx : Infinity;
  const tz = dz > 1e-12 ? (c.maxZ - z) / dz : dz < -1e-12 ? (c.minZ - z) / dz : Infinity;
  const t = Math.min(tx, tz);
  return t === Infinity ? Infinity : t / speedMps;
}
