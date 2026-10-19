import type { RoadEdge } from '../world/roadGraph';

/** Small allocation-free geometry helpers shared by the NPC pools. Yaw 0 faces -Z, so heading = (-sin yaw, -cos yaw). */

export const TWO_PI = Math.PI * 2;

/** Result of `sampleEdge`; a module-level scratch the callers read right away. */
export interface EdgeSample {
  /** Input: arc length along the centreline (clamped to the edge). */
  s: number;
  /** Point on the centreline. */
  x: number;
  z: number;
  /** Unit heading from `from` towards `to`. */
  hx: number;
  hz: number;
}

/** Point and heading at arc length `out.s` of an edge's centreline polyline (the input travels in `out` so no double crosses the call). */
export function sampleEdge(e: RoadEdge, out: EdgeSample): EdgeSample {
  const pts = e.points;
  const last = (pts.length >> 1) - 1;
  let remain = out.s < 0 ? 0 : out.s;
  let i = 0;
  let sx = 0;
  let sz = 0;
  let len = 1;
  for (; i < last; i++) {
    const x0 = pts[2 * i] ?? 0;
    const z0 = pts[2 * i + 1] ?? 0;
    const dx = (pts[2 * i + 2] ?? 0) - x0;
    const dz = (pts[2 * i + 3] ?? 0) - z0;
    len = Math.sqrt(dx * dx + dz * dz);
    sx = dx;
    sz = dz;
    if (remain <= len || i === last - 1) {
      const t = len > 1e-9 ? Math.min(remain / len, 1) : 0;
      out.x = x0 + dx * t;
      out.z = z0 + dz * t;
      break;
    }
    remain -= len;
  }
  if (len > 1e-9) {
    out.hx = sx / len;
    out.hz = sz / len;
  } else {
    out.hx = 1;
    out.hz = 0;
  }
  return out;
}

/** Yaw that faces along (dx, dz). */
export function yawOf(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/** Moves angle `a` towards `b` by at most `maxStep` radians along the short way. */
export function turnToward(a: number, b: number, maxStep: number): number {
  let d = b - a;
  d -= TWO_PI * Math.round(d / TWO_PI);
  if (d > maxStep) d = maxStep;
  else if (d < -maxStep) d = -maxStep;
  return a + d;
}

/** Is (x, z) inside the closed polygon `pts` (x, z pairs)? Even-odd ray casting, allocation-free. */
export function pointInPolygon(pts: Float32Array, x: number, z: number): boolean {
  const n = pts.length >> 1;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = pts[2 * i] as number;
    const zi = pts[2 * i + 1] as number;
    const xj = pts[2 * j] as number;
    const zj = pts[2 * j + 1] as number;
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}
