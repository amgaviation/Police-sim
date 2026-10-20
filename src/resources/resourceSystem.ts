/**
 * ResourceSystem (design §8.3): the specialised unit pools (supervisors, K9, EMS, fire, tow, SWAT, air, ...).
 * Requests (radio, MDT, scene provider, chain of command) are queued and handled at the start of the owner's
 * step: the best unit is picked by response time over the real road network, spawns at its base after the
 * turnout and drives to the call as a traffic fleet car (the air unit flies); on scene it resolves the scene
 * services it carries, shows its crew and leaves when the call closes or its time is up.
 */
import '../cad/events';
import type { CadCall, CadTime } from '../cad/types';
import type { Rng } from '../core/rng';
import '../force/events';
import '../incidents/events';
import { ACTOR_STATE, type ActorInfo } from '../npc/types';
import { PoliceLights, attachPoliceLights } from '../police/components';
import { BODY, POSE, createHumanoidSource, type HumanoidSource } from '../render/people/pose';
import '../scene/events';
import type { FleeState, FleetState } from '../traffic/trafficSystem';
import '../traffic/events';
import {
  ETA_CONFIG,
  UNIT_TYPES,
  airEta,
  estimateResponse,
  expandResourceSlots,
  expectedSpeed,
  rankByEta,
  remainingEta,
  urgencyFor,
  type EtaCandidate,
  type EtaResult,
  type EtaRoute,
  type UnitType,
  type UnitTypesData,
} from '../units';
import { vehicleModel } from '../vehicles/model';
import './events';
import {
  AIR_TARGET_KINDS,
  ON_STATION_S,
  REVEAL_EVERY_S,
  REVEAL_M,
  airOnTarget,
  compassWord,
  newAirState,
  stepAir,
  type AirState,
} from './air';
import { basePoint, type BasePoint } from './bases';
import { chainResponse, type ChainTrigger } from './chain';
import { crewSpot, type CrewSpot } from './crews';
import { POST_LEVELS, type PostLevel } from './save';
import type {
  AirView,
  ResourceAirSave,
  ResourceDeps,
  ResourceHud,
  ResourcePort,
  ResourceRequest,
  ResourceSave,
  ResourceStatus,
  ResourceUnitSave,
  ResourceUnitView,
  ResourceUrgency,
} from './types';

/** Arrival radius around the destination (m), besides the traffic system's own arrived flag. */
const ARRIVE_M = 30;
/** A returning or transporting unit is home this close to its destination (m). */
const HOME_M = 40;
/** A unit that gained no route progress for this long counts as arrived (sim s). */
const NO_PROGRESS_S = 150;
/** Route metres a unit must gain to count as progress. */
const PROGRESS_M = 50;
/** Fleet car spawn / destination retry interval (sim s). */
const RETRY_S = 5;
/** A unit with an officer on foot waits at most this long (sim s) before it leaves anyway. */
const HOLD_S = 30;
/** Siren on above this speed in emergency mode (m/s). */
const SIREN_SPEED = 1;
/** CAD position (AVL) interval (sim s). */
const AVL_S = 0.5;
/** Crew figure rewrite interval (sim s). */
const CREW_S = 0.1;
/** Most crew figures drawn. */
const MAX_CREW = 48;
/** Rotor angular speed (rad/s, presentation only). */
const ROTOR_RAD_S = 38;
/** The air unit lands within this distance of its pad (m). */
const LAND_M = 10;
/** Cruise speed assumed for a patrol unit's live ETA (m/s at urgency factor 1). */
const PATROL_MPS = 11;
/** Fleet spawn retry offsets around a base (m), tried in order (the dispatcher's pattern). */
const SPAWN_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0], [150, 0], [0, 150], [-150, 0], [0, -150], [300, 300], [-300, 300], [300, -300], [-300, -300], [600, 0], [0, 600], [-600, 0], [0, -600],
];
const SKIN = [0xc68e6b, 0x8d5a3c, 0xe0b48f, 0x6f4430, 0xd2a47c] as const;
const HAIR = [0x2a1d14, 0x1a1410, 0x5a3a22, 0x3a3a3c, 0x7a5a30] as const;
const DOG_FUR = 0x6b4a2b;
/** Behaviours that stay until the call closes. */
const HELD = new Set<string>(['supervisor', 'command']);

type Via = 'radio' | 'mdt' | 'auto' | 'scene';

interface Post {
  x: number;
  z: number;
  level: PostLevel;
}

interface Unit {
  readonly callsign: string;
  readonly type: UnitType;
  readonly typeId: string;
  readonly fleetIndex: number;
  readonly air: boolean;
  readonly modelIndex: number;
  /** Light bar clock offset. */
  readonly phase: number;
  /** Where the unit starts (its base when requested from the city centre). */
  readonly homeX: number;
  readonly homeZ: number;
  readonly view: ResourceUnitView;
  status: ResourceStatus;
  callId: number;
  etaS: number;
  travelS: number;
  expectedMps: number;
  turnoutUntil: number;
  leaveAt: number;
  destX: number;
  destZ: number;
  urgency: ResourceUrgency;
  patient: number;
  noProgressSince: number;
  progressLeftM: number;
  // Runtime only (rebuilt after a restore).
  readonly fs: FleetState;
  present: boolean;
  eid: number;
  nextTry: number;
  /** Sim time the unit started waiting for its officer on foot, -1 none. */
  holdSince: number;
  /** Last known position (the car, else the base). */
  px: number;
  pz: number;
}

/** Cached best candidate of one `rankByEta` call. */
interface Ranked {
  route: EtaRoute;
  result: EtaResult;
}

function newFleetState(): FleetState {
  return { eid: 0, x: 0, z: 0, yaw: 0, speed: 0, edge: -1, mode: 'patrol', arrived: false, parked: false, routeLeftM: -1 };
}

function newActorInfo(): ActorInfo {
  return {
    id: 0, personId: -1, role: '', callId: 0, state: ACTOR_STATE.idle, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false,
    following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
  };
}

/** m:ss of a duration in seconds. */
function clock(s: number): string {
  const n = Math.max(0, Math.round(s));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}

function minutesText(etaS: number): string {
  const m = Math.max(1, Math.ceil(etaS / 60));
  return m === 1 ? '1 minute' : `${m} minutes`;
}

function hashCode(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

/** Loose view of the bus for topics another same-wave module declares (`command:post`). */
interface LooseBus {
  on(topic: string, handler: (payload: unknown) => void): () => void;
}

/** The resources module. */
export class ResourceSystem implements ResourcePort {
  /** Crew figures of on-scene units (and the K9 dog); rewritten at 10 Hz. */
  readonly crews: HumanoidSource & { count: number } = createHumanoidSource(MAX_CREW);
  /** Bumped when a unit's status, call or whole-second ETA changes (UI refresh check). */
  revision = 0;

  private readonly deps: ResourceDeps;
  private readonly cfg: UnitTypesData;
  private readonly rng: Rng;
  private readonly typeMap = new Map<string, UnitType>();
  private readonly pool: Unit[] = [];
  private readonly byCallsign = new Map<string, Unit>();
  private readonly views: ResourceUnitView[] = [];
  private readonly airUnit: Unit | null;
  private readonly flight: AirState;
  private readonly padX: number;
  private readonly padZ: number;
  private readonly revealed = new Set<number>();
  private readonly posts = new Map<number, Post>();
  private requests: ResourceRequest[] = [];
  /** Scene service requests already sent in the current drain batch (`call:service`). */
  private readonly routed = new Set<string>();
  private readonly unsubs: (() => void)[] = [];

  private playerX = 0;
  private playerZ = 0;
  private lastSim = 0;
  private lastGame = 0;
  private lastAvlSlot = -1;
  private lastRevealSlot = -1;
  private lastHudSlot = -1;
  private lastHudRevision = -1;
  private crewTimer = Infinity;
  private onTarget = false;
  private started = false;

  private readonly scratchBase: BasePoint = { x: 0, z: 0 };
  private readonly scratchSpot: CrewSpot = { x: 0, z: 0, yaw: 0 };
  private readonly flee: FleeState = { x: 0, z: 0, yaw: 0, speed: 0, edge: -1 };
  private readonly info: ActorInfo = newActorInfo();
  private readonly patrolFs: FleetState = newFleetState();
  private readonly actorList: number[] = [];
  private readonly airOut: AirView = { x: 0, y: 0, z: 0, yaw: 0, spot: false, targetX: 0, targetZ: 0, onTarget: false, rotor: 0 };
  private readonly hudOut: ResourceHud = { next: null, onScene: 0 };

  constructor(deps: ResourceDeps) {
    this.deps = deps;
    this.cfg = deps.types ?? UNIT_TYPES;
    this.rng = deps.rng;
    for (const t of this.cfg.types) this.typeMap.set(t.id, t);
    const spawn = deps.city.spawn;
    const slots = expandResourceSlots(this.cfg);
    let air: Unit | null = null;
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const type = slot ? this.typeMap.get(slot.typeId) : undefined;
      if (!slot || !type) continue;
      const isAir = type.behavior === 'air';
      const home = basePoint(deps.city, type.base, spawn.x, spawn.z, { x: 0, z: 0 });
      const view: ResourceUnitView = { callsign: slot.callsign, typeId: type.id, label: type.label, status: 'available', callId: 0, etaS: -1, x: home.x, z: home.z };
      const u: Unit = {
        callsign: slot.callsign,
        type,
        typeId: type.id,
        fleetIndex: slot.fleetIndex,
        air: isAir,
        modelIndex: isAir || type.vehicle === 'none' ? -1 : vehicleModel(type.vehicle).index,
        phase: i * 0.37,
        homeX: home.x,
        homeZ: home.z,
        view,
        status: 'available',
        callId: 0,
        etaS: -1,
        travelS: 0,
        expectedMps: 1,
        turnoutUntil: 0,
        leaveAt: -1,
        destX: home.x,
        destZ: home.z,
        urgency: 'respond',
        patient: -1,
        noProgressSince: 0,
        progressLeftM: -1,
        fs: newFleetState(),
        present: false,
        eid: 0,
        nextTry: 0,
        holdSince: -1,
        px: home.x,
        pz: home.z,
      };
      this.pool.push(u);
      this.byCallsign.set(u.callsign, u);
      this.views.push(view);
      if (isAir && air === null) air = u;
    }
    this.airUnit = air;
    const pad = basePoint(deps.city, 'airport', spawn.x, spawn.z, { x: 0, z: 0 });
    this.padX = pad.x;
    this.padZ = pad.z;
    this.flight = newAirState(pad.x, pad.z);
    this.subscribe();
  }

  // --- Bus wiring (handlers only enqueue) -----------------------------------------------------------------

  private subscribe(): void {
    const bus = this.deps.bus;
    this.unsubs.push(
      bus.on('force:applied', (e) => this.trigger({ kind: 'force', level: e.level, callId: e.callId })),
      bus.on('incident:forceVerdict', (e) => {
        const m = /^C-0*(\d+)/.exec(e.key);
        const id = m ? Number(m[1]) : 0;
        const call = id > 0 ? this.deps.cad.call(id) : null;
        this.trigger({ kind: 'verdict', verdict: e.verdict, callId: call ? call.id : 0 });
      }),
      bus.on('scene:pursuit', (e) => {
        if (e.kind === 'vehicle' && e.active) this.trigger({ kind: 'pursuit', callId: e.callId });
      }),
      bus.on('cad:callClosed', (e) => {
        this.posts.delete(e.callId);
      }),
      (bus as unknown as LooseBus).on('command:post', (p) => this.onPost(p)),
    );
  }

  private trigger(tr: ChainTrigger): void {
    for (const typeId of chainResponse(tr)) this.requests.push({ kind: 'request', typeId, callId: tr.callId, via: 'auto' });
  }

  private onPost(p: unknown): void {
    if (!isRecord(p) || typeof p.callId !== 'number' || typeof p.open !== 'boolean') return;
    const level = POST_LEVELS.find((l) => l === p.level);
    if (level === undefined) return;
    if (!p.open) {
      this.posts.delete(p.callId);
      return;
    }
    this.posts.set(p.callId, { x: typeof p.x === 'number' ? p.x : 0, z: typeof p.z === 'number' ? p.z : 0, level });
    this.trigger({ kind: 'post', level, callId: p.callId });
  }

  // --- Public API -----------------------------------------------------------------------------------------

  /** New game: CAD units (kind 'resource', available, at their base) for every slot; roster entries for ranked types. */
  start(t: CadTime): void {
    this.registerUnits(t);
    this.started = true;
    this.lastSim = t.sim;
    this.lastGame = t.game;
    this.revision++;
  }

  private registerUnits(t: CadTime): void {
    const { cad, roster } = this.deps;
    for (const u of this.pool) {
      const rank = u.type.rank;
      const officer = rank !== null ? roster.ensure(u.callsign, rank).name : u.type.label;
      if (!cad.unit(u.callsign)) {
        cad.addUnit({ callsign: u.callsign, kind: 'resource', officer, beat: u.type.base, fleetIndex: u.fleetIndex }, t);
        cad.setUnitPosition(u.callsign, u.homeX, u.homeZ);
      }
    }
  }

  /** Queues a request; applied at the start of the next step. */
  request(r: ResourceRequest): void {
    this.requests.push(r);
  }

  /**
   * Scene provider: maps the service to the first type whose `sceneServices` contains it, queues a 'scene' request and
   * returns true; false when no type covers it.
   */
  provide(callId: number, kind: string): boolean {
    for (const type of this.cfg.types) {
      if (type.send !== 'resource' || type.count < 1 || !type.sceneServices.includes(kind)) continue;
      this.requests.push({ kind: 'request', typeId: type.id, callId, via: 'scene' });
      return true;
    }
    return false;
  }

  /** `ResourcePort`: queues a request for a unit type on `callId` (0 = the player's call). */
  requestType(typeId: string, callId: number, via: 'radio' | 'mdt' | 'auto'): void {
    this.requests.push({ kind: 'request', typeId, callId, via });
  }

  /**
   * Unit ranker for the dispatcher: estimateResponse over a real route from the CAD unit position (Infinity when the unit
   * or the route is unknown). Patrol units are already on the road: no turnout; priority 1 for emergency, 3 for respond.
   */
  rankPatrol(callsign: string, x: number, z: number, urgency: 'respond' | 'emergency'): number {
    const cu = this.deps.cad.unit(callsign);
    if (!cu) return Infinity;
    const route = this.deps.city.graph.routeBetweenPoints(cu.x, cu.z, x, z);
    if (!route || !Number.isFinite(route.time) || !Number.isFinite(route.length)) return Infinity;
    return estimateResponse({
      routeTimeS: route.time,
      routeLengthM: route.length,
      priority: urgency === 'emergency' ? 1 : 3,
      urgency,
      trafficDensity: this.density(x, z),
      wetness: this.wetness(),
      turnoutS: [0, 0],
      speedFactor: 1,
    }).etaS;
  }

  /** Live ETA (s) of an en-route unit (resource or patrol), -1 when unknown or not en route. */
  eta(callsign: string): number {
    const u = this.byCallsign.get(callsign);
    if (u) return u.status === 'turnout' || u.status === 'enRoute' ? u.etaS : -1;
    const cu = this.deps.cad.unit(callsign);
    if (!cu || cu.kind !== 'ai' || cu.status !== 'enRoute' || cu.callId === null || cu.fleetIndex < 0) return -1;
    const fs = this.deps.traffic.fleetState(cu.fleetIndex, this.patrolFs);
    if (!fs || fs.mode === 'patrol') return -1;
    return remainingEta(fs.routeLeftM, PATROL_MPS * ETA_CONFIG.urgencyFactor[fs.mode]);
  }

  /** Every unit slot, in contract order (reused objects, updated each step: copy what you keep). */
  units(): readonly ResourceUnitView[] {
    return this.views;
  }

  /** Callsign of a sergeant (or higher) assigned to `callId` (dispatched, en route or on scene), sergeant preferred. */
  supervisorFor(callId: number): string | null {
    let best: Unit | null = null;
    let bestRank = 99;
    for (const u of this.pool) {
      const rank = u.type.rank;
      if (rank === null || rank === 'officer' || u.callId !== callId) continue;
      if (u.status !== 'turnout' && u.status !== 'enRoute' && u.status !== 'onScene') continue;
      const r = rank === 'sergeant' ? 0 : rank === 'lieutenant' ? 1 : 2;
      if (r < bestRank) {
        best = u;
        bestRank = r;
      }
    }
    return best ? best.callsign : null;
  }

  /** `ResourcePort`: units of `typeId` on scene of `callId`. */
  onScene(callId: number, typeId: string): number {
    let n = 0;
    for (const u of this.pool) if (u.status === 'onScene' && u.callId === callId && u.typeId === typeId) n++;
    return n;
  }

  /** `ResourcePort`: callsigns of the units of `typeId` on scene of `callId` (fills and returns `out`). */
  onSceneUnits(callId: number, typeId: string, out: string[]): string[] {
    out.length = 0;
    for (const u of this.pool) if (u.status === 'onScene' && u.callId === callId && u.typeId === typeId) out.push(u.callsign);
    return out;
  }

  /** `ResourcePort`: the air unit's position and flags; false while it is at its base. */
  air(out: { x: number; z: number; y: number; onTarget: boolean; spot: boolean }): boolean {
    const u = this.airUnit;
    if (!u || u.status === 'available' || u.status === 'turnout') return false;
    out.x = this.flight.x;
    out.z = this.flight.z;
    out.y = this.flight.y;
    out.onTarget = this.onTarget;
    out.spot = this.onTarget && this.deps.env().night;
    return true;
  }

  /** `ResourcePort`: what the air unit follows; `none` sends it back to orbit the call. */
  setAirTarget(kind: 'vehicle' | 'actor' | 'point' | 'none', id: number, x: number, z: number): void {
    const f = this.flight;
    f.targetKind = kind;
    f.targetId = kind === 'vehicle' || kind === 'actor' ? id : 0;
    if (kind === 'point') {
      f.tx = x;
      f.tz = z;
    }
  }

  /** `ResourcePort`: an on-scene EMS unit loads `personId` (the actor is removed) and drives to the hospital. */
  transport(callsign: string, personId: number): boolean {
    const u = this.byCallsign.get(callsign);
    if (!u || u.air || u.status !== 'onScene' || u.type.behavior !== 'ems') return false;
    const { npc, people, cad } = this.deps;
    const actor = npc.actorOfPerson(personId);
    if (actor > 0) npc.removeActor(actor);
    people.setCustody(personId, 'hospital');
    const t = this.now();
    this.emitCleared(u);
    u.patient = personId;
    u.status = 'transporting';
    u.etaS = -1;
    u.leaveAt = -1;
    const hospital = basePoint(this.deps.city, 'hospital', u.px, u.pz, this.scratchBase);
    u.destX = hospital.x;
    u.destZ = hospital.z;
    u.noProgressSince = t.sim;
    u.progressLeftM = -1;
    u.nextTry = 0;
    cad.setUnitStatus(u.callsign, 'transporting', t, 'auto');
    this.sendCar(u, 'respond');
    this.revision++;
    return true;
  }

  /** `ResourcePort`: sends an assigned ground unit to (x, z); it arrives there like at the call. */
  directTo(callsign: string, x: number, z: number, urgency: 'respond' | 'emergency'): boolean {
    const u = this.byCallsign.get(callsign);
    if (!u || u.air || u.callId <= 0) return false;
    if (u.status !== 'turnout' && u.status !== 'enRoute' && u.status !== 'onScene') return false;
    const t = this.now();
    if (u.status === 'onScene' && Math.hypot(u.px - x, u.pz - z) <= ARRIVE_M) {
      u.destX = x;
      u.destZ = z;
      return true;
    }
    u.destX = x;
    u.destZ = z;
    u.urgency = urgency;
    u.noProgressSince = t.sim;
    u.progressLeftM = -1;
    if (u.status === 'onScene') {
      u.status = 'enRoute';
      u.leaveAt = -1;
      u.holdSince = -1;
      this.deps.cad.setUnitStatus(u.callsign, 'enRoute', t, 'auto');
      this.revision++;
    }
    if (u.status === 'enRoute') this.sendCar(u, urgency);
    return true;
  }

  /** `ResourcePort`: pose of a unit's car; false when it has none. */
  unitPose(callsign: string, out: { x: number; z: number; yaw: number; speed: number }): boolean {
    const u = this.byCallsign.get(callsign);
    if (!u || u.air) return false;
    const fs = this.deps.traffic.fleetState(u.fleetIndex, u.fs);
    if (!fs) return false;
    out.x = fs.x;
    out.z = fs.z;
    out.yaw = fs.yaw;
    out.speed = fs.speed;
    return true;
  }

  /** The air unit for the renderer / FLIR camera (null at base). The object is reused. */
  airView(): AirView | null {
    const u = this.airUnit;
    if (!u || u.status === 'available' || u.status === 'turnout') return null;
    return this.airOut;
  }

  /** HUD feed (soonest ETA to the player's call, units on scene); recomputed once per second. */
  hud(): ResourceHud {
    return this.hudOut;
  }

  // --- Step -----------------------------------------------------------------------------------------------

  /** Fixed step (order -698). `player` = the officer's position. */
  step(dt: number, t: CadTime, player: { x: number; z: number }): void {
    if (!this.started) return;
    this.playerX = player.x;
    this.playerZ = player.z;
    this.lastSim = t.sim;
    this.lastGame = t.game;
    this.drainRequests(t);
    for (let i = 0; i < this.pool.length; i++) {
      const u = this.pool[i];
      if (u && u.status !== 'available') this.stepUnit(u, dt, t);
    }
    const slot = Math.floor(t.sim / AVL_S);
    if (slot !== this.lastAvlSlot) {
      this.lastAvlSlot = slot;
      this.avl();
    }
    this.refreshEta(Math.round(t.sim / dt));
    this.updateViews();
    this.writeCrews(dt);
    const hudSlot = Math.floor(t.sim);
    if (hudSlot !== this.lastHudSlot || this.revision !== this.lastHudRevision) {
      this.lastHudSlot = hudSlot;
      this.lastHudRevision = this.revision;
      this.updateHud();
    }
    this.updateAirView(t);
  }

  private now(): CadTime {
    return { sim: this.lastSim, game: this.lastGame };
  }

  private drainRequests(t: CadTime): void {
    const n = this.requests.length;
    if (n === 0) return;
    for (let i = 0; i < n; i++) {
      const r = this.requests[i];
      if (r) this.handle(r, t);
    }
    this.requests.splice(0, n);
    this.routed.clear();
  }

  private handle(r: ResourceRequest, t: CadTime): void {
    if (r.kind === 'request') {
      this.handleType(r.typeId, r.callId, r.via, t);
      return;
    }
    const u = this.byCallsign.get(r.callsign);
    if (!u) return;
    if (u.status === 'turnout' || u.status === 'enRoute' || u.status === 'onScene') this.leave(u, t);
  }

  // --- Request handling -----------------------------------------------------------------------------------

  private handleType(typeId: string, callIdIn: number, via: Via, t: CadTime): void {
    const { cad, dispatch, scene } = this.deps;
    const type = this.typeMap.get(typeId);
    const manual = via === 'radio' || via === 'mdt';
    if (!type || (manual && !type.requestable)) {
      if (manual) this.flash('Unknown resource');
      return;
    }
    if (type.send !== 'resource') return;

    // 2. The call: the named open call, else the player's, else (manual only) a new officer-assist call.
    let call: CadCall | null = null;
    if (callIdIn > 0) {
      const c = cad.call(callIdIn);
      if (c && c.status !== 'closed') call = c;
      else if (!manual) return;
    }
    if (!call) {
      const pcall = cad.unit(dispatch.playerCallsign)?.callId ?? null;
      const c = pcall !== null ? cad.call(pcall) : null;
      if (c && c.status !== 'closed') call = c;
    }
    if (!call) {
      if (!manual) return;
      const made = dispatch.openSelfInitiated('officerAssist', 3, { x: this.playerX, z: this.playerZ }, `Officer requesting ${type.label}.`, t);
      call = cad.call(made.id);
      if (!call) return;
    }

    // 3. Scene routing keeps the scene's flags and actions in sync; it calls `provide` back.
    const first = type.sceneServices[0];
    if (first !== undefined && via !== 'scene' && scene.hasScenario(call.id) && !scene.serviceRequested(call.id, first)) {
      // The scene answers later (and `serviceRequested` stays false until then): ask it once per batch. An explicit
      // request for a multi-unit type ("EMS 3") also assigns its units itself, the scene's own answer is then a no-op.
      const key = `${String(call.id)}:${first}`;
      if (!this.routed.has(key)) {
        this.routed.add(key);
        scene.request({ kind: 'serviceRequest', callId: call.id, service: first });
      }
      if (via !== 'mdt' || type.count <= 1) return;
    }

    // 4. Dedupe: a unit of the type is already on the call. An explicit MDT request for a multi-unit type adds another.
    let assigned: Unit | null = null;
    for (const u of this.pool) {
      if (u.type !== type || u.callId !== call.id) continue;
      if (u.status === 'turnout' || u.status === 'enRoute' || u.status === 'onScene') {
        assigned = u;
        break;
      }
    }
    if (assigned && !(via === 'mdt' && type.count > 1)) {
      if (assigned.status === 'onScene') this.announceServices(assigned);
      if (via === 'radio' || via === 'mdt') {
        const left = assigned.etaS >= 0 ? `, ETA ${clock(assigned.etaS)}` : '';
        this.radio('Dispatch', `${assigned.callsign} is already assigned${left}.`, type.channel);
      }
      return;
    }

    // 5. Pick by response time.
    const picked = type.behavior === 'air' ? this.pickAir(type, call) : this.pickGround(type, call);
    if (!picked) {
      this.radio('Dispatch', `No ${type.label} available.`, type.channel);
      this.flash(`No ${type.label} available`);
      return;
    }
    // 6. Assign.
    this.assign(picked.unit, call, picked.result, picked.lengthM, picked.originX, picked.originZ, t);
  }

  private pickAir(type: UnitType, call: CadCall): { unit: Unit; result: EtaResult; lengthM: number; originX: number; originZ: number } | null {
    const u = this.airUnit;
    if (!u || u.type !== type || u.status !== 'available' || !this.deps.cad.unit(u.callsign)) return null;
    if (!this.deps.cad.assign(call.id, u.callsign, this.now(), 'dispatch')) return null;
    const dist = Math.hypot(call.location.x - this.padX, call.location.z - this.padZ);
    const result = airEta(dist, this.cfg.airSpeedMps, type.turnoutS, call.priority);
    return { unit: u, result, lengthM: dist, originX: this.padX, originZ: this.padZ };
  }

  private pickGround(type: UnitType, call: CadCall): { unit: Unit; result: EtaResult; lengthM: number; originX: number; originZ: number } | null {
    const { city, cad } = this.deps;
    const cx = call.location.x;
    const cz = call.location.z;
    const cands: EtaCandidate[] = [];
    const returning = new Set<string>();
    for (const u of this.pool) {
      if (u.type !== type || (u.status !== 'available' && u.status !== 'returning') || !cad.unit(u.callsign)) continue;
      if (u.status === 'returning') {
        returning.add(u.callsign);
        const fs = this.deps.traffic.fleetState(u.fleetIndex, u.fs);
        cands.push({ id: u.callsign, x: fs ? fs.x : u.px, z: fs ? fs.z : u.pz });
      } else {
        const b = basePoint(city, type.base, cx, cz, this.scratchBase);
        cands.push({ id: u.callsign, x: b.x, z: b.z });
      }
    }
    if (cands.length === 0) return null;
    const density = this.density(cx, cz);
    const wetness = this.wetness();
    const urgency = urgencyFor(call.priority);
    const cache = new Map<string, Ranked>();
    const ranked = rankByEta(
      cands,
      cx,
      cz,
      (c) => {
        const r = city.graph.routeBetweenPoints(c.x, c.z, cx, cz);
        return r && Number.isFinite(r.time) && Number.isFinite(r.length) ? { timeS: r.time, lengthM: r.length } : null;
      },
      (c, route) => {
        const result = estimateResponse({
          routeTimeS: route.timeS,
          routeLengthM: route.lengthM,
          priority: call.priority,
          urgency,
          trafficDensity: density,
          wetness,
          turnoutS: returning.has(c.id) ? [0, 0] : type.turnoutS,
          speedFactor: type.speedFactor,
        });
        cache.set(c.id, { route, result });
        return result;
      },
    );
    for (const r of ranked) {
      const u = this.byCallsign.get(r.id);
      const hit = cache.get(r.id);
      const cand = cands.find((c) => c.id === r.id);
      if (!u || !hit || !cand) continue;
      if (!cad.assign(call.id, u.callsign, this.now(), 'dispatch')) continue;
      return { unit: u, result: hit.result, lengthM: hit.route.lengthM, originX: cand.x, originZ: cand.z };
    }
    return null;
  }

  private assign(u: Unit, call: CadCall, result: EtaResult, lengthM: number, originX: number, originZ: number, t: CadTime): void {
    const { cad } = this.deps;
    const urgency = urgencyFor(call.priority);
    u.status = 'turnout';
    u.callId = call.id;
    u.destX = call.location.x;
    u.destZ = call.location.z;
    u.urgency = urgency === 'emergency' ? 'emergency' : 'respond';
    u.etaS = result.etaS;
    u.travelS = result.travelS;
    u.expectedMps = u.air ? this.cfg.airSpeedMps : expectedSpeed(lengthM, result.travelS);
    u.turnoutUntil = t.sim + result.turnoutS;
    u.leaveAt = -1;
    u.patient = -1;
    u.noProgressSince = t.sim;
    u.progressLeftM = -1;
    u.nextTry = 0;
    u.px = originX;
    u.pz = originZ;
    cad.setUnitPosition(u.callsign, originX, originZ);
    this.revision++;
    const near = call.location.near;
    this.deps.bus.emit('resource:dispatched', { callsign: u.callsign, typeId: u.typeId, callId: call.id, etaS: result.etaS });
    const unit = this.deps.dispatch.playerCallsign;
    this.radio('Dispatch', `Copy ${unit}, ${u.callsign} en route to ${near}, ETA ${minutesText(result.etaS)}.`, u.type.channel);
    if (u.type.rank !== null) this.radio(u.callsign, `${u.callsign}, show me responding to ${near}.`, u.type.channel);
  }

  /** A scene service whose unit is already on scene: tell the scene (idempotent there). */
  private announceServices(u: Unit): void {
    const { scene } = this.deps;
    if (!scene.hasScenario(u.callId)) return;
    for (const kind of u.type.sceneServices) {
      if (scene.serviceRequested(u.callId, kind)) scene.request({ kind: 'serviceArrived', callId: u.callId, service: kind });
    }
  }

  // --- Unit FSM -------------------------------------------------------------------------------------------

  private stepUnit(u: Unit, dt: number, t: CadTime): void {
    switch (u.status) {
      case 'turnout':
        if (!this.callStillMine(u)) return this.leave(u, t);
        this.stepTurnout(u, t);
        return;
      case 'enRoute':
        if (!this.callStillMine(u)) return this.leave(u, t);
        if (u.air) this.stepAirFlight(u, dt, t);
        else this.stepEnRoute(u, t);
        return;
      case 'onScene':
        if (!this.callStillMine(u)) {
          if (!this.held(u, t)) this.leave(u, t);
          return;
        }
        if (u.air) this.stepAirFlight(u, dt, t);
        else this.stepOnScene(u, t);
        return;
      case 'transporting':
        this.stepHome(u, t, true);
        return;
      case 'returning':
        if (u.air) this.stepAirFlight(u, dt, t);
        else this.stepHome(u, t, false);
        return;
      case 'available':
      case 'outOfService':
        return;
    }
  }

  /** The unit is still assigned to its call in CAD (a closed call or a manual unassign releases it). */
  private callStillMine(u: Unit): boolean {
    const cu = this.deps.cad.unit(u.callsign);
    return cu !== null && cu.callId === u.callId;
  }

  private stepTurnout(u: Unit, t: CadTime): void {
    u.etaS = Math.max(0, u.turnoutUntil - t.sim) + u.travelS;
    if (t.sim < u.turnoutUntil) return;
    if (u.air) {
      this.flight.x = this.padX;
      this.flight.z = this.padZ;
      this.flight.y = 0;
      this.onTarget = false;
      u.status = 'enRoute';
      u.noProgressSince = t.sim;
      this.revision++;
      return;
    }
    if (t.sim < u.nextTry) return;
    const traffic = this.deps.traffic;
    if (!traffic.fleetState(u.fleetIndex, u.fs)) {
      const b = basePoint(this.deps.city, u.type.base, u.destX, u.destZ, this.scratchBase);
      const eid = this.spawnCar(u, b.x, b.z);
      if (eid === 0) {
        u.nextTry = t.sim + RETRY_S;
        this.forceIfStuck(u, t, u.turnoutUntil);
        return;
      }
      attachPoliceLights(this.deps.world, eid, u.phase);
      u.eid = eid;
      u.present = true;
    }
    if (!traffic.setFleetDestination(u.fleetIndex, u.destX, u.destZ, u.urgency)) {
      u.nextTry = t.sim + RETRY_S;
      this.forceIfStuck(u, t, u.turnoutUntil);
      return;
    }
    u.status = 'enRoute';
    u.noProgressSince = t.sim;
    u.progressLeftM = -1;
    this.revision++;
  }

  /** No car and no route for `NO_PROGRESS_S` since `since`: the unit counts as arrived (the service still happens). */
  private forceIfStuck(u: Unit, t: CadTime, since: number): void {
    if (t.sim - since >= NO_PROGRESS_S) this.arrive(u, t);
  }

  private spawnCar(u: Unit, x: number, z: number): number {
    const color = u.type.colorRgb;
    for (const [ox, oz] of SPAWN_OFFSETS) {
      const eid = this.deps.traffic.spawnFleetCar(u.fleetIndex, x + ox, z + oz, { modelIndex: u.modelIndex, color });
      if (eid !== 0) return eid;
    }
    return 0;
  }

  /** (Re)issues the destination of a unit with a car, falling back to a retry timer. */
  private sendCar(u: Unit, urgency: ResourceUrgency): void {
    if (!this.deps.traffic.setFleetDestination(u.fleetIndex, u.destX, u.destZ, urgency)) u.nextTry = this.lastSim + RETRY_S;
  }

  private stepEnRoute(u: Unit, t: CadTime): void {
    const fs = this.deps.traffic.fleetState(u.fleetIndex, u.fs);
    u.present = fs !== null;
    if (!fs) {
      // The car is gone (traffic reset): put it back near the last known position.
      if (t.sim >= u.nextTry) {
        u.nextTry = t.sim + RETRY_S;
        const eid = this.spawnCar(u, u.px, u.pz);
        if (eid !== 0) {
          attachPoliceLights(this.deps.world, eid, u.phase);
          u.eid = eid;
          this.sendCar(u, u.urgency);
        }
      }
      this.forceIfStuck(u, t, u.noProgressSince);
      return;
    }
    u.px = fs.x;
    u.pz = fs.z;
    this.syncLights(u, fs, true);
    this.trackProgress(u, fs, t);
    if (fs.arrived || Math.hypot(fs.x - u.destX, fs.z - u.destZ) <= ARRIVE_M || t.sim - u.noProgressSince >= NO_PROGRESS_S) {
      this.arrive(u, t);
    }
  }

  private trackProgress(u: Unit, fs: FleetState, t: CadTime): void {
    const left = fs.routeLeftM;
    if (left < 0) return;
    if (u.progressLeftM < 0) u.progressLeftM = left;
    else if (left < u.progressLeftM - PROGRESS_M) {
      u.progressLeftM = left;
      u.noProgressSince = t.sim;
    }
  }

  private syncLights(u: Unit, fs: FleetState, active: boolean): void {
    const eid = fs.eid;
    if (eid !== u.eid) {
      attachPoliceLights(this.deps.world, eid, u.phase);
      u.eid = eid;
    }
    PoliceLights.pattern[eid] = 0;
    PoliceLights.siren[eid] = active && fs.mode === 'emergency' && fs.speed > SIREN_SPEED ? 1 : 0;
  }

  private arrive(u: Unit, t: CadTime): void {
    const { cad, scene } = this.deps;
    u.status = 'onScene';
    u.etaS = 0;
    u.noProgressSince = t.sim;
    cad.setUnitStatus(u.callsign, 'onScene', t, 'auto');
    if (u.type.rank !== null) this.deps.roster.applyEvent(u.callsign, 'requestedAndArrived');
    if (u.air) {
      this.flight.onStationUntil = t.sim + ON_STATION_S;
      u.leaveAt = this.flight.onStationUntil;
    } else if (HELD.has(u.type.behavior)) {
      u.leaveAt = -1;
    } else {
      const [lo, hi] = u.type.onSceneS;
      u.leaveAt = t.sim + this.rng.nextFloat(lo, Math.max(lo, hi));
    }
    this.revision++;
    this.deps.bus.emit('resource:arrived', { callsign: u.callsign, typeId: u.typeId, callId: u.callId });
    this.radio(u.callsign, `${u.callsign}, on scene.`, u.type.channel);
    this.flash(`${u.callsign} on scene`);
    if (scene.hasScenario(u.callId)) {
      for (const kind of u.type.sceneServices) {
        if (scene.serviceRequested(u.callId, kind)) scene.request({ kind: 'serviceArrived', callId: u.callId, service: kind });
      }
    }
  }

  private stepOnScene(u: Unit, t: CadTime): void {
    const fs = this.deps.traffic.fleetState(u.fleetIndex, u.fs);
    u.present = fs !== null;
    if (fs) {
      u.px = fs.x;
      u.pz = fs.z;
      this.syncLights(u, fs, false);
    }
    // A command post keeps everyone on the call; the command module releases units explicitly.
    if (u.leaveAt >= 0 && t.sim >= u.leaveAt && !this.posts.has(u.callId) && !this.held(u, t)) this.leave(u, t);
  }

  /**
   * True while the unit waits for its officer on foot to get back into the car (at most `HOLD_S`): the officer walks
   * back as soon as the wait starts (`leaving`), so the car never drives off with the officer running after it.
   */
  private held(u: Unit, t: CadTime): boolean {
    const hold = this.deps.hold;
    if (!hold || u.air || u.status !== 'onScene' || !hold(u.callsign)) return false;
    if (u.holdSince < 0) u.holdSince = t.sim;
    return t.sim < u.holdSince + HOLD_S;
  }

  /** True while the unit waits for its officer to come back to the car (BackupSystem sends the officer back at once). */
  leaving(callsign: string): boolean {
    const u = this.byCallsign.get(callsign);
    return u !== undefined && u.holdSince >= 0;
  }

  /** The unit leaves its call: it is cleared in CAD and drives (flies) back to base. */
  private leave(u: Unit, t: CadTime): void {
    const { cad, roster } = this.deps;
    u.holdSince = -1;
    const call = cad.call(u.callId);
    if (u.type.rank !== null && u.status === 'onScene' && (!call || call.status === 'closed')) roster.applyEvent(u.callsign, 'callHandled');
    if (u.callId > 0) this.emitCleared(u);
    const cu = cad.unit(u.callsign);
    if (cu && (cu.callId !== null || cu.status !== 'available')) {
      cad.unassign(u.callsign, t);
      if (cad.unit(u.callsign)?.status !== 'available') cad.setUnitStatus(u.callsign, 'available', t, 'auto');
      // Integration fix: the last unit leaving a call someone worked closes it (a pending call would be offered again).
      if (call && call.status === 'pending' && call.firstOnScene !== null) cad.closeCall(call.id, 'handled', t);
    }
    u.callId = 0;
    u.etaS = -1;
    u.leaveAt = -1;
    u.patient = -1;
    this.revision++;
    if (u.air) {
      u.status = 'returning';
      return;
    }
    const fs = this.deps.traffic.fleetState(u.fleetIndex, u.fs);
    if (!fs) {
      // Never spawned (turnout cancelled): nothing to drive back.
      u.status = 'available';
      u.present = false;
      cad.setUnitPosition(u.callsign, u.homeX, u.homeZ);
      u.px = u.homeX;
      u.pz = u.homeZ;
      return;
    }
    const b = basePoint(this.deps.city, u.type.base, fs.x, fs.z, this.scratchBase);
    u.status = 'returning';
    u.destX = b.x;
    u.destZ = b.z;
    u.noProgressSince = t.sim;
    u.progressLeftM = -1;
    u.nextTry = 0;
    this.sendCar(u, 'respond');
    PoliceLights.siren[fs.eid] = 0;
  }

  /** Returning to base or driving a patient to the hospital: the car is removed at the destination. */
  private stepHome(u: Unit, t: CadTime, transporting: boolean): void {
    const fs = this.deps.traffic.fleetState(u.fleetIndex, u.fs);
    u.present = fs !== null;
    let home = fs === null;
    if (fs) {
      u.px = fs.x;
      u.pz = fs.z;
      this.syncLights(u, fs, false);
      if (t.sim >= u.nextTry && fs.routeLeftM < 0 && fs.speed < 0.5 && !fs.arrived) {
        u.nextTry = t.sim + RETRY_S;
        this.sendCar(u, 'respond');
      }
      this.trackProgress(u, fs, t);
      home = fs.arrived || Math.hypot(fs.x - u.destX, fs.z - u.destZ) <= HOME_M || t.sim - u.noProgressSince >= NO_PROGRESS_S;
    }
    if (!home) return;
    this.deps.traffic.removeFleetCar(u.fleetIndex);
    u.present = false;
    u.eid = 0;
    u.status = 'available';
    u.patient = -1;
    u.etaS = -1;
    u.px = u.homeX;
    u.pz = u.homeZ;
    if (transporting) this.deps.cad.setUnitStatus(u.callsign, 'available', t, 'auto');
    this.deps.cad.setUnitPosition(u.callsign, u.homeX, u.homeZ);
    u.callId = 0;
    this.revision++;
  }

  // --- Air unit -------------------------------------------------------------------------------------------

  private stepAirFlight(u: Unit, dt: number, t: CadTime): void {
    const f = this.flight;
    const speed = this.cfg.airSpeedMps;
    const alt = this.cfg.airAltitudeM;
    if (u.status === 'returning') {
      this.onTarget = false;
      const d = Math.hypot(this.padX - f.x, this.padZ - f.z);
      const landing = d <= LAND_M;
      stepAir(f, dt, this.padX, this.padZ, false, landing ? 0 : alt, speed);
      if (landing && f.y <= 0.01) {
        f.y = 0;
        u.status = 'available';
        u.px = this.padX;
        u.pz = this.padZ;
        this.deps.cad.setUnitPosition(u.callsign, this.padX, this.padZ);
        this.revision++;
      }
      return;
    }
    this.resolveAirTarget(u);
    stepAir(f, dt, f.tx, f.tz, true, alt, speed);
    this.onTarget = airOnTarget(f, f.tx, f.tz);
    u.px = f.x;
    u.pz = f.z;
    if (u.status === 'enRoute') {
      u.etaS = this.onTarget ? 0 : Math.hypot(f.tx - f.x, f.tz - f.z) / speed;
      if (airOnTarget(f, u.destX, u.destZ) || this.onTarget) this.arrive(u, t);
      return;
    }
    const slot = Math.floor(t.sim / REVEAL_EVERY_S);
    if (slot !== this.lastRevealSlot) {
      this.lastRevealSlot = slot;
      if (this.onTarget) this.scanReveal(u);
    }
    if (u.leaveAt >= 0 && t.sim >= u.leaveAt) this.leave(u, t);
  }

  /** Updates the target point (`tx`, `tz`) from the target. */
  private resolveAirTarget(u: Unit): void {
    const f = this.flight;
    switch (f.targetKind) {
      case 'vehicle':
        if (this.deps.traffic.fleeState(f.targetId, this.flee)) {
          f.tx = this.flee.x;
          f.tz = this.flee.z;
        }
        return;
      case 'actor': {
        const a = this.deps.npc.actor(f.targetId, this.info);
        if (a) {
          f.tx = a.x;
          f.tz = a.z;
        }
        return;
      }
      case 'point':
        return;
      case 'none':
        f.tx = u.destX;
        f.tz = u.destZ;
        return;
    }
  }

  /** FLIR: hidden outdoor actors within `REVEAL_M` of the target are revealed once. */
  private scanReveal(u: Unit): void {
    const { npc } = this.deps;
    const f = this.flight;
    const ids = npc.actorIds(this.actorList);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (id === undefined || this.revealed.has(id)) continue;
      const a = npc.actor(id, this.info);
      if (!a || !a.hidden || (a.building ?? -1) !== -1) continue;
      if (Math.hypot(a.x - f.tx, a.z - f.tz) > REVEAL_M) continue;
      this.revealed.add(id);
      npc.reveal(id);
      const near = this.deps.dispatch.locate(f.tx, f.tz).near;
      this.radio(u.callsign, `${u.callsign}, I have a heat signature ${compassWord(f.tx, f.tz, a.x, a.z)} of the ${near}.`, u.type.channel);
    }
  }

  // --- Periodic work --------------------------------------------------------------------------------------

  /** CAD positions of active units (2 Hz). */
  private avl(): void {
    const { cad } = this.deps;
    for (const u of this.pool) {
      if (u.status === 'available') continue;
      if (u.air) cad.setUnitPosition(u.callsign, this.flight.x, this.flight.z);
      else if (u.present) cad.setUnitPosition(u.callsign, u.fs.x, u.fs.z);
    }
  }

  /** One unit per step (round robin over the slots): the live ETA of a unit en route. */
  private refreshEta(tick: number): void {
    const n = this.pool.length;
    if (n === 0) return;
    const u = this.pool[((tick % n) + n) % n];
    if (!u || u.status !== 'enRoute') return;
    if (u.air) {
      u.etaS = Math.hypot(this.flight.tx - this.flight.x, this.flight.tz - this.flight.z) / this.cfg.airSpeedMps;
      return;
    }
    if (u.present) u.etaS = remainingEta(u.fs.routeLeftM, u.expectedMps);
  }

  private updateViews(): void {
    for (const u of this.pool) {
      const v = u.view;
      const eta = u.status === 'turnout' || u.status === 'enRoute' ? u.etaS : -1;
      if (v.status !== u.status || v.callId !== u.callId || Math.round(v.etaS) !== Math.round(eta)) this.revision++;
      v.status = u.status;
      v.callId = u.callId;
      v.etaS = eta;
      v.x = u.px;
      v.z = u.pz;
    }
  }

  private updateHud(): void {
    const { cad, dispatch } = this.deps;
    const pcall = cad.unit(dispatch.playerCallsign)?.callId ?? null;
    let best: Unit | null = null;
    let onScene = 0;
    if (pcall !== null) {
      for (const u of this.pool) {
        if (u.callId !== pcall) continue;
        if (u.status === 'onScene') onScene++;
        else if ((u.status === 'turnout' || u.status === 'enRoute') && u.etaS >= 0 && (best === null || u.etaS < best.etaS)) best = u;
      }
    }
    let next = best ? `${best.callsign} ETA ${clock(best.etaS)}` : null;
    if (pcall !== null) {
      // The patrol units sent as backup count too: the soonest ETA of all wins.
      let bestS = best ? best.etaS : Infinity;
      for (const cu of cad.units()) {
        if (cu.kind !== 'ai' || cu.callId !== pcall || cu.status !== 'enRoute') continue;
        const s = this.eta(cu.callsign);
        if (s >= 0 && s < bestS) {
          bestS = s;
          next = `${cu.callsign} ETA ${clock(s)}`;
        }
      }
    }
    this.hudOut.onScene = onScene;
    this.hudOut.next = next;
  }

  private updateAirView(t: CadTime): void {
    const u = this.airUnit;
    if (!u || u.status === 'available' || u.status === 'turnout') return;
    const f = this.flight;
    const v = this.airOut;
    v.x = f.x;
    v.y = f.y;
    v.z = f.z;
    v.yaw = f.yaw;
    v.targetX = f.tx;
    v.targetZ = f.tz;
    v.onTarget = this.onTarget;
    v.spot = this.onTarget && this.deps.env().night;
    v.rotor = (t.sim * ROTOR_RAD_S) % (Math.PI * 2);
  }

  // --- Crews ----------------------------------------------------------------------------------------------

  private writeCrews(dt: number): void {
    this.crewTimer += dt;
    if (this.crewTimer < CREW_S) return;
    this.crewTimer = 0;
    const c = this.crews;
    let n = 0;
    for (const u of this.pool) {
      if (u.air || u.status !== 'onScene') continue;
      // The walking backup officer replaces the static figure.
      if (this.deps.hold?.(u.callsign)) continue;
      const crew = u.type.crew;
      const total = crew.count + (crew.dog ? 1 : 0);
      if (total === 0) continue;
      const fs = this.deps.traffic.fleetState(u.fleetIndex, u.fs);
      if (!fs) continue;
      const post = (u.type.behavior === 'supervisor' || u.type.behavior === 'command') ? this.posts.get(u.callId) : undefined;
      const rank = u.type.rank;
      const profile = rank !== null ? this.deps.roster.profile(u.callsign) : null;
      const h = hashCode(u.callsign);
      for (let k = 0; k < total && n < MAX_CREW; k++) {
        const dog = crew.dog && k === total - 1;
        const spot = this.scratchSpot;
        if (post) {
          spot.x = post.x + k * 0.9;
          spot.z = post.z;
          spot.yaw = 0;
        } else {
          crewSpot(fs.x, fs.z, fs.yaw, k, total, spot);
        }
        c.x[n] = spot.x;
        c.y[n] = 0;
        c.z[n] = spot.z;
        c.yaw[n] = spot.yaw;
        c.prevX[n] = spot.x;
        c.prevY[n] = 0;
        c.prevZ[n] = spot.z;
        c.prevYaw[n] = spot.yaw;
        c.anchor[n] = 0;
        c.pose[n] = POSE.stand;
        c.gait[n] = 0;
        c.speed[n] = 0;
        c.height[n] = dog ? 0.6 : (profile?.height ?? 1.7 + (((h >>> (k * 3)) & 7) / 7) * 0.2);
        c.build[n] = 1;
        c.skin[n] = profile?.skin ?? SKIN[(h + k) % SKIN.length] ?? SKIN[0];
        c.hair[n] = profile?.hair ?? HAIR[(h + k * 2) % HAIR.length] ?? HAIR[0];
        c.top[n] = dog ? DOG_FUR : crew.topRgb;
        c.bottom[n] = crew.bottomRgb;
        c.held[n] = 0;
        c.body[n] = dog ? BODY.dog : BODY.human;
        c.flags[n] = 0;
        n++;
      }
    }
    c.count = n;
  }

  // --- Helpers --------------------------------------------------------------------------------------------

  private density(x: number, z: number): number {
    const d = this.deps.trafficDensity(x, z);
    return Number.isFinite(d) ? d : 1;
  }

  private wetness(): number {
    const w = this.deps.env().wetness;
    return Number.isFinite(w) ? w : 0;
  }

  private radio(speaker: string, text: string, channel: UnitType['channel']): void {
    this.deps.bus.emit('resource:radio', { channel, speaker, text });
  }

  private flash(text: string): void {
    this.deps.bus.emit('resource:flash', { text });
  }

  private emitCleared(u: Unit): void {
    this.deps.bus.emit('resource:cleared', { callsign: u.callsign, typeId: u.typeId, callId: u.callId });
  }

  // --- Persistence ----------------------------------------------------------------------------------------

  /** The save block (JSON-safe). */
  serialize(): ResourceSave {
    const units: ResourceUnitSave[] = this.pool.map((u) => ({
      callsign: u.callsign,
      status: u.status,
      callId: u.callId,
      etaS: u.etaS,
      travelS: u.travelS,
      expectedMps: u.expectedMps,
      turnoutUntil: u.turnoutUntil,
      leaveAt: u.leaveAt,
      destX: u.destX,
      destZ: u.destZ,
      urgency: u.urgency,
      patient: u.patient,
      noProgressSince: u.noProgressSince,
      progressLeftM: u.progressLeftM,
    }));
    const f = this.flight;
    const air: ResourceAirSave | null =
      this.airUnit === null
        ? null
        : {
            x: f.x, y: f.y, z: f.z, yaw: f.yaw, targetKind: f.targetKind, targetId: f.targetId, tx: f.tx, tz: f.tz,
            onStationUntil: f.onStationUntil, revealed: [...this.revealed],
          };
    const posts: [number, number, number, number][] = [];
    for (const [callId, p] of [...this.posts].sort((a, b) => a[0] - b[0])) posts.push([callId, p.x, p.z, POST_LEVELS.indexOf(p.level)]);
    return {
      version: 1,
      rng: this.rng.state(),
      units,
      air,
      posts,
      requests: this.requests.map((r) => ({ ...r })),
      slots: { avl: this.lastAvlSlot, reveal: this.lastRevealSlot },
    };
  }

  /**
   * Restores a save (CAD has been restored first): missing slot units are added to CAD at their base, fleet cars are
   * re-linked by fleet index (the traffic snapshot restored them) and PoliceLights are re-attached on the next step.
   */
  restore(s: ResourceSave, t: CadTime): void {
    this.rng.restore(s.rng);
    const saved = new Map<string, ResourceUnitSave>();
    for (const e of s.units) saved.set(e.callsign, e);
    for (const u of this.pool) {
      const e = saved.get(u.callsign);
      u.present = false;
      u.eid = 0;
      u.nextTry = 0;
      u.holdSince = -1;
      u.px = u.homeX;
      u.pz = u.homeZ;
      if (!e) {
        u.status = 'available';
        u.callId = 0;
        u.etaS = -1;
        u.leaveAt = -1;
        u.patient = -1;
        continue;
      }
      u.status = e.status;
      u.callId = e.callId;
      u.etaS = e.etaS;
      u.travelS = e.travelS;
      u.expectedMps = e.expectedMps;
      u.turnoutUntil = e.turnoutUntil;
      u.leaveAt = e.leaveAt;
      u.destX = e.destX;
      u.destZ = e.destZ;
      u.urgency = e.urgency;
      u.patient = e.patient;
      u.noProgressSince = e.noProgressSince;
      u.progressLeftM = e.progressLeftM;
      const fs = u.air ? null : this.deps.traffic.fleetState(u.fleetIndex, u.fs);
      if (fs) {
        u.present = true;
        u.px = fs.x;
        u.pz = fs.z;
      }
    }
    const f = this.flight;
    this.revealed.clear();
    if (s.air && this.airUnit) {
      f.x = s.air.x;
      f.y = s.air.y;
      f.z = s.air.z;
      f.yaw = s.air.yaw;
      f.targetKind = AIR_TARGET_KINDS.find((k) => k === s.air?.targetKind) ?? 'none';
      f.targetId = s.air.targetId;
      f.tx = s.air.tx;
      f.tz = s.air.tz;
      f.onStationUntil = s.air.onStationUntil;
      for (const id of s.air.revealed) this.revealed.add(id);
      this.airUnit.px = f.x;
      this.airUnit.pz = f.z;
    } else {
      f.x = this.padX;
      f.z = this.padZ;
      f.y = 0;
      f.yaw = 0;
      f.targetKind = 'none';
      f.targetId = 0;
      f.tx = this.padX;
      f.tz = this.padZ;
      f.onStationUntil = -1;
    }
    this.onTarget = false;
    this.posts.clear();
    for (const [callId, x, z, li] of s.posts) {
      const level = POST_LEVELS[li];
      if (level !== undefined) this.posts.set(callId, { x, z, level });
    }
    this.requests = s.requests.map((r) => ({ ...r }));
    this.lastSim = t.sim;
    this.lastGame = t.game;
    this.lastAvlSlot = s.slots ? s.slots.avl : Math.floor(t.sim / AVL_S);
    this.lastRevealSlot = s.slots ? s.slots.reveal : Math.floor(t.sim / REVEAL_EVERY_S);
    this.lastHudSlot = -1;
    this.crewTimer = Infinity;
    this.registerUnits(t);
    this.started = true;
    this.revision++;
  }

  /** Unsubscribes from the bus and removes the fleet cars. */
  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    for (const u of this.pool) if (!u.air && u.fleetIndex >= 0) this.deps.traffic.removeFleetCar(u.fleetIndex);
    this.requests.length = 0;
    this.crews.count = 0;
  }
}

