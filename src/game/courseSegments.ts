import type { CourseSegment } from '../training';
import { MIN_SEGMENT_M } from '../training';
import { ROAD_CLASS } from '../world/ids';
import type { RoadEdge, RoadGraph } from '../world/roadGraph';

/** Largest sideways deviation (m) of a chain's points from its chord for the chain to count as straight. */
const STRAIGHT_TOLERANCE_M = 2;
/** Two edges meeting at a node continue each other when the cosine of the angle between their leaving headings is below this. */
const CONTINUES_COS = -0.9995;

/** Heading (unit vector) of `e` leaving node `node`. */
function leaving(e: RoadEdge, node: number, out: { x: number; z: number }): { x: number; z: number } {
  const p = e.points;
  const n = p.length >> 1;
  let dx: number;
  let dz: number;
  if (e.from === node) {
    dx = (p[2] as number) - (p[0] as number);
    dz = (p[3] as number) - (p[1] as number);
  } else {
    dx = (p[2 * (n - 2)] as number) - (p[2 * (n - 1)] as number);
    dz = (p[2 * (n - 2) + 1] as number) - (p[2 * (n - 1) + 1] as number);
  }
  const len = Math.hypot(dx, dz) || 1;
  out.x = dx / len;
  out.z = dz / len;
  return out;
}

/**
 * The straight stretches of arterial and collector road of the city as course segments (design §20.3). City edges are
 * short (a block), so edges of the same class that continue each other straight through a junction are chained; a chain
 * whose points stay within `STRAIGHT_TOLERANCE_M` of its chord and is at least `minLength` long is a segment, oriented
 * from its lower-numbered end. Everything iterates in edge-id order, so the result is deterministic.
 */
export function straightSegments(graph: RoadGraph, minLength: number = MIN_SEGMENT_M): CourseSegment[] {
  const eligible = (e: RoadEdge): boolean => e.roadClass === ROAD_CLASS.arterial || e.roadClass === ROAD_CLASS.collector;
  const h1 = { x: 0, z: 0 };
  const h2 = { x: 0, z: 0 };
  // next[e * 2 + end]: the edge continuing edge e past its `end` (0 = from, 1 = to) node, -1 for none.
  const next = new Int32Array(graph.edges.length * 2).fill(-1);
  for (const e of graph.edges) {
    if (!eligible(e)) continue;
    for (let end = 0; end < 2; end++) {
      const nodeId = end === 0 ? e.from : e.to;
      const node = graph.nodes[nodeId];
      if (!node) continue;
      leaving(e, nodeId, h1);
      let best = -1;
      let bestCos = CONTINUES_COS;
      for (const otherId of node.edges) {
        if (otherId === e.id) continue;
        const o = graph.edges[otherId];
        if (!o || o.roadClass !== e.roadClass) continue;
        leaving(o, nodeId, h2);
        const cos = h1.x * h2.x + h1.z * h2.z;
        if (cos < bestCos) {
          bestCos = cos;
          best = otherId;
        }
      }
      next[e.id * 2 + end] = best;
    }
  }
  const out: CourseSegment[] = [];
  const seen = new Uint8Array(graph.edges.length);
  for (const start of graph.edges) {
    if (!eligible(start) || seen[start.id]) continue;
    // Walk back to the first edge of the chain; `startNode` ends as the node the chain begins at.
    let cur = start;
    let startNode = start.from;
    for (let guard = 0; guard < graph.edges.length; guard++) {
      const nid = next[cur.id * 2 + (startNode === cur.from ? 0 : 1)] ?? -1;
      const n = nid < 0 ? undefined : graph.edges[nid];
      if (!n || n.id === start.id) break;
      startNode = n.from === startNode ? n.to : n.from;
      cur = n;
    }
    // Walk forward collecting the node points.
    const first = graph.nodes[startNode];
    if (!first) continue;
    const pts: number[] = [first.x, first.z];
    let length = 0;
    let atNode = startNode;
    let e: RoadEdge = cur;
    for (let guard = 0; guard < graph.edges.length; guard++) {
      seen[e.id] = 1;
      length += e.length;
      const far = e.from === atNode ? e.to : e.from;
      const farNode = graph.nodes[far];
      if (!farNode) break;
      pts.push(farNode.x, farNode.z);
      const nid = next[e.id * 2 + (far === e.from ? 0 : 1)] ?? -1;
      const n = nid < 0 ? undefined : graph.edges[nid];
      if (!n || seen[n.id]) break;
      atNode = far;
      e = n;
    }
    const count = pts.length >> 1;
    if (count < 2 || length < minLength) continue;
    const ax = pts[0] as number;
    const az = pts[1] as number;
    const bx = pts[2 * (count - 1)] as number;
    const bz = pts[2 * (count - 1) + 1] as number;
    const chord = Math.hypot(bx - ax, bz - az);
    if (chord < minLength) continue;
    let straight = true;
    for (let i = 1; i < count - 1 && straight; i++) {
      const dev = Math.abs(((pts[2 * i] as number) - ax) * (bz - az) - ((pts[2 * i + 1] as number) - az) * (bx - ax)) / chord;
      if (dev > STRAIGHT_TOLERANCE_M) straight = false;
    }
    if (straight) out.push({ ax, az, bx, bz });
  }
  return out;
}
