/**
 * Dispatch data (design §4.6): the unit roster (`units.json`) and the dispatcher tuning
 * (`dispatch.json`), validated at import. Every validation error names the file and the field.
 */
import dispatchJson from '../data/dispatch/dispatch.json';
import unitsJson from '../data/dispatch/units.json';
import { fail, readArray, readNumber, readObject, readString, readVersion, type JsonObject } from '../vehicles/json';
import { VEHICLE_MODELS } from '../vehicles/model';
import { DISTRICT_NAMES } from '../world/ids';

export interface PlayerUnitData {
  readonly callsign: string;
  readonly officer: string;
  /** District name (`DISTRICT_NAMES`). */
  readonly beat: string;
}

export interface AiUnitData {
  readonly callsign: string;
  readonly officer: string;
  /** Vehicle model id (a model with an `equipment` section, e.g. patrol_sedan). */
  readonly model: string;
  readonly beat: string;
}

export interface UnitsData {
  readonly player: PlayerUnitData;
  readonly units: readonly AiUnitData[];
}

export interface DispatchConfig {
  readonly generator: {
    readonly meanIntervalS: number;
    readonly firstCallDelayS: number;
    readonly maxOpenCalls: number;
    readonly nearPlayerShare: number;
    readonly nearRadiusM: number;
    readonly minDistanceM: number;
    readonly crimeReferenceRate: number;
  };
  readonly offer: { readonly radiusM: number; readonly timeoutS: number };
  readonly assign: { readonly maxDistanceM: number; readonly p1Units: number };
  readonly statusCheck: { readonly afterS: number; readonly responseS: number; readonly attempts: number; readonly escalateUnits: number };
  readonly backup: {
    readonly code2Units: number;
    readonly code3Units: number;
    readonly retargetS: number;
    readonly retargetMoveM: number;
    /** Backup / emergency / welfare units are released this long after code 4 (s). */
    readonly releaseS: number;
  };
  readonly emergency: { readonly units: number };
  readonly aiUnits: {
    readonly stuckS: number;
    readonly forceArriveS: number;
    readonly beatRadiusM: number;
    readonly breakChancePerHour: number;
    readonly breakS: readonly [number, number];
  };
  readonly avlIntervalS: number;
}

function rejectUnknown(obj: JsonObject, allowed: readonly string[], file: string, path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(file, path === '' ? key : `${path}.${key}`, `is not one of ${allowed.join(', ')}`);
  }
}

function readInt(value: unknown, file: string, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = readNumber(value, file, path, min, max);
  if (!Number.isInteger(n)) fail(file, path, `must be an integer, got ${n}`);
  return n;
}

function readBeat(value: unknown, file: string, path: string): string {
  const beat = readString(value, file, path);
  if (!(DISTRICT_NAMES as readonly string[]).includes(beat) || beat === 'water') {
    fail(file, path, `must be a land district (${DISTRICT_NAMES.filter((d) => d !== 'water').join(', ')}), got "${beat}"`);
  }
  return beat;
}

function readCallsign(value: unknown, file: string, path: string, seen: Set<string>): string {
  const callsign = readString(value, file, path);
  if (seen.has(callsign)) fail(file, path, `duplicates callsign "${callsign}"`);
  seen.add(callsign);
  return callsign;
}

export function validateUnits(data: unknown, file = 'units.json', maxUnits = 16): UnitsData {
  const root = readObject(data, file, '');
  readVersion(root, file);
  rejectUnknown(root, ['version', 'player', 'units'], file, '');
  const seen = new Set<string>();
  const p = readObject(root.player, file, 'player');
  rejectUnknown(p, ['callsign', 'officer', 'beat'], file, 'player');
  const player: PlayerUnitData = {
    callsign: readCallsign(p.callsign, file, 'player.callsign', seen),
    officer: p.officer === undefined ? 'Officer' : readString(p.officer, file, 'player.officer'),
    beat: readBeat(p.beat, file, 'player.beat'),
  };
  const list = readArray(root.units, file, 'units', 1);
  if (list.length > maxUnits) fail(file, 'units', `must have at most ${maxUnits} items (fleet cars), got ${list.length}`);
  const units = list.map((raw, i): AiUnitData => {
    const path = `units[${i}]`;
    const u = readObject(raw, file, path);
    rejectUnknown(u, ['callsign', 'officer', 'model', 'beat'], file, path);
    const model = readString(u.model, file, `${path}.model`);
    const m = VEHICLE_MODELS.find((v) => v.id === model);
    if (!m) fail(file, `${path}.model`, `must be a vehicle model id, got "${model}"`);
    if (m.equipment === null) fail(file, `${path}.model`, `must be a police model (with equipment), got "${model}"`);
    return {
      callsign: readCallsign(u.callsign, file, `${path}.callsign`, seen),
      officer: readString(u.officer, file, `${path}.officer`),
      model,
      beat: readBeat(u.beat, file, `${path}.beat`),
    };
  });
  return { player, units };
}

export function validateDispatchConfig(data: unknown, file = 'dispatch.json'): DispatchConfig {
  const root = readObject(data, file, '');
  readVersion(root, file);
  rejectUnknown(root, ['version', 'generator', 'offer', 'assign', 'statusCheck', 'backup', 'emergency', 'aiUnits', 'avlIntervalS'], file, '');
  const section = (key: string, keys: readonly string[]): JsonObject => {
    const obj = readObject(root[key], file, key);
    rejectUnknown(obj, keys, file, key);
    return obj;
  };
  const num = (obj: JsonObject, sec: string, key: string, min: number, max = Infinity): number =>
    readNumber(obj[key], file, `${sec}.${key}`, min, max);
  const int = (obj: JsonObject, sec: string, key: string, min: number, max?: number): number =>
    readInt(obj[key], file, `${sec}.${key}`, min, max);

  const g = section('generator', ['meanIntervalS', 'firstCallDelayS', 'maxOpenCalls', 'nearPlayerShare', 'nearRadiusM', 'minDistanceM', 'crimeReferenceRate']);
  const generator = {
    meanIntervalS: num(g, 'generator', 'meanIntervalS', 1),
    firstCallDelayS: num(g, 'generator', 'firstCallDelayS', 0),
    maxOpenCalls: int(g, 'generator', 'maxOpenCalls', 1, 100),
    nearPlayerShare: num(g, 'generator', 'nearPlayerShare', 0, 1),
    nearRadiusM: num(g, 'generator', 'nearRadiusM', 1),
    minDistanceM: num(g, 'generator', 'minDistanceM', 0),
    crimeReferenceRate: num(g, 'generator', 'crimeReferenceRate', 1e-6),
  };
  if (generator.minDistanceM >= generator.nearRadiusM) {
    fail(file, 'generator.minDistanceM', `must be below generator.nearRadiusM (${generator.nearRadiusM}), got ${generator.minDistanceM}`);
  }
  const o = section('offer', ['radiusM', 'timeoutS']);
  const a = section('assign', ['maxDistanceM', 'p1Units']);
  const s = section('statusCheck', ['afterS', 'responseS', 'attempts', 'escalateUnits']);
  const b = section('backup', ['code2Units', 'code3Units', 'retargetS', 'retargetMoveM', 'releaseS']);
  const e = section('emergency', ['units']);
  const u = section('aiUnits', ['stuckS', 'forceArriveS', 'beatRadiusM', 'breakChancePerHour', 'breakS']);
  const breakArr = readArray(u.breakS, file, 'aiUnits.breakS', 2);
  if (breakArr.length !== 2) fail(file, 'aiUnits.breakS', `must have 2 items, got ${breakArr.length}`);
  const breakS: [number, number] = [
    readNumber(breakArr[0], file, 'aiUnits.breakS[0]', 1),
    readNumber(breakArr[1], file, 'aiUnits.breakS[1]', 1),
  ];
  if (breakS[0] > breakS[1]) fail(file, 'aiUnits.breakS', `must be [min, max] with min <= max, got [${breakS[0]}, ${breakS[1]}]`);
  return {
    generator,
    offer: { radiusM: num(o, 'offer', 'radiusM', 0), timeoutS: num(o, 'offer', 'timeoutS', 1) },
    assign: { maxDistanceM: num(a, 'assign', 'maxDistanceM', 1), p1Units: int(a, 'assign', 'p1Units', 1, 16) },
    statusCheck: {
      afterS: num(s, 'statusCheck', 'afterS', 1),
      responseS: num(s, 'statusCheck', 'responseS', 1),
      attempts: int(s, 'statusCheck', 'attempts', 1, 10),
      escalateUnits: int(s, 'statusCheck', 'escalateUnits', 1, 16),
    },
    backup: {
      code2Units: int(b, 'backup', 'code2Units', 1, 16),
      code3Units: int(b, 'backup', 'code3Units', 1, 16),
      retargetS: num(b, 'backup', 'retargetS', 0.1),
      retargetMoveM: num(b, 'backup', 'retargetMoveM', 0),
      releaseS: b.releaseS === undefined ? 30 : num(b, 'backup', 'releaseS', 0),
    },
    emergency: { units: int(e, 'emergency', 'units', 1, 16) },
    aiUnits: {
      stuckS: num(u, 'aiUnits', 'stuckS', 1),
      forceArriveS: num(u, 'aiUnits', 'forceArriveS', 1),
      beatRadiusM: num(u, 'aiUnits', 'beatRadiusM', 1),
      breakChancePerHour: num(u, 'aiUnits', 'breakChancePerHour', 0, 3600),
      breakS,
    },
    avlIntervalS: readNumber(root.avlIntervalS, file, 'avlIntervalS', 0.01, 60),
  };
}

export const UNITS_DATA: UnitsData = validateUnits(unitsJson);
export const DISPATCH_CONFIG: DispatchConfig = validateDispatchConfig(dispatchJson);
