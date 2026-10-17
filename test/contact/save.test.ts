import { beforeAll, describe, expect, it } from 'vitest';
import { emptyContactSave, isContactSave } from '../../src/contact/save';
import type { ContactSave } from '../../src/contact/types';
import { DT, entryOf, findPerson, incident, key, makeRig, type ContactRig } from './helpers';

let rig: ContactRig;
beforeAll(async () => {
  rig = await makeRig();
});

function fresh(ok: (id: number) => boolean, from: number): number {
  return findPerson(rig, (p) => !rig.npc.isActivePerson(p) && rig.mgr.contactOfPerson(p) < 0 && ok(p), from);
}

function foreign(from: number): number {
  return fresh((p) => {
    const i = rig.people.identity(p);
    return i.language.english === 'none' && i.hearing === 'normal' && !i.dementia && !i.juvenile;
  }, from);
}

describe('save and restore', () => {
  it('continues a conversation identically after a restore with a delayed answer on its way', () => {
    const pid = foreign(0);
    const actor = rig.spawn(pid);
    const k = key('SV');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k, { callId: 5 }), rig.time());
    rig.mgr.request({ kind: 'commMode', contactId: id, mode: 'translationApp' });
    rig.step();
    rig.mgr.request({ kind: 'say', contactId: id, utteranceId: 'askAccount', tone: 'polite' });
    rig.step();
    rig.advance(1);
    const mid = JSON.parse(JSON.stringify(rig.mgr.serialize())) as ContactSave;
    expect(entryOf(mid, pid).pending).toHaveLength(1);
    expect(isContactSave(mid)).toBe(true);
    const snap = { people: rig.people.serialize(), npc: rig.npc.serialize(), sim: rig.clock.sim, game: rig.clock.game };

    const run = (): { contact: ContactSave; people: unknown; events: unknown[]; lines: unknown[]; requests: unknown[] } => {
      const ev = rig.events.length;
      const ln = rig.lines.length;
      const rq = rig.requests.length;
      rig.advance(7);
      return { contact: rig.mgr.serialize(), people: rig.people.serialize(), events: rig.events.slice(ev), lines: rig.lines.slice(ln), requests: rig.requests.slice(rq) };
    };
    const a = run();
    expect(entryOf(a.contact, pid).pending).toHaveLength(0);
    expect(a.lines.length).toBeGreaterThan(0);

    // Rewind the world to the snapshot and restore the conversation.
    rig.people.restore(snap.people);
    rig.npc.restore(snap.npc);
    rig.mgr.restore(mid);
    rig.clock.sim = snap.sim;
    rig.clock.game = snap.game;
    expect(rig.mgr.view(id)?.busy).toBe(true);
    const b = run();
    expect(b.contact).toEqual(a.contact);
    expect(b.people).toEqual(a.people);
    expect(b.events).toEqual(a.events);
    expect(b.lines).toEqual(a.lines);
    expect(b.requests).toEqual(a.requests);
    expect(rig.mgr.view(id)?.busy).toBe(false);
  });

  it('round-trips through JSON and keeps ids, the active contact and the transcript', () => {
    const pid = fresh((p) => !rig.people.identity(p).juvenile, 20000);
    const actor = rig.spawn(pid);
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('SV')), rig.time());
    rig.mgr.request({ kind: 'say', contactId: id, utteranceId: 'greet', tone: 'polite' });
    rig.step();
    const text = JSON.stringify(rig.mgr.serialize());
    const save = JSON.parse(text) as ContactSave;
    expect(isContactSave(save)).toBe(true);
    const other = rig.manager(3);
    other.restore(save);
    expect(other.active).toBe(rig.mgr.active);
    expect(other.contactOfPerson(pid)).toBe(id);
    expect(JSON.stringify(other.serialize().contacts)).toBe(JSON.stringify(save.contacts));
    expect(other.view(id)?.transcript).toEqual(rig.mgr.view(id)?.transcript);
    // New contacts continue the id sequence.
    const p2 = fresh((p) => !rig.people.identity(p).juvenile, 21000);
    const a2 = rig.spawn(p2);
    const id2 = other.open({ kind: 'actor', actorId: a2 }, incident(key('SV')), rig.time());
    expect(id2).toBe(save.nextId);
    other.dispose();
  });

  it('keeps a reopened contact to the story it already told', () => {
    const pid = fresh((p) => !rig.people.identity(p).juvenile && rig.people.identity(p).hearing === 'normal', 22000);
    const actor = rig.spawn(pid);
    const k = key('SV');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
    const rec = rig.records.peekPerson(pid);
    // The person claimed to be somebody else earlier: the facts survive the contact.
    rig.people.addFact(pid, { incident: k, topic: 'identity', value: '-1', source: 'claim', display: 'Pat Nobody, 01/01/1990', detail: '', game: 1 });
    rig.people.addFact(pid, { incident: k, topic: 'name', value: 'PAT NOBODY', source: 'claim', display: 'Pat Nobody', detail: '', game: 1 });
    rig.people.addFact(pid, { incident: k, topic: 'dob', value: '8000', source: 'claim', display: '01/01/1990', detail: '', game: 1 });
    rig.mgr.request({ kind: 'close', contactId: id });
    rig.step();
    expect(rig.mgr.contactOfPerson(pid)).toBe(-1);
    const again = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
    const claim = entryOf(rig.mgr.serialize(), pid).memory.identity;
    expect(claim?.kind).toBe('invented');
    expect(claim?.first).toBe('Pat');
    expect(claim?.last).toBe('Nobody');
    expect(claim?.dob).toBe(8000);
    expect(rig.mgr.view(again)?.title).toContain('Pat Nobody');
    expect(rec.id).toBe(pid);
  });
});

describe('save validation', () => {
  it('accepts a real save and the empty one, rejects malformed ones', () => {
    const pid = fresh((p) => !rig.people.identity(p).juvenile, 23000);
    const actor = rig.spawn(pid);
    rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('SV')), rig.time());
    const real = JSON.parse(JSON.stringify(rig.mgr.serialize())) as ContactSave;
    expect(isContactSave(real)).toBe(true);
    expect(isContactSave(emptyContactSave())).toBe(true);
    const clone = (): ContactSave => JSON.parse(JSON.stringify(real)) as ContactSave;
    expect(isContactSave(null)).toBe(false);
    expect(isContactSave({ ...clone(), version: 2 })).toBe(false);
    expect(isContactSave({ ...clone(), nextId: 0 })).toBe(false);
    expect(isContactSave({ ...clone(), contacts: 'x' })).toBe(false);
    const dup = clone();
    dup.contacts.push(dup.contacts[0] as ContactSave['contacts'][number]);
    expect(isContactSave(dup)).toBe(false);
    const bad = clone();
    (bad.contacts[0] as unknown as { memory: unknown }).memory = { rapport: 'x' };
    expect(isContactSave(bad)).toBe(false);
    const badMode = clone();
    (badMode.contacts[0] as unknown as { commMode: string }).commMode = 'telepathy';
    expect(isContactSave(badMode)).toBe(false);
    const badSfst = clone();
    (badSfst.contacts[0] as unknown as { sfst: unknown }).sfst = { version: 1 };
    expect(isContactSave(badSfst)).toBe(false);
    const badRng = clone();
    (badRng as unknown as { rng: unknown }).rng = { seed: 1, s: [1, 2, 3] };
    expect(isContactSave(badRng)).toBe(false);
    // A malformed save leaves the manager untouched.
    const before = JSON.stringify(rig.mgr.serialize());
    rig.mgr.restore(dup);
    expect(JSON.stringify(rig.mgr.serialize())).toBe(before);
  });

  it('accepts a save written without the optional fields', () => {
    const real = JSON.parse(JSON.stringify(rig.mgr.serialize())) as ContactSave;
    delete real.rng;
    for (const e of real.contacts) {
      delete e.flags;
      delete e.found;
    }
    expect(isContactSave(real)).toBe(true);
    const m = rig.manager(9);
    m.restore(real);
    expect(m.serialize().contacts.length).toBe(real.contacts.length);
    m.dispose();
  });
});

describe('performance', () => {
  it('an idle step costs well under 0.01 ms and an utterance well under 0.5 ms', () => {
    const idle = rig.manager(1);
    const t = rig.time();
    for (let i = 0; i < 2000; i++) idle.step(DT, t);
    let start = performance.now();
    for (let i = 0; i < 50000; i++) idle.step(DT, t);
    expect((performance.now() - start) / 50000).toBeLessThan(0.01);
    idle.dispose();

    const pid = fresh((p) => !rig.people.identity(p).juvenile && rig.people.identity(p).hearing === 'normal', 30000);
    const actor = rig.spawn(pid);
    const m = rig.manager(2);
    const id = m.open({ kind: 'actor', actorId: actor }, incident(key('P')), rig.time());
    const utterances = ['greet', 'explainReason', 'askDestination', 'askDrinking', 'requestId'];
    for (let i = 0; i < 20; i++) {
      m.request({ kind: 'say', contactId: id, utteranceId: utterances[i % utterances.length] as string, tone: 'neutral' });
      m.step(DT, rig.time());
    }
    start = performance.now();
    const n = 200;
    for (let i = 0; i < n; i++) {
      m.request({ kind: 'say', contactId: id, utteranceId: utterances[i % utterances.length] as string, tone: 'neutral' });
      m.step(DT, rig.time());
    }
    expect((performance.now() - start) / n).toBeLessThan(0.5);
    m.dispose();
  });
});
