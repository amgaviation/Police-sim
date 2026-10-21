import worldJson from '../data/worldstate/world.json';
import { CRIME_CATEGORIES, CRIME_DISTRICTS } from '../environment/crime';
import { fail, readArray, readNumber, readObject, readString, readVersion, type JsonObject } from '../vehicles/json';
import { OFFENSE_CLASSES, type OffenseClass } from './types';

/** Persistent-world tuning (Phase 8 design §6.1): `src/data/worldstate/world.json` validated at import. */

export interface PremisesConfig {
  readonly max: number;
  readonly entriesPerPremise: number;
  readonly repeatWindowDays: number;
  readonly repeatThreshold: number;
}

export interface CasesConfig {
  readonly max: number;
  readonly coldAfterShifts: number;
  readonly followUpChance: number;
  readonly maxFollowUpsPerShift: number;
  readonly categories: readonly string[];
}

export interface OffendersConfig {
  readonly max: number;
  readonly jailDays: Readonly<Record<OffenseClass, number>>;
  readonly pendingReleaseDays: number;
  readonly riskBase: number;
  readonly riskPerPrior: number;
  readonly riskJuvenile: number;
  readonly riskConvicted: number;
  readonly riskMax: number;
  readonly riskMin: number;
  readonly riskDecayPerDay: number;
}

export interface RecidivismConfig {
  readonly pickChanceScale: number;
  readonly maxPickChance: number;
  readonly sameDistrictWeight: number;
}

export interface WitnessesConfig {
  readonly max: number;
  readonly movePerDay: number;
  readonly unknownAddressShare: number;
}

export interface NeighborhoodsConfig {
  readonly relax: number;
  readonly trustWeight: number;
  readonly offenderWeight: number;
  readonly arrestWeight: number;
  readonly noise: number;
  readonly min: number;
  readonly max: number;
  readonly historyDays: number;
  readonly crimeToTrust: number;
  readonly factorRange: readonly [number, number];
  readonly baseCrime: Readonly<Record<string, number>>;
}

export interface RepeatCallsConfig {
  readonly chance: number;
  readonly minEntries: number;
}

export interface WorldConfig {
  readonly premises: PremisesConfig;
  readonly cases: CasesConfig;
  readonly offenders: OffendersConfig;
  readonly recidivism: RecidivismConfig;
  readonly witnesses: WitnessesConfig;
  readonly neighborhoods: NeighborhoodsConfig;
  readonly repeatCalls: RepeatCallsConfig;
}

function readInt(value: unknown, source: string, path: string, min: number, max: number): number {
  const n = readNumber(value, source, path, min, max);
  if (!Number.isInteger(n)) fail(source, path, `must be an integer, got ${n}`);
  return n;
}

function readUnique(value: unknown, source: string, path: string, allowed: readonly string[]): string[] {
  const out: string[] = [];
  readArray(value, source, path, 1).forEach((v, i) => {
    const s = readString(v, source, `${path}[${i}]`);
    if (!allowed.includes(s)) fail(source, `${path}[${i}]`, `must be one of ${allowed.join(', ')}, got "${s}"`);
    if (out.includes(s)) fail(source, `${path}[${i}]`, `lists "${s}" twice`);
    out.push(s);
  });
  return out;
}

function readBaseCrime(value: unknown, source: string, path: string): Record<string, number> {
  const o = readObject(value, source, path);
  const out: Record<string, number> = {};
  for (const key of Object.keys(o)) {
    if (!(CRIME_DISTRICTS as readonly string[]).includes(key)) {
      fail(source, `${path}.${key}`, `is not a district (${CRIME_DISTRICTS.join(', ')})`);
    }
    out[key] = readNumber(o[key], source, `${path}.${key}`, 0, 1);
  }
  return out;
}

function parseJailDays(o: JsonObject, source: string, path: string): Record<OffenseClass, number> {
  const j = readObject(o, source, path);
  for (const key of Object.keys(j)) {
    if (!(OFFENSE_CLASSES as readonly string[]).includes(key)) fail(source, `${path}.${key}`, `is not an offense class (${OFFENSE_CLASSES.join(', ')})`);
  }
  const out = {} as Record<OffenseClass, number>;
  for (const c of OFFENSE_CLASSES) out[c] = readNumber(j[c], source, `${path}.${c}`, 0, 3650);
  return out;
}

/** Validates `world.json`. Every failure throws `Error('<file>: <dotted.path> <problem>')`. */
export function parseWorldConfig(json: unknown, file: string): WorldConfig {
  const root = readObject(json, file, '');
  readVersion(root, file);

  const p = readObject(root.premises, file, 'premises');
  const premises: PremisesConfig = {
    max: readInt(p.max, file, 'premises.max', 1, 100000),
    entriesPerPremise: readInt(p.entriesPerPremise, file, 'premises.entriesPerPremise', 1, 1000),
    repeatWindowDays: readNumber(p.repeatWindowDays, file, 'premises.repeatWindowDays', 0, 3650),
    repeatThreshold: readInt(p.repeatThreshold, file, 'premises.repeatThreshold', 1, 1000),
  };

  const c = readObject(root.cases, file, 'cases');
  const cases: CasesConfig = {
    max: readInt(c.max, file, 'cases.max', 1, 100000),
    coldAfterShifts: readInt(c.coldAfterShifts, file, 'cases.coldAfterShifts', 1, 1000),
    followUpChance: readNumber(c.followUpChance, file, 'cases.followUpChance', 0, 1),
    maxFollowUpsPerShift: readInt(c.maxFollowUpsPerShift, file, 'cases.maxFollowUpsPerShift', 0, 100),
    categories: readUnique(c.categories, file, 'cases.categories', CRIME_CATEGORIES),
  };

  const o = readObject(root.offenders, file, 'offenders');
  const offenders: OffendersConfig = {
    max: readInt(o.max, file, 'offenders.max', 1, 100000),
    jailDays: parseJailDays(readObject(o.jailDays, file, 'offenders.jailDays'), file, 'offenders.jailDays'),
    pendingReleaseDays: readNumber(o.pendingReleaseDays, file, 'offenders.pendingReleaseDays', 0, 3650),
    riskBase: readNumber(o.riskBase, file, 'offenders.riskBase', 0, 1),
    riskPerPrior: readNumber(o.riskPerPrior, file, 'offenders.riskPerPrior', 0, 1),
    riskJuvenile: readNumber(o.riskJuvenile, file, 'offenders.riskJuvenile', 0, 1),
    riskConvicted: readNumber(o.riskConvicted, file, 'offenders.riskConvicted', 0, 1),
    riskMax: readNumber(o.riskMax, file, 'offenders.riskMax', 0, 1),
    riskMin: readNumber(o.riskMin, file, 'offenders.riskMin', 0, 1),
    riskDecayPerDay: readNumber(o.riskDecayPerDay, file, 'offenders.riskDecayPerDay', 0, 1),
  };
  if (offenders.riskMin > offenders.riskMax) fail(file, 'offenders.riskMin', `must not exceed riskMax (${offenders.riskMax}), got ${offenders.riskMin}`);

  const r = readObject(root.recidivism, file, 'recidivism');
  const recidivism: RecidivismConfig = {
    pickChanceScale: readNumber(r.pickChanceScale, file, 'recidivism.pickChanceScale', 0, 10),
    maxPickChance: readNumber(r.maxPickChance, file, 'recidivism.maxPickChance', 0, 1),
    sameDistrictWeight: readNumber(r.sameDistrictWeight, file, 'recidivism.sameDistrictWeight', 0, 100),
  };

  const w = readObject(root.witnesses, file, 'witnesses');
  const witnesses: WitnessesConfig = {
    max: readInt(w.max, file, 'witnesses.max', 1, 100000),
    movePerDay: readNumber(w.movePerDay, file, 'witnesses.movePerDay', 0, 1),
    unknownAddressShare: readNumber(w.unknownAddressShare, file, 'witnesses.unknownAddressShare', 0, 1),
  };

  const n = readObject(root.neighborhoods, file, 'neighborhoods');
  const range = readArray(n.factorRange, file, 'neighborhoods.factorRange');
  if (range.length !== 2) fail(file, 'neighborhoods.factorRange', `must have 2 items, got ${range.length}`);
  const lo = readNumber(range[0], file, 'neighborhoods.factorRange[0]', 0, 10);
  const hi = readNumber(range[1], file, 'neighborhoods.factorRange[1]', 0, 10);
  if (lo > hi) fail(file, 'neighborhoods.factorRange', `must be [min, max], got [${lo}, ${hi}]`);
  const neighborhoods: NeighborhoodsConfig = {
    relax: readNumber(n.relax, file, 'neighborhoods.relax', 0, 10),
    trustWeight: readNumber(n.trustWeight, file, 'neighborhoods.trustWeight', 0, 10),
    offenderWeight: readNumber(n.offenderWeight, file, 'neighborhoods.offenderWeight', 0, 10),
    arrestWeight: readNumber(n.arrestWeight, file, 'neighborhoods.arrestWeight', 0, 10),
    noise: readNumber(n.noise, file, 'neighborhoods.noise', 0, 1),
    min: readNumber(n.min, file, 'neighborhoods.min', 0, 1),
    max: readNumber(n.max, file, 'neighborhoods.max', 0, 1),
    historyDays: readInt(n.historyDays, file, 'neighborhoods.historyDays', 1, 365),
    crimeToTrust: readNumber(n.crimeToTrust, file, 'neighborhoods.crimeToTrust', 0, 10),
    factorRange: [lo, hi],
    baseCrime: readBaseCrime(n.baseCrime, file, 'neighborhoods.baseCrime'),
  };
  if (neighborhoods.min > neighborhoods.max) fail(file, 'neighborhoods.min', `must not exceed max (${neighborhoods.max}), got ${neighborhoods.min}`);

  const rc = readObject(root.repeatCalls, file, 'repeatCalls');
  const repeatCalls: RepeatCallsConfig = {
    chance: readNumber(rc.chance, file, 'repeatCalls.chance', 0, 1),
    minEntries: readInt(rc.minEntries, file, 'repeatCalls.minEntries', 1, 1000),
  };

  return { premises, cases, offenders, recidivism, witnesses, neighborhoods, repeatCalls };
}

export const WORLD_CONFIG: WorldConfig = parseWorldConfig(worldJson, 'world.json');
