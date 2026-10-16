import type { RngState } from '../core/rng';
import { MAX_TIME_SCALE } from '../core/time';

/** Version written by `SaveManager.save`; bump when `SaveGame` changes shape. */
export const CURRENT_SAVE_VERSION = 2;

/** Persisted wrapper around a save payload. `slot` doubles as the store key. */
export interface SaveEnvelope<T> {
  version: number;
  /** Wall-clock ms when the slot was first written. */
  createdAt: number;
  /** Wall-clock ms of the most recent write. */
  updatedAt: number;
  slot: string;
  data: T;
}

/** Entity in a v1 save: kind and transform only. */
export interface SerializedEntityV1 {
  kind: number;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

/** Entity in a v2 save: transform plus the rigid body's motion state. */
export interface SerializedEntity extends SerializedEntityV1 {
  /** Linear velocity (m/s). */
  vx: number;
  vy: number;
  vz: number;
  /** Angular velocity (rad/s). */
  wx: number;
  wy: number;
  wz: number;
  sleeping: boolean;
}

export interface SaveGameV1 {
  seed: number;
  rngState: RngState;
  clock: { simTime: number; timeScale: number };
  officer: { name: string; badge: string };
  world: { entities: SerializedEntityV1[] };
}

export interface SaveGameV2 {
  seed: number;
  rngState: RngState;
  clock: { simTime: number; timeScale: number };
  officer: { name: string; badge: string };
  /** Third-person camera pitch (yaw is the player's facing). */
  camera: { pitch: number };
  world: { entities: SerializedEntity[] };
}

/** Alias for the current save shape. */
export type SaveGame = SaveGameV2;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isUint32(x: unknown): x is number {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x <= 0xffffffff;
}

/** Matches what `Rng.restore` accepts: a uint32 seed and four uint32 state words. */
function isRngState(x: unknown): x is RngState {
  return isRecord(x) && isUint32(x['seed']) && Array.isArray(x['s']) && x['s'].length === 4 && x['s'].every(isUint32);
}

function hasFiniteFields(x: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => isFiniteNumber(x[key]));
}

const TRANSFORM_KEYS = ['kind', 'x', 'y', 'z', 'qx', 'qy', 'qz', 'qw'] as const;
const MOTION_KEYS = ['vx', 'vy', 'vz', 'wx', 'wy', 'wz'] as const;

export function isSerializedEntityV1(x: unknown): x is SerializedEntityV1 {
  return isRecord(x) && hasFiniteFields(x, TRANSFORM_KEYS);
}

export function isSerializedEntity(x: unknown): x is SerializedEntity {
  return isRecord(x) && hasFiniteFields(x, TRANSFORM_KEYS) && hasFiniteFields(x, MOTION_KEYS) && typeof x['sleeping'] === 'boolean';
}

/**
 * Fields shared by every save version: seed, RNG, clock (time scale in
 * [0, maxTimeScale]) and officer. v1 builds did not cap the time scale.
 */
function hasCommonFields(x: Record<string, unknown>, maxTimeScale: number = MAX_TIME_SCALE): boolean {
  const { clock, officer } = x;
  return (
    isFiniteNumber(x['seed']) &&
    isRngState(x['rngState']) &&
    isRecord(clock) &&
    isFiniteNumber(clock['simTime']) &&
    isFiniteNumber(clock['timeScale']) &&
    clock['timeScale'] >= 0 &&
    clock['timeScale'] <= maxTimeScale &&
    isRecord(officer) &&
    typeof officer['name'] === 'string' &&
    typeof officer['badge'] === 'string'
  );
}

function entitiesOf(x: Record<string, unknown>): unknown[] | null {
  const world = x['world'];
  return isRecord(world) && Array.isArray(world['entities']) ? world['entities'] : null;
}

/** Structural check for the v1 payload (the input of the v1 -> v2 migration). */
export function isSaveGameV1(x: unknown): x is SaveGameV1 {
  if (!isRecord(x) || !hasCommonFields(x, Number.POSITIVE_INFINITY)) return false;
  const entities = entitiesOf(x);
  return entities !== null && entities.every(isSerializedEntityV1);
}

/** Structural check for the v2 payload; every value must be loadable as-is. */
export function isSaveGameV2(x: unknown): x is SaveGameV2 {
  if (!isRecord(x) || !hasCommonFields(x)) return false;
  const camera = x['camera'];
  if (!isRecord(camera) || !isFiniteNumber(camera['pitch'])) return false;
  const entities = entitiesOf(x);
  return entities !== null && entities.every(isSerializedEntity);
}

/** Validator for the current save shape; used after migration, on load and before every write. */
export const isSaveGame: (x: unknown) => x is SaveGame = isSaveGameV2;

/** Checks the envelope metadata only; `data` is left for migration/validation. */
export function isSaveEnvelope(x: unknown): x is SaveEnvelope<unknown> {
  return (
    isRecord(x) &&
    Number.isInteger(x['version']) &&
    isFiniteNumber(x['createdAt']) &&
    isFiniteNumber(x['updatedAt']) &&
    typeof x['slot'] === 'string' &&
    'data' in x
  );
}
