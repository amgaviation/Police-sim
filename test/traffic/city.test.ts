import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from '../../src/ecs/world';
import { TrafficCar } from '../../src/traffic/components';
import { DENSITY } from '../../src/traffic/data';
import type { TrafficCollisionEvent } from '../../src/traffic/events';
import { TRAFFIC_STATE, isTrafficSnapshot, type TrafficCarInfo, type TrafficSnapshot } from '../../src/traffic/trafficSystem';
import { LIGHT, VehicleLook } from '../../src/vehicles/components';
import type { City } from '../../src/world/city';
import { DISTRICT, laneDir, laneEdge, laneIndex } from '../../src/world/roadGraph';
import { generateCity } from '../../src/world/generate';
import { DT, NOON, makeHarness, type Harness } from './helpers';

const SEED = 99;
let city: City;

beforeAll(() => {
  city = generateCity(SEED);
});

function info(): TrafficCarInfo {
  return { lane: 0, s: 0, nextLane: 0, behavior: 0, desiredFactor: 0, headway: 0, lateral: 0, weaveAmp: 0, limitMph: 0, inJunction: false };
}

/** Suburbs (row 3, columns 2-9): a 2 km east-west path at z = -1792. */
const PATH_Z = -1792;
const PATH_X0 = -2400;

function moveAlongPath(h: Harness, step: number, speed: number): void {
  h.focus.x = PATH_X0 + Math.min(2000, step * DT * speed);
  h.focus.z = PATH_Z;
}

/** Runs `steps` fixed steps from `t0` with the focus on the suburb path; returns the end time. */
function run(h: Harness, t0: number, steps: number, firstStep = 0, each?: () => void): number {
  let t = t0;
  for (let i = 0; i < steps; i++) {
    moveAlongPath(h, firstStep + i, 15);
    t += DT;
    h.sys.step(DT, t, NOON, h.focus);
    h.physics.step();
    each?.();
  }
  return t;
}

interface Frame {
  count: number;
  vehicleId: number[];
  x: number[];
  z: number[];
  yaw: number[];
  speed: number[];
  state: number[];
}

function frame(h: Harness): Frame {
  const v = h.sys.view;
  const n = v.count;
  return {
    count: n,
    vehicleId: Array.from(v.vehicleId.subarray(0, n)),
    x: Array.from(v.x.subarray(0, n)),
    z: Array.from(v.z.subarray(0, n)),
    yaw: Array.from(v.yaw.subarray(0, n)),
    speed: Array.from(v.speed.subarray(0, n)),
    state: Array.from(v.state.subarray(0, n)),
  };
}

describe('density and streaming', () => {
  it('populates to the target around the focus, never within 25 m', async () => {
    const h = await makeHarness(city.graph, SEED, city);
    moveAlongPath(h, 0, 0);
    expect(city.districtAt(h.focus.x, h.focus.z)).toBe(DISTRICT.suburbs);
    h.sys.populate(h.focus, NOON);
    const target = Math.round(DENSITY.baseActive * 0.8 * 1.05);
    expect(h.sys.activeCount).toBe(target);
    for (let i = 0; i < h.sys.activeCount; i++) {
      const d = Math.hypot((h.sys.view.x[i] ?? 0) - h.focus.x, (h.sys.view.z[i] ?? 0) - h.focus.z);
      expect(d).toBeGreaterThan(25);
      expect(d).toBeLessThan(DENSITY.radii.spawnMax + 5);
      expect(TrafficCar.slot[h.sys.view.eid[i] ?? 0]).toBe(i);
      expect(h.sys.slotOfEntity(h.sys.view.eid[i] ?? 0)).toBe(i);
    }
    expect(h.sys.slotOfEntity(0)).toBe(-1);
    expect(h.sys.vehicleIdOfEntity(h.sys.view.eid[0] ?? 0)).toBe(h.sys.view.vehicleId[0]);
    // Registry ids on the road are unique.
    expect(new Set(frame(h).vehicleId).size).toBe(h.sys.activeCount);
  });

  it('holds the target within 15% around a focus moving 2 km, never against a one-way', async () => {
    const h = await makeHarness(city.graph, SEED, city);
    moveAlongPath(h, 0, 0);
    h.sys.populate(h.focus, NOON);
    const target = h.sys.activeCount;
    const car = info();
    const steps = Math.ceil(2000 / 15 / DT);
    let worstDeviation = 0;
    let wrongWay = 0;
    run(h, 0, steps, 0, () => {
      worstDeviation = Math.max(worstDeviation, Math.abs(h.sys.activeCount - target));
      for (let i = 0; i < h.sys.activeCount; i++) {
        const lane = h.sys.inspect(i, car).lane;
        if (city.graph.laneCount(laneEdge(lane), laneDir(lane)) <= laneIndex(lane)) wrongWay++;
      }
    });
    expect(worstDeviation).toBeLessThanOrEqual(target * 0.15);
    expect(wrongWay).toBe(0);
    expect(h.focus.x).toBe(PATH_X0 + 2000);
    expect(h.sys.stats.despawned).toBeGreaterThan(50);
    expect(h.sys.stats.spawned).toBe(h.sys.stats.despawned + h.sys.activeCount);
  }, 30000);

  it('despawns cars beyond the despawn radius', async () => {
    const h = await makeHarness(city.graph, SEED, city);
    const gone: number[] = [];
    h.bus.on('traffic:despawned', (e) => gone.push(e.vehicleId));
    moveAlongPath(h, 0, 0);
    h.sys.populate(h.focus, NOON);
    const before = frame(h).vehicleId;
    // Teleport 1.5 km east: every old car is now beyond 440 m.
    h.focus.x += 1500;
    h.sys.step(DT, DENSITY.tickS, NOON, h.focus);
    expect(gone.sort((a, b) => a - b)).toEqual([...before].sort((a, b) => a - b));
    for (let i = 0; i < h.sys.activeCount; i++) {
      const d = Math.hypot((h.sys.view.x[i] ?? 0) - h.focus.x, (h.sys.view.z[i] ?? 0) - h.focus.z);
      expect(d).toBeLessThan(DENSITY.radii.despawn);
    }
    expect(h.sys.activeCount).toBeLessThanOrEqual(DENSITY.spawnPerTick);
  });

  it('keeps cars on a lane apart after 3000 steps', async () => {
    const h = await makeHarness(city.graph, SEED, city);
    h.focus.x = 256;
    h.focus.z = -512; // downtown
    h.sys.populate(h.focus, NOON);
    let t = 0;
    for (let i = 0; i < 3000; i++) {
      t += DT;
      h.sys.step(DT, t, NOON, h.focus);
    }
    const car = info();
    const byLane = new Map<number, number[]>();
    for (let i = 0; i < h.sys.activeCount; i++) {
      h.sys.inspect(i, car);
      byLane.set(car.lane, [...(byLane.get(car.lane) ?? []), car.s]);
    }
    let minGap = Infinity;
    for (const list of byLane.values()) {
      list.sort((a, b) => a - b);
      for (let i = 1; i < list.length; i++) minGap = Math.min(minGap, (list[i] ?? 0) - (list[i - 1] ?? 0));
    }
    expect(h.sys.activeCount).toBeGreaterThan(150);
    expect(minGap).toBeGreaterThan(2);
  }, 30000);
});

describe('physics proxies', () => {
  let h: Harness;
  afterAll(() => h.physics.dispose());

  it('adds kinematic proxies near the focus and removes them when it leaves', async () => {
    h = await makeHarness(city.graph, SEED, city);
    h.focus.x = 256;
    h.focus.z = -512;
    h.sys.populate(h.focus, NOON);
    let t = 0;
    for (let i = 0; i < 120; i++) {
      t += DT;
      h.sys.step(DT, t, NOON, h.focus);
      h.physics.step();
    }
    const near = (r: number): number => {
      let n = 0;
      for (let i = 0; i < h.sys.activeCount; i++) {
        if (Math.hypot((h.sys.view.x[i] ?? 0) - h.focus.x, (h.sys.view.z[i] ?? 0) - h.focus.z) < r) n++;
      }
      return n;
    };
    expect(h.sys.stats.proxies).toBeGreaterThan(0);
    expect(h.physics.bodyCount).toBe(h.sys.stats.proxies);
    expect(h.sys.stats.proxies).toBeGreaterThanOrEqual(near(DENSITY.radii.proxy));
    expect(h.sys.stats.proxies).toBeLessThanOrEqual(near(DENSITY.radii.proxyRelease));
    // Proxy bodies track the cars (synced back by the physics step).
    for (let i = 0; i < h.sys.activeCount; i++) {
      const eid = h.sys.view.eid[i] ?? 0;
      const body = h.physics.getBody(eid);
      if (!body) continue;
      const p = body.translation();
      expect(Math.hypot(p.x - (h.sys.view.x[i] ?? 0), p.z - (h.sys.view.z[i] ?? 0))).toBeLessThan(0.01);
    }
    h.focus.x += 300;
    t += DT;
    h.sys.step(DT, t, NOON, h.focus);
    expect(h.sys.stats.proxies).toBe(near(DENSITY.radii.proxy));
    h.focus.x += 2000;
    t += DT;
    h.sys.step(DT, t, NOON, h.focus);
    expect(h.sys.stats.proxies).toBe(0);
    expect(h.physics.bodyCount).toBe(0);
  });

  it('marks a car crashed when a dynamic body hits its proxy, and emits once', async () => {
    const hh = await makeHarness(city.graph, SEED, city);
    hh.physics.addGround(4000);
    hh.focus.x = 256;
    hh.focus.z = -512;
    hh.sys.populate(hh.focus, NOON);
    let t = 0;
    for (let i = 0; i < 30; i++) {
      t += DT;
      hh.sys.step(DT, t, NOON, hh.focus);
      hh.physics.step();
    }
    // Put the focus on a moving car so it gets a proxy, then drop a dynamic box onto it.
    let slot = -1;
    for (let i = 0; i < hh.sys.activeCount && slot < 0; i++) if ((hh.sys.view.speed[i] ?? 0) > 3) slot = i;
    expect(slot).toBeGreaterThanOrEqual(0);
    const target = hh.sys.view.eid[slot] ?? 0;
    hh.focus.x = hh.sys.view.x[slot] ?? 0;
    hh.focus.z = hh.sys.view.z[slot] ?? 0;
    t += DT;
    hh.sys.step(DT, t, NOON, hh.focus);
    hh.physics.step();
    expect(hh.physics.has(target)).toBe(true);
    const events: TrafficCollisionEvent[] = [];
    hh.bus.on('traffic:collision', (e) => events.push(e));
    const box = spawn(hh.world);
    const slotNow = hh.sys.slotOfEntity(target);
    hh.physics.addBox(box, { x: hh.sys.view.x[slotNow] ?? 0, y: 1.2, z: hh.sys.view.z[slotNow] ?? 0 }, { x: 0.8, y: 0.5, z: 0.8 }, { mass: 1500 });
    for (let i = 0; i < 30; i++) {
      t += DT;
      hh.sys.step(DT, t, NOON, hh.focus);
      hh.physics.step();
    }
    const s = hh.sys.slotOfEntity(target);
    expect(events).toHaveLength(1);
    expect(events[0]?.eid).toBe(target);
    expect(events[0]?.other).toBe(box);
    expect(events[0]?.vehicleId).toBe(hh.sys.view.vehicleId[s]);
    expect(hh.sys.view.state[s]).toBe(TRAFFIC_STATE.crashed);
    expect(hh.sys.view.speed[s]).toBe(0);
    expect((VehicleLook.lights[target] ?? 0) & LIGHT.hazard).toBe(LIGHT.hazard);
    hh.physics.dispose();
  });
});

describe('determinism', () => {
  async function session(steps: number): Promise<{ h: Harness; t: number }> {
    const h = await makeHarness(city.graph, SEED, city);
    moveAlongPath(h, 0, 0);
    h.sys.populate(h.focus, NOON);
    const t = run(h, 0, steps);
    return { h, t };
  }

  it('two systems with the same seed and focus path match after 3000 steps', async () => {
    const a = await session(3000);
    const fa = frame(a.h);
    a.h.sys.dispose();
    a.h.physics.dispose();
    const b = await session(3000);
    expect(frame(b.h)).toEqual(fa);
    expect(fa.count).toBeGreaterThan(50);
    b.h.sys.dispose();
    b.h.physics.dispose();
  }, 30000);

  it('snapshot/restore continues identically for 600 steps', async () => {
    const a = await session(600);
    const snap: TrafficSnapshot = JSON.parse(JSON.stringify(a.h.sys.snapshot())) as TrafficSnapshot;
    expect(isTrafficSnapshot(snap)).toBe(true);
    expect(isTrafficSnapshot({ ...snap, version: 2 })).toBe(false);
    expect(isTrafficSnapshot({ ...snap, rng: { seed: 1, s: [1, 2, 3] } })).toBe(false);
    expect(isTrafficSnapshot({ ...snap, cars: [{ ...snap.cars[0], s: 'x' }] })).toBe(false);
    expect(isTrafficSnapshot(null)).toBe(false);
    const frames: Frame[] = [];
    run(a.h, a.t, 600, 600, () => frames.push(frame(a.h)));
    a.h.sys.dispose();
    a.h.physics.dispose();

    const b = await makeHarness(city.graph, SEED, city);
    b.sys.restore(snap);
    expect(b.sys.activeCount).toBe(snap.cars.length);
    let k = 0;
    run(b, a.t, 600, 600, () => {
      expect(frame(b)).toEqual(frames[k]);
      k++;
    });
    b.sys.dispose();
    b.physics.dispose();
  }, 30000);
});

describe('performance', () => {
  it('steps 160+ cars in well under 3 ms on average', async () => {
    const h = await makeHarness(city.graph, SEED, city);
    h.focus.x = 256;
    h.focus.z = -512;
    const rush = { hour: 8, isWeekday: true };
    h.sys.populate(h.focus, rush);
    expect(h.sys.activeCount).toBeGreaterThanOrEqual(160);
    let t = 0;
    for (let i = 0; i < 300; i++) {
      t += DT;
      h.sys.step(DT, t, rush, h.focus);
      h.physics.step();
    }
    const steps = 1200;
    let total = 0;
    for (let i = 0; i < steps; i++) {
      t += DT;
      const start = performance.now();
      h.sys.step(DT, t, rush, h.focus);
      total += performance.now() - start;
      h.physics.step();
    }
    expect(h.sys.activeCount).toBeGreaterThanOrEqual(160);
    expect(total / steps).toBeLessThan(3);
    h.physics.dispose();
  }, 30000);
});
