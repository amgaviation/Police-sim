import { describe, expect, it } from 'vitest';
import { PULLOVER } from '../../src/traffic/data';
import type { TrafficPulledOverEvent, TrafficReleasedEvent } from '../../src/traffic/events';
import { PULL, TRAFFIC_STATE, type StopState } from '../../src/traffic/trafficSystem';
import { LIGHT, VehicleLook } from '../../src/vehicles/components';
import { VEHICLE_MODELS } from '../../src/vehicles/model';
import { JUNCTION, laneEdge, laneRef } from '../../src/world/roadGraph';
import { carInfo, crossGraph, followCar, lineGraph, makeHarness, runFor, slotOf, type Harness } from './helpers';

const EAST = laneRef(0, 0, 0); // lineGraph: travel +x at z = +1.75

interface Log {
  pulling: number[];
  pulled: TrafficPulledOverEvent[];
  released: TrafficReleasedEvent[];
  pullingAt: number[];
}

async function lineHarness(): Promise<{ h: Harness; log: Log }> {
  const h = await makeHarness(lineGraph());
  h.sys.densityScale = 0;
  const log: Log = { pulling: [], pulled: [], released: [], pullingAt: [] };
  let now = 0;
  h.bus.on('traffic:pullingOver', (e) => {
    log.pulling.push(e.vehicleId);
    log.pullingAt.push(now);
  });
  h.bus.on('traffic:pulledOver', (e) => log.pulled.push(e));
  h.bus.on('traffic:released', (e) => log.released.push(e));
  // Track the time of each step for pullingAt.
  const step = h.sys.step.bind(h.sys);
  h.sys.step = (dt, t, time, focus) => {
    now = t;
    step(dt, t, time, focus);
  };
  return { h, log };
}

function curbTarget(slot: number, h: Harness, laneIndex = 0): number {
  const model = VEHICLE_MODELS[h.sys.view.model[slot] ?? 0];
  return (laneIndex + 0.5) * 3.5 + (model?.body.width ?? 0) / 2 + PULLOVER.curb.clearance;
}

/** Spawns a car on the line road and pulls it over with the player 15 m behind; returns its id and the time. */
function pullOver(h: Harness, s = 1000, speed = 15): { id: number; t: number } {
  h.sys.spawnAt(EAST, s, { speed, behavior: 0, desiredFactor: 1 });
  const id = h.sys.view.vehicleId[0] ?? 0;
  const t = runFor(h, 0, 15, () => followCar(h, slotOf(h, id), 15, true));
  return { id, t };
}

describe('traffic stops', () => {
  it('computes the curb target per lane index', async () => {
    const h = await makeHarness(crossGraph(JUNCTION.none, { lanes: 2 }));
    h.sys.densityScale = 0;
    const a = h.sys.spawnAt(laneRef(0, 0, 0), 300, { speed: 10, behavior: 0, desiredFactor: 1 });
    const b = h.sys.spawnAt(laneRef(0, 0, 1), 400, { speed: 10, behavior: 0, desiredFactor: 1 });
    const ida = h.sys.view.vehicleId[a] ?? 0, idb = h.sys.view.vehicleId[b] ?? 0;
    // The focus stays by the cars (a stop is lost beyond autoReleaseM).
    const near = (id: number) => (): void => {
      h.focus.x = h.sys.view.x[slotOf(h, id)] ?? 0;
      h.focus.z = h.sys.view.z[slotOf(h, id)] ?? 0;
    };
    expect(h.sys.forceStop(ida)).toBe(true);
    runFor(h, 0, 15, near(ida));
    expect(h.sys.releaseStop()).toBe(true);
    expect(h.sys.forceStop(idb)).toBe(true);
    runFor(h, 15, 15, near(idb));
    const sa = slotOf(h, ida), sb = slotOf(h, idb);
    expect(h.sys.inspect(sa, carInfo()).shoulder).toBeLessThan(curbTarget(sa, h, 0));
    expect(h.sys.inspect(sb, carInfo()).shoulder).toBeCloseTo(curbTarget(sb, h, 1), 9);
    expect(curbTarget(sb, h, 1) - curbTarget(sb, h, 0)).toBeCloseTo(3.5, 9);
  });

  it('pulls the car ahead over after delayS with the light bar on: events, curb offset, stopped, hazards, parked', async () => {
    const { h, log } = await lineHarness();
    const { id } = pullOver(h);
    expect(log.pulling).toEqual([id]);
    expect(log.pullingAt[0]).toBeGreaterThanOrEqual(PULLOVER.detect.delayS);
    expect(log.pullingAt[0]).toBeLessThan(PULLOVER.detect.delayS + 0.1);
    expect(log.pulled).toHaveLength(1);
    expect(log.pulled[0]?.vehicleId).toBe(id);
    const slot = slotOf(h, id);
    const info = h.sys.inspect(slot, carInfo());
    expect(info.pull).toBe(PULL.stopped);
    expect(info.shoulder).toBeCloseTo(curbTarget(slot, h), 9);
    expect(h.sys.view.speed[slot]).toBe(0);
    expect(h.sys.view.state[slot]).toBe(TRAFFIC_STATE.parked);
    expect((VehicleLook.lights[h.sys.view.eid[slot] ?? 0] ?? 0) & LIGHT.hazard).toBe(LIGHT.hazard);
    // The car body is right of the lane centre (z = 1.75 on this road) by the curb offset.
    expect(h.sys.view.z[slot]).toBeCloseTo(1.75 + curbTarget(slot, h), 4);
    expect(log.pulled[0]?.x).toBeCloseTo(h.sys.view.x[slot] ?? 0, 4);
    expect(log.pulled[0]?.z).toBeCloseTo(h.sys.view.z[slot] ?? 0, 4);
    expect(h.sys.stopVehicleId).toBe(id);
    const st: StopState = { vehicleId: 0, eid: 0, phase: 'pulling', x: 0, z: 0, yaw: 0 };
    expect(h.sys.stopState(st)?.phase).toBe('stopped');
    expect(st.eid).toBe(h.sys.view.eid[slot]);
  });

  it('does nothing without the light bar, and nothing before delayS', async () => {
    const { h, log } = await lineHarness();
    h.sys.spawnAt(EAST, 1000, { speed: 15, behavior: 0, desiredFactor: 1 });
    const id = h.sys.view.vehicleId[0] ?? 0;
    let t = runFor(h, 0, 6, () => followCar(h, slotOf(h, id), 15, false));
    expect(log.pulling).toHaveLength(0);
    t = runFor(h, t, PULLOVER.detect.delayS - 0.1, () => followCar(h, slotOf(h, id), 15, true));
    expect(log.pulling).toHaveLength(0);
    expect(h.sys.stopVehicleId).toBe(-1);
    runFor(h, t, 0.2, () => followCar(h, slotOf(h, id), 15, true));
    expect(log.pulling).toEqual([id]);
  });

  it('a candidate switch restarts the delay', async () => {
    const { h, log } = await lineHarness();
    h.sys.spawnAt(EAST, 1000, { speed: 12, behavior: 0, desiredFactor: 1 });
    h.sys.spawnAt(EAST, 1100, { speed: 12, behavior: 0, desiredFactor: 1 });
    const a = h.sys.view.vehicleId[0] ?? 0, b = h.sys.view.vehicleId[1] ?? 0;
    let t = runFor(h, 0, 1.0, () => followCar(h, slotOf(h, a), 10, true));
    expect(log.pulling).toHaveLength(0);
    t = runFor(h, t, 1.0, () => followCar(h, slotOf(h, b), 10, true));
    expect(log.pulling).toHaveLength(0);
    runFor(h, t, 0.6, () => followCar(h, slotOf(h, b), 10, true));
    expect(log.pulling).toEqual([b]);
    expect(log.pullingAt[0]).toBeGreaterThanOrEqual(1.0 + PULLOVER.detect.delayS);
  });

  it('defers the pull near a stop line and pulls over on the next lane', async () => {
    const h = await makeHarness(crossGraph(JUNCTION.none));
    h.sys.densityScale = 0;
    const lane = laneRef(0, 0, 0);
    h.sys.spawnAt(lane, 1000 - 8 - 22, { speed: 10, behavior: 0, desiredFactor: 1 });
    const id = h.sys.view.vehicleId[0] ?? 0;
    expect(h.sys.forceStop(id)).toBe(true);
    let maxShoulderBefore = 0;
    runFor(h, 0, 20, () => {
      const info = h.sys.inspect(0, carInfo());
      if (info.lane === lane) maxShoulderBefore = Math.max(maxShoulderBefore, info.shoulder ?? 0);
    });
    const info = h.sys.inspect(0, carInfo());
    expect(laneEdge(info.lane)).not.toBe(0);
    expect(info.pull).toBe(PULL.stopped);
    expect(maxShoulderBefore).toBe(0);
    expect(h.sys.view.speed[0]).toBe(0);
  });

  it('a following car passes the stopped car', async () => {
    const { h } = await lineHarness();
    const { id, t } = pullOver(h);
    const stopped = slotOf(h, id);
    const sStop = h.sys.inspect(stopped, carInfo()).s;
    h.sys.spawnAt(EAST, sStop - 120, { speed: 15, behavior: 0, desiredFactor: 1 });
    const follower = h.sys.view.vehicleId[h.sys.view.count - 1] ?? 0;
    let minSpeed = Infinity;
    let tt = 0;
    // The player stays behind the stopped car, off the lane (on the shoulder too).
    h.focus.obstacle = false;
    runFor(h, t, 15, () => {
      // The view speed is written by a step: skip the spawn step.
      if (tt++ > 0) minSpeed = Math.min(minSpeed, h.sys.view.speed[slotOf(h, follower)] ?? 0);
    });
    expect(h.sys.inspect(slotOf(h, follower), carInfo()).s).toBeGreaterThan(sStop + 50);
    expect(minSpeed).toBeGreaterThan(12);
    expect(h.sys.view.speed[slotOf(h, id)]).toBe(0);
  });

  it('releaseStop merges the car back into traffic and emits released', async () => {
    const { h, log } = await lineHarness();
    const { id, t } = pullOver(h);
    expect(h.sys.releaseStop()).toBe(true);
    expect(h.sys.releaseStop()).toBe(false);
    expect(h.sys.stopVehicleId).toBe(-1);
    expect(log.released).toEqual([{ eid: h.sys.view.eid[slotOf(h, id)], vehicleId: id, reason: 'released' }]);
    h.focus.lights = false;
    runFor(h, t, 15);
    const slot = slotOf(h, id);
    const info = h.sys.inspect(slot, carInfo());
    expect(info.pull).toBe(PULL.none);
    expect(info.shoulder).toBe(0);
    expect(h.sys.view.speed[slot]).toBeGreaterThan(5);
    expect((VehicleLook.lights[h.sys.view.eid[slot] ?? 0] ?? 0) & LIGHT.hazard).toBe(0);
  });

  it('abandonStop leaves the car parked with hazards, and it despawns by distance', async () => {
    const { h, log } = await lineHarness();
    const { id, t } = pullOver(h);
    expect(h.sys.abandonStop()).toBe(true);
    expect(log.released.map((e) => e.reason)).toEqual(['abandoned']);
    h.focus.lights = false;
    const t2 = runFor(h, t, 10);
    const slot = slotOf(h, id);
    expect(h.sys.view.state[slot]).toBe(TRAFFIC_STATE.parked);
    expect(h.sys.view.speed[slot]).toBe(0);
    expect(h.sys.inspect(slot, carInfo()).pull).toBe(PULL.parked);
    expect((VehicleLook.lights[h.sys.view.eid[slot] ?? 0] ?? 0) & LIGHT.hazard).toBe(LIGHT.hazard);
    h.focus.x += 1000;
    runFor(h, t2, 1);
    expect(slotOf(h, id)).toBe(-1);
  });

  it("releases with 'lost' when the focus is beyond autoReleaseM; the pinned target survives that step's despawn tick", async () => {
    const { h, log } = await lineHarness();
    const { id, t } = pullOver(h);
    h.focus.lights = false;
    h.focus.obstacle = false;
    // Jump 1 km away on a step that runs the density tick (despawn before stop upkeep).
    let tt = t;
    while (Math.floor((tt + 1 / 60) / 0.5) === Math.floor(tt / 0.5)) tt = runFor(h, tt, 1 / 60);
    h.focus.x += 1000;
    tt = runFor(h, tt, 1 / 60);
    expect(slotOf(h, id)).toBeGreaterThanOrEqual(0);
    expect(log.released.map((e) => e.reason)).toEqual(['lost']);
    expect(h.sys.stopVehicleId).toBe(-1);
    runFor(h, tt, 1);
    expect(slotOf(h, id)).toBe(-1);
  });

  it("'lost' merges the car back when the player drives off", async () => {
    const { h, log } = await lineHarness();
    const { id, t } = pullOver(h);
    h.focus.lights = false;
    h.focus.obstacle = false;
    h.focus.x -= PULLOVER.release.autoReleaseM;
    runFor(h, t, 0.1);
    expect(log.released.map((e) => e.reason)).toEqual(['lost']);
    expect(h.sys.inspect(slotOf(h, id), carInfo()).pull).toBe(PULL.merging);
  });

  it('keeps one stop target at a time and never stops fleet cars', async () => {
    const { h, log } = await lineHarness();
    const { id, t } = pullOver(h);
    h.sys.spawnAt(EAST, h.sys.inspect(slotOf(h, id), carInfo()).s + 30, { speed: 5, behavior: 0, desiredFactor: 0.3 });
    const other = h.sys.view.vehicleId[h.sys.view.count - 1] ?? 0;
    expect(h.sys.forceStop(other)).toBe(false);
    runFor(h, t, 3, () => followCar(h, slotOf(h, other), 15, true));
    expect(h.sys.stopVehicleId).toBe(id);
    expect(log.pulling).toEqual([id]);
    const eid = h.sys.spawnFleetCar(0, 600, 0, { modelIndex: 0, color: 0x112233 });
    expect(h.sys.forceStop(h.sys.vehicleIdOfEntity(eid))).toBe(false);
  });
});
