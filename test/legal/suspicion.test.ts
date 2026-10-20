import { describe, expect, it } from 'vitest';
import { both, dets, drugs, evaluate, LogBuilder, one } from './helpers';

/** Driver stopped for a violation: lawful detention under both rulesets. */
function stopped(): LogBuilder {
  return new LogBuilder().start().person(1, 'driver').indicator(1, 'speeding').detain(1);
}

/** A lawful stop whose indicators carry no probable cause toward impaired driving. */
function stoppedQuietly(): LogBuilder {
  return new LogBuilder().start().person(1, 'driver').indicator(1, 'flight').indicator(1, 'falseIdentity').detain(1);
}

describe('reasonable suspicion', () => {
  it('speeding then a detention is lawful', () => {
    const log = stopped().build();
    const { generic, strict } = both(log);
    const g = one(generic, 'detention');
    expect(g.outcome).toBe('lawful');
    expect(g.ruleIds).toEqual(['GS-1.1']);
    expect(g.reason).toContain('Observed speeding');
    expect(one(strict, 'detention').ruleIds).toEqual(['SS-1.1']);
    expect(generic.persons[0]).toMatchObject({ detained: true, detentionLawful: true, rsAtDetention: 1 });
  });

  it('a detention with no indicator is unlawful, and a later consent search is fruit', () => {
    const b = new LogBuilder().start().person(1, 'driver').detain(1);
    const detId = b.lastId;
    b.at(10).consent(1, 'searchVehicle');
    b.at(20).search(1, 'vehicle', [drugs()]);
    const a = evaluate(b.build());

    const d = one(a, 'detention');
    expect(d.outcome).toBe('unlawful');
    expect(d.ruleIds).toEqual(['GS-1.1']);
    expect(d.reason).toBe('No reasonable suspicion: 0 of 1');
    // The consent given in the shadow of the illegal stop does not cure it.
    expect(one(a, 'consent').outcome).toBe('questionable');
    const s = one(a, 'search');
    expect(s.outcome).toBe('unlawful');
    expect(a.evidence).toHaveLength(1);
    expect(a.evidence[0]).toMatchObject({ admissible: false, taintedBy: detId, ruleIds: ['GS-12.2', 'GS-12.1'] });
    expect(a.summary.suppressed).toBe(1);
  });

  it('callSuspect plus weaponCall supports a stop', () => {
    const log = new LogBuilder('C-00002', 'property').start().person(1, 'suspect')
      .indicator(1, 'callSuspect', 'call').indicator(1, 'weaponCall', 'call').detain(1, 'command').build();
    const { generic, strict } = both(log);
    expect(one(generic, 'detention').outcome).toBe('lawful');
    expect(one(strict, 'detention').outcome).toBe('lawful');
    expect(generic.persons[0]?.rsAtDetention).toBeCloseTo(1.5);
    expect(strict.persons[0]?.rsAtDetention).toBeCloseTo(1.3);
  });

  it('a weak lead alone is not enough', () => {
    const log = new LogBuilder().start().person(1, 'driver').indicator(1, 'flight').detain(1).build();
    expect(one(evaluate(log), 'detention').outcome).toBe('unlawful');
  });

  it('a consensual contact has no detention determination', () => {
    const log = new LogBuilder().start().person(1, 'witness').question(1, 'name').statement(1, 'name', 'Pat').build();
    const a = evaluate(log);
    expect(dets(a, 'detention')).toHaveLength(0);
    expect(a.persons[0]).toMatchObject({ detained: false, detentionLawful: null });
    expect(a.summary.score).toBe(100);
  });

  it('only the first detention of a person counts', () => {
    const log = stopped().at(5).detain(1, 'command').build();
    expect(dets(evaluate(log), 'detention')).toHaveLength(1);
  });

  it('indicators of person -1 apply to every person', () => {
    const log = new LogBuilder().start().person(1, 'driver').person(2, 'passenger').indicator(-1, 'stolenVehicle', 'lookup')
      .detain(2).build();
    expect(one(evaluate(log), 'detention').outcome).toBe('lawful');
  });

  it('a warrant hit after an unlawful stop is attenuated in generic and tainted in strict', () => {
    const b = new LogBuilder().start().person(1, 'driver').detain(1);
    b.at(5).indicator(1, 'warrantHit', 'lookup');
    b.at(10).arrest(1);
    b.at(40).search(1, 'person', [drugs()]);
    const log = b.build();
    const { generic, strict } = both(log);

    expect(one(generic, 'detention').outcome).toBe('unlawful');
    expect(one(generic, 'arrest')).toMatchObject({ outcome: 'lawful', ruleIds: ['GS-3.2'] });
    expect(one(generic, 'search')).toMatchObject({ outcome: 'lawful', basis: 'incidentToArrest' });
    expect(generic.evidence[0]?.admissible).toBe(true);

    expect(one(strict, 'arrest')).toMatchObject({ outcome: 'unlawful', ruleIds: ['SS-3.1'] });
    expect(one(strict, 'search').outcome).toBe('unlawful');
    expect(strict.evidence[0]).toMatchObject({ admissible: false, ruleIds: ['SS-12.2', 'SS-12.1'] });
  });

  it('other indicators gathered after an unlawful stop are fruit', () => {
    const b = new LogBuilder().start().person(1, 'driver').detain(1);
    b.at(5).indicator(1, 'odorAlcohol').indicator(1, 'sfstFail', 'test').indicator(1, 'bacOver', 'test');
    b.at(10).arrest(1);
    const a = evaluate(b.build());
    expect(one(a, 'arrest').outcome).toBe('unlawful');
    expect(a.persons[0]?.pcAtArrest).toEqual({});
  });
});

describe('probable cause and arrest', () => {
  it('bacOver with odor of alcohol is probable cause for impaired driving', () => {
    const b = stoppedQuietly().indicator(1, 'odorAlcohol').indicator(1, 'bacOver', 'test');
    b.at(10).arrest(1);
    const a = evaluate(b.build());
    const d = one(a, 'arrest');
    expect(d).toMatchObject({ outcome: 'lawful', ruleIds: ['GS-3.1'], basis: 'probableCause' });
    expect(d.reason).toBe('Probable cause for Impaired driving: 2.1 of 2');
    expect(a.persons[0]).toMatchObject({ arrested: true, arrestLawful: true, arrestOffense: 'dui' });
    expect(a.persons[0]?.pcAtArrest.dui).toBeCloseTo(2.1);
  });

  it('odor of alcohol alone is not probable cause', () => {
    const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'odorAlcohol').detain(1);
    b.at(10).arrest(1);
    const a = evaluate(b.build());
    const d = one(a, 'arrest');
    expect(d.outcome).toBe('unlawful');
    expect(d.reason).toBe('Probable cause for Impaired driving: 0.6 of 2');
    expect(a.persons[0]).toMatchObject({ arrested: true, arrestLawful: false, arrestOffense: null });
  });

  it('odor + admission + failed sobriety test reaches 2.1', () => {
    const b = stoppedQuietly().indicator(1, 'odorAlcohol');
    b.at(2).statement(1, 'drinking', 'two beers');
    b.indicator(1, 'admissionDrinking', 'statement', b.lastId).indicator(1, 'sfstFail', 'test');
    b.at(10).arrest(1);
    const a = evaluate(b.build());
    expect(one(a, 'arrest').outcome).toBe('lawful');
    expect(a.persons[0]?.arrestOffense).toBe('dui');
  });

  it('a warrant hit is lawful with the warrant rule', () => {
    const b = new LogBuilder().start().person(1, 'suspect').indicator(1, 'warrantHit', 'lookup').detain(1);
    b.at(5).arrest(1);
    const d = one(evaluate(b.build()), 'arrest');
    expect(d).toMatchObject({ outcome: 'lawful', ruleIds: ['GS-3.2'], basis: 'warrant' });
  });

  it('a warrant event makes an arrest lawful', () => {
    const b = new LogBuilder().start().person(1, 'suspect').detain(1, 'command').warrant('arrest');
    b.at(5).arrest(1);
    const a = evaluate(b.build());
    expect(one(a, 'arrest').ruleIds).toEqual(['GS-3.2']);
    expect(a.persons[0]?.arrestOffense).toBe('warrant');
  });

  it('a statement suppressed under Miranda does not count toward probable cause', () => {
    const b = stoppedQuietly().indicator(1, 'odorAlcohol');
    b.at(2).question(1, 'drinking', true);
    b.at(3).statement(1, 'drinking', 'two beers');
    b.indicator(1, 'admissionDrinking', 'statement', b.lastId).indicator(1, 'sfstFail', 'test');
    b.at(10).arrest(1);
    const a = evaluate(b.build());
    expect(one(a, 'miranda').outcome).toBe('unlawful');
    expect(a.persons[0]?.suppressedStatements).toBe(1);
    // odor 0.6 + sfst 1.0 = 1.6 only
    const d = one(a, 'arrest');
    expect(d.outcome).toBe('unlawful');
    expect(d.reason).toBe('Probable cause for Impaired driving: 1.6 of 2');
  });

  it('a speeding-only arrest is lawful in generic and unlawful in strict', () => {
    const b = stopped();
    b.at(5).arrest(1);
    const { generic, strict } = both(b.build());
    expect(one(generic, 'arrest')).toMatchObject({ outcome: 'lawful', ruleIds: ['GS-3.1'] });
    const s = one(strict, 'arrest');
    expect(s).toMatchObject({ outcome: 'unlawful', ruleIds: ['SS-3.1'] });
    expect(s.reason).toBe('Traffic offense is not an arrestable offense under this ruleset');
  });

  it('an arrest with no indicators has no probable cause', () => {
    const b = new LogBuilder().start().person(1, 'suspect').arrest(1);
    const d = one(evaluate(b.build()), 'arrest');
    expect(d.outcome).toBe('unlawful');
    expect(d.reason).toContain('No probable cause');
  });

  it('a booking arrest after a cuff arrest is not judged twice', () => {
    const b = stopped();
    b.at(5).arrest(1).at(900).arrest(1, 'booking');
    expect(dets(evaluate(b.build()), 'arrest')).toHaveLength(1);
  });

  it('the best offense wins and ties go to the more severe one', () => {
    const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'speeding').indicator(1, 'warrantHit', 'lookup').detain(1);
    b.at(5).arrest(1);
    const a = evaluate(b.build());
    // traffic 2.0 and warrant 2.0 tie: warrant is more severe
    expect(a.persons[0]?.arrestOffense).toBe('warrant');
  });

  it('licenseInvalid counts only for the driver', () => {
    const b = new LogBuilder().start().person(1, 'driver').person(2, 'passenger')
      .indicator(1, 'licenseInvalid', 'lookup').indicator(2, 'licenseInvalid', 'lookup').detain(1).detain(2);
    const a = evaluate(b.build());
    const [d1, d2] = dets(a, 'detention');
    expect(d1?.outcome).toBe('lawful');
    expect(d2?.outcome).toBe('unlawful');
  });
});

describe('score', () => {
  it('subtracts 15 per unlawful and 10 per questionable', () => {
    const b = new LogBuilder().start().person(1, 'driver').detain(1);
    b.at(5).consent(1, 'searchVehicle').at(6).search(1, 'vehicle', [drugs()]);
    const a = evaluate(b.build());
    expect(a.summary).toMatchObject({ unlawful: 2, questionable: 1, suppressed: 1 });
    expect(a.summary.score).toBe(100 - 30 - 10);
  });

  it('is clamped at zero', () => {
    const b = new LogBuilder().start().person(1, 'driver');
    for (let i = 0; i < 10; i++) b.at(i).force(1, 'baton', 'compliant');
    expect(evaluate(b.build()).summary.score).toBe(0);
  });
});
