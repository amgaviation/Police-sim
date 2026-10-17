import { describe, expect, it } from 'vitest';
import { PULLOVER } from '../../src/traffic/data';
import { BEHAVIOR, PULL, type FleetLook, type FleetState } from '../../src/traffic/trafficSystem';
import { vehicleModel } from '../../src/vehicles/model';
import { laneRef } from '../../src/world/roadGraph';
import { DT, NOON, carInfo, gridGraph, lineGraph, makeHarness, runFor, slotOf } from './helpers';

const LOOK: FleetLook = { modelIndex: vehicleModel('patrol_sedan').index, color: 0xf4f4f4 };

function state(): FleetState {
  return { eid: 0, x: 0, z: 0, yaw: 0, speed: 0, edge: 0, mode: 'patrol', arrived: false, parked: false, routeLeftM: -1 };
}

describe('traffic review round 3', () => {
  it('a fleet car whose destination is behind it on its own edge drives round to it instead of parking at once', async () => {
    const h = await makeHarness(gridGraph());
    h.sys.densityScale = 0;
    let at: { x: number; z: number } | null = null;
    h.bus.on('traffic:fleetArrived', (e) => {
      if (e.index === 0) at = { x: e.x, z: e.z };
    });
    h.sys.spawnFleetCar(0, 150, 0, LOOK);
    expect(h.sys.setFleetDestination(0, 40, 0, 'respond')).toBe(true);
    runFor(h, 0, 0.1);
    expect(h.sys.fleetState(0, state())?.arrived).toBe(false);
    runFor(h, 0.1, 150);
    expect(at).not.toBeNull();
    const p = at as { x: number; z: number } | null;
    expect(Math.hypot((p?.x ?? 1e9) - 40, (p?.z ?? 1e9) - 0)).toBeLessThan(PULLOVER.fleet.arriveDistance + 10);
  });

  it('a pulled-over DUI car stands at the curb without its frozen weave offset', async () => {
    const h = await makeHarness(lineGraph());
    h.sys.densityScale = 0;
    h.sys.spawnAt(laneRef(0, 0, 0), 1500, { speed: 12, behavior: BEHAVIOR.dui, weaveAmp: 1.1, weavePeriod: 5 });
    h.focus.x = 100;
    const t = runFor(h, 0, 1);
    const id = h.sys.view.vehicleId[0] ?? -1;
    expect(h.sys.forceStop(id)).toBe(true);
    runFor(h, t, 25);
    const info = h.sys.inspect(slotOf(h, id), carInfo());
    expect(info.pull).toBe(PULL.stopped);
    expect(Math.abs(info.lateral)).toBeLessThan(1e-6);
  });

  it('a car heading to the curb brakes smoothly behind a car already parked there', async () => {
    const h = await makeHarness(lineGraph());
    h.sys.densityScale = 0;
    h.focus.parked = [{ x: -500, z: 4.55, hx: 1, hz: 0, halfLength: 2.55, halfWidth: 0.975 }];
    h.focus.parkedCount = 1;
    h.focus.x = -495;
    h.focus.z = 6;
    h.sys.spawnFleetCar(0, -700, 1.75, LOOK);
    expect(h.sys.setFleetDestination(0, -495, 6, 'respond')).toBe(true);
    const st = state();
    let prev = -1;
    let worst = 0;
    let t = 0;
    for (let i = 0; i < 60 * 40; i++) {
      t += DT;
      h.sys.step(DT, t, NOON, h.focus);
      h.physics.step();
      const v = h.sys.fleetState(0, st)?.speed ?? 0;
      if (prev >= 0) worst = Math.max(worst, (prev - v) / DT);
      prev = v;
    }
    expect(h.sys.fleetState(0, st)?.parked).toBe(true);
    // Stopped behind the parked car, at no more than a hard (not an instant) braking rate.
    expect(st.x).toBeLessThan(-500 - 2.55);
    expect(worst).toBeLessThan(12);
  });
});
