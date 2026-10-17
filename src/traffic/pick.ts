import { VEHICLE_MODELS } from '../vehicles/model';
import { isFleetVehicleId, type TrafficView } from './trafficSystem';

/**
 * Target lock for plate runs (design §7.5): a 2D ray (camera position + forward projected on XZ) against
 * every ambient car's oriented box inflated by `assist` m; fleet cars are skipped. Pure, allocation-free.
 */

export interface PickResult {
  slot: number;
  vehicleId: number;
  eid: number;
  /** Distance along the (normalised) ray to the box, 0 when the origin is inside it (m). */
  distance: number;
}

const HALF_LEN = Float64Array.from(VEHICLE_MODELS, (m) => m.body.length / 2);
const HALF_WID = Float64Array.from(VEHICLE_MODELS, (m) => m.body.width / 2);

/**
 * Nearest car hit by the ray from (ox, oz) along (dx, dz) within `maxDistance`; fills `out`, null on a miss
 * (or a zero direction). The box of a car is its model's body, `assist` metres larger on every side.
 */
export function pickTrafficCar(
  view: TrafficView,
  ox: number,
  oz: number,
  dx: number,
  dz: number,
  maxDistance: number,
  assist: number,
  out: PickResult,
): PickResult | null {
  const len = Math.hypot(dx, dz);
  if (!(len > 1e-9)) return null;
  const ux = dx / len, uz = dz / len;
  let best = -1;
  let bestT = maxDistance;
  for (let slot = 0; slot < view.count; slot++) {
    if (isFleetVehicleId(view.vehicleId[slot] ?? 0)) continue;
    const yaw = view.yaw[slot] ?? 0;
    // Heading (travel direction) of a car with this yaw; right = (-hz, hx).
    const hx = -Math.sin(yaw), hz = -Math.cos(yaw);
    const m = view.model[slot] ?? 0;
    const halfL = (HALF_LEN[m] ?? 2) + assist;
    const halfW = (HALF_WID[m] ?? 1) + assist;
    // Ray in the car's frame: `a` along its length, `b` across.
    const px = ox - (view.x[slot] ?? 0), pz = oz - (view.z[slot] ?? 0);
    const pa = px * hx + pz * hz, pb = -px * hz + pz * hx;
    const da = ux * hx + uz * hz, db = -ux * hz + uz * hx;
    let t0 = 0, t1 = bestT;
    // Slab along the length.
    if (Math.abs(da) < 1e-12) {
      if (pa < -halfL || pa > halfL) continue;
    } else {
      let ta = (-halfL - pa) / da, tb = (halfL - pa) / da;
      if (ta > tb) {
        const tmp = ta;
        ta = tb;
        tb = tmp;
      }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) continue;
    }
    // Slab across.
    if (Math.abs(db) < 1e-12) {
      if (pb < -halfW || pb > halfW) continue;
    } else {
      let ta = (-halfW - pb) / db, tb = (halfW - pb) / db;
      if (ta > tb) {
        const tmp = ta;
        ta = tb;
        tb = tmp;
      }
      if (ta > t0) t0 = ta;
      if (tb < t1) t1 = tb;
      if (t0 > t1) continue;
    }
    if (t0 < bestT || best < 0) {
      best = slot;
      bestT = t0;
    }
  }
  if (best < 0) return null;
  out.slot = best;
  out.vehicleId = view.vehicleId[best] ?? 0;
  out.eid = view.eid[best] ?? 0;
  out.distance = bestT;
  return out;
}
