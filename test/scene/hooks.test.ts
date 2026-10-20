import { describe, expect, it } from 'vitest';
import type { SceneVehicleSpec } from '../../src/calls';
import type { ScenePursuitEvent, SceneCommandEvent } from '../../src/scene/events';
import { engage, eventsOf, makeRig, run, runUntil, spawnWhere, type SceneRig } from './helpers';

const NOT_FALSE = (rt: { scenario: { variants: readonly string[] } }): boolean =>
  !rt.scenario.variants.includes('false') && !rt.scenario.variants.includes('swatting') && !rt.scenario.variants.includes('ambush');

function blank(): NonNullable<ReturnType<SceneRig['npc']['actor']>> {
  return {
    id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false,
    armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
  };
}

function emitLoose(r: SceneRig, topic: string, payload: object): void {
  (r.bus as unknown as { emit(t: string, p: object): void }).emit(topic, payload);
}

/** A materialized disturbance with a visible subject; returns the call id and the subject's actor id. */
function subjectScene(r: SceneRig): { id: number; actor: number } {
  const id = spawnWhere(r, 'intoxicatedPerson', (rt) => NOT_FALSE(rt) && rt.scenario.branch !== 'gone' && rt.scenario.participants.some((p) => p.role === 'subject'));
  const rt = engage(r, id, 30, 2);
  const i = rt.scenario.participants.findIndex((p) => p.role === 'subject');
  return { id, actor: rt.actorIds[i] ?? 0 };
}

function face(r: SceneRig, actor: number, d: number): void {
  const a = r.npc.actor(actor, blank())!;
  r.player.x = a.x - d;
  r.player.z = a.z;
  r.officer.yaw = -Math.PI / 2;
  run(r, 0.02);
}

function setFlee(r: SceneRig, flee: number): void {
  const saved = JSON.parse(JSON.stringify(r.scene.serialize())) as ReturnType<SceneRig['scene']['serialize']>;
  const list = saved.scenarios[0]!.scenario.vehicles as SceneVehicleSpec[];
  list[0] = { ...list[0]!, flee };
  r.scene.restore(saved, { sim: r.sim, game: 0 });
}

function approach(r: SceneRig, vehicleId: number): void {
  const slot = r.traffic.slotOfVehicle(vehicleId);
  expect(slot).toBeGreaterThanOrEqual(0);
  r.player.x = r.traffic.view.x[slot] ?? r.player.x;
  r.player.z = (r.traffic.view.z[slot] ?? r.player.z) + 15;
}

/** Starts a vehicle pursuit from an impaired-driver stop; returns the owner call, the pursuit call and the vehicle. */
function startPursuit(r: SceneRig): { owner: number; pursuit: number; vehicleId: number } {
  const owner = spawnWhere(r, 'impairedDriver', (rt) => rt.scenario.vehicles.length === 1 && !rt.scenario.variants.includes('false') && rt.scenario.branch === 'drunk');
  const rt = engage(r, owner, 60, 2);
  const v = rt.scenario.vehicles[0]!;
  setFlee(r, 1);
  approach(r, v.vehicleId);
  r.traffic.forceStop(v.vehicleId);
  expect(runUntil(r, () => r.traffic.fleeingCount > 0, 20)).toBe(true);
  run(r, 0.5);
  const pursuit = r.cad.calls().find((c) => c.typeId === 'vehiclePursuit')!;
  return { owner, pursuit: pursuit.id, vehicleId: v.vehicleId };
}

describe('setWeapon', () => {
  it('draws like the weapon key: presence, revision and the drawn event for the nearest actor', async () => {
    const r = await makeRig();
    const { id, actor } = subjectScene(r);
    face(r, actor, 3);
    const rev = r.scene.revision;
    r.scene.setWeapon('sidearm');
    expect(r.scene.officerWeapon).toBe('sidearm');
    expect(r.scene.presence.weapon).toBe('sidearm');
    expect(r.scene.revision).toBeGreaterThan(rev);
    expect(eventsOf<{ kind: string; callId: number; personId: number }>(r, 'force:used')).toEqual([
      { kind: 'sidearmDrawn', callId: id, personId: r.npc.actor(actor, blank())!.personId },
    ]);
    // The same weapon again is not drawn twice.
    r.scene.setWeapon('sidearm');
    expect(eventsOf(r, 'force:used')).toHaveLength(1);
    r.scene.setWeapon('taser');
    expect(r.scene.presence.weapon).toBe('taser');
    expect(eventsOf<{ kind: string }>(r, 'force:used').map((e) => e.kind)).toEqual(['sidearmDrawn', 'taserDrawn']);
    // Holstering emits nothing.
    r.scene.setWeapon('none');
    expect(r.scene.officerWeapon).toBe('none');
    expect(r.scene.presence.weapon).toBe('none');
    expect(eventsOf(r, 'force:used')).toHaveLength(2);
  });

  it('draws without an event when nobody is near, and the weapon key continues from it', async () => {
    const r = await makeRig();
    r.scene.setWeapon('taser');
    expect(r.scene.officerWeapon).toBe('taser');
    expect(eventsOf(r, 'force:used')).toHaveLength(0);
    r.scene.request({ kind: 'weapon' });
    run(r, 0.1);
    expect(r.scene.officerWeapon).toBe('none');
  });
});

describe('serviceArrived', () => {
  it('is true once the requested service arrived on that call', async () => {
    const r = await makeRig();
    const { id } = subjectScene(r);
    expect(r.scene.serviceArrived(id, 'ems')).toBe(false);
    r.scene.request({ kind: 'action', callId: id, actionId: 'requestEms' });
    run(r, 1);
    expect(r.scene.runtime(id)?.services.some((s) => s.kind === 'ems')).toBe(true);
    expect(r.scene.serviceArrived(id, 'ems')).toBe(false);
    expect(runUntil(r, () => r.scene.serviceArrived(id, 'ems'), 600)).toBe(true);
    expect(r.scene.serviceArrived(id, 'k9')).toBe(false);
    expect(r.scene.serviceArrived(id + 9999, 'ems')).toBe(false);
  });
});

describe('scene:command', () => {
  it('a shout reports the command, its outcome and the actor', async () => {
    const r = await makeRig();
    const { id, actor } = subjectScene(r);
    face(r, actor, 8);
    r.scene.request({ kind: 'shout' });
    run(r, 0.1);
    const ev = eventsOf<SceneCommandEvent>(r, 'scene:command');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ callId: id, actorId: actor, personId: r.npc.actor(actor, blank())!.personId });
    expect(['stop', 'handsUp', 'dropWeapon']).toContain(ev[0]?.command);
    expect(['comply', 'refuse', 'flee', 'fight', 'confused']).toContain(ev[0]?.outcome);
    expect(ev[0]?.sim).toBeGreaterThanOrEqual(0);
    // Nobody in front: nothing.
    face(r, actor, 30);
    r.scene.request({ kind: 'shout' });
    run(r, 0.1);
    expect(eventsOf(r, 'scene:command')).toHaveLength(1);
  });

  it('uses the trustAt dependency (at the officer) instead of the district table', async () => {
    const calls: [number, number][] = [];
    const r = await makeRig({
      deps: () => ({
        trustAt: (x, z) => {
          calls.push([x, z]);
          return 0.9;
        },
      }),
    });
    const { actor } = subjectScene(r);
    face(r, actor, 8);
    r.scene.request({ kind: 'shout' });
    run(r, 0.1);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]?.[0]).toBeCloseTo(r.officer.x, 3);
    expect(calls[0]?.[1]).toBeCloseTo(r.officer.z, 3);
  });
});

describe('pursuit payload and terminatePursuit', () => {
  it('a vehicle pursuit reports its owner call and driver, and ends with the flee reason', async () => {
    const r = await makeRig();
    const { owner, pursuit, vehicleId } = startPursuit(r);
    const start = eventsOf<ScenePursuitEvent>(r, 'scene:pursuit').find((e) => e.active)!;
    const driver = r.npc.occupantsOf(vehicleId)[0] ?? -1;
    expect(start).toMatchObject({ kind: 'vehicle', callId: pursuit, ownerCallId: owner, personId: driver });
    expect(driver).toBeGreaterThanOrEqual(0);
    expect(r.traffic.stopFlee(vehicleId)).toBe(true);
    run(r, 0.5);
    const end = eventsOf<ScenePursuitEvent>(r, 'scene:pursuit').find((e) => !e.active)!;
    expect(end).toMatchObject({ kind: 'vehicle', callId: pursuit, ownerCallId: owner, personId: driver, endReason: 'stopped' });
  });

  it('a pursuit that escapes ends with escaped', async () => {
    const r = await makeRig();
    const { pursuit } = startPursuit(r);
    r.player.x += 3000;
    expect(runUntil(r, () => r.traffic.fleeingCount === 0, 120)).toBe(true);
    run(r, 0.5);
    const end = eventsOf<ScenePursuitEvent>(r, 'scene:pursuit').find((e) => !e.active)!;
    expect(end).toMatchObject({ callId: pursuit });
    expect(['escaped', 'gaveUp', 'crashed']).toContain(end.endReason);
  });

  it('terminatePursuit ends the vehicle pursuit: flags, event, radio, and the later flee end is silent', async () => {
    const r = await makeRig();
    const { owner, pursuit, vehicleId } = startPursuit(r);
    expect(r.scene.hud().pursuit).toMatch(/^PURSUIT /);
    const before = eventsOf<{ text: string }>(r, 'scene:radio').length;
    r.scene.request({ kind: 'terminatePursuit' });
    run(r, 0.1);
    const ends = eventsOf<ScenePursuitEvent>(r, 'scene:pursuit').filter((e) => !e.active);
    expect(ends).toHaveLength(1);
    expect(ends[0]).toMatchObject({ kind: 'vehicle', callId: pursuit, ownerCallId: owner, endReason: 'terminated' });
    const rt = r.scene.runtime(pursuit)!;
    expect(rt.flags.has('pursuitTerminated')).toBe(true);
    expect(rt.flags.has('pursuitEnded')).toBe(true);
    expect(rt.flags.has('escaped:driver')).toBe(true);
    expect(r.scene.runtime(owner)?.flags.has('escaped:driver')).toBe(true);
    expect(r.scene.runtime(owner)?.flags.has('pursuitTerminated')).toBe(true);
    const radio = eventsOf<{ text: string }>(r, 'scene:radio').slice(before);
    expect(radio.map((e) => e.text)).toContain(`${r.dispatcher.playerCallsign}, terminating the pursuit.`);
    expect(r.scene.hud().pursuit).toBeNull();
    // The car keeps fleeing; when it is finally gone nothing more is reported.
    expect(r.traffic.fleeingCount).toBeGreaterThan(0);
    r.player.x += 3000;
    expect(runUntil(r, () => r.traffic.fleeingCount === 0, 120)).toBe(true);
    run(r, 0.5);
    expect(eventsOf<ScenePursuitEvent>(r, 'scene:pursuit').filter((e) => !e.active)).toHaveLength(1);
    expect(rt.flags.has('pursuitLost')).toBe(false);
    expect(vehicleId).toBeGreaterThan(0);
    // A second request with no pursuit does nothing.
    r.scene.request({ kind: 'terminatePursuit' });
    run(r, 0.1);
    expect(eventsOf<ScenePursuitEvent>(r, 'scene:pursuit').filter((e) => !e.active)).toHaveLength(1);
  });

  it('a foot pursuit reports the runner and ends with caught', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', (rt) => NOT_FALSE(rt) && rt.scenario.participants.some((p) => p.role === 'suspect'));
    engage(r, id, 30, 2);
    const rt = r.scene.runtime(id)!;
    const sus = rt.scenario.participants.find((p) => p.role === 'suspect')!;
    const actorId = rt.actorIds[sus.index]!;
    r.npc.forceState(actorId, 'flee');
    r.bus.emit('npc:fled', { actorId, personId: sus.personId, callId: id });
    run(r, 0.1);
    const start = eventsOf<ScenePursuitEvent>(r, 'scene:pursuit').find((e) => e.kind === 'foot' && e.active)!;
    expect(start).toMatchObject({ callId: id, ownerCallId: id, personId: sus.personId });
    r.bus.emit('npc:caught', { actorId, personId: sus.personId, callId: id, by: 'force' });
    run(r, 0.5);
    const end = eventsOf<ScenePursuitEvent>(r, 'scene:pursuit').find((e) => e.kind === 'foot' && !e.active)!;
    expect(end).toMatchObject({ callId: id, personId: sus.personId, endReason: 'caught' });
  });

  it('a saved pursuit keeps its owner and person, an old one without them still ends', async () => {
    const r = await makeRig();
    const { owner, pursuit } = startPursuit(r);
    const save = JSON.parse(JSON.stringify(r.scene.serialize())) as ReturnType<SceneRig['scene']['serialize']>;
    expect(save.pursuits[0]).toMatchObject({ callId: pursuit, ownerCallId: owner });
    delete save.pursuits[0]!.ownerCallId;
    delete save.pursuits[0]!.personId;
    r.scene.restore(save, { sim: r.sim, game: 0 });
    r.scene.request({ kind: 'terminatePursuit' });
    run(r, 0.1);
    const end = eventsOf<ScenePursuitEvent>(r, 'scene:pursuit').find((e) => !e.active)!;
    expect(end).toMatchObject({ callId: pursuit, ownerCallId: 0, personId: -1, endReason: 'terminated' });
  });
});

describe('errorScaleAt', () => {
  it('is asked for the call location and scales the dispatch errors', async () => {
    const asked: [number, number][] = [];
    let scale = 0;
    const r = await makeRig({
      deps: () => ({
        errorScaleAt: (x, z) => {
          asked.push([x, z]);
          return scale;
        },
      }),
    });
    let errors0 = 0;
    for (let i = 0; i < 40; i++) {
      const id = r.scene.spawnCall('domesticDisturbance', { sim: r.sim, game: 0 }, { x: r.player.x, z: r.player.z });
      const e = r.scene.runtime(id)?.scenario.errors;
      if (e && (e.wrongAddress || e.wrongDescription || e.missingWeapon)) errors0++;
      r.cad.closeCall(id, 'cancelled', { sim: r.sim, game: 0 });
    }
    expect(asked.length).toBeGreaterThanOrEqual(40);
    expect(errors0).toBe(0);
    scale = 50;
    let errorsMany = 0;
    for (let i = 0; i < 40; i++) {
      const id = r.scene.spawnCall('domesticDisturbance', { sim: r.sim, game: 0 }, { x: r.player.x, z: r.player.z });
      const e = r.scene.runtime(id)?.scenario.errors;
      if (e && e.wrongDescription) errorsMany++;
      r.cad.closeCall(id, 'cancelled', { sim: r.sim, game: 0 });
    }
    expect(errorsMany).toBeGreaterThan(30);
  });
});

describe('hostile onlookers', () => {
  function arrest(r: SceneRig, id: number): void {
    const rt = r.scene.runtime(id)!;
    const p = rt.scenario.participants.find((q) => q.role === 'suspect')!;
    emitLoose(r, 'contact:event', { incident: r.cad.call(id)!.number, callId: id, personId: p.personId, role: 'suspect', flag: 'custody' });
    run(r, 0.1);
  }

  function domestic(r: SceneRig): number {
    const id = spawnWhere(r, 'domesticDisturbance', (rt) => NOT_FALSE(rt) && rt.scenario.participants.some((p) => p.role === 'suspect'));
    engage(r, id, 30, 2);
    return id;
  }

  function onlookers(r: SceneRig, id: number): ReturnType<SceneRig['npc']['actor']>[] {
    const ids = r.npc.actorsOfCall(id, []);
    return ids.map((a) => r.npc.actor(a, blank())).filter((a) => a !== null && a.role === 'onlooker');
  }

  it('an arrest spawns 2-4 protesters 8-14 m away with two lines, once per call', async () => {
    const r = await makeRig({ deps: () => ({ hostilityAt: () => 1 }) });
    const id = domestic(r);
    expect(r.scene.runtime(id)?.buildingId).toBe(-1);
    const linesBefore = eventsOf<{ text: string }>(r, 'scene:line').length;
    arrest(r, id);
    const watchers = onlookers(r, id);
    expect(watchers.length).toBeGreaterThanOrEqual(2);
    expect(watchers.length).toBeLessThanOrEqual(4);
    for (const w of watchers) {
      expect(w?.profile).toBe('protester');
      expect(w?.callId).toBe(id);
      const d = Math.hypot((w?.x ?? 0) - r.officer.x, (w?.z ?? 0) - r.officer.z);
      expect(d).toBeGreaterThan(5);
      expect(d).toBeLessThan(16);
    }
    const lines = eventsOf<{ text: string }>(r, 'scene:line').slice(linesBefore).map((l) => l.text);
    expect(lines).toEqual(['Leave him alone!', "I'm filming this!"]);
    expect(r.scene.runtime(id)?.flags.has('onlookersRolled')).toBe(true);
    // Force on the same call does not roll again.
    r.bus.emit('force:used', { kind: 'tackle', personId: -1, callId: id });
    run(r, 0.1);
    expect(onlookers(r, id)).toHaveLength(watchers.length);
    expect(eventsOf<{ text: string }>(r, 'scene:line').length).toBe(linesBefore + 2);
  });

  it('force:used and force:applied also trigger them, but drawing a weapon does not', async () => {
    const used = await makeRig({ deps: () => ({ hostilityAt: () => 1 }) });
    const a = domestic(used);
    used.bus.emit('force:used', { kind: 'sidearmDrawn', personId: -1, callId: a });
    used.bus.emit('force:used', { kind: 'taserDrawn', personId: -1, callId: a });
    run(used, 0.1);
    expect(onlookers(used, a)).toHaveLength(0);
    used.bus.emit('force:used', { kind: 'taser', personId: -1, callId: a });
    run(used, 0.1);
    expect(onlookers(used, a).length).toBeGreaterThanOrEqual(2);

    const applied = await makeRig({ deps: () => ({ hostilityAt: () => 1 }) });
    const b = domestic(applied);
    emitLoose(applied, 'force:applied', { seq: 1, tool: 'baton', personId: -1, actorId: 0, callId: b });
    run(applied, 0.1);
    expect(onlookers(applied, b).length).toBeGreaterThanOrEqual(2);
  });

  it('nothing happens without the dependency, and it makes no draw', async () => {
    const r = await makeRig();
    const id = domestic(r);
    const before = JSON.stringify(r.scene.serialize().rng);
    arrest(r, id);
    expect(onlookers(r, id)).toHaveLength(0);
    expect(r.scene.runtime(id)?.flags.has('onlookersRolled')).toBe(false);
    expect(JSON.stringify(r.scene.serialize().rng)).toBe(before);
  });

  it('a failed roll draws once and spawns nobody; low chances spawn rarely', async () => {
    const asked: [number, number][] = [];
    const none = await makeRig({
      deps: () => ({
        hostilityAt: (x, z) => {
          asked.push([x, z]);
          return 0;
        },
      }),
    });
    const id = domestic(none);
    arrest(none, id);
    expect(onlookers(none, id)).toHaveLength(0);
    expect(asked).toHaveLength(1);
    const a = none.scene.runtime(id)!.scenario.anchor;
    expect(asked[0]).toEqual([a.x, a.z]);
    expect(none.scene.runtime(id)?.flags.has('onlookersRolled')).toBe(true);
  });

  it('the roll is saved with the call: a restored scene does not roll again', async () => {
    const r = await makeRig({ deps: () => ({ hostilityAt: () => 1 }) });
    const id = domestic(r);
    arrest(r, id);
    const count = onlookers(r, id).length;
    const save = JSON.parse(JSON.stringify(r.scene.serialize())) as ReturnType<SceneRig['scene']['serialize']>;
    r.scene.restore(save, { sim: r.sim, game: 0 });
    r.bus.emit('force:used', { kind: 'tackle', personId: -1, callId: id });
    run(r, 0.1);
    expect(onlookers(r, id)).toHaveLength(count);
  });
});
