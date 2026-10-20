/**
 * Pursuit system (Phase 6 design §10.3), step order -678. Wraps the Phase 3 fleeing car with police tactics: PIT
 * (contact classification + policy), spike strips, box-in, roadblock, the air unit, supervisor monitoring and
 * termination orders, jurisdiction handoff to the state patrol and the perimeter after a foot bail.
 *
 * Bus handlers only enqueue; everything is applied at the start of the next `step`. The steady-state step does not
 * allocate (path predictions, ETA ranking and radio lines happen on requests and at 1 Hz).
 */
import type { CadTime } from '../cad/types';
import type { ActorInfo } from '../npc/types';
import { estimateResponse } from '../units/eta';
import { unitType } from '../units/data';
import type { RadioLinePayload } from '../units/types';
import { VEHICLE_MODELS } from '../vehicles/model';
import { MPH } from '../world/constants';
import type { RoadHit } from '../world/roadGraph';
import { PURSUIT_CONFIG } from './data';
import './events';
import { inCity, timeToBoundary } from './jurisdiction';
import { perimeterPosts } from './perimeter';
import { classifyContact, pitPolicy } from './pit';
import { predictRoute } from './predict';
import { pursuitDecision, pursuitRisk, VIOLENT_OFFENSES, type DecisionInput } from './risk';
import {
  emptyPursuitSave,
  type PursuitBailSave,
  type PursuitIntakeSave,
  type PursuitRunSave,
  type PursuitSave,
} from './save';
import { crossesStrip, stripAcrossEdge, stripAcrossLanes } from './strips';
import { canBoxIn, unitsAhead } from './tactics';
import type {
  CarPose,
  PursuitConfig,
  PursuitContext,
  PursuitDeps,
  PursuitHud,
  PursuitMenuItem,
  PursuitRequest,
  PursuitTactic,
  Strip,
  TacticVerdict,
} from './types';
import type { FleeInfo, FleetState } from '../traffic/trafficSystem';

export type { PursuitContext, PursuitDeps, PursuitHud, PursuitMenuItem, PursuitRequest } from './types';

const MAX_INTAKE = 64;
const MAX_REQUESTS = 16;
/** The player is "out of sight" of the suspect beyond this distance (m). */
const SIGHT_M = 250;
/** A foot bail must start within this many sim seconds of the vehicle pursuit's end. */
const BAIL_WINDOW_S = 30;
/** A spike strip placed ahead needs the suspect at least this far from the node (m). */
const STRIP_MIN_GAP_M = 80;
/** An AI unit counts as arrived at its strip node within this distance (m). */
const UNIT_AT_NODE_M = 30;
/** Strips are removed this long after the pursuit ended (sim s). */
const STRIPS_LINGER_S = 10;
/** Tactics that never completed give up after this long (sim s). */
const TACTIC_TIMEOUT_S = 120;
/** A runner farther than this from the player is "out of sight" for the perimeter (m). */
const BAIL_SIGHT_M = 60;
/** Containment starts this far inside the perimeter radius (m). */
const CONTAIN_INSET_M = 20;
/** A bail never lasts longer than this (sim s). */
const BAIL_MAX_S = 900;
/** The flee must be missing this long before the pursuit is closed locally (sim s). */
const GONE_GRACE_S = 3;
const DEFAULT_HALF_LENGTH = 2.3;
const DEFAULT_HALF_WIDTH = 0.9;

type Run = Required<PursuitRunSave> & { goneSince: number };
type Bail = Required<PursuitBailSave>;

interface Xz {
  x: number;
  z: number;
  player: boolean;
}

function newFleeInfo(): FleeInfo {
  return { x: 0, z: 0, yaw: 0, speed: 0, edge: -1, deflated: 0, spinning: false, capMps: Infinity, tracked: false };
}

function newFleetState(): FleetState {
  return { eid: 0, x: 0, z: 0, yaw: 0, speed: 0, edge: -1, mode: 'patrol', arrived: false, parked: false, routeLeftM: -1 };
}

function newActorInfo(): ActorInfo {
  return {
    id: 0, personId: -1, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false,
    armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
  };
}

function newHit(): RoadHit {
  return { edge: -1, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 };
}

/** True when the `hz` cadence crossed a boundary during this step. */
function tick(t: number, dt: number, hz: number): boolean {
  return Math.floor(t * hz) !== Math.floor((t - dt) * hz);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

const HALF_DIMS = new Map<string, { l: number; w: number }>();

function halfDims(modelId: string): { l: number; w: number } {
  let d = HALF_DIMS.get(modelId);
  if (!d) {
    const m = VEHICLE_MODELS.find((v) => v.id === modelId);
    d = m ? { l: m.body.length / 2, w: m.body.width / 2 } : { l: DEFAULT_HALF_LENGTH, w: DEFAULT_HALF_WIDTH };
    HALF_DIMS.set(modelId, d);
  }
  return d;
}

export class PursuitSystem {
  /** Set by the integrator: consumes one carried spike strip (false when none is left). */
  takeStripFromKit: (() => boolean) | null = null;
  /** Set by the integrator: bursts the player's own front tyres (`drivenVehicle.burstTire(0)` + `(1)`). */
  burstPlayerTires: (() => void) | null = null;

  private readonly deps: PursuitDeps;
  private readonly cfg: PursuitConfig;
  private rev = 1;
  private run: Run | null = null;
  private bail: Bail | null = null;
  private stripList: Strip[] = [];
  private nextStripId = 1;
  private requests: PursuitRequest[] = [];
  private intake: PursuitIntakeSave[] = [];
  private lastEnd: { personId: number; sim: number } | null = null;
  private readonly unsubs: (() => void)[] = [];

  // Player view of this step.
  private px = 0;
  private pz = 0;
  private hasCar = false;
  private onFoot = true;
  private carrying = false;
  private carId = 0;
  private playerCs = 'Unit';
  private readonly car: CarPose = { x: 0, z: 0, yaw: 0, speed: 0, halfLength: DEFAULT_HALF_LENGTH, halfWidth: DEFAULT_HALF_WIDTH };

  // Runtime caches (rebuilt after a restore).
  private tacticUnits: string[] = [];
  private supName = '';
  private airOnTarget = false;
  private airReported = false;
  private lastVerdict: string | null = null;
  private dirty = true;

  // Scratch.
  private readonly fi = newFleeInfo();
  private readonly fleet = newFleetState();
  private readonly actor = newActorInfo();
  private readonly hit = newHit();
  private readonly airOut = { x: 0, y: 0, z: 0, onTarget: false, spot: false };
  private readonly poseOut = { x: 0, z: 0, yaw: 0, speed: 0 };
  private readonly callsigns: string[] = [];
  private readonly pool: Xz[] = [];
  private readonly view: Xz[] = [];
  private readonly tmpStrip: Strip = { id: 0, x0: 0, z0: 0, x1: 0, z1: 0, placedSim: 0, owner: '', active: true };
  private readonly suspectBox = { x: 0, z: 0, yaw: 0, speedMph: 0 };
  private readonly decision: DecisionInput = {
    speedMph: 0, limitMph: 0, district: '', wet: false, night: false, trafficDensity: 0, durationS: 0, offense: null,
    violentOffenses: VIOLENT_OFFENSES, lostSightS: 0, airOnTarget: false, allowedOffenses: [], maxDurationS: 0,
    supervisorMonitoring: false, monitoringS: 0,
  };
  private ux = 0;
  private uz = 0;

  // Outputs.
  private readonly hudObj: PursuitHud = { line: '', verdict: null };
  private hudOn = false;
  private readonly menuItems: PursuitMenuItem[] = [
    { id: 'requestPit', label: 'Request PIT authorization', enabled: false, hint: '' },
    { id: 'spikesAhead', label: 'Spikes ahead (unit)', enabled: false, hint: '' },
    { id: 'deployStrip', label: 'Deploy spike strip', enabled: false, hint: '' },
    { id: 'boxIn', label: 'Box in the suspect', enabled: false, hint: '' },
    { id: 'roadblock', label: 'Roadblock ahead', enabled: false, hint: '' },
    { id: 'air', label: 'Request air unit', enabled: false, hint: '' },
    { id: 'perimeter', label: 'Set perimeter', enabled: false, hint: '' },
  ];

  constructor(deps: PursuitDeps) {
    this.deps = deps;
    this.cfg = deps.config ?? PURSUIT_CONFIG;
    this.unsubs.push(
      deps.bus.on('scene:pursuit', (e) => {
        const personId = e.personId ?? -1;
        if (e.kind === 'vehicle') {
          if (e.active) this.enqueue({ kind: 'vehicleStart', callId: e.callId, personId });
          else this.enqueue({ kind: 'vehicleEnd', callId: e.callId, personId, endReason: e.endReason ?? '' });
        } else {
          this.enqueue({ kind: e.active ? 'footStart' : 'footEnd', callId: e.callId, personId });
        }
      }),
      deps.bus.on('traffic:collision', (e) => {
        if (e.fleeing === true) this.enqueue({ kind: 'contact', vehicleId: e.vehicleId, other: e.other });
      }),
    );
  }

  /** Increments whenever the HUD line, the verdict or the menu changes. */
  get revision(): number {
    return this.rev;
  }

  /** A vehicle pursuit of the officer is running (not a state-patrol handoff). */
  active(): boolean {
    return this.run !== null && this.run.handoff === null;
  }

  /** HUD feed (one reused object), null when nothing is going on. */
  hud(): PursuitHud | null {
    return this.hudOn ? this.hudObj : null;
  }

  /** The tactics panel entries (one reused array; `enabled` and `hint` are refreshed at 1 Hz and on requests). */
  menu(): readonly PursuitMenuItem[] {
    return this.menuItems;
  }

  /** Spike strips lying on the road (used strips stay until they expire). */
  strips(): readonly Strip[] {
    return this.stripList;
  }

  /** Queues a request for the next `step`. */
  request(r: PursuitRequest): void {
    if (this.requests.length < MAX_REQUESTS) this.requests.push(r);
  }

  private enqueue(e: PursuitIntakeSave): void {
    if (this.intake.length < MAX_INTAKE) this.intake.push(e);
  }

  // --- Step -------------------------------------------------------------------------------------------------------

  /** Fixed step (order -678). */
  step(dt: number, t: CadTime, ctx: PursuitContext): void {
    this.cachePlayer(ctx);
    if (this.intake.length > 0) this.drainIntake(t);
    if (this.requests.length > 0) this.drainRequests(t);
    const run = this.run;
    if (run === null && this.stripList.length === 0 && this.bail === null && !this.hudOn && !this.dirty) return;
    if (this.stripList.length > 0) this.stepPlayerStrips(dt);
    if (run !== null) {
      if (run.handoff !== null) this.stepHandoffMode(t, run);
      else this.stepRun(dt, t, run);
    }
    if (this.bail !== null) this.stepBail(dt, t, this.bail);
    if (this.stripList.length > 0) this.expireStrips(t);
    if (this.dirty || tick(t.sim, dt, 1)) this.refresh(t);
  }

  private cachePlayer(ctx: PursuitContext): void {
    this.px = ctx.x;
    this.pz = ctx.z;
    this.onFoot = ctx.onFoot;
    this.carrying = ctx.carryingStrip;
    this.carId = ctx.carId;
    this.playerCs = ctx.playerCallsign;
    const c = ctx.car;
    this.hasCar = c !== null;
    if (c !== null) {
      this.car.x = c.x;
      this.car.z = c.z;
      this.car.yaw = c.yaw;
      this.car.speed = c.speed;
      this.car.halfLength = c.halfLength;
      this.car.halfWidth = c.halfWidth;
    }
  }

  // --- Intake ---------------------------------------------------------------------------------------------------------

  private drainIntake(t: CadTime): void {
    // Handlers may enqueue while we work only through the bus; take the batch first.
    const batch = this.intake;
    this.intake = [];
    for (const e of batch) {
      switch (e.kind) {
        case 'vehicleStart':
          this.startRun(t, e.callId, e.personId);
          break;
        case 'vehicleEnd': {
          const run = this.run;
          if (run !== null && run.callId === e.callId && run.handoff === null) this.endRun(t, e.endReason);
          break;
        }
        case 'footStart':
          this.startBail(t, e.callId, e.personId);
          break;
        case 'footEnd':
          if (this.bail !== null && this.bail.personId === e.personId) this.endBail();
          break;
        case 'contact': {
          const run = this.run;
          if (run !== null && run.handoff === null && run.vehicleId === e.vehicleId && this.carId !== 0 && e.other === this.carId) {
            this.handleContact(run);
          }
          break;
        }
      }
    }
    this.dirty = true;
  }

  private startRun(t: CadTime, callId: number, personId: number): void {
    if (this.run !== null) return;
    const vehicleId = this.deps.cad.call(callId)?.vehicles[0];
    if (vehicleId === undefined) return;
    let px = 0, pz = 0;
    if (this.deps.traffic.fleeInfo(vehicleId, this.fi)) {
      px = this.fi.x;
      pz = this.fi.z;
    }
    this.run = {
      callId, vehicleId, personId, startSim: t.sim, pitAuthorized: false, monitorSince: -1, lastOrderSim: -1, ordered: false,
      lostSince: -1, prevX: px, prevZ: pz, tactic: null, handoff: null, stateRequested: false, airRequested: false,
      ignoredFlashed: false, directed: [], stateUnit: '', goneSince: -1,
    };
    this.tacticUnits.length = 0;
    this.supName = '';
    this.airOnTarget = false;
    this.airReported = false;
    this.lastVerdict = null;
  }

  /** The vehicle pursuit ended: release units, caps and tracking; strips linger a few seconds. */
  private endRun(t: CadTime, reason: string): void {
    const run = this.run;
    if (run === null) return;
    this.releaseRun(run);
    if (this.bail === null) this.deps.resources.setAirTarget('none', 0, run.prevX, run.prevZ);
    for (const s of this.stripList) s.placedSim = Math.min(s.placedSim, t.sim + STRIPS_LINGER_S - this.cfg.spikes.expireS);
    if (reason === 'crashed' || reason === 'stopped' || reason === 'gaveUp') this.lastEnd = { personId: run.personId, sim: t.sim };
    this.run = null;
    this.tacticUnits.length = 0;
    this.supName = '';
    this.airOnTarget = false;
    this.lastVerdict = null;
    this.dirty = true;
  }

  private releaseRun(run: Run): void {
    for (const cs of run.directed) this.deps.dispatcher.undirectUnit(cs);
    run.directed.length = 0;
    this.deps.traffic.setFleeSpeedCap(run.vehicleId, Infinity);
    this.deps.traffic.setFleeTracked(run.vehicleId, false);
  }

  private startBail(t: CadTime, callId: number, personId: number): void {
    const last = this.lastEnd;
    if (this.bail !== null || last === null || last.personId !== personId || t.sim - last.sim > BAIL_WINDOW_S) return;
    const actorId = this.deps.npc.actorOfPerson(personId);
    if (actorId < 0 || this.deps.npc.actor(actorId, this.actor) === null) return;
    this.bail = {
      personId, actorId, x: this.actor.x, z: this.actor.z, sinceSim: t.sim, posts: [], callId, perimeterSet: false, contained: false,
      lostSince: -1, airRequested: false,
    };
    this.lastEnd = null;
    if (this.cfg.perimeter.requestAir) {
      this.deps.resources.requestType('air', callId, 'auto');
      this.bail.airRequested = true;
    }
  }

  private endBail(): void {
    const b = this.bail;
    if (b === null) return;
    for (const p of b.posts) if (p[2] !== '') this.deps.dispatcher.undirectUnit(p[2]);
    this.bail = null;
    if (this.run === null) this.deps.resources.setAirTarget('none', 0, b.x, b.z);
    this.dirty = true;
  }

  // --- Requests -------------------------------------------------------------------------------------------------------

  private drainRequests(t: CadTime): void {
    const batch = this.requests;
    this.requests = [];
    for (const r of batch) {
      switch (r.kind) {
        case 'requestPit':
          this.requestPit(t);
          break;
        case 'spikesAhead':
          this.requestSpikes(t);
          break;
        case 'deployStrip':
          this.deployStrip(t);
          break;
        case 'boxIn':
          this.requestBoxIn();
          break;
        case 'roadblock':
          this.requestRoadblock(t);
          break;
        case 'air':
          this.requestAir();
          break;
        case 'perimeter':
          if (this.bail !== null && !this.bail.perimeterSet) this.buildPerimeter(this.bail);
          else this.flash('No perimeter to set');
          break;
      }
    }
    this.dirty = true;
  }

  /** The running officer pursuit with a live flee (fills `this.fi`), or null with a flash. */
  private liveRun(): Run | null {
    const run = this.run;
    if (run === null || run.handoff !== null || !this.deps.traffic.fleeInfo(run.vehicleId, this.fi)) {
      this.flash('No active pursuit');
      return null;
    }
    return run;
  }

  private requestPit(t: CadTime): void {
    const run = this.liveRun();
    if (run === null) return;
    if (run.pitAuthorized) {
      this.flash('PIT already authorized');
      return;
    }
    const sup = this.deps.resources.supervisorFor(run.callId);
    if (sup === null) {
      this.order(t, run, 'denyPit', 'Dispatch', 'No supervisor available, PIT not authorized.');
      return;
    }
    const road = this.deps.roadAt(this.fi.x, this.fi.z);
    const env = this.deps.env();
    const policy = pitPolicy(
      {
        speedMph: this.fi.speed / MPH, offense: this.deps.rules.offense(run.callId), authorized: true,
        modelId: this.deps.modelOf(run.vehicleId), district: road.district, wet: env.wet,
      },
      this.cfg,
    );
    if (policy.verdict === 'withinPolicy') {
      run.pitAuthorized = true;
      this.order(t, run, 'authorizePit', sup, `${sup} to ${this.playerCs}, PIT authorized.`);
    } else {
      this.order(t, run, 'denyPit', sup, `${sup} to ${this.playerCs}, PIT denied, ${policy.reasons.join(', ')}.`);
    }
  }

  private requestSpikes(t: CadTime): void {
    const run = this.liveRun();
    if (run === null) return;
    if (run.tactic !== null) {
      this.flash('Another tactic is running');
      return;
    }
    const route = predictRoute(this.deps.graph, this.fi.edge, this.fi.x, this.fi.z, this.fi.yaw, this.cfg.spikes.aheadJunctions);
    const idx = route.nodes.length - 1;
    const nodeId = route.nodes[idx];
    const node = nodeId === undefined ? undefined : this.deps.graph.nodes[nodeId];
    if (nodeId === undefined || node === undefined) {
      this.flash('No road ahead for spikes');
      return;
    }
    const unit = this.bestUnit(run.callId, node.x, node.z);
    if (unit === '') {
      this.flash('No unit available for spikes');
      return;
    }
    this.direct(run, unit, node.x, node.z);
    run.tactic = { kind: 'spikes', unit, node: nodeId, sinceSim: t.sim };
    this.tacticUnits.length = 0;
    this.tacticUnits.push(unit);
    this.say('current', unit, `${unit}, copy, moving ahead to set spikes at ${this.streetNear(node.x, node.z)}.`);
  }

  private deployStrip(t: CadTime): void {
    if (!this.onFoot || !this.carrying) {
      this.flash('You need to be on foot with a spike strip');
      return;
    }
    const g = this.deps.graph;
    if (g.nearestEdge(this.px, this.pz, this.cfg.spikes.playerDeployRangeM, this.hit) === null) {
      this.flash('No road within reach');
      return;
    }
    const edge = this.hit.edge;
    const len = g.edges[edge]?.length ?? 0;
    let dir: 0 | 1 = this.hit.side > 0 ? 0 : 1;
    if (g.laneCount(edge, dir) < 1) dir = dir === 0 ? 1 : 0;
    const sLane = dir === 0 ? this.hit.s : len - this.hit.s;
    if (!stripAcrossLanes(g, edge, dir, sLane, this.cfg.spikes.lengthM, this.tmpStrip)) {
      this.flash('Cannot place a strip here');
      return;
    }
    if (this.takeStripFromKit === null || !this.takeStripFromKit()) {
      this.flash('No spike strip to deploy');
      return;
    }
    this.addStrip(t, this.playerCs);
    this.say('current', this.playerCs, `${this.playerCs}, spikes deployed at ${this.streetNear(this.px, this.pz)}.`);
    this.flash('Spike strip deployed');
  }

  private requestBoxIn(): void {
    const run = this.liveRun();
    if (run === null) return;
    this.view.length = 0;
    this.collectPolice(run.callId);
    const sb = this.suspectBox;
    sb.x = this.fi.x;
    sb.z = this.fi.z;
    sb.yaw = this.fi.yaw;
    sb.speedMph = this.fi.speed / MPH;
    const res = canBoxIn(sb, this.view, this.cfg);
    if (res.ok) {
      this.deps.traffic.stopFlee(run.vehicleId);
      this.tactic(run.callId, 'boxIn', 'success', 'Box-in successful, the suspect is stopped.');
      this.say('current', this.playerCs, `${this.playerCs}, suspect boxed in and stopped.`);
    } else {
      this.tactic(run.callId, 'boxIn', 'failed', `Box-in failed: ${res.reason}`);
    }
  }

  private requestRoadblock(t: CadTime): void {
    const run = this.liveRun();
    if (run === null) return;
    if (run.tactic !== null) {
      this.flash('Another tactic is running');
      return;
    }
    const route = predictRoute(this.deps.graph, this.fi.edge, this.fi.x, this.fi.z, this.fi.yaw, 2);
    const idx = route.nodes.length - 1;
    const nodeId = route.nodes[idx];
    const node = nodeId === undefined ? undefined : this.deps.graph.nodes[nodeId];
    if (nodeId === undefined || node === undefined) {
      this.flash('No road ahead for a roadblock');
      return;
    }
    const ranked = this.rankUnits(run.callId, node.x, node.z);
    if (ranked.length < this.cfg.roadblock.minUnits) {
      this.tactic(run.callId, 'roadblock', 'failed', 'Not enough units for a roadblock.');
      return;
    }
    const chosen = ranked.slice(0, 3);
    for (const cs of chosen) this.direct(run, cs, node.x, node.z);
    run.tactic = { kind: 'roadblock', unit: chosen.join(','), node: nodeId, sinceSim: t.sim };
    this.tacticUnits.length = 0;
    for (const cs of chosen) this.tacticUnits.push(cs);
    this.say('current', this.playerCs, `${this.playerCs}, requesting a roadblock at ${this.streetNear(node.x, node.z)}.`);
  }

  private requestAir(): void {
    const run = this.run !== null && this.run.handoff === null ? this.run : null;
    const bail = this.bail;
    if (run === null && bail === null) {
      this.flash('No active pursuit');
      return;
    }
    if (this.deps.resources.air(this.airOut)) {
      this.flash('The air unit is already up');
      return;
    }
    if ((run !== null && run.airRequested) || (bail !== null && bail.airRequested)) {
      this.flash('Air unit already requested');
      return;
    }
    const callId = run !== null ? run.callId : (bail as Bail).callId;
    this.deps.resources.requestType('air', callId, 'radio');
    if (run !== null) run.airRequested = true;
    if (bail !== null) bail.airRequested = true;
    this.say('current', this.playerCs, `${this.playerCs}, requesting the air unit.`);
  }

  // --- Contact ----------------------------------------------------------------------------------------------------------

  private handleContact(run: Run): void {
    if (!this.hasCar || !this.deps.traffic.fleeInfo(run.vehicleId, this.fi) || this.fi.spinning) return;
    const modelId = this.deps.modelOf(run.vehicleId);
    const d = halfDims(modelId);
    const suspect: CarPose = { x: this.fi.x, z: this.fi.z, yaw: this.fi.yaw, speed: this.fi.speed, halfLength: d.l, halfWidth: d.w };
    const res = classifyContact(this.car, suspect, this.cfg);
    if (res.kind === 'pit') {
      const road = this.deps.roadAt(this.fi.x, this.fi.z);
      const policy = pitPolicy(
        {
          speedMph: this.fi.speed / MPH, offense: this.deps.rules.offense(run.callId), authorized: run.pitAuthorized, modelId,
          district: road.district, wet: this.deps.env().wet,
        },
        this.cfg,
      );
      this.deps.traffic.spinOut(run.vehicleId, res.dir);
      if (policy.verdict === 'withinPolicy') this.tactic(run.callId, 'pit', 'withinPolicy', 'PIT: within policy');
      else this.tactic(run.callId, 'pit', 'outsidePolicy', `PIT: outside policy, ${policy.reasons.join(', ')}`);
    } else if (res.kind === 'ram') {
      this.deps.traffic.crashCar(run.vehicleId);
      this.tactic(run.callId, 'pit', 'outsidePolicy', 'Ramming: outside policy');
    } else if (res.kind === 'bump') {
      this.flash('Contact, no effect');
    }
  }

  // --- Run --------------------------------------------------------------------------------------------------------------

  private stepRun(dt: number, t: CadTime, run: Run): void {
    const traffic = this.deps.traffic;
    const fi = this.fi;
    if (!traffic.fleeInfo(run.vehicleId, fi)) {
      // The flee ended; the scene's end event normally closes the pursuit. Close it ourselves if that never comes.
      if (run.goneSince < 0) run.goneSince = t.sim;
      else if (t.sim - run.goneSince > GONE_GRACE_S) this.endRun(t, 'gone');
      return;
    }
    run.goneSince = -1;

    // Sight: the player farther than SIGHT_M from the suspect has lost visual.
    const dx = this.px - fi.x, dz = this.pz - fi.z;
    if (dx * dx + dz * dz > SIGHT_M * SIGHT_M) {
      if (run.lostSince < 0) run.lostSince = t.sim;
    } else run.lostSince = -1;

    // Strips: the suspect's path this step against every live strip.
    for (let i = 0; i < this.stripList.length; i++) {
      const s = this.stripList[i] as Strip;
      if (!s.active || !crossesStrip(run.prevX, run.prevZ, fi.x, fi.z, s)) continue;
      s.active = false;
      traffic.deflate(run.vehicleId, this.cfg.spikes.tiresOnHit);
      this.say('current', s.owner, `${s.owner}, spikes hit, he's losing tyres.`);
      this.tactic(run.callId, 'spikes', 'success', 'Spikes hit: the suspect is losing tyres.');
      if (run.tactic !== null && run.tactic.kind === 'spikes' && run.tactic.unit === s.owner) this.clearTactic(run);
    }

    this.stepTactic(dt, t, run);
    this.stepAir(run);
    if (tick(t.sim, dt, 1 / this.cfg.supervisor.checkS)) this.stepSupervisor(t, run);
    if (tick(t.sim, dt, 1)) this.stepHandoffRequest(run);
    if (tick(t.sim, dt, 1 / this.cfg.follow.replanS)) this.stepFollow(run);
    if (run.stateUnit !== '' && tick(t.sim, dt, 4)) this.stepTakeover(t, run);
    run.prevX = fi.x;
    run.prevZ = fi.z;
  }

  private stepTactic(dt: number, t: CadTime, run: Run): void {
    const tac = run.tactic;
    if (tac === null) return;
    if (t.sim - tac.sinceSim > TACTIC_TIMEOUT_S) {
      this.failTactic(run, tac.kind === 'spikes' ? 'spikes' : 'roadblock', 'The tactic timed out.');
      return;
    }
    const node = this.deps.graph.nodes[tac.node];
    if (node === undefined) {
      this.clearTactic(run);
      return;
    }
    const fi = this.fi;
    const ahead = -Math.sin(fi.yaw) * (node.x - fi.x) - Math.cos(fi.yaw) * (node.z - fi.z) > 0;
    if (tac.kind === 'spikes') {
      if (!tick(t.sim, dt, 1)) return;
      const placed = this.stripOwnedSince(tac.unit, tac.sinceSim);
      if (placed) {
        if (!ahead) this.failTactic(run, 'spikes', 'The suspect avoided the spike strip.');
        return;
      }
      const dist = Math.hypot(node.x - fi.x, node.z - fi.z);
      if (!ahead || dist < STRIP_MIN_GAP_M) {
        // Too late unless the unit is ready and the suspect is still far.
        this.failTactic(run, 'spikes', 'Too late: the suspect passed before the strip was set.');
        return;
      }
      if (this.unitReady(tac.unit, node.x, node.z)) this.placeAheadStrip(t, run, tac);
      return;
    }
    // Roadblock.
    if (!ahead) {
      this.failTactic(run, 'roadblock', 'The suspect got past the roadblock.');
      return;
    }
    if (tick(t.sim, dt, 1)) {
      const route = predictRoute(this.deps.graph, fi.edge, fi.x, fi.z, fi.yaw, 2);
      if (!route.nodes.includes(tac.node)) {
        this.failTactic(run, 'roadblock', 'The suspect left the roadblock route.');
        return;
      }
    }
    this.view.length = 0;
    let n = 0;
    for (const cs of this.tacticUnits) {
      if (!this.unitPos(cs)) continue;
      this.fill(n++, this.ux, this.uz, false);
    }
    if (unitsAhead(fi, this.view, this.cfg) < this.cfg.roadblock.minUnits) return;
    if (fi.speed <= this.cfg.roadblock.stopMps) {
      this.deps.traffic.stopFlee(run.vehicleId);
      this.tactic(run.callId, 'roadblock', 'success', 'Roadblock successful, the suspect is stopped.');
      this.clearTactic(run);
      return;
    }
    const cap = Math.max(0, Math.min(fi.capMps, fi.speed) - this.cfg.roadblock.decelMps2 * dt);
    this.deps.traffic.setFleeSpeedCap(run.vehicleId, cap);
  }

  private unitReady(cs: string, x: number, z: number): boolean {
    const u = this.deps.cad.unit(cs);
    if (u === null) return false;
    if (u.fleetIndex >= 0 && this.deps.traffic.fleetState(u.fleetIndex, this.fleet) !== null && this.fleet.arrived) return true;
    return this.unitPos(cs) && Math.hypot(this.ux - x, this.uz - z) <= UNIT_AT_NODE_M;
  }

  private placeAheadStrip(t: CadTime, run: Run, tac: { unit: string; node: number }): void {
    // The edge entering the node on the predicted path.
    const route = predictRoute(this.deps.graph, this.fi.edge, this.fi.x, this.fi.z, this.fi.yaw, this.cfg.spikes.aheadJunctions);
    const k = route.nodes.indexOf(tac.node);
    const edge = k >= 0 ? route.edges[k] : undefined;
    if (edge === undefined) {
      this.failTactic(run, 'spikes', 'The suspect left the predicted route.');
      return;
    }
    if (!stripAcrossEdge(this.deps.graph, edge, tac.node, this.cfg.spikes.setbackM, this.cfg.spikes.lengthM, this.tmpStrip)) {
      this.failTactic(run, 'spikes', 'No place for a spike strip.');
      return;
    }
    this.addStrip(t, tac.unit);
    const near = this.deps.graph.edges[edge]?.name ?? 'the road ahead';
    this.say('current', tac.unit, `${tac.unit}, spikes deployed at ${near}.`);
  }

  private clearTactic(run: Run): void {
    const tac = run.tactic;
    if (tac === null) return;
    for (const cs of this.tacticUnits) {
      this.deps.dispatcher.undirectUnit(cs);
      const i = run.directed.indexOf(cs);
      if (i >= 0) run.directed.splice(i, 1);
    }
    this.tacticUnits.length = 0;
    run.tactic = null;
    this.dirty = true;
  }

  private failTactic(run: Run, tactic: PursuitTactic, text: string): void {
    if (run.tactic !== null && run.tactic.kind === 'roadblock') this.deps.traffic.setFleeSpeedCap(run.vehicleId, Infinity);
    this.clearTactic(run);
    this.tactic(run.callId, tactic, 'failed', text);
  }

  private stripOwnedSince(owner: string, sinceSim: number): boolean {
    for (const s of this.stripList) if (s.owner === owner && s.placedSim >= sinceSim) return true;
    return false;
  }

  private stepAir(run: Run): void {
    const res = this.deps.resources;
    const traffic = this.deps.traffic;
    const fi = this.fi;
    if (!res.air(this.airOut)) {
      this.airOnTarget = false;
      if (fi.tracked) traffic.setFleeTracked(run.vehicleId, false);
      return;
    }
    run.airRequested = true;
    res.setAirTarget('vehicle', run.vehicleId, fi.x, fi.z);
    const a = this.airOut;
    const on = a.onTarget && Math.hypot(a.x - fi.x, a.z - fi.z) <= this.cfg.air.trackM;
    if (on !== fi.tracked) traffic.setFleeTracked(run.vehicleId, on);
    this.airOnTarget = on;
    if (on && !this.airReported) {
      this.airReported = true;
      this.tactic(run.callId, 'air', 'success', 'Air unit has eyes on the suspect.');
    }
  }

  private stepSupervisor(t: CadTime, run: Run): void {
    const sup = this.deps.resources.supervisorFor(run.callId);
    if (sup !== null) {
      this.supName = sup;
      if (run.monitorSince < 0) {
        run.monitorSince = t.sim;
        this.say('dispatch', sup, `${sup}, monitoring the pursuit.`);
      }
    } else this.supName = '';
    const fi = this.fi;
    const road = this.deps.roadAt(fi.x, fi.z);
    const env = this.deps.env();
    const rules = this.deps.rules;
    const d = this.decision;
    d.speedMph = fi.speed / MPH;
    d.limitMph = road.limitMph;
    d.district = road.district;
    d.wet = env.wet;
    d.night = env.night;
    d.trafficDensity = this.deps.trafficDensity(fi.x, fi.z);
    d.durationS = t.sim - run.startSim;
    d.offense = rules.offense(run.callId);
    d.lostSightS = run.lostSince < 0 ? 0 : t.sim - run.lostSince;
    d.airOnTarget = this.airOnTarget;
    d.allowedOffenses = rules.allowedOffenses();
    d.maxDurationS = rules.maxDurationS();
    d.supervisorMonitoring = sup !== null;
    d.monitoringS = run.monitorSince < 0 ? 0 : t.sim - run.monitorSince;
    const dec = pursuitDecision(d, this.cfg);
    if (dec.action === 'terminate' && sup !== null && (!run.ordered || t.sim - run.lastOrderSim >= this.cfg.supervisor.repeatS)) {
      run.ordered = true;
      run.lastOrderSim = t.sim;
      run.ignoredFlashed = false;
      this.order(t, run, 'terminate', sup, `${sup} to ${this.playerCs}, terminate the pursuit — ${dec.reason}.`);
    }
    if (run.ordered && !run.ignoredFlashed && t.sim - run.lastOrderSim >= rules.terminateGraceS()) {
      run.ignoredFlashed = true;
      this.flash('Supervisor order ignored');
    }
  }

  private stepHandoffRequest(run: Run): void {
    if (run.stateRequested) return;
    const fi = this.fi;
    if (inCity(fi.x, fi.z, this.cfg) && timeToBoundary(fi.x, fi.z, fi.yaw, fi.speed, this.cfg) <= this.cfg.handoff.requestAheadS) {
      run.stateRequested = true;
      this.deps.resources.requestType('statePatrol', run.callId, 'auto');
      this.say('dispatch', this.playerCs, `${this.playerCs}, suspect is heading for the city limits, requesting state patrol.`);
    }
  }

  private stepFollow(run: Run): void {
    const fi = this.fi;
    if (run.stateRequested) {
      const type = unitType('statePatrol');
      const count = type?.count ?? 0;
      let found = '';
      for (let n = 1; n <= count && found === ''; n++) {
        const cs = (type?.callsign ?? '').replace('{n}', String(n));
        if (cs !== '' && this.deps.resources.directTo(cs, fi.x, fi.z, 'emergency')) found = cs;
      }
      if (found !== '') run.stateUnit = found;
    }
    const list = this.deps.dispatcher.aiUnitsOnCall(run.callId, this.callsigns);
    for (let i = 0; i < list.length; i++) {
      const cs = list[i] as string;
      if (this.tacticUnits.includes(cs)) continue;
      if (this.deps.dispatcher.directUnit(cs, fi.x, fi.z, 'emergency')) this.noteDirected(run, cs);
    }
  }

  private stepTakeover(t: CadTime, run: Run): void {
    const fi = this.fi;
    if (inCity(fi.x, fi.z, this.cfg)) return;
    if (!this.deps.resources.unitPose(run.stateUnit, this.poseOut)) return;
    if (Math.hypot(this.poseOut.x - fi.x, this.poseOut.z - fi.z) > this.cfg.handoff.takeoverM) return;
    const unit = run.stateUnit;
    const h = this.cfg.handoff;
    run.handoff = { unit, resolveAt: t.sim + this.deps.rng.nextFloat(h.resolveS[0], h.resolveS[1]), removeAt: -1, done: false };
    const text = `${unit}, we have primary, ${this.playerCs} you're clear.`;
    this.deps.bus.emit('pursuit:order', { callId: run.callId, order: 'handoff', by: unit, text, sim: t.sim });
    this.deps.bus.emit('pursuit:handoff', { callId: run.callId, to: unit });
    this.say('dispatch', unit, text, true);
    this.deps.scene.request({ kind: 'terminatePursuit', reason: 'handoff' });
    this.tactic(run.callId, 'handoff', 'success', `${unit} has primary.`);
    // The officer's units disengage.
    this.clearTactic(run);
    this.releaseRun(run);
    this.airOnTarget = false;
    this.dirty = true;
  }

  /** After a handoff the car is a state pursuit: resolve it off-screen, then remove the car. */
  private stepHandoffMode(t: CadTime, run: Run): void {
    const h = run.handoff;
    if (h === null) return;
    if (h.removeAt >= 0) {
      if (t.sim >= h.removeAt) {
        this.deps.traffic.removeVehicle(run.vehicleId);
        this.finishState(t);
      }
      return;
    }
    if (!this.deps.traffic.fleeInfo(run.vehicleId, this.fi)) {
      this.finishState(t);
      return;
    }
    if (h.done || t.sim < h.resolveAt) return;
    h.done = true;
    if (this.deps.rng.chance(this.cfg.handoff.catchChance)) {
      this.deps.traffic.stopFlee(run.vehicleId);
      this.say('state', h.unit, `${h.unit}, suspect in custody.`);
      h.removeAt = t.sim + this.cfg.handoff.removeAfterS;
    } else {
      this.finishState(t);
    }
  }

  private finishState(t: CadTime): void {
    const run = this.run;
    if (run === null) return;
    // The scene already ended the officer's pursuit at the handoff; just forget the car.
    this.deps.resources.setAirTarget('none', 0, run.prevX, run.prevZ);
    for (const s of this.stripList) s.placedSim = Math.min(s.placedSim, t.sim + STRIPS_LINGER_S - this.cfg.spikes.expireS);
    this.run = null;
    this.tacticUnits.length = 0;
    this.supName = '';
    this.dirty = true;
  }

  // --- Strips -------------------------------------------------------------------------------------------------------------

  private addStrip(t: CadTime, owner: string): void {
    const s: Strip = {
      id: this.nextStripId++, x0: this.tmpStrip.x0, z0: this.tmpStrip.z0, x1: this.tmpStrip.x1, z1: this.tmpStrip.z1,
      placedSim: t.sim, owner, active: true,
    };
    this.stripList.push(s);
    this.dirty = true;
  }

  /** The player's own car driving over a live strip bursts its front tyres. */
  private stepPlayerStrips(dt: number): void {
    if (!this.hasCar) return;
    const c = this.car;
    const bx = c.x, bz = c.z;
    // Previous position from the velocity (no stored state).
    const ax = bx + Math.sin(c.yaw) * c.speed * dt, az = bz + Math.cos(c.yaw) * c.speed * dt;
    for (let i = 0; i < this.stripList.length; i++) {
      const s = this.stripList[i] as Strip;
      if (!s.active || !crossesStrip(ax, az, bx, bz, s)) continue;
      s.active = false;
      this.burstPlayerTires?.();
      this.flash('You drove over your own spike strip');
      this.dirty = true;
    }
  }

  private expireStrips(t: CadTime): void {
    const life = this.cfg.spikes.expireS;
    let w = 0;
    for (let i = 0; i < this.stripList.length; i++) {
      const s = this.stripList[i] as Strip;
      if (t.sim - s.placedSim < life) this.stripList[w++] = s;
    }
    if (w !== this.stripList.length) {
      this.stripList.length = w;
      this.dirty = true;
    }
  }

  // --- Foot bail ---------------------------------------------------------------------------------------------------------

  private stepBail(dt: number, t: CadTime, b: Bail): void {
    if (!tick(t.sim, dt, 4)) return;
    if (t.sim - b.sinceSim > BAIL_MAX_S || this.deps.npc.actor(b.actorId, this.actor) === null) {
      this.endBail();
      return;
    }
    const a = this.actor;
    if (this.deps.resources.air(this.airOut)) this.deps.resources.setAirTarget('actor', b.actorId, a.x, a.z);
    if (!b.perimeterSet) {
      if (Math.hypot(a.x - this.px, a.z - this.pz) > BAIL_SIGHT_M) {
        if (b.lostSince < 0) b.lostSince = t.sim;
        else if (t.sim - b.lostSince >= this.cfg.perimeter.lostSightS) this.buildPerimeter(b);
      } else b.lostSince = -1;
      return;
    }
    this.fillMissingPosts(b);
    if (b.contained) return;
    const p = this.cfg.perimeter;
    if (Math.hypot(a.x - b.x, a.z - b.z) <= p.radiusM - CONTAIN_INSET_M) return;
    for (const post of b.posts) {
      if (post[2] === '' || !this.unitPos(post[2])) continue;
      if (Math.hypot(this.ux - a.x, this.uz - a.z) > p.postNearM) continue;
      b.contained = true;
      this.deps.npc.forceState(b.actorId, 'handsUp');
      this.say('current', post[2], `${post[2]}, perimeter unit has the suspect at gunpoint.`);
      this.tactic(b.callId, 'perimeter', 'success', 'Perimeter unit has the suspect.');
      return;
    }
  }

  private buildPerimeter(b: Bail): void {
    const p = this.cfg.perimeter;
    const posts = perimeterPosts(this.deps.graph, b.x, b.z, p.radiusM, p.posts);
    b.posts = posts.map((q) => [q.x, q.z, ''] as [number, number, string]);
    b.perimeterSet = true;
    this.fillMissingPosts(b);
    let missing = 0;
    for (const q of b.posts) if (q[2] === '') missing++;
    if (missing > 0) this.deps.dispatcher.sendBackup(3, missing);
    if (p.requestK9) this.deps.resources.requestType('k9', b.callId, 'auto');
    if (p.requestAir && !b.airRequested) {
      this.deps.resources.requestType('air', b.callId, 'auto');
      b.airRequested = true;
    }
    this.say('current', this.playerCs, `Units, setting a perimeter around ${this.streetNear(b.x, b.z)}.`);
    this.tactic(b.callId, 'perimeter', 'withinPolicy', 'Perimeter set.');
  }

  /** Assigns the nearest free AI unit of the call to every unstaffed post and sends it there. */
  private fillMissingPosts(b: Bail): void {
    let open = false;
    for (const q of b.posts) if (q[2] === '') open = true;
    if (!open) return;
    const list = this.deps.dispatcher.aiUnitsOnCall(b.callId, this.callsigns);
    for (const post of b.posts) {
      if (post[2] !== '') continue;
      let best = '';
      let bestD = Infinity;
      for (let i = 0; i < list.length; i++) {
        const cs = list[i] as string;
        if (b.posts.some((q) => q[2] === cs) || !this.unitPos(cs)) continue;
        const d = Math.hypot(this.ux - post[0], this.uz - post[1]);
        if (d < bestD) {
          bestD = d;
          best = cs;
        }
      }
      if (best === '') continue;
      if (this.deps.dispatcher.directUnit(best, post[0], post[1], 'emergency')) post[2] = best;
    }
  }

  // --- Helpers --------------------------------------------------------------------------------------------------------------

  private direct(run: Run, cs: string, x: number, z: number): void {
    if (this.deps.dispatcher.directUnit(cs, x, z, 'emergency')) this.noteDirected(run, cs);
  }

  private noteDirected(run: Run, cs: string): void {
    if (!run.directed.includes(cs)) run.directed.push(cs);
  }

  /** Position of unit `cs` into (`ux`, `uz`): its fleet car, else its CAD position. */
  private unitPos(cs: string): boolean {
    const u = this.deps.cad.unit(cs);
    if (u === null) return false;
    if (u.fleetIndex >= 0 && this.deps.traffic.fleetState(u.fleetIndex, this.fleet) !== null) {
      this.ux = this.fleet.x;
      this.uz = this.fleet.z;
    } else {
      this.ux = u.x;
      this.uz = u.z;
    }
    return true;
  }

  private fill(i: number, x: number, z: number, player: boolean): void {
    let o = this.pool[i];
    if (!o) {
      o = { x: 0, z: 0, player: false };
      this.pool[i] = o;
    }
    o.x = x;
    o.z = z;
    o.player = player;
    this.view.push(o);
  }

  /** Fills `view` with the call's AI units and the player's car (when driving). */
  private collectPolice(callId: number): void {
    const list = this.deps.dispatcher.aiUnitsOnCall(callId, this.callsigns);
    let n = this.view.length;
    for (let i = 0; i < list.length; i++) {
      if (this.unitPos(list[i] as string)) this.fill(n++, this.ux, this.uz, false);
    }
    if (this.hasCar) this.fill(n, this.car.x, this.car.z, true);
  }

  /** Estimated seconds for unit `cs` to reach (x, z) code 3, Infinity when it cannot. */
  private etaTo(cs: string, x: number, z: number): number {
    if (!this.unitPos(cs)) return Infinity;
    const route = this.deps.graph.routeBetweenPoints(this.ux, this.uz, x, z);
    if (route === null || !Number.isFinite(route.time) || !Number.isFinite(route.length)) return Infinity;
    return estimateResponse({
      routeTimeS: route.time, routeLengthM: route.length, priority: 1, urgency: 'emergency',
      trafficDensity: clamp(this.deps.trafficDensity(x, z), 0, 2), wetness: this.deps.env().wet ? 1 : 0, turnoutS: [0, 0], speedFactor: 1,
    }).etaS;
  }

  /** The AI unit of the call with the lowest ETA to (x, z), '' none. */
  private bestUnit(callId: number, x: number, z: number): string {
    const list = this.deps.dispatcher.aiUnitsOnCall(callId, []);
    let best = '';
    let bestEta = Infinity;
    for (const cs of list) {
      const eta = this.etaTo(cs, x, z);
      if (eta < bestEta) {
        bestEta = eta;
        best = cs;
      }
    }
    return best;
  }

  /** The call's AI units that can reach (x, z), fastest first. */
  private rankUnits(callId: number, x: number, z: number): string[] {
    const list = this.deps.dispatcher.aiUnitsOnCall(callId, []);
    const etas = new Map<string, number>();
    const out: string[] = [];
    for (const cs of list) {
      const eta = this.etaTo(cs, x, z);
      if (!Number.isFinite(eta)) continue;
      etas.set(cs, eta);
      out.push(cs);
    }
    out.sort((a, b) => (etas.get(a) ?? 0) - (etas.get(b) ?? 0));
    return out;
  }

  private streetNear(x: number, z: number): string {
    const g = this.deps.graph;
    if (g.nearestEdge(x, z, 80, this.hit) === null) return 'the area';
    return g.edges[this.hit.edge]?.name ?? 'the area';
  }

  private say(channel: RadioLinePayload['channel'], speaker: string, text: string, priority = false): void {
    this.deps.bus.emit('pursuit:radio', priority ? { channel, speaker, text, priority } : { channel, speaker, text });
  }

  private flash(text: string): void {
    this.deps.bus.emit('pursuit:flash', { text });
  }

  private tactic(callId: number, tactic: PursuitTactic, verdict: TacticVerdict, text: string): void {
    this.lastVerdict = text;
    this.deps.bus.emit('pursuit:tactic', { callId, tactic, verdict, text });
    this.dirty = true;
  }

  /** A supervisor order: the bus event for the incident recorder and the radio line. */
  private order(t: CadTime, run: Run, order: 'terminate' | 'authorizePit' | 'denyPit', by: string, text: string): void {
    this.deps.bus.emit('pursuit:order', { callId: run.callId, order, by, text, sim: t.sim });
    this.say('dispatch', by, text, true);
    this.dirty = true;
  }

  // --- HUD and menu (1 Hz) --------------------------------------------------------------------------------------------------

  private refresh(t: CadTime): void {
    this.dirty = false;
    const run = this.run;
    const bail = this.bail;
    let line = '';
    if (run !== null && run.handoff !== null) {
      line = `STATE PURSUIT · ${run.handoff.unit} has primary`;
    } else if (run !== null && this.deps.traffic.fleeInfo(run.vehicleId, this.fi)) {
      const fi = this.fi;
      const road = this.deps.roadAt(fi.x, fi.z);
      const risk = pursuitRisk(
        {
          speedMph: fi.speed / MPH, limitMph: road.limitMph, district: road.district, wet: this.deps.env().wet, night: this.deps.env().night,
          trafficDensity: this.deps.trafficDensity(fi.x, fi.z), durationS: t.sim - run.startSim, offense: this.deps.rules.offense(run.callId),
          violentOffenses: VIOLENT_OFFENSES, lostSightS: run.lostSince < 0 ? 0 : t.sim - run.lostSince, airOnTarget: this.airOnTarget,
        },
        this.cfg,
      );
      line = `PURSUIT · ${Math.round(fi.speed / MPH)} mph · risk ${risk.toFixed(2)}`;
      if (this.supName !== '') line += ` · ${this.supName} monitoring`;
      if (this.airOnTarget) line += ' · AIR on target';
    } else if (run !== null) {
      line = 'PURSUIT · suspect stopped';
    } else if (bail !== null) {
      let staffed = 0;
      for (const q of bail.posts) if (q[2] !== '') staffed++;
      line = bail.perimeterSet ? `FOOT BAIL · perimeter ${staffed}/${bail.posts.length}${bail.contained ? ' · contained' : ''}` : 'FOOT BAIL · runner on foot';
    }
    const on = line !== '';
    const verdict = on ? this.lastVerdict : null;
    let changed = false;
    if (on !== this.hudOn || line !== this.hudObj.line || verdict !== this.hudObj.verdict) {
      this.hudOn = on;
      this.hudObj.line = line;
      this.hudObj.verdict = verdict;
      changed = true;
    }
    if (this.refreshMenu()) changed = true;
    if (changed) this.rev++;
  }

  private setItem(i: number, enabled: boolean, hint: string): boolean {
    const item = this.menuItems[i];
    if (!item || (item.enabled === enabled && item.hint === hint)) return false;
    item.enabled = enabled;
    item.hint = hint;
    return true;
  }

  private refreshMenu(): boolean {
    const run = this.run !== null && this.run.handoff === null ? this.run : null;
    const bail = this.bail;
    const live = run !== null && this.deps.traffic.fleeInfo(run.vehicleId, this.fi);
    const cfg = this.cfg;
    let changed = false;
    const none = 'No active pursuit';
    const busy = 'Another tactic is running';

    changed = this.setItem(0, live && !run.pitAuthorized, !live ? none : run.pitAuthorized ? 'PIT authorized' : 'Ask the supervisor') || changed;

    let units = 0;
    if (run !== null) units = this.deps.dispatcher.aiUnitsOnCall(run.callId, this.callsigns).length;
    changed = this.setItem(1, live && run.tactic === null && units > 0, !live ? none : run.tactic !== null ? busy : units === 0 ? 'No unit available' : 'Send a unit ahead') || changed;

    let road = false;
    if (this.onFoot && this.carrying) road = this.deps.graph.nearestEdge(this.px, this.pz, cfg.spikes.playerDeployRangeM, this.hit) !== null;
    changed = this.setItem(2, this.onFoot && this.carrying && road, !this.onFoot ? 'Get out of the car' : !this.carrying ? 'No spike strip in the kit' : road ? 'Place it across the road' : 'No road within reach') || changed;

    let boxHint = none;
    let boxOk = false;
    if (live) {
      this.view.length = 0;
      this.collectPolice(run.callId);
      const sb = this.suspectBox;
      sb.x = this.fi.x;
      sb.z = this.fi.z;
      sb.yaw = this.fi.yaw;
      sb.speedMph = this.fi.speed / MPH;
      const res = canBoxIn(sb, this.view, cfg);
      boxOk = res.ok;
      boxHint = res.ok ? 'Ready' : res.reason;
    }
    changed = this.setItem(3, live && boxOk, boxHint) || changed;

    changed = this.setItem(4, live && run.tactic === null && units >= cfg.roadblock.minUnits, !live ? none : run.tactic !== null ? busy : units < cfg.roadblock.minUnits ? `Need ${cfg.roadblock.minUnits} units` : 'Units block the road ahead') || changed;

    const airUp = (live || bail !== null) && this.deps.resources.air(this.airOut);
    const airAsked = (run !== null && run.airRequested) || (bail !== null && bail.airRequested);
    changed = this.setItem(5, (live || bail !== null) && !airUp && !airAsked, !(live || bail !== null) ? none : airUp ? 'Air unit is up' : airAsked ? 'Air unit requested' : 'Request the helicopter') || changed;

    changed = this.setItem(6, bail !== null && !bail.perimeterSet, bail === null ? 'No foot bail' : bail.perimeterSet ? 'Perimeter set' : 'Cordon off the area') || changed;
    return changed;
  }

  // --- Save ----------------------------------------------------------------------------------------------------------------

  serialize(): PursuitSave {
    const save = emptyPursuitSave(this.deps.rng.state());
    const r = this.run;
    if (r !== null) {
      save.pursuit = {
        callId: r.callId, vehicleId: r.vehicleId, personId: r.personId, startSim: r.startSim, pitAuthorized: r.pitAuthorized,
        monitorSince: r.monitorSince, lastOrderSim: r.lastOrderSim, ordered: r.ordered, lostSince: r.lostSince, prevX: r.prevX,
        prevZ: r.prevZ, tactic: r.tactic ? { ...r.tactic } : null, handoff: r.handoff ? { ...r.handoff } : null,
        stateRequested: r.stateRequested, airRequested: r.airRequested, ignoredFlashed: r.ignoredFlashed, directed: [...r.directed],
        stateUnit: r.stateUnit,
      };
    }
    const b = this.bail;
    if (b !== null) save.bail = { ...b, posts: b.posts.map((p) => [p[0], p[1], p[2]] as [number, number, string]) };
    save.strips = this.stripList.map((s) => ({ ...s }));
    save.nextStripId = this.nextStripId;
    save.requests = this.requests.map((q) => ({ ...q }));
    save.intake = this.intake.map((e) => ({ ...e }));
    save.lastEnd = this.lastEnd ? { ...this.lastEnd } : null;
    return save;
  }

  restore(s: PursuitSave): void {
    this.deps.rng.restore(s.rng);
    const p = s.pursuit;
    this.run = p
      ? {
          callId: p.callId, vehicleId: p.vehicleId, personId: p.personId, startSim: p.startSim, pitAuthorized: p.pitAuthorized,
          monitorSince: p.monitorSince, lastOrderSim: p.lastOrderSim, ordered: p.ordered, lostSince: p.lostSince, prevX: p.prevX,
          prevZ: p.prevZ, tactic: p.tactic ? { ...p.tactic } : null, handoff: p.handoff ? { ...p.handoff } : null,
          stateRequested: p.stateRequested ?? false, airRequested: p.airRequested ?? false, ignoredFlashed: p.ignoredFlashed ?? false,
          directed: [...(p.directed ?? [])], stateUnit: p.stateUnit ?? '', goneSince: -1,
        }
      : null;
    this.tacticUnits.length = 0;
    if (this.run?.tactic) for (const cs of this.run.tactic.unit.split(',')) if (cs !== '') this.tacticUnits.push(cs);
    const b = s.bail;
    this.bail = b
      ? {
          personId: b.personId, actorId: b.actorId, x: b.x, z: b.z, sinceSim: b.sinceSim,
          posts: b.posts.map((q) => [q[0], q[1], q[2]] as [number, number, string]), callId: b.callId ?? 0,
          perimeterSet: b.perimeterSet ?? false, contained: b.contained ?? false, lostSince: b.lostSince ?? -1, airRequested: b.airRequested ?? false,
        }
      : null;
    this.stripList = s.strips.map((q) => ({ ...q }));
    this.nextStripId = s.nextStripId;
    this.requests = s.requests.map((q) => ({ ...q }));
    this.intake = (s.intake ?? []).map((e) => ({ ...e }));
    this.lastEnd = s.lastEnd ? { ...s.lastEnd } : null;
    this.supName = '';
    this.airOnTarget = false;
    this.airReported = false;
    this.lastVerdict = null;
    this.hudOn = false;
    this.dirty = true;
    this.rev++;
  }

  dispose(): void {
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.intake.length = 0;
    this.requests.length = 0;
    this.stripList.length = 0;
    this.run = null;
    this.bail = null;
    this.takeStripFromKit = null;
    this.burstPlayerTires = null;
  }
}
