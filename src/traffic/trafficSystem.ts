import type { RigidBody } from '@dimforge/rapier3d-compat';
import type { EntityId } from 'bitecs';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import { createRng, type Rng, type RngState } from '../core/rng';
import { EntityKind, KIND, PrevTransform, Transform, copyTransformSlot } from '../ecs/components';
import { despawn, spawn, type GameWorld } from '../ecs/world';
import type { CollisionEvent, PhysicsWorld, Vec3 } from '../physics/physics';
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
  type LanePoint,
  type RoadEdge,
  type RoadGraph,
  type RoadHit,
  type RoadNode,
  type ZoneTime,
} from '../world/roadGraph';
import { attachTrafficCar, TrafficCar } from './components';
import { DENSITY, VIOLATIONS } from './data';
import type { TrafficViolationKind } from './events';
import { idmAccel, IDM_S0 } from './idm';
import { REGISTRY_POPULATION, vehicleRecord } from './registry';

/**
 * Ambient traffic (design §9.2): kinematic cars on the road graph's lanes, IDM car following,
 * signals and stop signs, law-breaking behaviours, density streaming around a focus point and
 * kinematic Rapier proxies near the player. Fixed step, main thread, allocation-free per step
 * (spawns, despawns and events are rare transitions and may allocate).
 */

/** The player as seen by traffic: streaming centre plus an optional obstacle (car or officer). */
export interface TrafficFocus {
  x: number;
  z: number;
  obstacle: boolean;
  ox: number;
  oz: number;
  ovx: number;
  ovz: number;
  oRadius: number;
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
}

export interface TrafficSnapshot {
  version: 1;
  rng: RngState;
  spawnSeq: number;
  cars: TrafficCarSave[];
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
const CAR_FLAG = { fullStop: 1 } as const;
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
/** Minor-road cars wait while a major-road car is this close to the junction (m). */
const MAJOR_CLEAR_DISTANCE = 40;
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

type SlotArray = Float64Array | Float32Array | Int32Array | Uint8Array;

const CAR_SAVE_KEYS: readonly (keyof TrafficCarSave)[] = [
  'vehicleId', 'lane', 's', 'speed', 'accel', 'nextLane', 'state', 'behavior', 'desiredFactor', 'headway',
  'weaveAmp', 'weavePeriod', 'weavePhase', 'stopPhase', 'stopTimer', 'holding', 'reported', 'flags',
];

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
  return v.cars.every((car: unknown) => {
    if (typeof car !== 'object' || car === null) return false;
    const c = car as Record<string, unknown>;
    return CAR_SAVE_KEYS.every((key) => typeof c[key] === 'number' && Number.isFinite(c[key]));
  });
}

export class TrafficSystem {
  readonly capacity: number;
  readonly view: TrafficView;
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
  /** Per-step scratch: gap to the car/obstacle ahead (for the hard no-overlap clamp). */
  private readonly hardGap: Float64Array;
  private readonly proxy: (RigidBody | null)[];
  private readonly slotArrays: SlotArray[];

  /** Slots sorted by (lane, s, slot); rebuilt incrementally (insertion sort) each step. */
  private readonly order: Int32Array;
  /** 1 while a registry id is on the road. */
  private readonly onRoad: Uint8Array;
  /** Cars holding each junction node (crossing it, or cleared at its stop line). */
  private readonly nodeHold: Int32Array;
  /** Per approach (edge * 2 + dir): CONTROL id, signal group and the oncoming approach (-1 = none). */
  private readonly control: Uint8Array;
  private readonly group: Uint8Array;
  private readonly oncoming: Int32Array;

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
    const cap = DENSITY.capacity;
    this.capacity = cap;
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
    this.hardGap = f64();
    this.proxy = new Array<RigidBody | null>(cap).fill(null);
    this.slotArrays = [
      this.eid, this.vehicleId, this.x, this.z, this.yaw, this.speedView, this.state, this.model, this.lane,
      this.s, this.v, this.accel, this.nextLane, this.turn, this.c0x, this.c0z, this.c1x, this.c1z, this.c2x,
      this.c2z, this.clen, this.behavior, this.desiredFactor, this.headway, this.weaveAmp, this.weavePeriod,
      this.weavePhase, this.lateral, this.stopPhase, this.stopTimer, this.holding, this.reported, this.flags,
      this.hx, this.hz, this.limitMph,
    ];
    this.order = new Int32Array(cap);
    this.onRoad = new Uint8Array(REGISTRY_POPULATION);
    this.nodeHold = new Int32Array(this.graph.nodes.length);

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
    for (let attempt = 0; attempt < target * 30 && this.count < target; attempt++) {
      this.trySpawnRandom(focus, time, Math.max(initialMin, NEVER_WITHIN), spawnMax);
    }
  }

  /** One fixed step (system order 50: after copyPrevTransform, before physics). */
  step(dt: number, simTime: number, time: ZoneTime, focus: TrafficFocus): void {
    this.simTime = simTime;
    this.sortOrder();
    const tickS = DENSITY.tickS;
    if (Math.floor(simTime / tickS) !== Math.floor((simTime - dt) / tickS)) this.tick(focus, time);
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
    if (this.count >= this.capacity) return -1;
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
    }
    const st = this.rng.state();
    return { version: 1, rng: { seed: st.seed, s: [st.s[0], st.s[1], st.s[2], st.s[3]] }, spawnSeq: this.spawnSeq, cars };
  }

  /** Replaces every car with the snapshot's; the next `step` continues exactly as the saved session. */
  restore(snapshot: TrafficSnapshot): void {
    this.clear();
    this.rng.restore(snapshot.rng);
    this.spawnSeq = snapshot.spawnSeq;
    const edges = this.graph.edges.length;
    for (const c of snapshot.cars) {
      if (this.count >= this.capacity) break;
      const e = laneEdge(c.lane);
      if (e >= edges || this.graph.laneCount(e, laneDir(c.lane)) <= laneIndex(c.lane)) continue;
      if (c.vehicleId < 0 || c.vehicleId >= REGISTRY_POPULATION || this.onRoad[c.vehicleId] === 1) continue;
      const slot = this.createEntity(c.vehicleId, c.lane, c.s, c.speed);
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
      if (c.holding >= 0 && c.holding < this.nodeHold.length) {
        this.holding[slot] = c.holding;
        this.nodeHold[c.holding] = (this.nodeHold[c.holding] ?? 0) + 1;
      }
      this.pose(slot);
      this.writeEcs(slot);
      copyTransformSlot(Transform, PrevTransform, this.eid[slot] ?? 0);
    }
    this.sortOrder();
    this.stats.active = this.count;
  }

  /** Removes every car (entities and proxies) without events. */
  clear(): void {
    while (this.count > 0) this.despawnSlot(this.count - 1, false);
    this.nodeHold.fill(0);
    this.stats.active = 0;
    this.stats.proxies = 0;
  }

  dispose(): void {
    this.clear();
    this.unsubscribe();
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
      let topClass = 99, allSame = true;
      for (const id of node.edges) {
        const c = (g.edges[id] as RoadEdge).roadClass;
        if (topClass !== 99 && c !== topClass) allSame = false;
        topClass = Math.min(topClass, c);
      }
      const stops = node.junction === JUNCTION.allWayStop || allSame || edge.roadClass > topClass;
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
      const dx = (this.x[slot] ?? 0) - focus.x;
      const dz = (this.z[slot] ?? 0) - focus.z;
      const limit = this.state[slot] === TRAFFIC_STATE.crashed ? crashedR2 : despawnR2;
      if (dx * dx + dz * dz > limit) this.despawnSlot(slot, true);
    }
    const target = this.targetCount(focus, time);
    const { spawnMin, spawnMax } = DENSITY.radii;
    let spawned = 0;
    for (let attempt = 0; attempt < DENSITY.spawnPerTick * 8; attempt++) {
      if (this.count >= target || spawned >= DENSITY.spawnPerTick) break;
      if (this.trySpawnRandom(focus, time, spawnMin, spawnMax)) spawned++;
    }
  }

  /** Samples a point in the ring, snaps it to a lane and spawns there if it is free. */
  private trySpawnRandom(focus: TrafficFocus, time: ZoneTime, rMin: number, rMax: number): boolean {
    if (this.count >= this.capacity) return false;
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
    for (let k = this.lowerBound(lane); k < this.count; k++) {
      const o = this.order[k] ?? 0;
      if (this.lane[o] !== lane) break;
      if (Math.abs((this.s[o] ?? 0) - s) < SPAWN_SPACING) return false;
    }
    const id = this.nextVehicleId();
    if (id < 0) return false;
    // Slow enough to stop comfortably at the stop line ahead.
    const toLine = this.graph.laneEnd(lane) - s - MAX_HALF_LEN;
    const speed = Math.min(this.graph.effectiveSpeedLimitMph(e.id, time) * MPH * 0.8, Math.sqrt(3 * toLine));
    const slot = this.spawnCar(id, lane, s, speed, time, undefined);
    this.pose(slot);
    this.writeEcs(slot);
    copyTransformSlot(Transform, PrevTransform, this.eid[slot] ?? 0);
    return true;
  }

  /** Next registry id from the coprime-stride walk, skipping ids already on the road; -1 if all are. */
  private nextVehicleId(): number {
    const pop = REGISTRY_POPULATION;
    for (let tries = 0; tries < pop; tries++) {
      const id = ((this.spawnSeq % pop) * REGISTRY_STRIDE + this.registryOffset) % pop;
      this.spawnSeq++;
      if (this.onRoad[id] !== 1) return id;
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
    const slot = this.count++;
    for (const a of this.slotArrays) a[slot] = 0;
    const eid = spawn(this.world, Transform, PrevTransform);
    EntityKind.kind[eid] = KIND.Vehicle;
    attachVehicleLook(this.world, eid, record.modelIndex, record.color, record.faults);
    attachTrafficCar(this.world, eid, slot);
    this.eid[slot] = eid;
    this.vehicleId[slot] = id;
    this.model[slot] = record.modelIndex;
    this.lane[slot] = lane;
    this.s[slot] = s;
    this.v[slot] = speed;
    this.nextLane[slot] = -1;
    this.holding[slot] = -1;
    this.desiredFactor[slot] = 1;
    this.headway[slot] = NORMAL_HEADWAY[0];
    this.weavePeriod[slot] = 1;
    this.proxy[slot] = null;
    this.onRoad[id] = 1;
    this.insertOrder(slot);
    return slot;
  }

  private despawnSlot(slot: number, emit: boolean): void {
    const eid = this.eid[slot] ?? 0;
    const id = this.vehicleId[slot] ?? 0;
    this.releaseHold(slot);
    if (this.proxy[slot]) {
      this.physics.removeBody(eid);
      this.proxy[slot] = null;
      this.stats.proxies--;
    }
    this.onRoad[id] = 0;
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
    this.stats.despawned++;
    if (emit) this.bus?.emit('traffic:despawned', { eid, vehicleId: id });
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

  /** Slot of the car furthest along `lane` (including one crossing the junction after it), or -1. */
  private frontCar(lane: number): number {
    const k = this.lowerBound(lane + 1) - 1;
    const o = this.order[k] ?? 0;
    return k >= 0 && this.lane[o] === lane ? o : -1;
  }

  // --- Lanes and junctions --------------------------------------------------------------------

  private turnOf(lane: number, next: number): number {
    for (const c of this.graph.connections(laneEdge(lane), laneDir(lane))) {
      if (c.edge === laneEdge(next) && c.dir === laneDir(next)) return c.turn;
    }
    return TURN.straight;
  }

  /** Seeded choice among the exits (U-turn only at dead ends); right turns use the curb lane, left the inner one. */
  private chooseNextLane(slot: number): void {
    const lane = this.lane[slot] ?? 0;
    const conns = this.graph.connections(laneEdge(lane), laneDir(lane));
    let options = 0;
    for (const c of conns) if (c.turn !== TURN.uturn) options++;
    const allowUturn = options === 0;
    if (allowUturn) options = conns.length;
    if (options === 0) {
      this.nextLane[slot] = -1;
      this.clen[slot] = 0;
      return;
    }
    let pick = options > 1 ? this.rng.nextInt(0, options - 1) : 0;
    for (const c of conns) {
      if (c.turn === TURN.uturn && !allowUturn) continue;
      if (pick-- > 0) continue;
      const count = this.graph.laneCount(c.edge, c.dir);
      const idx = c.turn === TURN.right ? 0 : c.turn === TURN.left ? count - 1 : Math.min(laneIndex(lane), count - 1);
      this.setNextLane(slot, laneRef(c.edge, c.dir, idx), c.turn);
      return;
    }
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
    this.nodeHold[node] = (this.nodeHold[node] ?? 0) + 1;
  }

  private releaseHold(slot: number): void {
    const node = this.holding[slot] ?? -1;
    if (node < 0) return;
    this.nodeHold[node] = (this.nodeHold[node] ?? 1) - 1;
    this.holding[slot] = -1;
  }

  /** True when the next lane has no room for this car right after the junction. */
  private exitBlocked(slot: number): boolean {
    const next = this.nextLane[slot] ?? -1;
    if (next < 0) return false;
    const k = this.lowerBound(next);
    const o = this.order[k] ?? 0;
    if (k >= this.count || this.lane[o] !== next) return false;
    const room = (this.s[o] ?? 0) - this.graph.laneStart(next) - (MODEL_HALF_LEN[this.model[o] ?? 0] ?? 0);
    return room < 2 * (MODEL_HALF_LEN[this.model[slot] ?? 0] ?? 0) + IDM_S0 + 1;
  }

  /** True when a car on approach `a` is about to cross (moving within `distance` of its line, or crossing). */
  private approachBusy(a: number, distance: number): boolean {
    const e = a >> 1;
    const d = (a & 1) as 0 | 1;
    const g = this.graph;
    for (let i = 0; i < g.laneCount(e, d); i++) {
      const lane = laneRef(e, d, i);
      const o = this.frontCar(lane);
      if (o < 0 || this.state[o] === TRAFFIC_STATE.crashed) continue;
      const toLine = g.laneEnd(lane) - (this.s[o] ?? 0);
      if (toLine < 0 || (toLine < distance && (this.v[o] ?? 0) > 1)) return true;
    }
    return false;
  }

  /** Minor-road gap acceptance: no car on an approach that does not stop is close to the node. */
  private majorRoadClear(node: RoadNode, ownApproach: number): boolean {
    for (let i = 0; i < node.edges.length; i++) {
      const id = node.edges[i] ?? 0;
      const e = this.graph.edges[id] as RoadEdge;
      const a = id * 2 + (e.to === node.id ? 0 : 1);
      if (a === ownApproach || this.control[a] !== CONTROL.none) continue;
      if (this.approachBusy(a, MAJOR_CLEAR_DISTANCE)) return false;
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
    if (ctrl === CONTROL.none) return false;
    const v = this.v[slot] ?? 0;
    const bits = this.behavior[slot] ?? 0;
    const b = MODEL_B[this.model[slot] ?? 0] ?? 2;
    const node = g.nodes[g.laneEndNode(lane)] as RoadNode;

    if (ctrl === CONTROL.signal) {
      const grp = (this.group[a] ?? 0) as 0 | 1;
      const aspect = g.signalAspect(node.signal, grp, this.simTime);
      if (aspect === ASPECT.green) {
        if (d > NEAR_LINE) return false;
        if (this.turn[slot] === TURN.left) {
          const opp = this.oncoming[a] ?? -1;
          if (opp >= 0 && this.approachBusy(opp, LEFT_YIELD_DISTANCE)) return true;
        }
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
          // Cannot stop comfortably: commit.
          this.stopPhase[slot] = STOP_PHASE.cleared;
          return false;
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
    if ((this.nodeHold[node.id] ?? 0) > 0 || this.exitBlocked(slot) || !this.majorRoadClear(node, a)) return true;
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
      return;
    }
    const g = this.graph;
    const m = this.model[slot] ?? 0;
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
    let v0 = limitMph * MPH * (this.desiredFactor[slot] ?? 1);
    if (bits & BEHAVIOR.dui) {
      v0 *= 1 + VIOLATIONS.behaviors.dui.speedJitter * Math.sin((this.weavePhase[slot] ?? 0) * 0.7 + 1);
      b *= DUI_LATE_BRAKE;
    }
    const end = g.laneEnd(lane);
    const next = this.nextLane[slot] ?? -1;
    const turn = this.turn[slot] ?? 0;
    if (next >= 0 && turn !== TURN.straight) {
      const vt = turn === TURN.uturn ? UTURN_SPEED : TURN_SPEED;
      const ahead = Math.max(0, end - s - hl);
      v0 = Math.min(v0, s > end ? vt : Math.sqrt(vt * vt + 2 * b * ahead));
    }

    // Leader: next car on this lane, else the last car on the next lane.
    let gap = Infinity;
    let vLead = 0;
    const leader = k + 1 < this.count ? (this.order[k + 1] ?? 0) : -1;
    if (leader >= 0 && this.lane[leader] === lane) {
      gap = (this.s[leader] ?? 0) - s - hl - (MODEL_HALF_LEN[this.model[leader] ?? 0] ?? 0);
      vLead = this.v[leader] ?? 0;
    } else if (next >= 0) {
      const j = this.lowerBound(next);
      const o = this.order[j] ?? 0;
      if (j < this.count && this.lane[o] === next) {
        gap = end + (this.clen[slot] ?? 0) - s + (this.s[o] ?? 0) - g.laneStart(next) - hl - (MODEL_HALF_LEN[this.model[o] ?? 0] ?? 0);
        vLead = this.v[o] ?? 0;
      }
    }
    if (bits & BEHAVIOR.tailgating && v > TAILGATE_MIN_SPEED && gap < v * TAILGATE_HEADWAY_S) this.report(slot, 'tailgating', focus);

    // The player (car or officer) when it is in the lane ahead.
    if (focus.obstacle) {
      const hx = this.hx[slot] ?? 0, hz = this.hz[slot] ?? 0;
      const dx = focus.ox - (this.x[slot] ?? 0), dz = focus.oz - (this.z[slot] ?? 0);
      const lon = dx * hx + dz * hz;
      const lat = -dx * hz + dz * hx;
      const width = (g.edges[edge] as RoadEdge).laneWidth / 2 + focus.oRadius;
      if (lon > 0 && lon < OBSTACLE_LOOKAHEAD && Math.abs(lat) < width) {
        const og = lon - hl - focus.oRadius;
        if (og < gap) {
          gap = og;
          vLead = Math.max(0, focus.ovx * hx + focus.ovz * hz);
        }
      }
    }
    this.hardGap[slot] = gap;

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
    const s0 = this.s[slot] ?? 0;
    let s = s0 + ds;
    let end = g.laneEnd(lane);
    if (s0 <= end && s > end) this.enterJunction(slot, focus);
    // Leave the connector onto the next lane (a zero-length connector can chain).
    for (let guard = 0; guard < 4; guard++) {
      const next = this.nextLane[slot] ?? -1;
      if (next < 0) {
        if (s > end) s = end;
        break;
      }
      const exit = end + (this.clen[slot] ?? 0);
      if (s < exit) break;
      this.releaseHold(slot);
      s = g.laneStart(next) + (s - exit);
      lane = next;
      this.lane[slot] = lane;
      this.stopPhase[slot] = STOP_PHASE.approach;
      this.stopTimer[slot] = 0;
      this.reported[slot] = 0;
      this.flags[slot] = 0;
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
  }

  /** The car crosses its stop line: hold the node; a red aspect is a red-light violation. */
  private enterJunction(slot: number, focus: TrafficFocus): void {
    const g = this.graph;
    const lane = this.lane[slot] ?? 0;
    const node = g.nodes[g.laneEndNode(lane)] as RoadNode;
    if (node.junction !== JUNCTION.none) this.acquireHold(slot, node.id);
    const a = laneEdge(lane) * 2 + laneDir(lane);
    if (this.control[a] === CONTROL.signal) {
      const aspect = g.signalAspect(node.signal, (this.group[a] ?? 0) as 0 | 1, this.simTime);
      if (aspect === ASPECT.red) this.report(slot, 'redLight', focus);
    }
  }

  /** Pass 3: world pose (lane point or junction connector, plus DUI weave). */
  private pose(slot: number): void {
    const g = this.graph;
    const lane = this.lane[slot] ?? 0;
    const s = this.s[slot] ?? 0;
    const end = g.laneEnd(lane);
    let px: number, pz: number, hx: number, hz: number;
    if (s <= end || (this.nextLane[slot] ?? -1) < 0) {
      const p = g.lanePoint(lane, s, this.lp);
      px = p.x;
      pz = p.z;
      hx = p.hx;
      hz = p.hz;
    } else {
      const len = this.clen[slot] ?? 0;
      const t = len > 0 ? Math.min(1, (s - end) / len) : 1;
      const u = 1 - t;
      const x0 = this.c0x[slot] ?? 0, z0 = this.c0z[slot] ?? 0;
      const x1 = this.c1x[slot] ?? 0, z1 = this.c1z[slot] ?? 0;
      const x2 = this.c2x[slot] ?? 0, z2 = this.c2z[slot] ?? 0;
      px = u * u * x0 + 2 * u * t * x1 + t * t * x2;
      pz = u * u * z0 + 2 * u * t * z1 + t * t * z2;
      const tx = u * (x1 - x0) + t * (x2 - x1);
      const tz = u * (z1 - z0) + t * (z2 - z1);
      const tl = Math.hypot(tx, tz);
      hx = tl > 1e-9 ? tx / tl : (this.hx[slot] ?? 0);
      hz = tl > 1e-9 ? tz / tl : (this.hz[slot] ?? -1);
    }
    let lat = 0;
    if ((this.behavior[slot] ?? 0) & BEHAVIOR.dui) lat = (this.weaveAmp[slot] ?? 0) * Math.sin(this.weavePhase[slot] ?? 0);
    this.lateral[slot] = lat;
    // Right of the heading (hx, hz) is (-hz, hx).
    this.x[slot] = px - hz * lat;
    this.z[slot] = pz + hx * lat;
    this.hx[slot] = hx;
    this.hz[slot] = hz;
    this.yaw[slot] = Math.atan2(-hx, -hz);
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
    if (this.state[slot] === TRAFFIC_STATE.crashed) lights |= LIGHT.hazard;
    else if ((this.accel[slot] ?? 0) < -BRAKE_LIGHT_DECEL || (this.v[slot] ?? 0) < 0.05) lights |= LIGHT.brake;
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

  // --- Events ---------------------------------------------------------------------------------

  /** Emits a violation once per car, kind and edge, only within `observeRadius` of the focus. */
  private report(slot: number, kind: TrafficViolationKind, focus: TrafficFocus): void {
    const bit = VIOLATION_BIT[kind];
    if ((this.reported[slot] ?? 0) & bit || !this.bus) return;
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
    this.state[slot] = TRAFFIC_STATE.crashed;
    this.v[slot] = 0;
    this.speedView[slot] = 0;
    this.accel[slot] = 0;
    this.releaseHold(slot);
    this.proxy[slot]?.setLinvel({ x: 0, y: 0, z: 0 }, true);
    VehicleLook.lights[eid] = (VehicleLook.lights[eid] ?? 0) | LIGHT.hazard;
    this.bus?.emit('traffic:collision', { eid, vehicleId: this.vehicleId[slot] ?? 0, other, impactSpeed });
  }
}
