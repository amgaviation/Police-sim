import { describe, expect, it } from 'vitest';
import { IA_CONFIG, type IaConfig } from '../../src/conduct/data';
import { complaintChance, disciplineFor, iaStatementOptions, iaTriggers, resolveIa, ruleLabel } from '../../src/conduct/ia';
import type { IaCase, IaStatement, IaTrigger } from '../../src/conduct/types';
import { LogBuilder, assess, det, forceEvent, forceLog, ruling } from './helpers';

const noInjury = (): number => 0;
const NO_COMPLAINT = 0.99;

function triggers(a: ReturnType<typeof assess>, log = new LogBuilder().start().person(1, 'suspect').build(), over: { roll?: number; trust?: number; lines?: number; injury?: (id: number) => number } = {}): IaTrigger[] {
  return iaTriggers(a, log, IA_CONFIG, over.roll ?? NO_COMPLAINT, over.trust ?? 0.5, over.lines ?? 0, over.injury ?? noInjury);
}

function ids(ts: IaTrigger[]): string[] {
  return ts.map((t) => t.rule);
}

describe('iaTriggers', () => {
  it('fires nothing on a clean incident', () => {
    expect(triggers(assess('k'))).toEqual([]);
  });

  it('excessiveForce: one trigger listing the excessive own rulings, other officers excluded', () => {
    const log = new LogBuilder().start().person(1, 'suspect').force(1, 'baton', 'passive').force(1, 'baton', 'passive').build();
    const [f1, f2] = log.events.filter((e) => e.kind === 'force');
    const a = assess(log.key, { force: [ruling(f1?.id ?? 0, 'excessive'), ruling(f2?.id ?? 0, 'justified'), ruling(99, 'excessive', { other: true })] });
    const ts = triggers(a, log);
    expect(ts).toEqual([{ rule: 'excessiveForce', severity: 'major', eventIds: [f1?.id] }]);
    expect(ids(triggers(assess(log.key, { force: [ruling(99, 'excessive', { other: true })] }), log))).toEqual([]);
  });

  it('questionableForce honours minCount', () => {
    const log = new LogBuilder().start().person(1, 'suspect').build();
    expect(ids(triggers(assess('k', { force: [ruling(5, 'questionable')] }), log))).toEqual([]);
    const two = triggers(assess('k', { force: [ruling(5, 'questionable'), ruling(6, 'questionable')] }), log);
    expect(two).toEqual([{ rule: 'questionableForce', severity: 'minor', eventIds: [5, 6] }]);
    expect(ids(triggers(assess('k', { force: [ruling(5, 'questionable'), ruling(6, 'justified'), ruling(7, 'questionable', { other: true })] }), log))).toEqual([]);
  });

  it('lethalForce: any firearm force event that hit', () => {
    const b = new LogBuilder().start().person(1, 'suspect').force(1, 'firearm', 'lethal');
    const id = b.lastId;
    const log = b.build();
    expect(triggers(assess(log.key, { force: [ruling(id, 'justified', { level: 'firearm' })] }), log)).toEqual([{ rule: 'lethalForce', severity: 'critical', eventIds: [id] }]);
    forceEvent(log, id).hit = false;
    expect(ids(triggers(assess(log.key), log))).toEqual([]);
    const taser = new LogBuilder().start().person(1, 'suspect').force(1, 'taser', 'lethal').build();
    expect(ids(triggers(assess(taser.key), taser))).toEqual([]);
  });

  it('doctrine rules match doctrine and outcome, with their eventIds', () => {
    const log = new LogBuilder().start().person(1, 'suspect').build();
    const t = (doctrine: Parameters<typeof det>[0], outcome: Parameters<typeof det>[1] = 'unlawful'): string[] =>
      ids(triggers(assess('k', { dets: [det(doctrine, outcome, [4, 5])] }), log));
    expect(t('intervene')).toEqual(['failureToIntervene']);
    expect(t('recording')).toEqual(['recordingViolation']);
    expect(t('pursuit')).toEqual(['pursuitViolation']);
    expect(t('search')).toEqual(['unlawfulSearch']);
    expect(t('intervene', 'lawful')).toEqual([]);
    expect(t('search', 'questionable')).toEqual([]);
    expect(t('detention')).toEqual([]);
    const ts = triggers(assess('k', { dets: [det('recording', 'unlawful', [4, 5]), det('recording', 'unlawful', [5, 6])] }), log);
    expect(ts[0]?.eventIds).toEqual([4, 5, 6]);
  });

  it('doctrine minCount applies to the number of determinations', () => {
    const cfg: IaConfig = { ...IA_CONFIG, rules: [{ id: 'many', when: 'doctrine', doctrine: 'search', outcome: 'unlawful', severity: 'minor', minCount: 2 }] };
    const log = new LogBuilder().start().build();
    const one = iaTriggers(assess('k', { dets: [det('search', 'unlawful', [1])] }), log, cfg, NO_COMPLAINT, 0.5, 0, noInjury);
    const two = iaTriggers(assess('k', { dets: [det('search', 'unlawful', [1]), det('search', 'unlawful', [2])] }), log, cfg, NO_COMPLAINT, 0.5, 0, noInjury);
    expect(one).toEqual([]);
    expect(two).toHaveLength(1);
  });

  it('injuryInCustody: a force event that hurt a person after their first arrest', () => {
    const b = new LogBuilder().start().person(1, 'suspect').force(1, 'hardHands', 'active');
    const before = b.lastId;
    b.arrest(1).force(1, 'hardHands', 'compliant');
    const after = b.lastId;
    const log = b.build();
    const a = assess(log.key);
    forceEvent(log, before).injury = 0.8;
    expect(ids(triggers(a, log))).toEqual([]);
    forceEvent(log, after).injury = 0.2;
    expect(ids(triggers(a, log))).toEqual([]);
    forceEvent(log, after).injury = 0.3;
    expect(triggers(a, log)).toEqual([{ rule: 'injuryInCustody', severity: 'major', eventIds: [after] }]);
    // total injury from the people record counts once the event hurt
    forceEvent(log, after).injury = 0.1;
    expect(ids(triggers(a, log, { injury: () => 0.6 }))).toEqual(['injuryInCustody']);
    forceEvent(log, after).injury = 0;
    expect(ids(triggers(a, log, { injury: () => 0.6 }))).toEqual([]);
    // another person's arrest does not count
    const other = new LogBuilder().start().person(1, 'a').person(2, 'b').arrest(2).force(1, 'hardHands', 'active').build();
    forceEvent(other, other.events.filter((e) => e.kind === 'force')[0]?.id ?? 0).injury = 0.9;
    expect(ids(triggers(assess(other.key), other))).toEqual([]);
  });

  it('complaint probability follows base + lines + low trust, clamped to max', () => {
    const c = IA_CONFIG.complaint;
    expect(complaintChance(IA_CONFIG, 0.5, 0)).toBeCloseTo(c.base, 10);
    expect(complaintChance(IA_CONFIG, 0.8, 0)).toBeCloseTo(c.base, 10);
    expect(complaintChance(IA_CONFIG, 0.5, 2)).toBeCloseTo(c.base + 2 * c.perAggressiveLine, 10);
    expect(complaintChance(IA_CONFIG, 0.1, 0)).toBeCloseTo(c.base + 0.4 * c.lowTrust, 10);
    expect(complaintChance(IA_CONFIG, 0, 100)).toBe(c.max);
    expect(complaintChance(IA_CONFIG, 0.5, -5)).toBeLessThan(c.base + 1e-9);
  });

  it('complaint fires strictly below the probability (roll boundaries)', () => {
    const a = assess('k');
    const p = complaintChance(IA_CONFIG, 0.5, 2);
    const at = (roll: number): string[] => ids(triggers(a, undefined, { roll, lines: 2 }));
    expect(at(0)).toEqual(['complaint']);
    expect(at(p - 1e-9)).toEqual(['complaint']);
    expect(at(p)).toEqual([]);
    expect(at(0.999)).toEqual([]);
    expect(triggers(a, undefined, { roll: 0 })[0]).toEqual({ rule: 'complaint', severity: 'minor', eventIds: [] });
    // lower trust raises the chance
    const lowTrustP = complaintChance(IA_CONFIG, 0.1, 0);
    expect(ids(triggers(a, undefined, { roll: lowTrustP - 1e-9, trust: 0.1 }))).toEqual(['complaint']);
    expect(ids(triggers(a, undefined, { roll: lowTrustP - 1e-9, trust: 0.5 }))).toEqual([]);
  });

  it('can fire several rules at once, in rule order', () => {
    const log = new LogBuilder().start().person(1, 'suspect').build();
    const a = assess('k', { force: [ruling(3, 'excessive')], dets: [det('search', 'unlawful', [2])] });
    expect(ids(triggers(a, log, { roll: 0 }))).toEqual(['excessiveForce', 'unlawfulSearch', 'complaint']);
  });
});

function caseOf(ts: IaTrigger[], severity?: IaCase['severity']): IaCase {
  const order = ['minor', 'major', 'critical'] as const;
  const sev = severity ?? ts.reduce<IaCase['severity']>((s, t) => (order.indexOf(t.severity) > order.indexOf(s) ? t.severity : s), 'minor');
  return {
    id: 'IA-0001', key: 'k', openedGame: 0, triggers: ts, severity: sev, status: 'open', statement: null, finding: null, untruthful: false,
    discipline: [], closedGame: -1,
  };
}

const none: IaStatement = { kind: 'none' };

describe('iaStatementOptions', () => {
  it('offers the true and next higher resistance per force event, then acknowledge and none', () => {
    const { log, forceId } = forceLog();
    const c = caseOf([{ rule: 'excessiveForce', severity: 'major', eventIds: [forceId] }]);
    const opts = iaStatementOptions(c, log);
    expect(opts.map((o) => o.text)).toEqual([
      'When I used the taser, Mr. Doe was active.',
      'When I used the taser, Mr. Doe was assaultive.',
      'I acknowledge the policy violation.',
      'I have nothing to add.',
    ]);
    expect(opts[0]?.statement).toEqual({ kind: 'account', claims: [{ eventId: forceId, resistance: 'active' }] });
    expect(opts[1]?.statement).toEqual({ kind: 'account', claims: [{ eventId: forceId, resistance: 'assaultive' }] });
    expect(opts[2]?.statement).toEqual({ kind: 'acknowledge' });
    expect(opts[3]?.statement).toEqual(none);
  });

  it('caps the account options at four, skips presence and unrelated events, and has no higher level than lethal', () => {
    const b = new LogBuilder().start().person(1, 'Suspect', 'Mr. Doe').force(1, 'presence', 'active');
    const presence = b.lastId;
    b.force(1, 'ocSpray', 'passive');
    const f1 = b.lastId;
    b.force(1, 'baton', 'active');
    const f2 = b.lastId;
    b.force(1, 'hardHands', 'compliant');
    const f3 = b.lastId;
    b.force(1, 'firearm', 'lethal');
    const f4 = b.lastId;
    const log = b.build();
    const c = caseOf([{ rule: 'excessiveForce', severity: 'major', eventIds: [presence, f1, f2, f4] }]);
    const texts = iaStatementOptions(c, log).map((o) => o.text);
    expect(texts).toHaveLength(6);
    expect(texts[0]).toBe('When I used the oc spray, Mr. Doe was passive.');
    expect(texts[2]).toBe('When I used the baton, Mr. Doe was active.');
    expect(texts.join('|')).not.toContain('the hands');
    expect(f3).toBeGreaterThan(0);
    const lethalOnly = iaStatementOptions(caseOf([{ rule: 'lethalForce', severity: 'critical', eventIds: [f4] }]), log);
    expect(lethalOnly.map((o) => o.text)).toEqual(['When I used the firearm, Mr. Doe was lethal.', 'I acknowledge the policy violation.', 'I have nothing to add.']);
  });

  it('offers only acknowledge and none without force events', () => {
    const log = new LogBuilder().start().person(1, 'suspect').build();
    expect(iaStatementOptions(caseOf([{ rule: 'complaint', severity: 'minor', eventIds: [] }]), log)).toHaveLength(2);
  });
});

describe('resolveIa', () => {
  const excessive = (cam = true) => {
    const { log, forceId } = forceLog('k', { cam });
    const a = assess('k', { force: [ruling(forceId, 'excessive', { resistance: 'active' })], dets: [] });
    const c = caseOf(triggers(a, log));
    return { log, forceId, a, c };
  };

  it('sustains an excessive force finding recorded by the bodycam', () => {
    const { log, a, c } = excessive();
    const r = resolveIa(c, a, log, none);
    expect(r.finding).toBe('sustained');
    expect(r.untruthful).toBe(false);
    expect(r.reasons.join(' ')).toContain('Excessive force');
  });

  it('does not sustain a violation the camera did not record, unless critical or acknowledged', () => {
    const { log, a, c } = excessive(false);
    expect(resolveIa(c, a, log, none).finding).toBe('notSustained');
    expect(resolveIa(c, a, log, { kind: 'acknowledge' }).finding).toBe('sustained');
    expect(resolveIa({ ...c, severity: 'critical' }, a, log, none).finding).toBe('sustained');
  });

  it('IA statement options name a tackle and a cuffing struggle in words', () => {
    for (const [tool, word] of [['tackle', 'the tackle'], ['cuffResisted', 'the handcuffing']] as const) {
      const b = new LogBuilder('k').start().person(1, 'suspect', 'Doe').cam(true).force(1, 'hardHands', 'active', { tool });
      const id = b.lastId;
      const log = b.build();
      const a = assess('k', { force: [ruling(id, 'excessive')] });
      const texts = iaStatementOptions(caseOf(triggers(a, log)), log).map((o) => o.text).join('\n');
      expect(texts).toContain(`When I used ${word}`);
    }
  });

  it('a muted camera recorded nothing, so the violation is not sustained', () => {
    const b = new LogBuilder('k').start().person(1, 'suspect').cam(true, true).force(1, 'taser', 'active');
    const id = b.lastId;
    const log = b.build();
    const a = assess('k', { force: [ruling(id, 'excessive')] });
    const c = caseOf(triggers(a, log));
    expect(resolveIa(c, a, log, none).finding).toBe('notSustained');
    expect(resolveIa(c, a, log, { kind: 'acknowledge' }).finding).toBe('sustained');
  });

  it('an unmuted camera still sustains it', () => {
    const b = new LogBuilder('k').start().person(1, 'suspect').cam(true).force(1, 'taser', 'active');
    const id = b.lastId;
    const log = b.build();
    const a = assess('k', { force: [ruling(id, 'excessive')] });
    expect(resolveIa(caseOf(triggers(a, log)), a, log, none).finding).toBe('sustained');
  });

  it('exonerates when nothing is a violation: questionable force, justified firearm', () => {
    const log = new LogBuilder().start().person(1, 'suspect').build();
    const q = assess('k', { force: [ruling(5, 'questionable'), ruling(6, 'questionable')] });
    expect(resolveIa(caseOf(triggers(q, log)), q, log, none).finding).toBe('exonerated');

    const b = new LogBuilder('k').start().person(1, 'suspect').force(1, 'firearm', 'lethal');
    const id = b.lastId;
    const fl = b.build();
    const a = assess('k', { force: [ruling(id, 'justified', { level: 'firearm' })] });
    const c = caseOf(triggers(a, fl));
    expect(c.severity).toBe('critical');
    const r = resolveIa(c, a, fl, none);
    expect(r.finding).toBe('exonerated');
    expect(r.reasons.join(' ')).toContain('deadly force');
  });

  it('sustains an excessive firearm shooting even when critical', () => {
    const b = new LogBuilder('k').start().person(1, 'suspect').force(1, 'firearm', 'passive');
    const id = b.lastId;
    const log = b.build();
    const a = assess('k', { force: [ruling(id, 'excessive', { level: 'firearm' })] });
    expect(resolveIa(caseOf(triggers(a, log)), a, log, none).finding).toBe('sustained');
  });

  it('sustains unlawful doctrine triggers', () => {
    const log = new LogBuilder().start().person(1, 'suspect').build();
    const a = assess('k', { dets: [det('intervene', 'unlawful', [1])] });
    expect(resolveIa(caseOf(triggers(a, log)), a, log, none).finding).toBe('sustained');
    const search = assess('k', { dets: [det('search', 'unlawful', [1])] });
    expect(resolveIa(caseOf(triggers(search, log)), search, log, none).finding).toBe('sustained');
  });

  it('injuryInCustody is a violation only with a non-justified force ruling', () => {
    const b = new LogBuilder('k').start().person(1, 'suspect').arrest(1).force(1, 'hardHands', 'compliant');
    const id = b.lastId;
    const log = b.build();
    forceEvent(log, id).injury = 0.6;
    const bad = assess('k', { force: [ruling(id, 'questionable', { level: 'hardHands' })] });
    const t = triggers(bad, log);
    expect(ids(t)).toContain('injuryInCustody');
    expect(resolveIa(caseOf(t), bad, log, none).finding).toBe('sustained');
    const fine = assess('k', { force: [ruling(id, 'justified', { level: 'hardHands' })] });
    expect(resolveIa(caseOf(triggers(fine, log)), fine, log, none).finding).toBe('exonerated');
  });

  it('a complaint alone is unfounded on a clean assessment, otherwise exonerated or by the violations', () => {
    const log = new LogBuilder().start().person(1, 'suspect').build();
    const clean = assess('k');
    const c = caseOf([{ rule: 'complaint', severity: 'minor', eventIds: [] }]);
    expect(resolveIa(c, clean, log, none).finding).toBe('unfounded');
    const questionable = assess('k', { dets: [det('detention', 'unlawful', [1])] });
    expect(resolveIa(c, questionable, log, none).finding).toBe('exonerated');
    const both = caseOf([{ rule: 'complaint', severity: 'minor', eventIds: [] }, { rule: 'recordingViolation', severity: 'minor', eventIds: [1] }]);
    expect(resolveIa(both, assess('k', { dets: [det('recording', 'unlawful', [1])] }), log, none).finding).toBe('sustained');
    expect(resolveIa(both, clean, log, none).finding).not.toBe('unfounded');
  });

  it('an account contradicting the recorded resistance is untruthful and sustains the case', () => {
    const { log, forceId, a, c } = excessive();
    const lie: IaStatement = { kind: 'account', claims: [{ eventId: forceId, resistance: 'assaultive' }] };
    const r = resolveIa(c, a, log, lie);
    expect(r).toMatchObject({ finding: 'sustained', untruthful: true });
    expect(r.reasons).toContain('untruthfulness');
    const truth: IaStatement = { kind: 'account', claims: [{ eventId: forceId, resistance: 'active' }] };
    expect(resolveIa(c, a, log, truth).untruthful).toBe(false);
    // even a justified-use case is sustained when the officer lies
    const ok = assess('k', { force: [ruling(forceId, 'justified')] });
    const q = caseOf([{ rule: 'complaint', severity: 'minor', eventIds: [] }]);
    expect(resolveIa(q, ok, log, lie).finding).toBe('sustained');
  });

  it('a false account about an event the camera did not record is not provably untruthful', () => {
    const { log, forceId, a, c } = excessive(false);
    const lie: IaStatement = { kind: 'account', claims: [{ eventId: forceId, resistance: 'assaultive' }] };
    expect(resolveIa(c, a, log, lie)).toMatchObject({ untruthful: false, finding: 'notSustained' });
    expect(resolveIa(c, a, log, { kind: 'account', claims: [{ eventId: 9999, resistance: 'lethal' }] }).untruthful).toBe(false);
  });
});

describe('disciplineFor', () => {
  const sus = (sev: IaCase['severity'], prior: number, injury = 0, fatal = false, firearm = false): ReturnType<typeof disciplineFor> =>
    disciplineFor('sustained', sev, prior, injury, fatal, firearm);
  const brief = (l: ReturnType<typeof disciplineFor>): string[] => l.map((d) => (d.hours > 0 ? `${d.action}:${d.hours}` : d.action));

  it('returns nothing for findings other than sustained', () => {
    for (const f of ['exonerated', 'unfounded', 'notSustained'] as const) expect(disciplineFor(f, 'critical', 5, 1, true, true)).toEqual([]);
  });

  it('climbs the ladder by prior sustained cases and stops at the last rung', () => {
    expect(brief(sus('minor', 0))).toEqual(['counseling']);
    expect(brief(sus('minor', 1))).toEqual(['writtenReprimand']);
    expect(brief(sus('minor', 2))).toEqual(['suspension:8']);
    expect(brief(sus('minor', 9))).toEqual(['suspension:8']);
    expect(brief(sus('major', 0))).toEqual(['suspension:16']);
    expect(brief(sus('major', 1))).toEqual(['suspension:40']);
    expect(brief(sus('major', 2))).toEqual(['termination']);
    expect(brief(sus('critical', 0))).toEqual(['termination']);
    expect(brief(sus('critical', 3))).toEqual(['termination']);
    expect(brief(sus('minor', -3))).toEqual(['counseling']);
  });

  it('adds a civil suit rounded to thousands from the injury', () => {
    expect(brief(sus('minor', 0, 0.29))).toEqual(['counseling']);
    const l = sus('minor', 0, 0.3);
    expect(brief(l)).toEqual(['counseling', 'civilSuit']);
    expect(l[1]?.amount).toBe(145000);
    expect(sus('minor', 0, 0.6)[1]?.amount).toBe(265000);
    expect((sus('minor', 0, 0.3333)[1]?.amount ?? 1) % 1000).toBe(0);
    expect(sus('minor', 0, 0.3333)[1]?.amount).toBe(158000);
  });

  it('files criminal charges and terminates for a death or a serious firearm injury', () => {
    expect(brief(sus('major', 0, 1, true, true))).toEqual(['suspension:16', 'civilSuit', 'criminalCharges', 'termination']);
    expect(brief(sus('minor', 0, 0, true))).toEqual(['counseling', 'criminalCharges', 'termination']);
    expect(brief(sus('critical', 0, 0, true, true))).toEqual(['termination', 'criminalCharges']);
    expect(brief(sus('critical', 0, 0.5, false, true))).toEqual(['termination', 'civilSuit', 'criminalCharges']);
    expect(brief(sus('minor', 0, 0.49, false, true))).toEqual(['counseling', 'civilSuit']);
    expect(brief(sus('minor', 0, 0.5, false, false))).toEqual(['counseling', 'civilSuit']);
  });
});

describe('ruleLabel', () => {
  it('humanizes rule ids', () => {
    expect(ruleLabel('failureToIntervene')).toBe('Failure to intervene');
    expect(ruleLabel('complaint')).toBe('Complaint');
  });
});
