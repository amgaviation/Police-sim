import { describe, expect, it } from 'vitest';
import { engage, eventsOf, makeRig, run, runUntil, spawnWhere, type SceneRig } from './helpers';

const NOT_FALSE = (rt: { scenario: { variants: readonly string[] } }): boolean =>
  !rt.scenario.variants.includes('false') && !rt.scenario.variants.includes('swatting') && !rt.scenario.variants.includes('ambush');

function setFlee(r: SceneRig, flee: number): void {
  const saved = JSON.parse(JSON.stringify(r.scene.serialize())) as ReturnType<SceneRig['scene']['serialize']>;
  const list = saved.scenarios[0]!.scenario.vehicles as unknown as { flee: number }[];
  list[0]!.flee = flee;
  r.scene.restore(saved, { sim: r.sim, game: 0 });
}

function startPursuit(r: SceneRig): { id: number; vehicleId: number; pursuitId: number } {
  const id = spawnWhere(r, 'impairedDriver', (rt) => rt.scenario.vehicles.length === 1 && NOT_FALSE(rt) && rt.scenario.branch === 'drunk');
  const rt = engage(r, id, 60, 2);
  const v = rt.scenario.vehicles[0]!;
  setFlee(r, 1);
  const slot = r.traffic.slotOfVehicle(v.vehicleId);
  r.player.x = r.traffic.view.x[slot] ?? r.player.x;
  r.player.z = (r.traffic.view.z[slot] ?? r.player.z) + 15;
  r.traffic.forceStop(v.vehicleId);
  expect(runUntil(r, () => r.traffic.fleeingCount > 0, 20)).toBe(true);
  run(r, 0.3);
  const pursuit = r.cad.calls().find((c) => c.typeId === 'vehiclePursuit')!;
  return { id, vehicleId: v.vehicleId, pursuitId: pursuit.id };
}

describe('seated patients and pursuit endings', () => {
  it('EMS takes a seated medical patient out of the car', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'impairedDriver', (rt) => rt.scenario.branch === 'medical' && NOT_FALSE(rt) && rt.scenario.vehicles.length === 1);
    const rt = engage(r, id, 60, 2);
    expect(rt.flags.has('medicalEmergency')).toBe(true);
    r.scene.request({ kind: 'action', callId: id, actionId: 'requestEms' });
    expect(runUntil(r, () => rt.flags.has('arrived:ems'), 200)).toBe(true);
    expect(rt.flags.has('transported:driver')).toBe(true);
    const driver = rt.scenario.participants.find((p) => p.role === 'driver')!;
    expect(r.people.state(driver.personId).custody).toBe('hospital');
  });

  it('a crashed pursuit car puts its occupants out and ends the pursuit', async () => {
    const r = await makeRig();
    const { vehicleId, pursuitId } = startPursuit(r);
    const pr = r.scene.runtime(pursuitId)!;
    r.bus.emit('traffic:fleeEnded', { eid: 1, vehicleId, reason: 'crashed', x: r.player.x, z: r.player.z });
    run(r, 0.3);
    expect(pr.flags.has('pursuitEnded')).toBe(true);
    expect(pr.flags.has('vehicleStopped')).toBe(true);
    const driver = pr.scenario.participants.find((p) => p.role === 'driver')!;
    expect(r.npc.actorOfPerson(driver.personId)).toBeGreaterThan(0);
    expect(pr.actorIds[driver.index]).toBeGreaterThan(0);
    expect(eventsOf<{ active: boolean }>(r, 'scene:pursuit').filter((e) => !e.active)).toHaveLength(1);
  });

  it('an escaped car leaves the pursuit call open with the driver escaped and the radio informed', async () => {
    const r = await makeRig();
    const { id, vehicleId, pursuitId } = startPursuit(r);
    r.bus.emit('traffic:fleeEnded', { eid: 1, vehicleId, reason: 'escaped', x: 0, z: 0 });
    run(r, 0.3);
    const pr = r.scene.runtime(pursuitId)!;
    expect(pr.flags.has('pursuitLost')).toBe(true);
    expect(pr.flags.has('escaped:driver')).toBe(true);
    expect(r.scene.runtime(id)?.flags.has('escaped:driver')).toBe(true);
    expect(eventsOf<{ text: string }>(r, 'scene:radio').some((e) => e.text.includes('lost sight'))).toBe(true);
    expect(r.cad.call(pursuitId)?.status).not.toBe('closed');
    // Clearing the pursuit gives the escaped outcome.
    r.scene.request({ kind: 'clear', callId: pursuitId, disposition: null });
    run(r, 1);
    const out = r.scene.outcomes().find((o) => o.callId === pursuitId)!;
    expect(out.outcomeId).toBe('escaped');
    expect(out.disposition).toBe('goneOnArrival');
    expect(out.flags).toContain('pursuitLost');
  });
});

describe('families end to end', () => {
  it('a wanted-person call with a flee-prone subject can be arrested, giving a good outcome', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'wantedSubject', (rt) => NOT_FALSE(rt) && rt.scenario.participants.some((p) => p.role === 'subject'));
    const rt = engage(r, id, 30, 2);
    r.scene.request({ kind: 'action', callId: id, actionId: 'knock' });
    run(r, 0.3);
    rt.flags.add('custody:subject');
    r.scene.request({ kind: 'clear', callId: id, disposition: null });
    run(r, 1);
    const out = r.scene.outcomes().find((o) => o.callId === id)!;
    expect(out.outcomeId).toBe('arrest');
    expect(out.grade).toBe('good');
  });

  it('animals: the dog is a bodyless-person actor and secureAnimal removes it', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'strayDog', (rt) => NOT_FALSE(rt) && rt.scenario.participants.some((p) => p.role === 'animal'));
    const rt = engage(r, id, 30, 2);
    const ai = rt.scenario.participants.findIndex((p) => p.role === 'animal');
    expect(rt.scenario.participants[ai]?.personId).toBe(-1);
    expect(rt.actorIds[ai]).toBeGreaterThan(0);
    // Standing next to it sets near:animal and allows the action.
    const a = r.npc.actor(rt.actorIds[ai]!, { id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0 })!;
    r.player.x = a.x - 1;
    r.player.z = a.z;
    run(r, 0.6);
    expect(rt.flags.has('near:animal')).toBe(true);
    r.scene.request({ kind: 'action', callId: id, actionId: 'secureAnimal' });
    run(r, 0.3);
    expect(rt.flags.has('animalSecured')).toBe(true);
    expect(r.npc.actor(rt.actorIds[ai] ?? 0, { id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0 })).toBeNull();
  });

  it('parking calls park a real car and a tow request removes it', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'abandonedVehicle', (rt) => NOT_FALSE(rt) && rt.scenario.vehicles.length === 1);
    const rt = engage(r, id, 30, 2);
    const v = rt.scenario.vehicles[0]!;
    expect(r.traffic.slotOfVehicle(v.vehicleId)).toBeGreaterThanOrEqual(0);
    r.scene.request({ kind: 'action', callId: id, actionId: 'requestTow' });
    expect(runUntil(r, () => rt.flags.has('arrived:tow'), 300)).toBe(true);
    expect(r.traffic.slotOfVehicle(v.vehicleId)).toBe(-1);
    // Dematerialization on close.
    r.scene.request({ kind: 'clear', callId: id, disposition: null });
    run(r, 1);
    expect(r.scene.runtime(id)).toBeNull();
  });
});
