import type { VehicleModel } from '../../vehicles/model';
import { spotlightHousing } from '../vehicles/carParts';

/** A point in the vehicle frame (origin = body box centre, -Z front, -X left). */
export interface LocalPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Spotlight origin and unit beam direction in the vehicle frame. */
export interface SpotlightPose {
  x: number;
  y: number;
  z: number;
  dx: number;
  dy: number;
  dz: number;
}

/** The spotlight lamp: front face centre of the A-pillar housing (`spotlightHousing`). Allocates; cache per model. */
export function spotlightMount(model: VehicleModel): LocalPoint {
  const h = spotlightHousing(model);
  return { x: h.x, y: h.y, z: h.z - h.sz / 2 };
}

/**
 * Beam pose in the vehicle frame: origin at `mount`, direction = straight ahead (-Z) turned by `yaw`
 * (rad, + = left, i.e. toward -X) and tilted by `pitch` (rad, + = up). Allocation-free.
 */
export function spotlightPose(mount: LocalPoint, yaw: number, pitch: number, out: SpotlightPose): SpotlightPose {
  const cp = Math.cos(pitch);
  out.x = mount.x;
  out.y = mount.y;
  out.z = mount.z;
  out.dx = -Math.sin(yaw) * cp;
  out.dy = Math.sin(pitch);
  out.dz = -Math.cos(yaw) * cp;
  return out;
}
