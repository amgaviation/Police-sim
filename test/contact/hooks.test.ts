import { beforeAll, describe, expect, it } from 'vitest';
import type { ContactActionEvent, ContactFactEvent, ContactMirandaEvent, ContactSaidEvent } from '../../src/contact/events';
import type { ContactActionId } from '../../src/contact/types';
import { DT, entryOf, findPerson, incident, key, makeRig, patch, type ContactRig } from './helpers';

let rig: ContactRig;

/** Every Phase 5 contact event, in emission order. */
type Logged =
  | { topic: 'contact:fact'; e: ContactFactEvent }
  | { topic: 'contact:said'; e: ContactSaidEvent }
  | { topic: 'contact:action'; e: ContactActionEvent }
  | { topic: 'contact:miranda'; e: ContactMirandaEvent }
  | { topic: 'contact:event'; e: { flag: string } };
const log: Logged[] = [];

beforeAll(async () => {
  rig = await makeRig();
  rig.bus.on('contact:fact', (e) => log.push({ topic: 'contact:fact', e: { ...e } }));
  rig.bus.on('contact:said', (e) => log.push({ topic: 'contact:said', e: { ...e } }));
  rig.bus.on('contact:action', (e) => log.push({ topic: 'contact:action', e: { ...e, items: e.items.map((i) => ({ ...i })) } }));
  rig.bus.on('contact:miranda', (e) => log.push({ topic: 'contact:miranda', e: { ...e } }));
  rig.bus.on('contact:event', (e) => log.push({ topic: 'contact:event', e: { flag: e.flag } }));
});

function fresh(ok: (id: number) => boolean, from: number): number {
  return findPerson(rig, (p) => !rig.npc.isActivePerson(p) && rig.mgr.contactOfPerson(p) < 0 && ok(p), from);
}

function standing(from: number, over: Parameters<ContactRig['spawn']>[1] = {}): { pid: number; actor: number } {
  const pid = fresh((p) => !rig.people.identity(p).juvenile && rig.people.itemsOn(p).length === rig.people.identity(p).baseItems.length, from);
  const actor = rig.spawn(pid, over);
  rig.npc.forceState(actor, 'handsUp');
  return { pid, actor };
}

function act(id: number, action: ContactActionId): void {
  rig.mgr.request({ kind: 'action', contactId: id, action });
  rig.step();
}

function say(id: number, utteranceId: string, tone: 'polite' | 'neutral' | 'commanding' | 'aggressive' = 'neutral'): void {
  rig.mgr.request({ kind: 'say', contactId: id, utteranceId, tone });
  rig.step();
}

interface Topics {
  'contact:fact': ContactFactEvent;
  'contact:said': ContactSaidEvent;
  'contact:action': ContactActionEvent;
  'contact:miranda': ContactMirandaEvent;
  'contact:event': { flag: string };
}

/** Events logged since `mark` of one topic. */
function since<T extends keyof Topics>(mark: number, topic: T): Topics[T][] {
  const out: Topics[T][] = [];
  for (const l of log.slice(mark)) if (l.topic === topic) out.push(l.e as Topics[T]);
  return out;
}

function actions(mark: number, action?: string): ContactActionEvent[] {
  return since(mark, 'contact:action').filter((e) => action === undefined || e.action === action);
}

describe('contact:said', () => {
  it('is emitted once per applied utterance with the documented payload', () => {
    const { pid, actor } = standing(100);
    const k = key('S');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k, { callId: 5, role: 'suspect' }), rig.time());
    const mark = log.length;
    say(id, 'greet', 'polite');
    const said = since(mark, 'contact:said');
    expect(said).toHaveLength(1);
    expect(said[0]).toEqual({
      incident: k, callId: 5, personId: pid, role: 'suspect', utteranceId: 'greet', intent: 'greet', topic: 'greeting', fact: null,
      consent: null, command: null, tone: 'polite', outcome: null, custody: false, gunpoint: false, sim: said[0]?.sim,
    });
    expect(said[0]?.sim).toBeGreaterThan(0);
    // An ask carries its fact, a consent request its kind.
    say(id, 'askDrinking', 'neutral');
    say(id, 'consentSearchPerson');
    const more = since(mark, 'contact:said');
    expect(more.map((e) => e.utteranceId)).toEqual(['greet', 'askDrinking', 'consentSearchPerson']);
    expect(more[1]).toMatchObject({ intent: 'ask', fact: 'drinking', topic: 'questions' });
    expect(more[2]).toMatchObject({ intent: 'consent', consent: 'searchPerson' });
  });

  it('is not emitted for an utterance that is not available or while the subject is gone', () => {
    const { actor } = standing(300);
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('S')), rig.time());
    const mark = log.length;
    say(id, 'noSuchUtterance');
    // A requirement-gated utterance (the vehicle questions need a vehicle) is refused.
    say(id, 'askVehicleContents');
    expect(since(mark, 'contact:said')).toHaveLength(0);
  });

  it('commands carry the evaluated outcome, which the actor then follows', () => {
    const outcomes = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const { actor } = standing(500 + i * 200, { profile: i % 2 === 0 ? 'suspectCalm' : 'suspectHostile' });
      const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('C'), { callId: 6 }), rig.time());
      const mark = log.length;
      say(id, 'cmdStop', 'commanding');
      const said = since(mark, 'contact:said');
      expect(said).toHaveLength(1);
      expect(said[0]).toMatchObject({ utteranceId: 'cmdStop', intent: 'command', command: 'stop', topic: 'commands', tone: 'commanding' });
      expect(['comply', 'refuse', 'flee', 'fight', 'confused']).toContain(said[0]?.outcome);
      outcomes.add(said[0]?.outcome ?? '');
      // The utterance event comes before the subject's reply lines / flags caused by it.
      rig.mgr.request({ kind: 'close', contactId: id });
      rig.step();
      rig.npc.removeActor(actor);
    }
    expect(outcomes.has('comply')).toBe(true);
  });

  it('reports gunpoint from the officer weapon and custody after cuffing', () => {
    const { actor } = standing(4000);
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('G')), rig.time());
    rig.presence.value = { ...rig.presence.value, weapon: 'sidearm' };
    let mark = log.length;
    say(id, 'greet');
    expect(since(mark, 'contact:said')[0]).toMatchObject({ gunpoint: true, custody: false });
    rig.presence.value = { ...rig.presence.value, weapon: 'taser' };
    mark = log.length;
    say(id, 'reassure');
    expect(since(mark, 'contact:said')[0]).toMatchObject({ gunpoint: false });
    rig.presence.value = { ...rig.presence.value, weapon: 'none' };
    act(id, 'cuff');
    mark = log.length;
    say(id, 'askName');
    expect(since(mark, 'contact:said')[0]).toMatchObject({ custody: true, gunpoint: false });
  });
});

describe('contact:fact and ordering', () => {
  it('emits each new fact once, after contact:said and before nothing else of that answer', () => {
    const { pid, actor } = standing(6000);
    const k = key('F');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k, { callId: 7, role: 'witness' }), rig.time());
    const mark = log.length;
    say(id, 'askName');
    const slice = log.slice(mark);
    const saidAt = slice.findIndex((l) => l.topic === 'contact:said');
    const factAt = slice.findIndex((l) => l.topic === 'contact:fact' && l.e.topic === 'name');
    expect(saidAt).toBe(0);
    expect(factAt).toBeGreaterThan(saidAt);
    const facts = since(mark, 'contact:fact').filter((f) => f.topic === 'name');
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ incident: k, callId: 7, personId: pid, role: 'witness', source: 'claim' });
    expect(facts[0]?.display).not.toBe('');
    expect(rig.people.facts(pid, k).some((f) => f.topic === 'name' && f.value === facts[0]?.value)).toBe(true);
    // The first observations of the contact (appearance) are facts as well.
    expect(since(0, 'contact:fact').some((f) => f.personId === pid && f.topic === 'appearance' && f.source === 'observation')).toBe(true);
    // Asking again stores the same claim: no second event.
    const before = since(0, 'contact:fact').filter((f) => f.personId === pid && f.topic === 'name').length;
    say(id, 'askName');
    expect(since(0, 'contact:fact').filter((f) => f.personId === pid && f.topic === 'name').length).toBe(before);
  });

  it('a search emits contact:action before the evidence facts are repeated, and facts carry the finding', () => {
    const { pid, actor } = standing(8000);
    rig.people.addItem({ kind: 'person', id: pid }, 'handgun', 'waistband', true);
    const k = key('E');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k, { callId: 8 }), rig.time());
    const mark = log.length;
    act(id, 'frisk');
    const slice = log.slice(mark);
    const factAt = slice.findIndex((l) => l.topic === 'contact:fact' && l.e.topic === 'weapons');
    const actionAt = slice.findIndex((l) => l.topic === 'contact:action' && l.e.action === 'frisk');
    expect(factAt).toBeGreaterThanOrEqual(0);
    expect(actionAt).toBeGreaterThan(factAt);
    expect(slice.filter((l) => l.topic === 'contact:action')).toHaveLength(1);
  });
});

describe('contact:action', () => {
  it('frisk lists the found items with their flags', () => {
    const { pid, actor } = standing(10000);
    rig.people.addItem({ kind: 'person', id: pid }, 'handgun', 'waistband', true);
    const k = key('A');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k, { callId: 9, role: 'suspect', vehicleId: -1 }), rig.time());
    const mark = log.length;
    act(id, 'frisk');
    const ev = actions(mark);
    expect(ev).toHaveLength(1);
    const e = ev[0] as ContactActionEvent;
    expect(e).toMatchObject({ incident: k, callId: 9, personId: pid, role: 'suspect', action: 'frisk', ok: true, vehicleId: -1, result: null, custody: false });
    const gun = e.items.find((i) => i.item === 'handgun');
    expect(gun).toMatchObject({ item: 'handgun', label: 'Handgun', category: 'weapon', weapon: true, incriminating: true });
    expect(gun?.ref.startsWith('p')).toBe(true);
  });

  it('searchPerson, visualCheck and seize report items; seize reports what was seized', () => {
    const { pid, actor } = standing(12000);
    rig.people.addItem({ kind: 'person', id: pid }, 'knife', 'pocket', false);
    rig.people.addItem({ kind: 'person', id: pid }, 'pills', 'pocket', false);
    const k = key('S');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k, { callId: 10 }), rig.time());
    patch(rig.mgr, pid, (e) => {
      e.memory.consent.searchPerson = 'granted';
    });
    let mark = log.length;
    act(id, 'searchPerson');
    const search = actions(mark, 'searchPerson')[0] as ContactActionEvent;
    expect(search.ok).toBe(true);
    expect(search.items.length).toBeGreaterThan(0);
    for (const i of search.items) {
      expect(i.incriminating).toBe(['drugs', 'paraphernalia', 'weapon', 'evidence'].includes(i.category));
    }
    mark = log.length;
    act(id, 'seize');
    const seize = actions(mark, 'seize')[0] as ContactActionEvent;
    expect(seize.ok).toBe(true);
    expect(seize.items.map((i) => i.ref).sort()).toEqual(search.items.map((i) => i.ref).sort());
    // Nothing left now: not offered, so no event.
    mark = log.length;
    act(id, 'seize');
    expect(actions(mark)).toHaveLength(0);
  });

  it('visualCheck of a vehicle reports ok with the items seen', () => {
    rig.place(305);
    rig.step(2);
    const driver = rig.npc.occupantsOf(305)[0] as number;
    rig.people.addItem({ kind: 'vehicle', id: 305 }, 'handgun', 'cabin', true);
    const id = rig.mgr.open({ kind: 'occupant', vehicleId: 305, seat: 0 }, incident(key('V'), { callId: 11, role: 'driver', stop: true, vehicleId: 305 }), rig.time());
    rig.stop.vehicleId = 305;
    const mark = log.length;
    act(id, 'visualCheck');
    const ev = actions(mark, 'visualCheck');
    rig.stop.vehicleId = -1;
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ ok: true, vehicleId: 305, personId: driver });
    expect(Array.isArray(ev[0]?.items)).toBe(true);
    // Runs of the plate and VIN are actions too.
    const mark2 = log.length;
    act(id, 'runPlate');
    act(id, 'checkVin');
    expect(actions(mark2).map((e) => e.action)).toEqual(['runPlate', 'checkVin']);
  });

  it('pbt reports over or under the limit', () => {
    const results: string[] = [];
    for (const [bac, from] of [[0.2, 14000], [0, 14400]] as const) {
      const { pid, actor } = standing(from);
      rig.people.setIntoxication(pid, bac, 'none');
      const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('P'), { callId: 12 }), rig.time());
      patch(rig.mgr, pid, (e) => {
        e.memory.consent.pbt = 'granted';
      });
      const mark = log.length;
      act(id, 'pbt');
      const ev = actions(mark, 'pbt');
      expect(ev).toHaveLength(1);
      expect(ev[0]?.ok).toBe(true);
      results.push(ev[0]?.result ?? '');
    }
    expect(results).toEqual(['over', 'under']);
  });

  it('sfst start is an action; sfstResult follows when the tests finish', () => {
    const { pid, actor } = standing(17500);
    rig.people.setIntoxication(pid, 0.2, 'none');
    rig.npc.forceState(actor, 'hold');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('T'), { callId: 13 }), rig.time());
    patch(rig.mgr, pid, (e) => {
      e.memory.consent.sfst = 'granted';
    });
    const mark = log.length;
    act(id, 'sfst');
    expect(actions(mark).map((e) => [e.action, e.ok, e.result])).toEqual([['sfst', true, null]]);
    for (let i = 0; i < 4000; i++) {
      const v = rig.mgr.sfstView();
      if (!v || v.finished) break;
      const label = v.prompt;
      if (label) rig.mgr.request({ kind: 'sfstKey', key: /\((\w+)\)/.exec(label)?.[1]?.toLowerCase() ?? '' });
      rig.step();
    }
    const done = actions(mark, 'sfstResult');
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ ok: true, personId: pid, callId: 13 });
    expect(['fail', 'pass']).toContain(done[0]?.result);
    // The flag events (sfst, sfstFail) came before the result.
    const slice = log.slice(mark);
    const flagAt = slice.findIndex((l) => l.topic === 'contact:event' && l.e.flag === 'sfst');
    const resAt = slice.findIndex((l) => l.topic === 'contact:action' && l.e.action === 'sfstResult');
    expect(flagAt).toBeGreaterThanOrEqual(0);
    expect(resAt).toBeGreaterThan(flagAt);
    rig.advance(9);
  });

  it('cuff reports ok with custody true, or notReady; uncuff clears custody', () => {
    const { actor } = standing(18000);
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('K'), { callId: 14 }), rig.time());
    let mark = log.length;
    act(id, 'cuff');
    expect(actions(mark)).toEqual([expect.objectContaining({ action: 'cuff', ok: true, result: 'ok', custody: true, items: [] })]);
    mark = log.length;
    act(id, 'uncuff');
    expect(actions(mark)).toEqual([expect.objectContaining({ action: 'uncuff', ok: true, result: null, custody: false })]);
    // A relaxed, unrestrained subject: not ready.
    const calm = rig.spawn(fresh(() => true, 18400), { profile: 'callerHelpful' });
    const cid = rig.mgr.open({ kind: 'actor', actorId: calm }, incident(key('K')), rig.time());
    mark = log.length;
    act(cid, 'cuff');
    expect(actions(mark)).toEqual([expect.objectContaining({ action: 'cuff', ok: false, result: 'notReady', custody: false })]);
  });

  it('a resisting subject reports resist', () => {
    let found: ContactActionEvent | null = null;
    for (let i = 0; i < 80 && !found; i++) {
      const pid = fresh(() => true, 19000 + i * 3);
      const actor = rig.spawn(pid, { profile: 'suspectHostile' });
      const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('R')), rig.time());
      const mark = log.length;
      act(id, 'cuff');
      found = actions(mark, 'cuff').find((e) => e.result === 'resist') ?? null;
      rig.mgr.request({ kind: 'close', contactId: id });
      rig.step();
      rig.npc.removeActor(actor);
    }
    expect(found).not.toBeNull();
    expect(found).toMatchObject({ ok: false, custody: false });
  });

  it('escort, release, warnRelease, citation, checkId, runName, runId and notifyGuardian each emit one action', () => {
    const { pid, actor } = standing(20000);
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('M'), { callId: 15 }), rig.time());
    let mark = log.length;
    act(id, 'escort');
    expect(actions(mark).map((e) => [e.action, e.ok])).toEqual([['escort', true]]);
    mark = log.length;
    act(id, 'stopEscort');
    expect(actions(mark)).toHaveLength(0);
    mark = log.length;
    act(id, 'writeCitation');
    expect(actions(mark).map((e) => e.action)).toEqual(['writeCitation']);
    // Identity actions need a claim.
    patch(rig.mgr, pid, (e) => {
      e.memory.identity = { kind: 'true', personId: pid, first: 'A', middle: '', last: 'B', dob: 1000, address: '1 Test Street', document: 'dl', dlNumber: rig.people.identity(pid).record.license.number };
    });
    mark = log.length;
    act(id, 'checkId');
    act(id, 'runName');
    act(id, 'runId');
    expect(actions(mark).map((e) => [e.action, e.ok])).toEqual([['checkId', true], ['runName', true], ['runId', true]]);
    mark = log.length;
    act(id, 'warnRelease');
    expect(actions(mark).map((e) => [e.action, e.ok])).toEqual([['warnRelease', true]]);
    const { actor: a2 } = standing(21000);
    const id2 = rig.mgr.open({ kind: 'actor', actorId: a2 }, incident(key('M')), rig.time());
    mark = log.length;
    act(id2, 'release');
    expect(actions(mark).map((e) => e.action)).toEqual(['release']);
  });

  it('notifyGuardian emits for a juvenile', () => {
    const pid = fresh((p) => rig.people.identity(p).juvenile, 0);
    const actor = rig.spawn(pid);
    rig.npc.forceState(actor, 'handsUp');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('J')), rig.time());
    const mark = log.length;
    act(id, 'notifyGuardian');
    expect(actions(mark).map((e) => [e.action, e.ok, e.personId])).toEqual([['notifyGuardian', true, pid]]);
  });

  it('an action that is refused emits nothing', () => {
    const { actor } = standing(22000);
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('N')), rig.time());
    const mark = log.length;
    act(id, 'searchPerson'); // needs consent or custody
    act(id, 'checkId'); // no ID card
    act(id, 'runName'); // no name yet
    expect(actions(mark)).toHaveLength(0);
  });
});

describe('contact:miranda', () => {
  it('is emitted with the subject answer and the custody state', () => {
    const results = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const { pid, actor } = standing(24000 + i * 120);
      const k = key('X');
      const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k, { callId: 16 }), rig.time());
      const cuff = i % 2 === 0;
      if (cuff) act(id, 'cuff');
      const mark = log.length;
      say(id, 'miranda');
      rig.advance(8);
      const ev = since(mark, 'contact:miranda');
      const said = since(mark, 'contact:said');
      expect(said.map((e) => e.utteranceId)).toEqual(['miranda']);
      if (ev.length === 0) {
        // Not understood answers still come as 'misunderstood'; silence only for unresponsive people.
        expect(entryOf(rig.mgr.serialize(), pid).memory.miranda).toBeUndefined();
      } else {
        expect(ev).toHaveLength(1);
        expect(ev[0]).toMatchObject({ incident: k, callId: 16, personId: pid, custody: cuff });
        expect(ev[0]?.result).toBe(entryOf(rig.mgr.serialize(), pid).memory.miranda);
        results.add(ev[0]?.result ?? '');
        // The said event precedes the answer event.
        const slice = log.slice(mark);
        expect(slice.findIndex((l) => l.topic === 'contact:said')).toBeLessThan(slice.findIndex((l) => l.topic === 'contact:miranda'));
      }
      rig.mgr.request({ kind: 'close', contactId: id });
      rig.step();
      rig.npc.removeActor(actor);
    }
    expect(results.has('waived')).toBe(true);
    expect(results.has('invoked')).toBe(true);
  });

  it('after an invocation incriminating questions get the silent line and no statement or fact', () => {
    const { pid, actor } = standing(30000);
    const k = key('Y');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
    patch(rig.mgr, pid, (e) => {
      e.memory.mirandized = true;
      e.memory.miranda = 'invoked';
    });
    const mark = log.length;
    say(id, 'askDrinking');
    rig.advance(DT * 600);
    expect(since(mark, 'contact:said')).toHaveLength(1);
    expect(since(mark, 'contact:fact').filter((f) => f.topic === 'drinking' && f.source === 'claim')).toHaveLength(0);
    expect(rig.people.statements(pid, k)).toHaveLength(0);
    expect(rig.mgr.view(id)?.transcript.some((l) => l.speaker === 'subject' && /lawyer/i.test(l.text))).toBe(true);
  });
});
