/**
 * Crew figures of on-scene units (design §8.6): pure placement beside the vehicle.
 */

/** Distance of the crew from the vehicle centreline (m, to the right). */
export const CREW_SIDE_M = 2.2;
/** Spacing between crew members along the vehicle (m). */
export const CREW_SPACING_M = 0.9;
/** The rear axle is this far behind the vehicle centre (m). */
export const REAR_AXLE_M = 1.3;

/** Where a figure stands. */
export interface CrewSpot {
  x: number;
  z: number;
  yaw: number;
}

/**
 * The k-th of n crew members: `CREW_SIDE_M` to the right of the vehicle's rear axle, spaced `CREW_SPACING_M`
 * along the vehicle, facing away from it. Yaw convention: 0 faces -Z (heading = (-sin yaw, -cos yaw)).
 * Allocation-free; returns `out`.
 */
export function crewSpot(vehicleX: number, vehicleZ: number, vehicleYaw: number, k: number, n: number, out: CrewSpot): CrewSpot {
  const hx = -Math.sin(vehicleYaw);
  const hz = -Math.cos(vehicleYaw);
  // Right of the heading in the x-z plane.
  const rx = -hz;
  const rz = hx;
  const along = -REAR_AXLE_M + (k - (n - 1) / 2) * CREW_SPACING_M;
  out.x = vehicleX + hx * along + rx * CREW_SIDE_M;
  out.z = vehicleZ + hz * along + rz * CREW_SIDE_M;
  out.yaw = Math.atan2(-rx, -rz);
  return out;
}
