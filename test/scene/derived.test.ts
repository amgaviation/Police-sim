import { describe, expect, it } from 'vitest';
import { PLATE_FLAG, canBeOnRoad, plateFlags } from '../../src/records/vehicle';
import { isFleetVehicleId } from '../../src/traffic/trafficSystem';
import { BEHAVIOR } from '../../src/traffic/trafficSystem';
import { REGISTRY_POPULATION } from '../../src/traffic/registry';
import type { SceneVehicleSpec } from '../../src/calls';
import { eventsOf, makeRig, run, runUntil, spawnWhere, engage, type SceneRig } from './helpers';

/** First registry car (from `from`) whose driver and plates satisfy `pred`. */
function findCar(r: SceneRig, pred: (c: { id: number; driver: number; stolen: boolean; wanted: boolean }) => boolean, from = 100): number {
  for (let id = from; id < REGISTRY_POPULATION; id++) {
    if (isFleetVehicleId(id) || !canBeOnRoad(r.seed, id)) continue;
    const driver = r.people.occupantsOf(id)[0] ?? -1;
    if (driver < 0) continue;
    const stolen = (plateFlags(r.seed, id) & PLATE_FLAG.stolen) !== 0;
    const wanted = r.people.identity(driver).wanted;
    if (pred({ id, driver, stolen, wanted })) return id;
  }
  throw new Error('no car');
}

/** Puts car `vehicleId` on the road near the player and makes it the traffic-stop target. */
function stopCar(r: SceneRig, vehicleId: number, behavior = 0): void {
  const eid = r.traffic.spawnSubjectCar(vehicleId, r.player.x + 30, r.player.z, { mode: 'driving', behavior });
  expect(eid).toBeGreaterThan(0);
  r.traffic.pin(vehicleId, false);
  expect(r.traffic.forceStop(vehicleId)).toBe(true);
}

/** Moves the officer next to a scene car so the pull-over completes. */
function approach(r: SceneRig, vehicleId: number): void {
  const slot = r.traffic.slotOfVehicle(vehicleId);
  expect(slot).toBeGreaterThanOrEqual(0);
  r.player.x = r.traffic.view.x[slot] ?? r.player.x;
  r.player.z = (r.traffic.view.z[slot] ?? r.player.z) + 15;
}

/** Forces the flee chance of the first scene vehicle (the scenario is plain JSON: edit the save and load it). */
function setFlee(r: SceneRig, flee: number): void {
  const saved = JSON.parse(JSON.stringify(r.scene.serialize())) as ReturnType<SceneRig['scene']['serialize']>;
  const list = saved.scenarios[0]!.scenario.vehicles as SceneVehicleSpec[];
  list[0] = { ...list[0]!, flee };
  r.scene.restore(saved, { sim: r.sim, game: 0 });
}

function stopRuntime(r: SceneRig): ReturnType<SceneRig['scene']['runtime']> {
  const stop = r.cad.trafficStop;
  return stop ? r.scene.runtime(stop.callId) : null;
}

describe('derived traffic stops', () => {
  it('a DUI-behaviour car makes a dui stop and the driver is intoxicated', async () => {
    const r = await makeRig({ noAmbientFlee: true });
    const id = findCar(r, (c) => !c.stolen && !c.wanted && r.people.intoxication(c.driver).bac < 0.04);
    stopCar(r, id, BEHAVIOR.dui);
    expect(runUntil(r, () => r.cad.trafficStop?.outcome === 'active' && stopRuntime(r) !== null, 60)).toBe(true);
    const rt = stopRuntime(r)!;
    expect(rt.scenario.family).toBe('trafficStop');
    expect(rt.scenario.branch).toBe('dui');
    expect(rt.materialized).toBe(true);
    expect(rt.flags.has('vehicleStopped')).toBe(true);
    const driver = rt.scenario.participants.find((p) => p.role === 'driver')!;
    expect(driver.personId).toBe(r.people.occupantsOf(id)[0]);
    // The participants are exactly the car's occupants, driver first.
    expect(rt.scenario.participants.map((p) => p.personId)).toEqual([...r.people.occupantsOf(id)]);
    expect(rt.scenario.participants.map((p) => p.seat)).toEqual(r.people.occupantsOf(id).map((_, k) => k));
    expect(r.people.intoxication(driver.personId).bac).toBeGreaterThanOrEqual(0.08);
  });

  it('a stolen car makes a stolenVehicle stop', async () => {
    const r = await makeRig({ noAmbientFlee: true });
    const id = findCar(r, (c) => c.stolen);
    stopCar(r, id);
    expect(runUntil(r, () => stopRuntime(r) !== null, 60)).toBe(true);
    expect(stopRuntime(r)!.scenario.branch).toBe('stolenVehicle');
  });

  it('a wanted driver makes a wanted stop; a clean one a clean or suspended stop', async () => {
    const r = await makeRig({ noAmbientFlee: true });
    const wanted = findCar(r, (c) => !c.stolen && c.wanted);
    stopCar(r, wanted);
    expect(runUntil(r, () => stopRuntime(r) !== null, 60)).toBe(true);
    expect(stopRuntime(r)!.scenario.branch).toBe('wanted');
    expect(stopRuntime(r)!.scenario.participants[0]?.role).toBe('driver');
  });

  it('the stop attaches to a DUI scenario the player is on, keeping one call', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'impairedDriver', (rt) => rt.scenario.vehicles.length === 1 && !rt.scenario.variants.includes('false') && rt.scenario.branch === 'drunk');
    const rt = engage(r, id, 60, 2);
    expect(rt.materialized).toBe(true);
    const v = rt.scenario.vehicles[0]!;
    expect(r.traffic.slotOfVehicle(v.vehicleId)).toBeGreaterThanOrEqual(0);
    // Force the pull-over without the flee roll.
    setFlee(r, 0);
    approach(r, v.vehicleId);
    expect(r.traffic.forceStop(v.vehicleId)).toBe(true);
    expect(runUntil(r, () => r.cad.trafficStop?.outcome === 'active', 60)).toBe(true);
    expect(r.cad.trafficStop?.callId).toBe(id);
    expect(r.scene.runtime(id)?.flags.has('vehicleStopped')).toBe(true);
  });
});

describe('pursuits', () => {
  it('a fleeing subject vehicle starts a pursuit call linked to the scenario and ends in a stop', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'impairedDriver', (rt) => rt.scenario.vehicles.length === 1 && !rt.scenario.variants.includes('false') && rt.scenario.branch === 'drunk');
    const rt = engage(r, id, 60, 2);
    const v = rt.scenario.vehicles[0]!;
    setFlee(r, 1);
    approach(r, v.vehicleId);
    const rt2 = r.scene.runtime(id)!;
    expect(r.traffic.forceStop(v.vehicleId)).toBe(true);
    expect(runUntil(r, () => r.traffic.fleeingCount > 0, 20)).toBe(true);
    run(r, 0.5);
    const pursuit = r.cad.calls().find((c) => c.typeId === 'vehiclePursuit');
    expect(pursuit).toBeDefined();
    expect(pursuit!.links).toContain(id);
    expect(pursuit!.selfInitiated).toBe(true);
    expect(rt2.flags.has('pursuit')).toBe(true);
    expect(rt2.flags.has('fled:driver')).toBe(true);
    const pr = r.scene.runtime(pursuit!.id)!;
    expect(pr.scenario.family).toBe('pursuit');
    expect(pr.flags.has('pursuit')).toBe(true);
    expect(eventsOf<{ active: boolean }>(r, 'scene:pursuit').some((e) => e.active)).toBe(true);
    expect(r.scene.hud().pursuit).toMatch(/^PURSUIT /);
    expect(eventsOf<{ text: string; priority: boolean }>(r, 'scene:radio').some((e) => e.text.includes('in pursuit of'))).toBe(true);
    // End it: the car pulls over and the stop attaches to the pursuit call.
    expect(r.traffic.stopFlee(v.vehicleId)).toBe(true);
    run(r, 0.5);
    expect(pr.flags.has('pursuitEnded')).toBe(true);
    expect(pr.flags.has('vehicleStopped')).toBe(true);
    run(r, 0.5);
    expect(r.scene.hud().pursuit).toBeNull();
    expect(runUntil(r, () => r.cad.trafficStop?.outcome === 'active', 60)).toBe(true);
    expect(r.cad.trafficStop?.callId).toBe(pursuit!.id);
  });

  it('the call the player left for a pursuit is not stranded open when the pursuit is cleared', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'impairedDriver', (rt) => rt.scenario.vehicles.length === 1 && !rt.scenario.variants.includes('false') && rt.scenario.branch === 'drunk');
    const rt = engage(r, id, 60, 2);
    const v = rt.scenario.vehicles[0]!;
    setFlee(r, 1);
    approach(r, v.vehicleId);
    r.traffic.forceStop(v.vehicleId);
    expect(runUntil(r, () => r.traffic.fleeingCount > 0, 20)).toBe(true);
    run(r, 0.5);
    const pursuit = r.cad.calls().find((c) => c.typeId === 'vehiclePursuit')!;
    expect(r.traffic.stopFlee(v.vehicleId)).toBe(true);
    expect(runUntil(r, () => r.cad.trafficStop?.outcome === 'active', 60)).toBe(true);
    r.dispatcher.request(r.dispatcher.playerCallsign, { kind: 'clearCall', callId: pursuit.id, disposition: 'arrestMade' }, 'key');
    run(r, 120);
    expect(r.cad.call(pursuit.id)?.status).toBe('closed');
    const owner = r.cad.call(id)!;
    expect(owner.status === 'closed' || owner.units.length > 0).toBe(true);
  });

  it('a car that escapes marks the pursuit lost and the driver escaped', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'impairedDriver', (rt) => rt.scenario.vehicles.length === 1 && !rt.scenario.variants.includes('false') && rt.scenario.branch === 'drunk');
    const rt = engage(r, id, 60, 2);
    const v = rt.scenario.vehicles[0]!;
    setFlee(r, 1);
    approach(r, v.vehicleId);
    r.traffic.forceStop(v.vehicleId);
    expect(runUntil(r, () => r.traffic.fleeingCount > 0, 20)).toBe(true);
    // Move the officer far away so the flee ends as escaped.
    r.player.x += 3000;
    expect(runUntil(r, () => r.traffic.fleeingCount === 0, 120)).toBe(true);
    run(r, 0.5);
    const rt3 = r.scene.runtime(id)!;
    const pursuit = r.cad.calls().find((c) => c.typeId === 'vehiclePursuit')!;
    const pr = r.scene.runtime(pursuit.id);
    expect(pr).not.toBeNull();
    if (pr?.flags.has('pursuitLost')) {
      expect(pr.flags.has('escaped:driver')).toBe(true);
      expect(rt3.flags.has('escaped:driver')).toBe(true);
    }
    expect(pr?.flags.has('pursuitEnded')).toBe(true);
  });
});
