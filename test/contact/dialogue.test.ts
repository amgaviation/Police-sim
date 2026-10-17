import { beforeAll, describe, expect, it } from 'vitest';
import { RESPONSES } from '../../src/dialogue';
import { at, newCall } from '../cad/helpers';
import { DT, entryOf, findPerson, incident, key, makeRig, patch, type ContactRig } from './helpers';

let rig: ContactRig;
beforeAll(async () => {
  rig = await makeRig();
});

function fresh(ok: (id: number) => boolean, from: number): number {
  return findPerson(rig, (p) => !rig.npc.isActivePerson(p) && rig.mgr.contactOfPerson(p) < 0 && ok(p), from);
}

function say(id: number, utteranceId: string, tone: 'polite' | 'neutral' | 'commanding' | 'aggressive' = 'neutral'): void {
  rig.mgr.request({ kind: 'say', contactId: id, utteranceId, tone });
  rig.step();
}

describe('identity requests', () => {
  it('a liar gives a false identity: claim facts, statements and the stop licence request with the claimed person', () => {
    const liar = findPerson(
      rig,
      (p) => {
        const i = rig.people.identity(p);
        return (
          i.wanted && i.honesty < 0.5 && !i.juvenile && !i.dementia && i.hearing === 'normal' && i.language.english === 'fluent' &&
          i.family.some((l) => l.relation === 'sibling' || l.relation === 'relative')
        );
      },
      0,
      100000,
    );
    const call = rig.cad.createCall({ ...newCall('trafficStop', 4, 'Stop.'), selfInitiated: true }, at(0));
    const kinds = new Map<string, { claimPersonId: number; incident: string }>();
    for (let seed = 1; seed < 400 && kinds.size < 3; seed++) {
      const m = rig.manager(seed);
      const actor = rig.spawn(liar);
      const k = key('L');
      const id = m.open({ kind: 'actor', actorId: actor }, incident(k, { callId: call.id, role: 'driver', stop: true, guilty: true }), rig.time());
      const before = rig.requests.length;
      m.request({ kind: 'say', contactId: id, utteranceId: 'requestId', tone: 'neutral' });
      m.step(DT, rig.time());
      const e = entryOf(m.serialize(), liar);
      const claim = e.memory.identity;
      if (claim && claim.kind !== 'true' && !kinds.has(claim.kind)) {
        kinds.set(claim.kind, { claimPersonId: claim.personId, incident: k });
        // The claim facts exist, the statement is stored, and the hidden truthfulness stays out of the facts.
        const facts = rig.people.facts(liar, k).filter((f) => f.source === 'claim');
        expect(facts.map((f) => f.topic).sort()).toEqual(['address', 'dob', 'identity', 'name']);
        expect(facts.find((f) => f.topic === 'identity')?.value).toBe(String(claim.personId));
        expect(rig.people.statements(liar, k).some((s) => s.fact === 'identity' && !s.truthful)).toBe(true);
        const licence = rig.requests.slice(before).filter((r) => r.kind === 'stopContact' && r.action === 'license');
        if (claim.personId >= 0) {
          expect(licence).toEqual([{ kind: 'stopContact', action: 'license', personId: claim.personId }]);
        } else {
          expect(licence).toHaveLength(0);
          expect(rig.cad.call(call.id)?.narrative.some((n) => n.text.includes('identified verbally'))).toBe(true);
        }
        if (claim.document !== 'none') expect(rig.people.facts(liar, k).some((f) => f.source === 'document' && f.topic === 'idCard')).toBe(true);
      }
      m.dispose();
      rig.npc.removeActor(actor);
    }
    expect(kinds.has('invented')).toBe(true);
    expect(kinds.has('relative') || kinds.has('alteredDob')).toBe(true);
  });

  it('an honest subject gives the true identity and the document of a carried licence', () => {
    const honest = fresh((p) => {
      const i = rig.people.identity(p);
      return (
        i.honesty > 0.95 && !i.wanted && !i.juvenile && !i.dementia && i.hearing === 'normal' && i.language.english === 'fluent' &&
        i.baseItems.some((it) => it.item === 'driversLicense')
      );
    }, 300);
    for (let seed = 1; seed < 40; seed++) {
      const m = rig.manager(seed);
      const actor = rig.spawn(honest);
      const k = key('H');
      const id = m.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
      m.request({ kind: 'say', contactId: id, utteranceId: 'requestId', tone: 'polite' });
      m.step(DT, rig.time());
      const claim = entryOf(m.serialize(), honest).memory.identity;
      m.dispose();
      rig.npc.removeActor(actor);
      if (!claim) continue; // refused this time
      expect(claim.kind).toBe('true');
      expect(claim.document).toBe('dl');
      expect(rig.people.facts(honest, k).some((f) => f.source === 'document' && f.topic === 'name')).toBe(true);
      expect(rig.events.some((e) => e.flag === 'identified' && e.personId === honest && e.incident === k)).toBe(true);
      return;
    }
    throw new Error('every attempt refused');
  });

  it('asking only the name writes only the name fact', () => {
    const pid = fresh((p) => {
      const i = rig.people.identity(p);
      return i.honesty > 0.95 && !i.wanted && !i.juvenile && !i.dementia && i.hearing === 'normal' && i.language.english === 'fluent';
    }, 600);
    for (let seed = 1; seed < 40; seed++) {
      const m = rig.manager(seed);
      const actor = rig.spawn(pid);
      const k = key('N');
      const id = m.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
      m.request({ kind: 'say', contactId: id, utteranceId: 'askName', tone: 'polite' });
      m.step(DT, rig.time());
      const claim = entryOf(m.serialize(), pid).memory.identity;
      m.dispose();
      rig.npc.removeActor(actor);
      if (!claim) continue;
      const topics = rig.people.facts(pid, k).filter((f) => f.source === 'claim').map((f) => f.topic);
      expect(topics).toEqual(['name']);
      return;
    }
    throw new Error('every attempt refused');
  });
});

describe('questions and stories', () => {
  it('a changed story is flagged only once the second answer differs', () => {
    const pid = fresh((p) => !rig.people.identity(p).juvenile, 1500);
    const actor = rig.spawn(pid);
    const k = key('S');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
    const answer = (value: string): void => {
      patch(rig.mgr, pid, (e) => {
        e.pending.push({
          dueSim: 0,
          result: {
            lineKey: 'ask.lie',
            text: value,
            delayS: 0,
            understood: true,
            statement: { fact: 'account', value, display: value, truthful: false, confused: false },
            identity: null,
            consent: null,
            escalate: null,
            calmed: false,
            memory: e.memory,
          },
        });
      });
      rig.step();
    };
    answer('We were arguing about the bills.');
    expect(rig.mgr.inconsistencies(k, pid)).toHaveLength(0);
    answer('We were arguing about the bills.');
    expect(rig.mgr.inconsistencies(k, pid)).toHaveLength(0);
    answer('Nothing happened at all.');
    const found = rig.mgr.inconsistencies(k, pid);
    expect(found.map((i) => i.ruleId)).toEqual(['storyAccount']);
    expect(rig.mgr.view(id)?.inconsistencies[0]?.text).toContain('Changed their account');
    expect(rig.events.filter((e) => e.flag === 'statement' && e.personId === pid)).toHaveLength(3);
    expect(rig.people.lieFor(pid, k, 'account')).toBe('Nothing happened at all.');
  });

  it('answers a question through the dialogue engine and stores the statement', () => {
    const pid = fresh((p) => {
      const i = rig.people.identity(p);
      return i.honesty > 0.95 && !i.wanted && !i.dementia && i.hearing === 'normal' && i.language.english === 'fluent';
    }, 2500);
    const actor = rig.spawn(pid);
    const k = key('Q');
    for (let seed = 1; seed < 40; seed++) {
      const m = rig.manager(seed);
      const id = m.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
      m.request({ kind: 'say', contactId: id, utteranceId: 'askDestination', tone: 'polite' });
      m.step(DT, rig.time());
      m.dispose();
      const st = rig.people.statements(pid, k);
      if (st.length === 0) continue; // refused
      expect(st[0]?.fact).toBe('destination');
      expect(st[0]?.value).toBe('home');
      expect(st[0]?.truthful).toBe(true);
      expect(rig.people.facts(pid, k).some((f) => f.topic === 'destination' && f.source === 'claim')).toBe(true);
      return;
    }
    throw new Error('every attempt refused');
  });
});

describe('communication barriers', () => {
  it('a deaf subject does not answer aloud; written notes and gestures only show after the player noticed', () => {
    const pid = fresh((p) => {
      const i = rig.people.identity(p);
      return i.hearing === 'deaf' && !i.dementia && i.language.english === 'fluent' && !i.juvenile;
    }, 0);
    const actor = rig.spawn(pid);
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('D')), rig.time());
    // Nothing gives the deafness away before the first attempt.
    let v = rig.mgr.view(id);
    expect(v?.commModes).toEqual(['verbal']);
    expect(v?.subtitle).not.toContain('Deaf');
    // A request for a written mode is accepted by the model (the engine knows), but an unnoticed one stays hidden.
    say(id, 'greet');
    const spoken = rig.lines.filter((l) => l.personId === pid && l.speaker === 'subject');
    expect(spoken).toHaveLength(1);
    expect(RESPONSES.lines.get('deaf.noResponse')).toContain(spoken[0]?.text);
    v = rig.mgr.view(id);
    expect(v?.commModes).toEqual(expect.arrayContaining(['verbal', 'written', 'gesture']));
    expect(v?.subtitle).toContain('Deaf - use written notes');
    // Written notes work, with their 4 s delay.
    rig.mgr.request({ kind: 'commMode', contactId: id, mode: 'written' });
    rig.step();
    say(id, 'greet');
    expect(rig.mgr.view(id)?.busy).toBe(true);
    rig.advance(3.5);
    expect(rig.mgr.view(id)?.busy).toBe(true);
    rig.advance(0.6);
    expect(rig.mgr.view(id)?.busy).toBe(false);
    const last = rig.lines.filter((l) => l.personId === pid && l.speaker === 'subject').pop();
    expect(RESPONSES.lines.get('deaf.noResponse')).not.toContain(last?.text);
  });

  it('refuses a mode the subject does not need', () => {
    const pid = fresh((p) => {
      const i = rig.people.identity(p);
      return i.hearing === 'normal' && i.language.english === 'fluent' && !i.dementia;
    }, 3500);
    const actor = rig.spawn(pid);
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('V')), rig.time());
    rig.mgr.request({ kind: 'commMode', contactId: id, mode: 'written' });
    rig.mgr.request({ kind: 'commMode', contactId: id, mode: 'interpreter' });
    rig.step();
    expect(rig.mgr.view(id)?.commMode).toBe('verbal');
  });

  it('a translation app answer arrives 6 seconds later and the transcript shows a pending line meanwhile', () => {
    const pid = fresh((p) => {
      const i = rig.people.identity(p);
      return i.language.english === 'none' && i.hearing === 'normal' && !i.dementia && !i.juvenile;
    }, 0);
    const actor = rig.spawn(pid);
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('T')), rig.time());
    rig.mgr.request({ kind: 'commMode', contactId: id, mode: 'translationApp' });
    rig.step();
    expect(rig.mgr.view(id)?.commMode).toBe('translationApp');
    say(id, 'greet');
    let v = rig.mgr.view(id);
    expect(v?.busy).toBe(true);
    expect(v?.transcript.at(-1)).toMatchObject({ speaker: 'subject', pending: true });
    // The busy contact refuses new lines.
    say(id, 'explainReason');
    expect(rig.mgr.view(id)?.transcript.filter((l) => l.speaker === 'officer')).toHaveLength(1);
    rig.advance(5.5);
    expect(rig.mgr.view(id)?.busy).toBe(true);
    rig.advance(0.6);
    v = rig.mgr.view(id);
    expect(v?.busy).toBe(false);
    expect(v?.transcript.at(-1)?.pending).toBe(false);
    expect(v?.transcript.at(-1)?.speaker).toBe('subject');
  });

  it('an untranslated answer of a foreign speaker is shown with its language and noticed', () => {
    const pid = fresh((p) => {
      const i = rig.people.identity(p);
      return i.language.english === 'none' && i.hearing === 'normal' && !i.dementia && !i.juvenile;
    }, 1000);
    let noticed = false;
    for (let seed = 1; seed < 60 && !noticed; seed++) {
      const m = rig.manager(seed);
      const actor = rig.spawn(pid);
      const id = m.open({ kind: 'actor', actorId: actor }, incident(key('F')), rig.time());
      m.request({ kind: 'say', contactId: id, utteranceId: 'explainReason', tone: 'neutral' });
      m.step(DT, rig.time());
      const line = rig.lines.filter((l) => l.personId === pid && l.speaker === 'subject').pop();
      if (line && line.language !== 'en') {
        expect(line.language).toBe(rig.people.identity(pid).language.label);
        expect(m.view(id)?.subtitle).toContain(`Speaks ${line.language}`);
        expect(m.view(id)?.commModes).toContain('translationApp');
        noticed = true;
      }
      m.dispose();
      rig.npc.removeActor(actor);
    }
    expect(noticed).toBe(true);
  });
});

describe('consent', () => {
  it('a juvenile cannot consent without a guardian; notifying one makes the consent valid after 30 s', () => {
    const pid = fresh((p) => {
      const i = rig.people.identity(p);
      return i.juvenile && !i.dementia && i.hearing === 'normal' && i.language.english === 'fluent';
    }, 0);
    const actor = rig.spawn(pid);
    rig.npc.forceState(actor, 'handsUp');
    const k = key('J');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
    expect(rig.mgr.view(id)?.subtitle).toContain('Juvenile');
    say(id, 'consentPbt');
    expect(entryOf(rig.mgr.serialize(), pid).memory.consent.pbt).toBeUndefined();
    const reply = rig.lines.filter((l) => l.personId === pid && l.speaker === 'subject').pop();
    expect(RESPONSES.lines.get('consent.needGuardian')).toContain(reply?.text);
    rig.mgr.request({ kind: 'action', contactId: id, action: 'notifyGuardian' });
    rig.step();
    rig.advance(29);
    expect(rig.events.some((e) => e.flag === 'guardianNotified' && e.personId === pid)).toBe(false);
    rig.advance(2);
    expect(rig.events.filter((e) => e.flag === 'guardianNotified' && e.personId === pid)).toHaveLength(1);
    say(id, 'consentPbt');
    expect(entryOf(rig.mgr.serialize(), pid).memory.consent.pbt).toBeDefined();
  });
});

describe('commands', () => {
  it('a seated driver ordered to step out gets an actor at the door and the profile of the role', () => {
    rig.place(301);
    rig.step(2);
    const driver = rig.npc.occupantsOf(301)[0] as number;
    const k = key('X');
    const id = rig.mgr.open({ kind: 'occupant', vehicleId: 301, seat: 0 }, incident(k, { role: 'driver', vehicleId: 301, stop: true }), rig.time());
    // A cooperative, calm subject with strong presence: the compliance roll is as good as certain.
    patch(rig.mgr, driver, (e) => {
      e.memory.rapport = 1;
      e.memory.stress = 0;
    });
    rig.presence.value = { lights: true, siren: false, backup: 3, weapon: 'taser' };
    expect(rig.mgr.view(id)?.topics.find((t) => t.id === 'commands')?.options.find((o) => o.id === 'cmdStepOut')?.enabled).toBe(true);
    say(id, 'cmdStepOut', 'commanding');
    rig.presence.value = { lights: false, siren: false, backup: 0, weapon: 'none' };
    expect(rig.npc.isOut(301, 0)).toBe(true);
    const actor = rig.npc.actorOfPerson(driver);
    expect(actor).toBeGreaterThan(0);
    // The contact follows its subject: frisk is now possible, vehicle checks remain.
    const v = rig.mgr.view(id);
    expect(v?.actions.find((a) => a.id === 'frisk')?.hint).not.toContain('out of the vehicle');
    expect(v?.transcript.some((l) => l.speaker === 'subject' && !l.pending)).toBe(true);
  });
});
