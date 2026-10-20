/**
 * Path prediction for a fleeing car (design §10.2): follow the road straight on at every junction. Allocates; called
 * at 1 Hz at most.
 */
import type { RoadGraph } from '../world/roadGraph';

/** A predicted route: `nodes[k]` is the k-th junction ahead and `edges[k]` the edge that enters it. */
export interface PredictedRoute {
  nodes: number[];
  edges: number[];
}

/** Unit vector pointing away from `node` along `edge` (first or last polyline segment). */
function outward(graph: RoadGraph, edge: number, node: number, out: { x: number; z: number }): void {
  const e = graph.edges[edge];
  if (!e) {
    out.x = 0;
    out.z = 0;
    return;
  }
  const p = e.points;
  const n = p.length;
  let dx: number, dz: number;
  if (node === e.from) {
    dx = (p[2] ?? 0) - (p[0] ?? 0);
    dz = (p[3] ?? 0) - (p[1] ?? 0);
  } else {
    dx = (p[n - 4] ?? 0) - (p[n - 2] ?? 0);
    dz = (p[n - 3] ?? 0) - (p[n - 1] ?? 0);
  }
  const len = Math.hypot(dx, dz) || 1;
  out.x = dx / len;
  out.z = dz / len;
}

/** Can a car leave `node` along `edge` (one-way edges only leave from their start)? */
function canLeave(graph: RoadGraph, edge: number, node: number): boolean {
  const e = graph.edges[edge];
  if (!e) return false;
  if (e.from === node) return true;
  return e.to === node && e.lanesBackward > 0;
}

/**
 * The junctions a car on `edge` at (x, z) heading `yaw` (0 = facing -Z) is likely to reach: the end node of its edge
 * in the travel direction, then at each junction the exit with the smallest heading change (ties by edge id; a
 * U-turn only at a dead end), `steps` nodes in all (fewer when the road ends).
 */
export function predictRoute(graph: RoadGraph, edge: number, x: number, z: number, yaw: number, steps: number): PredictedRoute {
  const route: PredictedRoute = { nodes: [], edges: [] };
  const e = graph.edges[edge];
  if (!e || steps < 1) return route;
  const hx = -Math.sin(yaw), hz = -Math.cos(yaw);
  const from = graph.nodes[e.from], to = graph.nodes[e.to];
  if (!from || !to) return route;
  const toward = hx * (to.x - x) + hz * (to.z - z) >= hx * (from.x - x) + hz * (from.z - z) ? e.to : e.from;
  route.nodes.push(toward);
  route.edges.push(edge);
  const away = { x: 0, z: 0 };
  const leave = { x: 0, z: 0 };
  while (route.nodes.length < steps) {
    const node = route.nodes[route.nodes.length - 1] as number;
    const inEdge = route.edges[route.edges.length - 1] as number;
    outward(graph, inEdge, node, away);
    // Arrival heading = -away.
    const ax = -away.x, az = -away.z;
    const info = graph.nodes[node];
    if (!info) break;
    let best = -1;
    let bestDot = -Infinity;
    for (const o of info.edges) {
      if (o === inEdge || !canLeave(graph, o, node)) continue;
      outward(graph, o, node, leave);
      const d = ax * leave.x + az * leave.z;
      if (d > bestDot + 1e-9 || (d > bestDot - 1e-9 && o < best)) {
        best = o;
        bestDot = d;
      }
    }
    if (best < 0) {
      // Dead end: turn around where the road allows it.
      if (!canLeave(graph, inEdge, node)) break;
      best = inEdge;
    }
    const oe = graph.edges[best];
    if (!oe) break;
    route.nodes.push(oe.from === node ? oe.to : oe.from);
    route.edges.push(best);
  }
  return route;
}

/** `predictRoute(...).nodes`: the node sequence a fleeing car is likely to take. */
export function predictPath(graph: RoadGraph, edge: number, x: number, z: number, yaw: number, steps: number): number[] {
  return predictRoute(graph, edge, x, z, yaw, steps).nodes;
}
