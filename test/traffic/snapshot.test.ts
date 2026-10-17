import { describe, expect, it } from 'vitest';
import { PULL, isTrafficSnapshot, type FleetState, type TrafficSnapshot } from '../../src/traffic/trafficSystem';
import { vehicleModel } from '../../src/vehicles/model';
import { laneRef } from '../../src/world/roadGraph';
import { DT, NOON, followCar, gridGraph, makeHarness, slotOf, type Harness } from './helpers';

const GRAPH = gridGraph();
const SEED = 11;
const POLICE = vehicleModel('patrol_sedan').index;

function json<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** The player follows car `stopId` 15 m behind with the light bar on (falls back to a fixed point). */
function moveFocus(h: Harness, stopId: number): void {
  const slot = slotOf(h, stopId);
  if (slot >= 0) followCar(h, slot, 15, true);
}

function steps(h: Harness, t0: number, n: number, stopId: number): number {
  let t = t0;
  for (let i = 0; i < n; i++) {
    moveFocus(h, stopId);
    t += DT;
    h.sys.step(DT, t, NOON, h.focus);
    h.physics.step();
  }
  return t;
}

/**
 * Grid scenario: car A on row 0 with the player behind it (light bar: a stop), cars B and C on the next block
 * with a code-3 unit behind them (they yield), a code-2 unit routed across the grid and a patrolling unit.
 */
async function scenario(): Promise<{ h: Harness; stopId: number }> {
  const h = await makeHarness(GRAPH, SEED);
  h.sys.densityScale = 0;
  h.sys.spawnAt(laneRef(0, 0, 0), 60, { speed: 8 });
  const stopId = h.sys.view.vehicleId[0] ?? 0;
  h.sys.spawnAt(laneRef(1, 0, 0), 50, { speed: 6, desiredFactor: 0.5 });
  h.sys.spawnAt(laneRef(1, 0, 0), 90, { speed: 6, desiredFactor: 0.5 });
  h.sys.spawnAt(laneRef(9, 0, 0), 60, { speed: 6 });
  h.sys.spawnAt(laneRef(4, 1, 0), 60, { speed: 6 });
  expect(h.sys.spawnFleetCar(0, 215, 0, { modelIndex: POLICE, color: 0xeeeeee })).toBeGreaterThan(0);
  expect(h.sys.spawnFleetCar(3, 300, 395, { modelIndex: POLICE, color: 0x222222 })).toBeGreaterThan(0);
  expect(h.sys.spawnFleetCar(5, 0, 300, { modelIndex: POLICE, color: 0x123456 })).toBeGreaterThan(0);
  expect(h.sys.setFleetDestination(0, 400, 330, 'emergency')).toBe(true);
  expect(h.sys.setFleetDestination(3, 5, 100, 'respond')).toBe(true);
  return { h, stopId };
}

function fleet(): FleetState {
  return { eid: 0, x: 0, z: 0, yaw: 0, speed: 0, edge: 0, mode: 'patrol', arrived: false, parked: false, routeLeftM: -1 };
}

/** Restores `snap` into a fresh system and checks that both continue identically for `n` steps. */
async function continueBoth(a: Harness, snap: TrafficSnapshot, t: number, n: number, stopId: number): Promise<void> {
  const copy = json(snap);
  expect(isTrafficSnapshot(copy)).toBe(true);
  const b = await makeHarness(GRAPH, SEED);
  b.sys.densityScale = 0;
  b.sys.restore(copy);
  expect(json(b.sys.snapshot())).toEqual(copy);
  for (let k = 0; k < n; k += 60) {
    steps(a, t + k * DT, 60, stopId);
    steps(b, t + k * DT, 60, stopId);
    expect(json(b.sys.snapshot())).toEqual(json(a.sys.snapshot()));
  }
  const fa = fleet(), fb = fleet();
  for (const i of [0, 3, 5]) {
    a.sys.fleetState(i, fa);
    b.sys.fleetState(i, fb);
    expect({ ...fb, eid: 0 }).toEqual({ ...fa, eid: 0 });
  }
  b.physics.dispose();
}

describe('snapshot with stops, yielding and fleet cars', () => {
  it('a pending stop candidate restores with its timer', async () => {
    const { h, stopId } = await scenario();
    const t = steps(h, 0, 60, stopId);
    const snap = h.sys.snapshot();
    expect(snap.stopCandidate).toBe(stopId);
    expect(snap.stopTimer).toBeGreaterThan(0.9);
    expect(snap.stopVehicleId).toBeUndefined();
    await continueBoth(h, snap, t, 600, stopId);
    expect(h.sys.stopVehicleId).toBe(stopId);
    h.physics.dispose();
  });

  it('continues exactly after a JSON round trip with a stop target, yielding cars and routed units', async () => {
    const { h, stopId } = await scenario();
    const t = steps(h, 0, 240, stopId);
    const snap = h.sys.snapshot();
    expect(snap.stopVehicleId).toBe(stopId);
    const target = snap.cars.find((c) => c.vehicleId === stopId);
    expect(target?.pull).toBe(PULL.pulling);
    expect(target?.pinned).toBe(1);
    expect(snap.cars.filter((c) => c.pull === PULL.yielding).length).toBeGreaterThanOrEqual(1);
    const units = snap.cars.filter((c) => c.fleet !== undefined);
    expect(units.map((c) => c.fleet).sort()).toEqual([0, 3, 5]);
    expect(units.find((c) => c.fleet === 0)?.urgency).toBe(2);
    expect(units.find((c) => c.fleet === 0)?.route?.length).toBeGreaterThan(1);
    expect(units.find((c) => c.fleet === 5)?.route).toBeUndefined();
    expect(units.find((c) => c.fleet === 3)?.color).toBe(0x222222);
    await continueBoth(h, snap, t, 1800, stopId);
    h.physics.dispose();
  });

  it('two identical runs produce identical snapshots', async () => {
    const a = await scenario();
    const b = await scenario();
    steps(a.h, 0, 2400, a.stopId);
    steps(b.h, 0, 2400, b.stopId);
    expect(json(b.h.sys.snapshot())).toEqual(json(a.h.sys.snapshot()));
    a.h.physics.dispose();
    b.h.physics.dispose();
  });

  it('validates the optional fields and still accepts Phase 1 snapshots', async () => {
    const { h, stopId } = await scenario();
    steps(h, 0, 240, stopId);
    const snap = json(h.sys.snapshot());
    const unit = snap.cars.findIndex((c) => c.fleet === 0);
    const bad = (patch: Record<string, unknown>, car = unit): boolean => {
      const s = json(snap) as unknown as { cars: Record<string, unknown>[] } & Record<string, unknown>;
      if (car >= 0) Object.assign(s.cars[car] ?? {}, patch);
      else Object.assign(s, patch);
      return isTrafficSnapshot(s);
    };
    expect(bad({})).toBe(true);
    expect(bad({ route: [-1] })).toBe(false);
    expect(bad({ route: [1.5] })).toBe(false);
    expect(bad({ route: 'x' })).toBe(false);
    expect(bad({ pull: 'x' })).toBe(false);
    expect(bad({ shoulder: null })).toBe(false);
    expect(bad({ urgency: '2' })).toBe(false);
    expect(bad({ stopVehicleId: 'a' }, -1)).toBe(false);
    expect(bad({ stopTimer: null }, -1)).toBe(false);
    // Phase 1 shape: no optional fields at all (ambient cars only).
    const p1 = json(snap);
    delete p1.stopVehicleId;
    delete p1.stopCandidate;
    delete p1.stopTimer;
    p1.cars = p1.cars
      .filter((c) => c.fleet === undefined)
      .map((c) => ({
        vehicleId: c.vehicleId, lane: c.lane, s: c.s, speed: c.speed, accel: c.accel, nextLane: c.nextLane, state: 0,
        behavior: c.behavior, desiredFactor: c.desiredFactor, headway: c.headway, weaveAmp: c.weaveAmp,
        weavePeriod: c.weavePeriod, weavePhase: c.weavePhase, stopPhase: c.stopPhase, stopTimer: c.stopTimer,
        holding: c.holding, reported: c.reported, flags: c.flags,
      }));
    expect(isTrafficSnapshot(p1)).toBe(true);
    const b = await makeHarness(GRAPH, SEED);
    b.sys.restore(p1);
    expect(b.sys.activeCount).toBe(p1.cars.length);
    expect(b.sys.stopVehicleId).toBe(-1);
    expect(b.sys.fleetEntity(0)).toBe(0);
    steps(b, 4, 120, -1);
    h.physics.dispose();
    b.physics.dispose();
  });
});
