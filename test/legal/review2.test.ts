import { describe, expect, it } from 'vitest';
import mappingJson from '../../src/data/incidents/mapping.json';
import questionsJson from '../../src/data/court/questions.json';
import reportJson from '../../src/data/legal/report.json';
import { FORCE_TOOLS } from '../../src/force/types';
import { buildReportChoices } from '../../src/legal/report';
import { getRuleset } from '../../src/legal/ruleset';
import { both, dets, drugs, evaluate, LogBuilder, one } from './helpers';

describe('room consent covers a container search', () => {
  function log(target: 'container' | 'room'): LogBuilder {
    return new LogBuilder().start().person(1, 'resident').consent(1, 'entry', true, true, { buildingId: 5 }).at(2).entry(5, false)
      .at(3).consent(1, 'searchRoom', true, true, { buildingId: 5 })
      .at(5).search(1, target, [drugs()], { claimedBasis: 'consent', buildingId: 5 });
  }

  it('a searchRoom consent makes a container search lawful and the evidence admissible', () => {
    const a = evaluate(log('container').build());
    expect(one(a, 'search')).toMatchObject({ outcome: 'lawful', basis: 'consent' });
    expect(a.evidence[0]?.admissible).toBe(true);
  });

  it('is the same as a room search', () => {
    expect(one(evaluate(log('room').build()), 'search').outcome).toBe('lawful');
  });

  it('a searchPremises consent also covers it, a person-only consent does not', () => {
    const ok = new LogBuilder().start().person(1, 'resident').consent(1, 'searchPremises', true, true, { buildingId: 5 })
      .at(2).entry(5, false).at(5).search(1, 'container', [drugs()], { claimedBasis: 'consent', buildingId: 5 });
    expect(one(evaluate(ok.build()), 'search').outcome).toBe('lawful');
    const no = new LogBuilder().start().person(1, 'resident').consent(1, 'entry', true, true, { buildingId: 5 })
      .at(2).entry(5, false).at(5).search(1, 'container', [drugs()], { claimedBasis: 'consent', buildingId: 5 });
    expect(one(evaluate(no.build()), 'search').outcome).toBe('unlawful');
  });
});

describe('entry on a search consent', () => {
  for (const kind of ['searchPremises', 'searchRoom'] as const) {
    it(`a ${kind} consent licenses entering and does not taint the building`, () => {
      const b = new LogBuilder().start().person(1, 'resident').consent(1, kind, true, true, { buildingId: 5 })
        .at(2).entry(5, false).at(5).search(1, 'container', [drugs()], { claimedBasis: 'consent', buildingId: 5 });
      const a = evaluate(b.build());
      expect(one(a, 'entry')).toMatchObject({ outcome: 'lawful', basis: 'consent' });
      expect(a.evidence[0]?.admissible).toBe(true);
    });
  }

  it('a consent for another building does not', () => {
    const b = new LogBuilder().start().person(1, 'resident').consent(1, 'searchPremises', true, true, { buildingId: 9 }).at(2).entry(5, false);
    expect(one(evaluate(b.build()), 'entry').outcome).toBe('unlawful');
  });
});

describe('exigency window and building', () => {
  it('a premises search 5000 s after the exigency is not lawful on exigency', () => {
    const b = new LogBuilder().start().person(1, 'suspect').exigency().entry(5, false).at(5000).search(1, 'premises', [drugs()], { buildingId: 5 });
    const a = evaluate(b.build());
    expect(one(a, 'search').outcome).toBe('unlawful');
    expect(a.evidence[0]?.admissible).toBe(false);
  });

  it('an exigency refreshed shortly before is still live', () => {
    const b = new LogBuilder().start().person(1, 'suspect').exigency().at(5000).exigency('emergency in progress', 5).entry(5, false)
      .at(5010).search(1, 'premises', [drugs()], { buildingId: 5 });
    const a = evaluate(b.build());
    expect(one(a, 'entry')).toMatchObject({ outcome: 'lawful', basis: 'exigency' });
    expect(one(a, 'search')).toMatchObject({ outcome: 'lawful', basis: 'exigency' });
  });

  it('a mid-call exigency logged before the breach makes the entry lawful', () => {
    const b = new LogBuilder('C-1', 'welfare').start().person(1, 'subject').at(60).exigency('emergency in progress', 5).entry(5, false);
    expect(one(evaluate(b.build()), 'entry')).toMatchObject({ outcome: 'lawful', basis: 'exigency' });
    const none = new LogBuilder('C-1', 'welfare').start().person(1, 'subject').at(60).entry(5, false);
    expect(one(evaluate(none.build()), 'entry').outcome).toBe('unlawful');
  });

  it('an exigency in another building does not cover this one', () => {
    const b = new LogBuilder().start().person(1, 'suspect').exigency('emergency in progress', 7).entry(5, false);
    expect(one(evaluate(b.build()), 'entry').outcome).toBe('unlawful');
  });
});

describe('serving a call-level arrest warrant', () => {
  function service(): LogBuilder {
    return new LogBuilder('C-1', 'wanted').start().warrant('arrest').warrant('search').person(1, 'suspect').indicator(1, 'callSuspect', 'call')
      .at(5).detain(1, 'cuffed').arrest(1).at(8).search(1, 'person', [drugs()]);
  }

  it('is lawful under both rulesets', () => {
    const { generic, strict } = both(service().build());
    for (const a of [generic, strict]) {
      expect(one(a, 'detention').outcome).toBe('lawful');
      expect(one(a, 'arrest').outcome).toBe('lawful');
      expect(one(a, 'search').outcome).toBe('lawful');
      expect(a.evidence[0]?.admissible).toBe(true);
    }
  });

  it('a witness at the same call is not covered by the warrant', () => {
    const b = new LogBuilder('C-1', 'wanted').start().warrant('arrest').person(2, 'witness').at(5).detain(2, 'cuffed');
    expect(dets(evaluate(b.build()), 'detention').every((d) => d.outcome === 'unlawful')).toBe(true);
  });
});

describe('commands to non-suspects', () => {
  it('a complied command to a victim is not a detention', () => {
    const a = evaluate(new LogBuilder('C-1', 'domestic').start().person(2, 'victim').at(3).detain(2, 'command').build());
    expect(dets(a, 'detention')).toHaveLength(0);
  });

  it('does not taint what the victim says afterwards', () => {
    const b = new LogBuilder('C-1', 'domestic').start().person(2, 'victim').at(3).detain(2, 'command').at(4).indicator(2, 'victimInjury');
    expect(dets(evaluate(b.build()), 'detention')).toHaveLength(0);
  });

  it('a command to a suspect without suspicion is still unlawful', () => {
    const a = evaluate(new LogBuilder('C-1', 'domestic').start().person(2, 'suspect').at(3).detain(2, 'command').build());
    expect(one(a, 'detention').outcome).toBe('unlawful');
  });
});

describe('force tool display words', () => {
  const tools = (): string[] => {
    const ids = new Set<string>(FORCE_TOOLS);
    for (const row of Object.values(mappingJson.forceUsed)) ids.add(row[1] ?? '');
    return [...ids];
  };

  it('every force tool has a label in the report and the cross-examination tables', () => {
    for (const t of tools()) {
      expect(reportJson.words.tool, t).toHaveProperty(t);
      expect(questionsJson.labels.tool, t).toHaveProperty(t);
    }
  });

  it('a tackle reads as words in the report checklist', () => {
    const b = new LogBuilder().start().person(1, 'suspect', 'Sam').force(1, 'hardHands', 'active', { tool: 'tackle' });
    const log = b.build();
    const text = buildReportChoices(log, evaluate(log), getRuleset('generic'), 1).map((c) => c.text).join('\n');
    expect(text).toContain('a tackle');
    expect(text).not.toMatch(/used (tackle|cuffResisted|struggle)\b/);
  });
});

describe('an invocation stands', () => {
  it('a later waiver event does not undo it: questioning stays unlawful', () => {
    const b = new LogBuilder().start().person(1, 'suspect').detain(1, 'cuffed').miranda(1, 'invoked').at(20).miranda(1, 'waived')
      .at(30).question(1, 'drinking', true);
    const a = evaluate(b.build());
    expect(dets(a, 'miranda').some((d) => d.outcome === 'unlawful')).toBe(true);
  });
});
