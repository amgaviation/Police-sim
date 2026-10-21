import { describe, expect, it } from 'vitest';
import { WORLD_CONFIG, crimeFactor, evolveNeighborhood, newNeighborhood, type NeighborhoodState } from '../../src/worldstate';

const BASE = 0.6;
const N = WORLD_CONFIG.neighborhoods;

/** Evolves one day at a time, like repeated shifts, with a neutral draw. */
function simulate(trust: number, atLarge: number, arrests: number, days: number, u = 0.5): NeighborhoodState {
  const n = newNeighborhood(BASE);
  for (let i = 0; i < days; i++) evolveNeighborhood(n, BASE, trust, atLarge, arrests, 1, u);
  return n;
}

describe('evolveNeighborhood', () => {
  it('high trust lowers crime below base over 30 days', () => {
    const n = simulate(0.9, 0, 0, 30);
    expect(n.crime).toBeLessThan(BASE - 0.1);
    expect(n.trend).toBeLessThanOrEqual(0);
  });

  it('low trust and 20 offenders at large raise crime above base', () => {
    const n = simulate(0.1, 20, 0, 30);
    expect(n.crime).toBeGreaterThan(BASE + 0.1);
    expect(n.crime).toBeLessThanOrEqual(N.max);
  });

  it('arrests lower the level', () => {
    expect(simulate(0.5, 0, 20, 30).crime).toBeLessThan(simulate(0.5, 0, 0, 30).crime);
  });

  it('neutral inputs keep the base', () => {
    expect(simulate(0.5, 0, 0, 30).crime).toBeCloseTo(BASE, 10);
  });

  it('changes nothing for zero (or negative) days', () => {
    const n = newNeighborhood(BASE);
    evolveNeighborhood(n, BASE, 0.1, 20, 0, 0, 0.9);
    evolveNeighborhood(n, BASE, 0.1, 20, 0, -3, 0.9);
    expect(n).toEqual({ crime: BASE, trend: 0, history: [] });
  });

  it('is deterministic', () => {
    const a = simulate(0.3, 5, 2, 12, 0.2);
    const b = simulate(0.3, 5, 2, 12, 0.2);
    expect(a).toEqual(b);
  });

  it('the draw moves the level by at most the noise', () => {
    const lo = newNeighborhood(BASE);
    const hi = newNeighborhood(BASE);
    evolveNeighborhood(lo, BASE, 0.5, 0, 0, 1, 0);
    evolveNeighborhood(hi, BASE, 0.5, 0, 0, 1, 1);
    expect(hi.crime - lo.crime).toBeCloseTo(2 * N.noise, 10);
  });

  it('keeps the history to historyDays values and tracks the trend', () => {
    const n = simulate(0.9, 0, 0, 40);
    expect(n.history).toHaveLength(N.historyDays);
    expect(n.history[n.history.length - 1]).toBe(n.crime);
    const m = newNeighborhood(BASE);
    evolveNeighborhood(m, BASE, 0.9, 0, 0, 5, 0.5);
    expect(m.trend).toBeCloseTo(m.crime - BASE, 10);
  });

  it('clamps to [min, max]', () => {
    const low = newNeighborhood(0.06);
    evolveNeighborhood(low, 0.06, 1, 0, 100, 30, 0);
    expect(low.crime).toBe(N.min);
    const high = newNeighborhood(0.9);
    evolveNeighborhood(high, 0.9, 0, 500, 0, 30, 1);
    expect(high.crime).toBe(N.max);
  });
});

describe('crimeFactor', () => {
  it('is crime / base inside the range', () => {
    expect(crimeFactor({ crime: 0.66, trend: 0, history: [] }, 0.6)).toBeCloseTo(1.1);
  });

  it('clamps to the factor range', () => {
    expect(crimeFactor({ crime: 0.05, trend: 0, history: [] }, 0.6)).toBe(0.7);
    expect(crimeFactor({ crime: 0.95, trend: 0, history: [] }, 0.3)).toBe(1.5);
  });

  it('is 1 when the base is 0', () => {
    expect(crimeFactor({ crime: 0.4, trend: 0, history: [] }, 0)).toBe(1);
  });
});
