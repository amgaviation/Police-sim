/**
 * Spike strip geometry (design §10.2). Pure functions over segments and the road graph; allocation-free.
 */
import { laneRef, type LanePoint, type RoadGraph } from '../world/roadGraph';
import type { Strip } from './types';

export type { Strip } from './types';

const EPS = 1e-9;

function orient(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

/** Is `p` (known collinear with a -> b) inside the segment's bounding box? */
function within(ax: number, az: number, bx: number, bz: number, px: number, pz: number): boolean {
  return px >= Math.min(ax, bx) - EPS && px <= Math.max(ax, bx) + EPS && pz >= Math.min(az, bz) - EPS && pz <= Math.max(az, bz) + EPS;
}

/** The segment (ax, az) -> (bx, bz) crosses the strip segment (proper crossing or touching, collinear overlap included). */
export function crossesStrip(ax: number, az: number, bx: number, bz: number, s: Strip): boolean {
  const d1 = orient(s.x0, s.z0, s.x1, s.z1, ax, az);
  const d2 = orient(s.x0, s.z0, s.x1, s.z1, bx, bz);
  const d3 = orient(ax, az, bx, bz, s.x0, s.z0);
  const d4 = orient(ax, az, bx, bz, s.x1, s.z1);
  if (((d1 > EPS && d2 < -EPS) || (d1 < -EPS && d2 > EPS)) && ((d3 > EPS && d4 < -EPS) || (d3 < -EPS && d4 > EPS))) return true;
  if (Math.abs(d1) <= EPS && within(s.x0, s.z0, s.x1, s.z1, ax, az)) return true;
  if (Math.abs(d2) <= EPS && within(s.x0, s.z0, s.x1, s.z1, bx, bz)) return true;
  if (Math.abs(d3) <= EPS && within(ax, az, bx, bz, s.x0, s.z0)) return true;
  if (Math.abs(d4) <= EPS && within(ax, az, bx, bz, s.x1, s.z1)) return true;
  return false;
}

const scratchA: LanePoint = { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 };
const scratchB: LanePoint = { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 };

/**
 * A strip across the lanes of travel direction `dir` of `edge` at `sLane` metres from that direction's start node:
 * perpendicular to the travel heading, `lengthM` long, centred on the middle of the travel half of the road (the
 * midpoint of the first and last lane of that direction). False when the direction has no lanes.
 */
export function stripAcrossLanes(graph: RoadGraph, edge: number, dir: 0 | 1, sLane: number, lengthM: number, out: Strip): boolean {
  const lanes = graph.laneCount(edge, dir);
  if (lanes < 1) return false;
  const len = graph.laneLength(laneRef(edge, dir, 0));
  const s = sLane < 0 ? 0 : sLane > len ? len : sLane;
  graph.lanePoint(laneRef(edge, dir, 0), s, scratchA);
  graph.lanePoint(laneRef(edge, dir, lanes - 1), s, scratchB);
  const cx = (scratchA.x + scratchB.x) / 2, cz = (scratchA.z + scratchB.z) / 2;
  // Perpendicular to the travel heading (hx, hz): the right vector (-hz, hx).
  const px = -scratchA.hz, pz = scratchA.hx;
  const half = lengthM / 2;
  out.x0 = cx - px * half;
  out.z0 = cz - pz * half;
  out.x1 = cx + px * half;
  out.z1 = cz + pz * half;
  return true;
}

/**
 * A strip across the lanes of the travel direction at `setbackM` before `towardNode` on `edge` (the direction that
 * ends at that node): perpendicular to the edge, `lengthM` long, centred on the travel half of the road. Fills the
 * geometry of `out` only. False when `towardNode` is not an end of the edge or that direction has no lanes
 * (one-way against its direction).
 */
export function stripAcrossEdge(graph: RoadGraph, edge: number, towardNode: number, setbackM: number, lengthM: number, out: Strip): boolean {
  const e = graph.edges[edge];
  if (!e) return false;
  let dir: 0 | 1;
  if (towardNode === e.to) dir = 0;
  else if (towardNode === e.from) dir = 1;
  else return false;
  const len = graph.laneLength(laneRef(edge, dir, 0));
  return stripAcrossLanes(graph, edge, dir, Math.max(0, len - setbackM), lengthM, out);
}
