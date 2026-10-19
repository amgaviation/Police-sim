import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ContactConsentEvent } from '../../src/contact/events';
import { findPerson, incident, key, makeRig, type ContactRig } from './helpers';

let rig: ContactRig;
beforeAll(async () => {
  rig = await makeRig();
});
beforeEach(() => {
  rig.level.building = undefined;
  rig.premises.value = null;
});

/** A calm adult who answers in English (so the dialogue never gets in the way of the consent). */
function talker(from: number): number {
  return findPerson(
    rig,
    (p) => {
      const i = rig.people.identity(p);
      return !i.juvenile && !i.dementia && i.hearing === 'normal' && i.language.english === 'fluent' && !rig.npc.isActivePerson(p) && rig.mgr.contactOfPerson(p) < 0;
    },
    from,
    100000,
  );
}

function consents(): ContactConsentEvent[] {
  return rig.emitted.filter((e) => e.topic === 'contact:consent').map((e) => e.payload as ContactConsentEvent);
}

function say(id: number, utteranceId: string, tone: 'polite' | 'neutral' | 'commanding' | 'aggressive' = 'polite'): void {
  rig.mgr.request({ kind: 'say', contactId: id, utteranceId, tone });
  rig.step();
}

function view(id: number): ReturnType<ContactRig['mgr']['view']> {
  return rig.mgr.view(id);
}

describe('contact:consent', () => {
  it('is emitted for an entry consent with the building and room of the premises', () => {
    const p = talker(100);
    const actor = rig.spawn(p, { profile: 'residentInnocent', role: 'resident', callId: 3 });
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('E'), { callId: 3, role: 'resident' }), rig.time());
    rig.premises.value = { buildingId: 12, authority: true, room: 4 };
    const before = consents().length;
    say(id, 'consentEntry');
    const got = consents().slice(before);
    expect(got).toHaveLength(1);
    const e = got[0] as ContactConsentEvent;
    expect(e.kind).toBe('entry');
    expect(e.buildingId).toBe(12);
    expect(e.room).toBe(4);
    expect(e.personId).toBe(p);
    expect(e.callId).toBe(3);
    expect(e.valid).toBe(true);
    expect(typeof e.granted).toBe('boolean');
    expect(e.incident).toMatch(/^E-\d+$/);
    expect(e.sim).toBeGreaterThan(0);
  });

  it('is emitted for room and premises kinds and also for the Phase 3 kinds (-1 when the premises are unknown)', () => {
    const p = talker(300);
    const actor = rig.spawn(p, { profile: 'residentInnocent', role: 'resident' });
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('E'), { role: 'resident' }), rig.time());
    rig.premises.value = { buildingId: 7, authority: true, room: 2 };
    const before = consents().length;
    say(id, 'consentSearchRoom');
    say(id, 'consentSearchPremises');
    rig.premises.value = null;
    say(id, 'consentPbt');
    const got = consents().slice(before);
    // A denied consent can be asked again only after rapport grows, so the last two kinds are always new.
    expect(got.map((c) => c.kind)).toEqual(['searchRoom', 'searchPremises', 'pbt']);
    expect(got.slice(0, 2).map((c) => [c.buildingId, c.room])).toEqual([[7, 2], [7, 2]]);
    expect(got[2]).toMatchObject({ buildingId: -1, room: -1 });
  });

  it('a person without authority over the premises cannot be asked: no consent, the reason is shown', () => {
    const p = talker(500);
    const actor = rig.spawn(p, { profile: 'residentInnocent', role: 'witness' });
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('E'), { role: 'witness' }), rig.time());
    rig.premises.value = { buildingId: 7, authority: false, room: 2 };
    const before = consents().length;
    const v = view(id);
    const row = v?.topics.flatMap((t) => t.options).find((o) => o.id === 'consentEntry');
    expect(row?.enabled).toBe(false);
    expect(row?.hint).toBe('Not the resident or owner');
    say(id, 'consentEntry');
    expect(consents().length).toBe(before);
    expect(rig.lines.at(-1)?.text).toBe('Not the resident or owner');
    // Without a premises dependency at all the consent is unavailable, too.
    rig.premises.value = null;
    say(id, 'consentSearchRoom');
    expect(consents().length).toBe(before);
  });

  it('a consent that is granted is remembered per kind and offered again as asked', () => {
    // Over a handful of residents the entry consent is granted at least once and denied at least once.
    const outcomes = new Set<boolean>();
    let from = 700;
    for (let i = 0; i < 40 && outcomes.size < 2; i++) {
      const p = talker(from);
      from = p + 1;
      const actor = rig.spawn(p, { profile: 'residentInnocent', role: 'resident' });
      const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('E'), { role: 'resident', guilty: true }), rig.time());
      rig.premises.value = { buildingId: 1, authority: true, room: 0 };
      const before = consents().length;
      say(id, 'consentEntry', 'aggressive');
      const got = consents().slice(before)[0];
      if (got) outcomes.add(got.granted);
      rig.mgr.request({ kind: 'close', contactId: id });
      rig.step();
      rig.npc.removeActor(actor);
    }
    expect(outcomes.size).toBe(2);
  });
});

describe('levels', () => {
  it('cannot open or talk across levels; same level and unknown level work', () => {
    const p = talker(900);
    const actor = rig.spawn(p, { profile: 'residentInnocent', role: 'resident', building: 6 });
    // The officer is outdoors, the subject indoors.
    rig.level.building = -1;
    expect(rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('L')), rig.time())).toBe(-1);
    // Level not reported: no check (Phase 3 behaviour).
    rig.level.building = undefined;
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('L'), { role: 'resident' }), rig.time());
    expect(id).toBeGreaterThan(0);
    rig.mgr.request({ kind: 'close', contactId: id });
    rig.step();
    // Same building: open and talk.
    rig.level.building = 6;
    const id2 = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('L'), { role: 'resident' }), rig.time());
    expect(id2).toBeGreaterThan(0);
    const lines = rig.lines.length;
    say(id2, 'greet');
    expect(rig.lines.slice(lines).some((l) => l.speaker === 'subject')).toBe(true);
    // The officer walks out: the subject is on another level and cannot be reached.
    rig.level.building = -1;
    const after = rig.lines.length;
    say(id2, 'askName');
    expect(rig.lines.slice(after).some((l) => l.speaker === 'subject')).toBe(false);
    expect(rig.lines.slice(after).some((l) => l.text === 'Too far away to talk.')).toBe(true);
    // A pedestrian slot or an occupant is outdoors: unreachable from inside.
    rig.level.building = 6;
    expect(rig.mgr.open({ kind: 'occupant', vehicleId: 3, seat: 0 }, null, rig.time())).toBe(-1);
    expect(rig.mgr.open({ kind: 'ped', slot: 0 }, null, rig.time())).toBe(-1);
  });
});

describe('jailed persons', () => {
  it('can be talked to in the interview room', () => {
    const p = talker(1200);
    rig.people.setCustody(p, 'jailed');
    const actor = rig.spawn(p, { profile: 'suspectCalm', role: 'prisoner', building: 2 });
    rig.level.building = 2;
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(key('J')), rig.time());
    expect(id).toBeGreaterThan(0);
    const lines = rig.lines.length;
    say(id, 'greet');
    expect(rig.lines.slice(lines).some((l) => l.speaker === 'subject')).toBe(true);
    expect(rig.mgr.contactOfPerson(p)).toBe(id);
  });
});
