import { beforeAll, describe, expect, it } from 'vitest';
import { findPerson, incident, key, makeRig, type ContactRig } from './helpers';

let rig: ContactRig;
beforeAll(async () => {
  rig = await makeRig();
});

describe('open', () => {
  it('opens a seated occupant of a stopped car without an actor and records the first observations', () => {
    rig.place(300);
    rig.step(2);
    const driver = rig.npc.occupantsOf(300)[0] as number;
    const k = key('C');
    const id = rig.mgr.open({ kind: 'occupant', vehicleId: 300, seat: 0 }, incident(k, { role: 'driver', vehicleId: 300, stop: true }), rig.time());
    expect(id).toBeGreaterThan(0);
    expect(rig.mgr.active).toBe(id);
    expect(rig.mgr.contactOfPerson(driver)).toBe(id);
    expect(rig.mgr.personOf(id)).toBe(driver);
    // No actor until the occupant steps out.
    expect(rig.npc.actorOfPerson(driver)).toBe(0);
    // The record is touched, an appearance observation exists, and the flag was announced.
    expect(rig.records.serialize().persons.some((p) => p.id === driver)).toBe(true);
    const look = rig.people.facts(driver, k).find((f) => f.topic === 'appearance');
    expect(look?.source).toBe('observation');
    expect(look?.value).toMatch(/^[MF]\|\d+\|\d+\|\w+$/);
    expect(rig.events.some((e) => e.flag === 'contacted' && e.personId === driver && e.incident === k)).toBe(true);
    // Opening again re-activates the same contact.
    expect(rig.mgr.open({ kind: 'occupant', vehicleId: 300, seat: 0 }, null, rig.time())).toBe(id);
  });

  it('notes the odor of alcohol of a drinking subject within range', () => {
    const pid = findPerson(rig, (p) => !rig.npc.isActivePerson(p) && rig.people.identity(p).drinker > 0.9, 1000);
    rig.people.setIntoxication(pid, 0.13, 'none');
    const actor = rig.spawn(pid);
    const k = key('C');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
    expect(id).toBeGreaterThan(0);
    const odor = rig.people.facts(pid, k).find((f) => f.topic === 'drinking');
    expect(odor?.source).toBe('evidence');
    expect(odor?.detail).toBe('odor of alcohol');
    expect(rig.mgr.view(id)?.subtitle).toContain('Odor of alcohol');
  });

  it('opens a field contact FC-<person>-<day> with drawn truth and reports a call is needed on the first ID request', () => {
    const pid = findPerson(rig, (p) => !rig.npc.isActivePerson(p) && !rig.people.identity(p).juvenile && rig.people.identity(p).hearing === 'normal', 2000);
    const actor = rig.spawn(pid);
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, null, rig.time());
    expect(id).toBeGreaterThan(0);
    const entry = rig.mgr.serialize().contacts.find((c) => c.id === id);
    const day = 20605;
    expect(entry?.incident).toBe(`FC-${pid}-${day}`);
    expect(entry?.callId).toBe(0);
    expect(entry?.truth.reason).toBe('');
    expect(entry?.truth.destination).not.toBe('');
    rig.mgr.request({ kind: 'say', contactId: id, utteranceId: 'requestId', tone: 'polite' });
    rig.step();
    const needs = rig.emitted.filter((e) => e.topic === 'contact:needsCall' && (e.payload as { personId: number }).personId === pid);
    expect(needs).toHaveLength(1);
    expect((needs[0]?.payload as { incident: string }).incident).toBe(`FC-${pid}-${day}`);
    // Only once.
    rig.mgr.request({ kind: 'say', contactId: id, utteranceId: 'requestId', tone: 'polite' });
    rig.step();
    expect(rig.emitted.filter((e) => e.topic === 'contact:needsCall' && (e.payload as { personId: number }).personId === pid)).toHaveLength(1);
    // The scene reports the call: later events carry its id.
    rig.mgr.attachCall(`FC-${pid}-${day}`, 55);
    const before = rig.events.length;
    rig.mgr.request({ kind: 'action', contactId: id, action: 'writeCitation' });
    rig.step();
    const form = rig.emitted.find((e) => e.topic === 'contact:openForm' && (e.payload as { callId: number }).callId === 55);
    expect(form).toBeDefined();
    expect(rig.events.length).toBeGreaterThanOrEqual(before);
  });

  it('keeps at most 8 contacts open and drops the least recently used idle one', () => {
    const persons: number[] = [];
    for (let p = 5000; persons.length < 9; p++) if (!rig.npc.isActivePerson(p) && rig.mgr.contactOfPerson(p) < 0) persons.push(p);
    const ids = persons.map((p) => {
      const a = rig.spawn(p);
      const id = rig.mgr.open({ kind: 'actor', actorId: a }, incident(key('M')), rig.time());
      rig.step();
      return id;
    });
    expect(ids.every((i) => i > 0)).toBe(true);
    expect(rig.mgr.serialize().contacts.length).toBeLessThanOrEqual(8);
    expect(rig.mgr.active).toBe(ids[8]);
    // The oldest idle contact was dropped to make room.
    expect(rig.mgr.contactOfPerson(persons[0] as number)).toBe(-1);
    expect(rig.mgr.contactOfPerson(persons[8] as number)).toBe(ids[8]);
  });

  it('cannot open a hidden actor, an animal or an unknown target', () => {
    const pid = findPerson(rig, (p) => !rig.npc.isActivePerson(p) && rig.mgr.contactOfPerson(p) < 0, 9000);
    const hidden = rig.spawn(pid, { hidden: true, profile: 'suspectCalm' });
    expect(rig.mgr.open({ kind: 'actor', actorId: hidden }, null, rig.time())).toBe(-1);
    expect(rig.mgr.open({ kind: 'actor', actorId: 99999 }, null, rig.time())).toBe(-1);
    expect(rig.mgr.open({ kind: 'occupant', vehicleId: 999999, seat: 3 }, null, rig.time())).toBe(-1);
    expect(rig.mgr.open({ kind: 'ped', slot: 4 }, null, rig.time())).toBe(-1);
  });

  it('uses the resolver when no incident is given', () => {
    const pid = findPerson(rig, (p) => !rig.npc.isActivePerson(p) && rig.mgr.contactOfPerson(p) < 0, 12000);
    const k = key('R');
    rig.mgr.setResolver({ resolveIncident: () => incident(k, { callId: 9, role: 'witness' }) });
    const a = rig.spawn(pid);
    const id = rig.mgr.open({ kind: 'actor', actorId: a }, null, rig.time());
    const entry = rig.mgr.serialize().contacts.find((c) => c.id === id);
    expect(entry?.incident).toBe(k);
    expect(entry?.callId).toBe(9);
    expect(entry?.role).toBe('witness');
    rig.mgr.setResolver({ resolveIncident: () => null });
  });
});
