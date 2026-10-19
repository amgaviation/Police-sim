/**
 * Line of sight inside an interior (design §5.6): walls and closed door panels are 2D lines of ceiling height,
 * furniture is a set of AABBs. Allocation-free.
 */
import type { InteriorLayout } from './types';

/** True = the opening is clear (open, broken or wide). */
export type DoorOpen = (door: number) => boolean;

/** Endpoints this close to a line do not count as crossing it (m). */
const TOUCH = 1e-4;
const SPAN_SLACK = 1e-6;

/** Does a->b properly cross the axis-aligned line (vertical: x = c over [lo, hi] in z; else z = c over [lo, hi] in x)? */
function crosses(vertical: boolean, c: number, lo: number, hi: number, ax: number, az: number, bx: number, bz: number): boolean {
  const da = (vertical ? ax : az) - c;
  const db = (vertical ? bx : bz) - c;
  if (!((da > TOUCH && db < -TOUCH) || (da < -TOUCH && db > TOUCH))) return false;
  const t = da / (da - db);
  const along = vertical ? az + t * (bz - az) : ax + t * (bx - ax);
  return along >= lo - SPAN_SLACK && along <= hi + SPAN_SLACK;
}

/**
 * 2D: does the segment a->b cross a wall line or the panel line of a closed door? Proper crossings only
 * (endpoints within 1e-4 of a line do not count).
 */
export function wallsBlock(layout: InteriorLayout, open: DoorOpen, ax: number, az: number, bx: number, bz: number): boolean {
  const w = layout.walls;
  for (let i = 0; i < w.length; i += 4) {
    const x0 = w[i] as number, z0 = w[i + 1] as number, x1 = w[i + 2] as number, z1 = w[i + 3] as number;
    if (x0 === x1) {
      if (crosses(true, x0, Math.min(z0, z1), Math.max(z0, z1), ax, az, bx, bz)) return true;
    } else if (crosses(false, z0, Math.min(x0, x1), Math.max(x0, x1), ax, az, bx, bz)) return true;
  }
  const doors = layout.doors;
  for (let i = 0; i < doors.length; i++) {
    const d = doors[i] as InteriorLayout['doors'][number];
    if (d.kind === 'wide' || open(i)) continue;
    const half = d.width / 2;
    if (d.axis === 'x' ? crosses(false, d.z, d.x - half, d.x + half, ax, az, bx, bz) : crosses(true, d.x, d.z - half, d.z + half, ax, az, bx, bz)) return true;
  }
  return false;
}

/**
 * 3D: does a->b (y relative to the floor) pass through any furniture AABB [minX,maxX]x[0,h]x[minZ,maxZ]? Slab test;
 * `ignore` skips one furniture index (the surface an item lies on).
 */
export function furnitureBlocks(layout: InteriorLayout, ax: number, ay: number, az: number, bx: number, by: number, bz: number, ignore = -1): boolean {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const items = layout.furniture;
  for (let i = 0; i < items.length; i++) {
    if (i === ignore) continue;
    const p = items[i] as InteriorLayout['furniture'][number];
    let t0 = 0, t1 = 1;
    // x slab
    if (Math.abs(dx) < 1e-12) {
      if (ax < p.minX || ax > p.maxX) continue;
    } else {
      let a = (p.minX - ax) / dx, b = (p.maxX - ax) / dx;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) continue;
    }
    // y slab (floor to top)
    if (Math.abs(dy) < 1e-12) {
      if (ay < 0 || ay > p.h) continue;
    } else {
      let a = (0 - ay) / dy, b = (p.h - ay) / dy;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) continue;
    }
    // z slab
    if (Math.abs(dz) < 1e-12) {
      if (az < p.minZ || az > p.maxZ) continue;
    } else {
      let a = (p.minZ - az) / dz, b = (p.maxZ - az) / dz;
      if (a > b) { const t = a; a = b; b = t; }
      if (a > t0) t0 = a;
      if (b < t1) t1 = b;
      if (t0 > t1) continue;
    }
    return true;
  }
  return false;
}

/** True when nothing blocks the 3D segment a->b (walls, closed doors, furniture). */
export function lineOfSight(layout: InteriorLayout, open: DoorOpen, ax: number, ay: number, az: number, bx: number, by: number, bz: number, ignore = -1): boolean {
  return !wallsBlock(layout, open, ax, az, bx, bz) && !furnitureBlocks(layout, ax, ay, az, bx, by, bz, ignore);
}
