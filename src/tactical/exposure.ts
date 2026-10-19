/** How much of the officer a viewer can see (design §7.2). Pure and allocation-free. */
import type { InteriorLayout } from '../interior/types';
import type { TacticsConfig } from './data';
import type { StanceState } from './stance';

/** Head, chest and hip heights above the floor. */
const STANDING = [1.6, 1.2, 0.8] as const;
const CROUCHED = [1.0, 0.75, 0.45] as const;

/**
 * Three body points (head, chest, hips) of the officer at (x, z): standing y 1.6 / 1.2 / 0.8, crouched 1.0 / 0.75 /
 * 0.45; the head point is shifted sideways by `leanAmount x leanOffset` (towards the officer's right when positive).
 * Writes x, y, z (y above the floor) for each into `out` (length >= 9) and returns it.
 */
export function bodyPoints(x: number, z: number, yaw: number, stance: StanceState, cfg: TacticsConfig, out: Float32Array): Float32Array {
  const heights = stance.crouched ? CROUCHED : STANDING;
  const side = stance.leanAmount * cfg.stance.leanOffset;
  for (let i = 0; i < 3; i++) {
    const lean = i === 0 ? side : 0;
    out[3 * i] = x + Math.cos(yaw) * lean;
    out[3 * i + 1] = heights[i] as number;
    out[3 * i + 2] = z - Math.sin(yaw) * lean;
  }
  return out;
}

/** Endpoints this close to a wall line do not count as crossing it (m); matches `interior/los`. */
const TOUCH = 1e-4;
const SPAN_SLACK = 1e-6;

/**
 * Fraction (0, 1/3, 2/3, 1) of the three body points visible from the viewer eye (y above the floor): walls, closed
 * doors (`open` false) and furniture block. Outdoors (layout null) everything is visible.
 *
 * This is `lineOfSight` from `interior/los` (same tests, same results) written as one function with every number in a
 * local: the notice pass runs it for each listener, and calling the three-function original with eight doubles per ray
 * boxes them on every call.
 */
export function exposure(layout: InteriorLayout | null, open: (door: number) => boolean, ex: number, ey: number, ez: number, points: Float32Array): number {
  if (layout === null) return 1;
  const walls = layout.walls;
  const doors = layout.doors;
  const items = layout.furniture;
  let seen = 0;
  for (let p = 0; p < 3; p++) {
    const bx = points[3 * p] as number;
    const by = points[3 * p + 1] as number;
    const bz = points[3 * p + 2] as number;
    let blocked = false;
    // Walls (axis-aligned lines).
    for (let i = 0; i < walls.length && !blocked; i += 4) {
      const x0 = walls[i] as number;
      const z0 = walls[i + 1] as number;
      const x1 = walls[i + 2] as number;
      const z1 = walls[i + 3] as number;
      const vertical = x0 === x1;
      const da = vertical ? ex - x0 : ez - z0;
      const db = vertical ? bx - x0 : bz - z0;
      if (!((da > TOUCH && db < -TOUCH) || (da < -TOUCH && db > TOUCH))) continue;
      const t = da / (da - db);
      const along = vertical ? ez + t * (bz - ez) : ex + t * (bx - ex);
      const lo = vertical ? Math.min(z0, z1) : Math.min(x0, x1);
      const hi = vertical ? Math.max(z0, z1) : Math.max(x0, x1);
      if (along >= lo - SPAN_SLACK && along <= hi + SPAN_SLACK) blocked = true;
    }
    // Door panels of closed doors (wide openings have none).
    for (let i = 0; i < doors.length && !blocked; i++) {
      const d = doors[i] as InteriorLayout['doors'][number];
      if (d.kind === 'wide' || open(i)) continue;
      const half = d.width / 2;
      const alongX = d.axis === 'x';
      const da = alongX ? ez - d.z : ex - d.x;
      const db = alongX ? bz - d.z : bx - d.x;
      if (!((da > TOUCH && db < -TOUCH) || (da < -TOUCH && db > TOUCH))) continue;
      const t = da / (da - db);
      const along = alongX ? ex + t * (bx - ex) : ez + t * (bz - ez);
      const centre = alongX ? d.x : d.z;
      if (along >= centre - half - SPAN_SLACK && along <= centre + half + SPAN_SLACK) blocked = true;
    }
    // Furniture boxes [minX, maxX] x [0, h] x [minZ, maxZ] (slab test).
    const dx = bx - ex;
    const dy = by - ey;
    const dz = bz - ez;
    for (let i = 0; i < items.length && !blocked; i++) {
      const f = items[i] as InteriorLayout['furniture'][number];
      let t0 = 0;
      let t1 = 1;
      if (Math.abs(dx) < 1e-12) {
        if (ex < f.minX || ex > f.maxX) continue;
      } else {
        let a = (f.minX - ex) / dx;
        let b = (f.maxX - ex) / dx;
        if (a > b) {
          const t = a;
          a = b;
          b = t;
        }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        if (t0 > t1) continue;
      }
      if (Math.abs(dy) < 1e-12) {
        if (ey < 0 || ey > f.h) continue;
      } else {
        let a = (0 - ey) / dy;
        let b = (f.h - ey) / dy;
        if (a > b) {
          const t = a;
          a = b;
          b = t;
        }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        if (t0 > t1) continue;
      }
      if (Math.abs(dz) < 1e-12) {
        if (ez < f.minZ || ez > f.maxZ) continue;
      } else {
        let a = (f.minZ - ez) / dz;
        let b = (f.maxZ - ez) / dz;
        if (a > b) {
          const t = a;
          a = b;
          b = t;
        }
        if (a > t0) t0 = a;
        if (b < t1) t1 = b;
        if (t0 > t1) continue;
      }
      blocked = true;
    }
    if (!blocked) seen++;
  }
  return seen / 3;
}
