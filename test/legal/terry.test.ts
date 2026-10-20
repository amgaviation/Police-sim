import { describe, expect, it } from 'vitest';
import { both, dets, drugs, evaluate, gun, LogBuilder, one } from './helpers';

/** A lawful detention with the call-armed indicators (generic armed 1.0, strict 0.8). */
function weaponCallStop(): LogBuilder {
  return new LogBuilder('C-00003', 'property').start().person(1, 'suspect')
    .indicator(1, 'callSuspect', 'call').indicator(1, 'weaponCall', 'call').detain(1, 'command');
}

/** A lawful detention with a weapon seen (armed 1.0 in both). */
function weaponSeenStop(): LogBuilder {
  return new LogBuilder().start().person(1, 'suspect').indicator(1, 'weaponSeen').detain(1, 'command');
}

describe('Terry frisk', () => {
  it('weaponCall plus a lawful detention supports a frisk in generic', () => {
    const b = weaponCallStop();
    b.at(5).frisk(1, [gun()]);
    const { generic, strict } = both(b.build());
    expect(one(generic, 'frisk')).toMatchObject({ outcome: 'lawful', ruleIds: ['GS-2.1'], basis: 'terry' });
    expect(generic.evidence[0]).toMatchObject({ admissible: true, offense: 'weapons', ruleIds: [] });
    // Strict weighs the dispatch report at 0.8: not enough to believe the person is armed.
    expect(one(strict, 'frisk')).toMatchObject({ outcome: 'unlawful', ruleIds: ['SS-2.1'] });
    expect(strict.evidence[0]).toMatchObject({ admissible: false, ruleIds: ['SS-12.1'] });
  });

  it('no armed indicators makes the frisk unlawful and suppresses what it finds', () => {
    const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'speeding').detain(1);
    const frisk = b.at(5).frisk(1, [gun()]).lastId;
    const a = evaluate(b.build());
    const d = one(a, 'frisk');
    expect(d.outcome).toBe('unlawful');
    expect(d.reason).toBe('Nothing indicated the person was armed (0 of 1)');
    expect(a.evidence[0]).toMatchObject({ admissible: false, taintedBy: frisk, ruleIds: ['GS-12.1'] });
  });

  it('a frisk without any lawful stop is unlawful', () => {
    const b = new LogBuilder().start().person(1, 'suspect').indicator(1, 'weaponSeen').frisk(1);
    expect(one(evaluate(b.build()), 'frisk').reason).toBe('A frisk requires a lawful stop, arrest or consent');
  });

  it('a frisk with consent but no detention is lawful', () => {
    const b = new LogBuilder().start().person(1, 'witness').consent(1, 'searchPerson');
    b.at(5).frisk(1, [gun()]);
    const a = evaluate(b.build());
    expect(one(a, 'frisk')).toMatchObject({ outcome: 'lawful', basis: 'consent' });
    expect(a.evidence[0]?.admissible).toBe(true);
  });

  it('a frisk after a lawful arrest is a search incident to arrest', () => {
    const b = new LogBuilder().start().person(1, 'suspect').indicator(1, 'warrantHit', 'lookup').detain(1).at(5).arrest(1);
    b.at(10).frisk(1, [drugs()]);
    const a = evaluate(b.build());
    expect(one(a, 'frisk')).toMatchObject({ outcome: 'lawful', basis: 'incidentToArrest' });
    expect(dets(a, 'friskScope')).toHaveLength(0);
    expect(a.evidence[0]?.admissible).toBe(true);
  });

  it('drugs felt during the frisk: admissible by plain feel in generic, suppressed in strict', () => {
    const b = weaponSeenStop();
    const frisk = b.at(5).frisk(1, [drugs()]).lastId;
    b.indicator(1, 'contrabandFound', 'evidence', frisk);
    b.at(10).arrest(1);
    const { generic, strict } = both(b.build());

    expect(dets(generic, 'friskScope')).toHaveLength(0);
    expect(generic.evidence[0]).toMatchObject({ admissible: true, offense: 'drugs' });
    expect(one(generic, 'arrest')).toMatchObject({ outcome: 'lawful', ruleIds: ['GS-3.1'] });
    expect(generic.persons[0]?.arrestOffense).toBe('drugs');

    const scope = one(strict, 'friskScope');
    expect(scope).toMatchObject({ outcome: 'unlawful', ruleIds: ['SS-2.2'], eventId: frisk });
    expect(strict.evidence[0]).toMatchObject({ admissible: false, taintedBy: frisk, ruleIds: ['SS-12.1'] });
    // The excluded drugs cannot supply probable cause for the arrest.
    expect(one(strict, 'arrest').outcome).toBe('unlawful');
  });

  it('plain feel covers only the listed categories', () => {
    const b = weaponSeenStop();
    b.at(5).frisk(1, [{ ...drugs('p1'), category: 'paraphernalia', label: 'Pipe' }]);
    const a = evaluate(b.build());
    expect(one(a, 'friskScope').outcome).toBe('unlawful');
    expect(a.evidence[0]?.admissible).toBe(false);
  });

  it('a weapon found by a lawful frisk is admissible under both rulesets', () => {
    const b = weaponSeenStop();
    b.at(5).frisk(1, [gun()]);
    const { generic, strict } = both(b.build());
    expect(generic.evidence[0]?.admissible).toBe(true);
    expect(strict.evidence[0]?.admissible).toBe(true);
    expect(dets(strict, 'friskScope')).toHaveLength(0);
  });

  it('a consent frisk keeps non-weapon items in scope', () => {
    const b = new LogBuilder().start().person(1, 'witness').consent(1, 'searchPerson');
    b.at(5).frisk(1, [drugs()]);
    const a = evaluate(b.build(), 'strict');
    expect(dets(a, 'friskScope')).toHaveLength(0);
    expect(a.evidence[0]?.admissible).toBe(true);
  });

  it('a denied consent does not support a frisk', () => {
    const b = new LogBuilder().start().person(1, 'witness').consent(1, 'searchPerson', false);
    b.at(5).frisk(1, [gun()]);
    expect(one(evaluate(b.build()), 'frisk').outcome).toBe('unlawful');
  });

  it('a frisk after an unlawful detention is fruit of that detention', () => {
    const b2 = new LogBuilder().start().person(2, 'suspect');
    const det = b2.detain(2).lastId;
    b2.at(3).indicator(2, 'weaponSeen');
    const frisk = b2.at(5).frisk(2, [gun()]).lastId;
    const a = evaluate(b2.build());
    expect(one(a, 'frisk').outcome).toBe('unlawful');
    expect(a.evidence[0]).toMatchObject({ taintedBy: det, ruleIds: ['GS-12.2', 'GS-12.1'], eventId: frisk });
  });
});
