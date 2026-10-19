/** K9 sweep helpers (design phase 4 §10.2): scents, the dog's route through the rooms and its position over time. Pure. */
import { K9_FIRST_ROOM_S, K9_ROOM_S, type K9Target } from '../evidence';
import type { InteriorLayout } from '../interior/types';

/** Seconds the dog and handler need to leave after the last room. */
export const K9_LEAVE_S = 3;
/** Seconds the handler trails the dog along its route. */
export const K9_HANDLER_LAG_S = 1.8;
const OUTDOOR_RADIUS = 6;
/** Seconds of each room slot spent sniffing around the room centre (the rest is walking to the next room). */
const SNIFF_S = 8;
const SNIFF_RADIUS = 0.6;

/** What the dog can smell for an item id. */
export function scentOf(item: string): K9Target['scent'] {
  switch (item) {
    case 'narcotics':
    case 'pills':
    case 'cannabis':
      return 'narcotics';
    case 'handgun':
    case 'shellCasing':
      return 'firearm';
    default:
      return 'other';
  }
}

/** Total length of a sweep over `rooms` rooms (4 s to the first, 12 s per room, then leaving). */
export function k9Duration(rooms: number): number {
  return K9_FIRST_ROOM_S + K9_ROOM_S * rooms + K9_LEAVE_S;
}

/** The dog's path: start (outside the door, or the search centre outdoors) and the centre of every room in order. */
export interface K9Route {
  readonly indoor: boolean;
  readonly floorY: number;
  readonly sx: number;
  readonly sz: number;
  readonly cx: readonly number[];
  readonly cz: readonly number[];
}

/** Route through `order` (room indices of `layout`), starting at (sx, sz); `layout` null = outdoors. */
export function k9Route(layout: InteriorLayout | null, order: readonly number[], sx: number, sz: number): K9Route {
  if (layout === null) return { indoor: false, floorY: 0, sx, sz, cx: [], cz: [] };
  const cx: number[] = [];
  const cz: number[] = [];
  for (const r of order) {
    const room = layout.rooms[r];
    if (!room) continue;
    cx.push((room.rect.minX + room.rect.maxX) / 2);
    cz.push((room.rect.minZ + room.rect.maxZ) / 2);
  }
  return { indoor: true, floorY: layout.floorY, sx, sz, cx, cz };
}

/** Writes the dog's x, y, z at `tau` seconds after the sweep started into `out`. */
export function k9Sample(route: K9Route, tau: number, out: Float64Array): void {
  if (!route.indoor) {
    const a = Math.max(0, tau) * 0.3;
    out[0] = route.sx + OUTDOOR_RADIUS * Math.cos(a);
    out[1] = 0;
    out[2] = route.sz + OUTDOOR_RADIUS * Math.sin(a);
    return;
  }
  const n = route.cx.length;
  if (n === 0 || tau <= 0) {
    out[0] = route.sx;
    out[1] = 0;
    out[2] = route.sz;
    return;
  }
  const c0x = route.cx[0] as number;
  const c0z = route.cz[0] as number;
  if (tau < K9_FIRST_ROOM_S) {
    const f = tau / K9_FIRST_ROOM_S;
    out[0] = route.sx + (c0x - route.sx) * f;
    out[1] = f < 0.4 ? 0 : route.floorY;
    out[2] = route.sz + (c0z - route.sz) * f;
    return;
  }
  out[1] = route.floorY;
  const slot = Math.floor((tau - K9_FIRST_ROOM_S) / K9_ROOM_S);
  if (slot >= n) {
    out[0] = route.cx[n - 1] as number;
    out[2] = route.cz[n - 1] as number;
    return;
  }
  const ph = tau - K9_FIRST_ROOM_S - slot * K9_ROOM_S;
  const x = route.cx[slot] as number;
  const z = route.cz[slot] as number;
  if (ph <= SNIFF_S || slot + 1 >= n) {
    const r = ph <= SNIFF_S ? SNIFF_RADIUS * Math.sin((ph * Math.PI) / SNIFF_S) : 0;
    out[0] = x + r * Math.cos(ph * 1.5);
    out[2] = z + r * Math.sin(ph * 1.5);
    return;
  }
  const f = (ph - SNIFF_S) / (K9_ROOM_S - SNIFF_S);
  out[0] = x + ((route.cx[slot + 1] as number) - x) * f;
  out[2] = z + ((route.cz[slot + 1] as number) - z) * f;
}
