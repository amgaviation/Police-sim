/**
 * Dispatcher save block (design §8.2, §17): plain JSON, version 1. Everything that drives a future
 * decision is here (child RNG states, timers, unit FSMs, offers, status checks, emergency and backup
 * state, queued bus events and requests) so a restored game continues exactly.
 */
import { REQUEST_VIAS, STOP_ACTIONS, UNIT_STATUSES, type RequestVia, type UnitRequest } from '../cad/types';
import { DOC_KINDS, type DocKind } from '../cad/documents';
import type { RngState } from '../core/rng';

export const UNIT_MODES = ['patrol', 'beat', 'enRoute', 'onScene', 'break'] as const;
/** AI unit FSM state: patrolling, driving back to its beat, en route, on scene, out of service (break). */
export type UnitMode = (typeof UNIT_MODES)[number];

export const UNIT_ROLES = ['call', 'backup', 'emergency', 'welfare'] as const;
/** Why an AI unit is on its call: a dispatched call, backup for the player, the emergency button, a welfare escalation. */
export type UnitRole = (typeof UNIT_ROLES)[number];

/** Sim-second timers of a unit; -1 = not running. */
export interface UnitTimersSave {
  onSceneUntil: number;
  stuckSince: number;
  enRouteSince: number;
  /** Shortest route length seen on the trip (-1 none); absent in older saves. */
  progressLeftM?: number;
  breakUntil: number;
  releaseAt: number;
  nextBeatCheck: number;
}

export interface UnitFsmSave {
  callsign: string;
  fleetIndex: number;
  /** Fleet car body colour (0xRRGGBB), used when the car has to be respawned. */
  color: number;
  mode: UnitMode;
  role: UnitRole;
  callId: number | null;
  /** Destination of the current trip, null without one. */
  dest: { x: number; z: number; emergency: boolean } | null;
  timers: UnitTimersSave;
  replanned: boolean;
  /** A 'traffic:fleetArrived' was seen for the current trip. */
  arrived: boolean;
  /** Last AVL position written to CAD. */
  lastAvl: [number, number];
  /** Phase 6: sent to a point by `directUnit` (saved only when true). */
  directed?: boolean;
}

export type QueuedEvent =
  | { type: 'pulledOver'; vehicleId: number; x: number; z: number }
  | { type: 'released'; vehicleId: number; reason: 'released' | 'abandoned' | 'lost' | 'fled' }
  | { type: 'fleetArrived'; index: number }
  | { type: 'document'; id: string; kind: DocKind; final: boolean };

export interface QueuedRequest {
  callsign: string;
  request: UnitRequest;
  via: RequestVia;
}

export interface StatusCheckSave {
  lastAnswerSim: number;
  /** 0 none pending; 1..attempts asked; attempts + 1 escalated. */
  attempt: number;
  /** Sim time the next check is due while the player stays busy (-1 when not busy). */
  nextCheckSim: number;
  /** Sim time of the last unanswered check (-1 none). */
  awaitingSince: number;
  locationAsked: boolean;
  /** officerWelfare call of the current escalation, -1 none. */
  welfareCallId: number;
}

export interface DispatchSave {
  version: 1;
  started: boolean;
  rng: { main: RngState; calls: RngState; units: RngState };
  generator: { nextCallSim: number; generated: number; multiplier: number; nextMultiplierSim: number };
  timers: { nextAssignSim: number; assignDirty: boolean; nextAvlSim: number; nextRetargetSim: number };
  units: UnitFsmSave[];
  /** Call id currently offered to the player (-1 none) and calls the player declined or let expire. */
  offer: { callId: number; declined: number[] };
  /** AI units wanted per call: [callId, units]. */
  plans: [number, number][];
  statusCheck: StatusCheckSave;
  emergency: { active: boolean; callId: number };
  /** Player position the backup / emergency units were last sent to. */
  backup: { targetX: number; targetZ: number };
  stop: { warned: boolean };
  events: QueuedEvent[];
  requests: QueuedRequest[];
}

// --- Validation -----------------------------------------------------------------------------

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

function isRngState(x: unknown): x is RngState {
  return isObj(x) && isInt(x.seed, 0) && Array.isArray(x.s) && x.s.length === 4 && x.s.every((v) => isInt(v, 0) && v < 2 ** 32);
}

function isTimers(x: unknown): x is UnitTimersSave {
  return isObj(x) && isNum(x.onSceneUntil) && isNum(x.stuckSince) && isNum(x.enRouteSince) && isNum(x.breakUntil) &&
    isNum(x.releaseAt) && isNum(x.nextBeatCheck) && (x.progressLeftM === undefined || isNum(x.progressLeftM));
}

function isDest(x: unknown): x is UnitFsmSave['dest'] {
  return x === null || (isObj(x) && isNum(x.x) && isNum(x.z) && isBool(x.emergency));
}

function isUnitFsm(x: unknown): x is UnitFsmSave {
  return isObj(x) && isStr(x.callsign) && x.callsign.length > 0 && isInt(x.fleetIndex, 0) && isInt(x.color, 0) &&
    isOneOf(x.mode, UNIT_MODES) && isOneOf(x.role, UNIT_ROLES) && (x.callId === null || isInt(x.callId, 1)) &&
    isDest(x.dest) && isTimers(x.timers) && isBool(x.replanned) && isBool(x.arrived) &&
    Array.isArray(x.lastAvl) && x.lastAvl.length === 2 && isNum(x.lastAvl[0]) && isNum(x.lastAvl[1]) &&
    (x.directed === undefined || isBool(x.directed));
}

/** Structural check of a `UnitRequest` (kind and its fields). */
export function isUnitRequest(x: unknown): x is UnitRequest {
  if (!isObj(x) || !isStr(x.kind)) return false;
  switch (x.kind) {
    case 'status':
      return isOneOf(x.status, UNIT_STATUSES);
    case 'acceptCall':
    case 'declineCall':
    case 'selfAssign':
      return isInt(x.callId);
    case 'clearCall':
      return isInt(x.callId) && isStr(x.disposition);
    case 'narrative':
      return isInt(x.callId) && isStr(x.text);
    case 'runPlate':
      return isStr(x.plate) && isInt(x.vehicleId);
    case 'runPerson':
      return isInt(x.personId);
    case 'backup':
      return x.code === 2 || x.code === 3;
    case 'resource':
      return isStr(x.typeId) && x.typeId.length > 0;
    case 'stopContact':
      return isOneOf(x.action, STOP_ACTIONS) && (x.personId === undefined || isInt(x.personId, -1));
    case 'location':
    case 'code4':
    case 'emergency':
    case 'trafficStop':
    case 'repeat':
      return true;
    default:
      return false;
  }
}

function isQueuedEvent(x: unknown): x is QueuedEvent {
  if (!isObj(x)) return false;
  switch (x.type) {
    case 'pulledOver':
      return isInt(x.vehicleId) && isNum(x.x) && isNum(x.z);
    case 'released':
      return isInt(x.vehicleId) && isOneOf(x.reason, ['released', 'abandoned', 'lost', 'fled'] as const);
    case 'fleetArrived':
      return isInt(x.index, 0);
    case 'document':
      return isStr(x.id) && isOneOf(x.kind, DOC_KINDS) && isBool(x.final);
    default:
      return false;
  }
}

function isQueuedRequest(x: unknown): x is QueuedRequest {
  return isObj(x) && isStr(x.callsign) && isUnitRequest(x.request) && isOneOf(x.via, REQUEST_VIAS);
}

function isPlan(x: unknown): x is [number, number] {
  return Array.isArray(x) && x.length === 2 && isInt(x[0], 1) && isInt(x[1], 0);
}

function isStatusCheck(x: unknown): x is StatusCheckSave {
  return isObj(x) && isNum(x.lastAnswerSim) && isInt(x.attempt, 0) && isNum(x.nextCheckSim) && isNum(x.awaitingSince) &&
    isBool(x.locationAsked) && isInt(x.welfareCallId, -1);
}

/** Structural check of a dispatcher save block (version, RNG states, timers, FSMs, queues, unique fleet indices). */
export function isDispatchSave(x: unknown): x is DispatchSave {
  if (!isObj(x) || x.version !== 1 || !isBool(x.started)) return false;
  const rng = x.rng;
  if (!isObj(rng) || !isRngState(rng.main) || !isRngState(rng.calls) || !isRngState(rng.units)) return false;
  const g = x.generator;
  if (!isObj(g) || !isNum(g.nextCallSim) || !isInt(g.generated, 0) || !isNum(g.multiplier) || !isNum(g.nextMultiplierSim)) return false;
  const tm = x.timers;
  if (!isObj(tm) || !isNum(tm.nextAssignSim) || !isBool(tm.assignDirty) || !isNum(tm.nextAvlSim) || !isNum(tm.nextRetargetSim)) return false;
  if (!isArrayOf(x.units, isUnitFsm)) return false;
  const indices = new Set<number>();
  const callsigns = new Set<string>();
  for (const u of x.units) {
    if (indices.has(u.fleetIndex) || callsigns.has(u.callsign)) return false;
    indices.add(u.fleetIndex);
    callsigns.add(u.callsign);
  }
  const offer = x.offer;
  if (!isObj(offer) || !isInt(offer.callId, -1) || !isArrayOf(offer.declined, (v): v is number => isInt(v, 1))) return false;
  if (!isArrayOf(x.plans, isPlan) || !isStatusCheck(x.statusCheck)) return false;
  const em = x.emergency;
  if (!isObj(em) || !isBool(em.active) || !isInt(em.callId, -1)) return false;
  const b = x.backup;
  if (!isObj(b) || !isNum(b.targetX) || !isNum(b.targetZ)) return false;
  const stop = x.stop;
  if (!isObj(stop) || !isBool(stop.warned)) return false;
  return isArrayOf(x.events, isQueuedEvent) && isArrayOf(x.requests, isQueuedRequest);
}
