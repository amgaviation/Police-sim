import { addressOnEdge } from '../../src/cad/address';
import { CadState } from '../../src/cad/cadState';
import '../../src/cad/events';
import type { CadTime } from '../../src/cad/types';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { createRng } from '../../src/core/rng';
import { createGameWorld, type GameWorld } from '../../src/ecs/world';
import { PhysicsWorld } from '../../src/physics/physics';
import { DISPATCH_CONFIG, type DispatchConfig } from '../../src/dispatch/data';
import { Dispatcher, type PlayerUnitState } from '../../src/dispatch/dispatcher';
import { epochDayOfGameSeconds } from '../../src/records/calendar';
import { RecordsDb, homeEdgesOf } from '../../src/records/db';
import '../../src/traffic/events';
import { TrafficSystem, type TrafficFocus } from '../../src/traffic/trafficSystem';
import type { City } from '../../src/world/city';
import { DISTRICT_NAMES } from '../../src/world/ids';
import { cityFor } from '../world/helpers';

export const DT = 1 / 60;
export const SEED = 42;
/** Game seconds at sim 0 (07:00 on day 0). */
export const GAME0 = 7 * 3600;

export function at(sim: number): CadTime {
  return { sim, game: GAME0 + sim * 30 };
}

export interface Recorded {
  readonly topic: string;
  readonly payload: unknown;
}

export const TOPICS = [
  'cad:callCreated', 'cad:callClosed', 'cad:unitAssigned', 'cad:unitStatus', 'cad:trafficStop',
  'dispatch:offer', 'dispatch:plateResult', 'dispatch:personResult', 'dispatch:backup', 'dispatch:emergency',
  'dispatch:statusCheck', 'dispatch:location', 'dispatch:ack', 'dispatch:arrest',
] as const satisfies readonly (keyof EventMap)[];

export interface Harness {
  readonly seed: number;
  readonly city: City;
  readonly world: GameWorld;
  readonly physics: PhysicsWorld;
  readonly bus: EventBus<EventMap>;
  readonly traffic: TrafficSystem;
  readonly cad: CadState;
  readonly records: RecordsDb;
  readonly dispatcher: Dispatcher;
  readonly player: PlayerUnitState;
  readonly focus: TrafficFocus;
  readonly events: Recorded[];
  /** Current sim time (s). */
  sim: number;
}

export interface HarnessOptions {
  /** Ambient traffic density (0 = fleet cars only; faster). */
  density?: number;
  /** Call `start` (and populate traffic). Default true. */
  start?: boolean;
  /** Player position; default the city spawn. */
  player?: { x: number; z: number };
  config?: DispatchConfig;
  /** Player in a police vehicle (offers need it). Default true. */
  inPoliceVehicle?: boolean;
  /** Phase 6: roster names of the AI officers (`DispatchDeps.officerName`). */
  officerName?: (callsign: string) => string | null;
}

/** The default config with the call generator switched off (tests create calls themselves). */
export function quietConfig(patch: Partial<DispatchConfig> = {}): DispatchConfig {
  return { ...DISPATCH_CONFIG, generator: { ...DISPATCH_CONFIG.generator, firstCallDelayS: 1e9 }, ...patch };
}

/** A full dispatch stack on a generated city: world, physics, traffic, CAD, records and the dispatcher. */
export async function makeHarness(options: HarnessOptions = {}, seed = SEED): Promise<Harness> {
  const city = cityFor(seed);
  const world = createGameWorld();
  const physics = await PhysicsWorld.create();
  const bus = new EventBus<EventMap>((topic, error) => {
    throw new Error(`${topic}: ${String(error)}`);
  });
  const traffic = new TrafficSystem({ world, physics, graph: city.graph, city, seed, rng: createRng(seed).stream('traffic'), bus });
  traffic.densityScale = options.density ?? 0;
  const cad = new CadState(bus);
  const districtOf = (x: number, z: number): string => DISTRICT_NAMES[city.districtAt(x, z)] ?? '';
  const h: Harness = {
    seed,
    city,
    world,
    physics,
    bus,
    traffic,
    cad,
    records: undefined as unknown as RecordsDb,
    dispatcher: undefined as unknown as Dispatcher,
    player: { x: options.player?.x ?? city.spawn.x, z: options.player?.z ?? city.spawn.z, speed: 0, inPoliceVehicle: options.inPoliceVehicle ?? true },
    focus: { x: 0, z: 0, obstacle: false, ox: 0, oz: 0, ovx: 0, ovz: 0, oRadius: 2.4, oHalfWidth: 1 },
    events: [],
    sim: 0,
  };
  const records = new RecordsDb(seed, {
    homeEdges: homeEdgesOf(city),
    formatAddress: (edge, t) => addressOnEdge(city.graph, edge, t * (city.graph.edges[edge]?.length ?? 0), districtOf).text,
    today: () => epochDayOfGameSeconds(GAME0 + h.sim * 30),
  });
  const dispatcher = new Dispatcher({ seed, city, cad, records, traffic, world, bus, rng: createRng(seed).stream('dispatch'), config: options.config, officerName: options.officerName });
  Object.assign(h, { records, dispatcher });
  for (const topic of TOPICS) bus.on(topic, (payload) => h.events.push({ topic, payload }));
  syncFocus(h);
  if (options.start ?? true) {
    dispatcher.start(at(0), h.player);
    traffic.populate(h.focus, zone(h));
  }
  return h;
}

export function zone(h: Harness): { hour: number; isWeekday: boolean } {
  return { hour: ((GAME0 + h.sim * 30) % 86400) / 3600, isWeekday: true };
}

function syncFocus(h: Harness): void {
  h.focus.x = h.player.x;
  h.focus.z = h.player.z;
  h.focus.ox = h.player.x;
  h.focus.oz = h.player.z;
}

/** One fixed step: dispatch (-700) then traffic (50) then physics, like the session order. */
export function step(h: Harness): void {
  const t = at(h.sim);
  h.dispatcher.step(DT, t, h.player);
  syncFocus(h);
  h.sim += DT;
  h.traffic.step(DT, h.sim, zone(h), h.focus);
  h.physics.step();
}

export function run(h: Harness, seconds: number, each?: () => void): void {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    each?.();
    step(h);
  }
}

/** Steps until `pred` holds (or `maxSeconds` pass); returns whether it held. */
export function runUntil(h: Harness, pred: () => boolean, maxSeconds: number): boolean {
  const n = Math.round(maxSeconds / DT);
  for (let i = 0; i < n; i++) {
    if (pred()) return true;
    step(h);
  }
  return pred();
}

export function eventsOf<T>(h: Harness, topic: string): T[] {
  return h.events.filter((e) => e.topic === topic).map((e) => e.payload as T);
}

export function clearEvents(h: Harness): void {
  h.events.length = 0;
}
