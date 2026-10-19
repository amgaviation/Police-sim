/** Scene tape geometry (design phase 4 §10.2): the no-go polygon of a closed tape and the props laid along it. Pure. */
import type { NoGoZone } from './types';

/** Longest tape: posts the officer may set. */
export const MAX_TAPE_POSTS = 16;
/** Shortest closed tape. */
export const MIN_CLOSED_POSTS = 3;
/** One tape prop covers this much of a segment (the prop is a 3 m run of tape plus a post). */
export const TAPE_SPACING = 3;
/** A new post must be at least this far from the last one. */
export const MIN_POST_GAP = 1;

/** Yaw (project convention: forward = (-sin yaw, -cos yaw)) of the direction (dx, dz). */
export function yawOf(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/** The no-go zone of a closed tape (`points` are x, z pairs). */
export function tapeZone(id: number, points: readonly number[]): NoGoZone {
  const pts = new Float32Array(points.length);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i + 1 < points.length; i += 2) {
    const x = points[i] as number;
    const z = points[i + 1] as number;
    pts[i] = x;
    pts[i + 1] = z;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { id, points: pts, minX, minZ, maxX, maxZ };
}

/**
 * Calls `put(x, z, yaw)` for every tape prop of a tape: one per post facing the next post (a closed tape wraps;
 * the last post of an open tape keeps the direction of its segment) plus one every 3 m along each segment.
 * Stops early when `put` returns false (the prop buffer is full).
 */
export function layTape(points: readonly number[], closed: boolean, put: (x: number, z: number, yaw: number) => boolean): void {
  const n = points.length >> 1;
  if (n === 0) return;
  const segments = closed ? n : n - 1;
  for (let i = 0; i < segments; i++) {
    const ax = points[2 * i] as number;
    const az = points[2 * i + 1] as number;
    const j = (i + 1) % n;
    const bx = points[2 * j] as number;
    const bz = points[2 * j + 1] as number;
    const dx = bx - ax;
    const dz = bz - az;
    const len = Math.hypot(dx, dz);
    const yaw = yawOf(dx, dz);
    if (!put(ax, az, yaw)) return;
    if (len < 1e-6) continue;
    for (let d = TAPE_SPACING; d < len - 0.5; d += TAPE_SPACING) {
      if (!put(ax + (dx / len) * d, az + (dz / len) * d, yaw)) return;
    }
  }
  if (!closed) {
    const lx = points[2 * (n - 1)] as number;
    const lz = points[2 * (n - 1) + 1] as number;
    let yaw = 0;
    if (n > 1) yaw = yawOf(lx - (points[2 * (n - 2)] as number), lz - (points[2 * (n - 2) + 1] as number));
    put(lx, lz, yaw);
  }
}
