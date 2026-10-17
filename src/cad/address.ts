/**
 * The game's only address formatter (design §6.3): block numbers, prefixes, cross streets and
 * "near" text from the road graph. Pure; used by CAD, dispatch (10-20s), records (home addresses)
 * and the MDT.
 */
import { DISTRICT_NAMES, ROAD_CLASS } from '../world/ids';
import type { RoadEdge, RoadGraph, RoadHit } from '../world/roadGraph';
import { CAD_CONFIG } from './data';
import type { CadLocation } from './types';

export interface Address {
  readonly edge: number;
  /** Metres along the edge from its `from` node. */
  readonly s: number;
  readonly number: number;
  readonly street: string;
  /** '' when no differently named street meets the edge. */
  readonly cross: string;
  /** Capitalised district label ("Downtown"). */
  readonly district: string;
  /** "1240 N Oak Street". */
  readonly text: string;
  /** "Oak Street at 5th Street" or "1200 block of N Oak Street". */
  readonly near: string;
}

/** Default snapping distance of `addressAt` / `locationOf` (m). */
export const ADDRESS_MAX_DISTANCE = 60;

const scratchHit: RoadHit = { edge: -1, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 };
const scratchPoint = { x: 0, z: 0 };

function capitalise(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/** Unit direction from -> to of an edge (end nodes, falling back to its polyline). */
function edgeDirection(graph: RoadGraph, e: RoadEdge, out: { x: number; z: number }): void {
  const a = graph.nodes[e.from];
  const b = graph.nodes[e.to];
  const p = e.points;
  let dx = b && a ? b.x - a.x : 0;
  let dz = b && a ? b.z - a.z : 0;
  if (dx === 0 && dz === 0 && p.length >= 4) {
    dx = (p[p.length - 2] ?? 0) - (p[0] ?? 0);
    dz = (p[p.length - 1] ?? 0) - (p[1] ?? 0);
  }
  const len = Math.hypot(dx, dz);
  out.x = len > 0 ? dx / len : 1;
  out.z = len > 0 ? dz / len : 0;
}

/** Centreline point `s` metres along the edge from its `from` node (clamped). */
function pointAlong(e: RoadEdge, s: number, out: { x: number; z: number }): void {
  const p = e.points;
  let rest = s < 0 ? 0 : s;
  out.x = p[0] ?? 0;
  out.z = p[1] ?? 0;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i] ?? 0, az = p[i + 1] ?? 0;
    const bx = p[i + 2] ?? 0, bz = p[i + 3] ?? 0;
    const len = Math.hypot(bx - ax, bz - az);
    if (rest <= len || i + 4 >= p.length) {
      const t = len > 0 ? Math.min(1, rest / len) : 0;
      out.x = ax + (bx - ax) * t;
      out.z = az + (bz - az) * t;
      return;
    }
    rest -= len;
  }
}

/** Most perpendicular differently named street meeting `nodeId` (ties: lowest edge id), '' if none. */
function crossAt(graph: RoadGraph, nodeId: number, edge: number, street: string, dx: number, dz: number): string {
  const node = graph.nodes[nodeId];
  if (!node) return '';
  let best = '';
  let bestDot = Infinity;
  let bestId = Infinity;
  const dir = { x: 0, z: 0 };
  for (const id of node.edges) {
    if (id === edge) continue;
    const other = graph.edges[id];
    if (!other || other.name === street || other.name === '') continue;
    edgeDirection(graph, other, dir);
    const dot = Math.abs(dir.x * dx + dir.z * dz);
    if (dot < bestDot - 1e-9 || (Math.abs(dot - bestDot) <= 1e-9 && id < bestId)) {
      bestDot = dot;
      bestId = id;
      best = other.name;
    }
  }
  return best;
}

function build(
  graph: RoadGraph,
  e: RoadEdge,
  s: number,
  px: number,
  pz: number,
  /** -1 | 1 relative to from -> to; 0 = the even side. */
  side: -1 | 0 | 1,
  districtOf: ((x: number, z: number) => string) | undefined,
): Address {
  const dir = { x: 0, z: 0 };
  edgeDirection(graph, e, dir);
  const northSouth = Math.abs(dir.z) > Math.abs(dir.x);
  const coord = northSouth ? pz : px;
  const prefixed = e.roadClass !== ROAD_CLASS.highway && e.roadClass !== ROAD_CLASS.county;
  const prefix = !prefixed ? '' : northSouth ? (pz < 0 ? 'N' : 'S') : px > 0 ? 'E' : 'W';

  // `side` is relative to the edge's from -> to direction; refer it to a fixed heading (north for
  // north-south streets, east for east-west ones) so one side of a street keeps its parity whichever
  // way its edges were digitised: even numbers on the east / south side, odd on the west / north side.
  const heading = northSouth ? -dir.z : dir.x;
  const relSide = side === 0 ? 1 : heading < 0 ? -side : side;
  const per = CAD_CONFIG.metresPerHundred;
  const d = Math.abs(coord);
  const blocks = Math.floor(d / per);
  const frac = (d - blocks * per) / per;
  const hundreds = 100 * blocks;
  const number = hundreds + 2 * Math.floor(Math.min(frac, 0.999999) * 49) + (relSide === -1 ? 1 : 0);

  const street = e.name;
  const nearFrom = s <= e.length / 2;
  let junction = nearFrom ? e.from : e.to;
  let cross = crossAt(graph, junction, e.id, street, dir.x, dir.z);
  if (cross === '') {
    junction = nearFrom ? e.to : e.from;
    cross = crossAt(graph, junction, e.id, street, dir.x, dir.z);
  }
  const node = graph.nodes[junction];
  const prefixedStreet = prefix === '' ? street : `${prefix} ${street}`;
  const atJunction =
    cross !== '' && node !== undefined && Math.hypot(node.x - px, node.z - pz) <= CAD_CONFIG.intersectionRadius;
  const near = atJunction ? `${street} at ${cross}` : `${hundreds} block of ${prefixedStreet}`;

  const districtName = districtOf ? districtOf(px, pz) : (DISTRICT_NAMES[e.district] ?? '');
  return {
    edge: e.id,
    s,
    number,
    street,
    cross,
    district: capitalise(districtName),
    text: `${number} ${prefixedStreet}`,
    near,
  };
}

/**
 * 10-20 text: `near` plus the cross street when `near` does not name it already (mid-block),
 * e.g. "1200 block of N Oak Street near 5th Street"; at a junction it is `near` ("Oak Street at 5th Street").
 */
export function locationText(a: { readonly street: string; readonly cross: string; readonly near: string }): string {
  if (a.cross === '' || a.near === `${a.street} at ${a.cross}`) return a.near;
  return `${a.near} near ${a.cross}`;
}

/** Address of the road point nearest (x, z); null when no road is within `maxDistance` (default 60 m). */
export function addressAt(
  graph: RoadGraph,
  x: number,
  z: number,
  districtOf?: (x: number, z: number) => string,
  maxDistance = ADDRESS_MAX_DISTANCE,
): Address | null {
  const hit = graph.nearestEdge(x, z, maxDistance, scratchHit);
  if (!hit) return null;
  const e = graph.edges[hit.edge];
  if (!e) return null;
  return build(graph, e, hit.s, hit.x, hit.z, hit.side, districtOf);
}

/** Address of the centreline point `s` metres along `edge` (even side); throws RangeError on an unknown edge. */
export function addressOnEdge(
  graph: RoadGraph,
  edge: number,
  s: number,
  districtOf?: (x: number, z: number) => string,
): Address {
  const e = graph.edges[edge];
  if (!e) throw new RangeError(`Unknown road edge ${edge}`);
  const along = Math.min(Math.max(s, 0), e.length);
  pointAlong(e, along, scratchPoint);
  return build(graph, e, along, scratchPoint.x, scratchPoint.z, 0, districtOf);
}

/** CAD location of (x, z) (the point itself, addressed from the nearest road); null off-road. */
export function locationOf(
  graph: RoadGraph,
  x: number,
  z: number,
  districtOf?: (x: number, z: number) => string,
  maxDistance = ADDRESS_MAX_DISTANCE,
): CadLocation | null {
  const a = addressAt(graph, x, z, districtOf, maxDistance);
  if (!a) return null;
  return { x, z, edge: a.edge, text: a.text, street: a.street, cross: a.cross, near: a.near, district: a.district };
}
