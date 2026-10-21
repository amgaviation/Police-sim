import v8 from 'node:v8';
import vm from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initRapier } from '../../src/physics/physics';
import { Harness } from '../game/harness';

/** Node pieces the test needs (the project's tsconfig carries no Node globals). */
declare const process: { env: Record<string, string | undefined>; memoryUsage(): { heapUsed: number } };

const LONG = process.env.PATROL_LONG === '1';
const MB = 1024 * 1024;

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc') as () => void;

/** Heap in use after two full collections (the first frees, the second settles weak references and finalizers). */
function heapMb(): number {
  gc();
  gc();
  return process.memoryUsage().heapUsed / MB;
}

beforeAll(async () => {
  await initRapier();
});

describe('memory (Node)', () => {
  let harness: Harness | null = null;
  afterAll(() => {
    harness?.dispose();
  });

  it('session churn: 6 x (start, 600 steps, reset) does not keep growing and leaks no bus listeners', () => {
    const h = new Harness(undefined, undefined, true);
    harness = h;
    const heaps: number[] = [];
    const listeners: number[] = [];
    for (let cycle = 0; cycle < 6; cycle++) {
      const session = h.start(77, true);
      h.step(session, 600);
      h.reset(session);
      listeners.push(h.bus.listenerCount());
      heaps.push(heapMb());
    }
    const growth = (heaps[5] ?? 0) - (heaps[1] ?? 0);
    const report = `heap MB per cycle: ${heaps.map((v) => v.toFixed(1)).join(', ')}; listeners: ${listeners.join(', ')}`;
    console.log(report);
    expect(listeners.every((n) => n === listeners[0]), report).toBe(true);
    expect(growth, report).toBeLessThan(12);
    h.dispose();
    harness = null;
  }, 300_000);

  it(`plateau: one session, ${LONG ? 6 : 4} segments of ${LONG ? 7200 : 1800} steps`, () => {
    const segments = LONG ? 6 : 4;
    const stepsPerSegment = LONG ? 7200 : 1800;
    const limit = LONG ? 24 : 16;
    const h = new Harness(undefined, undefined, true);
    harness = h;
    const session = h.start(4242, true);
    const heaps: number[] = [];
    for (let s = 0; s < segments; s++) {
      h.step(session, stepsPerSegment);
      heaps.push(heapMb());
    }
    const growth = (heaps[segments - 1] ?? 0) - (heaps[1] ?? 0);
    const report = `heap MB at the end of each segment: ${heaps.map((v) => v.toFixed(1)).join(', ')} (growth segment 2 -> ${String(segments)}: ${growth.toFixed(1)} MB, limit ${String(limit)})`;
    console.log(report);
    expect(growth, report).toBeLessThan(limit);
    h.dispose();
    harness = null;
  }, LONG ? 20 * 60_000 : 300_000);
});
