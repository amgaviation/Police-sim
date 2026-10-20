/**
 * Scene save block (Phase 3 design §11.9, §16; frozen after Phase 3): plain JSON, version 1. Everything that
 * drives a future decision is here (the stream state, scenarios with their hidden truth and live flags,
 * closed outcomes, props, pursuits, queued requests and bus events) so a restored game continues exactly.
 */
import type { Scenario } from '../calls';
import { GRADES, SPOTS, VARIANT_KINDS } from '../calls/types';
import type { RngState } from '../core/rng';
import type { ActionState, CallOutcome, OfficerWeapon, SceneArrest, SceneRequest, ServiceState } from './types';

export interface SceneScenarioSave {
  scenario: Scenario;
  flags: string[];
  createdSim: number;
  materialized: boolean;
  actorIds: number[];
  timelineIdx: number;
  arrivedSim: number;
  actions: ActionState[];
  services: SceneServiceSave[];
  ambushArmed: boolean;
  forceUsed: string[];
  /** Call ids whose scenarios receive this one's pursuit and driver flags (absent: none). */
  mirror?: number[];
  /** Phase 4: the building the call is bound to (absent: -1, outdoors). */
  buildingId?: number;
  /** Phase 4: hiding spot per participant (absent: none). */
  hideSpots?: number[];
  /** Phase 4: sim second of the knock / of the pending answer (absent: -1). */
  knockedSim?: number;
  answerDueSim?: number;
  /** Phase 4: arrests made on the call (absent: none). */
  arrests?: SceneArrest[];
}

/** A requested service; `ackDueSim` is absent in saves of the bare design shape (no pending acknowledgement). */
export type SceneServiceSave = Omit<ServiceState, 'ackDueSim'> & { ackDueSim?: number };

export interface ScenePropSave {
  x: number;
  y: number;
  z: number;
  yaw: number;
  kind: number;
  callId: number;
}

export interface ScenePursuitSave {
  kind: 'vehicle' | 'foot';
  callId: number;
  vehicleId: number;
  actorId: number;
  startedSim: number;
  announced: boolean;
  /** Phase 5, optional when reading: the call the pursuit came from (absent = 0). */
  ownerCallId?: number;
  /** Phase 5, optional when reading: the pursued driver or runner (absent = -1). */
  personId?: number;
}

export interface SceneSave {
  version: 1;
  rng: RngState;
  officerWeapon: OfficerWeapon;
  scenarios: SceneScenarioSave[];
  closed: CallOutcome[];
  props: ScenePropSave[];
  pursuits: ScenePursuitSave[];
  queue: SceneRequest[];
  /** Queued bus events (module-defined plain data). */
  eventQueue: unknown[];
  /** Calls the scene never builds a scenario for (linked duplicates); absent: none. */
  ignored?: number[];
  /** Quarter-second tick of the last slow update; absent: -1. */
  slowTick?: number;
}

/** An empty save with the given scene stream state (used by the v4 -> v5 migration). */
export function emptySceneSave(rngState: RngState): SceneSave {
  return {
    version: 1,
    rng: { seed: rngState.seed, s: [...rngState.s] as RngState['s'] },
    officerWeapon: 'none',
    scenarios: [],
    closed: [],
    props: [],
    pursuits: [],
    queue: [],
    eventQueue: [],
    ignored: [],
    slowTick: -1,
  };
}

// --- Validation -----------------------------------------------------------------------------------------

type Obj = Record<string, unknown>;

function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}
function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}
function isInt(x: unknown, min = -Number.MAX_SAFE_INTEGER): x is number {
  return typeof x === 'number' && Number.isSafeInteger(x) && x >= min;
}
function isStr(x: unknown): x is string {
  return typeof x === 'string';
}
function isBool(x: unknown): x is boolean {
  return typeof x === 'boolean';
}
function isOneOf<T extends string>(x: unknown, options: readonly T[]): x is T {
  return typeof x === 'string' && (options as readonly string[]).includes(x);
}
function isArrayOf<T>(x: unknown, item: (v: unknown) => v is T): x is T[] {
  return Array.isArray(x) && x.every((v) => item(v));
}
function isStrArray(x: unknown): x is string[] {
  return isArrayOf(x, isStr);
}
function isRngState(x: unknown): x is RngState {
  return isObj(x) && isInt(x.seed, 0) && Array.isArray(x.s) && x.s.length === 4 && x.s.every((v) => isInt(v, 0) && v < 2 ** 32);
}
function isAnchor(x: unknown): boolean {
  return isObj(x) && isNum(x.x) && isNum(x.z) && isInt(x.edge, -1) && isNum(x.s) && (x.side === 1 || x.side === -1);
}
function isParticipant(x: unknown): boolean {
  if (!isObj(x)) return false;
  const i = x.intoxication;
  return isInt(x.index, 0) && isStr(x.role) && isInt(x.personId, -1) && isStr(x.profile) && isOneOf(x.spot, SPOTS) && isInt(x.spotIndex, 0) &&
    isStrArray(x.items) && (x.weapon === null || isStr(x.weapon)) && (i === null || (isObj(i) && isNum(i.bac) && isStr(i.drug))) &&
    isBool(x.injured) && isBool(x.deceased) && (x.body === 'human' || x.body === 'dog') && isInt(x.vehicle, -1) && isInt(x.seat, -1);
}
function isVehicleSpec(x: unknown): boolean {
  return isObj(x) && isInt(x.index, 0) && isStr(x.role) && isInt(x.vehicleId, 0) && isOneOf(x.mode, ['driving', 'parked', 'crashed'] as const) &&
    (x.behavior === 'normal' || x.behavior === 'dui') && isNum(x.flee) && isBool(x.reported) && isBool(x.existing);
}
function isTimelineEntry(x: unknown): boolean {
  return isObj(x) && isNum(x.atS) && isStr(x.kind) && isStr(x.text) && isNum(x.priority) && isInt(x.callerPersonId, -1);
}

/** Structural check of a scenario (hidden truth). */
export function isScenario(x: unknown): x is Scenario {
  if (!isObj(x) || x.version !== 1 || !isInt(x.callId, 1) || !isStr(x.typeId) || !isStr(x.family) || !isStr(x.branch)) return false;
  if (!isArrayOf(x.variants, (v): v is string => isOneOf(v, VARIANT_KINDS))) return false;
  if (!isAnchor(x.anchor) || !isAnchor(x.reported)) return false;
  if (!Array.isArray(x.participants) || !x.participants.every(isParticipant)) return false;
  if (!Array.isArray(x.vehicles) || !x.vehicles.every(isVehicleSpec)) return false;
  if (!Array.isArray(x.evidence) || !x.evidence.every((e) => isObj(e) && isStr(e.item) && isOneOf(e.spot, SPOTS) && isInt(e.spotIndex, 0))) return false;
  if (!Array.isArray(x.timeline) || !x.timeline.every(isTimelineEntry)) return false;
  const err = x.errors;
  return isStrArray(x.flags) && isObj(err) && isBool(err.wrongAddress) && isBool(err.wrongDescription) && isBool(err.missingWeapon);
}

function isActionState(x: unknown): x is ActionState {
  return isObj(x) && isStr(x.id) && isOneOf(x.state, ['done', 'running', 'requested'] as const) && isNum(x.dueSim);
}
function isServiceState(x: unknown): x is SceneServiceSave {
  return isObj(x) && isStr(x.kind) && isNum(x.dueSim) && isBool(x.arrived) && isNum(x.effectDueSim) && (x.ackDueSim === undefined || isNum(x.ackDueSim));
}

function isArrest(x: unknown): x is SceneArrest {
  return isObj(x) && isInt(x.personId, -1) && isInt(x.buildingId, -1) && isInt(x.room, -1) && isNum(x.sim);
}

function isCaseSummary(x: unknown): boolean {
  if (!isObj(x)) return false;
  const nums = ['items', 'found', 'plainView', 'suppressed', 'collected', 'photos', 'markers', 'prints', 'canvass', 'consents'];
  return nums.every((k) => isInt(x[k], 0)) && isBool(x.custodyComplete) && isBool(x.bodycam);
}

function isScenarioSave(x: unknown): x is SceneScenarioSave {
  if (!isObj(x) || !isScenario(x.scenario)) return false;
  const sc = x.scenario;
  return isStrArray(x.flags) && isNum(x.createdSim) && isBool(x.materialized) &&
    isArrayOf(x.actorIds, (v): v is number => isInt(v, 0)) && x.actorIds.length === sc.participants.length &&
    isInt(x.timelineIdx, 0) && x.timelineIdx <= sc.timeline.length && isNum(x.arrivedSim) &&
    isArrayOf(x.actions, isActionState) && isArrayOf(x.services, isServiceState) && isBool(x.ambushArmed) &&
    isStrArray(x.forceUsed) && (x.mirror === undefined || isArrayOf(x.mirror, (v): v is number => isInt(v, 1))) &&
    (x.buildingId === undefined || isInt(x.buildingId, -1)) &&
    (x.hideSpots === undefined || (isArrayOf(x.hideSpots, (v): v is number => isInt(v, -1)) && x.hideSpots.length === sc.participants.length)) &&
    (x.knockedSim === undefined || isNum(x.knockedSim)) && (x.answerDueSim === undefined || isNum(x.answerDueSim)) &&
    (x.arrests === undefined || isArrayOf(x.arrests, isArrest));
}

/** Structural check of a call outcome. */
export function isCallOutcome(x: unknown): x is CallOutcome {
  return isObj(x) && isInt(x.callId, 1) && isStr(x.number) && isStr(x.typeId) && isStr(x.family) &&
    isArrayOf(x.variants, (v): v is string => isOneOf(v, VARIANT_KINDS)) && isStr(x.branch) && isStr(x.outcomeId) &&
    isStr(x.suggested) && isStr(x.disposition) && isOneOf(x.grade, GRADES) && isStrArray(x.flags) && isBool(x.materialized) &&
    (x.resolvedBy === 'player' || x.resolvedBy === 'ai') && isNum(x.createdSim) && isNum(x.arrivedSim) && isNum(x.closedSim) &&
    isStrArray(x.forceUsed) && (x.buildingId === undefined || isInt(x.buildingId, -1)) &&
    (x.entry === undefined || x.entry === null || isStr(x.entry)) && (x.case === undefined || isCaseSummary(x.case));
}

function isProp(x: unknown): x is ScenePropSave {
  return isObj(x) && isNum(x.x) && isNum(x.y) && isNum(x.z) && isNum(x.yaw) && isInt(x.kind, 1) && isInt(x.callId, 0);
}

function isPursuit(x: unknown): x is ScenePursuitSave {
  return isObj(x) && (x.kind === 'vehicle' || x.kind === 'foot') && isInt(x.callId, 0) && isInt(x.vehicleId, -1) && isInt(x.actorId, 0) &&
    isNum(x.startedSim) && isBool(x.announced) && (x.ownerCallId === undefined || isInt(x.ownerCallId, 0)) &&
    (x.personId === undefined || isInt(x.personId, -1));
}

/** Structural check of a scene request. */
export function isSceneRequest(x: unknown): x is SceneRequest {
  if (!isObj(x) || !isStr(x.kind)) return false;
  switch (x.kind) {
    case 'weapon':
    case 'tackle':
    case 'shout':
    case 'terminatePursuit':
      return true;
    case 'fire':
      return isNum(x.dirX) && isNum(x.dirZ);
    case 'action':
      return isInt(x.callId, 1) && isStr(x.actionId);
    case 'clear':
      return isInt(x.callId, 1) && (x.disposition === null || isStr(x.disposition));
    default:
      return false;
  }
}

/** Structural check of a scene save block (version, stream state, scenarios, outcomes, props, pursuits, queues). */
export function isSceneSave(x: unknown): x is SceneSave {
  if (!isObj(x) || x.version !== 1 || !isRngState(x.rng) || !isOneOf(x.officerWeapon, ['none', 'sidearm', 'taser'] as const)) return false;
  if (!isArrayOf(x.scenarios, isScenarioSave)) return false;
  const ids = new Set<number>();
  for (const s of x.scenarios) {
    if (ids.has(s.scenario.callId)) return false;
    ids.add(s.scenario.callId);
  }
  return isArrayOf(x.closed, isCallOutcome) && isArrayOf(x.props, isProp) && isArrayOf(x.pursuits, isPursuit) &&
    isArrayOf(x.queue, isSceneRequest) && Array.isArray(x.eventQueue) && x.eventQueue.every(isObj) &&
    (x.ignored === undefined || isArrayOf(x.ignored, (v): v is number => isInt(v, 1))) && (x.slowTick === undefined || isInt(x.slowTick, -1));
}
