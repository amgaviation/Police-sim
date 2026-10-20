/** Command post spot, traffic control points, inner perimeter and evacuation geometry (Phase 6 design §11.2). Pure. */
import type { RoadGraph, RoadHit } from '../world/roadGraph';

/** Yaw (project convention: forward = (-sin yaw, -cos yaw)) of the direction (dx, dz). */
export function facing(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/** Furthest a command post may be snapped to a road. */
export const POST_SNAP_M = 200;

const scratchHit: RoadHit = { edge: 0, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 };
const scratchNodes: number[] = [];

/**
 * Command post spot: `standoffM` from the incident along the direction from the incident to the player (+X when they
 * coincide), snapped to the nearest road point (`graph.nearestEdge` within 200 m; unsnapped when no road is that close).
 */
export function postSpot(graph: RoadGraph, ix: number, iz: number, px: number, pz: number, standoffM: number): { x: number; z: number } {
  let dx = px - ix;
  let dz = pz - iz;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) {
    dx = 1;
    dz = 0;
  } else {
    dx /= len;
    dz /= len;
  }
  const x = ix + dx * standoffM;
  const z = iz + dz * standoffM;
  const hit = graph.nearestEdge(x, z, POST_SNAP_M, scratchHit);
  return hit ? { x: hit.x, z: hit.z } : { x, z };
}

/**
 * Traffic control points: road nodes from `graph.nodesNear(x, z, radiusM * 1.3)` whose distance is within [0.6, 1.3] * radiusM
 * and that have an incident edge whose other node is nearer to (x, z); sorted by |distance - radiusM| then node id; at most
 * `max`; each with the yaw facing the incident.
 */
export function tcpPoints(graph: RoadGraph, x: number, z: number, radiusM: number, max: number): { x: number; z: number; yaw: number; node: number }[] {
  const ids = graph.nodesNear(x, z, radiusM * 1.3, scratchNodes);
  const found: { x: number; z: number; yaw: number; node: number; d: number }[] = [];
  for (const id of ids) {
    const node = graph.nodes[id];
    if (!node) continue;
    const d = Math.hypot(node.x - x, node.z - z);
    if (d < radiusM * 0.6 || d > radiusM * 1.3) continue;
    let inward = false;
    for (const eid of node.edges) {
      const e = graph.edges[eid];
      if (!e) continue;
      const other = graph.nodes[e.from === id ? e.to : e.from];
      if (other && other.id !== id && Math.hypot(other.x - x, other.z - z) < d) {
        inward = true;
        break;
      }
    }
    if (inward) found.push({ x: node.x, z: node.z, yaw: facing(x - node.x, z - node.z), node: id, d });
  }
  found.sort((a, b) => Math.abs(a.d - radiusM) - Math.abs(b.d - radiusM) || a.node - b.node);
  return found.slice(0, max).map((f) => ({ x: f.x, z: f.z, yaw: f.yaw, node: f.node }));
}

/** Inner perimeter: the 4 footprint corners pushed out diagonally by `offsetM` (distance from the corner), yaw facing the building centre. */
export function innerPosts(rect: { minX: number; minZ: number; maxX: number; maxZ: number }, offsetM: number): { x: number; z: number; yaw: number }[] {
  const cx = (rect.minX + rect.maxX) / 2;
  const cz = (rect.minZ + rect.maxZ) / 2;
  const d = offsetM / Math.SQRT2;
  const corners: [number, number, number, number][] = [
    [rect.minX, rect.minZ, -1, -1],
    [rect.maxX, rect.minZ, 1, -1],
    [rect.maxX, rect.maxZ, 1, 1],
    [rect.minX, rect.maxZ, -1, 1],
  ];
  return corners.map(([x, z, sx, sz]) => {
    const px = x + sx * d;
    const pz = z + sz * d;
    return { x: px, z: pz, yaw: facing(cx - px, cz - pz) };
  });
}

/** Evacuation progress 0..1: cleared building-seconds / (buildings * buildingS); an empty zone is done. */
export function evacProgress(clearedS: number, buildings: number, buildingS: number): number {
  const total = buildings * buildingS;
  if (!(total > 0)) return 1;
  return Math.min(1, Math.max(0, clearedS / total));
}

/** A closed regular polygon with `segments` corners (x, z pairs, not repeating the first corner) around (x, z), shaped like a `NoGoZone`. */
export function circleZone(id: number, x: number, z: number, r: number, segments: number): { id: number; points: Float32Array; minX: number; minZ: number; maxX: number; maxZ: number } {
  const points = new Float32Array(segments * 2);
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    const px = x + Math.cos(a) * r;
    const pz = z + Math.sin(a) * r;
    points[2 * i] = px;
    points[2 * i + 1] = pz;
    const sx = points[2 * i] as number;
    const sz = points[2 * i + 1] as number;
    if (sx < minX) minX = sx;
    if (sx > maxX) maxX = sx;
    if (sz < minZ) minZ = sz;
    if (sz > maxZ) maxZ = sz;
  }
  return { id, points, minX, minZ, maxX, maxZ };
}
