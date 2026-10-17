import { describe, expect, it } from 'vitest';
import { spawn } from '../../src/ecs/world';
import { PULLOVER } from '../../src/traffic/data';
import type { TrafficCollisionEvent, TrafficFleetArrivedEvent } from '../../src/traffic/events';
import {
  FLEET_ID_BASE,
  PULL,
  TRAFFIC_STATE,
  isFleetVehicleId,
  type FleetLook,
  type FleetState,
} from '../../src/traffic/trafficSystem';
import { LIGHT, VehicleLook } from '../../src/vehicles/components';
import { vehicleModel } from '../../src/vehicles/model';
import { generateCity } from '../../src/world/generate';
import { JUNCTION, laneRef } from '../../src/world/roadGraph';
import { DT, NOON, buildGraph, carInfo, crossGraph, gridGraph, lineGraph, makeHarness, runFor, slotOf, type Harness } from './helpers';

const LOOK: FleetLook = { modelIndex: vehicleModel('patrol_sedan').index, color: 0xf4f4f4 };

function state(): FleetState {
  return { eid: 0, x: 0, z: 0, yaw: 0, speed: 0, edge: 0, mode: 'patrol', arrived: false, parked: false, routeLeftM: -1 };
}

async function harness(graph = lineGraph()): Promise<Harness> {
  const h = await makeHarness(graph);
  h.sys.densityScale = 0;
  return h;
}

describe('fleet cars', () => {
  it('spawns on the nearest curb lane with its fleet id and look; refuses bad indices and full spots', async () => {
    const h = await harness();
    const eid = h.sys.spawnFleetCar(0, 0, 10, LOOK);
    expect(eid).toBeGreaterThan(0);
    expect(h.sys.fleetEntity(0)).toBe(eid);
    expect(h.sys.vehicleIdOfEntity(eid)).toBe(FLEET_ID_BASE);
    expect(isFleetVehicleId(FLEET_ID_BASE + 3)).toBe(true);
    expect(isFleetVehicleId(59_999)).toBe(false);
    expect(VehicleLook.model[eid]).toBe(LOOK.modelIndex);
    expect(VehicleLook.color[eid]).toBe(LOOK.color);
    const slot = h.sys.slotOfEntity(eid);
    expect(h.sys.view.model[slot]).toBe(LOOK.modelIndex);
    expect(h.sys.inspect(slot, carInfo()).lane).toBe(laneRef(0, 0, 0));
    expect(h.sys.fleetState(0, state())?.mode).toBe('patrol');
    // Same spot: the other direction's curb lane, then nothing.
    const eid1 = h.sys.spawnFleetCar(1, 0, 10, LOOK);
    expect(h.sys.inspect(h.sys.slotOfEntity(eid1), carInfo()).lane).toBe(laneRef(0, 1, 0));
    expect(h.sys.spawnFleetCar(2, 0, 10, LOOK)).toBe(0);
    expect(h.sys.spawnFleetCar(3, 0, 1000, LOOK)).toBe(0);
    expect(h.sys.spawnFleetCar(-1, 0, 0, LOOK)).toBe(0);
    expect(h.sys.spawnFleetCar(PULLOVER.fleet.maxCars, 0, 0, LOOK)).toBe(0);
    expect(h.sys.spawnFleetCar(4, 300, 0, { modelIndex: 999, color: 0 })).toBe(0);
    h.sys.removeFleetCar(1);
    expect(h.sys.fleetEntity(1)).toBe(0);
    expect(h.sys.fleetState(1, state())).toBeNull();
    expect(h.sys.activeCount).toBe(1);
  });

  it('is never despawned by distance', async () => {
    const h = await harness();
    const eid = h.sys.spawnFleetCar(0, 0, 0, LOOK);
    h.focus.x = 2000;
    runFor(h, 0, 3);
    expect(h.sys.fleetEntity(0)).toBe(eid);
    expect(h.sys.activeCount).toBe(1);
  });

  it('is not counted for the density target', async () => {
    const city = generateCity(99);
    const a = await makeHarness(city.graph, 99, city);
    a.focus.x = 256;
    a.focus.z = -512;
    a.sys.populate(a.focus, NOON);
    const target = a.sys.activeCount;
    const b = await makeHarness(city.graph, 99, city);
    b.focus.x = 256;
    b.focus.z = -512;
    expect(b.sys.spawnFleetCar(0, 256, -512, LOOK)).toBeGreaterThan(0);
    expect(b.sys.spawnFleetCar(1, 300, -400, LOOK)).toBeGreaterThan(0);
    b.sys.populate(b.focus, NOON);
    expect(b.sys.activeCount).toBe(target + 2);
    a.physics.dispose();
    b.physics.dispose();
  });

  it('drives a route across a grid to its destination, parks at the curb and emits fleetArrived once', async () => {
    const h = await harness(gridGraph());
    const arrived: TrafficFleetArrivedEvent[] = [];
    h.bus.on('traffic:fleetArrived', (e) => arrived.push(e));
    const eid = h.sys.spawnFleetCar(0, 60, 0, LOOK);
    expect(h.sys.setFleetDestination(0, 300, 405, 'respond')).toBe(true);
    const st = state();
    h.sys.fleetState(0, st);
    expect(st.mode).toBe('respond');
    const routeStart = st.routeLeftM;
    expect(routeStart).toBeGreaterThan(400);
    expect(routeStart).toBeLessThan(800);
    let t = runFor(h, 0, 10);
    expect(h.sys.fleetState(0, st)?.routeLeftM).toBeLessThan(routeStart - 50);
    t = runFor(h, t, 110);
    expect(arrived).toHaveLength(1);
    expect(arrived[0]?.index).toBe(0);
    expect(arrived[0]?.eid).toBe(eid);
    h.sys.fleetState(0, st);
    expect(st.arrived).toBe(true);
    expect(st.parked).toBe(true);
    expect(st.speed).toBe(0);
    expect(st.routeLeftM).toBe(-1);
    expect(Math.hypot(st.x - 300, st.z - 400)).toBeLessThan(PULLOVER.fleet.arriveDistance + 10);
    const slot = h.sys.slotOfEntity(eid);
    expect(h.sys.view.state[slot]).toBe(TRAFFIC_STATE.parked);
    expect(h.sys.inspect(slot, carInfo()).pull).toBe(PULL.parked);
    expect((VehicleLook.lights[eid] ?? 0) & LIGHT.lightbar).toBe(0);

    // Back to patrol: leaves the curb and wanders.
    h.sys.setFleetPatrol(0);
    runFor(h, t, 10);
    h.sys.fleetState(0, st);
    expect(st.mode).toBe('patrol');
    expect(st.arrived).toBe(false);
    expect(st.parked).toBe(false);
    expect(h.sys.inspect(slot, carInfo()).pull).toBe(PULL.none);
    expect(st.speed).toBeGreaterThan(2);
  });

  it('reaches a destination behind it (turning round the block) and one further along its own edge', async () => {
    const h = await harness(gridGraph());
    const arrived: number[] = [];
    h.bus.on('traffic:fleetArrived', (e) => arrived.push(e.index));
    h.sys.spawnFleetCar(0, 150, 0, LOOK); // edge 0 -> 1 travelling +x
    h.sys.spawnFleetCar(1, 360, 0, LOOK); // edge 1 -> 2
    expect(h.sys.setFleetDestination(0, 40, 0, 'respond')).toBe(true);
    expect(h.sys.setFleetDestination(1, 380, 0, 'respond')).toBe(true);
    const st = state();
    expect(h.sys.fleetState(1, st)?.routeLeftM).toBeCloseTo(20, 0);
    runFor(h, 0, 150);
    expect(arrived.sort()).toEqual([0, 1]);
  });

  it('refuses an unreachable destination and keeps patrolling', async () => {
    const graph = buildGraph(
      [[0, 0], [500, 0], [0, 1000], [500, 1000]],
      [{ from: 0, to: 1 }, { from: 2, to: 3 }],
    );
    const h = await harness(graph);
    h.sys.spawnFleetCar(0, 100, 0, LOOK);
    expect(h.sys.setFleetDestination(0, 200, 1000, 'emergency')).toBe(false);
    expect(h.sys.setFleetDestination(0, 200, 5000, 'emergency')).toBe(false);
    expect(h.sys.setFleetDestination(5, 200, 0, 'respond')).toBe(false);
    expect(h.sys.fleetState(0, state())?.mode).toBe('patrol');
  });

  describe('urgency at a red light', () => {
    /** Group 0 is red from t = 24 to 51 (CROSS_SIGNAL). */
    async function approach(urgency: 'respond' | 'emergency'): Promise<{ crossT: number; crossSpeed: number; maxSpeed: number; lightbar: boolean }> {
      const h = await harness(crossGraph(JUNCTION.signal));
      const eid = h.sys.spawnFleetCar(0, -250, 0, LOOK);
      expect(h.sys.setFleetDestination(0, 500, 0, urgency)).toBe(true);
      let crossT = -1, crossSpeed = -1, maxSpeed = 0, lightbar = false;
      const info = carInfo();
      runFor(h, 24, 40, (t) => {
        const slot = h.sys.slotOfEntity(eid);
        h.sys.inspect(slot, info);
        const v = h.sys.view.speed[slot] ?? 0;
        maxSpeed = Math.max(maxSpeed, v);
        if (crossT < 0 && info.inJunction) {
          crossT = t;
          crossSpeed = v;
          lightbar = ((VehicleLook.lights[eid] ?? 0) & LIGHT.lightbar) !== 0;
        }
      });
      return { crossT, crossSpeed, maxSpeed, lightbar };
    }

    it('code 3 is faster, slows to crossSpeed and crosses on red with the light bar on; code 2 waits for green', async () => {
      const e = await approach('emergency');
      const r = await approach('respond');
      expect(e.maxSpeed).toBeGreaterThan(r.maxSpeed + 2);
      expect(e.crossT).toBeGreaterThan(24);
      expect(e.crossT).toBeLessThan(51);
      expect(e.crossSpeed).toBeLessThan(PULLOVER.fleet.crossSpeed + 1.5);
      expect(e.lightbar).toBe(true);
      expect(r.crossT).toBeGreaterThanOrEqual(51);
      expect(r.lightbar).toBe(false);
    });
  });

  it('code 3 makes ambient cars ahead yield', async () => {
    const h = await harness();
    h.sys.spawnAt(laneRef(0, 0, 0), 1100, { speed: 8, behavior: 0, desiredFactor: 0.5 });
    const id = h.sys.view.vehicleId[0] ?? 0;
    h.sys.spawnFleetCar(0, -450, 0, LOOK);
    expect(h.sys.setFleetDestination(0, 1200, 0, 'emergency')).toBe(true);
    let yielded = false;
    let t = runFor(h, 0, 20, () => {
      h.focus.x = h.sys.view.x[0] ?? 0;
      if (h.sys.inspect(slotOf(h, id), carInfo()).pull === PULL.yielding) yielded = true;
    });
    expect(yielded).toBe(true);
    t = runFor(h, t, 20);
    const st = state();
    h.sys.fleetState(0, st);
    // The unit passed the yielding car, which merged back.
    expect(st.x).toBeGreaterThan(h.sys.view.x[slotOf(h, id)] ?? 0);
    expect(h.sys.inspect(slotOf(h, id), carInfo()).pull).toBe(PULL.none);
    expect(t).toBeGreaterThan(0);
  });

  it('a collision emits traffic:collision but never crashes a fleet car', async () => {
    const h = await harness();
    h.physics.addGround(4000);
    const eid = h.sys.spawnFleetCar(0, 0, 0, LOOK);
    h.sys.setFleetDestination(0, 1200, 0, 'respond');
    let t = runFor(h, 0, 3, () => {
      const slot = h.sys.slotOfEntity(eid);
      h.focus.x = h.sys.view.x[slot] ?? 0;
      h.focus.z = h.sys.view.z[slot] ?? 0;
    });
    expect(h.physics.has(eid)).toBe(true);
    const events: TrafficCollisionEvent[] = [];
    h.bus.on('traffic:collision', (e) => events.push(e));
    const box = spawn(h.world);
    const slot = h.sys.slotOfEntity(eid);
    h.physics.addBox(box, { x: h.sys.view.x[slot] ?? 0, y: 1.2, z: h.sys.view.z[slot] ?? 0 }, { x: 0.8, y: 0.5, z: 0.8 }, { mass: 1500 });
    t = runFor(h, t, 0.5);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0]?.eid).toBe(eid);
    expect(events[0]?.vehicleId).toBe(FLEET_ID_BASE);
    expect(h.sys.view.state[h.sys.slotOfEntity(eid)]).not.toBe(TRAFFIC_STATE.crashed);
    runFor(h, t, 3);
    expect(h.sys.view.speed[h.sys.slotOfEntity(eid)]).toBeGreaterThan(3);
    h.physics.dispose();
  });

  it('clear() removes ambient cars only and keeps fleet cars driving', async () => {
    const h = await harness(gridGraph());
    h.sys.spawnAt(laneRef(0, 0, 0), 120, { speed: 5 });
    h.sys.spawnAt(laneRef(1, 0, 0), 60, { speed: 5 });
    const eid = h.sys.spawnFleetCar(0, 300, 200, LOOK);
    h.sys.setFleetDestination(0, 100, 400, 'emergency');
    let t = runFor(h, 0, 6);
    const despawned: number[] = [];
    h.bus.on('traffic:despawned', (e) => despawned.push(e.vehicleId));
    h.sys.clear(true);
    expect(despawned).toHaveLength(2);
    expect(despawned.some(isFleetVehicleId)).toBe(false);
    expect(h.sys.activeCount).toBe(1);
    expect(h.sys.fleetEntity(0)).toBe(eid);
    t = runFor(h, t, 60);
    expect(h.sys.fleetState(0, state())?.arrived).toBe(true);
    // restore and dispose remove fleet cars too.
    h.sys.restore({ ...h.sys.snapshot(), cars: [] });
    expect(h.sys.fleetEntity(0)).toBe(0);
    expect(h.sys.activeCount).toBe(0);
    expect(t).toBeGreaterThan(0);
    expect(DT).toBeGreaterThan(0);
  });
});
