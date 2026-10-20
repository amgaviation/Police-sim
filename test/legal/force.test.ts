import { describe, expect, it } from 'vitest';
import { forceVerdict, resistanceRank } from '../../src/legal/force';
import { getRuleset } from '../../src/legal/ruleset';
import { FORCE_LEVELS, RESISTANCE_LEVELS, type ForceLevel, type Resistance } from '../../src/legal/types';
import { both, dets, evaluate, LogBuilder, one } from './helpers';

const generic = getRuleset('generic');
const strict = getRuleset('strict');

function verdict(level: ForceLevel, resistance: Resistance, extra: Partial<Parameters<typeof forceVerdict>[0]> = {}, rs = generic) {
  return forceVerdict({ level, tool: level, resistance, cycle: 1, riskFactors: [], restrained: false, ...extra }, rs);
}

describe('resistanceRank', () => {
  it('indexes the resistance levels', () => {
    expect(RESISTANCE_LEVELS.map(resistanceRank)).toEqual([0, 1, 2, 3, 4]);
  });
});

describe('force continuum (generic matrix)', () => {
  for (const resistance of RESISTANCE_LEVELS) {
    for (const level of FORCE_LEVELS) {
      const max = generic.force.maxByResistance[resistance];
      const lvl = generic.force.levels[level];
      let expected: 'justified' | 'questionable' | 'excessive' = lvl <= max ? 'justified' : lvl <= max + 1 ? 'questionable' : 'excessive';
      if (level === 'firearm' && resistance !== 'lethal') expected = 'excessive';
      it(`${level} against ${resistance} is ${expected}`, () => {
        const v = verdict(level, resistance);
        expect(v.verdict).toBe(expected);
        expect(v.ruleIds).toEqual([level === 'firearm' && resistance !== 'lethal' ? 'GS-8.5' : 'GS-8.1']);
        // Through the full evaluation as well.
        const log = new LogBuilder().start().person(1, 'suspect').force(1, level, resistance).build();
        const a = evaluate(log);
        expect(a.force).toHaveLength(1);
        expect(a.force[0]).toMatchObject({ verdict: expected, level, resistance, other: false });
        const d = dets(a, 'force');
        expect(d).toHaveLength(expected === 'justified' ? 0 : 1);
        if (d[0]) expect(d[0].outcome).toBe(expected === 'excessive' ? 'unlawful' : 'questionable');
      });
    }
  }

  it('reports the highest allowed level', () => {
    expect(verdict('verbal', 'compliant').maxAllowed).toBe('softHands');
    expect(verdict('verbal', 'active').maxAllowed).toBe('k9');
    expect(verdict('verbal', 'assaultive').maxAllowed).toBe('lessLethal');
    expect(verdict('verbal', 'lethal').maxAllowed).toBe('firearm');
    expect(verdict('verbal', 'active', {}, strict).maxAllowed).toBe('ocSpray');
  });
});

describe('special force rules', () => {
  it('a firearm against an assaultive subject is excessive under the lethal rule', () => {
    const v = verdict('firearm', 'assaultive');
    expect(v).toMatchObject({ verdict: 'excessive', ruleIds: ['GS-8.5'], factors: ['lethal'] });
  });

  it('a firearm against a lethal subject is justified', () => {
    expect(verdict('firearm', 'lethal').verdict).toBe('justified');
  });

  it('a TASER on an active subject: justified in generic, questionable in strict', () => {
    expect(verdict('taser', 'active').verdict).toBe('justified');
    expect(verdict('taser', 'active', {}, strict).verdict).toBe('questionable');
  });

  it('the 4th TASER cycle is excessive in generic; the 3rd in strict', () => {
    expect(verdict('taser', 'assaultive', { cycle: 3 }).verdict).toBe('justified');
    expect(verdict('taser', 'assaultive', { cycle: 4 })).toMatchObject({ verdict: 'excessive', ruleIds: ['GS-8.3'], factors: ['cycles'] });
    expect(verdict('taser', 'assaultive', { cycle: 2 }, strict).verdict).toBe('justified');
    expect(verdict('taser', 'assaultive', { cycle: 3 }, strict)).toMatchObject({ verdict: 'excessive', ruleIds: ['SS-8.3'] });
  });

  it('a TASER on a subject with a risk factor is excessive unless the threat is lethal', () => {
    expect(verdict('taser', 'active', { riskFactors: ['elderly'] })).toMatchObject({ verdict: 'excessive', ruleIds: ['GS-8.4'], factors: ['elderly'] });
    expect(verdict('taser', 'assaultive', { riskFactors: ['pregnant', 'running', 'unrelated'] }).factors).toEqual(['pregnant', 'running']);
    expect(verdict('taser', 'lethal', { riskFactors: ['elderly'] }).verdict).toBe('justified');
    expect(verdict('taser', 'active', { riskFactors: ['unrelated'] }).verdict).toBe('justified');
  });

  it('any strike on a restrained subject is excessive', () => {
    for (const level of ['hardHands', 'ocSpray', 'baton', 'taser', 'k9', 'lessLethal', 'firearm'] as const) {
      expect(verdict(level, 'lethal', { restrained: true })).toMatchObject({ verdict: 'excessive', ruleIds: ['GS-8.2'], factors: ['restrained'] });
    }
    expect(verdict('softHands', 'compliant', { restrained: true }).verdict).toBe('justified');
    expect(verdict('verbal', 'compliant', { restrained: true }).verdict).toBe('justified');
  });

  it('pointing a firearm at a compliant subject: justified in generic, questionable in strict', () => {
    expect(verdict('presence', 'compliant', { tool: 'firearmDisplay' })).toMatchObject({ verdict: 'justified', ruleIds: ['GS-8.1'] });
    expect(verdict('presence', 'compliant', { tool: 'firearmDisplay' }, strict)).toMatchObject({ verdict: 'questionable', ruleIds: ['SS-8.6'], factors: ['display'] });
    expect(verdict('presence', 'active', { tool: 'firearmDisplay' }, strict).verdict).toBe('justified');
    expect(verdict('presence', 'compliant', { tool: 'none' }, strict).verdict).toBe('justified');
  });

  it('feeds the summary: excessive -30, questionable -10, other officers excluded', () => {
    const b = new LogBuilder().start().person(1, 'suspect');
    b.force(1, 'baton', 'compliant');
    b.at(5).force(1, 'hardHands', 'compliant');
    b.at(6).other(1, 'baton', 'compliant', 40);
    const a = evaluate(b.build());
    expect(a.summary).toMatchObject({ excessiveForce: 1, questionableForce: 1, unlawful: 0, questionable: 0, score: 60 });
  });
});

describe('duty to intervene', () => {
  const excessive = (b: LogBuilder, dist: number): number => b.at(10).other(1, 'baton', 'compliant', dist).lastId;

  it('intervening 2 s after excessive force at 5 m is lawful', () => {
    const b = new LogBuilder().start().person(1, 'suspect');
    const other = excessive(b, 5);
    b.at(12).intervene(other);
    const a = evaluate(b.build());
    expect(one(a, 'intervene')).toMatchObject({ outcome: 'lawful', reason: 'Officer intervened', ruleIds: ['GS-9.1'] });
    expect(a.force[0]).toMatchObject({ other: true, verdict: 'excessive' });
  });

  it('not intervening is unlawful', () => {
    const b = new LogBuilder().start().person(1, 'suspect');
    excessive(b, 5);
    const a = evaluate(b.build());
    expect(one(a, 'intervene')).toMatchObject({ outcome: 'unlawful', ruleIds: ['GS-9.1'] });
    expect(a.summary.unlawful).toBe(1);
  });

  it('intervening too late is unlawful', () => {
    const b = new LogBuilder().start().person(1, 'suspect');
    const other = excessive(b, 5);
    b.at(20).intervene(other);
    expect(one(evaluate(b.build()), 'intervene').outcome).toBe('unlawful');
  });

  it('force beyond the radius creates no determination', () => {
    const b = new LogBuilder().start().person(1, 'suspect');
    excessive(b, 30);
    expect(dets(evaluate(b.build()), 'intervene')).toHaveLength(0);
  });

  it('justified force by the other officer creates no determination', () => {
    const b = new LogBuilder().start().person(1, 'suspect');
    b.at(10).other(1, 'hardHands', 'active', 3);
    const a = evaluate(b.build());
    expect(dets(a, 'intervene')).toHaveLength(0);
    expect(a.force[0]?.verdict).toBe('justified');
  });

  it('strikes on a restrained subject count even at a low level', () => {
    const b = new LogBuilder().start().person(1, 'suspect');
    b.at(10).other(1, 'hardHands', 'compliant', 4, { restrained: true });
    expect(one(evaluate(b.build()), 'intervene').outcome).toBe('unlawful');
  });

  it('consecutive strikes of one officer form a single episode', () => {
    const b = new LogBuilder().start().person(1, 'suspect');
    const first = b.at(10).other(1, 'baton', 'compliant', 4).lastId;
    const second = b.at(14).other(1, 'baton', 'compliant', 4).lastId;
    b.at(20).other(1, 'baton', 'compliant', 4);
    b.at(17).intervene(second);
    const a = evaluate(b.build());
    const list = dets(a, 'intervene');
    // t = 10 and 14 share an episode; t = 20 is within 10 s of 14 and joins as well
    expect(list).toHaveLength(1);
    expect(list[0]?.eventIds).toHaveLength(3);
    expect(list[0]?.eventId).toBe(first);
    expect(list[0]?.outcome).toBe('lawful');
  });

  it('separate officers or a long gap make separate episodes', () => {
    const b = new LogBuilder().start().person(1, 'suspect');
    b.at(10).other(1, 'baton', 'compliant', 4, { officer: 'A' });
    b.at(11).other(1, 'baton', 'compliant', 4, { officer: 'B' });
    b.at(40).other(1, 'baton', 'compliant', 4, { officer: 'A' });
    expect(dets(evaluate(b.build()), 'intervene')).toHaveLength(3);
  });

  it('strict uses the same radius and window values', () => {
    const b = new LogBuilder().start().person(1, 'suspect');
    const other = b.at(10).other(1, 'baton', 'compliant', 14).lastId;
    b.at(14).intervene(other);
    const { generic: g, strict: s } = both(b.build());
    expect(one(g, 'intervene').outcome).toBe('lawful');
    expect(one(s, 'intervene').ruleIds).toEqual(['SS-9.1']);
  });
});
