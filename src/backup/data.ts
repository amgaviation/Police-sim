/**
 * Backup and SWAT tuning (design §9.1): `backup.json` and `swat.json`, validated strictly at import (unknown keys are
 * rejected). Every error names the file and the JSON path.
 */
import backupJson from '../data/backup/backup.json';
import swatJson from '../data/backup/swat.json';
import { fail, readArray, readNumber, readObject, readString, readVersion, type JsonObject } from '../vehicles/json';
import { CALLOUT_KINDS, type BackupConfig, type CalloutKind, type SwatConfig } from './types';

function onlyKeys(o: JsonObject, allowed: readonly string[], file: string, path: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(file, path === '' ? k : `${path}.${k}`, 'is not a known field');
}

function section(root: JsonObject, name: string, keys: readonly string[], file: string): JsonObject {
  const o = readObject(root[name], file, name);
  onlyKeys(o, keys, file, name);
  return o;
}

function num(o: JsonObject, sec: string, key: string, file: string, min: number, max: number): number {
  return readNumber(o[key], file, `${sec}.${key}`, min, max);
}

function int(o: JsonObject, sec: string, key: string, file: string, min: number, max: number): number {
  const n = num(o, sec, key, file, min, max);
  if (!Number.isInteger(n)) fail(file, `${sec}.${key}`, `must be an integer, got ${n}`);
  return n;
}

/** `[lo, hi]` with lo <= hi. */
function range(o: JsonObject, sec: string, key: string, file: string, min: number, max: number): readonly [number, number] {
  const path = `${sec}.${key}`;
  const a = readArray(o[key], file, path);
  if (a.length !== 2) fail(file, path, `must have exactly 2 items, got ${a.length}`);
  const lo = readNumber(a[0], file, `${path}[0]`, min, max);
  const hi = readNumber(a[1], file, `${path}[1]`, min, max);
  if (lo > hi) fail(file, path, `must be [min, max] with min <= max, got [${lo}, ${hi}]`);
  return [lo, hi];
}

/** Validates `backup.json`; throws an `Error` naming the file and path. */
export function parseBackupConfig(json: unknown, file: string): BackupConfig {
  const root = readObject(json, file, '');
  readVersion(root, file);
  onlyKeys(root, ['version', 'spawn', 'move', 'cover', 'secondary', 'chase', 'callout', 'post', 'stress', 'callouts'], file, '');

  const sp = section(root, 'spawn', ['maxCarDistanceM', 'maxOfficers', 'exitS'], file);
  const mv = section(root, 'move', ['walk', 'run', 'chase', 'arriveM'], file);
  const cv = section(root, 'cover', ['distanceM', 'angleDeg', 'poorAngleDeg', 'poorDistanceM', 'repositionS'], file);
  const sc = section(root, 'secondary', ['standoffM', 'commandEveryS', 'detectRangeM'], file);
  const ch = section(root, 'chase', ['tackleRangeM', 'giveUpM'], file);
  const co = section(root, 'callout', ['delayS', 'lateDelayS', 'weaponRangeM', 'cooldownS'], file);
  const po = section(root, 'post', ['staffedM'], file);
  const st = section(root, 'stress', ['sampleS'], file);
  const cl = section(root, 'callouts', CALLOUT_KINDS, file);

  const callouts = {} as Record<CalloutKind, readonly string[]>;
  for (const k of CALLOUT_KINDS) {
    const a = readArray(cl[k], file, `callouts.${k}`, 1);
    callouts[k] = a.map((t, i) => readString(t, file, `callouts.${k}[${i}]`));
  }

  const config: BackupConfig = {
    spawn: {
      maxCarDistanceM: num(sp, 'spawn', 'maxCarDistanceM', file, 1, 1000),
      maxOfficers: int(sp, 'spawn', 'maxOfficers', file, 1, 32),
      exitS: num(sp, 'spawn', 'exitS', file, 0, 30),
    },
    move: {
      walk: num(mv, 'move', 'walk', file, 0.1, 20),
      run: num(mv, 'move', 'run', file, 0.1, 20),
      chase: num(mv, 'move', 'chase', file, 0.1, 20),
      arriveM: num(mv, 'move', 'arriveM', file, 0.05, 5),
    },
    cover: {
      distanceM: range(cv, 'cover', 'distanceM', file, 0.5, 100),
      angleDeg: range(cv, 'cover', 'angleDeg', file, 0, 180),
      poorAngleDeg: num(cv, 'cover', 'poorAngleDeg', file, 90, 180),
      poorDistanceM: num(cv, 'cover', 'poorDistanceM', file, 0.1, 100),
      repositionS: num(cv, 'cover', 'repositionS', file, 0.1, 60),
    },
    secondary: {
      standoffM: num(sc, 'secondary', 'standoffM', file, 0.5, 50),
      commandEveryS: num(sc, 'secondary', 'commandEveryS', file, 0.5, 120),
      detectRangeM: num(sc, 'secondary', 'detectRangeM', file, 1, 200),
    },
    chase: {
      tackleRangeM: num(ch, 'chase', 'tackleRangeM', file, 0.3, 10),
      giveUpM: num(ch, 'chase', 'giveUpM', file, 10, 2000),
    },
    callout: {
      delayS: range(co, 'callout', 'delayS', file, 0, 60),
      lateDelayS: range(co, 'callout', 'lateDelayS', file, 0, 60),
      weaponRangeM: num(co, 'callout', 'weaponRangeM', file, 1, 200),
      cooldownS: num(co, 'callout', 'cooldownS', file, 0, 600),
    },
    post: { staffedM: num(po, 'post', 'staffedM', file, 0.5, 50) },
    stress: { sampleS: num(st, 'stress', 'sampleS', file, 0.05, 60) },
    callouts,
  };
  if (config.callout.lateDelayS[0] < config.callout.delayS[1]) fail(file, 'callout.lateDelayS', 'must start after delayS ends');
  if (config.cover.angleDeg[1] >= config.cover.poorAngleDeg) fail(file, 'cover.poorAngleDeg', 'must exceed the cover angle range');
  if (config.cover.distanceM[0] <= config.cover.poorDistanceM) fail(file, 'cover.poorDistanceM', 'must be below the cover distance range');
  if (config.move.run < config.move.walk) fail(file, 'move.run', 'must be at least move.walk');
  return config;
}

/** Validates `swat.json`; throws an `Error` naming the file and path. */
export function parseSwatConfig(json: unknown, file: string): SwatConfig {
  const root = readObject(json, file, '');
  readVersion(root, file);
  onlyKeys(root, ['version', 'operators', 'speed', 'stackOffsetM', 'roomS', 'breachS', 'stageDistanceM', 'contact', 'colors'], file, '');
  const sp = section(root, 'speed', ['walk', 'move'], file);
  const rm = section(root, 'roomS', ['deliberate', 'dynamic'], file);
  const ct = section(root, 'contact', [
    'surrenderBase', 'negotiationTrust', 'dynamicSurprise', 'lessLethal', 'hostagePenalty', 'armedPenalty',
    'hostageInjuryBase', 'hostageInjuryDynamic', 'subjectInjuryLessLethal',
  ], file);
  const cl = section(root, 'colors', ['top', 'bottom'], file);
  const p = (k: string): number => num(ct, 'contact', k, file, 0, 1);
  const operators = readNumber(root.operators, file, 'operators', 1, 8);
  if (!Number.isInteger(operators)) fail(file, 'operators', `must be an integer, got ${operators}`);
  return {
    operators,
    speed: { walk: num(sp, 'speed', 'walk', file, 0.1, 20), move: num(sp, 'speed', 'move', file, 0.1, 20) },
    stackOffsetM: readNumber(root.stackOffsetM, file, 'stackOffsetM', 0.2, 3),
    roomS: { deliberate: num(rm, 'roomS', 'deliberate', file, 0, 120), dynamic: num(rm, 'roomS', 'dynamic', file, 0, 120) },
    breachS: readNumber(root.breachS, file, 'breachS', 0, 60),
    stageDistanceM: readNumber(root.stageDistanceM, file, 'stageDistanceM', 3, 300),
    contact: {
      surrenderBase: p('surrenderBase'),
      negotiationTrust: p('negotiationTrust'),
      dynamicSurprise: p('dynamicSurprise'),
      lessLethal: p('lessLethal'),
      hostagePenalty: p('hostagePenalty'),
      armedPenalty: p('armedPenalty'),
      hostageInjuryBase: p('hostageInjuryBase'),
      hostageInjuryDynamic: p('hostageInjuryDynamic'),
      subjectInjuryLessLethal: p('subjectInjuryLessLethal'),
    },
    colors: {
      top: int(cl, 'colors', 'top', file, 0, 0xffffff),
      bottom: int(cl, 'colors', 'bottom', file, 0, 0xffffff),
    },
  };
}

/** The shipped backup tuning. */
export const BACKUP_CONFIG: BackupConfig = parseBackupConfig(backupJson, 'backup.json');
/** The shipped SWAT tuning. */
export const SWAT_CONFIG: SwatConfig = parseSwatConfig(swatJson, 'swat.json');
