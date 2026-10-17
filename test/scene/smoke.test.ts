import { describe, expect, it } from 'vitest';
import { makeRig, startScene, run, at } from './helpers';

describe('smoke', () => {
  it('builds and materializes a domestic call', async () => {
    const r = await makeRig();
    const id = startScene(r, 'domesticDisturbance', [], 2);
    const rt = r.scene.runtime(id);
    expect(rt).not.toBeNull();
    console.log(rt?.scenario.branch, rt?.scenario.variants, [...(rt?.flags ?? [])], rt?.materialized, rt?.actorIds);
    console.log(r.cad.call(id)?.narrative.map((n) => n.text));
    run(r, 5);
    console.log(r.scene.stats, at(r.sim));
  });
});
