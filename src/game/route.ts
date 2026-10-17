/** Distance (m) from (x, z) to a route polyline [x0, z0, x1, z1, ...]; Infinity for an empty one. */
export function distanceToPolyline(polyline: Float32Array, x: number, z: number): number {
  if (polyline.length === 2) return Math.hypot(x - (polyline[0] ?? 0), z - (polyline[1] ?? 0));
  let best = Infinity;
  for (let i = 0; i + 3 < polyline.length; i += 2) {
    const ax = polyline[i] ?? 0;
    const az = polyline[i + 1] ?? 0;
    const dx = (polyline[i + 2] ?? 0) - ax;
    const dz = (polyline[i + 3] ?? 0) - az;
    const len2 = dx * dx + dz * dz;
    const t = len2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / len2)) : 0;
    const d = Math.hypot(x - (ax + t * dx), z - (az + t * dz));
    if (d < best) best = d;
  }
  return best;
}
