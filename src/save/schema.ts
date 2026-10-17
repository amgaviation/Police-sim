import type { RngState } from '../core/rng';
import { MAX_TIME_SCALE } from '../core/time';
import { isEnvironmentSave, type EnvironmentSave } from '../environment/environment';
import { CAMERA_MODE } from '../player/cameraRig';
import type { PlayerModeName } from '../player/events';
import type { TrafficViolationKind } from '../traffic/events';
import { isTrafficSnapshot, type TrafficSnapshot } from '../traffic/trafficSystem';
import type { SerializedVehicle } from '../vehicles/drivableVehicle';
import { VEHICLE_MODELS } from '../vehicles/model';

/** Version written by `SaveManager.save`; bump when `SaveGame` changes shape. */
export const CURRENT_SAVE_VERSION = 3;

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

/** A drivable vehicle in a v3 save: its own state plus the look colour and its RNG stream. */
export interface SavedVehicle extends SerializedVehicle {
  /** Body colour 0xRRGGBB (`VehicleLook.color`). */
  color: number;
  /** State of the vehicle's `'vehicle:<slot>'` stream, so random stalls continue identically. */
  rng: RngState;
}

/** Violations the officer observed, per traffic registry id: [vehicleId, count per kind]. */
export type SavedViolations = Array<[number, Partial<Record<TrafficViolationKind, number>>]>;

/** v3 (Phase 1): the city session. The city itself is rebuilt from `seed`. */
export interface SaveGameV3 {
  seed: number;
  rngState: RngState;
  clock: { simTime: number; timeScale: number };
  officer: { name: string; badge: string };
  /** On-foot camera pitch and the `CAMERA_MODE` id used while driving. */
  camera: { pitch: number; mode: number };
  /** The officer (its seat pose while driving) and debug boxes, as in v2. */
  world: { entities: SerializedEntity[] };
  /**
   * `vehicle` indexes `vehicles` while driving, -1 on foot; `lastVehicle` is the vehicle driven last
   * (refuelling, parked headlights), -1 for none. Early v3 saves lack it (read as -1).
   */
  player: { mode: PlayerModeName; vehicle: number; lastVehicle?: number };
  vehicles: SavedVehicle[];
  /** Ambient traffic; null populates afresh around the player. */
  traffic: TrafficSnapshot | null;
  /** Observed violations (`traffic list`); early v3 saves lack it (read as none). */
  violations?: SavedViolations;
  environment: EnvironmentSave;
}

/** Alias for the current save shape. */
export type SaveGame = SaveGameV3;

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function inRange(x: unknown, min: number, max: number): boolean {
  return isFiniteNumber(x) && x >= min && x <= max;
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

function isTuple(x: unknown, length: number, item: (v: unknown) => boolean): boolean {
  return Array.isArray(x) && x.length === length && x.every(item);
}

const isBoolean = (x: unknown): x is boolean => typeof x === 'boolean';
const isUnit = (x: unknown): boolean => inRange(x, 0, 1);

const TRANSFORM_KEYS = ['kind', 'x', 'y', 'z', 'qx', 'qy', 'qz', 'qw'] as const;
const MOTION_KEYS = ['vx', 'vy', 'vz', 'wx', 'wy', 'wz'] as const;
const VEHICLE_POSE_KEYS = ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'vx', 'vy', 'vz', 'wx', 'wy', 'wz'] as const;
const VEHICLE_FLAG_KEYS = ['engineFailed', 'headlights', 'lightbar', 'reversing'] as const;
const VEHICLE_CAMERA_MODES: readonly number[] = [CAMERA_MODE.chase, CAMERA_MODE.hood, CAMERA_MODE.cockpit];
const VIOLATION_KINDS: readonly string[] = ['speeding', 'redLight', 'rollingStop', 'tailgating', 'weaving'] satisfies TrafficViolationKind[];

/** One `[vehicleId, counts]` entry of `SaveGameV3.violations`. */
function isViolationEntry(x: unknown): boolean {
  if (!Array.isArray(x) || x.length !== 2 || !isUint32(x[0]) || !isRecord(x[1])) return false;
  return Object.entries(x[1]).every(([kind, n]) => VIOLATION_KINDS.includes(kind) && isUint32(n));
}

export function isSerializedEntityV1(x: unknown): x is SerializedEntityV1 {
  return isRecord(x) && hasFiniteFields(x, TRANSFORM_KEYS);
}

export function isSerializedEntity(x: unknown): x is SerializedEntity {
  return isRecord(x) && hasFiniteFields(x, TRANSFORM_KEYS) && hasFiniteFields(x, MOTION_KEYS) && typeof x['sleeping'] === 'boolean';
}

/** The optional `sim` block of a serialized vehicle (steering, gearbox, stall timer, ABS phase, wheel loads). */
function isVehicleSimState(x: unknown): boolean {
  return (
    isRecord(x) &&
    hasFiniteFields(x, ['steerAngle', 'absTime']) &&
    Number.isInteger(x['gear']) &&
    (x['gear'] as number) >= 1 &&
    inRange(x['stallS'], 0, Number.MAX_VALUE) &&
    isTuple(x['wheelLoad'], 4, isFiniteNumber)
  );
}

/** Structural check of one saved vehicle, including that its model still ships. */
export function isSavedVehicle(x: unknown): x is SavedVehicle {
  if (!isRecord(x)) return false;
  const modelId = x['modelId'];
  return (
    typeof modelId === 'string' &&
    VEHICLE_MODELS.some((m) => m.id === modelId) &&
    hasFiniteFields(x, VEHICLE_POSE_KEYS) &&
    inRange(x['fuelL'], 0, Number.MAX_VALUE) &&
    isUnit(x['engineHealth']) &&
    isTuple(x['brakeTempC'], 2, isFiniteNumber) &&
    isTuple(x['zones'], 4, isUnit) &&
    isTuple(x['tireFlat'], 4, isBoolean) &&
    VEHICLE_FLAG_KEYS.every((key) => isBoolean(x[key])) &&
    (x['sim'] === undefined || isVehicleSimState(x['sim'])) &&
    Number.isInteger(x['color']) &&
    inRange(x['color'], 0, 0xffffff) &&
    isRngState(x['rng'])
  );
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

/** Structural check for the v3 payload, nested vehicle, traffic and environment state included. */
export function isSaveGameV3(x: unknown): x is SaveGameV3 {
  if (!isSaveGameV2(x)) return false;
  const v3 = x as unknown as Record<string, unknown>;
  const camera = v3['camera'] as Record<string, unknown>;
  if (!VEHICLE_CAMERA_MODES.includes(camera['mode'] as number)) return false;
  const vehicles = v3['vehicles'];
  if (!Array.isArray(vehicles) || !vehicles.every(isSavedVehicle)) return false;
  const player = v3['player'];
  if (!isRecord(player) || !Number.isInteger(player['vehicle'])) return false;
  const index = player['vehicle'] as number;
  const playerValid =
    player['mode'] === 'onFoot' ? index === -1 : player['mode'] === 'driving' && index >= 0 && index < vehicles.length;
  const last = player['lastVehicle'];
  const lastValid = last === undefined || (Number.isInteger(last) && (last as number) >= -1 && (last as number) < vehicles.length);
  const violations = v3['violations'];
  const violationsValid = violations === undefined || (Array.isArray(violations) && violations.every(isViolationEntry));
  return (
    playerValid &&
    lastValid &&
    violationsValid &&
    (v3['traffic'] === null || isTrafficSnapshot(v3['traffic'])) &&
    isEnvironmentSave(v3['environment'])
  );
}

/** Validator for the current save shape; used after migration, on load and before every write. */
export const isSaveGame: (x: unknown) => x is SaveGame = isSaveGameV3;

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
