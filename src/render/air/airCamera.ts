import type { AirView } from '../../resources/types';

/** Camera pose of the air unit camera (FLIR): position, look-at point and vertical field of view (degrees). */
export interface AirCameraPose {
  x: number;
  y: number;
  z: number;
  lookX: number;
  lookY: number;
  lookZ: number;
  fov: number;
}

/** The camera hangs this far under the helicopter (m). */
export const AIR_CAMERA_DROP_M = 3;
/** Zoomed field of view (degrees) of the air unit camera. */
export const AIR_CAMERA_FOV = 25;

/** A fresh pose object to reuse every frame. */
export function createAirCameraPose(): AirCameraPose {
  return { x: 0, y: 0, z: 0, lookX: 0, lookY: 0, lookZ: 0, fov: AIR_CAMERA_FOV };
}

/**
 * Pose of the air unit camera: 3 m below the helicopter, looking at the ground point (targetX, 0, targetZ), fov 25.
 * Allocation-free; the app swaps its camera rig for this pose while FLIR is on.
 */
export function airCameraPose(air: Readonly<AirView>, out: AirCameraPose): AirCameraPose {
  out.x = air.x;
  out.y = air.y - AIR_CAMERA_DROP_M;
  out.z = air.z;
  out.lookX = air.targetX;
  out.lookY = 0;
  out.lookZ = air.targetZ;
  out.fov = AIR_CAMERA_FOV;
  return out;
}

/**
 * Yaw (rad, 0 faces -Z, positive turns toward -X: the world convention that `compassLabel` reads) of the camera's
 * horizontal look direction; 0 when it looks straight down.
 */
export function airCameraYaw(pose: Readonly<AirCameraPose>): number {
  const dx = pose.lookX - pose.x;
  const dz = pose.lookZ - pose.z;
  return dx === 0 && dz === 0 ? 0 : Math.atan2(-dx, -dz);
}

/** Height of the camera above the ground point it looks at (m), for the overlay's altitude readout. */
export function airCameraAltitude(pose: Readonly<AirCameraPose>): number {
  return pose.y - pose.lookY;
}
