import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { hypot2 } from '../../src/traffic/fastMath';

describe('hypot2', () => {
  it('is bit-identical to Math.hypot over a wide range of magnitudes', () => {
    const rng = createRng(20260101).stream('hypot');
    for (let i = 0; i < 2_000_000; i++) {
      const scale = 10 ** (rng.next() * 24 - 12);
      const a = (rng.next() * 2 - 1) * scale;
      const b = (rng.next() * 2 - 1) * (i % 3 === 0 ? scale : 10 ** (rng.next() * 24 - 12));
      const want = Math.hypot(a, b);
      const got = hypot2(a, b);
      if (!Object.is(got, want)) expect(got).toBe(want);
    }
  });

  it('matches the special cases', () => {
    const cases: [number, number][] = [
      [0, 0], [-0, 0], [3, 4], [-3, 4], [5e-324, 5e-324], [1e308, 1e308], [1e-200, 1e-200],
      [Infinity, 1], [-Infinity, NaN], [NaN, 1], [NaN, NaN], [1, NaN], [0, -7], [1, 1], [0.1, 0.2],
    ];
    for (const [a, b] of cases) expect(Object.is(hypot2(a, b), Math.hypot(a, b))).toBe(true);
  });
});
