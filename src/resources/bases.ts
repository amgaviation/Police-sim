/**
 * Where resource units start, return to and are spawned (design §8.3): pure functions over the `City`.
 * `station`, `hospital`, `airport` and `harbor` are the first POI of that kind (the station when the city has
 * none); `highway` is the end of the state highway nearer to the call; `edge` is the world-edge point nearest
 * to the call, snapped to the nearest road.
 */
import type { UnitBase } from '../units';
import type { City, PoiKind } from '../world/city';
import { DISTRICTS } from '../world/data';
import type { RoadHit } from '../world/roadGraph';

/** A point on the ground (x, z). */
export interface BasePoint {
  x: number;
  z: number;
}

/** World-edge distance used by the `edge` base (m from the origin). */
export const EDGE_COORD = 3500;
const EDGE_SNAP_M = 5000;

const hit: RoadHit = { edge: -1, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 };

/** The station entrance (the city spawn when the city has no station). */
export function stationPoint(city: City, out: BasePoint): BasePoint {
  for (const p of city.pois) {
    if (p.kind !== 'station') continue;
    out.x = p.entrance.x;
    out.z = p.entrance.z;
    return out;
  }
  out.x = city.spawn.x;
  out.z = city.spawn.z;
  return out;
}

/** Entrance of the first POI of `kind` (the station when none). */
export function firstPoiPoint(city: City, kind: PoiKind, out: BasePoint): BasePoint {
  for (const p of city.pois) {
    if (p.kind !== kind) continue;
    out.x = p.entrance.x;
    out.z = p.entrance.z;
    return out;
  }
  return stationPoint(city, out);
}

/** Entrance of the POI of `kind` nearest to (x, z) (the station when none); ties go to the lower id. */
export function nearestPoiPoint(city: City, kind: PoiKind, x: number, z: number, out: BasePoint): BasePoint {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < city.pois.length; i++) {
    const p = city.pois[i];
    if (!p || p.kind !== kind) continue;
    const d = Math.hypot(p.entrance.x - x, p.entrance.z - z);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const p = best >= 0 ? city.pois[best] : undefined;
  if (!p) return stationPoint(city, out);
  out.x = p.entrance.x;
  out.z = p.entrance.z;
  return out;
}

function highwayPoint(city: City, nearX: number, nearZ: number, out: BasePoint): BasePoint {
  const hw = DISTRICTS.highways[0];
  if (!hw) return stationPoint(city, out);
  const ax = hw.axis === 'x' ? hw.from : hw.coord;
  const az = hw.axis === 'x' ? hw.coord : hw.from;
  const bx = hw.axis === 'x' ? hw.to : hw.coord;
  const bz = hw.axis === 'x' ? hw.coord : hw.to;
  const useA = Math.hypot(ax - nearX, az - nearZ) <= Math.hypot(bx - nearX, bz - nearZ);
  out.x = useA ? ax : bx;
  out.z = useA ? az : bz;
  return out;
}

function clampEdge(v: number): number {
  return v < -EDGE_COORD ? -EDGE_COORD : v > EDGE_COORD ? EDGE_COORD : v;
}

function edgePoint(city: City, nearX: number, nearZ: number, out: BasePoint): BasePoint {
  const cx = clampEdge(nearX);
  const cz = clampEdge(nearZ);
  // The four candidates are the projections of the call onto each side of the square; the nearest wins (first on ties).
  let bx = EDGE_COORD;
  let bz = cz;
  let bd = Math.abs(EDGE_COORD - nearX);
  if (Math.abs(-EDGE_COORD - nearX) < bd) {
    bx = -EDGE_COORD;
    bz = cz;
    bd = Math.abs(-EDGE_COORD - nearX);
  }
  if (Math.abs(EDGE_COORD - nearZ) < bd) {
    bx = cx;
    bz = EDGE_COORD;
    bd = Math.abs(EDGE_COORD - nearZ);
  }
  if (Math.abs(-EDGE_COORD - nearZ) < bd) {
    bx = cx;
    bz = -EDGE_COORD;
  }
  const snapped = city.graph.nearestEdge(bx, bz, EDGE_SNAP_M, hit);
  out.x = snapped ? snapped.x : bx;
  out.z = snapped ? snapped.z : bz;
  return out;
}

/**
 * Position of `base` for a unit that serves (nearX, nearZ): fixed for the POI bases, the nearer highway end for
 * `highway`, the nearest world-edge road point for `edge`. Allocation-free; returns `out`.
 */
export function basePoint(city: City, base: UnitBase, nearX: number, nearZ: number, out: BasePoint): BasePoint {
  switch (base) {
    case 'station':
      return stationPoint(city, out);
    case 'hospital':
      return firstPoiPoint(city, 'hospital', out);
    case 'airport':
      return firstPoiPoint(city, 'airport', out);
    case 'harbor':
      return firstPoiPoint(city, 'harbor', out);
    case 'highway':
      return highwayPoint(city, nearX, nearZ, out);
    case 'edge':
      return edgePoint(city, nearX, nearZ, out);
  }
}
