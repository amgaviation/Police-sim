import vfxJson from '../../data/vfx/vfx.json';
import { fail, readArray, readBoolean, readNumber, readObject, readVersion, type JsonObject } from '../../vehicles/json';
import { VFX_PARTICLE_KINDS, type VfxParticleKind } from './types';

/**
 * Validated VFX tuning (design §6.1). `parseVfxData` throws an Error naming the file and the dotted JSON path,
 * e.g. `vfx.json: glow.capacity must be in [1, 4096], got 0`.
 */

export interface VfxPoolData {
  /** Most ground pools (one per police car with its bar on). */
  readonly capacity: number;
  readonly radiusM: number;
  readonly intensity: number;
}

export interface VfxGlowData {
  readonly capacity: number;
  readonly barSize: number;
  readonly headSize: number;
  readonly tailSize: number;
  /** Bar glow share by day (night = 1). */
  readonly dayFactor: number;
  /** Glow size factor at quality `low`. */
  readonly lowSizeFactor: number;
  readonly pool: VfxPoolData;
}

export interface VfxConeData {
  readonly capacity: number;
  readonly lengthM: number;
  readonly radiusM: number;
  readonly maxDistanceM: number;
  readonly intensity: number;
  readonly fogBoost: number;
  readonly rainBoost: number;
}

export interface VfxKindData {
  /** Inclusive integer range of particles per burst. */
  readonly count: readonly [number, number];
  /** Metres per second. */
  readonly speed: readonly [number, number];
  readonly lifeS: readonly [number, number];
  /** Vertical acceleration, m/s^2. */
  readonly gravity: number;
  /** Sprite size, m. */
  readonly size: number;
  /** Linear RGB. */
  readonly color: readonly [number, number, number];
  readonly additive: boolean;
}

export interface VfxSplashData {
  readonly count: number;
  readonly radiusM: number;
  readonly rateHz: number;
  /** Largest ring radius, m. */
  readonly ringM: number;
}

export interface VfxWetData {
  readonly dryRoughness: number;
  readonly wetRoughness: number;
  readonly darken: number;
  readonly markingsWetRoughness: number;
}

export interface VfxTapeData {
  readonly amplitudeM: number;
  readonly freqHz: number;
  readonly waveK: number;
  /** Wind speed (m/s) for full flutter. */
  readonly windFull: number;
}

export interface VfxArcData {
  readonly segments: number;
  readonly jitterM: number;
  readonly rateHz: number;
}

export interface VfxMuzzleLightData {
  readonly intensity: number;
  readonly distance: number;
  readonly durationS: number;
}

export interface VfxData {
  readonly glow: VfxGlowData;
  readonly cones: VfxConeData;
  readonly particles: { readonly capacity: number; readonly kinds: Readonly<Record<VfxParticleKind, VfxKindData>> };
  readonly splashes: VfxSplashData;
  readonly wet: VfxWetData;
  readonly tape: VfxTapeData;
  readonly arc: VfxArcData;
  readonly muzzleLight: VfxMuzzleLightData;
}

function int(o: JsonObject, key: string, file: string, path: string, min: number, max: number): number {
  const v = readNumber(o[key], file, `${path}.${key}`, min, max);
  if (!Number.isInteger(v)) fail(file, `${path}.${key}`, `must be an integer, got ${v}`);
  return v;
}

function num(o: JsonObject, key: string, file: string, path: string, min: number, max: number): number {
  return readNumber(o[key], file, `${path}.${key}`, min, max);
}

function pair(value: unknown, file: string, path: string, min: number, max: number, integer: boolean): readonly [number, number] {
  const a = readArray(value, file, path);
  if (a.length !== 2) fail(file, path, `must have 2 items, got ${a.length}`);
  const lo = readNumber(a[0], file, `${path}[0]`, min, max);
  const hi = readNumber(a[1], file, `${path}[1]`, min, max);
  if (integer && (!Number.isInteger(lo) || !Number.isInteger(hi))) fail(file, path, 'must hold integers');
  if (lo > hi) fail(file, path, `must be ascending, got [${lo}, ${hi}]`);
  return [lo, hi];
}

function parseKind(value: unknown, file: string, path: string): VfxKindData {
  const o = readObject(value, file, path);
  const colorArr = readArray(o.color, file, `${path}.color`);
  if (colorArr.length !== 3) fail(file, `${path}.color`, `must have 3 items, got ${colorArr.length}`);
  return {
    count: pair(o.count, file, `${path}.count`, 1, 256, true),
    speed: pair(o.speed, file, `${path}.speed`, 0, 100, false),
    lifeS: pair(o.lifeS, file, `${path}.lifeS`, 0.01, 30, false),
    gravity: num(o, 'gravity', file, path, -50, 50),
    size: num(o, 'size', file, path, 0.001, 10),
    color: [
      readNumber(colorArr[0], file, `${path}.color[0]`, 0, 4),
      readNumber(colorArr[1], file, `${path}.color[1]`, 0, 4),
      readNumber(colorArr[2], file, `${path}.color[2]`, 0, 4),
    ],
    additive: readBoolean(o.additive, file, `${path}.additive`),
  };
}

/** Validates the parsed `vfx.json`; throws an Error naming `file` and the JSON path. */
export function parseVfxData(json: unknown, file = 'vfx.json'): VfxData {
  const root = readObject(json, file, '');
  readVersion(root, file);

  const g = readObject(root.glow, file, 'glow');
  const gp = readObject(g.pool, file, 'glow.pool');
  const glow: VfxGlowData = {
    capacity: int(g, 'capacity', file, 'glow', 1, 4096),
    barSize: num(g, 'barSize', file, 'glow', 0.01, 20),
    headSize: num(g, 'headSize', file, 'glow', 0.01, 20),
    tailSize: num(g, 'tailSize', file, 'glow', 0.01, 20),
    dayFactor: num(g, 'dayFactor', file, 'glow', 0, 1),
    lowSizeFactor: num(g, 'lowSizeFactor', file, 'glow', 0.05, 1),
    pool: {
      capacity: int(gp, 'capacity', file, 'glow.pool', 1, 64),
      radiusM: num(gp, 'radiusM', file, 'glow.pool', 0.1, 50),
      intensity: num(gp, 'intensity', file, 'glow.pool', 0, 4),
    },
  };

  const c = readObject(root.cones, file, 'cones');
  const cones: VfxConeData = {
    capacity: int(c, 'capacity', file, 'cones', 1, 256),
    lengthM: num(c, 'lengthM', file, 'cones', 1, 200),
    radiusM: num(c, 'radiusM', file, 'cones', 0.2, 50),
    maxDistanceM: num(c, 'maxDistanceM', file, 'cones', 1, 2000),
    intensity: num(c, 'intensity', file, 'cones', 0, 4),
    fogBoost: num(c, 'fogBoost', file, 'cones', 1, 10),
    rainBoost: num(c, 'rainBoost', file, 'cones', 1, 10),
  };

  const p = readObject(root.particles, file, 'particles');
  const kindsJson = readObject(p.kinds, file, 'particles.kinds');
  const kinds = {} as Record<VfxParticleKind, VfxKindData>;
  for (const kind of VFX_PARTICLE_KINDS) kinds[kind] = parseKind(kindsJson[kind], file, `particles.kinds.${kind}`);
  for (const key of Object.keys(kindsJson)) {
    if (!(VFX_PARTICLE_KINDS as readonly string[]).includes(key)) fail(file, `particles.kinds.${key}`, 'is not a known particle kind');
  }
  const particleCapacity = int(p, 'capacity', file, 'particles', 2, 65536);
  if (particleCapacity % 2 !== 0) fail(file, 'particles.capacity', `must be even, got ${particleCapacity}`);

  const s = readObject(root.splashes, file, 'splashes');
  const splashes: VfxSplashData = {
    count: int(s, 'count', file, 'splashes', 1, 20000),
    radiusM: num(s, 'radiusM', file, 'splashes', 1, 200),
    rateHz: num(s, 'rateHz', file, 'splashes', 0.01, 20),
    ringM: num(s, 'ringM', file, 'splashes', 0.01, 5),
  };

  const w = readObject(root.wet, file, 'wet');
  const wet: VfxWetData = {
    dryRoughness: num(w, 'dryRoughness', file, 'wet', 0, 1),
    wetRoughness: num(w, 'wetRoughness', file, 'wet', 0, 1),
    darken: num(w, 'darken', file, 'wet', 0, 1),
    markingsWetRoughness: num(w, 'markingsWetRoughness', file, 'wet', 0, 1),
  };

  const t = readObject(root.tape, file, 'tape');
  const tape: VfxTapeData = {
    amplitudeM: num(t, 'amplitudeM', file, 'tape', 0, 1),
    freqHz: num(t, 'freqHz', file, 'tape', 0, 20),
    waveK: num(t, 'waveK', file, 'tape', 0, 20),
    windFull: num(t, 'windFull', file, 'tape', 0.1, 100),
  };

  const a = readObject(root.arc, file, 'arc');
  const arc: VfxArcData = {
    segments: int(a, 'segments', file, 'arc', 1, 64),
    jitterM: num(a, 'jitterM', file, 'arc', 0, 2),
    rateHz: num(a, 'rateHz', file, 'arc', 0.1, 60),
  };

  const m = readObject(root.muzzleLight, file, 'muzzleLight');
  const muzzleLight: VfxMuzzleLightData = {
    intensity: num(m, 'intensity', file, 'muzzleLight', 0, 1000),
    distance: num(m, 'distance', file, 'muzzleLight', 0, 200),
    durationS: num(m, 'durationS', file, 'muzzleLight', 0.001, 2),
  };

  return { glow, cones, particles: { capacity: particleCapacity, kinds }, splashes, wet, tape, arc, muzzleLight };
}

/** The validated contents of `src/data/vfx/vfx.json`. */
export const VFX_DATA: VfxData = parseVfxData(vfxJson, 'vfx.json');
