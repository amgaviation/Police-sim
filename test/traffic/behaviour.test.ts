import { describe, expect, it } from 'vitest';
import { IDM_S0 } from '../../src/traffic/idm';
import { VehicleLook } from '../../src/vehicles/components';
import { VEHICLE_MODELS } from '../../src/vehicles/model';
import { BEHAVIOR, TRAFFIC_STATE, type TrafficCarInfo } from '../../src/traffic/trafficSystem';
import { MPH } from '../../src/world/constants';
import { JUNCTION, laneRef } from '../../src/world/roadGraph';
import { DT, NOON, crossGraph, lineGraph, makeHarness, type Harness } from './helpers';

const HALF_LEN_MAX = 7;

function info(): TrafficCarInfo {
  return { lane: 0, s: 0, nextLane: 0, behavior: 0, desiredFactor: 0, headway: 0, lateral: 0, weaveAmp: 0, limitMph: 0, inJunction: false };
}

/** Steps `seconds` from `t0` with the focus on slot 0 (no auto spawning); returns the end time. */
function run(h: Harness, t0: number, seconds: number, each?: (t: number) => void): number {
  let t = t0;
  for (let i = 0; i < Math.round(seconds / DT); i++) {
    if (h.sys.activeCount > 0) {
      h.focus.x = h.sys.view.x[0] ?? 0;
      h.focus.z = h.sys.view.z[0] ?? 0;
    }
    t += DT;
    h.sys.step(DT, t, NOON, h.focus);
    h.physics.step();
    each?.(t);
  }
  return t;
}

async function harness(junction: (typeof JUNCTION)[keyof typeof JUNCTION]): Promise<Harness> {
  const h = await makeHarness(crossGraph(junction));
  h.sys.densityScale = 0;
  return h;
}

describe('signals', () => {
  const lane = laneRef(0, 0, 0); // west arm, travelling east (group 0)
  const stopLine = 1000 - 8;

  it('stops at a red stop line and goes on green', async () => {
    const h = await harness(JUNCTION.signal);
    const slot = h.sys.spawnAt(lane, 800, { speed: 11, behavior: 0, desiredFactor: 1 });
    expect(slot).toBe(0);
    const car = info();
    // Red for group 0 from t = 24 to 51.
    const t = run(h, 25, 25, () => {
      h.sys.inspect(0, car);
      expect(car.lane).toBe(lane);
      expect(car.s).toBeLessThanOrEqual(stopLine);
    });
    h.sys.inspect(0, car);
    expect(stopLine - car.s).toBeLessThan(HALF_LEN_MAX + 2);
    expect(h.sys.view.speed[0]).toBeLessThan(0.05);
    expect(h.sys.view.state[0]).toBe(TRAFFIC_STATE.waiting);
    run(h, t, 12);
    h.sys.inspect(0, car);
    expect(car.lane !== lane || car.s > stopLine).toBe(true);
    expect(h.violations.filter((v) => v.kind === 'redLight')).toHaveLength(0);
  });

  it('a red-light runner crosses on a fresh red and reports it once', async () => {
    const h = await harness(JUNCTION.signal);
    // Yellow at t = 22; at 11 m/s the car reaches the line about 2.5 s later, just after red.
    h.sys.spawnAt(lane, stopLine - 3 - 27.5, { speed: 11, behavior: BEHAVIOR.redLight, desiredFactor: 1 });
    run(h, 22, 10);
    const car = h.sys.inspect(0, info());
    expect(car.lane).not.toBe(lane);
    const red = h.violations.filter((v) => v.kind === 'redLight');
    expect(red).toHaveLength(1);
    expect(red[0]?.vehicleId).toBe(h.sys.view.vehicleId[0]);
  });

  it('a law-abiding driver stops for the same yellow', async () => {
    const h = await harness(JUNCTION.signal);
    h.sys.spawnAt(lane, stopLine - 3 - 27.5, { speed: 11, behavior: 0, desiredFactor: 1 });
    run(h, 22, 10);
    const car = h.sys.inspect(0, info());
    expect(car.lane).toBe(lane);
    expect(car.s).toBeLessThanOrEqual(stopLine);
    expect(h.violations).toHaveLength(0);
  });
});

describe('stop signs', () => {
  it('makes a full stop of at least 1 s at an all-way stop, one car in the junction at a time', async () => {
    const h = await harness(JUNCTION.allWayStop);
    const west = laneRef(0, 0, 0);
    const north = laneRef(2, 0, 0);
    h.sys.spawnAt(west, 900, { speed: 8, behavior: 0, desiredFactor: 1 });
    h.sys.spawnAt(north, 900, { speed: 8, behavior: 0, desiredFactor: 1 });
    const car = info();
    let stoppedS = 0;
    let crossed = false;
    let bothInJunction = false;
    run(h, 0, 40, () => {
      let inside = 0;
      for (let i = 0; i < h.sys.activeCount; i++) {
        h.sys.inspect(i, car);
        if (car.inJunction) inside++;
        if (i === 0 && car.lane === west) {
          if ((h.sys.view.speed[0] ?? 1) < 0.1 && car.s > 950) stoppedS += DT;
        }
        if (i === 0 && car.lane !== west) crossed = true;
      }
      if (inside > 1) bothInJunction = true;
    });
    expect(crossed).toBe(true);
    expect(stoppedS).toBeGreaterThanOrEqual(1 - 1e-9);
    expect(bothInJunction).toBe(false);
    for (let i = 0; i < 2; i++) expect([west, north]).not.toContain(h.sys.inspect(i, car).lane);
  });

  it('a rolling stopper slows but does not stop, and is reported', async () => {
    const h = await harness(JUNCTION.allWayStop);
    const west = laneRef(0, 0, 0);
    h.sys.spawnAt(west, 900, { speed: 8, behavior: BEHAVIOR.rollingStop, desiredFactor: 1 });
    let minSpeed = Infinity;
    const car = info();
    run(h, 0, 20, () => {
      h.sys.inspect(0, car);
      if (car.lane === west && car.s > 960) minSpeed = Math.min(minSpeed, h.sys.view.speed[0] ?? 0);
    });
    expect(minSpeed).toBeGreaterThan(0.1);
    expect(minSpeed).toBeLessThan(4);
    expect(h.violations.filter((v) => v.kind === 'rollingStop')).toHaveLength(1);
  });
});

describe('behaviours on a straight road', () => {
  const lane = laneRef(0, 0, 0);

  it('a speeding car settles at limit x speedFactor and is reported once', async () => {
    const h = await makeHarness(lineGraph());
    h.sys.densityScale = 0;
    h.sys.spawnAt(lane, 100, { speed: 10, behavior: BEHAVIOR.speeding, desiredFactor: 1.3 });
    run(h, 0, 60);
    const mph = (h.sys.view.speed[0] ?? 0) / MPH;
    expect(mph).toBeGreaterThan(40 * 1.3 * 0.97);
    expect(mph).toBeLessThanOrEqual(40 * 1.3 + 1e-6);
    expect(h.violations.filter((v) => v.kind === 'speeding')).toHaveLength(1);
    expect(h.violations[0]?.limitMph).toBe(40);
  });

  it('a normal driver keeps to about the limit', async () => {
    const h = await makeHarness(lineGraph());
    h.sys.densityScale = 0;
    h.sys.spawnAt(lane, 100, { speed: 10, behavior: 0 });
    run(h, 0, 60);
    const car = h.sys.inspect(0, info());
    expect((h.sys.view.speed[0] ?? 0) / MPH).toBeLessThanOrEqual(40 * car.desiredFactor + 1e-6);
    expect(car.desiredFactor).toBeLessThan(1.1);
    expect(h.violations).toHaveLength(0);
  });

  it('a DUI driver weaves within its amplitude', async () => {
    const h = await makeHarness(lineGraph());
    h.sys.densityScale = 0;
    h.sys.spawnAt(lane, 100, { speed: 10, behavior: BEHAVIOR.dui, weaveAmp: 0.9, weavePeriod: 5 });
    const car = info();
    const lp = { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 };
    const graph = lineGraph();
    let maxOffset = 0;
    run(h, 0, 30, () => {
      h.sys.inspect(0, car);
      graph.lanePoint(car.lane, car.s, lp);
      const off = Math.hypot((h.sys.view.x[0] ?? 0) - lp.x, (h.sys.view.z[0] ?? 0) - lp.z);
      expect(off).toBeLessThanOrEqual(0.9 + 1e-3);
      maxOffset = Math.max(maxOffset, off);
    });
    expect(maxOffset).toBeGreaterThan(0.8);
    expect(h.violations.filter((v) => v.kind === 'weaving')).toHaveLength(1);
  });

  it('stops behind the player obstacle in its lane, keeping at least the jam gap', async () => {
    const h = await makeHarness(lineGraph());
    h.sys.densityScale = 0;
    h.sys.spawnAt(lane, 100, { speed: 15, behavior: 0, desiredFactor: 1 });
    const lp = lineGraph().lanePoint(lane, 400, { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 });
    Object.assign(h.focus, { x: lp.x, z: lp.z, obstacle: true, ox: lp.x, oz: lp.z, oRadius: 1 });
    let t = 0;
    for (let i = 0; i < 60 * 60; i++) {
      t += DT;
      h.sys.step(DT, t, NOON, h.focus);
    }
    const car = h.sys.inspect(0, info());
    const model = VEHICLE_MODELS[VehicleLook.model[h.sys.view.eid[0] ?? 0] ?? 0];
    const bumperGap = 400 - car.s - 1 - (model?.body.length ?? 0) / 2;
    expect(h.sys.view.speed[0]).toBeLessThan(0.05);
    expect(bumperGap).toBeGreaterThanOrEqual(IDM_S0 - 0.05);
    expect(bumperGap).toBeLessThan(IDM_S0 + 1);
  });
});
