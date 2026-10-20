/**
 * Walkability of a room's free floor (pure). The officer collider is a 0.4 m radius cylinder plus the 0.02 m
 * character-controller skin, so it fits wherever a disc of `WALK_RADIUS` fits; the walls take half their
 * thickness off the room edge. Used by the generator to keep furniture from walling off doors and stand points.
 */
export const WALK_RADIUS = 0.43;
/** Room edge to the nearest disc centre: radius + half a wall. */
export const WALL_INSET = 0.5;
const STEP = 0.1;

interface WalkRect { readonly minX: number; readonly minZ: number; readonly maxX: number; readonly maxZ: number }
interface WalkPoint { readonly x: number; readonly z: number }

let blocked = new Uint8Array(0);
let seen = new Uint8Array(0);
let queue = new Int32Array(0);

/**
 * True when every node (a door's inside point, a stand point, the arrival pose) lies on free floor of `room` and
 * all of them are mutually reachable around `solids` for a disc of `WALK_RADIUS` (0.1 m grid, 4-connected).
 */
export function nodesConnected(room: WalkRect, solids: readonly WalkRect[], nodes: readonly WalkPoint[]): boolean {
  if (nodes.length === 0) return true;
  const x0 = room.minX + WALL_INSET, z0 = room.minZ + WALL_INSET;
  const nx = Math.floor((room.maxX - room.minX - 2 * WALL_INSET) / STEP + 1e-6) + 1;
  const nz = Math.floor((room.maxZ - room.minZ - 2 * WALL_INSET) / STEP + 1e-6) + 1;
  if (nx <= 0 || nz <= 0) return false;
  const n = nx * nz;
  if (blocked.length < n) {
    blocked = new Uint8Array(n);
    seen = new Uint8Array(n);
    queue = new Int32Array(n);
  }
  blocked.fill(0, 0, n);
  seen.fill(0, 0, n);
  const r2 = WALK_RADIUS * WALK_RADIUS;
  for (const s of solids) {
    const ix0 = Math.max(0, Math.ceil((s.minX - WALK_RADIUS - x0) / STEP - 1e-9));
    const ix1 = Math.min(nx - 1, Math.floor((s.maxX + WALK_RADIUS - x0) / STEP + 1e-9));
    const iz0 = Math.max(0, Math.ceil((s.minZ - WALK_RADIUS - z0) / STEP - 1e-9));
    const iz1 = Math.min(nz - 1, Math.floor((s.maxZ + WALK_RADIUS - z0) / STEP + 1e-9));
    for (let iz = iz0; iz <= iz1; iz++) {
      const cz = z0 + iz * STEP;
      const dz = Math.max(s.minZ - cz, 0, cz - s.maxZ);
      for (let ix = ix0; ix <= ix1; ix++) {
        const cx = x0 + ix * STEP;
        const dx = Math.max(s.minX - cx, 0, cx - s.maxX);
        if (dx * dx + dz * dz < r2 - 1e-9) blocked[iz * nx + ix] = 1;
      }
    }
  }
  // A node's own cell counts as free: snapping it to the grid moves it by up to 0.07 m.
  const cells: number[] = [];
  for (const p of nodes) {
    const ix = Math.min(nx - 1, Math.max(0, Math.round((p.x - x0) / STEP)));
    const iz = Math.min(nz - 1, Math.max(0, Math.round((p.z - z0) / STEP)));
    cells.push(iz * nx + ix);
    blocked[iz * nx + ix] = 0;
  }
  if (cells.length === 1) return true;
  let want = 0;
  const wanted = new Set(cells);
  let head = 0, tail = 0;
  const start = cells[0] as number;
  seen[start] = 1;
  queue[tail++] = start;
  while (head < tail) {
    const c = queue[head++] as number;
    if (wanted.has(c)) { want++; if (want === wanted.size) return true; }
    const ix = c % nx;
    if (ix > 0 && !blocked[c - 1] && !seen[c - 1]) { seen[c - 1] = 1; queue[tail++] = c - 1; }
    if (ix < nx - 1 && !blocked[c + 1] && !seen[c + 1]) { seen[c + 1] = 1; queue[tail++] = c + 1; }
    if (c >= nx && !blocked[c - nx] && !seen[c - nx]) { seen[c - nx] = 1; queue[tail++] = c - nx; }
    if (c + nx < n && !blocked[c + nx] && !seen[c + nx]) { seen[c + nx] = 1; queue[tail++] = c + nx; }
  }
  return false;
}
