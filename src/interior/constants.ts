/** Interior constants (design §4.1). Interiors live below grade, one floor per building. */

/** Feet height of every interior floor (officer body centre = -39.1). */
export const INTERIOR_FLOOR_Y = -40;
/** Floor to ceiling (m). */
export const WALL_HEIGHT = 3;
/** Collider / mesh thickness; line of sight treats walls as lines. */
export const WALL_THICKNESS = 0.15;
/** Interior and front doors (m). */
export const DOOR_WIDTH = 0.9;
/** Garage, sally port, loading and deck openings (m). */
export const WIDE_DOOR_WIDTH = 2.8;
export const DOOR_HEIGHT = 2.1;
/** BSP / slab minimum room side (m). */
export const MIN_ROOM_SIDE = 2.6;
/** Interiors become resident within this distance of an entrance (m). */
export const STREAM_RADIUS = 25;
/** Resident interiors (the officer's + the nearest entrance). */
export const MAX_RESIDENT = 2;

/** Level of a building id: feet y of its floor; -1 (outdoors) maps to 0. */
export function levelY(building: number): number {
  return building >= 0 ? INTERIOR_FLOOR_Y : 0;
}
