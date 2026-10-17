import { describe, expect, it } from 'vitest';
import type { TrafficPulledOverEvent } from '../../src/traffic/events';
import { PULL, TRAFFIC_STATE } from '../../src/traffic/trafficSystem';
import { JUNCTION, laneRef } from '../../src/world/roadGraph';
import { carInfo, crossGraph, followCar, lineGraph, makeHarness, runFor, slotOf, type Harness } from './helpers';

const EAST = laneRef(0, 0, 0);

function pulledLog(h: Harness): TrafficPulledOverEvent[] {
  const out: TrafficPulledOverEvent[] = [];
  h.bus.on('traffic:pulledOver', (e) => out.push(e));
  return out;
}

/** Bumps the car in `slot` from behind with a dynamic box for 0.2 s. */
function bump(h: Harness, slot: number, t: number, follow: () => void): number {
  const x = h.sys.view.x[slot] ?? 0;
  const z = h.sys.view.z[slot] ?? 0;
  h.physics.addBox(9999, { x: x - 2.6, y: 0.8, z }, { x: 2.3, y: 0.7, z: 0.9 }, {});
  const end = runFor(h, t, 0.2, follow);
  h.physics.removeBody(9999);
  return end;
}

describe('traffic stop with lights and siren', () => {
  it('the car being followed pulls over for the stop at once instead of yielding and driving off first', async () => {
    const h = await makeHarness(lineGraph());
    h.sys.densityScale = 0;
    const pulled = pulledLog(h);
    h.sys.spawnAt(EAST, 1000, { speed: 12, behavior: 0, desiredFactor: 1 });
    const id = h.sys.view.vehicleId[0] ?? 0;
    let merged = false;
    runFor(h, 0, 15, () => {
      followCar(h, slotOf(h, id), 12, true, true);
      if (h.sys.inspect(slotOf(h, id), carInfo()).pull === PULL.merging) merged = true;
    });
    expect(merged).toBe(false);
    expect(pulled.map((e) => e.vehicleId)).toEqual([id]);
    expect(h.sys.stopVehicleId).toBe(id);
  });
});

describe('a bumped stop target', () => {
  it('still reaches the curb when bumped while pulling over', async () => {
    const h = await makeHarness(lineGraph());
    h.sys.densityScale = 0;
    const pulled = pulledLog(h);
    h.sys.spawnAt(EAST, 1000, { speed: 12, behavior: 0, desiredFactor: 1 });
    const id = h.sys.view.vehicleId[0] ?? 0;
    expect(h.sys.forceStop(id)).toBe(true);
    const follow = (): void => followCar(h, slotOf(h, id), 15, true);
    let t = runFor(h, 0, 1, follow);
    t = bump(h, slotOf(h, id), t, follow);
    runFor(h, t, 30, follow);
    expect(pulled.map((e) => e.vehicleId)).toEqual([id]);
    const slot = slotOf(h, id);
    expect(h.sys.view.state[slot]).not.toBe(TRAFFIC_STATE.crashed);
    expect(h.sys.inspect(slot, carInfo()).pull).toBe(PULL.stopped);
  });

  it('drives off when released after a bump at the curb', async () => {
    const h = await makeHarness(lineGraph());
    h.sys.densityScale = 0;
    h.sys.spawnAt(EAST, 1000, { speed: 12, behavior: 0, desiredFactor: 1 });
    const id = h.sys.view.vehicleId[0] ?? 0;
    expect(h.sys.forceStop(id)).toBe(true);
    const follow = (): void => followCar(h, slotOf(h, id), 15, true);
    let t = runFor(h, 0, 20, follow);
    expect(h.sys.inspect(slotOf(h, id), carInfo()).pull).toBe(PULL.stopped);
    t = bump(h, slotOf(h, id), t, follow);
    const x0 = h.sys.view.x[slotOf(h, id)] ?? 0;
    expect(h.sys.releaseStop()).toBe(true);
    h.focus.lights = false;
    runFor(h, t, 20);
    const slot = slotOf(h, id);
    expect((h.sys.view.x[slot] ?? 0) - x0).toBeGreaterThan(20);
    expect(h.sys.view.state[slot]).not.toBe(TRAFFIC_STATE.crashed);
  });
});

describe('inner-lane cars going to the curb', () => {
  it('two side-by-side cars yielding to a siren end at different curb spots', async () => {
    const h = await makeHarness(crossGraph(JUNCTION.none, { lanes: 2 }));
    h.sys.densityScale = 0;
    h.sys.spawnAt(laneRef(0, 0, 0), 400, { speed: 10, behavior: 0, desiredFactor: 1 });
    h.sys.spawnAt(laneRef(0, 0, 1), 401, { speed: 10, behavior: 0, desiredFactor: 1 });
    const ids = [h.sys.view.vehicleId[0] ?? 0, h.sys.view.vehicleId[1] ?? 0];
    let x = -640;
    let minD = Infinity;
    runFor(h, 0, 20, () => {
      const f = h.focus;
      x += 4 / 60;
      Object.assign(f, { obstacle: true, ox: x, oz: 5.25, ovx: 4, ovz: 0, x, z: 5.25, heading: -Math.PI / 2, lights: true, siren: true });
      const a = slotOf(h, ids[0] ?? 0), b = slotOf(h, ids[1] ?? 0);
      const v = h.sys.view;
      minD = Math.min(minD, Math.hypot((v.x[a] ?? 0) - (v.x[b] ?? 0), (v.z[a] ?? 0) - (v.z[b] ?? 0)));
    });
    expect(minD).toBeGreaterThan(3);
  });

  it('a stop target in the inner lane waits for the curb lane beside it to clear', async () => {
    const h = await makeHarness(crossGraph(JUNCTION.none, { lanes: 2 }));
    h.sys.densityScale = 0;
    const pulled = pulledLog(h);
    h.sys.spawnAt(laneRef(0, 0, 1), 300, { speed: 10, behavior: 0, desiredFactor: 1 });
    h.sys.spawnAt(laneRef(0, 0, 0), 290, { speed: 11, behavior: 0, desiredFactor: 1 });
    const target = h.sys.view.vehicleId[0] ?? 0;
    const other = h.sys.view.vehicleId[1] ?? 0;
    expect(h.sys.forceStop(target)).toBe(true);
    let minD = Infinity;
    runFor(h, 0, 30, () => {
      const a = slotOf(h, target), b = slotOf(h, other);
      const v = h.sys.view;
      // The player stays behind the target, out of the way.
      h.focus.x = (v.x[a] ?? 0) - 20;
      h.focus.z = v.z[a] ?? 0;
      if (b >= 0) minD = Math.min(minD, Math.hypot((v.x[a] ?? 0) - (v.x[b] ?? 0), (v.z[a] ?? 0) - (v.z[b] ?? 0)));
    });
    expect(minD).toBeGreaterThan(3);
    expect(pulled.map((e) => e.vehicleId)).toEqual([target]);
  });
});
