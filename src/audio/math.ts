import { SIREN_DATA, type LfoShape, type SirenToneName } from './data';

/** Pure siren/audio maths (design §10.2, §10.8); no Web Audio, no allocation. */

export interface SirenEmitter {
  /** Stable emitter id (entity id); voices stay on the same id while it is selected. */
  id: number;
  x: number;
  y: number;
  z: number;
  /** Running siren tone, or null. */
  tone: SirenToneName | null;
  /** Air horn held. */
  horn: boolean;
  /** Manual wind-up held. */
  manual: boolean;
  /** The listener sits in this car: no distance attenuation, cabin gain and lowpass. */
  inCabin: boolean;
}

/**
 * Value in [-1, 1] of a Web Audio periodic wave of `shape` at `phase` in [0, 1),
 * matching `OscillatorNode` (sine-phase convention: every shape starts at 0 going up,
 * except the square which starts high).
 */
export function lfoValue(shape: LfoShape, phase: number): number {
  const p = phase - Math.floor(phase);
  switch (shape) {
    case 'triangle':
      if (p < 0.25) return 4 * p;
      if (p < 0.75) return 2 - 4 * p;
      return 4 * p - 4;
    case 'sawtooth':
      return p < 0.5 ? 2 * p : 2 * p - 2;
    case 'square':
      return p < 0.5 ? 1 : -1;
    case 'sine':
      return Math.sin(2 * Math.PI * p);
  }
}

/** Siren frequency (Hz) of `tone` at time `t` (s): centre + depth * LFO(t / period), within [lowHz, highHz]. */
export function sirenFrequency(tone: SirenToneName, t: number): number {
  const spec = SIREN_DATA.tones[tone];
  const centre = (spec.lowHz + spec.highHz) / 2;
  const depth = (spec.highHz - spec.lowHz) / 2;
  return centre + depth * lfoValue(spec.shape, t / spec.periodS);
}

/**
 * Web Audio `inverse` distance gain: `ref / (ref + rolloff * (max(d, ref) - ref))`.
 * Distances are clamped to [ref, max] (the spec formula does not use `max`; the clamp
 * only matters beyond `maxDistance`, which the siren bank culls earlier anyway).
 * A non-positive `ref` gives 0, as in browsers.
 */
export function distanceGain(d: number, ref: number, rolloff: number, max: number): number {
  if (!(ref > 0)) return 0;
  const clamped = Math.min(Math.max(d, ref), Math.max(max, ref));
  return ref / (ref + Math.max(0, rolloff) * (clamped - ref));
}

/** True when the emitter makes any siren sound. */
export function emitterSounding(e: SirenEmitter): boolean {
  return e.tone !== null || e.horn || e.manual;
}

let scratchDist = new Float64Array(16);

/**
 * Writes into `out` the indices (into `emitters[0..count)`) of up to `capacity` sounding
 * emitters within `maxDist` (XZ distance) of the listener, nearest first; ties keep the
 * lower index first. In-cabin emitters count as distance 0. Returns how many were written.
 * Allocation-free after the first call with a given capacity.
 */
export function chooseNearest(
  emitters: readonly SirenEmitter[],
  count: number,
  lx: number,
  lz: number,
  capacity: number,
  maxDist: number,
  out: Int32Array,
): number {
  const cap = Math.max(0, Math.min(capacity, out.length));
  if (cap === 0) return 0;
  if (scratchDist.length < cap) scratchDist = new Float64Array(cap);
  const dist = scratchDist;
  const maxSq = maxDist * maxDist;
  const n = Math.min(count, emitters.length);
  let filled = 0;
  for (let i = 0; i < n; i++) {
    const e = emitters[i];
    if (e === undefined || !emitterSounding(e)) continue;
    let dSq = 0;
    if (!e.inCabin) {
      const dx = e.x - lx;
      const dz = e.z - lz;
      dSq = dx * dx + dz * dz;
      if (!(dSq <= maxSq)) continue;
    }
    // Insertion: strictly-greater shifts keep earlier indices ahead on ties.
    let j = filled;
    if (j === cap) {
      if (dSq >= (dist[cap - 1] ?? Infinity)) continue;
      j = cap - 1;
    } else {
      filled++;
    }
    while (j > 0 && (dist[j - 1] ?? 0) > dSq) {
      dist[j] = dist[j - 1] ?? 0;
      out[j] = out[j - 1] ?? 0;
      j--;
    }
    dist[j] = dSq;
    out[j] = i;
  }
  return filled;
}
