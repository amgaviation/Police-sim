import type { CourseSegment } from '../training';
import { MIN_SEGMENT_M } from '../training';
import { ROAD_CLASS } from '../world/ids';
import type { RoadGraph } from '../world/roadGraph';

/** Largest sideways deviation (m) of an edge's points from its chord for the edge to count as straight. */
const STRAIGHT_TOLERANCE_M = 2;

/**
 * The straight arterial and collector edges of the city as course segments (design §20.3): an edge whose centreline
 * polyline stays within `STRAIGHT_TOLERANCE_M` of its chord and is at least `MIN_SEGMENT_M` long. Edges are listed in id
 * order, so the pick is deterministic.
 */
export function straightSegments(graph: RoadGraph, minLength: number = MIN_SEGMENT_M): CourseSegment[] {
  const out: CourseSegment[] = [];
  for (const e of graph.edges) {
    if (e.roadClass !== ROAD_CLASS.arterial && e.roadClass !== ROAD_CLASS.collector) continue;
    const p = e.points;
    const n = p.length >> 1;
    if (n < 2) continue;
    const ax = p[0] as number;
    const az = p[1] as number;
    const bx = p[2 * (n - 1)] as number;
    const bz = p[2 * (n - 1) + 1] as number;
    const len = Math.hypot(bx - ax, bz - az);
    if (len < minLength) continue;
    let straight = true;
    for (let i = 1; i < n - 1 && straight; i++) {
      const dev = Math.abs(((p[2 * i] as number) - ax) * (bz - az) - ((p[2 * i + 1] as number) - az) * (bx - ax)) / len;
      if (dev > STRAIGHT_TOLERANCE_M) straight = false;
    }
    if (straight) out.push({ ax, az, bx, bz });
  }
  return out;
}
