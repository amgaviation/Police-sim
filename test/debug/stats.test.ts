import { describe, expect, it } from 'vitest';
import { RollingStats, ema, formatBytes, topEntries } from '../../src/debug/stats';

describe('RollingStats', () => {
  it('rejects a non-positive capacity', () => {
    expect(() => new RollingStats(0)).toThrow(RangeError);
    expect(() => new RollingStats(1.5)).toThrow(RangeError);
  });

  it('returns zeros when empty', () => {
    const s = new RollingStats(4);
    expect(s.count).toBe(0);
    expect(s.average()).toBe(0);
    expect(s.min()).toBe(0);
    expect(s.max()).toBe(0);
    expect(s.percentile(0.5)).toBe(0);
    expect(s.worstAverage(0.01)).toBe(0);
    expect(s.last).toBe(0);
  });

  it('averages the samples in the window', () => {
    const s = new RollingStats(4);
    for (const v of [1, 2, 3, 4]) s.push(v);
    expect(s.count).toBe(4);
    expect(s.average()).toBe(2.5);
    expect(s.min()).toBe(1);
    expect(s.max()).toBe(4);
    expect(s.last).toBe(4);
  });

  it('evicts the oldest sample once full', () => {
    const s = new RollingStats(3);
    for (const v of [10, 20, 30, 40, 50]) s.push(v);
    expect(s.count).toBe(3);
    expect(s.average()).toBe(40);
    expect(s.min()).toBe(30);
    expect(s.max()).toBe(50);
  });

  it('keeps the running sum exact after many wraps', () => {
    const s = new RollingStats(7);
    for (let i = 0; i < 1000; i++) s.push(i % 13);
    let expected = 0;
    for (let i = 993; i < 1000; i++) expected += i % 13;
    expect(s.average()).toBeCloseTo(expected / 7, 12);
  });

  it('ignores non-finite samples', () => {
    const s = new RollingStats(3);
    s.push(NaN);
    s.push(Infinity);
    s.push(2);
    expect(s.count).toBe(1);
    expect(s.average()).toBe(2);
  });

  it('computes nearest-rank percentiles', () => {
    const s = new RollingStats(100);
    const values = Array.from({ length: 100 }, (_, i) => 100 - i); // 100..1 in descending order
    for (const v of values) s.push(v);
    expect(s.percentile(0)).toBe(1);
    expect(s.percentile(0.5)).toBe(50);
    expect(s.percentile(0.99)).toBe(99);
    expect(s.percentile(1)).toBe(100);
    expect(s.percentile(2)).toBe(100);
    expect(s.percentile(-1)).toBe(1);
  });

  it('averages the worst fraction of samples (1% low)', () => {
    const s = new RollingStats(200);
    for (let i = 0; i < 200; i++) s.push(16);
    s.push(50);
    s.push(40);
    // 200 samples: the worst 1% is 2 samples, 50 and 40.
    expect(s.worstAverage(0.01)).toBe(45);
    // At least one sample is always used.
    expect(s.worstAverage(0)).toBe(50);
    expect(s.worstAverage(1)).toBeCloseTo((198 * 16 + 90) / 200);
  });

  it('does not disturb samples when sorting for percentiles', () => {
    const s = new RollingStats(5);
    for (const v of [5, 1, 4, 2, 3]) s.push(v);
    s.percentile(0.5);
    s.push(9);
    expect(s.last).toBe(9);
    expect(s.average()).toBe((1 + 4 + 2 + 3 + 9) / 5);
  });

  it('clear() empties the window', () => {
    const s = new RollingStats(3);
    s.push(1);
    s.push(2);
    s.clear();
    expect(s.count).toBe(0);
    expect(s.average()).toBe(0);
    s.push(7);
    expect(s.average()).toBe(7);
  });
});

describe('ema', () => {
  it('moves toward the value by the smoothing factor', () => {
    expect(ema(0, 10, 0.1)).toBeCloseTo(1);
    expect(ema(10, 10, 0.5)).toBe(10);
    expect(ema(4, 8, 1)).toBe(8);
  });
});

describe('topEntries', () => {
  it('sorts by value descending, then by name, and limits', () => {
    const timings = new Map<string, number>([
      ['physics', 2.5],
      ['ai', 0.2],
      ['render', 2.5],
      ['audio', 0.1],
    ]);
    expect(topEntries(timings, 3)).toEqual([
      { name: 'physics', ms: 2.5 },
      { name: 'render', ms: 2.5 },
      { name: 'ai', ms: 0.2 },
    ]);
    expect(topEntries(timings, 0)).toEqual([]);
    expect(topEntries(new Map(), 5)).toEqual([]);
  });
});

describe('formatBytes', () => {
  it('formats byte counts', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(12.3 * 1024 * 1024)).toBe('12.3 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(formatBytes(-1)).toBe('-');
    expect(formatBytes(NaN)).toBe('-');
  });
});
