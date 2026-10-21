import { Session } from 'node:inspector';
import { describe, expect, it } from 'vitest';
import { vehicleModel } from '../../src/vehicles/model';
import { generateCity } from '../../src/world/generate';
import { DT, makeHarness } from './helpers';

/** Sampled allocation record of one call frame (V8 sampling heap profiler). */
interface ProfileNode {
  callFrame: { functionName: string; url: string };
  selfSize: number;
  children: ProfileNode[];
}

/** Bytes the sampling profiler attributes to frames whose URL contains `needle` (plus `hypot`, the Math.hypot builtin). */
function allocatedBy(root: ProfileNode, needle: string): number {
  let total = 0;
  const stack = [root];
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    const { url, functionName } = n.callFrame;
    if (url.includes(needle) || functionName === 'hypot') total += n.selfSize;
    for (const c of n.children) stack.push(c);
  }
  return total;
}

describe('traffic step allocation', () => {
  it('stays under a per-step allocation budget with ~190 cars', async () => {
    const city = generateCity(99);
    const h = await makeHarness(city.graph, 99, city);
    h.focus.x = 256;
    h.focus.z = -512;
    h.sys.densityScale = 3;
    const rush = { hour: 8, isWeekday: true };
    h.sys.populate(h.focus, rush);
    const look = { modelIndex: vehicleModel('patrol_sedan').index, color: 0xffffff };
    for (let i = 0; i < 6; i++) h.sys.spawnFleetCar(i, 256 + 120 * Math.cos(i), -512 + 120 * Math.sin(i), look);
    let t = 0;
    const stepOnce = (): void => {
      t += DT;
      h.sys.step(DT, t, rush, h.focus);
    };
    for (let i = 0; i < 600; i++) stepOnce(); // warm-up: JIT and first-sight work

    const session = new Session();
    session.connect();
    const post = (method: string, params?: object): Promise<{ profile?: { head: ProfileNode } }> =>
      new Promise((resolve, reject) => {
        session.post(method, params as never, (err, result) => (err ? reject(err) : resolve(result as never)));
      });
    await post('HeapProfiler.enable');
    await post('HeapProfiler.startSampling', {
      samplingInterval: 128,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const steps = 1500;
    for (let i = 0; i < steps; i++) stepOnce();
    const result = await post('HeapProfiler.stopSampling');
    session.disconnect();

    const head = result.profile?.head;
    expect(head).toBeDefined();
    const perStep = allocatedBy(head as ProfileNode, 'src/traffic/') / steps;
    console.log(`traffic: ${perStep.toFixed(0)} bytes allocated per step with ${String(h.sys.view.count)} cars`);
    // Before the Phase 9 pass this was ~41 KB per step (Math.hypot builtin and boxed lane lookups); now ~20 KB.
    expect(perStep).toBeLessThan(32 * 1024);
  }, 120_000);
});
