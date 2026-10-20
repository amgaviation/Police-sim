/**
 * The dispatcher brain (design §8): call generation, offers to the player, assignment of AI units,
 * AI patrol-unit FSMs driving traffic fleet cars, backup, the emergency button, status checks with
 * escalation, 10-20 answers, plate/person runs, traffic-stop context, records upkeep and AVL.
 *
 * Determinism: bus handlers only enqueue; every state change happens inside `step` (fixed step,
 * order -700) and draws only from `deps.rng` children 'calls' and 'units'. Steady-state steps
 * allocate nothing; strings and objects are built on rare transitions (calls, requests, events).
 */
import { locationText } from '../cad/address';
import { DISPOSITIONS, findCallType } from '../cad/data';
import { plateRunNarrative, statusLabel } from '../cad/codes';
import { canAssign, canTransition, type CadState } from '../cad/cadState';
import type { Citation, Booking } from '../cad/documents';
import type {
  CadCall,
  CadLocation,
  CadTime,
  CadUnit,
  CallerInfo,
  Priority,
  RequestVia,
  StopAction,
  UnitRequest,
} from '../cad/types';
import '../cad/events';
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import type { GameWorld } from '../ecs/world';
import { PoliceLights, attachPoliceLights } from '../police/components';
import { normalizePlate, plateSummary, type RecordsDb } from '../records/db';
import { PERSON_POPULATION, vinOf } from '../records/ids';
import { displayName } from '../records/person';
import { driverOf, mountedPlate, observedVehicle, vehicleDescription } from '../records/vehicle';
import '../traffic/events';
import { REGISTRY_POPULATION } from '../traffic/registry';
import { isFleetVehicleId, type FleetState, type FleetUrgency, type TrafficSystem } from '../traffic/trafficSystem';
import { pickModelColor, vehicleModel } from '../vehicles/model';
import type { City } from '../world/city';
import { DISTRICT } from '../world/ids';
import { DISPATCH_CONFIG, UNITS_DATA, type AiUnitData, type DispatchConfig, type UnitsData } from './data';
import { CallGenerator } from './generator';
import type { DispatchSave, QueuedEvent, QueuedRequest, UnitFsmSave, UnitMode, UnitRole } from './save';

export interface PlayerUnitState {
  x: number;
  z: number;
  speed: number;
  inPoliceVehicle: boolean;
}

export interface DispatchDeps {
  readonly seed: number;
  readonly city: City;
  readonly cad: CadState;
  readonly records: RecordsDb;
  readonly traffic: TrafficSystem;
  readonly world: GameWorld;
  readonly bus: EventBus<EventMap>;
  /** session.rng.stream('dispatch'). */
  readonly rng: Rng;
  /** Overrides for tests; default the validated JSON. */
  readonly config?: DispatchConfig;
  readonly units?: UnitsData;
  /** Phase 6: roster name of an AI unit's officer (null = keep the `units.json` name). */
  readonly officerName?: (callsign: string) => string | null;
}

/** Phase 6 ETA ranker: lower is better, `Infinity` = unreachable (the unit is skipped). */
export type UnitRanker = (callsign: string, x: number, z: number, urgency: FleetUrgency) => number;

export interface DispatchStats {
  readonly generated: number;
  readonly open: number;
  readonly aiBusy: number;
}

/** Call types created by officers (never offered to the player). */
const OFFICER_TYPES: ReadonlySet<string> = new Set(['trafficStop', 'officerAssist', 'officerEmergency', 'officerWelfare']);
/** A unit counts as arrived this close to its destination (m), besides 'traffic:fleetArrived'. */
const ARRIVE_M = 30;
/** Below this speed a unit en route counts as stuck (m/s). */
const STUCK_SPEED = 0.5;
/** Route metres an en-route unit must gain to count as progress (resets the forced-arrival timer). */
const PROGRESS_M = 50;
/** Siren on above this speed in emergency mode (m/s). */
const SIREN_SPEED = 1;
/** Assignment pass interval when nothing changed (s). */
const ASSIGN_INTERVAL = 1;
/** Generator multiplier refresh interval (s). */
const MULTIPLIER_INTERVAL = 5;
/** Break and beat checks per patrolling unit (s). */
const PATROL_CHECK_S = 10;
/** A backup unit on scene re-routes when the player is farther than this from it (m). */
const BACKUP_FOLLOW_M = 60;
/** Missing fleet cars are re-spawned at most this often (s). */
const RESPAWN_S = 5;
/** Fleet spawn retry offsets around a beat centre (m), tried in order. */
const SPAWN_OFFSETS: readonly (readonly [number, number])[] = [
  [0, 0], [150, 0], [0, 150], [-150, 0], [0, -150], [300, 300], [-300, 300], [300, -300], [-300, -300], [600, 0], [0, 600], [-600, 0], [0, -600],
];
/** The ETA ranker only looks at this many nearest eligible units (by straight line). */
export const ETA_RANK_K = 4;
/** A release postponed by `setUnitHold` happens at the latest this long (sim s) after `releaseAt`. */
export const HOLD_MAX_S = 30;
const DEFAULT_ON_SCENE: readonly [number, number] = [120, 300];

interface AiUnit {
  readonly callsign: string;
  readonly fleetIndex: number;
  readonly data: AiUnitData;
  readonly modelIndex: number;
  readonly phase: number;
  readonly beatX: number;
  readonly beatZ: number;
  color: number;
  mode: UnitMode;
  role: UnitRole;
  callId: number | null;
  hasDest: boolean;
  destX: number;
  destZ: number;
  destEmergency: boolean;
  onSceneUntil: number;
  stuckSince: number;
  /** Start of the trip, then the last time the route got `PROGRESS_M` shorter (forced arrival only without progress). */
  enRouteSince: number;
  /** Shortest route length seen on this trip (-1 = not measured yet). */
  progressLeftM: number;
  breakUntil: number;
  releaseAt: number;
  nextBeatCheck: number;
  replanned: boolean;
  arrived: boolean;
  lastAvlX: number;
  lastAvlZ: number;
  /** Phase 6: sent to a point by `directUnit`; the backup retarget leaves it alone. */
  directed: boolean;
  /** Runtime only: entity the PoliceLights were attached to (0 = re-attach). */
  eid: number;
  present: boolean;
  nextRespawn: number;
  readonly fs: FleetState;
}

function time(t: CadTime): CadTime {
  return { sim: t.sim, game: t.game };
}

function newFleetState(): FleetState {
  return { eid: 0, x: 0, z: 0, yaw: 0, speed: 0, edge: 0, mode: 'patrol', arrived: false, parked: false, routeLeftM: -1 };
}

const DISPOSITION_IDS: ReadonlySet<string> = new Set(DISPOSITIONS.map((d) => d.id));

export class Dispatcher {
  readonly playerCallsign: string;
  readonly generator: CallGenerator;

  private readonly deps: DispatchDeps;
  private readonly cfg: DispatchConfig;
  private readonly roster: UnitsData;
  private readonly callsRng: Rng;
  private readonly unitsRng: Rng;
  private readonly units: AiUnit[] = [];
  private readonly unitByIndex = new Map<number, AiUnit>();
  private readonly picked: Uint8Array;
  private readonly pickedOut: AiUnit[] = [];
  /** Nearest-K candidates of one pick (ETA ranker): unit indices and straight-line distances. */
  private readonly rankIdx = new Int32Array(ETA_RANK_K);
  private readonly rankDist = new Float64Array(ETA_RANK_K);
  private ranker: UnitRanker | null = null;
  private holdFn: ((callsign: string) => boolean) | null = null;
  /** Time of the last step (for the public helpers that change CAD status). */
  private readonly lastT: { sim: number; game: number } = { sim: 0, game: 0 };
  private readonly unsubscribers: (() => void)[] = [];
  private events: QueuedEvent[] = [];
  private requests: QueuedRequest[] = [];

  private started = false;
  private nextCallSim = 0;
  private generated = 0;
  private multiplierValue = 1;
  private nextMultiplierSim = 0;
  private nextAssignSim = 0;
  private assignDirty = true;
  private nextAvlSim = 0;
  private nextRetargetSim = 0;
  private offerCallId = -1;
  private readonly declined = new Set<number>();
  private readonly plans = new Map<number, number>();
  private lastAnswerSim = 0;
  private checkAttempt = 0;
  private nextCheckSim = -1;
  private awaitingSince = -1;
  private locationAsked = false;
  private welfareCallId = -1;
  private emergencyActive = false;
  private emergencyCallId = -1;
  private backupTargetX = 0;
  private backupTargetZ = 0;
  private stopWarned = false;
  /** Scene hook: does open call `callId` own the stopped vehicle (a scenario's subject car or a pursuit)? */
  private stopOwner: ((callId: number, vehicleId: number) => boolean) | null = null;
  private driverResolver: ((vehicleId: number) => number) | null = null;
  private dispositionResolver: ((callId: number) => string | null) | null = null;
  /** Player state of the current step (requests and helpers read it). */
  private player: PlayerUnitState = { x: 0, z: 0, speed: 0, inPoliceVehicle: false };

  constructor(deps: DispatchDeps) {
    this.deps = deps;
    this.cfg = deps.config ?? DISPATCH_CONFIG;
    this.roster = deps.units ?? UNITS_DATA;
    this.playerCallsign = this.roster.player.callsign;
    this.callsRng = deps.rng.stream('calls');
    this.unitsRng = deps.rng.stream('units');
    this.generator = new CallGenerator(deps.city, deps.records, deps.seed, this.cfg.generator);
    this.picked = new Uint8Array(this.roster.units.length);
    const beats = new Map<string, { x: number; z: number }>();
    this.roster.units.forEach((data, i) => {
      let beat = beats.get(data.beat);
      if (!beat) {
        beat = beatCentre(deps.city, data.beat);
        beats.set(data.beat, beat);
      }
      const unit: AiUnit = {
        callsign: data.callsign,
        fleetIndex: i,
        data,
        modelIndex: vehicleModel(data.model).index,
        phase: i * 0.37,
        beatX: beat.x,
        beatZ: beat.z,
        color: 0,
        mode: 'patrol',
        role: 'call',
        callId: null,
        hasDest: false,
        destX: 0,
        destZ: 0,
        destEmergency: false,
        onSceneUntil: -1,
        stuckSince: -1,
        enRouteSince: -1,
        progressLeftM: -1,
        breakUntil: -1,
        releaseAt: -1,
        nextBeatCheck: 0,
        replanned: false,
        arrived: false,
        lastAvlX: 0,
        lastAvlZ: 0,
        directed: false,
        eid: 0,
        present: false,
        nextRespawn: 0,
        fs: newFleetState(),
      };
      this.units.push(unit);
      this.unitByIndex.set(i, unit);
    });
    const bus = deps.bus;
    this.unsubscribers.push(
      bus.on('unit:request', (e) => {
        this.requests.push({ callsign: e.callsign, request: e.request, via: e.via });
      }),
      bus.on('traffic:pulledOver', (e) => {
        this.events.push({ type: 'pulledOver', vehicleId: e.vehicleId, x: e.x, z: e.z });
      }),
      bus.on('traffic:released', (e) => {
        this.events.push({ type: 'released', vehicleId: e.vehicleId, reason: e.reason });
      }),
      bus.on('traffic:fleetArrived', (e) => {
        this.events.push({ type: 'fleetArrived', index: e.index });
      }),
      bus.on('cad:documentSaved', (e) => {
        this.events.push({ type: 'document', id: e.id, kind: e.kind, final: e.final });
      }),
    );
  }

  // --- Public API -------------------------------------------------------------------------------

  /** Roster -> CAD, fleet cars spawned at their beats with PoliceLights. Call before traffic populate. */
  start(t: CadTime, player: PlayerUnitState): void {
    const { cad, traffic, world } = this.deps;
    this.player = player;
    const p = this.roster.player;
    cad.addUnit({ callsign: p.callsign, kind: 'player', officer: p.officer, beat: p.beat, fleetIndex: -1 }, t);
    cad.setUnitPosition(p.callsign, player.x, player.z);
    for (const u of this.units) {
      cad.addUnit({ callsign: u.callsign, kind: 'ai', officer: this.officerOf(u), beat: u.data.beat, fleetIndex: u.fleetIndex }, t);
      u.color = pickModelColor(vehicleModel(u.data.model), this.unitsRng.next());
      const eid = this.spawnCar(u, u.beatX, u.beatZ);
      if (eid !== 0) {
        attachPoliceLights(world, eid, u.phase);
        u.eid = eid;
      }
      const fs = traffic.fleetState(u.fleetIndex, u.fs);
      u.present = fs !== null;
      u.lastAvlX = fs ? fs.x : u.beatX;
      u.lastAvlZ = fs ? fs.z : u.beatZ;
      cad.setUnitPosition(u.callsign, u.lastAvlX, u.lastAvlZ);
      u.nextBeatCheck = t.sim + PATROL_CHECK_S;
    }
    this.started = true;
    this.nextCallSim = t.sim + this.cfg.generator.firstCallDelayS;
    this.nextMultiplierSim = t.sim;
    this.nextAssignSim = t.sim;
    this.nextAvlSim = t.sim + this.cfg.avlIntervalS;
    this.nextRetargetSim = t.sim + this.cfg.backup.retargetS;
    this.lastAnswerSim = t.sim;
  }

  /** Fixed step (order -700). */
  step(dt: number, t: CadTime, player: PlayerUnitState): void {
    if (!this.started) return;
    this.player = player;
    this.lastT.sim = t.sim;
    this.lastT.game = t.game;
    this.drainEvents(t);
    this.drainRequests(t);
    this.generate(dt, t);
    this.offerTimeouts(t);
    if (this.assignDirty || t.sim >= this.nextAssignSim) this.assign(t);
    this.stepUnits(t);
    this.retarget(t);
    this.statusChecks(t);
    this.avl(t);
    this.syncLights();
  }

  /** Queues a request; applied at the start of the next step. */
  request(callsign: string, r: UnitRequest, via: RequestVia): void {
    this.requests.push({ callsign, request: r, via });
  }

  /**
   * Scene hook (design §11.1): when the player pulls over a car that the call they are on owns (the subject
   * vehicle of a DUI scenario, a pursuit), the stop attaches to that call instead of being refused.
   */
  /** The person actually driving `vehicleId` in the world (the NPC occupant), or -1 to use the registry driver. */
  setDriverResolver(fn: ((vehicleId: number) => number) | null): void {
    this.driverResolver = fn;
  }

  /**
   * Phase 5: community trust feeds the crime rate. `fn(district)` multiplies the call generator's rate multiplier
   * (see `CallGenerator.setCrimeFactor`); `null` removes it. It takes effect at the next multiplier refresh.
   */
  setCrimeFactor(fn: ((district: string) => number) | null): void {
    this.generator.setCrimeFactor(fn);
  }

  /**
   * Phase 6 ETA ranker: when set, `pickUnits` keeps the nearest `ETA_RANK_K` eligible units by straight line and
   * picks the one with the lowest `fn(callsign, x, z, urgency)` (`Infinity` = unreachable, skipped; ties go to the
   * nearer unit). `null` restores the plain nearest pick.
   */
  setUnitRanker(fn: UnitRanker | null): void {
    this.ranker = fn;
  }

  /**
   * Phase 6: sends AI unit `callsign` (assigned to a call) to (x, z) at `urgency`. It stops following the player
   * (the backup retarget skips it) until `undirectUnit`; CAD status enRoute, arrival -> onScene as usual.
   * False when the unit is unknown, has no call or has no car.
   */
  directUnit(callsign: string, x: number, z: number, urgency: FleetUrgency): boolean {
    const u = this.units.find((v) => v.callsign === callsign);
    if (!u || u.callId === null || u.mode === 'patrol' || u.mode === 'beat' || u.mode === 'break') return false;
    if (!this.deps.traffic.setFleetDestination(u.fleetIndex, x, z, urgency)) return false;
    const t = time(this.lastT);
    this.deps.cad.setUnitStatus(u.callsign, 'enRoute', t, 'auto');
    u.directed = true;
    u.mode = 'enRoute';
    u.hasDest = true;
    u.destX = x;
    u.destZ = z;
    u.destEmergency = urgency === 'emergency';
    u.enRouteSince = t.sim;
    u.progressLeftM = -1;
    u.stuckSince = -1;
    u.onSceneUntil = -1;
    u.replanned = false;
    u.arrived = false;
    return true;
  }

  /** Phase 6: the unit follows the player again (backup retarget). */
  undirectUnit(callsign: string): void {
    const u = this.units.find((v) => v.callsign === callsign);
    if (u) u.directed = false;
  }

  /** Phase 6: while `fn(callsign)` is true a release (Code 4 / `releaseAt`) is postponed, at most `HOLD_MAX_S` past `releaseAt`. */
  setUnitHold(fn: ((callsign: string) => boolean) | null): void {
    this.holdFn = fn;
  }

  /** Phase 6: AI patrol callsigns assigned to `callId` (fills and returns `out`). */
  aiUnitsOnCall(callId: number, out: string[]): string[] {
    out.length = 0;
    for (const u of this.units) if (u.callId === callId) out.push(u.callsign);
    return out;
  }

  /**
   * Phase 6: sends `n` more patrol units to the player's current call at `code` (the backup request without the
   * radio acknowledgement). Returns their callsigns; none without an open call of the player.
   */
  sendBackup(code: 2 | 3, n: number): string[] {
    const { cad } = this.deps;
    const pu = cad.unit(this.playerCallsign);
    const call = pu && pu.callId !== null ? cad.call(pu.callId) : null;
    if (!call || call.status === 'closed' || n < 1) return [];
    const p = this.player;
    const urgency: FleetUrgency = code === 3 ? 'emergency' : 'respond';
    const units = this.pickUnits(n, p.x, p.z, call.id, 'preemptLow', urgency);
    const t = time(this.lastT);
    for (const u of units) this.dispatchUnit(u, call.id, p.x, p.z, urgency, 'backup', 'backup', t);
    if (units.length > 0) this.setBackupTarget(t);
    return units.map((u) => u.callsign);
  }

  /** CAD location of the point (x, z). */
  locate(x: number, z: number): CadLocation {
    return this.generator.locate(x, z);
  }

  /** The call's location changed (a correction): units still on their way go to the new spot. */
  callRelocated(callId: number, x: number, z: number): void {
    for (const u of this.units) {
      if (u.callId !== callId || u.mode !== 'enRoute' || !u.hasDest) continue;
      u.destX = x;
      u.destZ = z;
      this.deps.traffic.setFleetDestination(u.fleetIndex, x, z, u.destEmergency ? 'emergency' : 'respond');
    }
  }

  /** The disposition the scenario of `callId` earned (what actually happened there), or null for a call without one. */
  setDispositionResolver(fn: ((callId: number) => string | null) | null): void {
    this.dispositionResolver = fn;
  }

  private scenarioDisposition(callId: number): string | null {
    const d = this.dispositionResolver?.(callId) ?? null;
    return d !== null && DISPOSITION_IDS.has(d) ? d : null;
  }

  private trueDriverOf(vehicleId: number): number {
    const id = this.driverResolver?.(vehicleId) ?? -1;
    return id >= 0 && id < PERSON_POPULATION ? id : driverOf(this.deps.seed, vehicleId);
  }

  setStopOwner(fn: ((callId: number, vehicleId: number) => boolean) | null): void {
    this.stopOwner = fn;
  }

  /**
   * Opens a self-initiated call at `at` (field contact, pursuit): the player is assigned (by 'self') and
   * on scene at once, no AI unit is planned. A dispatched call the player leaves for it without other units goes
   * back to the AI units (and is not offered to the player again); a self-initiated one is over and closed.
   */
  openSelfInitiated(
    typeId: string,
    priority: Priority,
    at: { x: number; z: number },
    narrative: string,
    t: CadTime,
    persons: readonly number[] = [],
    vehicles: readonly number[] = [],
  ): CadCall {
    const { cad } = this.deps;
    const pc = this.playerCallsign;
    const location = this.generator.locate(at.x, at.z);
    const call = this.openCall(typeId, priority, location, this.officerCaller(), narrative, t, true, persons, vehicles);
    this.plans.set(call.id, 0);
    this.withdrawOffer(t);
    this.makeAssignable(t);
    const prevId = cad.unit(pc)?.callId ?? null;
    cad.assign(call.id, pc, t, 'self');
    cad.setUnitStatus(pc, 'onScene', t, 'auto');
    if (prevId !== null && prevId !== call.id) {
      const prev = cad.call(prevId);
      if (prev && prev.status !== 'closed' && prev.units.length === 0) {
        this.declined.add(prevId);
        if (prev.selfInitiated) cad.closeCall(prevId, this.scenarioDisposition(prevId) ?? 'handled', t);
      }
    }
    this.assignDirty = true;
    return call;
  }

  /** Debug/tests: creates a call of `typeId` now (at `at`, else a generated location); null when impossible. */
  createCall(typeId: string, t: CadTime, at?: { x: number; z: number }): CadCall | null {
    const type = findCallType(typeId);
    if (!type) return null;
    const g = this.generator.generate(this.callsRng, this.player.x, this.player.z, this.playerCallsign, t.game, type, at);
    if (!g) return null;
    return this.openCall(g.typeId, g.priority, g.location, g.caller, g.narrative, t, false, g.persons, g.vehicles);
  }

  /** The player's destination: their assigned call's location. */
  playerDestination(out: { x: number; z: number }): boolean {
    const pu = this.deps.cad.unit(this.playerCallsign);
    if (!pu || pu.callId === null) return false;
    const call = this.deps.cad.call(pu.callId);
    if (!call || call.status === 'closed') return false;
    out.x = call.location.x;
    out.z = call.location.z;
    return true;
  }

  get stats(): DispatchStats {
    let open = 0;
    for (const c of this.deps.cad.calls()) if (c.status !== 'closed') open++;
    let aiBusy = 0;
    for (const u of this.units) if (this.deps.cad.unit(u.callsign)?.status !== 'available') aiBusy++;
    return { generated: this.generated, open, aiBusy };
  }

  /** AI unit FSM summaries (console / tests). */
  unitStates(): { callsign: string; fleetIndex: number; mode: UnitMode; role: UnitRole; callId: number | null }[] {
    return this.units.map((u) => ({ callsign: u.callsign, fleetIndex: u.fleetIndex, mode: u.mode, role: u.role, callId: u.callId }));
  }

  serialize(): DispatchSave {
    return {
      version: 1,
      started: this.started,
      rng: { main: this.deps.rng.state(), calls: this.callsRng.state(), units: this.unitsRng.state() },
      generator: {
        nextCallSim: this.nextCallSim,
        generated: this.generated,
        multiplier: this.multiplierValue,
        nextMultiplierSim: this.nextMultiplierSim,
      },
      timers: { nextAssignSim: this.nextAssignSim, assignDirty: this.assignDirty, nextAvlSim: this.nextAvlSim, nextRetargetSim: this.nextRetargetSim },
      units: this.units.map((u): UnitFsmSave => ({
        callsign: u.callsign,
        fleetIndex: u.fleetIndex,
        color: u.color,
        mode: u.mode,
        role: u.role,
        callId: u.callId,
        dest: u.hasDest ? { x: u.destX, z: u.destZ, emergency: u.destEmergency } : null,
        timers: {
          onSceneUntil: u.onSceneUntil,
          stuckSince: u.stuckSince,
          enRouteSince: u.enRouteSince,
          progressLeftM: u.progressLeftM,
          breakUntil: u.breakUntil,
          releaseAt: u.releaseAt,
          nextBeatCheck: u.nextBeatCheck,
        },
        replanned: u.replanned,
        arrived: u.arrived,
        lastAvl: [u.lastAvlX, u.lastAvlZ],
        ...(u.directed ? { directed: true } : {}),
      })),
      offer: { callId: this.offerCallId, declined: [...this.declined] },
      plans: [...this.plans],
      statusCheck: {
        lastAnswerSim: this.lastAnswerSim,
        attempt: this.checkAttempt,
        nextCheckSim: this.nextCheckSim,
        awaitingSince: this.awaitingSince,
        locationAsked: this.locationAsked,
        welfareCallId: this.welfareCallId,
      },
      emergency: { active: this.emergencyActive, callId: this.emergencyCallId },
      backup: { targetX: this.backupTargetX, targetZ: this.backupTargetZ },
      stop: { warned: this.stopWarned },
      events: structuredClone(this.events),
      requests: structuredClone(this.requests),
    };
  }

  /**
   * Restores the dispatcher (after `CadState.restore` and `TrafficSystem.restore`): units are re-linked
   * by fleet index (save entries for unknown indices are ignored), PoliceLights are re-attached on the
   * next step.
   */
  restore(save: DispatchSave, t: CadTime = { sim: 0, game: 0 }): void {
    this.deps.rng.restore(save.rng.main);
    this.callsRng.restore(save.rng.calls);
    this.unitsRng.restore(save.rng.units);
    this.started = save.started;
    this.nextCallSim = save.generator.nextCallSim;
    this.generated = save.generator.generated;
    this.multiplierValue = save.generator.multiplier;
    this.nextMultiplierSim = save.generator.nextMultiplierSim;
    this.nextAssignSim = save.timers.nextAssignSim;
    this.assignDirty = save.timers.assignDirty;
    this.nextAvlSim = save.timers.nextAvlSim;
    this.nextRetargetSim = save.timers.nextRetargetSim;
    for (const u of this.units) this.resetUnit(u, save.timers.nextAssignSim);
    for (const s of save.units) {
      const u = this.unitByIndex.get(s.fleetIndex);
      if (!u || u.callsign !== s.callsign) continue;
      u.color = s.color;
      u.mode = s.mode;
      u.role = s.role;
      u.callId = s.callId;
      u.hasDest = s.dest !== null;
      u.destX = s.dest?.x ?? 0;
      u.destZ = s.dest?.z ?? 0;
      u.destEmergency = s.dest?.emergency ?? false;
      u.onSceneUntil = s.timers.onSceneUntil;
      u.stuckSince = s.timers.stuckSince;
      u.enRouteSince = s.timers.enRouteSince;
      u.progressLeftM = s.timers.progressLeftM ?? -1;
      u.breakUntil = s.timers.breakUntil;
      u.releaseAt = s.timers.releaseAt;
      u.nextBeatCheck = s.timers.nextBeatCheck;
      u.replanned = s.replanned;
      u.arrived = s.arrived;
      u.lastAvlX = s.lastAvl[0];
      u.lastAvlZ = s.lastAvl[1];
      u.directed = s.directed === true;
    }
    for (const u of this.units) {
      u.eid = 0;
      u.present = this.deps.traffic.fleetState(u.fleetIndex, u.fs) !== null;
    }
    this.offerCallId = save.offer.callId;
    this.declined.clear();
    for (const id of save.offer.declined) this.declined.add(id);
    this.plans.clear();
    for (const [id, n] of save.plans) this.plans.set(id, n);
    const sc = save.statusCheck;
    this.lastAnswerSim = sc.lastAnswerSim;
    this.checkAttempt = sc.attempt;
    this.nextCheckSim = sc.nextCheckSim;
    this.awaitingSince = sc.awaitingSince;
    this.locationAsked = sc.locationAsked;
    this.welfareCallId = sc.welfareCallId;
    this.emergencyActive = save.emergency.active;
    this.emergencyCallId = save.emergency.callId;
    this.backupTargetX = save.backup.targetX;
    this.backupTargetZ = save.backup.targetZ;
    this.stopWarned = save.stop.warned;
    this.events = structuredClone(save.events);
    this.requests = structuredClone(save.requests);
    this.reconcileRoster(t);
  }

  /**
   * After a load, CAD matches the current roster (units.json may have changed since the save): a roster
   * unit missing from CAD is added at its car (spawned by the step like any absent car) or beat; a CAD AI
   * unit without a roster entry is removed.
   */
  private reconcileRoster(t: CadTime): void {
    const { cad, traffic } = this.deps;
    for (const u of this.units) {
      if (cad.unit(u.callsign)) continue;
      cad.addUnit({ callsign: u.callsign, kind: 'ai', officer: this.officerOf(u), beat: u.data.beat, fleetIndex: u.fleetIndex }, t);
      const fs = traffic.fleetState(u.fleetIndex, u.fs);
      u.lastAvlX = fs ? fs.x : u.beatX;
      u.lastAvlZ = fs ? fs.z : u.beatZ;
      cad.setUnitPosition(u.callsign, u.lastAvlX, u.lastAvlZ);
    }
    for (const cu of [...cad.units()]) {
      if (cu.kind === 'ai' && !this.units.some((u) => u.callsign === cu.callsign)) cad.removeUnit(cu.callsign);
    }
  }

  private officerOf(u: AiUnit): string {
    return this.deps.officerName?.(u.callsign) ?? u.data.officer;
  }

  /** Dispatch is waiting for the player's answer to a status check (survives save/load; HUD and in-car screen). */
  get statusCheckPending(): boolean {
    return this.checkAttempt > 0;
  }

  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.events.length = 0;
    this.requests.length = 0;
  }

  // --- Event queue ------------------------------------------------------------------------------

  private drainEvents(t: CadTime): void {
    if (this.events.length === 0) return;
    const list = this.events;
    this.events = [];
    for (const e of list) {
      switch (e.type) {
        case 'fleetArrived': {
          const u = this.unitByIndex.get(e.index);
          if (u) u.arrived = true;
          break;
        }
        case 'pulledOver':
          this.onPulledOver(e.vehicleId, e.x, e.z, t);
          break;
        case 'released':
          this.onReleased(e.vehicleId, e.reason, t);
          break;
        case 'document':
          if (e.final) this.onDocument(e.id, t);
          break;
      }
    }
  }

  private onPulledOver(vehicleId: number, x: number, z: number, t: CadTime): void {
    if (isFleetVehicleId(vehicleId) || vehicleId < 0 || vehicleId >= REGISTRY_POPULATION) return;
    const { cad, seed, records } = this.deps;
    // A stop never takes the player off another call they are on (en route or on scene), nor off a
    // stop that ended in an arrest and is still open (its booking needs it): the car is let go.
    const pcall = cad.playerUnit()?.callId ?? null;
    const current = pcall !== null ? cad.call(pcall) : null;
    const cur = cad.trafficStop;
    const activeStopCall = current !== null && current.typeId === 'trafficStop' && cur?.callId === current.id && cur.outcome === 'active';
    const owned = current !== null && current.status !== 'closed' && !activeStopCall && this.stopOwner !== null && this.stopOwner(current.id, vehicleId);
    if (current && current.status !== 'closed' && !activeStopCall && !owned) {
      this.deps.traffic.releaseStop();
      this.ack(this.playerCallsign, 'trafficStop', false, `Clear ${current.number} first`);
      return;
    }
    const prev = cad.trafficStop;
    if (prev && prev.outcome === 'active') this.endStop('lost', 'handled', t);
    const pc = this.playerCallsign;
    let call: CadCall;
    if (owned && current) {
      // The stopped car belongs to the call the player is on: the stop runs on that call.
      call = current;
      cad.addNarrative(call.id, pc, `Vehicle stopped, plate ${mountedPlate(seed, vehicleId).plate}.`, t);
      if (!call.vehicles.includes(vehicleId)) call.vehicles.push(vehicleId);
      cad.setUnitStatus(pc, 'onScene', t, 'auto');
    } else {
      const type = findCallType('trafficStop');
      const location = this.generator.locate(x, z);
      const caller = this.officerCaller();
      const vehicles = [vehicleId];
      const narrative = type ? this.generator.narrative(type, this.callsRng, location, caller, vehicles, vehicleId) : `Traffic stop at ${location.near}.`;
      call = this.openCall('trafficStop', 4, location, caller, narrative, t, true, [], vehicles);
      this.withdrawOffer(t);
      this.makeAssignable(t);
      cad.assign(call.id, pc, t, 'self');
      cad.setUnitStatus(pc, 'onScene', t, 'auto');
    }
    cad.setTrafficStop(
      {
        callId: call.id,
        vehicleId,
        plate: mountedPlate(seed, vehicleId).plate,
        x,
        z,
        started: time(t),
        driverId: -1,
        trueDriverId: this.trueDriverOf(vehicleId),
        plateRun: false,
        vinChecked: false,
        vinResult: '',
        citations: [],
        outcome: 'active',
      },
      t,
    );
    this.stopWarned = false;
    // Touch the stopped car's registration so it persists with the call.
    records.registration(vehicleId);
  }

  private onReleased(vehicleId: number, reason: 'released' | 'abandoned' | 'lost' | 'fled', t: CadTime): void {
    const stop = this.deps.cad.trafficStop;
    if (!stop || stop.outcome !== 'active' || stop.vehicleId !== vehicleId) return;
    if (reason === 'released') this.endStop('released', this.stopDisposition(), t);
    else if (reason === 'fled') this.endStop('lost', 'reportTaken', t, 'Stopped vehicle fled from the stop.');
    else this.endStop('lost', 'handled', t);
  }

  /** Ends the active stop with `outcome` and closes its call with `disposition`. */
  private endStop(outcome: 'released' | 'lost', disposition: string, t: CadTime, note?: string): void {
    const { cad } = this.deps;
    const stop = cad.trafficStop;
    if (!stop) return;
    cad.updateTrafficStop({ outcome }, t);
    cad.addNarrative(stop.callId, this.playerCallsign, note ?? (outcome === 'released' ? 'Vehicle released.' : 'Stopped vehicle left the scene.'), t);
    this.closeOwnCall(stop.callId, disposition, t);
  }

  private stopDisposition(): string {
    const stop = this.deps.cad.trafficStop;
    if (stop && stop.citations.length > 0) return 'citationIssued';
    return this.stopWarned ? 'warningIssued' : 'handled';
  }

  private onDocument(id: string, t: CadTime): void {
    const { cad } = this.deps;
    const doc = cad.docs.get(id);
    if (!doc || doc.status !== 'final') return;
    if (doc.kind === 'citation') this.onCitation(doc, t);
    else if (doc.kind === 'booking') this.onBooking(doc, t);
  }

  private onCitation(doc: Citation, t: CadTime): void {
    const { cad, records } = this.deps;
    if (doc.personId >= 0 && doc.personId < PERSON_POPULATION && !this.hasContact(doc.personId, doc.id)) {
      const summary = doc.violations.length > 0 ? doc.violations.map((v) => v.statuteId).join(', ') : 'Citation';
      records.addContact(doc.personId, { gameSeconds: t.game, kind: 'citation', ref: doc.id, summary: `Cited: ${summary}` });
    }
    const stop = cad.trafficStop;
    if (stop && doc.callId !== null && doc.callId === stop.callId && !stop.citations.includes(doc.id)) {
      cad.updateTrafficStop({ citations: [...stop.citations, doc.id] }, t);
    }
  }

  private onBooking(doc: Booking, t: CadTime): void {
    const { records } = this.deps;
    if (doc.personId < 0 || doc.personId >= PERSON_POPULATION) return;
    if (!this.hasContact(doc.personId, doc.id)) {
      const charges = doc.charges.length > 0 ? doc.charges.join(', ') : 'no charges listed';
      records.addContact(doc.personId, { gameSeconds: t.game, kind: 'arrest', ref: doc.id, summary: `Booked: ${charges}` });
    }
    if (doc.charges.includes('PC-220')) {
      for (const w of records.person(doc.personId).warrants) records.serveWarrant(doc.personId, w.id);
    }
  }

  private hasContact(personId: number, ref: string): boolean {
    return this.deps.records.person(personId).priors.some((p) => p.ref === ref);
  }

  // --- Requests ---------------------------------------------------------------------------------

  private drainRequests(t: CadTime): void {
    if (this.requests.length === 0) return;
    const list = this.requests;
    this.requests = [];
    for (const q of list) this.handleRequest(q, t);
  }

  private handleRequest(q: QueuedRequest, t: CadTime): void {
    const r = q.request;
    if (q.callsign !== this.playerCallsign || !this.deps.cad.unit(q.callsign)) {
      this.ack(q.callsign, r.kind, false, 'Unknown unit');
      return;
    }
    this.answered(t);
    switch (r.kind) {
      case 'status':
        this.reqStatus(r.status, q.via, t);
        break;
      case 'acceptCall':
        this.reqAccept(r.callId, t);
        break;
      case 'declineCall':
        this.reqDecline(r.callId, t);
        break;
      case 'selfAssign':
        this.reqSelfAssign(r.callId, t);
        break;
      case 'clearCall':
        this.reqClear(r.callId, r.disposition, t);
        break;
      case 'narrative':
        this.reqNarrative(r.callId, r.text, t);
        break;
      case 'runPlate':
        this.reqRunPlate(r.plate, r.vehicleId, q.via, t);
        break;
      case 'runPerson':
        this.reqRunPerson(r.personId, q.via);
        break;
      case 'backup':
        this.reqBackup(r.code, t);
        break;
      case 'location':
        this.reqLocation();
        break;
      case 'code4':
        this.reqCode4(t);
        break;
      case 'emergency':
        this.reqEmergency(t);
        break;
      case 'trafficStop':
        this.reqTrafficStop();
        break;
      case 'stopContact':
        this.reqStopContact(r.action, t, r.personId);
        break;
      case 'resource':
        // Phase 6: the resources module handles it from the bus (no acknowledgement here).
        break;
      case 'repeat':
        break;
    }
  }

  private ack(callsign: string, kind: UnitRequest['kind'], ok: boolean, text: string): void {
    this.deps.bus.emit('dispatch:ack', { callsign, kind, ok, text });
  }

  private reqStatus(status: CadUnit['status'], via: RequestVia, t: CadTime): void {
    const pc = this.playerCallsign;
    const { cad } = this.deps;
    const pu = cad.unit(pc);
    // "En route" accepts a pending offer only when the player is free (never drops a current call).
    if (status === 'enRoute' && this.offerCallId >= 0 && pu?.callId === null) {
      this.reqAccept(this.offerCallId, t, 'status');
      return;
    }
    const before = pu?.status ?? 'available';
    // 10-8 / 10-7 on a call clears it (an active stop is released), not handed to an AI unit.
    if ((status === 'available' || status === 'outOfService') && pu && pu.callId !== null && canTransition(before, status)) {
      // Clearing the emergency call is a Code 4.
      if (this.emergencyActive && pu.callId === this.emergencyCallId) this.reqCode4(t);
      this.leaveOwnCall(t);
    }
    if (status !== 'available') this.withdrawOffer(t);
    const prevCall = pu?.callId ?? null;
    const ok = cad.setUnitStatus(pc, status, t, via);
    if (ok) {
      this.assignDirty = true;
      // Leaving a call by status: it goes back to the AI units, never offered to the player again.
      if (prevCall !== null && pu?.callId === null) this.declined.add(prevCall);
    }
    this.ack(pc, 'status', ok, ok ? statusLabel(status) : `Unable: ${statusLabel(before)} to ${statusLabel(status)}`);
  }

  private reqAccept(callId: number, t: CadTime, kind: 'acceptCall' | 'status' = 'acceptCall'): void {
    const { cad } = this.deps;
    const pc = this.playerCallsign;
    const call = cad.call(callId);
    if (!call || call.status === 'closed' || call.offeredTo !== pc) {
      this.ack(pc, kind, false, 'No call offered');
      return;
    }
    const refused = this.assignRefusal();
    if (refused !== null) {
      this.ack(pc, kind, false, refused);
      return;
    }
    cad.assign(callId, pc, t, 'dispatch');
    if (this.offerCallId === callId) this.offerCallId = -1;
    this.ack(pc, kind, true, `En route to ${call.number}, ${call.location.text}`);
  }

  private reqDecline(callId: number, t: CadTime): void {
    const { cad } = this.deps;
    const pc = this.playerCallsign;
    const call = cad.call(callId);
    if (!call || call.status === 'closed' || call.offeredTo !== pc) {
      this.ack(pc, 'declineCall', false, 'No call offered');
      return;
    }
    cad.offer(callId, null, 0, t);
    this.declined.add(callId);
    if (this.offerCallId === callId) this.offerCallId = -1;
    this.assignDirty = true;
    this.ack(pc, 'declineCall', true, `${call.number} declined`);
  }

  private reqSelfAssign(callId: number, t: CadTime): void {
    const { cad } = this.deps;
    const pc = this.playerCallsign;
    const call = cad.call(callId);
    if (!call || call.status === 'closed') {
      this.ack(pc, 'selfAssign', false, 'Unknown call');
      return;
    }
    if (call.units.includes(pc)) {
      this.ack(pc, 'selfAssign', false, `Already on ${call.number}`);
      return;
    }
    const refused = this.assignRefusal();
    if (refused !== null) {
      this.ack(pc, 'selfAssign', false, refused);
      return;
    }
    if (this.offerCallId === callId) this.offerCallId = -1;
    else this.withdrawOffer(t);
    cad.assign(callId, pc, t, 'self');
    this.assignDirty = true;
    this.ack(pc, 'selfAssign', true, `Assigned to ${call.number}`);
  }

  private reqClear(callId: number, disposition: string, t: CadTime): void {
    const { cad } = this.deps;
    const pc = this.playerCallsign;
    const call = cad.call(callId);
    if (!call || call.status === 'closed' || !call.units.includes(pc)) {
      this.ack(pc, 'clearCall', false, 'Not on that call');
      return;
    }
    if (!DISPOSITION_IDS.has(disposition)) {
      this.ack(pc, 'clearCall', false, `Unknown disposition ${disposition}`);
      return;
    }
    const stop = cad.trafficStop;
    if (stop && stop.callId === callId && stop.outcome === 'active') {
      this.deps.traffic.releaseStop();
      cad.updateTrafficStop({ outcome: 'released' }, t);
    }
    this.closeOwnCall(callId, disposition, t);
    this.ack(pc, 'clearCall', true, `${call.number} clear`);
  }

  /**
   * The player leaves call `callId`: units there only for the player (backup / emergency / welfare)
   * are released, then the call closes with `disposition` when the player was the last unit, else the
   * player is just unassigned.
   */
  private closeOwnCall(callId: number, disposition: string, t: CadTime): void {
    const { cad } = this.deps;
    const pc = this.playerCallsign;
    const call = cad.call(callId);
    if (!call || call.status === 'closed') return;
    for (const u of this.units) {
      if (u.callId === callId && u.role !== 'call') {
        cad.unassign(u.callsign, t);
        this.toPatrol(u, t);
      }
    }
    let others = 0;
    for (const cs of call.units) if (cs !== pc) others++;
    if (others === 0) cad.closeCall(callId, disposition, t);
    else if (cad.unit(pc)?.callId === callId) cad.unassign(pc, t);
    this.assignDirty = true;
  }

  /**
   * The player leaves their current call: an active traffic stop on it is released; a dispatched call
   * nobody has reached returns to the queue; otherwise the call closes with its default disposition
   * when the player was the last unit, else the player is unassigned (the remaining units keep it).
   */
  private leaveOwnCall(t: CadTime): void {
    const { cad } = this.deps;
    const callId = cad.unit(this.playerCallsign)?.callId ?? null;
    if (callId === null) return;
    const stop = cad.trafficStop;
    if (stop && stop.outcome === 'active' && stop.callId === callId) {
      this.deps.traffic.releaseStop();
      this.endStop('released', this.stopDisposition(), t);
      return;
    }
    // A dispatched call nobody reached yet is not handled: it goes back to the queue for the AI units.
    const call = cad.call(callId);
    const status = cad.unit(this.playerCallsign)?.status;
    const arrived = status === 'onScene' || status === 'busy' || status === 'transporting' || (call?.firstOnScene ?? null) !== null;
    if (call && !call.selfInitiated && !arrived) {
      for (const u of this.units) {
        if (u.callId === callId && u.role !== 'call') {
          cad.unassign(u.callsign, t);
          this.toPatrol(u, t);
        }
      }
      cad.unassign(this.playerCallsign, t);
      this.declined.add(callId);
      this.assignDirty = true;
      return;
    }
    this.closeOwnCall(callId, this.defaultDisposition(callId), t);
  }

  /** A self-initiated contact (stop, backup request) brings an out-of-service or transporting player back into service first. */
  private makeAssignable(t: CadTime): void {
    const pu = this.deps.cad.unit(this.playerCallsign);
    if (!pu || canAssign(pu.status)) return;
    this.leaveOwnCall(t);
    this.deps.cad.setUnitStatus(this.playerCallsign, 'available', t, 'auto');
  }

  /** Disposition used when the player clears a call without choosing one. */
  defaultDisposition(callId: number): string {
    const { cad } = this.deps;
    const stop = cad.trafficStop;
    if (stop && stop.callId === callId) return stop.outcome === 'arrest' ? 'arrestMade' : this.stopDisposition();
    const earned = this.scenarioDisposition(callId);
    if (earned !== null) return earned;
    const call = cad.call(callId);
    const first = call ? findCallType(call.typeId)?.dispositions[0] : undefined;
    return first !== undefined && DISPOSITION_IDS.has(first) ? first : 'handled';
  }

  /** Why the player may not take a call now (null = may): out of service, transporting, or on an active traffic stop. */
  private assignRefusal(): string | null {
    const { cad } = this.deps;
    const pu = cad.unit(this.playerCallsign);
    if (!pu) return 'Unknown unit';
    if (!canAssign(pu.status)) return `Unable: ${statusLabel(pu.status)}`;
    const stop = cad.trafficStop;
    if (stop && stop.outcome === 'active' && stop.callId === pu.callId) return 'Clear the traffic stop first';
    return null;
  }

  /** Withdraws a pending offer to the player (it goes to the AI units). */
  private withdrawOffer(t: CadTime): void {
    if (this.offerCallId < 0) return;
    const call = this.deps.cad.call(this.offerCallId);
    if (call && call.status !== 'closed' && call.offeredTo === this.playerCallsign) this.deps.cad.offer(call.id, null, 0, t);
    this.declined.add(this.offerCallId);
    this.offerCallId = -1;
    this.assignDirty = true;
  }

  private reqNarrative(callId: number, text: string, t: CadTime): void {
    const { cad } = this.deps;
    const pc = this.playerCallsign;
    const call = cad.call(callId);
    if (!call || text.trim() === '') {
      this.ack(pc, 'narrative', false, call ? 'Empty narrative' : 'Unknown call');
      return;
    }
    cad.addNarrative(callId, pc, text.trim(), t);
    this.ack(pc, 'narrative', true, `Narrative added to ${call.number}`);
  }

  private reqRunPlate(plate: string, vehicleId: number, via: RequestVia, t: CadTime): void {
    const { cad, records, seed, bus } = this.deps;
    const pc = this.playerCallsign;
    if (plate.trim() === '') {
      this.ack(pc, 'runPlate', false, 'No plate');
      return;
    }
    const stop = cad.trafficStop;
    const active = stop !== null && stop.outcome === 'active';
    // The stop car's plate (e.g. read out while another car is under the reticle) is run against the
    // stop car, so a description mismatch still shows.
    const vid = vehicleId < 0 && active && normalizePlate(plate) === stop.plate ? stop.vehicleId : vehicleId;
    const registered = vid >= 0 && vid < REGISTRY_POPULATION && !isFleetVehicleId(vid);
    const observed = registered ? observedVehicle(seed, vid) : undefined;
    const readback = plateSummary(records.runPlate(plate, observed, t.game));
    bus.emit('dispatch:plateResult', { callsign: pc, via, vehicleId: vid, readback });
    if (active && vid === stop.vehicleId) {
      if (!stop.plateRun) cad.updateTrafficStop({ plateRun: true }, t);
      cad.addNarrative(stop.callId, 'CAD', plateRunNarrative(readback), t);
    }
  }

  private reqRunPerson(personId: number, via: RequestVia): void {
    const pc = this.playerCallsign;
    if (!Number.isInteger(personId) || personId < 0 || personId >= PERSON_POPULATION) {
      this.ack(pc, 'runPerson', false, 'Unknown person');
      return;
    }
    const readback = this.deps.records.personSummary(personId);
    this.deps.bus.emit('dispatch:personResult', { callsign: pc, via, readback });
  }

  private reqBackup(code: 2 | 3, t: CadTime): void {
    const { cad, bus } = this.deps;
    const pc = this.playerCallsign;
    const pu = cad.unit(pc);
    const p = this.player;
    let call = pu && pu.callId !== null ? cad.call(pu.callId) : null;
    if (!call || call.status === 'closed') {
      const location = this.generator.locate(p.x, p.z);
      call = this.openOfficerCall('officerAssist', code === 3 ? 1 : 2, location, t);
      this.withdrawOffer(t);
      this.makeAssignable(t);
      cad.assign(call.id, pc, t, 'self');
      cad.setUnitStatus(pc, 'onScene', t, 'auto');
    }
    const n = code === 3 ? this.cfg.backup.code3Units : this.cfg.backup.code2Units;
    const units = this.pickUnits(n, p.x, p.z, call.id, 'preemptLow', code === 3 ? 'emergency' : 'respond');
    for (const u of units) this.dispatchUnit(u, call.id, p.x, p.z, code === 3 ? 'emergency' : 'respond', 'backup', 'backup', t);
    if (units.length > 0) this.setBackupTarget(t);
    const callsigns = units.map((u) => u.callsign);
    bus.emit('dispatch:backup', { requester: pc, code, units: callsigns, x: p.x, z: p.z, location: call.location.near });
    if (units.length === 0) this.ack(pc, 'backup', false, 'No units available');
  }

  private reqLocation(): void {
    const pc = this.playerCallsign;
    const text = locationText(this.generator.locate(this.player.x, this.player.z));
    this.deps.bus.emit('dispatch:location', { callsign: pc, text, asked: false });
  }

  private reqCode4(t: CadTime): void {
    const { cad, bus } = this.deps;
    const pc = this.playerCallsign;
    let rich = false;
    if (this.emergencyActive) {
      this.emergencyActive = false;
      cad.setEmergency(pc, false, t);
      const location = this.generator.locate(this.player.x, this.player.z).near;
      bus.emit('dispatch:emergency', { callsign: pc, active: false, units: [], location });
      rich = true;
    }
    for (const u of this.units) {
      if (u.role !== 'call' && u.callId !== null && u.releaseAt < 0) u.releaseAt = t.sim + this.cfg.backup.releaseS;
    }
    if (!rich) this.ack(pc, 'code4', true, 'Code 4');
  }

  private reqEmergency(t: CadTime): void {
    const { cad, bus } = this.deps;
    const pc = this.playerCallsign;
    if (this.emergencyActive) {
      this.ack(pc, 'emergency', false, 'Emergency already active');
      return;
    }
    const p = this.player;
    this.emergencyActive = true;
    cad.setEmergency(pc, true, t);
    const location = this.generator.locate(p.x, p.z);
    const call = this.openOfficerCall('officerEmergency', 1, location, t);
    this.emergencyCallId = call.id;
    const units = this.pickUnits(this.cfg.emergency.units, p.x, p.z, call.id, 'preemptAll', 'emergency');
    for (const u of units) this.dispatchUnit(u, call.id, p.x, p.z, 'emergency', 'dispatch', 'emergency', t);
    this.setBackupTarget(t);
    bus.emit('dispatch:emergency', { callsign: pc, active: true, units: units.map((u) => u.callsign), location: location.near });
  }

  private reqTrafficStop(): void {
    const pc = this.playerCallsign;
    const stop = this.deps.cad.trafficStop;
    if (!stop || stop.outcome !== 'active') {
      this.ack(pc, 'trafficStop', false, 'No traffic stop');
      return;
    }
    const call = this.deps.cad.call(stop.callId);
    this.ack(pc, 'trafficStop', true, `Traffic stop, plate ${stop.plate}, ${call ? call.location.near : 'location unknown'}`);
  }

  private reqStopContact(action: StopAction, t: CadTime, claimedId?: number): void {
    const { cad, records, seed, traffic, bus } = this.deps;
    const pc = this.playerCallsign;
    const stop = cad.trafficStop;
    if (!stop || stop.outcome !== 'active') {
      this.ack(pc, 'stopContact', false, 'No traffic stop');
      return;
    }
    const call = cad.call(stop.callId);
    // The occupants may have been seated after the stop began: re-resolve who is really behind the wheel.
    const trueDriver = this.trueDriverOf(stop.vehicleId);
    cad.setTrueDriver(trueDriver);
    const subject = stop.driverId >= 0 ? stop.driverId : trueDriver;
    switch (action) {
      case 'license': {
        // The identity the driver claimed (when the officer ran that name) else the true driver.
        const driverId = claimedId !== undefined && Number.isInteger(claimedId) && claimedId >= 0 && claimedId < PERSON_POPULATION ? claimedId : trueDriver;
        cad.updateTrafficStop({ driverId }, t);
        const readback = records.personSummary(driverId);
        if (call && !call.persons.includes(driverId)) call.persons.push(driverId);
        cad.addNarrative(stop.callId, pc, `Driver identified: ${displayName(records.person(driverId))}, DL ${readback.dl}.`, t);
        bus.emit('dispatch:personResult', { callsign: pc, via: 'auto', readback });
        return;
      }
      case 'vin': {
        const vin = vinOf(seed, stop.vehicleId);
        const res = records.runVin(vin, t.game);
        const reg = res.registration;
        const hits = res.hits.length > 0 ? ` - ${res.hits.map((h) => h.text).join('; ')}` : '';
        const text = reg ? `VIN ${res.vin}: ${vehicleDescription(reg).toUpperCase()}, registered plate ${reg.plate}${hits}` : `VIN ${res.vin}: NO RECORD`;
        cad.updateTrafficStop({ vinChecked: true, vinResult: text }, t);
        cad.addNarrative(stop.callId, 'CAD', text, t);
        this.ack(pc, 'stopContact', true, text);
        return;
      }
      case 'warn': {
        records.addContact(subject, {
          gameSeconds: t.game,
          kind: 'warning',
          ref: call ? call.number : '',
          summary: 'Verbal warning - traffic stop',
        });
        this.stopWarned = true;
        cad.addNarrative(stop.callId, pc, 'Verbal warning issued.', t);
        this.ack(pc, 'stopContact', true, 'Warning issued');
        return;
      }
      case 'release': {
        traffic.releaseStop();
        this.endStop('released', this.stopDisposition(), t);
        this.ack(pc, 'stopContact', true, 'Vehicle released');
        return;
      }
      case 'arrest': {
        traffic.abandonStop();
        cad.updateTrafficStop({ outcome: 'arrest' }, t);
        if (call && !call.persons.includes(subject)) call.persons.push(subject);
        cad.addNarrative(stop.callId, pc, `Driver taken into custody: ${displayName(records.person(subject))}.`, t);
        bus.emit('dispatch:arrest', { personId: subject, callId: stop.callId });
        this.ack(pc, 'stopContact', true, 'Subject in custody');
        return;
      }
    }
  }

  /** Any player request answers a pending status check (and calls off a welfare escalation). */
  private answered(t: CadTime): void {
    this.lastAnswerSim = t.sim;
    this.checkAttempt = 0;
    this.awaitingSince = -1;
    this.locationAsked = false;
    if (this.welfareCallId >= 0) {
      for (const u of this.units) {
        if (u.role === 'welfare' && u.callId === this.welfareCallId && u.releaseAt < 0) u.releaseAt = t.sim + this.cfg.backup.releaseS;
      }
      this.welfareCallId = -1;
    }
  }

  // --- Generator --------------------------------------------------------------------------------

  private generate(dt: number, t: CadTime): void {
    if (t.sim < this.nextCallSim) return;
    const g = this.cfg.generator;
    const p = this.player;
    if (t.sim >= this.nextMultiplierSim) {
      this.multiplierValue = this.generator.multiplier(t.game, this.generator.districtOf(p.x, p.z));
      this.nextMultiplierSim = t.sim + MULTIPLIER_INTERVAL;
    }
    if (this.callsRng.next() >= (dt * this.multiplierValue) / g.meanIntervalS) return;
    let open = 0;
    const calls = this.deps.cad.calls();
    for (let i = 0; i < calls.length; i++) if (calls[i]?.status !== 'closed') open++;
    if (open >= g.maxOpenCalls) return;
    const c = this.generator.generate(this.callsRng, p.x, p.z, this.playerCallsign, t.game);
    if (!c) return;
    this.openCall(c.typeId, c.priority, c.location, c.caller, c.narrative, t, false, c.persons, c.vehicles);
    this.generated++;
  }

  /** Creates a CAD call and its AI-unit plan. */
  private openCall(
    typeId: string,
    priority: Priority,
    location: CadLocation,
    caller: CallerInfo,
    narrative: string,
    t: CadTime,
    selfInitiated: boolean,
    persons: readonly number[],
    vehicles: readonly number[],
  ): CadCall {
    const call = this.deps.cad.createCall({ typeId, priority, location, caller, narrative, selfInitiated, persons, vehicles }, t);
    const type = findCallType(typeId);
    const range = type ? type.units : ([1, 1] as const);
    const drawn = this.callsRng.nextInt(range[0], Math.max(range[0], range[1]));
    this.plans.set(call.id, priority === 1 ? Math.max(this.cfg.assign.p1Units, drawn) : drawn);
    this.assignDirty = true;
    return call;
  }

  private openOfficerCall(typeId: string, priority: Priority, location: CadLocation, t: CadTime): CadCall {
    const type = findCallType(typeId);
    const caller = this.officerCaller();
    const narrative = type ? this.generator.narrative(type, this.callsRng, location, caller, []) : `${typeId} at ${location.near}.`;
    return this.openCall(typeId, priority, location, caller, narrative, t, true, [], []);
  }

  private officerCaller(): CallerInfo {
    return { kind: 'officer', name: `Unit ${this.playerCallsign}`, phone: '', personId: -1 };
  }

  // --- Offers and assignment --------------------------------------------------------------------

  private offerTimeouts(t: CadTime): void {
    if (this.offerCallId < 0) return;
    const { cad, bus } = this.deps;
    const pc = this.playerCallsign;
    const call = cad.call(this.offerCallId);
    if (!call || call.status === 'closed' || call.offeredTo !== pc) {
      this.offerCallId = -1;
      this.assignDirty = true;
      return;
    }
    const pu = cad.unit(pc);
    if (pu && (pu.status !== 'available' || pu.callId !== null)) {
      // The player took something else: the offer goes to the AI units.
      this.withdrawOffer(t);
      return;
    }
    if (t.sim < call.offerExpires) return;
    cad.offer(call.id, null, 0, t);
    this.declined.add(call.id);
    this.offerCallId = -1;
    this.assignDirty = true;
    bus.emit('dispatch:offer', { callId: call.id, callsign: pc, expired: true });
  }

  /** Pending calls in priority order (P1 first, then oldest): offer to the player or assign AI units. */
  private assign(t: CadTime): void {
    this.nextAssignSim = t.sim + ASSIGN_INTERVAL;
    const { cad } = this.deps;
    const calls = cad.calls();
    if (this.assignDirty) this.prunePlans();
    this.assignDirty = false;
    for (let prio = 1; prio <= 4; prio++) {
      for (let i = 0; i < calls.length; i++) {
        const c = calls[i];
        if (!c || c.status === 'closed' || c.priority !== prio || c.offeredTo !== null) continue;
        this.assignCall(c, t);
      }
    }
  }

  private assignCall(c: CadCall, t: CadTime): void {
    const pc = this.playerCallsign;
    if (c.units.includes(pc)) return;
    // A self-initiated call left without units is never handed to the AI units.
    if (c.selfInitiated && c.units.length === 0) return;
    let ai = 0;
    for (const cs of c.units) if (cs !== pc) ai++;
    if (c.status === 'pending' && ai === 0 && this.canOffer(c)) {
      this.offer(c, t);
      return;
    }
    const wanted = this.plans.get(c.id) ?? (c.priority === 1 ? this.cfg.assign.p1Units : 1);
    const need = wanted - ai;
    if (need <= 0) return;
    const urgency: FleetUrgency = c.priority <= 2 ? 'emergency' : 'respond';
    const units = this.pickUnits(need, c.location.x, c.location.z, c.id, 'available', urgency);
    for (const u of units) this.dispatchUnit(u, c.id, c.location.x, c.location.z, urgency, 'dispatch', 'call', t);
  }

  private canOffer(c: CadCall): boolean {
    if (this.offerCallId >= 0 || c.selfInitiated || OFFICER_TYPES.has(c.typeId) || this.declined.has(c.id)) return false;
    const pu = this.deps.cad.unit(this.playerCallsign);
    const p = this.player;
    if (!pu || pu.status !== 'available' || !p.inPoliceVehicle) return false;
    return Math.hypot(c.location.x - p.x, c.location.z - p.z) <= this.cfg.offer.radiusM;
  }

  private offer(c: CadCall, t: CadTime): void {
    const pc = this.playerCallsign;
    this.deps.cad.offer(c.id, pc, t.sim + this.cfg.offer.timeoutS, t);
    this.offerCallId = c.id;
    this.deps.bus.emit('dispatch:offer', { callId: c.id, callsign: pc, expired: false });
  }

  /** Drops plans and declines of calls that are closed or gone (rare: only on the assignment pass). */
  private prunePlans(): void {
    const { cad } = this.deps;
    for (const id of this.plans.keys()) {
      const c = cad.call(id);
      if (!c || c.status === 'closed') this.plans.delete(id);
    }
    for (const id of this.declined) {
      const c = cad.call(id);
      if (!c || c.status === 'closed') this.declined.delete(id);
    }
  }

  /**
   * Up to `n` nearest AI units (a reused array: consume before the next call) (straight line from their AVL position, within `assign.maxDistanceM`) not
   * already on `callId`: 'available' = patrolling units only; 'preemptLow' also takes units on P3/P4
   * calls; 'preemptAll' takes any unit that is not out of service.
   */
  private pickUnits(n: number, x: number, z: number, callId: number, mode: 'available' | 'preemptLow' | 'preemptAll', urgency: FleetUrgency = 'respond'): AiUnit[] {
    const { cad } = this.deps;
    const out = this.pickedOut;
    out.length = 0;
    this.picked.fill(0);
    const maxD = this.cfg.assign.maxDistanceM;
    if (this.ranker) return this.pickRanked(n, x, z, callId, mode, urgency);
    for (let k = 0; k < n; k++) {
      let best: AiUnit | null = null;
      let bestD = maxD;
      for (let i = 0; i < this.units.length; i++) {
        const u = this.units[i];
        if (!u || this.picked[i] === 1 || !u.present || u.mode === 'break' || u.callId === callId) continue;
        const cu = cad.unit(u.callsign);
        if (!cu || cu.status === 'outOfService') continue;
        if (!this.eligible(u, cu, mode)) continue;
        const d = Math.hypot(cu.x - x, cu.z - z);
        if (d <= bestD && (best === null || d < bestD)) {
          best = u;
          bestD = d;
        }
      }
      if (!best) break;
      this.picked[best.fleetIndex] = 1;
      out.push(best);
    }
    return out;
  }

  /**
   * `pickUnits` with the ETA ranker: per pick the nearest `ETA_RANK_K` eligible units (straight line, ties in roster
   * order) are ranked by `ranker`; the lowest finite value wins, ties go to the nearer unit.
   */
  private pickRanked(n: number, x: number, z: number, callId: number, mode: 'available' | 'preemptLow' | 'preemptAll', urgency: FleetUrgency): AiUnit[] {
    const { cad } = this.deps;
    const ranker = this.ranker;
    const out = this.pickedOut;
    const idx = this.rankIdx;
    const dist = this.rankDist;
    const maxD = this.cfg.assign.maxDistanceM;
    for (let k = 0; k < n; k++) {
      let count = 0;
      for (let i = 0; i < this.units.length; i++) {
        const u = this.units[i];
        if (!u || this.picked[i] === 1 || !u.present || u.mode === 'break' || u.callId === callId) continue;
        const cu = cad.unit(u.callsign);
        if (!cu || cu.status === 'outOfService') continue;
        if (!this.eligible(u, cu, mode)) continue;
        const d = Math.hypot(cu.x - x, cu.z - z);
        if (d > maxD) continue;
        // Insert into the sorted nearest-K list (after equal distances: roster order breaks ties).
        let pos = count;
        while (pos > 0 && (dist[pos - 1] as number) > d) pos--;
        if (pos >= ETA_RANK_K) continue;
        const last = Math.min(count, ETA_RANK_K - 1);
        for (let j = last; j > pos; j--) {
          idx[j] = idx[j - 1] as number;
          dist[j] = dist[j - 1] as number;
        }
        idx[pos] = i;
        dist[pos] = d;
        if (count < ETA_RANK_K) count++;
      }
      let best: AiUnit | null = null;
      let bestV = Infinity;
      for (let j = 0; j < count; j++) {
        const u = this.units[idx[j] as number];
        if (!u) continue;
        const v = ranker ? ranker(u.callsign, x, z, urgency) : 0;
        if (Number.isNaN(v) || v === Infinity) continue;
        if (best === null || v < bestV) {
          best = u;
          bestV = v;
        }
      }
      if (!best) break;
      this.picked[best.fleetIndex] = 1;
      out.push(best);
    }
    return out;
  }

  private eligible(u: AiUnit, cu: CadUnit, mode: 'available' | 'preemptLow' | 'preemptAll'): boolean {
    const free = cu.status === 'available' && (u.mode === 'patrol' || u.mode === 'beat');
    if (free || mode === 'preemptAll') return true;
    if (mode === 'available' || u.role !== 'call' || u.callId === null) return false;
    const call = this.deps.cad.call(u.callId);
    return call !== null && call.priority >= 3;
  }

  private dispatchUnit(u: AiUnit, callId: number, x: number, z: number, urgency: FleetUrgency, by: 'dispatch' | 'backup', role: UnitRole, t: CadTime): void {
    const { cad, traffic } = this.deps;
    const prevCall = u.callId;
    cad.assign(callId, u.callsign, t, by);
    if (prevCall !== null && prevCall !== callId) this.assignDirty = true;
    u.mode = 'enRoute';
    u.role = role;
    u.callId = callId;
    u.hasDest = true;
    u.destX = x;
    u.destZ = z;
    u.destEmergency = urgency === 'emergency';
    u.enRouteSince = t.sim;
    u.progressLeftM = -1;
    u.stuckSince = -1;
    u.onSceneUntil = -1;
    u.releaseAt = -1;
    u.breakUntil = -1;
    u.replanned = false;
    u.arrived = false;
    u.directed = false;
    traffic.setFleetDestination(u.fleetIndex, x, z, urgency);
  }

  // --- AI unit FSMs -----------------------------------------------------------------------------

  private stepUnits(t: CadTime): void {
    const { cad, traffic } = this.deps;
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      if (!u) continue;
      const fs = traffic.fleetState(u.fleetIndex, u.fs);
      u.present = fs !== null;
      if (!fs) {
        if (t.sim >= u.nextRespawn) {
          u.nextRespawn = t.sim + RESPAWN_S;
          const cu = cad.unit(u.callsign);
          if (this.spawnCar(u, cu ? cu.x : u.beatX, cu ? cu.z : u.beatZ) !== 0 && u.hasDest) {
            traffic.setFleetDestination(u.fleetIndex, u.destX, u.destZ, u.destEmergency ? 'emergency' : 'respond');
          }
        }
        continue;
      }
      const cu = cad.unit(u.callsign);
      if (!cu) continue;
      if ((u.mode === 'enRoute' || u.mode === 'onScene') && cu.callId !== u.callId) {
        // The call was closed or the unit taken off it elsewhere.
        this.toPatrol(u, t);
        continue;
      }
      if (u.releaseAt >= 0 && t.sim >= u.releaseAt && (u.mode === 'enRoute' || u.mode === 'onScene')) {
        if (!this.holdFn || t.sim >= u.releaseAt + HOLD_MAX_S || !this.holdFn(u.callsign)) {
          this.release(u, t);
          continue;
        }
      }
      switch (u.mode) {
        case 'enRoute':
          this.stepEnRoute(u, fs, t);
          break;
        case 'onScene':
          if (u.onSceneUntil >= 0 && t.sim >= u.onSceneUntil) this.finishCall(u, t);
          break;
        case 'patrol':
          if (t.sim >= u.nextBeatCheck) this.patrolCheck(u, fs, t);
          break;
        case 'beat':
          if (u.arrived || fs.arrived) {
            traffic.setFleetPatrol(u.fleetIndex);
            u.mode = 'patrol';
            u.hasDest = false;
            u.arrived = false;
            u.nextBeatCheck = t.sim + PATROL_CHECK_S;
          }
          break;
        case 'break':
          if (t.sim >= u.breakUntil) {
            cad.setUnitStatus(u.callsign, 'available', t, 'auto');
            this.toPatrol(u, t);
            this.assignDirty = true;
          }
          break;
      }
    }
  }

  private stepEnRoute(u: AiUnit, fs: FleetState, t: CadTime): void {
    const close = Math.hypot(fs.x - u.destX, fs.z - u.destZ) <= ARRIVE_M;
    // Arrival is forced only after `forceArriveS` without progress along the route (or without a route).
    const left = fs.routeLeftM;
    if (left >= 0) {
      if (u.progressLeftM < 0) u.progressLeftM = left;
      else if (left < u.progressLeftM - PROGRESS_M) {
        u.progressLeftM = left;
        u.enRouteSince = t.sim;
      }
    }
    if (u.arrived || fs.arrived || close || t.sim - u.enRouteSince >= this.cfg.aiUnits.forceArriveS) {
      this.arrive(u, t);
      return;
    }
    if (fs.speed < STUCK_SPEED) {
      if (u.stuckSince < 0) u.stuckSince = t.sim;
      else if (!u.replanned && t.sim - u.stuckSince >= this.cfg.aiUnits.stuckS) {
        u.replanned = true;
        u.stuckSince = t.sim;
        this.deps.traffic.setFleetDestination(u.fleetIndex, u.destX, u.destZ, u.destEmergency ? 'emergency' : 'respond');
      }
    } else {
      u.stuckSince = -1;
    }
  }

  private arrive(u: AiUnit, t: CadTime): void {
    const { cad } = this.deps;
    cad.setUnitStatus(u.callsign, 'onScene', t, 'auto');
    u.mode = 'onScene';
    u.arrived = false;
    u.stuckSince = -1;
    if (u.role === 'call') {
      const call = u.callId !== null ? cad.call(u.callId) : null;
      const range = (call ? findCallType(call.typeId)?.onSceneS : undefined) ?? DEFAULT_ON_SCENE;
      u.onSceneUntil = t.sim + this.unitsRng.nextFloat(range[0], Math.max(range[0], range[1]));
    } else {
      u.onSceneUntil = -1;
    }
  }

  /** On-scene time is up: close the call (no player on it, last AI unit) or just leave it. */
  private finishCall(u: AiUnit, t: CadTime): void {
    const { cad } = this.deps;
    const call = u.callId !== null ? cad.call(u.callId) : null;
    if (call && call.status !== 'closed') {
      const pc = this.playerCallsign;
      let others = 0;
      for (const cs of call.units) if (cs !== u.callsign) others++;
      if (others === 0 && !call.units.includes(pc)) {
        const type = findCallType(call.typeId);
        const options = type && type.dispositions.length > 0 ? type.dispositions : ['handled'];
        cad.closeCall(call.id, this.scenarioDisposition(call.id) ?? this.unitsRng.pick(options), t);
      } else {
        cad.unassign(u.callsign, t);
        // Its share of the work is done: the call is never refilled (the unit leaving would be picked
        // again at once, being nearest), it closes when the last unit on it finishes.
        if (!call.units.includes(pc)) this.plans.set(call.id, others);
      }
    }
    this.toPatrol(u, t);
    this.assignDirty = true;
  }

  /** Releases a backup / emergency / welfare unit: emergency and welfare calls close, backup just leaves. */
  private release(u: AiUnit, t: CadTime): void {
    const { cad } = this.deps;
    const call = u.callId !== null ? cad.call(u.callId) : null;
    if (call && call.status !== 'closed') {
      if ((u.role === 'emergency' || u.role === 'welfare') && !call.units.includes(this.playerCallsign)) {
        cad.closeCall(call.id, 'handled', t);
        if (call.id === this.emergencyCallId) this.emergencyCallId = -1;
      } else {
        cad.unassign(u.callsign, t);
      }
    }
    this.toPatrol(u, t);
    this.assignDirty = true;
  }

  private toPatrol(u: AiUnit, t: CadTime): void {
    u.mode = 'patrol';
    u.role = 'call';
    u.callId = null;
    u.hasDest = false;
    u.onSceneUntil = -1;
    u.stuckSince = -1;
    u.enRouteSince = -1;
    u.progressLeftM = -1;
    u.breakUntil = -1;
    u.releaseAt = -1;
    u.replanned = false;
    u.arrived = false;
    u.directed = false;
    u.nextBeatCheck = t.sim + PATROL_CHECK_S;
    this.deps.traffic.setFleetPatrol(u.fleetIndex);
  }

  /** Every PATROL_CHECK_S while patrolling: maybe a break (one unit at a time), else back toward the beat. */
  private patrolCheck(u: AiUnit, fs: FleetState, t: CadTime): void {
    const { cad, traffic } = this.deps;
    u.nextBeatCheck = t.sim + PATROL_CHECK_S;
    const ai = this.cfg.aiUnits;
    const p = (ai.breakChancePerHour * PATROL_CHECK_S) / 3600;
    if (this.unitsRng.chance(p) && !this.anyOnBreak() && cad.unit(u.callsign)?.status === 'available') {
      if (cad.setUnitStatus(u.callsign, 'outOfService', t, 'auto')) {
        u.mode = 'break';
        u.breakUntil = t.sim + this.unitsRng.nextFloat(ai.breakS[0], ai.breakS[1]);
        u.hasDest = true;
        u.destX = fs.x;
        u.destZ = fs.z;
        u.destEmergency = false;
        traffic.setFleetDestination(u.fleetIndex, fs.x, fs.z, 'respond');
        return;
      }
    }
    if (Math.hypot(fs.x - u.beatX, fs.z - u.beatZ) > ai.beatRadiusM) {
      if (traffic.setFleetDestination(u.fleetIndex, u.beatX, u.beatZ, 'respond')) {
        u.mode = 'beat';
        u.hasDest = true;
        u.destX = u.beatX;
        u.destZ = u.beatZ;
        u.destEmergency = false;
        u.arrived = false;
      }
    }
  }

  private anyOnBreak(): boolean {
    for (const u of this.units) if (u.mode === 'break') return true;
    return false;
  }

  /** Backup and emergency units follow the player every `retargetS` once the player moved > `retargetMoveM`. */
  private retarget(t: CadTime): void {
    if (t.sim < this.nextRetargetSim) return;
    this.nextRetargetSim = t.sim + this.cfg.backup.retargetS;
    const p = this.player;
    if (Math.hypot(p.x - this.backupTargetX, p.z - this.backupTargetZ) <= this.cfg.backup.retargetMoveM) return;
    let moved = false;
    for (const u of this.units) {
      if ((u.role !== 'backup' && u.role !== 'emergency') || u.callId === null || u.releaseAt >= 0 || u.directed) continue;
      const urgency: FleetUrgency = u.destEmergency ? 'emergency' : 'respond';
      if (u.mode === 'enRoute') {
        u.destX = p.x;
        u.destZ = p.z;
        u.progressLeftM = -1;
        this.deps.traffic.setFleetDestination(u.fleetIndex, p.x, p.z, urgency);
        moved = true;
      } else if (u.mode === 'onScene' && Math.hypot(u.fs.x - p.x, u.fs.z - p.z) > BACKUP_FOLLOW_M) {
        this.deps.cad.setUnitStatus(u.callsign, 'enRoute', t, 'auto');
        u.mode = 'enRoute';
        u.enRouteSince = t.sim;
        u.progressLeftM = -1;
        u.stuckSince = -1;
        u.replanned = false;
        u.arrived = false;
        u.destX = p.x;
        u.destZ = p.z;
        this.deps.traffic.setFleetDestination(u.fleetIndex, p.x, p.z, urgency);
        moved = true;
      }
    }
    if (moved) this.setBackupTarget(t);
  }

  private setBackupTarget(t: CadTime): void {
    this.backupTargetX = this.player.x;
    this.backupTargetZ = this.player.z;
    this.nextRetargetSim = t.sim + this.cfg.backup.retargetS;
  }

  // --- Status checks ----------------------------------------------------------------------------

  private statusChecks(t: CadTime): void {
    const { cad, bus } = this.deps;
    const pc = this.playerCallsign;
    const pu = cad.unit(pc);
    if (!pu) return;
    const sc = this.cfg.statusCheck;
    if (this.emergencyActive) {
      // Emergency traffic: units are already on the way; no status checks (and their clock restarts after Code 4).
      this.checkAttempt = 0;
      this.awaitingSince = -1;
      this.locationAsked = false;
      this.lastAnswerSim = t.sim;
      this.nextCheckSim = -1;
      return;
    }
    const busy = pu.status === 'onScene' || pu.status === 'busy';
    if (!busy) {
      if (this.checkAttempt > 0 && this.checkAttempt <= sc.attempts) {
        this.checkAttempt = 0;
        this.awaitingSince = -1;
        this.locationAsked = false;
      }
      this.nextCheckSim = -1;
      return;
    }
    if (this.checkAttempt === 0) {
      this.nextCheckSim = Math.max(pu.statusSince.sim, this.lastAnswerSim) + sc.afterS;
      if (t.sim < this.nextCheckSim) return;
      this.checkAttempt = 1;
      this.awaitingSince = t.sim;
      bus.emit('dispatch:statusCheck', { callsign: pc, attempt: 1, escalated: false, location: this.lastKnown(pu) });
      return;
    }
    if (this.checkAttempt > sc.attempts || t.sim - this.awaitingSince < sc.responseS) return;
    if (this.checkAttempt < sc.attempts) {
      this.checkAttempt++;
      this.awaitingSince = t.sim;
      this.locationAsked = true;
      bus.emit('dispatch:statusCheck', { callsign: pc, attempt: this.checkAttempt, escalated: false, location: this.lastKnown(pu) });
      bus.emit('dispatch:location', { callsign: pc, text: '', asked: true });
      return;
    }
    this.escalate(pu, t);
  }

  private lastKnown(pu: CadUnit): string {
    return this.generator.locate(pu.x, pu.z).near;
  }

  /** No answer to the last status check: officerWelfare P1 call at the player's last AVL, units code 3. */
  private escalate(pu: CadUnit, t: CadTime): void {
    const sc = this.cfg.statusCheck;
    this.checkAttempt = sc.attempts + 1;
    const location = this.generator.locate(pu.x, pu.z);
    const call = this.openOfficerCall('officerWelfare', 1, location, t);
    this.welfareCallId = call.id;
    const units = this.pickUnits(sc.escalateUnits, pu.x, pu.z, call.id, 'preemptLow', 'emergency');
    for (const u of units) this.dispatchUnit(u, call.id, location.x, location.z, 'emergency', 'dispatch', 'welfare', t);
    this.deps.bus.emit('dispatch:statusCheck', { callsign: pu.callsign, attempt: this.checkAttempt, escalated: true, location: location.near });
  }

  // --- AVL and lights ---------------------------------------------------------------------------

  private avl(t: CadTime): void {
    if (t.sim < this.nextAvlSim) return;
    this.nextAvlSim = t.sim + this.cfg.avlIntervalS;
    const { cad } = this.deps;
    for (const u of this.units) {
      if (!u.present) continue;
      u.lastAvlX = u.fs.x;
      u.lastAvlZ = u.fs.z;
      cad.setUnitPosition(u.callsign, u.fs.x, u.fs.z);
    }
    cad.setUnitPosition(this.playerCallsign, this.player.x, this.player.z);
  }

  /** PoliceLights of fleet cars: re-attached when the entity changed; pattern 0; wail while code 3 and moving. */
  private syncLights(): void {
    for (const u of this.units) {
      if (!u.present) continue;
      const eid = u.fs.eid;
      if (eid !== u.eid) {
        attachPoliceLights(this.deps.world, eid, u.phase);
        u.eid = eid;
      }
      PoliceLights.pattern[eid] = 0;
      PoliceLights.siren[eid] = u.fs.mode === 'emergency' && u.fs.speed > SIREN_SPEED ? 1 : 0;
    }
  }

  // --- Helpers ----------------------------------------------------------------------------------

  /** Spawns fleet car `u` near (x, z), trying deterministic offsets; returns its entity id (0 = none). */
  private spawnCar(u: AiUnit, x: number, z: number): number {
    for (const [ox, oz] of SPAWN_OFFSETS) {
      const eid = this.deps.traffic.spawnFleetCar(u.fleetIndex, x + ox, z + oz, { modelIndex: u.modelIndex, color: u.color });
      if (eid !== 0) return eid;
    }
    return 0;
  }

  private resetUnit(u: AiUnit, now: number): void {
    u.mode = 'patrol';
    u.role = 'call';
    u.callId = null;
    u.hasDest = false;
    u.onSceneUntil = -1;
    u.stuckSince = -1;
    u.enRouteSince = -1;
    u.breakUntil = -1;
    u.releaseAt = -1;
    u.replanned = false;
    u.arrived = false;
    u.directed = false;
    u.nextBeatCheck = now;
    u.nextRespawn = 0;
  }
}

/** Beat centre of a district: the node nearest the centroid of the nodes of edges in that district (city spawn when none). */
export function beatCentre(city: City, beat: string): { x: number; z: number } {
  const district = (DISTRICT as Readonly<Record<string, number>>)[beat];
  const g = city.graph;
  const seen = new Set<number>();
  let sx = 0, sz = 0;
  for (const e of g.edges) {
    if (e.district !== district) continue;
    for (const id of [e.from, e.to]) {
      if (seen.has(id)) continue;
      const n = g.nodes[id];
      if (!n) continue;
      seen.add(id);
      sx += n.x;
      sz += n.z;
    }
  }
  if (seen.size === 0) return { x: city.spawn.x, z: city.spawn.z };
  const cx = sx / seen.size, cz = sz / seen.size;
  let best = { x: city.spawn.x, z: city.spawn.z };
  let bestD = Infinity;
  for (const id of seen) {
    const n = g.nodes[id];
    if (!n) continue;
    const d = Math.hypot(n.x - cx, n.z - cz);
    if (d < bestD || (d === bestD && n.x < best.x)) {
      bestD = d;
      best = { x: n.x, z: n.z };
    }
  }
  return best;
}
