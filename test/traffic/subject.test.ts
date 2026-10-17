import { describe, expect, it } from 'vitest';
import { canBeOnRoad } from '../../src/records/vehicle';
import type { TrafficCarEvent } from '../../src/traffic/events';
import { REGISTRY_POPULATION } from '../../src/traffic/registry';
import { BEHAVIOR, PULL, TRAFFIC_STATE, isTrafficSnapshot } from '../../src/traffic/trafficSystem';
import { LIGHT, VehicleLook } from '../../src/vehicles/components';
import { carInfo, lineGraph, makeHarness, runFor, type Harness } from './helpers';

const ID = 5000;

async function harness(): Promise<Harness> {
  const h = await makeHarness(lineGraph());
  h.sys.densityScale = 0;
  return h;
}

describe('subject cars', () => {
  it('spawns a driving car on the nearest lane, pinned, and emits traffic:spawned', async () => {
    const h = await harness();
    const spawned: TrafficCarEvent[] = [];
    h.bus.on('traffic:spawned', (e) => spawned.push(e));
    const eid = h.sys.spawnSubjectCar(ID, 100, 0, { mode: 'driving' });
    expect(eid).toBeGreaterThan(0);
    expect(spawned).toEqual([{ eid, vehicleId: ID }]);
    expect(h.sys.slotOfVehicle(ID)).toBe(h.sys.slotOfEntity(eid));
    expect(h.sys.view.vehicleId[h.sys.slotOfVehicle(ID)]).toBe(ID);
    // Pinned: the focus leaving does not despawn it.
    h.focus.x = 3000;
    runFor(h, 0, 8);
    const slot = h.sys.slotOfVehicle(ID);
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(h.sys.view.speed[slot]).toBeGreaterThan(1);
    expect(h.sys.view.state[slot]).toBe(TRAFFIC_STATE.driving);
    expect(h.sys.inspect(slot, carInfo()).behavior).toBe(0);
  });

  it('refuses an active id, an invalid id and a point with no road within 200 m', async () => {
    const h = await harness();
    expect(h.sys.spawnSubjectCar(ID, 0, 0, { mode: 'driving' })).toBeGreaterThan(0);
    expect(h.sys.spawnSubjectCar(ID, 300, 0, { mode: 'driving' })).toBe(0);
    expect(h.sys.spawnSubjectCar(-1, 300, 0, { mode: 'driving' })).toBe(0);
    expect(h.sys.spawnSubjectCar(REGISTRY_POPULATION, 300, 0, { mode: 'driving' })).toBe(0);
    expect(h.sys.spawnSubjectCar(ID + 1, 0, 1000, { mode: 'driving' })).toBe(0);
    // The curb spot is taken within 20 m on both directions' curb lanes: a third car at the same point has no room.
    expect(h.sys.spawnSubjectCar(ID + 2, 0, 0, { mode: 'driving' })).toBeGreaterThan(0);
    expect(h.sys.spawnSubjectCar(ID + 3, 0, 0, { mode: 'driving' })).toBe(0);
    expect(h.sys.activeCount).toBe(2);
  });

  it('parks a car at the curb: PULL.parked, stopped, no hazards unless asked', async () => {
    const h = await harness();
    const eid = h.sys.spawnSubjectCar(ID, 0, 0, { mode: 'parked', behavior: BEHAVIOR.dui });
    const eid2 = h.sys.spawnSubjectCar(ID + 1, 100, 0, { mode: 'parked', hazards: true });
    runFor(h, 0, 2);
    for (const e of [eid, eid2]) {
      const slot = h.sys.slotOfEntity(e);
      const info = h.sys.inspect(slot, carInfo());
      expect(info.pull).toBe(PULL.parked);
      expect(info.shoulder).toBeGreaterThan(1.5);
      expect(h.sys.view.state[slot]).toBe(TRAFFIC_STATE.parked);
      expect(h.sys.view.speed[slot]).toBe(0);
    }
    expect((VehicleLook.lights[eid] ?? 0) & LIGHT.hazard).toBe(0);
    expect((VehicleLook.lights[eid2] ?? 0) & LIGHT.hazard).toBe(LIGHT.hazard);
    expect(h.sys.inspect(h.sys.slotOfEntity(eid), carInfo()).behavior).toBe(BEHAVIOR.dui);
    // A traffic stop on it shows the stop's hazards.
    expect(h.sys.forceStop(ID)).toBe(true);
    runFor(h, 2, 1);
    expect((VehicleLook.lights[eid] ?? 0) & LIGHT.hazard).toBe(LIGHT.hazard);
  });

  it('crashes a car at the curb with hazards on', async () => {
    const h = await harness();
    const eid = h.sys.spawnSubjectCar(ID, 0, 0, { mode: 'crashed' });
    runFor(h, 0, 1);
    const slot = h.sys.slotOfEntity(eid);
    expect(h.sys.view.state[slot]).toBe(TRAFFIC_STATE.crashed);
    expect(h.sys.inspect(slot, carInfo()).pull).toBe(PULL.parked);
    expect((VehicleLook.lights[eid] ?? 0) & LIGHT.hazard).toBe(LIGHT.hazard);
    // Pinned: not cleared when the focus is far away.
    h.focus.x = 3000;
    runFor(h, 1, 3);
    expect(h.sys.slotOfVehicle(ID)).toBeGreaterThanOrEqual(0);
  });

  it('places a vehicle whose plates are reported stolen, and keeps it through a snapshot', async () => {
    const h = await harness();
    let id = -1;
    for (let i = 0; i < 20000 && id < 0; i++) if (!canBeOnRoad(7, i)) id = i;
    expect(id).toBeGreaterThanOrEqual(0);
    expect(h.sys.spawnSubjectCar(id, 0, 0, { mode: 'parked' })).toBeGreaterThan(0);
    const snap = JSON.parse(JSON.stringify(h.sys.snapshot())) as ReturnType<typeof h.sys.snapshot>;
    expect(isTrafficSnapshot(snap)).toBe(true);
    const h2 = await harness();
    h2.sys.restore(snap);
    expect(h2.sys.slotOfVehicle(id)).toBe(0);
    expect(h2.sys.inspect(0, carInfo()).pull).toBe(PULL.parked);
  });

  it('pins, unpins, removes and looks up cars by vehicle id', async () => {
    const h = await harness();
    h.sys.spawnAt(0, 1500, { vehicleId: 77, speed: 5 });
    const eid = h.sys.view.eid[0] ?? 0;
    expect(h.sys.slotOfVehicle(77)).toBe(0);
    expect(h.sys.slotOfVehicle(78)).toBe(-1);
    expect(h.sys.pin(78, true)).toBe(false);
    expect(h.sys.pin(77, true)).toBe(true);
    h.focus.x = 5000;
    runFor(h, 0, 2);
    expect(h.sys.slotOfVehicle(77)).toBe(0);
    expect(h.sys.pin(77, false)).toBe(true);
    // The despawn pass runs on the density tick.
    runFor(h, 2, 1.5);
    expect(h.sys.slotOfVehicle(77)).toBe(-1);

    const despawned: TrafficCarEvent[] = [];
    h.bus.on('traffic:despawned', (e) => despawned.push(e));
    const e2 = h.sys.spawnSubjectCar(ID, 0, 0, { mode: 'driving' });
    expect(h.sys.removeVehicle(ID)).toBe(true);
    expect(h.sys.removeVehicle(ID)).toBe(false);
    expect(despawned).toEqual([{ eid: e2, vehicleId: ID }]);
    expect(h.sys.activeCount).toBe(0);
    // The id is free again.
    expect(h.sys.spawnSubjectCar(ID, 0, 0, { mode: 'driving' })).toBeGreaterThan(0);
    expect(eid).toBeGreaterThan(0);
  });

  it('removes the stop target with traffic:released lost', async () => {
    const h = await harness();
    h.sys.spawnAt(0, 1500, { vehicleId: 77, speed: 5, behavior: 0 });
    expect(h.sys.forceStop(77)).toBe(true);
    const reasons: string[] = [];
    h.bus.on('traffic:released', (e) => reasons.push(e.reason));
    expect(h.sys.removeVehicle(77)).toBe(true);
    expect(reasons).toEqual(['lost']);
    expect(h.sys.stopVehicleId).toBe(-1);
  });

  it('sets behaviour bits and rolls the weave of a DUI subject', async () => {
    const h = await harness();
    h.sys.spawnAt(0, 1500, { vehicleId: 77, speed: 5, behavior: 0 });
    expect(h.sys.setBehavior(78, BEHAVIOR.dui)).toBe(false);
    expect(h.sys.setBehavior(77, 300)).toBe(false);
    expect(h.sys.setBehavior(77, BEHAVIOR.dui | BEHAVIOR.speeding)).toBe(true);
    const info = h.sys.inspect(0, carInfo());
    expect(info.behavior).toBe(BEHAVIOR.dui | BEHAVIOR.speeding);
    expect(info.weaveAmp).toBeGreaterThan(0);
    expect(info.desiredFactor).toBeGreaterThan(1.04);
    expect(h.sys.setBehavior(77, 0)).toBe(true);
    expect(h.sys.inspect(0, carInfo()).weaveAmp).toBe(0);
  });

  it('removes the farthest unpinned ambient car when the system is full', async () => {
    const h = await harness();
    const cap = h.sys.capacity;
    for (let i = 0; i < cap; i++) expect(h.sys.spawnAt(0, 20 + i * 14, { vehicleId: 100 + i, speed: 0 })).toBeGreaterThanOrEqual(0);
    expect(h.sys.activeCount).toBe(cap);
    expect(h.sys.pin(100 + cap - 1, true)).toBe(true);
    runFor(h, 0, 0.1);
    const evicted: number[] = [];
    h.bus.on('traffic:despawned', (e) => evicted.push(e.vehicleId));
    // The other direction's curb lane at x = 0 is free.
    expect(h.sys.spawnSubjectCar(ID, 0, 0, { mode: 'driving' })).toBeGreaterThan(0);
    expect(h.sys.activeCount).toBe(cap);
    // Farthest from the focus (the origin): the first car, at x = -1480 (the one at x = 1200 is pinned anyway).
    expect(evicted).toEqual([100]);
    expect(h.sys.slotOfVehicle(ID)).toBeGreaterThanOrEqual(0);
  });
});
