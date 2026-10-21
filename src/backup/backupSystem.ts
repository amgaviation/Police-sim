/**
 * Backup officers on foot (design §9.4): the AI units on scene of the player's call get out, take the cover or
 * secondary role, call out what they see, chase and cuff runners, staff posts and return to their cars. Stress and
 * fatigue (the roster) decide deterministic mistakes: late callouts, poor positioning and, rarely, excessive force.
 * The SWAT team (`SwatTeam`) shares the view. Steady-state `step` allocates nothing; the view arrays are written in place.
 */
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import { hashString, type Rng } from '../core/rng';
import type { CadState } from '../cad/cadState';
import type { CadTime, CadUnit } from '../cad/types';
import { ACTOR_STATE, type ActorInfo, type CommandContext, type CommandOutcome, type NpcCommand } from '../npc/types';
import { createHumanoidSource, FIGURE_FLAG, HELD, POSE, type HumanoidSource } from '../render/people/pose';
import type { FellowOfficer } from '../force/types';
import type { InteriorQuery } from '../tactical/types';
import { TACTICS } from '../tactical/data';
import { mistakeChances, rollMistakes } from '../units/personality';
import type { RosterState } from '../units/roster';
import { resourceSlots } from '../units/data';
import type { Rank } from '../units/types';
import { BACKUP_CONFIG, SWAT_CONFIG } from './data';
import { createFsmOutput, initialRole, stepOfficerFsm, type FsmInputs, type FsmOutput, type OfficerFsm } from './fsm';
import { coverSpot, poorCoverSpot, positionQuality, yawToward, type SpotOut } from './geometry';
import type { BackupOfficerSave, BackupPostSave, BackupSave, PendingCalloutSave } from './save';
import { SwatTeam } from './swat';
import type {
  BackupAppearance,
  BackupAppearanceRole,
  BackupConfig,
  BackupPort,
  BackupRequest,
  BackupOfficerView,
  BackupRole,
  BackupState,
  CalloutKind,
  PostKind,
  SwatCommand,
  SwatConfig,
  SwatPlan,
} from './types';

/** Subset of the NPC system the backup officers use (design §9.4). */
export interface BackupNpcPort {
  actorIds(out: number[]): number[];
  actor(id: number, out: ActorInfo): ActorInfo | null;
  actorsOfCall(callId: number, out: number[]): number[];
  evaluateCommand(id: number, cmd: NpcCommand, ctx: CommandContext): CommandOutcome;
  applyCommand(id: number, cmd: NpcCommand, outcome: CommandOutcome): void;
  forceState(id: number, state: 'handsUp' | 'kneel' | 'prone' | 'hold' | 'leave'): void;
  cuff(id: number): 'ok' | 'resist' | 'notReady';
  tackle(officerX: number, officerZ: number, officerYaw: number, building?: number): number;
  incapacitate(id: number, seconds: number, by: 'beanbag' | 'strike'): boolean;
  actorsInBuilding(buildingId: number, out: number[]): number[];
}

export interface BackupDeps {
  readonly seed: number;
  readonly bus: EventBus<EventMap>;
  /** session.rng.stream('backup'). */
  readonly rng: Rng;
  readonly roster: RosterState;
  readonly cad: CadState;
  readonly npc: BackupNpcPort;
  /** Pose of a unit's car (AI patrol via the dispatcher's fleet index, resource via resources.unitPose); false when absent. */
  unitCar(callsign: string, out: { x: number; z: number; yaw: number }): boolean;
  /** Interiors (SWAT): layout, door states. */
  readonly interiors: InteriorQuery;
  /** Queues an interior door request (SWAT breach: 'ram'; open: 'open'). */
  doorRequest(buildingId: number, door: number, action: 'open' | 'ram' | 'kick'): void;
  /** Building footprint and front door (BuildingIndex.building). */
  building(id: number): { minX: number; minZ: number; maxX: number; maxZ: number; door: { x: number; z: number; yaw: number } } | null;
  /**
   * True while the unit has been told to leave its call but is still on it (Code 4 timer, on-scene time up): its officers
   * walk back to the car at once, so the car does not drive off with an officer running after it.
   */
  releasing?: (callsign: string) => boolean;
  /** The call's bound building, -1 none. */
  callBuilding(callId: number): number;
  /** SWAT units on scene of the call (resources.onScene(callId, 'swat')). */
  swatOnScene(callId: number): number;
  /** The SWAT negotiation trust 0..1 of the call (command), 0 when none. */
  negotiationTrust(callId: number): number;
  /**
   * Phase 7: the outfit of an AI officer (`outfit` index into the renderer's table plus shirt / trousers colours);
   * null or absent keeps the Phase 6 colours and outfit 0. Asked once per callsign (cached).
   */
  appearanceOf?(callsign: string, role: BackupAppearanceRole): BackupAppearance | null;
  readonly config?: BackupConfig;
  readonly swatConfig?: SwatConfig;
}

export interface BackupContext {
  x: number;
  z: number;
  yaw: number;
  building: number;
  onFoot: boolean;
  /** The player's CAD call, 0 none. */
  callId: number;
  /** Person id of the player's open contact (contact.active), -1 none: the cover target. */
  contactPersonId: number;
  /**
   * Optional: where the contact stands when that person is not a scene actor (a driver still in a stopped car):
   * the cover officer takes cover against this point.
   */
  subject?: { x: number; z: number } | null;
  /** Current game seconds (the roster minute tick is the integrator's). */
  game: number;
}

// --- Constants -----------------------------------------------------------------------------------------------

/** Resource unit types whose crews get out of the car with the player. */
const FOOT_TYPES: readonly string[] = ['supervisor', 'lieutenant', 'chief', 'statePatrol'];
/** Roles of the actors that count as subjects (second subjects, secondary targets). */
const SUBJECT_ROLES: readonly string[] = ['subject', 'suspect', 'driver', 'passenger'];
/** Rank of the resource unit types, by callsign. */
const SLOT_TYPE = new Map<string, string>();
for (const slot of resourceSlots()) SLOT_TYPE.set(slot.callsign, slot.typeId);
const SWAT_CALLSIGNS: readonly string[] = resourceSlots().filter((s) => s.typeId === 'swat').map((s) => s.callsign);

const F_LATE_USED = 1;
const F_LATE_SHOWN = 2;
const F_POOR_SHOWN = 4;
const F_FORCE_SHOWN = 8;
const F_COVERED = 16;
const F_ABANDONED = 32;
const F_COVERING = 64;
const F_PINNED = 128;
/** The unit left the call (status or call changed) while the officer was out: a returned officer gets out again on re-arrival. */
const F_LEFT = 256;

const SCAN_S = 0.25;
const COVER_TARGET_RANGE_M = 25;
const FIGHT_RANGE_M = 25;
const SHOT_RANGE_M = 60;
const FORCE_RANGE_M = 20;
const COVERED_RANGE_M = 15;
const ABANDON_RANGE_M = 200;
const ABANDON_S = 60;
const RUN_OVER_M = 6;
const STRIDE = 1.4;
const CUFF_RANGE_M = 1.2;
const CUFF_RETRY_S = 1;
const DETAIN_GIVE_UP_S = 20;
/** After a failed detain the officer does not auto-detain the same kind of subject for this long. */
const DETAIN_PAUSE_S = 30;
/** A car moving faster than this (m/s) while its officer is still away leaves the officer behind. */
const CAR_LEAVING_MPS = 2;
/** A player in a vehicle farther than this from the officer has driven off: the officers walk back to their own cars. */
const DRIVE_OFF_RANGE_M = 35;
const DOOR_OFFSET_M = 1.2;
const STANDBY_BEHIND_M = 3;
const CONTACT_SCAN_S = 0.25;
const MAX_MEMORY = 48;
const MAX_QUEUE = 64;
const TWO_POW_32 = 4294967296;
const DEG = Math.PI / 180;

const OBSERVATIONAL: readonly CalloutKind[] = ['weapon', 'secondSubject', 'runner', 'handsClear', 'fight'];
const COMPLIANT: ReadonlySet<number> = new Set<number>([ACTOR_STATE.handsUp, ACTOR_STATE.kneel, ACTOR_STATE.prone, ACTOR_STATE.down]);

interface Officer {
  readonly callsign: string;
  readonly name: string;
  readonly rank: Rank;
  callId: number;
  fsm: OfficerFsm;
  x: number;
  z: number;
  yaw: number;
  building: number;
  seq: number;
  mistakes: [boolean, boolean, boolean];
  targetActor: number;
  post: BackupPostSave | null;
  sideSign: 1 | -1;
  nextScan: number;
  calledOut: [number, string, number][];
  flags: number;
  // runtime only
  slot: number;
  goalX: number;
  goalZ: number;
  goalYaw: number;
  goalT: number;
  cmd: FsmInputs['command'];
  cmdT: number;
  cmdIdx: number;
  cuffT: number;
  detainT: number;
  farT: number;
  threat: boolean;
  speed: number;
  gait: number;
  prevX: number;
  prevZ: number;
  prevYaw: number;
  coverAngle: number;
  coverDist: number;
  hasCover: boolean;
  cvSx: number;
  cvSz: number;
  cvPx: number;
  cvPz: number;
  atCar: boolean;
  /** The car's last seen position (returning), NaN none. */
  carX: number;
  carZ: number;
}

interface Pending {
  callsign: string;
  kind: CalloutKind;
  text: string;
  dueSim: number;
  priority: boolean;
  late: boolean;
}

function newInfo(): ActorInfo {
  return {
    id: 0, personId: -1, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false,
    armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
  };
}

function hashFrac(callsign: string, salt: string): number {
  return hashString(callsign + salt) / TWO_POW_32;
}

function lerp(r: readonly [number, number], u: number): number {
  return r[0] + (r[1] - r[0]) * u;
}

function rankOf(callsign: string): Rank {
  const type = SLOT_TYPE.get(callsign);
  if (type === 'supervisor') return 'sergeant';
  if (type === 'lieutenant') return 'lieutenant';
  if (type === 'chief') return 'chief';
  return 'officer';
}

function compass(yaw: number): string {
  const hx = -Math.sin(yaw);
  const hz = -Math.cos(yaw);
  if (Math.abs(hz) >= Math.abs(hx)) return hz < 0 ? 'northbound' : 'southbound';
  return hx > 0 ? 'eastbound' : 'westbound';
}

function dist2(ax: number, az: number, bx: number, bz: number): number {
  const dx = ax - bx;
  const dz = az - bz;
  return dx * dx + dz * dz;
}

/** The backup officers and the SWAT team of a session. */
export class BackupSystem implements BackupPort {
  /** Officers (slots 0 .. maxOfficers - 1) followed by the SWAT operators. */
  readonly view: HumanoidSource & { count: number; outfit: Uint16Array };
  /** Bumped when the set of officers, a state or a post changes (UI refresh key). */
  revision = 0;

  private readonly deps: BackupDeps;
  private readonly cfg: BackupConfig;
  private readonly swatCfg: SwatConfig;
  private readonly list: Officer[] = [];
  private readonly byCallsign = new Map<string, Officer>();
  private readonly slots: (Officer | null)[];
  private readonly pending: Pending[] = [];
  private requests: BackupRequest[] = [];
  private team: SwatTeam | null = null;
  private readonly unsub: (() => void)[] = [];
  /** Appearance per callsign, asked once (null = the dependency has none). */
  private readonly looks = new Map<string, BackupAppearance | null>();

  // scratch
  private readonly ids: number[] = [];
  private readonly info = newInfo();
  private readonly info2 = newInfo();
  private readonly pose = { x: 0, z: 0, yaw: 0 };
  private readonly spot: SpotOut = { x: 0, z: 0, yaw: 0 };
  private readonly fsmIn: FsmInputs = {
    dt: 0, onCall: true, goalDistance: 0, runner: false, caught: false, lost: false, command: null, post: false, detained: false, atCar: false,
  };
  private readonly fsmOut: FsmOutput = createFsmOutput();
  private readonly cmdCtx = { tone: 'commanding', rapport: 0, commMode: 'verbal', weapon: 'sidearm', backup: 1, lights: false } as {
    -readonly [K in keyof CommandContext]: CommandContext[K];
  };

  // contact actor cache
  private contactActor = 0;
  private contactScanT = 0;

  // stress and bus queues
  private stressT = 0;
  private readonly shotQueue: number[] = [];
  private readonly forceQueue: number[] = [];
  private readonly forceOtherQueue: string[] = [];
  private readonly intervenedQueue: string[] = [];
  private readonly otherBy = new Map<number, string>();
  private readonly pursuitQueue: number[] = [];
  private readonly pursuitSeen = new Set<number>();

  // views
  private viewObjects: BackupOfficerView[] = [];
  private readonly viewList: BackupOfficerView[] = [];
  private readonly fellowPool: FellowOfficer[] = [];
  private readonly fellowList: FellowOfficer[] = [];

  constructor(deps: BackupDeps) {
    this.deps = deps;
    this.cfg = deps.config ?? BACKUP_CONFIG;
    this.swatCfg = deps.swatConfig ?? SWAT_CONFIG;
    const cap = this.cfg.spawn.maxOfficers + this.swatCfg.operators;
    // The outfit array is allocated here when the render module's source does not carry one, so wave order never matters.
    const source = createHumanoidSource(cap);
    const given: Partial<HumanoidSource> = source;
    this.view = { ...source, outfit: given.outfit ?? new Uint16Array(cap) };
    this.slots = new Array<Officer | null>(this.cfg.spawn.maxOfficers).fill(null);
    for (let i = 0; i < cap; i++) this.view.flags[i] = FIGURE_FLAG.hidden;
    this.view.count = 0;
    const bus = deps.bus;
    this.unsub.push(
      bus.on('npc:attack', (e) => {
        if (e.kind === 'fire' && this.shotQueue.length < MAX_QUEUE) this.shotQueue.push(e.actorId);
      }),
      bus.on('force:applied', (e) => {
        if (this.forceQueue.length < MAX_QUEUE) this.forceQueue.push(e.actorId);
      }),
      bus.on('force:other', (e) => {
        if (this.forceOtherQueue.length < MAX_QUEUE) this.forceOtherQueue.push(e.officer);
        this.otherBy.set(e.seq, e.officer);
        if (this.otherBy.size > 64) {
          const first = this.otherBy.keys().next();
          if (!first.done) this.otherBy.delete(first.value);
        }
      }),
      bus.on('force:intervened', (e) => {
        const name = this.otherBy.get(e.otherSeq);
        if (name !== undefined && this.intervenedQueue.length < MAX_QUEUE) this.intervenedQueue.push(name);
      }),
      bus.on('scene:pursuit', (e) => {
        if (e.kind === 'vehicle' && e.active && this.pursuitQueue.length < MAX_QUEUE) this.pursuitQueue.push(e.callId);
      }),
    );
  }

  // --- Public API ------------------------------------------------------------------------------------------

  /** Queues a request; applied at the start of the next step. */
  request(r: BackupRequest): void {
    if (this.requests.length < 256) this.requests.push(r);
  }

  /** The officers that are on foot (not yet gone); a reused array of reused objects. */
  officers(): readonly BackupOfficerView[] {
    let n = 0;
    for (const o of this.list) {
      if (o.fsm.state === 'gone') continue;
      let v = this.viewObjects[n];
      if (v === undefined) {
        v = { callsign: '', name: '', role: 'standby', state: 'approach', stress: 0, fatigue: 0, loyalty: 0, quality: 1, post: null };
        this.viewObjects.push(v);
      }
      const dyn = this.deps.roster.dynamic(o.callsign);
      v.callsign = o.callsign;
      v.name = o.name;
      v.role = o.fsm.role;
      v.state = o.fsm.state;
      v.stress = dyn?.stress ?? 0;
      v.fatigue = dyn?.fatigue ?? 0;
      v.loyalty = dyn?.loyalty ?? 0;
      v.quality = o.hasCover ? positionQuality(o.cvPx, o.cvPz, o.cvSx, o.cvSz, o.x, o.z, this.cfg) : 1;
      v.post = o.post === null ? null : o.post.id;
      this.viewList[n] = v;
      n++;
    }
    this.viewList.length = n;
    return this.viewList;
  }

  /**
   * Force port fellows: the on-foot officers. `misconductChance` is 1 when this arrival rolled the excessiveForce
   * mistake, else 0 (the deterministic roll decides; the force module only needs a restrained, previously violent
   * subject nearby). A reused array.
   */
  fellows(): readonly FellowOfficer[] {
    let n = 0;
    for (const o of this.list) {
      const s = o.fsm.state;
      if (s === 'gone' || s === 'returning' || s === 'exiting') continue;
      let f = this.fellowPool[n];
      if (f === undefined) {
        f = { name: '', x: 0, z: 0, building: -1, callsign: '', misconductChance: 0 };
        this.fellowPool.push(f);
      }
      f.name = o.name;
      f.x = o.x;
      f.z = o.z;
      f.building = o.building;
      f.callsign = o.callsign;
      f.misconductChance = o.mistakes[2] ? 1 : 0;
      this.fellowList[n] = f;
      n++;
    }
    this.fellowList.length = n;
    return this.fellowList;
  }

  /** True while an officer of `callsign` is out of the car (the dispatcher holds the unit). */
  onFoot(callsign: string): boolean {
    const o = this.byCallsign.get(callsign);
    return o !== undefined && o.fsm.state !== 'gone';
  }

  // --- BackupPort ------------------------------------------------------------------------------------------

  staffPost(post: { id: string; x: number; z: number; yaw: number; kind: PostKind }): string | null {
    // Already staffed under this id: move it.
    for (const o of this.list) {
      if (o.post !== null && o.post.id === post.id && o.fsm.state !== 'gone' && o.fsm.state !== 'returning') {
        o.post = { id: post.id, x: post.x, z: post.z, yaw: post.yaw, kind: post.kind };
        return o.callsign;
      }
    }
    let best: Officer | null = null;
    let bestScore = Infinity;
    for (const o of this.list) {
      const s = o.fsm.state;
      if (o.post !== null || s === 'gone' || s === 'returning' || s === 'exiting' || s === 'chase' || s === 'detain' || s === 'swat') continue;
      if (o.fsm.role !== 'standby' && o.fsm.role !== 'secondary') continue;
      // Command staff (sergeants and up) stay at the command post: only patrol officers staff posts.
      if (o.rank !== 'officer') continue;
      // Standby officers first, then secondary; nearest to the post within a class.
      const score = (o.fsm.role === 'standby' ? 0 : 1e9) + dist2(o.x, o.z, post.x, post.z);
      if (score < bestScore) {
        best = o;
        bestScore = score;
      }
    }
    if (best === null) return null;
    best.post = { id: post.id, x: post.x, z: post.z, yaw: post.yaw, kind: post.kind };
    best.flags &= ~F_PINNED;
    this.revision++;
    return best.callsign;
  }

  clearPosts(kind?: PostKind): void {
    for (const o of this.list) {
      if (o.post !== null && (kind === undefined || o.post.kind === kind)) {
        o.post = null;
        this.revision++;
      }
    }
  }

  staffed(kind: PostKind): number {
    let n = 0;
    const r2 = this.cfg.post.staffedM * this.cfg.post.staffedM;
    for (const o of this.list) {
      if (o.post !== null && o.post.kind === kind && o.fsm.state === 'post' && dist2(o.x, o.z, o.post.x, o.post.z) <= r2) n++;
    }
    return n;
  }

  swat(callId: number, command: SwatCommand, plan?: Partial<SwatPlan>): string {
    if (this.team === null || this.team.callId !== callId) {
      const phase = this.swatPhase(callId);
      if (phase === null) return 'No SWAT team on this call.';
      // On scene of a call with no building to enter: the standoff is resolved from the street by the scene's timer.
      return phase === 'arrived' ? 'No building to enter here.' : 'The SWAT team has not arrived yet.';
    }
    this.request(plan === undefined ? { kind: 'swat', callId, command } : { kind: 'swat', callId, command, plan });
    return `${command[0]?.toUpperCase() ?? ''}${command.slice(1)} acknowledged.`;
  }

  swatPhase(callId: number): string | null {
    if (this.team !== null && this.team.callId === callId) return this.team.phase;
    const call = this.deps.cad.call(callId);
    if (call === null) return null;
    let phase: string | null = null;
    for (const cs of call.units) {
      if (!SWAT_CALLSIGNS.includes(cs)) continue;
      phase = 'enRoute';
      if (this.deps.cad.unit(cs)?.status === 'onScene' && this.deps.callBuilding(callId) < 0) return 'arrived';
    }
    return phase;
  }

  // --- Step ------------------------------------------------------------------------------------------------

  /** Advances the officers and the SWAT team by `dt` seconds (fixed step, order -665). */
  step(dt: number, t: CadTime, ctx: BackupContext): void {
    this.syncTeam(ctx);
    if (this.requests.length > 0) this.applyRequests();
    this.refreshContact(t, ctx);
    this.spawn(t, ctx);
    for (let i = 0; i < this.list.length; i++) {
      const o = this.list[i] as Officer;
      if (o.fsm.state !== 'gone') this.updateOfficer(o, dt, t, ctx);
    }
    this.stressStep(dt);
    if (this.team !== null) {
      this.team.step(dt);
      this.team.writeView(this.view, this.cfg.spawn.maxOfficers);
    }
    this.flushCallouts(t);
    this.drainEvents();
    this.purge(ctx);
    this.finishView();
  }

  // --- Requests --------------------------------------------------------------------------------------------

  private applyRequests(): void {
    const reqs = this.requests;
    this.requests = [];
    for (const r of reqs) {
      switch (r.kind) {
        case 'command':
          this.applyCommand(r);
          break;
        case 'post':
          this.staffPost({ id: r.id, x: r.x, z: r.z, yaw: r.yaw, kind: r.postKind });
          break;
        case 'clearPosts':
          this.clearPosts(r.postKind);
          break;
        case 'swat':
          if (this.team === null || this.team.callId !== r.callId) {
            this.deps.bus.emit('backup:swat', { phase: 'enRoute', text: 'No SWAT team on scene.', callId: r.callId });
          } else {
            this.team.command(r.command, r.plan);
          }
          break;
      }
    }
  }

  private applyCommand(r: Extract<BackupRequest, { kind: 'command' }>): void {
    for (const o of this.list) {
      if (o.fsm.state === 'gone' || o.fsm.state === 'returning') continue;
      if (r.callsign !== 'all' && r.callsign !== o.callsign) continue;
      const targeted = r.targetPersonId !== undefined && r.targetPersonId >= 0 && (r.command === 'cover' || r.command === 'secondary' || r.command === 'detain');
      if (targeted) {
        const id = this.actorOfPerson(o.callId, r.targetPersonId);
        if (id !== 0) {
          o.targetActor = id;
          o.flags |= F_PINNED;
        }
      } else if (r.command !== 'detain') {
        o.flags &= ~F_PINNED;
        if (r.command !== 'secondary' || o.fsm.role !== 'secondary') o.targetActor = 0;
      } else if (o.targetActor === 0) {
        o.targetActor = this.nearestDetainable(o);
      }
      if (o.fsm.state === 'exiting') {
        // The FSM ignores commands while getting out: set the role directly.
        if (r.command === 'release') this.toReturning(o);
        else if (r.command !== 'detain') o.fsm.role = r.command === 'cover' || r.command === 'secondary' ? r.command : 'standby';
        continue;
      }
      o.cmd = r.command;
    }
  }

  /** Nearest uncuffed subject of the officer's call within 30 m, 0 none. */
  private nearestDetainable(o: Officer): number {
    const { npc } = this.deps;
    const ids = npc.actorsOfCall(o.callId, this.ids);
    let best = 0;
    let bestD = 30 * 30;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k] as number;
      const a = npc.actor(id, this.info);
      if (a === null || a.cuffed || a.hidden || a.body !== 0 || a.dead === true || !SUBJECT_ROLES.includes(a.role)) continue;
      const d = dist2(a.x, a.z, o.x, o.z);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  private actorOfPerson(callId: number, personId: number): number {
    const ids = this.deps.npc.actorsOfCall(callId, this.ids);
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k] as number;
      const a = this.deps.npc.actor(id, this.info);
      if (a !== null && a.personId === personId) return id;
    }
    return 0;
  }

  private toReturning(o: Officer): void {
    o.fsm.state = 'returning';
    o.post = null;
    o.flags &= ~F_PINNED;
    this.revision++;
  }

  // --- Contact actor ---------------------------------------------------------------------------------------

  /** Caches the actor id of the player's contact person (rescanned at most every 0.25 s). */
  private refreshContact(t: CadTime, ctx: BackupContext): void {
    if (ctx.contactPersonId < 0 || ctx.callId === 0) {
      this.contactActor = 0;
      return;
    }
    if (this.contactActor !== 0) {
      const a = this.deps.npc.actor(this.contactActor, this.info);
      if (a !== null && a.personId === ctx.contactPersonId) return;
      this.contactActor = 0;
    }
    if (t.sim < this.contactScanT) return;
    this.contactScanT = t.sim + CONTACT_SCAN_S;
    this.contactActor = this.actorOfPerson(ctx.callId, ctx.contactPersonId);
  }

  // --- Spawn -----------------------------------------------------------------------------------------------

  private activeCount(): number {
    let n = 0;
    for (let i = 0; i < this.list.length; i++) if ((this.list[i] as Officer).fsm.state !== 'gone') n++;
    return n;
  }

  private hasRole(callId: number, role: BackupRole): boolean {
    for (let i = 0; i < this.list.length; i++) {
      const o = this.list[i] as Officer;
      if (o.callId === callId && o.fsm.state !== 'gone' && o.fsm.state !== 'returning' && o.fsm.role === role) return true;
    }
    return false;
  }

  private spawn(t: CadTime, ctx: BackupContext): void {
    if (ctx.callId === 0) return;
    const units = this.deps.cad.units();
    for (let i = 0; i < units.length; i++) {
      const u = units[i] as CadUnit;
      if (u.status !== 'onScene' || u.callId !== ctx.callId) continue;
      if (u.kind === 'player' || this.byCallsign.has(u.callsign)) continue;
      if (u.kind === 'resource') {
        const type = SLOT_TYPE.get(u.callsign);
        if (type === undefined || !FOOT_TYPES.includes(type)) continue;
      }
      if (this.activeCount() >= this.cfg.spawn.maxOfficers) return;
      const pose = this.pose;
      if (!this.deps.unitCar(u.callsign, pose)) continue;
      const max = this.cfg.spawn.maxCarDistanceM;
      if (dist2(pose.x, pose.z, ctx.x, ctx.z) > max * max) continue;
      // A driving player who is already away does not get new officers running after the car.
      if (!ctx.onFoot && dist2(pose.x, pose.z, ctx.x, ctx.z) > DRIVE_OFF_RANGE_M * DRIVE_OFF_RANGE_M) continue;
      this.createOfficer(u, pose, t, ctx);
    }
  }

  private freeSlot(): number {
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i] === null) return i;
    return -1;
  }

  private createOfficer(u: CadUnit, car: { x: number; z: number; yaw: number }, t: CadTime, ctx: BackupContext): void {
    const slot = this.freeSlot();
    if (slot < 0) return;
    const { roster, seed } = this.deps;
    const rank = rankOf(u.callsign);
    const profile = roster.ensure(u.callsign, rank);
    const dyn = roster.dynamic(u.callsign);
    const seq = roster.nextArrival(u.callsign);
    const chances = mistakeChances(profile.traits, dyn ?? { stress: 0, fatigue: 0, loyalty: 0.5, calls: 0, mistakes: 0, arrivals: 0 });
    const rolls = rollMistakes(seed, u.callsign, seq, chances);
    const k = !this.hasRole(ctx.callId, 'cover') ? 0 : !this.hasRole(ctx.callId, 'secondary') ? 1 : 2;
    const role: BackupRole = rank === 'officer' ? initialRole(k) : 'standby';
    // Driver door: 1.2 m to the left of the heading (right = (cos yaw, -sin yaw)).
    const o = this.makeOfficer(u.callsign, profile.name, rank, ctx.callId, {
      state: 'exiting', role, timer: 0,
    }, car.x - Math.cos(car.yaw) * DOOR_OFFSET_M, car.z + Math.sin(car.yaw) * DOOR_OFFSET_M, car.yaw);
    o.seq = seq;
    o.mistakes = [rolls.lateCallout, rolls.poorPosition, rolls.excessiveForce];
    o.nextScan = t.sim + SCAN_S;
    this.attach(o, slot);
    this.deps.bus.emit('backup:flash', { text: `${profile.name} is out of the car` });
    this.revision++;
  }

  private makeOfficer(callsign: string, name: string, rank: Rank, callId: number, fsm: OfficerFsm, x: number, z: number, yaw: number): Officer {
    const h = hashString(callsign);
    return {
      callsign, name, rank, callId, fsm, x, z, yaw, building: -1, seq: 0, mistakes: [false, false, false], targetActor: 0, post: null,
      sideSign: h % 2 === 0 ? 1 : -1, nextScan: 0, calledOut: [], flags: 0,
      slot: -1, goalX: x, goalZ: z, goalYaw: yaw, goalT: 0, cmd: null, cmdT: 0, cmdIdx: 0, cuffT: 0, detainT: 0, farT: 0, threat: false,
      speed: 0, gait: 0, prevX: x, prevZ: z, prevYaw: yaw,
      coverAngle: lerp(this.cfg.cover.angleDeg, hashFrac(callsign, ':angle')) * DEG,
      coverDist: lerp(this.cfg.cover.distanceM, hashFrac(callsign, ':dist')),
      hasCover: false, cvSx: 0, cvSz: 0, cvPx: 0, cvPz: 0, atCar: false, carX: NaN, carZ: NaN,
    };
  }

  private attach(o: Officer, slot: number): void {
    o.slot = slot;
    this.slots[slot] = o;
    this.list.push(o);
    this.byCallsign.set(o.callsign, o);
    this.writeOfficerView(o);
  }

  // --- Per-officer update ----------------------------------------------------------------------------------

  private updateOfficer(o: Officer, dt: number, t: CadTime, ctx: BackupContext): void {
    const { cad } = this.deps;
    o.prevX = o.x;
    o.prevZ = o.z;
    o.prevYaw = o.yaw;
    const u = cad.unit(o.callsign);
    const present = ctx.callId === o.callId && u !== null && u.callId === o.callId && u.status === 'onScene';
    const drovePast = !ctx.onFoot && dist2(o.x, o.z, ctx.x, ctx.z) > DRIVE_OFF_RANGE_M * DRIVE_OFF_RANGE_M;
    const onCall = present && !drovePast && !(this.deps.releasing?.(o.callsign) ?? false);
    if (!present) o.flags |= F_LEFT;
    else if (onCall && o.fsm.state === 'returning' && (o.flags & F_LEFT) !== 0) {
      // The unit came back to the call: a fresh arrival, the officer goes back to its role.
      o.flags &= ~F_LEFT;
      o.fsm.state = 'approach';
      this.onTransition(o, 'returning');
    }
    const inp = this.fsmIn;
    inp.dt = dt;
    inp.onCall = onCall;
    inp.runner = false;
    inp.caught = false;
    inp.lost = false;
    inp.detained = false;
    inp.gaveUp = false;
    inp.atCar = false;
    inp.post = o.post !== null;
    inp.command = o.cmd;
    o.cmd = null;
    o.atCar = false;

    // Behaviour of the current state: sets the goal and the FSM inputs.
    const state = o.fsm.state;
    switch (state) {
      case 'exiting':
        o.goalX = o.x;
        o.goalZ = o.z;
        break;
      case 'returning':
        this.goalCar(o, dt);
        inp.atCar = o.atCar;
        break;
      case 'chase':
        this.stepChase(o, ctx, inp);
        break;
      case 'detain':
        this.stepDetain(o, dt, inp);
        break;
      default:
        this.goalForRole(o, dt, ctx, inp);
        break;
    }
    inp.goalDistance = Math.sqrt(dist2(o.x, o.z, o.goalX, o.goalZ));

    const out = stepOfficerFsm(o.fsm, inp, this.cfg, this.fsmOut);
    if (out.changed) this.onTransition(o, state);
    if (out.callout !== null) this.fsmCallout(o, out.callout, t);

    this.move(o, dt);
    this.writeOfficerView(o);
    this.farCheck(o, dt, ctx);
    if (t.sim >= o.nextScan) {
      o.nextScan = t.sim + SCAN_S;
      this.observe(o, t, ctx);
    }
  }

  private onTransition(o: Officer, prev: BackupState): void {
    this.revision++;
    const s = o.fsm.state;
    if (s === 'approach') o.goalT = 0;
    if (s === 'returning') {
      o.post = null;
      o.flags &= ~F_PINNED;
    }
    if (s === 'secondary') o.cmdT = 0;
    if (s === 'detain') {
      o.detainT = 0;
      o.cuffT = 0;
    }
    if (s === 'cover' && prev === 'approach' && o.mistakes[1] && (o.flags & F_POOR_SHOWN) === 0) {
      o.flags |= F_POOR_SHOWN;
      this.showMistake(o, 'poorPosition');
    }
    if (s === 'gone') {
      if (o.slot >= 0) {
        this.slots[o.slot] = null;
        this.view.flags[o.slot] = FIGURE_FLAG.hidden;
        o.slot = -1;
      }
    }
  }

  private showMistake(o: Officer, kind: 'lateCallout' | 'poorPosition' | 'excessiveForce'): void {
    this.deps.roster.noteMistake(o.callsign);
    this.deps.bus.emit('backup:mistake', { callsign: o.callsign, kind, callId: o.callId });
  }

  // --- Goals -----------------------------------------------------------------------------------------------

  private goalCar(o: Officer, dt: number): void {
    const p = this.pose;
    if (!this.deps.unitCar(o.callsign, p)) {
      o.atCar = true;
      return;
    }
    // Safety net: a car that drives off leaves the officer behind rather than letting it run after the car.
    const moved = Math.sqrt(dist2(p.x, p.z, o.carX, o.carZ));
    o.carX = p.x;
    o.carZ = p.z;
    if (moved > CAR_LEAVING_MPS * dt && dist2(o.x, o.z, p.x, p.z) > 4 * 4) {
      o.atCar = true;
      return;
    }
    o.goalX = p.x - Math.cos(p.yaw) * DOOR_OFFSET_M;
    o.goalZ = p.z + Math.sin(p.yaw) * DOOR_OFFSET_M;
    o.goalYaw = p.yaw;
    o.atCar = dist2(o.x, o.z, o.goalX, o.goalZ) <= 1.5 * 1.5;
  }

  private goalForRole(o: Officer, dt: number, ctx: BackupContext, inp: FsmInputs): void {
    switch (o.fsm.role) {
      case 'cover':
        this.goalCover(o, dt, ctx);
        break;
      case 'secondary':
        this.goalSecondary(o, dt, ctx, inp);
        break;
      case 'post':
        if (o.post !== null) {
          o.goalX = o.post.x;
          o.goalZ = o.post.z;
          o.goalYaw = o.post.yaw;
        }
        break;
      default:
        this.goalStandby(o, ctx);
        break;
    }
  }

  private goalStandby(o: Officer, ctx: BackupContext): void {
    const lateral = 1 + 1.2 * (hashString(o.callsign) % 3);
    const bx = Math.sin(ctx.yaw);
    const bz = Math.cos(ctx.yaw);
    const rx = Math.cos(ctx.yaw);
    const rz = -Math.sin(ctx.yaw);
    o.goalX = ctx.x + bx * STANDBY_BEHIND_M + rx * lateral;
    o.goalZ = ctx.z + bz * STANDBY_BEHIND_M + rz * lateral;
    o.goalYaw = ctx.yaw;
    o.hasCover = false;
  }

  /** The target actor of a cover officer: pinned, the contact person's actor, else the nearest uncuffed actor of the call. */
  private pickCoverTarget(o: Officer, ctx: BackupContext): number {
    const { npc } = this.deps;
    if ((o.flags & F_PINNED) !== 0 && o.targetActor !== 0 && npc.actor(o.targetActor, this.info) !== null) return o.targetActor;
    if (this.contactActor !== 0) return this.contactActor;
    // The contact is not an actor (a driver in a stopped car): cover against the given point.
    if (ctx.subject != null && ctx.contactPersonId >= 0) return 0;
    const ids = npc.actorsOfCall(o.callId, this.ids);
    let best = 0;
    let bestD = COVER_TARGET_RANGE_M * COVER_TARGET_RANGE_M;
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k] as number;
      const a = npc.actor(id, this.info);
      if (a === null || a.cuffed || a.hidden || a.body !== 0 || a.dead === true) continue;
      const d = dist2(a.x, a.z, ctx.x, ctx.z);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  }

  private goalCover(o: Officer, dt: number, ctx: BackupContext): void {
    o.goalT -= dt;
    if (o.goalT > 0) return;
    o.goalT = this.cfg.cover.repositionS;
    o.targetActor = this.pickCoverTarget(o, ctx);
    const a = o.targetActor !== 0 ? this.deps.npc.actor(o.targetActor, this.info) : null;
    const sx = a !== null ? a.x : ctx.subject != null ? ctx.subject.x : NaN;
    const sz = a !== null ? a.z : ctx.subject != null ? ctx.subject.z : NaN;
    if (Number.isNaN(sx)) {
      this.goalStandby(o, ctx);
      return;
    }
    if (o.mistakes[1]) poorCoverSpot(ctx.x, ctx.z, sx, sz, this.cfg, this.spot);
    else coverSpot(ctx.x, ctx.z, sx, sz, o.coverAngle, o.coverDist, o.sideSign, this.spot);
    o.goalX = this.spot.x;
    o.goalZ = this.spot.z;
    o.goalYaw = this.spot.yaw;
    o.hasCover = true;
    o.cvPx = ctx.x;
    o.cvPz = ctx.z;
    o.cvSx = sx;
    o.cvSz = sz;
  }

  private goalSecondary(o: Officer, dt: number, ctx: BackupContext, inp: FsmInputs): void {
    const { npc } = this.deps;
    const a = o.targetActor !== 0 ? npc.actor(o.targetActor, this.info) : null;
    if (a === null || a.cuffed) {
      o.targetActor = 0;
      this.goalStandby(o, ctx);
      return;
    }
    // Standoff from the subject, on the player's side.
    const dx = ctx.x - a.x;
    const dz = ctx.z - a.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    const k = len > 1e-3 ? this.cfg.secondary.standoffM / len : 0;
    o.goalX = a.x + dx * k;
    o.goalZ = a.z + dz * k;
    o.goalYaw = yawToward(o.goalX, o.goalZ, a.x, a.z);
    o.hasCover = false;
    if (a.state === ACTOR_STATE.flee) {
      inp.runner = true;
      return;
    }
    const compliant = COMPLIANT.has(a.state);
    if (o.fsm.state === 'secondary') {
      if (compliant) {
        // detainT counts the pause after a failed detain down outside the detain state.
        if (o.detainT > 0) o.detainT -= dt;
        else if (inp.command === null) inp.command = 'detain';
        return;
      }
      o.cmdT -= dt;
      if (o.cmdT <= 0) {
        o.cmdT = this.cfg.secondary.commandEveryS;
        this.issueCommand(o);
      }
    }
  }

  /** Alternates `showHands` and `stop` on the target. */
  private issueCommand(o: Officer): void {
    const { npc } = this.deps;
    const cmd: NpcCommand = o.cmdIdx % 2 === 0 ? 'showHands' : 'stop';
    o.cmdIdx++;
    let count = 0;
    for (let i = 0; i < this.list.length; i++) if ((this.list[i] as Officer).fsm.state !== 'gone') count++;
    this.cmdCtx.backup = count;
    const outcome = npc.evaluateCommand(o.targetActor, cmd, this.cmdCtx);
    npc.applyCommand(o.targetActor, cmd, outcome);
  }

  private stepChase(o: Officer, ctx: BackupContext, inp: FsmInputs): void {
    const { npc } = this.deps;
    const a = o.targetActor !== 0 ? npc.actor(o.targetActor, this.info) : null;
    if (a === null || a.state !== ACTOR_STATE.flee || dist2(o.x, o.z, ctx.x, ctx.z) > this.cfg.chase.giveUpM * this.cfg.chase.giveUpM) {
      inp.lost = true;
      return;
    }
    o.goalX = a.x;
    o.goalZ = a.z;
    o.goalYaw = yawToward(o.x, o.z, a.x, a.z);
    const r = this.cfg.chase.tackleRangeM;
    if (dist2(o.x, o.z, a.x, a.z) <= r * r) {
      o.yaw = o.goalYaw;
      const id = npc.tackle(o.x, o.z, o.yaw, -1);
      if (id !== 0) {
        o.targetActor = id;
        inp.caught = true;
      }
    }
  }

  private stepDetain(o: Officer, dt: number, inp: FsmInputs): void {
    const { npc, bus } = this.deps;
    const a = o.targetActor !== 0 ? npc.actor(o.targetActor, this.info) : null;
    o.detainT += dt;
    if (a !== null && a.cuffed) {
      inp.detained = true;
      return;
    }
    if (a === null || o.detainT > DETAIN_GIVE_UP_S) {
      // Nothing was cuffed: back to the role without the custody callout, and no new attempt for a while.
      inp.gaveUp = true;
      o.detainT = DETAIN_PAUSE_S;
      return;
    }
    // Stop short of the subject.
    const dx = o.x - a.x;
    const dz = o.z - a.z;
    const len = Math.sqrt(dx * dx + dz * dz);
    const k = len > 1e-3 ? 0.9 / len : 0;
    o.goalX = a.x + dx * k;
    o.goalZ = a.z + dz * k;
    o.goalYaw = yawToward(o.x, o.z, a.x, a.z);
    if (len > CUFF_RANGE_M) return;
    o.cuffT -= dt;
    if (!COMPLIANT.has(a.state)) {
      // Not yet down: keep giving commands.
      if (o.cuffT <= 0) {
        o.cuffT = this.cfg.secondary.commandEveryS;
        this.issueCommand(o);
      }
      return;
    }
    if (o.cuffT > 0) return;
    o.cuffT = CUFF_RETRY_S;
    const personId = a.personId;
    const id = o.targetActor;
    if (npc.cuff(id) === 'ok') {
      inp.detained = true;
      bus.emit('backup:custody', { callId: o.callId, personId, actorId: id, by: o.callsign });
      bus.emit('backup:flash', { text: `${o.name} has a subject in custody` });
    }
  }

  // --- Movement and view -----------------------------------------------------------------------------------

  private move(o: Officer, dt: number): void {
    o.speed = 0;
    const s = o.fsm.state;
    if (s === 'exiting' || s === 'gone') return;
    const dx = o.goalX - o.x;
    const dz = o.goalZ - o.z;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d <= this.cfg.move.arriveM * 0.5) {
      if (s !== 'chase' && s !== 'detain' && s !== 'returning') o.yaw = o.goalYaw;
      return;
    }
    let speed = d > RUN_OVER_M ? this.cfg.move.run : this.cfg.move.walk;
    if (s === 'chase') speed = this.cfg.move.chase;
    else if (s === 'returning') speed = this.cfg.move.run;
    const step = Math.min(d, speed * dt);
    o.x += (dx / d) * step;
    o.z += (dz / d) * step;
    o.yaw = Math.atan2(-dx, -dz);
    o.speed = dt > 0 ? step / dt : 0;
    o.gait = (o.gait + step / STRIDE) % 64;
    if (d - step <= this.cfg.move.arriveM * 0.5 && s !== 'chase' && s !== 'detain' && s !== 'returning') o.yaw = o.goalYaw;
  }

  /** The officer's outfit from `deps.appearanceOf` (sergeants wear the supervisor uniform), cached per callsign. */
  private lookOf(o: Officer): BackupAppearance | null {
    const cached = this.looks.get(o.callsign);
    if (cached !== undefined) return cached;
    const look = this.deps.appearanceOf?.(o.callsign, o.rank === 'sergeant' ? 'supervisor' : 'patrol') ?? null;
    this.looks.set(o.callsign, look);
    return look;
  }

  private writeOfficerView(o: Officer): void {
    const slot = o.slot;
    if (slot < 0) return;
    const v = this.view;
    const profile = this.deps.roster.profile(o.callsign);
    v.prevX[slot] = o.prevX;
    v.prevZ[slot] = o.prevZ;
    v.prevY[slot] = 0;
    v.prevYaw[slot] = o.prevYaw;
    v.x[slot] = o.x;
    v.z[slot] = o.z;
    v.y[slot] = 0;
    v.yaw[slot] = o.yaw;
    v.speed[slot] = o.speed;
    v.gait[slot] = o.gait;
    const s = o.fsm.state;
    let pose: number = POSE.stand;
    let held: number = HELD.none;
    if (o.speed > 0.05) pose = o.speed > 3 ? POSE.run : POSE.walk;
    else if (o.threat && (s === 'cover' || s === 'secondary')) pose = POSE.aim;
    if (o.threat && (s === 'cover' || s === 'secondary' || s === 'approach' || s === 'chase')) held = HELD.sidearm;
    v.pose[slot] = pose;
    v.held[slot] = held;
    v.skin[slot] = profile?.skin ?? 0xc68e6b;
    v.hair[slot] = profile?.hair ?? 0x2a1d14;
    const look = this.lookOf(o);
    v.outfit[slot] = look?.outfit ?? 0;
    v.top[slot] = look?.top ?? TACTICS.partner.colors.top;
    v.bottom[slot] = look?.bottom ?? TACTICS.partner.colors.bottom;
    v.height[slot] = profile?.height ?? 1.76;
    v.build[slot] = 1;
    v.anchor[slot] = 0;
    v.body[slot] = 0;
    v.flags[slot] = 0;
  }

  private farCheck(o: Officer, dt: number, ctx: BackupContext): void {
    const s = o.fsm.state;
    if (s === 'exiting' || s === 'returning') return;
    if (dist2(o.x, o.z, ctx.x, ctx.z) > ABANDON_RANGE_M * ABANDON_RANGE_M) {
      o.farT += dt;
      if (o.farT > ABANDON_S && (o.flags & F_ABANDONED) === 0) {
        o.flags |= F_ABANDONED;
        this.deps.roster.applyEvent(o.callsign, 'abandoned');
      }
    } else {
      o.farT = 0;
    }
  }

  // --- Observations and callouts ---------------------------------------------------------------------------

  private memoryIndex(o: Officer, actorId: number, kind: string): number {
    for (let i = 0; i < o.calledOut.length; i++) {
      const e = o.calledOut[i] as [number, string, number];
      if (e[0] === actorId && e[1] === kind) return i;
    }
    return -1;
  }

  /** Records (actorId, kind) at `sim`; true when it is new or its cooldown passed (`once`: only when new). */
  private remember(o: Officer, actorId: number, kind: string, sim: number, cooldown: number): boolean {
    const i = this.memoryIndex(o, actorId, kind);
    if (i >= 0) {
      const e = o.calledOut[i] as [number, string, number];
      if (cooldown < 0 || sim - e[2] < cooldown) return false;
      e[2] = sim;
      return true;
    }
    if (o.calledOut.length >= MAX_MEMORY) o.calledOut.shift();
    o.calledOut.push([actorId, kind, sim]);
    return true;
  }

  /** True when any officer already called `kind` out for `actorId` (one report per second subject). */
  private calledByAnyone(actorId: number, kind: string): boolean {
    for (let i = 0; i < this.list.length; i++) if (this.memoryIndex(this.list[i] as Officer, actorId, kind) >= 0) return true;
    return false;
  }

  private observe(o: Officer, t: CadTime, ctx: BackupContext): void {
    const s = o.fsm.state;
    if (s === 'exiting' || s === 'returning' || s === 'gone' || s === 'swat') return;
    const { npc, roster } = this.deps;
    const cfg = this.cfg;
    const ids = npc.actorsOfCall(o.callId, this.ids);
    const weaponR2 = cfg.callout.weaponRangeM * cfg.callout.weaponRangeM;
    const detectR2 = cfg.secondary.detectRangeM * cfg.secondary.detectRangeM;
    const fightR2 = FIGHT_RANGE_M * FIGHT_RANGE_M;
    let threat = false;
    let fightNear = false;
    let runner = 0;
    let secondary = 0;
    let secondaryD = detectR2;
    const coverTarget = this.coverTargetOf(o);
    for (let k = 0; k < ids.length; k++) {
      const id = ids[k] as number;
      const a = npc.actor(id, this.info);
      if (a === null || a.body !== 0 || a.dead === true || a.hidden) continue;
      const d2 = dist2(a.x, a.z, o.x, o.z);
      const isTarget = id === o.targetActor && (o.fsm.role === 'cover' || o.fsm.role === 'secondary');
      if (a.weaponDrawn && d2 <= weaponR2) {
        if (isTarget) threat = true;
        if (this.remember(o, id, 'stress:weapon', t.sim, -1)) roster.applyEvent(o.callsign, 'weaponSeen');
        if (this.remember(o, id, 'weapon', t.sim, cfg.callout.cooldownS)) this.queueCallout(o, 'weapon', a, t);
      }
      if (a.state === ACTOR_STATE.fight && d2 <= fightR2) {
        fightNear = true;
        if (isTarget) threat = true;
        if (this.remember(o, id, 'stress:fight', t.sim, -1)) roster.applyEvent(o.callsign, 'fight');
        if (this.remember(o, id, 'fight', t.sim, cfg.callout.cooldownS)) this.queueCallout(o, 'fight', a, t);
      }
      if (isTarget && (a.state === ACTOR_STATE.armed)) threat = true;
      const subject = SUBJECT_ROLES.includes(a.role);
      if (subject && !a.cuffed && id !== this.contactActor && !this.isCoverTarget(id)) {
        if (d2 <= detectR2 && !this.calledByAnyone(id, 'secondSubject') && this.remember(o, id, 'secondSubject', t.sim, -1)) {
          this.queueCallout(o, 'secondSubject', a, t);
        }
        if (a.state === ACTOR_STATE.flee && d2 <= 4 * detectR2) runner = id;
        else if (d2 < secondaryD) {
          secondaryD = d2;
          secondary = id;
        }
      }
      if (subject && a.state === ACTOR_STATE.flee && id === this.contactActor && d2 <= 4 * detectR2) runner = id;
      if (id === coverTarget && (a.state === ACTOR_STATE.handsUp || a.cuffed) && this.remember(o, id, 'handsClear', t.sim, -1)) {
        this.queueCallout(o, 'handsClear', a, t);
      }
    }
    o.threat = threat;
    if (o.fsm.role === 'secondary' && (o.flags & F_PINNED) === 0 && (s === 'secondary' || s === 'approach')) {
      if (runner !== 0) o.targetActor = runner;
      else if (o.targetActor === 0) o.targetActor = secondary;
    }
    if (fightNear && (o.flags & F_COVERED) === 0 && dist2(ctx.x, ctx.z, o.x, o.z) <= COVERED_RANGE_M * COVERED_RANGE_M) {
      o.flags |= F_COVERED;
      roster.applyEvent(o.callsign, 'coveredByPlayer');
    }
  }

  /** Actor the cover officer of this call is watching (0 none). */
  private coverTargetOf(o: Officer): number {
    if (o.fsm.role === 'cover') return o.targetActor;
    for (let i = 0; i < this.list.length; i++) {
      const x = this.list[i] as Officer;
      if (x.callId === o.callId && x.fsm.role === 'cover' && x.fsm.state !== 'gone') return x.targetActor;
    }
    return this.contactActor;
  }

  private isCoverTarget(id: number): boolean {
    for (let i = 0; i < this.list.length; i++) {
      const x = this.list[i] as Officer;
      if (x.fsm.role === 'cover' && x.fsm.state !== 'gone' && x.targetActor === id) return true;
    }
    return false;
  }

  private fsmCallout(o: Officer, kind: 'covering' | 'runner' | 'inCustody', t: CadTime): void {
    if (kind === 'covering') {
      if ((o.flags & F_COVERING) !== 0) return;
      o.flags |= F_COVERING;
      this.queueCallout(o, 'covering', null, t);
      return;
    }
    const a = o.targetActor !== 0 ? this.deps.npc.actor(o.targetActor, this.info2) : null;
    if (kind === 'runner') {
      if (a !== null && !this.remember(o, o.targetActor, 'runner', t.sim, this.cfg.callout.cooldownS)) return;
      this.queueCallout(o, 'runner', a, t);
    } else {
      this.queueCallout(o, 'inCustody', a, t);
    }
  }

  /** Schedules a callout `delayS` (or `lateDelayS` for the first observation of a lateCallout officer) from now. */
  private queueCallout(o: Officer, kind: CalloutKind, a: ActorInfo | null, t: CadTime): void {
    const { rng } = this.deps;
    const cfg = this.cfg;
    let late = false;
    if (o.mistakes[0] && (o.flags & F_LATE_USED) === 0 && OBSERVATIONAL.includes(kind)) {
      late = true;
      o.flags |= F_LATE_USED;
    }
    const delay = lerp(late ? cfg.callout.lateDelayS : cfg.callout.delayS, rng.next());
    const text = this.callText(kind, a);
    this.pending.push({ callsign: o.callsign, kind, text, dueSim: t.sim + delay, priority: kind === 'weapon' || kind === 'runner', late });
  }

  private callText(kind: CalloutKind, a: ActorInfo | null): string {
    const { rng } = this.deps;
    let text = rng.pick(this.cfg.callouts[kind]);
    if (text.includes('{side}')) text = text.replace('{side}', rng.next() < 0.5 ? 'left' : 'right');
    if (text.includes('{weapon}')) text = text.replace('{weapon}', 'gun');
    if (text.includes('{desc}')) text = text.replace('{desc}', 'subject');
    if (text.includes('{spot}')) text = text.replace('{spot}', a === null ? 'curb' : a.vehicleId >= 0 ? 'car' : (a.building ?? -1) >= 0 ? 'house' : 'curb');
    if (text.includes('{dir}')) text = text.replace('{dir}', a === null ? 'northbound' : compass(a.yaw));
    if (text.includes('{street}')) text = text.replace('{street}', 'the street');
    return text;
  }

  private flushCallouts(t: CadTime): void {
    const q = this.pending;
    let i = 0;
    while (i < q.length) {
      const p = q[i] as Pending;
      if (t.sim < p.dueSim) {
        i++;
        continue;
      }
      q.splice(i, 1);
      const o = this.byCallsign.get(p.callsign);
      if (o === undefined) continue;
      this.deps.bus.emit('backup:callout', { callsign: p.callsign, kind: p.kind, text: p.text, late: p.late, callId: o.callId });
      this.deps.bus.emit('backup:radio', { channel: 'current', speaker: p.callsign, text: p.text, priority: p.priority });
      if (p.late && (o.flags & F_LATE_SHOWN) === 0) {
        o.flags |= F_LATE_SHOWN;
        this.showMistake(o, 'lateCallout');
      }
    }
  }

  // --- Stress ----------------------------------------------------------------------------------------------

  private stressStep(dt: number): void {
    this.stressT += dt;
    if (this.stressT < this.cfg.stress.sampleS) return;
    this.stressT = 0;
    const { npc, roster } = this.deps;
    for (let k = 0; k < this.shotQueue.length; k++) {
      const a = npc.actor(this.shotQueue[k] as number, this.info);
      if (a === null) continue;
      for (const o of this.list) {
        if (this.active(o) && dist2(a.x, a.z, o.x, o.z) <= SHOT_RANGE_M * SHOT_RANGE_M) roster.applyEvent(o.callsign, 'shotsFired');
      }
    }
    this.shotQueue.length = 0;
    for (let k = 0; k < this.forceQueue.length; k++) {
      const a = npc.actor(this.forceQueue[k] as number, this.info);
      if (a === null) continue;
      for (const o of this.list) {
        if (this.active(o) && dist2(a.x, a.z, o.x, o.z) <= FORCE_RANGE_M * FORCE_RANGE_M) roster.applyEvent(o.callsign, 'forceUsed');
      }
    }
    this.forceQueue.length = 0;
    for (let k = 0; k < this.pursuitQueue.length; k++) {
      const callId = this.pursuitQueue[k] as number;
      if (this.pursuitSeen.has(callId)) continue;
      this.pursuitSeen.add(callId);
      for (const o of this.list) if (this.active(o)) roster.applyEvent(o.callsign, 'pursuitMinute');
    }
    this.pursuitQueue.length = 0;
  }

  private active(o: Officer): boolean {
    const s = o.fsm.state;
    return s !== 'gone' && s !== 'exiting' && s !== 'returning';
  }

  /** Mistakes and roster events driven by force events seen on the bus. */
  private drainEvents(): void {
    if (this.forceOtherQueue.length > 0) {
      for (const name of this.forceOtherQueue) {
        for (const o of this.list) {
          if (o.name === name && o.mistakes[2] && (o.flags & F_FORCE_SHOWN) === 0) {
            o.flags |= F_FORCE_SHOWN;
            this.showMistake(o, 'excessiveForce');
          }
        }
      }
      this.forceOtherQueue.length = 0;
    }
    if (this.intervenedQueue.length > 0) {
      for (const name of this.intervenedQueue) {
        for (const o of this.list) if (o.name === name && o.fsm.state !== 'gone') this.deps.roster.applyEvent(o.callsign, 'intervenedOnThem');
      }
      this.intervenedQueue.length = 0;
    }
  }

  // --- SWAT ------------------------------------------------------------------------------------------------

  /** Creates the team when SWAT is on scene of the player's call, removes it when SWAT or the call is gone. */
  private syncTeam(ctx: BackupContext): void {
    const deps = this.deps;
    if (this.team !== null && (ctx.callId !== this.team.callId || deps.swatOnScene(this.team.callId) <= 0)) {
      this.team = null;
      this.hideTeam();
      this.revision++;
    }
    if (this.team === null && ctx.callId !== 0 && deps.swatOnScene(ctx.callId) > 0) {
      const building = deps.callBuilding(ctx.callId);
      if (building >= 0 && deps.building(building) !== null) {
        this.team = new SwatTeam(this.swatDeps(), ctx.callId, building, this.truckOf(ctx.callId));
        this.revision++;
      }
    }
  }

  private swatDeps(): ConstructorParameters<typeof SwatTeam>[0] {
    const d = this.deps;
    return {
      bus: d.bus,
      rng: d.rng,
      npc: d.npc,
      interiors: d.interiors,
      doorRequest: (b, door, action) => d.doorRequest(b, door, action),
      building: (id) => d.building(id),
      negotiationTrust: (callId) => d.negotiationTrust(callId),
      ...(d.appearanceOf ? { appearanceOf: (callsign: string, role: BackupAppearanceRole) => d.appearanceOf?.(callsign, role) ?? null } : {}),
      config: this.swatCfg,
    };
  }

  private truckOf(callId: number): { x: number; z: number } | null {
    for (const u of this.deps.cad.units()) {
      if (u.callId === callId && SWAT_CALLSIGNS.includes(u.callsign) && this.deps.unitCar(u.callsign, this.pose)) return { x: this.pose.x, z: this.pose.z };
    }
    return null;
  }

  private hideTeam(): void {
    SwatTeam.hideView(this.view, this.cfg.spawn.maxOfficers, this.swatCfg.operators);
  }

  // --- Cleanup and view ------------------------------------------------------------------------------------

  /** Forgets finished officers once their unit has left the call. */
  private purge(ctx: BackupContext): void {
    for (let i = this.list.length - 1; i >= 0; i--) {
      const o = this.list[i] as Officer;
      if (o.fsm.state !== 'gone') continue;
      const u = this.deps.cad.unit(o.callsign);
      // A unit still on the call keeps its returned officer, unless the unit left and came back (it gets out again).
      if (ctx.callId === o.callId && u !== null && u.callId === o.callId && u.status === 'onScene' && (o.flags & F_LEFT) === 0) continue;
      this.list.splice(i, 1);
      this.byCallsign.delete(o.callsign);
    }
  }

  private finishView(): void {
    const v = this.view;
    const max = this.cfg.spawn.maxOfficers;
    let count = 0;
    for (let i = 0; i < max; i++) if (this.slots[i] !== null) count = i + 1;
    if (this.team !== null) count = max + this.swatCfg.operators;
    v.count = count;
  }

  // --- Save ------------------------------------------------------------------------------------------------

  serialize(): BackupSave {
    return {
      version: 1,
      rng: this.deps.rng.state(),
      officers: this.list.map((o): BackupOfficerSave => ({
        callsign: o.callsign,
        callId: o.callId,
        fsm: { state: o.fsm.state, role: o.fsm.role, timer: o.fsm.timer },
        x: o.x,
        z: o.z,
        yaw: o.yaw,
        building: o.building,
        seq: o.seq,
        mistakes: [o.mistakes[0], o.mistakes[1], o.mistakes[2]],
        targetActor: o.targetActor,
        post: o.post === null ? null : { ...o.post },
        sideSign: o.sideSign,
        nextCallout: o.nextScan,
        calledOut: o.calledOut.map((e): [number, string, number] => [e[0], e[1], e[2]]),
        flags: o.flags,
        rt: {
          goal: [o.goalX, o.goalZ, o.goalYaw],
          timers: [o.goalT, o.cmdT, o.cuffT, o.detainT, o.farT],
          cmdIdx: o.cmdIdx,
          threat: o.threat,
          cover: o.hasCover ? [o.cvPx, o.cvPz, o.cvSx, o.cvSz] : null,
        },
      })),
      pendingCallouts: this.pending.map((p): PendingCalloutSave => ({
        callsign: p.callsign, kind: p.kind, text: p.text, dueSim: p.dueSim, priority: p.priority, late: p.late,
      })),
      swat: this.team === null ? null : this.team.serialize(),
      requests: this.requests.slice(),
    };
  }

  restore(s: BackupSave): void {
    this.deps.rng.restore(s.rng);
    this.list.length = 0;
    this.byCallsign.clear();
    this.slots.fill(null);
    this.pending.length = 0;
    this.requests = s.requests.slice();
    this.team = null;
    this.contactActor = 0;
    this.contactScanT = 0;
    this.stressT = 0;
    this.shotQueue.length = 0;
    this.forceQueue.length = 0;
    this.forceOtherQueue.length = 0;
    this.intervenedQueue.length = 0;
    this.pursuitQueue.length = 0;
    this.pursuitSeen.clear();
    this.otherBy.clear();
    for (let i = 0; i < this.view.flags.length; i++) this.view.flags[i] = FIGURE_FLAG.hidden;
    for (const so of s.officers) {
      const rank = rankOf(so.callsign);
      const profile = this.deps.roster.ensure(so.callsign, rank);
      const o = this.makeOfficer(so.callsign, profile.name, rank, so.callId, { state: so.fsm.state, role: so.fsm.role, timer: so.fsm.timer }, so.x, so.z, so.yaw);
      o.building = so.building;
      o.seq = so.seq;
      o.mistakes = [so.mistakes[0], so.mistakes[1], so.mistakes[2]];
      o.targetActor = so.targetActor;
      o.post = so.post === null ? null : { ...so.post };
      o.sideSign = so.sideSign;
      o.nextScan = so.nextCallout;
      o.calledOut = so.calledOut.map((e): [number, string, number] => [e[0], e[1], e[2]]);
      o.flags = so.flags;
      if (so.rt !== undefined) {
        o.goalX = so.rt.goal[0];
        o.goalZ = so.rt.goal[1];
        o.goalYaw = so.rt.goal[2];
        [o.goalT, o.cmdT, o.cuffT, o.detainT, o.farT] = so.rt.timers;
        o.cmdIdx = so.rt.cmdIdx;
        o.threat = so.rt.threat;
        if (so.rt.cover !== null) {
          o.hasCover = true;
          [o.cvPx, o.cvPz, o.cvSx, o.cvSz] = so.rt.cover;
        }
      }
      if (so.fsm.state === 'gone') {
        this.list.push(o);
        this.byCallsign.set(o.callsign, o);
        continue;
      }
      const slot = this.freeSlot();
      if (slot < 0) continue;
      this.attach(o, slot);
    }
    for (const p of s.pendingCallouts) {
      this.pending.push({ callsign: p.callsign, kind: p.kind as CalloutKind, text: p.text, dueSim: p.dueSim, priority: p.priority, late: p.late === true });
    }
    if (s.swat !== null) {
      const team = new SwatTeam(this.swatDeps(), s.swat.callId, s.swat.building, this.truckOf(s.swat.callId));
      team.restore(s.swat);
      this.team = team;
      team.writeView(this.view, this.cfg.spawn.maxOfficers);
    }
    this.finishView();
    this.revision++;
  }

  dispose(): void {
    for (const off of this.unsub) off();
    this.unsub.length = 0;
    this.list.length = 0;
    this.byCallsign.clear();
    this.slots.fill(null);
    this.pending.length = 0;
    this.requests = [];
    this.team = null;
    this.looks.clear();
    this.view.count = 0;
  }
}
