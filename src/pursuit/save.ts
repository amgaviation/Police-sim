/**
 * Persisted state of the pursuit system (design §10.4). The shape of §10.4 plus a few optional fields that make a
 * mid-pursuit load continue exactly (`intake`, `lastEnd`, and the `extras` of the pursuit and the bail).
 */
import type { RngState } from '../core/rng';
import type { PursuitRequest, Strip } from './types';

export interface PursuitTacticSave {
  /** `spikes` or `roadblock`. */
  kind: string;
  /** Callsign; several callsigns joined with a comma for a roadblock. */
  unit: string;
  node: number;
  sinceSim: number;
}

export interface PursuitHandoffSave {
  unit: string;
  resolveAt: number;
  removeAt: number;
  done: boolean;
}

export interface PursuitRunSave {
  callId: number;
  vehicleId: number;
  personId: number;
  startSim: number;
  pitAuthorized: boolean;
  /** Sim time the supervisor was first seen, -1 none. */
  monitorSince: number;
  /** Sim time of the last terminate order, -1 none. */
  lastOrderSim: number;
  ordered: boolean;
  /** Sim time the player lost sight of the suspect, -1 in sight. */
  lostSince: number;
  prevX: number;
  prevZ: number;
  tactic: PursuitTacticSave | null;
  handoff: PursuitHandoffSave | null;
  stateRequested?: boolean;
  airRequested?: boolean;
  ignoredFlashed?: boolean;
  /** AI units this module directed (released when the pursuit ends). */
  directed?: string[];
  /** The state-patrol unit sent after the suspect ('' none). */
  stateUnit?: string;
}

export interface PursuitBailSave {
  personId: number;
  actorId: number;
  x: number;
  z: number;
  sinceSim: number;
  /** x, z, callsign of the unit staffing the post ('' none yet). */
  posts: [number, number, string][];
  callId?: number;
  perimeterSet?: boolean;
  contained?: boolean;
  lostSince?: number;
  airRequested?: boolean;
}

/** Bus events waiting for the next step. */
export type PursuitIntakeSave =
  | { kind: 'vehicleStart'; callId: number; personId: number }
  | { kind: 'vehicleEnd'; callId: number; personId: number; endReason: string }
  | { kind: 'footStart'; callId: number; personId: number }
  | { kind: 'footEnd'; callId: number; personId: number }
  | { kind: 'contact'; vehicleId: number; other: number };

export interface PursuitSave {
  version: 1;
  rng: RngState;
  pursuit: PursuitRunSave | null;
  bail: PursuitBailSave | null;
  strips: Strip[];
  nextStripId: number;
  /** Unused queue placeholder (contacts wait in `intake`). */
  contacts: { relX: number; relZ: number }[];
  requests: PursuitRequest[];
  intake?: PursuitIntakeSave[];
  /** The last vehicle pursuit that ended in a stop or crash (foot-bail detection window). */
  lastEnd?: { personId: number; sim: number } | null;
}

/** A fresh state: nothing tracked. */
export function emptyPursuitSave(rng: RngState): PursuitSave {
  return { version: 1, rng, pursuit: null, bail: null, strips: [], nextStripId: 1, contacts: [], requests: [], intake: [], lastEnd: null };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function int(v: unknown): v is number {
  return num(v) && Number.isInteger(v);
}

function str(v: unknown): v is string {
  return typeof v === 'string';
}

function optBool(v: unknown): boolean {
  return v === undefined || typeof v === 'boolean';
}

function isRngState(v: unknown): boolean {
  if (!isRecord(v) || !int(v.seed)) return false;
  const s = v.s;
  return Array.isArray(s) && s.length === 4 && s.every((x) => int(x) && x >= 0 && x < 4294967296);
}

const REQUEST_KINDS: readonly string[] = ['requestPit', 'spikesAhead', 'deployStrip', 'boxIn', 'roadblock', 'air', 'perimeter'];

function isRequest(v: unknown): boolean {
  return isRecord(v) && str(v.kind) && REQUEST_KINDS.includes(v.kind);
}

function isStrip(v: unknown): boolean {
  return isRecord(v) && int(v.id) && num(v.x0) && num(v.z0) && num(v.x1) && num(v.z1) && num(v.placedSim) && str(v.owner) && typeof v.active === 'boolean';
}

function isTactic(v: unknown): boolean {
  return v === null || (isRecord(v) && str(v.kind) && str(v.unit) && int(v.node) && num(v.sinceSim));
}

function isHandoff(v: unknown): boolean {
  return v === null || (isRecord(v) && str(v.unit) && num(v.resolveAt) && num(v.removeAt) && typeof v.done === 'boolean');
}

function isRun(v: unknown): boolean {
  return (
    v === null ||
    (isRecord(v) && int(v.callId) && int(v.vehicleId) && int(v.personId) && num(v.startSim) && typeof v.pitAuthorized === 'boolean' &&
      num(v.monitorSince) && num(v.lastOrderSim) && typeof v.ordered === 'boolean' && num(v.lostSince) && num(v.prevX) && num(v.prevZ) &&
      isTactic(v.tactic) && isHandoff(v.handoff) && optBool(v.stateRequested) && optBool(v.airRequested) && optBool(v.ignoredFlashed) && (v.stateUnit === undefined || str(v.stateUnit)) &&
      (v.directed === undefined || (Array.isArray(v.directed) && v.directed.every(str))))
  );
}

function isBail(v: unknown): boolean {
  return (
    v === null ||
    (isRecord(v) && int(v.personId) && int(v.actorId) && num(v.x) && num(v.z) && num(v.sinceSim) &&
      Array.isArray(v.posts) && v.posts.every((p) => Array.isArray(p) && p.length === 3 && num(p[0]) && num(p[1]) && str(p[2])) &&
      (v.callId === undefined || int(v.callId)) && optBool(v.perimeterSet) && optBool(v.contained) && optBool(v.airRequested) && (v.lostSince === undefined || num(v.lostSince)))
  );
}

function isIntake(v: unknown): boolean {
  if (!isRecord(v)) return false;
  switch (v.kind) {
    case 'vehicleStart':
    case 'footStart':
    case 'footEnd':
      return int(v.callId) && int(v.personId);
    case 'vehicleEnd':
      return int(v.callId) && int(v.personId) && str(v.endReason);
    case 'contact':
      return int(v.vehicleId) && int(v.other);
    default:
      return false;
  }
}

/** Is `x` shaped like a `PursuitSave`? */
export function isPursuitSave(x: unknown): x is PursuitSave {
  if (!isRecord(x) || x.version !== 1) return false;
  return (
    isRngState(x.rng) && isRun(x.pursuit) && isBail(x.bail) &&
    Array.isArray(x.strips) && x.strips.every(isStrip) && int(x.nextStripId) &&
    Array.isArray(x.contacts) && x.contacts.every((c) => isRecord(c) && num(c.relX) && num(c.relZ)) &&
    Array.isArray(x.requests) && x.requests.every(isRequest) &&
    (x.intake === undefined || (Array.isArray(x.intake) && x.intake.every(isIntake))) &&
    (x.lastEnd === undefined || x.lastEnd === null || (isRecord(x.lastEnd) && int(x.lastEnd.personId) && num(x.lastEnd.sim)))
  );
}
