/**
 * Resources save (design §8.7): unit slots, the air unit, remembered command posts and queued requests.
 * Fleet cars are not stored here (the traffic snapshot owns them); `PoliceLights` are re-attached on the next step.
 */
import type { RngState } from '../core/rng';
import { AIR_TARGET_KINDS } from './air';
import { RESOURCE_STATUSES, type ResourceRequest, type ResourceSave } from './types';

export type { ResourceAirSave, ResourceSave, ResourceUnitSave } from './types';

/** Command post levels in the order of `ResourceSave.posts[3]`. */
export const POST_LEVELS = ['none', 'incident', 'major', 'disaster'] as const;
export type PostLevel = (typeof POST_LEVELS)[number];

/** An empty save carrying the 'resources' stream state. */
export function emptyResourceSave(rng: RngState): ResourceSave {
  return { version: 1, rng, units: [], air: null, posts: [], requests: [] };
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isInt(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x);
}

function isStr(x: unknown): x is string {
  return typeof x === 'string';
}

function isRngState(x: unknown): x is RngState {
  if (!isObj(x) || !isInt(x.seed) || !Array.isArray(x.s) || x.s.length !== 4) return false;
  return x.s.every((v) => isInt(v) && v >= 0 && v <= 0xffffffff);
}

function isOneOf(x: unknown, list: readonly string[]): boolean {
  return isStr(x) && list.includes(x);
}

function isUnitSave(x: unknown): boolean {
  if (!isObj(x)) return false;
  return (
    isStr(x.callsign) && x.callsign !== '' && isOneOf(x.status, RESOURCE_STATUSES) &&
    isInt(x.callId) && isNum(x.etaS) && isNum(x.travelS) && isNum(x.expectedMps) && isNum(x.turnoutUntil) && isNum(x.leaveAt) &&
    isNum(x.destX) && isNum(x.destZ) && isOneOf(x.urgency, ['respond', 'emergency']) && isInt(x.patient) &&
    isNum(x.noProgressSince) && isNum(x.progressLeftM)
  );
}

function isAirSave(x: unknown): boolean {
  if (!isObj(x)) return false;
  return (
    isNum(x.x) && isNum(x.y) && isNum(x.z) && isNum(x.yaw) && isOneOf(x.targetKind, AIR_TARGET_KINDS) && isInt(x.targetId) &&
    isNum(x.tx) && isNum(x.tz) && isNum(x.onStationUntil) && Array.isArray(x.revealed) && x.revealed.every(isInt)
  );
}

/** Whether `x` is a well-formed queued request. */
export function isResourceRequest(x: unknown): x is ResourceRequest {
  if (!isObj(x)) return false;
  if (x.kind === 'request') return isStr(x.typeId) && x.typeId !== '' && isInt(x.callId) && isOneOf(x.via, ['radio', 'mdt', 'auto', 'scene']);
  if (x.kind === 'cancel' || x.kind === 'release') return isStr(x.callsign) && x.callsign !== '';
  return false;
}

/** Structural check of a saved resources block (version 1, unique callsigns, known statuses). */
export function isResourceSave(x: unknown): x is ResourceSave {
  if (!isObj(x) || x.version !== 1 || !isRngState(x.rng)) return false;
  if (!Array.isArray(x.units) || !x.units.every(isUnitSave)) return false;
  const seen = new Set<string>();
  for (const u of x.units as { callsign: string }[]) {
    if (seen.has(u.callsign)) return false;
    seen.add(u.callsign);
  }
  if (x.air !== null && !isAirSave(x.air)) return false;
  if (!Array.isArray(x.posts)) return false;
  for (const p of x.posts as unknown[]) {
    if (!Array.isArray(p) || p.length !== 4 || !isInt(p[0]) || !isNum(p[1]) || !isNum(p[2]) || !isInt(p[3]) || p[3] < 0 || p[3] >= POST_LEVELS.length) {
      return false;
    }
  }
  if (x.slots !== undefined && !(isObj(x.slots) && isInt(x.slots.avl) && isInt(x.slots.reveal))) return false;
  return Array.isArray(x.requests) && x.requests.every(isResourceRequest);
}
