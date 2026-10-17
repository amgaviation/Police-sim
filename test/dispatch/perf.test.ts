import { describe, expect, it } from 'vitest';
import { DT, at, makeHarness, run, zone } from './helpers';

describe('dispatch performance', () => {
  it('steps within budget over 3600 steps (calls, AI units en route, offers, AVL)', async () => {
    const h = await makeHarness();
    // Warm up: calls exist, units are dispatched, code paths are compiled.
    run(h, 120);
    h.dispatcher.request('12', { kind: 'backup', code: 3 }, 'radio');
    const steps = 3600;
    let total = 0;
    let worst = 0;
    for (let i = 0; i < steps; i++) {
      const t = at(h.sim);
      const start = performance.now();
      h.dispatcher.step(DT, t, h.player);
      const ms = performance.now() - start;
      total += ms;
      worst = Math.max(worst, ms);
      h.sim += DT;
      h.traffic.step(DT, h.sim, zone(h), h.focus);
      h.physics.step();
    }
    const avg = total / steps;
    console.log(`dispatch step: ${avg.toFixed(4)} ms average, ${worst.toFixed(3)} ms worst over ${String(steps)} steps (${String(h.dispatcher.stats.generated)} calls generated)`);
    // Budget 0.05 ms average / 2 ms spikes on the target machine; generous bounds for shared CI runners.
    expect(avg).toBeLessThan(0.25);
    expect(worst).toBeLessThan(20);
  }, 60000);
});
