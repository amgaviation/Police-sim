import { describe, expect, it } from 'vitest';
import {
  LIGHTBAR_PATTERNS,
  LIGHTBAR_SEGMENTS,
  REDUCED_FLASH,
  SEGMENT_COLOR,
  lightbarColors,
  maxTogglesPerSecond,
  patternIndex,
  reducedFlashRate,
} from '../../src/police/lightbar';

const { off: O, red: R, blue: B, white: W, amber: A } = SEGMENT_COLOR;
const colorsAt = (id: string, t: number, reduced = false): number[] =>
  Array.from(lightbarColors(patternIndex(id), t, reduced, new Uint8Array(LIGHTBAR_SEGMENTS)));

describe('light bar patterns', () => {
  it('ships six patterns with 8 segments, indexed by id', () => {
    expect(LIGHTBAR_SEGMENTS).toBe(8);
    expect(LIGHTBAR_PATTERNS.map((p) => p.id)).toEqual(['alternate', 'quad', 'sweep', 'takedown', 'cruise', 'arrowLeft']);
    expect(patternIndex('sweep')).toBe(2);
    expect(patternIndex('disco')).toBe(-1);
    expect(REDUCED_FLASH).toEqual({ minFrameS: 0.34, level: 0.55 });
  });

  it('returns the frame colours at sample times, wrapping by the period', () => {
    expect(colorsAt('alternate', 0)).toEqual([R, R, R, R, O, O, O, O]);
    expect(colorsAt('alternate', 0.3)).toEqual([O, O, O, O, B, B, B, B]);
    expect(colorsAt('alternate', 0.55)).toEqual([R, R, R, R, O, O, O, O]);
    expect(colorsAt('alternate', -0.1)).toEqual([O, O, O, O, B, B, B, B]);
    expect(colorsAt('quad', 0.07)).toEqual([O, O, O, O, O, O, O, O]);
    expect(colorsAt('quad', 0.12)).toEqual([R, R, R, R, O, O, O, O]);
    expect(colorsAt('quad', 0.23)).toEqual([O, O, O, O, B, B, B, B]);
    expect(colorsAt('sweep', 0.07 * 5 + 0.01)).toEqual([O, O, O, O, O, B, O, O]);
    expect(colorsAt('takedown', 0.31)).toEqual([B, W, W, W, W, W, W, R]);
    expect(colorsAt('cruise', 123.4)).toEqual([B, O, O, O, O, O, O, B]);
    expect(colorsAt('arrowLeft', 0.37)).toEqual([A, A, A, A, A, A, A, A]);
    expect(colorsAt('arrowLeft', 0.6)).toEqual([O, O, O, O, O, O, O, O]);
  });

  it('reuses the out array without allocating and blanks unknown patterns', () => {
    const out = new Uint8Array(LIGHTBAR_SEGMENTS);
    expect(lightbarColors(0, 0, false, out)).toBe(out);
    expect(lightbarColors(1, 0.12, true, out)).toBe(out);
    expect(lightbarColors(99, 0, false, out)).toBe(out);
    expect(Array.from(out)).toEqual([O, O, O, O, O, O, O, O]);
  });

  it('reduced flash keeps every pattern at or below 3 toggles per second', () => {
    LIGHTBAR_PATTERNS.forEach((p, i) => {
      expect(maxTogglesPerSecond(i, true), p.id).toBeLessThanOrEqual(3);
    });
    // Without it the fast patterns flash well above the limit.
    expect(maxTogglesPerSecond(patternIndex('quad'), false)).toBeGreaterThan(5);
    expect(maxTogglesPerSecond(patternIndex('cruise'), false)).toBe(0);
  });

  it('reduced flash slows the clock to the shortest frame, and not at all when frames are long', () => {
    const quad = patternIndex('quad');
    const rate = reducedFlashRate(LIGHTBAR_PATTERNS[quad]!);
    expect(rate).toBeCloseTo(0.05 / 0.34, 10);
    // Reduced time t shows what normal time t * rate shows.
    for (const t of [0, 0.3, 0.5, 0.9, 2.2]) expect(colorsAt('quad', t, true)).toEqual(colorsAt('quad', t * rate));
    const cruise = LIGHTBAR_PATTERNS[patternIndex('cruise')]!;
    expect(reducedFlashRate(cruise)).toBe(1);
    expect(maxTogglesPerSecond(patternIndex('cruise'), true)).toBe(maxTogglesPerSecond(patternIndex('cruise'), false));
    for (const t of [0, 0.5, 3.7]) expect(colorsAt('cruise', t, true)).toEqual(colorsAt('cruise', t));
  });
});
