import { describe, expect, it } from 'vitest';
import { roomAt } from '../../src/interior/nav';
import { INTERIOR_FLOOR_Y } from '../../src/interior/constants';
import { ACTOR_STATE, type ActorInfo } from '../../src/npc';
import { mainDoor } from '../../src/scene/indoor';
import type { ScenarioRuntime, SceneDoorEvent } from '../../src/scene/types';
import { at, eventsOf, run } from './helpers';
import { makeIndoorRig, materialize, spawnBound, type IndoorRig } from './indoorHelpers';

function emitLoose(r: IndoorRig, topic: string, payload: object): void {
  (r.bus as unknown as { emit(t: string, p: object): void }).emit(topic, payload);
}

function actorOf(r: IndoorRig, rt: ScenarioRuntime, role: string): ActorInfo {
  const i = rt.scenario.participants.findIndex((p) => p.role === role);
  const info: ActorInfo = {
    id: 0, personId: -1, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false,
    armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
  };
  const id = rt.actorIds[i] ?? 0;
  if (id <= 0 || !r.npc.actor(id, info)) throw new Error(`no actor for ${role}`);
  return info;
}

function roomKindOf(r: IndoorRig, building: number, x: number, z: number): string {
  const layout = r.interiors.layout(building);
  if (!layout) throw new Error('no layout');
  return layout.rooms[roomAt(layout, x, z)]?.kind ?? 'none';
}

const HOMES = ['house', 'apartment'] as const;

describe('indoor binding and placement', () => {
  it('a domestic call binds to a nearby home; the suspect spawns inside, the victim waits at the door', async () => {
    const r = await makeIndoorRig();
    const { id, rt } = spawnBound(r, 'domesticDisturbance', HOMES, (x) => x.scenario.participants.some((p) => p.role === 'suspect'));
    expect(rt.buildingId).toBeGreaterThanOrEqual(0);
    const building = r.interiors.building(rt.buildingId);
    expect(['house', 'apartment']).toContain(building?.kind);
    materialize(r, id, 2);
    expect(rt.materialized).toBe(true);
    expect(eventsOf(r, 'scene:materialized')).toEqual([{ callId: id, buildingId: rt.buildingId }]);

    const suspect = actorOf(r, rt, 'suspect');
    expect(suspect.building).toBe(rt.buildingId);
    expect(suspect.hidden).toBe(false);
    const layout = r.interiors.layout(rt.buildingId);
    expect(layout).not.toBeNull();
    expect(roomAt(layout!, suspect.x, suspect.z)).toBeGreaterThanOrEqual(0);
    expect(['living', 'kitchen', 'bedroom', 'unitLiving']).toContain(roomKindOf(r, rt.buildingId, suspect.x, suspect.z));
    // The npc view publishes the interior level.
    const v = r.npc.view;
    const ys: number[] = [];
    for (let i = 0; i < v.count; i++) ys.push(v.y[i] ?? 0);
    expect(ys).toContain(INTERIOR_FLOOR_Y);

    const victim = actorOf(r, rt, 'victim');
    expect(victim.building).toBe(-1);
    const exit = layout!.doors.find((d) => d.main)!.exit!;
    expect(Math.hypot(victim.x - exit.x, victim.z - exit.z)).toBeLessThan(0.5);
  });

  it('a hidden burglar is in a hiding spot of the bound home and the scene remembers the spot', async () => {
    const r = await makeIndoorRig();
    const { id, rt } = spawnBound(
      r,
      'burglaryInProgress',
      HOMES,
      (x) => x.scenario.participants.some((p) => p.spot === 'hidden' && p.personId >= 0) && (r.interiors.layout(x.buildingId)?.hidingSpots.length ?? 0) > 0,
    );
    materialize(r, id, 2);
    const i = rt.scenario.participants.findIndex((p) => p.spot === 'hidden');
    const info = actorOf(r, rt, rt.scenario.participants[i]!.role);
    expect(info.hidden).toBe(true);
    expect(info.building).toBe(rt.buildingId);
    const spot = rt.hideSpots[i] ?? -1;
    expect(spot).toBeGreaterThanOrEqual(0);
    const h = r.interiors.layout(rt.buildingId)!.hidingSpots[spot]!;
    expect(info.x).toBeCloseTo(h.x, 2);
    expect(info.z).toBeCloseTo(h.z, 2);
  });

  it('the deceased lies in a bedroom with the front door locked', async () => {
    const r = await makeIndoorRig();
    const { id, rt } = spawnBound(r, 'welfareCheckElderly', HOMES, (x) => x.scenario.branch === 'deceased');
    materialize(r, id, 2);
    const info = actorOf(r, rt, 'subject');
    expect(info.building).toBe(rt.buildingId);
    expect(info.state).toBe(ACTOR_STATE.lying);
    expect(['bedroom', 'unitBedroom']).toContain(roomKindOf(r, rt.buildingId, info.x, info.z));
    const layout = r.interiors.layout(rt.buildingId)!;
    expect(r.interiors.doorState(rt.buildingId, mainDoor(layout))).toBe('locked');
  });

  it('retail participants are inside the store', async () => {
    const r = await makeIndoorRig();
    const { id, rt } = spawnBound(r, 'shopliftingDetained', ['convenienceStore'], (x) => r.interiors.building(x.buildingId)?.kind === 'convenienceStore');
    materialize(r, id, 2);
    for (const role of ['guard', 'suspect']) {
      const info = actorOf(r, rt, role);
      expect(info.building).toBe(rt.buildingId);
      expect(['backOffice', 'salesFloor']).toContain(roomKindOf(r, rt.buildingId, info.x, info.z));
    }
  });

  it('a barricade starts with the front door locked', async () => {
    const r = await makeIndoorRig();
    const { id, rt } = spawnBound(r, 'barricadedSubject', HOMES);
    materialize(r, id, 2);
    const layout = r.interiors.layout(rt.buildingId)!;
    expect(r.interiors.doorState(rt.buildingId, mainDoor(layout))).toBe('locked');
    expect(actorOf(r, rt, 'subject').building).toBe(rt.buildingId);
  });

  it('outdoor-only calls are unchanged: road calls and excluded types stay unbound', async () => {
    const r = await makeIndoorRig();
    const b = r.buildings.nearestEntrance(r.player.x, r.player.z, 200, ['house', 'apartment']);
    expect(b).not.toBeNull();
    const at0 = { x: b!.door.x, z: b!.door.z };
    for (const type of ['vehicleBurglaryCold', 'slumpedInVehicle', 'injuryCollision', 'impairedDriver']) {
      const id = r.scene.spawnCall(type, at(r.sim), at0);
      expect(r.scene.runtime(id)?.buildingId, type).toBe(-1);
    }
  });
});

describe('adoption and premises', () => {
  it('adoptOpenCalls binds calls created while the scene was not listening', async () => {
    const r = await makeIndoorRig();
    const b = r.buildings.nearestEntrance(r.player.x, r.player.z, 400, ['house']);
    expect(b).not.toBeNull();
    const call = r.dispatcher.createCall('domesticDisturbance', at(r.sim), { x: b!.door.x, z: b!.door.z });
    expect(call).not.toBeNull();
    expect(r.scene.runtime(call!.id)).toBeNull();
    r.scene.adoptOpenCalls(at(r.sim));
    const rt = r.scene.runtime(call!.id);
    expect(rt).not.toBeNull();
    expect(rt!.buildingId).toBeGreaterThanOrEqual(0);
    expect(r.scene.buildingOf(call!.id)).toBe(rt!.buildingId);
    expect(r.scene.buildingOf(99999)).toBe(-1);
  });

  it('premises tells the integrator which building a scene person belongs to and who has authority', async () => {
    const r = await makeIndoorRig();
    const { id, rt } = spawnBound(r, 'domesticDisturbance', HOMES, (x) => x.scenario.participants.some((p) => p.role === 'victim') && x.scenario.participants.some((p) => p.role === 'caller'));
    materialize(r, id, 1);
    const victim = rt.scenario.participants.find((p) => p.role === 'victim')!;
    const caller = rt.scenario.participants.find((p) => p.role === 'caller')!;
    expect(r.scene.premises(victim.personId)).toEqual({ buildingId: rt.buildingId, authority: true, room: -1 });
    expect(r.scene.premises(caller.personId)).toEqual({ buildingId: rt.buildingId, authority: false, room: -1 });
    expect(r.scene.premises(-5)).toBeNull();
    r.officer.building = rt.buildingId;
    const layout = r.interiors.layout(rt.buildingId)!;
    r.player.x = layout.entry.x;
    r.player.z = layout.entry.z;
    run(r, 1);
    expect(r.scene.premises(victim.personId)?.room).toBe(roomAt(layout, layout.entry.x, layout.entry.z));
  });
});

describe('door lock and knock', () => {
  it('knocking brings the resident to the door and unlocks it; the barricaded subject stays inside', async () => {
    const r = await makeIndoorRig();
    const { id, rt } = spawnBound(r, 'welfareCheckElderly', HOMES, (x) => x.scenario.branch === 'fine' && x.scenario.participants.some((p) => p.role === 'subject'));
    materialize(r, id, 2);
    const layout = r.interiors.layout(rt.buildingId)!;
    const main = mainDoor(layout);
    r.interiors.setDoorState(rt.buildingId, main, 'locked');
    const before = actorOf(r, rt, 'subject');
    expect(before.building).toBe(rt.buildingId);
    r.scene.request({ kind: 'action', callId: id, actionId: 'knock' });
    run(r, 1);
    expect(rt.flags.has('knocked')).toBe(true);
    expect(rt.answerDueSim).toBeGreaterThanOrEqual(rt.knockedSim + 4);
    expect(rt.answerDueSim).toBeLessThanOrEqual(rt.knockedSim + 10 + 0.01);
    run(r, 11);
    const after = actorOf(r, rt, 'subject');
    expect(after.building).toBe(-1);
    const exit = layout.doors[main]!.exit!;
    expect(Math.hypot(after.x - exit.x, after.z - exit.z)).toBeLessThan(4);
    expect(rt.flags.has('answered:subject')).toBe(true);
    expect(r.interiors.doorState(rt.buildingId, main)).toBe('closed');

    // The barricaded subject does not answer a real knock.
    const b = spawnBound(r, 'barricadedSubject', HOMES);
    materialize(r, b.id, 2);
    const l2 = r.interiors.layout(b.rt.buildingId)!;
    const door: SceneDoorEvent = { buildingId: b.rt.buildingId, door: mainDoor(l2), action: 'knock', success: true, x: 0, z: 0, by: 'officer' };
    r.scene.onDoorEvent(door);
    expect(b.rt.flags.has('knocked')).toBe(true);
    run(r, 12);
    expect(actorOf(r, b.rt, 'subject').building).toBe(b.rt.buildingId);
    expect(b.rt.flags.has('answered:subject')).toBe(false);
  });

  it('a hostage answers the door but the barricaded subject does not', async () => {
    const r = await makeIndoorRig();
    const { id, rt } = spawnBound(r, 'hostageSituation', HOMES, (x) => x.scenario.participants.some((p) => p.role === 'hostage'));
    materialize(r, id, 2);
    const layout = r.interiors.layout(rt.buildingId)!;
    r.scene.onDoorEvent({ buildingId: rt.buildingId, door: mainDoor(layout), action: 'knock', success: true, x: 0, z: 0, by: 'officer' });
    run(r, 12);
    expect(actorOf(r, rt, 'hostage').building).toBe(-1);
    expect(actorOf(r, rt, 'subject').building).toBe(rt.buildingId);
  });

  it('a breach by the officer sets forcedEntry; the scene is deaf to its own door changes', async () => {
    const r = await makeIndoorRig();
    const { id, rt } = spawnBound(r, 'domesticDisturbance', HOMES);
    materialize(r, id, 1);
    const door = (by: string, action: string): SceneDoorEvent => ({ buildingId: rt.buildingId, door: 0, action, success: true, x: 0, z: 0, by });
    r.scene.onDoorEvent(door('scene', 'breached'));
    expect(rt.flags.has('forcedEntry')).toBe(false);
    r.scene.onDoorEvent(door('officer', 'breached'));
    expect(rt.flags.has('forcedEntry')).toBe(true);
  });
});

describe('entry and call context', () => {
  it('entering flags entered and the legal basis: none without consent, consent after an entry consent', async () => {
    const r = await makeIndoorRig();
    const a = spawnBound(r, 'domesticDisturbance', HOMES, (x) => x.scenario.participants.some((p) => p.role === 'victim'));
    materialize(r, a.id, 1);
    r.officer.building = a.rt.buildingId;
    run(r, 1);
    expect(a.rt.flags.has('entered')).toBe(true);
    expect(a.rt.flags.has('entry:none')).toBe(true);

    const b = spawnBound(r, 'domesticDisturbance', HOMES, (x) => x.scenario.participants.some((p) => p.role === 'victim'));
    r.officer.building = -1;
    materialize(r, b.id, 1);
    const victim = b.rt.scenario.participants.find((p) => p.role === 'victim')!;
    emitLoose(r, 'contact:consent', { incident: 'x', callId: b.id, personId: victim.personId, kind: 'entry', granted: true, valid: true, buildingId: b.rt.buildingId, room: -1, sim: r.sim });
    run(r, 1);
    expect(b.rt.flags.has('consent:entry')).toBe(true);
    r.officer.building = b.rt.buildingId;
    run(r, 1);
    expect(b.rt.flags.has('entry:consent')).toBe(true);
  });

  it('a consent from a bystander without authority does not count', async () => {
    const r = await makeIndoorRig();
    const a = spawnBound(r, 'domesticDisturbance', HOMES, (x) => x.scenario.participants.some((p) => p.role === 'caller'));
    materialize(r, a.id, 1);
    const caller = a.rt.scenario.participants.find((p) => p.role === 'caller')!;
    emitLoose(r, 'contact:consent', { incident: 'x', callId: a.id, personId: caller.personId, kind: 'entry', granted: true, valid: true, buildingId: a.rt.buildingId, room: -1, sim: r.sim });
    emitLoose(r, 'contact:consent', { incident: 'x', callId: a.id, personId: caller.personId, kind: 'entry', granted: false, valid: true, buildingId: a.rt.buildingId, room: -1, sim: r.sim });
    run(r, 1);
    expect(a.rt.flags.has('consent:entry')).toBe(false);
  });

  it('a store is entered on the public area basis while it is open', async () => {
    const r = await makeIndoorRig();
    const s = spawnBound(r, 'shopliftingDetained', ['convenienceStore'], (x) => r.interiors.building(x.buildingId)?.kind === 'convenienceStore');
    materialize(r, s.id, 1);
    r.officer.building = s.rt.buildingId;
    const layout = r.interiors.layout(s.rt.buildingId)!;
    const entry = layout.entry;
    r.officer.x = entry.x;
    r.officer.z = entry.z;
    r.player.x = entry.x;
    r.player.z = entry.z;
    run(r, 1);
    expect(s.rt.flags.has('entered')).toBe(true);
    const room = layout.rooms[roomAt(layout, entry.x, entry.z)]!;
    // 07:00 game time: the store is open (opening hours of the template); the entry room is public or it is not.
    const open = layout.occupants.openHours === null || (layout.occupants.openHours[0] <= 7 && 7 < layout.occupants.openHours[1]);
    expect(s.rt.flags.has(room.public && open ? 'entry:publicArea' : 'entry:none')).toBe(true);
  });

  it('callContext: exigency by flags and family, warrant, arrests, suspect and building', async () => {
    const r = await makeIndoorRig();
    expect(r.scene.callContext(999)).toBeNull();
    const d = spawnBound(r, 'domesticDisturbance', HOMES, (x) => x.scenario.participants.some((p) => p.role === 'suspect') && !x.flags.has('injury:victim'));
    materialize(r, d.id, 1);
    let ctx = r.scene.callContext(d.id)!;
    expect(ctx.exigency).toBe(false);
    expect(ctx.warrant).toBe(false);
    expect(ctx.buildingId).toBe(d.rt.buildingId);
    expect(ctx.family).toBe('domestic');
    expect(ctx.suspectPersonId).toBe(d.rt.scenario.participants.find((p) => p.role === 'suspect')!.personId);
    expect(ctx.anchorX).toBe(d.rt.scenario.anchor.x);
    d.rt.flags.add('shotsFired');
    expect(r.scene.callContext(d.id)!.exigency).toBe(true);
    d.rt.flags.delete('shotsFired');
    d.rt.flags.add('injury:victim');
    expect(r.scene.callContext(d.id)!.exigency).toBe(true);

    const p = spawnBound(r, 'burglaryInProgress', HOMES);
    expect(r.scene.callContext(p.id)!.exigency).toBe(true);
    const b = spawnBound(r, 'barricadedSubject', HOMES);
    expect(r.scene.callContext(b.id)!.exigency).toBe(true);

    // An arrest is recorded with where the person was.
    const suspect = d.rt.scenario.participants.find((x) => x.role === 'suspect')!;
    emitLoose(r, 'contact:event', { incident: 'C', callId: d.id, personId: suspect.personId, role: 'suspect', flag: 'custody' });
    run(r, 1);
    ctx = r.scene.callContext(d.id)!;
    expect(ctx.arrests).toHaveLength(1);
    expect(ctx.arrests[0]).toMatchObject({ personId: suspect.personId, buildingId: d.rt.buildingId });
    expect(ctx.arrests[0]!.room).toBeGreaterThanOrEqual(0);
  });

  it('a welfare knock with no answer becomes exigent after 60 s; warrant service has a warrant', async () => {
    const r = await makeIndoorRig();
    const w = spawnBound(r, 'welfareCheckNoAnswer', HOMES, (x) => x.scenario.branch === 'notHome');
    materialize(r, w.id, 1);
    expect(r.scene.callContext(w.id)!.exigency).toBe(false);
    r.scene.request({ kind: 'action', callId: w.id, actionId: 'knock' });
    run(r, 30);
    expect(r.scene.callContext(w.id)!.exigency).toBe(false);
    run(r, 35);
    expect(r.scene.callContext(w.id)!.exigency).toBe(true);
    const id = r.scene.spawnCall('warrantService', at(r.sim), { x: r.player.x, z: r.player.z });
    expect(r.scene.callContext(id)!.warrant).toBe(true);
  });
});

describe('investigation events', () => {
  it('set the tool flags and the tool rows show Done', async () => {
    const r = await makeIndoorRig();
    const { id, rt } = spawnBound(r, 'domesticDisturbance', HOMES);
    materialize(r, id, 1);
    const rows = (): Record<string, { detail?: string; enabled: boolean }> => {
      const m = r.scene.panelModel(id)!;
      const out: Record<string, { detail?: string; enabled: boolean }> = {};
      for (const o of m.options) out[o.label] = { detail: o.detail, enabled: o.enabled === true };
      return out;
    };
    expect(rows()['Photograph the scene']).toEqual({ detail: 'Use the camera (O)', enabled: false });
    expect(rows()['Collect evidence']).toEqual({ detail: 'Use the tools (I)', enabled: false });
    expect(rows()['Canvass for witnesses']).toEqual({ detail: 'Use the tools (I)', enabled: false });
    // The row is a hint: the action request flashes it and sets nothing.
    r.scene.request({ kind: 'action', callId: id, actionId: 'photograph' });
    run(r, 1);
    expect(rt.flags.has('photographed')).toBe(false);
    expect(eventsOf<{ text: string }>(r, 'scene:flash').map((e) => e.text)).toContain('Use the camera (O)');

    r.scene.onInvestigation('investigation:photo', { callId: id });
    r.scene.onInvestigation('investigation:collected', { callId: id });
    expect(rt.flags.has('photographed')).toBe(true);
    expect(rt.flags.has('evidenceCollected')).toBe(true);
    expect(rows()['Photograph the scene']?.detail).toBe('Done');
    expect(rows()['Collect evidence']?.detail).toBe('Done');

    r.scene.onInvestigation('investigation:canvass', { callId: id });
    expect(rt.flags.has('canvassed')).toBe(false);
    r.scene.onInvestigation('investigation:canvass', { callId: id });
    expect(rt.flags.has('canvassed')).toBe(true);
    expect(rows()['Canvass for witnesses']?.detail).toBe('Done');

    r.scene.onInvestigation('investigation:plainView', { callId: id, itemId: 'E-1-2' });
    r.scene.onInvestigation('investigation:custodyComplete', { callId: id });
    expect(rt.flags.has('plainView:E-1-2')).toBe(true);
    expect(rt.flags.has('custodyComplete')).toBe(true);
  });

  it('a closed tape around the anchor sets perimeter and scenePreserved; an open or far tape does not', async () => {
    const r = await makeIndoorRig();
    const { id, rt } = spawnBound(r, 'domesticDisturbance', HOMES);
    materialize(r, id, 1);
    const a = rt.scenario.anchor;
    const around = [a.x - 10, a.z - 10, a.x + 10, a.z - 10, a.x + 10, a.z + 10, a.x - 10, a.z + 10];
    r.scene.onInvestigation('investigation:tape', { callId: id, closed: false, points: around });
    expect(rt.flags.has('perimeter')).toBe(false);
    const far = around.map((v, i) => (i % 2 === 0 ? v + 500 : v));
    r.scene.onInvestigation('investigation:tape', { callId: id, closed: true, points: far });
    expect(rt.flags.has('perimeter')).toBe(false);
    r.scene.onInvestigation('investigation:tape', { callId: id, closed: true, points: around });
    expect(rt.flags.has('perimeter')).toBe(true);
    expect(rt.flags.has('scenePreserved')).toBe(true);
  });

  it('npc awareness of a participant sets aware:<role>; a K9 person alert reveals the hidden suspect', async () => {
    const r = await makeIndoorRig();
    const { id, rt } = spawnBound(
      r,
      'burglaryInProgress',
      HOMES,
      (x) => x.scenario.participants.some((p) => p.spot === 'hidden' && p.personId >= 0) && (r.interiors.layout(x.buildingId)?.hidingSpots.length ?? 0) > 0,
    );
    materialize(r, id, 2);
    const p = rt.scenario.participants.find((x) => x.spot === 'hidden')!;
    const actor = actorOf(r, rt, p.role);
    r.scene.onNpcAware({ actorId: actor.id, personId: p.personId, callId: id, level: 'alert', reaction: 'none', cause: 'sound' });
    expect(rt.flags.has(`aware:${p.role}`)).toBe(true);
    expect(actorOf(r, rt, p.role).hidden).toBe(true);
    r.scene.onInvestigation('investigation:k9Alert', { callId: id, kind: 'item', actorId: 0 });
    expect(rt.flags.has('k9Indicated')).toBe(false);
    r.scene.onInvestigation('investigation:k9Alert', { callId: id, kind: 'person', actorId: actor.id });
    expect(rt.flags.has('k9Indicated')).toBe(true);
    expect(actorOf(r, rt, p.role).hidden).toBe(false);
  });
});

describe('K9 on a bound call', () => {
  it('emits scene:service and leaves the hiding suspect to the investigation sweep', async () => {
    const r = await makeIndoorRig();
    const { id, rt } = spawnBound(
      r,
      'burglaryInProgress',
      HOMES,
      (x) => x.scenario.participants.some((p) => p.spot === 'hidden' && p.personId >= 0) && (r.interiors.layout(x.buildingId)?.hidingSpots.length ?? 0) > 0,
    );
    materialize(r, id, 2);
    const p = rt.scenario.participants.find((x) => x.spot === 'hidden')!;
    r.scene.request({ kind: 'action', callId: id, actionId: 'requestK9' });
    run(r, 1);
    expect(eventsOf(r, 'scene:service')).toEqual([{ callId: id, kind: 'k9', phase: 'requested' }]);
    run(r, 200);
    expect(eventsOf(r, 'scene:service')).toContainEqual({ callId: id, kind: 'k9', phase: 'arrived' });
    expect(rt.flags.has('arrived:k9')).toBe(true);
    expect(actorOf(r, rt, p.role).hidden).toBe(true);
    expect(rt.flags.has(`revealed:${p.role}`)).toBe(false);
  });
});

describe('officer levels and weapons', () => {
  it('tackle, taser and shout only reach people on the officer level', async () => {
    const r = await makeIndoorRig();
    const x = r.player.x;
    const z = r.player.z;
    const id = r.npc.spawnActor({ personId: 100, x, z: z - 0.8, yaw: 0, profile: 'suspectCalm', role: 'bystander', callId: 0, hidden: false, body: 'human', weapon: null, vehicleId: -1, building: 5 });
    expect(id).toBeGreaterThan(0);
    r.officer.building = -1;
    r.scene.request({ kind: 'tackle' });
    run(r, 1);
    expect(eventsOf<{ text: string }>(r, 'scene:flash').map((e) => e.text)).toContain('Nobody in reach');
    expect(eventsOf(r, 'force:used')).toHaveLength(0);
    r.officer.building = 5;
    r.scene.request({ kind: 'tackle' });
    run(r, 1);
    expect(eventsOf(r, 'force:used')).toHaveLength(1);
  });

  it('sceneAt ignores the scene while the officer is inside another building', async () => {
    const r = await makeIndoorRig();
    const { id, rt } = spawnBound(r, 'domesticDisturbance', HOMES);
    materialize(r, id, 2);
    const a = rt.scenario.anchor;
    expect(r.scene.sceneAt(a.x, a.z)).toBe(id);
    expect(r.scene.sceneAt(a.x, a.z, rt.buildingId)).toBe(id);
    expect(r.scene.sceneAt(a.x, a.z, rt.buildingId + 1)).toBe(-1);
  });

  it('the weapon cycle skips what is not signed out; none out flashes', async () => {
    const r = await makeIndoorRig();
    r.weapons.sidearm = false;
    r.scene.request({ kind: 'weapon' });
    run(r, 1);
    expect(r.scene.officerWeapon).toBe('taser');
    r.scene.request({ kind: 'weapon' });
    run(r, 1);
    expect(r.scene.officerWeapon).toBe('none');
    r.weapons.taser = false;
    r.scene.request({ kind: 'weapon' });
    run(r, 1);
    expect(r.scene.officerWeapon).toBe('none');
    expect(eventsOf<{ text: string }>(r, 'scene:flash').map((e) => e.text)).toContain('No weapon signed out (armory)');
    r.weapons.sidearm = true;
    r.weapons.taser = true;
    r.scene.request({ kind: 'weapon' });
    run(r, 1);
    expect(r.scene.officerWeapon).toBe('sidearm');
  });
});

describe('returned weapon', () => {
  it('a drawn weapon returned to the armory is holstered and cannot fire', async () => {
    const r = await makeIndoorRig();
    r.scene.request({ kind: 'weapon' });
    r.scene.request({ kind: 'weapon' });
    run(r, 0.1);
    expect(r.scene.officerWeapon).toBe('taser');
    r.weapons.taser = false;
    r.scene.request({ kind: 'fire', dirX: 1, dirZ: 0 });
    run(r, 0.1);
    expect(r.scene.officerWeapon).toBe('none');
    expect(r.scene.presence.weapon).toBe('none');
    expect(eventsOf<{ text: string }>(r, 'scene:flash').map((e) => e.text)).toContain('No weapon signed out (armory)');
    expect(eventsOf<{ kind: string }>(r, 'force:used').some((e) => e.kind === 'taser')).toBe(false);
  });
});

describe('evidence port', () => {
  it('unbound ground evidence goes through placeItem and the scene lays no prop of its own', async () => {
    const r = await makeIndoorRig();
    const id = (() => {
      for (let i = 0; i < 120; i++) {
        const c = r.scene.spawnCall('shotsFired', at(r.sim), { x: r.player.x, z: r.player.z });
        const rt = r.scene.runtime(c);
        if (rt && rt.buildingId < 0 && rt.scenario.evidence.length > 0) return c;
        r.cad.closeCall(c, 'cancelled', at(r.sim));
      }
      throw new Error('none');
    })();
    materialize(r, id, 2);
    const placed = r.evidence.placed.filter((p) => p.callId === id);
    expect(placed.length).toBeGreaterThan(0);
    expect(placed[0]).toMatchObject({ item: 'shellCasing', buildingId: -1, room: -1, concealed: false, container: 'none', incriminating: true });
    expect(r.scene.props.count).toBe(0);
  });

  it('indoor items are placed with the right concealment and the call is summarised at close', async () => {
    const r = await makeIndoorRig();
    let found = 0;
    for (let n = 0; n < 12 && found < 3; n++) {
      const { id, rt } = spawnBound(r, 'burglaryCold', HOMES);
      materialize(r, id, 1);
      for (const p of r.evidence.placed.filter((q) => q.callId === id && q.buildingId >= 0)) {
        found++;
        const layout = r.interiors.layout(rt.buildingId)!;
        expect(p.concealed).toBe(p.container !== 'none');
        if (p.item === 'brokenGlass') expect(p).toMatchObject({ furniture: -1, container: 'none', concealed: false });
        if (p.item === 'burglaryTools') expect(p.furniture).toBeGreaterThanOrEqual(0);
        expect(p.y).toBeLessThan(3);
        expect(layout.rooms[p.room]).toBeDefined();
      }
      r.cad.closeCall(id, 'cancelled', at(r.sim));
      run(r, 1);
      expect(r.evidence.removed).toContain(id);
    }
    expect(found).toBeGreaterThan(0);
  });
});

describe('persistence', () => {
  it('save and restore keep the building, hiding spots and knock state', async () => {
    const r = await makeIndoorRig();
    const { id, rt } = spawnBound(
      r,
      'burglaryInProgress',
      HOMES,
      (x) => x.scenario.participants.some((p) => p.spot === 'hidden' && p.personId >= 0) && (r.interiors.layout(x.buildingId)?.hidingSpots.length ?? 0) > 0,
    );
    materialize(r, id, 2);
    r.scene.onDoorEvent({ buildingId: rt.buildingId, door: mainDoor(r.interiors.layout(rt.buildingId)!), action: 'knock', success: true, x: 0, z: 0, by: 'officer' });
    const save = JSON.parse(JSON.stringify(r.scene.serialize())) as ReturnType<typeof r.scene.serialize>;
    const saved = save.scenarios.find((s) => s.scenario.callId === id)!;
    expect(saved.buildingId).toBe(rt.buildingId);
    expect(saved.hideSpots?.some((h) => h >= 0)).toBe(true);
    expect(saved.knockedSim).toBeGreaterThanOrEqual(0);
    r.scene.restore(save, at(r.sim));
    const back = r.scene.runtime(id)!;
    expect(back.buildingId).toBe(rt.buildingId);
    expect(back.hideSpots).toEqual(rt.hideSpots);
    expect(back.knockedSim).toBe(rt.knockedSim);
    expect(back.answerDueSim).toBe(rt.answerDueSim);
    expect(JSON.parse(JSON.stringify(r.scene.serialize()))).toEqual(save);
  });
});

describe('determinism', () => {
  it('two runs of the same indoor sequence agree on the save, the placed evidence and the door states', async () => {
    const runOnce = async (): Promise<{ save: string; placed: string; doors: string[] }> => {
      const r = await makeIndoorRig();
      const { id, rt } = spawnBound(r, 'domesticDisturbance', HOMES, (x) => x.scenario.participants.some((p) => p.role === 'suspect'));
      materialize(r, id, 2);
      r.scene.onDoorEvent({ buildingId: rt.buildingId, door: mainDoor(r.interiors.layout(rt.buildingId)!), action: 'knock', success: true, x: 0, z: 0, by: 'officer' });
      run(r, 15);
      const layout = r.interiors.layout(rt.buildingId)!;
      return {
        save: JSON.stringify(r.scene.serialize()),
        placed: JSON.stringify(r.evidence.placed),
        doors: layout.doors.map((_, i) => r.interiors.doorState(rt.buildingId, i)),
      };
    };
    const a = await runOnce();
    const b = await runOnce();
    expect(b).toEqual(a);
  });
});
