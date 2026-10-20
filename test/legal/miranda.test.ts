import { describe, expect, it } from 'vitest';
import { both, dets, evaluate, LogBuilder, one } from './helpers';

function suspect(): LogBuilder {
  return new LogBuilder().start().person(1, 'suspect');
}

describe('Miranda', () => {
  it('a custodial incriminating question without a warning suppresses the statement', () => {
    const b = suspect();
    const q = b.at(5).question(1, 'account', true).lastId;
    b.at(8).statement(1, 'account', 'I did it');
    const a = evaluate(b.build());
    expect(one(a, 'miranda')).toMatchObject({ outcome: 'unlawful', ruleIds: ['GS-7.1'], eventId: q });
    expect(a.evidence).toHaveLength(1);
    expect(a.evidence[0]).toMatchObject({ kind: 'statement', admissible: false, taintedBy: q, ruleIds: ['GS-7.1', 'GS-12.1'] });
    expect(a.persons[0]?.suppressedStatements).toBe(1);
    expect(a.summary.suppressed).toBe(1);
  });

  it('after a waiver the same questioning is fine', () => {
    const b = suspect().at(1).miranda(1, 'waived');
    b.at(5).question(1, 'account', true);
    b.at(8).statement(1, 'account', 'I did it');
    const a = evaluate(b.build());
    expect(dets(a, 'miranda')).toHaveLength(0);
    expect(a.evidence[0]).toMatchObject({ kind: 'statement', admissible: true, ruleIds: [] });
  });

  it('a misunderstood warning is not a waiver', () => {
    const b = suspect().at(1).miranda(1, 'misunderstood');
    b.at(5).question(1, 'drugs', true);
    expect(one(evaluate(b.build()), 'miranda').ruleIds).toEqual(['GS-7.1']);
  });

  it('questioning after an invocation violates the invocation rule', () => {
    const b = suspect().at(1).miranda(1, 'invoked');
    const q = b.at(5).question(1, 'account', true).lastId;
    b.at(7).statement(1, 'account', 'ok fine');
    const a = evaluate(b.build());
    expect(one(a, 'miranda')).toMatchObject({ outcome: 'unlawful', ruleIds: ['GS-7.2'] });
    expect(a.evidence[0]).toMatchObject({ admissible: false, taintedBy: q, ruleIds: ['GS-7.2', 'GS-12.1'] });
  });

  it('a non-custodial question needs no warning', () => {
    const b = suspect();
    b.at(5).question(1, 'account', false);
    b.at(8).statement(1, 'account', 'I did it');
    const a = evaluate(b.build());
    expect(dets(a, 'miranda')).toHaveLength(0);
    expect(a.evidence[0]?.admissible).toBe(true);
  });

  it('a booking question in custody is always admissible', () => {
    const b = suspect();
    b.at(5).question(1, 'name', true);
    b.at(6).statement(1, 'name', 'Pat Doe');
    const a = evaluate(b.build());
    expect(dets(a, 'miranda')).toHaveLength(0);
    expect(a.evidence).toHaveLength(0);
  });

  it('gunpoint questioning is not custodial in generic but is in strict', () => {
    const b = suspect();
    b.at(5).question(1, 'weapons', false, true);
    b.at(8).statement(1, 'weapons', 'in the car');
    const { generic, strict } = both(b.build());
    expect(dets(generic, 'miranda')).toHaveLength(0);
    expect(generic.evidence[0]?.admissible).toBe(true);
    expect(one(strict, 'miranda')).toMatchObject({ outcome: 'unlawful', ruleIds: ['SS-7.1'] });
    expect(strict.evidence[0]?.admissible).toBe(false);
  });

  it('cuffing and arrest create custody; release ends it', () => {
    const cuffed = suspect().detain(1, 'cuffed');
    cuffed.at(5).question(1, 'drugs');
    expect(dets(evaluate(cuffed.build()), 'miranda')).toHaveLength(1);

    const arrested = suspect().indicator(1, 'warrantHit', 'lookup').at(1).arrest(1);
    arrested.at(5).question(1, 'drugs');
    expect(dets(evaluate(arrested.build()), 'miranda')).toHaveLength(1);

    const released = suspect().detain(1, 'cuffed').at(2).release(1, 'uncuff');
    released.at(5).question(1, 'drugs');
    expect(dets(evaluate(released.build()), 'miranda')).toHaveLength(0);
  });

  it('folds repeated violations of one rule into a single determination', () => {
    const b = suspect();
    const q1 = b.at(5).question(1, 'account', true).lastId;
    const q2 = b.at(10).question(1, 'drugs', true).lastId;
    const q3 = b.at(15).question(1, 'weapons', true).lastId;
    const d = one(evaluate(b.build()), 'miranda');
    expect(d.eventIds).toEqual([q1, q2, q3]);
  });

  it('a statement outside the response window is not paired with the unwarned question', () => {
    const b = suspect();
    b.at(5).question(1, 'account', true);
    b.at(60).statement(1, 'account', 'later');
    expect(evaluate(b.build()).evidence[0]?.admissible).toBe(true);
  });

  it('pairs a statement with any incriminating question in the window when the facts differ', () => {
    const b = suspect();
    b.at(5).question(1, 'account', true);
    b.at(9).statement(1, 'drinking', 'two beers');
    const a = evaluate(b.build());
    expect(a.evidence[0]).toMatchObject({ admissible: false, offense: 'dui' });
  });

  it('a volunteered statement without a question is admissible', () => {
    const b = suspect();
    b.at(5).statement(1, 'drugs', 'they are mine', true);
    expect(evaluate(b.build()).evidence[0]?.admissible).toBe(true);
  });

  it('a statement after an unlawful stop is fruit of the stop', () => {
    const b = suspect();
    const det = b.detain(1).lastId;
    b.at(5).statement(1, 'drugs', 'they are mine');
    expect(evaluate(b.build()).evidence[0]).toMatchObject({ admissible: false, taintedBy: det, ruleIds: ['GS-12.2', 'GS-12.1'] });
  });
});

describe('breath and sobriety tests', () => {
  function lawfulStop(): LogBuilder {
    return new LogBuilder().start().person(1, 'driver').indicator(1, 'speeding').indicator(1, 'odorAlcohol').detain(1);
  }

  it('a PBT without consent before an arrest is unlawful and its indicator is tainted', () => {
    const b = lawfulStop();
    const test = b.at(5).test(1, 'pbt', 'over').lastId;
    b.indicator(1, 'bacOver', 'test', test);
    b.at(10).arrest(1);
    const a = evaluate(b.build(), 'strict');
    expect(one(a, 'test')).toMatchObject({ outcome: 'unlawful', ruleIds: ['SS-7.3'] });
    expect(a.evidence[0]).toMatchObject({ kind: 'test', admissible: false, taintedBy: test, offense: 'dui' });
    // strict: speeding is not arrestable and bacOver is tainted, so the arrest fails
    expect(one(a, 'arrest').outcome).toBe('unlawful');
  });

  it('a PBT with consent is lawful', () => {
    const b = lawfulStop();
    b.at(4).consent(1, 'pbt');
    const test = b.at(5).test(1, 'pbt', 'over').lastId;
    b.indicator(1, 'bacOver', 'test', test);
    b.at(10).arrest(1);
    const a = evaluate(b.build());
    expect(one(a, 'test')).toMatchObject({ outcome: 'lawful', basis: 'consent' });
    expect(a.evidence[0]?.admissible).toBe(true);
    expect(one(a, 'arrest').outcome).toBe('lawful');
  });

  it('consent to a PBT does not cover the field sobriety tests', () => {
    const b = lawfulStop().consent(1, 'pbt');
    b.at(5).test(1, 'sfst', 'fail');
    expect(one(evaluate(b.build()), 'test').outcome).toBe('unlawful');
  });

  it('after a lawful arrest: implied consent in generic, not in strict', () => {
    const b = new LogBuilder().start().person(1, 'driver').indicator(1, 'warrantHit', 'lookup').detain(1);
    b.at(5).arrest(1);
    b.at(10).test(1, 'pbt', 'over');
    const { generic, strict } = both(b.build());
    expect(one(generic, 'test')).toMatchObject({ outcome: 'lawful', basis: 'arrest' });
    expect(one(strict, 'test').outcome).toBe('unlawful');
  });
});
