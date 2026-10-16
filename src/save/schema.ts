import type { RngState } from '../core/rng';

/** Version written by `SaveManager.save`; bump when `SaveGame` changes shape. */
export const CURRENT_SAVE_VERSION = 1;

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

export interface SerializedEntity {
  kind: number;
  x: number;
  y: number;
  z: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
}

export interface SaveGameV1 {
  seed: number;
  rngState: RngState;
  clock: { simTime: number; timeScale: number };
  officer: { name: string; badge: string };
  world: { entities: SerializedEntity[] };
}

/** Alias for the current save shape. */
export type SaveGame = SaveGameV1;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function isRngState(x: unknown): x is RngState {
  return (
    isRecord(x) &&
    isFiniteNumber(x['seed']) &&
    Array.isArray(x['s']) &&
    x['s'].length === 4 &&
    x['s'].every(isFiniteNumber)
  );
}

export function isSerializedEntity(x: unknown): x is SerializedEntity {
  if (!isRecord(x)) return false;
  for (const key of ['kind', 'x', 'y', 'z', 'qx', 'qy', 'qz', 'qw'] as const) {
    if (!isFiniteNumber(x[key])) return false;
  }
  return true;
}

/** Structural check for the v1 save payload; used after migration and on load. */
export function isSaveGameV1(x: unknown): x is SaveGameV1 {
  if (!isRecord(x)) return false;
  const { clock, officer, world } = x;
  return (
    isFiniteNumber(x['seed']) &&
    isRngState(x['rngState']) &&
    isRecord(clock) &&
    isFiniteNumber(clock['simTime']) &&
    isFiniteNumber(clock['timeScale']) &&
    isRecord(officer) &&
    typeof officer['name'] === 'string' &&
    typeof officer['badge'] === 'string' &&
    isRecord(world) &&
    Array.isArray(world['entities']) &&
    world['entities'].every(isSerializedEntity)
  );
}

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
