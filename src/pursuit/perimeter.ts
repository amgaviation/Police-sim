/**
 * Perimeter post selection around a point (design §10.2). Allocates; called when a perimeter is set.
 */
import type { RoadGraph } from '../world/roadGraph';

/**
 * Up to `n` road nodes around (x, z) at about `radiusM`: the plane is cut into `n` equal sectors (from -x,
 * counter-clockwise by atan2) and each sector contributes the node of `graph.nodesNear(x, z, radiusM * 1.5)` whose
 * distance is nearest `radiusM` (ties by node id). Sectors without a node are skipped.
 */
export function perimeterPosts(graph: RoadGraph, x: number, z: number, radiusM: number, n: number): { x: number; z: number; node: number }[] {
  const out: { x: number; z: number; node: number }[] = [];
  if (n < 1) return out;
  const near = graph.nodesNear(x, z, radiusM * 1.5, []);
  const bestErr = new Array<number>(n).fill(Infinity);
  const best = new Array<number>(n).fill(-1);
  for (const id of near) {
    const node = graph.nodes[id];
    if (!node) continue;
    const dx = node.x - x, dz = node.z - z;
    const d = Math.hypot(dx, dz);
    const sector = Math.min(n - 1, Math.floor(((Math.atan2(dz, dx) + Math.PI) / (2 * Math.PI)) * n));
    const err = Math.abs(d - radiusM);
    if (err < (bestErr[sector] ?? Infinity)) {
      bestErr[sector] = err;
      best[sector] = id;
    }
  }
  for (let k = 0; k < n; k++) {
    const id = best[k] ?? -1;
    const node = id >= 0 ? graph.nodes[id] : undefined;
    if (node) out.push({ x: node.x, z: node.z, node: id });
  }
  return out;
}
