import { CadState } from '../../src/cad/cadState';
import type { CadLocation, CadTime, RadioMode } from '../../src/cad/types';
import '../../src/cad/events';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { createRng } from '../../src/core/rng';
import { RadioSystem } from '../../src/radio/radioSystem';
import '../../src/radio/events';
import type { Transmission } from '../../src/radio/types';
import { DISTRICT, JUNCTION, ROAD_CLASS, RoadGraph, SURFACE, type RoadEdge, type RoadNode } from '../../src/world/roadGraph';

/** A plus-shaped crossing: Oak Street (north-south) meets 5th Street (east-west) at the origin. */
export function crossGraph(): RoadGraph {
  const points: [number, number][] = [[0, 0], [0, -400], [0, 400], [-400, 0], [400, 0]];
  const specs: [number, number, string][] = [[0, 1, 'Oak Street'], [0, 2, 'Oak Street'], [0, 3, '5th Street'], [0, 4, '5th Street']];
  const incident: number[][] = points.map(() => []);
  const edges: RoadEdge[] = specs.map(([a, b, name], id) => {
    const [x0, z0] = points[a] as [number, number];
    const [x1, z1] = points[b] as [number, number];
    incident[a]?.push(id);
    incident[b]?.push(id);
    return {
      id, from: a, to: b, roadClass: ROAD_CLASS.local, lanesForward: 1, lanesBackward: 1, laneWidth: 3.5, median: 0,
      shoulder: 0.5, sidewalk: 2, width: 8, speedLimitMph: 25, flags: 0, surface: SURFACE.asphalt,
      length: Math.hypot(x1 - x0, z1 - z0), points: new Float32Array([x0, z0, x1, z1]), name, district: DISTRICT.downtown,
    };
  });
  const nodes: RoadNode[] = points.map(([x, z], id) => ({ id, x, z, junction: JUNCTION.none, edges: incident[id] ?? [], signal: -1, setback: 0 }));
  return new RoadGraph(nodes, edges, []);
}

export const PLAYER = '12';
export const SEED = 4242;

export function at(sim: number): CadTime {
  return { sim, game: 50400 + sim * 30 };
}

export const CALL_LOCATION: CadLocation = {
  x: 0, z: -250, edge: 0, text: '248 N Oak Street', street: 'Oak Street', cross: '5th Street',
  near: '200 block of N Oak Street', district: 'Downtown',
};

export interface Rig {
  readonly bus: EventBus<EventMap>;
  readonly cad: CadState;
  readonly radio: RadioSystem;
  readonly graph: RoadGraph;
  /** Every radio:* and unit:request event in order. */
  readonly events: { topic: string; payload: unknown }[];
  mode: RadioMode;
  /** Current sim time of the rig. */
  time: number;
  /** Steps the radio (60 Hz) until sim time `until`. */
  runUntil(until: number): void;
  /** Steps for `seconds`. */
  run(seconds: number): void;
  readonly player: { x: number; z: number };
}

export interface RigOptions {
  readonly mode?: RadioMode;
  readonly seed?: number;
  /** Silence ambient chatter (default true, so tests see only composed traffic). */
  readonly quiet?: boolean;
  readonly cad?: CadState;
  readonly bus?: EventBus<EventMap>;
}

const TOPICS = ['radio:start', 'radio:end', 'radio:blocked', 'radio:channel', 'unit:request'] as const;

export function makeRig(opts: RigOptions = {}): Rig {
  const bus =
    opts.bus ??
    new EventBus<EventMap>((topic, error) => {
      throw new Error(`${topic}: ${String(error)}`);
    });
  const cad = opts.cad ?? new CadState(bus);
  if (!opts.cad) {
    cad.addUnit({ callsign: PLAYER, kind: 'player', officer: 'Officer Doe', beat: 'downtown', fleetIndex: -1 }, at(0));
    cad.addUnit({ callsign: '21', kind: 'ai', officer: 'Officer Reyes', beat: 'downtown', fleetIndex: 0 }, at(0));
    cad.addUnit({ callsign: '23', kind: 'ai', officer: 'Officer Park', beat: 'suburbs', fleetIndex: 1 }, at(0));
  }
  const graph = crossGraph();
  const seed = opts.seed ?? SEED;
  const events: { topic: string; payload: unknown }[] = [];
  for (const topic of TOPICS) bus.on(topic, (payload) => events.push({ topic, payload }));
  const player = { x: 0, z: -30 };
  const rig: Rig = {
    bus,
    cad,
    graph,
    events,
    player,
    mode: opts.mode ?? 'tenCode',
    time: 0,
    radio: null as unknown as RadioSystem,
    runUntil(until: number) {
      while (rig.time < until - 1e-9) {
        rig.time += 1 / 60;
        rig.radio.step(1 / 60, at(rig.time), player);
      }
    },
    run(seconds: number) {
      rig.runUntil(rig.time + seconds);
    },
  };
  const rng = createRng(seed).stream('radio');
  (rig as { radio: RadioSystem }).radio = new RadioSystem({
    seed,
    rng,
    bus,
    cad,
    graph,
    playerCallsign: PLAYER,
    mode: () => rig.mode,
  });
  if (opts.quiet ?? true) silenceAmbient(rig.radio);
  return rig;
}

/** Pushes every ambient timer far into the future (restore keeps the rest of the state). */
export function silenceAmbient(radio: RadioSystem): void {
  const save = radio.serialize();
  save.ambientNext = { dispatch: 1e12, tac: 1e12, car: 1e12, fireEms: 1e12, county: 1e12, state: 1e12 };
  radio.restore(save);
}

export function starts(rig: Rig): Transmission[] {
  return rig.events.filter((e) => e.topic === 'radio:start').map((e) => (e.payload as { tx: Transmission }).tx);
}

export function texts(rig: Rig): string[] {
  return starts(rig).map((tx) => `${tx.speaker}: ${tx.text}`);
}

export function requests(rig: Rig): unknown[] {
  return rig.events.filter((e) => e.topic === 'unit:request').map((e) => e.payload);
}
