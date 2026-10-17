import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { createRng } from '../../src/core/rng';
import { createGameWorld, type GameWorld } from '../../src/ecs/world';
import { PhysicsWorld } from '../../src/physics/physics';
import type { TrafficViolationEvent } from '../../src/traffic/events';
import { TrafficSystem, type TrafficFocus } from '../../src/traffic/trafficSystem';
import type { City } from '../../src/world/city';
import {
  DISTRICT,
  JUNCTION,
  ROAD_CLASS,
  RoadGraph,
  SURFACE,
  type JunctionId,
  type RoadEdge,
  type RoadNode,
  type SignalDef,
} from '../../src/world/roadGraph';

export const DT = 1 / 60;
export const NOON = { hour: 12, isWeekday: true } as const;

interface EdgeSpec {
  from: number;
  to: number;
  speedMph?: number;
  lanes?: number;
}

/** Small graph of straight two-way edges; nodes of degree >= 3 get an 8 m setback. */
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
    const lanes = s.lanes ?? 1;
    incident[s.from]?.push(id);
    incident[s.to]?.push(id);
    return {
      id,
      from: s.from,
      to: s.to,
      roadClass: ROAD_CLASS.local,
      lanesForward: lanes,
      lanesBackward: lanes,
      laneWidth: 3.5,
      median: 0,
      shoulder: 0.5,
      sidewalk: 2,
      width: 2 * lanes * 3.5 + 1,
      speedLimitMph: s.speedMph ?? 25,
      flags: 0,
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
    signal: signals.findIndex((sig) => sig.node === id),
    setback: (incident[id]?.length ?? 0) >= 3 ? 8 : 0,
  }));
  return new RoadGraph(nodes, edges, signals);
}

/** Group 0 (x-axis) green 0-20 s, yellow 20-24, red 24-51; group 1 green 25.5-45.5. */
export const CROSS_SIGNAL: SignalDef = { id: 0, node: 0, cycle: 51, offset: 0, green: [20, 20], yellow: 4, allRed: 1.5 };

/**
 * A + junction at the origin with 1000 m arms. Edge 0 runs west -> centre (travel +x on dir 0),
 * edge 1 centre -> east, edge 2 north -> centre (travel +z), edge 3 centre -> south.
 */
export function crossGraph(junction: JunctionId): RoadGraph {
  const L = 1000;
  return buildGraph(
    [[0, 0], [-L, 0], [L, 0], [0, -L], [0, L]],
    [{ from: 1, to: 0 }, { from: 0, to: 2 }, { from: 3, to: 0 }, { from: 0, to: 4 }],
    [junction],
    junction === JUNCTION.signal ? [CROSS_SIGNAL] : [],
  );
}

/** One straight 3 km road along x (40 mph). */
export function lineGraph(): RoadGraph {
  return buildGraph([[-1500, 0], [1500, 0]], [{ from: 0, to: 1, speedMph: 40 }]);
}

export interface Harness {
  sys: TrafficSystem;
  world: GameWorld;
  physics: PhysicsWorld;
  bus: EventBus<EventMap>;
  violations: TrafficViolationEvent[];
  focus: TrafficFocus;
}

/** A traffic system with its own world, physics and bus; `violations` collects violation events. */
export async function makeHarness(graph: RoadGraph, seed = 7, city?: City): Promise<Harness> {
  const world = createGameWorld();
  const physics = await PhysicsWorld.create();
  const bus = new EventBus<EventMap>();
  const sys = new TrafficSystem({ world, physics, graph, city, seed, rng: createRng(seed).stream('traffic'), bus });
  const violations: TrafficViolationEvent[] = [];
  bus.on('traffic:violation', (e) => violations.push(e));
  const focus: TrafficFocus = { x: 0, z: 0, obstacle: false, ox: 0, oz: 0, ovx: 0, ovz: 0, oRadius: 1 };
  return { sys, world, physics, bus, violations, focus };
}
