import skyJson from '../data/environment/sky.json';
import { fail, readColor, readNumber, readObject, readVersion } from './validate';

/** sRGB colour, channels in [0, 1]. */
export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface SkyKeyframe {
  readonly hour: number;
  readonly skyTop: Readonly<Rgb>;
  readonly skyHorizon: Readonly<Rgb>;
  readonly fog: Readonly<Rgb>;
  readonly sunColor: Readonly<Rgb>;
  readonly sunIntensity: number;
  readonly moonIntensity: number;
  readonly ambientSky: Readonly<Rgb>;
  readonly ambientGround: Readonly<Rgb>;
  readonly ambientIntensity: number;
}

export interface SkyConfig {
  readonly sunriseHour: number;
  readonly sunsetHour: number;
  readonly maxSunElevationDeg: number;
  /** Sorted by hour, all in [0, 24). */
  readonly keyframes: readonly SkyKeyframe[];
  /** nightFactor is 0 above `dayAboveDeg` sun elevation and 1 below `nightBelowDeg`, smoothstep between. */
  readonly nightFactor: { readonly dayAboveDeg: number; readonly nightBelowDeg: number };
  readonly clouds: {
    readonly darken: number;
    readonly desaturate: number;
    readonly sunDim: number;
    readonly moonDim: number;
    readonly ambientDim: number;
  };
  readonly streetlightsBelowDeg: number;
  readonly headlights: { readonly belowDeg: number; readonly precipAbove: number; readonly fogAbove: number };
}

/** Interpolated sky at one moment (colours sRGB). */
export interface SkySample {
  skyTop: Rgb;
  skyHorizon: Rgb;
  fog: Rgb;
  sunColor: Rgb;
  ambientSky: Rgb;
  ambientGround: Rgb;
  sunIntensity: number;
  moonIntensity: number;
  ambientIntensity: number;
}

const COLOR_KEYS = ['skyTop', 'skyHorizon', 'fog', 'sunColor', 'ambientSky', 'ambientGround'] as const;
type ColorKey = (typeof COLOR_KEYS)[number];

function hexToRgb(hex: number): Rgb {
  return { r: ((hex >> 16) & 255) / 255, g: ((hex >> 8) & 255) / 255, b: (hex & 255) / 255 };
}

export function validateSkyConfig(data: unknown, file = 'sky.json'): SkyConfig {
  const root = readObject(data, file, '');
  readVersion(root, file);
  const sunriseHour = readNumber(root.sunriseHour, file, 'sunriseHour', 0, 24);
  const sunsetHour = readNumber(root.sunsetHour, file, 'sunsetHour', 0, 24);
  if (sunsetHour <= sunriseHour) fail(file, 'sunsetHour', `must be after sunriseHour (${sunriseHour}), got ${sunsetHour}`);
  if (!Array.isArray(root.keyframes) || root.keyframes.length < 2) fail(file, 'keyframes', 'must be an array of at least 2 keyframes');
  const keyframes = (root.keyframes as unknown[]).map((value, i): SkyKeyframe => {
    const path = `keyframes[${i}]`;
    const k = readObject(value, file, path);
    const color = (key: ColorKey): Rgb => hexToRgb(readColor(k[key], file, `${path}.${key}`));
    return {
      hour: readNumber(k.hour, file, `${path}.hour`, 0, 23.999),
      skyTop: color('skyTop'),
      skyHorizon: color('skyHorizon'),
      fog: color('fog'),
      sunColor: color('sunColor'),
      sunIntensity: readNumber(k.sunIntensity, file, `${path}.sunIntensity`, 0, 100),
      moonIntensity: readNumber(k.moonIntensity, file, `${path}.moonIntensity`, 0, 100),
      ambientSky: color('ambientSky'),
      ambientGround: color('ambientGround'),
      ambientIntensity: readNumber(k.ambientIntensity, file, `${path}.ambientIntensity`, 0, 100),
    };
  });
  for (let i = 1; i < keyframes.length; i++) {
    const prev = keyframes[i - 1]?.hour ?? 0;
    const hour = keyframes[i]?.hour ?? 0;
    if (hour <= prev) fail(file, `keyframes[${i}].hour`, `must be greater than the previous keyframe's (${prev}), got ${hour}`);
  }
  const night = readObject(root.nightFactor, file, 'nightFactor');
  const dayAboveDeg = readNumber(night.dayAboveDeg, file, 'nightFactor.dayAboveDeg', -90, 90);
  const nightBelowDeg = readNumber(night.nightBelowDeg, file, 'nightFactor.nightBelowDeg', -90, 90);
  if (nightBelowDeg >= dayAboveDeg) fail(file, 'nightFactor.nightBelowDeg', `must be below dayAboveDeg (${dayAboveDeg})`);
  const clouds = readObject(root.clouds, file, 'clouds');
  const fraction = (key: string): number => readNumber(clouds[key], file, `clouds.${key}`, 0, 1);
  const headlights = readObject(root.headlights, file, 'headlights');
  return {
    sunriseHour,
    sunsetHour,
    maxSunElevationDeg: readNumber(root.maxSunElevationDeg, file, 'maxSunElevationDeg', 1, 90),
    keyframes,
    nightFactor: { dayAboveDeg, nightBelowDeg },
    clouds: {
      darken: fraction('darken'),
      desaturate: fraction('desaturate'),
      sunDim: fraction('sunDim'),
      moonDim: fraction('moonDim'),
      ambientDim: fraction('ambientDim'),
    },
    streetlightsBelowDeg: readNumber(
      readObject(root.streetlights, file, 'streetlights').onWhenSunBelowDeg,
      file,
      'streetlights.onWhenSunBelowDeg',
      -90,
      90,
    ),
    headlights: {
      belowDeg: readNumber(headlights.onWhenSunBelowDeg, file, 'headlights.onWhenSunBelowDeg', -90, 90),
      precipAbove: readNumber(headlights.onWhenPrecipAbove, file, 'headlights.onWhenPrecipAbove', 0, 1),
      fogAbove: readNumber(headlights.onWhenFogAbove, file, 'headlights.onWhenFogAbove', 0, 1),
    },
  };
}

export const SKY_CONFIG: SkyConfig = validateSkyConfig(skyJson);

const DEG = Math.PI / 180;

/**
 * Writes the unit direction towards the sun at `hour` into `out` and returns its
 * elevation in degrees. By day (sunrise..sunset) the sun moves east (+X) -> south (+Z)
 * -> west (-X) with elevation `max * sin(pi * dayFraction)`; by night it continues
 * west -> north -> east below the horizon (mirrored), so elevation is continuous and
 * negative at night. The moon is the opposite direction.
 */
export function sunDirection(config: SkyConfig, hour: number, out: { x: number; y: number; z: number }): number {
  const h = ((hour % 24) + 24) % 24;
  const dayLength = config.sunsetHour - config.sunriseHour;
  let angle: number;
  let elevationDeg: number;
  if (h >= config.sunriseHour && h <= config.sunsetHour) {
    const f = (h - config.sunriseHour) / dayLength;
    angle = Math.PI * f;
    elevationDeg = config.maxSunElevationDeg * Math.sin(Math.PI * f);
  } else {
    const g = ((((h - config.sunsetHour) % 24) + 24) % 24) / (24 - dayLength);
    angle = Math.PI + Math.PI * g;
    elevationDeg = -config.maxSunElevationDeg * Math.sin(Math.PI * g);
  }
  const e = elevationDeg * DEG;
  out.x = Math.cos(e) * Math.cos(angle);
  out.y = Math.sin(e);
  out.z = Math.cos(e) * Math.sin(angle);
  return elevationDeg;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 0 by day .. 1 by night, smooth across the horizon band. */
export function nightFactorAt(config: SkyConfig, sunElevationDeg: number): number {
  return 1 - smoothstep(config.nightFactor.nightBelowDeg, config.nightFactor.dayAboveDeg, sunElevationDeg);
}

function makeRgb(): Rgb {
  return { r: 0, g: 0, b: 0 };
}

export function createSkySample(): SkySample {
  return {
    skyTop: makeRgb(),
    skyHorizon: makeRgb(),
    fog: makeRgb(),
    sunColor: makeRgb(),
    ambientSky: makeRgb(),
    ambientGround: makeRgb(),
    sunIntensity: 0,
    moonIntensity: 0,
    ambientIntensity: 0,
  };
}

function lerpRgb(a: Readonly<Rgb>, b: Readonly<Rgb>, t: number, out: Rgb): void {
  out.r = a.r + (b.r - a.r) * t;
  out.g = a.g + (b.g - a.g) * t;
  out.b = a.b + (b.b - a.b) * t;
}

/** Desaturates towards grey and darkens by cloud cover. */
function cloudShade(c: Rgb, desaturate: number, darken: number): void {
  const grey = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const k = 1 - darken;
  c.r = (c.r + (grey - c.r) * desaturate) * k;
  c.g = (c.g + (grey - c.g) * desaturate) * k;
  c.b = (c.b + (grey - c.b) * desaturate) * k;
}

/**
 * Interpolates the keyframes at `hour` (wrapping from the last keyframe to the first
 * through midnight), then darkens and desaturates by `cloudCover` (0..1). Allocation-free.
 */
export function sampleSky(config: SkyConfig, hour: number, cloudCover: number, out: SkySample): SkySample {
  const frames = config.keyframes;
  const n = frames.length;
  const h = ((hour % 24) + 24) % 24;
  // Index of the last keyframe at or before h; -1 means before the first (wrap from the last).
  let i = n - 1;
  while (i >= 0 && (frames[i]?.hour ?? 0) > h) i--;
  const a = frames[i < 0 ? n - 1 : i] as SkyKeyframe;
  const b = frames[i < 0 ? 0 : (i + 1) % n] as SkyKeyframe;
  let span = b.hour - a.hour;
  if (span <= 0) span += 24;
  let into = h - a.hour;
  if (into < 0) into += 24;
  const t = into / span;
  for (let k = 0; k < COLOR_KEYS.length; k++) {
    const key = COLOR_KEYS[k] as ColorKey;
    lerpRgb(a[key], b[key], t, out[key]);
  }
  out.sunIntensity = a.sunIntensity + (b.sunIntensity - a.sunIntensity) * t;
  out.moonIntensity = a.moonIntensity + (b.moonIntensity - a.moonIntensity) * t;
  out.ambientIntensity = a.ambientIntensity + (b.ambientIntensity - a.ambientIntensity) * t;

  const c = Math.min(1, Math.max(0, cloudCover));
  if (c > 0) {
    const clouds = config.clouds;
    for (let k = 0; k < COLOR_KEYS.length; k++) {
      const key = COLOR_KEYS[k] as ColorKey;
      if (key !== 'sunColor') cloudShade(out[key], clouds.desaturate * c, clouds.darken * c);
    }
    out.sunIntensity *= 1 - clouds.sunDim * c;
    out.moonIntensity *= 1 - clouds.moonDim * c;
    out.ambientIntensity *= 1 - clouds.ambientDim * c;
  }
  return out;
}
