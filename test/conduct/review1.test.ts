import { describe, expect, it } from 'vitest';
import { iaTriggers, resolveIa } from '../../src/conduct/ia';
import { IA_CONFIG } from '../../src/conduct/data';
import { evaluate } from '../legal/helpers';
import { forceEvent, harness, LogBuilder } from './helpers';

function caseOf(log: ReturnType<LogBuilder['build']>) {
  const a = evaluate(log);
  const triggers = iaTriggers(a, log, IA_CONFIG, 1, 0.5, 0, () => 0);
  const c = {
    id: 'IA-0001', key: log.key, openedGame: 0, triggers, severity: 'minor' as const, status: 'open' as const, statement: null,
    finding: null, untruthful: false, discipline: [], closedGame: -1,
  };
  return { a, c };
}

describe('recording violations', () => {
  it('can be sustained when the bodycam was never on', () => {
    const b = new LogBuilder('C-1', 'trafficStop').cam(false).start().person(1, 'driver').after(20).detain(1, 'trafficStop').search(1, 'person');
    const log = b.build();
    const { a, c } = caseOf(log);
    expect(c.triggers.map((t) => t.rule)).toContain('recordingViolation');
    const r = resolveIa(c, a, log, { kind: 'none' });
    expect(r.finding).toBe('sustained');
    expect(r.severity).toBe('minor');
  });

  it('an unrelated violation without footage is still not sustained', () => {
    const b = new LogBuilder('C-1', 'trafficStop').cam(false).start().person(1, 'driver').after(20).detain(1, 'trafficStop').search(1, 'person');
    const log = b.build();
    const { a, c } = caseOf(log);
    const only = { ...c, triggers: c.triggers.filter((t) => t.rule !== 'recordingViolation') };
    expect(only.triggers.length).toBeGreaterThan(0);
    expect(resolveIa(only, a, log, { kind: 'none' }).finding).toBe('notSustained');
  });
});

describe('discipline severity', () => {
  it('a justified lethal shooting plus a minor violation is not terminated or charged', () => {
    const h = harness();
    const b = new LogBuilder('C-1', 'disturbance').cam(false).start().person(1, 'suspect').after(20).detain(1, 'command').force(1, 'firearm', 'lethal');
    const forceId = b.lastId;
    const log = b.build();
    const f = forceEvent(log, forceId);
    f.fatal = true;
    f.injury = 1;
    const a = evaluate(log);
    expect(a.force[0]?.verdict).toBe('justified');
    h.incidents.add(log, a);
    h.state.request({ kind: 'incidentClosed', key: 'C-1', aggressiveLines: 0 });
    h.step();
    const c = h.state.career.ia.find((x) => x.key === 'C-1');
    expect(c?.severity).toBe('critical');
    h.state.request({ kind: 'iaStatement', caseId: c?.id ?? '', statement: { kind: 'none' } });
    h.step();
    const done = h.state.iaCase(c?.id ?? '');
    expect(done?.finding).toBe('sustained');
    const actions = done?.discipline.map((d) => d.action) ?? [];
    expect(actions).not.toContain('termination');
    expect(actions).not.toContain('criminalCharges');
    expect(actions).not.toContain('civilSuit');
    expect(h.state.career.status).not.toBe('terminated');
  });
});
