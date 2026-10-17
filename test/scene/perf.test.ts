import { describe, expect, it } from 'vitest';
import { DT, at, engage, makeRig, run, spawnWhere, step } from './helpers';

describe('scene performance', () => {
  it('an idle scene step (no scenario, nothing queued) costs well under 0.03 ms', async () => {
    const r = await makeRig();
    const n = 20000;
    const t0 = performance.now();
    for (let i = 0; i < n; i++) r.scene.step(DT, at(i * DT), r.officer);
    const avg = (performance.now() - t0) / n;
    expect(avg).toBeLessThan(0.03);
  });

  it('a step with a materialized scene stays within 0.03 ms on average (scene work only)', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', (rt) => !rt.scenario.variants.includes('false') && rt.scenario.participants.length >= 3);
    engage(r, id, 30, 2);
    run(r, 1);
    expect(r.scene.stats.materialized).toBe(1);
    const n = 6000;
    let total = 0;
    for (let i = 0; i < n; i++) {
      const t = at(r.sim);
      const t0 = performance.now();
      r.scene.step(DT, t, r.officer);
      total += performance.now() - t0;
      step(r);
    }
    expect(total / n).toBeLessThan(0.03);
  });

  it('building a scenario and materializing it take 2 ms or less on average', async () => {
    const r = await makeRig();
    // Warm the caches the way a running game has them (first people identity builds the name index).
    spawnWhere(r, 'domesticDisturbance', () => true);
    run(r, 0.1);
    const build: number[] = [];
    const materialize: number[] = [];
    for (let k = 0; k < 30; k++) {
      const t0 = performance.now();
      const id = r.scene.spawnCall('domesticDisturbance', at(r.sim), { x: r.player.x, z: r.player.z });
      build.push(performance.now() - t0);
      const rt = r.scene.runtime(id);
      if (!rt || rt.scenario.variants.includes('false')) continue;
      r.dispatcher.request(r.dispatcher.playerCallsign, { kind: 'selfAssign', callId: id }, 'key');
      r.player.x = rt.scenario.anchor.x - 100;
      r.player.z = rt.scenario.anchor.z;
      // The dispatcher applies the assignment first; the scene materializes in its own step.
      r.dispatcher.step(DT, at(r.sim), r.player);
      r.officer.x = r.player.x;
      r.officer.z = r.player.z;
      const t1 = performance.now();
      r.scene.step(DT, at(r.sim), r.officer);
      if (rt.materialized) materialize.push(performance.now() - t1);
      r.cad.closeCall(id, 'cancelled', at(r.sim));
      run(r, 0.1);
    }
    const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    expect(materialize.length).toBeGreaterThan(10);
    expect(mean(build)).toBeLessThan(2);
    expect(mean(materialize)).toBeLessThan(2);
  });
});
