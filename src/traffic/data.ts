import densityJson from '../data/traffic/density.json';
import pulloverJson from '../data/traffic/pullover.json';
import registryJson from '../data/traffic/registry.json';
import violationsJson from '../data/traffic/violations.json';
import { fail, readArray, readBoolean, readNumber, readObject, readVersion, type JsonObject } from '../vehicles/json';
import { DISTRICT_NAMES } from '../world/ids';

// --- Validated shapes ------------------------------------------------------------

export interface ViolationsData {
  /** Probabilities per registered vehicle. */
  readonly vehicleFlags: {
    readonly expiredRegistration: number;
    readonly noInsurance: number;
    readonly stolen: number;
    readonly headlightOut: number;
    readonly taillightOut: number;
    readonly brakeLightOut: number;
  };
  readonly behaviors: {
    readonly speeding: { readonly share: number; readonly speedFactor: readonly [number, number] };
    readonly tailgating: { readonly share: number; readonly headwayS: readonly [number, number] };
    readonly redLight: { readonly share: number; readonly lateRedS: number };
    readonly rollingStop: { readonly share: number };
    readonly dui: {
      readonly share: number;
      /** 24 multipliers on the per-trip DUI chance, index = hour. */
      readonly hourMultiplier: readonly number[];
      readonly weaveAmplitude: readonly [number, number];
      readonly weavePeriodS: readonly [number, number];
      readonly speedJitter: number;
    };
  };
  /** Violations further than this from the focus are not reported (m). */
  readonly observeRadius: number;
}

export interface DensityData {
  /** Max simultaneous traffic cars (SoA size). */
  readonly capacity: number;
  readonly baseActive: number;
  /** Multiplier per district id (DISTRICT order). */
  readonly district: readonly number[];
  /** 24 multipliers, index = hour. */
  readonly hourMultiplier: readonly number[];
  readonly radii: {
    readonly spawnMin: number;
    readonly spawnMax: number;
    readonly initialMin: number;
    readonly despawn: number;
    readonly proxy: number;
    readonly proxyRelease: number;
  };
  readonly spawnPerTick: number;
  readonly tickS: number;
}

export interface RegistryData {
  readonly population: number;
  readonly yearRange: readonly [number, number];
}

/** Traffic stops, yielding and fleet cars (Phase 2 design §4.3, §7). */
export interface PulloverData {
  /** Stop candidate window ahead of the player car (centre distances, m) and the time it must persist (s). */
  readonly detect: {
    readonly minDistance: number;
    readonly maxDistance: number;
    readonly lateral: number;
    readonly headingDot: number;
    readonly delayS: number;
    /** The player car must be moving at least this fast (m/s) along its heading: a parked car with scene lights stops no one. */
    readonly minPatrolSpeed: number;
    /** A candidate pulling away faster than the player car by more than this (m/s) is not being followed. */
    readonly closingTol: number;
  };
  /**
   * Curb offset: clearance past the lane edge (m), lateral speed (m/s), braking (m/s²), no pull this close
   * to a stop line (m); while the curb move is deferred past a junction the car slows to `approachSpeed` (m/s).
   */
  readonly curb: {
    readonly approachSpeed: number;
    readonly clearance: number;
    readonly lateralSpeed: number;
    readonly decel: number;
    readonly noPullNearLineM: number;
    readonly hazards: boolean;
  };
  /** Merging back (m/s) and the focus distance that ends a stop (m). */
  readonly release: { readonly lateralSpeed: number; readonly autoReleaseM: number };
  /** Yielding to emergency vehicles: range ahead (m), lateral window (m), pass margin (m), timeout (s). */
  readonly yield: { readonly range: number; readonly lateral: number; readonly passMargin: number; readonly timeoutS: number };
  /** AI police fleet cars: count, speed factors on the limit, caps (m/s), crossing speed (m/s), arrival distance (m). */
  readonly fleet: {
    readonly maxCars: number;
    readonly patrolFactor: number;
    readonly respondFactor: number;
    readonly emergencyFactor: number;
    readonly maxEmergencySpeed: number;
    readonly crossSpeed: number;
    readonly arriveDistance: number;
  };
  /**
   * Vehicle pursuits (Phase 3 design §7.1): desired speed is `min(limit * speedFactor, maxSpeed)` (m/s), reds and
   * signs are crossed at `crossSpeed` (m/s), the car escapes once farther than `loseDistanceM` from the focus
   * for `loseS` seconds, and after `minFleeS` it gives up with probability `giveUpPerMin / 60` per second;
   * `awayBias` is the chance an exit choice takes the exit leading farthest from the focus.
   */
  readonly flee: {
    readonly speedFactor: number;
    readonly maxSpeed: number;
    readonly crossSpeed: number;
    readonly loseDistanceM: number;
    readonly loseS: number;
    readonly giveUpPerMin: number;
    readonly minFleeS: number;
    readonly awayBias: number;
  };
}

// --- Readers --------------------------------------------------------------------------

function readRange(value: unknown, file: string, path: string, min: number, max: number): [number, number] {
  const arr = readArray(value, file, path, 2);
  if (arr.length !== 2) fail(file, path, `must have 2 items, got ${arr.length}`);
  const lo = readNumber(arr[0], file, `${path}[0]`, min, max);
  const hi = readNumber(arr[1], file, `${path}[1]`, min, max);
  if (lo > hi) fail(file, path, `must be [min, max] with min <= max, got [${lo}, ${hi}]`);
  return [lo, hi];
}

function readHours(value: unknown, file: string, path: string): number[] {
  const arr = readArray(value, file, path, 24);
  if (arr.length !== 24) fail(file, path, `must have 24 items, got ${arr.length}`);
  return arr.map((v, i) => readNumber(v, file, `${path}[${i}]`, 0, 1000));
}

function readInt(value: unknown, file: string, path: string, min: number, max: number): number {
  const n = readNumber(value, file, path, min, max);
  if (!Number.isInteger(n)) fail(file, path, `must be an integer, got ${n}`);
  return n;
}

function probability(obj: JsonObject, key: string, file: string, path: string): number {
  return readNumber(obj[key], file, `${path}.${key}`, 0, 1);
}

// --- Validators -----------------------------------------------------------------------

export function validateViolations(data: unknown, file = 'violations.json'): ViolationsData {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const flags = readObject(root.vehicleFlags, file, 'vehicleFlags');
  const p = (key: string): number => probability(flags, key, file, 'vehicleFlags');
  const b = readObject(root.behaviors, file, 'behaviors');
  const sec = (key: string): JsonObject => readObject(b[key], file, `behaviors.${key}`);
  const speeding = sec('speeding');
  const tailgating = sec('tailgating');
  const redLight = sec('redLight');
  const rollingStop = sec('rollingStop');
  const dui = sec('dui');
  return {
    vehicleFlags: {
      expiredRegistration: p('expiredRegistration'),
      noInsurance: p('noInsurance'),
      stolen: p('stolen'),
      headlightOut: p('headlightOut'),
      taillightOut: p('taillightOut'),
      brakeLightOut: p('brakeLightOut'),
    },
    behaviors: {
      speeding: {
        share: probability(speeding, 'share', file, 'behaviors.speeding'),
        speedFactor: readRange(speeding.speedFactor, file, 'behaviors.speeding.speedFactor', 1, 3),
      },
      tailgating: {
        share: probability(tailgating, 'share', file, 'behaviors.tailgating'),
        headwayS: readRange(tailgating.headwayS, file, 'behaviors.tailgating.headwayS', 0.1, 5),
      },
      redLight: {
        share: probability(redLight, 'share', file, 'behaviors.redLight'),
        lateRedS: readNumber(redLight.lateRedS, file, 'behaviors.redLight.lateRedS', 0, 30),
      },
      rollingStop: { share: probability(rollingStop, 'share', file, 'behaviors.rollingStop') },
      dui: {
        share: probability(dui, 'share', file, 'behaviors.dui'),
        hourMultiplier: readHours(dui.hourMultiplier, file, 'behaviors.dui.hourMultiplier'),
        weaveAmplitude: readRange(dui.weaveAmplitude, file, 'behaviors.dui.weaveAmplitude', 0, 3),
        weavePeriodS: readRange(dui.weavePeriodS, file, 'behaviors.dui.weavePeriodS', 0.5, 120),
        speedJitter: readNumber(dui.speedJitter, file, 'behaviors.dui.speedJitter', 0, 0.9),
      },
    },
    observeRadius: readNumber(root.observeRadius, file, 'observeRadius', 0, 10000),
  };
}

export function validateDensity(data: unknown, file = 'density.json'): DensityData {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const districtObj = readObject(root.district, file, 'district');
  for (const key of Object.keys(districtObj)) {
    if (!(DISTRICT_NAMES as readonly string[]).includes(key)) fail(file, `district.${key}`, 'is not a district name');
  }
  const district = DISTRICT_NAMES.map((name) => {
    if (districtObj[name] === undefined) fail(file, `district.${name}`, 'is missing');
    return readNumber(districtObj[name], file, `district.${name}`, 0, 10);
  });
  const r = readObject(root.radii, file, 'radii');
  const radius = (key: string): number => readNumber(r[key], file, `radii.${key}`, 0, 5000);
  const radii = {
    spawnMin: radius('spawnMin'),
    spawnMax: radius('spawnMax'),
    initialMin: radius('initialMin'),
    despawn: radius('despawn'),
    proxy: radius('proxy'),
    proxyRelease: radius('proxyRelease'),
  };
  if (radii.spawnMin > radii.spawnMax) fail(file, 'radii.spawnMin', 'must not exceed radii.spawnMax');
  if (radii.initialMin > radii.spawnMax) fail(file, 'radii.initialMin', 'must not exceed radii.spawnMax');
  if (radii.despawn < radii.spawnMax) fail(file, 'radii.despawn', 'must be at least radii.spawnMax');
  if (radii.proxyRelease < radii.proxy) fail(file, 'radii.proxyRelease', 'must be at least radii.proxy');
  const capacity = readInt(root.capacity, file, 'capacity', 1, 4096);
  return {
    capacity,
    baseActive: readNumber(root.baseActive, file, 'baseActive', 0, capacity),
    district,
    hourMultiplier: readHours(root.hourMultiplier, file, 'hourMultiplier'),
    radii,
    spawnPerTick: readInt(root.spawnPerTick, file, 'spawnPerTick', 1, 64),
    tickS: readNumber(root.tickS, file, 'tickS', 0.05, 10),
  };
}

export function validateRegistry(data: unknown, file = 'registry.json'): RegistryData {
  const root = readObject(data, file, '');
  readVersion(root, file);
  return {
    // Plates encode at most 26^3 * 10^4 ids.
    population: readInt(root.population, file, 'population', 1, 26 ** 3 * 10 ** 4),
    yearRange: readRange(root.yearRange, file, 'yearRange', 1900, 2100),
  };
}

export function validatePullover(data: unknown, file = 'pullover.json'): PulloverData {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const section = (key: string): JsonObject => readObject(root[key], file, key);
  const num = (obj: JsonObject, sec: string, key: string, min: number, max: number): number =>
    readNumber(obj[key], file, `${sec}.${key}`, min, max);
  const detect = section('detect');
  const curb = section('curb');
  const release = section('release');
  const yld = section('yield');
  const fleet = section('fleet');
  const flee = section('flee');
  const result: PulloverData = {
    detect: {
      minDistance: num(detect, 'detect', 'minDistance', 0, 500),
      maxDistance: num(detect, 'detect', 'maxDistance', 0, 500),
      lateral: num(detect, 'detect', 'lateral', 0, 50),
      headingDot: num(detect, 'detect', 'headingDot', -1, 1),
      delayS: num(detect, 'detect', 'delayS', 0, 60),
      minPatrolSpeed: detect.minPatrolSpeed === undefined ? 2 : num(detect, 'detect', 'minPatrolSpeed', 0, 50),
      closingTol: detect.closingTol === undefined ? 0.5 : num(detect, 'detect', 'closingTol', 0, 50),
    },
    curb: {
      clearance: num(curb, 'curb', 'clearance', 0, 5),
      lateralSpeed: num(curb, 'curb', 'lateralSpeed', 0.05, 10),
      decel: num(curb, 'curb', 'decel', 0.1, 10),
      noPullNearLineM: num(curb, 'curb', 'noPullNearLineM', 0, 500),
      approachSpeed: curb.approachSpeed === undefined ? 9 : num(curb, 'curb', 'approachSpeed', 1, 50),
      hazards: readBoolean(curb.hazards, file, 'curb.hazards'),
    },
    release: {
      lateralSpeed: num(release, 'release', 'lateralSpeed', 0.05, 10),
      autoReleaseM: num(release, 'release', 'autoReleaseM', 1, 10000),
    },
    yield: {
      range: num(yld, 'yield', 'range', 0, 1000),
      lateral: num(yld, 'yield', 'lateral', 0, 50),
      passMargin: num(yld, 'yield', 'passMargin', 0, 500),
      timeoutS: num(yld, 'yield', 'timeoutS', 0.1, 600),
    },
    fleet: {
      maxCars: readInt(fleet.maxCars, file, 'fleet.maxCars', 0, 64),
      patrolFactor: num(fleet, 'fleet', 'patrolFactor', 0.1, 3),
      respondFactor: num(fleet, 'fleet', 'respondFactor', 0.1, 3),
      emergencyFactor: num(fleet, 'fleet', 'emergencyFactor', 0.1, 3),
      maxEmergencySpeed: num(fleet, 'fleet', 'maxEmergencySpeed', 1, 100),
      crossSpeed: num(fleet, 'fleet', 'crossSpeed', 0.5, 30),
      arriveDistance: num(fleet, 'fleet', 'arriveDistance', 1, 1000),
    },
    flee: {
      speedFactor: num(flee, 'flee', 'speedFactor', 0.1, 5),
      maxSpeed: num(flee, 'flee', 'maxSpeed', 1, 100),
      crossSpeed: num(flee, 'flee', 'crossSpeed', 0.5, 30),
      loseDistanceM: num(flee, 'flee', 'loseDistanceM', 10, 10000),
      loseS: num(flee, 'flee', 'loseS', 0.1, 600),
      giveUpPerMin: num(flee, 'flee', 'giveUpPerMin', 0, 3600),
      minFleeS: num(flee, 'flee', 'minFleeS', 0, 3600),
      awayBias: num(flee, 'flee', 'awayBias', 0, 1),
    },
  };
  if (result.detect.minDistance > result.detect.maxDistance) fail(file, 'detect.minDistance', 'must not exceed detect.maxDistance');
  return result;
}

export const VIOLATIONS: ViolationsData = validateViolations(violationsJson);
export const DENSITY: DensityData = validateDensity(densityJson);
export const REGISTRY: RegistryData = validateRegistry(registryJson);
export const PULLOVER: PulloverData = validatePullover(pulloverJson);
