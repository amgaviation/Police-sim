import { describe, expect, it } from 'vitest';
import type { LegalAssessment } from '../../src/legal/types';
import { action, callInfo, consent, cx, drugs, fact, item, key, Rig, said } from './helpers';

const K = key(7);

/** The scripted DUI stop of the design: violation, stop, odor, PBT with consent, over, cuff, Miranda, question, statement, booking. */
function duiStop(jurisdiction: string): Rig {
  const rig = new Rig({ jurisdiction });
  rig.step();
  rig.world.calls.set(7, callInfo());
  rig.world.roles.set(5, 'driver');
  rig.world.stop = { personId: 5, vehicleId: 3, callId: 7 };
  rig.world.bookings.set('B-0001', { personId: 5, callId: 7, charges: ['TR-360'] });
  rig.bus.emit('investigation:bodycam', { callId: 7, on: true });
  rig.bus.emit('traffic:violation', { eid: 1, vehicleId: 3, kind: 'speeding', x: 0, z: 0, speedMph: 52, limitMph: 35 });
  rig.bus.emit('scene:materialized', { callId: 7 });
  rig.step();
  rig.bus.emit('cad:trafficStop', { active: true, callId: 7, vehicleId: 3 });
  rig.seconds(5);
  said(rig, 7, 5, { fact: 'origin', utteranceId: 'askOrigin' });
  rig.seconds(1);
  fact(rig, 7, 5, { topic: 'drinking', value: 'yes', source: 'evidence', display: 'Odor of alcohol', detail: 'odor of alcohol' });
  rig.seconds(1);
  said(rig, 7, 5, { fact: 'drinking', utteranceId: 'askDrinking' });
  fact(rig, 7, 5, { topic: 'drinking', value: 'yes', source: 'claim', display: 'Says: two beers' });
  rig.seconds(1);
  said(rig, 7, 5, { intent: 'consent', consent: 'pbt', fact: null });
  consent(rig, 7, 5, 'pbt');
  rig.seconds(1);
  fact(rig, 7, 5, { topic: 'drinking', value: 'heavy', source: 'evidence', display: 'Breath test 0.110', detail: 'PBT 0.110' });
  action(rig, 7, 5, 'pbt', { result: 'over' });
  rig.seconds(2);
  action(rig, 7, 5, 'cuff', { result: 'ok', custody: true });
  rig.seconds(1);
  rig.bus.emit('contact:miranda', { ...cx(7, 5), result: 'waived', custody: true, sim: rig.sim });
  rig.seconds(1);
  said(rig, 7, 5, { fact: 'drinking', utteranceId: 'askDrinking', custody: true });
  fact(rig, 7, 5, { topic: 'drinking', value: 'heavy', source: 'claim', display: 'Says: six beers' });
  rig.seconds(3);
  rig.bus.emit('cad:documentSaved', { id: 'B-0001', kind: 'booking', final: true });
  rig.seconds(1);
  rig.bus.emit('scene:outcome', { outcome: { callId: 7, disposition: 'R', outcomeId: 'arrest' } as never });
  rig.step(2);
  return rig;
}

describe.each(['generic', 'strict'])('scripted DUI stop under %s', (jurisdiction) => {
  const rig = duiStop(jurisdiction);
  const a = rig.sys.assessment(K) as LegalAssessment;

  it('records the whole sequence in order', () => {
    expect(rig.kinds(K)).toEqual([
      'start', 'person', 'indicator', 'detention', 'question', 'indicator', 'question', 'statement', 'indicator', 'consent', 'test',
      'indicator', 'arrest', 'miranda', 'question', 'statement', 'indicator', 'charges', 'close',
    ]);
    const kinds = rig.kinds(K);
    expect(kinds.indexOf('indicator')).toBeLessThan(kinds.indexOf('detention'));
    const test = rig.of(K, 'test')[0];
    const bac = rig.of(K, 'indicator').find((i) => i.indicator === 'bacOver');
    expect(bac?.sourceEvent).toBe(test?.id);
    expect((bac?.id ?? 0) > (test?.id ?? 99)).toBe(true);
    expect(rig.of(K, 'detention').map((d) => d.how)).toEqual(['trafficStop']);
    expect(rig.of(K, 'arrest').map((x) => x.how)).toEqual(['cuff']);
    expect(rig.of(K, 'charges')[0]?.statutes).toEqual(['TR-360']);
    expect(rig.log(K).closed).toBe(true);
  });

  it('is lawful throughout', () => {
    expect(a.rulesetId).toBe(jurisdiction);
    expect(a.determinations.filter((d) => d.outcome !== 'lawful')).toEqual([]);
    expect(a.summary).toMatchObject({ unlawful: 0, questionable: 0, suppressed: 0, excessiveForce: 0, score: 100 });
    const p = a.persons.find((x) => x.personId === 5);
    expect(p).toMatchObject({ detained: true, detentionLawful: true, arrested: true, arrestLawful: true, arrestOffense: 'dui' });
    expect(a.evidence.every((e) => e.admissible)).toBe(true);
    expect(a.evidence.map((e) => e.kind).sort()).toEqual(['statement', 'statement', 'test']);
    expect(rig.closed).toHaveLength(1);
    expect(rig.closed[0]).toMatchObject({ key: K, unlawful: 0, score: 100 });
  });

  it('offers a report with the arrest and its probable cause as true key facts', () => {
    const choices = rig.sys.reportChoices(K);
    expect(choices.some((c) => c.id === 'arrest:5' && c.truth === 'true' && c.key)).toBe(true);
    expect(choices.some((c) => c.id === 'pc:5:dui' && c.truth === 'true' && c.key)).toBe(true);
    expect(choices.some((c) => c.id === 'consent:pbt:5' && c.truth === 'true')).toBe(true);
    expect(choices.filter((c) => c.truth === 'false').every((c) => !c.key)).toBe(true);
  });
});

describe('judged conduct', () => {
  it('a frisk without reasonable suspicion evaluates unlawful and suppresses what it finds', () => {
    const rig = new Rig();
    rig.step();
    rig.bus.emit('investigation:bodycam', { callId: 0, on: true });
    const fc = 'FC-5-1';
    said(rig, 0, 5, { ...cx(0, 5, 'suspect', fc), fact: 'origin' });
    rig.seconds(1);
    action(rig, 0, 5, 'frisk', { ...cx(0, 5, 'suspect', fc), items: [item('i1')] });
    rig.sys.request({ kind: 'close', key: fc });
    rig.step(2);
    const a = rig.sys.assessment(fc) as LegalAssessment;
    const frisk = a.determinations.find((d) => d.doctrine === 'frisk');
    expect(frisk).toMatchObject({ outcome: 'unlawful', ruleIds: ['GS-2.1'] });
    expect(a.evidence).toHaveLength(1);
    expect(a.evidence[0]).toMatchObject({ ref: 'i1', admissible: false });
    expect(rig.closed[0]).toMatchObject({ key: fc, unlawful: 1, score: 85 });
  });

  it('an unsupported stop taints the consent search that follows (fruit of the poisonous tree)', () => {
    const rig = new Rig();
    rig.step();
    rig.world.calls.set(7, callInfo({ family: 'investigation', typeId: 'checkOnPerson' }));
    rig.world.roles.set(5, 'suspect');
    rig.bus.emit('investigation:bodycam', { callId: 7, on: true });
    rig.bus.emit('scene:materialized', { callId: 7 });
    rig.step();
    said(rig, 7, 5, { intent: 'command', command: 'stop', outcome: 'comply', fact: null });
    rig.seconds(1);
    consent(rig, 7, 5, 'searchPerson');
    action(rig, 7, 5, 'searchPerson', { items: [drugs('d1')] });
    const a = rig.sys.assessment(K) as LegalAssessment;
    expect(a.determinations.find((d) => d.doctrine === 'detention')).toMatchObject({ outcome: 'unlawful', ruleIds: ['GS-1.1'] });
    expect(a.evidence[0]).toMatchObject({ ref: 'd1', admissible: false, ruleIds: ['GS-12.2', 'GS-12.1'] });
  });

  it('questioning in custody without a warning suppresses the statement; a waiver admits it', () => {
    const run = (waive: boolean): LegalAssessment => {
      const rig = new Rig();
      rig.step();
      rig.world.calls.set(7, callInfo());
      rig.bus.emit('investigation:bodycam', { callId: 7, on: true });
      rig.bus.emit('scene:materialized', { callId: 7 });
      rig.step();
      rig.world.contact = K;
      rig.bus.emit('dispatch:personResult', {
        callsign: 'A-12', via: 'radio',
        readback: { personId: 5, name: 'DOE, J', dob: '', dl: '', dlStatus: '', hits: ['WARRANT: THEFT - CITY - BAIL $500'], severity: 'alert' },
      });
      action(rig, 7, 5, 'cuff', { result: 'ok', custody: true });
      rig.seconds(1);
      if (waive) rig.bus.emit('contact:miranda', { ...cx(7, 5), result: 'waived', custody: true, sim: rig.sim });
      rig.seconds(1);
      said(rig, 7, 5, { fact: 'drugs', custody: true });
      fact(rig, 7, 5, { topic: 'drugs', value: 'yes', source: 'claim', display: 'Says: has a baggie' });
      return rig.sys.assessment(K) as LegalAssessment;
    };
    const bad = run(false).evidence.find((e) => e.kind === 'statement');
    expect(bad).toMatchObject({ admissible: false });
    expect(bad?.ruleIds[0]).toBe('GS-7.1');
    expect(run(true).evidence.find((e) => e.kind === 'statement')?.admissible).toBe(true);
  });

  it('a fellow officer striking a restrained subject: the officer must intervene', () => {
    const run = (intervene: boolean): LegalAssessment => {
      const rig = new Rig();
      rig.step();
      rig.world.calls.set(7, callInfo());
      rig.bus.emit('investigation:bodycam', { callId: 7, on: true });
      rig.bus.emit('scene:materialized', { callId: 7 });
      rig.step();
      rig.bus.emit('force:other', {
        seq: 4, officer: 'Officer Hale', level: 'hardHands', personId: 5, actorId: 1, callId: 7, resistance: 'compliant', restrained: true,
        distanceToOfficer: 5, injury: 0.1, sim: rig.sim,
      });
      rig.seconds(2);
      if (intervene) rig.bus.emit('force:intervened', { otherSeq: 4, personId: 5, callId: 7, sim: rig.sim });
      return rig.sys.assessment(K) as LegalAssessment;
    };
    const failed = run(false);
    expect(failed.determinations.find((d) => d.doctrine === 'intervene')).toMatchObject({ outcome: 'unlawful', ruleIds: ['GS-9.1'] });
    expect(failed.force[0]).toMatchObject({ other: true, verdict: 'excessive' });
    expect(run(true).determinations.find((d) => d.doctrine === 'intervene')).toMatchObject({ outcome: 'lawful' });
  });

  it('actions without a recording body camera are a recording violation', () => {
    const rig = new Rig();
    rig.step();
    rig.world.calls.set(7, callInfo());
    rig.bus.emit('scene:materialized', { callId: 7 });
    said(rig, 7, 5, { fact: 'origin' });
    rig.seconds(30);
    action(rig, 7, 5, 'frisk', { items: [] });
    const a = rig.sys.assessment(K) as LegalAssessment;
    expect(a.determinations.some((d) => d.doctrine === 'recording' && d.outcome === 'unlawful')).toBe(true);
  });

  it('a lawful use of force is judged live and in the assessment under the active ruleset', () => {
    const rig = new Rig();
    rig.step();
    rig.world.calls.set(7, callInfo());
    rig.bus.emit('investigation:bodycam', { callId: 7, on: true });
    rig.bus.emit('scene:materialized', { callId: 7 });
    rig.step();
    const send = (): void =>
      rig.bus.emit('force:applied', {
        seq: 1, tool: 'taser', level: 'taser', personId: 5, actorId: 1, callId: 7, resistance: 'active', hit: true, injury: 0, fatal: false,
        cycle: 1, riskFactors: [], distance: 4, restrained: false, sim: rig.sim,
      });
    send();
    expect(rig.verdicts[0]?.text).toBe('TASER on active resistance: within policy (GS-8.1)');
    expect(rig.sys.assessment(K)?.force[0]?.verdict).toBe('justified');
    rig.sys.request({ kind: 'jurisdiction', id: 'strict' });
    rig.step();
    send();
    expect(rig.verdicts[1]?.verdict).toBe('questionable');
    expect(rig.sys.assessment(K)?.force.map((f) => f.verdict)).toEqual(['questionable', 'questionable']);
  });
});
