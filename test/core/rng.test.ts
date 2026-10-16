import { describe, expect, it } from 'vitest';
import { createRng, hashString, normalizeSeed, rngFromState } from '../../src/core/rng';

function sequence(seed: number | string, n: number): number[] {
  const rng = createRng(seed);
  return Array.from({ length: n }, () => rng.next());
}

describe('createRng', () => {
  it('reproduces the same sequence for the same seed', () => {
    expect(sequence(42, 50)).toEqual(sequence(42, 50));
    expect(sequence('shift-7', 50)).toEqual(sequence('shift-7', 50));
  });

  it('produces different sequences for different seeds', () => {
    expect(sequence(1, 20)).not.toEqual(sequence(2, 20));
    expect(sequence('a', 20)).not.toEqual(sequence('b', 20));
  });

  it('normalizes seeds to unsigned 32-bit integers', () => {
    expect(normalizeSeed(-1)).toBe(0xffffffff);
    expect(normalizeSeed(2 ** 32 + 5)).toBe(5);
    expect(normalizeSeed(Number.NaN)).toBe(0);
    expect(normalizeSeed('abc')).toBe(hashString('abc'));
    expect(hashString('')).toBe(0x811c9dc5);
    expect(sequence(-1, 5)).toEqual(sequence(0xffffffff, 5));
  });

  it('next() stays within [0, 1)', () => {
    const rng = createRng(7);
    for (let i = 0; i < 10_000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('nextInt() honours inclusive bounds and hits both ends', () => {
    const rng = createRng(99);
    const seen = new Set<number>();
    for (let i = 0; i < 5_000; i++) {
      const v = rng.nextInt(3, 6);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(6);
      seen.add(v);
    }
    expect([...seen].sort()).toEqual([3, 4, 5, 6]);
    expect(rng.nextInt(5, 5)).toBe(5);
    expect(() => rng.nextInt(6, 3)).toThrow(RangeError);
  });

  it('nextFloat() and chance() behave at the edges', () => {
    const rng = createRng(5);
    for (let i = 0; i < 1_000; i++) {
      const v = rng.nextFloat(-2, 2);
      expect(v).toBeGreaterThanOrEqual(-2);
      expect(v).toBeLessThan(2);
    }
    expect(rng.chance(0)).toBe(false);
    expect(rng.chance(1)).toBe(true);
    let hits = 0;
    for (let i = 0; i < 10_000; i++) if (rng.chance(0.3)) hits++;
    expect(hits / 10_000).toBeCloseTo(0.3, 1);
  });

  it('pick() is roughly uniform and rejects empty arrays', () => {
    const rng = createRng('pick');
    const items = ['a', 'b', 'c', 'd'] as const;
    const counts: Record<string, number> = {};
    for (let i = 0; i < 20_000; i++) {
      const v = rng.pick(items);
      counts[v] = (counts[v] ?? 0) + 1;
    }
    for (const item of items) {
      expect(counts[item] ?? 0).toBeGreaterThan(4_500);
      expect(counts[item] ?? 0).toBeLessThan(5_500);
    }
    expect(() => rng.pick([])).toThrow(RangeError);
  });

  it('shuffle() permutes in place and is roughly uniform per position', () => {
    const rng = createRng('shuffle');
    const arr = [0, 1, 2, 3];
    expect(rng.shuffle(arr)).toBe(arr);
    expect([...arr].sort()).toEqual([0, 1, 2, 3]);

    const trials = 24_000;
    const positionCounts = [0, 0, 0, 0];
    for (let t = 0; t < trials; t++) {
      const a = [0, 1, 2, 3];
      rng.shuffle(a);
      positionCounts[a.indexOf(0)]! += 1;
    }
    for (const c of positionCounts) {
      expect(c).toBeGreaterThan(trials / 4 - 600);
      expect(c).toBeLessThan(trials / 4 + 600);
    }
  });

  it('gaussian() has the requested mean and spread', () => {
    const rng = createRng('gauss');
    const n = 20_000;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = rng.gaussian(10, 2);
      sum += v;
      sumSq += v * v;
    }
    const mean = sum / n;
    const sd = Math.sqrt(sumSq / n - mean * mean);
    expect(mean).toBeCloseTo(10, 1);
    expect(sd).toBeCloseTo(2, 1);
  });

  it('stream(name) is independent of draw and creation order', () => {
    const a = createRng(1234);
    const b = createRng(1234);

    const trafficA = a.stream('traffic');
    const fromA = [trafficA.next(), trafficA.next(), trafficA.next()];

    b.next();
    b.next();
    b.stream('weather').next();
    b.stream('calls');
    const trafficB = b.stream('traffic');
    const fromB = [trafficB.next(), trafficB.next(), trafficB.next()];

    expect(fromA).toEqual(fromB);
    expect(fromA).not.toEqual(sequence(1234, 3));
    expect(a.stream('weather').next()).not.toBe(a.stream('traffic').next());
    expect(a.stream('x').stream('y').next()).toBe(b.stream('x').stream('y').next());
  });

  it('state()/restore() round-trips mid-sequence', () => {
    const rng = createRng('state');
    rng.next();
    rng.next();
    const snapshot = rng.state();
    const json = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
    const expected = [rng.next(), rng.next(), rng.next()];

    rng.restore(json);
    expect([rng.next(), rng.next(), rng.next()]).toEqual(expected);

    const clone = rngFromState(json);
    expect(clone.seed).toBe(rng.seed);
    expect([clone.next(), clone.next(), clone.next()]).toEqual(expected);

    expect(() => rng.restore({ seed: 1, s: [1, 2, 3, -1] })).toThrow(TypeError);
  });
});
