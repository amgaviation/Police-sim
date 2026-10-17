import type { RigidBody } from '@dimforge/rapier3d-compat';
import type { EntityId } from 'bitecs';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import { createRng, type Rng, type RngState } from '../core/rng';
import { EntityKind, KIND, PrevTransform, Transform, copyTransformSlot } from '../ecs/components';
import { despawn, spawn, type GameWorld } from '../ecs/world';
import type { CollisionEvent, PhysicsWorld, Vec3 } from '../physics/physics';
import { canBeOnRoad } from '../records/vehicle';
import { LIGHT, VehicleLook, attachVehicleLook } from '../vehicles/components';
import { VEHICLE_MODELS, restHeight } from '../vehicles/model';
import type { City } from '../world/city';
import { MPH } from '../world/constants';
import {
  ASPECT,
  JUNCTION,
  ROAD_CLASS,
  TURN,
  laneDir,
  laneEdge,
  laneIndex,
  laneRef,
  type LaneConnection,
  type LanePoint,
  type RoadEdge,
  type RoadGraph,
  type RoadHit,
  type RoadNode,
  type Route,
  type ZoneTime,
} from '../world/roadGraph';
import { attachTrafficCar, TrafficCar } from './components';
import { DENSITY, PULLOVER, VIOLATIONS } from './data';
import type { TrafficReleaseReason, TrafficViolationKind } from './events';
import { idmAccel, IDM_S0 } from './idm';
import { REGISTRY_POPULATION, vehicleRecord } from './registry';

/**
 * Ambient traffic (design §9.2): kinematic cars on the road graph's lanes, IDM car following,
 * signals and stop signs, law-breaking behaviours, density streaming around a focus point and
 * kinematic Rapier proxies near the player. Fixed step, main thread, allocation-free per step
 * (spawns, despawns and events are rare transitions and may allocate).
 */

/** A parked player vehicle traffic keeps clear of: centre, heading (unit, travel direction) and half size. */
export interface TrafficParked {
  x: number;
  z: number;
  hx: number;
  hz: number;
  halfLength: number;
  halfWidth: number;
}

/** Most parked player vehicles traffic looks at (`TrafficFocus.parked`). */
export const MAX_PARKED_OBSTACLES = 8;

/** The player as seen by traffic: streaming centre plus an optional obstacle (car or officer). */
export interface TrafficFocus {
  x: number;
  z: number;
  obstacle: boolean;
  ox: number;
  oz: number;
  ovx: number;
  ovz: number;
  /** Half length along the obstacle's travel: the longitudinal gap is measured to it. */
  oRadius: number;
  /** Half width: the obstacle is in a car's lane when its centre is within laneWidth / 2 + this. */
  oHalfWidth: number;
  /** Player vehicles standing nearby (the car the officer got out of): entries 0 .. parkedCount - 1. */
  parked?: readonly TrafficParked[];
  parkedCount?: number;
  /** Yaw of the player car (stop detection and yielding need it; without it neither runs). */
  heading?: number;
  /** Player car light bar on: the car ahead becomes a traffic-stop target. */
  lights?: boolean;
  /** Player car siren on (with `lights`): cars ahead yield. */
  siren?: boolean;
}

export interface TrafficDeps {
  world: GameWorld;
  physics: PhysicsWorld;
  graph: RoadGraph;
  /** District lookup for the density target; without it the nearest edge's district is used. */
  city?: City;
  seed: number;
  /** session.rng.stream('traffic'). */
  rng: Rng;
  bus?: EventBus<EventMap>;
}

export const TRAFFIC_STATE = { driving: 0, waiting: 1, crashed: 2, parked: 3 } as const;
export type TrafficStateId = (typeof TRAFFIC_STATE)[keyof typeof TRAFFIC_STATE];

/** Fleet car `index` has vehicle id `FLEET_ID_BASE + index`: never a registry id. */
export const FLEET_ID_BASE = 1 << 20;

export function isFleetVehicleId(id: number): boolean {
  return id >= FLEET_ID_BASE;
}

/** Curb-offset phase of a car (design §7.1). */
export const PULL = { none: 0, pulling: 1, stopped: 2, merging: 3, yielding: 4, parking: 5, parked: 6 } as const;
export type PullId = (typeof PULL)[keyof typeof PULL];

export type FleetUrgency = 'respond' | 'emergency';

/** Explicit look of a fleet car: `VehicleModel.index` and body colour 0xRRGGBB. */
export interface FleetLook {
  readonly modelIndex: number;
  readonly color: number;
}

/** `TrafficSystem.fleetState` output. */
export interface FleetState {
  eid: number;
  x: number;
  z: number;
  yaw: number;
  speed: number;
  edge: number;
  mode: 'patrol' | FleetUrgency;
  arrived: boolean;
  parked: boolean;
  /** Metres left to the destination along the route; -1 without a route. */
  routeLeftM: number;
}

/** `TrafficSystem.stopState` output: the current traffic-stop target. */
export interface StopState {
  vehicleId: number;
  eid: number;
  phase: 'pulling' | 'stopped' | 'merging';
  x: number;
  z: number;
  yaw: number;
}

/** Fleet urgency as stored and saved: 0 patrol, 1 respond, 2 emergency. */
const URGENCY = { patrol: 0, respond: 1, emergency: 2 } as const;
const URGENCY_MODE = ['patrol', 'respond', 'emergency'] as const;

/** Per-trip behaviour bits (`TrafficCarInfo.behavior`). */
export const BEHAVIOR = { speeding: 1, tailgating: 2, redLight: 4, rollingStop: 8, dui: 16 } as const;

/** Read-only dense SoA for the HUD/minimap/renderer: slots 0 .. count - 1 (swap-remove on despawn). */
export interface TrafficView {
  readonly count: number;
  readonly eid: Int32Array;
  readonly vehicleId: Int32Array;
  readonly x: Float32Array;
  readonly z: Float32Array;
  readonly yaw: Float32Array;
  readonly speed: Float32Array;
  readonly state: Uint8Array;
  /** `VehicleModel.index` per slot. */
  readonly model: Uint8Array;
}

/** One car in a snapshot; plain numbers only. */
export interface TrafficCarSave {
  vehicleId: number;
  lane: number;
  s: number;
  speed: number;
  accel: number;
  nextLane: number;
  state: number;
  behavior: number;
  desiredFactor: number;
  headway: number;
  weaveAmp: number;
  weavePeriod: number;
  weavePhase: number;
  stopPhase: number;
  stopTimer: number;
  /** Junction node this car holds, -1 if none. */
  holding: number;
  /** Violation bits already reported on the current edge. */
  reported: number;
  flags: number;
  // Phase 2, written only when not the default:
  /** Fleet look (`VehicleModel.index`, colour). */
  model?: number;
  color?: number;
  /** Fleet index (vehicleId - FLEET_ID_BASE). */
  fleet?: number;
  /** Fleet route: edge ids from the edge the route was planned on to the destination edge. */
  route?: number[];
  routePos?: number;
  destX?: number;
  destZ?: number;
  destEdge?: number;
  /** Destination along `destEdge` from its `from` node (m). */
  destS?: number;
  /** 0 patrol, 1 respond, 2 emergency. */
  urgency?: number;
  /** 1 when the fleet car reached its destination. */
  arrived?: number;
  /** `PULL` phase. */
  pull?: number;
  shoulder?: number;
  pullTimer?: number;
  /** 1 when never despawned by distance. */
  pinned?: number;
}

export interface TrafficSnapshot {
  version: 1;
  rng: RngState;
  spawnSeq: number;
  cars: TrafficCarSave[];
  // Phase 2, written only when set:
  stopVehicleId?: number;
  stopCandidate?: number;
  stopTimer?: number;
}

/** Debug/test view of one car (`TrafficSystem.inspect`). */
export interface TrafficCarInfo {
  lane: number;
  s: number;
  nextLane: number;
  behavior: number;
  desiredFactor: number;
  headway: number;
  /** Current lateral offset from the lane centre (DUI weave), + = right. */
  lateral: number;
  weaveAmp: number;
  /** Effective limit on the current edge at the last step. */
  limitMph: number;
  /** True while crossing the junction at the end of the lane. */
  inJunction: boolean;
  /** Curb offset (m, + = right) and `PULL` phase (filled by `inspect`). */
  shoulder?: number;
  pull?: number;
}

/** Options for `spawnAt` (tests and debug commands); omitted values are drawn as for a normal spawn. */
export interface SpawnOptions {
  vehicleId?: number;
  speed?: number;
  behavior?: number;
  desiredFactor?: number;
  headway?: number;
  weaveAmp?: number;
  weavePeriod?: number;
}

const CONTROL = { none: 0, signal: 1, stop: 2, yield: 3 } as const;
const STOP_PHASE = { approach: 0, waiting: 1, cleared: 2 } as const;
/** `fullStop`: stopped at the current stop sign; `merge`: the next lane is shared with a sibling lane (lane drop). */
const CAR_FLAG = { fullStop: 1, merge: 2 } as const;
const VIOLATION_BIT: Readonly<Record<TrafficViolationKind, number>> = {
  speeding: 1,
  redLight: 2,
  rollingStop: 4,
  tailgating: 8,
  weaving: 16,
};

/** Wait after a full stop at a stop sign (s). */
const STOP_WAIT_S = 1;
/** Speed rolling stoppers (and yield approaches) slow to at the line (m/s). */
const ROLLING_STOP_SPEED = 3;
/** Left turns at signals yield to oncoming cars this close to their stop line (m). */
const LEFT_YIELD_DISTANCE = 35;
/** Minor-road cars wait while a major-road car is this close to the junction (m) ... */
const MAJOR_CLEAR_DISTANCE = 40;
/** ... or will reach its line within this time (s): pulling away from a stop and clearing the box takes 3-4 s. */
const GAP_S = 5;
const TURN_SPEED = 6;
const UTURN_SPEED = 3;
/** Hard minimum bumper gap; the integrator never lets a car close below it (m). */
const MIN_GAP = 0.5;
/** Bumper distance to the stop line when stopped there (m). */
const STOP_LINE_GAP = 0.5;
/** Stop lines further ahead than this are ignored (m). */
const GATE_LOOKAHEAD = 200;
/** Within this distance of the stop line a car counts as "at the junction" (m). */
const NEAR_LINE = 30;
/** Bumper distance to a stop sign's line within which the car counts as stopped at it (m). */
const STOP_ZONE = 2.5;
/** The focus obstacle is ignored beyond this distance ahead (m). */
const OBSTACLE_LOOKAHEAD = 80;
/** Spawn: centre distance to any car on the same lane (m). */
const SPAWN_SPACING = 20;
/** Spawn: snap distance from the sampled point to a road (m). */
const SPAWN_SNAP = 40;
/** Spawns never land this close to the focus (m). */
const NEVER_WITHIN = 25;
/** Crashed cars are cleared once the focus is this far away (m). */
const CRASHED_DESPAWN = 150;
/** Registry walk stride, coprime to the population. */
const REGISTRY_STRIDE = 7919;
const NORMAL_FACTOR: readonly [number, number] = [0.92, 1.04];
const NORMAL_HEADWAY: readonly [number, number] = [1.2, 1.6];
/** DUI drivers brake late: a larger IDM comfort decel shrinks the anticipation term. */
const DUI_LATE_BRAKE = 2;
const SPEEDING_RATIO = 1.1;
const SPEEDING_MARGIN_MPH = 5;
const TAILGATE_HEADWAY_S = 1;
const TAILGATE_MIN_SPEED = 8;
const BRAKE_LIGHT_DECEL = 0.4;
/** A car whose lane ends (lane drop) yields to sibling-lane cars bound for the same lane this close to the line (m). */
const MERGE_DISTANCE = 30;
const TWO_PI = Math.PI * 2;

/** Per-model constants, indexed by `VehicleModel.index`. */
const MODEL_HALF_LEN = Float64Array.from(VEHICLE_MODELS, (m) => m.body.length / 2);
const MODEL_HALF_WID = Float64Array.from(VEHICLE_MODELS, (m) => m.body.width / 2);
const MODEL_HALF_HGT = Float64Array.from(VEHICLE_MODELS, (m) => m.body.height / 2);
const MODEL_REST_Y = Float64Array.from(VEHICLE_MODELS, (m) => restHeight(m));
const MODEL_A_MAX = Float64Array.from(VEHICLE_MODELS, (m) => m.traffic.maxAccel);
const MODEL_B = Float64Array.from(VEHICLE_MODELS, (m) => m.traffic.comfortDecel);
const MODEL_MAX_DECEL = Float64Array.from(VEHICLE_MODELS, (m) => m.traffic.maxDecel);
const MAX_HALF_LEN = Math.max(...MODEL_HALF_LEN);
const MIN_COMFORT_DECEL = Math.min(...MODEL_B);

type SlotArray = Float64Array | Float32Array | Int32Array | Int16Array | Uint8Array;

const CAR_SAVE_KEYS: readonly (keyof TrafficCarSave)[] = [
  'vehicleId', 'lane', 's', 'speed', 'accel', 'nextLane', 'state', 'behavior', 'desiredFactor', 'headway',
  'weaveAmp', 'weavePeriod', 'weavePhase', 'stopPhase', 'stopTimer', 'holding', 'reported', 'flags',
];
/** Optional Phase 2 number fields of a car save. */
const CAR_OPTIONAL_KEYS: readonly (keyof TrafficCarSave)[] = [
  'model', 'color', 'fleet', 'routePos', 'destX', 'destZ', 'destEdge', 'destS', 'urgency', 'arrived', 'pull',
  'shoulder', 'pullTimer', 'pinned',
];
const SNAPSHOT_OPTIONAL_KEYS: readonly (keyof TrafficSnapshot)[] = ['stopVehicleId', 'stopCandidate', 'stopTimer'];

/** Route edges stored per fleet car; a longer route is followed in parts (re-planned at its end). */
const ROUTE_CAP = 512;
/** Fleet spawns snap to a road this close (m). */
const FLEET_SNAP = 200;
/** Fleet destinations snap to a road this close (m). */
const DEST_SNAP = 300;
/** A yielding car merges back once every source is farther than this (m). */
const YIELD_RELEASE_DISTANCE = 80;
/** A car whose shoulder is within this of its curb target is clear of its lane (m). */
const ASIDE_MARGIN = 0.25;
/** A merging car waits while a car behind on its lane is this close (m) or this many seconds away. */
const MERGE_CLEAR_M = 12;
/** Extra longitudinal clearance (m) a car moving across lanes to or from the curb keeps from cars beside it. */
const SIDE_CLEAR_M = 1.5;
/** `sideBlock` results. */
const SIDE = { clear: 0, moving: 1, curb: 2 } as const;
const MERGE_CLEAR_S = 2.5;
/** An emergency fleet car crossing against a signal or sign waits while another approach has a car this close (m / s). */
const EMERGENCY_CLEAR_M = 15;
const EMERGENCY_CLEAR_S = 1.5;

function isFiniteNumber(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isUint32(value: unknown): boolean {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

/** Type guard for save validation: a version-1 snapshot made of finite numbers only. */
export function isTrafficSnapshot(value: unknown): value is TrafficSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Partial<Record<keyof TrafficSnapshot, unknown>>;
  if (v.version !== 1 || typeof v.spawnSeq !== 'number' || !Number.isInteger(v.spawnSeq) || v.spawnSeq < 0) return false;
  const rng = v.rng as Partial<RngState> | null | undefined;
  if (typeof rng !== 'object' || rng === null || !isUint32(rng.seed) || !Array.isArray(rng.s) || rng.s.length !== 4) return false;
  if (!rng.s.every(isUint32) || !Array.isArray(v.cars)) return false;
  const snap = value as Record<string, unknown>;
  if (!SNAPSHOT_OPTIONAL_KEYS.every((key) => snap[key] === undefined || isFiniteNumber(snap[key]))) return false;
  return v.cars.every((car: unknown) => {
    if (typeof car !== 'object' || car === null) return false;
    const c = car as Record<string, unknown>;
    if (!CAR_SAVE_KEYS.every((key) => isFiniteNumber(c[key]))) return false;
    if (!CAR_OPTIONAL_KEYS.every((key) => c[key] === undefined || isFiniteNumber(c[key]))) return false;
    const route = c.route;
    return route === undefined || (Array.isArray(route) && route.every((e) => typeof e === 'number' && Number.isInteger(e) && e >= 0));
  });
}

export class TrafficSystem {
  /** Most ambient cars (`density.json` capacity); fleet cars have their own slots on top. */
  readonly capacity: number;
  readonly view: TrafficView;
  /** `spawned` / `despawned` count the 'traffic:spawned' / 'traffic:despawned' events (silent clears are not counted). */
  readonly stats = { active: 0, proxies: 0, spawned: 0, despawned: 0 };
  /** Multiplies the density target (debug); 0 stops spawning (despawning continues). */
  densityScale = 1;

  private readonly world: GameWorld;
  private readonly physics: PhysicsWorld;
  private readonly graph: RoadGraph;
  private readonly city: City | undefined;
  private readonly seed: number;
  private readonly rng: Rng;
  private readonly bus: EventBus<EventMap> | undefined;
  private readonly unsubscribe: () => void;

  private count = 0;
  /** Cars that are not fleet cars (the density target counts these). */
  private ambientCount = 0;
  /** SoA size: ambient capacity plus the fleet cars. */
  private readonly slotCap: number;
  private spawnSeq = 0;
  private readonly registryOffset: number;
  private headlights = false;
  private simTime = 0;

  // --- SoA (slot-indexed) -------------------------------------------------------------
  private readonly eid: Int32Array;
  private readonly vehicleId: Int32Array;
  private readonly x: Float32Array;
  private readonly z: Float32Array;
  private readonly yaw: Float32Array;
  private readonly speedView: Float32Array;
  private readonly state: Uint8Array;
  private readonly model: Uint8Array;
  private readonly lane: Int32Array;
  private readonly s: Float64Array;
  private readonly v: Float64Array;
  private readonly accel: Float64Array;
  private readonly nextLane: Int32Array;
  private readonly turn: Uint8Array;
  /** Connector: stop-line point, control point, next lane start; length. */
  private readonly c0x: Float64Array;
  private readonly c0z: Float64Array;
  private readonly c1x: Float64Array;
  private readonly c1z: Float64Array;
  private readonly c2x: Float64Array;
  private readonly c2z: Float64Array;
  private readonly clen: Float64Array;
  private readonly behavior: Uint8Array;
  private readonly desiredFactor: Float64Array;
  private readonly headway: Float64Array;
  private readonly weaveAmp: Float64Array;
  private readonly weavePeriod: Float64Array;
  private readonly weavePhase: Float64Array;
  private readonly lateral: Float64Array;
  private readonly stopPhase: Uint8Array;
  private readonly stopTimer: Float64Array;
  private readonly holding: Int32Array;
  private readonly reported: Uint8Array;
  private readonly flags: Uint8Array;
  private readonly hx: Float64Array;
  private readonly hz: Float64Array;
  private readonly limitMph: Float64Array;
  /** Curb offset to the right of the lane centre (m) and its `PULL` phase. */
  private readonly shoulder: Float64Array;
  private readonly pull: Uint8Array;
  /** Yield time (s); negative after a yield timed out: no new yield until it counts back up to 0. */
  private readonly pullTimer: Float64Array;
  /** 1: never despawned by distance (stop target, fleet cars). */
  private readonly pinned: Uint8Array;
  /** Fleet index, -1 for ambient cars. */
  private readonly fleetIndex: Int16Array;
  /** Derived from shoulder/pull: 1 when the body is clear of its lane (cars behind pass it). */
  private readonly aside: Uint8Array;
  /** Per-step scratch: gap to the car/obstacle ahead (for the hard no-overlap clamp). */
  private readonly hardGap: Float64Array;
  /**
   * Per-step scratch: 1 = the pull is deferred past the junction ahead; 2 = a merge waits for a gap;
   * 3 = the sideways move waits for the lanes towards the curb to clear (lateral position held).
   */
  private readonly pullHold: Uint8Array;
  private readonly proxy: (RigidBody | null)[];
  private readonly slotArrays: SlotArray[];

  /** Slots sorted by (lane, s, slot); rebuilt incrementally (insertion sort) each step. */
  private readonly order: Int32Array;
  /** 1 while a registry id is on the road. */
  private readonly onRoad: Uint8Array;
  /** Cars holding each junction node (crossing it, or cleared at its stop line). */
  private readonly nodeHold: Int32Array;
  /** The part of `nodeHold` taken from stop / yield approaches: major-road cars wait for these. */
  private readonly minorHold: Int32Array;
  /** The part of `nodeHold` taken from signal approaches, per node and signal group (node * 2 + group). */
  private readonly signalHold: Int32Array;
  /** Per approach (edge * 2 + dir): CONTROL id, signal group and the oncoming approach (-1 = none). */
  private readonly control: Uint8Array;
  private readonly group: Uint8Array;
  private readonly oncoming: Int32Array;

  // --- Fleet cars, indexed by fleet index ------------------------------------------------
  private readonly fleetEid: Int32Array;
  private readonly urgency: Uint8Array;
  private readonly arrived: Uint8Array;
  private readonly destX: Float64Array;
  private readonly destZ: Float64Array;
  private readonly destS: Float64Array;
  /** -1: no destination. */
  private readonly destEdge: Int32Array;
  private readonly routeBuf: Int32Array;
  private readonly routeLen: Int32Array;
  private readonly routePos: Int32Array;

  // --- Traffic stop ------------------------------------------------------------------------
  private stopId = -1;
  private stopEid = 0;
  private stopCandidate = -1;
  /** Seconds the current stop candidate has persisted. */
  private stopDelay = 0;

  /** Per-step yield sources: position and unit heading. */
  private readonly srcX: Float64Array;
  private readonly srcZ: Float64Array;
  private readonly srcHx: Float64Array;
  private readonly srcHz: Float64Array;
  private srcCount = 0;
  private readonly nearEdges: number[] = [];
  /** `fleetSpot` result: s on the chosen lane. */
  private spotS = 0;

  private readonly lp: LanePoint = { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 };
  private readonly lp2: LanePoint = { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 };
  private readonly hit: RoadHit = { edge: -1, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 };
  private readonly vec: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly half: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly quat = { x: 0, y: 0, z: 0, w: 1 };

  constructor(deps: TrafficDeps) {
    this.world = deps.world;
    this.physics = deps.physics;
    this.graph = deps.graph;
    this.city = deps.city;
    this.seed = deps.seed;
    this.rng = deps.rng;
    this.bus = deps.bus;
    this.registryOffset = createRng(deps.seed).stream('traffic:registry').nextInt(0, REGISTRY_POPULATION - 1);
    this.capacity = DENSITY.capacity;
    const fleetCars = PULLOVER.fleet.maxCars;
    const cap = DENSITY.capacity + fleetCars;
    this.slotCap = cap;
    const f64 = (): Float64Array => new Float64Array(cap);
    this.eid = new Int32Array(cap);
    this.vehicleId = new Int32Array(cap);
    this.x = new Float32Array(cap);
    this.z = new Float32Array(cap);
    this.yaw = new Float32Array(cap);
    this.speedView = new Float32Array(cap);
    this.state = new Uint8Array(cap);
    this.model = new Uint8Array(cap);
    this.lane = new Int32Array(cap);
    this.s = f64();
    this.v = f64();
    this.accel = f64();
    this.nextLane = new Int32Array(cap);
    this.turn = new Uint8Array(cap);
    this.c0x = f64();
    this.c0z = f64();
    this.c1x = f64();
    this.c1z = f64();
    this.c2x = f64();
    this.c2z = f64();
    this.clen = f64();
    this.behavior = new Uint8Array(cap);
    this.desiredFactor = f64();
    this.headway = f64();
    this.weaveAmp = f64();
    this.weavePeriod = f64();
    this.weavePhase = f64();
    this.lateral = f64();
    this.stopPhase = new Uint8Array(cap);
    this.stopTimer = f64();
    this.holding = new Int32Array(cap);
    this.reported = new Uint8Array(cap);
    this.flags = new Uint8Array(cap);
    this.hx = f64();
    this.hz = f64();
    this.limitMph = f64();
    this.shoulder = f64();
    this.pull = new Uint8Array(cap);
    this.pullTimer = f64();
    this.pinned = new Uint8Array(cap);
    this.fleetIndex = new Int16Array(cap);
    this.aside = new Uint8Array(cap);
    this.hardGap = f64();
    this.pullHold = new Uint8Array(cap);
    this.proxy = new Array<RigidBody | null>(cap).fill(null);
    this.slotArrays = [
      this.eid, this.vehicleId, this.x, this.z, this.yaw, this.speedView, this.state, this.model, this.lane,
      this.s, this.v, this.accel, this.nextLane, this.turn, this.c0x, this.c0z, this.c1x, this.c1z, this.c2x,
      this.c2z, this.clen, this.behavior, this.desiredFactor, this.headway, this.weaveAmp, this.weavePeriod,
      this.weavePhase, this.lateral, this.stopPhase, this.stopTimer, this.holding, this.reported, this.flags,
      this.hx, this.hz, this.limitMph, this.shoulder, this.pull, this.pullTimer, this.pinned, this.fleetIndex,
      this.aside,
    ];
    this.fleetEid = new Int32Array(fleetCars);
    this.urgency = new Uint8Array(fleetCars);
    this.arrived = new Uint8Array(fleetCars);
    this.destX = new Float64Array(fleetCars);
    this.destZ = new Float64Array(fleetCars);
    this.destS = new Float64Array(fleetCars);
    this.destEdge = new Int32Array(fleetCars).fill(-1);
    this.routeBuf = new Int32Array(fleetCars * ROUTE_CAP);
    this.routeLen = new Int32Array(fleetCars);
    this.routePos = new Int32Array(fleetCars);
    this.srcX = new Float64Array(fleetCars + 1);
    this.srcZ = new Float64Array(fleetCars + 1);
    this.srcHx = new Float64Array(fleetCars + 1);
    this.srcHz = new Float64Array(fleetCars + 1);
    this.order = new Int32Array(cap);
    this.onRoad = new Uint8Array(REGISTRY_POPULATION);
    this.nodeHold = new Int32Array(this.graph.nodes.length);
    this.minorHold = new Int32Array(this.graph.nodes.length);
    this.signalHold = new Int32Array(this.graph.nodes.length * 2);

    const approaches = this.graph.edges.length * 2;
    this.control = new Uint8Array(approaches);
    this.group = new Uint8Array(approaches);
    this.oncoming = new Int32Array(approaches).fill(-1);
    for (let e = 0; e < this.graph.edges.length; e++) {
      this.classifyApproach(e, 0);
      this.classifyApproach(e, 1);
    }

    const countOf = (): number => this.count;
    this.view = {
      get count() {
        return countOf();
      },
      eid: this.eid,
      vehicleId: this.vehicleId,
      x: this.x,
      z: this.z,
      yaw: this.yaw,
      speed: this.speedView,
      state: this.state,
      model: this.model,
    };
    this.unsubscribe = this.physics.onCollision((event) => this.onCollision(event));
  }

  get activeCount(): number {
    return this.count;
  }

  /** Headlights of every traffic car (the caller passes `env.lighting.headlightsOn`). */
  setHeadlights(on: boolean): void {
    this.headlights = on;
  }

  slotOfEntity(eid: EntityId): number {
    if (eid < 0 || eid >= TrafficCar.slot.length) return -1;
    const slot = TrafficCar.slot[eid] ?? -1;
    return slot >= 0 && slot < this.count && this.eid[slot] === eid ? slot : -1;
  }

  vehicleIdOfEntity(eid: EntityId): number {
    const slot = this.slotOfEntity(eid);
    return slot < 0 ? -1 : (this.vehicleId[slot] ?? -1);
  }

  /** Fills the target number of cars around the focus at once (session start, after a teleport). */
  populate(focus: TrafficFocus, time: ZoneTime): void {
    this.sortOrder();
    const target = this.targetCount(focus, time);
    const { initialMin, spawnMax } = DENSITY.radii;
    for (let attempt = 0; attempt < target * 30 && this.ambientCount < target; attempt++) {
      this.trySpawnRandom(focus, time, Math.max(initialMin, NEVER_WITHIN), spawnMax);
    }
  }

  /** One fixed step (system order 50: after copyPrevTransform, before physics). */
  step(dt: number, simTime: number, time: ZoneTime, focus: TrafficFocus): void {
    this.simTime = simTime;
    this.sortOrder();
    const tickS = DENSITY.tickS;
    if (Math.floor(simTime / tickS) !== Math.floor((simTime - dt) / tickS)) this.tick(focus, time);
    this.updateStop(dt, focus);
    this.updateYield(dt, focus);
    const n = this.count;
    for (let k = 0; k < n; k++) this.computeAccel(this.order[k] ?? 0, k, dt, time, focus);
    for (let slot = 0; slot < n; slot++) this.integrate(slot, dt, focus);
    for (let slot = 0; slot < n; slot++) {
      this.pose(slot);
      this.writeEcs(slot);
      this.updateProxy(slot, dt, focus);
    }
    this.stats.active = this.count;
  }

  /** Places one car on `lane` at `s` (tests, debug commands); returns its slot or -1. */
  spawnAt(lane: number, s: number, options: SpawnOptions = {}): number {
    if (this.ambientCount >= this.capacity || this.count >= this.slotCap) return -1;
    if (this.graph.laneCount(laneEdge(lane), laneDir(lane)) <= laneIndex(lane)) return -1;
    const id = options.vehicleId ?? this.nextVehicleId();
    if (id < 0 || id >= REGISTRY_POPULATION || this.onRoad[id] === 1) return -1;
    const slot = this.spawnCar(id, lane, s, options.speed ?? 0, { hour: 12, isWeekday: true }, options.behavior);
    if (options.desiredFactor !== undefined) this.desiredFactor[slot] = options.desiredFactor;
    if (options.headway !== undefined) this.headway[slot] = options.headway;
    if (options.weaveAmp !== undefined) this.weaveAmp[slot] = options.weaveAmp;
    if (options.weavePeriod !== undefined) this.weavePeriod[slot] = options.weavePeriod;
    this.pose(slot);
    this.writeEcs(slot);
    copyTransformSlot(Transform, PrevTransform, this.eid[slot] ?? 0);
    return slot;
  }

  /** Fills `out` with the state of `slot` (0 .. count - 1). */
  inspect(slot: number, out: TrafficCarInfo): TrafficCarInfo {
    const lane = this.lane[slot] ?? 0;
    out.lane = lane;
    out.s = this.s[slot] ?? 0;
    out.nextLane = this.nextLane[slot] ?? -1;
    out.behavior = this.behavior[slot] ?? 0;
    out.desiredFactor = this.desiredFactor[slot] ?? 1;
    out.headway = this.headway[slot] ?? 0;
    out.lateral = this.lateral[slot] ?? 0;
    out.weaveAmp = this.weaveAmp[slot] ?? 0;
    out.limitMph = this.limitMph[slot] ?? 0;
    out.inJunction = out.s > this.graph.laneEnd(lane);
    out.shoulder = this.shoulder[slot] ?? 0;
    out.pull = this.pull[slot] ?? 0;
    return out;
  }

  // --- Traffic stops (design §7.2) -----------------------------------------------------------

  /** Registry id of the traffic-stop target, -1 when none. */
  get stopVehicleId(): number {
    return this.stopId;
  }

  /** Fills `out` with the stop target's state; null without one. */
  stopState(out: StopState): StopState | null {
    const slot = this.stopSlot();
    if (slot < 0) return null;
    const p = this.pull[slot];
    out.vehicleId = this.stopId;
    out.eid = this.stopEid;
    out.phase = p === PULL.stopped ? 'stopped' : p === PULL.merging ? 'merging' : 'pulling';
    out.x = this.x[slot] ?? 0;
    out.z = this.z[slot] ?? 0;
    out.yaw = this.yaw[slot] ?? 0;
    return out;
  }

  /** Lets the stop target go: it merges back into traffic and is no longer pinned. */
  releaseStop(): boolean {
    const slot = this.stopSlot();
    if (slot < 0) return false;
    this.endStop(slot, 'released');
    return true;
  }

  /** Ends the stop leaving the car parked at the curb with hazards (arrest); it despawns by distance. */
  abandonStop(): boolean {
    const slot = this.stopSlot();
    if (slot < 0) return false;
    this.endStop(slot, 'abandoned');
    return true;
  }

  /** Debug: makes the ambient car `vehicleId` the stop target at once; false when absent, crashed or a stop runs. */
  forceStop(vehicleId: number): boolean {
    if (this.stopId >= 0) return false;
    for (let slot = 0; slot < this.count; slot++) {
      if (this.vehicleId[slot] !== vehicleId) continue;
      if ((this.fleetIndex[slot] ?? -1) >= 0 || this.state[slot] === TRAFFIC_STATE.crashed) return false;
      this.beginStop(slot);
      return true;
    }
    return false;
  }

  // --- Fleet cars (design §7.4) ----------------------------------------------------------------

  /**
   * Puts fleet car `index` on the curb lane of the nearest road within 200 m of (x, z) (the next edges
   * near the point, in id order, when that spot is taken); returns its entity id, 0 when nothing fits.
   * An existing car with this index is removed first.
   */
  spawnFleetCar(index: number, x: number, z: number, look: FleetLook): number {
    if (!this.validFleetIndex(index) || !Number.isInteger(look.modelIndex) || look.modelIndex < 0 || look.modelIndex >= VEHICLE_MODELS.length) {
      return 0;
    }
    this.removeFleetCar(index);
    if (this.count >= this.slotCap) return 0;
    const g = this.graph;
    const hit = g.nearestEdge(x, z, FLEET_SNAP, this.hit);
    if (!hit) return 0;
    const hl = MODEL_HALF_LEN[look.modelIndex] ?? 2;
    let lane = this.fleetSpot(hit.edge, x, z, hl);
    if (lane < 0) {
      const near = g.edgesNear(x, z, FLEET_SNAP, this.nearEdges);
      for (let i = 0; i < near.length && lane < 0; i++) lane = this.fleetSpot(near[i] ?? 0, x, z, hl);
    }
    if (lane < 0) return 0;
    const slot = this.allocSlot(FLEET_ID_BASE + index, lane, this.spotS, 0, look.modelIndex, look.color >>> 0, 0);
    this.fleetIndex[slot] = index;
    this.pinned[slot] = 1;
    this.fleetEid[index] = this.eid[slot] ?? 0;
    this.resetFleet(index);
    this.chooseNextLane(slot);
    this.pose(slot);
    this.writeEcs(slot);
    copyTransformSlot(Transform, PrevTransform, this.eid[slot] ?? 0);
    return this.eid[slot] ?? 0;
  }

  removeFleetCar(index: number): void {
    const slot = this.fleetSlot(index);
    if (slot >= 0) this.despawnSlot(slot, false);
  }

  /** Entity id of fleet car `index`, 0 when absent. */
  fleetEntity(index: number): number {
    return this.fleetSlot(index) >= 0 ? (this.fleetEid[index] ?? 0) : 0;
  }

  /**
   * Sends fleet car `index` to the road point nearest (x, z) (within 300 m) at `urgency`; it parks at the
   * curb on arrival and emits 'traffic:fleetArrived'. False (nothing changed) when absent or unreachable.
   */
  setFleetDestination(index: number, x: number, z: number, urgency: FleetUrgency): boolean {
    const slot = this.fleetSlot(index);
    if (slot < 0) return false;
    const hit = this.graph.nearestEdge(x, z, DEST_SNAP, this.hit);
    if (!hit) return false;
    const prev = [this.destEdge[index] ?? -1, this.destS[index] ?? 0, this.destX[index] ?? 0, this.destZ[index] ?? 0] as const;
    this.destEdge[index] = hit.edge;
    this.destS[index] = hit.s;
    this.destX[index] = hit.x;
    this.destZ[index] = hit.z;
    if (!this.planRoute(index, slot)) {
      this.destEdge[index] = prev[0];
      this.destS[index] = prev[1];
      this.destX[index] = prev[2];
      this.destZ[index] = prev[3];
      return false;
    }
    this.urgency[index] = urgency === 'emergency' ? URGENCY.emergency : URGENCY.respond;
    this.arrived[index] = 0;
    this.leaveCurb(slot);
    // Not yet committed to the junction: take the route's exit.
    const lane = this.lane[slot] ?? 0;
    if ((this.s[slot] ?? 0) <= this.graph.laneEnd(lane) && (this.holding[slot] ?? -1) < 0) this.chooseNextLane(slot);
    return true;
  }

  /** Back to patrol: no destination, light bar off, leaves the curb and wanders. */
  setFleetPatrol(index: number): void {
    const slot = this.fleetSlot(index);
    if (slot < 0) return;
    this.resetFleet(index);
    this.leaveCurb(slot);
  }

  /** Fills `out` with fleet car `index`'s state; null when absent. */
  fleetState(index: number, out: FleetState): FleetState | null {
    const slot = this.fleetSlot(index);
    if (slot < 0) return null;
    out.eid = this.eid[slot] ?? 0;
    out.x = this.x[slot] ?? 0;
    out.z = this.z[slot] ?? 0;
    out.yaw = this.yaw[slot] ?? 0;
    out.speed = this.v[slot] ?? 0;
    out.edge = laneEdge(this.lane[slot] ?? 0);
    out.mode = URGENCY_MODE[this.urgency[index] ?? 0] ?? 'patrol';
    out.arrived = this.arrived[index] === 1;
    out.parked = this.pull[slot] === PULL.parked;
    out.routeLeftM = this.routeLeft(index, slot);
    return out;
  }

  snapshot(): TrafficSnapshot {
    const cars: TrafficCarSave[] = [];
    for (let i = 0; i < this.count; i++) {
      cars.push({
        vehicleId: this.vehicleId[i] ?? 0,
        lane: this.lane[i] ?? 0,
        s: this.s[i] ?? 0,
        speed: this.v[i] ?? 0,
        accel: this.accel[i] ?? 0,
        nextLane: this.nextLane[i] ?? -1,
        state: this.state[i] ?? 0,
        behavior: this.behavior[i] ?? 0,
        desiredFactor: this.desiredFactor[i] ?? 1,
        headway: this.headway[i] ?? 1,
        weaveAmp: this.weaveAmp[i] ?? 0,
        weavePeriod: this.weavePeriod[i] ?? 1,
        weavePhase: this.weavePhase[i] ?? 0,
        stopPhase: this.stopPhase[i] ?? 0,
        stopTimer: this.stopTimer[i] ?? 0,
        holding: this.holding[i] ?? -1,
        reported: this.reported[i] ?? 0,
        flags: this.flags[i] ?? 0,
      });
      const car = cars[cars.length - 1] as TrafficCarSave;
      if (this.pull[i] !== PULL.none) car.pull = this.pull[i] ?? 0;
      if (this.shoulder[i] !== 0) car.shoulder = this.shoulder[i] ?? 0;
      if (this.pullTimer[i] !== 0) car.pullTimer = this.pullTimer[i] ?? 0;
      if (this.pinned[i] !== 0) car.pinned = this.pinned[i] ?? 0;
      const f = this.fleetIndex[i] ?? -1;
      if (f >= 0) this.saveFleet(f, i, car);
    }
    const st = this.rng.state();
    const snap: TrafficSnapshot = { version: 1, rng: { seed: st.seed, s: [st.s[0], st.s[1], st.s[2], st.s[3]] }, spawnSeq: this.spawnSeq, cars };
    if (this.stopId >= 0) snap.stopVehicleId = this.stopId;
    if (this.stopCandidate >= 0) {
      snap.stopCandidate = this.stopCandidate;
      snap.stopTimer = this.stopDelay;
    }
    return snap;
  }

  /** Replaces every car with the snapshot's; the next `step` continues exactly as the saved session. */
  restore(snapshot: TrafficSnapshot): void {
    this.removeAll(false);
    this.rng.restore(snapshot.rng);
    this.spawnSeq = snapshot.spawnSeq;
    const edges = this.graph.edges.length;
    for (const c of snapshot.cars) {
      if (this.count >= this.slotCap) break;
      const e = laneEdge(c.lane);
      if (e >= edges || this.graph.laneCount(e, laneDir(c.lane)) <= laneIndex(c.lane)) continue;
      let slot: number;
      if (isFleetVehicleId(c.vehicleId)) {
        const index = c.vehicleId - FLEET_ID_BASE;
        const model = c.model ?? 0;
        if (!this.validFleetIndex(index) || this.fleetSlot(index) >= 0 || !Number.isInteger(model) || model < 0 || model >= VEHICLE_MODELS.length) continue;
        slot = this.allocSlot(c.vehicleId, c.lane, c.s, c.speed, model, (c.color ?? 0) >>> 0, 0);
        this.fleetIndex[slot] = index;
        this.fleetEid[index] = this.eid[slot] ?? 0;
        this.restoreFleet(index, c);
      } else {
        if (this.ambientCount >= this.capacity) continue;
        if (c.vehicleId < 0 || c.vehicleId >= REGISTRY_POPULATION || this.onRoad[c.vehicleId] === 1) continue;
        // Older saves (Phase 1) may hold cars kept off the road now (their own plates reported stolen).
        if (!canBeOnRoad(this.seed, c.vehicleId)) continue;
        slot = this.createEntity(c.vehicleId, c.lane, c.s, c.speed);
      }
      const pull = c.pull ?? PULL.none;
      this.pull[slot] = Number.isInteger(pull) && pull >= PULL.none && pull <= PULL.parked ? pull : PULL.none;
      this.shoulder[slot] = c.shoulder ?? 0;
      this.pullTimer[slot] = c.pullTimer ?? 0;
      this.pinned[slot] = (c.pinned ?? 0) !== 0 || isFleetVehicleId(c.vehicleId) ? 1 : 0;
      this.accel[slot] = c.accel;
      this.state[slot] = c.state;
      this.behavior[slot] = c.behavior;
      this.desiredFactor[slot] = c.desiredFactor;
      this.headway[slot] = c.headway;
      this.weaveAmp[slot] = c.weaveAmp;
      this.weavePeriod[slot] = c.weavePeriod;
      this.weavePhase[slot] = c.weavePhase;
      this.stopPhase[slot] = c.stopPhase;
      this.stopTimer[slot] = c.stopTimer;
      this.reported[slot] = c.reported;
      this.flags[slot] = c.flags;
      if (c.nextLane >= 0 && laneEdge(c.nextLane) < edges) this.setNextLane(slot, c.nextLane, this.turnOf(c.lane, c.nextLane));
      if (c.holding >= 0 && c.holding < this.nodeHold.length) this.acquireHold(slot, c.holding);
      this.updateAside(slot);
      this.pose(slot);
      this.writeEcs(slot);
      copyTransformSlot(Transform, PrevTransform, this.eid[slot] ?? 0);
    }
    this.sortOrder();
    const stopId = snapshot.stopVehicleId ?? -1;
    for (let slot = 0; slot < this.count && stopId >= 0; slot++) {
      if (this.vehicleId[slot] !== stopId || (this.fleetIndex[slot] ?? -1) >= 0) continue;
      this.stopId = stopId;
      this.stopEid = this.eid[slot] ?? 0;
    }
    this.stopCandidate = snapshot.stopCandidate ?? -1;
    this.stopDelay = this.stopCandidate >= 0 ? (snapshot.stopTimer ?? 0) : 0;
    this.stats.active = this.count;
  }

  /**
   * Removes every ambient car (entities and proxies); fleet cars stay (they go with `removeFleetCar`,
   * `restore` and `dispose`). With `emit` each car gets its 'traffic:despawned' (teleport, `traffic clear`),
   * so listeners tracking cars stay in step, and a stop target ends with 'traffic:released' { reason: 'lost' }.
   */
  clear(emit = false): void {
    for (let slot = this.count - 1; slot >= 0; slot--) if ((this.fleetIndex[slot] ?? -1) < 0) this.despawnSlot(slot, emit);
    // Junction holds of the remaining (fleet) cars, recounted from scratch.
    this.nodeHold.fill(0);
    this.minorHold.fill(0);
    this.signalHold.fill(0);
    for (let slot = 0; slot < this.count; slot++) {
      const node = this.holding[slot] ?? -1;
      if (node >= 0) this.countHold(slot, node, 1);
    }
    this.stopCandidate = -1;
    this.stopDelay = 0;
    this.stats.active = this.count;
  }

  dispose(): void {
    this.removeAll(false);
    this.unsubscribe();
  }

  /** Removes every car, fleet cars included. */
  private removeAll(emit: boolean): void {
    while (this.count > 0) this.despawnSlot(this.count - 1, emit);
    this.nodeHold.fill(0);
    this.minorHold.fill(0);
    this.signalHold.fill(0);
    this.stopId = -1;
    this.stopEid = 0;
    this.stopCandidate = -1;
    this.stopDelay = 0;
    this.stats.active = 0;
    this.stats.proxies = 0;
  }

  // --- Setup ------------------------------------------------------------------------------

  private classifyApproach(e: number, d: 0 | 1): void {
    const g = this.graph;
    const a = e * 2 + d;
    if (g.laneCount(e, d) === 0) return;
    const edge = g.edges[e] as RoadEdge;
    const node = g.nodes[d === 0 ? edge.to : edge.from] as RoadNode;
    this.group[a] = g.approachGroup(e, d);
    if (node.junction === JUNCTION.signal && node.signal >= 0) this.control[a] = CONTROL.signal;
    else if (node.junction !== JUNCTION.none) {
      // Same rule as the stop/yield signs in chunkLayout.
      const stops = g.stopsAt(e, node.id);
      const yieldOnly = edge.roadClass === ROAD_CLASS.service || edge.roadClass === ROAD_CLASS.gravel;
      this.control[a] = stops ? (yieldOnly ? CONTROL.yield : CONTROL.stop) : CONTROL.none;
    }
    for (const c of g.connections(e, d)) {
      const back: 0 | 1 = c.dir === 0 ? 1 : 0;
      if (c.turn === TURN.straight && g.laneCount(c.edge, back) > 0) this.oncoming[a] = c.edge * 2 + back;
    }
  }

  // --- Density ------------------------------------------------------------------------------

  private targetCount(focus: TrafficFocus, time: ZoneTime): number {
    let district: number;
    if (this.city) district = this.city.districtAt(focus.x, focus.z);
    else {
      const hit = this.graph.nearestEdge(focus.x, focus.z, 1000, this.hit);
      district = hit ? (this.graph.edges[hit.edge] as RoadEdge).district : 0;
    }
    const hour = Math.floor(time.hour) % 24;
    const target = DENSITY.baseActive * (DENSITY.district[district] ?? 1) * (DENSITY.hourMultiplier[hour] ?? 1) * this.densityScale;
    return Math.max(0, Math.min(this.capacity, Math.round(target)));
  }

  private tick(focus: TrafficFocus, time: ZoneTime): void {
    const despawnR2 = DENSITY.radii.despawn * DENSITY.radii.despawn;
    const crashedR2 = CRASHED_DESPAWN * CRASHED_DESPAWN;
    for (let slot = this.count - 1; slot >= 0; slot--) {
      if (this.pinned[slot] === 1) continue;
      const dx = (this.x[slot] ?? 0) - focus.x;
      const dz = (this.z[slot] ?? 0) - focus.z;
      const limit = this.state[slot] === TRAFFIC_STATE.crashed ? crashedR2 : despawnR2;
      if (dx * dx + dz * dz > limit) this.despawnSlot(slot, true);
    }
    const target = this.targetCount(focus, time);
    const { spawnMin, spawnMax } = DENSITY.radii;
    let spawned = 0;
    for (let attempt = 0; attempt < DENSITY.spawnPerTick * 8; attempt++) {
      if (this.ambientCount >= target || spawned >= DENSITY.spawnPerTick) break;
      if (this.trySpawnRandom(focus, time, spawnMin, spawnMax)) spawned++;
    }
  }

  /** Samples a point in the ring, snaps it to a lane and spawns there if it is free. */
  private trySpawnRandom(focus: TrafficFocus, time: ZoneTime, rMin: number, rMax: number): boolean {
    if (this.ambientCount >= this.capacity || this.count >= this.slotCap) return false;
    const rng = this.rng;
    const angle = rng.next() * TWO_PI;
    const r = Math.sqrt(rng.nextFloat(rMin * rMin, rMax * rMax));
    const hit = this.graph.nearestEdge(focus.x + Math.cos(angle) * r, focus.z + Math.sin(angle) * r, SPAWN_SNAP, this.hit);
    if (!hit) return false;
    const e = this.graph.edges[hit.edge] as RoadEdge;
    const dir: 0 | 1 = e.lanesBackward > 0 && rng.next() < 0.5 ? 1 : 0;
    const lane = laneRef(e.id, dir, rng.nextInt(0, this.graph.laneCount(e.id, dir) - 1));
    const s = dir === 0 ? hit.s : e.length - hit.s;
    if (s < this.graph.laneStart(lane) + MAX_HALF_LEN + 1 || s > this.graph.laneEnd(lane) - MAX_HALF_LEN - 10) return false;
    const p = this.graph.lanePoint(lane, s, this.lp);
    const d2 = (p.x - focus.x) * (p.x - focus.x) + (p.z - focus.z) * (p.z - focus.z);
    if (d2 < rMin * rMin || d2 > rMax * rMax || d2 < NEVER_WITHIN * NEVER_WITHIN) return false;
    // Nearest car ahead on the lane: bumper gap and speed.
    let gapAhead = Infinity;
    let vAhead = 0;
    for (let k = this.lowerBound(lane); k < this.count; k++) {
      const o = this.order[k] ?? 0;
      if (this.lane[o] !== lane) break;
      const so = this.s[o] ?? 0;
      if (Math.abs(so - s) < SPAWN_SPACING) return false;
      if (so > s && so - s - MAX_HALF_LEN - (MODEL_HALF_LEN[this.model[o] ?? 0] ?? 0) < gapAhead) {
        gapAhead = so - s - MAX_HALF_LEN - (MODEL_HALF_LEN[this.model[o] ?? 0] ?? 0);
        vAhead = this.v[o] ?? 0;
      }
    }
    const id = this.nextVehicleId();
    if (id < 0) return false;
    // Slow enough to stop comfortably at the stop line ahead, and behind the car ahead.
    const toLine = this.graph.laneEnd(lane) - s - MAX_HALF_LEN;
    let speed = Math.min(this.graph.effectiveSpeedLimitMph(e.id, time) * MPH * 0.8, Math.sqrt(3 * toLine));
    if (gapAhead < Infinity) speed = Math.min(speed, vAhead + Math.sqrt(2 * MIN_COMFORT_DECEL * Math.max(0, gapAhead - IDM_S0)));
    const slot = this.spawnCar(id, lane, s, speed, time, undefined);
    this.pose(slot);
    this.writeEcs(slot);
    copyTransformSlot(Transform, PrevTransform, this.eid[slot] ?? 0);
    return true;
  }

  /**
   * Next registry id from the coprime-stride walk, skipping ids already on the road and
   * registrations kept off it (`canBeOnRoad`: plates reported stolen); -1 if all are.
   */
  private nextVehicleId(): number {
    const pop = REGISTRY_POPULATION;
    for (let tries = 0; tries < pop; tries++) {
      const id = ((this.spawnSeq % pop) * REGISTRY_STRIDE + this.registryOffset) % pop;
      this.spawnSeq++;
      if (this.onRoad[id] !== 1 && canBeOnRoad(this.seed, id)) return id;
    }
    return -1;
  }

  /** Creates the entity and rolls the trip (behaviours from the record's tendencies). */
  private spawnCar(id: number, lane: number, s: number, speed: number, time: ZoneTime, behavior: number | undefined): number {
    const slot = this.createEntity(id, lane, s, speed);
    const rng = this.rng;
    const t = vehicleRecord(this.seed, id).tendencies;
    const b = VIOLATIONS.behaviors;
    let bits = 0;
    if (behavior === undefined) {
      if (t.speeding) bits |= BEHAVIOR.speeding;
      if (t.tailgating) bits |= BEHAVIOR.tailgating;
      if (t.redLight) bits |= BEHAVIOR.redLight;
      if (t.rollingStop) bits |= BEHAVIOR.rollingStop;
      const hour = Math.floor(time.hour) % 24;
      if (rng.chance(t.duiRisk * (b.dui.hourMultiplier[hour] ?? 1))) bits |= BEHAVIOR.dui;
    } else bits = behavior;
    this.behavior[slot] = bits;
    const factor = bits & BEHAVIOR.speeding ? b.speeding.speedFactor : NORMAL_FACTOR;
    this.desiredFactor[slot] = rng.nextFloat(factor[0], factor[1]);
    const headway = bits & BEHAVIOR.tailgating ? b.tailgating.headwayS : NORMAL_HEADWAY;
    this.headway[slot] = rng.nextFloat(headway[0], headway[1]);
    if (bits & BEHAVIOR.dui) {
      this.weaveAmp[slot] = rng.nextFloat(b.dui.weaveAmplitude[0], b.dui.weaveAmplitude[1]);
      this.weavePeriod[slot] = rng.nextFloat(b.dui.weavePeriodS[0], b.dui.weavePeriodS[1]);
      this.weavePhase[slot] = rng.next() * TWO_PI;
    }
    this.chooseNextLane(slot);
    this.stats.spawned++;
    this.bus?.emit('traffic:spawned', { eid: this.eid[slot] ?? 0, vehicleId: id });
    return slot;
  }

  /** Allocates a slot and its ECS entity with the record's look; trip fields are reset. */
  private createEntity(id: number, lane: number, s: number, speed: number): number {
    const record = vehicleRecord(this.seed, id);
    const slot = this.allocSlot(id, lane, s, speed, record.modelIndex, record.color, record.faults);
    this.onRoad[id] = 1;
    this.ambientCount++;
    return slot;
  }

  /** Allocates a slot and its ECS entity with an explicit look (ambient cars via `createEntity`, fleet cars). */
  private allocSlot(id: number, lane: number, s: number, speed: number, model: number, color: number, faults: number): number {
    const slot = this.count++;
    for (const a of this.slotArrays) a[slot] = 0;
    const eid = spawn(this.world, Transform, PrevTransform);
    EntityKind.kind[eid] = KIND.Vehicle;
    attachVehicleLook(this.world, eid, model, color, faults);
    attachTrafficCar(this.world, eid, slot);
    this.eid[slot] = eid;
    this.vehicleId[slot] = id;
    this.model[slot] = model;
    this.fleetIndex[slot] = -1;
    this.lane[slot] = lane;
    this.s[slot] = s;
    this.v[slot] = speed;
    // The view speed is right from the start (a restored or spawned car reads its speed before its first step).
    this.speedView[slot] = speed;
    this.nextLane[slot] = -1;
    this.holding[slot] = -1;
    this.desiredFactor[slot] = 1;
    this.headway[slot] = NORMAL_HEADWAY[0];
    this.weavePeriod[slot] = 1;
    this.proxy[slot] = null;
    this.insertOrder(slot);
    return slot;
  }

  private despawnSlot(slot: number, emit: boolean): void {
    const eid = this.eid[slot] ?? 0;
    const id = this.vehicleId[slot] ?? 0;
    const fleet = this.fleetIndex[slot] ?? -1;
    this.releaseHold(slot);
    if (this.proxy[slot]) {
      this.physics.removeBody(eid);
      this.proxy[slot] = null;
      this.stats.proxies--;
    }
    if (fleet >= 0) {
      this.fleetEid[fleet] = 0;
      this.resetFleet(fleet);
    } else {
      this.onRoad[id] = 0;
      this.ambientCount--;
    }
    if (this.stopId >= 0 && eid === this.stopEid) {
      this.stopId = -1;
      this.stopEid = 0;
      if (emit) this.bus?.emit('traffic:released', { eid, vehicleId: id, reason: 'lost' });
    }
    TrafficCar.slot[eid] = -1;
    despawn(this.world, eid);
    // Remove from the sorted order, then move the last slot into the hole.
    const n = this.count;
    let k = 0;
    while (k < n && this.order[k] !== slot) k++;
    this.order.copyWithin(k, k + 1, n);
    const last = n - 1;
    if (slot !== last) {
      for (const a of this.slotArrays) a[slot] = a[last] ?? 0;
      this.proxy[slot] = this.proxy[last] ?? null;
      TrafficCar.slot[this.eid[slot] ?? 0] = slot;
      for (let j = 0; j < last; j++) if (this.order[j] === last) this.order[j] = slot;
    }
    this.proxy[last] = null;
    this.count = last;
    if (!emit || fleet >= 0) return;
    this.stats.despawned++;
    this.bus?.emit('traffic:despawned', { eid, vehicleId: id });
  }

  // --- Ordering -----------------------------------------------------------------------------

  private before(a: number, b: number): boolean {
    const la = this.lane[a] ?? 0, lb = this.lane[b] ?? 0;
    if (la !== lb) return la < lb;
    const sa = this.s[a] ?? 0, sb = this.s[b] ?? 0;
    if (sa !== sb) return sa < sb;
    return a < b;
  }

  private sortOrder(): void {
    const order = this.order;
    for (let i = 1; i < this.count; i++) {
      const o = order[i] ?? 0;
      let j = i - 1;
      while (j >= 0 && this.before(o, order[j] ?? 0)) {
        order[j + 1] = order[j] ?? 0;
        j--;
      }
      order[j + 1] = o;
    }
  }

  /** Inserts the newest slot (count - 1) at its sorted position. */
  private insertOrder(slot: number): void {
    let j = this.count - 2;
    while (j >= 0 && this.before(slot, this.order[j] ?? 0)) {
      this.order[j + 1] = this.order[j] ?? 0;
      j--;
    }
    this.order[j + 1] = slot;
  }

  /** First order index whose lane is >= `lane`. */
  private lowerBound(lane: number): number {
    let lo = 0, hi = this.count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((this.lane[this.order[mid] ?? 0] ?? 0) < lane) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Slot of the car furthest along `lane` (including one crossing the junction after it), or -1.
   * Cars parked clear of the lane (pulled over, yielding) are skipped: traffic passes them.
   */
  private frontCar(lane: number): number {
    for (let k = this.lowerBound(lane + 1) - 1; k >= 0; k--) {
      const o = this.order[k] ?? 0;
      if (this.lane[o] !== lane) return -1;
      if (this.aside[o] !== 1) return o;
    }
    return -1;
  }

  /** True when leader `o` stands clear of the lane far enough to the side for `slot` to pass it. */
  private passable(slot: number, o: number): boolean {
    if (this.aside[o] !== 1) return false;
    // A car on its way to the curb is judged where it is heading: it must stop behind a car there.
    const pull = this.pull[slot];
    const own = this.shoulder[slot] ?? 0;
    const mine = pull === PULL.pulling || pull === PULL.parking ? Math.max(own, this.curbTarget(slot)) : own;
    const lateral = Math.abs(mine - (this.shoulder[o] ?? 0));
    return lateral >= (MODEL_HALF_WID[this.model[slot] ?? 0] ?? 1) + (MODEL_HALF_WID[this.model[o] ?? 0] ?? 1) + 0.1;
  }

  // --- Lanes and junctions --------------------------------------------------------------------

  private turnOf(lane: number, next: number): number {
    for (const c of this.graph.connections(laneEdge(lane), laneDir(lane))) {
      if (c.edge === laneEdge(next) && c.dir === laneDir(next)) return c.turn;
    }
    return TURN.straight;
  }

  /**
   * Seeded choice among the exits (U-turn only at dead ends). Each exit is taken from one source lane only:
   * right turns from the curb lane into the curb lane, left turns from the inner lane into the inner lane,
   * straight on from lane i into lane i. So two cars side by side never share a connector's target lane.
   * A lane with no such exit keeps its index on any exit that has that lane; only a true lane drop shares
   * a target lane with a sibling lane, and its cars then merge behind the sibling's (`CAR_FLAG.merge`).
   */
  private chooseNextLane(slot: number): void {
    const f = this.fleetIndex[slot] ?? -1;
    if (f >= 0 && (this.routeLen[f] ?? 0) > 0 && this.followRoute(f, slot)) return;
    const lane = this.lane[slot] ?? 0;
    const edge = laneEdge(lane), dir = laneDir(lane);
    const g = this.graph;
    const conns = g.connections(edge, dir);
    const index = laneIndex(lane);
    const inner = g.laneCount(edge, dir) - 1;
    // Mode 0: exits that fit this lane; 1: any exit but a U-turn that has lane `index` (kept);
    // 2: any exit but a U-turn (lane drop); 3: anything (dead end).
    let mode = 0;
    let options = 0;
    for (const c of conns) if (this.exitAllowed(0, index, inner, c)) options++;
    while (options === 0 && mode < 3) {
      mode++;
      for (const c of conns) if (this.exitAllowed(mode, index, inner, c)) options++;
    }
    this.flags[slot] = (this.flags[slot] ?? 0) & ~CAR_FLAG.merge;
    if (options === 0) {
      this.nextLane[slot] = -1;
      this.clen[slot] = 0;
      return;
    }
    let pick = options > 1 ? this.rng.nextInt(0, options - 1) : 0;
    for (const c of conns) {
      if (!this.exitAllowed(mode, index, inner, c)) continue;
      if (pick-- > 0) continue;
      const count = g.laneCount(c.edge, c.dir);
      let idx = c.turn === TURN.right ? 0 : c.turn === TURN.left ? count - 1 : Math.min(index, count - 1);
      if (mode === 1) idx = index;
      else if (mode >= 2 && inner > 0) this.flags[slot] = (this.flags[slot] ?? 0) | CAR_FLAG.merge;
      this.setNextLane(slot, laneRef(c.edge, c.dir, idx), c.turn);
      return;
    }
  }

  /** Whether exit `c` is a choice for lane `index` in `chooseNextLane`'s `mode`. */
  private exitAllowed(mode: number, index: number, inner: number, c: LaneConnection): boolean {
    if (mode === 3) return true;
    if (c.turn === TURN.uturn) return false;
    if (mode === 0) return this.fitsLane(index, inner, c);
    return mode === 2 || index < this.graph.laneCount(c.edge, c.dir);
  }

  /** True when lane `index` (of `inner` + 1) may take exit `c` (see `chooseNextLane`). */
  private fitsLane(index: number, inner: number, c: LaneConnection): boolean {
    if (c.turn === TURN.right) return index === 0;
    if (c.turn === TURN.left) return index === inner;
    return index < this.graph.laneCount(c.edge, c.dir);
  }

  /** Sets the next lane and builds the quadratic Bezier connector across the junction. */
  private setNextLane(slot: number, next: number, turn: number): void {
    const g = this.graph;
    const lane = this.lane[slot] ?? 0;
    this.nextLane[slot] = next;
    this.turn[slot] = turn;
    const p0 = g.lanePoint(lane, g.laneEnd(lane), this.lp);
    const p2 = g.lanePoint(next, g.laneStart(next), this.lp2);
    const dx = p2.x - p0.x, dz = p2.z - p0.z;
    const det = p0.hx * p2.hz - p2.hx * p0.hz;
    let cx = (p0.x + p2.x) / 2, cz = (p0.z + p2.z) / 2;
    if (Math.abs(det) > 1e-3) {
      // p0 + a h0 = p2 - b h2: the lane lines' intersection.
      const a = (dx * p2.hz - p2.hx * dz) / det;
      if (a > 0) {
        cx = p0.x + p0.hx * a;
        cz = p0.z + p0.hz * a;
      }
    } else if (p0.hx * p2.hx + p0.hz * p2.hz < 0) {
      // U-turn: pull the control point ahead so the curve loops round.
      const d = Math.hypot(dx, dz);
      cx += p0.hx * d;
      cz += p0.hz * d;
    }
    this.c0x[slot] = p0.x;
    this.c0z[slot] = p0.z;
    this.c1x[slot] = cx;
    this.c1z[slot] = cz;
    this.c2x[slot] = p2.x;
    this.c2z[slot] = p2.z;
    let len = 0, px = p0.x, pz = p0.z;
    for (let i = 1; i <= 8; i++) {
      const t = i / 8, u = 1 - t;
      const qx = u * u * p0.x + 2 * u * t * cx + t * t * p2.x;
      const qz = u * u * p0.z + 2 * u * t * cz + t * t * p2.z;
      len += Math.hypot(qx - px, qz - pz);
      px = qx;
      pz = qz;
    }
    this.clen[slot] = len;
  }

  private acquireHold(slot: number, node: number): void {
    if ((this.holding[slot] ?? -1) >= 0) return;
    this.holding[slot] = node;
    this.countHold(slot, node, 1);
  }

  /** Holds are released before the car moves onto its next lane, so the approach is the one it held from. */
  private releaseHold(slot: number): void {
    const node = this.holding[slot] ?? -1;
    if (node < 0) return;
    this.countHold(slot, node, -1);
    this.holding[slot] = -1;
  }

  /** Adds `delta` to the node's hold counts for the car's current approach (total, minor road, signal group). */
  private countHold(slot: number, node: number, delta: number): void {
    this.nodeHold[node] = (this.nodeHold[node] ?? 0) + delta;
    const lane = this.lane[slot] ?? 0;
    const a = laneEdge(lane) * 2 + laneDir(lane);
    const ctrl = this.control[a];
    if (ctrl === CONTROL.stop || ctrl === CONTROL.yield) this.minorHold[node] = (this.minorHold[node] ?? 0) + delta;
    else if (ctrl === CONTROL.signal) {
      const k = node * 2 + (this.group[a] ?? 0);
      this.signalHold[k] = (this.signalHold[k] ?? 0) + delta;
    }
  }

  /**
   * True when the next lane has no room for this car right after the junction, or a car from another
   * lane is already crossing the junction into it (it only moves onto that lane once clear of the box).
   */
  private exitBlocked(slot: number): boolean {
    const next = this.nextLane[slot] ?? -1;
    if (next < 0) return false;
    const g = this.graph;
    const node = g.nodes[g.laneEndNode(this.lane[slot] ?? 0)] as RoadNode;
    for (let i = 0; i < node.edges.length; i++) {
      const id = node.edges[i] ?? 0;
      const d = (g.edges[id] as RoadEdge).to === node.id ? 0 : 1;
      for (let l = 0; l < g.laneCount(id, d); l++) {
        const lane = laneRef(id, d, l);
        const o = this.frontCar(lane);
        if (o >= 0 && o !== slot && this.nextLane[o] === next && (this.s[o] ?? 0) > g.laneEnd(lane)) return true;
      }
    }
    let k = this.lowerBound(next);
    while (k < this.count && this.lane[this.order[k] ?? 0] === next && this.aside[this.order[k] ?? 0] === 1) k++;
    const o = this.order[k] ?? 0;
    if (k >= this.count || this.lane[o] !== next) return false;
    const room = (this.s[o] ?? 0) - g.laneStart(next) - (MODEL_HALF_LEN[this.model[o] ?? 0] ?? 0);
    return room < 2 * (MODEL_HALF_LEN[this.model[slot] ?? 0] ?? 0) + IDM_S0 + 1;
  }

  /**
   * True when a car on approach `a` is about to cross: moving and within `distance` of its line or
   * `gapS` seconds of it at its speed (fast cars count from further out), or already crossing.
   */
  private approachBusy(a: number, distance: number, gapS: number): boolean {
    const e = a >> 1;
    const d = (a & 1) as 0 | 1;
    const g = this.graph;
    for (let i = 0; i < g.laneCount(e, d); i++) {
      const lane = laneRef(e, d, i);
      const o = this.frontCar(lane);
      if (o < 0 || this.state[o] === TRAFFIC_STATE.crashed) continue;
      const toLine = g.laneEnd(lane) - (this.s[o] ?? 0);
      const v = this.v[o] ?? 0;
      if (toLine < 0 || (toLine < Math.max(distance, v * gapS) && v > 1)) return true;
    }
    return false;
  }

  /** Gap (s) a car needs to pull away from its line and clear the box: at least GAP_S, longer for slow, long vehicles. */
  private gapFor(slot: number): number {
    const m = this.model[slot] ?? 0;
    const travel = (this.clen[slot] ?? 0) + 2 * (MODEL_HALF_LEN[m] ?? 2);
    return Math.max(GAP_S, Math.sqrt((2 * travel) / (MODEL_A_MAX[m] ?? 2)) + 1);
  }

  /**
   * True when a left-turner from the oncoming approach has committed to its turn (released from its
   * hold, or past its line) and is still crossing: through and right-turning cars wait for it.
   */
  private oncomingTurnerCrossing(a: number, node: number): boolean {
    const opp = this.oncoming[a] ?? -1;
    if (opp < 0) return false;
    const e = opp >> 1;
    const d = (opp & 1) as 0 | 1;
    const g = this.graph;
    for (let i = 0; i < g.laneCount(e, d); i++) {
      const lane = laneRef(e, d, i);
      const o = this.frontCar(lane);
      if (o < 0 || this.holding[o] !== node || this.turn[o] !== TURN.left) continue;
      if (this.stopPhase[o] === STOP_PHASE.cleared || (this.s[o] ?? 0) > g.laneEnd(lane)) return true;
    }
    return false;
  }

  /** Minor-road gap acceptance: no car on an approach that does not stop is close to the node. */
  private majorRoadClear(node: RoadNode, ownApproach: number, gapS: number): boolean {
    for (let i = 0; i < node.edges.length; i++) {
      const id = node.edges[i] ?? 0;
      const e = this.graph.edges[id] as RoadEdge;
      const a = id * 2 + (e.to === node.id ? 0 : 1);
      if (a === ownApproach || this.control[a] !== CONTROL.none) continue;
      if (this.approachBusy(a, MAJOR_CLEAR_DISTANCE, gapS)) return false;
    }
    return true;
  }

  /**
   * Junction control at the end of the lane: true when the car must treat the stop line as a
   * stopped obstacle this step. `d` = bumper distance to the stop line.
   */
  private mustStop(slot: number, d: number, dt: number, focus: TrafficFocus): boolean {
    const phase = this.stopPhase[slot] ?? 0;
    if (phase === STOP_PHASE.cleared) return false;
    const g = this.graph;
    const lane = this.lane[slot] ?? 0;
    const edge = laneEdge(lane);
    const a = edge * 2 + laneDir(lane);
    const ctrl = this.control[a] ?? 0;
    const node = g.nodes[g.laneEndNode(lane)] as RoadNode;
    const f = this.fleetIndex[slot] ?? -1;
    if (f >= 0 && this.urgency[f] === URGENCY.emergency && this.againstControl(a, node)) return this.emergencyGate(slot, a, d, node);
    if (ctrl === CONTROL.none) {
      // Major road through a junction: no stop, but left turns yield to oncoming cars, nobody enters
      // the box behind a full exit (that would block the cross traffic), as on a green, and nobody
      // enters while a minor-road car that has cleared its stop line is crossing.
      if (node.junction === JUNCTION.none || d > NEAR_LINE) return false;
      if ((this.minorHold[node.id] ?? 0) > 0) return true;
      if (this.turn[slot] === TURN.left) {
        const opp = this.oncoming[a] ?? -1;
        if (opp >= 0 && this.approachBusy(opp, LEFT_YIELD_DISTANCE, this.gapFor(slot))) return true;
      } else if (this.oncomingTurnerCrossing(a, node.id)) return true;
      return this.exitBlocked(slot);
    }
    const v = this.v[slot] ?? 0;
    const bits = this.behavior[slot] ?? 0;
    const b = MODEL_B[this.model[slot] ?? 0] ?? 2;

    if (ctrl === CONTROL.signal) {
      const grp = (this.group[a] ?? 0) as 0 | 1;
      const opp = this.oncoming[a] ?? -1;
      // A left-turner that took the junction on green (waiting at the line for oncoming traffic) finishes
      // its turn on any aspect once the oncoming side stops; the cross traffic waits for it.
      if (this.holding[slot] === node.id) {
        if ((opp >= 0 && this.approachBusy(opp, LEFT_YIELD_DISTANCE, this.gapFor(slot))) || this.exitBlocked(slot)) return true;
        this.stopPhase[slot] = STOP_PHASE.cleared;
        return false;
      }
      const aspect = g.signalAspect(node.signal, grp, this.simTime);
      if (aspect === ASPECT.green) {
        if (d > NEAR_LINE) return false;
        // Cars of the other phase still in the junction (late on yellow, a left-turner finishing) go first.
        if ((this.signalHold[node.id * 2 + 1 - grp] ?? 0) > 0) return true;
        if (this.turn[slot] === TURN.left) {
          if (opp >= 0 && this.approachBusy(opp, LEFT_YIELD_DISTANCE, this.gapFor(slot))) {
            if (d < STOP_ZONE) this.acquireHold(slot, node.id);
            return true;
          }
        } else if (this.oncomingTurnerCrossing(a, node.id)) return true;
        return this.exitBlocked(slot);
      }
      const runner = (bits & BEHAVIOR.redLight) !== 0;
      const lateRed = VIOLATIONS.behaviors.redLight.lateRedS;
      if (aspect === ASPECT.yellow) {
        const eta = d / Math.max(v, 0.1);
        if (runner && eta < g.signalTimeToChange(node.signal, grp, this.simTime) + lateRed) {
          this.stopPhase[slot] = STOP_PHASE.cleared;
          return false;
        }
        if (v * v > 2 * b * Math.max(d, 0)) {
          // Cannot stop comfortably: commit if the centre crosses the line before red (a turner slows to
          // TURN_SPEED first) or even the hardest braking cannot stop it; otherwise brake hard.
          const m = this.model[slot] ?? 0;
          const turn = this.turn[slot];
          const vLine = turn === TURN.straight ? v : Math.min(v, turn === TURN.uturn ? UTURN_SPEED : TURN_SPEED);
          const eta = (d + (MODEL_HALF_LEN[m] ?? 2)) / Math.max((v + vLine) / 2, 0.1);
          if (eta <= g.signalTimeToChange(node.signal, grp, this.simTime) || v * v > 2 * (MODEL_MAX_DECEL[m] ?? 6) * Math.max(d, 0)) {
            this.stopPhase[slot] = STOP_PHASE.cleared;
            return false;
          }
        }
        return true;
      }
      // Red: runners continue through a fresh red they reach within a couple of seconds.
      if (runner && v > 3 && d / v < 2 && g.signalAspect(node.signal, grp, this.simTime - lateRed) !== ASPECT.red) {
        this.stopPhase[slot] = STOP_PHASE.cleared;
        return false;
      }
      return true;
    }

    // Stop or yield sign.
    if (d > STOP_ZONE) return true;
    if (v < 0.1) this.flags[slot] = (this.flags[slot] ?? 0) | CAR_FLAG.fullStop;
    if (phase === STOP_PHASE.approach) {
      const rolling = ctrl === CONTROL.yield || (bits & BEHAVIOR.rollingStop) !== 0;
      if (v < 0.1) {
        this.stopPhase[slot] = STOP_PHASE.waiting;
        this.stopTimer[slot] = 0;
      } else if (rolling && v <= ROLLING_STOP_SPEED + 0.5) {
        // Rolling stoppers and yield approaches skip the wait.
        this.stopPhase[slot] = STOP_PHASE.waiting;
        this.stopTimer[slot] = STOP_WAIT_S;
      } else return true;
    }
    this.stopTimer[slot] = (this.stopTimer[slot] ?? 0) + dt;
    if ((this.stopTimer[slot] ?? 0) < STOP_WAIT_S) return true;
    if ((this.nodeHold[node.id] ?? 0) > 0 || this.exitBlocked(slot) || !this.majorRoadClear(node, a, this.gapFor(slot))) return true;
    this.stopPhase[slot] = STOP_PHASE.cleared;
    this.acquireHold(slot, node.id);
    if (ctrl === CONTROL.stop && ((this.flags[slot] ?? 0) & CAR_FLAG.fullStop) === 0) this.report(slot, 'rollingStop', focus);
    return false;
  }

  // --- Step passes ----------------------------------------------------------------------------

  /** Pass 1: IDM acceleration from the sorted (old) state; junction gates and violations. */
  private computeAccel(slot: number, k: number, dt: number, time: ZoneTime, focus: TrafficFocus): void {
    const st = this.state[slot] ?? 0;
    if (st === TRAFFIC_STATE.crashed || st === TRAFFIC_STATE.parked) {
      this.accel[slot] = 0;
      this.hardGap[slot] = Infinity;
      this.pullHold[slot] = 0;
      return;
    }
    const g = this.graph;
    const m = this.model[slot] ?? 0;
    const f = this.fleetIndex[slot] ?? -1;
    const lane = this.lane[slot] ?? 0;
    const edge = laneEdge(lane);
    const s = this.s[slot] ?? 0;
    const v = this.v[slot] ?? 0;
    const hl = MODEL_HALF_LEN[m] ?? 2;
    const bits = this.behavior[slot] ?? 0;
    const aMax = MODEL_A_MAX[m] ?? 2;
    let b = MODEL_B[m] ?? 2;
    const limitMph = g.effectiveSpeedLimitMph(edge, time);
    this.limitMph[slot] = limitMph;
    let v0: number;
    if (f >= 0) v0 = this.fleetSpeed(f, limitMph);
    else {
      v0 = limitMph * MPH * (this.desiredFactor[slot] ?? 1);
      if (bits & BEHAVIOR.dui) {
        v0 *= 1 + VIOLATIONS.behaviors.dui.speedJitter * Math.sin((this.weavePhase[slot] ?? 0) * 0.7 + 1);
        b *= DUI_LATE_BRAKE;
      }
    }
    const end = g.laneEnd(lane);
    const next = this.nextLane[slot] ?? -1;
    const turn = this.turn[slot] ?? 0;
    if (next >= 0 && turn !== TURN.straight) {
      const vt = turn === TURN.uturn ? UTURN_SPEED : TURN_SPEED;
      const ahead = Math.max(0, end - s - hl);
      v0 = Math.min(v0, s > end ? vt : Math.sqrt(vt * vt + 2 * b * ahead));
    }
    // Code 3 against a red or a sign: slow to the crossing speed at the line (`crossBrake` below).
    let crossLine = -1;
    if (f >= 0 && this.urgency[f] === URGENCY.emergency && s <= end) {
      const ap = edge * 2 + laneDir(lane);
      if (this.control[ap] !== CONTROL.none && this.againstControl(ap, g.nodes[g.laneEndNode(lane)] as RoadNode)) {
        const vc = PULLOVER.fleet.crossSpeed;
        crossLine = Math.max(0, end - s - hl);
        v0 = Math.min(v0, Math.sqrt(vc * vc + 2 * b * crossLine));
      }
    }

    // Leader: next car on this lane, else the last car on the next lane (cars parked aside are passed).
    let gap = Infinity;
    let vLead = 0;
    let lk = k + 1;
    while (lk < this.count && this.lane[this.order[lk] ?? 0] === lane && this.passable(slot, this.order[lk] ?? 0)) lk++;
    const leader = lk < this.count ? (this.order[lk] ?? 0) : -1;
    if (leader >= 0 && this.lane[leader] === lane) {
      gap = (this.s[leader] ?? 0) - s - hl - (MODEL_HALF_LEN[this.model[leader] ?? 0] ?? 0);
      vLead = this.v[leader] ?? 0;
    } else if (next >= 0) {
      let j = this.lowerBound(next);
      while (j < this.count && this.lane[this.order[j] ?? 0] === next && this.passable(slot, this.order[j] ?? 0)) j++;
      const o = this.order[j] ?? 0;
      if (j < this.count && this.lane[o] === next) {
        gap = end + (this.clen[slot] ?? 0) - s + (this.s[o] ?? 0) - g.laneStart(next) - hl - (MODEL_HALF_LEN[this.model[o] ?? 0] ?? 0);
        vLead = this.v[o] ?? 0;
      }
    }
    if (bits & BEHAVIOR.tailgating && v > TAILGATE_MIN_SPEED && gap < v * TAILGATE_HEADWAY_S) this.report(slot, 'tailgating', focus);

    // The player (car or officer) and parked player vehicles when they are in the lane ahead. A car on
    // its way to the curb also looks where it is heading, so it brakes in time behind a car standing there.
    const laneHalf = (g.edges[edge] as RoadEdge).laneWidth / 2;
    const hx = this.hx[slot] ?? 0, hz = this.hz[slot] ?? 0;
    const cx = this.x[slot] ?? 0, cz = this.z[slot] ?? 0;
    const pullNow = this.pull[slot];
    const curbShift =
      pullNow === PULL.pulling || pullNow === PULL.parking ? Math.max(0, this.curbTarget(slot) - (this.shoulder[slot] ?? 0)) : 0;
    if (focus.obstacle) {
      const dx = focus.ox - cx, dz = focus.oz - cz;
      const lon = dx * hx + dz * hz;
      const lat = -dx * hz + dz * hx;
      const band = laneHalf + focus.oHalfWidth;
      if (lon > 0 && lon < OBSTACLE_LOOKAHEAD && (Math.abs(lat) < band || (curbShift > 0 && Math.abs(lat - curbShift) < band))) {
        const og = lon - hl - focus.oRadius;
        if (og < gap) {
          gap = og;
          vLead = Math.max(0, focus.ovx * hx + focus.ovz * hz);
        }
      }
    }
    const parked = focus.parked;
    const parkedCount = parked ? Math.min(focus.parkedCount ?? 0, parked.length) : 0;
    for (let i = 0; i < parkedCount; i++) {
      const o = parked?.[i];
      if (!o) continue;
      const dx = o.x - cx, dz = o.z - cz;
      const lon = dx * hx + dz * hz;
      const lat = -dx * hz + dz * hx;
      // Half extents of the parked body along and across this car's heading.
      const cos = Math.abs(o.hx * hx + o.hz * hz), sin = Math.abs(o.hx * hz - o.hz * hx);
      const halfLat = o.halfLength * sin + o.halfWidth * cos;
      const band = laneHalf + halfLat;
      if (lon > 0 && lon < OBSTACLE_LOOKAHEAD && (Math.abs(lat) < band || (curbShift > 0 && Math.abs(lat - curbShift) < band))) {
        const og = lon - hl - (o.halfLength * cos + o.halfWidth * sin);
        if (og < gap) {
          gap = og;
          vLead = 0;
        }
      }
    }
    this.hardGap[slot] = gap;
    // Lane drop: yield to a sibling-lane car bound for the same lane unless clearly ahead of it (zipper merge).
    // IDM only: side by side the gap is negative, which brakes at maxDecel instead of the hard clamp's instant stop.
    if ((this.flags[slot] ?? 0) & CAR_FLAG.merge && next >= 0 && end - s < MERGE_DISTANCE) {
      const toMerge = end + (this.clen[slot] ?? 0) - s;
      const count = g.laneCount(edge, laneDir(lane));
      for (let i = 0; i < count; i++) {
        const sib = laneRef(edge, laneDir(lane), i);
        if (sib === lane) continue;
        const sibEnd = g.laneEnd(sib);
        for (let j = this.lowerBound(sib); j < this.count; j++) {
          const o = this.order[j] ?? 0;
          if (this.lane[o] !== sib) break;
          if (this.nextLane[o] !== next) continue;
          const hlo = MODEL_HALF_LEN[this.model[o] ?? 0] ?? 0;
          const og = toMerge - (sibEnd + (this.clen[o] ?? 0) - (this.s[o] ?? 0)) - hl - hlo;
          if (og > -2 * (hl + hlo) - IDM_S0 && og < gap) {
            gap = og;
            vLead = this.v[o] ?? 0;
          }
        }
      }
    }

    // Stop line as a virtual stopped obstacle.
    const toLine = end - s - hl;
    if (s <= end && toLine < GATE_LOOKAHEAD && this.mustStop(slot, toLine, dt, focus)) {
      const lineGap = toLine - STOP_LINE_GAP + IDM_S0;
      if (lineGap < gap) {
        gap = lineGap;
        vLead = 0;
      }
    }

    let a = idmAccel(v, v0, gap, v - vLead, aMax, b, this.headway[slot] ?? 1.4);
    if (crossLine >= 0) {
      // Brake on the profile that reaches crossSpeed at the line once it needs the comfortable decel.
      const vc = PULLOVER.fleet.crossSpeed;
      const need = (v * v - vc * vc) / (2 * Math.max(crossLine, 0.5));
      if (need >= b) a = Math.min(a, -need);
    }
    // Curb offset: pulling over, yielding and parking brake to a stop at curb.decel (deferred past a junction
    // close ahead); a merging car still beside the lane waits for a gap behind it.
    const p = this.pull[slot] ?? 0;
    let hold = 0;
    if (p === PULL.pulling || p === PULL.yielding || p === PULL.parking) {
      const decel = PULLOVER.curb.decel;
      const side = this.aside[slot] === 1 ? SIDE.clear : this.sideBlock(slot, true);
      if (next >= 0 && (s > end || s + hl + (v * v) / (2 * decel) > end - PULLOVER.curb.noPullNearLineM)) {
        // Deferred past the junction: slow to the approach speed meanwhile, so the next block is long
        // enough to stop in (a fast car would otherwise drive on at full speed for blocks).
        hold = 1;
        if (v > PULLOVER.curb.approachSpeed) a = Math.min(a, -decel);
      } else if (side !== SIDE.clear) {
        // A car beside it on the way to the curb (or already at the curb there): hold the lateral move;
        // ease off for moving traffic so it passes, drive on past a car standing at the curb.
        hold = 3;
        if (side === SIDE.moving) a = Math.min(a, v > 0 ? -decel / 2 : 0);
      } else a = Math.min(a, v > 0 ? -decel : 0);
    } else if (p === PULL.merging && this.aside[slot] === 1 && (this.carBehindClose(slot, k) || this.sideBlock(slot, false) !== SIDE.clear)) {
      hold = 2;
      a = Math.min(a, v > 0 ? -PULLOVER.curb.decel : 0);
    }
    this.pullHold[slot] = hold;
    const maxDecel = MODEL_MAX_DECEL[m] ?? 6;
    if (a < -maxDecel) a = -maxDecel;
    this.accel[slot] = a;

    const mph = v / MPH;
    if (bits & BEHAVIOR.speeding && mph > limitMph * SPEEDING_RATIO && mph - limitMph >= SPEEDING_MARGIN_MPH) {
      this.report(slot, 'speeding', focus);
    }
    if (bits & BEHAVIOR.dui && v > 5) this.report(slot, 'weaving', focus);
  }

  /** Pass 2: integrate speed and position; junction entry and lane transitions. */
  private integrate(slot: number, dt: number, focus: TrafficFocus): void {
    const st = this.state[slot] ?? 0;
    if (st === TRAFFIC_STATE.crashed || st === TRAFFIC_STATE.parked) {
      this.v[slot] = 0;
      this.speedView[slot] = 0;
      return;
    }
    let v = (this.v[slot] ?? 0) + (this.accel[slot] ?? 0) * dt;
    if (v < 0) v = 0;
    let ds = v * dt;
    const room = (this.hardGap[slot] ?? Infinity) - MIN_GAP;
    if (ds > room) {
      ds = room > 0 ? room : 0;
      v = Math.min(v, ds / dt);
    }
    const g = this.graph;
    let lane = this.lane[slot] ?? 0;
    const lane0 = lane;
    const s0 = this.s[slot] ?? 0;
    let s = s0 + ds;
    let end = g.laneEnd(lane);
    if (s0 <= end && s > end) this.enterJunction(slot, focus);
    // Move onto the next lane once the rear bumper has left the connector (`pose` samples both bumpers
    // along lane, connector and next lane); a zero-length connector can chain.
    const hl = MODEL_HALF_LEN[this.model[slot] ?? 0] ?? 0;
    for (let guard = 0; guard < 4; guard++) {
      const next = this.nextLane[slot] ?? -1;
      if (next < 0) {
        if (s > end) s = end;
        break;
      }
      const exit = end + (this.clen[slot] ?? 0);
      if (s - hl < exit) break;
      this.releaseHold(slot);
      s = g.laneStart(next) + (s - exit);
      lane = next;
      this.lane[slot] = lane;
      this.stopPhase[slot] = STOP_PHASE.approach;
      this.stopTimer[slot] = 0;
      this.reported[slot] = 0;
      this.flags[slot] = 0;
      const f = this.fleetIndex[slot] ?? -1;
      if (f >= 0 && (this.routeLen[f] ?? 0) > 0) this.advanceRoute(f, slot);
      this.chooseNextLane(slot);
      end = g.laneEnd(lane);
      if (s > end) this.enterJunction(slot, focus);
    }
    this.s[slot] = s;
    this.v[slot] = v;
    this.speedView[slot] = v;
    this.state[slot] = v < 0.3 ? TRAFFIC_STATE.waiting : TRAFFIC_STATE.driving;
    if ((this.behavior[slot] ?? 0) & BEHAVIOR.dui) {
      const phase = (this.weavePhase[slot] ?? 0) + (TWO_PI * dt) / (this.weavePeriod[slot] ?? 1);
      this.weavePhase[slot] = phase >= TWO_PI ? phase - TWO_PI : phase;
    }
    const f = this.fleetIndex[slot] ?? -1;
    if (f >= 0 && this.pull[slot] === PULL.none && (this.destEdge[f] ?? -1) >= 0 && this.arrived[f] === 0) this.checkArrival(f, slot, lane0 === lane ? s0 : -Infinity);
    if (this.pull[slot] !== PULL.none) this.stepPull(slot, v, dt);
  }

  /** The car crosses its stop line: hold the node; a red aspect is a red-light violation (unless held from green). */
  private enterJunction(slot: number, focus: TrafficFocus): void {
    const g = this.graph;
    const lane = this.lane[slot] ?? 0;
    const node = g.nodes[g.laneEndNode(lane)] as RoadNode;
    // A hold taken before the line is a left-turner that took the junction on green: finishing is legal.
    const held = this.holding[slot] === node.id;
    if (node.junction !== JUNCTION.none) this.acquireHold(slot, node.id);
    const a = laneEdge(lane) * 2 + laneDir(lane);
    if (this.control[a] === CONTROL.signal && !held) {
      const aspect = g.signalAspect(node.signal, (this.group[a] ?? 0) as 0 | 1, this.simTime);
      if (aspect === ASPECT.red) this.report(slot, 'redLight', focus);
    }
  }

  /**
   * Pass 3: world pose (plus DUI weave). Both bumpers follow the path (lane, junction connector, next
   * lane) half a length ahead of and behind `s` and the body sits between them, so on a tight corner a
   * long vehicle off-tracks inward instead of swinging its tail into the next lane or a waiting car.
   */
  private pose(slot: number): void {
    const hl = MODEL_HALF_LEN[this.model[slot] ?? 0] ?? 2;
    const s = this.s[slot] ?? 0;
    const front = this.pathPoint(slot, s + hl, this.lp);
    const fx = front.x, fz = front.z;
    const rear = this.pathPoint(slot, s - hl, this.lp2);
    const px = (fx + rear.x) / 2, pz = (fz + rear.z) / 2;
    const dx = fx - rear.x, dz = fz - rear.z;
    const dl = Math.hypot(dx, dz);
    const hx = dl > 1e-6 ? dx / dl : rear.hx;
    const hz = dl > 1e-6 ? dz / dl : rear.hz;
    let lat = 0;
    if ((this.behavior[slot] ?? 0) & BEHAVIOR.dui) {
      // The weave fades out on the way to the curb (none while stopped there) and back in when merging.
      const k = this.pull[slot] === PULL.none ? 1 : Math.max(0, 1 - (this.shoulder[slot] ?? 0) / this.curbTarget(slot));
      lat = k * (this.weaveAmp[slot] ?? 0) * Math.sin(this.weavePhase[slot] ?? 0);
    }
    this.lateral[slot] = lat;
    lat += this.shoulder[slot] ?? 0;
    // Right of the heading (hx, hz) is (-hz, hx).
    this.x[slot] = px - hz * lat;
    this.z[slot] = pz + hx * lat;
    this.hx[slot] = hx;
    this.hz[slot] = hz;
    this.yaw[slot] = Math.atan2(-hx, -hz);
  }

  /** Path point `s` metres along the car's lane, continuing over its connector onto the next lane. */
  private pathPoint(slot: number, s: number, out: LanePoint): LanePoint {
    const g = this.graph;
    const lane = this.lane[slot] ?? 0;
    const start = g.laneStart(lane);
    if (s < start) {
      // Behind the lane start (the rear still on the previous connector): straight back from the start.
      g.lanePoint(lane, start, out);
      out.x -= out.hx * (start - s);
      out.z -= out.hz * (start - s);
      return out;
    }
    const end = g.laneEnd(lane);
    const next = this.nextLane[slot] ?? -1;
    if (s <= end || next < 0) return g.lanePoint(lane, Math.min(s, end), out);
    const len = this.clen[slot] ?? 0;
    if (s - end >= len) return g.lanePoint(next, g.laneStart(next) + (s - end - len), out);
    const t = (s - end) / len;
    const u = 1 - t;
    const x0 = this.c0x[slot] ?? 0, z0 = this.c0z[slot] ?? 0;
    const x1 = this.c1x[slot] ?? 0, z1 = this.c1z[slot] ?? 0;
    const x2 = this.c2x[slot] ?? 0, z2 = this.c2z[slot] ?? 0;
    out.x = u * u * x0 + 2 * u * t * x1 + t * t * x2;
    out.z = u * u * z0 + 2 * u * t * z1 + t * t * z2;
    const tx = u * (x1 - x0) + t * (x2 - x1);
    const tz = u * (z1 - z0) + t * (z2 - z1);
    const tl = Math.hypot(tx, tz);
    out.hx = tl > 1e-9 ? tx / tl : out.hx;
    out.hz = tl > 1e-9 ? tz / tl : out.hz;
    return out;
  }

  private writeEcs(slot: number): void {
    const eid = this.eid[slot] ?? 0;
    const yaw = this.yaw[slot] ?? 0;
    Transform.x[eid] = this.x[slot] ?? 0;
    Transform.y[eid] = MODEL_REST_Y[this.model[slot] ?? 0] ?? 0;
    Transform.z[eid] = this.z[slot] ?? 0;
    Transform.qx[eid] = 0;
    Transform.qy[eid] = Math.sin(yaw / 2);
    Transform.qz[eid] = 0;
    Transform.qw[eid] = Math.cos(yaw / 2);
    let lights = this.headlights ? LIGHT.head : 0;
    const p = this.pull[slot];
    if (this.state[slot] === TRAFFIC_STATE.crashed) lights |= LIGHT.hazard;
    else if ((p === PULL.stopped || p === PULL.parked) && PULLOVER.curb.hazards) lights |= LIGHT.hazard;
    else if ((this.accel[slot] ?? 0) < -BRAKE_LIGHT_DECEL || (this.v[slot] ?? 0) < 0.05) lights |= LIGHT.brake;
    const f = this.fleetIndex[slot] ?? -1;
    if (f >= 0 && this.urgency[f] === URGENCY.emergency) lights |= LIGHT.lightbar;
    VehicleLook.lights[eid] = lights;
  }

  /** Kinematic Rapier box near the focus: velocity toward the new pose, rotation set directly. */
  private updateProxy(slot: number, dt: number, focus: TrafficFocus): void {
    const dx = (this.x[slot] ?? 0) - focus.x;
    const dz = (this.z[slot] ?? 0) - focus.z;
    const d2 = dx * dx + dz * dz;
    const body = this.proxy[slot] ?? null;
    const eid = this.eid[slot] ?? 0;
    const m = this.model[slot] ?? 0;
    const yaw = this.yaw[slot] ?? 0;
    const q = this.quat;
    q.y = Math.sin(yaw / 2);
    q.w = Math.cos(yaw / 2);
    const tx = this.x[slot] ?? 0, ty = MODEL_REST_Y[m] ?? 0, tz = this.z[slot] ?? 0;
    if (!body) {
      const r = DENSITY.radii.proxy;
      if (d2 > r * r || this.physics.has(eid)) return;
      this.vec.x = tx;
      this.vec.y = ty;
      this.vec.z = tz;
      this.half.x = MODEL_HALF_WID[m] ?? 1;
      this.half.y = MODEL_HALF_HGT[m] ?? 0.7;
      this.half.z = MODEL_HALF_LEN[m] ?? 2;
      const created = this.physics.addBox(eid, this.vec, this.half, { kinematic: true });
      created.setRotation(q, true);
      this.proxy[slot] = created;
      this.stats.proxies++;
      return;
    }
    const release = DENSITY.radii.proxyRelease;
    if (d2 > release * release) {
      this.physics.removeBody(eid);
      this.proxy[slot] = null;
      this.stats.proxies--;
      return;
    }
    const p = body.translation(this.vec);
    p.x = (tx - p.x) / dt;
    p.y = (ty - p.y) / dt;
    p.z = (tz - p.z) / dt;
    body.setLinvel(p, true);
    body.setRotation(q, true);
  }

  // --- Traffic stops ---------------------------------------------------------------------------

  /** Slot of the stop target, -1 when none. */
  private stopSlot(): number {
    if (this.stopId < 0) return -1;
    const slot = this.slotOfEntity(this.stopEid);
    return slot >= 0 && this.vehicleId[slot] === this.stopId ? slot : -1;
  }

  private beginStop(slot: number): void {
    const eid = this.eid[slot] ?? 0;
    const id = this.vehicleId[slot] ?? 0;
    this.stopId = id;
    this.stopEid = eid;
    this.stopCandidate = -1;
    this.stopDelay = 0;
    this.pinned[slot] = 1;
    this.pull[slot] = PULL.pulling;
    this.pullTimer[slot] = 0;
    // An abandoned car parked at the curb is already there: it finishes the pull at once.
    if (this.state[slot] === TRAFFIC_STATE.parked) this.state[slot] = TRAFFIC_STATE.waiting;
    this.bus?.emit('traffic:pullingOver', { eid, vehicleId: id });
  }

  /** Ends the stop: 'abandoned' leaves the car parked at the curb, otherwise it merges back. */
  private endStop(slot: number, reason: TrafficReleaseReason): void {
    const eid = this.eid[slot] ?? 0;
    const id = this.vehicleId[slot] ?? 0;
    this.stopId = -1;
    this.stopEid = 0;
    this.pinned[slot] = 0;
    if (reason !== 'abandoned') this.leaveCurb(slot);
    else if (this.pull[slot] === PULL.stopped) this.pull[slot] = PULL.parked;
    this.bus?.emit('traffic:released', { eid, vehicleId: id, reason });
  }

  /**
   * Stop target upkeep ('lost' beyond autoReleaseM) and candidate detection: with the light bar on and
   * the siren off (lights and siren only make traffic yield), the player car moving, the nearest ambient
   * car ahead of it in its direction, not pulling away from it, that stays the candidate for delayS.
   * Cars merging, yielding, parked or crashed are not candidates.
   */
  private updateStop(dt: number, focus: TrafficFocus): void {
    if (this.stopId >= 0) {
      const slot = this.stopSlot();
      if (slot < 0) {
        this.stopId = -1;
        this.stopEid = 0;
      } else {
        const dx = (this.x[slot] ?? 0) - focus.x, dz = (this.z[slot] ?? 0) - focus.z;
        const r = PULLOVER.release.autoReleaseM;
        if (dx * dx + dz * dz > r * r) this.endStop(slot, 'lost');
      }
      this.stopCandidate = -1;
      this.stopDelay = 0;
      return;
    }
    const heading = focus.heading;
    const det = PULLOVER.detect;
    const fx = heading === undefined ? 0 : -Math.sin(heading), fz = heading === undefined ? 0 : -Math.cos(heading);
    const vf = focus.ovx * fx + focus.ovz * fz;
    if (focus.lights !== true || focus.siren === true || !focus.obstacle || heading === undefined || vf < det.minPatrolSpeed) {
      this.stopCandidate = -1;
      this.stopDelay = 0;
      return;
    }
    let best = -1;
    let bestLon = Infinity;
    for (let slot = 0; slot < this.count; slot++) {
      if ((this.fleetIndex[slot] ?? -1) >= 0 || this.state[slot] === TRAFFIC_STATE.crashed) continue;
      if (this.pull[slot] !== PULL.none) continue;
      const dx = (this.x[slot] ?? 0) - focus.ox, dz = (this.z[slot] ?? 0) - focus.oz;
      const lon = dx * fx + dz * fz;
      if (lon < det.minDistance || lon > det.maxDistance || lon >= bestLon) continue;
      if (Math.abs(-dx * fz + dz * fx) >= det.lateral) continue;
      const along = (this.hx[slot] ?? 0) * fx + (this.hz[slot] ?? 0) * fz;
      if (along <= det.headingDot) continue;
      // Pulling away (the gap grows): not a car being followed.
      if ((this.v[slot] ?? 0) * along - vf > det.closingTol) continue;
      best = slot;
      bestLon = lon;
    }
    if (best < 0) {
      this.stopCandidate = -1;
      this.stopDelay = 0;
      return;
    }
    const id = this.vehicleId[best] ?? 0;
    if (id === this.stopCandidate) this.stopDelay += dt;
    else {
      this.stopCandidate = id;
      this.stopDelay = 0;
    }
    if (this.stopDelay >= det.delayS) this.beginStop(best);
  }

  // --- Yielding (design §7.3) ----------------------------------------------------------------------

  /**
   * Emergency sources (the player car with lights and siren, code-3 fleet cars on the move): ambient cars
   * ahead of one in its direction move to the curb and stop; they merge back once every source has
   * passed (passMargin ahead), is beyond 80 m, or after timeoutS (then no new yield for timeoutS).
   */
  private updateYield(dt: number, focus: TrafficFocus): void {
    let n = 0;
    const heading = focus.heading;
    if (focus.lights === true && focus.siren === true && focus.obstacle && heading !== undefined) {
      this.srcX[0] = focus.ox;
      this.srcZ[0] = focus.oz;
      this.srcHx[0] = -Math.sin(heading);
      this.srcHz[0] = -Math.cos(heading);
      n = 1;
    }
    for (let f = 0; f < this.fleetEid.length; f++) {
      if (this.urgency[f] !== URGENCY.emergency) continue;
      const slot = this.fleetSlot(f);
      if (slot < 0 || this.pull[slot] !== PULL.none) continue;
      this.srcX[n] = this.x[slot] ?? 0;
      this.srcZ[n] = this.z[slot] ?? 0;
      this.srcHx[n] = this.hx[slot] ?? 0;
      this.srcHz[n] = this.hz[slot] ?? 0;
      n++;
    }
    this.srcCount = n;
    const y = PULLOVER.yield;
    for (let slot = 0; slot < this.count; slot++) {
      const p = this.pull[slot];
      if (p === PULL.yielding) {
        const t = (this.pullTimer[slot] ?? 0) + dt;
        this.pullTimer[slot] = t;
        if (t >= y.timeoutS) {
          this.pull[slot] = PULL.merging;
          this.pullTimer[slot] = -y.timeoutS;
        } else if (!this.yieldSource(slot, false)) {
          this.pull[slot] = PULL.merging;
          this.pullTimer[slot] = 0;
        }
      } else if (p === PULL.none) {
        const t = this.pullTimer[slot] ?? 0;
        if (t < 0) {
          this.pullTimer[slot] = Math.min(0, t + dt);
          continue;
        }
        if (n === 0 || (this.fleetIndex[slot] ?? -1) >= 0) continue;
        const st = this.state[slot];
        if (st === TRAFFIC_STATE.crashed || st === TRAFFIC_STATE.parked) continue;
        if (this.yieldSource(slot, true)) {
          this.pull[slot] = PULL.yielding;
          this.pullTimer[slot] = 0;
        }
      }
    }
  }

  /**
   * With `start`, true when a source is behind the car within yield.range (same direction, lateral window);
   * without, true while a source still needs the car aside (within 80 m and not yet passMargin ahead of it).
   */
  private yieldSource(slot: number, start: boolean): boolean {
    const y = PULLOVER.yield;
    const x = this.x[slot] ?? 0, z = this.z[slot] ?? 0;
    const hx = this.hx[slot] ?? 0, hz = this.hz[slot] ?? 0;
    const far2 = YIELD_RELEASE_DISTANCE * YIELD_RELEASE_DISTANCE;
    for (let i = 0; i < this.srcCount; i++) {
      const sx = this.srcHx[i] ?? 0, sz = this.srcHz[i] ?? 0;
      if (hx * sx + hz * sz <= 0.5) continue;
      const dx = x - (this.srcX[i] ?? 0), dz = z - (this.srcZ[i] ?? 0);
      if (Math.abs(-dx * sz + dz * sx) >= y.lateral) continue;
      const lon = dx * sx + dz * sz;
      if (start ? lon > 0 && lon <= y.range : lon >= -y.passMargin && dx * dx + dz * dz <= far2) return true;
    }
    return false;
  }

  // --- Curb offset (design §7.1) -------------------------------------------------------------------

  /** Shoulder offset that puts the body just clear of the car's lane. */
  private curbTarget(slot: number): number {
    const lane = this.lane[slot] ?? 0;
    const e = this.graph.edges[laneEdge(lane)] as RoadEdge;
    return (laneIndex(lane) + 0.5) * e.laneWidth + (MODEL_HALF_WID[this.model[slot] ?? 0] ?? 1) + PULLOVER.curb.clearance;
  }

  private updateAside(slot: number): void {
    const off = this.pull[slot] !== PULL.none && (this.shoulder[slot] ?? 0) >= this.curbTarget(slot) - ASIDE_MARGIN;
    this.aside[slot] = off ? 1 : 0;
  }

  /**
   * What keeps `slot` from moving sideways on its road: a car alongside it (car lengths plus
   * SIDE_CLEAR_M apart along the road) on a lane between its own and the curb (`toCurb`: any such
   * car; merging back: only cars still in their lane), or, on the way to the curb, a car of a lane
   * further out already standing at the curb there.
   */
  private sideBlock(slot: number, toCurb: boolean): number {
    const lane = this.lane[slot] ?? 0;
    const idx = laneIndex(lane);
    const e = laneEdge(lane), dir = laneDir(lane);
    const n = this.graph.laneCount(e, dir);
    if (n <= 1) return SIDE.clear;
    const s = this.s[slot] ?? 0;
    const hl = MODEL_HALF_LEN[this.model[slot] ?? 0] ?? 2;
    // Once mostly out of its own lane the car finishes the move: only cars standing at the curb still hold it.
    const committed = toCurb && (this.shoulder[slot] ?? 0) >= (this.graph.edges[e]?.laneWidth ?? 3.5) / 2;
    for (let j = 0; j < n; j++) {
      if (j === idx || (!toCurb && j > idx)) continue;
      const other = laneRef(e, dir, j);
      for (let k = this.lowerBound(other); k < this.count; k++) {
        const o = this.order[k] ?? 0;
        if (this.lane[o] !== other) break;
        const d = (this.s[o] ?? 0) - s;
        const lengths = hl + (MODEL_HALF_LEN[this.model[o] ?? 0] ?? 2);
        const atCurb = this.aside[o] === 1;
        if (d >= lengths + SIDE_CLEAR_M) break;
        // Moving traffic coming up from behind needs a time gap, like a merge.
        const behind = atCurb ? SIDE_CLEAR_M : Math.max(SIDE_CLEAR_M, (this.v[o] ?? 0) * MERGE_CLEAR_S);
        if (d <= -(lengths + behind)) continue;
        if (j > idx ? atCurb : toCurb || !atCurb) {
          if (atCurb) return SIDE.curb;
          if (!committed) return SIDE.moving;
        }
      }
    }
    return SIDE.clear;
  }

  /** True when a car behind on the lane (not itself aside) is too close for this car to merge out. */
  private carBehindClose(slot: number, k: number): boolean {
    const lane = this.lane[slot] ?? 0;
    const s = this.s[slot] ?? 0;
    const hl = MODEL_HALF_LEN[this.model[slot] ?? 0] ?? 2;
    for (let j = k - 1; j >= 0; j--) {
      const o = this.order[j] ?? 0;
      if (this.lane[o] !== lane) return false;
      if (this.aside[o] === 1) continue;
      const gap = s - (this.s[o] ?? 0) - hl - (MODEL_HALF_LEN[this.model[o] ?? 0] ?? 2);
      return gap < Math.max(MERGE_CLEAR_M, (this.v[o] ?? 0) * MERGE_CLEAR_S);
    }
    return false;
  }

  /** Lateral motion of a car with a curb phase (after its longitudinal step) and the phase transitions. */
  private stepPull(slot: number, v: number, dt: number): void {
    const p = this.pull[slot] ?? 0;
    let sh = this.shoulder[slot] ?? 0;
    const hold = this.pullHold[slot];
    if (p === PULL.merging) {
      if (hold !== 2) sh = Math.max(0, sh - PULLOVER.release.lateralSpeed * dt);
      this.shoulder[slot] = sh;
      if (sh <= 0) this.pull[slot] = PULL.none;
    } else if ((p === PULL.pulling || p === PULL.yielding || p === PULL.parking) && hold !== 3) {
      const target = hold === 1 ? 0 : this.curbTarget(slot);
      const step = PULLOVER.curb.lateralSpeed * dt;
      sh = sh < target ? Math.min(target, sh + step) : Math.max(target, sh - step);
      this.shoulder[slot] = sh;
      if (hold !== 1 && v <= 0 && sh >= target) this.finishPull(slot, p);
    }
    this.updateAside(slot);
  }

  /** The car stands at the curb: a stop target is pulled over, a parking fleet car has arrived. */
  private finishPull(slot: number, p: number): void {
    if (p === PULL.yielding) return;
    this.v[slot] = 0;
    this.speedView[slot] = 0;
    this.accel[slot] = 0;
    this.state[slot] = TRAFFIC_STATE.parked;
    const eid = this.eid[slot] ?? 0;
    const target = this.stopId >= 0 && eid === this.stopEid;
    this.pull[slot] = target ? PULL.stopped : PULL.parked;
    const f = this.fleetIndex[slot] ?? -1;
    if (!this.bus && !(p === PULL.parking && f >= 0)) return;
    this.pose(slot);
    if (p === PULL.parking && f >= 0) {
      this.arrived[f] = 1;
      this.bus?.emit('traffic:fleetArrived', { index: f, eid, x: this.x[slot] ?? 0, z: this.z[slot] ?? 0 });
    } else if (target) {
      this.bus?.emit('traffic:pulledOver', { eid, vehicleId: this.stopId, x: this.x[slot] ?? 0, z: this.z[slot] ?? 0, yaw: this.yaw[slot] ?? 0 });
    }
  }

  /** Leaves the curb (or stops heading for it): merges back into the lane. */
  private leaveCurb(slot: number): void {
    const p = this.pull[slot];
    if (p === PULL.none || p === PULL.merging) return;
    this.pull[slot] = PULL.merging;
    const st = this.state[slot];
    if (st === TRAFFIC_STATE.parked || st === TRAFFIC_STATE.crashed) this.state[slot] = TRAFFIC_STATE.waiting;
  }

  // --- Fleet cars ------------------------------------------------------------------------------------

  private validFleetIndex(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < this.fleetEid.length;
  }

  /** Slot of fleet car `index`, -1 when absent. */
  private fleetSlot(index: number): number {
    if (!this.validFleetIndex(index)) return -1;
    const eid = this.fleetEid[index] ?? 0;
    if (eid === 0) return -1;
    const slot = this.slotOfEntity(eid);
    return slot >= 0 && this.fleetIndex[slot] === index ? slot : -1;
  }

  /** Back to patrol defaults: no destination or route, not arrived. */
  private resetFleet(index: number): void {
    this.urgency[index] = URGENCY.patrol;
    this.arrived[index] = 0;
    this.destEdge[index] = -1;
    this.destS[index] = 0;
    this.destX[index] = 0;
    this.destZ[index] = 0;
    this.routeLen[index] = 0;
    this.routePos[index] = 0;
  }

  /** Curb lane of `edge` (dir 0, else dir 1) at the projection of (x, z), when free; sets `spotS`. */
  private fleetSpot(edge: number, x: number, z: number, hl: number): number {
    const g = this.graph;
    const e = g.edges[edge] as RoadEdge;
    const hit = g.projectOnEdge(edge, x, z, this.hit);
    for (let d = 0; d < 2; d++) {
      const dir = d as 0 | 1;
      if (g.laneCount(edge, dir) === 0) continue;
      const lane = laneRef(edge, dir, 0);
      const lo = g.laneStart(lane) + hl + 1, hi = g.laneEnd(lane) - hl - 1;
      if (lo > hi) continue;
      const s = Math.min(hi, Math.max(lo, dir === 0 ? hit.s : e.length - hit.s));
      if (this.laneOccupied(lane, s)) continue;
      this.spotS = s;
      return lane;
    }
    return -1;
  }

  private laneOccupied(lane: number, s: number): boolean {
    this.sortOrder();
    for (let k = this.lowerBound(lane); k < this.count; k++) {
      const o = this.order[k] ?? 0;
      if (this.lane[o] !== lane) return false;
      if (Math.abs((this.s[o] ?? 0) - s) < SPAWN_SPACING) return true;
    }
    return false;
  }

  /** Desired speed of a fleet car by urgency (m/s). */
  private fleetSpeed(f: number, limitMph: number): number {
    const fleet = PULLOVER.fleet;
    const limit = limitMph * MPH;
    const u = this.urgency[f];
    if (u === URGENCY.emergency) return Math.min(limit * fleet.emergencyFactor, fleet.maxEmergencySpeed);
    return limit * (u === URGENCY.respond ? fleet.respondFactor : fleet.patrolFactor);
  }

  /** Destination s on `destEdge` travelling in `dir`. */
  private destLaneS(f: number, dir: number): number {
    const s = this.destS[f] ?? 0;
    return dir === 0 ? s : (this.graph.edges[this.destEdge[f] ?? 0] as RoadEdge).length - s;
  }

  /** True when lane `lane` has an exit onto `edge`. */
  private hasExit(lane: number, edge: number): boolean {
    const conns = this.graph.connections(laneEdge(lane), laneDir(lane));
    for (let i = 0; i < conns.length; i++) if ((conns[i] as LaneConnection).edge === edge) return true;
    return false;
  }

  /**
   * Plans fleet car `f`'s route to its destination: A* from the end node of its lane (of the next lane when
   * already crossing the junction) to the destination edge's `from` (driving it from -> to) and, on a
   * two-way edge, to its `to`; keeps the faster. Turning back onto the current edge is not an exit unless
   * the lane dead-ends. Fills the route buffer (edge it is on first); false when unreachable.
   */
  private planRoute(f: number, slot: number): boolean {
    const g = this.graph;
    const dest = this.destEdge[f] ?? -1;
    if (dest < 0) return false;
    const de = g.edges[dest] as RoadEdge;
    const base = f * ROUTE_CAP;
    let lane = this.lane[slot] ?? 0;
    let s = this.s[slot] ?? 0;
    let n = 0;
    const next = this.nextLane[slot] ?? -1;
    if (s > g.laneEnd(lane) && next >= 0) {
      this.routeBuf[base + n++] = laneEdge(lane);
      lane = next;
      s = g.laneStart(next);
    }
    const edge = laneEdge(lane);
    this.routeBuf[base + n++] = edge;
    if (edge === dest && s < this.destLaneS(f, laneDir(lane))) {
      this.routeLen[f] = n;
      this.routePos[f] = 0;
      return true;
    }
    const from = g.laneEndNode(lane);
    const speed = Math.max(1, de.speedLimitMph * MPH);
    let best: Route | null = null;
    let bestTime = Infinity;
    const consider = (r: Route | null, tail: number): void => {
      if (!r) return;
      // The first edge after this lane must be one of its exits (no U-turn onto the destination edge).
      if (!this.hasExit(lane, r.edges[0] ?? dest)) return;
      const t = r.time + tail;
      if (t < bestTime) {
        best = r;
        bestTime = t;
      }
    };
    const deadEnd = this.hasExit(lane, edge);
    // Without the current edge first (no U-turn); then, if that finds nothing, with it.
    for (let attempt = 0; attempt < (deadEnd ? 1 : 2) && (best as Route | null) === null; attempt++) {
      const options = attempt === 0 && !deadEnd ? { avoidEdges: new Set([edge]) } : {};
      consider(g.findRoute(from, de.from, options), (this.destS[f] ?? 0) / speed);
      if (de.lanesBackward > 0) consider(g.findRoute(from, de.to, options), (de.length - (this.destS[f] ?? 0)) / speed);
    }
    const route = best as Route | null;
    if (!route) return false;
    for (let i = 0; i < route.edges.length && n < ROUTE_CAP - 1; i++) this.routeBuf[base + n++] = route.edges[i] ?? 0;
    this.routeBuf[base + n++] = dest;
    this.routeLen[f] = n;
    this.routePos[f] = 0;
    return true;
  }

  /** Picks the exit onto the route's next edge; re-plans once when that is not possible. */
  private followRoute(f: number, slot: number): boolean {
    for (let attempt = 0; attempt < 2; attempt++) {
      const pos = this.routePos[f] ?? 0;
      const len = this.routeLen[f] ?? 0;
      if (pos + 1 < len) {
        if (this.takeExit(slot, this.routeBuf[f * ROUTE_CAP + pos + 1] ?? -1)) return true;
      } else if (laneEdge(this.lane[slot] ?? 0) === this.destEdge[f]) return false;
      if (attempt === 0 && !this.planRoute(f, slot)) {
        this.routeLen[f] = 0;
        return false;
      }
    }
    return false;
  }

  /** Sets the next lane onto `edge` (lane index by the Phase 1 turn rules); false when no exit leads there. */
  private takeExit(slot: number, edge: number): boolean {
    const g = this.graph;
    const lane = this.lane[slot] ?? 0;
    const conns = g.connections(laneEdge(lane), laneDir(lane));
    const index = laneIndex(lane);
    for (let i = 0; i < conns.length; i++) {
      const c = conns[i] as LaneConnection;
      if (c.edge !== edge) continue;
      const count = g.laneCount(c.edge, c.dir);
      const idx = c.turn === TURN.right ? 0 : c.turn === TURN.left ? count - 1 : Math.min(index, count - 1);
      this.flags[slot] = (this.flags[slot] ?? 0) & ~CAR_FLAG.merge;
      this.setNextLane(slot, laneRef(c.edge, c.dir, idx), c.turn);
      return true;
    }
    return false;
  }

  /** The fleet car moved onto a new lane: advance along the route, or re-plan when it left it. */
  private advanceRoute(f: number, slot: number): void {
    const pos = this.routePos[f] ?? 0;
    const edge = laneEdge(this.lane[slot] ?? 0);
    if (pos + 1 < (this.routeLen[f] ?? 0) && this.routeBuf[f * ROUTE_CAP + pos + 1] === edge) this.routePos[f] = pos + 1;
    else if (!this.planRoute(f, slot)) this.routeLen[f] = 0;
  }

  /**
   * On the destination edge: park at the curb within arriveDistance of the point, once the point is
   * within braking distance ahead (curb.decel), or when the car drove past it this step (`s0`: its s at
   * the start of the step on this lane, -Infinity when it entered the lane during the step). A point
   * already behind the car does not count: its route loops round to it.
   */
  private checkArrival(f: number, slot: number, s0: number): void {
    const lane = this.lane[slot] ?? 0;
    if (laneEdge(lane) !== this.destEdge[f]) return;
    const dx = (this.x[slot] ?? 0) - (this.destX[f] ?? 0), dz = (this.z[slot] ?? 0) - (this.destZ[f] ?? 0);
    const r = PULLOVER.fleet.arriveDistance;
    const s = this.s[slot] ?? 0;
    const dS = this.destLaneS(f, laneDir(lane));
    const v = this.v[slot] ?? 0;
    const ahead = dS - s;
    const brake = Math.max(r, (v * v) / (2 * PULLOVER.curb.decel) + (MODEL_HALF_LEN[this.model[slot] ?? 0] ?? 2));
    const crossed = s0 < dS && s >= dS;
    if (dx * dx + dz * dz >= r * r && !crossed && !(ahead >= 0 && ahead <= brake)) return;
    this.pull[slot] = PULL.parking;
    this.routeLen[f] = 0;
    this.routePos[f] = 0;
  }

  /** Metres left along the route to the destination, -1 without one. */
  private routeLeft(f: number, slot: number): number {
    const len = this.routeLen[f] ?? 0;
    const dest = this.destEdge[f] ?? -1;
    if (dest < 0 || len === 0 || this.arrived[f] === 1) return -1;
    const g = this.graph;
    const lane = this.lane[slot] ?? 0;
    const s = this.s[slot] ?? 0;
    if (laneEdge(lane) === dest) return Math.max(0, this.destLaneS(f, laneDir(lane)) - s);
    let left = Math.max(0, g.laneLength(lane) - s);
    const base = f * ROUTE_CAP;
    for (let i = (this.routePos[f] ?? 0) + 1; i < len - 1; i++) left += (g.edges[this.routeBuf[base + i] ?? 0] as RoadEdge).length;
    if (this.routeBuf[base + len - 1] !== dest || len < 2) return left;
    const prev = g.edges[this.routeBuf[base + len - 2] ?? 0] as RoadEdge;
    const de = g.edges[dest] as RoadEdge;
    return left + this.destLaneS(f, prev.from === de.from || prev.to === de.from ? 0 : 1);
  }

  private saveFleet(f: number, slot: number, car: TrafficCarSave): void {
    car.model = this.model[slot] ?? 0;
    car.color = VehicleLook.color[this.eid[slot] ?? 0] ?? 0;
    car.fleet = f;
    if (this.urgency[f] !== URGENCY.patrol) car.urgency = this.urgency[f] ?? 0;
    if (this.arrived[f] !== 0) car.arrived = 1;
    if ((this.destEdge[f] ?? -1) >= 0) {
      car.destX = this.destX[f] ?? 0;
      car.destZ = this.destZ[f] ?? 0;
      car.destEdge = this.destEdge[f] ?? 0;
      car.destS = this.destS[f] ?? 0;
    }
    const len = this.routeLen[f] ?? 0;
    if (len > 0) {
      car.route = Array.from(this.routeBuf.subarray(f * ROUTE_CAP, f * ROUTE_CAP + len));
      car.routePos = this.routePos[f] ?? 0;
    }
  }

  private restoreFleet(f: number, c: TrafficCarSave): void {
    this.resetFleet(f);
    const edges = this.graph.edges.length;
    const u = c.urgency ?? 0;
    this.urgency[f] = u === URGENCY.respond || u === URGENCY.emergency ? u : URGENCY.patrol;
    this.arrived[f] = (c.arrived ?? 0) !== 0 ? 1 : 0;
    const dest = c.destEdge ?? -1;
    if (Number.isInteger(dest) && dest >= 0 && dest < edges) {
      this.destEdge[f] = dest;
      this.destS[f] = c.destS ?? 0;
      this.destX[f] = c.destX ?? 0;
      this.destZ[f] = c.destZ ?? 0;
    }
    const route = c.route;
    if (route && route.length > 0 && route.every((e) => e < edges)) {
      const len = Math.min(route.length, ROUTE_CAP);
      for (let i = 0; i < len; i++) this.routeBuf[f * ROUTE_CAP + i] = route[i] ?? 0;
      this.routeLen[f] = len;
      this.routePos[f] = Math.min(len - 1, Math.max(0, Math.floor(c.routePos ?? 0)));
    }
  }

  /** True when approach `a` faces a red/yellow signal or a stop/yield sign at `node`. */
  private againstControl(a: number, node: RoadNode): boolean {
    const ctrl = this.control[a];
    if (ctrl === CONTROL.signal) return this.graph.signalAspect(node.signal, (this.group[a] ?? 0) as 0 | 1, this.simTime) !== ASPECT.green;
    return ctrl === CONTROL.stop || ctrl === CONTROL.yield;
  }

  /**
   * Code 3 against a red or a sign: at the line (slowed to crossSpeed) the car crosses when nobody holds
   * the node, its exit has room and no other approach has a car about to enter; it stops at the line otherwise.
   */
  private emergencyGate(slot: number, a: number, d: number, node: RoadNode): boolean {
    if (this.holding[slot] === node.id) {
      this.stopPhase[slot] = STOP_PHASE.cleared;
      return false;
    }
    const busy = (this.nodeHold[node.id] ?? 0) > 0;
    const vc = PULLOVER.fleet.crossSpeed;
    const decide = STOP_ZONE + (vc * vc) / (2 * (MODEL_B[this.model[slot] ?? 0] ?? 2));
    if (d > decide) return busy && d < NEAR_LINE;
    if (busy || this.exitBlocked(slot)) return true;
    for (let i = 0; i < node.edges.length; i++) {
      const id = node.edges[i] ?? 0;
      const other = id * 2 + ((this.graph.edges[id] as RoadEdge).to === node.id ? 0 : 1);
      if (other !== a && this.approachBusy(other, EMERGENCY_CLEAR_M, EMERGENCY_CLEAR_S)) return true;
    }
    this.stopPhase[slot] = STOP_PHASE.cleared;
    this.acquireHold(slot, node.id);
    return false;
  }

  // --- Events ---------------------------------------------------------------------------------

  /** Emits a violation once per car, kind and edge, only within `observeRadius` of the focus. */
  private report(slot: number, kind: TrafficViolationKind, focus: TrafficFocus): void {
    const bit = VIOLATION_BIT[kind];
    if ((this.reported[slot] ?? 0) & bit || !this.bus || (this.fleetIndex[slot] ?? -1) >= 0) return;
    const x = this.x[slot] ?? 0, z = this.z[slot] ?? 0;
    const r = VIOLATIONS.observeRadius;
    if ((x - focus.x) * (x - focus.x) + (z - focus.z) * (z - focus.z) > r * r) return;
    this.reported[slot] = (this.reported[slot] ?? 0) | bit;
    this.bus.emit('traffic:violation', {
      eid: this.eid[slot] ?? 0,
      vehicleId: this.vehicleId[slot] ?? 0,
      kind,
      x,
      z,
      speedMph: (this.v[slot] ?? 0) / MPH,
      limitMph: this.limitMph[slot] ?? 0,
    });
  }

  private onCollision(event: CollisionEvent): void {
    if (!event.started || event.a === undefined || event.b === undefined) return;
    this.crash(event.a, event.b);
    this.crash(event.b, event.a);
  }

  /** A proxy touched a non-traffic body: the car stops with hazards on. */
  private crash(eid: EntityId, other: EntityId): void {
    const slot = this.slotOfEntity(eid);
    if (slot < 0 || this.slotOfEntity(other) >= 0 || this.state[slot] === TRAFFIC_STATE.crashed) return;
    let impactSpeed = this.v[slot] ?? 0;
    const body = this.physics.getBody(other);
    if (body) {
      const ov = body.linvel(this.vec);
      const v = this.v[slot] ?? 0;
      impactSpeed = Math.hypot(ov.x - v * (this.hx[slot] ?? 0), ov.z - v * (this.hz[slot] ?? 0));
    }
    // Fleet cars (AI units) shrug collisions off, and so does a car pulling over or standing at the curb
    // (the traffic-stop target must still reach / leave the curb): the event still tells the dispatcher.
    const p = this.pull[slot];
    const curb = eid === this.stopEid || p === PULL.pulling || p === PULL.stopped || p === PULL.parked;
    if ((this.fleetIndex[slot] ?? -1) < 0 && !curb) {
      this.state[slot] = TRAFFIC_STATE.crashed;
      this.v[slot] = 0;
      this.speedView[slot] = 0;
      this.accel[slot] = 0;
      this.releaseHold(slot);
      this.proxy[slot]?.setLinvel({ x: 0, y: 0, z: 0 }, true);
      VehicleLook.lights[eid] = (VehicleLook.lights[eid] ?? 0) | LIGHT.hazard;
    }
    this.bus?.emit('traffic:collision', { eid, vehicleId: this.vehicleId[slot] ?? 0, other, impactSpeed });
  }
}
