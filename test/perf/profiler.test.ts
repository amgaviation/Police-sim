import v8 from 'node:v8';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { SystemProfiler, formatProfile, PROFILE_PHASES } from '../../src/debug/profiler';
import { SystemRegistry } from '../../src/ecs/systems';
import { createGameWorld } from '../../src/ecs/world';

declare const process: { memoryUsage(): { heapUsed: number } };

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

function heapBytes(): number {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

/** Upper edge (ms) of the histogram bucket the spec assigns to `ms`. */
function upperEdge(ms: number): number {
  const b = Math.min(63, Math.max(0, Math.floor(4 * Math.log2(ms / 0.001))));
  return 0.001 * 2 ** ((b + 1) / 4);
}

describe('SystemProfiler', () => {
  it('lists the frame phases', () => {
    expect([...PROFILE_PHASES]).toEqual(['sim', 'update', 'render']);
  });

  it('reports exact count, mean, max, total and share per system, sorted by total', () => {
    const p = new SystemProfiler();
    for (const ms of [1, 2, 3]) p.record('a', ms);
    for (const ms of [0.5, 0.5]) p.record('b', ms);
    p.record('c', 10);
    p.endStep();
    p.endStep();
    const r = p.report();
    expect(r.steps).toBe(2);
    expect(r.systems.map((s) => s.name)).toEqual(['c', 'a', 'b']);
    const a = r.systems.find((s) => s.name === 'a');
    expect(a).toMatchObject({ count: 3, meanMs: 2, maxMs: 3, totalMs: 6 });
    expect(r.systems.find((s) => s.name === 'b')).toMatchObject({ count: 2, meanMs: 0.5, maxMs: 0.5, totalMs: 1 });
    expect(r.systems.find((s) => s.name === 'c')?.share).toBeCloseTo(10 / 17, 12);
    expect(r.systems.reduce((acc, s) => acc + s.share, 0)).toBeCloseTo(1, 12);
  });

  it('p95 is the upper edge of the bucket holding the 95th percentile sample', () => {
    const p = new SystemProfiler();
    // 95 fast samples and 5 slow ones: the 95th percentile (rank 95) is still a fast one.
    for (let i = 0; i < 95; i++) p.record('x', 0.1);
    for (let i = 0; i < 5; i++) p.record('x', 8);
    expect(p.report().systems[0]?.p95Ms).toBeCloseTo(upperEdge(0.1), 12);
    // One more slow sample moves rank 95 of 101 (ceil(95.95) = 96) into the slow bucket.
    p.record('x', 8);
    expect(p.report().systems[0]?.p95Ms).toBeCloseTo(upperEdge(8), 12);
    // Edge bucket arithmetic: 0.1 ms is bucket floor(4 * log2(100)) = 26.
    expect(upperEdge(0.1)).toBeCloseTo(0.001 * 2 ** (27 / 4), 12);
  });

  it('clamps the histogram: zero and tiny samples land in bucket 0, huge ones in bucket 63', () => {
    const p = new SystemProfiler();
    p.record('lo', 0);
    p.record('lo', -1);
    p.record('hi', 1e9);
    const rows = p.report().systems;
    expect(rows.find((r) => r.name === 'lo')?.p95Ms).toBeCloseTo(0.001 * 2 ** 0.25, 12);
    expect(rows.find((r) => r.name === 'hi')?.p95Ms).toBeCloseTo(0.001 * 2 ** 16, 9);
  });

  it('frame phases keep their own stats and frames counts the largest phase', () => {
    const p = new SystemProfiler();
    p.frame('sim', 1);
    p.frame('sim', 3);
    p.frame('render', 4);
    const r = p.report();
    expect(r.phases.map((row) => row.name)).toEqual(['sim', 'update', 'render']);
    expect(r.phases[0]).toMatchObject({ count: 2, meanMs: 2, maxMs: 3 });
    expect(r.phases[1]).toMatchObject({ count: 0, meanMs: 0, p95Ms: 0 });
    expect(r.phases[2]?.share).toBeCloseTo(0.5, 12);
    expect(r.frames).toBe(2);
  });

  it('ignores names beyond maxSystems and keeps counting known ones', () => {
    const p = new SystemProfiler(2);
    p.record('a', 1);
    p.record('b', 1);
    p.record('c', 1);
    p.record('a', 1);
    const r = p.report();
    expect(r.systems.map((s) => s.name).sort()).toEqual(['a', 'b']);
    expect(r.systems.find((s) => s.name === 'a')?.count).toBe(2);
  });

  it('reset clears samples but keeps working', () => {
    const p = new SystemProfiler();
    p.record('a', 5);
    p.endStep();
    p.frame('render', 2);
    p.reset();
    let r = p.report();
    expect(r).toMatchObject({ steps: 0, frames: 0, systems: [] });
    p.record('a', 1);
    r = p.report();
    expect(r.systems[0]).toMatchObject({ name: 'a', count: 1, meanMs: 1, maxMs: 1 });
  });

  it('does not allocate over 100 000 record calls once the names are known', () => {
    const p = new SystemProfiler();
    const names = ['alpha', 'beta', 'gamma', 'delta'];
    for (const n of names) p.record(n, 0.1);
    let sink = 0;
    for (let i = 0; i < 20_000; i++) sink += i; // warm the JIT before the baseline reading
    const before = heapBytes();
    for (let i = 0; i < 100_000; i++) {
      p.record(names[i & 3] ?? 'alpha', 0.01 + (i % 97) * 0.01);
      if ((i & 255) === 0) p.endStep();
    }
    const after = heapBytes();
    expect(sink).toBeGreaterThan(0);
    expect(after - before).toBeLessThan(256 * 1024);
  });

  it('records in well under the 0.0005 ms budget', () => {
    const p = new SystemProfiler();
    const names = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta'];
    for (const n of names) p.record(n, 0.1);
    const calls = 200_000;
    let best = Infinity;
    for (let rep = 0; rep < 5; rep++) {
      const t0 = performance.now();
      for (let i = 0; i < calls; i++) p.record(names[i & 7] ?? 'alpha', 0.01 + (i % 97) * 0.01);
      best = Math.min(best, (performance.now() - t0) / calls);
    }
    console.log(`SystemProfiler.record: ${(best * 1e6).toFixed(0)} ns per call`);
    expect(best).toBeLessThan(0.0005);
  });

  it('formatProfile prints a Markdown table of the top rows', () => {
    const p = new SystemProfiler();
    p.record('slow', 2);
    p.record('fast', 0.5);
    p.record('mid', 1);
    const text = formatProfile(p.report(), 2);
    const lines = text.split('\n');
    expect(lines[0]).toBe('| system | mean ms | p95 | max | share |');
    expect(lines[1]).toBe('|---|---:|---:|---:|---:|');
    expect(lines).toHaveLength(4);
    expect(lines[2]).toMatch(/^\| slow \| 2\.000 \| \d+\.\d{3} \| 2\.000 \| 57\.1% \|$/);
    expect(lines[3]).toMatch(/^\| mid \|/);
    expect(formatProfile(p.report(), 0).split('\n')).toHaveLength(2);
  });
});

describe('SystemRegistry profiler hook', () => {
  it('records every enabled system once per run and calls endStep once per runAll', () => {
    const calls: string[] = [];
    const sink = {
      record: (name: string, ms: number) => {
        expect(ms).toBeGreaterThanOrEqual(0);
        calls.push(`record:${name}`);
      },
      endStep: () => calls.push('endStep'),
    };
    const reg = new SystemRegistry();
    reg.register({ name: 'one', run: () => calls.push('run:one') }, 1);
    reg.register({ name: 'two', run: () => calls.push('run:two') }, 2);
    reg.register({ name: 'off', run: () => calls.push('run:off') }, 3);
    reg.disable('off');
    reg.setProfiler(sink);
    const world = createGameWorld();
    reg.runAll(world, 1 / 60);
    reg.runAll(world, 1 / 60);
    expect(calls).toEqual([
      'run:one', 'record:one', 'run:two', 'record:two', 'endStep',
      'run:one', 'record:one', 'run:two', 'record:two', 'endStep',
    ]);
  });

  it('behaves as before with no profiler and after detaching one', () => {
    const reg = new SystemRegistry();
    let runs = 0;
    reg.register({ name: 'one', run: () => runs++ });
    const world = createGameWorld();
    reg.runAll(world, 1 / 60);
    const p = new SystemProfiler();
    reg.setProfiler(p);
    reg.runAll(world, 1 / 60);
    reg.setProfiler(null);
    reg.runAll(world, 1 / 60);
    expect(runs).toBe(3);
    expect(p.report().steps).toBe(1);
    expect(reg.timings.has('one')).toBe(true);
  });
});
