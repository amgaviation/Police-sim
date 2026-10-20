import { describe, expect, it } from 'vitest';
import { DISTRICTS } from '../../src/dialogue/data';
import { makeHarness, run } from './helpers';

describe('crime factor (community trust to crime rate)', () => {
  it('multiplies the generator multiplier before the clamp; null restores', async () => {
    const h = await makeHarness({ start: false });
    const g = h.dispatcher.generator;
    // A time and place whose multiplier is well inside the clamp, so the factor shows unclamped.
    let found: { t: number; district: string; base: number } | null = null;
    for (const district of DISTRICTS) {
      for (let hour = 0; hour < 24 && !found; hour++) {
        const base = g.multiplier(hour * 3600, district);
        if (base > 0.4 && base < 1.4) found = { t: hour * 3600, district, base };
      }
    }
    expect(found).not.toBeNull();
    const { t, district, base } = found!;
    const asked: string[] = [];
    g.setCrimeFactor((d) => {
      asked.push(d);
      return 2;
    });
    expect(g.multiplier(t, district)).toBeCloseTo(base * 2, 10);
    expect(asked).toEqual([district]);
    g.setCrimeFactor(() => 0.5);
    expect(g.multiplier(t, district)).toBeCloseTo(Math.max(0.25, base * 0.5), 10);
    // The clamp is applied after the factor.
    g.setCrimeFactor(() => 100);
    expect(g.multiplier(t, district)).toBe(3);
    g.setCrimeFactor(() => 0);
    expect(g.multiplier(t, district)).toBe(0.25);
    // A factor that is not a number counts as 1.
    g.setCrimeFactor(() => Number.NaN);
    expect(g.multiplier(t, district)).toBe(base);
    g.setCrimeFactor(null);
    expect(g.multiplier(t, district)).toBe(base);
  });

  it('can differ per district', async () => {
    const h = await makeHarness({ start: false });
    const g = h.dispatcher.generator;
    const t = 21 * 3600;
    const a = g.multiplier(t, 'downtown');
    const b = g.multiplier(t, 'suburbs');
    g.setCrimeFactor((d) => (d === 'downtown' ? 1 : 0.1));
    expect(g.multiplier(t, 'downtown')).toBe(a);
    expect(g.multiplier(t, 'suburbs')).toBe(Math.max(0.25, b * 0.1));
  });

  it('Dispatcher.setCrimeFactor forwards to its generator', async () => {
    const h = await makeHarness({ start: false });
    const g = h.dispatcher.generator;
    const before = g.multiplier(21 * 3600, 'downtown');
    expect(before).toBeLessThan(3);
    h.dispatcher.setCrimeFactor(() => 1.2);
    expect(g.multiplier(21 * 3600, 'downtown')).toBeCloseTo(Math.min(3, before * 1.2), 10);
    h.dispatcher.setCrimeFactor(null);
    expect(g.multiplier(21 * 3600, 'downtown')).toBe(before);
  });

  it('a higher factor generates more calls over a run (seeded)', async () => {
    const count = async (factor: number): Promise<number> => {
      const h = await makeHarness();
      h.dispatcher.setCrimeFactor(() => factor);
      run(h, 30 * 60);
      return h.dispatcher.stats.generated;
    };
    const low = await count(0.1);
    const high = await count(3);
    expect(high).toBeGreaterThan(low);
  });
});
