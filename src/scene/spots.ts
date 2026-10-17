/**
 * Spot placement (Phase 3 design §11.2): where a participant of a scenario stands relative to the anchor.
 * Pure: a function of the road graph, the anchor, the spot, the nth person on it and an `Rng`.
 */
import type { Anchor, Spot } from '../calls';
import type { Rng } from '../core/rng';
import { sampleEdge, yawOf, type EdgeSample } from '../npc/geometry';
import type { RoadEdge } from '../world/roadGraph';

/** Spacing between neighbours on one spot (m). */
export const SPOT_SPACING = 1.2;

export interface SpotPosition {
  x: number;
  z: number;
  /** Faces the street. */
  yaw: number;
  /** Spawned hidden until revealed. */
  hidden: boolean;
  /** Distance from the edge centreline (m). */
  lateral: number;
  /** Metres along the edge. */
  s: number;
}

export function createSpotPosition(): SpotPosition {
  return { x: 0, z: 0, yaw: 0, hidden: false, lateral: 0, s: 0 };
}

const sample: EdgeSample = { s: 0, x: 0, z: 0, hx: 1, hz: 0 };

/** Lateral offsets of the sidewalk positions of an edge (design §11.2). */
export function edgeLaterals(e: Pick<RoadEdge, 'width' | 'sidewalk'>): { L: number; D: number; C: number; S: number } {
  const half = e.width / 2;
  return {
    L: half + (e.sidewalk > 0 ? e.sidewalk / 2 : 1.5),
    D: half + (e.sidewalk > 0 ? e.sidewalk - 0.3 : 3),
    C: half + 0.4,
    S: half - 1.2,
  };
}

/** Along offset (m), lateral key and hidden flag per spot. */
function layout(spot: Spot): { along: number; lat: 'L' | 'D' | 'C' | 'S' | 'C1'; hidden: boolean } {
  switch (spot) {
    case 'door':
      return { along: 0, lat: 'D', hidden: false };
    case 'curb':
      return { along: 2, lat: 'C', hidden: false };
    case 'yard':
      return { along: 6, lat: 'D', hidden: false };
    case 'street':
      return { along: 0, lat: 'S', hidden: false };
    case 'roadside':
      return { along: -4, lat: 'C1', hidden: false };
    case 'inside':
      return { along: 0, lat: 'D', hidden: true };
    case 'hidden':
      return { along: 0, lat: 'D', hidden: true };
    case 'distance':
      return { along: 25, lat: 'L', hidden: false };
    // 'vehicle' (seated) and 'crowd' are handled below; 'vehicle' falls back to the curb.
    default:
      return { along: 2, lat: 'C', hidden: false };
  }
}

/**
 * Fills `out` with the position of the `n`th person on `spot`. `bothSides` (street anchors) lets a crowd
 * stand on both sidewalks. Draws: `hidden` 2 (sign, distance), `crowd` 2 (along, lateral) plus 1 with
 * `bothSides`; other spots none. The edge is clamped, never extrapolated.
 */
export function spotPosition(
  edges: readonly RoadEdge[],
  anchor: Anchor,
  spot: Spot,
  n: number,
  rng: Rng,
  out: SpotPosition,
  bothSides = false,
): SpotPosition {
  const e = edges[anchor.edge];
  if (!e) {
    out.x = anchor.x;
    out.z = anchor.z;
    out.yaw = 0;
    out.hidden = spot === 'inside' || spot === 'hidden';
    out.lateral = 0;
    out.s = anchor.s;
    return out;
  }
  const lat = edgeLaterals(e);
  const l = layout(spot);
  let along = l.along + SPOT_SPACING * n;
  let lateral = l.lat === 'C1' ? lat.C + 1 : lat[l.lat];
  let side: number = anchor.side;
  if (spot === 'hidden') {
    const sign = rng.next() < 0.5 ? -1 : 1;
    along = sign * rng.nextFloat(20, 40) + SPOT_SPACING * n;
  } else if (spot === 'crowd') {
    along = rng.nextFloat(-12, 12) + SPOT_SPACING * n;
    lateral = rng.nextFloat(lat.C, Math.max(lat.C + 0.01, lat.D));
    if (bothSides && rng.next() < 0.5) side = -side;
  }
  const s = Math.min(Math.max(anchor.s + along, 0), e.length);
  sample.s = s;
  const sm = sampleEdge(e, sample);
  const nx = -sm.hz * side;
  const nz = sm.hx * side;
  out.x = sm.x + nx * lateral;
  out.z = sm.z + nz * lateral;
  // Face the street centre.
  out.yaw = yawOf(-nx, -nz);
  out.hidden = l.hidden;
  out.lateral = lateral;
  out.s = s;
  return out;
}

/** Point on the edge centreline at `s` plus a lateral offset on the anchor's side (props, vehicles). */
export function edgePoint(e: RoadEdge, s: number, lateral: number, side: number, out: { x: number; z: number; yaw: number }): void {
  sample.s = Math.min(Math.max(s, 0), e.length);
  const sm = sampleEdge(e, sample);
  out.x = sm.x - sm.hz * side * lateral;
  out.z = sm.z + sm.hx * side * lateral;
  out.yaw = yawOf(sm.hx, sm.hz);
}
