import { beforeAll, describe, expect, it } from 'vitest';
import type { ContactActionId } from '../../src/contact/types';
import { itemDef } from '../../src/people';
import { DT, findPerson, incident, key, makeRig, patch, type ContactRig } from './helpers';

let rig: ContactRig;
beforeAll(async () => {
  rig = await makeRig();
});

function fresh(ok: (id: number) => boolean, from: number): number {
  return findPerson(rig, (p) => !rig.npc.isActivePerson(p) && rig.mgr.contactOfPerson(p) < 0 && ok(p), from);
}

function act(id: number, action: ContactActionId): void {
  rig.mgr.request({ kind: 'action', contactId: id, action });
  rig.step();
}

function lastSystem(id: number): string {
  const v = rig.mgr.view(id);
  return [...(v?.transcript ?? [])].reverse().find((l) => l.speaker === 'system')?.text ?? '';
}

/** A person standing 1.5 m from the officer with their hands up. */
function standing(from: number, over: Parameters<ContactRig['spawn']>[1] = {}): { pid: number; actor: number } {
  const pid = fresh((p) => !rig.people.identity(p).juvenile && rig.people.itemsOn(p).length === rig.people.identity(p).baseItems.length, from);
  const actor = rig.spawn(pid, over);
  rig.npc.forceState(actor, 'handsUp');
  return { pid, actor };
}

describe('custody', () => {
  it('cuffing a compliant subject sets the custody flag and the person is arrested', () => {
    const { pid, actor } = standing(100);
    const k = key('K');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k, { callId: 4 }), rig.time());
    act(id, 'cuff');
    expect(rig.events.some((e) => e.flag === 'custody' && e.personId === pid && e.callId === 4)).toBe(true);
    expect(rig.people.state(pid).custody).toBe('arrested');
    expect(rig.npc.actor(actor, { id: 0, personId: 0, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false, armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0 })?.cuffed).toBe(true);
    expect(rig.mgr.view(id)?.subtitle).toContain('Cuffed');
    // Not a stop driver: nothing was sent to dispatch.
    expect(rig.requests.some((r) => r.kind === 'stopContact' && r.action === 'arrest')).toBe(false);
    // Uncuffing clears it.
    act(id, 'uncuff');
    expect(rig.people.state(pid).custody).toBe('none');
  });

  it('cuffing the driver of a stop tells dispatch', () => {
    const { actor } = standing(3000);
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('K'), { role: 'driver', stop: true }), rig.time());
    act(id, 'cuff');
    expect(rig.requests.filter((r) => r.kind === 'stopContact' && r.action === 'arrest')).toHaveLength(1);
  });

  it('refuses to cuff somebody who is too far away or not standing still', () => {
    const { pid, actor } = standing(5000);
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('K')), rig.time());
    rig.officer.x += 30;
    act(id, 'cuff');
    expect(lastSystem(id)).toBe('Too far away');
    expect(rig.people.state(pid).custody).toBe('none');
    rig.officer.x -= 30;
  });

  it('escorts a prisoner and cages them: the actor is removed and contact:caged fires', () => {
    const { pid, actor } = standing(7000);
    const k = key('K');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k, { callId: 12 }), rig.time());
    act(id, 'cuff');
    act(id, 'escort');
    expect(rig.mgr.escorting()).toBe(actor);
    // Closing the conversation keeps an escorted prisoner reachable for the cage.
    rig.mgr.request({ kind: 'close', contactId: id });
    rig.step();
    expect(rig.mgr.active).toBe(-1);
    expect(rig.mgr.escorting()).toBe(actor);
    rig.mgr.request({ kind: 'cage', vehicleIndex: 2 });
    rig.step();
    const caged = rig.emitted.find((e) => e.topic === 'contact:caged');
    expect(caged?.payload).toEqual({ personId: pid, vehicleIndex: 2, callId: 12 });
    expect(rig.events.some((e) => e.flag === 'caged' && e.personId === pid)).toBe(true);
    expect(rig.npc.actorOfPerson(pid)).toBe(0);
    expect(rig.people.state(pid).custody).toBe('arrested');
    expect(rig.mgr.escorting()).toBe(0);
    expect(rig.mgr.contactOfPerson(pid)).toBe(-1);
    expect(rig.people.officerHistory(pid).lastOutcome).toBe('arrested');
  });

  it('a cage request without an escorted prisoner does nothing', () => {
    const before = rig.emitted.filter((e) => e.topic === 'contact:caged').length;
    rig.mgr.request({ kind: 'cage', vehicleIndex: 0 });
    rig.step();
    expect(rig.emitted.filter((e) => e.topic === 'contact:caged')).toHaveLength(before);
  });
});

describe('release', () => {
  it('a field release lets the subject leave and records the contact', () => {
    const { pid, actor } = standing(9000);
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('R')), rig.time());
    act(id, 'release');
    expect(rig.events.some((e) => e.flag === 'released' && e.personId === pid)).toBe(true);
    expect(rig.mgr.contactOfPerson(pid)).toBe(-1);
    expect(rig.people.officerHistory(pid).count).toBe(1);
    expect(rig.people.officerHistory(pid).lastOutcome).toBe('released');
  });

  it('warn and release flags the warning and sends the stop warning', () => {
    const { pid, actor } = standing(11000);
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('R'), { stop: true, role: 'driver' }), rig.time());
    act(id, 'warnRelease');
    expect(rig.events.some((e) => e.flag === 'warned' && e.personId === pid)).toBe(true);
    expect(rig.requests.some((r) => r.kind === 'stopContact' && r.action === 'warn')).toBe(true);
    expect(rig.people.officerHistory(pid).lastOutcome).toBe('warned');
  });

  it('releasing a stop sends everybody back into the car and ends the stop once they are seated', () => {
    rig.place(302);
    rig.step(2);
    rig.stop.vehicleId = 302;
    const driver = rig.npc.occupantsOf(302)[0] as number;
    const out = rig.npc.stepOut(302, 0);
    expect(out).toBeGreaterThan(0);
    const k = key('R');
    const id = rig.mgr.open({ kind: 'actor', actorId: out }, incident(k, { role: 'driver', stop: true, vehicleId: 302 }), rig.time());
    const before = rig.requests.length;
    act(id, 'release');
    // Not yet: the driver has to walk back to the door.
    expect(rig.requests.slice(before).some((r) => r.kind === 'stopContact' && r.action === 'release')).toBe(false);
    rig.advance(20);
    expect(rig.npc.isOut(302, 0)).toBe(false);
    expect(rig.requests.slice(before).filter((r) => r.kind === 'stopContact' && r.action === 'release')).toHaveLength(1);
    expect(rig.events.some((e) => e.flag === 'released' && e.personId === driver)).toBe(true);
    expect(rig.mgr.contactOfPerson(driver)).toBe(-1);
    rig.stop.vehicleId = -1;
  });
});

describe('searching', () => {
  it('a frisk finds a visible weapon, seizes it as evidence and records the discovery', () => {
    const { pid, actor } = standing(13000);
    rig.people.addItem({ kind: 'person', id: pid }, 'handgun', 'waistband', true);
    const k = key('F');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k, { callId: 3 }), rig.time());
    const docs = rig.cad.docs.list('evidence').length;
    act(id, 'frisk');
    expect(rig.events.map((e) => e.flag)).toEqual(expect.arrayContaining(['frisked', 'weaponFound', 'itemFound:handgun']));
    expect(rig.people.facts(pid, k).some((f) => f.topic === 'weapons' && f.source === 'evidence' && f.value === 'yes')).toBe(true);
    expect(rig.people.itemsOn(pid).some((i) => i.item === 'handgun')).toBe(false);
    const evidence = rig.cad.docs.list('evidence');
    expect(evidence.length).toBe(docs + 1);
    expect(evidence.at(-1)).toMatchObject({ status: 'final', category: 'weapon', callId: 3 });
    expect(rig.mgr.view(id)?.facts.some((n) => n.text.includes('Handgun'))).toBe(true);
    // A second frisk is not offered.
    expect(rig.mgr.view(id)?.actions.find((a) => a.id === 'frisk')?.enabled).toBe(false);
  });

  it('a search needs consent or custody, then lists and seizes what it finds', () => {
    const { pid, actor } = standing(15000);
    rig.people.addItem({ kind: 'person', id: pid }, 'knife', 'pocket', false);
    rig.people.addItem({ kind: 'person', id: pid }, 'pills', 'pocket', false);
    const k = key('S');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
    act(id, 'searchPerson');
    expect(lastSystem(id)).toBe('Needs consent or custody');
    patch(rig.mgr, pid, (e) => {
      e.memory.consent.searchPerson = 'granted';
    });
    act(id, 'searchPerson');
    const found = rig.people.facts(pid, k).filter((f) => f.source === 'evidence');
    expect(found.length).toBeGreaterThan(0);
    expect(rig.events.some((e) => e.flag === 'searched' && e.personId === pid)).toBe(true);
    const seizable = rig.mgr.view(id)?.actions.find((a) => a.id === 'seize');
    expect(seizable?.enabled).toBe(true);
    const docs = rig.cad.docs.list('evidence').length;
    act(id, 'seize');
    expect(rig.cad.docs.list('evidence').length).toBeGreaterThan(docs);
    expect(rig.mgr.view(id)?.actions.find((a) => a.id === 'seize')?.enabled).toBe(false);
    for (const item of ['knife', 'pills']) {
      const got = found.some((f) => f.display.includes(itemDef(item).label));
      expect(rig.people.itemsOn(pid).some((i) => i.item === item)).toBe(!got);
    }
  });

  it('searches the vehicle with consent and notes the contents', () => {
    rig.place(303);
    rig.step(2);
    const driver = rig.npc.occupantsOf(303)[0] as number;
    rig.people.addItem({ kind: 'vehicle', id: 303 }, 'burglaryTools', 'trunk', false);
    const k = key('V');
    const id = rig.mgr.open({ kind: 'occupant', vehicleId: 303, seat: 0 }, incident(k, { role: 'driver', stop: true, vehicleId: 303 }), rig.time());
    act(id, 'searchVehicle');
    expect(lastSystem(id)).toBe('Needs consent or custody');
    patch(rig.mgr, driver, (e) => {
      e.memory.consent.searchVehicle = 'granted';
    });
    act(id, 'searchVehicle');
    const contents = rig.people.facts(driver, k).filter((f) => f.topic === 'vehicleContents');
    expect(contents.every((f) => f.source === 'evidence' && f.value.startsWith('item:'))).toBe(true);
    expect(contents.length).toBeGreaterThan(0);
    // A look from the stopped car's side works without leaving it.
    rig.stop.vehicleId = 303;
    expect(rig.mgr.view(id)?.actions.find((a) => a.id === 'visualCheck')?.enabled).toBe(true);
    rig.stop.vehicleId = -1;
  });

  it('runs the plate of the stopped car and records the registered owner', () => {
    const id = rig.mgr.contactOfPerson(rig.npc.occupantsOf(303)[0] as number);
    const before = rig.requests.length;
    act(id, 'runPlate');
    const sent = rig.requests.slice(before).find((r) => r.kind === 'runPlate');
    expect(sent).toMatchObject({ kind: 'runPlate', vehicleId: 303 });
    const driver = rig.npc.occupantsOf(303)[0] as number;
    const owner = rig.people.facts(driver).find((f) => f.topic === 'vehicleOwner' && f.source === 'record');
    expect(owner?.value).toMatch(/^owner:\d+$/);
  });
});

describe('field sobriety tests', () => {
  it('runs the three tests with the right keys and records the result', () => {
    const { pid, actor } = standing(17000);
    rig.people.setIntoxication(pid, 0.2, 'none');
    rig.npc.forceState(actor, 'hold');
    const k = key('T');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
    act(id, 'sfst');
    expect(lastSystem(id)).toBe('Needs consent');
    patch(rig.mgr, pid, (e) => {
      e.memory.consent.sfst = 'granted';
    });
    act(id, 'sfst');
    expect(rig.mgr.sfstView()).not.toBeNull();
    expect(rig.mgr.view(id)?.busy).toBe(true);
    for (let i = 0; i < 4000; i++) {
      const v = rig.mgr.sfstView();
      if (!v || v.finished) break;
      const label = v.prompt;
      if (label) {
        const keyName = /\((\w+)\)/.exec(label)?.[1]?.toLowerCase() ?? '';
        rig.mgr.request({ kind: 'sfstKey', key: keyName });
      }
      rig.step();
    }
    const done = rig.mgr.sfstView();
    expect(done?.finished).toBe(true);
    expect(done?.summary).toHaveLength(3);
    expect(rig.events.map((e) => e.flag)).toEqual(expect.arrayContaining(['sfst', 'sfstFail']));
    expect(rig.people.facts(pid, k).some((f) => f.topic === 'drinking' && f.source === 'evidence' && f.detail.includes('HGN'))).toBe(true);
    // The summary lingers, then the panel model disappears.
    rig.advance(9);
    expect(rig.mgr.sfstView()).toBeNull();
    expect(rig.mgr.view(id)?.busy).toBe(false);
  });
});

describe('views', () => {
  it('never show undiscovered items, the truth of an answer or hidden traits', () => {
    const { pid, actor } = standing(19000);
    rig.people.addItem({ kind: 'person', id: pid }, 'brassKnuckles', 'pocket', false);
    rig.people.addItem({ kind: 'person', id: pid }, 'narcotics', 'pocket', false);
    const k = key('Z');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k, { guilty: true }), rig.time());
    for (const u of ['greet', 'explainReason', 'requestId', 'askDrugs', 'askWeapons', 'askDestination']) {
      rig.mgr.request({ kind: 'say', contactId: id, utteranceId: u, tone: 'polite' });
      rig.step();
      rig.advance(7);
    }
    const text = JSON.stringify(rig.mgr.view(id));
    for (const hidden of ['Brass', 'Narcotics', 'knuckles', 'truthful', 'wanted', 'honesty', 'temperament', 'warrant']) expect(text).not.toContain(hidden);
    expect(rig.mgr.serialize().contacts.length).toBeGreaterThan(0);
  });

  it('lists every action with a reason when it is not possible and every topic of the dialogue', () => {
    const { actor } = standing(21000);
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('Z')), rig.time());
    const v = rig.mgr.view(id);
    expect(v?.actions).toHaveLength(22);
    for (const a of v?.actions ?? []) if (!a.enabled) expect(a.hint ?? '').not.toBe('');
    expect(v?.topics.map((t) => t.id)).toEqual(['greeting', 'reason', 'id', 'questions', 'consent', 'commands', 'support', 'miranda', 'closing']);
    expect(v?.topics.flatMap((t) => t.options).length).toBe(42);
    expect(v?.title).toMatch(/^Unknown (male|female), ~\d+ \(Suspect\)$/);
    expect(rig.mgr.view(9999)).toBeNull();
  });

  it('a subject who draws a weapon makes the order to drop it available', () => {
    const pid = fresh((p) => !rig.people.identity(p).juvenile, 23000);
    rig.people.addItem({ kind: 'person', id: pid }, 'handgun', 'waistband', false);
    const actor = rig.spawn(pid, { weapon: 'handgun', profile: 'suspectArmedHostile' });
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('W')), rig.time());
    const option = (): boolean | undefined => rig.mgr.view(id)?.topics.find((t) => t.id === 'commands')?.options.find((o) => o.id === 'cmdDropWeapon')?.enabled;
    expect(option()).toBe(false);
    rig.npc.drawWeapon(actor);
    expect(option()).toBe(true);
  });
});

describe('maintenance', () => {
  it('drops the contact when the person is removed from the world', () => {
    const { pid, actor } = standing(25000);
    rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('G')), rig.time());
    rig.npc.removeActor(actor);
    rig.step(40);
    expect(rig.mgr.contactOfPerson(pid)).toBe(-1);
  });

  it('survives dispose and ignores requests for unknown contacts', () => {
    const m = rig.manager(5);
    m.request({ kind: 'say', contactId: 99, utteranceId: 'greet', tone: 'neutral' });
    m.request({ kind: 'action', contactId: 99, action: 'frisk' });
    m.request({ kind: 'sfstKey', key: 'a' });
    m.request({ kind: 'cage', vehicleIndex: 0 });
    m.step(DT, rig.time());
    expect(m.active).toBe(-1);
    expect(m.sfstView()).toBeNull();
    m.dispose();
  });
});
