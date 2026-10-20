import { addEntity } from 'bitecs';
import { CadState } from '../../src/cad/cadState';
import '../../src/cad/events';
import type { CadCall, CadLocation, CadTime, Priority } from '../../src/cad/types';
import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { createRng } from '../../src/core/rng';
import { createGameWorld, type GameWorld } from '../../src/ecs/world';
import type { ActorInfo } from '../../src/npc/types';
import { ACTOR_STATE } from '../../src/npc/types';
import type { RadioLinePayload } from '../../src/units';
import { RosterState, UNIT_TYPES, type UnitTypesData } from '../../src/units';
import type { FleeState, FleetState } from '../../src/traffic/trafficSystem';
import type { City } from '../../src/world/city';
import { ResourceSystem } from '../../src/resources/resourceSystem';
import type { ResourceDeps, ResourceNpcPort, ResourceTrafficPort } from '../../src/resources/types';
import type { SceneRequest } from '../../src/scene/types';
import { cityFor } from '../world/helpers';

export const DT = 1 / 60;
export const SEED = 42;
export const PLAYER = '12';

export function at(sim: number): CadTime {
  return { sim, game: 7 * 3600 + sim * 30 };
}

// --- Fake traffic ----------------------------------------------------------------------------------

export interface FakeCar {
  eid: number;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  hasDest: boolean;
  dx: number;
  dz: number;
  urgency: 'respond' | 'emergency';
  arrived: boolean;
  routeLeft: number;
}

export interface FakeTrafficSnapshot {
  cars: [number, Omit<FakeCar, 'eid'>][];
}

/** Straight-line fleet cars: deterministic, cheap, and with every state copyable. */
export class FakeTraffic implements ResourceTrafficPort {
  readonly cars = new Map<number, FakeCar>();
  readonly flees = new Map<number, FleeState>();
  readonly spawns: { index: number; x: number; z: number }[] = [];
  failSpawn = false;
  /** Cruise speeds (m/s). */
  speeds = { respond: 14, emergency: 22 };

  private readonly world: GameWorld;

  constructor(world: GameWorld) {
    this.world = world;
  }

  spawnFleetCar(index: number, x: number, z: number): number {
    if (this.failSpawn) return 0;
    const eid = addEntity(this.world);
    this.cars.set(index, { eid, x, z, yaw: 0, speed: 0, hasDest: false, dx: x, dz: z, urgency: 'respond', arrived: false, routeLeft: -1 });
    this.spawns.push({ index, x, z });
    return eid;
  }

  removeFleetCar(index: number): void {
    this.cars.delete(index);
  }

  setFleetDestination(index: number, x: number, z: number, urgency: 'respond' | 'emergency'): boolean {
    const c = this.cars.get(index);
    if (!c) return false;
    c.hasDest = true;
    c.dx = x;
    c.dz = z;
    c.urgency = urgency;
    c.arrived = false;
    c.routeLeft = Math.hypot(x - c.x, z - c.z) * 1.2;
    return true;
  }

  setFleetPatrol(index: number): void {
    const c = this.cars.get(index);
    if (c) {
      c.hasDest = false;
      c.routeLeft = -1;
    }
  }

  fleetState(index: number, out: FleetState): FleetState | null {
    const c = this.cars.get(index);
    if (!c) return null;
    out.eid = c.eid;
    out.x = c.x;
    out.z = c.z;
    out.yaw = c.yaw;
    out.speed = c.speed;
    out.edge = 0;
    out.mode = c.hasDest ? c.urgency : 'patrol';
    out.arrived = c.arrived;
    out.parked = !c.hasDest;
    out.routeLeftM = c.hasDest ? c.routeLeft : -1;
    return out;
  }

  fleeState(vehicleId: number, out: FleeState): boolean {
    const f = this.flees.get(vehicleId);
    if (!f) return false;
    out.x = f.x;
    out.z = f.z;
    out.yaw = f.yaw;
    out.speed = f.speed;
    out.edge = f.edge;
    return true;
  }

  step(dt: number): void {
    for (const c of this.cars.values()) {
      if (!c.hasDest) continue;
      const d = Math.hypot(c.dx - c.x, c.dz - c.z);
      if (d <= 3) {
        c.hasDest = false;
        c.arrived = true;
        c.speed = 0;
        c.routeLeft = -1;
        continue;
      }
      const v = this.speeds[c.urgency];
      const s = Math.min(v * dt, d);
      c.x += ((c.dx - c.x) / d) * s;
      c.z += ((c.dz - c.z) / d) * s;
      c.speed = v;
      c.yaw = Math.atan2(-(c.dx - c.x), -(c.dz - c.z));
      c.routeLeft = Math.max(0, c.routeLeft - s * 1.2);
    }
  }

  snapshot(): FakeTrafficSnapshot {
    return {
      cars: [...this.cars].map(([i, c]) => {
        const { eid: _eid, ...rest } = c;
        return [i, { ...rest }];
      }),
    };
  }

  restore(s: FakeTrafficSnapshot): void {
    this.cars.clear();
    for (const [i, c] of s.cars) this.cars.set(i, { ...c, eid: addEntity(this.world) });
  }
}

// --- Fake NPC --------------------------------------------------------------------------------------

export class FakeNpc implements ResourceNpcPort {
  readonly actors = new Map<number, ActorInfo>();
  readonly revealed: number[] = [];
  readonly removed: number[] = [];
  private readonly byPerson = new Map<number, number>();

  add(id: number, personId: number, x: number, z: number, patch: Partial<ActorInfo> = {}): ActorInfo {
    const a: ActorInfo = {
      id, personId, role: 'victim', callId: 1, state: ACTOR_STATE.idle, x, z, yaw: 0, stress: 0, cuffed: false, following: false,
      hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0, building: -1, ...patch,
    };
    this.actors.set(id, a);
    this.byPerson.set(personId, id);
    return a;
  }

  actorOfPerson(personId: number): number {
    return this.byPerson.get(personId) ?? 0;
  }

  actor(id: number, out: ActorInfo): ActorInfo | null {
    const a = this.actors.get(id);
    if (!a) return null;
    Object.assign(out, a);
    return out;
  }

  removeActor(id: number): void {
    this.actors.delete(id);
    this.removed.push(id);
  }

  reveal(id: number): void {
    const a = this.actors.get(id);
    if (a) a.hidden = false;
    this.revealed.push(id);
  }

  actorIds(out: number[]): number[] {
    out.length = 0;
    for (const id of this.actors.keys()) out.push(id);
    return out;
  }
}

// --- Harness ---------------------------------------------------------------------------------------

export interface HarnessOptions {
  /** Unit data variant (default the shipped data). */
  types?: UnitTypesData;
  /** City override (e.g. with a stubbed router). */
  city?: City;
  /** `trafficDensity` value (default 1). */
  density?: number;
  night?: boolean;
  wetness?: number;
  /** Whether the fake scene has a scenario for every call. */
  scenario?: boolean;
  /** Player position. */
  player?: { x: number; z: number };
}

export interface Harness {
  readonly city: City;
  readonly world: GameWorld;
  readonly bus: EventBus<EventMap>;
  readonly cad: CadState;
  readonly traffic: FakeTraffic;
  readonly npc: FakeNpc;
  readonly roster: RosterState;
  readonly res: ResourceSystem;
  readonly player: { x: number; z: number };
  readonly sceneRequests: SceneRequest[];
  readonly requested: Set<string>;
  readonly radio: RadioLinePayload[];
  readonly flashes: string[];
  readonly custody: [number, string][];
  readonly events: { topic: string; payload: unknown }[];
  readonly env: { wetness: number; night: boolean };
  scenario: boolean;
  sim: number;
}

export const TOPICS = ['resource:dispatched', 'resource:arrived', 'resource:cleared'] as const;

export function location(x: number, z: number): CadLocation {
  return { x, z, edge: -1, text: '100 Main Street', street: 'Main Street', cross: '1st Street', near: 'Main Street at 1st Street', district: 'downtown' };
}

export function makeHarness(options: HarnessOptions = {}): Harness {
  const city = options.city ?? cityFor(SEED);
  const world = createGameWorld();
  const bus = new EventBus<EventMap>((topic, error) => {
    throw new Error(`${topic}: ${String(error)}`);
  });
  const cad = new CadState(bus);
  const traffic = new FakeTraffic(world);
  const npc = new FakeNpc();
  const roster = new RosterState(SEED);
  const sceneRequests: SceneRequest[] = [];
  const requested = new Set<string>();
  const radio: RadioLinePayload[] = [];
  const flashes: string[] = [];
  const custody: [number, string][] = [];
  const events: { topic: string; payload: unknown }[] = [];
  const env = { wetness: options.wetness ?? 0, night: options.night ?? false };
  const player = options.player ?? { x: city.spawn.x, z: city.spawn.z };
  const h = { sim: 0, scenario: options.scenario ?? false } as Harness;
  const deps: ResourceDeps = {
    seed: SEED,
    bus,
    rng: createRng(SEED).stream('resources'),
    cad,
    city,
    world,
    traffic,
    scene: {
      request: (r) => {
        sceneRequests.push(r);
        if (r.kind === 'serviceRequest') requested.add(`${r.callId}:${r.service}`);
      },
      hasScenario: () => h.scenario,
      serviceRequested: (callId, kind) => requested.has(`${callId}:${kind}`),
    },
    dispatch: {
      playerCallsign: PLAYER,
      openSelfInitiated: (typeId, priority, p, narrative, t) => {
        const call = cad.createCall(
          { typeId, priority, location: location(p.x, p.z), caller: { kind: 'officer', name: 'Officer', phone: '', personId: -1 }, narrative, selfInitiated: true },
          t,
        );
        cad.assign(call.id, PLAYER, t, 'self');
        cad.setUnitStatus(PLAYER, 'onScene', t, 'auto');
        return { id: call.id };
      },
      locate: (x, z) => location(x, z),
    },
    npc,
    people: { setCustody: (id, c) => custody.push([id, c]) },
    roster,
    env: () => env,
    trafficDensity: () => options.density ?? 1,
    types: options.types,
  };
  const res = new ResourceSystem(deps);
  Object.assign(h, { city, world, bus, cad, traffic, npc, roster, res, player, sceneRequests, requested, radio, flashes, custody, events, env });
  bus.on('resource:radio', (p) => radio.push(p));
  bus.on('resource:flash', (p) => flashes.push(p.text));
  for (const topic of TOPICS) bus.on(topic, (payload) => events.push({ topic, payload }));
  cad.addUnit({ callsign: PLAYER, kind: 'player', officer: 'Officer', beat: 'downtown', fleetIndex: -1 }, at(0));
  cad.setUnitPosition(PLAYER, player.x, player.z);
  res.start(at(0));
  return h;
}

/** A pending call at (x, z) with the player assigned (so request defaults resolve to it). */
export function makeCall(h: Harness, priority: Priority, x: number, z: number, typeId = 'robbery'): CadCall {
  const t = at(h.sim);
  const call = h.cad.createCall(
    { typeId, priority, location: location(x, z), caller: { kind: 'citizen', name: 'Caller', phone: '555-0100', personId: -1 }, narrative: 'Test call.' },
    t,
  );
  h.cad.assign(call.id, PLAYER, t, 'dispatch');
  h.cad.setUnitStatus(PLAYER, 'onScene', t, 'auto');
  return call;
}

/** One fixed step: resources (-698) then traffic. */
export function step(h: Harness): void {
  h.res.step(DT, at(h.sim), h.player);
  h.sim += DT;
  h.traffic.step(DT);
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

export function view(h: Harness, callsign: string): { status: string; callId: number; etaS: number; x: number; z: number } {
  const v = h.res.units().find((u) => u.callsign === callsign);
  if (!v) throw new Error(`no unit ${callsign}`);
  return v;
}

export function eventsOf<T>(h: Harness, topic: string): T[] {
  return h.events.filter((e) => e.topic === topic).map((e) => e.payload as T);
}

/** The shipped unit data with `typeId` expanded to `count` units. */
export function withCount(typeId: string, count: number): UnitTypesData {
  return { ...UNIT_TYPES, types: UNIT_TYPES.types.map((t) => (t.id === typeId ? { ...t, count } : t)) };
}

/** A far point on the map from the station, ~`d` metres east of it. */
export function pointFromStation(h: Harness, d: number): { x: number; z: number } {
  const g = h.city.graph;
  const hit = g.nearestEdge(h.city.spawn.x + d, h.city.spawn.z, 4000, { edge: -1, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 });
  return hit ? { x: hit.x, z: hit.z } : { x: h.city.spawn.x + d, z: h.city.spawn.z };
}
