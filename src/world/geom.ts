/** Distance from (x, z) to a polyline stored as x0, z0, x1, z1, ... (allocation-free). */
export function distanceToPolyline(points: Float32Array, x: number, z: number): number {
  let best = Infinity;
  for (let i = 0; i + 3 < points.length; i += 2) {
    const ax = points[i] ?? 0;
    const az = points[i + 1] ?? 0;
    const dx = (points[i + 2] ?? 0) - ax;
    const dz = (points[i + 3] ?? 0) - az;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = ax + dx * t - x;
    const ez = az + dz * t - z;
    const d2 = ex * ex + ez * ez;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/** Squared distance from (x, z) to the rectangle [minX, maxX] x [minZ, maxZ] (0 inside). */
export function rectDistanceSq(minX: number, minZ: number, maxX: number, maxZ: number, x: number, z: number): number {
  const dx = x < minX ? minX - x : x > maxX ? x - maxX : 0;
  const dz = z < minZ ? minZ - z : z > maxZ ? z - maxZ : 0;
  return dx * dx + dz * dz;
}

/** Yaw (yaw 0 faces -Z, CCW positive) of a heading vector. */
export function yawOf(hx: number, hz: number): number {
  return Math.atan2(-hx, -hz);
}
