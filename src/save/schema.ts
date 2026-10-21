import { isBackupSave, type BackupSave } from '../backup/save';
import { isCadSave, type CadSave } from '../cad/cadState';
import { isCommandSave, type CommandSave } from '../command/save';
import { isConductSave, type ConductSave } from '../conduct/save';
import { isCourtSave, type CourtSave } from '../court/save';
import { isFleetSave, type FleetSave } from '../fleet/save';
import { isForceSave, type ForceSave } from '../force/save';
import { isGearSave, type GearSave } from '../gear';
import { isIncidentsSave, type IncidentsSave } from '../incidents/save';
import { isPursuitSave, type PursuitSave } from '../pursuit/save';
import { isResourceSave, type ResourceSave } from '../resources/save';
import { isRosterSave } from '../units/roster';
import type { RosterSave } from '../units/types';
import type { RngState } from '../core/rng';
import { MAX_TIME_SCALE } from '../core/time';
import { isDispatchSave, type DispatchSave } from '../dispatch/save';
import type { ContactSave } from '../contact';
import { isContactSave } from '../contact/save';
import { isEnvironmentSave, type EnvironmentSave } from '../environment/environment';
import { isInteriorSave, type InteriorSave } from '../indoors/save';
import { isInvestigationSave, type InvestigationSave } from '../investigation/save';
import { isNpcSave } from '../npc/save';
import type { NpcSave } from '../npc/types';
import { isPeopleSave, type PeopleSave } from '../people';
import { CAMERA_MODE } from '../player/cameraRig';
import type { PlayerModeName } from '../player/events';
import { isCharacterSave, type CharacterSave } from '../uniform';
import { isEquipmentSave, type EquipmentSave } from '../police/equipment';
import { isOfficerKitSave, type OfficerKitSave } from '../police/inventory';
import { isRadioSave, type RadioSave } from '../radio/save';
import { isRecordsSave, type RecordsSave } from '../records/db';
import { isSceneSave, type SceneSave } from '../scene/save';
import { isStationSave, type StationSave } from '../station/stationState';
import { isTacticalSave, type TacticalSave } from '../tactical/save';
import type { TrafficViolationKind } from '../traffic/events';
import { isTrafficSnapshot, type TrafficSnapshot } from '../traffic/trafficSystem';
import type { SerializedVehicle } from '../vehicles/drivableVehicle';
import { VEHICLE_MODELS } from '../vehicles/model';

/** Version written by `SaveManager.save`; bump when `SaveGame` changes shape. */
export const CURRENT_SAVE_VERSION = 9;

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

/** Last speeding reading per observed vehicle: [vehicleId, speedMph, limitMph] (citation prefill). */
export type SavedSpeeding = Array<[number, number, number]>;

/**
 * v4 (Phase 2): the patrol job. CAD (calls, units, documents, traffic stop), the dispatcher (null in
 * migrated saves: a fresh roster and fleet start at load), touched records with the shift's overlay,
 * the radio, each drivable vehicle's patrol equipment (`equipment[i]` belongs to `vehicles[i]`; null
 * for a car without equipment, or defaults) and what the officer carries.
 */
export interface SaveGameV4 extends SaveGameV3 {
  cad: CadSave;
  dispatch: DispatchSave | null;
  records: RecordsSave;
  radio: RadioSave;
  equipment: (EquipmentSave | null)[];
  officerKit: OfficerKitSave;
  /** Last speeding readings (citation prefill); optional. */
  speeding?: SavedSpeeding;
}

/**
 * v5 (Phase 3): people and calls. `people` holds only the persons the shift touched (deltas over the
 * deterministic base identity), `npc` the pedestrians, actors and occupant state (null in migrated saves:
 * fresh pedestrians at load), `contacts` the open conversations (memory, transcript, SFST) and `scenes`
 * the scenarios of open and closed calls with their branch state, flags, props and pursuits. The scene
 * block holds hidden truth and must never be shown to the player. Frozen after Phase 3.
 */
export interface SaveGameV5 extends SaveGameV4 {
  people: PeopleSave;
  npc: NpcSave | null;
  contacts: ContactSave;
  scenes: SceneSave;
}

/**
 * v6 (Phase 4): interiors and scene work. `interiors` holds the officer's level, door and light overrides and
 * the pending fade, `tactical` the stance, flashlight, partner and queued sounds, `investigation` the case files
 * (items, markers, photos with thumbnails, prints, canvass, consents, statements, bodycam), the custody ledger,
 * tapes, the K9 sweep and dusting, and `station` the shift flow, armory log, loadout, holding cells and interview.
 * Frozen after Phase 4.
 */
export interface SaveGameV6 extends SaveGameV5 {
  interiors: InteriorSave;
  tactical: TacticalSave;
  investigation: InvestigationSave;
  station: StationSave;
}

/**
 * v7 (Phase 5): law, procedure and consequences. `force` holds the selected tool, ammo, TASER attachment and cycles and
 * the fellow-officer episode, `incidents` the jurisdiction, the open and retained closed incident logs (capped), the
 * camera state and the pursuit sampler, `conduct` the community trust per district and the career (duty status, points,
 * credibility, commendations, discipline, IA cases, report grades) and `court` the cases (capped) and the calendar. Each
 * block carries its own RNG stream state. Frozen after Phase 5.
 */
export interface SaveGameV7 extends SaveGameV6 {
  force: ForceSave;
  incidents: IncidentsSave;
  conduct: ConductSave;
  court: CourtSave;
}

/**
 * v8 (Phase 6): backup, tactical and multi-agency. `roster` holds the stress, fatigue, loyalty and counters per officer
 * (profiles are pure functions of the seed and the callsign), `resources` the unit slots, the air unit, remembered
 * posts and queued requests, `backup` the on-foot officers, pending callouts and the SWAT team, `pursuit` the tracked
 * pursuit (authorization, tactic, handoff), the foot-bail perimeter and the strips, and `command` the post, victims and
 * tags, TCPs, evacuation, containment and negotiation. Each block carries its own RNG stream state (roster has none).
 * The traffic snapshot gains optional deflation / spin / cap / blockade fields without a version change.
 */
export interface SaveGameV8 extends SaveGameV7 {
  roster: RosterSave;
  resources: ResourceSave;
  backup: BackupSave;
  pursuit: PursuitSave;
  command: CommandSave;
}

/**
 * v9 (Phase 7): fleet, uniforms and customization. `character` holds the officer's profile (name, badge, pronouns, body,
 * uniform), `gear` the officer loadout and presets and `fleet` the units (livery, loadout, spawned vehicle index, stored
 * condition), the custom liveries, damage incidents and reports, the maintenance ledger and the shift-end inspection.
 * `vehicles[i]` may carry `wear`, `craft` and `pushBar` (see `SerializedVehicle`), `player.mode` may be 'remote' (`vehicle`
 * is then the drone's index) and `equipment[i]` may list `extraPrisoners`. `officer` stays equal to the profile's name and badge.
 */
export interface SaveGameV9 extends SaveGameV8 {
  character: CharacterSave;
  gear: GearSave;
  fleet: FleetSave;
}

/** Alias for the current save shape. */
export type SaveGame = SaveGameV9;

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

/** The optional Phase 7 `wear` block: oil, per-wheel tread (0..1) and odometer. */
function isVehicleWear(x: unknown): boolean {
  return x === undefined || (isRecord(x) && inRange(x['oilL'], 0, Number.MAX_VALUE) && isTuple(x['tread'], 4, isUnit) && inRange(x['odometerM'], 0, Number.MAX_VALUE));
}

/** The optional Phase 7 `craft` block (boats, helicopters, drones): integrator state. */
function isVehicleCraft(x: unknown): boolean {
  return x === undefined || (isRecord(x) && hasFiniteFields(x, ['speed', 'vy', 'yaw', 'pitch', 'roll']));
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
    isVehicleWear(x['wear']) &&
    isVehicleCraft(x['craft']) &&
    (x['pushBar'] === undefined || isBoolean(x['pushBar'])) &&
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
    player['mode'] === 'onFoot'
      ? index === -1
      : (player['mode'] === 'driving' || player['mode'] === 'remote') && index >= 0 && index < vehicles.length;
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

/** One `[vehicleId, speedMph, limitMph]` entry of `SaveGameV4.speeding`. */
function isSpeedingEntry(x: unknown): boolean {
  return Array.isArray(x) && x.length === 3 && isUint32(x[0]) && inRange(x[1], 0, Number.MAX_VALUE) && inRange(x[2], 0, Number.MAX_VALUE);
}

/** Structural check for the v4 payload: v3 plus every Phase 2 block (each module's own validator). */
export function isSaveGameV4(x: unknown): x is SaveGameV4 {
  if (!isSaveGameV3(x)) return false;
  const v4 = x as unknown as Record<string, unknown>;
  const equipment = v4['equipment'];
  const speeding = v4['speeding'];
  return (
    isCadSave(v4['cad']) &&
    (v4['dispatch'] === null || isDispatchSave(v4['dispatch'])) &&
    isRecordsSave(v4['records']) &&
    isRadioSave(v4['radio']) &&
    Array.isArray(equipment) &&
    equipment.length === x.vehicles.length &&
    equipment.every((e) => e === null || isEquipmentSave(e)) &&
    isOfficerKitSave(v4['officerKit']) &&
    (speeding === undefined || (Array.isArray(speeding) && speeding.every(isSpeedingEntry)))
  );
}

/** Structural check for the v5 payload: v4 plus the Phase 3 blocks (each module's own validator). */
export function isSaveGameV5(x: unknown): x is SaveGameV5 {
  if (!isSaveGameV4(x)) return false;
  const v5 = x as unknown as Record<string, unknown>;
  return (
    isPeopleSave(v5['people']) &&
    (v5['npc'] === null || isNpcSave(v5['npc'])) &&
    isContactSave(v5['contacts']) &&
    isSceneSave(v5['scenes'])
  );
}

/** Structural check for the v6 payload: v5 plus the Phase 4 blocks (each module's own validator). */
export function isSaveGameV6(x: unknown): x is SaveGameV6 {
  if (!isSaveGameV5(x)) return false;
  const v6 = x as unknown as Record<string, unknown>;
  return (
    isInteriorSave(v6['interiors']) &&
    isTacticalSave(v6['tactical']) &&
    isInvestigationSave(v6['investigation']) &&
    isStationSave(v6['station'])
  );
}

/** Structural check for the v7 payload: v6 plus the Phase 5 blocks (each module's own validator). */
export function isSaveGameV7(x: unknown): x is SaveGameV7 {
  if (!isSaveGameV6(x)) return false;
  const v7 = x as unknown as Record<string, unknown>;
  return (
    isForceSave(v7['force']) &&
    isIncidentsSave(v7['incidents']) &&
    isConductSave(v7['conduct']) &&
    isCourtSave(v7['court'])
  );
}

/** Structural check for the v8 payload: v7 plus the Phase 6 blocks (each module's own validator). */
export function isSaveGameV8(x: unknown): x is SaveGameV8 {
  if (!isSaveGameV7(x)) return false;
  const v8 = x as unknown as Record<string, unknown>;
  return (
    isRosterSave(v8['roster']) &&
    isResourceSave(v8['resources']) &&
    isBackupSave(v8['backup']) &&
    isPursuitSave(v8['pursuit']) &&
    isCommandSave(v8['command'])
  );
}

/** Structural check for the v9 payload: v8 plus the Phase 7 blocks (each module's own validator). */
export function isSaveGameV9(x: unknown): x is SaveGameV9 {
  if (!isSaveGameV8(x)) return false;
  const v9 = x as unknown as Record<string, unknown>;
  return isCharacterSave(v9['character']) && isGearSave(v9['gear']) && isFleetSave(v9['fleet']);
}

/** Validator for the current save shape; used after migration, on load and before every write. */
export const isSaveGame: (x: unknown) => x is SaveGame = isSaveGameV9;

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
