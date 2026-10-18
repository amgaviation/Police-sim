import { describe, expect, it } from 'vitest';
import { outcomeFor } from '../../src/calls/conditions';
import { familyDef } from '../../src/calls/catalog';
import type { ActorInfo } from '../../src/npc/types';
import { at, engage, makeRig, run, runUntil, spawnWhere, type SceneRig } from './helpers';

const REAL = (rt: { scenario: { variants: readonly string[] } }): boolean =>
  !rt.scenario.variants.includes('false') && !rt.scenario.variants.includes('swatting') && !rt.scenario.variants.includes('ambush');

function contactEvent(r: SceneRig, callId: number, role: string, flag: string): void {
  r.bus.emit('contact:event', { incident: `C-${String(callId).padStart(5, '0')}`, callId, personId: 0, role, flag });
}

describe('dispositions follow what happened', () => {
  it('clearing with 10-8 records the scene outcome, not the first listed disposition', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'shopliftingInProgress', (rt) => REAL(rt) && rt.scenario.participants.some((p) => p.role === 'suspect'));
    const rt = engage(r, id, 30, 1);
    rt.flags.add('custody:suspect');
    r.dispatcher.request(r.dispatcher.playerCallsign, { kind: 'status', status: 'available' }, 'key');
    run(r, 1);
    expect(r.cad.call(id)?.disposition).toBe('arrestMade');
    const out = r.scene.outcomes().find((o) => o.callId === id);
    expect(out?.disposition).toBe(out?.suggested);
  });

  it('an AI unit closes a swatting call as what it was, every time', async () => {
    const seen = new Set<string>();
    for (let k = 0; k < 4; k++) {
      const r = await makeRig({ inPoliceVehicle: false });
      const id = r.scene.spawnCall('personWithGun', at(r.sim), { x: r.player.x + 300, z: r.player.z }, ['swatting']);
      expect(id).toBeGreaterThan(0);
      const rt = r.scene.runtime(id);
      const family = rt ? familyDef(rt.scenario.family) : null;
      const expected = rt && family ? outcomeFor(family, rt.flags).disposition : '';
      const closed = runUntil(r, () => r.cad.call(id)?.status === 'closed', 1500);
      if (!closed) continue;
      seen.add(`${expected}->${r.cad.call(id)?.disposition ?? ''}`);
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const s of seen) {
      const [want, got] = s.split('->');
      expect(got).toBe(want);
    }
  });
});

describe('wrong address', () => {
  it('the correction moves the CAD call to the true anchor', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'loudParty', (rt) => rt.scenario.errors.wrongAddress);
    const rt = r.scene.runtime(id)!;
    const a = rt.scenario.anchor;
    const before = r.cad.call(id)!.location;
    expect(Math.hypot(before.x - a.x, before.z - a.z)).toBeGreaterThan(20);
    const due = rt.scenario.timeline.find((e) => e.text.startsWith('Correction: RP advises the location is'));
    run(r, (due?.atS ?? 0) + 1);
    const after = r.cad.call(id)!.location;
    expect(after.x).toBeCloseTo(a.x, 3);
    expect(after.z).toBeCloseTo(a.z, 3);
    expect(due?.text).toContain(after.text);
  });
});

describe('custody and clearing', () => {
  it('cuffing and then releasing or uncuffing does not grade as an arrest', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'shopliftingInProgress', (rt) => REAL(rt) && rt.scenario.participants.some((p) => p.role === 'suspect'));
    const rt = engage(r, id, 30, 1);
    contactEvent(r, id, 'suspect', 'custody');
    run(r, 0.2);
    expect(rt.flags.has('custody:suspect')).toBe(true);
    contactEvent(r, id, 'suspect', 'uncuffed');
    run(r, 0.2);
    expect(rt.flags.has('custody:suspect')).toBe(false);
    contactEvent(r, id, 'suspect', 'custody');
    contactEvent(r, id, 'suspect', 'released');
    run(r, 0.2);
    expect(rt.flags.has('custody:suspect')).toBe(false);
    const family = familyDef(rt.scenario.family)!;
    expect(outcomeFor(family, rt.flags).id).not.toBe('arrest');
  });

  it('a caged prisoner stays in custody', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'shopliftingInProgress', (rt) => REAL(rt) && rt.scenario.participants.some((p) => p.role === 'suspect'));
    const rt = engage(r, id, 30, 1);
    contactEvent(r, id, 'suspect', 'custody');
    contactEvent(r, id, 'suspect', 'caged');
    contactEvent(r, id, 'suspect', 'released');
    run(r, 0.2);
    expect(rt.flags.has('custody:suspect')).toBe(true);
  });

  it('clearing a call from the MDT without ever arriving is graded bad', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'personWithGun', (rt) => rt.scenario.variants.includes('swatting'), ['swatting']);
    r.dispatcher.request(r.dispatcher.playerCallsign, { kind: 'selfAssign', callId: id }, 'key');
    r.player.x += 3000;
    run(r, 1);
    r.dispatcher.request(r.dispatcher.playerCallsign, { kind: 'clearCall', callId: id, disposition: 'unfounded' }, 'key');
    run(r, 1);
    const out = r.scene.outcomes().find((o) => o.callId === id);
    expect(out?.arrivedSim).toBe(-1);
    expect(out?.grade).toBe('bad');
    expect(out?.outcomeId).toBe('clearedWithoutResponding');
  });
});

describe('families without a patient', () => {
  it('a false medical, welfare or crisis report is unfounded, not a failure', () => {
    for (const id of ['medical', 'welfare', 'crisis']) {
      const family = familyDef(id)!;
      const flags = new Set(['arrived', 'variant:false', 'role:caller']);
      const out = outcomeFor(family, flags);
      expect(out.id, id).toBe('unfounded');
      expect(out.grade).toBe('good');
    }
    const medical = familyDef('medical')!;
    expect(outcomeFor(medical, new Set(['arrived', 'role:caller'])).id).not.toBe('noEms');
    expect(outcomeFor(medical, new Set(['arrived', 'role:patient'])).id).toBe('noEms');
  });
});

describe('field contact while working a call', () => {
  it('a contact with a bystander stays on the current call', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', (rt) => REAL(rt) && rt.scenario.participants.some((p) => p.role === 'suspect'));
    engage(r, id, 30, 2);
    const pc = r.dispatcher.playerCallsign;
    expect(r.cad.unit(pc)?.callId).toBe(id);
    const calls = r.cad.calls().length;
    (r.bus as unknown as { emit(t: string, p: unknown): void }).emit('contact:needsCall', { personId: 9, x: r.player.x, z: r.player.z, incident: 'FC-9-1' });
    run(r, 0.5);
    expect(r.cad.unit(pc)?.callId).toBe(id);
    expect(r.cad.call(id)?.status).not.toBe('pending');
    expect(r.cad.call(id)?.units).toContain(pc);
    expect(r.cad.calls().length).toBe(calls);
    expect(r.contact.attached).toEqual([{ incident: 'FC-9-1', callId: id }]);
  });

  it('a free officer gets a contact call with the subject role', async () => {
    const r = await makeRig();
    (r.bus as unknown as { emit(t: string, p: unknown): void }).emit('contact:needsCall', { personId: 11, x: r.player.x, z: r.player.z, incident: 'FC-11-1' });
    run(r, 0.5);
    expect(r.contact.attached).toHaveLength(1);
    expect(r.contact.attached[0]?.role).toBe('subject');
  });
});

describe('scene events from the contact and npc modules', () => {
  it('a surrendering runner ends the foot pursuit', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', (rt) => REAL(rt) && rt.scenario.participants.some((p) => p.role === 'suspect'));
    const rt = engage(r, id, 30, 2);
    const sus = rt.scenario.participants.find((p) => p.role === 'suspect')!;
    const actor = rt.actorIds[sus.index]!;
    r.npc.forceState(actor, 'flee');
    run(r, 2);
    expect(r.scene.hud().pursuit).toMatch(/^FOOT PURSUIT/);
    r.npc.forceState(actor, 'kneel');
    run(r, 5);
    expect(r.scene.hud().pursuit).toBeNull();
    expect(rt.flags.has('pursuitEnded')).toBe(true);
  });

  it('a dropped weapon leaves the person who carried it', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', (rt) => REAL(rt) && rt.scenario.participants.some((p) => p.role === 'suspect'));
    const rt = engage(r, id, 30, 2);
    const sus = rt.scenario.participants.find((p) => p.role === 'suspect')!;
    const gun = r.people.addItem({ kind: 'person', id: sus.personId }, 'handgun', 'waistband', false);
    r.bus.emit('npc:weaponDropped', { actorId: rt.actorIds[sus.index]!, personId: sus.personId, callId: id, item: 'handgun', x: 5, z: 6 });
    run(r, 0.2);
    expect(r.people.itemsOn(sus.personId).some((it) => it.instance === gun.instance)).toBe(false);
  });

  it('an interpreter request from the dialogue starts the interpreter service once', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', (rt) => REAL(rt) && rt.scenario.participants.some((p) => p.role === 'suspect'));
    const rt = engage(r, id, 30, 2);
    const send = (): void => contactEvent(r, id, 'suspect', 'interpreterRequested');
    send();
    send();
    run(r, 0.2);
    expect(rt.flags.has('service:interpreter')).toBe(true);
    expect(rt.services.filter((s) => s.kind === 'interpreter')).toHaveLength(1);
    expect(r.scene.interpreterAvailable(id)).toBe(false);
    run(r, 400);
    expect(r.scene.interpreterAvailable(id)).toBe(true);
  });

  it('people the contact module added to a closed call are sent away', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'domesticDisturbance', (rt) => REAL(rt) && rt.scenario.participants.some((p) => p.role === 'suspect'));
    engage(r, id, 30, 2);
    let person = 30000;
    while (r.npc.isActivePerson(person)) person++;
    const stray = r.npc.spawnActor({
      personId: person, x: r.player.x + 3, z: r.player.z, yaw: 0, profile: 'bystander', role: 'bystander', callId: id, hidden: false, body: 'human', weapon: null, vehicleId: -1,
    });
    expect(stray).toBeGreaterThan(0);
    r.cad.closeCall(id, 'handled', at(r.sim));
    run(r, 1);
    const info = r.npc.actor(stray, { id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0 });
    expect(info === null || info.state === 16).toBe(true);
  });
});

describe('confused elderly subjects', () => {
  it('really have dementia', async () => {
    const r = await makeRig();
    for (let k = 0; k < 4; k++) {
      const id = spawnWhere(r, 'welfareCheckElderly', (rt) => rt.scenario.branch === 'confused' && rt.scenario.participants.some((p) => p.role === 'subject'));
      const sub = r.scene.runtime(id)!.scenario.participants.find((p) => p.role === 'subject')!;
      const identity = r.people.identity(sub.personId);
      expect(identity.dementia).toBe(true);
      expect(identity.age).toBeGreaterThanOrEqual(70);
      r.cad.closeCall(id, 'cancelled', at(r.sim));
    }
  });
});

describe('residents', () => {
  it('a person waiting at their own door has the call address on record', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'welfareCheckNoAnswer', (rt) => rt.scenario.participants.some((p) => p.role === 'subject' && p.personId >= 0));
    const rt = r.scene.runtime(id)!;
    const subject = rt.scenario.participants.find((p) => p.role === 'subject')!;
    expect(r.records.peekPerson(subject.personId).address).toBe(r.cad.call(id)!.location.text);
    const saved = r.records.serialize();
    expect(saved.addresses?.some(([pid]) => pid === subject.personId)).toBe(true);
  });
});

describe('crisis transport', () => {
  it('EMS takes a calm subject in crisis away, so the best outcome can be earned', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'mentalHealthCrisis', (rt) => REAL(rt) && rt.scenario.branch === 'suicidal' && rt.scenario.participants.some((p) => p.role === 'subject'));
    const rt = engage(r, id, 30, 1);
    r.scene.request({ kind: 'action', callId: id, actionId: 'requestEms' });
    expect(runUntil(r, () => rt.flags.has('transported:subject'), 600)).toBe(true);
    const subject = rt.scenario.participants.find((p) => p.role === 'subject')!;
    expect(r.people.state(subject.personId).custody).toBe('hospital');
    expect(outcomeFor(familyDef('crisis')!, rt.flags).id).toBe('transported');
  });
});

function info(): ActorInfo {
  return { id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0 };
}

describe('escalation arms the suspect', () => {
  it('a suspect who is now armed really carries the weapon', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'assaultInProgress', (rt) => rt.scenario.branch === 'suspectNearby' && rt.scenario.variants.includes('escalation'), ['escalation']);
    const rt = engage(r, id, 30, 1);
    expect(runUntil(r, () => rt.flags.has('escalated'), 400)).toBe(true);
    run(r, 2);
    const i = rt.scenario.participants.findIndex((p) => p.role === 'suspect');
    const actor = rt.actorIds[i] ?? 0;
    expect(actor).toBeGreaterThan(0);
    expect(r.npc.actor(actor, info())?.armed).toBe(true);
  });
});

describe('bodies stay put', () => {
  it('a deceased or unconscious person does not get up and walk away when the call is cleared', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'unattendedDeath', (rt) => rt.scenario.participants.some((p) => p.deceased));
    const rt = engage(r, id, 30, 3);
    const i = rt.scenario.participants.findIndex((p) => p.deceased);
    const actor = rt.actorIds[i] ?? 0;
    expect(actor).toBeGreaterThan(0);
    r.npc.reveal(actor);
    r.npc.forceState(actor, 'lying');
    r.scene.request({ kind: 'clear', callId: id, disposition: null });
    run(r, 3);
    expect(r.npc.actor(actor, info())?.state).toBe(15);
  });
});

describe('a dropped weapon', () => {
  it('is collected as evidence and secures the weapon', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'armedPerson', (rt) => REAL(rt) && rt.scenario.branch === 'brandishing' && rt.scenario.participants.some((p) => p.role === 'subject' && p.weapon === 'handgun'));
    const rt = engage(r, id, 30, 1);
    const i = rt.scenario.participants.findIndex((p) => p.role === 'subject');
    const actor = rt.actorIds[i] ?? 0;
    expect(actor).toBeGreaterThan(0);
    r.npc.reveal(actor);
    r.npc.forceState(actor, 'armed');
    r.npc.dropWeapon(actor);
    run(r, 1);
    expect(rt.flags.has('weaponFound')).toBe(false);
    const before = r.scene.props.count;
    expect(before).toBeGreaterThan(0);
    r.scene.request({ kind: 'action', callId: id, actionId: 'photograph' });
    run(r, 30);
    r.scene.request({ kind: 'action', callId: id, actionId: 'collectEvidence' });
    run(r, 60);
    expect(rt.flags.has('weaponFound')).toBe(true);
    expect(rt.flags.has('itemFound:handgun')).toBe(true);
    expect(r.cad.docs.byCall(id).some((d) => d.kind === 'evidence' && (d as { description?: string }).description === 'Handgun')).toBe(true);
  });
});

describe('occupants the officer ordered out', () => {
  it('belong to the scene: EMS takes the patient who stepped out of the car', async () => {
    const r = await makeRig();
    const id = spawnWhere(r, 'impairedDriver', (rt) => REAL(rt) && rt.scenario.branch === 'medical' && rt.scenario.vehicles.length === 1);
    const rt = engage(r, id, 60, 2);
    const driverIdx = rt.scenario.participants.findIndex((p) => p.role === 'driver');
    const driver = rt.scenario.participants[driverIdx]!;
    const vehicleId = rt.scenario.vehicles[0]!.vehicleId;
    // Exactly what ContactManager.stepOutActor does.
    const aid = r.npc.stepOut(vehicleId, 0);
    expect(aid).toBeGreaterThan(0);
    r.npc.setRole(aid, 'driver', id);
    r.scene.request({ kind: 'action', callId: id, actionId: 'requestEms' });
    expect(runUntil(r, () => rt.flags.has('transported:driver'), 900)).toBe(true);
    expect(r.people.state(driver.personId).custody).toBe('hospital');
    expect(r.npc.actorOfPerson(driver.personId)).toBe(0);
  });
});
