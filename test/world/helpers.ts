import { generateCity } from '../../src/world/generate';
import type { City } from '../../src/world/city';
import {
  JUNCTION,
  ROAD_CLASS,
  RoadGraph,
  SURFACE,
  DISTRICT,
  type JunctionId,
  type RoadClassId,
  type RoadEdge,
  type RoadNode,
  type SignalDef,
} from '../../src/world/roadGraph';

export interface EdgeSpec {
  from: number;
  to: number;
  lanesF?: number;
  lanesB?: number;
  laneWidth?: number;
  median?: number;
  flags?: number;
  speedMph?: number;
  roadClass?: RoadClassId;
}

/** Builds a small graph from node coordinates and edge specs (straight two-point edges). */
export function buildGraph(
  points: readonly [number, number][],
  specs: readonly EdgeSpec[],
  junctions: readonly JunctionId[] = [],
  signals: SignalDef[] = [],
): RoadGraph {
  const incident: number[][] = points.map(() => []);
  const edges: RoadEdge[] = specs.map((s, id) => {
    const [x0, z0] = points[s.from] as [number, number];
    const [x1, z1] = points[s.to] as [number, number];
    const lanesF = s.lanesF ?? 1;
    const lanesB = s.lanesB ?? 1;
    const laneWidth = s.laneWidth ?? 3.5;
    const median = s.median ?? 0;
    incident[s.from]?.push(id);
    incident[s.to]?.push(id);
    return {
      id,
      from: s.from,
      to: s.to,
      roadClass: s.roadClass ?? ROAD_CLASS.local,
      lanesForward: lanesF,
      lanesBackward: lanesB,
      laneWidth,
      median,
      shoulder: 0.5,
      sidewalk: 2,
      width: (lanesF + lanesB) * laneWidth + median + 1,
      speedLimitMph: s.speedMph ?? 25,
      flags: s.flags ?? 0,
      surface: SURFACE.asphalt,
      length: Math.hypot(x1 - x0, z1 - z0),
      points: new Float32Array([x0, z0, x1, z1]),
      name: `Edge ${id}`,
      district: DISTRICT.suburbs,
    };
  });
  const nodes: RoadNode[] = points.map(([x, z], id) => ({
    id,
    x,
    z,
    junction: junctions[id] ?? JUNCTION.none,
    edges: incident[id] ?? [],
    signal: signals.findIndex((s) => s.node === id),
    setback: (incident[id]?.length ?? 0) >= 3 ? 8 : 0,
  }));
  return new RoadGraph(nodes, edges, signals);
}

const cities = new Map<number, City>();

/** Generated city, cached per seed for the test file. */
export function cityFor(seed: number): City {
  let c = cities.get(seed);
  if (!c) {
    c = generateCity(seed);
    cities.set(seed, c);
  }
  return c;
}
