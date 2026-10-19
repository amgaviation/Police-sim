import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { createRng } from '../../src/core/rng';
import { NpcSystem } from '../../src/npc/npcSystem';
import type { ActorInfo, ActorSpawn, CommandContext, IndoorNavPort, NpcFocus } from '../../src/npc/types';
import { Population } from '../../src/people/population';
import { CALENDAR } from '../../src/records/calendar';
import { RecordsDb } from '../../src/records/db';
import type { TrafficSystem } from '../../src/traffic/trafficSystem';
import type { City } from '../../src/world/city';
import { DISTRICT, type DistrictId, type RoadEdge } from '../../src/world/roadGraph';
import { generateCity } from '../../src/world/generate';
import { fakeCtx } from '../records/helpers';
import { makeHarness, type Harness } from '../traffic/helpers';

export const DT = 1 / 60;
export const NOON = 12 * 3600;
export const NIGHT = 2 * 3600;
export const SEED = 77;

/** The captured events of one rig, by topic. */
export type Captured = Record<string, Record<string, unknown>[]>;

export interface NpcRig {
  readonly npc: NpcSystem;
  readonly city: City;
  readonly people: Population;
  readonly traffic: Harness;
  readonly bus: EventBus<EventMap>;
  readonly clock: { t: number };
  readonly focus: NpcFocus;
  /** Captured `npc:*` events. */
  readonly events: Captured;
  /** Steps the NPC system (the traffic system only when `withTraffic`). */
  run(steps: number, dt?: number): void;
}

const TOPICS = ['npc:fled', 'npc:caught', 'npc:escaped', 'npc:surrendered', 'npc:attack', 'npc:weaponDropped', 'npc:left', 'npc:revealed', 'npc:aware'] as const;

let cityCache: { seed: number; city: City } | null = null;

/** One generated city per seed for the whole run (generation takes ~100 ms). */
export function cityOf(seed: number = SEED): City {
  if (cityCache?.seed !== seed) cityCache = { seed, city: generateCity(seed) };
  return cityCache.city;
}

export function makeFocus(x = 0, z = 0): NpcFocus {
  return { x, z, yaw: 0, speed: 0, onFoot: true, weapon: 'none', lights: false, backup: 0 };
}

export interface RigOptions {
  seed?: number;
  /** Game seconds the clock starts at (default noon of day 0). */
  start?: number;
  x?: number;
  z?: number;
  /** Pedestrian density scale (default 1; 0 gives an actors-only rig). */
  density?: number;
}

/** A full NPC rig: generated city, records + population, a real traffic system (not stepped), event capture. */
export async function makeRig(options: RigOptions = {}): Promise<NpcRig> {
  const seed = options.seed ?? SEED;
  const city = cityOf(seed);
  const traffic = await makeHarness(city.graph, seed, city);
  const bus = new EventBus<EventMap>();
  const clock = { t: options.start ?? NOON };
  const records = new RecordsDb(seed, fakeCtx(CALENDAR.startEpochDay));
  const people = new Population({ seed, records, now: () => clock.t });
  const npc = new NpcSystem({
    seed,
    rng: createRng(seed).stream('npc'),
    city,
    people,
    traffic: traffic.sys,
    world: traffic.world,
    bus,
    now: () => clock.t,
  });
  if (options.density !== undefined) npc.setDensityScale(options.density);
  const events: Captured = {};
  for (const topic of TOPICS) {
    events[topic] = [];
    bus.on(topic, (e) => (events[topic] as Record<string, unknown>[]).push({ ...e }));
  }
  const focus = makeFocus(options.x ?? 0, options.z ?? 0);
  let t = 0;
  return {
    npc,
    city,
    people,
    traffic,
    bus,
    clock,
    focus,
    events,
    run(steps: number, dt: number = DT): void {
      for (let i = 0; i < steps; i++) {
        t += dt;
        npc.step(dt, t, focus);
      }
    },
  };
}

/** Midpoint of the longest sidewalked edge of `district` (deterministic), or null. */
export function spotIn(city: City, district: DistrictId): { x: number; z: number } | null {
  let best: RoadEdge | null = null;
  for (const e of city.graph.edges) {
    if (e.district === district && e.sidewalk > 0 && (best === null || e.length > best.length)) best = e;
  }
  if (!best) return null;
  const p = best.points;
  return { x: ((p[0] ?? 0) + (p[p.length - 2] ?? 0)) / 2, z: ((p[1] ?? 0) + (p[p.length - 1] ?? 0)) / 2 };
}

export const DOWNTOWN = DISTRICT.downtown;

export function spec(personId: number, x: number, z: number, over: Partial<ActorSpawn> = {}): ActorSpawn {
  return { personId, x, z, yaw: 0, profile: 'suspectCalm', role: 'suspect', callId: 7, hidden: false, body: 'human', weapon: null, vehicleId: -1, ...over };
}

export function info(): ActorInfo {
  return {
    id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false,
    armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
  };
}

export function stateOf(npc: NpcSystem, id: number): number {
  return npc.actor(id, info())?.state ?? -1;
}

export function ctx(over: Partial<CommandContext> = {}): CommandContext {
  return { tone: 'neutral', rapport: 0, commMode: 'verbal', weapon: 'none', backup: 0, lights: false, ...over };
}

export type { TrafficSystem };

/** A scripted `IndoorNavPort`: straight paths, one fixed way out, one fixed hiding spot; every call is recorded. */
export class StubNav implements IndoorNavPort {
  /** Route to the way out (x, z pairs); empty = no way out. */
  exitRoute: number[] = [];
  exitPose = { x: 0, z: 0, yaw: 0 };
  /** Index of the hiding spot, -1 = none. */
  hideIndex = -1;
  hidePose = { x: 0, z: 0, yaw: 0 };
  readonly paths: { building: number; x: number; z: number; tx: number; tz: number }[] = [];
  readonly exits: number[] = [];
  readonly hides: { building: number; awayX: number; awayZ: number }[] = [];
  readonly released: { building: number; index: number }[] = [];

  path(building: number, x: number, z: number, tx: number, tz: number, out: Float32Array): number {
    this.paths.push({ building, x, z, tx, tz });
    out[0] = tx;
    out[1] = tz;
    return 1;
  }

  exit(building: number, _x: number, _z: number, out: Float32Array, pose: { x: number; z: number; yaw: number }): number {
    this.exits.push(building);
    if (this.exitRoute.length === 0) return 0;
    for (let i = 0; i < this.exitRoute.length; i++) out[i] = this.exitRoute[i] as number;
    pose.x = this.exitPose.x;
    pose.z = this.exitPose.z;
    pose.yaw = this.exitPose.yaw;
    return this.exitRoute.length / 2;
  }

  hideSpot(building: number, _x: number, _z: number, awayX: number, awayZ: number, pose: { x: number; z: number; yaw: number }): number {
    this.hides.push({ building, awayX, awayZ });
    if (this.hideIndex < 0) return -1;
    pose.x = this.hidePose.x;
    pose.z = this.hidePose.z;
    pose.yaw = this.hidePose.yaw;
    return this.hideIndex;
  }

  releaseHide(building: number, index: number): void {
    this.released.push({ building, index });
  }
}
