import { describe, expect, it } from 'vitest';
import { IA_CONFIG } from '../../src/conduct/data';
import { iaStatementOptions } from '../../src/conduct/ia';
import { evaluateIncident } from '../../src/legal/evaluate';
import { buildReportChoices } from '../../src/legal/report';
import { getRuleset } from '../../src/legal/ruleset';
import { LogBuilder, forceEvent, harness, topics, type Harness } from './helpers';

/** Wires the real legal engine into the fake incident source. */
function register(h: Harness, log: ReturnType<LogBuilder['build']>, rulesetId = 'generic'): ReturnType<typeof evaluateIncident> {
  const rs = getRuleset(rulesetId);
  const a = evaluateIncident(log, rs);
  h.incidents.add(log, a, buildReportChoices(log, a, rs, 42));
  return a;
}

describe('conduct on real legal assessments', () => {
  it('a restrained subject tased on camera: IA case, options, untruthful vs honest account', () => {
    const b = new LogBuilder('C-00100', 'disturbance');
    b.start().person(1, 'suspect', 'Mr. Doe').after(1).detain(1, 'cuffed').after(1).arrest(1).after(1).force(1, 'taser', 'active', { restrained: true });
    const forceId = b.lastId;
    b.after(1).release(1, 'release');
    const log = b.build();
    const h = harness();
    const a = register(h, log);
    expect(a.force[0]?.verdict).toBe('excessive');

    h.state.request({ kind: 'incidentClosed', key: log.key, aggressiveLines: 0 });
    h.step();
    const c = h.state.career.ia[0];
    expect(c?.severity).toBe('major');
    expect(c?.triggers.map((t) => t.rule)).toContain('excessiveForce');
    expect(topics(h, 'conduct:ia')).toHaveLength(1);

    if (!c) throw new Error('no case');
    const options = iaStatementOptions(c, log);
    const honest = options.find((o) => o.statement.kind === 'account');
    const lie = options.filter((o) => o.statement.kind === 'account')[1];
    expect(honest?.text).toContain('active');
    expect(lie?.text).toContain('assaultive');

    h.state.request({ kind: 'iaStatement', caseId: c.id, statement: lie?.statement ?? { kind: 'none' } });
    h.step();
    expect(h.state.iaCase(c.id)).toMatchObject({ finding: 'sustained', untruthful: true });
    expect(forceId).toBeGreaterThan(0);
  });

  it('the same incident without footage is not sustained, and an honest ack is', () => {
    const make = (cam: boolean) => {
      const b = new LogBuilder('C-00101', 'disturbance');
      if (!cam) b.cam(false);
      b.start().person(1, 'suspect', 'Mr. Doe').after(1).detain(1, 'cuffed').after(1).arrest(1).after(1).force(1, 'taser', 'active', { restrained: true });
      return b.build();
    };
    for (const [cam, statement, finding] of [[false, 'none', 'notSustained'], [false, 'acknowledge', 'sustained'], [true, 'none', 'sustained']] as const) {
      const h = harness();
      register(h, make(cam));
      h.state.request({ kind: 'incidentClosed', key: 'C-00101', aggressiveLines: 0 });
      h.step();
      const id = h.state.career.ia[0]?.id ?? '';
      h.state.request({ kind: 'iaStatement', caseId: id, statement: { kind: statement } });
      h.step();
      expect(h.state.iaCase(id)?.finding, `${cam} ${statement}`).toBe(finding);
    }
  });

  it('a clean traffic stop opens no case, and a perfect report grades A', () => {
    const b = new LogBuilder('C-00102', 'trafficStop');
    b.start().person(1, 'driver', 'Ms. Roe').indicator(1, 'trafficViolation').after(1).detain(1, 'trafficStop').after(1).release(1, 'citation');
    const log = b.build();
    const h = harness({ configs: { ia: { ...IA_CONFIG, complaint: { ...IA_CONFIG.complaint, max: 0 } } } });
    const a = register(h, log);
    expect(a.summary.unlawful).toBe(0);
    h.state.request({ kind: 'incidentClosed', key: log.key, aggressiveLines: 0 });
    const key = h.incidents.reportChoices(log.key).filter((c) => c.key).map((c) => c.id);
    h.state.request({ kind: 'report', key: log.key, docId: 'CIT-1', assertions: key });
    h.step();
    expect(h.state.career.ia).toHaveLength(0);
    expect(h.state.reportGrade('CIT-1')).toMatchObject({ score: 100, letter: 'A' });
    expect(h.state.trust('downtown')).toBeGreaterThan(0.45);
  });

  it('judges under the strict ruleset too', () => {
    const b = new LogBuilder('C-00103', 'disturbance');
    b.start().person(1, 'suspect', 'Mr. Doe').after(1).force(1, 'baton', 'passive');
    const id = b.lastId;
    const log = b.build();
    forceEvent(log, id).injury = 0.4;
    const h = harness();
    register(h, log, 'strict');
    h.state.request({ kind: 'incidentClosed', key: log.key, aggressiveLines: 0 });
    h.step();
    expect(h.state.career.stats.incidents).toBe(1);
    expect(h.state.trust('downtown')).toBeLessThan(0.45);
  });
});
