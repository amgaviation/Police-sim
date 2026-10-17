import { beforeAll, describe, expect, it } from 'vitest';
import type { DialogueResult, IdentityClaim, SubjectMemory } from '../../src/dialogue';
import type { ContactActionId } from '../../src/contact/types';
import { dlNumberOf, personIdFromDl } from '../../src/records/ids';
import { SEED, answer, claimOf, findPerson, incident, inject, key, makeRig, patch, type ContactRig } from './helpers';

let rig: ContactRig;
beforeAll(async () => {
  rig = await makeRig();
});

function fresh(ok: (id: number) => boolean, from: number): number {
  return findPerson(rig, (p) => !rig.npc.isActivePerson(p) && rig.mgr.contactOfPerson(p) < 0 && ok(p), from);
}

/** A delivered identity statement (what the dialogue engine would have produced). */
function identityAnswer(claim: IdentityClaim): (m: SubjectMemory) => DialogueResult {
  return (m) => {
    m.identity = claim;
    return answer(m, {
      lineKey: claim.document === 'none' ? 'requestId.lieVerbal' : 'requestId.handFake',
      statement: { fact: 'identity', value: String(claim.personId), display: `${claim.first} ${claim.last}`, truthful: false, confused: false },
      identity: claim,
    });
  };
}

function adult(p: number): boolean {
  const i = rig.people.identity(p);
  return !i.juvenile && i.age < 60;
}

function action(id: number, a: ContactActionId): void {
  rig.mgr.request({ kind: 'action', contactId: id, action: a });
  rig.step();
}

describe('lie detection end to end', () => {
  it('an altered date of birth shows as an inconsistency only after the name is run', () => {
    const pid = fresh(adult, 100);
    const actor = rig.spawn(pid);
    const k = key('A');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
    const rec = rig.records.peekPerson(pid);
    const claim = claimOf(rec.first, rec.last, rec.dob + 900, { kind: 'alteredDob', personId: pid, address: rec.address });
    inject(rig, pid, identityAnswer(claim));
    // The claim alone contradicts nothing the player knows.
    expect(rig.mgr.inconsistencies(k, pid)).toHaveLength(0);
    expect(rig.mgr.view(id)?.inconsistencies).toHaveLength(0);
    action(id, 'runName');
    const found = rig.mgr.inconsistencies(k, pid);
    expect(found.map((i) => i.ruleId)).toContain('dobVsRecord');
    expect(rig.mgr.view(id)?.inconsistencies.some((n) => n.severity === 'alert' && n.text.includes('date of birth'))).toBe(true);
    expect(rig.events.some((e) => e.flag === 'falseIdentity' && e.personId === pid && e.incident === k)).toBe(true);
    // The lookup went out to dispatch for the warrant check.
    expect(rig.requests.some((r) => r.kind === 'runPerson' && r.personId === pid)).toBe(true);
  });

  it('claiming to be somebody who looks different shows the appearance mismatch only after the lookup', () => {
    const pid = fresh(adult, 3000);
    const rec = rig.records.peekPerson(pid);
    const other = findPerson(
      rig,
      (p) => {
        const r = rig.records.peekPerson(p);
        return p !== pid && r.sex !== rec.sex && !rig.npc.isActivePerson(p);
      },
      4000,
    );
    const orec = rig.records.peekPerson(other);
    const actor = rig.spawn(pid);
    const k = key('B');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
    const claim = claimOf(orec.first, orec.last, orec.dob, { kind: 'relative', personId: other, address: orec.address });
    inject(rig, pid, identityAnswer(claim));
    expect(rig.mgr.inconsistencies(k, pid).map((i) => i.ruleId)).not.toContain('appearanceVsRecord');
    action(id, 'runName');
    const rules = rig.mgr.inconsistencies(k, pid).map((i) => i.ruleId);
    expect(rules).toContain('appearanceVsRecord');
    // Name, date of birth and address are the relative's own record: nothing else contradicts.
    expect(rules).not.toContain('dobVsRecord');
    expect(rules).not.toContain('addressVsRecord');
  });

  it('an invented name with no record is flagged as not on file', () => {
    const pid = fresh(adult, 6000);
    const actor = rig.spawn(pid);
    const k = key('C');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
    inject(rig, pid, identityAnswer(claimOf('Zed', 'Zzqxyw', 7000)));
    action(id, 'runName');
    expect(rig.mgr.inconsistencies(k, pid).map((i) => i.ruleId)).toEqual(['nameNotOnFile']);
    expect(rig.mgr.view(id)?.transcript.at(-1)?.text).toContain('No record for ZED ZZQXYW');
    expect(rig.requests.some((r) => r.kind === 'runPerson' && r.personId === pid)).toBe(false);
  });

  it('a truthful claim stays free of contradictions after the lookup', () => {
    const pid = fresh(adult, 8000);
    const rec = rig.records.peekPerson(pid);
    const actor = rig.spawn(pid);
    const k = key('D');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
    inject(rig, pid, identityAnswer(claimOf(rec.first, rec.last, rec.dob, { kind: 'true', personId: pid, address: rec.address })));
    action(id, 'runName');
    expect(rig.mgr.inconsistencies(k, pid)).toHaveLength(0);
    expect(rig.events.some((e) => e.flag === 'identified' && e.personId === pid)).toBe(true);
  });

  it('a fake ID with another person\'s number or no number on file is caught by running the ID', () => {
    const pid = fresh(adult, 10000);
    const rec = rig.records.peekPerson(pid);
    const holder = findPerson(rig, (p) => p !== pid && rig.records.peekPerson(p).license.number !== '', 20000);
    const actor = rig.spawn(pid);
    const k = key('E');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
    // The card says the subject's own name but carries somebody else's number.
    inject(rig, pid, identityAnswer(claimOf(rec.first, rec.last, rec.dob, { kind: 'alteredDob', personId: pid, document: 'fakeId', dlNumber: rig.records.peekPerson(holder).license.number })));
    expect(rig.people.facts(pid, k).some((f) => f.source === 'document' && f.topic === 'idCard')).toBe(true);
    action(id, 'runId');
    expect(rig.mgr.inconsistencies(k, pid).map((i) => i.ruleId)).toContain('idNotOnFile');

    // A made-up number is simply not on file.
    let made = 9999999;
    while (personIdFromDl(SEED, `D${made}`) !== null) made--;
    const other = fresh(adult, 30000);
    const oa = rig.spawn(other);
    const k2 = key('E');
    const id2 = rig.mgr.open({ kind: 'actor', actorId: oa }, incident(k2), rig.time());
    const orec = rig.records.peekPerson(other);
    inject(rig, other, identityAnswer(claimOf(orec.first, orec.last, orec.dob, { kind: 'invented', document: 'fakeId', dlNumber: `D${made}` })));
    action(id2, 'runId');
    const facts = rig.people.facts(other, k2).filter((f) => f.source === 'record' && f.topic === 'idCard');
    expect(facts[0]?.value).toBe('notOnFile');
    expect(rig.mgr.inconsistencies(k2, other).map((i) => i.ruleId)).toContain('idNotOnFile');
  });

  it('a real licence number of the claimed person is consistent', () => {
    const pid = fresh((p) => adult(p) && rig.records.peekPerson(p).license.number !== '', 40000);
    const rec = rig.records.peekPerson(pid);
    const actor = rig.spawn(pid);
    const k = key('F');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
    inject(rig, pid, identityAnswer(claimOf(rec.first, rec.last, rec.dob, { kind: 'true', personId: pid, document: 'dl', dlNumber: dlNumberOf(SEED, pid) })));
    action(id, 'checkId');
    action(id, 'runId');
    expect(rig.mgr.inconsistencies(k, pid)).toHaveLength(0);
    expect(rig.people.facts(pid, k).some((f) => f.source === 'record' && f.topic === 'idCard' && f.value.startsWith('onFile:'))).toBe(true);
  });

  it('a denial of drinking is contradicted by the breath test', () => {
    const pid = fresh(adult, 50000);
    const actor = rig.spawn(pid);
    const k = key('G');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
    // Set after the first contact: no odor was noticed up front.
    rig.people.setIntoxication(pid, 0.12, 'none');
    inject(rig, pid, (m) =>
      answer(m, { lineKey: 'drinking.no', text: 'No.', statement: { fact: 'drinking', value: 'no', display: 'no', truthful: false, confused: false } }),
    );
    expect(rig.mgr.inconsistencies(k, pid)).toHaveLength(0);
    // The test needs consent.
    action(id, 'pbt');
    expect(rig.mgr.view(id)?.transcript.at(-1)?.text).toBe('Needs consent');
    patch(rig.mgr, pid, (e) => {
      e.memory.consent.pbt = 'granted';
    });
    action(id, 'pbt');
    const facts = rig.people.facts(pid, k).filter((f) => f.source === 'evidence' && f.topic === 'drinking');
    expect(facts).toHaveLength(1);
    expect(facts[0]?.value).toBe('heavy');
    expect(rig.mgr.inconsistencies(k, pid).map((i) => i.ruleId)).toEqual(['drinkingDenial']);
    expect(rig.events.filter((e) => e.personId === pid).map((e) => e.flag)).toEqual(expect.arrayContaining(['pbt', 'bacOver']));
    expect(rig.mgr.view(id)?.transcript.some((l) => /^PBT: 0\.1\d\d$/.test(l.text))).toBe(true);
    // Only once.
    action(id, 'pbt');
    expect(rig.people.facts(pid, k).filter((f) => f.topic === 'drinking' && f.source === 'evidence')).toHaveLength(1);
  });

  it('a sober subject who admits nothing wrong stays consistent after the breath test', () => {
    const pid = fresh((p) => adult(p) && rig.people.intoxication(p).bac === 0, 60000);
    const actor = rig.spawn(pid);
    const k = key('H');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
    inject(rig, pid, (m) =>
      answer(m, { lineKey: 'drinking.no', text: 'No.', statement: { fact: 'drinking', value: 'no', display: 'no', truthful: true, confused: false } }),
    );
    patch(rig.mgr, pid, (e) => {
      e.memory.consent.pbt = 'granted';
    });
    action(id, 'pbt');
    expect(rig.mgr.inconsistencies(k, pid)).toHaveLength(0);
    expect(rig.events.some((e) => e.flag === 'bacOver' && e.personId === pid)).toBe(false);
  });

  it('a booking under the true identity contradicts an invented one', () => {
    const pid = fresh(adult, 70000);
    const actor = rig.spawn(pid);
    const k = key('I');
    const id = rig.mgr.open({ kind: 'actor', actorId: actor }, incident(k), rig.time());
    inject(rig, pid, identityAnswer(claimOf('Pat', 'Nobody', 8000)));
    expect(rig.mgr.inconsistencies(k, pid)).toHaveLength(0);
    const doc = rig.cad.docs.create('booking', { personId: pid, charges: ['TR-330'], arrestLocation: 'Main Street' }, rig.time(), 'Officer Hart #4071');
    rig.cad.docs.finalize(doc.id, rig.time());
    rig.step();
    const rules = rig.mgr.inconsistencies(k, pid).map((i) => i.ruleId);
    expect(rules).toContain('identityVsBooking');
    expect(rig.mgr.view(id)?.facts.some((n) => n.text.includes('booking'))).toBe(true);
  });
});
