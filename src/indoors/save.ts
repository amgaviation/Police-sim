/** Interior save block (design §6.5). */
import type { RngState } from '../core/rng';
import type { InteriorRequest } from './types';

/** Door and light override caps (oldest dropped, the officer's and resident buildings kept). */
export const MAX_OVERRIDES = 2000;
/** Queued requests kept in a save. */
export const MAX_QUEUE = 64;

export interface InteriorSave {
  version: 1;
  rng: RngState;
  /** Building the officer is in, -1 outdoors. */
  officerBuilding: number;
  /** [buildingId, door, DOOR_STATE] overrides, oldest first. */
  doors: [number, number, number][];
  /** [buildingId, room, on] overrides, oldest first. */
  lights: [number, number, 0 | 1][];
  kickCooldown: number;
  /** 0 = clear, 1 = black. */
  fade: number;
  pending: { kind: 'enter' | 'exit'; buildingId: number; door: number; phase: 0 | 1 | 2; t: number } | null;
  queue: InteriorRequest[];
  /** buildingId -> ambient actor ids. */
  spawned: [number, number[]][];
}

/** A save with no overrides, the officer outdoors. */
export function emptyInteriorSave(rng: RngState): InteriorSave {
  return {
    version: 1,
    rng: { seed: rng.seed, s: [rng.s[0], rng.s[1], rng.s[2], rng.s[3]] },
    officerBuilding: -1,
    doors: [],
    lights: [],
    kickCooldown: 0,
    fade: 0,
    pending: null,
    queue: [],
    spawned: [],
  };
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x);
const isNonNegInt = (x: unknown): x is number => isInt(x) && x >= 0;
const isUint32 = (x: unknown): boolean => isInt(x) && x >= 0 && x < 4294967296;

function isRngState(x: unknown): boolean {
  return isObj(x) && isUint32(x['seed']) && Array.isArray(x['s']) && x['s'].length === 4 && x['s'].every(isUint32);
}

const DOOR_ACTIONS: readonly string[] = ['toggle', 'open', 'close', 'knock', 'kick', 'ram', 'lock', 'unlock', 'announce'];

function isRequest(x: unknown): x is InteriorRequest {
  if (!isObj(x)) return false;
  switch (x['kind']) {
    case 'enter': return isNonNegInt(x['buildingId']) && isNonNegInt(x['door']);
    case 'exit': return isNonNegInt(x['door']);
    case 'door': return isNonNegInt(x['buildingId']) && isNonNegInt(x['door']) && typeof x['action'] === 'string' && DOOR_ACTIONS.includes(x['action']);
    case 'switch': return isNonNegInt(x['buildingId']) && isNonNegInt(x['room']);
    default: return false;
  }
}

function isPending(x: unknown): boolean {
  return (
    isObj(x) &&
    (x['kind'] === 'enter' || x['kind'] === 'exit') &&
    isNonNegInt(x['buildingId']) &&
    isNonNegInt(x['door']) &&
    (x['phase'] === 0 || x['phase'] === 1 || x['phase'] === 2) &&
    typeof x['t'] === 'number' && Number.isFinite(x['t']) && x['t'] >= 0
  );
}

function isTriples(x: unknown, valueOk: (v: unknown) => boolean): boolean {
  return (
    Array.isArray(x) &&
    x.length <= MAX_OVERRIDES &&
    x.every((e) => Array.isArray(e) && e.length === 3 && isNonNegInt(e[0]) && isNonNegInt(e[1]) && valueOk(e[2]))
  );
}

/** Structural validation of a saved interior block. */
export function isInteriorSave(x: unknown): x is InteriorSave {
  if (!isObj(x) || x['version'] !== 1 || !isRngState(x['rng'])) return false;
  if (!isInt(x['officerBuilding']) || x['officerBuilding'] < -1) return false;
  if (!isTriples(x['doors'], (v) => isInt(v) && v >= 0 && v <= 3)) return false;
  if (!isTriples(x['lights'], (v) => v === 0 || v === 1)) return false;
  const cd = x['kickCooldown'], fade = x['fade'];
  if (typeof cd !== 'number' || !Number.isFinite(cd) || cd < 0) return false;
  if (typeof fade !== 'number' || !Number.isFinite(fade) || fade < 0 || fade > 1) return false;
  if (x['pending'] !== null && !isPending(x['pending'])) return false;
  const queue = x['queue'];
  if (!Array.isArray(queue) || queue.length > MAX_QUEUE || !queue.every(isRequest)) return false;
  const spawned = x['spawned'];
  return (
    Array.isArray(spawned) &&
    spawned.every((e) => Array.isArray(e) && e.length === 2 && isNonNegInt(e[0]) && Array.isArray(e[1]) && e[1].every(isNonNegInt))
  );
}
