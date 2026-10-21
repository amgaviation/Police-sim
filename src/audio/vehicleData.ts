import vehicleAudioJson from '../data/audio/vehicleAudio.json';
import { fail, readArray, readNumber, readObject, readOneOf, readVersion } from '../vehicles/json';
import { SURFACE_NAMES } from '../world/ids';
import { LFO_SHAPES, type LfoShape } from './data';

/** Typed, validated view of `src/data/audio/vehicleAudio.json` (phase 9 design §5.3). */

export const ENGINE_PROFILES = ['car', 'v8', 'diesel', 'twin', 'single', 'outboard', 'rotor', 'drone'] as const;
export type EngineProfileId = (typeof ENGINE_PROFILES)[number];

export interface EngineProfile {
  /** Cylinders of a four-stroke: the firing frequency is rpm / 60 * cylinders / 2. */
  readonly cylinders: number;
  readonly wave: LfoShape;
  readonly lowpassBaseHz: number;
  readonly lowpassPerRpm: number;
  readonly subGain: number;
  readonly noiseGain: number;
  /** Amplitude modulation depth 0..1 (rotor beat); 0 = none. */
  readonly am: number;
  readonly gain: number;
}

export interface TrafficEngineData {
  readonly voices: number;
  readonly maxDistanceM: number;
  readonly profile: EngineProfileId;
  readonly idleRpm: number;
  readonly redlineRpm: number;
  readonly gearRatios: readonly number[];
  readonly finalDrive: number;
  readonly wheelRadiusM: number;
  readonly shiftRpm: number;
}

export interface TireAudioData {
  readonly slipStartMs: number;
  readonly slipFullMs: number;
  readonly lockSpeedMs: number;
  readonly squealHzMin: number;
  readonly squealHzMax: number;
  readonly noiseHz: number;
  readonly noiseQ: number;
  readonly gain: number;
  readonly gravelGain: number;
  /** Per SURFACE id. */
  readonly surfaceSqueal: readonly number[];
  readonly surfaceCrunch: readonly number[];
}

export interface VehicleAudioData {
  readonly speedOfSound: number;
  readonly dopplerClamp: readonly [number, number];
  readonly dopplerTau: number;
  readonly engine: {
    readonly profiles: Readonly<Record<EngineProfileId, EngineProfile>>;
    readonly idleGain: number;
    readonly cabin: { readonly gain: number; readonly lowpassHz: number };
    readonly traffic: TrafficEngineData;
  };
  readonly tires: TireAudioData;
}

const FILE = 'vehicleAudio.json';

function readProfile(value: unknown, path: string, f: string): EngineProfile {
  const o = readObject(value, f, path);
  return {
    cylinders: Math.floor(readNumber(o.cylinders, f, `${path}.cylinders`, 1, 16)),
    wave: readOneOf<LfoShape>(o.wave, LFO_SHAPES, f, `${path}.wave`),
    lowpassBaseHz: readNumber(o.lowpassBaseHz, f, `${path}.lowpassBaseHz`, 20, 20000),
    lowpassPerRpm: readNumber(o.lowpassPerRpm, f, `${path}.lowpassPerRpm`, 0, 100),
    subGain: readNumber(o.subGain, f, `${path}.subGain`, 0, 2),
    noiseGain: readNumber(o.noiseGain, f, `${path}.noiseGain`, 0, 2),
    am: readNumber(o.am, f, `${path}.am`, 0, 1),
    gain: readNumber(o.gain, f, `${path}.gain`, 0, 1),
  };
}

function readTraffic(value: unknown, path: string, f: string): TrafficEngineData {
  const o = readObject(value, f, path);
  const idleRpm = readNumber(o.idleRpm, f, `${path}.idleRpm`, 100, 10000);
  const redlineRpm = readNumber(o.redlineRpm, f, `${path}.redlineRpm`, idleRpm, 20000);
  return {
    voices: Math.floor(readNumber(o.voices, f, `${path}.voices`, 1, 8)),
    maxDistanceM: readNumber(o.maxDistanceM, f, `${path}.maxDistanceM`, 1, 1000),
    profile: readOneOf<EngineProfileId>(o.profile, ENGINE_PROFILES, f, `${path}.profile`),
    idleRpm,
    redlineRpm,
    gearRatios: readArray(o.gearRatios, f, `${path}.gearRatios`, 1).map((g, i) => readNumber(g, f, `${path}.gearRatios[${i}]`, 0.1, 20)),
    finalDrive: readNumber(o.finalDrive, f, `${path}.finalDrive`, 0.1, 20),
    wheelRadiusM: readNumber(o.wheelRadiusM, f, `${path}.wheelRadiusM`, 0.05, 2),
    shiftRpm: readNumber(o.shiftRpm, f, `${path}.shiftRpm`, 100, redlineRpm),
  };
}

function readSurfaceTable(value: unknown, path: string, f: string): number[] {
  const arr = readArray(value, f, path);
  if (arr.length !== SURFACE_NAMES.length) fail(f, path, `must have ${SURFACE_NAMES.length} items (one per surface), got ${arr.length}`);
  return arr.map((v, i) => readNumber(v, f, `${path}[${i}]`, 0, 1));
}

function readTires(value: unknown, path: string, f: string): TireAudioData {
  const o = readObject(value, f, path);
  const slipStartMs = readNumber(o.slipStartMs, f, `${path}.slipStartMs`, 0, 50);
  const squealHzMin = readNumber(o.squealHzMin, f, `${path}.squealHzMin`, 50, 10000);
  return {
    slipStartMs,
    slipFullMs: readNumber(o.slipFullMs, f, `${path}.slipFullMs`, slipStartMs + 0.01, 100),
    lockSpeedMs: readNumber(o.lockSpeedMs, f, `${path}.lockSpeedMs`, 0, 50),
    squealHzMin,
    squealHzMax: readNumber(o.squealHzMax, f, `${path}.squealHzMax`, squealHzMin, 10000),
    noiseHz: readNumber(o.noiseHz, f, `${path}.noiseHz`, 50, 20000),
    noiseQ: readNumber(o.noiseQ, f, `${path}.noiseQ`, 0.1, 50),
    gain: readNumber(o.gain, f, `${path}.gain`, 0, 1),
    gravelGain: readNumber(o.gravelGain, f, `${path}.gravelGain`, 0, 1),
    surfaceSqueal: readSurfaceTable(o.surfaceSqueal, `${path}.surfaceSqueal`, f),
    surfaceCrunch: readSurfaceTable(o.surfaceCrunch, `${path}.surfaceCrunch`, f),
  };
}

/** Validates the raw JSON; throws an Error naming the file and field. */
export function parseVehicleAudio(raw: unknown, file: string = FILE): VehicleAudioData {
  const f = file;
  const root = readObject(raw, f, '');
  readVersion(root, f);
  const clampArr = readArray(root.dopplerClamp, f, 'dopplerClamp');
  if (clampArr.length !== 2) fail(f, 'dopplerClamp', `must have 2 items [min, max], got ${clampArr.length}`);
  const clampMin = readNumber(clampArr[0], f, 'dopplerClamp[0]', 0.1, 1);
  const clampMax = readNumber(clampArr[1], f, 'dopplerClamp[1]', 1, 10);
  const engine = readObject(root.engine, f, 'engine');
  const profilesObj = readObject(engine.profiles, f, 'engine.profiles');
  const profiles = {} as Record<EngineProfileId, EngineProfile>;
  for (const id of ENGINE_PROFILES) profiles[id] = readProfile(profilesObj[id], `engine.profiles.${id}`, f);
  const cabin = readObject(engine.cabin, f, 'engine.cabin');
  return {
    speedOfSound: readNumber(root.speedOfSound, f, 'speedOfSound', 100, 1000),
    dopplerClamp: [clampMin, clampMax],
    dopplerTau: readNumber(root.dopplerTau, f, 'dopplerTau', 0.001, 2),
    engine: {
      profiles,
      idleGain: readNumber(engine.idleGain, f, 'engine.idleGain', 0, 1),
      cabin: {
        gain: readNumber(cabin.gain, f, 'engine.cabin.gain', 0, 1),
        lowpassHz: readNumber(cabin.lowpassHz, f, 'engine.cabin.lowpassHz', 20, 20000),
      },
      traffic: readTraffic(engine.traffic, 'engine.traffic', f),
    },
    tires: readTires(root.tires, 'tires', f),
  };
}

export const VEHICLE_AUDIO: VehicleAudioData = parseVehicleAudio(vehicleAudioJson);
