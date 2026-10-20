import { describe, expect, it } from 'vitest';
import type { DispatchBackupEvent } from '../../src/cad/events';
import { createRng } from '../../src/core/rng';
import { ResourceSystem } from '../../src/resources/resourceSystem';
import type { SceneRequest } from '../../src/scene/types';
import { RosterState } from '../../src/units';
import { hasPoliceLights } from '../../src/police/components';
import { at, clearEvents, eventsOf, makeHarness as makeDispatchHarness, quietConfig, step as dispatchStep, type Harness } from '../dispatch/helpers';
import { FakeNpc } from './helpers';

function build(h: Harness) {
  const roster = new RosterState(h.seed);
  const npc = new FakeNpc();
  const scene: SceneRequest[] = [];
  const res = new ResourceSystem({
    seed: h.seed,
    bus: h.bus,
    rng: createRng(h.seed).stream('resources'),
    cad: h.cad,
    city: h.city,
    world: h.world,
    traffic: h.traffic,
    scene: { request: (r) => scene.push(r), hasScenario: () => true, serviceRequested: () => true },
    dispatch: {
      playerCallsign: h.dispatcher.playerCallsign,
      openSelfInitiated: (typeId, priority, p, narrative, t) => h.dispatcher.openSelfInitiated(typeId, priority, p, narrative, t),
      locate: (x, z) => h.dispatcher.locate(x, z),
    },
    npc,
    people: { setCustody: () => undefined },
    roster,
    env: () => ({ wetness: 0, night: false }),
    trafficDensity: () => 1,
  });
  res.start(at(0));
  h.dispatcher.setUnitRanker((cs, x, z, u) => res.rankPatrol(cs, x, z, u));
  return { res, scene, roster };
}

function tick(h: Harness, res: ResourceSystem): void {
  res.step(1 / 60, at(h.sim), h.player);
  dispatchStep(h);
}

describe('with the real traffic system and dispatcher', () => {
  it('a K9 unit spawns at the station, drives the real roads to the call and arrives', async () => {
    const h = await makeDispatchHarness({ config: quietConfig() });
    const { res, scene } = build(h);
    const station = h.city.pois.find((p) => p.kind === 'station');
    expect(station).toBeDefined();
    const to = { x: h.city.spawn.x + 1200, z: h.city.spawn.z + 300 };
    const call = h.dispatcher.createCall('suspiciousPerson', at(0), to);
    expect(call).not.toBeNull();
    if (!call) return;
    res.request({ kind: 'request', typeId: 'k9', callId: call.id, via: 'radio' });
    dispatchStep(h);
    res.step(1 / 60, at(h.sim), h.player);
    expect(res.units().find((u) => u.callsign === 'K9-1')?.status).toBe('turnout');
    // Turn-out, then the car appears at the base and drives on real roads.
    let spawned = false;
    let first = { x: 0, z: 0 };
    let eta0 = -1;
    for (let i = 0; i < 60 * 200 && !spawned; i++) {
      tick(h, res);
      const unit = res.units().find((u) => u.callsign === 'K9-1');
      if (unit?.status === 'enRoute') {
        spawned = true;
        const pose = { x: 0, z: 0, yaw: 0, speed: 0 };
        expect(res.unitPose('K9-1', pose)).toBe(true);
        first = { x: pose.x, z: pose.z };
        eta0 = res.eta('K9-1');
      }
    }
    expect(spawned).toBe(true);
    expect(Math.hypot(first.x - (station?.entrance.x ?? 0), first.z - (station?.entrance.z ?? 0))).toBeLessThan(700);
    expect(Math.hypot(first.x - to.x, first.z - to.z)).toBeGreaterThan(500);
    expect(eta0).toBeGreaterThan(0);
    // The car wears a light bar (PoliceLights attached).
    const eid = h.traffic.fleetEntity(h.cad.unit('K9-1')?.fleetIndex ?? -1);
    expect(eid).toBeGreaterThan(0);
    for (let i = 0; i < 600; i++) tick(h, res);
    const pose = { x: 0, z: 0, yaw: 0, speed: 0 };
    expect(res.unitPose('K9-1', pose)).toBe(true);
    expect(Math.hypot(pose.x - first.x, pose.z - first.z)).toBeGreaterThan(30);
    expect(res.eta('K9-1')).toBeLessThan(eta0);
    expect(hasPoliceLights(h.world, eid)).toBe(true);
    // Arrival.
    let arrived = false;
    for (let i = 0; i < 60 * 400 && !arrived; i++) {
      tick(h, res);
      arrived = res.units().find((u) => u.callsign === 'K9-1')?.status === 'onScene';
    }
    expect(arrived).toBe(true);
    expect(h.cad.unit('K9-1')?.status).toBe('onScene');
    expect(h.cad.unit('K9-1')?.kind).toBe('resource');
    expect(scene).toContainEqual({ kind: 'serviceArrived', callId: call.id, service: 'k9' });
    expect(res.unitPose('K9-1', pose)).toBe(true);
    expect(Math.hypot(pose.x - to.x, pose.z - to.z)).toBeLessThan(150);
  }, 120_000);

  it('the ETA ranker picks backup units through resources.rankPatrol and patrol ETAs are live', async () => {
    const h = await makeDispatchHarness({ config: quietConfig() });
    const { res } = build(h);
    clearEvents(h);
    h.dispatcher.request('12', { kind: 'backup', code: 3 }, 'radio');
    dispatchStep(h);
    const sent = eventsOf<DispatchBackupEvent>(h, 'dispatch:backup').at(-1)?.units ?? [];
    expect(sent.length).toBeGreaterThan(0);
    for (const cs of sent) expect(h.cad.unit(cs)?.status).toBe('enRoute');
    for (let i = 0; i < 300; i++) tick(h, res);
    const etas = sent.map((cs) => res.eta(cs));
    expect(etas.some((e) => e > 0)).toBe(true);
    for (let i = 0; i < 600; i++) tick(h, res);
    const later = sent.map((cs) => res.eta(cs));
    const k = etas.findIndex((e) => e > 20);
    if (k >= 0) expect(later[k]).toBeLessThan(etas[k] ?? 0);
  }, 120_000);

  it('a supervisor reaches a pursuit call and stays', async () => {
    const h = await makeDispatchHarness({ config: quietConfig() });
    const { res } = build(h);
    const call = h.dispatcher.createCall('suspiciousPerson', at(0), { x: h.city.spawn.x + 700, z: h.city.spawn.z });
    expect(call).not.toBeNull();
    if (!call) return;
    h.bus.emit('scene:pursuit', { kind: 'vehicle', active: true, callId: call.id });
    let on = false;
    for (let i = 0; i < 60 * 300 && !on; i++) {
      tick(h, res);
      on = res.onScene(call.id, 'supervisor') > 0;
    }
    expect(on).toBe(true);
    expect(res.supervisorFor(call.id)).toBe('SGT-1');
  }, 120_000);
});
