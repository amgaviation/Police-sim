/**
 * Tactical tuning (design §7.1): sound, stance, slicing, notice and partner numbers from
 * `src/data/tactics/tactics.json`, validated strictly at import (unknown keys are rejected). Every error names the
 * file and the JSON path.
 */
import tacticsJson from '../data/tactics/tactics.json';
import { fail, readNumber, readObject, readVersion, type JsonObject } from '../vehicles/json';
import { SOUND_KINDS, type SoundKind } from './sound';

const SOURCE_KINDS = [...SOUND_KINDS.filter((k): k is Exclude<SoundKind, 'footstep'> => k !== 'footstep'), 'radioEarpiece'] as const;

const FILE = 'tactics.json';
const FOOTSTEP_SURFACES = ['carpet', 'wood', 'tile', 'concrete', 'linoleum', 'asphalt', 'grass', 'gravel', 'dirt', 'sand'] as const;
const GAITS = ['walk', 'run', 'crouch'] as const;

export interface SoundConfig {
  readonly wallDb: number;
  readonly exteriorWallDb: number;
  readonly doorOpenDb: number;
  readonly doorClosedDb: number;
  readonly cellDoorDb: number;
  readonly stimulusRangeDb: number;
  readonly hearing: { readonly normal: number; readonly hardOfHearing: number; readonly asleepBonus: number };
  /** Footstep level at 1 m by surface name (floor surfaces and ground surfaces). */
  readonly footstepDb: Readonly<Record<string, number>>;
  /** Source level at 1 m per sound kind except footsteps (those come from `footstepDb`), plus `radioEarpiece` (a chirp heard only in the officer's earpiece). */
  readonly sources: Readonly<Record<Exclude<SoundKind, 'footstep'> | 'radioEarpiece', number>>;
  readonly footstepIntervalS: { readonly walk: number; readonly run: number; readonly crouch: number };
  readonly listenRadiusM: number;
}

export interface StanceConfig {
  readonly standEye: number;
  readonly crouchEye: number;
  readonly crouchSpeed: number;
  readonly leanOffset: number;
  readonly leanRoll: number;
  readonly leanSpeedFactor: number;
  readonly leanRate: number;
}

export interface SliceConfig {
  readonly speed: number;
  readonly radiusMin: number;
  readonly radiusMax: number;
  readonly radialSpeed: number;
  readonly maxAngle: number;
  readonly engageM: number;
  readonly engageCone: number;
}

export interface NoticeConfig {
  readonly rangeM: number;
  readonly periodS: number;
  readonly fovCos: number;
  readonly peripheral: number;
  readonly sightRate: number;
  readonly lightRate: number;
  readonly flashlightCone: number;
  readonly flashlightRange: number;
  readonly darkFactor: number;
  readonly nightOutdoor: number;
  readonly decayPerS: number;
}

export interface PartnerConfig {
  readonly followM: number;
  readonly speed: number;
  readonly stackOffset: number;
  readonly colors: { readonly top: number; readonly bottom: number };
}

export interface TacticsConfig {
  readonly sound: SoundConfig;
  readonly stance: StanceConfig;
  readonly slice: SliceConfig;
  readonly notice: NoticeConfig;
  readonly partner: PartnerConfig;
}

/** Rejects keys other than `allowed` (typos in a data file must not pass silently). */
function onlyKeys(o: JsonObject, allowed: readonly string[], path: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(FILE, path === '' ? k : `${path}.${k}`, 'is not a known field');
}

/** Object whose keys are exactly `keys`, each a number in [min, max]. */
function numberTable<K extends string>(value: unknown, keys: readonly K[], path: string, min: number, max: number): Record<K, number> {
  const o = readObject(value, FILE, path);
  onlyKeys(o, keys, path);
  const out = {} as Record<K, number>;
  for (const k of keys) out[k] = readNumber(o[k], FILE, `${path}.${k}`, min, max);
  return out;
}

function section(root: JsonObject, name: string, keys: readonly string[]): JsonObject {
  const o = readObject(root[name], FILE, name);
  onlyKeys(o, keys, name);
  return o;
}

function num(o: JsonObject, section: string, key: string, min: number, max: number): number {
  return readNumber(o[key], FILE, `${section}.${key}`, min, max);
}

/** Validates a parsed tactics file; throws an `Error` naming the file and path. Exported for tests. */
export function validateTactics(raw: unknown): TacticsConfig {
  const root = readObject(raw, FILE, '');
  readVersion(root, FILE);
  onlyKeys(root, ['version', 'sound', 'stance', 'slice', 'notice', 'partner'], '');

  const s = section(root, 'sound', ['wallDb', 'exteriorWallDb', 'doorOpenDb', 'doorClosedDb', 'cellDoorDb', 'stimulusRangeDb', 'hearing', 'footstepDb', 'sources', 'footstepIntervalS', 'listenRadiusM']);
  const hearing = numberTable(s['hearing'], ['normal', 'hardOfHearing', 'asleepBonus'] as const, 'sound.hearing', 0, 200);
  const sound: SoundConfig = {
    wallDb: num(s, 'sound', 'wallDb', 0, 200),
    exteriorWallDb: num(s, 'sound', 'exteriorWallDb', 0, 200),
    doorOpenDb: num(s, 'sound', 'doorOpenDb', 0, 200),
    doorClosedDb: num(s, 'sound', 'doorClosedDb', 0, 200),
    cellDoorDb: num(s, 'sound', 'cellDoorDb', 0, 200),
    stimulusRangeDb: num(s, 'sound', 'stimulusRangeDb', 1, 200),
    hearing,
    footstepDb: numberTable(s['footstepDb'], FOOTSTEP_SURFACES, 'sound.footstepDb', 0, 200),
    sources: numberTable(s['sources'], SOURCE_KINDS, 'sound.sources', 0, 200),
    footstepIntervalS: numberTable(s['footstepIntervalS'], GAITS, 'sound.footstepIntervalS', 0.05, 5),
    listenRadiusM: num(s, 'sound', 'listenRadiusM', 1, 500),
  };
  if (sound.doorOpenDb > sound.doorClosedDb) fail(FILE, 'sound.doorOpenDb', 'must not exceed doorClosedDb');

  const st = section(root, 'stance', ['standEye', 'crouchEye', 'crouchSpeed', 'leanOffset', 'leanRoll', 'leanSpeedFactor', 'leanRate']);
  const stance: StanceConfig = {
    standEye: num(st, 'stance', 'standEye', 0.5, 2.5),
    crouchEye: num(st, 'stance', 'crouchEye', 0.3, 2.5),
    crouchSpeed: num(st, 'stance', 'crouchSpeed', 0.05, 1),
    leanOffset: num(st, 'stance', 'leanOffset', 0, 1),
    leanRoll: num(st, 'stance', 'leanRoll', 0, 0.8),
    leanSpeedFactor: num(st, 'stance', 'leanSpeedFactor', 0.05, 1),
    leanRate: num(st, 'stance', 'leanRate', 0.1, 100),
  };
  if (stance.crouchEye >= stance.standEye) fail(FILE, 'stance.crouchEye', 'must be below standEye');

  const sl = section(root, 'slice', ['speed', 'radiusMin', 'radiusMax', 'radialSpeed', 'maxAngle', 'engageM', 'engageCone']);
  const slice: SliceConfig = {
    speed: num(sl, 'slice', 'speed', 0.01, 10),
    radiusMin: num(sl, 'slice', 'radiusMin', 0.3, 10),
    radiusMax: num(sl, 'slice', 'radiusMax', 0.3, 20),
    radialSpeed: num(sl, 'slice', 'radialSpeed', 0.01, 10),
    // Below a quarter turn: the officer never reaches the door plane.
    maxAngle: num(sl, 'slice', 'maxAngle', 0.1, Math.PI / 2 - 0.01),
    engageM: num(sl, 'slice', 'engageM', 0.5, 20),
    engageCone: num(sl, 'slice', 'engageCone', 0.1, Math.PI),
  };
  if (slice.radiusMax < slice.radiusMin) fail(FILE, 'slice.radiusMax', 'must be at least radiusMin');

  const n = section(root, 'notice', ['rangeM', 'periodS', 'fovCos', 'peripheral', 'sightRate', 'lightRate', 'flashlightCone', 'flashlightRange', 'darkFactor', 'nightOutdoor', 'decayPerS']);
  const notice: NoticeConfig = {
    rangeM: num(n, 'notice', 'rangeM', 1, 500),
    periodS: num(n, 'notice', 'periodS', 0.02, 10),
    fovCos: num(n, 'notice', 'fovCos', -1, 1),
    peripheral: num(n, 'notice', 'peripheral', 0, 1),
    sightRate: num(n, 'notice', 'sightRate', 0, 10),
    lightRate: num(n, 'notice', 'lightRate', 0, 10),
    flashlightCone: num(n, 'notice', 'flashlightCone', 0.01, Math.PI),
    flashlightRange: num(n, 'notice', 'flashlightRange', 1, 500),
    darkFactor: num(n, 'notice', 'darkFactor', 0, 1),
    nightOutdoor: num(n, 'notice', 'nightOutdoor', 0, 1),
    decayPerS: num(n, 'notice', 'decayPerS', 0, 10),
  };

  const p = section(root, 'partner', ['followM', 'speed', 'stackOffset', 'colors']);
  const colors = numberTable(p['colors'], ['top', 'bottom'] as const, 'partner.colors', 0, 0xffffff);
  const partner: PartnerConfig = {
    followM: num(p, 'partner', 'followM', 0.5, 20),
    speed: num(p, 'partner', 'speed', 0.1, 20),
    stackOffset: num(p, 'partner', 'stackOffset', 0, 5),
    colors,
  };
  return { sound, stance, slice, notice, partner };
}

/** The shipped tuning. */
export const TACTICS: TacticsConfig = validateTactics(tacticsJson);
