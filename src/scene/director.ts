/**
 * SceneDirector (Phase 3 design §11): turns CAD calls into live scenes. It builds the hidden truth of a
 * call (`buildScenario`), runs the CAD timeline (describe, corrections, escalation, duplicates, ambush),
 * materializes actors, scene vehicles and props around the player, sets the scene flags from contact,
 * npc and traffic events, runs scene actions and service stubs, officer tactics, pursuits, derived
 * traffic-stop and field-contact scenes, presence / HUD / panel models and the graded `CallOutcome`.
 *
 * Determinism: bus handlers only enqueue plain data (saved with the scene); every change happens in
 * `step` (fixed step, order -690) and draws only from `deps.rng` (stream 'scene') or the call's own
 * scenario stream. `Math.random`, `Date.now` and `performance.now` are never used. The idle path
 * (no open scenario, nothing queued) allocates nothing.
 */
import { addressOnEdge } from '../cad/address';
import { findCallType } from '../cad/data';
import type { CadCall, CadTime, Priority } from '../cad/types';
import '../cad/events';
import {
  actionDef,
  buildScenario,
  callTypeDef,
  CALL_CATALOG,
  familyDef,
  familyForType,
  objectivesFor,
  outcomeFor,
  serviceDef,
  CONTRABAND_ITEM_IDS,
  ITEM_IDS,
  NPC_COMMAND_IDS,
  PROFILE_IDS,
  SERVICE_KINDS,
  type ActionDef,
  type FamilyDef,
  type PersonConstraint,
  type Scenario,
  type ScenarioInput,
  type ServiceKind,
  type ToolKind,
  type VariantChange,
  type VariantKind,
} from '../calls';
import { CRISIS_PROFILES, INJURED_PROFILES, evalCond } from '../calls/conditions';
import { LOCATION_CORRECTION, topPhrase } from '../calls/scenario';
import { createRng, type Rng } from '../core/rng';
import { lawfulPresence, type ConsentRecord } from '../evidence/searchRules';
import { hourOf, isOpenAt } from '../indoors/occupants';
import { roomAt } from '../interior/nav';
import type { InteriorLayout } from '../interior/types';
import { commandLine, RESPONSES, trustOf, type DialogueContext, type SubjectProfile, type Tone } from '../dialogue';
import type { ActionPanelModel, PanelOption } from '../ui/panels/actionPanel';
import '../npc/events';
import { ACTOR_STATE, NPC_COMMANDS, NPC_CONFIG, BEHAVIORS, behavior as behaviorOf, type ActorInfo, type CommandContext, type NpcCommand } from '../npc';
import { pointInPolygon, yawOf } from '../npc/geometry';
import { describePerson, itemDef, ITEMS, riskOf, type DrugKind, type NpcIdentity } from '../people';
import { ageOn, epochDayOfGameSeconds } from '../records/calendar';
import { isItemId } from '../people/items';
import { DRUG_KINDS } from '../people/types';
import { PROP_BY_NAME, createPropSource } from '../render/people/pose';
import { hash3 } from '../records/hash';
import { PERSON_POPULATION, ownerOfVehicle } from '../records/ids';
import { PLATE_FLAG, canBeOnRoad, mountedPlate, plateFlags, vehicleDescription } from '../records/vehicle';
import '../traffic/events';
import { REGISTRY_POPULATION } from '../traffic/registry';
import { BEHAVIOR, isFleetVehicleId, type FleeState } from '../traffic/trafficSystem';
import { Transform } from '../ecs/components';
import { DISTRICT_NAMES } from '../world/ids';
import type { ContactConsentPayload, ContactEventPayload, ContactNeedsCallPayload } from './events';
import './events';
import { isQueuedEvent, type NpcEventKind, type QueuedEvent } from './queue';
import { SCENE_CONFIG, type SceneConfig } from './data';
import {
  INDOOR,
  bindingKinds,
  doorSlot,
  fallbackKinds,
  indoorFamily,
  lockRoll,
  mainDoor,
  planInterior,
  type IndoorConfig,
  type IndoorPlace,
  type IndoorPlan,
} from './indoor';
import { emptySceneSave, isSceneSave, type SceneSave, type SceneScenarioSave, type ScenePropSave, type ScenePursuitSave } from './save';
import { createSpotPosition, edgeLaterals, edgePoint, spotPosition } from './spots';
import { compass, fill, ScriptedRng } from './text';
import type {
  ActionState,
  CallOutcome,
  ContactTarget,
  IncidentInfo,
  IncidentResolver,
  InvestigationPayloads,
  InvestigationTopic,
  OfficerFocus,
  OfficerWeapon,
  Presence,
  SceneAwareEvent,
  SceneCallContext,
  SceneDeps,
  SceneDoorEvent,
  ScenePlaceItem,
  SceneHud,
  SceneRequest,
  SceneStats,
  ScenarioRuntime,
  ServiceState,
} from './types';

// --- Constants ---------------------------------------------------------------------------------------

/** Slow update rate (Hz). */
const SLOW_HZ = 4;
/** Hash salt of the incident truth lists. */
const SALT_TRUTH = 0x5343_0001;

const DEFAULT_ITEM_WHERE: Readonly<Record<string, 'pocket' | 'waistband' | 'bag' | 'hand'>> = {
  weapon: 'waistband',
  document: 'pocket',
  personal: 'pocket',
  drugs: 'pocket',
  paraphernalia: 'pocket',
  tools: 'bag',
  property: 'bag',
  evidence: 'pocket',
  alcohol: 'hand',
};

/** Person flags contact reports as `<flag>:<role>`. */
const CONTACT_PERSON_FLAGS: ReadonlySet<string> = new Set([
  'contacted', 'statement', 'identified', 'falseIdentity', 'custody', 'caged', 'warned', 'released', 'searched', 'frisked',
  'pbt', 'sfst', 'calmed', 'guardianNotified',
]);
/** Global flags contact reports as they are. */
const CONTACT_GLOBAL_FLAGS: ReadonlySet<string> = new Set(['bacOver', 'sfstFail', 'weaponFound', 'contrabandFound', 'guardianNotified', 'forceUsed']);
/** Global flags a scenario passes on to the scenarios it mirrors. */
const MIRROR_GLOBAL: ReadonlySet<string> = new Set([
  'pursuit', 'pursuitLost', 'pursuitEnded', 'vehicleStopped', 'forceUsed', 'shotsFired', 'attacked', 'bacOver', 'sfstFail',
  'weaponFound', 'contrabandFound',
]);
/** Profiles of participants EMS transports. */

const FORCE_KINDS: ReadonlySet<string> = new Set(['sidearmDrawn', 'taserDrawn', 'taser', 'sidearmFire', 'tackle', 'struggle', 'cuff']);

/** Loosely typed bus access for topics owned by the contact module (declared there, not imported here). */
interface LooseBus {
  on(topic: string, handler: (payload: never) => void): () => void;
}

function newActorInfo(): ActorInfo {
  return {
    id: 0, personId: -1, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false,
    armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
  };
}

function dist(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}

/**
 * Checks that the content tables hold every id of the design's fixed lists (§4.0): items, behaviour profiles,
 * services and NPC commands. Throws an `Error` naming the missing ids.
 */
export function verifyContentIds(): void {
  const missing: string[] = [];
  const items = new Set(ITEMS.map((i) => i.id));
  for (const id of ITEM_IDS) if (!items.has(id)) missing.push(`item "${id}" (people items.json)`);
  const profiles = new Set(BEHAVIORS.map((b) => b.id));
  for (const id of PROFILE_IDS) if (!profiles.has(id)) missing.push(`behaviour profile "${id}" (npc behaviors.json)`);
  const services = new Set(CALL_CATALOG.services.map((s) => s.id));
  for (const id of SERVICE_KINDS) if (!services.has(id)) missing.push(`service "${id}" (calls services.json)`);
  const commands: ReadonlySet<string> = new Set(NPC_COMMANDS);
  for (const id of NPC_COMMAND_IDS) if (!commands.has(id)) missing.push(`npc command "${id}"`);
  if (missing.length > 0) throw new Error(`Scene content cross-check failed, missing: ${missing.join(', ')}`);
}

/** A mutable `Presence` the director updates in place. */
interface MutablePresence {
  lights: boolean;
  siren: boolean;
  backup: number;
  weapon: OfficerWeapon;
}

/** Truth of a stopped car's driver (design §11.1 step 7). */
interface StopTruth {
  driver: number;
  stolen: boolean;
  wanted: boolean;
  dui: boolean;
  contraband: boolean;
  suspended: boolean;
  bac: number;
}

/** Roles that live where the call is when they wait at the door or inside (the others are guards, suspects of shops, callers). */
const RESIDENT_ROLES: ReadonlySet<string> = new Set(['subject', 'suspect', 'victim', 'resident', 'owner', 'reporter', 'hostage', 'deceased']);

/** Profiles that never walk to the door when somebody knocks (suspects, the barricaded, the dead and the unconscious). */
const NO_ANSWER_PROFILE = /^(suspect|ambusher|barricaded|subjectDeceased|subjectUnconscious)/;
/** Flags that make a call exigent (Phase 4 design §12.2); `injury:*` and `deceased:*` match by prefix. */
const EXIGENT_FLAGS: ReadonlySet<string> = new Set(['shotsFired', 'attacked', 'fight', 'medicalEmergency', 'hostage', 'branch:hostage', 'pursuit']);
const EXIGENT_FAMILIES: ReadonlySet<string> = new Set(['inProgress', 'barricade', 'activeAssailant']);
/** Roles with authority over the premises of a call (consent to enter or search). */
const AUTHORITY_ROLES: ReadonlySet<string> = new Set(['victim', 'subject', 'resident', 'owner', 'reporter', 'hostage', 'guard']);
/** Consent kinds the scene records as flags. */
const CONSENT_FLAG_KINDS: ReadonlySet<string> = new Set(['entry', 'searchPremises', 'searchRoom', 'searchPerson', 'searchVehicle']);

/** Self-initiated scene calls (field contacts, pursuits) clear themselves: idle for this long (sim s)... */
const SELF_IDLE_CLEAR_S = 600;
/** ...or with the officer this far from the scene (m) for this long (sim s)... */
const SELF_FAR_M = 150;
const SELF_FAR_CLEAR_S = 60;
/** ...or this long after a pursuit ended without a stop (sim s). */
const SELF_PURSUIT_OVER_S = 20;

export class SceneDirector implements IncidentResolver {
  private readonly deps: SceneDeps;
  private readonly cfg: SceneConfig;
  private readonly indoor: IndoorConfig;
  private readonly shoutCone: number;
  private readonly taserCone: number;
  private readonly seed: number;
  private readonly rng: Rng;
  private readonly pc: string;
  private readonly open: ScenarioRuntime[] = [];
  private readonly byCall = new Map<number, ScenarioRuntime>();
  private closedList: CallOutcome[] = [];
  private readonly ignored = new Set<number>();
  /** Last activity (sim s) and the time the officer went far away, per self-initiated call (not saved: restarts on load). */
  private readonly activity = new Map<number, number>();
  private readonly farSince = new Map<number, number>();
  private propList: ScenePropSave[] = [];
  private readonly propSource: ReturnType<typeof createPropSource>;
  private propsDirty = true;
  private pursuits: ScenePursuitSave[] = [];
  private requests: SceneRequest[] = [];
  private events: QueuedEvent[] = [];
  private readonly forced = new Map<number, readonly VariantKind[]>();
  /** Debug: call id -> building the call must bind to. */
  private readonly forcedBuilding = new Map<number, number>();
  private readonly witnesses = new Map<number, number>();
  private weapon: OfficerWeapon = 'none';
  private readonly pres: MutablePresence = { lights: false, siren: false, backup: 0, weapon: 'none' };
  private rev = 0;
  private slowTick = -1;
  private readonly officer = { x: 0, z: 0, yaw: 0, speed: 0, onFoot: true, building: -1 };
  private time: CadTime = { sim: 0, game: 0 };
  private readonly leaveScratch: number[] = [];
  private readonly unsubscribers: (() => void)[] = [];
  private statsValue: SceneStats = { scenarios: 0, materialized: 0, stepMs: 0 };
  // Pursuit HUD (numbers updated in the slow tick, the text is built in `hud()`).
  private pursuitKind: 'none' | 'vehicle' | 'foot' = 'none';
  private pursuitPlate = '';
  private pursuitDesc = '';
  private pursuitDistance = 0;
  // Scratch.
  private readonly info = newActorInfo();
  private readonly info2 = newActorInfo();
  private readonly spot = createSpotPosition();
  private readonly fleeScratch: FleeState = { x: 0, z: 0, yaw: 0, speed: 0, edge: 0 };
  private readonly actorIdsScratch: number[] = [];
  private readonly edgePt = { x: 0, z: 0, yaw: 0 };

  constructor(deps: SceneDeps) {
    verifyContentIds();
    this.deps = deps;
    this.cfg = deps.config ?? SCENE_CONFIG;
    this.indoor = deps.indoorConfig ?? INDOOR;
    this.shoutCone = Math.cos((this.cfg.tactics.shoutConeDeg * Math.PI) / 180);
    this.taserCone = Math.cos((this.cfg.tactics.taserConeDeg * Math.PI) / 180);
    this.propSource = createPropSource(this.cfg.limits.propCap);
    this.seed = deps.seed;
    this.rng = deps.rng;
    this.pc = deps.dispatcher.playerCallsign;
    deps.dispatcher.setStopOwner((callId, vehicleId) => this.ownsVehicle(callId, vehicleId));
    deps.dispatcher.setDriverResolver((vehicleId) => deps.npc.occupantsOf(vehicleId)[0] ?? -1);
    deps.dispatcher.setDispositionResolver((callId) => this.earnedDisposition(callId));
    this.subscribe();
  }

  // --- Public API ------------------------------------------------------------------------------------

  get officerWeapon(): OfficerWeapon {
    return this.weapon;
  }

  get presence(): Presence {
    return this.pres;
  }

  get props(): import('../render/people/pose').PropSource {
    return this.propSource;
  }

  /** Bumps on every visible change (flags, scenarios, props, panel state). */
  get revision(): number {
    return this.rev;
  }

  get stats(): SceneStats {
    return this.statsValue;
  }

  /** Queues a request (UI / officer keys); applied at the start of the next step. */
  request(r: SceneRequest): void {
    this.requests.push(r);
  }

  /** The live state of call `callId`'s scenario, null without one. */
  runtime(callId: number): ScenarioRuntime | null {
    return this.byCall.get(callId) ?? null;
  }

  /** Recorded outcomes of closed scenarios (newest last, at most 200). */
  outcomes(): readonly CallOutcome[] {
    return this.closedList;
  }

  /** The disposition `callId`'s scenario has earned so far (null without a scenario). */
  private earnedDisposition(callId: number): string | null {
    const rt = this.byCall.get(callId);
    const family = rt ? familyDef(rt.scenario.family) : null;
    return rt && family ? outcomeFor(family, rt.flags).disposition : null;
  }

  /** The interpreter service of the call has arrived (contact comm mode `interpreter`). */
  interpreterAvailable(callId: number): boolean {
    return this.byCall.get(callId)?.flags.has('arrived:interpreter') ?? false;
  }

  /**
   * The player's materialized call whose anchor is within 80 m of (x, z), else -1. `building` is the level of the
   * asker (-1 outdoors): inside a building other than the call's bound one the scene is not at hand.
   */
  sceneAt(x: number, z: number, building = -1): number {
    const rt = this.playerRuntime();
    if (!rt || !rt.materialized) return -1;
    if (building >= 0 && rt.buildingId >= 0 && building !== rt.buildingId) return -1;
    const a = rt.scenario.anchor;
    return dist(a.x, a.z, x, z) <= this.cfg.distances.sceneAtM ? rt.scenario.callId : -1;
  }

  /** Debug: creates a call of `typeId` through the dispatcher (optionally with forced variants) and builds its scenario now; 0 when impossible. */
  spawnCall(typeId: string, t: CadTime, at: { x: number; z: number } | undefined, variants?: VariantKind[], building = -1): number {
    const call = this.deps.dispatcher.createCall(typeId, t, at);
    if (!call) return 0;
    if (variants && variants.length > 0) this.forced.set(call.id, variants);
    if (building >= 0) this.forcedBuilding.set(call.id, building);
    this.time = t;
    this.adopt(call, t);
    return call.id;
  }

  /**
   * Builds scenarios for open calls that have none (calls of a v4 save, or created while the scene was not
   * listening). Timeline entries already due are skipped, not replayed.
   */
  adoptOpenCalls(t: CadTime): void {
    this.time = t;
    for (const call of this.deps.cad.calls()) {
      if (call.status === 'closed' || this.byCall.has(call.id) || this.ignored.has(call.id)) continue;
      const rt = this.adopt(call, t);
      if (rt) {
        const tl = rt.scenario.timeline;
        while (rt.timelineIdx < tl.length && rt.createdSim + (tl[rt.timelineIdx]?.atS ?? 0) <= t.sim) rt.timelineIdx++;
      }
    }
  }

  dispose(): void {
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    this.deps.dispatcher.setStopOwner(null);
    this.deps.dispatcher.setDriverResolver(null);
    this.deps.dispatcher.setDispositionResolver(null);
    this.events.length = 0;
    this.requests.length = 0;
  }

  // --- Bus ---------------------------------------------------------------------------------------------

  private subscribe(): void {
    const bus = this.deps.bus;
    const q = this.events;
    void q;
    const push = (e: QueuedEvent): void => {
      this.events.push(e);
    };
    const npcEvent = (kind: NpcEventKind) => (e: { actorId: number; personId: number; callId: number; item?: string; by?: string; kind?: string; x?: number; z?: number }): void => {
      push({ t: 'npc', kind, actorId: e.actorId, personId: e.personId, callId: e.callId, extra: e.item ?? e.by ?? e.kind ?? '', x: e.x ?? 0, z: e.z ?? 0 });
    };
    this.unsubscribers.push(
      bus.on('cad:callCreated', (e) => push({ t: 'created', callId: e.callId })),
      bus.on('cad:callClosed', (e) => push({ t: 'closed', callId: e.callId, disposition: e.disposition })),
      bus.on('cad:unitStatus', (e) => {
        if (e.status === 'onScene' && e.callId !== null) push({ t: 'onScene', callsign: e.callsign, callId: e.callId });
      }),
      bus.on('cad:trafficStop', (e) => push({ t: 'stop', active: e.active, callId: e.callId, vehicleId: e.vehicleId })),
      bus.on('cad:documentSaved', (e) => {
        if (e.final && (e.kind === 'citation' || e.kind === 'report')) push({ t: 'doc', id: e.id, kind: e.kind });
      }),
      bus.on('traffic:pullingOver', (e) => push({ t: 'pulling', vehicleId: e.vehicleId })),
      bus.on('traffic:fleeEnded', (e) => push({ t: 'fleeEnded', vehicleId: e.vehicleId, reason: e.reason, x: e.x, z: e.z })),
      bus.on('npc:fled', npcEvent('fled')),
      bus.on('npc:caught', npcEvent('caught')),
      bus.on('npc:escaped', npcEvent('escaped')),
      bus.on('npc:surrendered', npcEvent('surrendered')),
      bus.on('npc:attack', npcEvent('attack')),
      bus.on('npc:weaponDropped', npcEvent('weaponDropped')),
      bus.on('npc:left', npcEvent('left')),
      bus.on('npc:revealed', npcEvent('revealed')),
      bus.on('force:used', (e) => push({ t: 'force', kind: e.kind, personId: e.personId, callId: e.callId })),
    );
    const loose = bus as unknown as LooseBus;
    this.unsubscribers.push(
      loose.on('contact:event', (e: ContactEventPayload) =>
        push({ t: 'contact', callId: e.callId, incident: e.incident, personId: e.personId, role: e.role, flag: e.flag }),
      ),
      loose.on('contact:needsCall', (e: ContactNeedsCallPayload) => push({ t: 'needsCall', personId: e.personId, x: e.x, z: e.z, incident: e.incident })),
      loose.on('contact:consent', (e: ContactConsentPayload) =>
        push({ t: 'consent', callId: e.callId, personId: e.personId, kind: e.kind, granted: e.granted, valid: e.valid, buildingId: e.buildingId, room: e.room }),
      ),
    );
  }

  // --- Step --------------------------------------------------------------------------------------------

  /** Fixed step (order -690). */
  step(_dt: number, t: CadTime, officer: OfficerFocus): void {
    const clock = this.deps.clock;
    const c0 = clock ? clock() : 0;
    this.time = t;
    this.officer.x = officer.x;
    this.officer.z = officer.z;
    this.officer.yaw = officer.yaw;
    this.officer.speed = officer.speed;
    this.officer.onFoot = officer.onFoot;
    this.officer.building = officer.building ?? this.deps.interiors?.officerBuilding ?? -1;
    // Getting into a car holsters whatever was drawn (the weapon cannot be put away from the seat).
    if (!officer.onFoot && this.weapon !== 'none') {
      this.weapon = 'none';
      this.pres.weapon = 'none';
      this.rev++;
    }
    if (this.events.length > 0) this.drainEvents(t);
    if (this.requests.length > 0) this.drainRequests(t);
    const open = this.open;
    for (let i = 0; i < open.length; i++) {
      const rt = open[i];
      if (rt) this.stepRuntime(rt, t);
    }
    if (open.length > 0) this.stepPlayerScene(t);
    const tick = Math.floor(t.sim * SLOW_HZ);
    if (tick !== this.slowTick) {
      this.slowTick = tick;
      this.slowUpdate(t);
    }
    if (this.propsDirty) this.rebuildProps();
    if (clock) this.statsValue.stepMs = clock() - c0;
  }

  private stepRuntime(rt: ScenarioRuntime, t: CadTime): void {
    const tl = rt.scenario.timeline;
    while (rt.timelineIdx < tl.length) {
      const e = tl[rt.timelineIdx];
      if (!e || rt.createdSim + e.atS > t.sim) break;
      rt.timelineIdx++;
      this.applyTimeline(rt, e.kind, e.text, e.priority, e.callerPersonId, t);
    }
    if (rt.actions.length > 0) {
      for (let i = rt.actions.length - 1; i >= 0; i--) {
        const a = rt.actions[i];
        if (a && a.state === 'running' && t.sim >= a.dueSim) this.completeAction(rt, a, t);
      }
    }
    if (rt.buildingId >= 0) {
      if (rt.answerDueSim >= 0 && t.sim >= rt.answerDueSim) this.answerDoor(rt);
      if (rt.materialized && this.officer.building === rt.buildingId && !rt.flags.has('entered')) this.onEntered(rt, t);
    }
    if (rt.services.length > 0) {
      for (const s of rt.services) this.stepService(rt, s, t);
    }
  }

  /** The runtime of the call the player is assigned to, null without one. */
  private playerRuntime(): ScenarioRuntime | null {
    const pu = this.deps.cad.unit(this.pc);
    if (!pu || pu.callId === null) return null;
    return this.byCall.get(pu.callId) ?? null;
  }

  private stepPlayerScene(t: CadTime): void {
    const rt = this.playerRuntime();
    if (!rt) return;
    const a = rt.scenario.anchor;
    const d = dist(this.officer.x, this.officer.z, a.x, a.z);
    if (!rt.materialized && d <= this.cfg.distances.materializeM) this.materialize(rt, t);
    if (rt.arrivedSim < 0 && d <= this.cfg.distances.arriveM && (this.officer.onFoot || this.officer.speed < 2)) this.arrive(rt, t);
    if (rt.ambushArmed && rt.materialized && !rt.flags.has('attacked') && d <= CALL_CATALOG.variants.ambush.triggerDistanceM) this.fireAmbush(rt, t);
  }

  private arrive(rt: ScenarioRuntime, t: CadTime): void {
    rt.arrivedSim = t.sim;
    this.setFlag(rt, 'arrived');
    const pu = this.deps.cad.unit(this.pc);
    if (pu && pu.status === 'enRoute' && pu.callId === rt.scenario.callId) {
      this.deps.dispatcher.request(this.pc, { kind: 'status', status: 'onScene' }, 'auto');
    }
    this.rev++;
  }

  // --- Events ------------------------------------------------------------------------------------------

  private drainEvents(t: CadTime): void {
    const list = this.events;
    this.events = [];
    for (const e of list) this.handleEvent(e, t);
  }

  private handleEvent(e: QueuedEvent, t: CadTime): void {
    switch (e.t) {
      case 'created': {
        const call = this.deps.cad.call(e.callId);
        if (!call || call.status === 'closed' || this.byCall.has(e.callId) || this.ignored.has(e.callId)) return;
        this.adopt(call, t);
        return;
      }
      case 'closed':
        this.onClosed(e.callId, e.disposition, t);
        return;
      case 'onScene':
        this.onAiOnScene(e.callsign, e.callId, t);
        return;
      case 'stop':
        if (e.active) this.onStopStarted(e.callId, e.vehicleId, t);
        return;
      case 'pulling':
        this.onPullingOver(e.vehicleId, t);
        return;
      case 'fleeEnded':
        this.onFleeEnded(e.vehicleId, e.reason, e.x, e.z, t);
        return;
      case 'contact':
        this.onContactEvent(e.callId, e.incident, e.role, e.flag);
        return;
      case 'needsCall':
        this.onNeedsCall(e.personId, e.x, e.z, e.incident, t);
        return;
      case 'npc':
        this.onNpcEvent(e, t);
        return;
      case 'doc':
        this.onDocument(e.id);
        return;
      case 'force':
        this.onForce(e.kind, e.callId);
        return;
      case 'consent':
        this.onConsent(e);
        return;
    }
  }

  private runtimeOfCallRef(callId: number, incident: string): ScenarioRuntime | null {
    const direct = callId > 0 ? this.byCall.get(callId) : undefined;
    if (direct) return direct;
    const m = /^C-(\d+)$/.exec(incident);
    if (m) return this.byCall.get(Number(m[1])) ?? null;
    return null;
  }

  private onContactEvent(callId: number, incident: string, role: string, flag: string): void {
    const rt = this.runtimeOfCallRef(callId, incident);
    if (!rt) return;
    this.activity.set(rt.scenario.callId, this.time.sim);
    if (flag === 'forceUsed') {
      if (!rt.forceUsed.includes('struggle')) rt.forceUsed.push('struggle');
      this.setFlag(rt, 'forceUsed');
      return;
    }
    if (flag === 'interpreterRequested') {
      if (!rt.flags.has('service:interpreter')) this.requestService(rt, 'interpreter', this.time);
      return;
    }
    // Cuffed and then let go is not an arrest (only a caged prisoner stays in custody).
    if ((flag === 'released' || flag === 'uncuffed') && role !== '' && !rt.flags.has(`caged:${role}`)) this.delFlag(rt, `custody:${role}`);
    if (CONTACT_PERSON_FLAGS.has(flag) && role !== '') this.setFlag(rt, `${flag}:${role}`);
    if (CONTACT_GLOBAL_FLAGS.has(flag) || flag.startsWith('itemFound:')) this.setFlag(rt, flag);
  }

  private onForce(kind: string, callId: number): void {
    const rt = callId > 0 ? this.byCall.get(callId) : undefined;
    if (!rt) return;
    if (FORCE_KINDS.has(kind) && !rt.forceUsed.includes(kind)) rt.forceUsed.push(kind);
    // Drawing a weapon is not a use of force yet; everything else is.
    if (kind !== 'sidearmDrawn' && kind !== 'taserDrawn') this.setFlag(rt, 'forceUsed');
  }

  private onDocument(id: string): void {
    const doc = this.deps.cad.docs.get(id);
    if (!doc || doc.status !== 'final' || doc.callId === null) return;
    const rt = this.byCall.get(doc.callId);
    if (!rt) return;
    if (doc.kind === 'report') {
      this.setFlag(rt, 'report');
    } else if (doc.kind === 'citation') {
      this.setFlag(rt, 'cited');
      for (const p of rt.scenario.participants) if (p.personId >= 0 && p.personId === doc.personId) this.setFlag(rt, `citation:${p.role}`);
    }
  }

  private onAiOnScene(callsign: string, callId: number, t: CadTime): void {
    const rt = this.byCall.get(callId);
    if (!rt) return;
    const unit = this.deps.cad.unit(callsign);
    if (!unit || unit.kind !== 'ai') return;
    let text = `Unit ${callsign} on scene.`;
    const flags = rt.flags;
    if (flags.has('variant:false') || flags.has('variant:swatting')) text += ' Advises no evidence of an incident.';
    else if (flags.has('suspectFled') || flags.has('branch:suspectGone') || flags.has('branch:gone') || this.anyFlagPrefix(rt, 'escaped:')) {
      text += ' Advises the suspect is gone.';
    }
    this.deps.cad.addNarrative(callId, callsign, text, t);
  }

  /** The legal basis of the officer's entry (`entry:<basis>` flag), null when the officer never went inside. */
  private entryOf(rt: ScenarioRuntime): string | null {
    for (const f of rt.flags) if (f.startsWith('entry:')) return f.slice(6);
    return null;
  }

  private anyFlagPrefix(rt: ScenarioRuntime, prefix: string): boolean {
    for (const f of rt.flags) if (f.startsWith(prefix)) return true;
    return false;
  }

  private onNpcEvent(e: Extract<QueuedEvent, { t: 'npc' }>, t: CadTime): void {
    const found = this.runtimeOfActor(e.actorId, e.personId, e.callId);
    const rt = found?.rt ?? null;
    const role = found ? (rt?.scenario.participants[found.index]?.role ?? '') : '';
    switch (e.kind) {
      case 'fled':
        if (rt && role !== '') this.setFlag(rt, `fled:${role}`);
        this.onFootPursuitStart(rt, role, e.actorId, e.personId, t);
        return;
      case 'caught':
        if (rt && role !== '') this.setFlag(rt, `caught:${role}`);
        this.endFootPursuit(e.actorId, t);
        return;
      case 'escaped':
        if (rt && role !== '') this.setFlag(rt, `escaped:${role}`);
        this.endFootPursuit(e.actorId, t);
        return;
      case 'surrendered':
        if (rt && role !== '') this.setFlag(rt, `detained:${role}`);
        this.endFootPursuit(e.actorId, t);
        return;
      case 'attack':
        if (rt) {
          this.setFlag(rt, 'attacked');
          if (e.extra === 'fire') this.setFlag(rt, 'shotsFired');
        }
        return;
      case 'weaponDropped': {
        this.addGroundItem(e.extra, e.x, e.z, rt?.scenario.callId ?? 0);
        // The gun is on the ground now, not in the waistband too.
        if (e.personId >= 0) {
          const { people } = this.deps;
          const held = people.itemsOn(e.personId).find((it) => it.item === e.extra);
          if (held) people.seize({ kind: 'person', id: e.personId }, held.instance);
        }
        return;
      }
      case 'left':
        if (rt && role !== '') this.setFlag(rt, `left:${role}`);
        this.endFootPursuit(e.actorId, t);
        return;
      case 'revealed':
        if (rt && role !== '') this.setFlag(rt, `revealed:${role}`);
        if (rt && found && (rt.hideSpots[found.index] ?? -1) >= 0) rt.hideSpots[found.index] = -1;
        return;
    }
  }

  /** The runtime and participant index of an actor (by call, then by scan). */
  private runtimeOfActor(actorId: number, personId: number, callId: number): { rt: ScenarioRuntime; index: number } | null {
    const hit = (rt: ScenarioRuntime): { rt: ScenarioRuntime; index: number } | null => {
      const ids = rt.actorIds;
      for (let i = 0; i < ids.length; i++) if (ids[i] === actorId) return { rt, index: i };
      if (personId >= 0) {
        const ps = rt.scenario.participants;
        for (let i = 0; i < ps.length; i++) if (ps[i]?.personId === personId) return { rt, index: i };
      }
      return null;
    };
    const direct = callId > 0 ? this.byCall.get(callId) : undefined;
    if (direct) {
      const h = hit(direct);
      if (h) return h;
    }
    for (const rt of this.open) {
      const h = hit(rt);
      if (h) return h;
    }
    return null;
  }

  // --- Flags -------------------------------------------------------------------------------------------

  /** Adds a flag (and mirrors it into the scenarios this one shares flags with). */
  private setFlag(rt: ScenarioRuntime, flag: string): void {
    if (!rt.flags.has(flag)) {
      rt.flags.add(flag);
      if (!flag.startsWith('near:') && !flag.startsWith('found:')) this.activity.set(rt.scenario.callId, this.time.sim);
      if (flag.startsWith('custody:')) this.noteArrest(rt, flag.slice(8));
      this.rev++;
    }
    if (rt.mirror.length === 0) return;
    const colon = flag.indexOf(':');
    const scoped = colon >= 0 && !flag.startsWith('itemFound:') && !flag.startsWith('service:') && !flag.startsWith('arrived:') && !flag.startsWith('branch:') && !flag.startsWith('variant:');
    for (const id of rt.mirror) {
      const target = this.byCall.get(id);
      if (!target || target === rt) continue;
      if (scoped) {
        const role = flag.slice(colon + 1);
        if (!target.flags.has(`role:${role}`)) continue;
      } else if (!MIRROR_GLOBAL.has(flag) && !flag.startsWith('itemFound:')) {
        continue;
      }
      if (!target.flags.has(flag)) {
        target.flags.add(flag);
        this.rev++;
      }
    }
  }

  private delFlag(rt: ScenarioRuntime, flag: string): void {
    if (rt.flags.delete(flag)) this.rev++;
  }

  private addNarrative(callId: number, source: string, text: string): void {
    this.deps.cad.addNarrative(callId, source, text, this.time);
  }

  private radio(text: string, speaker: string | null, priority = false): void {
    this.deps.bus.emit('scene:radio', { channel: 'dispatch', speaker, text, priority });
  }

  private flash(text: string): void {
    this.deps.bus.emit('scene:flash', { text });
  }

  // --- Scenario creation -------------------------------------------------------------------------------

  /** Builds the scenario of a CAD call (non-derived families only); null when the type has none. */
  private adopt(call: CadCall, t: CadTime): ScenarioRuntime | null {
    const family = familyForType(call.typeId);
    if (!family || family.derived) return null;
    return this.createRuntime(call, family, { existingVehicleId: -1, given: [], derivedBranch: null, materializeNow: false, mirror: [] }, t);
  }

  private busyPersons(): Set<number> {
    const busy = new Set<number>();
    for (const rt of this.open) for (const p of rt.scenario.participants) if (p.personId >= 0) busy.add(p.personId);
    return busy;
  }

  private createRuntime(
    call: CadCall,
    family: FamilyDef,
    opts: { existingVehicleId: number; given: readonly number[]; derivedBranch: string | null; materializeNow: boolean; mirror: number[] },
    t: CadTime,
  ): ScenarioRuntime {
    const { people, traffic, city, npc, records } = this.deps;
    const forced = this.forced.get(call.id);
    this.forced.delete(call.id);
    const type = callTypeDef(call.typeId);
    let rng: Rng = createRng(this.seed).stream(`scenario:${call.id}`);
    if (forced) rng = new ScriptedRng(rng, scriptFor(forced, type?.variants ?? family.variants));
    const busy = this.busyPersons();
    const districtOf = (x: number, z: number): string => DISTRICT_NAMES[city.districtAt(x, z)] ?? '';
    const pick = (c: PersonConstraint, r: Rng): number => this.pickPersonFor(c, r, busy);
    const input: ScenarioInput = {
      seed: this.seed,
      callId: call.id,
      typeId: call.typeId,
      priority: call.priority,
      location: { x: call.location.x, z: call.location.z, edge: call.location.edge, text: call.location.text, near: call.location.near, street: call.location.street },
      callerPersonId: call.caller.kind === 'citizen' ? call.caller.personId : -1,
      reportedVehicleId: call.vehicles[0] ?? -1,
      existingVehicleId: opts.existingVehicleId,
      given: opts.given,
      derivedBranch: opts.derivedBranch,
      graph: city.graph,
      pickPerson: pick,
      driverOf: (vehicleId) => npc.occupantsOf(vehicleId)[0] ?? 0,
      pickVehicle: (r) => this.pickVehicleFor(r),
      describe: (id) => describePerson(people.identity(id)),
      addressAt: (edge, s) => addressOnEdge(city.graph, edge, s, districtOf).text,
      ageOf: (id) => people.identity(id).age,
    };
    void traffic;
    let scenario = buildScenario(input, rng);
    // People at their own door live at the call address (the MDT, CAD and dialogue read the same record).
    const homeText = scenario.errors.wrongAddress ? input.addressAt(scenario.anchor.edge, scenario.anchor.s) : call.location.text;
    for (const p of scenario.participants) {
      if (p.personId < 0 || opts.given.includes(p.personId) || !RESIDENT_ROLES.has(p.role) || (p.spot !== 'inside' && p.spot !== 'door')) continue;
      if (p.spot === 'door' && family.id === 'retail') continue;
      records.setAddress(p.personId, homeText);
    }
    if (family.id === 'trafficStop' && opts.given.length > 0) scenario = this.fitOccupants(scenario, opts.given);
    const flags = new Set<string>(scenario.flags);
    for (const p of scenario.participants) {
      if (p.injured) flags.add(`injury:${p.role}`);
      if (p.deceased) flags.add(`deceased:${p.role}`);
    }
    const rt: ScenarioRuntime = {
      scenario,
      flags,
      createdSim: call.created.sim,
      materialized: false,
      actorIds: scenario.participants.map(() => 0),
      timelineIdx: 0,
      arrivedSim: -1,
      actions: [],
      services: [],
      ambushArmed: false,
      forceUsed: [],
      mirror: opts.mirror,
      buildingId: -1,
      hideSpots: scenario.participants.map(() => -1),
      knockedSim: -1,
      answerDueSim: -1,
      arrests: [],
    };
    rt.buildingId = this.bindBuilding(scenario);
    this.open.push(rt);
    this.byCall.set(call.id, rt);
    this.rev++;
    if (opts.materializeNow) this.materialize(rt, t);
    return rt;
  }

  /** A traffic stop's participants are exactly the car's occupants (the builder rolls its own passenger count). */
  private fitOccupants(scenario: Scenario, occupants: readonly number[]): Scenario {
    const participants = occupants.map((personId, j) => ({
      index: j,
      role: j === 0 ? 'driver' : 'passenger',
      personId,
      profile: this.deps.npc.ambientProfile(personId, j === 0 ? 'driverCooperative' : 'passenger'),
      spot: 'vehicle' as const,
      spotIndex: j,
      items: [] as string[],
      weapon: null,
      intoxication: null,
      injured: false,
      deceased: false,
      body: 'human' as const,
      vehicle: scenario.vehicles.length > 0 ? 0 : -1,
      seat: j,
    }));
    const flags = scenario.flags.filter((f) => !f.startsWith('role:') && !f.startsWith('juvenile:'));
    for (const p of participants) {
      if (!flags.includes(`role:${p.role}`)) flags.push(`role:${p.role}`);
      if (this.deps.people.identity(p.personId).juvenile && !flags.includes(`juvenile:${p.role}`)) flags.push(`juvenile:${p.role}`);
    }
    return { ...scenario, participants, flags };
  }

  /**
   * A person satisfying `c`, not busy: a bounded random search over the cheap record view (no identity is
   * generated until a person is picked); `risk` relaxes first, then the age window, when nothing fits.
   */
  private pickPersonFor(c: PersonConstraint, rng: Rng, busy: ReadonlySet<number>): number {
    const { people, records } = this.deps;
    const today = epochDayOfGameSeconds(this.time.game);
    let fallback = -1;
    for (let tries = 0; tries < this.cfg.people.pickTries; tries++) {
      const id = rng.nextInt(0, PERSON_POPULATION - 1);
      if (busy.has(id)) continue;
      const rec = records.peekPerson(id);
      if (c.warrant === true && rec.warrants.length === 0) continue;
      const age = ageOn(rec.dob, today);
      if (c.minAge !== undefined && age < c.minAge) continue;
      if (c.maxAge !== undefined && age > c.maxAge) continue;
      if (c.sex !== undefined && rec.sex !== c.sex) continue;
      if (c.mentalHealth === true && rec.mentalHealth === null) continue;
      if (c.dementia === true && !people.identity(id).dementia) continue;
      if (people.isTouched(id)) {
        const state = people.state(id);
        if (state.deceased || state.missing || (state.custody !== 'none' && state.custody !== 'released')) continue;
      }
      if (c.risk === true && riskOf(rec) < this.cfg.people.riskMin) {
        if (fallback < 0) fallback = id;
        continue;
      }
      return id;
    }
    if (fallback >= 0) return fallback;
    for (let id = rng.nextInt(0, PERSON_POPULATION - 1), n = 0; n < PERSON_POPULATION; n++, id = (id + 1) % PERSON_POPULATION) {
      if (busy.has(id)) continue;
      const age = ageOn(records.peekPerson(id).dob, today);
      if ((c.minAge === undefined || age >= c.minAge) && (c.maxAge === undefined || age <= c.maxAge) && (c.dementia !== true || people.identity(id).dementia)) return id;
    }
    return rng.nextInt(0, PERSON_POPULATION - 1);
  }

  private pickVehicleFor(rng: Rng): number {
    let id = rng.nextInt(0, REGISTRY_POPULATION - 1);
    for (let tries = 0; tries < 20; tries++) {
      if (!isFleetVehicleId(id) && canBeOnRoad(this.seed, id) && this.deps.traffic.slotOfVehicle(id) < 0) return id;
      id = rng.nextInt(0, REGISTRY_POPULATION - 1);
    }
    return id;
  }

  // --- Timeline ----------------------------------------------------------------------------------------

  private nameOf(personId: number): string {
    if (personId < 0) return 'Caller';
    const p = this.deps.records.peekPerson(personId);
    return `${p.last}, ${p.first}`;
  }

  /** The caller gave the right address: the CAD call, the pin and the units on their way move to the true anchor. */
  private correctLocation(rt: ScenarioRuntime, t: CadTime): void {
    const { cad, dispatcher } = this.deps;
    const a = rt.scenario.anchor;
    cad.updateLocation(rt.scenario.callId, dispatcher.locate(a.x, a.z), t);
    dispatcher.callRelocated(rt.scenario.callId, a.x, a.z);
  }

  private applyTimeline(rt: ScenarioRuntime, kind: string, text: string, priority: number, callerPersonId: number, t: CadTime): void {
    const id = rt.scenario.callId;
    const family = familyDef(rt.scenario.family);
    this.rev++;
    switch (kind) {
      case 'correction':
        this.addNarrative(id, 'CAD', text);
        if (rt.scenario.errors.wrongAddress && text.startsWith(LOCATION_CORRECTION)) this.correctLocation(rt, t);
        return;
      case 'describe':
      case 'narrative':
      case 'unitReport':
        this.addNarrative(id, 'CAD', text);
        return;
      case 'priority':
        if (priority > 0) this.deps.cad.setPriority(id, priority as Priority, t);
        return;
      case 'escalate':
        this.addNarrative(id, 'CAD', text);
        if (priority > 0) this.deps.cad.setPriority(id, priority as Priority, t);
        this.setFlag(rt, 'escalated');
        if (family?.escalation) this.applyVariantChange(rt, family.escalation);
        return;
      case 'deescalate':
        this.addNarrative(id, 'CAD', text);
        if (priority > 0) this.deps.cad.setPriority(id, priority as Priority, t);
        this.setFlag(rt, 'deescalated');
        if (family?.deescalation) this.applyVariantChange(rt, family.deescalation);
        return;
      case 'duplicateCaller': {
        const name = this.nameOf(callerPersonId);
        this.addNarrative(id, name, text.replace('{name}', name));
        return;
      }
      case 'linkedCall':
        this.makeLinkedCall(rt, callerPersonId, text, t);
        return;
      case 'ambush':
        rt.ambushArmed = true;
        return;
    }
  }

  /** Escalation / de-escalation: live actors get the new profile (and spot, weapon); removed roles leave. */
  private applyVariantChange(rt: ScenarioRuntime, change: VariantChange): void {
    const { npc, people } = this.deps;
    const sc = rt.scenario;
    for (let i = 0; i < sc.participants.length; i++) {
      const p = sc.participants[i];
      const actor = this.actorOfParticipant(rt, i);
      if (!p) continue;
      if (actor > 0 && change.remove.includes(p.role)) {
        npc.forceState(actor, 'leave');
        continue;
      }
      const ov = change.roleOverrides[p.role];
      if (!ov) continue;
      if (actor > 0 && ov.profile !== undefined) npc.setProfile(actor, ov.profile);
      if (actor > 0 && ov.weapon) npc.arm(actor, ov.weapon);
      if (ov.weapon && p.personId >= 0 && !people.itemsOn(p.personId).some((it) => it.item === ov.weapon)) {
        people.addItem({ kind: 'person', id: p.personId }, ov.weapon, 'waistband', false);
      }
      if (actor > 0 && ov.spot !== undefined && ov.spot !== p.spot && (npc.actor(actor, this.info)?.building ?? -1) < 0) {
        spotPosition(this.deps.city.graph.edges, sc.anchor, ov.spot, p.spotIndex, this.rng, this.spot);
        npc.walkTo(actor, this.spot.x, this.spot.z);
      }
    }
  }

  /** A duplicate report: a second CAD call of the same type, linked and closed at once as a duplicate. */
  private makeLinkedCall(rt: ScenarioRuntime, callerPersonId: number, text: string, t: CadTime): void {
    const { cad, records } = this.deps;
    const orig = cad.call(rt.scenario.callId);
    if (!orig) return;
    const p = callerPersonId >= 0 ? records.peekPerson(callerPersonId) : null;
    const caller = p
      ? { kind: 'citizen' as const, name: `${p.last}, ${p.first}`, phone: p.phone, personId: callerPersonId }
      : { kind: 'anonymous' as const, name: 'ANONYMOUS', phone: '', personId: -1 };
    const dup = cad.createCall(
      { typeId: orig.typeId, priority: orig.priority, location: orig.location, caller, narrative: text, selfInitiated: false, persons: callerPersonId >= 0 ? [callerPersonId] : [], vehicles: [...orig.vehicles] },
      t,
    );
    this.ignored.add(dup.id);
    cad.linkCalls(orig.id, dup.id, t);
    cad.closeCall(dup.id, 'duplicate', t);
  }

  // --- Materialize -------------------------------------------------------------------------------------

  private vehicleIdOf(rt: ScenarioRuntime, vehicleIndex: number): number {
    return vehicleIndex >= 0 ? (rt.scenario.vehicles[vehicleIndex]?.vehicleId ?? -1) : -1;
  }

  private effectiveProfile(rt: ScenarioRuntime, role: string, base: string): string {
    const fam = familyDef(rt.scenario.family);
    let profile = base;
    if (rt.flags.has('escalated')) profile = fam?.escalation?.roleOverrides[role]?.profile ?? profile;
    if (rt.flags.has('deescalated')) profile = fam?.deescalation?.roleOverrides[role]?.profile ?? profile;
    return profile;
  }

  /**
   * The live actor of participant `i`: the one the scene spawned, else the one the officer made of them (ordered out of
   * a car or promoted from the street), which the scene adopts with the participant's role profile.
   */
  private actorOfParticipant(rt: ScenarioRuntime, i: number): number {
    const known = rt.actorIds[i] ?? 0;
    if (known > 0) return known;
    const p = rt.scenario.participants[i];
    if (!p || p.body !== 'human' || p.personId < 0 || !rt.materialized) return 0;
    const { npc } = this.deps;
    const id = npc.actorOfPerson(p.personId);
    if (id <= 0) return 0;
    rt.actorIds[i] = id;
    npc.setRole(id, p.role, rt.scenario.callId);
    npc.setProfile(id, this.effectiveProfile(rt, p.role, p.profile));
    const weapon = this.effectiveWeapon(rt, p.role, p.weapon);
    if (weapon) npc.arm(id, weapon);
    return id;
  }

  /** The weapon a role carries now: the escalation's weapon once the scene escalated. */
  private effectiveWeapon(rt: ScenarioRuntime, role: string, base: string | null): string | null {
    const fam = familyDef(rt.scenario.family);
    return (rt.flags.has('escalated') ? fam?.escalation?.roleOverrides[role]?.weapon : undefined) ?? base;
  }

  private roleRemoved(rt: ScenarioRuntime, role: string): boolean {
    const fam = familyDef(rt.scenario.family);
    return (rt.flags.has('escalated') && (fam?.escalation?.remove.includes(role) ?? false)) ||
      (rt.flags.has('deescalated') && (fam?.deescalation?.remove.includes(role) ?? false));
  }

  /**
   * Spawns the scene (design §11.1 step 3): subject cars, person deltas (intoxication, injury, items),
   * actors at their spots, seated occupants, ground evidence. Each scene materializes once.
   */
  private materialize(rt: ScenarioRuntime, _t: CadTime): void {
    if (rt.materialized) return;
    rt.materialized = true;
    this.rev++;
    const { npc, people, traffic, city } = this.deps;
    const sc = rt.scenario;
    const edges = city.graph.edges;
    const anchor = sc.anchor;
    const edge = edges[anchor.edge];
    const callId = sc.callId;

    // Scene vehicles.
    const vehicleOk = sc.vehicles.map((v) => v.existing);
    let slot = 0;
    for (const v of sc.vehicles) {
      if (v.existing) continue;
      let x = anchor.x;
      let z = anchor.z;
      if (edge) {
        let s: number;
        let lateral = 0;
        if (v.mode === 'driving') {
          const a = Math.min(Math.max(anchor.s + this.cfg.distances.driveAwayM, 5), Math.max(5, edge.length - 5));
          const b = Math.min(Math.max(anchor.s - this.cfg.distances.driveAwayM, 5), Math.max(5, edge.length - 5));
          edgePoint(edge, a, 0, anchor.side, this.edgePt);
          const da = dist(this.edgePt.x, this.edgePt.z, this.officer.x, this.officer.z);
          edgePoint(edge, b, 0, anchor.side, this.edgePt);
          const db = dist(this.edgePt.x, this.edgePt.z, this.officer.x, this.officer.z);
          s = da >= db ? a : b;
        } else {
          s = anchor.s + (slot - 0.5) * this.cfg.distances.vehicleGapM;
          lateral = edgeLaterals(edge).C;
        }
        edgePoint(edge, s, lateral, anchor.side, this.edgePt);
        x = this.edgePt.x;
        z = this.edgePt.z;
      }
      slot++;
      const eid = traffic.spawnSubjectCar(v.vehicleId, x, z, { behavior: v.behavior === 'dui' ? BEHAVIOR.dui : 0, mode: v.mode });
      vehicleOk[v.index] = eid !== 0;
    }

    // People: deltas first (the identity must carry them when the actor appears), then bodies.
    const seated = new Map<number, { seat: number; personId: number }[]>();
    const layout = rt.buildingId >= 0 ? (this.deps.interiors?.layout(rt.buildingId) ?? null) : null;
    const plan = layout ? this.planScene(rt, layout) : null;
    for (let i = 0; i < sc.participants.length; i++) {
      const p = sc.participants[i];
      if (!p) continue;
      if (this.roleRemoved(rt, p.role)) continue;
      if (p.body === 'human' && p.personId >= 0) this.applyDeltas(rt, p);
      const veh = p.vehicle >= 0 ? sc.vehicles[p.vehicle] : undefined;
      if (p.spot === 'vehicle' && veh && vehicleOk[veh.index] && p.personId >= 0) {
        let list = seated.get(veh.vehicleId);
        if (!list) {
          list = [];
          seated.set(veh.vehicleId, list);
        }
        list.push({ seat: p.seat, personId: p.personId });
        continue;
      }
      this.spawnParticipant(rt, i, p.spot === 'vehicle' ? 'curb' : p.spot, plan?.places.find((pl) => pl.index === i) ?? null);
    }
    for (const [vehicleId, list] of seated) {
      const spec = sc.vehicles.find((v) => v.vehicleId === vehicleId);
      if (spec && !spec.existing) {
        list.sort((a, b) => a.seat - b.seat);
        npc.setOccupants(vehicleId, list.map((e) => e.personId));
      }
    }

    // Ground evidence (Phase 4 with an evidence port: placed items of the investigation module, props of the scene otherwise).
    if (this.deps.evidence) {
      this.placeEvidence(rt, layout, plan);
    } else {
      for (const e of sc.evidence) {
        spotPosition(edges, anchor, e.spot, e.spotIndex, this.rng, this.spot);
        this.addGroundItem(e.item, this.spot.x, this.spot.z, callId);
      }
    }
    if (layout) this.lockMainDoor(rt, layout);
    void people;
    if (this.deps.interiors !== undefined && this.deps.buildings !== undefined) this.deps.bus.emit('scene:materialized', { callId, buildingId: rt.buildingId });
    else this.deps.bus.emit('scene:materialized', { callId });
  }

  /** Scenario deltas of one human participant: intoxication, injury, deceased, items and the carried weapon. */
  private applyDeltas(rt: ScenarioRuntime, p: ScenarioRuntime['scenario']['participants'][number]): void {
    const { people } = this.deps;
    const id = p.personId;
    if (p.intoxication) {
      const drug = (DRUG_KINDS as readonly string[]).includes(p.intoxication.drug) ? (p.intoxication.drug as DrugKind) : 'none';
      people.setIntoxication(id, p.intoxication.bac, drug);
    }
    if (p.injured) people.setInjured(id, this.cfg.people.injuryValue);
    if (p.deceased) people.setDeceased(id);
    const vehicleId = p.spot === 'vehicle' ? this.vehicleIdOf(rt, p.vehicle) : -1;
    const carried = people.itemsOn(id);
    const give = (item: string): void => {
      if (!isItemId(item)) return;
      const def = itemDef(item);
      if (vehicleId >= 0 && def.category === 'alcohol' && def.inVehicle) {
        if (!people.vehicleItems(vehicleId, id).some((it) => it.item === item)) {
          try {
            people.addItem({ kind: 'vehicle', id: vehicleId }, item, 'cabin', false);
          } catch {
            // Not an owned registry car: the item stays off the car.
          }
        }
        return;
      }
      if (carried.some((it) => it.item === item)) return;
      people.addItem({ kind: 'person', id }, item, DEFAULT_ITEM_WHERE[def.category] ?? 'pocket', false);
    };
    for (const item of p.items) give(item);
    if (p.weapon !== null) give(p.weapon);
  }

  /** Spawns (or adopts) the actor of participant `i` at `spotName`. */
  private spawnParticipant(
    rt: ScenarioRuntime,
    i: number,
    spotName: ScenarioRuntime['scenario']['participants'][number]['spot'],
    place: IndoorPlace | null = null,
  ): void {
    const { npc, city } = this.deps;
    const sc = rt.scenario;
    const p = sc.participants[i];
    if (!p) return;
    const profile = this.effectiveProfile(rt, p.role, p.profile);
    if (p.body === 'human' && p.personId >= 0) {
      const existing = npc.actorOfPerson(p.personId);
      if (existing > 0) {
        npc.setRole(existing, p.role, sc.callId);
        rt.actorIds[i] = existing;
        return;
      }
    }
    if (place !== null) {
      // Inside the bound building (rooms, hiding spots) or at its main door; the level is the building's for the first two.
      const indoors = place.mode !== 'door';
      const id = npc.spawnActor({
        personId: p.personId,
        x: place.x,
        z: place.z,
        yaw: place.yaw,
        profile,
        role: p.role,
        callId: sc.callId,
        hidden: place.mode === 'hidden',
        body: p.body,
        weapon: this.effectiveWeapon(rt, p.role, p.weapon),
        vehicleId: this.vehicleIdOf(rt, p.vehicle),
        pose: place.pose,
        building: indoors ? rt.buildingId : -1,
      });
      rt.actorIds[i] = id;
      if (id > 0 && place.mode === 'hidden') {
        rt.hideSpots[i] = place.spotIndex;
        this.deps.interiors?.claimHideSpot?.(rt.buildingId, place.spotIndex);
      }
      return;
    }
    spotPosition(city.graph.edges, sc.anchor, spotName, p.spotIndex, this.rng, this.spot, familyAnchorIsStreet(sc.family));
    const id = npc.spawnActor({
      personId: p.body === 'dog' ? -1 : p.personId,
      x: this.spot.x,
      z: this.spot.z,
      yaw: this.spot.yaw,
      profile,
      role: p.role,
      callId: sc.callId,
      hidden: this.spot.hidden,
      body: p.body,
      weapon: this.effectiveWeapon(rt, p.role, p.weapon),
      vehicleId: this.vehicleIdOf(rt, p.vehicle),
    });
    rt.actorIds[i] = id;
  }

  private addGroundItem(item: string, x: number, z: number, callId: number): void {
    const name = isItemId(item) ? itemDef(item).prop : null;
    const kind = name !== null ? (PROP_BY_NAME[name] ?? 0) : 0;
    if (kind === 0) return;
    this.addProp(x, z, 0, kind, callId);
  }

  private addProp(x: number, z: number, yaw: number, kind: number, callId: number): void {
    this.propList.push({ x, y: 0, z, yaw, kind, callId });
    if (this.propList.length > this.cfg.limits.propCap) this.propList.shift();
    this.propsDirty = true;
    this.rev++;
  }

  private rebuildProps(): void {
    this.propsDirty = false;
    const src = this.propSource;
    const n = Math.min(this.propList.length, this.cfg.limits.propCap);
    for (let i = 0; i < n; i++) {
      const p = this.propList[i];
      if (!p) continue;
      src.x[i] = p.x;
      src.y[i] = p.y;
      src.z[i] = p.z;
      src.yaw[i] = p.yaw;
      src.kind[i] = p.kind;
    }
    src.count = n;
  }

  /** Close of a scene: loose actors leave (cuffed ones stay for the cage), cars are unpinned. */
  private dematerialize(rt: ScenarioRuntime): void {
    const { npc, traffic } = this.deps;
    for (let i = 0; i < rt.actorIds.length; i++) {
      const id = rt.actorIds[i] ?? 0;
      if (id <= 0) continue;
      const info = npc.actor(id, this.info);
      if (!info) continue;
      if (info.state === ACTOR_STATE.lying) npc.setRole(id, 'bystander', 0);
      else if (!info.cuffed) npc.forceState(id, 'leave');
    }
    // People the contact module got out of cars or promoted from the street for this call are not in `actorIds`.
    npc.actorsOfCall(rt.scenario.callId, this.leaveScratch);
    for (let i = 0; i < this.leaveScratch.length; i++) {
      const id = this.leaveScratch[i] ?? 0;
      const info = id > 0 ? npc.actor(id, this.info) : null;
      if (info?.state === ACTOR_STATE.lying) npc.setRole(id, 'bystander', 0);
      else if (info && !info.cuffed && !info.following) npc.forceState(id, 'leave');
    }
    for (const v of rt.scenario.vehicles) {
      if (v.existing) continue;
      if (traffic.fleeState(v.vehicleId, this.fleeScratch)) continue;
      traffic.pin(v.vehicleId, false);
    }
  }

  // --- Indoor scenes (Phase 4 design §12) --------------------------------------------------------------

  /** The building `scenario` binds to (design §12.1), -1 when it stays outdoors or the scene has no interiors. */
  private bindBuilding(scenario: Scenario): number {
    const { interiors, buildings, city } = this.deps;
    if (!interiors || !buildings) return -1;
    // Debug: `call spawn <type> building <id>` binds the call to that building.
    const forcedId = this.forcedBuilding.get(scenario.callId);
    if (forcedId !== undefined && interiors.layout(forcedId)) return forcedId;
    const kinds = bindingKinds(this.indoor, scenario.typeId, scenario.family, findCallType(scenario.typeId)?.location ?? 'block');
    if (!kinds) return -1;
    // The door spot of the anchor (no random draws for this spot).
    spotPosition(city.graph.edges, scenario.anchor, 'door', 0, this.rng, this.spot);
    const radius = this.cfg.indoor.bindRadiusM;
    let b = buildings.nearestEntrance(this.spot.x, this.spot.z, radius, kinds);
    if (!b) {
      const fallback = fallbackKinds(kinds);
      if (fallback.length > 0) b = buildings.nearestEntrance(this.spot.x, this.spot.z, radius, fallback);
    }
    return b && interiors.layout(b.id) ? b.id : -1;
  }

  /** True when an open scenario is bound to `buildingId` (no ambient occupants are spawned there). */
  ownsBuilding(buildingId: number): boolean {
    for (const rt of this.open) if (rt.buildingId === buildingId) return true;
    return false;
  }

  /** The building a call is bound to, -1 for none (or an unknown call). */
  buildingOf(callId: number): number {
    return this.byCall.get(callId)?.buildingId ?? -1;
  }

  /** Does participant `p` lie on the floor (the dead, the unconscious)? */
  private lies(rt: ScenarioRuntime, p: ScenarioRuntime['scenario']['participants'][number]): boolean {
    return p.deceased || /^subject(Deceased|Unconscious)$/.test(this.effectiveProfile(rt, p.role, p.profile));
  }

  private planScene(rt: ScenarioRuntime, layout: InteriorLayout): IndoorPlan {
    const sc = rt.scenario;
    const people = sc.participants.map((p) => ({
      index: p.index,
      role: p.role,
      spot: p.spot,
      lying: this.lies(rt, p),
      skip: p.body !== 'human' || p.personId < 0 || this.roleRemoved(rt, p.role),
    }));
    return planInterior(this.seed, sc.callId, layout, indoorFamily(this.indoor, sc.family), people);
  }

  /** Who the person on a placed item belongs to: the suspect's tools, the victim's blood, the dead person's pills. */
  private ownerFor(rt: ScenarioRuntime, item: string): number {
    const category = isItemId(item) ? itemDef(item).category : '';
    const roles = category === 'weapon' || category === 'tools' || category === 'property' ? ['suspect'] : category === 'drugs' ? ['deceased', 'subject'] : category === 'evidence' ? ['victim'] : [];
    for (const role of roles) {
      const p = rt.scenario.participants.find((x) => x.role === role && x.personId >= 0);
      if (p) return p.personId;
    }
    return -1;
  }

  private placeOne(rt: ScenarioRuntime, item: string, x: number, y: number, z: number, at: { buildingId: number; room: number; furniture: number; container: ScenePlaceItem['container']; concealed: boolean }): void {
    const ev = this.deps.evidence;
    if (!ev || !isItemId(item)) return;
    const def = itemDef(item);
    ev.placeItem({
      callId: rt.scenario.callId,
      item,
      label: def.label,
      x,
      y,
      z,
      buildingId: at.buildingId,
      room: at.room,
      furniture: at.furniture,
      container: at.container,
      concealed: at.concealed,
      ownerPersonId: this.ownerFor(rt, item),
      incriminating: def.weapon || def.contraband || def.category === 'evidence',
    });
  }

  /** Scenario ground evidence (at the door or the Phase 3 spots) and the indoor evidence of the plan, through the evidence port. */
  private placeEvidence(rt: ScenarioRuntime, layout: InteriorLayout | null, plan: IndoorPlan | null): void {
    const sc = rt.scenario;
    const exit = layout?.doors.find((d) => d.main)?.exit ?? null;
    for (const e of sc.evidence) {
      if (exit !== null) {
        // Just outside the door, side by side.
        const fx = -Math.sin(exit.yaw);
        const fz = -Math.cos(exit.yaw);
        const lateral = (e.spotIndex % 2 === 0 ? 1 : -1) * Math.ceil((e.spotIndex + 1) / 2) * 0.6;
        this.placeOne(rt, e.item, exit.x + fx + Math.cos(exit.yaw) * lateral, 0, exit.z + fz - Math.sin(exit.yaw) * lateral, { buildingId: -1, room: -1, furniture: -1, container: 'none', concealed: false });
      } else {
        spotPosition(this.deps.city.graph.edges, sc.anchor, e.spot, e.spotIndex, this.rng, this.spot);
        this.placeOne(rt, e.item, this.spot.x, 0, this.spot.z, { buildingId: -1, room: -1, furniture: -1, container: 'none', concealed: false });
      }
    }
    for (const it of plan?.items ?? []) {
      this.placeOne(rt, it.item, it.x, it.y, it.z, { buildingId: rt.buildingId, room: it.room, furniture: it.furniture, container: it.container, concealed: it.concealed });
    }
  }

  /** The main door starts locked or unlocked (design §12.2): `unitHash(seed, 0x51ce, callId) < doorLocked`, welfare no-answer branches always. */
  private lockMainDoor(rt: ScenarioRuntime, layout: InteriorLayout): void {
    const { interiors } = this.deps;
    const idx = mainDoor(layout);
    const door = layout.doors[idx];
    if (!interiors || !door || door.kind === 'wide') return;
    const sc = rt.scenario;
    const fam = indoorFamily(this.indoor, sc.family);
    const locked = lockRoll(this.seed, sc.callId, fam?.doorLocked ?? 0) || (sc.family === 'welfare' && (sc.branch === 'notHome' || sc.branch === 'deceased'));
    const want = locked ? 'locked' : 'closed';
    if (interiors.doorState(rt.buildingId, idx) !== want) interiors.setDoorState(rt.buildingId, idx, want);
  }

  /** Door pose for the n-th person at the bound building's main door; false when the call has no such door. */
  private doorPose(rt: ScenarioRuntime, n: number, out: { x: number; z: number; yaw: number }): boolean {
    const exit = rt.buildingId >= 0 ? this.deps.interiors?.layout(rt.buildingId)?.doors.find((d) => d.main)?.exit : undefined;
    if (!exit) return false;
    doorSlot(exit, n, out);
    return true;
  }

  /** Records an arrest (`custody:<role>`) with where the person was (the search-incident-to-arrest rules need the room). */
  private noteArrest(rt: ScenarioRuntime, role: string): void {
    const idx = rt.scenario.participants.findIndex((p) => p.role === role && p.personId >= 0);
    const p = rt.scenario.participants[idx];
    if (!p || rt.arrests.some((a) => a.personId === p.personId)) return;
    let building = -1;
    let room = -1;
    const id = rt.actorIds[idx] ?? 0;
    const info = id > 0 ? this.deps.npc.actor(id, this.info2) : null;
    if (info && (info.building ?? -1) >= 0) {
      building = info.building ?? -1;
      const layout = this.deps.interiors?.layout(building);
      if (layout) room = roomAt(layout, info.x, info.z);
    }
    rt.arrests.push({ personId: p.personId, buildingId: building, room, sim: this.time.sim });
    if (rt.arrests.length > 8) rt.arrests.shift();
  }

  /** The officer knocked on the bound building's door: a resident may answer in 4-10 s (the scene stream decides). */
  private noteKnock(rt: ScenarioRuntime, t: CadTime): void {
    if (rt.knockedSim < 0) rt.knockedSim = t.sim;
    this.setFlag(rt, 'knocked');
    if (rt.buildingId < 0 || rt.answerDueSim >= 0 || this.anyFlagPrefix(rt, 'answered:')) return;
    const [lo, hi] = this.cfg.indoor.knockAnswerS;
    rt.answerDueSim = t.sim + this.rng.nextFloat(lo, hi);
    this.rev++;
  }

  /** A resident who can answer walks to the door (the npc system moves them to the exit pose) and unlocks it. */
  private answerDoor(rt: ScenarioRuntime): void {
    rt.answerDueSim = -1;
    const { npc, interiors } = this.deps;
    const layout = interiors?.layout(rt.buildingId);
    if (!interiors || !layout || rt.flags.has('variant:false') || rt.flags.has('variant:swatting')) return;
    const mainIdx = mainDoor(layout);
    const sc = rt.scenario;
    let slot = sc.participants.filter((p) => p.spot === 'door' && !this.roleRemoved(rt, p.role)).length;
    let answered = 0;
    for (let i = 0; i < sc.participants.length; i++) {
      const p = sc.participants[i];
      const id = rt.actorIds[i] ?? 0;
      if (!p || id <= 0 || this.roleRemoved(rt, p.role) || NO_ANSWER_PROFILE.test(this.effectiveProfile(rt, p.role, p.profile))) continue;
      const info = npc.actor(id, this.info);
      if (!info || (info.building ?? -1) !== rt.buildingId || info.hidden || info.cuffed || info.state === ACTOR_STATE.lying) continue;
      if (!this.doorPose(rt, slot++, this.edgePt)) return;
      npc.setActorPosition(id, -1, this.edgePt.x, this.edgePt.z, this.edgePt.yaw);
      this.setFlag(rt, `answered:${p.role}`);
      answered++;
    }
    if (answered > 0 && mainIdx >= 0 && interiors.doorState(rt.buildingId, mainIdx) === 'locked') interiors.setDoorState(rt.buildingId, mainIdx, 'closed');
    this.rev++;
  }

  /** Exigent circumstances of the call (design §12.2). */
  private exigent(rt: ScenarioRuntime): boolean {
    if (EXIGENT_FAMILIES.has(rt.scenario.family)) return true;
    for (const f of rt.flags) if (EXIGENT_FLAGS.has(f) || f.startsWith('injury:') || f.startsWith('deceased:')) return true;
    return rt.scenario.family === 'welfare' && rt.knockedSim >= 0 && !this.anyFlagPrefix(rt, 'answered:') && this.time.sim - rt.knockedSim >= this.cfg.indoor.noAnswerExigencyS;
  }

  /** Implements `InvestigationPorts.callContext` (the integrator forwards it); null for a call without a scenario. */
  callContext(callId: number): SceneCallContext | null {
    const rt = this.byCall.get(callId);
    if (!rt) return null;
    const sc = rt.scenario;
    const suspect = sc.participants.find((p) => (p.role === 'suspect' || (sc.family === 'barricade' && p.role === 'subject')) && p.personId >= 0 && !this.roleRemoved(rt, p.role));
    return {
      exigency: this.exigent(rt),
      warrant: sc.typeId === 'warrantService',
      arrests: rt.arrests,
      buildingId: rt.buildingId,
      family: sc.family,
      suspectPersonId: suspect?.personId ?? -1,
      anchorX: sc.anchor.x,
      anchorZ: sc.anchor.z,
      k9: familyDef(sc.family)?.actions.includes('requestK9') ?? false,
    };
  }

  /**
   * `ContactDeps.premises` helper: the premises a scene person belongs to (the bound building, their authority over it
   * and the officer's room, -1 outdoors); null for a person who is on no bound call.
   */
  premises(personId: number): { buildingId: number; authority: boolean; room: number } | null {
    for (const rt of this.open) {
      if (rt.buildingId < 0) continue;
      const p = rt.scenario.participants.find((x) => x.personId === personId);
      if (!p) continue;
      let room = -1;
      if (this.officer.building === rt.buildingId) {
        const layout = this.deps.interiors?.layout(rt.buildingId);
        if (layout) room = roomAt(layout, this.officer.x, this.officer.z);
      }
      return { buildingId: rt.buildingId, authority: this.hasAuthority(rt, p.role), room };
    }
    return null;
  }

  private hasAuthority(rt: ScenarioRuntime, role: string): boolean {
    return AUTHORITY_ROLES.has(role) || (rt.scenario.family === 'domestic' && role === 'suspect');
  }

  /** A consent from the contact module: granted, free and from somebody with authority becomes the flag `consent:<kind>`. */
  private onConsent(e: Extract<QueuedEvent, { t: 'consent' }>): void {
    const rt = this.byCall.get(e.callId);
    if (!rt || !CONSENT_FLAG_KINDS.has(e.kind) || !e.granted || !e.valid) return;
    if (e.buildingId >= 0 && rt.buildingId >= 0 && e.buildingId !== rt.buildingId) return;
    const p = rt.scenario.participants.find((x) => x.personId === e.personId);
    const personal = e.kind === 'searchPerson' || e.kind === 'searchVehicle';
    if (!personal && !(p && this.hasAuthority(rt, p.role))) return;
    this.setFlag(rt, `consent:${e.kind}`);
  }

  /** The officer's level became the bound building: flag `entered` and the legal basis `entry:<basis>`. */
  private onEntered(rt: ScenarioRuntime, t: CadTime): void {
    this.setFlag(rt, 'entered');
    const layout = this.deps.interiors?.layout(rt.buildingId);
    if (!layout) return;
    const room = roomAt(layout, this.officer.x, this.officer.z);
    const consents: ConsentRecord[] = [];
    for (const kind of ['entry', 'searchPremises', 'searchRoom'] as const) {
      if (rt.flags.has(`consent:${kind}`)) {
        consents.push({ id: consents.length, personId: -1, kind, granted: true, valid: true, authority: true, buildingId: rt.buildingId, room, vehicleId: -1, sim: t.sim, revokedSim: -1 });
      }
    }
    const presence = lawfulPresence({
      buildingId: rt.buildingId,
      room,
      roomPublic: layout.rooms[room]?.public ?? false,
      businessOpen: !layout.residential && isOpenAt(layout.occupants.openHours, hourOf(t.game)),
      consents,
      exigency: this.exigent(rt),
      warrant: rt.scenario.typeId === 'warrantService',
      sim: t.sim,
    });
    const basis = !presence.lawful || presence.basis === null ? 'none' : presence.basis === 'invited' ? 'consent' : presence.basis;
    this.setFlag(rt, `entry:${basis}`);
  }

  /** `interior:door` (bridged by the integrator): a real knock on the bound door starts the answer, a breach sets `forcedEntry`. */
  onDoorEvent(e: SceneDoorEvent): void {
    if (e.by !== 'officer') return;
    for (const rt of this.open) {
      if (rt.buildingId < 0 || rt.buildingId !== e.buildingId) continue;
      if (e.action === 'breached') {
        this.setFlag(rt, 'forcedEntry');
      } else if (e.action === 'knock') {
        const layout = this.deps.interiors?.layout(rt.buildingId);
        if (layout && e.door === mainDoor(layout)) this.noteKnock(rt, this.time);
      }
    }
  }

  /** `investigation:*` topics (bridged by the integrator) become scene flags (design §12.2). */
  onInvestigation<T extends InvestigationTopic>(topic: T, payload: InvestigationPayloads[T]): void {
    const rt = this.byCall.get(payload.callId);
    if (!rt) return;
    switch (topic) {
      case 'investigation:photo':
        this.setFlag(rt, 'photographed');
        return;
      case 'investigation:collected':
        this.setFlag(rt, 'evidenceCollected');
        return;
      case 'investigation:canvass': {
        let hits = 0;
        for (const f of rt.flags) if (f.startsWith('canvassHit:')) hits++;
        this.setFlag(rt, `canvassHit:${hits + 1}`);
        if (hits + 1 >= this.cfg.indoor.canvassHits) this.setFlag(rt, 'canvassed');
        return;
      }
      case 'investigation:tape': {
        const e = payload as InvestigationPayloads['investigation:tape'];
        if (!e.closed || e.points.length < 6) return;
        const poly = Float32Array.from(e.points);
        const a = rt.scenario.anchor;
        const door = rt.buildingId >= 0 ? this.deps.interiors?.layout(rt.buildingId)?.doors.find((d) => d.main) : undefined;
        if (pointInPolygon(poly, a.x, a.z) || (door !== undefined && pointInPolygon(poly, door.x, door.z))) {
          this.setFlag(rt, 'perimeter');
          this.setFlag(rt, 'scenePreserved');
        }
        return;
      }
      case 'investigation:plainView':
        this.setFlag(rt, `plainView:${(payload as InvestigationPayloads['investigation:plainView']).itemId}`);
        return;
      case 'investigation:custodyComplete':
        this.setFlag(rt, 'custodyComplete');
        return;
      case 'investigation:k9Alert': {
        const e = payload as InvestigationPayloads['investigation:k9Alert'];
        if (e.kind !== 'person') return;
        if (e.actorId > 0) this.deps.npc.reveal(e.actorId);
        this.setFlag(rt, 'k9Indicated');
        return;
      }
    }
  }

  /** `npc:aware` (bridged by the integrator): a scene person noticed something, flag `aware:<role>`. */
  onNpcAware(e: SceneAwareEvent): void {
    const found = this.runtimeOfActor(e.actorId, e.personId, e.callId);
    const role = found ? (found.rt.scenario.participants[found.index]?.role ?? '') : '';
    if (found && role !== '') this.setFlag(found.rt, `aware:${role}`);
  }

  // --- Close / outcome ---------------------------------------------------------------------------------

  private onClosed(callId: number, disposition: string, t: CadTime): void {
    const rt = this.byCall.get(callId);
    if (!rt) {
      this.ignored.delete(callId);
      return;
    }
    const { cad } = this.deps;
    const call = cad.call(callId);
    const family = familyDef(rt.scenario.family);
    if (family) {
      const out = outcomeFor(family, rt.flags);
      const resolvedBy = call?.units.includes(this.pc) === true ? 'player' : 'ai';
      if (rt.materialized || resolvedBy === 'player') {
        // Cleared from the MDT without ever getting there: nothing was handled, whatever the hidden truth was.
        const absent = resolvedBy === 'player' && rt.arrivedSim < 0 && call?.selfInitiated !== true;
        const outcome: CallOutcome = {
          callId,
          number: call?.number ?? '',
          typeId: rt.scenario.typeId,
          family: rt.scenario.family,
          variants: [...rt.scenario.variants],
          branch: rt.scenario.branch,
          outcomeId: absent ? 'clearedWithoutResponding' : out.id,
          suggested: out.disposition,
          disposition,
          grade: absent ? 'bad' : out.grade,
          flags: [...rt.flags].sort(),
          materialized: rt.materialized,
          resolvedBy,
          createdSim: rt.createdSim,
          arrivedSim: rt.arrivedSim,
          closedSim: t.sim,
          forceUsed: [...rt.forceUsed],
        };
        if (rt.buildingId >= 0) {
          outcome.buildingId = rt.buildingId;
          outcome.entry = this.entryOf(rt);
        }
        if (this.deps.evidence) outcome.case = this.deps.evidence.summary(callId);
        this.closedList.push(outcome);
        if (this.closedList.length > this.cfg.limits.closedCap) this.closedList.shift();
        this.deps.bus.emit('scene:outcome', { outcome });
      }
    }
    this.dematerialize(rt);
    this.deps.evidence?.removeCallItems(callId);
    const idx = this.open.indexOf(rt);
    if (idx >= 0) this.open.splice(idx, 1);
    this.byCall.delete(callId);
    this.activity.delete(callId);
    this.farSince.delete(callId);
    // Calls this one stood in for (the player left them for a stop or pursuit) are resolved with it when nobody else took them.
    for (const ownerId of rt.mirror) {
      const owner = cad.call(ownerId);
      if (owner && owner.status !== 'closed' && owner.units.length === 0) cad.closeCall(ownerId, this.earnedDisposition(ownerId) ?? 'handled', t);
    }
    for (const other of this.open) {
      const m = other.mirror.indexOf(callId);
      if (m >= 0) other.mirror.splice(m, 1);
    }
    this.closePursuitsOf(callId, t);
    this.rev++;
  }

  // --- Actions -----------------------------------------------------------------------------------------

  private actionState(rt: ScenarioRuntime, id: string): ActionState | undefined {
    return rt.actions.find((a) => a.id === id);
  }

  /** Why the action cannot run now (null = may), with the same rules the panel shows. */
  private actionBlocked(rt: ScenarioRuntime, def: ActionDef): string | null {
    if (def.tool !== null && this.deps.evidence) return toolHint(def.tool);
    const st = this.actionState(rt, def.id);
    if (st && (st.state === 'running' || (def.once && (st.state === 'done' || st.state === 'requested')))) return st.state === 'running' ? 'In progress' : 'Already done';
    if (def.requires !== null && !evalCond(def.requires, this.flagsWithNear(rt))) return 'Not available yet';
    for (const [item, n] of Object.entries(def.consumes)) {
      if (this.deps.kit().carried(item) < n) return `Missing ${item}`;
    }
    const a = rt.scenario.anchor;
    if (dist(this.officer.x, this.officer.z, a.x, a.z) > this.cfg.distances.actionRangeM) return 'Too far from the scene';
    return null;
  }

  /** The flags; `near:` flags are maintained in the slow tick. */
  private flagsWithNear(rt: ScenarioRuntime): ReadonlySet<string> {
    return rt.flags;
  }

  private doAction(rt: ScenarioRuntime, actionId: string, t: CadTime): void {
    const family = familyDef(rt.scenario.family);
    if (!family || !family.actions.includes(actionId)) {
      this.flash('That action is not available here');
      return;
    }
    const def = actionDef(actionId);
    const why = this.actionBlocked(rt, def);
    if (why !== null) {
      this.flash(why);
      return;
    }
    const kit = this.deps.kit();
    for (const [item, n] of Object.entries(def.consumes)) {
      if (!kit.use(item, n)) {
        this.flash(`Missing ${item}`);
        return;
      }
    }
    const callId = rt.scenario.callId;
    const call = this.deps.cad.call(callId);
    const vars = { unit: this.pc, address: call?.location.text ?? '', near: call?.location.near ?? '' };
    let st = this.actionState(rt, def.id);
    if (!st) {
      st = { id: def.id, state: 'done', dueSim: -1 };
      rt.actions.push(st);
    }
    this.rev++;
    if (def.service !== null) {
      st.state = 'requested';
      this.requestService(rt, def.service, t);
    } else if (def.durationS > 0) {
      st.state = 'running';
      st.dueSim = t.sim + def.durationS;
    } else {
      this.finishAction(rt, def, t);
      st.state = 'done';
    }
    if (def.narrative !== null) this.addNarrative(callId, this.pc, fill(def.narrative, vars));
    if (def.radio !== null) this.radio(fill(def.radio, vars), this.pc);
    if (def.props !== null) this.layoutProps(rt, def);
    if (def.reveals !== null) this.revealParticipants(rt, def.reveals, false);
    if (def.command !== null) this.commandRoles(rt, def.command.command as NpcCommand, def.command.roles);
    if (def.opens !== null) this.openForm(rt, def.opens);
    if (def.once === false && st.state === 'done') {
      const i = rt.actions.indexOf(st);
      if (i >= 0) rt.actions.splice(i, 1);
    }
  }

  /** Sets the flags / effects of a finished action. */
  private finishAction(rt: ScenarioRuntime, def: ActionDef, t: CadTime): void {
    for (const f of def.sets) this.setFlag(rt, f);
    if (def.sets.includes('knocked')) this.noteKnock(rt, t);
    if (def.sets.includes('animalSecured')) this.removeAnimals(rt);
    if (def.id === 'collectEvidence') this.collectEvidence(rt, t);
  }

  private completeAction(rt: ScenarioRuntime, st: ActionState, t: CadTime): void {
    const def = actionDef(st.id);
    const a = rt.scenario.anchor;
    if (dist(this.officer.x, this.officer.z, a.x, a.z) > this.cfg.distances.actionRangeM) {
      this.cancelAction(rt, st);
      return;
    }
    this.finishAction(rt, def, t);
    if (def.once) {
      st.state = 'done';
      st.dueSim = -1;
    } else {
      const i = rt.actions.indexOf(st);
      if (i >= 0) rt.actions.splice(i, 1);
    }
    this.rev++;
  }

  private cancelAction(rt: ScenarioRuntime, st: ActionState): void {
    const i = rt.actions.indexOf(st);
    if (i >= 0) rt.actions.splice(i, 1);
    this.flash('Cancelled: you left the scene');
    this.rev++;
  }

  private layoutProps(rt: ScenarioRuntime, def: ActionDef): void {
    const props = def.props;
    if (props === null) return;
    const kind = PROP_BY_NAME[props.kind] ?? 0;
    if (kind === 0) return;
    const sc = rt.scenario;
    const edge = this.deps.city.graph.edges[sc.anchor.edge];
    const n = Math.max(1, props.count);
    for (let k = 0; k < n; k++) {
      if (props.pattern === 'ring') {
        const ang = (k / n) * Math.PI * 2;
        this.addProp(sc.anchor.x + Math.cos(ang) * props.radius, sc.anchor.z + Math.sin(ang) * props.radius, ang + Math.PI / 2, kind, sc.callId);
      } else if (props.pattern === 'line' && edge) {
        edgePoint(edge, sc.anchor.s + (k - (n - 1) / 2) * props.spacing, edgeLaterals(edge).S, sc.anchor.side, this.edgePt);
        this.addProp(this.edgePt.x, this.edgePt.z, this.edgePt.yaw, kind, sc.callId);
      } else {
        this.addProp(sc.anchor.x, sc.anchor.z, 0, kind, sc.callId);
      }
    }
  }

  /** `knock` / `searchArea`: reveals inside / hidden participants (hidden ones with 0.6 per person). */
  private revealParticipants(rt: ScenarioRuntime, what: 'inside' | 'hidden', all: boolean): void {
    const { npc } = this.deps;
    const ps = rt.scenario.participants;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const id = this.actorOfParticipant(rt, i);
      if (!p || id <= 0) continue;
      if (p.spot !== what) continue;
      if (what === 'hidden' && !all && this.rng.next() >= this.cfg.tactics.revealChance) continue;
      const info = npc.actor(id, this.info);
      if (!info || !info.hidden) continue;
      npc.reveal(id);
      this.setFlag(rt, `revealed:${p.role}`);
    }
  }

  private commandRoles(rt: ScenarioRuntime, cmd: NpcCommand, roles: readonly string[]): void {
    const { npc } = this.deps;
    const ps = rt.scenario.participants;
    const ctx: CommandContext = { tone: 'commanding', rapport: 0, commMode: 'verbal', weapon: this.weapon, backup: this.pres.backup, lights: this.pres.lights };
    let total = 0;
    let complied = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const id = this.actorOfParticipant(rt, i);
      if (!p || id <= 0 || !roles.includes(p.role)) continue;
      const outcome = npc.evaluateCommand(id, cmd, ctx);
      npc.applyCommand(id, cmd, outcome);
      total++;
      if (outcome === 'comply') complied++;
    }
    if (cmd === 'disperse' && total > 0 && complied / total >= this.cfg.tactics.disperseShare) this.setFlag(rt, 'crowdDispersed');
  }

  private openForm(rt: ScenarioRuntime, kind: 'citation' | 'report'): void {
    const sc = rt.scenario;
    let vehicleId = -1;
    let personId = -1;
    if (kind === 'citation') {
      const spec = sc.vehicles[0];
      if (spec) {
        vehicleId = spec.vehicleId;
        personId = ownerOfVehicle(this.seed, vehicleId);
      }
    }
    this.deps.bus.emit('scene:openForm', { kind, callId: sc.callId, personId, vehicleId });
  }

  private removeAnimals(rt: ScenarioRuntime): void {
    const ps = rt.scenario.participants;
    for (let i = 0; i < ps.length; i++) {
      const id = rt.actorIds[i] ?? 0;
      if (ps[i]?.body === 'dog' && id > 0) {
        this.deps.npc.removeActor(id);
        rt.actorIds[i] = 0;
      }
    }
    this.setFlag(rt, 'animalSecured');
  }

  /** Photographed ground evidence becomes finalized CAD evidence documents linked to the call. */
  private collectEvidence(rt: ScenarioRuntime, t: CadTime): void {
    const { cad } = this.deps;
    const call = cad.call(rt.scenario.callId);
    const document = (item: string): void => {
      const def = itemDef(item);
      try {
        const doc = cad.docs.create(
          'evidence',
          {
            description: def.label,
            category: def.category === 'weapon' ? 'weapon' : def.category === 'drugs' ? 'drugs' : 'other',
            foundAt: call?.location.text ?? '',
            custody: [{ game: t.game, action: 'collected', by: this.pc, note: 'Collected at the scene' }],
            callId: rt.scenario.callId,
          },
          t,
          this.pc,
        );
        cad.docs.finalize(doc.id, t);
      } catch {
        // An incomplete draft stays a draft; the officer can finish it in the MDT.
      }
    };
    // The props the scenario laid out are its evidence; any other evidence prop of the call was dropped by somebody
    // (a suspect's weapon) and is documented from what it is.
    const laid = new Map<number, number>();
    for (const e of rt.scenario.evidence) {
      if (!isItemId(e.item)) continue;
      document(e.item);
      const name = itemDef(e.item).prop;
      const kind = name !== null ? (PROP_BY_NAME[name] ?? 0) : 0;
      laid.set(kind, (laid.get(kind) ?? 0) + 1);
    }
    for (const p of this.propList) {
      if (p.callId !== rt.scenario.callId || !evidenceKind(p.kind)) continue;
      const n = laid.get(p.kind) ?? 0;
      if (n > 0) {
        laid.set(p.kind, n - 1);
        continue;
      }
      const def = ITEMS.find((it) => it.prop !== null && PROP_BY_NAME[it.prop] === p.kind);
      if (!def) continue;
      document(def.id);
      this.setFlag(rt, `itemFound:${def.id}`);
      if (def.weapon) this.setFlag(rt, 'weaponFound');
      else if (def.contraband) this.setFlag(rt, 'contrabandFound');
    }
    this.propList = this.propList.filter((p) => !(p.callId === rt.scenario.callId && evidenceKind(p.kind)));
    this.propsDirty = true;
  }

  // --- Services ----------------------------------------------------------------------------------------

  private requestService(rt: ScenarioRuntime, kind: ServiceKind, t: CadTime): void {
    const def = serviceDef(kind);
    const call = this.deps.cad.call(rt.scenario.callId);
    const vars = { unit: this.pc, address: call?.location.text ?? '', near: call?.location.near ?? '' };
    rt.services.push({
      kind,
      dueSim: t.sim + this.rng.nextFloat(def.arriveS[0], Math.max(def.arriveS[0], def.arriveS[1])),
      arrived: false,
      effectDueSim: -1,
      ackDueSim: t.sim + this.cfg.tactics.ackDelayS,
    });
    this.setFlag(rt, `service:${kind}`);
    this.radio(fill(def.radio, vars), this.pc);
    this.deps.bus.emit('scene:service', { callId: rt.scenario.callId, kind, phase: 'requested' });
  }

  private stepService(rt: ScenarioRuntime, s: ServiceState, t: CadTime): void {
    const def = serviceDef(s.kind as ServiceKind);
    const call = this.deps.cad.call(rt.scenario.callId);
    const vars = { unit: this.pc, address: call?.location.text ?? '', near: call?.location.near ?? '' };
    if (s.ackDueSim >= 0 && t.sim >= s.ackDueSim) {
      s.ackDueSim = -1;
      this.radio(fill(def.ack, vars), null);
    }
    if (!s.arrived && t.sim >= s.dueSim) {
      s.arrived = true;
      this.setFlag(rt, `arrived:${s.kind}`);
      for (const f of def.sets) this.setFlag(rt, f);
      this.radio(def.arrivedText, null);
      const st = this.actionState(rt, `request${s.kind.charAt(0).toUpperCase()}${s.kind.slice(1)}`);
      if (st) st.state = 'done';
      this.applyServiceEffect(rt, s, def.effect, t);
      this.deps.bus.emit('scene:service', { callId: rt.scenario.callId, kind: s.kind, phase: 'arrived' });
      this.rev++;
    }
    if (s.effectDueSim >= 0 && t.sim >= s.effectDueSim) {
      s.effectDueSim = -1;
      this.resolveBarricade(rt);
    }
  }

  private applyServiceEffect(rt: ScenarioRuntime, s: ServiceState, effect: string, t: CadTime): void {
    switch (effect) {
      case 'transportInjured':
        this.transportInjured(rt);
        return;
      case 'resolveBarricade':
        s.effectDueSim = t.sim + this.rng.nextFloat(this.cfg.tactics.standoffResolveS[0], this.cfg.tactics.standoffResolveS[1]);
        return;
      case 'revealHidden':
        // A bound call's K9 sweep (investigation module, started from `scene:service`) reveals the people itself.
        if (rt.buildingId >= 0) return;
        this.revealParticipants(rt, 'hidden', true);
        this.findEscaped(rt);
        return;
      case 'removeDeceased': {
        const ps = rt.scenario.participants;
        for (let i = 0; i < ps.length; i++) {
          const id = ps[i]?.deceased ? this.actorOfParticipant(rt, i) : 0;
          if (ps[i]?.deceased && id > 0) {
            this.deps.npc.removeActor(id);
            rt.actorIds[i] = 0;
          }
        }
        return;
      }
      case 'secureAnimal':
        this.removeAnimals(rt);
        return;
      case 'towVehicles':
        for (const v of rt.scenario.vehicles) {
          const stop = this.deps.cad.trafficStop;
          if (v.existing && stop && stop.outcome === 'active' && stop.vehicleId === v.vehicleId) continue;
          this.deps.traffic.removeVehicle(v.vehicleId);
        }
        return;
      default:
        return;
    }
  }

  private transportInjured(rt: ScenarioRuntime): void {
    const { npc, people } = this.deps;
    if (rt.flags.has('branch:refuses')) return;
    const ps = rt.scenario.participants;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (!p || p.personId < 0 || p.deceased || p.body !== 'human') continue;
      const profile = this.effectiveProfile(rt, p.role, p.profile);
      const injured = p.injured || rt.flags.has(`injury:${p.role}`) || INJURED_PROFILES.has(profile) || rt.flags.has('medicalEmergency');
      // A subject in crisis who is not running or fighting goes for a psychiatric evaluation, cuffed or not.
      const crisis = rt.scenario.family === 'crisis' && p.role === 'subject' && CRISIS_PROFILES.has(profile) && !rt.flags.has(`fled:${p.role}`) &&
        !rt.flags.has(`escaped:${p.role}`) && !rt.flags.has(`weaponDrawn:${p.role}`) && !rt.flags.has('attacked');
      if ((!injured && !crisis) || rt.flags.has(`transported:${p.role}`)) continue;
      if (!crisis && rt.flags.has(`custody:${p.role}`)) continue;
      let id = this.actorOfParticipant(rt, i);
      if (id <= 0) {
        // A seated patient steps out first so the stretcher can take them.
        const veh = p.vehicle >= 0 ? rt.scenario.vehicles[p.vehicle] : undefined;
        if (p.spot === 'vehicle' && veh) id = npc.stepOut(veh.vehicleId, Math.max(0, p.seat));
      }
      if (id > 0) npc.removeActor(id);
      rt.actorIds[i] = 0;
      people.setCustody(p.personId, 'hospital');
      this.setFlag(rt, `transported:${p.role}`);
    }
  }

  /** The tactical team ends a standoff: the subject comes out cuffed at the door, a hostage is freed. */
  private resolveBarricade(rt: ScenarioRuntime): void {
    const { npc, people, city } = this.deps;
    const sc = rt.scenario;
    for (let i = 0; i < sc.participants.length; i++) {
      const p = sc.participants[i];
      if (!p) continue;
      if (p.role === 'hostage') {
        this.setFlag(rt, `released:${p.role}`);
        continue;
      }
      const standoff = p.profile === 'barricaded' || this.effectiveProfile(rt, p.role, p.profile) === 'barricaded' || (sc.family === 'barricade' && p.role === 'subject');
      if (!standoff || p.personId < 0) continue;
      if (rt.flags.has(`custody:${p.role}`)) continue;
      const old = this.actorOfParticipant(rt, i);
      if (old > 0) npc.removeActor(old);
      // A bound call's subject comes out of the building's front door.
      if (!this.doorPose(rt, p.spotIndex, this.edgePt)) spotPosition(city.graph.edges, sc.anchor, 'door', p.spotIndex, this.rng, this.spot);
      else Object.assign(this.spot, { x: this.edgePt.x, z: this.edgePt.z, yaw: this.edgePt.yaw });
      const id = npc.spawnActor({
        personId: p.personId,
        x: this.spot.x,
        z: this.spot.z,
        yaw: this.spot.yaw,
        profile: 'suspectCalm',
        role: p.role,
        callId: sc.callId,
        hidden: false,
        body: 'human',
        weapon: null,
        vehicleId: -1,
      });
      rt.actorIds[i] = id;
      if (id > 0) {
        npc.forceState(id, 'handsUp');
        npc.cuff(id);
      }
      people.setCustody(p.personId, 'arrested');
      this.setFlag(rt, `custody:${p.role}`);
    }
  }

  /** K9: a suspect who got away is found with 0.5 (prone near the scene). */
  private findEscaped(rt: ScenarioRuntime): void {
    const { npc, city } = this.deps;
    const sc = rt.scenario;
    for (let i = 0; i < sc.participants.length; i++) {
      const p = sc.participants[i];
      if (!p || p.personId < 0 || !rt.flags.has(`escaped:${p.role}`)) continue;
      if (this.rng.next() >= this.cfg.tactics.foundEscapedChance) continue;
      spotPosition(city.graph.edges, sc.anchor, 'distance', p.spotIndex, this.rng, this.spot);
      const id = npc.spawnActor({
        personId: p.personId,
        x: this.spot.x,
        z: this.spot.z,
        yaw: this.spot.yaw,
        profile: 'suspectCalm',
        role: p.role,
        callId: sc.callId,
        hidden: false,
        body: 'human',
        weapon: null,
        vehicleId: -1,
      });
      if (id <= 0) continue;
      rt.actorIds[i] = id;
      npc.forceState(id, 'prone');
      this.delFlag(rt, `escaped:${p.role}`);
      this.setFlag(rt, `found:${p.role}`);
    }
  }

  // --- Requests (officer tactics, panel) ---------------------------------------------------------------

  private drainRequests(t: CadTime): void {
    const list = this.requests;
    this.requests = [];
    for (const r of list) {
      switch (r.kind) {
        case 'weapon':
          this.cycleWeapon();
          break;
        case 'fire':
          this.fire(r.dirX, r.dirZ);
          break;
        case 'tackle':
          this.tackle();
          break;
        case 'shout':
          this.shout();
          break;
        case 'action': {
          const rt = this.byCall.get(r.callId);
          if (rt) this.doAction(rt, r.actionId, t);
          break;
        }
        case 'clear':
          this.clear(r.callId, r.disposition);
          break;
      }
    }
  }

  /** The nearest visible actor within `maxDist` inside a cone around `yaw` (`coneCos` -1 = any direction); 0 when none. */
  private findActor(maxDist: number, yaw: number, coneCos: number): number {
    const { npc } = this.deps;
    const ids = npc.actorIds(this.actorIdsScratch);
    const hx = -Math.sin(yaw);
    const hz = -Math.cos(yaw);
    let best = 0;
    let bestD = maxDist;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] ?? 0;
      const info = npc.actor(id, this.info);
      if (!info || info.hidden || (info.building ?? -1) !== this.officer.building) continue;
      const dx = info.x - this.officer.x;
      const dz = info.z - this.officer.z;
      const d = Math.hypot(dx, dz);
      if (d > bestD) continue;
      if (coneCos > -1 && d > 1e-6 && (dx * hx + dz * hz) / d < coneCos) continue;
      best = id;
      bestD = d;
    }
    return best;
  }

  private cycleWeapon(): void {
    if (!this.officer.onFoot) {
      this.flash('Exit the vehicle to draw a weapon');
      return;
    }
    const avail = this.deps.weaponsAvailable?.() ?? { sidearm: true, taser: true };
    if (!avail.sidearm && !avail.taser) {
      if (this.weapon !== 'none') {
        this.weapon = 'none';
        this.pres.weapon = 'none';
        this.rev++;
      }
      this.flash('No weapon signed out (armory)');
      return;
    }
    // none -> sidearm -> taser -> none, skipping what is not signed out.
    let next: OfficerWeapon = this.weapon;
    for (let k = 0; k < 3; k++) {
      next = next === 'none' ? 'sidearm' : next === 'sidearm' ? 'taser' : 'none';
      if (next === 'none' || avail[next]) break;
    }
    this.weapon = next;
    this.pres.weapon = this.weapon;
    this.rev++;
    if (this.weapon === 'none') return;
    const id = this.findActor(this.cfg.distances.forceNearM, 0, -1);
    if (id <= 0) return;
    const info = this.deps.npc.actor(id, this.info2);
    if (!info) return;
    this.deps.bus.emit('force:used', { kind: this.weapon === 'sidearm' ? 'sidearmDrawn' : 'taserDrawn', personId: info.personId, callId: info.callId });
  }

  private fire(dirX: number, dirZ: number): void {
    const { npc, bus } = this.deps;
    if (this.weapon === 'sidearm') {
      this.flash('Firearm discharge is not modelled until Phase 5');
      bus.emit('force:used', { kind: 'sidearmFire', personId: -1, callId: this.playerRuntime()?.scenario.callId ?? 0 });
      return;
    }
    if (this.weapon !== 'taser') return;
    const range = NPC_CONFIG.actors.taserRangeM;
    const id = this.findActor(range, yawOf(dirX, dirZ), this.taserCone);
    if (id <= 0) {
      this.flash('No target in range');
      return;
    }
    const info = npc.actor(id, this.info2);
    if (!info) return;
    const d = dist(this.officer.x, this.officer.z, info.x, info.z);
    const personId = info.personId;
    const callId = info.callId;
    npc.taser(id, d);
    const rt = this.runtimeOfActor(id, personId, callId);
    if (rt) this.setFlag(rt.rt, 'forceUsed');
    bus.emit('force:used', { kind: 'taser', personId, callId });
  }

  private tackle(): void {
    const { npc, bus } = this.deps;
    const id = npc.tackle(this.officer.x, this.officer.z, this.officer.yaw, this.officer.building);
    if (id <= 0) {
      this.flash('Nobody in reach');
      return;
    }
    const info = npc.actor(id, this.info2);
    const personId = info?.personId ?? -1;
    const callId = info?.callId ?? 0;
    const found = this.runtimeOfActor(id, personId, callId);
    if (found) {
      const role = found.rt.scenario.participants[found.index]?.role ?? '';
      if (role !== '') this.setFlag(found.rt, `caught:${role}`);
      this.setFlag(found.rt, 'forceUsed');
    }
    bus.emit('force:used', { kind: 'tackle', personId, callId });
  }

  /** Context command to the nearest actor in front: fleeing -> stop, armed -> drop the weapon, weapon drawn -> hands up, else stop. */
  private shout(): void {
    const { npc, bus, people } = this.deps;
    const id = this.findActor(this.cfg.distances.shoutM, this.officer.yaw, this.shoutCone);
    if (id <= 0) return;
    const info = npc.actor(id, this.info2);
    if (!info) return;
    let cmd: NpcCommand = 'stop';
    let officerText = 'Police! Stop!';
    if (info.state === ACTOR_STATE.flee) {
      cmd = 'stop';
    } else if (info.armed || info.state === ACTOR_STATE.armed) {
      cmd = 'dropWeapon';
      officerText = 'Police! Drop the weapon!';
    } else if (this.weapon !== 'none') {
      cmd = 'handsUp';
      officerText = 'Police! Show me your hands!';
    }
    const ctx: CommandContext = { tone: 'shout', rapport: 0, commMode: 'verbal', weapon: this.weapon, backup: this.pres.backup, lights: this.pres.lights };
    const outcome = npc.evaluateCommand(id, cmd, ctx);
    npc.applyCommand(id, cmd, outcome);
    bus.emit('scene:line', { personId: -1, speaker: 'Officer', text: officerText, language: 'en' });
    if (info.personId >= 0 && info.body === 0) {
      const identity = people.identity(info.personId);
      const subject: SubjectProfile = {
        personId: info.personId,
        identity,
        intoxication: people.intoxication(info.personId),
        demeanor: behaviorOf(info.profile).demeanor,
        role: info.role,
        items: [],
        vehicleItems: [],
        vehicleOwnerId: -1,
        guilty: false,
        injured: false,
        inVehicle: false,
        restrained: info.cuffed,
      };
      const dctx = this.dialogueContext(info.personId);
      const line = commandLine(outcome, subject, dctx, this.rng);
      const english = identity.language.english === 'fluent';
      bus.emit('scene:line', { personId: info.personId, speaker: this.nameOf(info.personId), text: line.text, language: english ? 'en' : identity.language.label });
    }
  }

  private dialogueContext(personId: number): DialogueContext {
    const { people, city } = this.deps;
    const district = DISTRICT_NAMES[city.districtAt(this.officer.x, this.officer.z)] ?? '';
    const tone: Tone = 'aggressive';
    return {
      tone,
      commMode: 'verbal',
      hour: Math.floor((this.time.game % 86400) / 3600),
      officerName: 'Officer',
      presence: { lights: this.pres.lights, backup: this.pres.backup, weapon: this.weapon, uniform: true },
      history: people.officerHistory(personId),
      trust: trustOf(district),
      truth: { destination: '', origin: '', account: '', suspectWhereabouts: '', reason: '' },
      guardianPresent: false,
      interpreterAvailable: false,
    };
  }

  private clear(callId: number, disposition: string | null): void {
    const rt = this.byCall.get(callId);
    let d = disposition;
    if (d === null) {
      const family = rt ? familyDef(rt.scenario.family) : null;
      d = family && rt ? outcomeFor(family, rt.flags).disposition : 'handled';
    }
    this.deps.dispatcher.request(this.pc, { kind: 'clearCall', callId, disposition: d }, 'key');
  }

  // --- Derived scenes (traffic stops, field contacts) --------------------------------------------------

  private readonly carScratch = { lane: 0, s: 0, nextLane: 0, behavior: 0, desiredFactor: 1, headway: 0, lateral: 0, weaveAmp: 0, limitMph: 0, inJunction: false };

  /** What is true about the car and its driver (design §11.1 step 7). */
  private stopTruth(vehicleId: number): StopTruth {
    const { people, traffic } = this.deps;
    const occupants = this.deps.npc.occupantsOf(vehicleId);
    const driver = occupants[0] ?? -1;
    const out: StopTruth = { driver, stolen: false, wanted: false, dui: false, contraband: false, suspended: false, bac: 0 };
    if (vehicleId >= 0 && vehicleId < REGISTRY_POPULATION && !isFleetVehicleId(vehicleId)) {
      out.stolen = (plateFlags(this.seed, vehicleId) & PLATE_FLAG.stolen) !== 0;
    }
    if (driver < 0) return out;
    const identity = people.identity(driver);
    out.wanted = identity.wanted;
    out.bac = people.intoxication(driver).bac;
    const slot = traffic.slotOfVehicle(vehicleId);
    const duiBit = slot >= 0 && (traffic.inspect(slot, this.carScratch).behavior & BEHAVIOR.dui) !== 0;
    out.dui = out.bac >= 0.08 || duiBit;
    const status = identity.record.license.status;
    out.suspended = status === 'suspended' || status === 'revoked' || status === 'none';
    const carried = [...people.itemsOn(driver), ...(vehicleId < REGISTRY_POPULATION ? people.vehicleItems(vehicleId, driver) : [])];
    out.contraband = carried.some((it) => itemDef(it.item).contraband);
    return out;
  }

  private findSubjectRuntime(vehicleId: number): ScenarioRuntime | null {
    for (const rt of this.open) {
      if (rt.scenario.family === 'trafficStop' || rt.scenario.family === 'contact') continue;
      if (rt.scenario.vehicles.some((v) => v.vehicleId === vehicleId)) return rt;
    }
    return null;
  }

  /** Does call `callId` own the stopped vehicle (a scenario's subject car or a pursuit)? Dispatcher hook. */
  private ownsVehicle(callId: number, vehicleId: number): boolean {
    const rt = this.byCall.get(callId);
    return rt !== undefined && rt.scenario.vehicles.some((v) => v.vehicleId === vehicleId);
  }

  private onStopStarted(callId: number, vehicleId: number, t: CadTime): void {
    const { cad, npc, people } = this.deps;
    const existing = this.byCall.get(callId);
    if (existing) {
      this.setFlag(existing, 'vehicleStopped');
      return;
    }
    const call = cad.call(callId);
    const family = familyDef('trafficStop');
    if (!call || !family || this.ignored.has(callId)) return;
    const occupants = [...npc.occupantsOf(vehicleId)];
    const truth = this.stopTruth(vehicleId);
    let branch = 'clean';
    if (truth.stolen) branch = 'stolenVehicle';
    else if (truth.wanted) branch = 'wanted';
    else if (truth.dui) branch = 'dui';
    else if (truth.contraband) branch = 'contraband';
    else if (truth.suspended) branch = 'suspended';
    if (branch === 'dui' && truth.driver >= 0 && truth.bac < 0.08) people.ensureIntoxicated(truth.driver, 0.09 + this.rng.next() * 0.1);
    const owner = this.findSubjectRuntime(vehicleId);
    const rt = this.createRuntime(call, family, { existingVehicleId: vehicleId, given: occupants, derivedBranch: branch, materializeNow: true, mirror: owner ? [owner.scenario.callId] : [] }, t);
    this.setFlag(rt, 'vehicleStopped');
    if (owner) {
      cad.linkCalls(callId, owner.scenario.callId, t);
      this.setFlag(owner, 'vehicleStopped');
    }
  }

  private onNeedsCall(personId: number, x: number, z: number, incident: string, t: CadTime): void {
    const { cad, dispatcher, people, contact, city } = this.deps;
    for (const rt of this.open) if (rt.scenario.family === 'contact' && rt.scenario.participants.some((p) => p.personId === personId)) {
      contact.attachCall(incident, rt.scenario.callId, 'subject');
      return;
    }
    // Already working a call: the contact belongs to it (as a bystander) instead of pulling the officer off it.
    const busyWith = cad.unit(this.pc)?.callId ?? null;
    if (busyWith !== null && cad.call(busyWith)?.status !== 'closed') {
      contact.attachCall(incident, busyWith);
      return;
    }
    const family = familyDef('contact');
    if (!family) return;
    const identity = people.identity(personId);
    const carried = people.itemsOn(personId);
    let branch = 'clean';
    if (identity.wanted) branch = 'wanted';
    else if (carried.some((it) => itemDef(it.item).contraband)) branch = 'contraband';
    const desc = describePerson(identity);
    const near = city.graph.nearestEdge(x, z, 80, this.hitScratch);
    const street = near ? (city.graph.edges[near.edge]?.name ?? '') : '';
    const narrative = `Field contact with a ${desc.sex === 'M' ? 'male' : 'female'} ${desc.ageBand}${street !== '' ? ` on ${street}` : ''}.`;
    const call = dispatcher.openSelfInitiated('pedestrianStop', 4, { x, z }, narrative, t, [personId]);
    const rt = this.createRuntime(call, family, { existingVehicleId: -1, given: [personId], derivedBranch: branch, materializeNow: true, mirror: [] }, t);
    void rt;
    void cad;
    contact.attachCall(incident, call.id, 'subject');
  }

  private readonly hitScratch = { edge: -1, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 as 1 | -1 };

  // --- Pursuits ----------------------------------------------------------------------------------------

  private onPullingOver(vehicleId: number, t: CadTime): void {
    const { cad, traffic } = this.deps;
    if (vehicleId < 0 || isFleetVehicleId(vehicleId) || vehicleId >= REGISTRY_POPULATION) return;
    const owner = this.findSubjectRuntime(vehicleId);
    // A car that already led a pursuit gives up for good: it does not run again when it is stopped.
    if (owner && (owner.flags.has('pursuit') || owner.flags.has('pursuitEnded'))) return;
    let p: number;
    if (owner) {
      p = owner.scenario.vehicles.find((v) => v.vehicleId === vehicleId)?.flee ?? 0;
    } else {
      const tr = this.stopTruth(vehicleId);
      const f = this.cfg.ambientFlee;
      p = f.base + f.wanted * (tr.wanted ? 1 : 0) + f.stolen * (tr.stolen ? 1 : 0) + f.intoxicated * (tr.bac >= f.bacThreshold ? 1 : 0) + f.contraband * (tr.contraband ? 1 : 0);
    }
    const u = this.rng.next();
    if (u >= p) return;
    // A stop on top of another call is refused by dispatch (the car is let go), so nobody flees from it.
    const pu = cad.unit(this.pc);
    if (pu && pu.callId !== null) {
      const call = cad.call(pu.callId);
      const free = call !== null && (call.typeId === 'trafficStop' || this.ownsVehicle(pu.callId, vehicleId));
      if (!free) return;
    }
    if (!traffic.flee(vehicleId)) return;
    this.startVehiclePursuit(vehicleId, owner, t);
  }

  private startVehiclePursuit(vehicleId: number, owner: ScenarioRuntime | null, t: CadTime): void {
    const { dispatcher, npc, traffic, records, city, cad } = this.deps;
    const family = familyForType('vehiclePursuit');
    if (!family) return;
    const driver = npc.occupantsOf(vehicleId)[0] ?? -1;
    const plate = mountedPlate(this.seed, vehicleId).plate;
    const desc = vehicleDescription(records.registration(vehicleId));
    let x = this.officer.x;
    let z = this.officer.z;
    let dir = 'northbound';
    let street = 'the roadway';
    if (traffic.fleeState(vehicleId, this.fleeScratch)) {
      x = this.fleeScratch.x;
      z = this.fleeScratch.z;
      dir = compass(this.fleeScratch.yaw);
      street = city.graph.edges[this.fleeScratch.edge]?.name || street;
    }
    const narrative = `Pursuit of a ${desc}, plate ${plate}, ${dir} on ${street}.`;
    const call = dispatcher.openSelfInitiated('vehiclePursuit', 1, { x, z }, narrative, t, driver >= 0 ? [driver] : [], [vehicleId]);
    const rt = this.createRuntime(call, family, { existingVehicleId: vehicleId, given: driver >= 0 ? [driver] : [], derivedBranch: null, materializeNow: true, mirror: owner ? [owner.scenario.callId] : [] }, t);
    if (owner) cad.linkCalls(call.id, owner.scenario.callId, t);
    this.setFlag(rt, 'pursuit');
    this.setFlag(rt, 'fled:driver');
    this.radio(`${this.pc}, in pursuit of ${desc}, plate ${plate}, ${dir} on ${street}`, this.pc, true);
    dispatcher.request(this.pc, { kind: 'backup', code: 3 }, 'auto');
    this.pursuits.push({ kind: 'vehicle', callId: call.id, vehicleId, actorId: 0, startedSim: t.sim, announced: true });
    this.deps.bus.emit('scene:pursuit', { kind: 'vehicle', active: true, callId: call.id });
    this.rev++;
  }

  private onFleeEnded(vehicleId: number, reason: string, _x: number, _z: number, t: CadTime): void {
    const { traffic, npc } = this.deps;
    const pi = this.pursuits.findIndex((p) => p.kind === 'vehicle' && p.vehicleId === vehicleId);
    if (pi < 0) return;
    const pur = this.pursuits[pi];
    this.pursuits.splice(pi, 1);
    if (!pur) return;
    this.deps.bus.emit('scene:pursuit', { kind: 'vehicle', active: false, callId: pur.callId });
    const rt = this.byCall.get(pur.callId);
    this.rev++;
    if (!rt) return;
    this.setFlag(rt, 'pursuitEnded');
    if (reason === 'escaped') {
      this.setFlag(rt, 'pursuitLost');
      this.setFlag(rt, 'escaped:driver');
      this.radio(`${this.pc}, lost sight of the vehicle.`, this.pc);
      return;
    }
    this.setFlag(rt, 'vehicleStopped');
    if (reason === 'crashed') {
      const occ = npc.occupantsOf(vehicleId);
      const driverIdx = rt.scenario.participants.findIndex((p) => p.role === 'driver');
      for (let k = 0; k < occ.length; k++) {
        const id = npc.stepOut(vehicleId, k);
        if (id <= 0) continue;
        npc.setRole(id, k === 0 ? 'driver' : 'passenger', rt.scenario.callId);
        if (k === 0) {
          if (driverIdx >= 0) rt.actorIds[driverIdx] = id;
          npc.forceState(id, this.rng.next() < this.cfg.tactics.crashFootFleeChance ? 'flee' : 'handsUp');
        } else {
          npc.forceState(id, 'handsUp');
        }
      }
      return;
    }
    // gaveUp / stopped: the parked car becomes a stop (dispatch attaches it to this call).
    traffic.forceStop(vehicleId);
    void t;
  }

  private onFootPursuitStart(rt0: ScenarioRuntime | null, role0: string, actorId: number, personId: number, t: CadTime): void {
    const { npc, dispatcher, cad, city } = this.deps;
    if (this.pursuits.some((p) => p.kind === 'foot' && p.actorId === actorId)) return;
    const info = npc.actor(actorId, this.info);
    if (!info) return;
    let rt = rt0;
    const x = info.x;
    const z = info.z;
    const yaw = info.yaw;
    const desc = personId >= 0 ? describePerson(this.deps.people.identity(personId)) : null;
    if (!rt) {
      const pu = cad.unit(this.pc);
      const family = familyForType('footPursuit');
      if (!family || personId < 0 || (pu && pu.callId !== null)) return;
      const call = dispatcher.openSelfInitiated('footPursuit', 2, { x, z }, 'Foot pursuit in progress.', t, [personId]);
      rt = this.createRuntime(call, family, { existingVehicleId: -1, given: [personId], derivedBranch: null, materializeNow: true, mirror: [] }, t);
      role0 = 'driver';
      this.setFlag(rt, 'fled:driver');
    }
    const near = city.graph.nearestEdge(x, z, 80, this.hitScratch);
    const street = near ? (city.graph.edges[near.edge]?.name || 'the roadway') : 'the roadway';
    const who = desc ? `${desc.sex === 'M' ? 'male' : 'female'} in ${topPhrase(desc.top)}` : 'subject';
    this.radio(`${this.pc}, foot pursuit, ${who}, ${compass(yaw)} on ${street}`, this.pc, true);
    this.setFlag(rt, 'pursuit');
    void role0;
    this.pursuits.push({ kind: 'foot', callId: rt.scenario.callId, vehicleId: -1, actorId, startedSim: t.sim, announced: true });
    this.deps.bus.emit('scene:pursuit', { kind: 'foot', active: true, callId: rt.scenario.callId });
    this.rev++;
  }

  private endFootPursuit(actorId: number, _t: CadTime): void {
    for (let i = this.pursuits.length - 1; i >= 0; i--) {
      const p = this.pursuits[i];
      if (p && p.kind === 'foot' && p.actorId === actorId) {
        this.pursuits.splice(i, 1);
        this.deps.bus.emit('scene:pursuit', { kind: 'foot', active: false, callId: p.callId });
        const rt = this.byCall.get(p.callId);
        if (rt) this.setFlag(rt, 'pursuitEnded');
        this.rev++;
      }
    }
  }

  private closePursuitsOf(callId: number, _t: CadTime): void {
    for (let i = this.pursuits.length - 1; i >= 0; i--) {
      const p = this.pursuits[i];
      if (p && p.callId === callId) {
        this.pursuits.splice(i, 1);
        this.deps.bus.emit('scene:pursuit', { kind: p.kind, active: false, callId });
      }
    }
  }

  private fireAmbush(rt: ScenarioRuntime, _t: CadTime): void {
    const { npc } = this.deps;
    const sc = rt.scenario;
    for (let i = 0; i < sc.participants.length; i++) {
      const p = sc.participants[i];
      const id = this.actorOfParticipant(rt, i);
      if (!p || p.role !== 'ambusher' || id <= 0) continue;
      npc.reveal(id);
      npc.forceState(id, 'armed');
      npc.drawWeapon(id);
    }
    this.setFlag(rt, 'attacked');
    this.setFlag(rt, 'shotsFired');
    this.radio('Shots fired! Shots fired!', null, true);
    this.addNarrative(sc.callId, this.pc, 'Officer reports being fired upon');
  }

  // --- Slow update (4 Hz): presence, actor polling, pursuit HUD, prop cleanup ---------------------------

  private slowUpdate(t: CadTime): void {
    const { cad } = this.deps;
    this.updatePresence();
    for (const rt of this.open) {
      if (!rt.materialized) continue;
      this.pollRuntime(rt);
      if (rt.actions.length > 0) {
        const a = rt.scenario.anchor;
        if (dist(this.officer.x, this.officer.z, a.x, a.z) > this.cfg.distances.actionRangeM) {
          for (let i = rt.actions.length - 1; i >= 0; i--) {
            const st = rt.actions[i];
            if (st && st.state === 'running') this.cancelAction(rt, st);
          }
        }
      }
    }
    this.autoClearSelfInitiated(t);
    // A foot pursuit ends when the runner stops running (surrendered, obeyed, caged or gone).
    for (let i = this.pursuits.length - 1; i >= 0; i--) {
      const p = this.pursuits[i];
      if (!p || p.kind !== 'foot') continue;
      const runner = this.deps.npc.actor(p.actorId, this.info);
      if (!runner || runner.state !== ACTOR_STATE.flee) this.endFootPursuit(p.actorId, t);
    }
    // Pursuit HUD numbers.
    const last = this.pursuits[this.pursuits.length - 1];
    if (!last) {
      this.pursuitKind = 'none';
    } else if (last.kind === 'vehicle') {
      if (this.pursuitKind !== 'vehicle' || this.pursuitPlate === '' || this.pursuitVehicle !== last.vehicleId) {
        this.pursuitVehicle = last.vehicleId;
        this.pursuitPlate = mountedPlate(this.seed, last.vehicleId).plate;
        this.pursuitDesc = vehicleDescription(this.deps.records.registration(last.vehicleId));
      }
      this.pursuitKind = 'vehicle';
      this.pursuitDistance = this.deps.traffic.fleeState(last.vehicleId, this.fleeScratch)
        ? dist(this.fleeScratch.x, this.fleeScratch.z, this.officer.x, this.officer.z)
        : this.pursuitDistance;
    } else {
      this.pursuitKind = 'foot';
      const info = this.deps.npc.actor(last.actorId, this.info);
      if (info) this.pursuitDistance = dist(info.x, info.z, this.officer.x, this.officer.z);
    }
    // Props of closed calls go once the officer is far away.
    if (this.propList.length > 0) {
      let keep = 0;
      for (const p of this.propList) {
        if (this.byCall.has(p.callId) || p.callId === 0 || dist(p.x, p.z, this.officer.x, this.officer.z) <= this.cfg.distances.propClearM) this.propList[keep++] = p;
      }
      if (keep !== this.propList.length) {
        this.propList.length = keep;
        this.propsDirty = true;
      }
    }
    let materialized = 0;
    for (const rt of this.open) if (rt.materialized) materialized++;
    this.statsValue.scenarios = this.open.length;
    this.statsValue.materialized = materialized;
    void cad;
    void t;
  }

  private pursuitVehicle = -1;

  /**
   * Field contacts and pursuits the player opened themselves have no dispatcher behind them: clear them once the
   * contact ended (released or warned, nobody in custody), a pursuit ended without a stop, the officer walked
   * away, or nothing happened for a long time. A running stop or pursuit keeps its call.
   */
  private autoClearSelfInitiated(t: CadTime): void {
    const { cad } = this.deps;
    const stop = cad.trafficStop;
    for (const rt of this.open.slice()) {
      const id = rt.scenario.callId;
      const call = cad.call(id);
      if (!call || call.status === 'closed' || !call.selfInitiated || !call.units.includes(this.pc)) continue;
      if (stop && stop.callId === id && stop.outcome === 'active') {
        this.activity.set(id, t.sim);
        continue;
      }
      if (this.pursuits.some((p) => p.callId === id)) {
        this.activity.set(id, t.sim);
        this.farSince.delete(id);
        continue;
      }
      const last = this.activity.get(id);
      if (last === undefined) {
        this.activity.set(id, t.sim);
        continue;
      }
      const a = rt.scenario.anchor;
      let far = this.farSince.get(id);
      if (dist(this.officer.x, this.officer.z, a.x, a.z) > SELF_FAR_M) {
        far ??= t.sim;
        this.farSince.set(id, far);
      } else {
        far = undefined;
        this.farSince.delete(id);
      }
      let done = t.sim - last >= SELF_IDLE_CLEAR_S || (far !== undefined && t.sim - far >= SELF_FAR_CLEAR_S);
      if (!done && rt.scenario.family === 'contact') {
        done = (this.anyFlagPrefix(rt, 'released:') || this.anyFlagPrefix(rt, 'warned:')) && !this.anyFlagPrefix(rt, 'custody:') && !this.anyFlagPrefix(rt, 'caged:');
      }
      if (!done && rt.flags.has('pursuitEnded') && t.sim - last >= SELF_PURSUIT_OVER_S) done = true;
      if (done) this.clear(id, null);
    }
  }

  private updatePresence(): void {
    const { cad } = this.deps;
    let lights = false;
    let siren = false;
    for (const car of this.deps.patrolCars()) {
      if (!car.lightbar && !car.siren) continue;
      if (dist(Transform.x[car.eid] ?? 0, Transform.z[car.eid] ?? 0, this.officer.x, this.officer.z) > this.cfg.distances.lightsM) continue;
      if (car.lightbar) lights = true;
      if (car.siren) siren = true;
    }
    let backup = 0;
    const pu = cad.unit(this.pc);
    if (pu && pu.callId !== null) {
      for (const u of cad.units()) {
        if (u.kind !== 'ai' || u.status !== 'onScene' || u.callId !== pu.callId) continue;
        if (dist(u.x, u.z, this.officer.x, this.officer.z) <= this.cfg.distances.backupM) backup++;
      }
    }
    const p = this.pres;
    if (p.lights !== lights || p.siren !== siren || p.backup !== backup || p.weapon !== this.weapon) {
      p.lights = lights;
      p.siren = siren;
      p.backup = backup;
      p.weapon = this.weapon;
      this.rev++;
    }
  }

  /** `near:` / `found:` / `detained:` / `weaponDrawn:` flags from the live actors of a materialized scene. */
  private pollRuntime(rt: ScenarioRuntime): void {
    const { npc } = this.deps;
    const ps = rt.scenario.participants;
    const nearRoles: string[] = [];
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const id = this.actorOfParticipant(rt, i);
      if (!p || id <= 0) continue;
      const info = npc.actor(id, this.info);
      if (!info) {
        rt.actorIds[i] = 0;
        continue;
      }
      if (!info.hidden && (info.building ?? -1) === this.officer.building && dist(info.x, info.z, this.officer.x, this.officer.z) <= this.cfg.distances.nearM) nearRoles.push(p.role);
      const st = info.state;
      if (st === ACTOR_STATE.handsUp || st === ACTOR_STATE.kneel || st === ACTOR_STATE.prone || st === ACTOR_STATE.down) this.setFlag(rt, `detained:${p.role}`);
      if (info.weaponDrawn) this.setFlag(rt, `weaponDrawn:${p.role}`);
    }
    const seen = new Set<string>();
    for (const p of ps) {
      if (seen.has(p.role)) continue;
      seen.add(p.role);
      if (nearRoles.includes(p.role)) {
        this.setFlag(rt, `near:${p.role}`);
        this.setFlag(rt, `found:${p.role}`);
      } else {
        this.delFlag(rt, `near:${p.role}`);
      }
    }
  }

  // --- Incidents (contact) -----------------------------------------------------------------------------

  resolveIncident(personId: number, _target: ContactTarget): IncidentInfo | null {
    let hit: { rt: ScenarioRuntime; index: number } | null = null;
    const prefer = this.playerRuntime();
    const scan = (rt: ScenarioRuntime): void => {
      if (hit) return;
      const ps = rt.scenario.participants;
      for (let i = 0; i < ps.length; i++) if (ps[i]?.personId === personId) hit = { rt, index: i };
    };
    if (prefer) scan(prefer);
    for (const rt of this.open) scan(rt);
    const found = hit as { rt: ScenarioRuntime; index: number } | null;
    if (!found) return this.witnessIncident(personId);
    const { rt, index } = found;
    const p = rt.scenario.participants[index];
    if (!p) return null;
    const { cad, people } = this.deps;
    const call = cad.call(rt.scenario.callId);
    const vehicleId = this.vehicleIdOf(rt, p.vehicle);
    const stop = cad.trafficStop;
    const stopActive = stop !== null && stop.outcome === 'active' && vehicleId >= 0 && stop.vehicleId === vehicleId;
    return {
      key: call?.number ?? `C-${String(rt.scenario.callId).padStart(5, '0')}`,
      callId: rt.scenario.callId,
      role: p.role,
      truth: this.truthFor(rt, p.personId, call?.nature ?? ''),
      guilty: this.guiltyOf(rt, p, people.identity(p.personId)),
      vehicleId,
      stop: stopActive,
    };
  }

  /** Canvass witnesses (Phase 4): neighbours who may have seen something on call `callId`; not saved. */
  addWitness(callId: number, personId: number): void {
    this.witnesses.set(personId, callId);
  }

  private witnessIncident(personId: number): IncidentInfo | null {
    const callId = this.witnesses.get(personId);
    const rt = callId === undefined ? undefined : this.byCall.get(callId);
    if (callId === undefined || !rt) return null;
    const call = this.deps.cad.call(callId);
    return {
      key: call?.number ?? `C-${String(callId).padStart(5, '0')}`,
      callId,
      role: 'witness',
      truth: this.truthFor(rt, personId, call?.nature ?? ''),
      guilty: false,
      vehicleId: -1,
      stop: false,
    };
  }

  private truthFor(rt: ScenarioRuntime, personId: number, nature: string): IncidentInfo['truth'] {
    const h = hash3(this.seed ^ rt.scenario.callId, SALT_TRUTH, personId);
    const list = (key: string): string => {
      const values = RESPONSES.values.get(key) ?? [];
      return values.length > 0 ? (values[(h >>> (key.length % 8)) % values.length] ?? '') : '';
    };
    const family = rt.scenario.family;
    const reason = family === 'trafficStop' ? 'a traffic stop' : family === 'contact' ? 'a field check' : `the report of ${nature.toLowerCase() || 'an incident'}`;
    const truth: IncidentInfo['truth'] = {
      destination: list('destination'),
      origin: list('origin'),
      account: list('account'),
      suspectWhereabouts: list('suspectWhereabouts'),
      reason,
    };
    // Bound calls name their suspect (consent to enter / search is less likely from the person under suspicion).
    if (rt.buildingId >= 0 && rt.scenario.participants.some((p) => p.personId === personId && (p.role === 'suspect' || (family === 'barricade' && p.role === 'subject')))) {
      return { ...truth, suspect: true };
    }
    return truth;
  }

  /** Has a motive to lie: a suspect-like role, a wanted person, contraband, an impaired driver or a stolen car. */
  private guiltyOf(rt: ScenarioRuntime, p: ScenarioRuntime['scenario']['participants'][number], identity: NpcIdentity): boolean {
    if (/^suspect|^ambusher|^barricaded/.test(p.profile)) return true;
    if (identity.wanted) return true;
    const items = this.deps.people.itemsOn(p.personId);
    if (items.some((it) => itemDef(it.item).contraband || CONTRABAND_ITEM_IDS.includes(it.item))) return true;
    if (p.role === 'driver' && this.deps.people.intoxication(p.personId).bac >= 0.08) return true;
    return rt.flags.has('branch:stolenVehicle') && p.role === 'driver';
  }

  // --- HUD and panel -----------------------------------------------------------------------------------

  private title(rt: ScenarioRuntime): string {
    const call = this.deps.cad.call(rt.scenario.callId);
    return call ? `${call.number} P${call.priority} ${call.nature}` : `C-${rt.scenario.callId}`;
  }

  hud(): SceneHud {
    let scene: SceneHud['scene'] = null;
    const rt = this.playerRuntime();
    if (rt && rt.materialized) {
      const a = rt.scenario.anchor;
      const family = familyDef(rt.scenario.family);
      if (family && dist(this.officer.x, this.officer.z, a.x, a.z) <= this.cfg.distances.hudM) {
        scene = { title: this.title(rt), objectives: objectivesFor(family, rt.flags) };
      }
    }
    let pursuit: string | null = null;
    if (this.pursuitKind === 'vehicle') pursuit = `PURSUIT ${this.pursuitPlate} · ${this.pursuitDesc} · ${Math.round(this.pursuitDistance)} m`;
    else if (this.pursuitKind === 'foot') pursuit = `FOOT PURSUIT · ${Math.round(this.pursuitDistance)} m`;
    return { scene, pursuit };
  }

  panelModel(callId: number): ActionPanelModel | null {
    const rt = this.byCall.get(callId);
    const family = rt ? familyDef(rt.scenario.family) : null;
    if (!rt || !family) return null;
    const open = objectivesFor(family, rt.flags).find((o) => !o.done);
    const options: PanelOption[] = [];
    for (const id of family.actions) {
      const def = actionDef(id);
      const st = this.actionState(rt, id);
      const blocked = this.actionBlocked(rt, def);
      let detail: string | undefined;
      if (def.tool !== null && this.deps.evidence) {
        // Done with the investigation tools: the row is a hint until the tool set its flags.
        detail = def.sets.length > 0 && def.sets.every((f) => rt.flags.has(f)) ? 'Done' : toolHint(def.tool);
        options.push({ label: def.label, detail, enabled: false });
        continue;
      }
      if (st?.state === 'running') detail = `In progress ${Math.max(0, Math.ceil(st.dueSim - this.time.sim))} s`;
      else if (st?.state === 'requested') detail = 'Requested';
      else if (st?.state === 'done') detail = def.service !== null ? 'On scene' : 'Done';
      options.push({ label: def.label, detail, enabled: blocked === null });
    }
    const suggested = outcomeFor(family, rt.flags).disposition;
    options.push({ label: `Clear call - ${dispositionLabel(suggested)} (suggested)`, enabled: true });
    options.push({ label: 'Clear call - choose disposition in MDT', enabled: true });
    return { title: this.title(rt), subtitle: open?.text, options };
  }

  panelSelect(callId: number, index: number): void {
    const rt = this.byCall.get(callId);
    const family = rt ? familyDef(rt.scenario.family) : null;
    if (!rt || !family) return;
    const n = family.actions.length;
    if (index >= 0 && index < n) {
      const id = family.actions[index];
      if (id !== undefined) this.request({ kind: 'action', callId, actionId: id });
    } else if (index === n) {
      this.request({ kind: 'clear', callId, disposition: null });
    } else if (index === n + 1) {
      this.flash('Open the MDT to choose a disposition');
    }
  }

  // --- Persistence -------------------------------------------------------------------------------------

  serialize(): SceneSave {
    const scenarios: SceneScenarioSave[] = this.open.map((rt) => ({
      scenario: structuredClone(rt.scenario),
      flags: [...rt.flags],
      createdSim: rt.createdSim,
      materialized: rt.materialized,
      actorIds: [...rt.actorIds],
      timelineIdx: rt.timelineIdx,
      arrivedSim: rt.arrivedSim,
      actions: rt.actions.map((a) => ({ ...a })),
      services: rt.services.map((s) => ({ ...s })),
      ambushArmed: rt.ambushArmed,
      forceUsed: [...rt.forceUsed],
      mirror: [...rt.mirror],
      ...(rt.buildingId >= 0 ? { buildingId: rt.buildingId } : {}),
      ...(rt.hideSpots.some((h) => h >= 0) ? { hideSpots: [...rt.hideSpots] } : {}),
      ...(rt.knockedSim >= 0 ? { knockedSim: rt.knockedSim } : {}),
      ...(rt.answerDueSim >= 0 ? { answerDueSim: rt.answerDueSim } : {}),
      ...(rt.arrests.length > 0 ? { arrests: rt.arrests.map((a) => ({ ...a })) } : {}),
    }));
    const empty = emptySceneSave(this.rng.state());
    return {
      ...empty,
      officerWeapon: this.weapon,
      scenarios,
      closed: structuredClone(this.closedList),
      props: this.propList.map((p) => ({ ...p })),
      pursuits: this.pursuits.map((p) => ({ ...p })),
      queue: structuredClone(this.requests),
      eventQueue: structuredClone(this.events),
      ignored: [...this.ignored].sort((a, b) => a - b),
      slowTick: this.slowTick,
    };
  }

  /** Restores the scene (after cad, people, npc and traffic restore); scenarios whose call is gone are dropped. */
  restore(save: SceneSave, t: CadTime): void {
    if (!isSceneSave(save)) return;
    this.time = t;
    this.rng.restore(save.rng);
    this.open.length = 0;
    this.byCall.clear();
    this.ignored.clear();
    this.forced.clear();
    this.weapon = save.officerWeapon;
    for (const s of save.scenarios) {
      const call = this.deps.cad.call(s.scenario.callId);
      if (!call || call.status === 'closed') continue;
      const rt: ScenarioRuntime = {
        scenario: structuredClone(s.scenario),
        flags: new Set(s.flags),
        createdSim: s.createdSim,
        materialized: s.materialized,
        actorIds: [...s.actorIds],
        timelineIdx: s.timelineIdx,
        arrivedSim: s.arrivedSim,
        actions: s.actions.map((a) => ({ ...a })),
        services: s.services.map((x) => ({ ...x, ackDueSim: x.ackDueSim ?? -1 })),
        ambushArmed: s.ambushArmed,
        forceUsed: [...s.forceUsed],
        mirror: [...(s.mirror ?? [])],
        buildingId: s.buildingId ?? -1,
        hideSpots: s.hideSpots ? [...s.hideSpots] : s.scenario.participants.map(() => -1),
        knockedSim: s.knockedSim ?? -1,
        answerDueSim: s.answerDueSim ?? -1,
        arrests: (s.arrests ?? []).map((a) => ({ ...a })),
      };
      // Hidden actors keep their reserved hiding spot across a load (claims are not part of the interior save).
      rt.hideSpots.forEach((h, i) => {
        if (h >= 0 && rt.buildingId >= 0 && (rt.actorIds[i] ?? 0) > 0) this.deps.interiors?.claimHideSpot?.(rt.buildingId, h);
      });
      this.open.push(rt);
      this.byCall.set(rt.scenario.callId, rt);
    }
    for (const id of save.ignored ?? []) this.ignored.add(id);
    this.closedList = structuredClone(save.closed).slice(-this.cfg.limits.closedCap);
    this.propList = save.props.map((p) => ({ ...p })).slice(-this.cfg.limits.propCap);
    this.propsDirty = true;
    this.pursuits = save.pursuits.filter((p) => this.byCall.has(p.callId)).map((p) => ({ ...p }));
    this.requests = structuredClone(save.queue);
    this.events = structuredClone(save.eventQueue).filter(isQueuedEvent);
    this.slowTick = save.slowTick ?? -1;
    this.pursuitKind = 'none';
    this.pursuitPlate = '';
    this.pursuitVehicle = -1;
    this.rev++;
  }
}

// --- Module helpers --------------------------------------------------------------------------------------

const DISPOSITION_LABELS: Readonly<Record<string, string>> = {};

function dispositionLabel(id: string): string {
  return Object.hasOwn(DISPOSITION_LABELS, id) ? (DISPOSITION_LABELS[id] ?? id) : labelOf(id);
}

function labelOf(id: string): string {
  return id.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
}

/** The row text of an action that is done with an investigation tool. */
function toolHint(tool: ToolKind): string {
  return tool === 'camera' ? 'Use the camera (O)' : 'Use the tools (I)';
}

function familyAnchorIsStreet(familyId: string): boolean {
  return familyDef(familyId)?.anchor === 'street';
}

/** Prop kinds that come from evidence items (bottle .. note). */
function evidenceKind(kind: number): boolean {
  return kind >= (PROP_BY_NAME.bottle ?? 5);
}

/**
 * The scripted first three draws of a scenario build (exclusive group, duplicate, escalation) that make
 * `pickVariants` return `forced` where the type's multipliers allow it; unforced kinds are switched off.
 */
export function scriptFor(forced: readonly VariantKind[], mult: Readonly<Record<VariantKind, number>>): number[] {
  const r = CALL_CATALOG.variants.rates;
  const pFalse = r.false * mult.false;
  const pSwat = r.swatting * mult.swatting;
  const pAmbush = r.ambush * mult.ambush;
  const pEsc = r.escalation * mult.escalation;
  const pDe = r.deescalation * mult.deescalation;
  const off = 0.999999;
  let uEx = off;
  if (forced.includes('false') && pFalse > 0) uEx = pFalse / 2;
  else if (forced.includes('swatting') && pSwat > 0) uEx = pFalse + pSwat / 2;
  else if (forced.includes('ambush') && pAmbush > 0) uEx = pFalse + pSwat + pAmbush / 2;
  const uDup = forced.includes('duplicate') && r.duplicate * mult.duplicate > 0 ? 0 : off;
  let uEsc = off;
  if (forced.includes('escalation') && pEsc > 0) uEsc = 0;
  else if (forced.includes('deescalation') && pDe > 0) uEsc = pEsc + pDe / 2;
  return [uEx, uDup, uEsc];
}

