import { beforeAll, describe, expect, it } from 'vitest';
import { ACTOR_STATE, type ActorInfo, type PersonPick } from '../../src/npc';
import { answer, findPerson, incident, inject, key, makeRig, patch, type ContactRig } from './helpers';

let rig: ContactRig;
beforeAll(async () => {
  rig = await makeRig();
});

function fresh(ok: (id: number) => boolean, from: number): number {
  return findPerson(rig, (p) => !rig.npc.isActivePerson(p) && rig.mgr.contactOfPerson(p) < 0 && ok(p), from);
}

function info(): ActorInfo {
  return { id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0 };
}

describe('pedestrians and occupants', () => {
  it('promotes a pedestrian into an actor when the contact opens', () => {
    rig.npc.setDensityScale(1);
    rig.step(240);
    const pick: PersonPick = { kind: 'actor', id: 0, seat: 0, personId: -1, distance: 0 };
    const found = rig.npc.nearestPerson(rig.spot.x, rig.spot.z, 0, 5000, -1, pick);
    rig.npc.setDensityScale(0);
    expect(found?.kind).toBe('ped');
    if (!found || found.kind !== 'ped') return;
    const person = found.personId;
    const id = rig.mgr.open({ kind: 'ped', slot: found.id }, incident(key('PD')), rig.time());
    expect(id).toBeGreaterThan(0);
    expect(rig.mgr.personOf(id)).toBe(person);
    expect(rig.npc.actorOfPerson(person)).toBeGreaterThan(0);
    rig.npc.clearPeds();
  });
});

describe('force and escalation', () => {
  it('a struggle during cuffing is announced once the subject is finally cuffed', () => {
    let resisted = false;
    for (let p = 40000; p < 40060 && !resisted; p++) {
      if (rig.npc.isActivePerson(p) || rig.mgr.contactOfPerson(p) >= 0) continue;
      const actor = rig.spawn(p, { profile: 'suspectHostile' });
      const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('FU'), { callId: 8 }), rig.time());
      rig.mgr.request({ kind: 'action', contactId: id, action: 'cuff' });
      rig.step();
      if (!rig.mgr.view(id)?.transcript.some((l) => l.text === 'The subject resists!')) {
        rig.mgr.request({ kind: 'close', contactId: id });
        rig.npc.removeActor(actor);
        rig.step();
        continue;
      }
      resisted = true;
      expect(rig.emitted.some((e) => e.topic === 'force:used' && (e.payload as { kind: string }).kind === 'struggle')).toBe(true);
      expect(rig.events.some((e) => e.flag === 'forceUsed' && e.personId === p)).toBe(false);
      // The struggle ends with the subject down; then the cuffs go on and the force is reported.
      rig.npc.forceState(actor, 'prone');
      rig.mgr.request({ kind: 'action', contactId: id, action: 'cuff' });
      rig.step();
      expect(rig.npc.actor(actor, info())?.cuffed).toBe(true);
      expect(rig.events.filter((e) => e.flag === 'forceUsed' && e.personId === p)).toHaveLength(1);
      expect(rig.emitted.some((e) => e.topic === 'force:used' && (e.payload as { kind: string }).kind === 'cuff')).toBe(true);
    }
    expect(resisted).toBe(true);
  });

  it('an escalating answer puts the actor in flight; for a seated driver it first gets them out', () => {
    const pid = fresh((p) => !rig.people.identity(p).juvenile, 41000);
    const actor = rig.spawn(pid, { profile: 'suspectHostile' });
    rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('ES')), rig.time());
    inject(rig, pid, (m) => answer(m, { lineKey: 'escalate.flee', text: 'I am out of here!', escalate: 'flee' }));
    expect(rig.npc.actor(actor, info())?.state).toBe(ACTOR_STATE.flee);

    rig.place(304);
    rig.step(2);
    const driver = rig.npc.occupantsOf(304)[0] as number;
    rig.mgr.open({ kind: 'occupant', vehicleId: 304, seat: 0 }, incident(key('ES'), { role: 'driver', stop: true, vehicleId: 304 }), rig.time());
    expect(rig.npc.isOut(304, 0)).toBe(false);
    inject(rig, driver, (m) => answer(m, { lineKey: 'escalate.flee', text: 'Nope!', escalate: 'flee' }));
    expect(rig.npc.isOut(304, 0)).toBe(true);
    const out = rig.npc.actorOfPerson(driver);
    expect(rig.npc.actor(out, info())?.state).toBe(ACTOR_STATE.flee);
  });

  it('a calmed crisis subject is announced once', () => {
    const pid = fresh((p) => !rig.people.identity(p).juvenile, 42000);
    const actor = rig.spawn(pid, { profile: 'subjectCrisis' });
    rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('CA')), rig.time());
    inject(rig, pid, (m) => answer(m, { lineKey: 'reassure.ok', text: 'Okay.', calmed: true }));
    inject(rig, pid, (m) => answer(m, { lineKey: 'reassure.ok', text: 'Okay.', calmed: true }));
    expect(rig.events.filter((e) => e.flag === 'calmed' && e.personId === pid)).toHaveLength(1);
  });
});

describe('help with communication', () => {
  it('the translation app and the interpreter are offered once a barrier was noticed', () => {
    const pid = fresh((p) => {
      const i = rig.people.identity(p);
      return i.language.english === 'none' && i.hearing === 'normal' && !i.dementia && !i.juvenile;
    }, 43000);
    const actor = rig.spawn(pid);
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('IN'), { callId: 6 }), rig.time());
    const act = (a: 'useTranslationApp' | 'requestInterpreter'): void => {
      rig.mgr.request({ kind: 'action', contactId: id, action: a });
      rig.step();
    };
    const enabled = (a: string): boolean | undefined => rig.mgr.view(id)?.actions.find((x) => x.id === a)?.enabled;
    expect(enabled('useTranslationApp')).toBe(false);
    expect(enabled('requestInterpreter')).toBe(false);
    inject(rig, pid, (m) => answer(m, { lineKey: 'foreign.untranslated', text: '(Spanish) ...', understood: false }));
    expect(enabled('useTranslationApp')).toBe(true);
    expect(enabled('requestInterpreter')).toBe(true);
    // No interpreter around yet: the request goes to the scene.
    act('requestInterpreter');
    expect(rig.events.some((e) => e.flag === 'interpreterRequested' && e.personId === pid)).toBe(true);
    expect(rig.mgr.view(id)?.commModes).not.toContain('interpreter');
    // Once one is on scene the mode is available and the action switches to it.
    rig.interpreter.available = true;
    expect(rig.mgr.view(id)?.commModes).toContain('interpreter');
    act('requestInterpreter');
    expect(rig.mgr.view(id)?.commMode).toBe('interpreter');
    rig.interpreter.available = false;
    act('useTranslationApp');
    expect(rig.mgr.view(id)?.commMode).toBe('translationApp');
    expect(enabled('useTranslationApp')).toBe(false);
  });
});

describe('vehicle checks', () => {
  it('checks the VIN through the stop or the records and notes the registered owner', () => {
    rig.place(305);
    rig.step(2);
    const driver = rig.npc.occupantsOf(305)[0] as number;
    const k = key('VN');
    const id = rig.mgr.open({ kind: 'occupant', vehicleId: 305, seat: 0 }, incident(k, { role: 'driver', stop: true, vehicleId: 305 }), rig.time());
    const before = rig.requests.length;
    rig.mgr.request({ kind: 'action', contactId: id, action: 'checkVin' });
    rig.step();
    // The active stop is another vehicle: the records answer directly.
    expect(rig.requests.slice(before).some((r) => r.kind === 'stopContact')).toBe(false);
    rig.stop.vehicleId = 305;
    rig.mgr.request({ kind: 'action', contactId: id, action: 'checkVin' });
    rig.step();
    rig.stop.vehicleId = -1;
    expect(rig.requests.slice(before)).toContainEqual({ kind: 'stopContact', action: 'vin' });
    expect(rig.people.facts(driver, k).some((f) => f.topic === 'vehicleOwner' && f.source === 'record')).toBe(true);
  });

  it('writes a citation form for the claimed identity', () => {
    const pid = fresh((p) => !rig.people.identity(p).juvenile, 44000);
    const actor = rig.spawn(pid);
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('CI'), { callId: 2, vehicleId: 123 }), rig.time());
    patch(rig.mgr, pid, (e) => {
      e.memory.identity = { kind: 'relative', personId: 777, first: 'A', middle: '', last: 'B', dob: 1, address: 'x', document: 'none', dlNumber: '' };
    });
    rig.mgr.request({ kind: 'action', contactId: id, action: 'writeCitation' });
    rig.step();
    const form = rig.emitted.filter((e) => e.topic === 'contact:openForm').pop();
    expect(form?.payload).toEqual({ kind: 'citation', personId: 777, vehicleId: 123, callId: 2 });
  });
});
