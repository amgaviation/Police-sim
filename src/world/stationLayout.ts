import type { Pose2 } from './city';

export interface Rect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export interface StationLayout {
  /** Building footprint minX, minZ, maxX, maxZ. */
  readonly building: readonly [number, number, number, number];
  readonly buildingHeight: number;
  /** Door, facing out over the lot (the session spawn). */
  readonly door: Pose2;
  /** Parking slots in the lot, cars facing the lot exit. */
  readonly slots: readonly Pose2[];
  readonly pump: Pose2;
  /** Point on the block edge at the lot front (used to find the entrance road). */
  readonly lotFront: { readonly x: number; readonly z: number };
}

/** Number of parking slots in the station lot. */
export const STATION_SLOTS = 6;
const SLOT_PITCH = 3.6;

/**
 * Fixed station set inside its block: the building sits at the back, the
 * lot (slots and fuel pump) in front of the door. `yaw` is snapped to a
 * quarter turn and is the direction the door faces.
 */
export function stationLayout(block: Rect, yaw: number): StationLayout {
  const q = (((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4);
  const snapped = q * (Math.PI / 2);
  // Front (door) direction f and its right r = (-fz, fx).
  const fx = Math.round(-Math.sin(snapped));
  const fz = Math.round(-Math.cos(snapped));
  const rx = -fz;
  const rz = fx;
  const cx = (block.minX + block.maxX) / 2;
  const cz = (block.minZ + block.maxZ) / 2;
  const sizeX = block.maxX - block.minX;
  const sizeZ = block.maxZ - block.minZ;
  const hf = (fx !== 0 ? sizeX : sizeZ) / 2;
  const hr = (fx !== 0 ? sizeZ : sizeX) / 2;
  const at = (u: number, v: number): { x: number; z: number } => ({ x: cx + rx * u + fx * v, z: cz + rz * u + fz * v });

  const back = -hf + 4;
  const depth = Math.min(28, hf * 0.55);
  const halfWidth = Math.min(30, hr - 6);
  const a = at(-halfWidth, back);
  const b = at(halfWidth, back + depth);
  const doorV = back + depth + 1.5;
  const door = at(0, doorV);
  const slots: Pose2[] = [];
  for (let k = 0; k < STATION_SLOTS; k++) {
    const p = at((k - (STATION_SLOTS - 1) / 2) * SLOT_PITCH, Math.min(doorV + 10, hf - 4));
    slots.push({ x: p.x, z: p.z, yaw: snapped });
  }
  const pump = at(Math.min(14, hr - 4), Math.min(doorV + 22, hf - 3));
  const front = at(0, hf);
  return {
    building: [Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z)],
    buildingHeight: 10,
    door: { x: door.x, z: door.z, yaw: snapped },
    slots,
    pump: { x: pump.x, z: pump.z, yaw: snapped },
    lotFront: front,
  };
}
