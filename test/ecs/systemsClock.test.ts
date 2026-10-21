import { afterEach, describe, expect, it, vi } from 'vitest';
import { SystemRegistry } from '../../src/ecs/systems';
import { createGameWorld } from '../../src/ecs/world';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('SystemRegistry.runAll clock', () => {
  it('reads the clock once per system boundary and splits the interval between systems', () => {
    let t = 0;
    const reads: number[] = [];
    vi.spyOn(performance, 'now').mockImplementation(() => {
      reads.push(t);
      return t;
    });
    const reg = new SystemRegistry();
    reg.register({ name: 'a', run: () => { t += 1; } }, 1);
    reg.register({ name: 'b', run: () => { t += 4; } }, 2);
    reg.register({ name: 'off', run: () => { t += 100; } }, 3);
    reg.disable('off');
    reg.runAll(createGameWorld(), 1 / 60);
    // One read before the first system, then one after each system that ran.
    expect(reads).toHaveLength(3);
    expect(reg.timings.get('a')).toBe(1);
    expect(reg.timings.get('b')).toBe(4);
    expect(reg.timings.get('off')).toBe(0);
  });

  it('feeds the profiler the same durations the timings map holds', () => {
    let t = 10;
    vi.spyOn(performance, 'now').mockImplementation(() => t);
    const seen = new Map<string, number>();
    let ends = 0;
    const reg = new SystemRegistry();
    reg.register({ name: 'a', run: () => { t += 2.5; } }, 1);
    reg.register({ name: 'b', run: () => { t += 0.25; } }, 2);
    reg.setProfiler({ record: (name, ms) => seen.set(name, ms), endStep: () => { ends++; } });
    reg.runAll(createGameWorld(), 1 / 60);
    expect(seen.get('a')).toBe(2.5);
    expect(seen.get('b')).toBe(0.25);
    expect(ends).toBe(1);
    expect(reg.timings.get('a')).toBe(2.5);
  });
});
