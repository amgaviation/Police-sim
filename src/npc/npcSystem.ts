import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import { levelY } from '../interior/constants';
import { itemDef } from '../people/items';
import type { Population } from '../people/population';
import type { Intoxication } from '../people/types';
import { unitHash } from '../records/hash';
import { PERSON_POPULATION } from '../records/ids';
import { BODY, FIGURE_FLAG, HELD, POSE, createHumanoidSource } from '../render/people/pose';
import { isFleetVehicleId, type TrafficSystem } from '../traffic/trafficSystem';
import { VEHICLE_MODELS } from '../vehicles/model';
import type { RoadEdge, RoadGraph, RoadHit, RoadNode } from '../world/roadGraph';
import { ambientProfile } from './ambient';
import { complianceChance, understands } from './compliance';
import { NPC_CONFIG, NPC_DENSITY, behavior, findBehavior, type BehaviorProfile, type NpcConfig } from './data';
import { TWO_PI, sampleEdge, yawOf, type EdgeSample } from './geometry';
import { ActorRec, FLAG, NEVER, PedRec } from './pool';
import { isNpcSave } from './save';
import {
  ACTOR_STATE,
  AWARE_REACTIONS,
  type ActorInfo,
  type ActorSave,
  type ActorSpawn,
  type ActorStateId,
  type CommandContext,
  type AwareReaction,
  type CommandOutcome,
  type IncapacitateBy,
  type IndoorNavPort,
  type Listener,
  type NoGoZone,
  type NpcCommand,
  type NpcDeps,
  type NpcFocus,
  type NpcSave,
  type NpcView,
  type PedSave,
  type PersonPick,
  type ResistanceLevel,
  LETHAL_WEAPONS,
} from './types';

/**
 * NPC system (design §8): ambient pedestrians on the sidewalks with tick LOD, scene actors driven by a behaviour
 * state machine (compliance, flee, fight, armed, surrender, cuffs, follow), seated occupants of nearby traffic
 * cars, and one combined read-only render view (pedestrians, then actors, then occupants).
 *
 * Fixed step, main thread. Randomness comes only from the `peds` and `actors` child streams of the injected
 * stream. Nothing allocates per step: pools are preallocated, routes live in per-actor `Float32Array(64)`s and
 * only state changes (spawns, route plans, events) allocate. Events raised inside `step` are queued and emitted
 * when the step is done, so handlers may call back into the system.
 */

/** Seated entries per step. */
const MAX_OCCUPANTS = 48;
/** Waypoints of an actor route. */
const MAX_ROUTE_POINTS = 32;
/** Edge candidates for pedestrian spawns. */
const CANDIDATE_CAP = 1024;
/** Node candidates for flee / leave routes. */
const NODE_CANDIDATE_CAP = 512;
/** Seconds a pedestrian runs away from a drawn weapon, and the distance that triggers it (m). */
const WEAPON_FLEE_S = 10;
const WEAPON_FLEE_M = 20;
/** Offset metres removed per metre walked while a ped blends from one sidewalk corner to the next. */
const PED_CORNER_BLEND = 2.5;
/** Wander radius of idle bystanders around their spawn point (m). */
const WANDER_RADIUS_M = 3;
/** Within this distance resting actors turn to face the officer (m), and their turn rate (rad/s). */
const FACE_RANGE_M = 15;
const TURN_RATE = 5;
/** Armed actors attack from this distance (m), with this chance per action. */
const ATTACK_RANGE_M = 12;
const ATTACK_CHANCE = 0.3;
/** Melee attackers start a fight this close (m). */
const MELEE_RANGE_M = 1.5;
/** Hits within this distance of the officer's position count as "in front" for commands. */
const FIGHT_COMMAND_RANGE_M = 2;
/** Half angle of the tackle cone (rad): the design's 70 degree cone. */
const TACKLE_HALF_CONE = (35 * Math.PI) / 180;
/** Seconds without a view of an occupant cache entry before it is dropped. */
const OCC_CACHE_STEPS = 600;
const OVERRIDE_GRACE_STEPS = 900;
const OVERRIDE_CAP = 64;
/** Door offset beyond the body side (m). */
const DOOR_OFFSET_M = 0.7;
/** Seconds between the path updates of an actor that follows the officer indoors. */
const INDOOR_REPATH_S = 1;
/** An escorted actor placed on a new level stands this far behind the officer (m). */
const FOLLOWER_GAP_M = 1;
/** Within this distance of the officer a `confront` reaction starts a fight (m). */
const CONFRONT_FIGHT_M = 3;
/** Awareness gained per unit of light stimulus (sound and sight count 1). */
const LIGHT_GAIN = 1.5;
/** Eye heights by pose (m). */
const EYE_STAND = 1.6;
const EYE_SIT = 1.1;
const EYE_LYING = 0.3;
const EYE_DOG = 0.5;

const SALT_WALK = 0x4e50_0001;
const SALT_RUN = 0x4e50_0002;
const SALT_STAMINA = 0x4e50_0003;
const SALT_FUR = 0x4e50_0004;

const FUR = [0x8b5a2b, 0x3b2a20, 0xd9c9a3, 0x222222, 0x9a9a9a] as const;
const NO_INTOX: Intoxication = { bac: 0, drug: 'none', level: 0 };
const BALD = 0xffffffff;

/** States in which the officer can still cuff without a fight. */
const CUFFABLE = new Set<number>([
  ACTOR_STATE.handsUp, ACTOR_STATE.kneel, ACTOR_STATE.prone, ACTOR_STATE.down, ACTOR_STATE.hold, ACTOR_STATE.sit,
]);
/** States in which a plain approach triggers the flee / weapon roll. */
const APPROACHABLE = new Set<number>([
  ACTOR_STATE.idle, ACTOR_STATE.wander, ACTOR_STATE.crowd, ACTOR_STATE.talk, ACTOR_STATE.sit,
]);
/** States that cannot run or fight (restrained or helpless). */
const HELPLESS = new Set<number>([
  ACTOR_STATE.cuffed, ACTOR_STATE.down, ACTOR_STATE.prone, ACTOR_STATE.lying, ACTOR_STATE.hide, ACTOR_STATE.seated,
]);
/** States of a loose actor that may be culled when nobody needs it. */
const CULLABLE = new Set<number>([ACTOR_STATE.idle, ACTOR_STATE.wander, ACTOR_STATE.hold, ACTOR_STATE.talk, ACTOR_STATE.crowd, ACTOR_STATE.lying]);
/** A bystander older than this and out of sight goes away (s). */
const BYSTANDER_LIFE_S = 300;
/** States of a person held on the ground or in cuffs: they cannot bolt or fight until released. */
const RESTRAINED = new Set<number>([ACTOR_STATE.cuffed, ACTOR_STATE.down, ACTOR_STATE.prone]);
/** States in which an actor stands still facing the officer when close. */
const FACING = new Set<number>([
  ACTOR_STATE.idle, ACTOR_STATE.talk, ACTOR_STATE.hold, ACTOR_STATE.handsUp, ACTOR_STATE.kneel, ACTOR_STATE.sit, ACTOR_STATE.fight,
]);
/** States the `follow` command can take over. */
const FOLLOWABLE = new Set<number>([
  ACTOR_STATE.idle, ACTOR_STATE.wander, ACTOR_STATE.talk, ACTOR_STATE.hold, ACTOR_STATE.handsUp, ACTOR_STATE.kneel,
  ACTOR_STATE.sit, ACTOR_STATE.walkTo, ACTOR_STATE.follow, ACTOR_STATE.crowd,
]);
/** States of a loose ambient actor that walks away when it stands inside a no-go zone. */
const ZONE_LEAVABLE = new Set<number>([
  ACTOR_STATE.idle, ACTOR_STATE.wander, ACTOR_STATE.hold, ACTOR_STATE.talk, ACTOR_STATE.crowd, ACTOR_STATE.sit, ACTOR_STATE.walkTo,
]);
/** States in which an alert actor snaps round to face a stimulus. */
const TURNABLE = new Set<number>([
  ACTOR_STATE.idle, ACTOR_STATE.wander, ACTOR_STATE.hold, ACTOR_STATE.talk, ACTOR_STATE.crowd, ACTOR_STATE.sit, ACTOR_STATE.handsUp, ACTOR_STATE.kneel,
]);
/** States a tackle cannot reach. */
const UNTACKLEABLE = new Set<number>([
  ACTOR_STATE.cuffed, ACTOR_STATE.down, ACTOR_STATE.prone, ACTOR_STATE.lying, ACTOR_STATE.hide, ACTOR_STATE.seated,
]);

/** Seconds a refused / confused command keeps an actor `passive`. */
const PASSIVE_S = 15;
/** Seconds a cuffing struggle keeps an actor `active`. */
const ACTIVE_S = 10;
/** Seconds an attack keeps an actor `assaultive` (fight) or `lethal` (fire). */
const ATTACK_S = 5;
/** Seconds a seriously wounded actor stays down before kneeling. */
const WOUND_DOWN_S = 60;
/** Wound severity at which an actor goes down instead of staggering. */
const WOUND_DOWN_AT = 0.5;
/** Seconds a minor wound incapacitates. */
const WOUND_STAGGER_S = 3;
/** Persisted resistance ages are dropped beyond this (s): the longest window is 15 s. */
const RESISTANCE_KEEP_S = 30;
/** `ActorRec.attackKind` codes. */
const ATTACK_FIGHT = 0;
const ATTACK_FIRE = 1;
const ATTACK_BRANDISH = 2;

/** Cached render data of the occupants of one vehicle. */
interface OccEntry {
  ids: number[];
  skin: number[];
  hair: number[];
  top: number[];
  bottom: number[];
  height: number[];
  build: number[];
  seen: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function lerp(range: readonly [number, number], u: number): number {
  return range[0] + (range[1] - range[0]) * u;
}

/** HELD kind of a carried weapon item. */
function heldOf(weapon: string): number {
  if (weapon === '') return HELD.none;
  if (weapon === 'handgun') return HELD.handgun;
  if (weapon === 'liquorBottle' || weapon === 'openContainer') return HELD.bottle;
  return HELD.knife;
}

/** Eye height (m) of an actor in `state`. */
function eyeHeight(state: number): number {
  switch (state) {
    case ACTOR_STATE.lying:
    case ACTOR_STATE.prone:
    case ACTOR_STATE.down:
      return EYE_LYING;
    case ACTOR_STATE.sit:
    case ACTOR_STATE.seated:
    case ACTOR_STATE.kneel:
      return EYE_SIT;
    default:
      return EYE_STAND;
  }
}

export class NpcSystem {
  /** Pedestrians, then actors, then seated occupants. */
  readonly view: NpcView;
  readonly stats = { peds: 0, actors: 0, occupants: 0, stepMs: 0, pedUpdates: 0, actorUpdates: 0 };

  private readonly seed: number;
  private readonly cfg: NpcConfig = NPC_CONFIG;
  private readonly graph: RoadGraph;
  private readonly edges: readonly RoadEdge[];
  private readonly people: Population;
  private readonly traffic: TrafficSystem;
  private readonly bus: EventBus<EventMap>;
  private readonly rng: Rng;
  private readonly pedsRng: Rng;
  private readonly actorsRng: Rng;
  private tackleResistance: ResistanceLevel = 'compliant';
  private readonly nowFn: () => number;
  private readonly clockFn: (() => number) | undefined;

  // clocks
  private stepCount = 0;
  private nextActorId = 1;
  private retargetIn = 0;
  private target = 0;
  private densityScale = 1;
  private stepping = false;
  private readonly queue: (() => void)[] = [];

  // the officer, as of the last step
  private fx = 0;
  private fz = 0;
  private fyaw = 0;
  private fspeed = 0;
  private fonFoot = true;
  /** 0 none, 1 sidearm, 2 taser. */
  private fweapon = 0;
  private fbackup = 0;
  private fbuilding = -1;

  // pedestrians
  private readonly peds: PedRec[];
  private pedCount = 0;
  private readonly active = new Set<number>();
  private readonly nearBuf: number[] = [];
  private readonly cand = new Int32Array(CANDIDATE_CAP);
  private readonly candCum = new Float64Array(CANDIDATE_CAP);
  private candN = 0;
  private readonly sample: EdgeSample = { s: 0, x: 0, z: 0, hx: 0, hz: 0 };
  private readonly hit: RoadHit = { edge: 0, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 };

  // actors
  private readonly actors: ActorRec[];
  private actorCount = 0;
  private readonly byId = new Map<number, ActorRec>();
  private readonly nodeBuf: number[] = [];
  private readonly nodeCand = new Int32Array(NODE_CANDIDATE_CAP);
  // scratch registers of the actor step (see updateActors)
  private rdt = 0;
  private rdd = 0;
  private rdist = 0;
  private rd2 = 0;
  private rmoved = 0;
  private gx = 0;
  private gz = 0;
  private gmax = 0;
  private gface = true;
  /** Whether the actor being stepped is on the officer's level. */
  private rsame = true;
  private periodNear = 1;
  private periodMid = 1;
  private periodFar = 1;

  // occupants
  private readonly overrides = new Map<number, number[]>();
  /** Step at which each override was set (not saved): a fresh override gets a grace period before it can be pruned. */
  private readonly overrideSince = new Map<number, number>();
  private readonly outSeats = new Map<number, number[]>();
  private readonly occCache = new Map<number, OccEntry>();
  private readonly occVehicle = new Int32Array(MAX_OCCUPANTS);
  private readonly occSeat = new Int32Array(MAX_OCCUPANTS);
  private readonly occPerson = new Int32Array(MAX_OCCUPANTS);
  private occCount = 0;
  private readonly modelWidth: Float32Array;
  private readonly modelLength: Float32Array;
  private readonly door = { x: 0, z: 0, yaw: 0 };

  // indoors
  private nav: IndoorNavPort | null = null;
  private zones: readonly NoGoZone[] = [];
  private zoneBox = new Float64Array(0);
  private zx = 0;
  private zz = 0;
  private zedge = 0;
  private zs = 0;
  private zside = 1;
  private zox = 0;
  private zoz = 0;
  private readonly pose = { x: 0, z: 0, yaw: 0 };
  private readonly exitRoute = new Float32Array(64);

  constructor(deps: NpcDeps) {
    this.seed = deps.seed;
    this.graph = deps.city.graph;
    this.edges = this.graph.edges;
    this.people = deps.people;
    this.traffic = deps.traffic;
    this.bus = deps.bus;
    this.rng = deps.rng;
    this.pedsRng = deps.rng.stream('peds');
    this.actorsRng = deps.rng.stream('actors');
    this.nowFn = () => deps.now();
    this.clockFn = deps.clock === undefined ? undefined : () => deps.clock?.() ?? 0;
    this.peds = Array.from({ length: this.cfg.peds.max }, () => new PedRec());
    this.actors = Array.from({ length: this.cfg.actors.max }, () => new ActorRec());
    this.view = createHumanoidSource(this.cfg.peds.max + this.cfg.actors.max + MAX_OCCUPANTS);
    this.modelWidth = new Float32Array(VEHICLE_MODELS.length);
    this.modelLength = new Float32Array(VEHICLE_MODELS.length);
    for (let i = 0; i < VEHICLE_MODELS.length; i++) {
      this.modelWidth[i] = VEHICLE_MODELS[i]?.body.width ?? 1.8;
      this.modelLength[i] = VEHICLE_MODELS[i]?.body.length ?? 4.5;
    }
  }

  // --- Fixed step ------------------------------------------------------------------------

  /** One fixed step (system order 60). `simTime` is unused; time-of-day comes from `deps.now()`. */
  step(dt: number, _simTime: number, focus: NpcFocus): void {
    const t0 = this.clockFn ? this.clockFn() : 0;
    this.stepping = true;
    this.fx = focus.x;
    this.fz = focus.z;
    this.fyaw = focus.yaw;
    this.fspeed = focus.speed;
    this.fonFoot = focus.onFoot;
    this.fweapon = focus.weapon === 'sidearm' ? 1 : focus.weapon === 'taser' ? 2 : 0;
    this.fbackup = focus.backup;
    this.fbuilding = focus.building ?? -1;

    for (let i = 0; i < this.pedCount; i++) {
      const p = this.peds[i] as PedRec;
      p.prevX = p.x;
      p.prevZ = p.z;
      p.prevYaw = p.yaw;
    }
    for (let i = 0; i < this.actorCount; i++) {
      const a = this.actors[i] as ActorRec;
      a.prevX = a.x;
      a.prevZ = a.z;
      a.prevYaw = a.yaw;
      a.refusedAge += dt;
      a.resistedAge += dt;
      a.attackedAge += dt;
    }

    this.retargetIn -= dt;
    if (this.retargetIn <= 0) {
      this.retarget();
      this.retargetIn = this.cfg.peds.retargetS;
    }
    this.updatePeds(dt);
    this.spawnPeds();

    const lod = this.cfg.actors.lod;
    this.periodNear = Math.max(1, Math.round(1 / (lod.nearHz * dt)));
    this.periodMid = Math.max(1, Math.round(1 / (lod.midHz * dt)));
    this.periodFar = Math.max(1, Math.round(1 / (lod.farHz * dt)));
    this.updateActors(dt);

    this.publish();
    this.stepCount++;
    this.stepping = false;
    for (let i = 0; i < this.queue.length; i++) (this.queue[i] as () => void)();
    this.queue.length = 0;
    if (this.clockFn) {
      const ms = this.clockFn() - t0;
      this.stats.stepMs = this.stats.stepMs === 0 ? ms : this.stats.stepMs * 0.95 + ms * 0.05;
    }
  }

  /** Raises a payload-less `npc:*` event for `a` (queued inside a step). */
  private note(topic: 'npc:fled' | 'npc:escaped' | 'npc:surrendered' | 'npc:left' | 'npc:revealed', a: ActorRec): void {
    const ev = { actorId: a.id, personId: a.person, callId: a.callId };
    this.fire(() => this.bus.emit(topic, ev));
  }

  private noteAttack(a: ActorRec, kind: 'fight' | 'fire' | 'brandish'): void {
    a.attackedAge = 0;
    a.attackKind = kind === 'fight' ? ATTACK_FIGHT : kind === 'fire' ? ATTACK_FIRE : ATTACK_BRANDISH;
    const ev = { actorId: a.id, personId: a.person, callId: a.callId, kind };
    this.fire(() => this.bus.emit('npc:attack', ev));
  }

  /** Queues `fn` until the end of the current step, or runs it at once outside a step. */
  private fire(fn: () => void): void {
    if (this.stepping) this.queue.push(fn);
    else fn();
  }

  private hourOfDay(): number {
    const t = this.nowFn();
    const s = ((t % 86400) + 86400) % 86400;
    return Math.floor(s / 3600);
  }

  // --- Pedestrians (§8.2) ----------------------------------------------------------------

  /** Target pedestrian count: sidewalk length near the focus x density by district and hour. */
  private retarget(): void {
    const near = this.graph.edgesNear(this.fx, this.fz, this.cfg.peds.spawnRadiusM, this.nearBuf);
    const hourly = NPC_DENSITY.hourly[this.hourOfDay()] ?? 0;
    let sum = 0;
    for (let k = 0; k < near.length; k++) {
      const e = this.edges[near[k] as number] as RoadEdge;
      if (e.sidewalk > 0) sum += e.length * 0.001 * (NPC_DENSITY.perKm[e.district] ?? 0) * hourly * 2;
    }
    this.target = Math.min(this.cfg.peds.max, Math.round(sum * this.densityScale));
    // Seats of vehicles that are gone are free again.
    for (const [vid, seats] of this.outSeats) {
      if (seats.length === 0 || this.traffic.slotOfVehicle(vid) < 0) {
        let held = false;
        for (let i = 0; i < this.actorCount; i++) if ((this.actors[i] as ActorRec).vehicleId === vid) held = true;
        if (!held) this.outSeats.delete(vid);
      }
    }
    // Scenario occupants of cars that left traffic are forgotten (the car respawns with its generated occupants).
    for (const vid of this.overrides.keys()) {
      if (this.stepCount - (this.overrideSince.get(vid) ?? 0) < OVERRIDE_GRACE_STEPS || this.traffic.slotOfVehicle(vid) >= 0) continue;
      let held = false;
      for (let i = 0; i < this.actorCount; i++) if ((this.actors[i] as ActorRec).vehicleId === vid) held = true;
      if (held) continue;
      this.overrides.delete(vid);
      this.overrideSince.delete(vid);
      this.occCache.delete(vid);
      this.outSeats.delete(vid);
    }
  }

  private updatePeds(dt: number): void {
    const cfg = this.cfg.peds;
    const nearSq = cfg.lod.nearM * cfg.lod.nearM;
    const midSq = cfg.lod.midM * cfg.lod.midM;
    const despawnSq = cfg.despawnRadiusM * cfg.despawnRadiusM;
    let updates = 0;
    let farIdx = -1;
    let farSq = 0;
    for (let i = this.pedCount - 1; i >= 0; i--) {
      const p = this.peds[i] as PedRec;
      p.acc += dt;
      const dx = p.x - this.fx;
      const dz = p.z - this.fz;
      const d2 = dx * dx + dz * dz;
      if (d2 > despawnSq || (this.zones.length > 0 && this.pedInZone(p))) {
        this.removePed(i);
        continue;
      }
      const period = d2 < nearSq ? cfg.lod.nearEvery : d2 < midSq ? cfg.lod.midEvery : cfg.lod.farEvery;
      if (period <= 1 || (this.stepCount + i) % period === 0) {
        this.rdt = p.acc;
        this.rd2 = d2;
        this.movePed(p);
        p.acc = 0;
        updates++;
      }
      if (d2 > farSq) {
        farSq = d2;
        farIdx = i;
      }
    }
    this.stats.pedUpdates = updates;
    // Density fell (hour change, teleport): thin out the farthest pedestrian beyond the near ring.
    if (farIdx >= 0 && farIdx < this.pedCount && farSq > nearSq && this.pedCount > this.target + Math.max(4, Math.ceil(this.target * 0.1))) this.removePed(farIdx);
  }

  private movePed(p: PedRec): void {
    const dt = this.rdt;
    if (this.fweapon > 0 && this.rd2 < WEAPON_FLEE_M * WEAPON_FLEE_M) {
      if (p.flee <= 0) this.turnPedAway(p);
      p.flee = WEAPON_FLEE_S;
    }
    const speed = p.flee > 0 ? this.cfg.actors.runSpeed[0] : p.base;
    if (p.flee > 0) p.flee = Math.max(0, p.flee - dt);
    p.speed = speed;
    const zoned = this.zones.length > 0;
    if (zoned) {
      // Remembered for the step back at a no-go zone (scratch registers, not locals: no boxing).
      this.zedge = p.edge;
      this.zs = p.s;
      this.zside = p.side;
      this.zox = p.ox;
      this.zoz = p.oz;
    }
    p.s += p.dir * speed * dt;
    const e = this.edges[p.edge] as RoadEdge;
    if (p.s < 0 || p.s > e.length) {
      const x0 = p.x;
      const z0 = p.z;
      const side0 = p.side;
      this.pedNextEdge(p, e);
      if (p.edge !== e.id) this.blendCorner(p, x0, z0, side0);
    }
    const ol = Math.sqrt(p.ox * p.ox + p.oz * p.oz);
    if (ol > 0) {
      const k = Math.max(0, ol - speed * dt * PED_CORNER_BLEND) / ol;
      p.ox *= k;
      p.oz *= k;
    }
    this.placePed(p);
    if (zoned && this.pedInZone(p)) {
      // Scene tape: step back to where it came from and walk the other way.
      p.edge = this.zedge;
      p.s = this.zs;
      p.side = this.zside;
      p.ox = this.zox;
      p.oz = this.zoz;
      p.dir = -p.dir;
      this.placePed(p);
      p.speed = 0;
      return;
    }
    p.gait += (speed * dt) / ((1.4 * p.height) / 1.75);
  }

  /** Flips the walking direction when it leads towards the officer. */
  private turnPedAway(p: PedRec): void {
    const e = this.edges[p.edge] as RoadEdge;
    this.sample.s = p.s;
    const sm = sampleEdge(e, this.sample);
    if ((p.x - this.fx) * sm.hx * p.dir + (p.z - this.fz) * sm.hz * p.dir < 0) p.dir = -p.dir;
  }

  /** Continues on another edge with a sidewalk at the end node (U-turn when there is none). */
  private pedNextEdge(p: PedRec, e: RoadEdge): void {
    const forward = p.dir > 0;
    const over = forward ? p.s - e.length : -p.s;
    const node = this.graph.nodes[forward ? e.to : e.from] as RoadNode;
    let n = 0;
    for (let k = 0; k < node.edges.length; k++) {
      const id = node.edges[k] as number;
      const c = this.edges[id] as RoadEdge;
      if (id !== p.edge && c.sidewalk > 0 && c.length >= 1) n++;
    }
    if (n === 0) {
      p.dir = -p.dir;
      p.s = clamp(forward ? e.length - over : over, 0, e.length);
      return;
    }
    let pick = this.pedsRng.nextInt(0, n - 1);
    for (let k = 0; k < node.edges.length; k++) {
      const id = node.edges[k] as number;
      const c = this.edges[id] as RoadEdge;
      if (id === p.edge || c.sidewalk <= 0 || c.length < 1) continue;
      if (pick-- > 0) continue;
      p.edge = id;
      if (c.from === node.id) {
        p.dir = 1;
        p.s = clamp(over, 0, c.length);
      } else {
        p.dir = -1;
        p.s = clamp(c.length - over, 0, c.length);
      }
      return;
    }
  }

  /**
   * After a junction turn the sidewalk lines of two edges of different width meet at different corners. Picks the
   * nearer side of the new edge and keeps the remaining gap as an offset that placePed adds and movePed shrinks.
   */
  private blendCorner(p: PedRec, x0: number, z0: number, side0: number): void {
    p.ox = 0;
    p.oz = 0;
    p.side = side0 < 0 ? -1 : 1;
    this.placePed(p);
    const dSame = Math.hypot(p.x - x0, p.z - z0);
    p.side = -p.side;
    this.placePed(p);
    if (Math.hypot(p.x - x0, p.z - z0) >= dSame) {
      p.side = -p.side;
      this.placePed(p);
    }
    p.ox = x0 - p.x;
    p.oz = z0 - p.z;
  }

  /** Writes the world position and yaw from (edge, s, side, dir). */
  private placePed(p: PedRec): void {
    const e = this.edges[p.edge] as RoadEdge;
    this.sample.s = p.s;
    const sm = sampleEdge(e, this.sample);
    const off = p.side * (e.width * 0.5 + e.sidewalk * 0.5);
    p.x = sm.x - sm.hz * off + p.ox;
    p.z = sm.z + sm.hx * off + p.oz;
    p.yaw = yawOf(sm.hx * p.dir, sm.hz * p.dir);
  }

  private spawnPeds(): void {
    const want = Math.min(this.target, this.cfg.peds.max);
    if (this.pedCount >= want) return;
    this.gatherCandidates();
    if (this.candN === 0) return;
    let spawned = 0;
    while (this.pedCount < want && spawned < this.cfg.peds.spawnPerStep) {
      if (!this.trySpawnPed()) break;
      spawned++;
    }
  }

  private gatherCandidates(): void {
    const near = this.graph.edgesNear(this.fx, this.fz, this.cfg.peds.spawnRadiusM, this.nearBuf);
    let n = 0;
    let total = 0;
    for (let k = 0; k < near.length && n < CANDIDATE_CAP; k++) {
      const e = this.edges[near[k] as number] as RoadEdge;
      if (e.sidewalk <= 0 || e.length < 1) continue;
      total += e.length;
      this.cand[n] = e.id;
      this.candCum[n] = total;
      n++;
    }
    this.candN = n;
  }

  private trySpawnPed(): boolean {
    const cfg = this.cfg.peds;
    const rng = this.pedsRng;
    const p = this.peds[this.pedCount] as PedRec;
    const total = this.candCum[this.candN - 1] ?? 0;
    const minSq = cfg.minSpawnM * cfg.minSpawnM;
    const maxSq = cfg.spawnRadiusM * cfg.spawnRadiusM;
    for (let attempt = 0; attempt < 3; attempt++) {
      const u = rng.next() * total;
      let k = 0;
      while (k < this.candN - 1 && (this.candCum[k] ?? 0) < u) k++;
      const e = this.edges[this.cand[k] as number] as RoadEdge;
      p.edge = e.id;
      p.s = rng.next() * e.length;
      p.side = rng.next() < 0.5 ? -1 : 1;
      p.dir = rng.next() < 0.5 ? -1 : 1;
      p.ox = 0;
      p.oz = 0;
      this.placePed(p);
      const dx = p.x - this.fx;
      const dz = p.z - this.fz;
      const d2 = dx * dx + dz * dz;
      if (d2 < minSq || d2 > maxSq) continue;
      if (this.zones.length > 0 && this.pedInZone(p)) continue;
      let person = -1;
      for (let t = 0; t < 4 && person < 0; t++) {
        const id = rng.nextInt(0, PERSON_POPULATION - 1);
        if (this.pedAllowed(id)) person = id;
      }
      if (person < 0) return false;
      p.person = person;
      p.base = lerp(cfg.walkSpeed, rng.next());
      p.flee = 0;
      p.acc = 0;
      p.speed = p.base;
      p.gait = rng.next();
      this.dressPed(p, person);
      p.prevX = p.x;
      p.prevZ = p.z;
      p.prevYaw = p.yaw;
      this.active.add(person);
      this.pedCount++;
      return true;
    }
    return false;
  }

  private dressPed(p: PedRec, person: number): void {
    const ap = this.people.appearance(person);
    p.height = ap.heightM;
    p.build = ap.build;
    p.skin = ap.skin;
    p.hair = ap.hair === null ? BALD : ap.hair;
    p.top = ap.top;
    p.bottom = ap.bottom;
  }

  /** May this person appear as a pedestrian now (not active, free, alive, not a juvenile at night)? */
  private pedAllowed(id: number): boolean {
    if (this.isActivePerson(id)) return false;
    const st = this.people.state(id);
    if (st.deceased || st.missing) return false;
    if (st.custody === 'arrested' || st.custody === 'jailed' || st.custody === 'hospital') return false;
    const hour = this.hourOfDay();
    if ((hour >= 23 || hour < 5) && this.people.identity(id).juvenile) return false;
    return true;
  }

  private removePed(i: number): void {
    const p = this.peds[i] as PedRec;
    this.active.delete(p.person);
    const last = this.pedCount - 1;
    this.peds[i] = this.peds[last] as PedRec;
    this.peds[last] = p;
    this.pedCount = last;
  }

  /**
   * Turns pedestrian `slot` (an index of the pedestrian pool: 0 .. peds - 1, also its index in `view`) into an
   * actor with the `bystander` profile at its position; returns the actor id, 0 when the slot is invalid or the
   * actor pool is full.
   */
  promotePedestrian(slot: number): number {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.pedCount) return 0;
    if (this.actorCount >= this.cfg.actors.max) return 0;
    const p = this.peds[slot] as PedRec;
    const person = p.person;
    const x = p.x;
    const z = p.z;
    const yaw = p.yaw;
    this.removePed(slot);
    return this.spawnActor({
      personId: person, x, z, yaw, profile: this.ambientProfile(person, 'bystander'), role: 'bystander', callId: 0, hidden: false, body: 'human', weapon: null, vehicleId: -1,
    });
  }

  /** The profile `base` adjusted by who `personId` is (temperament, mental health, warrants, drink); see `ambientProfile`. */
  ambientProfile(personId: number, base: string): string {
    if (personId < 0) return base;
    return ambientProfile(this.people.identity(personId), this.people.intoxication(personId).bac, base);
  }

  // --- Actors: lifecycle ---------------------------------------------------------------

  /**
   * Adds a scene actor; returns its id, 0 when the pool is full. A person who is already an actor returns that
   * actor's id; a person who is a pedestrian is taken out of the pedestrian pool first.
   */
  spawnActor(spec: ActorSpawn): number {
    const profile = findBehavior(spec.profile);
    if (!profile) throw new RangeError(`spawnActor: unknown profile "${spec.profile}"`);
    const person = spec.personId;
    if (!Number.isInteger(person) || person < -1 || person >= PERSON_POPULATION) throw new RangeError(`spawnActor: invalid person id ${String(person)}`);
    if (spec.building !== undefined && (!Number.isInteger(spec.building) || spec.building < -1)) throw new RangeError(`spawnActor: invalid building ${String(spec.building)}`);
    if (person >= 0) {
      for (let i = 0; i < this.actorCount; i++) {
        const other = this.actors[i] as ActorRec;
        if (other.person === person) return other.id;
      }
      for (let i = 0; i < this.pedCount; i++) {
        if ((this.peds[i] as PedRec).person === person) {
          this.removePed(i);
          break;
        }
      }
      // A scenario occupant who becomes an actor has left the car (the seat numbers stay).
      this.markOut(person);
    }
    if (this.actorCount >= this.cfg.actors.max) return 0;
    const a = this.actors[this.actorCount] as ActorRec;
    this.resetActor(a);
    a.id = this.nextActorId++;
    a.person = person;
    a.role = spec.role;
    a.callId = spec.callId;
    a.profile = profile;
    a.x = a.prevX = spec.x;
    a.z = a.prevZ = spec.z;
    a.yaw = a.prevYaw = spec.yaw;
    a.stress = profile.stress;
    a.weapon = spec.weapon ?? '';
    if (a.weapon !== '') a.flags |= FLAG.armed;
    a.vehicleId = spec.vehicleId;
    a.body = spec.body === 'dog' ? BODY.dog : BODY.human;
    a.tx = spec.x;
    a.tz = spec.z;
    a.building = spec.building ?? -1;
    this.derive(a);
    a.stamina = a.staminaMax;
    const pose = spec.pose ?? profile.startPose;
    if (spec.hidden) {
      a.flags |= FLAG.hidden;
      a.state = ACTOR_STATE.hide;
    } else {
      a.state = this.restingState(profile, pose, a.building >= 0);
    }
    if (a.state === ACTOR_STATE.wander || a.state === ACTOR_STATE.crowd) this.pickGoal(a);
    this.byId.set(a.id, a);
    if (person >= 0) this.active.add(person);
    this.actorCount++;
    return a.id;
  }

  /** The state a visible actor of `profile` rests in: the pose it starts in, else crowd, wander or idle (idle indoors). */
  private restingState(profile: BehaviorProfile, pose: string, indoors = false): number {
    if (pose === 'lying') return ACTOR_STATE.lying;
    if (pose === 'sit') return ACTOR_STATE.sit;
    if (pose === 'kneel') return ACTOR_STATE.kneel;
    if (indoors) return ACTOR_STATE.idle;
    if (profile.crowd) return ACTOR_STATE.crowd;
    return profile.wander ? ACTOR_STATE.wander : ACTOR_STATE.idle;
  }

  private resetActor(a: ActorRec): void {
    a.id = 0;
    a.person = -1;
    a.role = '';
    a.callId = 0;
    a.state = ACTOR_STATE.idle;
    a.speed = 0;
    a.gait = 0;
    a.stress = 0;
    a.timer = 0;
    a.stamina = 0;
    a.flags = 0;
    a.weapon = '';
    a.vehicleId = -1;
    a.seat = -1;
    a.body = BODY.human;
    a.routeLen = 0;
    a.routePos = 0;
    a.lost = 0;
    a.acc = 0;
    a.age = 0;
    a.building = -1;
    a.aware = 0;
    a.awareLevel = 0;
    a.hideSpot = -1;
    a.refusedAge = NEVER;
    a.resistedAge = NEVER;
    a.attackedAge = NEVER;
    a.attackKind = ATTACK_FIGHT;
    a.srcX = 0;
    a.srcZ = 0;
  }

  /** Values derived from the person (or the actor id): speeds, stamina, look, flee bonus. */
  private derive(a: ActorRec): void {
    const cfg = this.cfg.actors;
    a.walkSpeed = lerp(cfg.walkSpeed, unitHash(this.seed, SALT_WALK, a.id));
    a.runSpeed = lerp(cfg.runSpeed, unitHash(this.seed, SALT_RUN, a.id));
    a.staminaMax = lerp(cfg.staminaS, unitHash(this.seed, SALT_STAMINA, a.id));
    a.fleeBonus = 0;
    a.hearing = 'normal';
    if (a.body === BODY.dog) {
      a.height = 0.6;
      a.build = 1;
      a.skin = 0;
      a.hair = BALD;
      a.top = FUR[Math.floor(unitHash(this.seed, SALT_FUR, a.id) * FUR.length)] ?? FUR[0];
      a.bottom = a.top;
      return;
    }
    if (a.person >= 0) {
      const ap = this.people.appearance(a.person);
      a.height = ap.heightM;
      a.build = ap.build;
      a.skin = ap.skin;
      a.hair = ap.hair === null ? BALD : ap.hair;
      a.top = ap.top;
      a.bottom = ap.bottom;
      const ident = this.people.identity(a.person);
      a.hearing = ident.hearing;
      if (ident.wanted) a.fleeBonus += 0.15;
      if (ident.juvenile) a.fleeBonus += 0.1;
      const items = this.people.itemsOn(a.person);
      for (let i = 0; i < items.length; i++) {
        if (itemDef((items[i] as { item: string }).item).contraband) {
          a.fleeBonus += 0.1;
          break;
        }
      }
    } else {
      a.height = 1.75;
      a.build = 1;
      a.skin = 0xc68642;
      a.hair = 0x4b3621;
      a.top = 0x7a7a7a;
      a.bottom = 0x34507a;
    }
  }

  /** Removes the actor (left, transported, caged). Does nothing for an unknown id. */
  removeActor(id: number): void {
    const a = this.byId.get(id);
    if (!a) return;
    this.removeActorRec(a);
  }

  private removeActorRec(a: ActorRec): void {
    let i = -1;
    for (let k = 0; k < this.actorCount; k++) {
      if (this.actors[k] === a) {
        i = k;
        break;
      }
    }
    if (i < 0) return;
    this.byId.delete(a.id);
    if (a.person >= 0) this.active.delete(a.person);
    this.releaseSpot(a);
    const last = this.actorCount - 1;
    this.actors[i] = this.actors[last] as ActorRec;
    this.actors[last] = a;
    this.actorCount = last;
  }

  // --- Actors: queries -----------------------------------------------------------------

  /**
   * The person nearest to (x, z) within `maxDist` and inside the cone around `yaw` (`coneCos` = cosine of the
   * half angle): actors that are not hidden, pedestrians and occupants of the traffic-stop car. Only people on
   * `building` count (default -1: outdoors, where the pedestrians and occupants are).
   */
  nearestPerson(x: number, z: number, yaw: number, maxDist: number, coneCos: number, out: PersonPick, building = -1): PersonPick | null {
    const hx = -Math.sin(yaw);
    const hz = -Math.cos(yaw);
    let best = maxDist;
    let found = false;
    for (let i = 0; i < this.actorCount; i++) {
      const a = this.actors[i] as ActorRec;
      if ((a.flags & FLAG.hidden) !== 0 || a.state === ACTOR_STATE.seated || a.building !== building) continue;
      const d = this.inCone(a.x, a.z, x, z, hx, hz, best, coneCos);
      if (d < 0) continue;
      best = d;
      found = true;
      out.kind = 'actor';
      out.id = a.id;
      out.seat = a.seat;
      out.personId = a.person;
      out.distance = d;
    }
    if (building >= 0) return found ? out : null;
    for (let i = 0; i < this.pedCount; i++) {
      const p = this.peds[i] as PedRec;
      const d = this.inCone(p.x, p.z, x, z, hx, hz, best, coneCos);
      if (d < 0) continue;
      best = d;
      found = true;
      out.kind = 'ped';
      out.id = i;
      out.seat = -1;
      out.personId = p.person;
      out.distance = d;
    }
    const stopId = this.traffic.stopVehicleId;
    if (stopId >= 0) {
      const slot = this.traffic.slotOfVehicle(stopId);
      if (slot >= 0) {
        const ids = this.occupantIds(stopId);
        const seats = this.cfg.occupants.seats;
        for (let k = 0; k < ids.length && k < seats.length; k++) {
          if (this.isOut(stopId, k)) continue;
          this.seatWorld(slot, k);
          const d = this.inCone(this.door.x, this.door.z, x, z, hx, hz, best, coneCos);
          if (d < 0) continue;
          best = d;
          found = true;
          out.kind = 'occupant';
          out.id = stopId;
          out.seat = k;
          out.personId = ids[k] as number;
          out.distance = d;
        }
      }
    }
    return found ? out : null;
  }

  /** Distance when (px, pz) is within `maxDist` of (x, z) and inside the cone, else -1. */
  private inCone(px: number, pz: number, x: number, z: number, hx: number, hz: number, maxDist: number, coneCos: number): number {
    const dx = px - x;
    const dz = pz - z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > maxDist) return -1;
    if (d > 1e-6 && (dx * hx + dz * hz) / d < coneCos) return -1;
    return d;
  }

  /** Fills `out` with actor `id`; null for an unknown id. */
  actor(id: number, out: ActorInfo): ActorInfo | null {
    const a = this.byId.get(id);
    if (!a) return null;
    out.id = a.id;
    out.personId = a.person;
    out.role = a.role;
    out.callId = a.callId;
    out.state = a.state as ActorStateId;
    out.x = a.x;
    out.z = a.z;
    out.yaw = a.yaw;
    out.stress = a.stress;
    out.cuffed = (a.flags & FLAG.cuffed) !== 0;
    out.following = (a.flags & FLAG.following) !== 0;
    out.hidden = (a.flags & FLAG.hidden) !== 0;
    out.armed = (a.flags & FLAG.armed) !== 0;
    out.weaponDrawn = (a.flags & FLAG.weaponDrawn) !== 0;
    out.vehicleId = a.vehicleId;
    out.seat = a.seat;
    out.profile = a.profile.id;
    out.body = a.body;
    out.building = a.building;
    out.aware = a.aware;
    out.dead = (a.flags & FLAG.dead) !== 0;
    out.resistance = this.resistanceOf(a);
    return out;
  }

  /**
   * How hard actor `id` resists now (design §4.2, first match wins): `lethal` drawn lethal weapon or a shot in the
   * last 5 s, `assaultive` fighting / other weapon drawn / a struggle in the last 5 s, `active` fleeing or a cuffing
   * struggle in the last 10 s, `passive` a refused or confused command in the last 15 s, else `compliant` (also a body
   * and unknown ids).
   */
  resistance(id: number): ResistanceLevel {
    const a = this.byId.get(id);
    return a ? this.resistanceOf(a) : 'compliant';
  }

  private resistanceOf(a: ActorRec): ResistanceLevel {
    if ((a.flags & FLAG.dead) !== 0) return 'compliant';
    const attacked = a.attackedAge <= ATTACK_S;
    if (a.state === ACTOR_STATE.armed && (a.flags & FLAG.weaponDrawn) !== 0 && (LETHAL_WEAPONS as readonly string[]).includes(a.weapon)) return 'lethal';
    if (attacked && a.attackKind === ATTACK_FIRE) return 'lethal';
    if (a.state === ACTOR_STATE.fight || a.state === ACTOR_STATE.armed || (attacked && a.attackKind === ATTACK_FIGHT)) return 'assaultive';
    if (a.state === ACTOR_STATE.flee || a.resistedAge <= ACTIVE_S) return 'active';
    if (a.refusedAge <= PASSIVE_S) return 'passive';
    return 'compliant';
  }

  /** Clears `out` and fills it with the ids of all actors (pool order). */
  actorIds(out: number[]): number[] {
    out.length = 0;
    for (let i = 0; i < this.actorCount; i++) out.push((this.actors[i] as ActorRec).id);
    return out;
  }

  /** Actor id of a person, 0 when the person is not an actor. */
  actorOfPerson(personId: number): number {
    if (personId < 0) return 0;
    for (let i = 0; i < this.actorCount; i++) {
      const a = this.actors[i] as ActorRec;
      if (a.person === personId) return a.id;
    }
    return 0;
  }

  /** Clears `out` and fills it with the ids of the actors of call `callId`. */
  actorsOfCall(callId: number, out: number[]): number[] {
    out.length = 0;
    for (let i = 0; i < this.actorCount; i++) {
      const a = this.actors[i] as ActorRec;
      if (a.callId === callId) out.push(a.id);
    }
    return out;
  }

  /** Clears `out` and fills it with the ids of the actors in building `buildingId` (-1: outdoors). */
  actorsInBuilding(buildingId: number, out: number[]): number[] {
    out.length = 0;
    for (let i = 0; i < this.actorCount; i++) {
      const a = this.actors[i] as ActorRec;
      if (a.building === buildingId) out.push(a.id);
    }
    return out;
  }

  /** Is the person a pedestrian, an actor or a seated occupant right now? */
  isActivePerson(personId: number): boolean {
    if (this.active.has(personId)) return true;
    for (let i = 0; i < this.occCount; i++) if (this.occPerson[i] === personId) return true;
    return false;
  }

  // --- Actors: setters -----------------------------------------------------------------

  /** Makes a hidden actor visible (idle) and rolls its approach reaction. */
  reveal(id: number): void {
    const a = this.byId.get(id);
    if (!a || (a.flags & FLAG.hidden) === 0) return;
    this.revealRec(a);
  }

  private revealRec(a: ActorRec): void {
    this.unhide(a);
    this.approachRoll(a);
  }

  /** Comes out of hiding: frees a claimed hiding spot, takes the resting pose and raises `npc:revealed`. */
  private unhide(a: ActorRec): void {
    a.flags &= ~FLAG.hidden;
    this.releaseSpot(a);
    if (a.state === ACTOR_STATE.hide) {
      // Out of hiding the actor takes the pose it would have had in plain view (a body stays lying).
      a.state = this.restingState(a.profile, a.profile.startPose, a.building >= 0);
      if (a.state === ACTOR_STATE.wander || a.state === ACTOR_STATE.crowd) this.pickGoal(a);
    }
    this.note('npc:revealed', a);
  }

  /** Gives a claimed hiding spot back to the nav port. */
  private releaseSpot(a: ActorRec): void {
    if (a.hideSpot < 0) return;
    this.nav?.releaseHide(a.building, a.hideSpot);
    a.hideSpot = -1;
  }

  setProfile(id: number, profile: string): void {
    const a = this.byId.get(id);
    if (!a) return;
    a.profile = behavior(profile);
  }

  /** Gives a live actor a weapon (an escalation: the suspect now has a knife); it is not drawn yet. */
  arm(id: number, weapon: string): void {
    const a = this.byId.get(id);
    if (!a || weapon === '' || a.weapon !== '') return;
    a.weapon = weapon;
    a.flags |= FLAG.armed;
  }

  setStress(id: number, stress: number): void {
    const a = this.byId.get(id);
    if (a) a.stress = clamp(Number.isFinite(stress) ? stress : 0, 0, 1);
  }

  setRole(id: number, role: string, callId: number): void {
    const a = this.byId.get(id);
    if (!a) return;
    a.role = role;
    a.callId = callId;
  }

  // --- Commands (§8.4) -----------------------------------------------------------------

  /**
   * Rolls how actor `id` reacts to `cmd`: understanding, then compliance, then (unless restrained) a flee roll
   * and, for hostile people within 2 m, a fight roll. Draws from the actors stream: fixed steps only.
   */
  evaluateCommand(id: number, cmd: NpcCommand, ctx: CommandContext): CommandOutcome {
    const a = this.byId.get(id);
    if (!a) return 'refuse';
    if (cmd === 'release' || cmd === 'returnToVehicle') return 'comply';
    if (a.state === ACTOR_STATE.lying || (a.flags & FLAG.hidden) !== 0) return 'refuse';
    const ident = a.person >= 0 ? this.people.identity(a.person) : null;
    const intox = a.person >= 0 ? this.people.intoxication(a.person) : NO_INTOX;
    const rng = this.actorsRng;
    if (rng.next() >= understands(ident, ctx.commMode, cmd)) return 'confused';
    if (rng.next() < complianceChance(a.profile, ident, intox, a.stress, ctx, cmd)) return 'comply';
    if (HELPLESS.has(a.state)) return 'refuse';
    const fleeP = a.profile.fleeChance + (ident?.wanted ? 0.15 : 0);
    if (fleeP > 0 && rng.next() < fleeP) return 'flee';
    if (a.profile.demeanor === 'hostile' && a.profile.fightChance > 0) {
      const dx = a.x - this.fx;
      const dz = a.z - this.fz;
      if (dx * dx + dz * dz <= FIGHT_COMMAND_RANGE_M * FIGHT_COMMAND_RANGE_M && rng.next() < a.profile.fightChance) return 'fight';
    }
    return 'refuse';
  }

  /** Carries out the result of `evaluateCommand`. */
  applyCommand(id: number, cmd: NpcCommand, outcome: CommandOutcome): void {
    const a = this.byId.get(id);
    if (!a || (a.flags & FLAG.dead) !== 0) return;
    if ((outcome === 'refuse' || outcome === 'confused') && a.state !== ACTOR_STATE.lying) a.refusedAge = 0;
    if (outcome === 'confused') return;
    if (outcome === 'refuse') {
      if (a.state !== ACTOR_STATE.lying) a.stress = Math.min(1, a.stress + 0.1);
      return;
    }
    if (outcome === 'flee') {
      if (!HELPLESS.has(a.state) && a.state !== ACTOR_STATE.flee) this.startFlee(a);
      return;
    }
    if (outcome === 'fight') {
      if (!HELPLESS.has(a.state) && a.state !== ACTOR_STATE.fight) this.startFight(a);
      return;
    }
    this.comply(a, cmd);
  }

  private comply(a: ActorRec, cmd: NpcCommand): void {
    const dog = a.body === BODY.dog;
    const cuffed = a.state === ACTOR_STATE.cuffed;
    if (a.state === ACTOR_STATE.lying || a.state === ACTOR_STATE.hide || a.state === ACTOR_STATE.fight) return;
    switch (cmd) {
      case 'stop':
      case 'stayBack':
        if (cuffed) a.flags &= ~FLAG.following;
        else if (a.state !== ACTOR_STATE.armed && a.state !== ACTOR_STATE.down && a.state !== ACTOR_STATE.prone && a.state !== ACTOR_STATE.seated) this.setHold(a);
        break;
      case 'handsUp':
      case 'showHands':
        if (cuffed || dog || a.state === ACTOR_STATE.seated) break;
        if (a.state === ACTOR_STATE.armed) this.dropWeaponRec(a);
        this.setPose(a, ACTOR_STATE.handsUp);
        break;
      case 'getDown':
        if (cuffed || dog || a.state === ACTOR_STATE.seated) break;
        if (a.state === ACTOR_STATE.armed) this.dropWeaponRec(a);
        this.setPose(a, a.state === ACTOR_STATE.kneel || a.state === ACTOR_STATE.prone || a.state === ACTOR_STATE.down ? ACTOR_STATE.prone : ACTOR_STATE.kneel);
        break;
      case 'turnAround': {
        const dx = a.x - this.fx;
        const dz = a.z - this.fz;
        a.yaw = dx * dx + dz * dz > 1e-6 ? yawOf(dx, dz) : a.yaw;
        a.flags |= FLAG.faceAway;
        break;
      }
      case 'comeHere':
        if (cuffed || dog || HELPLESS.has(a.state)) break;
        this.startWalkTo(a, this.fx - Math.sin(this.fyaw) * 1.5, this.fz - Math.cos(this.fyaw) * 1.5);
        break;
      case 'followMe':
        this.followRec(a, true);
        break;
      case 'sitDown':
        if (cuffed || dog || a.state === ACTOR_STATE.seated) break;
        this.setPose(a, ACTOR_STATE.sit);
        break;
      case 'stepOut':
        if (a.state === ACTOR_STATE.seated) {
          this.doorOf(a);
          a.x = this.door.x;
          a.z = this.door.z;
          a.yaw = this.door.yaw;
          this.setHold(a);
        }
        break;
      case 'dropWeapon':
        if (a.weapon !== '') this.dropWeaponRec(a);
        if (!cuffed && !dog && a.state !== ACTOR_STATE.seated) this.setPose(a, ACTOR_STATE.handsUp);
        break;
      case 'leaveArea':
      case 'disperse':
      case 'release':
        if (!cuffed || cmd === 'release') this.startLeave(a);
        break;
      case 'calmDown':
        a.stress = Math.max(0, a.stress - 0.2);
        break;
      case 'turnOffEngine':
      case 'tossKeys':
        break;
      case 'walkBackward': {
        if (cuffed || dog || HELPLESS.has(a.state)) break;
        const dx = this.fx - a.x;
        const dz = this.fz - a.z;
        const d = Math.sqrt(dx * dx + dz * dz);
        if (d < 1e-3) break;
        const walk = Math.max(0, Math.min(6, d - 1));
        this.startWalkTo(a, a.x + (dx / d) * walk, a.z + (dz / d) * walk);
        a.flags |= FLAG.backward | FLAG.faceAway;
        a.yaw = yawOf(-dx, -dz);
        break;
      }
      case 'returnToVehicle':
        if (a.vehicleId >= 0 && a.seat >= 0) {
          this.doorOf(a);
          if (this.door.x !== 0 || this.door.z !== 0) {
            this.startWalkTo(a, this.door.x, this.door.z);
            a.flags |= FLAG.returning;
          }
        }
        break;
    }
  }

  /** Forces an actor into `state`; flee, fight and armed raise their events like a natural transition. */
  forceState(id: number, state: 'flee' | 'fight' | 'armed' | 'handsUp' | 'kneel' | 'prone' | 'leave' | 'lying' | 'crowd' | 'hold' | 'idle'): void {
    const a = this.byId.get(id);
    if (!a || (a.flags & FLAG.dead) !== 0) return;
    // Restrained and helpless people cannot bolt or fight (cuffs only come off through `uncuff`).
    if ((state === 'flee' || state === 'fight') && ((a.flags & FLAG.cuffed) !== 0 || RESTRAINED.has(a.state))) return;
    switch (state) {
      case 'flee':
        this.startFlee(a);
        break;
      case 'fight':
        this.startFight(a);
        break;
      case 'armed':
        this.startArmed(a);
        break;
      case 'handsUp':
        this.setPose(a, ACTOR_STATE.handsUp);
        break;
      case 'kneel':
        this.setPose(a, ACTOR_STATE.kneel);
        break;
      case 'prone':
        this.setPose(a, ACTOR_STATE.prone);
        break;
      case 'leave':
        // A body or an unconscious person does not get up and walk away (the stretcher or the cull takes them).
        if (a.state !== ACTOR_STATE.lying) this.startLeave(a);
        break;
      case 'lying':
        this.setPose(a, ACTOR_STATE.lying);
        break;
      case 'crowd':
        a.tx = a.x;
        a.tz = a.z;
        if (a.building >= 0) {
          this.setHold(a);
          break;
        }
        this.setPose(a, ACTOR_STATE.crowd);
        this.pickGoal(a);
        break;
      case 'hold':
        this.setHold(a);
        break;
      case 'idle':
        // Back to the profile's own behaviour (an ambient occupant returned home).
        if (a.state === ACTOR_STATE.hold) this.setPose(a, ACTOR_STATE.idle);
        break;
    }
  }

  /** Cuffs a restrained or compliant actor ('ok'); otherwise rolls the fight chance ('resist' starts a fight, else 'notReady'). */
  cuff(id: number): 'ok' | 'resist' | 'notReady' {
    const a = this.byId.get(id);
    if (!a || a.body === BODY.dog) return 'notReady';
    if (a.state === ACTOR_STATE.cuffed) return 'ok';
    if (CUFFABLE.has(a.state)) {
      if ((a.flags & FLAG.weaponDrawn) !== 0) this.dropWeaponRec(a);
      a.state = ACTOR_STATE.cuffed;
      a.flags = (a.flags & ~(FLAG.following | FLAG.advance | FLAG.backward | FLAG.returning | FLAG.wounded)) | FLAG.cuffed;
      a.speed = 0;
      return 'ok';
    }
    switch (a.state) {
      case ACTOR_STATE.idle:
      case ACTOR_STATE.wander:
      case ACTOR_STATE.talk:
      case ACTOR_STATE.crowd:
      case ACTOR_STATE.walkTo:
      case ACTOR_STATE.follow:
      case ACTOR_STATE.leave:
        if (a.profile.fightChance > 0 && this.actorsRng.next() < a.profile.fightChance) {
          a.resistedAge = 0;
          this.startFight(a);
          return 'resist';
        }
        return 'notReady';
      default:
        return 'notReady';
    }
  }

  uncuff(id: number): boolean {
    const a = this.byId.get(id);
    if (!a || a.state !== ACTOR_STATE.cuffed) return false;
    a.flags &= ~(FLAG.cuffed | FLAG.following);
    a.state = ACTOR_STATE.hold;
    a.speed = 0;
    return true;
  }

  /** Makes a cuffed or compliant actor walk behind the officer (`on`) or stop doing so. False when it cannot. */
  follow(id: number, on: boolean): boolean {
    const a = this.byId.get(id);
    if (!a) return false;
    if (!on) {
      a.flags &= ~FLAG.following;
      if (a.state === ACTOR_STATE.follow) this.setHold(a);
      return true;
    }
    return this.followRec(a, true);
  }

  private followRec(a: ActorRec, on: boolean): boolean {
    if (!on || a.body === BODY.dog) return false;
    if (a.state === ACTOR_STATE.cuffed) {
      a.flags |= FLAG.following;
      a.repath = 0;
      return true;
    }
    if (!FOLLOWABLE.has(a.state)) return false;
    a.repath = 0;
    a.state = ACTOR_STATE.follow;
    a.flags = (a.flags | FLAG.following) & ~(FLAG.backward | FLAG.faceAway | FLAG.returning | FLAG.advance);
    return true;
  }

  /**
   * Brings down the nearest actor in front of the officer (within `tackleRangeM` and the 70 degree cone) who is
   * standing or running; returns its id, 0 when there is none.
   */
  tackle(officerX: number, officerZ: number, officerYaw: number, building = -1): number {
    const hx = -Math.sin(officerYaw);
    const hz = -Math.cos(officerYaw);
    const cos = Math.cos(TACKLE_HALF_CONE);
    let best: ActorRec | null = null;
    let bestD = this.cfg.actors.tackleRangeM;
    for (let i = 0; i < this.actorCount; i++) {
      const a = this.actors[i] as ActorRec;
      if (a.body === BODY.dog || a.building !== building || (a.flags & FLAG.hidden) !== 0 || UNTACKLEABLE.has(a.state)) continue;
      const d = this.inCone(a.x, a.z, officerX, officerZ, hx, hz, bestD, cos);
      if (d < 0) continue;
      bestD = d;
      best = a;
    }
    if (!best) return 0;
    this.tackleResistance = this.resistanceOf(best);
    this.takeDown(best, this.cfg.actors.tackleDownS, 'tackle');
    return best.id;
  }

  /** The resistance of the actor the last successful `tackle` brought down, sampled before the takedown. */
  get lastTackleResistance(): ResistanceLevel {
    return this.tackleResistance;
  }

  /**
   * CED shot at actor `id` from `distance`: within `taserRangeM` it hits with `taserHit` and brings the actor down.
   * With `building` given the actor must be on that level.
   */
  taser(id: number, distance: number, building?: number): boolean {
    const a = this.byId.get(id);
    if (!a || (building !== undefined && a.building !== building) || a.body === BODY.dog || (a.flags & FLAG.hidden) !== 0 || UNTACKLEABLE.has(a.state)) return false;
    if (!(distance <= this.cfg.actors.taserRangeM)) return false;
    if (this.actorsRng.next() >= this.cfg.actors.taserHit) return false;
    this.takeDown(a, this.cfg.actors.taserDownS, 'taser');
    return true;
  }

  /**
   * Puts actor `id` down for `seconds` after an officer's use of force (like a tackle: a drawn weapon is dropped, state
   * `down`, `npc:caught` with `by: 'force'`). False for unknown, hidden, dog and already restrained / helpless actors
   * (cuffed, down, prone, lying, hiding, seated); armed actors can be put down by any tool.
   */
  incapacitate(id: number, seconds: number, _by: IncapacitateBy): boolean {
    const a = this.byId.get(id);
    if (!a || a.body === BODY.dog || (a.flags & FLAG.hidden) !== 0 || UNTACKLEABLE.has(a.state)) return false;
    this.takeDown(a, Math.max(0, seconds), 'force');
    return true;
  }

  /**
   * Applies a gunshot or similar wound. `fatal`: a body (state `lying` for good, flag `dead`, weapon dropped,
   * `resistance` compliant). `severity >= 0.5`: down for 60 s, then kneeling. Otherwise a 3 s `shot` incapacitation.
   */
  wound(id: number, severity: number, fatal: boolean): void {
    const a = this.byId.get(id);
    if (!a || (a.flags & FLAG.dead) !== 0) return;
    if (fatal) {
      if ((a.flags & FLAG.hidden) !== 0) {
        a.flags &= ~FLAG.hidden;
        this.releaseSpot(a);
      }
      this.dropWeaponRec(a);
      this.setPose(a, ACTOR_STATE.lying);
      a.flags = (a.flags & ~(FLAG.cuffed | FLAG.wounded)) | FLAG.dead;
      return;
    }
    if (severity >= WOUND_DOWN_AT) {
      this.takeDown(a, WOUND_DOWN_S, 'force');
      a.flags |= FLAG.wounded;
      return;
    }
    this.incapacitate(id, WOUND_STAGGER_S, 'shot');
  }

  /** One CED cycle on actor `id`: a downed actor stays down at least `seconds`, any other is put down for `seconds`. */
  taserCycle(id: number, seconds: number): void {
    const a = this.byId.get(id);
    if (!a) return;
    if (a.state === ACTOR_STATE.down) a.timer = Math.max(a.timer, seconds);
    else this.incapacitate(id, seconds, 'taser');
  }

  private takeDown(a: ActorRec, seconds: number, by: 'tackle' | 'taser' | 'fight' | 'force'): void {
    if ((a.flags & FLAG.weaponDrawn) !== 0) this.dropWeaponRec(a);
    a.state = ACTOR_STATE.down;
    a.timer = seconds;
    a.speed = 0;
    a.flags &= ~(FLAG.following | FLAG.advance | FLAG.backward | FLAG.returning | FLAG.wounded);
    const ev = { actorId: a.id, personId: a.person, callId: a.callId, by };
    this.fire(() => this.bus.emit('npc:caught', ev));
  }

  /** Draws the carried weapon (held item shown); no effect without one. */
  drawWeapon(id: number): void {
    const a = this.byId.get(id);
    if (a && a.weapon !== '') a.flags |= FLAG.weaponDrawn;
  }

  /** Lets go of the carried weapon ('npc:weaponDropped'); an armed actor puts its hands up. */
  dropWeapon(id: number): void {
    const a = this.byId.get(id);
    if (!a) return;
    const armed = a.state === ACTOR_STATE.armed;
    this.dropWeaponRec(a);
    if (armed) this.setPose(a, ACTOR_STATE.handsUp);
  }

  private dropWeaponRec(a: ActorRec): void {
    if (a.weapon === '') {
      a.flags &= ~(FLAG.armed | FLAG.weaponDrawn | FLAG.advance);
      return;
    }
    const item = a.weapon;
    a.weapon = '';
    a.flags &= ~(FLAG.armed | FLAG.weaponDrawn | FLAG.advance);
    const x = a.x;
    const z = a.z;
    const ev = { actorId: a.id, personId: a.person, callId: a.callId, item, x, z };
    this.fire(() => this.bus.emit('npc:weaponDropped', ev));
  }

  /** Walks to (x, z) and holds there. */
  walkTo(id: number, x: number, z: number): void {
    const a = this.byId.get(id);
    if (!a || HELPLESS.has(a.state) || a.body === BODY.dog) return;
    this.startWalkTo(a, x, z);
  }

  // --- Actors: state helpers -------------------------------------------------------------

  private startWalkTo(a: ActorRec, x: number, z: number): void {
    let n = 0;
    if (a.building >= 0) {
      // Indoors the route comes from the nav port; without one (or without a way) the actor stays put.
      n = this.nav ? Math.min(MAX_ROUTE_POINTS, this.nav.path(a.building, a.x, a.z, x, z, a.route)) : 0;
      if (n <= 0) {
        this.setHold(a);
        return;
      }
    }
    a.state = ACTOR_STATE.walkTo;
    a.tx = x;
    a.tz = z;
    a.routeLen = 2 * n;
    a.routePos = 0;
    a.flags &= ~(FLAG.following | FLAG.advance | FLAG.backward | FLAG.faceAway | FLAG.returning);
  }

  /**
   * Loads the route to the nearest way out into the actor (indoors). When there is none the actor hides (`canHide`) or
   * holds; false then.
   */
  private planExit(a: ActorRec, canHide: boolean): boolean {
    a.routeLen = 0;
    a.routePos = 0;
    const nav = this.nav;
    if (!nav) {
      this.setHold(a);
      return false;
    }
    const n = Math.min(MAX_ROUTE_POINTS, nav.exit(a.building, a.x, a.z, a.route, this.pose));
    if (n > 0) {
      a.routeLen = 2 * n;
      return true;
    }
    if (!canHide || !this.hideAt(a, this.fx, this.fz)) this.setHold(a);
    return false;
  }

  /** Moves the actor to the nav port's hiding spot away from (awayX, awayZ) and hides it; false when there is none. */
  private hideAt(a: ActorRec, awayX: number, awayZ: number): boolean {
    const nav = this.nav;
    if (!nav || a.building < 0) return false;
    const idx = nav.hideSpot(a.building, a.x, a.z, awayX, awayZ, this.pose);
    if (idx < 0) return false;
    this.releaseSpot(a);
    a.hideSpot = idx;
    a.x = a.prevX = this.pose.x;
    a.z = a.prevZ = this.pose.z;
    a.yaw = a.prevYaw = this.pose.yaw;
    a.tx = a.x;
    a.tz = a.z;
    a.routeLen = 0;
    a.routePos = 0;
    a.speed = 0;
    a.flags = (a.flags | FLAG.hidden) & ~(FLAG.following | FLAG.advance | FLAG.backward | FLAG.faceAway | FLAG.returning | FLAG.weaponDrawn);
    a.state = ACTOR_STATE.hide;
    return true;
  }

  /** The actor reached the end of its way out: it steps outdoors at the exit pose and continues like an outdoor actor. */
  private exitBuilding(a: ActorRec, fleeing: boolean): void {
    const nav = this.nav;
    if (!nav || nav.exit(a.building, a.x, a.z, this.exitRoute, this.pose) <= 0) {
      this.setHold(a);
      return;
    }
    this.releaseSpot(a);
    a.building = -1;
    a.x = a.prevX = this.pose.x;
    a.z = a.prevZ = this.pose.z;
    a.yaw = a.prevYaw = this.pose.yaw;
    a.tx = a.x;
    a.tz = a.z;
    a.lost = 0;
    if (fleeing) this.planAway(a, this.cfg.actors.fleeRouteM[0], this.cfg.actors.fleeRouteM[1]);
    else this.planAway(a, this.cfg.actors.leaveDistanceM, this.cfg.actors.leaveDistanceM * 1.6);
  }

  /** Stand still (hold) and clear movement flags. */
  private setHold(a: ActorRec): void {
    this.setPose(a, ACTOR_STATE.hold);
  }

  private setPose(a: ActorRec, state: number): void {
    a.state = state;
    a.speed = 0;
    a.timer = 0;
    // A weapon is lowered (still carried) when the actor stops being armed.
    a.flags &= ~(FLAG.following | FLAG.advance | FLAG.backward | FLAG.faceAway | FLAG.returning | FLAG.weaponDrawn);
    if (state !== ACTOR_STATE.cuffed) a.flags &= ~FLAG.cuffed;
    if (state !== ACTOR_STATE.down) a.flags &= ~FLAG.wounded;
  }

  private startFlee(a: ActorRec): void {
    a.flags &= ~(FLAG.following | FLAG.advance | FLAG.backward | FLAG.faceAway | FLAG.returning | FLAG.cuffed);
    if (a.building >= 0 && !this.planExit(a, true)) return;
    a.state = ACTOR_STATE.flee;
    a.timer = 0;
    a.lost = 0;
    if (a.stamina <= 0) a.stamina = a.staminaMax;
    if (a.building < 0) this.planAway(a, this.cfg.actors.fleeRouteM[0], this.cfg.actors.fleeRouteM[1]);
    this.note('npc:fled', a);
  }

  private startFight(a: ActorRec): void {
    a.state = ACTOR_STATE.fight;
    a.timer = this.cfg.actors.struggleS;
    a.speed = 0;
    a.flags &= ~(FLAG.following | FLAG.advance | FLAG.backward | FLAG.faceAway | FLAG.returning | FLAG.cuffed);
    this.noteAttack(a, 'fight');
  }

  private startArmed(a: ActorRec): void {
    a.state = ACTOR_STATE.armed;
    a.flags &= ~(FLAG.following | FLAG.advance | FLAG.backward | FLAG.faceAway | FLAG.returning | FLAG.cuffed);
    if (a.weapon !== '') a.flags |= FLAG.armed | FLAG.weaponDrawn;
    a.speed = 0;
    a.timer = lerp(this.cfg.actors.armedActionS, this.actorsRng.next());
    this.noteAttack(a, 'brandish');
  }

  private startLeave(a: ActorRec): void {
    a.flags &= ~(FLAG.following | FLAG.advance | FLAG.backward | FLAG.faceAway | FLAG.returning | FLAG.cuffed);
    if (a.building >= 0 && !this.planExit(a, false)) return;
    a.state = ACTOR_STATE.leave;
    a.lost = 0;
    const d = this.cfg.actors.leaveDistanceM;
    if (a.building < 0) this.planAway(a, d, d * 1.6);
  }

  /** New wander / crowd goal around the home point (tx, tz) kept in route[0..1]. */
  private pickGoal(a: ActorRec): void {
    const radius = a.state === ACTOR_STATE.crowd ? this.cfg.actors.crowdRadiusM : WANDER_RADIUS_M;
    const ang = this.actorsRng.next() * Math.PI * 2;
    const r = Math.sqrt(this.actorsRng.next()) * radius;
    a.route[0] = a.tx + Math.cos(ang) * r;
    a.route[1] = a.tz + Math.sin(ang) * r;
    a.routeLen = 2;
    a.routePos = 0;
    a.timer = 2 + this.actorsRng.next() * 4;
  }

  /** Plans a route to a node `lo`..`hi` m away on the side away from the officer (best of 6 by angle). */
  private planAway(a: ActorRec, lo: number, hi: number): void {
    const g = this.graph;
    let ax = a.x - this.fx;
    let az = a.z - this.fz;
    const l = Math.sqrt(ax * ax + az * az);
    if (l < 0.5) {
      ax = -Math.sin(a.yaw);
      az = -Math.cos(a.yaw);
    } else {
      ax /= l;
      az /= l;
    }
    const nodes = g.nodesNear(a.x, a.z, hi, this.nodeBuf);
    let n = 0;
    for (let pass = 0; pass < 2 && n === 0; pass++) {
      const min = pass === 0 ? lo : lo * 0.4;
      const min2 = min * min;
      for (let k = 0; k < nodes.length && n < NODE_CANDIDATE_CAP; k++) {
        const nd = g.nodes[nodes[k] as number] as RoadNode;
        const dx = nd.x - a.x;
        const dz = nd.z - a.z;
        if (dx * dx + dz * dz >= min2) this.nodeCand[n++] = nd.id;
      }
    }
    a.routeLen = 0;
    a.routePos = 0;
    if (n > 0) {
      let bestScore = -2;
      let bestNode = -1;
      const tries = Math.min(6, n);
      for (let t = 0; t < tries; t++) {
        const id = this.nodeCand[n <= 6 ? t : this.actorsRng.nextInt(0, n - 1)] as number;
        const nd = g.nodes[id] as RoadNode;
        const dx = nd.x - a.x;
        const dz = nd.z - a.z;
        const d = Math.sqrt(dx * dx + dz * dz) || 1;
        const score = (dx * ax + dz * az) / d;
        if (score > bestScore) {
          bestScore = score;
          bestNode = id;
        }
      }
      const node = g.nodes[bestNode] as RoadNode;
      const route = g.routeBetweenPoints(a.x, a.z, node.x, node.z, { cost: 'distance' });
      if (route) {
        this.loadRoute(a, route.polyline);
        if (a.routeLen > 0) return;
      }
    }
    // No usable route: run straight away.
    a.tx = a.x + ax * hi;
    a.tz = a.z + az * hi;
  }

  /** Copies up to 32 vertices of `poly` (x, z pairs, skipping the first) into the actor route, moved onto the sidewalk. */
  private loadRoute(a: ActorRec, poly: Float32Array): void {
    const np = poly.length >> 1;
    const count = np - 1;
    if (count < 1) return;
    const m = Math.min(MAX_ROUTE_POINTS, count);
    for (let k = 0; k < m; k++) {
      const idx = m === 1 ? np - 1 : 1 + Math.round((k * (np - 2)) / (m - 1));
      const px = poly[2 * idx] as number;
      const pz = poly[2 * idx + 1] as number;
      const prev = Math.max(0, idx - 1);
      const next = Math.min(np - 1, idx + 1);
      let dx = (poly[2 * next] as number) - (poly[2 * prev] as number);
      let dz = (poly[2 * next + 1] as number) - (poly[2 * prev + 1] as number);
      const dl = Math.sqrt(dx * dx + dz * dz);
      let off = 0;
      if (dl > 1e-6) {
        dx /= dl;
        dz /= dl;
        const hit = this.graph.nearestEdge(px, pz, 40, this.hit);
        const e = hit ? (this.edges[hit.edge] as RoadEdge) : null;
        off = e ? e.width * 0.5 + e.sidewalk * 0.5 : 0;
      }
      a.route[2 * k] = px - dz * off;
      a.route[2 * k + 1] = pz + dx * off;
    }
    a.routeLen = 2 * m;
    a.routePos = 0;
  }

  // --- Actors: step ----------------------------------------------------------------------

  private updateActors(dt: number): void {
    const lod = this.cfg.actors.lod;
    let updates = 0;
    for (let i = this.actorCount - 1; i >= 0; i--) {
      const a = this.actors[i] as ActorRec;
      a.acc += dt;
      const dx = a.x - this.fx;
      const dz = a.z - this.fz;
      const d = Math.sqrt(dx * dx + dz * dz);
      this.rsame = a.building === this.fbuilding;
      const period = d < lod.nearM ? this.periodNear : d < lod.midM ? this.periodMid : this.periodFar;
      const decide = period <= 1 || (this.stepCount + a.id) % period === 0;
      // Scratch registers instead of arguments: doubles passed to calls that are not inlined are boxed (garbage).
      if (d < lod.midM) {
        this.rdt = dt;
        if (this.moveActor(a)) continue;
      } else if (decide) {
        this.rdt = a.acc;
        if (this.moveActor(a)) continue;
      }
      if (decide) {
        this.rdd = a.acc;
        this.rdist = d;
        a.acc = 0;
        updates++;
        if (this.decideActor(a)) continue;
      }
    }
    this.stats.actorUpdates = updates;
  }

  /** Moves `a` for `rdt` seconds; true when the actor was removed. */
  private moveActor(a: ActorRec): boolean {
    a.speed = 0;
    this.rmoved = 0;
    switch (a.state) {
      case ACTOR_STATE.wander:
      case ACTOR_STATE.crowd:
        if (a.routeLen >= 2 && a.building < 0) {
          this.gx = a.route[0] as number;
          this.gz = a.route[1] as number;
          this.gmax = a.walkSpeed * 0.5 * this.rdt;
          this.gface = true;
          this.advance(a);
        }
        break;
      case ACTOR_STATE.walkTo: {
        if (a.building >= 0) {
          this.gmax = a.walkSpeed * this.rdt;
          this.followRoute(a);
        } else {
          this.gx = a.tx;
          this.gz = a.tz;
          this.gmax = a.walkSpeed * this.rdt;
          this.gface = (a.flags & FLAG.backward) === 0;
          this.advance(a);
        }
        const dx = a.tx - a.x;
        const dz = a.tz - a.z;
        if (dx * dx + dz * dz < 1e-4) {
          if ((a.flags & FLAG.returning) !== 0) {
            this.reseat(a);
            return true;
          }
          const keep = a.flags & FLAG.faceAway;
          this.setHold(a);
          a.flags |= keep;
        }
        break;
      }
      case ACTOR_STATE.follow:
        this.followOfficer(a);
        break;
      case ACTOR_STATE.cuffed:
        if ((a.flags & FLAG.following) !== 0) this.followOfficer(a);
        break;
      case ACTOR_STATE.flee:
        this.gmax = (a.stamina > 0 ? a.runSpeed : a.runSpeed * this.cfg.actors.tiredFactor) * this.rdt;
        this.followRoute(a);
        if (a.building >= 0 && a.routePos * 2 >= a.routeLen) this.exitBuilding(a, true);
        break;
      case ACTOR_STATE.leave:
        this.gmax = a.walkSpeed * this.rdt;
        this.followRoute(a);
        if (a.building >= 0) {
          if (a.routePos * 2 >= a.routeLen) this.exitBuilding(a, false);
        } else a.lost += this.rmoved;
        break;
      case ACTOR_STATE.armed:
        if ((a.flags & FLAG.advance) !== 0 && this.rsame) {
          this.gx = this.fx;
          this.gz = this.fz;
          this.gmax = a.walkSpeed * 1.6 * this.rdt;
          this.gface = true;
          this.advance(a);
          const dx = a.x - this.fx;
          const dz = a.z - this.fz;
          if (dx * dx + dz * dz <= MELEE_RANGE_M * MELEE_RANGE_M) {
            this.startFight(a);
            return false;
          }
        } else this.faceOfficer(a);
        break;
      default:
        if (FACING.has(a.state)) this.faceOfficer(a);
        break;
    }
    if (this.rmoved > 0 && this.rdt > 0) {
      a.speed = this.rmoved / this.rdt;
      a.gait += this.rmoved / ((1.4 * a.height) / 1.75);
    }
    return false;
  }

  /** Slow turn towards the officer when close and not told otherwise. */
  private faceOfficer(a: ActorRec): void {
    if (a.body === BODY.dog || (a.flags & FLAG.faceAway) !== 0 || a.building !== this.fbuilding) return;
    const dx = this.fx - a.x;
    const dz = this.fz - a.z;
    const d2 = dx * dx + dz * dz;
    if (d2 > FACE_RANGE_M * FACE_RANGE_M || d2 < 0.01) return;
    let turn = Math.atan2(-dx, -dz) - a.yaw;
    turn -= TWO_PI * Math.round(turn / TWO_PI);
    const maxTurn = TURN_RATE * this.rdt;
    a.yaw += turn > maxTurn ? maxTurn : turn < -maxTurn ? -maxTurn : turn;
  }

  /** Moves up to `gmax` metres towards (gx, gz), facing along when `gface`; adds the distance moved to `rmoved`. */
  private advance(a: ActorRec): void {
    const dx = this.gx - a.x;
    const dz = this.gz - a.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 1e-6 || this.gmax <= 0) return;
    if (this.gface) a.yaw = Math.atan2(-dx, -dz);
    if (this.gmax >= d) {
      a.x = this.gx;
      a.z = this.gz;
      this.rmoved += d;
      return;
    }
    const k = this.gmax / d;
    a.x += dx * k;
    a.z += dz * k;
    this.rmoved += this.gmax;
  }

  /** Follows the route (or runs to the straight-line target when there is none) with a budget of `gmax` metres. */
  private followRoute(a: ActorRec): void {
    const budget = this.gmax;
    let used = 0;
    this.gface = true;
    if (a.routeLen === 0) {
      this.gx = a.tx;
      this.gz = a.tz;
      this.advance(a);
      return;
    }
    for (let guard = 0; guard < 6 && a.routePos * 2 < a.routeLen && used < budget; guard++) {
      const k = a.routePos * 2;
      this.gx = a.route[k] as number;
      this.gz = a.route[k + 1] as number;
      this.gmax = budget - used;
      const before = this.rmoved;
      this.advance(a);
      used += this.rmoved - before;
      const dx = this.gx - a.x;
      const dz = this.gz - a.z;
      if (dx * dx + dz * dz < 1e-6) a.routePos++;
      else break;
    }
  }

  private routeDone(a: ActorRec): boolean {
    if (a.routeLen > 0) return a.routePos * 2 >= a.routeLen;
    const dx = a.tx - a.x;
    const dz = a.tz - a.z;
    return dx * dx + dz * dz < 1;
  }

  /** Walks to the point `followDistance` behind the officer, speeding up when left behind. */
  private followOfficer(a: ActorRec): void {
    // On another level the follower waits (`transferFollowers` brings it along).
    if (!this.fonFoot || a.building !== this.fbuilding) return;
    const fd = this.cfg.actors.followDistance;
    if (a.building >= 0) {
      this.followIndoors(a, fd);
      return;
    }
    this.gx = this.fx + Math.sin(this.fyaw) * fd;
    this.gz = this.fz + Math.cos(this.fyaw) * fd;
    const dx = this.gx - a.x;
    const dz = this.gz - a.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d < 0.25) {
      this.faceOfficer(a);
      return;
    }
    this.gmax = Math.min(a.runSpeed, Math.max(a.walkSpeed, this.fspeed * 1.1) + d * 1.2) * this.rdt;
    this.gface = true;
    this.advance(a);
  }

  /** Follows the officer through the rooms: a path to the officer's position, recomputed every second. */
  private followIndoors(a: ActorRec, fd: number): void {
    const nav = this.nav;
    if (!nav) return;
    const dx = this.fx - a.x;
    const dz = this.fz - a.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    a.repath -= this.rdt;
    if (d <= fd) {
      this.faceOfficer(a);
      return;
    }
    if (a.repath <= 0) {
      a.repath = INDOOR_REPATH_S;
      a.routeLen = 2 * Math.min(MAX_ROUTE_POINTS, nav.path(a.building, a.x, a.z, this.fx, this.fz, a.route));
      a.routePos = 0;
    }
    if (a.routeLen === 0) return;
    this.gmax = Math.min(a.runSpeed, Math.max(a.walkSpeed, this.fspeed * 1.1) + d * 1.2) * this.rdt;
    this.followRoute(a);
  }

  /** Re-seats an actor that walked back to its vehicle: the seat is free again and the actor is removed. */
  private reseat(a: ActorRec): void {
    const seats = this.outSeats.get(a.vehicleId);
    if (seats) {
      const k = seats.indexOf(a.seat);
      if (k >= 0) seats.splice(k, 1);
      if (seats.length === 0) this.outSeats.delete(a.vehicleId);
    }
    this.removeActorRec(a);
  }

  /**
   * A hidden actor shows itself to an officer within `revealDistanceM` outdoors; indoors only within `revealIndoorM`
   * and in the same room (a closet behind a wall and a closed door stays hidden).
   */
  private revealsTo(a: ActorRec, d: number): boolean {
    if (a.building < 0) return d <= this.cfg.actors.revealDistanceM;
    if (d > this.cfg.actors.revealIndoorM) return false;
    const nav = this.nav;
    return nav?.sameRoom === undefined || nav.sameRoom(a.building, a.x, a.z, this.fx, this.fz);
  }

  /** Evaluates the state machine for `a` after `ddt` seconds; true when the actor was removed. */
  private decideActor(a: ActorRec): boolean {
    const cfg = this.cfg.actors;
    const ddt = this.rdd;
    const d = this.rdist;
    if (a.aware > 0) this.decayAware(a, ddt);
    if (
      this.zones.length > 0 && a.callId === 0 && ZONE_LEAVABLE.has(a.state) && (a.flags & (FLAG.cuffed | FLAG.following)) === 0 &&
      (a.building < 0 || this.nav !== null) && this.actorInZone(a)
    ) {
      this.startLeave(a);
    }
    if (a.state === ACTOR_STATE.hide) {
      if (this.rsame && this.revealsTo(a, d)) this.revealRec(a);
      return false;
    }
    a.age += ddt;
    // Loose bystanders (no call) that nobody is dealing with fade out: far away, or old and out of sight.
    if (
      a.callId === 0 && CULLABLE.has(a.state) && (a.flags & (FLAG.cuffed | FLAG.following)) === 0 &&
      (d > this.cfg.peds.despawnRadiusM || (a.age > BYSTANDER_LIFE_S && d > this.cfg.actors.lod.nearM))
    ) {
      this.removeActorRec(a);
      return true;
    }
    if ((a.flags & FLAG.approached) === 0 && APPROACHABLE.has(a.state) && this.rsame && d <= cfg.approachTriggerM) this.approachRoll(a);
    const rng = this.actorsRng;
    switch (a.state) {
      case ACTOR_STATE.flee: {
        if (a.stamina > 0) a.stamina -= ddt;
        if (d > cfg.escapeDistanceM) {
          a.lost += ddt;
          if (a.lost >= cfg.escapeS) {
            this.note('npc:escaped', a);
            this.removeActorRec(a);
            return true;
          }
        } else a.lost = 0;
        a.timer += ddt;
        const rate = (a.profile.surrenderPerMin / 60) * (1 + 0.5 * Math.max(0, this.fbackup));
        while (a.timer >= 1) {
          a.timer -= 1;
          if (rate > 0 && rng.next() < rate) {
            this.setPose(a, ACTOR_STATE.kneel);
            this.note('npc:surrendered', a);
            return false;
          }
        }
        if (a.building < 0 && this.routeDone(a)) this.planAway(a, cfg.fleeRouteM[0], cfg.fleeRouteM[1]);
        return false;
      }
      case ACTOR_STATE.armed:
        this.armedTick(a);
        return false;
      case ACTOR_STATE.fight:
        a.timer -= ddt;
        if (a.timer <= 0) {
          const p = clamp(cfg.officerWinBase + cfg.officerWinPerBackup * Math.max(0, this.fbackup), 0, 1);
          if (rng.next() < p) this.takeDown(a, cfg.tackleDownS, 'fight');
          else this.startFlee(a);
        }
        return false;
      case ACTOR_STATE.down:
        a.timer -= ddt;
        if (a.timer <= 0) {
          const kneel = (a.flags & FLAG.wounded) !== 0;
          this.setPose(a, kneel ? ACTOR_STATE.kneel : ACTOR_STATE.prone);
        }
        return false;
      case ACTOR_STATE.wander:
      case ACTOR_STATE.crowd: {
        a.timer -= ddt;
        if (a.timer <= 0) this.pickGoal(a);
        return false;
      }
      case ACTOR_STATE.leave:
        if (a.building < 0 && (a.lost >= cfg.leaveDistanceM || this.routeDone(a))) {
          this.note('npc:left', a);
          this.removeActorRec(a);
          return true;
        }
        return false;
      default:
        return false;
    }
  }

  /** The first time the officer comes close: roll flee, then drawing a carried weapon. */
  private approachRoll(a: ActorRec): void {
    if ((a.flags & FLAG.approached) !== 0) return;
    a.flags |= FLAG.approached;
    if (a.state === ACTOR_STATE.lying || HELPLESS.has(a.state) || a.state === ACTOR_STATE.flee) return;
    const rng = this.actorsRng;
    const fleeP = a.profile.fleeChance + a.fleeBonus;
    if (fleeP > 0 && rng.next() < fleeP) {
      this.startFlee(a);
      return;
    }
    if (a.weapon !== '' && a.profile.weaponDrawChance > 0 && rng.next() < a.profile.weaponDrawChance) this.startArmed(a);
  }

  /** Every `armedActionS`: maybe surrender (drop the weapon, hands up), else maybe attack. */
  private armedTick(a: ActorRec): void {
    const cfg = this.cfg.actors;
    const ddt = this.rdd;
    const d = this.rdist;
    const rng = this.actorsRng;
    a.timer -= ddt;
    if (a.timer > 0) return;
    const interval = (cfg.armedActionS[0] + cfg.armedActionS[1]) / 2;
    a.timer = lerp(cfg.armedActionS, rng.next());
    const mult = 1 + (this.fweapon > 0 ? 0.5 : 0) + (this.fbackup > 0 ? 0.5 : 0);
    const p = Math.min(1, (a.profile.surrenderPerMin / 60) * interval * mult);
    if (p > 0 && rng.next() < p) {
      this.dropWeaponRec(a);
      this.setPose(a, ACTOR_STATE.handsUp);
      this.note('npc:surrendered', a);
      return;
    }
    if (a.profile.demeanor === 'hostile' && this.rsame && d <= ATTACK_RANGE_M && rng.next() < ATTACK_CHANCE) {
      if (a.weapon === 'handgun') {
        this.noteAttack(a, 'fire');
      } else if (a.weapon !== '') {
        a.flags |= FLAG.advance;
      }
    }
  }

  // --- Occupants (§8.1, vehicles) --------------------------------------------------------

  /** Scenario occupants of a vehicle replace the generated ones (any pedestrian among them is removed). */
  setOccupants(vehicleId: number, personIds: readonly number[]): void {
    const ids: number[] = [];
    for (const id of personIds) {
      if (Number.isInteger(id) && id >= 0 && id < PERSON_POPULATION && !ids.includes(id)) ids.push(id);
    }
    this.overrides.delete(vehicleId);
    this.overrides.set(vehicleId, ids);
    this.overrideSince.set(vehicleId, this.stepCount);
    while (this.overrides.size > OVERRIDE_CAP) {
      const oldest = this.overrides.keys().next();
      if (oldest.done) break;
      this.overrides.delete(oldest.value);
      this.overrideSince.delete(oldest.value);
      this.occCache.delete(oldest.value);
    }
    this.occCache.delete(vehicleId);
    for (const id of ids) {
      for (let i = 0; i < this.pedCount; i++) {
        if ((this.peds[i] as PedRec).person === id) {
          this.removePed(i);
          break;
        }
      }
    }
  }

  /** The occupants of a vehicle by seat (seat 0 = driver): the scenario override or the generated ones. */
  occupantsOf(vehicleId: number): readonly number[] {
    const o = this.overrides.get(vehicleId);
    if (o) return o;
    const base = this.people.occupantsOf(vehicleId);
    // Seat numbers are keys (outSeats, stepOut, contacts): a car that is the stop target, has people out of it or is
    // drawn keeps all its seats. Elsewhere a booked, hospitalised, missing or dead person is not driving around any more
    // (an arrested one is still in the car until booked).
    if (vehicleId === this.traffic.stopVehicleId || this.outSeats.has(vehicleId) || this.occCache.has(vehicleId)) return base;
    for (let i = 0; i < base.length; i++) {
      if (this.people.unavailable(base[i] as number, false)) return base.filter((id) => !this.people.unavailable(id, false));
    }
    return base;
  }

  /** Marks the seat of `person` empty in every scenario occupant list that has them. */
  private markOut(person: number): void {
    for (const [vid, ids] of this.overrides) {
      const seat = ids.indexOf(person);
      if (seat < 0) continue;
      let seats = this.outSeats.get(vid);
      if (!seats) {
        seats = [];
        this.outSeats.set(vid, seats);
      }
      if (!seats.includes(seat)) seats.push(seat);
    }
  }

  /** Occupants for rendering and picking; cached per vehicle. */
  private occupantIds(vehicleId: number): readonly number[] {
    const entry = this.occEntry(vehicleId);
    return entry.ids;
  }

  private occEntry(vehicleId: number): OccEntry {
    let e = this.occCache.get(vehicleId);
    if (e) {
      e.seen = this.stepCount;
      return e;
    }
    const ids = isFleetVehicleId(vehicleId) && !this.overrides.has(vehicleId) ? [] : this.occupantsOf(vehicleId).slice(0, this.cfg.occupants.seats.length);
    e = { ids, skin: [], hair: [], top: [], bottom: [], height: [], build: [], seen: this.stepCount };
    for (const id of ids) {
      const ap = this.people.appearance(id);
      e.skin.push(ap.skin);
      e.hair.push(ap.hair === null ? BALD : ap.hair);
      e.top.push(ap.top);
      e.bottom.push(ap.bottom);
      e.height.push(ap.heightM);
      e.build.push(ap.build);
    }
    this.occCache.set(vehicleId, e);
    return e;
  }

  /** Is the person in `seat` of the vehicle out of the car? */
  isOut(vehicleId: number, seat: number): boolean {
    const seats = this.outSeats.get(vehicleId);
    return seats !== undefined && seats.includes(seat);
  }

  /**
   * The occupant of `seat` gets out on the curb side: returns the id of the standing actor (profile
   * `driverCooperative` for the driver, `passenger` otherwise; the scene sets the real profile), 0 when the
   * vehicle is not active, the seat is empty or already out, or the actor pool is full.
   */
  stepOut(vehicleId: number, seat: number): number {
    const slot = this.traffic.slotOfVehicle(vehicleId);
    if (slot < 0 || !Number.isInteger(seat) || seat < 0 || this.isOut(vehicleId, seat)) return 0;
    const ids = this.occupantsOf(vehicleId);
    const person = ids[seat];
    if (person === undefined || seat >= this.cfg.occupants.seats.length) return 0;
    this.seatWorld(slot, seat, true);
    const id = this.spawnActor({
      personId: person, x: this.door.x, z: this.door.z, yaw: this.door.yaw, profile: this.ambientProfile(person, seat === 0 ? 'driverCooperative' : 'passenger'),
      role: seat === 0 ? 'driver' : 'passenger', callId: 0, hidden: false, body: 'human', weapon: null, vehicleId, pose: 'stand',
    });
    const a = this.byId.get(id);
    if (!a || a.seat >= 0 || a.person !== person) return 0;
    a.seat = seat;
    a.vehicleId = vehicleId;
    let seats = this.outSeats.get(vehicleId);
    if (!seats) {
      seats = [];
      this.outSeats.set(vehicleId, seats);
    }
    if (!seats.includes(seat)) seats.push(seat);
    return id;
  }

  /** Door of an actor's own vehicle seat into `door` (0, 0 when the vehicle is not active). */
  private doorOf(a: ActorRec): void {
    const slot = this.traffic.slotOfVehicle(a.vehicleId);
    if (slot < 0) {
      this.door.x = 0;
      this.door.z = 0;
      this.door.yaw = 0;
      return;
    }
    this.seatWorld(slot, Math.max(0, a.seat), true);
  }

  /** World position of seat `seat` of traffic slot `slot` into `door`; `curbSide` puts it outside the right door instead. */
  private seatWorld(slot: number, seat: number, curbSide = false): void {
    const v = this.traffic.view;
    const yaw = v.yaw[slot] ?? 0;
    const model = v.model[slot] ?? 0;
    const w = this.modelWidth[model] ?? 1.8;
    const len = this.modelLength[model] ?? 4.5;
    const seats = this.cfg.occupants.seats;
    const frac = (seats[Math.min(seat, seats.length - 1)] ?? seats[0]) as readonly [number, number];
    const lx = curbSide ? w / 2 + DOOR_OFFSET_M : frac[0] * w;
    const lz = frac[1] * len;
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    this.door.x = (v.x[slot] ?? 0) + c * lx + s * lz;
    this.door.z = (v.z[slot] ?? 0) - s * lx + c * lz;
    this.door.yaw = yaw - Math.PI / 2;
  }

  // --- View ----------------------------------------------------------------------------------

  private publish(): void {
    const v = this.view;
    let k = 0;
    for (let i = 0; i < this.pedCount; i++, k++) {
      const p = this.peds[i] as PedRec;
      v.x[k] = p.x;
      v.y[k] = 0;
      v.z[k] = p.z;
      v.yaw[k] = p.yaw;
      v.prevX[k] = p.prevX;
      v.prevY[k] = 0;
      v.prevZ[k] = p.prevZ;
      v.prevYaw[k] = p.prevYaw;
      v.anchor[k] = 0;
      v.pose[k] = p.flee > 0 ? POSE.run : POSE.walk;
      v.gait[k] = p.gait;
      v.speed[k] = p.speed;
      v.height[k] = p.height;
      v.build[k] = p.build;
      v.skin[k] = p.skin;
      v.hair[k] = p.hair;
      v.top[k] = p.top;
      v.bottom[k] = p.bottom;
      v.held[k] = HELD.none;
      v.body[k] = BODY.human;
      v.flags[k] = 0;
    }
    for (let i = 0; i < this.actorCount; i++, k++) {
      const a = this.actors[i] as ActorRec;
      const y = levelY(a.building);
      v.x[k] = a.x;
      v.y[k] = y;
      v.z[k] = a.z;
      v.yaw[k] = a.yaw;
      v.prevX[k] = a.prevX;
      v.prevY[k] = y;
      v.prevZ[k] = a.prevZ;
      v.prevYaw[k] = a.prevYaw;
      v.anchor[k] = 0;
      v.pose[k] = this.poseOf(a);
      v.gait[k] = a.gait;
      v.speed[k] = a.speed;
      v.height[k] = a.height;
      v.build[k] = a.build;
      v.skin[k] = a.skin;
      v.hair[k] = a.hair;
      v.top[k] = a.top;
      v.bottom[k] = a.bottom;
      v.held[k] = (a.flags & FLAG.weaponDrawn) !== 0 ? heldOf(a.weapon) : HELD.none;
      v.body[k] = a.body;
      v.flags[k] = (a.flags & FLAG.hidden) !== 0 ? FIGURE_FLAG.hidden : 0;
    }
    k = this.publishOccupants(k);
    v.count = k;
    this.stats.peds = this.pedCount;
    this.stats.actors = this.actorCount;
    this.stats.occupants = this.occCount;
  }

  private poseOf(a: ActorRec): number {
    switch (a.state) {
      case ACTOR_STATE.handsUp:
        return POSE.handsUp;
      case ACTOR_STATE.kneel:
        return POSE.kneel;
      case ACTOR_STATE.prone:
      case ACTOR_STATE.down:
        return POSE.prone;
      case ACTOR_STATE.cuffed:
        return POSE.cuffed;
      case ACTOR_STATE.seated:
        return POSE.seated;
      case ACTOR_STATE.sit:
        return POSE.sit;
      case ACTOR_STATE.lying:
        return POSE.lying;
      case ACTOR_STATE.fight:
        return POSE.fight;
      case ACTOR_STATE.armed:
        return (a.flags & FLAG.weaponDrawn) !== 0 ? POSE.aim : a.speed > 0.1 ? POSE.walk : POSE.stand;
      default:
        return a.speed > 3.2 ? POSE.run : a.speed > 0.1 ? POSE.walk : POSE.stand;
    }
  }

  /** Seated entries for traffic cars within `renderRadiusM`; returns the next free view index. */
  private publishOccupants(start: number): number {
    const v = this.view;
    const tv = this.traffic.view;
    const cfg = this.cfg.occupants;
    const r2 = cfg.renderRadiusM * cfg.renderRadiusM;
    let k = start;
    let n = 0;
    for (let slot = 0; slot < tv.count && n < MAX_OCCUPANTS; slot++) {
      const dx = (tv.x[slot] ?? 0) - this.fx;
      const dz = (tv.z[slot] ?? 0) - this.fz;
      if (dx * dx + dz * dz > r2) continue;
      const vid = tv.vehicleId[slot] ?? -1;
      const entry = this.occEntry(vid);
      const model = tv.model[slot] ?? 0;
      const w = this.modelWidth[model] ?? 1.8;
      const len = this.modelLength[model] ?? 4.5;
      const eid = tv.eid[slot] ?? 0;
      for (let seat = 0; seat < entry.ids.length && seat < cfg.seats.length && n < MAX_OCCUPANTS; seat++) {
        if (this.isOut(vid, seat)) continue;
        const frac = cfg.seats[seat] as readonly [number, number];
        v.x[k] = v.prevX[k] = frac[0] * w;
        v.y[k] = v.prevY[k] = cfg.seatY;
        v.z[k] = v.prevZ[k] = frac[1] * len;
        v.yaw[k] = v.prevYaw[k] = 0;
        v.anchor[k] = eid;
        v.pose[k] = POSE.seated;
        v.gait[k] = 0;
        v.speed[k] = 0;
        v.height[k] = entry.height[seat] ?? 1.75;
        v.build[k] = entry.build[seat] ?? 1;
        v.skin[k] = entry.skin[seat] ?? 0;
        v.hair[k] = entry.hair[seat] ?? BALD;
        v.top[k] = entry.top[seat] ?? 0;
        v.bottom[k] = entry.bottom[seat] ?? 0;
        v.held[k] = HELD.none;
        v.body[k] = BODY.human;
        v.flags[k] = 0;
        this.occVehicle[n] = vid;
        this.occSeat[n] = seat;
        this.occPerson[n] = entry.ids[seat] ?? -1;
        k++;
        n++;
      }
    }
    this.occCount = n;
    if (this.stepCount % 120 === 0) {
      for (const [vid, e] of this.occCache) if (this.stepCount - e.seen > OCC_CACHE_STEPS) this.occCache.delete(vid);
    }
    return k;
  }

  // --- Indoors (design §8.1) -----------------------------------------------------------------

  /** Sets (or clears) the navigation inside buildings. Without it indoor actors only idle and hold. */
  setIndoorNav(nav: IndoorNavPort | null): void {
    this.nav = nav;
  }

  /** Moves actor `id` to a level and position (residents to the door, prisoners to cells). Clears its route. */
  setActorPosition(id: number, building: number, x: number, z: number, yaw: number): void {
    const a = this.byId.get(id);
    if (!a || !Number.isInteger(building) || building < -1 || !Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)) return;
    this.releaseSpot(a);
    a.building = building;
    a.x = a.prevX = x;
    a.z = a.prevZ = z;
    a.yaw = a.prevYaw = yaw;
    a.tx = x;
    a.tz = z;
    a.routeLen = 0;
    a.routePos = 0;
    a.repath = 0;
    if (a.state === ACTOR_STATE.flee || a.state === ACTOR_STATE.leave) {
      const fleeing = a.state === ACTOR_STATE.flee;
      if (building >= 0) this.planExit(a, fleeing);
      else if (fleeing) this.planAway(a, this.cfg.actors.fleeRouteM[0], this.cfg.actors.fleeRouteM[1]);
      else this.planAway(a, this.cfg.actors.leaveDistanceM, this.cfg.actors.leaveDistanceM * 1.6);
    }
  }

  /** Every following (escorted) actor joins the officer on a level change, placed 1 m behind (x, z, yaw). */
  transferFollowers(building: number, x: number, z: number, yaw: number): void {
    if (!Number.isInteger(building) || building < -1) return;
    const px = x + Math.sin(yaw) * FOLLOWER_GAP_M;
    const pz = z + Math.cos(yaw) * FOLLOWER_GAP_M;
    for (let i = 0; i < this.actorCount; i++) {
      const a = this.actors[i] as ActorRec;
      if ((a.flags & FLAG.following) === 0) continue;
      this.releaseSpot(a);
      a.building = building;
      a.x = a.prevX = px;
      a.z = a.prevZ = pz;
      a.yaw = a.prevYaw = yaw;
      a.tx = px;
      a.tz = pz;
      a.routeLen = 0;
      a.routePos = 0;
      a.repath = 0;
    }
  }

  /**
   * ListenerPort (design §7.3): fills `out` with the actors within `radius` of (x, z) on any level, reusing the
   * objects already in the array (it only grows), and returns how many were written.
   */
  listeners(x: number, z: number, radius: number, out: Listener[]): number {
    const r2 = radius * radius;
    const hour = this.hourOfDay();
    let n = 0;
    for (let i = 0; i < this.actorCount; i++) {
      const a = this.actors[i] as ActorRec;
      const dx = a.x - x;
      const dz = a.z - z;
      if (dx * dx + dz * dz > r2) continue;
      let l = out[n];
      if (!l) {
        l = { actorId: 0, personId: -1, x: 0, z: 0, building: -1, hearing: 'normal', asleep: false, hidden: false, yaw: 0, eyeY: EYE_STAND };
        out.push(l);
      }
      const dead = a.profile.id === 'subjectDeceased' || a.profile.id === 'subjectUnconscious';
      l.actorId = a.id;
      l.personId = a.person;
      l.x = a.x;
      l.z = a.z;
      l.building = a.building;
      l.hearing = dead ? 'deaf' : a.hearing;
      l.asleep = a.state === ACTOR_STATE.lying && !dead && hour < 6;
      l.hidden = (a.flags & FLAG.hidden) !== 0;
      l.yaw = a.yaw;
      l.eyeY = a.body === BODY.dog ? EYE_DOG : eyeHeight(a.state);
      n++;
    }
    return n;
  }

  /**
   * Something reached actor `actorId` (design §8.1): `sound` and `sight` add `amount` to its awareness, `light` 1.5 times
   * that. Hidden actors ignore sight; people who cannot react (unconscious, dead) ignore everything. Crossing `alertAt`
   * turns the actor towards the source and raises `npc:aware` (level `alert`); crossing `awareAt` rolls the profile's
   * `onAware` reaction once per actor and raises `npc:aware` (level `aware`).
   */
  stimulate(actorId: number, kind: 'sound' | 'sight' | 'light', amount: number, srcX: number, srcZ: number): void {
    const a = this.byId.get(actorId);
    if (!a || !(amount > 0) || a.profile.demeanor === 'unresponsive') return;
    if (kind === 'sight' && (a.flags & FLAG.hidden) !== 0) return;
    a.aware = Math.min(1, a.aware + (kind === 'light' ? amount * LIGHT_GAIN : amount));
    a.srcX = srcX;
    a.srcZ = srcZ;
    const level = this.levelOfAware(a.aware);
    if (level <= a.awareLevel) return;
    const from = a.awareLevel;
    a.awareLevel = level;
    if (from < 1) {
      this.faceSource(a);
      this.noteAware(a, 'alert', 'none', kind);
    }
    if (level >= 2 && (a.flags & FLAG.awareRolled) === 0) {
      a.flags |= FLAG.awareRolled;
      const reaction = this.react(a, this.rollAware(a));
      this.noteAware(a, 'aware', reaction, kind);
    }
  }

  private levelOfAware(aware: number): number {
    const cfg = this.cfg.actors;
    return aware >= cfg.awareAt ? 2 : aware >= cfg.alertAt ? 1 : 0;
  }

  private decayAware(a: ActorRec, ddt: number): void {
    a.aware = Math.max(0, a.aware - this.cfg.actors.awareDecayPerS * ddt);
    a.awareLevel = Math.min(a.awareLevel, this.levelOfAware(a.aware));
  }

  /** Snaps a resting actor round to face the last stimulus. */
  private faceSource(a: ActorRec): void {
    if ((a.flags & (FLAG.hidden | FLAG.cuffed)) !== 0 || !TURNABLE.has(a.state)) return;
    const dx = a.srcX - a.x;
    const dz = a.srcZ - a.z;
    if (dx * dx + dz * dz > 1e-4) a.yaw = yawOf(dx, dz);
  }

  private noteAware(a: ActorRec, level: 'alert' | 'aware', reaction: AwareReaction, cause: 'sound' | 'sight' | 'light'): void {
    const ev = { actorId: a.id, personId: a.person, callId: a.callId, level, reaction, cause };
    this.fire(() => this.bus.emit('npc:aware', ev));
  }

  /** Picks a reaction by the profile's `onAware` weights with one draw of the actors stream. */
  private rollAware(a: ActorRec): AwareReaction {
    const w = a.profile.onAware;
    let total = 0;
    for (let i = 0; i < AWARE_REACTIONS.length; i++) total += w[AWARE_REACTIONS[i] as AwareReaction];
    let u = this.actorsRng.next() * total;
    for (let i = 0; i < AWARE_REACTIONS.length; i++) {
      const r = AWARE_REACTIONS[i] as AwareReaction;
      const weight = w[r];
      if (weight <= 0) continue;
      if (u < weight) return r;
      u -= weight;
    }
    return 'none';
  }

  /** Carries out a rolled reaction; returns the one that actually happened (the others need a way out, a weapon or a free body). */
  private react(a: ActorRec, reaction: AwareReaction): AwareReaction {
    const stuck = (a.flags & FLAG.cuffed) !== 0 || RESTRAINED.has(a.state) || a.state === ACTOR_STATE.lying || a.state === ACTOR_STATE.seated;
    if (stuck || reaction === 'none') return 'none';
    const hidden = (a.flags & FLAG.hidden) !== 0;
    switch (reaction) {
      case 'hide':
        if (hidden || a.building < 0) return 'none';
        return this.hideAt(a, a.srcX, a.srcZ) ? 'hide' : 'none';
      case 'flee':
        if (hidden) this.unhide(a);
        this.startFlee(a);
        return this.reactionOfState(a);
      case 'confront': {
        if (hidden) this.unhide(a);
        if (a.weapon !== '') {
          this.startArmed(a);
          return 'confront';
        }
        const dx = a.x - this.fx;
        const dz = a.z - this.fz;
        if (this.fbuilding === a.building && dx * dx + dz * dz <= CONFRONT_FIGHT_M * CONFRONT_FIGHT_M) this.startFight(a);
        else {
          this.setHold(a);
          this.faceSource(a);
        }
        return 'confront';
      }
      case 'surrender':
        if (hidden) this.unhide(a);
        this.setPose(a, ACTOR_STATE.handsUp);
        this.note('npc:surrendered', a);
        return 'surrender';
      case 'arm':
        if (a.weapon === '') return 'none';
        if (!hidden) this.setHold(a);
        a.flags |= FLAG.weaponDrawn;
        return 'arm';
      default:
        return 'none';
    }
  }

  /** The reaction a state stands for after `startFlee` (it may have hidden or held the actor instead). */
  private reactionOfState(a: ActorRec): AwareReaction {
    const state: number = a.state;
    return state === ACTOR_STATE.flee ? 'flee' : state === ACTOR_STATE.hide ? 'hide' : 'none';
  }

  /** Sets the areas pedestrians keep out of (scene tape). Ambient actors standing in one walk away. */
  setNoGoZones(zones: readonly NoGoZone[]): void {
    this.zones = zones.slice();
    // The boxes live in a typed array (minX, minZ, maxX, maxZ per zone): reading them allocates nothing.
    this.zoneBox = new Float64Array(zones.length * 4);
    zones.forEach((zone, i) => {
      this.zoneBox[i * 4] = zone.minX;
      this.zoneBox[i * 4 + 1] = zone.minZ;
      this.zoneBox[i * 4 + 2] = zone.maxX;
      this.zoneBox[i * 4 + 3] = zone.maxZ;
    });
  }

  // The position travels in scratch registers: doubles passed to calls that are not inlined are boxed (garbage).
  private pedInZone(p: PedRec): boolean {
    this.zx = p.x;
    this.zz = p.z;
    return this.zoneHit();
  }

  private actorInZone(a: ActorRec): boolean {
    this.zx = a.x;
    this.zz = a.z;
    return this.zoneHit();
  }

  /** Is (zx, zz) inside a no-go zone (box first, then the polygon)? */
  private zoneHit(): boolean {
    const zones = this.zones;
    const box = this.zoneBox;
    const x = this.zx;
    const z = this.zz;
    for (let i = 0; i < zones.length; i++) {
      const k = i * 4;
      if (x < (box[k] as number) || x > (box[k + 2] as number) || z < (box[k + 1] as number) || z > (box[k + 3] as number)) continue;
      if (this.polygonHit((zones[i] as NoGoZone).points)) return true;
    }
    return false;
  }

  /** `pointInPolygon` for (zx, zz): the point travels in scratch registers (no boxed arguments). */
  private polygonHit(pts: Float32Array): boolean {
    const x = this.zx;
    const z = this.zz;
    const n = pts.length >> 1;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = pts[2 * i] as number;
      const zi = pts[2 * i + 1] as number;
      const xj = pts[2 * j] as number;
      const zj = pts[2 * j + 1] as number;
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  }

  // --- Debug ------------------------------------------------------------------------------

  /** Debug: scales the pedestrian density target (default 1). */
  setDensityScale(scale: number): void {
    this.densityScale = Number.isFinite(scale) && scale >= 0 ? scale : 1;
    this.retargetIn = 0;
  }

  get density(): number {
    return this.densityScale;
  }

  /** Debug: removes every ambient pedestrian. */
  clearPeds(): void {
    while (this.pedCount > 0) this.removePed(this.pedCount - 1);
  }

  /** Current target pedestrian count (debug and tests). */
  get targetPeds(): number {
    return this.target;
  }

  // --- Persistence (§8.6) ------------------------------------------------------------------

  serialize(): NpcSave {
    const peds: PedSave[] = [];
    for (let i = 0; i < this.pedCount; i++) {
      const p = this.peds[i] as PedRec;
      const ps: PedSave = { personId: p.person, edge: p.edge, s: p.s, side: p.side, dir: p.dir, speed: p.base, gait: p.gait, flee: p.flee, acc: p.acc };
      if (p.ox !== 0 || p.oz !== 0) {
        ps.ox = p.ox;
        ps.oz = p.oz;
      }
      peds.push(ps);
    }
    const actors: ActorSave[] = [];
    for (let i = 0; i < this.actorCount; i++) {
      const a = this.actors[i] as ActorRec;
      const route: number[] = [];
      for (let k = 0; k < a.routeLen; k++) route.push(a.route[k] as number);
      actors.push({
        id: a.id, personId: a.person, role: a.role, callId: a.callId, profile: a.profile.id, state: a.state, x: a.x, z: a.z, yaw: a.yaw,
        speed: a.speed, stress: a.stress, timer: a.timer, stamina: a.stamina, flags: a.flags, weapon: a.weapon, vehicleId: a.vehicleId,
        seat: a.seat, body: a.body, targetX: a.tx, targetZ: a.tz, route, routePos: a.routePos, lostTimer: a.lost, acc: a.acc, age: a.age,
      });
      const saved = actors[actors.length - 1] as ActorSave;
      if (a.building !== -1) saved.building = a.building;
      if (a.aware > 0) saved.aware = a.aware;
      if (a.hideSpot >= 0) saved.hideSpot = a.hideSpot;
      if (a.refusedAge <= RESISTANCE_KEEP_S) saved.ra = a.refusedAge;
      if (a.resistedAge <= RESISTANCE_KEEP_S) saved.rs = a.resistedAge;
      if (a.attackedAge <= RESISTANCE_KEEP_S) {
        saved.at = a.attackedAge;
        saved.ak = a.attackKind;
      }
    }
    const pairs = (m: Map<number, number[]>): [number, number[]][] =>
      [...m.entries()].filter(([, v]) => v.length > 0).sort((x, y) => x[0] - y[0]).map(([k, v]) => [k, v.slice()]);
    return {
      version: 1,
      rng: this.rng.state(),
      pedsRng: this.pedsRng.state(),
      actorsRng: this.actorsRng.state(),
      step: this.stepCount,
      nextActorId: this.nextActorId,
      retargetIn: this.retargetIn,
      target: this.target,
      peds,
      actors,
      occupants: [...this.overrides.entries()].map(([k, v]) => [k, v.slice()]),
      occupantsSince: [...this.overrides.keys()].map((k): [number, number] => [k, this.overrideSince.get(k) ?? 0]),
      out: pairs(this.outSeats),
    };
  }

  /** Replaces the state with `save`; entries that do not fit the current data (unknown profile, bad edge) are dropped. */
  restore(save: NpcSave): void {
    if (!isNpcSave(save)) return;
    this.dispose();
    this.rng.restore(save.rng);
    this.pedsRng.restore(save.pedsRng);
    this.actorsRng.restore(save.actorsRng);
    this.stepCount = save.step;
    this.nextActorId = Math.max(1, save.nextActorId);
    this.retargetIn = save.retargetIn;
    this.target = Math.min(this.cfg.peds.max, Math.max(0, save.target));
    const people = this.people;
    for (const ps of save.peds) {
      if (this.pedCount >= this.cfg.peds.max) break;
      const e = this.edges[ps.edge];
      if (!e || e.length < 1 || ps.personId < 0 || ps.personId >= PERSON_POPULATION || this.active.has(ps.personId)) continue;
      const p = this.peds[this.pedCount] as PedRec;
      p.person = ps.personId;
      p.edge = ps.edge;
      p.s = clamp(ps.s, 0, e.length);
      p.side = ps.side < 0 ? -1 : 1;
      p.dir = ps.dir < 0 ? -1 : 1;
      p.base = ps.speed;
      p.gait = ps.gait;
      p.flee = Math.max(0, ps.flee);
      p.acc = ps.acc ?? 0;
      p.speed = p.flee > 0 ? this.cfg.actors.runSpeed[0] : p.base;
      p.ox = ps.ox ?? 0;
      p.oz = ps.oz ?? 0;
      this.placePed(p);
      p.prevX = p.x;
      p.prevZ = p.z;
      p.prevYaw = p.yaw;
      this.dressPed(p, ps.personId);
      this.active.add(ps.personId);
      this.pedCount++;
    }
    let maxId = 0;
    for (const s of save.actors) {
      if (this.actorCount >= this.cfg.actors.max) break;
      const profile = findBehavior(s.profile);
      if (!profile || this.byId.has(s.id) || s.id < 1) continue;
      if (s.personId >= PERSON_POPULATION || (s.personId >= 0 && this.active.has(s.personId))) continue;
      const a = this.actors[this.actorCount] as ActorRec;
      this.resetActor(a);
      a.id = s.id;
      a.person = s.personId;
      a.role = s.role;
      a.callId = s.callId;
      a.profile = profile;
      a.state = s.state;
      a.x = a.prevX = s.x;
      a.z = a.prevZ = s.z;
      a.yaw = a.prevYaw = s.yaw;
      a.speed = s.speed;
      a.stress = s.stress;
      a.timer = s.timer;
      a.stamina = s.stamina;
      a.flags = s.flags;
      a.weapon = s.weapon;
      a.vehicleId = s.vehicleId;
      a.seat = s.seat;
      a.body = s.body === BODY.dog ? BODY.dog : BODY.human;
      a.tx = s.targetX;
      a.tz = s.targetZ;
      const n = Math.min(s.route.length - (s.route.length % 2), a.route.length);
      for (let k = 0; k < n; k++) a.route[k] = s.route[k] as number;
      a.routeLen = n;
      a.routePos = Math.min(Math.max(0, s.routePos), n / 2);
      a.lost = s.lostTimer;
      a.acc = s.acc ?? 0;
      a.age = s.age ?? 0;
      a.building = s.building !== undefined && s.building >= -1 ? s.building : -1;
      a.aware = clamp(s.aware ?? 0, 0, 1);
      a.awareLevel = this.levelOfAware(a.aware);
      a.hideSpot = s.hideSpot !== undefined && s.hideSpot >= 0 ? s.hideSpot : -1;
      if (s.ra !== undefined) a.refusedAge = Math.max(0, s.ra);
      if (s.rs !== undefined) a.resistedAge = Math.max(0, s.rs);
      if (s.at !== undefined) {
        a.attackedAge = Math.max(0, s.at);
        a.attackKind = s.ak === ATTACK_FIRE || s.ak === ATTACK_BRANDISH ? s.ak : ATTACK_FIGHT;
      }
      this.derive(a);
      this.byId.set(a.id, a);
      if (a.person >= 0) this.active.add(a.person);
      this.actorCount++;
      maxId = Math.max(maxId, a.id);
    }
    this.nextActorId = Math.max(this.nextActorId, maxId + 1);
    for (const [vid, ids] of save.occupants) {
      const clean = ids.filter((id) => Number.isInteger(id) && id >= 0 && id < PERSON_POPULATION);
      this.overrides.set(vid, clean);
      const since = save.occupantsSince?.find((p) => p[0] === vid)?.[1];
      this.overrideSince.set(vid, typeof since === 'number' && Number.isFinite(since) ? since : this.stepCount);
    }
    for (const [vid, seats] of save.out) this.outSeats.set(vid, seats.filter((s) => Number.isInteger(s) && s >= 0));
    void people;
    this.publish();
  }

  /** Drops all pedestrians, actors and occupant state (the system can be stepped again afterwards). */
  dispose(): void {
    this.pedCount = 0;
    this.actorCount = 0;
    this.active.clear();
    this.byId.clear();
    this.overrides.clear();
    this.overrideSince.clear();
    this.outSeats.clear();
    this.occCache.clear();
    this.occCount = 0;
    this.queue.length = 0;
    this.view.count = 0;
    this.stats.peds = 0;
    this.stats.actors = 0;
    this.stats.occupants = 0;
  }
}
