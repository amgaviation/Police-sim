import { beforeAll, describe, expect, it } from 'vitest';
import type { ContactActionId } from '../../src/contact/types';
import { ACTOR_STATE, type ActorInfo } from '../../src/npc';
import { answer, entryOf, findPerson, incident, inject, key, makeRig, patch, type ContactRig } from './helpers';

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

function say(id: number, utteranceId: string, tone: 'polite' | 'neutral' | 'commanding' | 'aggressive' = 'neutral'): void {
  rig.mgr.request({ kind: 'say', contactId: id, utteranceId, tone });
  rig.step();
}

function act(id: number, action: ContactActionId): void {
  rig.mgr.request({ kind: 'action', contactId: id, action });
  rig.step();
}

const plain = (p: number): boolean => {
  const i = rig.people.identity(p);
  return !i.juvenile && !i.dementia && i.hearing === 'normal' && i.language.english === 'fluent';
};

describe('subtitle label', () => {
  it('never shows the true record name before the person has identified themselves', () => {
    const pid = fresh(plain, 50000);
    const rec = rig.people.identity(pid).record;
    const actor = rig.spawn(pid);
    rig.npc.forceState(actor, 'handsUp');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('LB')), rig.time());
    const before = rig.lines.length;
    say(id, 'greet', 'polite');
    const subject = rig.lines.slice(before).filter((l) => l.speaker === 'subject');
    expect(subject.length).toBeGreaterThan(0);
    for (const l of subject) {
      expect(l.label).toMatch(/^Unknown (male|female), ~\d+$/);
      expect(l.label).not.toContain(rec.last);
    }
  });
});

describe('restrained people', () => {
  it('a cuffed prisoner does not bolt or fight when the dialogue escalates', () => {
    const pid = fresh((p) => !rig.people.identity(p).juvenile, 51000);
    const actor = rig.spawn(pid, { profile: 'suspectHostile' });
    rig.npc.forceState(actor, 'handsUp');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('CF')), rig.time());
    act(id, 'cuff');
    expect(rig.npc.actor(actor, info())?.cuffed).toBe(true);
    inject(rig, pid, (m) => answer(m, { lineKey: 'escalate.flee', text: 'Out of here!', escalate: 'flee' }));
    inject(rig, pid, (m) => answer(m, { lineKey: 'escalate.fight', text: 'Back off!', escalate: 'fight' }));
    const a = rig.npc.actor(actor, info());
    expect(a?.cuffed).toBe(true);
    expect(a?.state).not.toBe(ACTOR_STATE.flee);
    expect(a?.state).not.toBe(ACTOR_STATE.fight);
    rig.npc.forceState(actor, 'flee');
    expect(rig.npc.actor(actor, info())?.cuffed).toBe(true);
  });

  it('an uncuffed subject who bolts closes the dialogue and cannot be talked to', () => {
    const pid = fresh((p) => !rig.people.identity(p).juvenile, 51200);
    const actor = rig.spawn(pid, { profile: 'suspectHostile' });
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('EF')), rig.time());
    expect(rig.mgr.active).toBe(id);
    inject(rig, pid, (m) => answer(m, { lineKey: 'escalate.flee', text: 'Nope!', escalate: 'flee' }));
    expect(rig.mgr.active).toBe(-1);
    expect(rig.npc.actor(actor, info())?.state).toBe(ACTOR_STATE.flee);
    rig.mgr.request({ kind: 'activate', contactId: id });
    rig.step();
    const before = rig.mgr.view(id)?.transcript.length ?? 0;
    say(id, 'greet');
    const last = rig.mgr.view(id)?.transcript.at(-1);
    expect(last?.speaker).toBe('system');
    expect(rig.mgr.view(id)?.transcript.length).toBe(before + 1);
  });
});

describe('talking range', () => {
  it('the dialogue refuses to talk to somebody far away', () => {
    const pid = fresh(plain, 58000);
    const actor = rig.spawn(pid);
    rig.npc.forceState(actor, 'handsUp');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('TR')), rig.time());
    rig.officer.x += 40;
    say(id, 'greet');
    expect(rig.mgr.view(id)?.transcript.at(-1)).toMatchObject({ speaker: 'system', text: 'Too far away to talk.' });
    rig.officer.x -= 40;
  });
});

describe('closing the dialogue', () => {
  it('dismissing keeps consent, found items and flags for the next time', () => {
    const pid = fresh(plain, 52000);
    const actor = rig.spawn(pid);
    rig.npc.forceState(actor, 'handsUp');
    const target = { kind: 'actor', actorId: actor } as const;
    const id = rig.mgr.open(target, incident(key('DM')), rig.time());
    patch(rig.mgr, pid, (e) => {
      e.memory.consent.pbt = 'granted';
      e.memory.consent.sfst = 'denied';
      e.memory.consentAskedAt.sfst = 5;
      e.memory.mirandized = true;
      e.flags = ['frisked'];
      e.found = ['p1:phone:0'];
    });
    rig.mgr.request({ kind: 'dismiss', contactId: id });
    rig.step();
    expect(rig.mgr.active).toBe(-1);
    expect(rig.mgr.contactOfPerson(pid)).toBe(id);
    const again = rig.mgr.open(target, incident(key('DM')), rig.time());
    expect(again).toBe(id);
    const e = entryOf(rig.mgr.serialize(), pid);
    expect(e.memory.consent).toEqual({ pbt: 'granted', sfst: 'denied' });
    expect(e.memory.mirandized).toBe(true);
    expect(e.flags).toContain('frisked');
    expect(e.found).toEqual(['p1:phone:0']);
  });

  it('keeps the liveness phase across a save', () => {
    rig.step(7);
    const saved = rig.mgr.serialize();
    expect(saved.step).toBeGreaterThan(0);
    const other = rig.manager(1);
    other.restore(JSON.parse(JSON.stringify(saved)) as typeof saved);
    expect(other.serialize().step).toBe(saved.step);
    const e = saved.contacts[0];
    if (e) expect(other.serialize().contacts.find((c) => c.id === e.id)?.lastSim).toBe(e.lastSim);
  });
});

describe('field sobriety test escape', () => {
  it('stopping the test frees the dialogue and allows a retry without a result', () => {
    const pid = fresh(plain, 53000);
    rig.people.setIntoxication(pid, 0.2, 'none');
    const actor = rig.spawn(pid);
    rig.npc.forceState(actor, 'hold');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('SA')), rig.time());
    patch(rig.mgr, pid, (e) => {
      e.memory.consent.sfst = 'granted';
    });
    act(id, 'sfst');
    expect(rig.mgr.sfstView()).not.toBeNull();
    expect(rig.mgr.view(id)?.busy).toBe(true);
    rig.mgr.request({ kind: 'sfstAbort' });
    rig.step();
    expect(rig.mgr.sfstView()).toBeNull();
    expect(rig.mgr.view(id)?.busy).toBe(false);
    expect(rig.events.some((e) => e.flag === 'sfst' && e.personId === pid)).toBe(false);
    expect(rig.mgr.view(id)?.actions.find((a) => a.id === 'sfst')?.enabled).toBe(true);
    act(id, 'sfst');
    expect(rig.mgr.sfstView()).not.toBeNull();
    rig.mgr.request({ kind: 'sfstAbort' });
    rig.step();
  });
});

describe('dementia and the language chips', () => {
  it('a confused answer does not mark the subject as speaking limited English', () => {
    const pid = fresh((p) => {
      const i = rig.people.identity(p);
      return i.dementia && i.language.english === 'fluent' && i.hearing === 'normal' && !i.juvenile;
    }, 54000);
    const actor = rig.spawn(pid);
    rig.npc.forceState(actor, 'handsUp');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('DE')), rig.time());
    inject(rig, pid, (m) => answer(m, { lineKey: 'dementia.confused', text: 'Hmm? What was that?', understood: false }));
    expect(rig.mgr.view(id)?.subtitle).not.toContain('Limited English');
    expect(rig.mgr.view(id)?.actions.find((a) => a.id === 'useTranslationApp')?.enabled).toBe(false);
  });
});

describe('field contacts joining a call', () => {
  it('attaching a call re-emits the earned flags with the call id and the new role', () => {
    const pid = fresh(plain, 55000);
    const actor = rig.spawn(pid, { profile: 'suspectCalm', role: 'bystander' });
    rig.npc.forceState(actor, 'handsUp');
    const inc = `FC-${String(pid)}-1`;
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(inc, { callId: 0, role: 'bystander' }), rig.time());
    const from = rig.events.length;
    rig.mgr.attachCall(inc, 77, 'subject');
    const replay = rig.events.slice(from);
    expect(replay.some((e) => e.flag === 'contacted' && e.callId === 77 && e.role === 'subject' && e.personId === pid)).toBe(true);
    act(id, 'cuff');
    expect(rig.events.some((e) => e.flag === 'custody' && e.callId === 77 && e.role === 'subject')).toBe(true);
  });

  it('requesting an interpreter on a field contact asks for a call first', () => {
    const pid = fresh((p) => {
      const i = rig.people.identity(p);
      return i.language.english === 'none' && i.hearing === 'normal' && !i.dementia && !i.juvenile;
    }, 56000);
    const actor = rig.spawn(pid);
    rig.npc.forceState(actor, 'handsUp');
    const inc = `FC-${String(pid)}-2`;
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(inc, { callId: 0 }), rig.time());
    inject(rig, pid, (m) => answer(m, { lineKey: 'foreign.untranslated', text: '(Spanish) ...', understood: false }));
    const before = rig.emitted.length;
    act(id, 'requestInterpreter');
    expect(rig.emitted.slice(before).some((e) => e.topic === 'contact:needsCall')).toBe(true);
    expect(rig.events.some((e) => e.flag === 'interpreterRequested' && e.personId === pid)).toBe(true);
    // The request is repeated for the call once it exists, so the scene can order the interpreter.
    rig.mgr.attachCall(inc, 78, 'subject');
    expect(rig.events.some((e) => e.flag === 'interpreterRequested' && e.callId === 78 && e.personId === pid)).toBe(true);
  });

  it('tells the officer when the requested interpreter arrives', () => {
    const pid = fresh((p) => {
      const i = rig.people.identity(p);
      return i.language.english === 'none' && i.hearing === 'normal' && !i.dementia && !i.juvenile;
    }, 57000);
    const actor = rig.spawn(pid);
    rig.npc.forceState(actor, 'handsUp');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('IA'), { callId: 9 }), rig.time());
    inject(rig, pid, (m) => answer(m, { lineKey: 'foreign.untranslated', text: '(Spanish) ...', understood: false }));
    act(id, 'requestInterpreter');
    const rev = rig.mgr.revision;
    rig.interpreter.available = true;
    rig.step(20);
    expect(rig.mgr.revision).toBeGreaterThan(rev);
    expect(rig.mgr.view(id)?.transcript.some((l) => l.text === 'The interpreter has arrived.')).toBe(true);
    rig.interpreter.available = false;
  });
});

describe('orders that make the subject flee or fight', () => {
  it('close the dialogue so the officer can react', () => {
    let bolted = 0;
    for (let k = 0; k < 40 && bolted < 2; k++) {
      const pid = fresh((p) => plain(p) && !rig.people.identity(p).wanted, 52000 + k * 37);
      const actor = rig.spawn(pid, { profile: 'suspectFleeRisk' });
      const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('CMD')), rig.time());
      say(id, 'cmdHandsUp', 'aggressive');
      rig.advance(4);
      const state = rig.npc.actor(actor, info())?.state;
      if (state === ACTOR_STATE.flee || state === ACTOR_STATE.fight) {
        bolted++;
        expect(rig.mgr.active).not.toBe(id);
      }
      rig.npc.removeActor(actor);
      rig.step();
    }
    expect(bolted).toBeGreaterThan(0);
  });
});
