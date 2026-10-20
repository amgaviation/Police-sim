import behaviorsJson from '../data/npc/behaviors.json';
import densityJson from '../data/npc/density.json';
import npcJson from '../data/npc/npc.json';
import {
  fail,
  readArray,
  readBoolean,
  readNumber,
  readObject,
  readOneOf,
  readString,
  readVersion,
  type JsonObject,
} from '../vehicles/json';
import { DISTRICT_NAMES } from '../world/ids';
import { AWARE_REACTIONS, type AwareReaction } from './types';

/**
 * Validated NPC tables (design §4.4): behaviour profiles, simulation constants, pedestrian density.
 * Every parser throws an Error naming the file and the dotted field path.
 */

/** The behaviour profile ids other modules reference (design §4.0); `behaviors.json` must define every one. */
export const PROFILE_IDS = [
  'bystander', 'callerHelpful', 'callerUpset', 'victimDistraught', 'victimInjured', 'witnessReluctant', 'suspectCalm',
  'suspectNervous', 'suspectEvasive', 'suspectAgitated', 'suspectHostile', 'suspectArmedHostile', 'suspectFleeRisk',
  'subjectCrisis', 'subjectSuicidal', 'subjectIntoxicated', 'subjectConfused', 'subjectUnconscious', 'subjectDeceased',
  'juvenileScared', 'guardianWorried', 'protester', 'crowdMember', 'ambusher', 'barricaded', 'driverCooperative',
  'driverNervous', 'passenger', 'residentInnocent', 'securityGuard', 'animalDog', 'animalAggressiveDog',
] as const;

export const DEMEANORS = ['cooperative', 'nervous', 'evasive', 'hostile', 'distraught', 'confused', 'crisis', 'unresponsive', 'animal'] as const;
export type Demeanor = (typeof DEMEANORS)[number];
export const START_POSES = ['stand', 'sit', 'lying', 'kneel'] as const;
export type StartPose = (typeof START_POSES)[number];

/** One row of `behaviors.json`: how a role-bound person reacts (all chances 0..1). */
export interface BehaviorProfile {
  readonly id: string;
  readonly demeanor: Demeanor;
  /** Base chance to obey a command. */
  readonly compliance: number;
  /** Rolled once when the officer first comes within `approachTriggerM`. */
  readonly fleeChance: number;
  /** Rolled when cuffed / grabbed while not compliant. */
  readonly fightChance: number;
  /** Rolled once on approach when the actor carries a weapon. */
  readonly weaponDrawChance: number;
  /** Expected surrenders per minute (armed / barricaded / fleeing). */
  readonly surrenderPerMin: number;
  readonly startPose: StartPose;
  /** Mills around its spawn point. */
  readonly wander: boolean;
  /** Crowd actor: stays in the `crowd` state around its spawn point. */
  readonly crowd: boolean;
  /** Initial stress 0..1. */
  readonly stress: number;
  /** Weights of the reactions rolled once when the actor becomes aware (all 0 but `none` = 1 by default). */
  readonly onAware: Readonly<Record<AwareReaction, number>>;
}

export type Range = readonly [number, number];

export interface NpcConfig {
  readonly actors: {
    readonly max: number;
    readonly walkSpeed: Range;
    readonly runSpeed: Range;
    readonly staminaS: Range;
    readonly tiredFactor: number;
    readonly followDistance: number;
    readonly approachTriggerM: number;
    readonly revealDistanceM: number;
    /** Indoors a hidden actor shows itself only to an officer this close in the same room. */
    readonly revealIndoorM: number;
    readonly tackleRangeM: number;
    readonly taserRangeM: number;
    readonly taserHit: number;
    readonly taserDownS: number;
    readonly tackleDownS: number;
    readonly struggleS: number;
    readonly officerWinBase: number;
    readonly officerWinPerBackup: number;
    readonly escapeDistanceM: number;
    readonly escapeS: number;
    readonly fleeRouteM: Range;
    readonly armedActionS: Range;
    readonly leaveDistanceM: number;
    readonly crowdRadiusM: number;
    /** Awareness lost per second. */
    readonly awareDecayPerS: number;
    /** Awareness at which an actor turns towards a stimulus. */
    readonly alertAt: number;
    /** Awareness at which an actor reacts (`onAware`). */
    readonly awareAt: number;
    readonly lod: { readonly nearM: number; readonly midM: number; readonly nearHz: number; readonly midHz: number; readonly farHz: number };
  };
  readonly occupants: {
    readonly renderRadiusM: number;
    readonly seatY: number;
    /** Seat fractions of (body width, body length) in the vehicle frame: x right, z rear. Seat 0 = driver. */
    readonly seats: readonly (readonly [number, number])[];
  };
  readonly peds: {
    readonly max: number;
    readonly spawnRadiusM: number;
    readonly despawnRadiusM: number;
    readonly minSpawnM: number;
    readonly spawnPerStep: number;
    readonly walkSpeed: Range;
    readonly retargetS: number;
    readonly lod: { readonly nearM: number; readonly midM: number; readonly nearEvery: number; readonly midEvery: number; readonly farEvery: number };
  };
}

export interface DensityData {
  /** Pedestrians per km of sidewalk, indexed by `DistrictId`. */
  readonly perKm: readonly number[];
  /** 24 hourly factors. */
  readonly hourly: readonly number[];
}

// --- Readers ---------------------------------------------------------------------------

function readRange(value: unknown, file: string, path: string, min: number, max: number): [number, number] {
  const arr = readArray(value, file, path, 2);
  if (arr.length !== 2) fail(file, path, `must have 2 items, got ${arr.length}`);
  const lo = readNumber(arr[0], file, `${path}[0]`, min, max);
  const hi = readNumber(arr[1], file, `${path}[1]`, min, max);
  if (lo > hi) fail(file, path, `must be [min, max] with min <= max, got [${lo}, ${hi}]`);
  return [lo, hi];
}

function readInt(value: unknown, file: string, path: string, min: number, max: number): number {
  const n = readNumber(value, file, path, min, max);
  if (!Number.isInteger(n)) fail(file, path, `must be an integer, got ${n}`);
  return n;
}

/** Fails on keys that are not in `allowed` (typos in data files). */
function onlyKeys(obj: JsonObject, allowed: readonly string[], file: string, path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(file, path === '' ? key : `${path}.${key}`, 'is not a known field');
  }
}

/** `onAware` weights: absent = `{ none: 1 }`; keys are reaction ids, the weights are non-negative and not all 0. */
function readOnAware(value: unknown, file: string, path: string): Record<AwareReaction, number> {
  const out: Record<AwareReaction, number> = { none: 0, hide: 0, flee: 0, confront: 0, surrender: 0, arm: 0 };
  if (value === undefined) {
    out.none = 1;
    return out;
  }
  const o = readObject(value, file, path);
  let sum = 0;
  for (const key of Object.keys(o)) {
    const reaction = readOneOf(key, AWARE_REACTIONS, file, `${path}.${key}`);
    out[reaction] = readNumber(o[key], file, `${path}.${key}`, 0, 1);
    sum += out[reaction];
  }
  if (!(sum > 0)) fail(file, path, 'must have at least one positive weight');
  return out;
}

/** Validates `behaviors.json`: exactly one profile per `PROFILE_IDS` id (extra ids are allowed). */
export function parseBehaviors(raw: unknown, file = 'behaviors.json'): readonly BehaviorProfile[] {
  const root = readObject(raw, file, '');
  readVersion(root, file);
  onlyKeys(root, ['version', 'profiles'], file, '');
  const rows = readArray(root.profiles, file, 'profiles', 1);
  const out: BehaviorProfile[] = [];
  const seen = new Set<string>();
  rows.forEach((row, i) => {
    const path = `profiles[${i}]`;
    const o = readObject(row, file, path);
    onlyKeys(o, ['id', 'demeanor', 'compliance', 'fleeChance', 'fightChance', 'weaponDrawChance', 'surrenderPerMin', 'startPose', 'wander', 'crowd', 'stress', 'onAware'], file, path);
    const id = readString(o.id, file, `${path}.id`);
    if (seen.has(id)) fail(file, `${path}.id`, `duplicate profile "${id}"`);
    seen.add(id);
    out.push({
      id,
      demeanor: readOneOf(o.demeanor, DEMEANORS, file, `${path}.demeanor`),
      compliance: readNumber(o.compliance, file, `${path}.compliance`, 0, 1),
      fleeChance: readNumber(o.fleeChance, file, `${path}.fleeChance`, 0, 1),
      fightChance: readNumber(o.fightChance, file, `${path}.fightChance`, 0, 1),
      weaponDrawChance: readNumber(o.weaponDrawChance, file, `${path}.weaponDrawChance`, 0, 1),
      surrenderPerMin: readNumber(o.surrenderPerMin, file, `${path}.surrenderPerMin`, 0, 1),
      startPose: readOneOf(o.startPose, START_POSES, file, `${path}.startPose`),
      wander: readBoolean(o.wander, file, `${path}.wander`),
      crowd: o.crowd === undefined ? false : readBoolean(o.crowd, file, `${path}.crowd`),
      stress: readNumber(o.stress, file, `${path}.stress`, 0, 1),
      onAware: readOnAware(o.onAware, file, `${path}.onAware`),
    });
  });
  for (const id of PROFILE_IDS) if (!seen.has(id)) fail(file, 'profiles', `is missing the required profile "${id}"`);
  return out;
}

function readLod(value: unknown, file: string, path: string): { nearM: number; midM: number; nearHz: number; midHz: number; farHz: number } {
  const o = readObject(value, file, path);
  const nearM = readNumber(o.nearM, file, `${path}.nearM`, 0, 10000);
  const midM = readNumber(o.midM, file, `${path}.midM`, 0, 10000);
  if (midM < nearM) fail(file, `${path}.midM`, `must be >= nearM (${nearM}), got ${midM}`);
  return {
    nearM,
    midM,
    nearHz: readNumber(o.nearHz, file, `${path}.nearHz`, 0.01, 120),
    midHz: readNumber(o.midHz, file, `${path}.midHz`, 0.01, 120),
    farHz: readNumber(o.farHz, file, `${path}.farHz`, 0.01, 120),
  };
}

/** Validates `npc.json`. */
export function parseNpcConfig(raw: unknown, file = 'npc.json'): NpcConfig {
  const root = readObject(raw, file, '');
  readVersion(root, file);
  const a = readObject(root.actors, file, 'actors');
  const o = readObject(root.occupants, file, 'occupants');
  const p = readObject(root.peds, file, 'peds');
  if (!(readNumber(a.alertAt, file, 'actors.alertAt', 0, 1) <= readNumber(a.awareAt, file, 'actors.awareAt', 0, 1))) {
    fail(file, 'actors.awareAt', 'must be >= alertAt');
  }
  const seatRows = readArray(o.seats, file, 'occupants.seats', 1);
  const seats = seatRows.map((row, i) => {
    const pair = readArray(row, file, `occupants.seats[${i}]`, 2);
    if (pair.length !== 2) fail(file, `occupants.seats[${i}]`, `must have 2 items, got ${pair.length}`);
    return [readNumber(pair[0], file, `occupants.seats[${i}][0]`, -1, 1), readNumber(pair[1], file, `occupants.seats[${i}][1]`, -1, 1)] as const;
  });
  const pl = readObject(p.lod, file, 'peds.lod');
  const pedNear = readNumber(pl.nearM, file, 'peds.lod.nearM', 0, 10000);
  const pedMid = readNumber(pl.midM, file, 'peds.lod.midM', 0, 10000);
  if (pedMid < pedNear) fail(file, 'peds.lod.midM', `must be >= nearM (${pedNear}), got ${pedMid}`);
  const spawnRadius = readNumber(p.spawnRadiusM, file, 'peds.spawnRadiusM', 10, 5000);
  const despawnRadius = readNumber(p.despawnRadiusM, file, 'peds.despawnRadiusM', 10, 5000);
  if (despawnRadius <= spawnRadius) fail(file, 'peds.despawnRadiusM', `must be > spawnRadiusM (${spawnRadius}), got ${despawnRadius}`);
  const minSpawn = readNumber(p.minSpawnM, file, 'peds.minSpawnM', 0, 5000);
  if (minSpawn >= spawnRadius) fail(file, 'peds.minSpawnM', `must be < spawnRadiusM (${spawnRadius}), got ${minSpawn}`);
  return {
    actors: {
      max: readInt(a.max, file, 'actors.max', 1, 4096),
      walkSpeed: readRange(a.walkSpeed, file, 'actors.walkSpeed', 0.1, 4),
      runSpeed: readRange(a.runSpeed, file, 'actors.runSpeed', 1, 12),
      staminaS: readRange(a.staminaS, file, 'actors.staminaS', 1, 600),
      tiredFactor: readNumber(a.tiredFactor, file, 'actors.tiredFactor', 0.1, 1),
      followDistance: readNumber(a.followDistance, file, 'actors.followDistance', 0.3, 10),
      approachTriggerM: readNumber(a.approachTriggerM, file, 'actors.approachTriggerM', 1, 200),
      revealDistanceM: readNumber(a.revealDistanceM, file, 'actors.revealDistanceM', 0.5, 200),
      revealIndoorM: readNumber(a.revealIndoorM, file, 'actors.revealIndoorM', 0.5, 200),
      tackleRangeM: readNumber(a.tackleRangeM, file, 'actors.tackleRangeM', 0.5, 10),
      taserRangeM: readNumber(a.taserRangeM, file, 'actors.taserRangeM', 1, 50),
      taserHit: readNumber(a.taserHit, file, 'actors.taserHit', 0, 1),
      taserDownS: readNumber(a.taserDownS, file, 'actors.taserDownS', 0.5, 120),
      tackleDownS: readNumber(a.tackleDownS, file, 'actors.tackleDownS', 0.5, 120),
      struggleS: readNumber(a.struggleS, file, 'actors.struggleS', 0.5, 60),
      officerWinBase: readNumber(a.officerWinBase, file, 'actors.officerWinBase', 0, 1),
      officerWinPerBackup: readNumber(a.officerWinPerBackup, file, 'actors.officerWinPerBackup', 0, 1),
      escapeDistanceM: readNumber(a.escapeDistanceM, file, 'actors.escapeDistanceM', 10, 5000),
      escapeS: readNumber(a.escapeS, file, 'actors.escapeS', 0.5, 600),
      fleeRouteM: readRange(a.fleeRouteM, file, 'actors.fleeRouteM', 10, 2000),
      armedActionS: readRange(a.armedActionS, file, 'actors.armedActionS', 0.5, 120),
      leaveDistanceM: readNumber(a.leaveDistanceM, file, 'actors.leaveDistanceM', 5, 1000),
      crowdRadiusM: readNumber(a.crowdRadiusM, file, 'actors.crowdRadiusM', 1, 200),
      awareDecayPerS: readNumber(a.awareDecayPerS, file, 'actors.awareDecayPerS', 0, 10),
      alertAt: readNumber(a.alertAt, file, 'actors.alertAt', 0, 1),
      awareAt: readNumber(a.awareAt, file, 'actors.awareAt', 0, 1),
      lod: readLod(a.lod, file, 'actors.lod'),
    },
    occupants: {
      renderRadiusM: readNumber(o.renderRadiusM, file, 'occupants.renderRadiusM', 1, 1000),
      seatY: readNumber(o.seatY, file, 'occupants.seatY', -2, 2),
      seats,
    },
    peds: {
      max: readInt(p.max, file, 'peds.max', 1, 4096),
      spawnRadiusM: spawnRadius,
      despawnRadiusM: despawnRadius,
      minSpawnM: minSpawn,
      spawnPerStep: readInt(p.spawnPerStep, file, 'peds.spawnPerStep', 1, 64),
      walkSpeed: readRange(p.walkSpeed, file, 'peds.walkSpeed', 0.1, 4),
      retargetS: readNumber(p.retargetS, file, 'peds.retargetS', 0.05, 60),
      lod: {
        nearM: pedNear,
        midM: pedMid,
        nearEvery: readInt(pl.nearEvery, file, 'peds.lod.nearEvery', 1, 600),
        midEvery: readInt(pl.midEvery, file, 'peds.lod.midEvery', 1, 600),
        farEvery: readInt(pl.farEvery, file, 'peds.lod.farEvery', 1, 600),
      },
    },
  };
}

/** Validates `density.json`: `perKm` has an entry per district name, `hourly` 24 factors. */
export function parseDensity(raw: unknown, file = 'density.json'): DensityData {
  const root = readObject(raw, file, '');
  readVersion(root, file);
  const perKm = readObject(root.perKm, file, 'perKm');
  const table = DISTRICT_NAMES.map((name) => readNumber(perKm[name], file, `perKm.${name}`, 0, 10000));
  for (const key of Object.keys(perKm)) if (!(DISTRICT_NAMES as readonly string[]).includes(key)) fail(file, `perKm.${key}`, 'is not a district name');
  const hours = readArray(root.hourly, file, 'hourly', 24);
  if (hours.length !== 24) fail(file, 'hourly', `must have 24 items, got ${hours.length}`);
  return { perKm: table, hourly: hours.map((v, i) => readNumber(v, file, `hourly[${i}]`, 0, 100)) };
}

export const BEHAVIORS: readonly BehaviorProfile[] = parseBehaviors(behaviorsJson);
export const NPC_CONFIG: NpcConfig = parseNpcConfig(npcJson);
export const NPC_DENSITY: DensityData = parseDensity(densityJson);

const BY_ID = new Map<string, BehaviorProfile>(BEHAVIORS.map((p) => [p.id, p]));

/** The profile `id`; throws on an unknown id. */
export function behavior(id: string): BehaviorProfile {
  const p = BY_ID.get(id);
  if (!p) throw new Error(`Unknown behaviour profile "${id}"`);
  return p;
}

/** The profile `id` or null. */
export function findBehavior(id: string): BehaviorProfile | null {
  return BY_ID.get(id) ?? null;
}
