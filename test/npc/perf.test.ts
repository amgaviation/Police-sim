import { afterAll, describe, expect, it } from 'vitest';
import { DOWNTOWN, cityOf, makeRig, spec, spotIn, type NpcRig } from './helpers';

/** The Node pieces the allocation test needs (the project has no Node type definitions). */
declare const process: { memoryUsage(): { heapUsed: number } };
interface NodeModules {
  v8: { setFlagsFromString(flags: string): void };
  vm: { runInNewContext(code: string): unknown };
}

async function loadGc(): Promise<() => void> {
  const names: Record<keyof NodeModules, string> = { v8: 'node:v8', vm: 'node:vm' };
  const v8 = (await import(/* @vite-ignore */ names.v8)) as NodeModules['v8'];
  const vm = (await import(/* @vite-ignore */ names.vm)) as NodeModules['vm'];
  v8.setFlagsFromString('--expose-gc');
  return vm.runInNewContext('gc') as () => void;
}

const rigs: NpcRig[] = [];
afterAll(() => {
  for (const r of rigs) r.traffic.physics.dispose();
});

/** 160 pedestrians, 30 actors in steady states (idle, wander, crowd, cuffed and following) and cars with occupants. */
async function busyRig(): Promise<NpcRig> {
  const p = spotIn(cityOf(), DOWNTOWN);
  if (!p) throw new Error('no downtown edge');
  const r = await makeRig({ x: p.x, z: p.z, density: 3 });
  rigs.push(r);
  r.traffic.focus.x = p.x;
  r.traffic.focus.z = p.z;
  r.traffic.sys.populate(r.traffic.focus, { hour: 12, isWeekday: true });
  const profiles = ['callerHelpful', 'callerHelpful', 'bystander', 'crowdMember', 'guardianWorried'];
  for (let i = 0; i < 30; i++) {
    r.npc.spawnActor(spec(3000 + i * 11, p.x + (i % 6) * 8 - 20, p.z + Math.floor(i / 6) * 8 - 20, { profile: profiles[i % 5] as string }));
  }
  r.run(900);
  return r;
}

describe('performance', () => {
  it('fills the pools: 160 pedestrians, 30 actors, occupants', async () => {
    const r = await busyRig();
    expect(r.npc.stats.peds).toBe(160);
    expect(r.npc.stats.actors).toBe(30);
    expect(r.npc.view.count).toBe(r.npc.stats.peds + r.npc.stats.actors + r.npc.stats.occupants);
  });

  it('a step with 160 pedestrians and 30 actors averages 0.15 ms or less', async () => {
    const r = await busyRig();
    r.run(300);
    let best = Infinity;
    // The best of a few windows: a shared CI box adds noise but never makes a window faster than the code is.
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      r.run(600);
      best = Math.min(best, (performance.now() - t0) / 600);
    }
    expect(best).toBeLessThanOrEqual(0.15);
  }, 60000);

  it('does not allocate in step (steady state)', async () => {
    const gc = await loadGc();
    const r = await busyRig();
    r.run(600);
    let worst = 0;
    for (let k = 0; k < 8; k++) {
      gc();
      const before = process.memoryUsage().heapUsed;
      r.run(100);
      worst = Math.max(worst, process.memoryUsage().heapUsed - before);
    }
    // The test loop itself boxes a few numbers per step; one boxed double per figure and step would be 300 KB.
    expect(worst).toBeLessThan(40_000);
  }, 60000);
});
