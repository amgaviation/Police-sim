import { describe, expect, it } from 'vitest';
import { both, dets, drugs, evaluate, LogBuilder, one } from './helpers';

/** Driver detained with no indicators: an unlawful stop under both rulesets. */
function unlawfulStop(): LogBuilder {
  return new LogBuilder().start().person(1, 'driver').detain(1);
}

describe('shared plate-run indicators after an unlawful stop', () => {
  it('are fruit of the stop in the strict ruleset, so the arrest and search fail', () => {
    const b = unlawfulStop();
    b.at(5).indicator(-1, 'stolenVehicle', 'lookup').indicator(-1, 'stolenPlate', 'lookup');
    b.at(10).arrest(1);
    b.at(20).search(1, 'vehicle', [drugs()]);
    const a = evaluate(b.build(), 'strict');
    expect(one(a, 'arrest').outcome).toBe('unlawful');
    expect(one(a, 'search').outcome).toBe('unlawful');
    expect(a.evidence[0]?.admissible).toBe(false);
  });

  it('match a person-level indicator and still count in the generic ruleset only when attenuating', () => {
    const shared = unlawfulStop();
    shared.at(5).indicator(-1, 'stolenVehicle', 'lookup').indicator(-1, 'stolenPlate', 'lookup');
    shared.at(10).arrest(1);
    const own = unlawfulStop();
    own.at(5).indicator(1, 'stolenVehicle', 'lookup').indicator(1, 'stolenPlate', 'lookup');
    own.at(10).arrest(1);
    for (const id of ['generic', 'strict']) {
      expect(one(evaluate(shared.build(), id), 'arrest').outcome).toBe(one(evaluate(own.build(), id), 'arrest').outcome);
    }
  });

  it('still count on a lawful stop', () => {
    const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'speeding').detain(1);
    b.at(5).indicator(-1, 'stolenVehicle', 'lookup').indicator(-1, 'stolenPlate', 'lookup');
    b.at(10).arrest(1);
    const { generic, strict } = both(b.build());
    expect(one(generic, 'arrest').outcome).toBe('lawful');
    expect(one(strict, 'arrest').outcome).toBe('lawful');
  });
});

describe('an unlawful arrest taints what follows', () => {
  function unlawfulArrest(): LogBuilder {
    const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'speeding').detain(1);
    b.at(10).arrest(1);
    return b;
  }

  it('makes later consent questionable and the consent search unlawful (strict)', () => {
    const b = unlawfulArrest();
    b.at(20).consent(1, 'searchVehicle', true);
    b.at(30).search(1, 'vehicle', [drugs()]);
    const a = evaluate(b.build(), 'strict');
    expect(one(a, 'arrest').outcome).toBe('unlawful');
    expect(one(a, 'consent').outcome).toBe('questionable');
    expect(one(a, 'search').outcome).toBe('unlawful');
    expect(a.evidence[0]?.admissible).toBe(false);
  });

  it('suppresses a later statement', () => {
    const b = unlawfulArrest();
    b.at(20).miranda(1, 'waived').question(1, 'drugs', true).statement(1, 'drugs');
    const a = evaluate(b.build(), 'strict');
    expect(a.evidence.find((r) => r.kind === 'statement')?.admissible).toBe(false);
    expect(a.persons.find((p) => p.personId === 1)?.suppressedStatements).toBe(1);
  });

  it('taints later non-call indicators', () => {
    const b = unlawfulArrest();
    b.at(20).indicator(1, 'odorAlcohol').indicator(1, 'bacOver', 'test');
    b.at(25).arrest(1, 'booking');
    const a = evaluate(b.build(), 'strict');
    expect(a.persons.find((p) => p.personId === 1)?.arrestLawful).toBe(false);
  });

  it('does not taint a lawful arrest', () => {
    const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'warrantHit', 'lookup').detain(1);
    b.at(10).arrest(1).at(20).consent(1, 'searchVehicle', true);
    expect(one(evaluate(b.build(), 'strict'), 'consent').outcome).toBe('lawful');
  });
});

describe('withdrawn consent', () => {
  function consented(): LogBuilder {
    const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'speeding').detain(1);
    b.at(10).consent(1, 'searchVehicle', true);
    return b;
  }

  it('grant then refuse then search is unlawful', () => {
    const b = consented();
    b.at(20).consent(1, 'searchVehicle', false);
    b.at(30).search(1, 'vehicle', [drugs()]);
    const a = evaluate(b.build());
    expect(one(a, 'search').outcome).toBe('unlawful');
    expect(a.evidence[0]?.admissible).toBe(false);
  });

  it('a search before the withdrawal stays lawful', () => {
    const b = consented();
    b.at(15).search(1, 'vehicle', [drugs()]);
    b.at(20).consent(1, 'searchVehicle', false);
    expect(one(evaluate(b.build()), 'search')).toMatchObject({ outcome: 'lawful', basis: 'consent' });
  });

  it('a refusal of another kind does not revoke', () => {
    const b = consented();
    b.at(20).consent(1, 'searchPerson', false);
    b.at(30).search(1, 'vehicle', [drugs()]);
    expect(one(evaluate(b.build()), 'search').outcome).toBe('lawful');
  });

  it('revokes an entry consent for the building', () => {
    const b = new LogBuilder().start().person(1, 'resident');
    b.at(5).consent(1, 'entry', true, true, { buildingId: 3 });
    b.at(8).consent(1, 'entry', false, true, { buildingId: 3 });
    b.at(10).entry(3);
    expect(one(evaluate(b.build()), 'entry').outcome).toBe('unlawful');
  });

  it('revokes a PBT consent', () => {
    const b = consented();
    b.at(11).consent(1, 'pbt', true);
    b.at(12).consent(1, 'pbt', false);
    b.at(13).test(1, 'pbt');
    expect(one(evaluate(b.build()), 'test').outcome).toBe('unlawful');
  });
});

describe('call-level arrest warrant', () => {
  function warrantCall(): LogBuilder {
    const b = new LogBuilder('C-1', 'wanted').start().person(1, 'suspect').person(2, 'bystander');
    b.warrant('arrest').warrant('search');
    return b;
  }

  it('does not make a bystander arrest lawful', () => {
    const b = warrantCall();
    b.at(10).detain(2, 'command').arrest(2);
    b.at(20).search(2, 'person', [drugs()]);
    const a = evaluate(b.build());
    const arrest = dets(a, 'arrest')[0];
    expect(arrest?.outcome).toBe('unlawful');
    expect(one(a, 'search').outcome).toBe('unlawful');
    expect(a.evidence[0]?.admissible).toBe(false);
  });

  it('still covers the suspect', () => {
    const b = warrantCall();
    b.at(10).detain(1, 'command').arrest(1);
    expect(one(evaluate(b.build()), 'arrest')).toMatchObject({ outcome: 'lawful', basis: 'warrant' });
  });

  it('is cut off by an unlawful stop under strict, not under generic', () => {
    const b = warrantCall();
    b.at(10).detain(1, 'command').arrest(1);
    const { generic, strict } = both(b.build());
    // The suspect has no indicators and was detained with the warrant already known.
    expect(one(generic, 'arrest').outcome).toBe('lawful');
    expect(dets(strict, 'detention')[0]?.outcome).toBe('unlawful');
    expect(one(strict, 'arrest').outcome).toBe('unlawful');
  });

  it('does not make a vehicle or person search lawful on its own', () => {
    const b = warrantCall();
    b.at(10).search(2, 'vehicle', [drugs()]);
    expect(one(evaluate(b.build()), 'search').outcome).toBe('unlawful');
  });

  it('covers a premises search', () => {
    const b = warrantCall();
    b.at(10).search(1, 'premises', [drugs()], { buildingId: 3 });
    expect(one(evaluate(b.build()), 'search')).toMatchObject({ outcome: 'lawful', basis: 'warrant' });
  });
});
