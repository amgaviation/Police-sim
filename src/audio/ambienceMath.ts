import type { Rng } from '../core/rng';
import type { AmbienceData } from './ambienceData';

/** Pure ambience maths (phase 9 design §5.5); no Web Audio, no allocation in `ambienceGains`. */

export interface AmbienceParams {
  /** DISTRICT_NAMES entry at the listener ('water' off the map). */
  district: string;
  /** 0..24 game hour. */
  hour: number;
  /** WEATHER_KINDS entry. */
  weather: string;
  /** 0..1 precipitation * (1 - precipSnow). */
  rain: number;
  /** m/s, |wind|. */
  wind: number;
  /** Officer inside a building interior. */
  indoor: boolean;
  /** Listener inside a vehicle cabin. */
  inCabin: boolean;
}

/** Wind speed (m/s) at which the wind layer is at full level. */
export const WIND_FULL_MS = 12;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Target gain per layer (AMBIENCE_LAYERS order) into `out` (length >= layers):
 * gain x district factor x hour factor (linear between whole hours, wrapping 23 -> 0) x weather factor
 * x drive (rain, wind) x (indoor ? layer.indoor : 1) x (inCabin ? cabinFactor : 1). Allocation-free.
 */
export function ambienceGains(p: Readonly<AmbienceParams>, data: AmbienceData, out: Float32Array): Float32Array {
  const hourRaw = Number.isFinite(p.hour) ? p.hour % 24 : 0;
  const hour = hourRaw < 0 ? hourRaw + 24 : hourRaw;
  const h0 = Math.floor(hour);
  const frac = hour - h0;
  const h1 = h0 === 23 ? 0 : h0 + 1;
  const rain = clamp01(Number.isFinite(p.rain) ? p.rain : 0);
  const wind = clamp01((Number.isFinite(p.wind) ? p.wind : 0) / WIND_FULL_MS);
  const layers = data.layers;
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    if (layer === undefined) continue;
    const district = layer.district[p.district] ?? layer.district['*'] ?? 0;
    const a = layer.hours[h0] ?? 0;
    const b = layer.hours[h1] ?? 0;
    const hourFactor = a + (b - a) * frac;
    const weather = layer.weather[p.weather] ?? 1;
    const drive = layer.drive === 'rain' ? rain : layer.drive === 'wind' ? wind : 1;
    let g = layer.gain * district * hourFactor * weather * drive;
    if (p.indoor) g *= layer.indoor;
    if (p.inCabin) g *= data.cabinFactor;
    out[i] = g;
  }
  return out;
}

/** Seconds until the next chirp: exponential with rate `ratePerS * level` from `rng` (Infinity when the rate is 0). */
export function nextChirpS(rng: Rng, ratePerS: number, level: number): number {
  const rate = ratePerS * level;
  if (!(rate > 0)) return Infinity;
  return -Math.log(1 - rng.next()) / rate;
}
