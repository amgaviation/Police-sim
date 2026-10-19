/**
 * Room-graph navigation (design §5.5). Rooms are nodes, doors are edges; the BFS scratch buffers are
 * module-level so every call is allocation-free (they only grow for a layout with more rooms than they hold).
 */
import type { InteriorDoor, InteriorLayout } from './types';

/** True when the door can be walked through (the caller decides from door state). */
export type DoorPassable = (door: number) => boolean;

/** Waypoint distance either side of a door centre (m). */
const SIDE = 0.5;
/** How far inside an exterior door `exitPath` ends (m). */
const EXIT_INSIDE = 0.4;
const UNSEEN = -2;

let prevRoom = new Int32Array(64);
let prevDoor = new Int32Array(64);
let dist = new Int32Array(64);
let queue = new Int32Array(64);

function ensure(n: number): void {
  if (prevRoom.length >= n) return;
  const size = Math.max(n, prevRoom.length * 2);
  prevRoom = new Int32Array(size);
  prevDoor = new Int32Array(size);
  dist = new Int32Array(size);
  queue = new Int32Array(size);
}

/** Room index containing (x, z) (rect inclusive), -1 when none. */
export function roomAt(layout: InteriorLayout, x: number, z: number): number {
  const rooms = layout.rooms;
  for (let i = 0; i < rooms.length; i++) {
    const r = (rooms[i] as InteriorLayout['rooms'][number]).rect;
    if (x >= r.minX && x <= r.maxX && z >= r.minZ && z <= r.maxZ) return i;
  }
  return -1;
}

/** BFS from `start` (ties: lower door index); stops early at `goal` (-1: full). Returns the visited count. */
function search(layout: InteriorLayout, start: number, goal: number, passable: DoorPassable): number {
  const n = layout.rooms.length;
  ensure(n);
  for (let i = 0; i < n; i++) { prevRoom[i] = UNSEEN; prevDoor[i] = -1; dist[i] = 0; }
  prevRoom[start] = -1;
  queue[0] = start;
  let head = 0, tail = 1;
  while (head < tail) {
    const room = queue[head++] as number;
    if (room === goal) break;
    const ids = layout.roomDoors[room] as readonly number[];
    for (let k = 0; k < ids.length; k++) {
      const di = ids[k] as number;
      const d = layout.doors[di] as InteriorDoor;
      if (d.b < 0 || !passable(di)) continue;
      const next = d.a === room ? d.b : d.a;
      if (prevRoom[next] !== UNSEEN) continue;
      prevRoom[next] = room;
      prevDoor[next] = di;
      dist[next] = (dist[room] as number) + 1;
      queue[tail++] = next;
    }
  }
  return tail;
}

/** Sign (-1 / +1) of the side of the door's line that `room` lies on. */
function sideOf(layout: InteriorLayout, d: InteriorDoor, room: number): number {
  const r = (layout.rooms[room] as InteriorLayout['rooms'][number]).rect;
  const centre = d.axis === 'x' ? (r.minZ + r.maxZ) / 2 : (r.minX + r.maxX) / 2;
  return centre < (d.axis === 'x' ? d.z : d.x) ? -1 : 1;
}

/** Writes the two waypoints either side of door `di`, starting on `from`'s side, at point index `pi`. */
function writeCrossing(layout: InteriorLayout, di: number, from: number, pi: number, out: Float32Array): void {
  const d = layout.doors[di] as InteriorDoor;
  const s = sideOf(layout, d, from);
  if (d.axis === 'x') {
    out[2 * pi] = d.x; out[2 * pi + 1] = d.z + s * SIDE;
    out[2 * pi + 2] = d.x; out[2 * pi + 3] = d.z - s * SIDE;
  } else {
    out[2 * pi] = d.x + s * SIDE; out[2 * pi + 1] = d.z;
    out[2 * pi + 2] = d.x - s * SIDE; out[2 * pi + 3] = d.z;
  }
}

/** Writes the crossings along the BFS tree from the start to `to`; returns the point count (2 per hop) or -1. */
function writeRoute(layout: InteriorLayout, to: number, out: Float32Array): number {
  let hops = 0;
  for (let r = to; (prevRoom[r] as number) >= 0; r = prevRoom[r] as number) hops++;
  if (4 * hops + 2 > out.length) return -1;
  let idx = hops;
  for (let r = to; (prevRoom[r] as number) >= 0; r = prevRoom[r] as number) {
    idx--;
    writeCrossing(layout, prevDoor[r] as number, prevRoom[r] as number, 2 * idx, out);
  }
  return 2 * hops;
}

/**
 * Waypoints from (x, z) to (tx, tz) inside the layout: BFS over rooms through passable doors (ties: lower door index);
 * for each door crossed two points 0.5 m either side of the door centre along its normal, then the target.
 * Writes x, z pairs into `out` (Float32Array, capacity >= 64), returns the point count; 0 when unreachable or either
 * point is outside every room. Same room: 1 point (the target). Allocation-free.
 */
export function findPath(layout: InteriorLayout, x: number, z: number, tx: number, ty: number, passable: DoorPassable, out: Float32Array): number {
  const from = roomAt(layout, x, z);
  const to = roomAt(layout, tx, ty);
  if (from < 0 || to < 0) return 0;
  if (from !== to) {
    search(layout, from, to, passable);
    if (prevRoom[to] === UNSEEN) return 0;
  }
  const n = from === to ? 0 : writeRoute(layout, to, out);
  if (n < 0 || 2 * n + 2 > out.length) return 0;
  out[2 * n] = tx;
  out[2 * n + 1] = ty;
  return n + 1;
}

/**
 * Path to the reachable exterior door with the fewest hops (ties: main door, then lower index), ending 0.4 m inside it;
 * `door` receives its index (-1 none).
 */
export function exitPath(layout: InteriorLayout, x: number, z: number, passable: DoorPassable, out: Float32Array, door: { index: number }): number {
  door.index = -1;
  const from = roomAt(layout, x, z);
  if (from < 0) return 0;
  search(layout, from, -1, passable);
  let best = -1;
  for (let i = 0; i < layout.doors.length; i++) {
    const d = layout.doors[i] as InteriorDoor;
    if (d.b >= 0 || prevRoom[d.a] === UNSEEN || !passable(i)) continue;
    if (best < 0) { best = i; continue; }
    const b = layout.doors[best] as InteriorDoor;
    const hi = dist[d.a] as number, hb = dist[b.a] as number;
    if (hi < hb || (hi === hb && d.main && !b.main)) best = i;
  }
  if (best < 0) return 0;
  const d = layout.doors[best] as InteriorDoor;
  const n = writeRoute(layout, d.a, out);
  if (n < 0 || 2 * n + 2 > out.length) return 0;
  const s = sideOf(layout, d, d.a);
  out[2 * n] = d.axis === 'x' ? d.x : d.x + s * EXIT_INSIDE;
  out[2 * n + 1] = d.axis === 'x' ? d.z + s * EXIT_INSIDE : d.z;
  door.index = best;
  return n + 1;
}

/** Rooms reachable from `room` through passable doors (BFS order). */
export function reachableRooms(layout: InteriorLayout, room: number, passable: DoorPassable, out: number[]): number[] {
  out.length = 0;
  if (room < 0 || room >= layout.rooms.length) return out;
  const count = search(layout, room, -1, passable);
  for (let i = 0; i < count; i++) out.push(queue[i] as number);
  return out;
}
