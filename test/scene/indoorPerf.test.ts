import { describe, expect, it } from 'vitest';
import type { Scenario } from '../../src/calls';
import { DT, at, run, step } from './helpers';
import { makeIndoorRig, materialize, spawnBound } from './indoorHelpers';

describe('indoor scene performance', () => {
  it('binding a call to a building (warm building index) takes well under 1 ms', async () => {
    const r = await makeIndoorRig();
    const { rt } = spawnBound(r, 'domesticDisturbance', ['house', 'apartment']);
    const bind = (r.scene as unknown as { bindBuilding(s: Scenario): number }).bindBuilding.bind(r.scene);
    for (let i = 0; i < 20; i++) bind(rt.scenario);
    const n = 500;
    const t0 = performance.now();
    let sum = 0;
    for (let i = 0; i < n; i++) sum += bind(rt.scenario);
    const avg = (performance.now() - t0) / n;
    expect(sum).toBe(rt.buildingId * n);
    expect(avg).toBeLessThan(1);
  });

  it('a step with a materialized indoor scene stays within 0.03 ms on average (scene work only)', async () => {
    const r = await makeIndoorRig();
    const { id, rt } = spawnBound(r, 'domesticDisturbance', ['house', 'apartment'], (x) => x.scenario.participants.length >= 3 && !x.scenario.variants.includes('false'));
    materialize(r, id, 2);
    run(r, 1);
    expect(rt.materialized).toBe(true);
    r.officer.building = rt.buildingId;
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
});
