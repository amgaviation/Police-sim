import { afterAll, describe, expect, it } from 'vitest';
import type { IndoorNavPort, Listener, NoGoZone } from '../../src/npc/types';
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

/** A nav port that allocates nothing: straight paths and a fixed way out. */
const nav: IndoorNavPort = {
  path(_b, _x, _z, tx, tz, out) {
    out[0] = tx;
    out[1] = tz;
    return 1;
  },
  exit(_b, x, z, out, pose) {
    out[0] = x + 4;
    out[1] = z;
    pose.x = x + 5;
    pose.z = z;
    pose.yaw = 0;
    return 1;
  },
  hideSpot: () => -1,
  releaseHide: () => undefined,
};

/** 160 pedestrians, 30 outdoor actors, 12 indoor actors (idle and following), a nav port and two no-go zones. */
async function busyRig(): Promise<{ r: NpcRig; px: number; pz: number }> {
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
  r.npc.setIndoorNav(nav);
  r.focus.building = 3;
  for (let i = 0; i < 12; i++) {
    const id = r.npc.spawnActor(spec(7000 + i * 13, p.x + i, p.z + 70, { profile: 'callerHelpful', building: 3, callId: 0 }));
    if (i % 3 === 0) r.npc.follow(id, true);
  }
  const zone = (id: number, cx: number): NoGoZone => ({
    id, points: new Float32Array([cx - 5, p.z - 90, cx + 5, p.z - 90, cx + 5, p.z - 80, cx - 5, p.z - 80]), minX: cx - 5, minZ: p.z - 90, maxX: cx + 5, maxZ: p.z - 80,
  });
  r.npc.setNoGoZones([zone(1, p.x - 40), zone(2, p.x + 40)]);
  r.run(900);
  return { r, px: p.x, pz: p.z };
}

describe('indoor performance', () => {
  it('a step with the indoor additions averages 0.17 ms or less (0.15 ms baseline + 0.02)', async () => {
    const { r } = await busyRig();
    r.run(300);
    let best = Infinity;
    for (let k = 0; k < 5; k++) {
      const t0 = performance.now();
      r.run(600);
      best = Math.min(best, (performance.now() - t0) / 600);
    }
    expect(best).toBeLessThanOrEqual(0.17);
  }, 60000);

  it('does not allocate in step, listeners or stimulate (steady state)', async () => {
    const gc = await loadGc();
    const { r, px, pz } = await busyRig();
    const buf: Listener[] = [];
    r.npc.listeners(px, pz + 70, 50, buf);
    const ids: number[] = [];
    r.npc.actorsInBuilding(3, ids);
    const work = (n: number): void => {
      for (let i = 0; i < n; i++) {
        r.npc.listeners(px, pz + 70, 50, buf);
        // Below the alert line: nothing is raised, so nothing may be allocated.
        r.npc.stimulate(ids[i % ids.length] as number, 'sound', 0.001, px, pz);
        r.run(1);
      }
    };
    // Warm-up includes the calls under test (the JIT's own compiled code shows up in the heap size).
    work(1500);
    let worst = 0;
    for (let k = 0; k < 8; k++) {
      gc();
      const before = process.memoryUsage().heapUsed;
      work(100);
      worst = Math.max(worst, process.memoryUsage().heapUsed - before);
    }
    // The loop itself boxes the double arguments of both calls (about 200 bytes per iteration); a per-step allocation
    // inside the system would be many times that.
    expect(worst).toBeLessThan(80_000);
    expect(buf.length).toBeGreaterThan(0);
  }, 60000);
});
