/**
 * Pursuit tuning (design §10.1): `pursuit.json` validated at import. Every error names the file and the dotted path.
 */
import pursuitJson from '../data/pursuit/pursuit.json';
import {
  fail,
  readArray,
  readBoolean,
  readNumber,
  readObject,
  readString,
  readVersion,
  type JsonObject,
} from '../vehicles/json';
import { VEHICLE_MODELS } from '../vehicles/model';
import type { CityLimits, PursuitConfig } from './types';

export type { PursuitConfig } from './types';

function rejectUnknown(obj: JsonObject, allowed: readonly string[], file: string, path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(file, path === '' ? key : `${path}.${key}`, `is not one of ${allowed.join(', ')}`);
  }
}

function section(root: JsonObject, key: string, keys: readonly string[], file: string): JsonObject {
  const obj = readObject(root[key], file, key);
  rejectUnknown(obj, keys, file, key);
  return obj;
}

function readInt(value: unknown, file: string, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = readNumber(value, file, path, min, max);
  if (!Number.isInteger(n)) fail(file, path, `must be an integer, got ${n}`);
  return n;
}

function readStrings(value: unknown, file: string, path: string): string[] {
  return readArray(value, file, path).map((v, i) => readString(v, file, `${path}[${i}]`));
}

function parseLimits(value: unknown, file: string, path: string): CityLimits {
  const o = readObject(value, file, path);
  rejectUnknown(o, ['minX', 'maxX', 'minZ', 'maxZ'], file, path);
  const limits: CityLimits = {
    minX: readNumber(o.minX, file, `${path}.minX`),
    maxX: readNumber(o.maxX, file, `${path}.maxX`),
    minZ: readNumber(o.minZ, file, `${path}.minZ`),
    maxZ: readNumber(o.maxZ, file, `${path}.maxZ`),
  };
  if (limits.minX >= limits.maxX) fail(file, path, 'minX must be below maxX');
  if (limits.minZ >= limits.maxZ) fail(file, path, 'minZ must be below maxZ');
  return limits;
}

/** Validates `pursuit.json` (exported for tests that feed variants). */
export function parsePursuitConfig(json: unknown, file: string): PursuitConfig {
  const root = readObject(json, file, '');
  readVersion(root, file);
  rejectUnknown(root, ['version', 'pit', 'spikes', 'boxIn', 'roadblock', 'risk', 'supervisor', 'perimeter', 'handoff', 'follow', 'air'], file, '');

  const p = section(root, 'pit', ['minMph', 'maxMph', 'maxRelMph', 'rearZoneFrac', 'lateralMinFrac', 'maxHeadingDeg', 'ramMph', 'forbiddenModels', 'requiresAuthorization', 'allowedOffenses'], file);
  const forbiddenModels = readStrings(p.forbiddenModels, file, 'pit.forbiddenModels');
  forbiddenModels.forEach((id, i) => {
    if (!VEHICLE_MODELS.some((m) => m.id === id)) fail(file, `pit.forbiddenModels[${i}]`, `is not a vehicle model, got "${id}"`);
  });
  const pit = {
    minMph: readNumber(p.minMph, file, 'pit.minMph', 0, 200),
    maxMph: readNumber(p.maxMph, file, 'pit.maxMph', 0, 200),
    maxRelMph: readNumber(p.maxRelMph, file, 'pit.maxRelMph', 0, 200),
    rearZoneFrac: readNumber(p.rearZoneFrac, file, 'pit.rearZoneFrac', 0.01, 0.5),
    lateralMinFrac: readNumber(p.lateralMinFrac, file, 'pit.lateralMinFrac', 0, 1),
    maxHeadingDeg: readNumber(p.maxHeadingDeg, file, 'pit.maxHeadingDeg', 0, 180),
    ramMph: readNumber(p.ramMph, file, 'pit.ramMph', 0, 200),
    forbiddenModels,
    requiresAuthorization: readBoolean(p.requiresAuthorization, file, 'pit.requiresAuthorization'),
    allowedOffenses: readStrings(p.allowedOffenses, file, 'pit.allowedOffenses'),
  };
  if (pit.minMph > pit.maxMph) fail(file, 'pit.minMph', `must not exceed pit.maxMph, got ${pit.minMph} > ${pit.maxMph}`);

  const s = section(root, 'spikes', ['lengthM', 'aheadJunctions', 'setbackM', 'expireS', 'playerDeployRangeM', 'tiresOnHit'], file);
  const spikes = {
    lengthM: readNumber(s.lengthM, file, 'spikes.lengthM', 0.5, 50),
    aheadJunctions: readInt(s.aheadJunctions, file, 'spikes.aheadJunctions', 1, 10),
    setbackM: readNumber(s.setbackM, file, 'spikes.setbackM', 0, 500),
    expireS: readNumber(s.expireS, file, 'spikes.expireS', 1, 3600),
    playerDeployRangeM: readNumber(s.playerDeployRangeM, file, 'spikes.playerDeployRangeM', 0.5, 100),
    tiresOnHit: readInt(s.tiresOnHit, file, 'spikes.tiresOnHit', 1, 4),
  };

  const b = section(root, 'boxIn', ['maxSuspectMph', 'radiusM', 'minAiUnits', 'requirePlayer'], file);
  const boxIn = {
    maxSuspectMph: readNumber(b.maxSuspectMph, file, 'boxIn.maxSuspectMph', 0, 200),
    radiusM: readNumber(b.radiusM, file, 'boxIn.radiusM', 1, 500),
    minAiUnits: readInt(b.minAiUnits, file, 'boxIn.minAiUnits', 0, 10),
    requirePlayer: readBoolean(b.requirePlayer, file, 'boxIn.requirePlayer'),
  };

  const r = section(root, 'roadblock', ['aheadM', 'lateralM', 'minUnits', 'decelMps2', 'stopMps'], file);
  const roadblock = {
    aheadM: readNumber(r.aheadM, file, 'roadblock.aheadM', 1, 2000),
    lateralM: readNumber(r.lateralM, file, 'roadblock.lateralM', 0.5, 200),
    minUnits: readInt(r.minUnits, file, 'roadblock.minUnits', 1, 3),
    decelMps2: readNumber(r.decelMps2, file, 'roadblock.decelMps2', 0.01, 20),
    stopMps: readNumber(r.stopMps, file, 'roadblock.stopMps', 0, 50),
  };

  const k = section(root, 'risk', ['overLimitPer10Mph', 'district', 'wet', 'night', 'density', 'perMinute', 'nonViolent', 'lostSight', 'airUnitRelief'], file);
  const districtJson = readObject(k.district, file, 'risk.district');
  const district: Record<string, number> = {};
  for (const name of Object.keys(districtJson)) district[name] = readNumber(districtJson[name], file, `risk.district.${name}`, 0, 1);
  const risk = {
    overLimitPer10Mph: readNumber(k.overLimitPer10Mph, file, 'risk.overLimitPer10Mph', 0, 1),
    district,
    wet: readNumber(k.wet, file, 'risk.wet', 0, 1),
    night: readNumber(k.night, file, 'risk.night', 0, 1),
    density: readNumber(k.density, file, 'risk.density', 0, 1),
    perMinute: readNumber(k.perMinute, file, 'risk.perMinute', 0, 1),
    nonViolent: readNumber(k.nonViolent, file, 'risk.nonViolent', 0, 1),
    lostSight: readNumber(k.lostSight, file, 'risk.lostSight', 0, 1),
    airUnitRelief: readNumber(k.airUnitRelief, file, 'risk.airUnitRelief', -1, 0),
  };

  const u = section(root, 'supervisor', ['monitorDelayS', 'riskTerminate', 'riskTerminateNonViolent', 'lostSightS', 'checkS', 'repeatS'], file);
  const supervisor = {
    monitorDelayS: readNumber(u.monitorDelayS, file, 'supervisor.monitorDelayS', 0, 600),
    riskTerminate: readNumber(u.riskTerminate, file, 'supervisor.riskTerminate', 0, 1),
    riskTerminateNonViolent: readNumber(u.riskTerminateNonViolent, file, 'supervisor.riskTerminateNonViolent', 0, 1),
    lostSightS: readNumber(u.lostSightS, file, 'supervisor.lostSightS', 0, 600),
    checkS: readNumber(u.checkS, file, 'supervisor.checkS', 0.05, 60),
    repeatS: readNumber(u.repeatS, file, 'supervisor.repeatS', 0, 600),
  };
  if (supervisor.riskTerminateNonViolent > supervisor.riskTerminate) {
    fail(file, 'supervisor.riskTerminateNonViolent', 'must not exceed supervisor.riskTerminate');
  }

  const m = section(root, 'perimeter', ['radiusM', 'posts', 'postNearM', 'escapeM', 'requestK9', 'requestAir', 'lostSightS'], file);
  const perimeter = {
    radiusM: readNumber(m.radiusM, file, 'perimeter.radiusM', 30, 2000),
    posts: readInt(m.posts, file, 'perimeter.posts', 1, 12),
    postNearM: readNumber(m.postNearM, file, 'perimeter.postNearM', 1, 500),
    escapeM: readNumber(m.escapeM, file, 'perimeter.escapeM', 30, 3000),
    requestK9: readBoolean(m.requestK9, file, 'perimeter.requestK9'),
    requestAir: readBoolean(m.requestAir, file, 'perimeter.requestAir'),
    lostSightS: readNumber(m.lostSightS, file, 'perimeter.lostSightS', 0, 600),
  };
  if (perimeter.escapeM <= perimeter.radiusM) fail(file, 'perimeter.escapeM', 'must exceed perimeter.radiusM');

  const h = section(root, 'handoff', ['cityLimits', 'requestAheadS', 'takeoverM', 'resolveS', 'catchChance', 'removeAfterS'], file);
  const resolve = readArray(h.resolveS, file, 'handoff.resolveS');
  if (resolve.length !== 2) fail(file, 'handoff.resolveS', `must have exactly 2 items, got ${resolve.length}`);
  const lo = readNumber(resolve[0], file, 'handoff.resolveS[0]', 0, 3600);
  const hi = readNumber(resolve[1], file, 'handoff.resolveS[1]', 0, 3600);
  if (lo > hi) fail(file, 'handoff.resolveS', `must be [min, max] with min <= max, got [${lo}, ${hi}]`);
  const handoff = {
    cityLimits: parseLimits(h.cityLimits, file, 'handoff.cityLimits'),
    requestAheadS: readNumber(h.requestAheadS, file, 'handoff.requestAheadS', 0, 3600),
    takeoverM: readNumber(h.takeoverM, file, 'handoff.takeoverM', 1, 5000),
    resolveS: [lo, hi] as const,
    catchChance: readNumber(h.catchChance, file, 'handoff.catchChance', 0, 1),
    removeAfterS: readNumber(h.removeAfterS, file, 'handoff.removeAfterS', 0, 3600),
  };

  const f = section(root, 'follow', ['replanS'], file);
  const a = section(root, 'air', ['trackM'], file);
  return {
    pit,
    spikes,
    boxIn,
    roadblock,
    risk,
    supervisor,
    perimeter,
    handoff,
    follow: { replanS: readNumber(f.replanS, file, 'follow.replanS', 0.1, 60) },
    air: { trackM: readNumber(a.trackM, file, 'air.trackM', 1, 5000) },
  };
}

/** The shipped pursuit tuning. */
export const PURSUIT_CONFIG: PursuitConfig = parsePursuitConfig(pursuitJson, 'src/data/pursuit/pursuit.json');
