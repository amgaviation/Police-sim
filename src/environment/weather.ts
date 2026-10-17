import weatherJson from '../data/environment/weather.json';
import { fail, readNumber, readObject, readRange, readVersion, rejectUnknownKeys } from './validate';

export const WEATHER = { clear: 0, cloudy: 1, rain: 2, storm: 3, fog: 4, snow: 5, heat: 6 } as const;
export type WeatherKind = keyof typeof WEATHER;
export type WeatherId = (typeof WEATHER)[WeatherKind];
/** Kind names indexed by `WeatherId`. */
export const WEATHER_KINDS: readonly WeatherKind[] = ['clear', 'cloudy', 'rain', 'storm', 'fog', 'snow', 'heat'];

export function isWeatherKind(value: unknown): value is WeatherKind {
  return typeof value === 'string' && Object.hasOwn(WEATHER, value);
}

export interface WeatherState {
  /** Kind of the current timeline segment (or the override). */
  kind: WeatherKind;
  /** 0..1 strength of the current kind. */
  intensity: number;
  cloudCover: number;
  /** Exponential fog density (1/m); visibility is roughly 2 / fogDensity. */
  fogDensity: number;
  /** 0..1 precipitation rate (rain or snow, by kind). */
  precipitation: number;
  /** 0..1 share of `precipitation` falling as snow (a snow segment blending out still snows). */
  precipSnow: number;
  /** 0..1 road wetness. */
  wetness: number;
  /** 0..1 snow on the ground. */
  snowCover: number;
  temperatureC: number;
  /** Wind velocity, m/s. */
  windX: number;
  windZ: number;
  /** 0..1 heat shimmer strength. */
  heatHaze: number;
}

export interface WeatherKindDef {
  readonly cloudCover: number;
  readonly fogDensity: number;
  readonly precip: number;
  readonly temperatureC: number;
  readonly windSpeed: number;
  readonly heatHaze: number;
  /** Precipitation above freezing: wets roads. */
  readonly wets: boolean;
  /** Precipitation at or below freezing: builds snow cover. */
  readonly snows: boolean;
}

export interface WeatherConfig {
  /** Indexed by `WeatherId`. */
  readonly kinds: readonly WeatherKindDef[];
  /** `transitions[from][to]`, rows normalized to sum 1. */
  readonly transitions: readonly (readonly number[])[];
  readonly segmentHours: readonly [number, number];
  readonly intensity: readonly [number, number];
  readonly blendMinutes: number;
  readonly wetRampMinutes: number;
  readonly dryMinutes: number;
  readonly snowRampMinutes: number;
  readonly meltMinutes: number;
}

export function validateWeatherConfig(data: unknown, file = 'weather.json'): WeatherConfig {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const kindsObj = readObject(root.kinds, file, 'kinds');
  rejectUnknownKeys(kindsObj, WEATHER_KINDS, file, 'kinds');
  const kinds = WEATHER_KINDS.map((name): WeatherKindDef => {
    const path = `kinds.${name}`;
    const k = readObject(kindsObj[name], file, path);
    const precip = readNumber(k.precip, file, `${path}.precip`, 0, 1);
    const temperatureC = readNumber(k.temperatureC, file, `${path}.temperatureC`, -60, 60);
    return {
      cloudCover: readNumber(k.cloudCover, file, `${path}.cloudCover`, 0, 1),
      fogDensity: readNumber(k.fogDensity, file, `${path}.fogDensity`, 0, 1),
      precip,
      temperatureC,
      windSpeed: readNumber(k.windSpeed, file, `${path}.windSpeed`, 0, 100),
      heatHaze: readNumber(k.heatHaze, file, `${path}.heatHaze`, 0, 1),
      wets: precip > 0 && temperatureC > 0,
      snows: precip > 0 && temperatureC <= 0,
    };
  });
  const transObj = readObject(root.transitions, file, 'transitions');
  rejectUnknownKeys(transObj, WEATHER_KINDS, file, 'transitions');
  const transitions = WEATHER_KINDS.map((from) => {
    const path = `transitions.${from}`;
    const row = readObject(transObj[from], file, path);
    rejectUnknownKeys(row, WEATHER_KINDS, file, path);
    const weights = WEATHER_KINDS.map((to) => readNumber(row[to], file, `${path}.${to}`, 0, 1000));
    const sum = weights.reduce((a, b) => a + b, 0);
    if (!(sum > 0)) fail(file, path, 'must have at least one positive weight');
    return weights.map((w) => w / sum);
  });
  const minutes = (key: string): number => readNumber(root[key], file, key, 0.001, 100000);
  const blendMinutes = minutes('blendMinutes');
  const segmentHours = readRange(root.segmentHours, file, 'segmentHours', 0.1, 1000);
  if (blendMinutes > segmentHours[0] * 60) fail(file, 'blendMinutes', `must not exceed the shortest segment (${segmentHours[0] * 60} min)`);
  return {
    kinds,
    transitions,
    segmentHours,
    intensity: readRange(root.intensity, file, 'intensity', 0, 1),
    blendMinutes,
    wetRampMinutes: minutes('wetRampMinutes'),
    dryMinutes: minutes('dryMinutes'),
    snowRampMinutes: minutes('snowRampMinutes'),
    meltMinutes: minutes('meltMinutes'),
  };
}

export const WEATHER_CONFIG: WeatherConfig = validateWeatherConfig(weatherJson);

export function createWeatherState(): WeatherState {
  return {
    kind: 'clear',
    intensity: 0,
    cloudCover: 0,
    fogDensity: 0,
    precipitation: 0,
    precipSnow: 0,
    wetness: 0,
    snowCover: 0,
    temperatureC: 0,
    windX: 0,
    windZ: 0,
    heatHaze: 0,
  };
}

/** One timeline segment plus what carries over from the segments before it. */
export interface WeatherSegment {
  index: number;
  /** Game seconds since 00:00 of day 0. */
  start: number;
  end: number;
  kind: WeatherId;
  intensity: number;
  windAngle: number;
  prevKind: WeatherId;
  prevIntensity: number;
  prevWindAngle: number;
  /** Road wetness and snow cover at `start`. */
  wetStart: number;
  snowStart: number;
}

const TWO_POW_32 = 4294967296;
const SALT_KIND = 1;
const SALT_LENGTH = 2;
const SALT_INTENSITY = 3;
const SALT_WIND = 4;

function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

/** Uniform [0, 1) from (seed, segment index, salt); stateless so any segment can be re-derived. */
function hash01(seed: number, index: number, salt: number): number {
  return mix32((seed ^ mix32((index + Math.imul(salt, 0x9e3779b9)) >>> 0)) >>> 0) / TWO_POW_32;
}

/**
 * Deterministic weather timeline: a Markov chain of segments whose kind, length,
 * intensity and wind direction are hashed from `(seed, segment index)`. A cursor walks
 * forward as time advances (O(1) per call); querying an earlier time rewinds to
 * segment 0, so the result is a pure function of `(seed, gameSeconds)`.
 */
export class WeatherTimeline {
  readonly seed: number;
  private readonly config: WeatherConfig;
  private readonly seg: WeatherSegment;

  constructor(seed: number, config: WeatherConfig = WEATHER_CONFIG) {
    this.seed = seed >>> 0;
    this.config = config;
    this.seg = {
      index: 0,
      start: 0,
      end: 0,
      kind: WEATHER.clear,
      intensity: 0,
      windAngle: 0,
      prevKind: WEATHER.clear,
      prevIntensity: 0,
      prevWindAngle: 0,
      wetStart: 0,
      snowStart: 0,
    };
    this.rewind();
  }

  /** The segment containing `gameSeconds` (the same object, updated in place). */
  segmentAt(gameSeconds: number): Readonly<WeatherSegment> {
    const t = Math.max(0, gameSeconds);
    if (t < this.seg.start) this.rewind();
    while (t >= this.seg.end) this.advance();
    return this.seg;
  }

  /** Fills `out` with the weather at `gameSeconds`; allocation-free. */
  sample(gameSeconds: number, out: WeatherState): WeatherState {
    const seg = this.segmentAt(gameSeconds);
    const elapsed = Math.max(0, gameSeconds) - seg.start;
    const blend = Math.min(1, elapsed / (this.config.blendMinutes * 60));
    blendKinds(this.config, seg.prevKind, seg.prevIntensity, seg.prevWindAngle, seg.kind, seg.intensity, seg.windAngle, blend, out);
    out.wetness = this.wetnessAt(seg, elapsed);
    out.snowCover = this.snowAt(seg, elapsed);
    return out;
  }

  private wetnessAt(seg: Readonly<WeatherSegment>, elapsed: number): number {
    const minutes = elapsed / 60;
    if (this.config.kinds[seg.kind]?.wets === true) return Math.min(1, seg.wetStart + minutes / this.config.wetRampMinutes);
    return Math.max(0, seg.wetStart - minutes / this.config.dryMinutes);
  }

  private snowAt(seg: Readonly<WeatherSegment>, elapsed: number): number {
    const minutes = elapsed / 60;
    if (this.config.kinds[seg.kind]?.snows === true) return Math.min(1, seg.snowStart + minutes / this.config.snowRampMinutes);
    return Math.max(0, seg.snowStart - minutes / this.config.meltMinutes);
  }

  private rewind(): void {
    const s = this.seg;
    s.index = -1;
    s.end = 0;
    s.kind = WEATHER.clear;
    s.intensity = this.config.intensity[0];
    s.windAngle = 0;
    s.wetStart = 0;
    s.snowStart = 0;
    this.advance();
  }

  /** Steps the cursor to the next segment, carrying wetness and snow across the boundary. */
  private advance(): void {
    const s = this.seg;
    const c = this.config;
    if (s.index >= 0) {
      const length = s.end - s.start;
      s.wetStart = this.wetnessAt(s, length);
      s.snowStart = this.snowAt(s, length);
    }
    s.prevKind = s.kind;
    s.prevIntensity = s.intensity;
    s.prevWindAngle = s.windAngle;
    s.index++;
    s.start = s.end;
    const hours = c.segmentHours[0] + (c.segmentHours[1] - c.segmentHours[0]) * hash01(this.seed, s.index, SALT_LENGTH);
    s.end = s.start + Math.max(60, hours * 3600);
    s.kind = pickTransition(c.transitions[s.prevKind] ?? [], hash01(this.seed, s.index, SALT_KIND));
    s.intensity = c.intensity[0] + (c.intensity[1] - c.intensity[0]) * hash01(this.seed, s.index, SALT_INTENSITY);
    s.windAngle = Math.PI * 2 * hash01(this.seed, s.index, SALT_WIND);
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function pickTransition(row: readonly number[], u: number): WeatherId {
  let acc = 0;
  let last = 0;
  for (let i = 0; i < row.length; i++) {
    const p = row[i] ?? 0;
    if (p <= 0) continue;
    last = i;
    acc += p;
    if (u < acc) return i as WeatherId;
  }
  return last as WeatherId; // rounding: u just below 1
}

/** Writes everything but wetness/snowCover for a blend `t` (0..1) from kind `a` to kind `b`. */
function blendKinds(
  config: WeatherConfig,
  a: WeatherId,
  ia: number,
  angleA: number,
  b: WeatherId,
  ib: number,
  angleB: number,
  t: number,
  out: WeatherState,
): void {
  const ka = config.kinds[a] as WeatherKindDef;
  const kb = config.kinds[b] as WeatherKindDef;
  out.kind = WEATHER_KINDS[b] ?? 'clear';
  out.intensity = ib;
  out.cloudCover = lerp(ka.cloudCover, kb.cloudCover, t);
  out.fogDensity = lerp(ka.fogDensity * ia, kb.fogDensity * ib, t);
  out.precipitation = lerp(ka.precip * ia, kb.precip * ib, t);
  // The precipitation type comes from the kind contributing it, not from `out.kind`.
  const snow = (ka.snows ? ka.precip * ia * (1 - t) : 0) + (kb.snows ? kb.precip * ib * t : 0);
  out.precipSnow = out.precipitation > 0 ? Math.min(1, snow / out.precipitation) : kb.snows ? 1 : 0;
  out.temperatureC = lerp(ka.temperatureC, kb.temperatureC, t);
  out.windX = lerp(Math.cos(angleA) * ka.windSpeed * ia, Math.cos(angleB) * kb.windSpeed * ib, t);
  out.windZ = lerp(Math.sin(angleA) * ka.windSpeed * ia, Math.sin(angleB) * kb.windSpeed * ib, t);
  out.heatHaze = lerp(ka.heatHaze * ia, kb.heatHaze * ib, t);
}

/**
 * Weather for a fixed kind (debug override): no blending, wetness/snow cover follow
 * the intensity immediately. Wind blows from a fixed direction.
 */
export function overrideWeather(config: WeatherConfig, kind: WeatherKind, intensity: number, out: WeatherState): WeatherState {
  const id = WEATHER[kind];
  const i = Math.min(1, Math.max(0, intensity));
  blendKinds(config, id, i, 0.6, id, i, 0.6, 1, out);
  const def = config.kinds[id] as WeatherKindDef;
  out.wetness = def.wets ? i : 0;
  out.snowCover = def.snows ? i : 0;
  return out;
}
