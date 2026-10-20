import { describe, expect, it } from 'vitest';
import { getRuleset } from '../../src/legal/ruleset';
import { evaluateIncident } from '../../src/legal/evaluate';
import { both, dets, drugs, evaluate, gun, LogBuilder, one, rulesetCopy } from './helpers';

/** Suspect with a warrant hit, lawfully arrested at t = 10. Returns the builder and the arrest event id. */
function warrantArrest(): { b: LogBuilder; arrest: number } {
  const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'warrantHit', 'lookup').detain(1);
  const arrest = b.at(10).arrest(1).lastId;
  return { b, arrest };
}

/** Driver arrested for impaired driving (pc 2.1). */
function duiArrest(): LogBuilder {
  const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'flight').indicator(1, 'falseIdentity').detain(1)
    .indicator(1, 'odorAlcohol').indicator(1, 'bacOver', 'test');
  b.at(10).arrest(1);
  return b;
}

describe('search incident to arrest', () => {
  it('a person search 100 s after a lawful arrest is lawful', () => {
    const { b } = warrantArrest();
    b.at(110).search(1, 'person', [drugs()]);
    const { generic, strict } = both(b.build());
    expect(one(generic, 'search')).toMatchObject({ outcome: 'lawful', ruleIds: ['GS-4.1'], basis: 'incidentToArrest' });
    expect(generic.evidence[0]?.admissible).toBe(true);
    expect(one(strict, 'search')).toMatchObject({ outcome: 'lawful', ruleIds: ['SS-4.1'] });
  });

  it('700 s after is outside the generic window; 350 s is outside the strict one', () => {
    const { b } = warrantArrest();
    b.at(710).search(1, 'person', [drugs()]);
    expect(one(evaluate(b.build()), 'search')).toMatchObject({ outcome: 'unlawful', ruleIds: ['GS-12.1'] });

    const { b: b2 } = warrantArrest();
    b2.at(360).search(1, 'person');
    const { generic, strict } = both(b2.build());
    expect(one(generic, 'search').outcome).toBe('lawful');
    expect(one(strict, 'search').outcome).toBe('unlawful');
  });

  it('30 s before a lawful arrest with probable cause: lawful in generic, unlawful in strict', () => {
    const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'warrantHit', 'lookup').detain(1);
    b.at(10).search(1, 'person', [drugs()]);
    b.at(40).arrest(1);
    const { generic, strict } = both(b.build());
    expect(one(generic, 'search')).toMatchObject({ outcome: 'lawful', basis: 'incidentToArrest' });
    expect(one(strict, 'search').outcome).toBe('unlawful');
    expect(strict.evidence[0]?.admissible).toBe(false);
  });

  it('a pre-arrest search without probable cause at that time is not saved by the later arrest', () => {
    const b2 = new LogBuilder().start().person(2, 'suspect').indicator(2, 'flight').detain(2, 'command');
    b2.at(10).search(2, 'person');
    b2.at(20).indicator(2, 'warrantHit', 'lookup').arrest(2);
    expect(one(evaluate(b2.build()), 'search').outcome).toBe('unlawful');
  });

  it('a vehicle search after a cuffed warrant arrest: broad lawful, gant unlawful', () => {
    const { b } = warrantArrest();
    b.at(30).search(1, 'vehicle', [drugs()]);
    const { generic, strict } = both(b.build());
    expect(one(generic, 'search')).toMatchObject({ outcome: 'lawful', ruleIds: ['GS-4.2'], basis: 'incidentToArrest' });
    const s = one(strict, 'search');
    expect(s).toMatchObject({ outcome: 'unlawful', ruleIds: ['SS-4.2', 'SS-12.1'] });
    expect(strict.evidence[0]?.admissible).toBe(false);
  });

  it('a vehicle search after a cuffed impaired-driving arrest is lawful under gant', () => {
    const b = duiArrest();
    b.at(30).search(1, 'vehicle', [drugs()]);
    const a = evaluate(b.build(), 'strict');
    expect(one(a, 'search')).toMatchObject({ outcome: 'lawful', ruleIds: ['SS-4.2'], basis: 'incidentToArrest' });
  });

  it('a gant vehicle search before the person is secured is lawful', () => {
    const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'warrantHit', 'lookup').detain(1);
    b.at(5).search(1, 'vehicle');
    b.at(20).arrest(1);
    const strictNoPre = rulesetCopy('strict', (rs) => { rs.sita.preArrestS = 30; });
    expect(one(evaluateIncident(b.build(), strictNoPre), 'search')).toMatchObject({ outcome: 'lawful', ruleIds: ['SS-4.2'] });
  });

  it('a search after an unlawful arrest is unlawful and its items are fruit of the arrest', () => {
    const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'odorAlcohol').detain(1);
    const arrest = b.at(10).arrest(1).lastId;
    b.at(30).search(1, 'person', [drugs()]);
    const a = evaluate(b.build());
    expect(one(a, 'arrest').outcome).toBe('unlawful');
    expect(one(a, 'search').outcome).toBe('unlawful');
    expect(a.evidence[0]).toMatchObject({ admissible: false, taintedBy: arrest, ruleIds: ['GS-12.2', 'GS-12.1'] });
  });

  it('premises are covered only when the search claims incident to arrest and is within the window', () => {
    const { b } = warrantArrest();
    b.at(60).search(1, 'room', [], { claimedBasis: 'incidentToArrest', buildingId: 4 });
    b.at(70).search(1, 'room', [], { buildingId: 4 });
    const a = evaluate(b.build());
    const [claimed, unclaimed] = dets(a, 'search');
    expect(claimed).toMatchObject({ outcome: 'lawful', ruleIds: ['GS-4.1'] });
    expect(unclaimed?.outcome).toBe('unlawful');
  });
});

describe('automobile exception', () => {
  it('contraband in plain view then a vehicle search without consent or arrest is lawful', () => {
    const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'speeding').detain(1);
    b.at(5).indicator(1, 'contrabandPlainView');
    b.at(10).search(1, 'vehicle', [drugs()]);
    const { generic, strict } = both(b.build());
    expect(one(generic, 'search')).toMatchObject({ outcome: 'lawful', basis: 'automobile', ruleIds: ['GS-4.3'] });
    expect(one(strict, 'search')).toMatchObject({ outcome: 'lawful', basis: 'automobile', ruleIds: ['SS-4.3'] });
  });

  it('odor of cannabis alone is not enough under either ruleset', () => {
    const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'speeding').detain(1);
    b.at(5).indicator(1, 'odorCannabis');
    b.at(10).search(1, 'vehicle');
    const { generic, strict } = both(b.build());
    expect(one(generic, 'search').outcome).toBe('unlawful');
    expect(one(strict, 'search').outcome).toBe('unlawful');
  });

  it('odor of cannabis plus a weapon seen is still below 2.0 for each offense', () => {
    const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'speeding').detain(1);
    b.at(5).indicator(1, 'odorCannabis').indicator(1, 'weaponSeen');
    b.at(10).search(1, 'vehicle');
    expect(one(evaluate(b.build()), 'search').outcome).toBe('unlawful');
  });

  it('is skipped when the ruleset disables it', () => {
    const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'speeding').detain(1);
    b.at(5).indicator(1, 'contrabandPlainView');
    b.at(10).search(1, 'vehicle');
    const off = rulesetCopy('generic', (rs) => { rs.automobile.enabled = false; });
    expect(one(evaluateIncident(b.build(), off), 'search').outcome).toBe('unlawful');
  });

  it('does not apply to a person search', () => {
    const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'speeding').detain(1);
    b.at(5).indicator(1, 'contrabandPlainView');
    b.at(10).search(1, 'person');
    expect(one(evaluate(b.build()), 'search').outcome).toBe('unlawful');
  });
});

describe('consent', () => {
  const driver = (): LogBuilder => new LogBuilder().start().person(1, 'driver').indicator(1, 'speeding').detain(1);

  it('a granted, valid consent supports the search', () => {
    const b = driver();
    b.at(5).consent(1, 'searchVehicle');
    b.at(6).search(1, 'vehicle', [drugs()]);
    const a = evaluate(b.build());
    expect(one(a, 'consent')).toMatchObject({ outcome: 'lawful', ruleIds: ['GS-5.1'], basis: 'searchVehicle' });
    expect(one(a, 'search')).toMatchObject({ outcome: 'lawful', basis: 'consent', ruleIds: ['GS-5.1'] });
    expect(a.evidence[0]?.admissible).toBe(true);
  });

  it('a denied consent leaves the search without a basis', () => {
    const b = driver();
    b.at(5).consent(1, 'searchVehicle', false);
    b.at(6).search(1, 'vehicle', [drugs()]);
    const a = evaluate(b.build());
    expect(dets(a, 'consent')).toHaveLength(0);
    expect(one(a, 'search')).toMatchObject({ outcome: 'unlawful', ruleIds: ['GS-12.1'] });
    expect(a.evidence[0]).toMatchObject({ admissible: false, ruleIds: ['GS-12.1'] });
  });

  it('consent to search the person does not cover the vehicle', () => {
    const b = driver();
    b.at(5).consent(1, 'searchPerson');
    b.at(6).search(1, 'vehicle');
    const s = one(evaluate(b.build()), 'search');
    expect(s).toMatchObject({ outcome: 'unlawful', ruleIds: ['GS-5.2', 'GS-12.1'], reason: 'Consent did not cover the vehicle' });
  });

  it('consent given with a weapon drawn is coerced', () => {
    const b = driver();
    b.at(5).consent(1, 'searchVehicle', true, true, { weaponDrawn: true });
    b.at(6).search(1, 'vehicle');
    const a = evaluate(b.build());
    expect(one(a, 'consent')).toMatchObject({ outcome: 'unlawful', ruleIds: ['GS-5.3'] });
    expect(one(a, 'search').outcome).toBe('unlawful');
  });

  it('too many aggressive lines coerce consent: more than 3 in generic, more than 1 in strict', () => {
    const b = driver();
    b.at(5).consent(1, 'searchVehicle', true, true, { aggressiveLines: 2 });
    b.at(6).search(1, 'vehicle');
    const { generic, strict } = both(b.build());
    expect(one(generic, 'consent').outcome).toBe('lawful');
    expect(one(strict, 'consent')).toMatchObject({ outcome: 'unlawful', ruleIds: ['SS-5.3'] });
    const b2 = driver();
    b2.at(5).consent(1, 'searchVehicle', true, true, { aggressiveLines: 4 });
    expect(one(evaluate(b2.build()), 'consent').ruleIds).toEqual(['GS-5.3']);
  });

  it('an invalid consent (a juvenile) is unlawful', () => {
    const b = driver();
    b.at(5).consent(1, 'searchVehicle', true, false);
    b.at(6).search(1, 'vehicle');
    const a = evaluate(b.build());
    expect(one(a, 'consent')).toMatchObject({ outcome: 'unlawful', ruleIds: ['GS-5.1'] });
    expect(one(a, 'search').outcome).toBe('unlawful');
  });

  it('a room is covered by a premises consent but a premises is not covered by a room consent', () => {
    const b = new LogBuilder().start().person(1, 'resident');
    b.consent(1, 'searchPremises', true, true, { buildingId: 3 });
    b.at(5).search(1, 'room', [], { buildingId: 3 });
    const a = evaluate(b.build());
    expect(one(a, 'search').outcome).toBe('lawful');

    const b2 = new LogBuilder().start().person(1, 'resident');
    b2.consent(1, 'searchRoom', true, true, { buildingId: 3 });
    b2.at(5).search(1, 'premises', [], { buildingId: 3 });
    expect(one(evaluate(b2.build()), 'search').outcome).toBe('unlawful');
  });

  it('a resident consent in a building covers a search by another person id', () => {
    const b = new LogBuilder().start().person(1, 'resident').person(2, 'suspect');
    b.consent(1, 'searchPremises', true, true, { buildingId: 8 });
    b.at(5).search(2, 'container', [], { buildingId: 8 });
    expect(one(evaluate(b.build()), 'search')).toMatchObject({ outcome: 'lawful', basis: 'consent' });
  });
});

describe('exigency and entry', () => {
  it('a premises search with an exigency event is lawful', () => {
    const b = new LogBuilder().start().person(1, 'suspect');
    b.exigency();
    b.at(5).search(1, 'premises', [gun()], { buildingId: 2 });
    const a = evaluate(b.build());
    expect(one(a, 'search')).toMatchObject({ outcome: 'lawful', basis: 'exigency', ruleIds: ['GS-6.1'] });
    expect(a.evidence[0]?.admissible).toBe(true);
  });

  it('the same search without an exigency is unlawful', () => {
    const b = new LogBuilder().start().person(1, 'suspect');
    b.at(5).search(1, 'premises', [gun()], { buildingId: 2 });
    expect(one(evaluate(b.build()), 'search').outcome).toBe('unlawful');
  });

  it('entry without consent, exigency or a warrant into a private building is unlawful and taints plain view', () => {
    const b = new LogBuilder().start().person(1, 'suspect');
    const entry = b.entry(5, false, 1).lastId;
    const search = b.at(5).search(1, 'room', [drugs()], { claimedBasis: 'plainView', buildingId: 5 }).lastId;
    b.indicator(1, 'contrabandPlainView', 'evidence', search);
    b.at(10).arrest(1);
    const a = evaluate(b.build());
    expect(one(a, 'entry')).toMatchObject({ outcome: 'unlawful', ruleIds: ['GS-6.2'] });
    expect(one(a, 'search')).toMatchObject({ outcome: 'unlawful', ruleIds: ['GS-6.4', 'GS-12.1'] });
    expect(a.evidence[0]).toMatchObject({ admissible: false, taintedBy: entry, ruleIds: ['GS-12.2', 'GS-12.1'] });
    // The tainted plain-view indicator supplies no probable cause.
    expect(one(a, 'arrest').outcome).toBe('unlawful');
  });

  it('plain view from a lawful entry is lawful', () => {
    const b = new LogBuilder().start().person(1, 'suspect');
    b.entry(5, true, 1);
    b.at(5).search(1, 'room', [drugs()], { claimedBasis: 'plainView', buildingId: 5 });
    const a = evaluate(b.build());
    expect(one(a, 'entry')).toMatchObject({ outcome: 'lawful', basis: 'publicPlace' });
    expect(one(a, 'search')).toMatchObject({ outcome: 'lawful', basis: 'plainView', ruleIds: ['GS-6.4'] });
  });

  it('entry with consent, exigency or a search warrant is lawful', () => {
    const consent = new LogBuilder().start().person(1, 'resident').consent(1, 'entry', true, true, { buildingId: 5 });
    consent.at(2).entry(5, false, 1);
    expect(one(evaluate(consent.build()), 'entry')).toMatchObject({ outcome: 'lawful', basis: 'consent', ruleIds: ['GS-5.1'] });

    const exig = new LogBuilder().start().exigency().at(2).entry(5);
    expect(one(evaluate(exig.build()), 'entry')).toMatchObject({ outcome: 'lawful', basis: 'exigency', ruleIds: ['GS-6.1'] });

    const warrant = new LogBuilder().start().warrant('search').at(2).entry(5);
    expect(one(evaluate(warrant.build()), 'entry')).toMatchObject({ outcome: 'lawful', basis: 'warrant' });
  });

  it('consent for a different building does not cover the entry', () => {
    const b = new LogBuilder().start().person(1, 'resident').consent(1, 'entry', true, true, { buildingId: 9 });
    b.at(2).entry(5, false, 1);
    expect(one(evaluate(b.build()), 'entry').outcome).toBe('unlawful');
  });

  it('only the first entry per building is judged', () => {
    const b = new LogBuilder().start().entry(5).at(3).entry(5).at(4).entry(6, true);
    expect(dets(evaluate(b.build()), 'entry')).toHaveLength(2);
  });

  it('a lawful search inside a building with an unlawful entry is still tainted', () => {
    const b = new LogBuilder().start().person(1, 'suspect');
    const entry = b.entry(5, false, 1).lastId;
    b.exigency();
    b.at(3).search(1, 'room', [drugs()], { buildingId: 5 });
    const a = evaluate(b.build());
    expect(one(a, 'search')).toMatchObject({ outcome: 'lawful', basis: 'exigency' });
    expect(a.evidence[0]).toMatchObject({ admissible: false, taintedBy: entry });
  });

  it('a protective sweep after an arrest in the building is lawful', () => {
    const b = new LogBuilder().start().person(1, 'resident').person(2, 'suspect').indicator(2, 'warrantHit', 'lookup');
    b.consent(1, 'entry', true, true, { buildingId: 5 });
    b.at(1).entry(5, false, 1);
    b.at(2).arrest(2);
    b.at(4).search(2, 'room', [], { claimedBasis: 'protectiveSweep', buildingId: 5 });
    b.at(5).search(2, 'room', [], { claimedBasis: 'protectiveSweep', buildingId: 6 });
    const [sweep, other] = dets(evaluate(b.build()), 'search');
    expect(sweep).toMatchObject({ outcome: 'lawful', basis: 'protectiveSweep', ruleIds: ['GS-6.3'] });
    expect(other?.outcome).toBe('unlawful');
  });

  it('a search warrant event makes a premises search lawful', () => {
    const b = new LogBuilder().start().person(1, 'suspect').warrant('search');
    b.at(4).search(1, 'premises', [], { buildingId: 5 });
    expect(one(evaluate(b.build()), 'search')).toMatchObject({ outcome: 'lawful', basis: 'warrant' });
  });
});

describe('determinism', () => {
  it('evaluating twice gives equal results and does not mutate the log', () => {
    const { b } = warrantArrest();
    b.at(30).search(1, 'vehicle', [drugs()]);
    const log = b.build();
    const copy = structuredClone(log);
    const a1 = evaluateIncident(log, getRuleset('generic'));
    const a2 = evaluateIncident(log, getRuleset('generic'));
    expect(a2).toEqual(a1);
    expect(log).toEqual(copy);
  });
});
