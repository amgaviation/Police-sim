/** Static station staff figures (design §11.1). Pure: takes plain layout data, imports no interior module. */
import { POSE, type HumanoidSource } from '../render/people/pose';
import { defaultLoadout, uniformColors } from './locker';

/** Staff roles by point kind, in figure order (one figure per kind: the first point of that kind). */
const ROLES = ['frontDesk', 'briefing', 'armory', 'evidence', 'booking'] as const;
/** Clear distance (m) from a figure to furniture and room walls. */
const STAFF_RADIUS = 0.4;
/** Distance (m) the figure keeps beyond the far edge of the furniture. */
const BEYOND = 0.5;
/** Sideways distances (m) from the stand point, tried in order, left before right. */
const LATERAL = [1.1, 1.5, 2] as const;
const SKIN = [0xc68e6b, 0x8d5a3c, 0xe0b48f, 0x6f4430, 0xd2a47c] as const;
const HAIR = [0x2a1d14, 0x1a1410, 0x5a3a22, 0x3a3a3c, 0x7a5a30] as const;
const HEIGHTS = [1.78, 1.7, 1.82, 1.66, 1.75] as const;

interface Box { readonly minX: number; readonly minZ: number; readonly maxX: number; readonly maxZ: number }

/** The parts of an interior layout the staff need. */
export interface StaffLayout {
  readonly floorY: number;
  readonly points: readonly { kind: string; room: number; furniture: number; x: number; z: number; yaw: number }[];
  readonly furniture: readonly (Box & { solid: boolean })[];
  readonly rooms: readonly { rect: Box }[];
}

/** Distance from (x, z) to the box, 0 inside. */
function boxDistance(b: Box, x: number, z: number): number {
  return Math.hypot(Math.max(b.minX - x, 0, x - b.maxX), Math.max(b.minZ - z, 0, z - b.maxZ));
}

/**
 * The spot `beyond` m past the far edge of a point's furniture, along the point's facing (a point is the stand
 * position in front of its furniture, which the stand looks at). `piece` undefined: `beyond` m ahead of the stand.
 */
export function beyondFurniture(
  piece: Box | undefined, p: { x: number; z: number; yaw: number }, beyond: number, out: { x: number; z: number },
): { x: number; z: number } {
  // yaw 0 faces -Z: forward = (-sin yaw, -cos yaw).
  const fx = Math.round(-Math.sin(p.yaw)), fz = Math.round(-Math.cos(p.yaw));
  let far = 0;
  if (piece !== undefined) far = fx > 0 ? piece.maxX - p.x : fx < 0 ? p.x - piece.minX : fz > 0 ? piece.maxZ - p.z : p.z - piece.minZ;
  out.x = p.x + fx * (far + beyond);
  out.z = p.z + fz * (far + beyond);
  return out;
}

/**
 * Where the figure of a point stands: just beyond the far edge of the point's furniture when that is clear floor of
 * the room (a counter in the middle of a room), else beside the stand point (counters and the podium sit against a
 * wall, so the far side is the wall). Always on free floor of the point's own room, away from the stand point.
 */
function staffSpot(layout: StaffLayout, p: StaffLayout['points'][number], out: { x: number; z: number }): void {
  const room = layout.rooms[p.room]?.rect;
  const piece = layout.furniture[p.furniture];
  const fx = Math.round(-Math.sin(p.yaw)), fz = Math.round(-Math.cos(p.yaw));
  const candidates: { x: number; z: number }[] = [];
  if (piece !== undefined) candidates.push(beyondFurniture(piece, p, BEYOND, { x: 0, z: 0 }));
  for (const d of LATERAL) {
    candidates.push({ x: p.x - fz * d, z: p.z + fx * d }, { x: p.x + fz * d, z: p.z - fx * d });
  }
  const free = (c: { x: number; z: number }): boolean => {
    if (room !== undefined && (c.x < room.minX + STAFF_RADIUS || c.x > room.maxX - STAFF_RADIUS || c.z < room.minZ + STAFF_RADIUS || c.z > room.maxZ - STAFF_RADIUS)) return false;
    return layout.furniture.every((f) => !f.solid || boxDistance(f, c.x, c.z) >= STAFF_RADIUS);
  };
  const spot = candidates.find(free) ?? candidates[piece === undefined ? 0 : 1] ?? { x: p.x, z: p.z };
  out.x = spot.x;
  out.z = spot.z;
}

/**
 * Writes one uniformed figure for each of the desk sergeant (frontDesk), briefing sergeant (briefing), armorer (armory),
 * evidence technician (evidence) and booking officer (booking) points present (the first point of each kind), on free
 * floor of the point's room (see `staffSpot`) and looking at the point's stand position, at feet height
 * `layout.floorY`. Returns the count written (`out.count`).
 */
export function stationStaff(layout: StaffLayout, out: HumanoidSource & { count: number }): number {
  const floorY = layout.floorY;
  const colors = uniformColors(defaultLoadout());
  const spot = { x: 0, z: 0 };
  const capacity = out.x.length;
  let n = 0;
  for (let r = 0; r < ROLES.length && n < capacity; r++) {
    const kind = ROLES[r];
    const p = layout.points.find((q) => q.kind === kind);
    if (p === undefined) continue;
    staffSpot(layout, p, spot);
    const x = spot.x, z = spot.z;
    const yaw = Math.atan2(p.x - x, p.z - z) + Math.PI;
    out.x[n] = x;
    out.y[n] = floorY;
    out.z[n] = z;
    out.yaw[n] = yaw;
    out.prevX[n] = x;
    out.prevY[n] = floorY;
    out.prevZ[n] = z;
    out.prevYaw[n] = yaw;
    out.anchor[n] = 0;
    out.pose[n] = POSE.stand;
    out.gait[n] = 0;
    out.speed[n] = 0;
    out.height[n] = HEIGHTS[r] ?? 1.75;
    out.build[n] = 1;
    out.skin[n] = SKIN[r] ?? SKIN[0];
    out.hair[n] = HAIR[r] ?? HAIR[0];
    out.top[n] = colors.top;
    out.bottom[n] = colors.bottom;
    out.held[n] = 0;
    out.body[n] = 0;
    out.flags[n] = 0;
    n++;
  }
  out.count = n;
  return n;
}
