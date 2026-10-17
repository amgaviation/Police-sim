import { ROAD_CLASS_NAMES } from '../../world/ids';

/** Pure text helpers and the minimap projection used by the HUD (no DOM). */

/** Whole mph, never negative (reversing shows the magnitude); "0" for non-finite input. */
export function formatSpeedMph(mph: number): string {
  return Number.isFinite(mph) ? String(Math.round(Math.abs(mph))) : '0';
}

/** `VehicleTelemetry.gear`: -1 -> "R", 0 -> "N", 1..n -> "1".."n". */
export function formatGear(gear: number): string {
  if (gear < 0) return 'R';
  if (gear === 0) return 'N';
  return String(Math.round(gear));
}

/** Fuel tank fraction (0..1) as a whole percentage, e.g. "57%". */
export function formatFuel(fraction: number): string {
  const f = Number.isFinite(fraction) ? Math.min(1, Math.max(0, fraction)) : 0;
  return `${String(Math.round(f * 100))}%`;
}

const ROAD_CLASS_LABELS: Record<(typeof ROAD_CLASS_NAMES)[number], string> = {
  highway: 'Highway',
  arterial: 'Arterial',
  collector: 'Collector',
  local: 'Local street',
  county: 'County road',
  gravel: 'Gravel road',
  service: 'Service road',
};

/** Display label for a `ROAD_CLASS` id ("Road" for an unknown id). */
export function roadClassLabel(roadClass: number): string {
  const name = ROAD_CLASS_NAMES[roadClass];
  return name === undefined ? 'Road' : ROAD_CLASS_LABELS[name];
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/**
 * Eight-point compass label for a yaw (design §2: yaw 0 faces north, positive yaw
 * turns counter-clockwise seen from above, so yaw +pi/2 faces west).
 */
export function compassLabel(yaw: number): string {
  if (!Number.isFinite(yaw)) return 'N';
  // Clockwise bearing from north.
  const bearing = -yaw / (Math.PI / 4);
  const index = ((Math.round(bearing) % 8) + 8) % 8;
  return COMPASS[index] ?? 'N';
}

/** Number on the limit sign: whole mph, or "--" when there is no limit to show. */
export function limitSignText(limitMph: number): string {
  return Number.isFinite(limitMph) && limitMph > 0 ? String(Math.round(limitMph)) : '--';
}

export interface MapPoint {
  x: number;
  y: number;
}

/**
 * Heading-up minimap projection: world point (wx, wz) relative to the player at
 * (px, pz) facing `yaw`, in pixels from the map centre (+x right, +y down; the
 * player's heading points up). Allocation-free; returns `out`.
 */
export function worldToMap(
  px: number,
  pz: number,
  yaw: number,
  wx: number,
  wz: number,
  metersPerPixel: number,
  out: MapPoint,
): MapPoint {
  const dx = wx - px;
  const dz = wz - pz;
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  // Heading h = (-sin, -cos); right of heading = (cos, -sin).
  const forward = -dx * s - dz * c;
  const right = dx * c - dz * s;
  out.x = right / metersPerPixel;
  out.y = -forward / metersPerPixel;
  return out;
}
