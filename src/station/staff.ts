/** Static station staff figures (design §11.1). Pure: takes plain points, imports no interior module. */
import { POSE, type HumanoidSource } from '../render/people/pose';
import { defaultLoadout, uniformColors } from './locker';

/** Staff roles by point kind, in figure order (one figure per kind: the first point of that kind). */
const ROLES = ['frontDesk', 'briefing', 'armory', 'evidence', 'booking'] as const;
/** Distance (m) from the point to the figure, along the point's facing. */
const STAFF_DISTANCE = 1.2;
const SKIN = [0xc68e6b, 0x8d5a3c, 0xe0b48f, 0x6f4430, 0xd2a47c] as const;
const HAIR = [0x2a1d14, 0x1a1410, 0x5a3a22, 0x3a3a3c, 0x7a5a30] as const;
const HEIGHTS = [1.78, 1.7, 1.82, 1.66, 1.75] as const;

/**
 * Writes one uniformed figure for each of the desk sergeant (frontDesk), briefing sergeant (briefing), armorer (armory),
 * evidence technician (evidence) and booking officer (booking) points present (the first point of each kind), standing
 * 1.2 m beyond the point in its facing direction and looking back at it, at feet height `floorY`. Returns the count
 * written (`out.count`).
 */
export function stationStaff(
  points: readonly { kind: string; x: number; z: number; yaw: number }[],
  floorY: number,
  out: HumanoidSource & { count: number },
): number {
  const colors = uniformColors(defaultLoadout());
  const capacity = out.x.length;
  let n = 0;
  for (let r = 0; r < ROLES.length && n < capacity; r++) {
    const kind = ROLES[r];
    const p = points.find((q) => q.kind === kind);
    if (p === undefined) continue;
    // yaw 0 faces -Z: forward = (-sin yaw, -cos yaw).
    const x = p.x - Math.sin(p.yaw) * STAFF_DISTANCE;
    const z = p.z - Math.cos(p.yaw) * STAFF_DISTANCE;
    const yaw = p.yaw + Math.PI;
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
