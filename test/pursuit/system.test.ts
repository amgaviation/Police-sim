import { describe, expect, it } from 'vitest';
import { CadState } from '../../src/cad/cadState';
import type { CadLocation } from '../../src/cad/types';
import { createRng } from '../../src/core/rng';
import type { PursuitOrderEvent } from '../../src/incidents/events';
import type { ActorInfo } from '../../src/npc/types';
import { PURSUIT_CONFIG } from '../../src/pursuit/data';
import { perimeterPosts } from '../../src/pursuit/perimeter';
import { isPursuitSave } from '../../src/pursuit/save';
import { PursuitSystem } from '../../src/pursuit/pursuitSystem';
import type { PursuitHandoffEvent, PursuitTacticEvent } from '../../src/pursuit/events';
import type {
  PursuitConfig,
  PursuitContext,
  PursuitNpcPort,
  PursuitRequest,
  ResourcePort,
} from '../../src/pursuit/types';
import type { SceneRequest } from '../../src/scene/types';
import { PULLOVER } from '../../src/traffic/data';
import type { TrafficFleeEndedEvent } from '../../src/traffic/events';
import type { FleeInfo } from '../../src/traffic/trafficSystem';
import type { FlashPayload, RadioLinePayload } from '../../src/units/types';
import { vehicleModel } from '../../src/vehicles/model';
import { MPH } from '../../src/world/constants';
import { generateCity } from '../../src/world/generate';
import { laneRef, type LanePoint, type RoadGraph } from '../../src/world/roadGraph';
import { DT, NOON, buildGraph, makeHarness, type Harness } from '../traffic/helpers';

const CITY = generateCity(42);
const ID = 77;
const PERSON = 5;
const CAR_ID = 4242;
const SEDAN = vehicleModel('sedan').body;
const CALLER = { kind: 'citizen', name: 'Caller', phone: '555-0100', personId: -1 } as const;
const LOC: CadLocation = { x: 0, z: 0, edge: 0, text: 'Test Road', street: 'Test Road', cross: '', near: 'Test Road', district: 'suburbs' };

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Runs `fn` with random flee give-ups switched off. */
async function noGiveUp<T>(fn: () => Promise<T>): Promise<T> {
  const flee = PULLOVER.flee as Mutable<typeof PULLOVER.flee>;
  const saved = flee.giveUpPerMin;
  flee.giveUpPerMin = 0;
  try {
    return await fn();
  } finally {
    flee.giveUpPerMin = saved;
  }
}

// --- Fakes ---------------------------------------------------------------------------------------------------------

class FakeDispatcher {
  onCall: string[] = [];
  directed = new Map<string, { x: number; z: number }>();
  undirected: string[] = [];
  backups: number[] = [];
  teleport = true;
  private readonly cad: CadState;
  constructor(cad: CadState) {
    this.cad = cad;
  }
  directUnit(cs: string, x: number, z: number, _u: 'respond' | 'emergency'): boolean {
    this.directed.set(cs, { x, z });
    if (this.teleport) this.cad.setUnitPosition(cs, x, z);
    return true;
  }
  undirectUnit(cs: string): void {
    this.undirected.push(cs);
    this.directed.delete(cs);
  }
  aiUnitsOnCall(_callId: number, out: string[]): string[] {
    out.length = 0;
    for (const cs of this.onCall) out.push(cs);
    return out;
  }
  sendBackup(_code: 2 | 3, n: number): string[] {
    this.backups.push(n);
    return [];
  }
}

class FakeResources implements ResourcePort {
  requests: { typeId: string; callId: number; via: string }[] = [];
  sup: string | null = null;
  airUp = false;
  airOnTarget = false;
  airPos = { x: 0, z: 0 };
  targets: { kind: string; id: number }[] = [];
  directToOk = new Set<string>();
  directToCalls: string[] = [];
  poses = new Map<string, { x: number; z: number; yaw: number; speed: number }>();
  requestType(typeId: string, callId: number, via: 'radio' | 'mdt' | 'auto'): void {
    this.requests.push({ typeId, callId, via });
  }
  supervisorFor(): string | null {
    return this.sup;
  }
  onScene(): number {
    return 0;
  }
  onSceneUnits(_callId: number, _typeId: string, out: string[]): string[] {
    out.length = 0;
    return out;
  }
  air(out: { x: number; z: number; y: number; onTarget: boolean; spot: boolean }): boolean {
    if (!this.airUp) return false;
    out.x = this.airPos.x;
    out.z = this.airPos.z;
    out.y = 150;
    out.onTarget = this.airOnTarget;
    out.spot = false;
    return true;
  }
  setAirTarget(kind: 'vehicle' | 'actor' | 'point' | 'none', id: number): void {
    this.targets.push({ kind, id });
  }
  transport(): boolean {
    return false;
  }
  directTo(cs: string): boolean {
    this.directToCalls.push(cs);
    return this.directToOk.has(cs);
  }
  unitPose(cs: string, out: { x: number; z: number; yaw: number; speed: number }): boolean {
    const p = this.poses.get(cs);
    if (!p) return false;
    Object.assign(out, p);
    return true;
  }
}

class FakeNpc implements PursuitNpcPort {
  actors = new Map<number, { x: number; z: number }>();
  forced: { id: number; state: string }[] = [];
  actorOfPerson(personId: number): number {
    return personId === PERSON ? 88 : -1;
  }
  actor(id: number, out: ActorInfo): ActorInfo | null {
    const a = this.actors.get(id);
    if (!a) return null;
    out.x = a.x;
    out.z = a.z;
    return out;
  }
  forceState(id: number, s: 'handsUp'): void {
    this.forced.push({ id, state: s });
  }
}

interface Log {
  orders: PursuitOrderEvent[];
  tactics: PursuitTacticEvent[];
  radio: RadioLinePayload[];
  flashes: string[];
  handoffs: PursuitHandoffEvent[];
  ended: TrafficFleeEndedEvent[];
}

interface World {
  h: Harness;
  pursuit: PursuitSystem;
  cad: CadState;
  sim: number;
  ctx: PursuitContext;
  log: Log;
  dispatcher: FakeDispatcher;
  resources: FakeResources;
  npc: FakeNpc;
  sceneRequests: SceneRequest[];
  rules: { offense: string | null; allowed: string[]; maxDurationS: number; graceS: number };
  callId: number;
  burst: { count: number };
  strips: { carried: number };
  rngSeed: number;
  /** Keep the player 20 m behind the suspect (in sight) unless a test places the player itself. */
  trackPlayer: boolean;
}

interface Options {
  graph?: RoadGraph;
  city?: ReturnType<typeof generateCity>;
  config?: PursuitConfig;
  seed?: number;
}

function info(): FleeInfo {
  return { x: 0, z: 0, yaw: 0, speed: 0, edge: 0, deflated: 0, spinning: false, capMps: 0, tracked: false };
}

function cfgWith(patch: { [K in keyof PursuitConfig]?: Partial<PursuitConfig[K]> }): PursuitConfig {
  const out = { ...PURSUIT_CONFIG } as Mutable<PursuitConfig>;
  for (const k of Object.keys(patch) as (keyof PursuitConfig)[]) {
    (out as unknown as Record<string, unknown>)[k] = { ...(PURSUIT_CONFIG[k] as object), ...(patch[k] as object) };
  }
  return out;
}

async function makeWorld(opts: Options = {}): Promise<World> {
  const city = opts.city ?? CITY;
  const graph = opts.graph ?? city.graph;
  const h = await makeHarness(graph, 42, opts.graph ? undefined : city);
  h.sys.densityScale = 0;
  const cad = new CadState(h.bus);
  const t0 = { sim: 0, game: 0 };
  for (const cs of ['21', '22', '23', '24']) cad.addUnit({ callsign: cs, kind: 'ai', officer: 'Officer', beat: '1', fleetIndex: -1 }, t0);
  const call = cad.createCall(
    { typeId: 'vehiclePursuit', priority: 1, location: LOC, caller: CALLER, narrative: 'Pursuit', selfInitiated: true, vehicles: [ID], persons: [PERSON] },
    t0,
  );
  const dispatcher = new FakeDispatcher(cad);
  const resources = new FakeResources();
  const npc = new FakeNpc();
  const sceneRequests: SceneRequest[] = [];
  const rules = { offense: 'violent' as string | null, allowed: ['violent', 'felonyVehicle', 'weapons', 'warrant'], maxDurationS: 600, graceS: 15 };
  const seed = opts.seed ?? 7;
  const pursuit = new PursuitSystem({
    seed: 42,
    bus: h.bus,
    rng: createRng(seed).stream('pursuit'),
    graph,
    cad,
    traffic: h.sys,
    dispatcher,
    resources,
    scene: { request: (r) => sceneRequests.push(r) },
    npc,
    rules: {
      allowedOffenses: () => rules.allowed,
      maxDurationS: () => rules.maxDurationS,
      terminateGraceS: () => rules.graceS,
      allowedOverMph: () => 15,
      offense: () => rules.offense,
    },
    modelOf: () => 'sedan',
    roadAt: () => ({ district: 'suburbs', limitMph: 35 }),
    env: () => ({ wet: false, night: false }),
    trafficDensity: () => 0.5,
    config: opts.config,
  });
  const burst = { count: 0 };
  const strips = { carried: 2 };
  pursuit.burstPlayerTires = () => {
    burst.count++;
  };
  pursuit.takeStripFromKit = () => {
    if (strips.carried <= 0) return false;
    strips.carried--;
    return true;
  };
  const log: Log = { orders: [], tactics: [], radio: [], flashes: [], handoffs: [], ended: [] };
  h.bus.on('pursuit:order', (e) => log.orders.push(e));
  h.bus.on('pursuit:tactic', (e) => log.tactics.push(e));
  h.bus.on('pursuit:radio', (e) => log.radio.push(e));
  h.bus.on('pursuit:flash', (e: FlashPayload) => log.flashes.push(e.text));
  h.bus.on('pursuit:handoff', (e) => log.handoffs.push(e));
  // Stand-in for the scene director: a flee ending ends the pursuit.
  h.bus.on('traffic:fleeEnded', (e) => {
    log.ended.push(e);
    h.bus.emit('scene:pursuit', { kind: 'vehicle', active: false, callId: call.id, personId: PERSON, endReason: e.reason });
  });
  const ctx: PursuitContext = {
    car: null, carId: 0, lights: true, siren: true, onFoot: false, x: 0, z: 0, yaw: 0, carryingStrip: false, playerCallsign: '1-A-12',
  };
  return { h, pursuit, cad, sim: 0, ctx, log, dispatcher, resources, npc, sceneRequests, rules, callId: call.id, burst, strips, rngSeed: seed, trackPlayer: true };
}

/** The first edge at least `minLen` long with a forward lane. */
function longEdge(graph: RoadGraph, minLen = 300): number {
  const e = graph.edges.find((x) => x.length >= minLen && x.lanesForward >= 1);
  if (!e) throw new Error('no long edge');
  return e.id;
}

/** A fleeing car on `edge` at `s`, doing `speed`, capped at `cap` m/s; the scene announces the pursuit. */
function startPursuit(w: World, edge: number, s: number, cap = 13): void {
  const slot = w.h.sys.spawnAt(laneRef(edge, 0, 0), s, { vehicleId: ID, speed: Math.min(12, cap), behavior: 0, desiredFactor: 1 });
  if (slot < 0) throw new Error('spawn failed');
  expect(w.h.sys.flee(ID)).toBe(true);
  if (Number.isFinite(cap)) w.h.sys.setFleeSpeedCap(ID, cap);
  follow(w);
  w.h.bus.emit('scene:pursuit', { kind: 'vehicle', active: true, callId: w.callId, personId: PERSON, ownerCallId: 0 });
}

function follow(w: World): void {
  const slot = w.h.sys.slotOfVehicle(ID);
  if (slot < 0) return;
  w.h.focus.x = w.h.sys.view.x[slot] ?? 0;
  w.h.focus.z = w.h.sys.view.z[slot] ?? 0;
}

/** Steps the pursuit system and the traffic for `n` fixed steps. */
function run(w: World, n: number, each?: () => void): void {
  for (let i = 0; i < n; i++) {
    each?.();
    w.sim += DT;
    w.pursuit.step(DT, { sim: w.sim, game: w.sim * 30 }, w.ctx);
    w.h.sys.step(DT, w.sim, NOON, w.h.focus);
    w.h.physics.step();
    follow(w);
    if (w.trackPlayer) {
      const slot = w.h.sys.slotOfVehicle(ID);
      if (slot >= 0) {
        w.ctx.x = (w.h.sys.view.x[slot] ?? 0) - 20;
        w.ctx.z = w.h.sys.view.z[slot] ?? 0;
      }
    }
  }
}

const sec = (s: number): number => Math.round(s / DT);

function suspectInfo(w: World): FleeInfo {
  const out = info();
  w.h.sys.fleeInfo(ID, out);
  return out;
}

/** Police pose whose front centre sits at the suspect-local (along, lateral) with the suspect's heading. */
function policeAt(f: FleeInfo, along: number, lateral: number, dSpeed: number): NonNullable<PursuitContext['car']> {
  const fx = -Math.sin(f.yaw), fz = -Math.cos(f.yaw);
  const rx = Math.cos(f.yaw), rz = -Math.sin(f.yaw);
  const hl = 2.4;
  const cx = f.x + fx * along + rx * lateral;
  const cz = f.z + fz * along + rz * lateral;
  return { x: cx - fx * hl, z: cz - fz * hl, yaw: f.yaw, speed: f.speed + dSpeed, halfLength: hl, halfWidth: 0.95 };
}

function collide(w: World, other = CAR_ID): void {
  w.h.bus.emit('traffic:collision', { eid: 1, vehicleId: ID, other, impactSpeed: 3, fleeing: true });
}

/** A 3-node straight road (400 m arms, dead end on both sides) for deterministic route tests. */
function chainGraph(): RoadGraph {
  return buildGraph([[-400, 0], [0, 0], [400, 0]], [{ from: 0, to: 1, speedMph: 35 }, { from: 1, to: 2, speedMph: 35 }]);
}

function lanePoint(graph: RoadGraph, edge: number, s: number): LanePoint {
  const out: LanePoint = { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 };
  return graph.lanePoint(laneRef(edge, 0, 0), s, out);
}

/** A road node with four perimeter posts around it. */
function densePoint(): { x: number; z: number } {
  for (const n of CITY.graph.nodes) {
    if (perimeterPosts(CITY.graph, n.x, n.z, PURSUIT_CONFIG.perimeter.radiusM, PURSUIT_CONFIG.perimeter.posts).length === 4) return { x: n.x, z: n.z };
  }
  throw new Error('no dense node');
}

// --- Tests ------------------------------------------------------------------------------------------------------------

describe('contact: PIT, ram, bump', () => {
  it('spins out the suspect on a PIT outside policy without authorization and reports the verdict', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      startPursuit(w, longEdge(CITY.graph), 40);
      run(w, sec(3));
      expect(w.pursuit.active()).toBe(true);
      const f = suspectInfo(w);
      expect(f.speed / MPH).toBeGreaterThan(20);
      w.ctx.carId = CAR_ID;
      w.ctx.car = policeAt(f, -SEDAN.length / 2 * 0.8, SEDAN.width / 2 * 0.6, 1);
      collide(w);
      run(w, 1);
      expect(suspectInfo(w).spinning).toBe(true);
      expect(w.log.tactics).toHaveLength(1);
      expect(w.log.tactics[0]?.tactic).toBe('pit');
      expect(w.log.tactics[0]?.verdict).toBe('outsidePolicy');
      expect(w.log.tactics[0]?.text).toMatch(/no supervisor authorization/);
      expect(w.pursuit.hud()?.verdict).toMatch(/outside policy/);
      // The spin ends in a wreck: the flee ends crashed and the pursuit closes.
      run(w, sec(PULLOVER.spin.durationS + 1));
      expect(w.log.ended.map((e) => e.reason)).toEqual(['crashed']);
      expect(w.pursuit.active()).toBe(false);
      expect(w.pursuit.hud()).toBeNull();
    });
  });

  it('is within policy once the supervisor authorized the PIT', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      const graph = CITY.graph;
      startPursuit(w, longEdge(graph), 40);
      w.resources.sup = 'SGT-1';
      run(w, sec(3));
      w.pursuit.request({ kind: 'requestPit' });
      run(w, 1);
      expect(w.log.orders.map((o) => o.order)).toEqual(['authorizePit']);
      expect(w.log.orders[0]?.by).toBe('SGT-1');
      expect(w.log.radio.at(-1)?.text).toMatch(/PIT authorized/);
      const f = suspectInfo(w);
      w.ctx.carId = CAR_ID;
      w.ctx.car = policeAt(f, -SEDAN.length / 2 * 0.8, -SEDAN.width / 2 * 0.6, 1);
      collide(w);
      run(w, 1);
      expect(w.log.tactics[0]?.verdict).toBe('withinPolicy');
      expect(w.pursuit.hud()?.verdict).toBe('PIT: within policy');
      expect(suspectInfo(w).spinning).toBe(true);
    });
  });

  it('ignores contacts from other bodies and while on foot', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      startPursuit(w, longEdge(CITY.graph), 40);
      run(w, sec(2));
      const f = suspectInfo(w);
      w.ctx.carId = CAR_ID;
      w.ctx.car = policeAt(f, -SEDAN.length / 2 * 0.8, 0.6, 1);
      collide(w, 99);
      run(w, 1);
      expect(w.log.tactics).toHaveLength(0);
      expect(suspectInfo(w).spinning).toBe(false);
      w.ctx.car = null;
      collide(w);
      run(w, 1);
      expect(w.log.tactics).toHaveLength(0);
    });
  });

  it('crashes the suspect when ramming and does nothing on a bump', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      startPursuit(w, longEdge(CITY.graph), 40);
      run(w, sec(2));
      let f = suspectInfo(w);
      w.ctx.carId = CAR_ID;
      // A tap at the rear centre, slowly: a bump.
      w.ctx.car = policeAt(f, -SEDAN.length / 2, 0, 0.5);
      collide(w);
      run(w, 1);
      expect(w.log.flashes).toContain('Contact, no effect');
      expect(w.log.tactics).toHaveLength(0);
      expect(w.pursuit.active()).toBe(true);
      // A hard hit from the side: a ram.
      f = suspectInfo(w);
      // The police car faces the suspect's right side, its nose on the suspect's left flank.
      const rx = Math.cos(f.yaw), rz = -Math.sin(f.yaw);
      const hl = 2.4;
      const nose = { x: f.x - rx * (SEDAN.width / 2), z: f.z - rz * (SEDAN.width / 2) };
      w.ctx.car = { x: nose.x - rx * hl, z: nose.z - rz * hl, yaw: f.yaw - Math.PI / 2, speed: 14, halfLength: hl, halfWidth: 0.95 };
      collide(w);
      run(w, 1);
      expect(w.log.tactics).toHaveLength(1);
      expect(w.log.tactics[0]?.verdict).toBe('outsidePolicy');
      expect(w.log.tactics[0]?.text).toMatch(/Ramming/);
      run(w, 2);
      expect(w.log.ended.map((e) => e.reason)).toEqual(['crashed']);
    });
  });
});

describe('PIT authorization', () => {
  it('is denied without a supervisor', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      startPursuit(w, longEdge(CITY.graph), 40);
      run(w, sec(1));
      w.pursuit.request({ kind: 'requestPit' });
      run(w, 1);
      expect(w.log.orders).toHaveLength(1);
      expect(w.log.orders[0]?.order).toBe('denyPit');
      expect(w.log.orders[0]?.text).toBe('No supervisor available, PIT not authorized.');
      expect(w.log.radio.at(-1)?.priority).toBe(true);
    });
  });

  it('is denied for an offense that does not allow it, with the reason', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      startPursuit(w, longEdge(CITY.graph), 40);
      w.resources.sup = 'SGT-1';
      w.rules.offense = 'traffic';
      run(w, sec(1));
      w.pursuit.request({ kind: 'requestPit' });
      run(w, 1);
      expect(w.log.orders[0]?.order).toBe('denyPit');
      expect(w.log.orders[0]?.text).toMatch(/offense does not allow a PIT/);
      expect(w.log.orders[0]?.by).toBe('SGT-1');
    });
  });

  it('is granted for a violent offense, once, and stays until the pursuit ends', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      startPursuit(w, longEdge(CITY.graph), 40);
      w.resources.sup = 'SGT-1';
      run(w, sec(1));
      w.pursuit.request({ kind: 'requestPit' });
      run(w, 1);
      expect(w.pursuit.menu().find((m) => m.id === 'requestPit')?.enabled).toBe(false);
      w.pursuit.request({ kind: 'requestPit' });
      run(w, 1);
      expect(w.log.orders.map((o) => o.order)).toEqual(['authorizePit']);
      expect(w.log.flashes).toContain('PIT already authorized');
      expect(w.pursuit.serialize().pursuit?.pitAuthorized).toBe(true);
    });
  });

  it('without a pursuit only flashes', async () => {
    const w = await makeWorld();
    w.pursuit.request({ kind: 'requestPit' });
    run(w, 1);
    expect(w.log.orders).toHaveLength(0);
    expect(w.log.flashes).toEqual(['No active pursuit']);
  });
});

describe('spike strips', () => {
  it('the player deploys a strip from the kit and the suspect deflates two tyres crossing it', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      const graph = CITY.graph;
      const edge = longEdge(graph);
      startPursuit(w, edge, 40);
      const spot = lanePoint(graph, edge, 200);
      w.ctx.onFoot = true;
      w.ctx.carryingStrip = true;
      w.ctx.x = spot.x;
      w.ctx.z = spot.z;
      w.pursuit.request({ kind: 'deployStrip' });
      run(w, 1);
      expect(w.pursuit.strips()).toHaveLength(1);
      const strip = w.pursuit.strips()[0];
      expect(strip?.owner).toBe('1-A-12');
      expect(strip?.active).toBe(true);
      expect(w.strips.carried).toBe(1);
      expect(Math.hypot((strip?.x1 ?? 0) - (strip?.x0 ?? 0), (strip?.z1 ?? 0) - (strip?.z0 ?? 0))).toBeCloseTo(PURSUIT_CONFIG.spikes.lengthM, 3);
      run(w, sec(20));
      const f = suspectInfo(w);
      expect(f.deflated).toBe(PURSUIT_CONFIG.spikes.tiresOnHit);
      expect(w.pursuit.strips()[0]?.active).toBe(false);
      expect(w.log.tactics.some((t) => t.tactic === 'spikes' && t.verdict === 'success')).toBe(true);
      expect(w.log.radio.some((r) => /spikes hit/.test(r.text))).toBe(true);
      // The strip is used up: a second pass does not deflate again.
      expect(w.log.tactics.filter((t) => t.tactic === 'spikes')).toHaveLength(1);
    });
  });

  it('refuses without a carried strip, on a car, or with the kit empty', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      const graph = CITY.graph;
      const edge = longEdge(graph);
      const spot = lanePoint(graph, edge, 200);
      w.ctx.x = spot.x;
      w.ctx.z = spot.z;
      w.ctx.onFoot = false;
      w.ctx.carryingStrip = true;
      w.pursuit.request({ kind: 'deployStrip' });
      run(w, 1);
      expect(w.log.flashes.at(-1)).toBe('You need to be on foot with a spike strip');
      w.ctx.onFoot = true;
      w.ctx.carryingStrip = false;
      w.pursuit.request({ kind: 'deployStrip' });
      run(w, 1);
      expect(w.log.flashes.at(-1)).toBe('You need to be on foot with a spike strip');
      w.ctx.carryingStrip = true;
      w.strips.carried = 0;
      w.pursuit.request({ kind: 'deployStrip' });
      run(w, 1);
      expect(w.log.flashes.at(-1)).toBe('No spike strip to deploy');
      w.ctx.x = 99999;
      w.pursuit.request({ kind: 'deployStrip' });
      run(w, 1);
      expect(w.log.flashes.at(-1)).toBe('No road within reach');
      expect(w.pursuit.strips()).toHaveLength(0);
    });
  });

  it('bursts the player tyres when the player car drives over a live strip', async () => {
    const w = await makeWorld();
    const graph = CITY.graph;
    const edge = longEdge(graph);
    const spot = lanePoint(graph, edge, 200);
    w.ctx.onFoot = true;
    w.ctx.carryingStrip = true;
    w.ctx.x = spot.x;
    w.ctx.z = spot.z;
    w.pursuit.request({ kind: 'deployStrip' });
    run(w, 1);
    expect(w.pursuit.strips()).toHaveLength(1);
    const strip = w.pursuit.strips()[0];
    if (!strip) throw new Error('no strip');
    const mx = (strip.x0 + strip.x1) / 2, mz = (strip.z0 + strip.z1) / 2;
    // The car drives across the strip at 10 m/s, perpendicular to it.
    const dx = strip.x1 - strip.x0, dz = strip.z1 - strip.z0;
    const len = Math.hypot(dx, dz);
    const hx = -dz / len, hz = dx / len;
    const yaw = Math.atan2(-hx, -hz);
    w.ctx.onFoot = false;
    w.ctx.carryingStrip = false;
    w.ctx.carId = CAR_ID;
    const speed = 10;
    run(w, 1, () => {
      w.ctx.car = { x: mx - hx * 0.05, z: mz - hz * 0.05, yaw, speed, halfLength: 2.4, halfWidth: 0.95 };
    });
    expect(w.burst.count).toBe(0);
    run(w, 1, () => {
      w.ctx.car = { x: mx + hx * 0.1, z: mz + hz * 0.1, yaw, speed, halfLength: 2.4, halfWidth: 0.95 };
    });
    expect(w.burst.count).toBe(1);
    expect(w.log.flashes).toContain('You drove over your own spike strip');
    expect(w.pursuit.strips()[0]?.active).toBe(false);
    run(w, 1);
    expect(w.burst.count).toBe(1);
  });

  it('expires strips after expireS', async () => {
    const w = await makeWorld();
    const graph = CITY.graph;
    const edge = longEdge(graph);
    const spot = lanePoint(graph, edge, 200);
    w.ctx.onFoot = true;
    w.ctx.carryingStrip = true;
    w.ctx.x = spot.x;
    w.ctx.z = spot.z;
    w.pursuit.request({ kind: 'deployStrip' });
    run(w, 1);
    run(w, sec(PURSUIT_CONFIG.spikes.expireS - 2));
    expect(w.pursuit.strips()).toHaveLength(1);
    run(w, sec(3));
    expect(w.pursuit.strips()).toHaveLength(0);
  });

  it('an AI unit sent ahead sets a strip across the road and the suspect hits it', async () => {
    await noGiveUp(async () => {
      const graph = chainGraph();
      const w = await makeWorld({ graph });
      w.dispatcher.onCall = ['21'];
      startPursuit(w, 0, 100);
      run(w, sec(1));
      w.pursuit.request({ kind: 'spikesAhead' });
      run(w, 1);
      // The unit is sent to the second node of the predicted route, the dead end at x = 400.
      expect(w.dispatcher.directed.get('21')).toEqual({ x: 400, z: 0 });
      expect(w.pursuit.serialize().pursuit?.tactic).toMatchObject({ kind: 'spikes', unit: '21', node: 2 });
      expect(w.pursuit.strips()).toHaveLength(0);
      run(w, sec(2));
      expect(w.pursuit.strips()).toHaveLength(1);
      const strip = w.pursuit.strips()[0];
      expect(strip?.owner).toBe('21');
      // 25 m before the node at x = 400.
      expect(((strip?.x0 ?? 0) + (strip?.x1 ?? 0)) / 2).toBeCloseTo(375, 3);
      expect(w.log.radio.some((r) => r.speaker === '21' && /spikes deployed/.test(r.text))).toBe(true);
      for (let k = 0; k < sec(70) && w.pursuit.strips()[0]?.active; k++) run(w, 1);
      expect(w.pursuit.strips()[0]?.active).toBe(false);
      expect(suspectInfo(w).deflated).toBe(PURSUIT_CONFIG.spikes.tiresOnHit);
      expect(w.log.tactics.some((t) => t.tactic === 'spikes' && t.verdict === 'success')).toBe(true);
      expect(w.pursuit.serialize().pursuit?.tactic).toBeNull();
      expect(w.dispatcher.undirected).toContain('21');
      // Two flat tyres stop the car after stopAfterS.
      run(w, sec(PULLOVER.spikes.stopAfterS + 2));
      expect(w.log.ended.map((e) => e.reason)).toEqual(['stopped']);
    });
  });

  it('fails when the unit cannot get there before the suspect and releases it', async () => {
    await noGiveUp(async () => {
      const graph = chainGraph();
      const w = await makeWorld({ graph });
      w.dispatcher.onCall = ['21'];
      w.dispatcher.teleport = false;
      w.cad.setUnitPosition('21', -300, 300);
      startPursuit(w, 0, 100);
      run(w, sec(1));
      w.pursuit.request({ kind: 'spikesAhead' });
      run(w, sec(60));
      expect(w.pursuit.strips()).toHaveLength(0);
      const failed = w.log.tactics.find((t) => t.tactic === 'spikes');
      expect(failed?.verdict).toBe('failed');
      expect(w.dispatcher.undirected).toContain('21');
      expect(w.pursuit.serialize().pursuit?.tactic).toBeNull();
    });
  });

  it('flashes when no unit is available or another tactic runs', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld({ graph: chainGraph() });
      startPursuit(w, 0, 100);
      run(w, sec(1));
      w.pursuit.request({ kind: 'spikesAhead' });
      run(w, 1);
      expect(w.log.flashes.at(-1)).toBe('No unit available for spikes');
      w.dispatcher.onCall = ['21'];
      w.pursuit.request({ kind: 'spikesAhead' });
      w.pursuit.request({ kind: 'spikesAhead' });
      run(w, 1);
      expect(w.log.flashes.at(-1)).toBe('Another tactic is running');
    });
  });
});

describe('box-in', () => {
  it('stops a slow car when the player and two AI units are close', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      startPursuit(w, longEdge(CITY.graph), 40, 2);
      w.dispatcher.onCall = ['21', '22'];
      run(w, sec(6));
      const f = suspectInfo(w);
      expect(f.speed).toBeLessThan(PURSUIT_CONFIG.boxIn.maxSuspectMph * MPH);
      w.cad.setUnitPosition('21', f.x + 8, f.z);
      w.cad.setUnitPosition('22', f.x - 8, f.z + 3);
      w.ctx.car = policeAt(f, -6, 2, 0);
      w.ctx.carId = CAR_ID;
      w.pursuit.request({ kind: 'boxIn' });
      run(w, 1);
      expect(w.log.tactics.at(-1)).toMatchObject({ tactic: 'boxIn', verdict: 'success' });
      run(w, 2);
      expect(w.log.ended.map((e) => e.reason)).toEqual(['stopped']);
    });
  });

  it('fails and says why when the suspect is fast or the units are far', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      startPursuit(w, longEdge(CITY.graph), 40);
      w.dispatcher.onCall = ['21', '22'];
      run(w, sec(3));
      const f = suspectInfo(w);
      w.cad.setUnitPosition('21', f.x + 8, f.z);
      w.cad.setUnitPosition('22', f.x - 8, f.z + 3);
      w.ctx.car = policeAt(f, -6, 2, 0);
      w.ctx.carId = CAR_ID;
      w.pursuit.request({ kind: 'boxIn' });
      run(w, 1);
      expect(w.log.tactics.at(-1)?.verdict).toBe('failed');
      expect(w.log.tactics.at(-1)?.text).toMatch(/too fast/);
      expect(w.pursuit.active()).toBe(true);
    });
  });
});

describe('roadblock', () => {
  it('units ahead slow the suspect down and stop it', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld({ graph: chainGraph() });
      w.dispatcher.onCall = ['21', '22', '23'];
      startPursuit(w, 0, 100, 14);
      run(w, sec(1));
      w.pursuit.request({ kind: 'roadblock' });
      run(w, 1);
      expect(w.dispatcher.directed.size).toBe(3);
      expect(w.pursuit.serialize().pursuit?.tactic).toMatchObject({ kind: 'roadblock', unit: '21,22,23', node: 2 });
      // Nothing happens until the units are within aheadM of the suspect.
      run(w, sec(20));
      expect(suspectInfo(w).speed).toBeGreaterThan(13);
      run(w, sec(40));
      expect(w.log.tactics.at(-1)).toMatchObject({ tactic: 'roadblock', verdict: 'success' });
      run(w, 2);
      expect(w.log.ended.map((e) => e.reason)).toEqual(['stopped']);
      expect(w.dispatcher.undirected).toEqual(expect.arrayContaining(['21', '22', '23']));
    });
  });

  it('needs minUnits units', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld({ graph: chainGraph() });
      w.dispatcher.onCall = ['21'];
      startPursuit(w, 0, 100, 14);
      run(w, sec(1));
      w.pursuit.request({ kind: 'roadblock' });
      run(w, 1);
      expect(w.log.tactics.at(-1)).toMatchObject({ tactic: 'roadblock', verdict: 'failed' });
      expect(w.dispatcher.directed.size).toBe(0);
    });
  });

  it('is cancelled when the suspect gets past the block', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld({ graph: chainGraph() });
      w.dispatcher.onCall = ['21', '22'];
      // The units never get to the block, the suspect drives past node 2.
      w.dispatcher.teleport = false;
      w.cad.setUnitPosition('21', -300, 50);
      w.cad.setUnitPosition('22', -300, -50);
      startPursuit(w, 0, 100, 14);
      run(w, sec(1));
      w.pursuit.request({ kind: 'roadblock' });
      run(w, sec(60));
      expect(w.log.tactics.at(-1)).toMatchObject({ tactic: 'roadblock', verdict: 'failed' });
      expect(w.pursuit.serialize().pursuit?.tactic).toBeNull();
      expect(w.dispatcher.undirected).toEqual(expect.arrayContaining(['21', '22']));
    });
  });
});

describe('air unit', () => {
  it('requests the helicopter once, targets the suspect and keeps the flee tracked while on target', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      startPursuit(w, longEdge(CITY.graph), 40);
      run(w, sec(1));
      w.pursuit.request({ kind: 'air' });
      run(w, 1);
      expect(w.resources.requests).toEqual([{ typeId: 'air', callId: w.callId, via: 'radio' }]);
      w.pursuit.request({ kind: 'air' });
      run(w, 1);
      expect(w.log.flashes.at(-1)).toBe('Air unit already requested');
      // The helicopter arrives overhead.
      w.resources.airUp = true;
      w.resources.airOnTarget = false;
      run(w, 2);
      expect(w.resources.targets.at(-1)).toEqual({ kind: 'vehicle', id: ID });
      expect(suspectInfo(w).tracked).toBe(false);
      w.resources.airOnTarget = true;
      const f = suspectInfo(w);
      w.resources.airPos = { x: f.x, z: f.z };
      run(w, 2, () => {
        const g = suspectInfo(w);
        w.resources.airPos = { x: g.x, z: g.z };
      });
      expect(suspectInfo(w).tracked).toBe(true);
      expect(w.log.tactics.some((t) => t.tactic === 'air' && t.verdict === 'success')).toBe(true);
      expect(w.pursuit.hud()?.line).toMatch(/AIR on target/);
      // Too far away: no longer tracked.
      w.resources.airPos = { x: 99999, z: 99999 };
      run(w, 2);
      expect(suspectInfo(w).tracked).toBe(false);
    });
  });
});

describe('supervisor', () => {
  it('orders a termination once after the monitor delay for an offense that does not allow a pursuit', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      startPursuit(w, longEdge(CITY.graph), 40);
      w.rules.offense = 'traffic';
      w.resources.sup = 'SGT-1';
      const delay = PURSUIT_CONFIG.supervisor.monitorDelayS;
      run(w, sec(delay - 2));
      expect(w.log.orders).toHaveLength(0);
      expect(w.log.radio.some((r) => /monitoring the pursuit/.test(r.text))).toBe(true);
      expect(w.pursuit.hud()?.line).toMatch(/SGT-1 monitoring/);
      run(w, sec(5));
      expect(w.log.orders).toHaveLength(1);
      const order = w.log.orders[0];
      expect(order?.order).toBe('terminate');
      expect(order?.by).toBe('SGT-1');
      expect(order?.callId).toBe(w.callId);
      expect(order?.text).toBe('SGT-1 to 1-A-12, terminate the pursuit — pursuit not authorized for this offense.');
      expect(order?.sim).toBeGreaterThanOrEqual(delay);
      const radio = w.log.radio.filter((r) => /terminate the pursuit/.test(r.text));
      expect(radio).toHaveLength(1);
      expect(radio[0]).toMatchObject({ channel: 'dispatch', speaker: 'SGT-1', priority: true });
      // Not repeated before repeatS; "ignored" is flashed once after the grace period.
      run(w, sec(10));
      expect(w.log.orders).toHaveLength(1);
      expect(w.log.flashes.filter((f) => f === 'Supervisor order ignored')).toHaveLength(0);
      run(w, sec(8));
      expect(w.log.flashes.filter((f) => f === 'Supervisor order ignored')).toHaveLength(1);
      run(w, sec(PURSUIT_CONFIG.supervisor.repeatS));
      expect(w.log.orders).toHaveLength(2);
      expect(w.log.flashes.filter((f) => f === 'Supervisor order ignored')).toHaveLength(2);
    });
  });

  it('does not order anything without a supervisor or for a good pursuit', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      startPursuit(w, longEdge(CITY.graph), 40);
      w.rules.offense = 'traffic';
      run(w, sec(30));
      expect(w.log.orders).toHaveLength(0);
      w.rules.offense = 'violent';
      w.resources.sup = 'SGT-1';
      run(w, sec(30));
      expect(w.log.orders).toHaveLength(0);
    });
  });

  it('orders a termination when the player loses sight of the suspect without air support', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      startPursuit(w, longEdge(CITY.graph), 40);
      w.resources.sup = 'SGT-1';
      // The player sits 400 m away from the car.
      w.trackPlayer = false;
      w.ctx.x = 99999;
      w.ctx.z = 99999;
      run(w, sec(PURSUIT_CONFIG.supervisor.monitorDelayS + 2));
      expect(w.log.orders).toHaveLength(0);
      run(w, sec(PURSUIT_CONFIG.supervisor.lostSightS));
      expect(w.log.orders.map((o) => o.order)).toEqual(['terminate']);
      expect(w.log.orders[0]?.text).toMatch(/lost visual, no air support/);
    });
  });

  it('closes the pursuit when the scene ends it and releases the units', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      w.dispatcher.onCall = ['21', '22'];
      startPursuit(w, longEdge(CITY.graph), 40);
      run(w, sec(5));
      // The units chase the suspect.
      expect(w.dispatcher.directed.has('21')).toBe(true);
      expect(w.dispatcher.directed.has('22')).toBe(true);
      w.h.bus.emit('scene:pursuit', { kind: 'vehicle', active: false, callId: w.callId, personId: PERSON, endReason: 'terminated' });
      run(w, 1);
      expect(w.pursuit.active()).toBe(false);
      expect(w.dispatcher.directed.size).toBe(0);
      expect(w.dispatcher.undirected).toEqual(expect.arrayContaining(['21', '22']));
      expect(suspectInfo(w).capMps).toBe(Infinity);
    });
  });
});

describe('jurisdiction handoff', () => {
  it('asks for state patrol near the limits, hands off outside them and resolves the chase', async () => {
    await noGiveUp(async () => {
      const city = CITY;
      const edge = longEdge(city.graph);
      const e = city.graph.edges[edge];
      const a = city.graph.nodes[e?.from ?? 0];
      if (!a) throw new Error('no node');
      // City limits: a 150 m box around the start, so the car leaves it within seconds.
      const config = cfgWith({
        handoff: { cityLimits: { minX: a.x - 150, maxX: a.x + 150, minZ: a.z - 150, maxZ: a.z + 150 }, resolveS: [5, 8], removeAfterS: 5 },
      });
      const w = await makeWorld({ city, config, seed: 11 });
      w.resources.directToOk.add('STATE-1');
      startPursuit(w, edge, 20);
      w.dispatcher.onCall = ['21'];
      run(w, sec(4));
      expect(w.resources.requests).toEqual([{ typeId: 'statePatrol', callId: w.callId, via: 'auto' }]);
      expect(w.resources.directToCalls).toContain('STATE-1');
      expect(w.pursuit.active()).toBe(true);
      // The state unit trails the suspect once it is outside the city.
      let outside = false;
      for (let i = 0; i < sec(60) && w.log.handoffs.length === 0; i++) {
        run(w, 1, () => {
          const f = suspectInfo(w);
          w.resources.poses.set('STATE-1', { x: f.x + 100, z: f.z, yaw: 0, speed: 20 });
          if (Math.abs(f.x - a.x) > 150 || Math.abs(f.z - a.z) > 150) outside = true;
        });
      }
      expect(outside).toBe(true);
      expect(w.log.handoffs).toEqual([{ callId: w.callId, to: 'STATE-1' }]);
      expect(w.sceneRequests).toEqual([{ kind: 'terminatePursuit', reason: 'handoff' }]);
      expect(w.log.orders.map((o) => o.order)).toEqual(['handoff']);
      expect(w.log.orders[0]?.text).toBe("STATE-1, we have primary, 1-A-12 you're clear.");
      expect(w.log.tactics.at(-1)).toMatchObject({ tactic: 'handoff', verdict: 'success' });
      expect(w.pursuit.active()).toBe(false);
      expect(w.pursuit.hud()?.line).toMatch(/STATE PURSUIT/);
      expect(w.dispatcher.undirected).toContain('21');
      // The scene ending the officer's pursuit (handoff) does not close the state pursuit.
      w.h.bus.emit('scene:pursuit', { kind: 'vehicle', active: false, callId: w.callId, personId: PERSON, endReason: 'handoff' });
      run(w, 1);
      expect(w.pursuit.hud()?.line).toMatch(/STATE PURSUIT/);
      // Resolution replays the module's rng stream: resolveS, then the catch roll.
      const rng = createRng(11).stream('pursuit');
      const resolve = rng.nextFloat(5, 8);
      const caught = rng.chance(PURSUIT_CONFIG.handoff.catchChance);
      const handedAt = w.sim;
      run(w, sec(resolve + 1.5));
      if (caught) {
        expect(w.log.radio.some((r) => r.speaker === 'STATE-1' && /suspect in custody/.test(r.text))).toBe(true);
        expect(w.log.ended.map((x) => x.reason)).toContain('stopped');
        run(w, sec(6));
        expect(w.h.sys.slotOfVehicle(ID)).toBe(-1);
        expect(w.pursuit.hud()).toBeNull();
      } else {
        expect(w.log.radio.some((r) => /suspect in custody/.test(r.text))).toBe(false);
        expect(w.pursuit.hud()).toBeNull();
      }
      expect(handedAt).toBeGreaterThan(0);
    });
  });

  it('does not ask for state patrol while far from the limits', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      startPursuit(w, longEdge(CITY.graph), 40);
      run(w, sec(5));
      expect(w.resources.requests).toHaveLength(0);
    });
  });
});

describe('foot bail and perimeter', () => {
  /** A crashed car and a runner: the vehicle pursuit ends and the foot pursuit starts for the same person. */
  async function bailWorld(): Promise<World> {
    const w = await makeWorld();
    const graph = CITY.graph;
    startPursuit(w, longEdge(graph), 40);
    run(w, sec(2));
    w.npc.actors.set(88, densePoint());
    w.h.sys.crashCar(ID);
    run(w, 2);
    expect(w.pursuit.active()).toBe(false);
    w.h.bus.emit('scene:pursuit', { kind: 'foot', active: true, callId: w.callId, personId: PERSON });
    return w;
  }

  it('starts a bail only for the same person within 30 s of the crash', async () => {
    await noGiveUp(async () => {
      const w = await bailWorld();
      run(w, 1);
      expect(w.pursuit.hud()?.line).toMatch(/FOOT BAIL/);
      expect(w.resources.requests).toContainEqual({ typeId: 'air', callId: w.callId, via: 'auto' });
      const other = await makeWorld();
      startPursuit(other, longEdge(CITY.graph), 40);
      run(other, sec(2));
      other.npc.actors.set(88, { x: 0, z: 0 });
      other.h.sys.crashCar(ID);
      run(other, sec(35));
      other.h.bus.emit('scene:pursuit', { kind: 'foot', active: true, callId: other.callId, personId: PERSON });
      run(other, 1);
      expect(other.pursuit.hud()).toBeNull();
    });
  });

  it('sets a perimeter once the runner is out of sight and directs the nearest units to the posts', async () => {
    await noGiveUp(async () => {
      const w = await bailWorld();
      w.dispatcher.onCall = ['21', '22', '23', '24'];
      const bail = () => w.pursuit.serialize().bail;
      run(w, 1);
      const centre = bail();
      if (!centre) throw new Error('no bail');
      const graph = CITY.graph;
      const posts = perimeterPosts(graph, centre.x, centre.z, PURSUIT_CONFIG.perimeter.radiusM, PURSUIT_CONFIG.perimeter.posts);
      // The player stands 100 m from the runner for lostSightS: the perimeter goes up.
      w.trackPlayer = false;
      w.ctx.x = centre.x - 100;
      w.ctx.z = centre.z;
      run(w, sec(PURSUIT_CONFIG.perimeter.lostSightS - 3));
      expect(w.dispatcher.directed.size).toBe(0);
      run(w, sec(5));
      expect(bail()?.perimeterSet).toBe(true);
      expect(bail()?.posts).toHaveLength(posts.length);
      expect(w.dispatcher.directed.size).toBe(Math.min(posts.length, 4));
      for (const p of bail()?.posts ?? []) {
        expect(p[2]).not.toBe('');
        expect(w.dispatcher.directed.get(p[2])).toEqual({ x: p[0], z: p[1] });
      }
      expect(w.resources.requests).toContainEqual({ typeId: 'k9', callId: w.callId, via: 'auto' });
      expect(w.log.radio.some((r) => /setting a perimeter around/.test(r.text))).toBe(true);
    });
  });

  it('asks for backup for posts without a unit and staffs them as units arrive', async () => {
    await noGiveUp(async () => {
      const w = await bailWorld();
      w.dispatcher.onCall = ['21'];
      run(w, 1);
      w.pursuit.request({ kind: 'perimeter' });
      run(w, 1);
      const posts = w.pursuit.serialize().bail?.posts ?? [];
      expect(posts.length).toBeGreaterThan(1);
      expect(w.dispatcher.backups).toEqual([posts.length - 1]);
      w.dispatcher.onCall = ['21', '22'];
      run(w, sec(1));
      expect((w.pursuit.serialize().bail?.posts ?? []).filter((p) => p[2] !== '')).toHaveLength(2);
      w.pursuit.request({ kind: 'perimeter' });
      run(w, 1);
      expect(w.log.flashes.at(-1)).toBe('No perimeter to set');
    });
  });

  it('forces a runner at the edge of the perimeter with a unit close to hands up', async () => {
    await noGiveUp(async () => {
      const w = await bailWorld();
      w.dispatcher.onCall = ['21', '22', '23', '24'];
      run(w, 1);
      const centre = w.pursuit.serialize().bail;
      if (!centre) throw new Error('no bail');
      w.pursuit.request({ kind: 'perimeter' });
      run(w, sec(1));
      // The runner is deep inside the cordon: nothing happens even with a unit near.
      w.npc.actors.set(88, { x: centre.x + 30, z: centre.z });
      w.cad.setUnitPosition('21', centre.x + 31, centre.z);
      run(w, sec(1));
      expect(w.npc.forced).toHaveLength(0);
      // At the edge with a post unit close by: handsUp, once.
      const edgeX = centre.x + PURSUIT_CONFIG.perimeter.radiusM;
      w.npc.actors.set(88, { x: edgeX, z: centre.z });
      w.dispatcher.teleport = false;
      for (const cs of ['21', '22', '23', '24']) w.cad.setUnitPosition(cs, edgeX + 20, centre.z);
      run(w, sec(1));
      expect(w.npc.forced).toEqual([{ id: 88, state: 'handsUp' }]);
      expect(w.log.tactics.at(-1)).toMatchObject({ tactic: 'perimeter', verdict: 'success' });
      expect(w.log.radio.some((r) => /at gunpoint/.test(r.text))).toBe(true);
      run(w, sec(2));
      expect(w.npc.forced).toHaveLength(1);
      expect(w.pursuit.hud()?.line).toMatch(/contained/);
      // The scene ends the foot pursuit: the bail closes and the posts are released.
      w.h.bus.emit('scene:pursuit', { kind: 'foot', active: false, callId: w.callId, personId: PERSON, endReason: 'caught' });
      run(w, 2);
      expect(w.pursuit.hud()).toBeNull();
      expect(w.dispatcher.directed.size).toBe(0);
    });
  });

  it('closes the bail when the runner is gone', async () => {
    await noGiveUp(async () => {
      const w = await bailWorld();
      run(w, 1);
      expect(w.pursuit.hud()).not.toBeNull();
      w.npc.actors.delete(88);
      run(w, sec(1));
      expect(w.pursuit.hud()).toBeNull();
    });
  });
});

describe('menu and hud', () => {
  it('lists the seven requests with enabled flags and hints', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      run(w, sec(1));
      const idle = w.pursuit.menu();
      expect(idle.map((m) => m.id)).toEqual(['requestPit', 'spikesAhead', 'deployStrip', 'boxIn', 'roadblock', 'air', 'perimeter']);
      expect(idle.every((m) => !m.enabled)).toBe(true);
      expect(w.pursuit.hud()).toBeNull();
      w.dispatcher.onCall = ['21', '22'];
      startPursuit(w, longEdge(CITY.graph), 40);
      run(w, sec(2));
      const live = w.pursuit.menu();
      expect(live.find((m) => m.id === 'requestPit')?.enabled).toBe(true);
      expect(live.find((m) => m.id === 'spikesAhead')?.enabled).toBe(true);
      expect(live.find((m) => m.id === 'roadblock')?.enabled).toBe(true);
      expect(live.find((m) => m.id === 'air')?.enabled).toBe(true);
      expect(live.find((m) => m.id === 'boxIn')?.enabled).toBe(false);
      expect(live.find((m) => m.id === 'boxIn')?.hint).toMatch(/too fast/);
      expect(live.find((m) => m.id === 'perimeter')?.enabled).toBe(false);
      expect(live.find((m) => m.id === 'deployStrip')?.hint).toBe('Get out of the car');
    });
  });

  it('builds the one-line HUD and bumps the revision when it changes', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      const rev0 = w.pursuit.revision;
      startPursuit(w, longEdge(CITY.graph), 40);
      run(w, sec(2));
      const hud = w.pursuit.hud();
      expect(hud?.line).toMatch(/^PURSUIT · \d+ mph · risk \d\.\d\d$/);
      expect(w.pursuit.revision).toBeGreaterThan(rev0);
      w.resources.sup = 'SGT-1';
      w.resources.airUp = true;
      w.resources.airOnTarget = true;
      run(w, sec(3), () => {
        const f = suspectInfo(w);
        w.resources.airPos = { x: f.x, z: f.z };
      });
      expect(w.pursuit.hud()?.line).toMatch(/PURSUIT · \d+ mph · risk \d\.\d\d · SGT-1 monitoring · AIR on target$/);
    });
  });
});

describe('save and restore', () => {
  /** A pursuit with a supervisor, a strip, a tactic and queued requests. */
  async function busyWorld(seed = 7): Promise<World> {
    const graph = chainGraph();
    const w = await makeWorld({ graph, seed });
    w.dispatcher.onCall = ['21', '22'];
    w.resources.sup = 'SGT-1';
    w.rules.offense = 'warrant';
    startPursuit(w, 0, 100, 14);
    const spot = lanePoint(graph, 0, 250);
    w.ctx.onFoot = true;
    w.ctx.carryingStrip = true;
    w.ctx.x = spot.x;
    w.ctx.z = spot.z;
    run(w, sec(1));
    w.pursuit.request({ kind: 'deployStrip' });
    run(w, 1);
    w.ctx.onFoot = false;
    w.pursuit.request({ kind: 'spikesAhead' });
    run(w, sec(2));
    return w;
  }

  it('round trips through JSON and passes the guard', async () => {
    await noGiveUp(async () => {
      const w = await busyWorld();
      w.pursuit.request({ kind: 'requestPit' });
      w.h.bus.emit('scene:pursuit', { kind: 'foot', active: true, callId: 9, personId: 3 });
      const save = w.pursuit.serialize();
      expect(save.pursuit?.tactic?.kind).toBe('spikes');
      expect(save.strips.length).toBeGreaterThanOrEqual(1);
      expect(save.requests).toEqual([{ kind: 'requestPit' }]);
      expect(save.intake).toHaveLength(1);
      const json = JSON.parse(JSON.stringify(save)) as unknown;
      expect(isPursuitSave(json)).toBe(true);
      const w2 = await makeWorld({ graph: chainGraph() });
      w2.pursuit.restore(json as never);
      expect(w2.pursuit.serialize()).toEqual(save);
      expect(w2.pursuit.active()).toBe(true);
      expect(w2.pursuit.strips()).toHaveLength(save.strips.length);
    });
  });

  it('rejects malformed saves', async () => {
    const w = await makeWorld();
    const good = JSON.parse(JSON.stringify(w.pursuit.serialize())) as Record<string, unknown>;
    expect(isPursuitSave(good)).toBe(true);
    expect(isPursuitSave(null)).toBe(false);
    expect(isPursuitSave({ ...good, version: 2 })).toBe(false);
    expect(isPursuitSave({ ...good, strips: [{ id: 1 }] })).toBe(false);
    expect(isPursuitSave({ ...good, requests: [{ kind: 'dance' }] })).toBe(false);
    expect(isPursuitSave({ ...good, rng: { seed: 1, s: [1, 2] } })).toBe(false);
    expect(isPursuitSave({ ...good, pursuit: { callId: 1 } })).toBe(false);
    // The Phase 6 design shape without the optional extras is accepted.
    const bare = { ...good };
    delete bare.intake;
    delete bare.lastEnd;
    expect(isPursuitSave(bare)).toBe(true);
  });

  it('restores the rng so the handoff roll continues the stream', async () => {
    const w = await makeWorld({ seed: 3 });
    const before = w.pursuit.serialize();
    const w2 = await makeWorld({ seed: 99 });
    w2.pursuit.restore(before);
    expect(w2.pursuit.serialize().rng).toEqual(before.rng);
  });
});

describe('determinism', () => {
  async function scripted(): Promise<string> {
    return noGiveUp(async () => {
      const w = await busyWorld2();
      run(w, sec(30));
      return JSON.stringify(w.pursuit.serialize());
    });
  }

  async function busyWorld2(): Promise<World> {
    const graph = chainGraph();
    const w = await makeWorld({ graph, seed: 5 });
    w.dispatcher.onCall = ['21', '22'];
    w.resources.sup = 'SGT-1';
    w.rules.offense = 'warrant';
    startPursuit(w, 0, 100, 14);
    run(w, sec(1));
    w.pursuit.request({ kind: 'requestPit' });
    w.pursuit.request({ kind: 'spikesAhead' });
    run(w, sec(2));
    return w;
  }

  it('two identical runs end with identical saves', async () => {
    const a = await scripted();
    const b = await scripted();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(100);
  });

  it('a pursuit restored mid-way (with the traffic) continues like the original', async () => {
    await noGiveUp(async () => {
      const w = await busyWorld2();
      run(w, sec(25));
      const save = JSON.parse(JSON.stringify(w.pursuit.serialize())) as never;
      const traffic = JSON.parse(JSON.stringify(w.h.sys.snapshot())) as never;
      const unitPos = ['21', '22'].map((cs) => [w.cad.unit(cs)?.x ?? 0, w.cad.unit(cs)?.z ?? 0] as const);
      const simAt = w.sim;
      run(w, sec(40));
      const end = JSON.stringify(w.pursuit.serialize());
      expect((JSON.parse(end) as { strips: unknown[] }).strips.length).toBeGreaterThan(0);

      const w2 = await makeWorld({ graph: chainGraph(), seed: 5 });
      w2.dispatcher.onCall = ['21', '22'];
      w2.resources.sup = 'SGT-1';
      w2.rules.offense = 'warrant';
      w2.h.sys.restore(traffic);
      w2.pursuit.restore(save);
      w2.sim = simAt;
      ['21', '22'].forEach((cs, i) => w2.cad.setUnitPosition(cs, unitPos[i]?.[0] ?? 0, unitPos[i]?.[1] ?? 0));
      follow(w2);
      run(w2, sec(40));
      expect(JSON.stringify(w2.pursuit.serialize())).toBe(end);
    });
  });
});

describe('performance', () => {
  it('an active pursuit step costs at most 0.02 ms on average', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      w.dispatcher.onCall = ['21', '22', '23'];
      w.resources.sup = 'SGT-1';
      w.resources.airUp = true;
      w.resources.airOnTarget = true;
      startPursuit(w, longEdge(CITY.graph), 40);
      run(w, sec(2));
      const f = suspectInfo(w);
      w.resources.airPos = { x: f.x, z: f.z };
      const graph = CITY.graph;
      const spot = lanePoint(graph, longEdge(graph), 5);
      w.ctx.onFoot = true;
      w.ctx.carryingStrip = true;
      w.ctx.x = spot.x;
      w.ctx.z = spot.z;
      w.pursuit.request({ kind: 'deployStrip' });
      // The traffic stands still while the pursuit steps: this measures the pursuit alone.
      const steps = 20000;
      let sim = w.sim;
      const t0 = performance.now();
      for (let i = 0; i < steps; i++) {
        sim += DT;
        w.pursuit.step(DT, { sim, game: sim * 30 }, w.ctx);
      }
      const perStep = (performance.now() - t0) / steps;
      expect(w.pursuit.active()).toBe(true);
      expect(perStep).toBeLessThan(0.02);
    });
  });
});

describe('requests', () => {
  it('limits the queue and tolerates an unknown fleeing car', async () => {
    const w = await makeWorld();
    const reqs: PursuitRequest[] = Array.from({ length: 40 }, () => ({ kind: 'boxIn' }));
    for (const r of reqs) w.pursuit.request(r);
    expect(w.pursuit.serialize().requests.length).toBeLessThanOrEqual(16);
    // A start event for a call without vehicles is ignored.
    const bare = w.cad.createCall({ typeId: 'vehiclePursuit', priority: 1, location: LOC, caller: CALLER, narrative: 'x' }, { sim: 0, game: 0 });
    w.h.bus.emit('scene:pursuit', { kind: 'vehicle', active: true, callId: bare.id, personId: 1 });
    run(w, 2);
    expect(w.pursuit.active()).toBe(false);
  });

  it('closes a pursuit whose car vanished without an end event', async () => {
    await noGiveUp(async () => {
      const w = await makeWorld();
      startPursuit(w, longEdge(CITY.graph), 40);
      run(w, sec(1));
      expect(w.pursuit.active()).toBe(true);
      w.h.sys.removeVehicle(ID);
      run(w, sec(5));
      expect(w.pursuit.active()).toBe(false);
    });
  });

  it('dispose unsubscribes from the bus', async () => {
    const w = await makeWorld();
    const before = w.h.bus.listenerCount('scene:pursuit');
    w.pursuit.dispose();
    expect(w.h.bus.listenerCount('scene:pursuit')).toBe(before - 1);
  });
});
