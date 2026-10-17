import { LIGHTBAR_DATA, type LightbarPattern } from './data';

export { SEGMENT_COLOR, type LightbarFrame, type LightbarPattern, type SegmentColor } from './data';

/** Lenses across the bar, left to right. */
export const LIGHTBAR_SEGMENTS = 8;
if (LIGHTBAR_DATA.segments !== LIGHTBAR_SEGMENTS) {
  throw new Error(`lightbar.json: segments must be ${LIGHTBAR_SEGMENTS}, got ${LIGHTBAR_DATA.segments}`);
}

/** Patterns in data order; `PoliceLights.pattern` indexes this list. */
export const LIGHTBAR_PATTERNS: readonly LightbarPattern[] = LIGHTBAR_DATA.patterns;

/** Photosensitivity rule: with reduced flash every frame lasts at least `minFrameS`; the renderer dims lit lenses to `level`. */
export const REDUCED_FLASH: { readonly minFrameS: number; readonly level: number } = LIGHTBAR_DATA.reducedFlash;

/** Pattern index by id; -1 when unknown. */
export function patternIndex(id: string): number {
  return LIGHTBAR_PATTERNS.findIndex((p) => p.id === id);
}

/**
 * Clock rate of a pattern under reduced flash: `min(1, shortestFrame / minFrameS)`, so the shortest
 * frame lasts at least `minFrameS`; 1 when every frame is already long enough.
 */
export function reducedFlashRate(pattern: LightbarPattern): number {
  let shortest = Infinity;
  for (const f of pattern.frames) shortest = Math.min(shortest, f.durationS);
  return Math.min(1, shortest / REDUCED_FLASH.minFrameS);
}

/** Precomputed per pattern (same order). */
const REDUCED_RATES: readonly number[] = LIGHTBAR_PATTERNS.map(reducedFlashRate);

/**
 * Segment colours (`SEGMENT_COLOR`) of `pattern` at time `timeS` into `out` (allocation-free).
 * With `reducedFlash` the pattern clock runs at `reducedFlashRate` (no segment toggles more than
 * about 3 times per second); the caller dims lit lenses by `REDUCED_FLASH.level`. An unknown pattern
 * index turns every lens off.
 */
export function lightbarColors(pattern: number, timeS: number, reducedFlash: boolean, out: Uint8Array): Uint8Array {
  const p = LIGHTBAR_PATTERNS[pattern];
  if (p === undefined) return out.fill(0);
  const rate = reducedFlash ? (REDUCED_RATES[pattern] ?? 1) : 1;
  let t = (timeS * rate) % p.periodS;
  if (t < 0) t += p.periodS;
  const frames = p.frames;
  let frame = frames[frames.length - 1];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f === undefined) break;
    if (t < f.durationS) {
      frame = f;
      break;
    }
    t -= f.durationS;
  }
  if (frame === undefined) return out.fill(0);
  const colors = frame.colors;
  const n = Math.min(out.length, colors.length);
  for (let i = 0; i < n; i++) out[i] = colors[i] ?? 0;
  if (out.length > n) out.fill(0, n);
  return out;
}

/**
 * Most colour changes per second of any one segment (cyclic over the pattern period), with the
 * reduced-flash clock when asked. Test helper for the photosensitivity rule; 0 for unknown patterns.
 */
export function maxTogglesPerSecond(pattern: number, reducedFlash: boolean): number {
  const p = LIGHTBAR_PATTERNS[pattern];
  if (p === undefined || p.frames.length < 2) return 0;
  const rate = reducedFlash ? (REDUCED_RATES[pattern] ?? 1) : 1;
  const period = p.periodS / rate;
  let most = 0;
  for (let s = 0; s < LIGHTBAR_SEGMENTS; s++) {
    let toggles = 0;
    for (let i = 0; i < p.frames.length; i++) {
      const a = p.frames[i]?.colors[s];
      const b = p.frames[(i + 1) % p.frames.length]?.colors[s];
      if (a !== b) toggles++;
    }
    most = Math.max(most, toggles / period);
  }
  return most;
}
