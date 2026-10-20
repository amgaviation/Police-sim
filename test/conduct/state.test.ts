import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { IA_CONFIG, TRUST_CONFIG } from '../../src/conduct/data';
import type { IaStatement } from '../../src/conduct/types';
import { isConductSave } from '../../src/conduct/save';
import { ConductState } from '../../src/conduct/conductState';
import { TRUST } from '../../src/dialogue/data';
import { assess, choice, det, forceEvent, forceLog, harness, person, ruling, topics, type Harness } from './helpers';

const HOUR = 3600;

/** Registers an incident whose only force was ruled excessive (recorded by default). */
function excessive(h: Harness, key: string, opts: { cam?: boolean; injury?: number; fatal?: boolean; level?: 'taser' | 'firearm' } = {}): number {
  const { log, forceId } = forceLog(key, { cam: opts.cam ?? true, level: opts.level ?? 'taser', ...(opts.injury !== undefined ? { injury: opts.injury } : {}) });
  if (opts.fatal) forceEvent(log, forceId).fatal = true;
  h.incidents.add(log, assess(key, { force: [ruling(forceId, 'excessive', { level: opts.level ?? 'taser' })] }));
  return forceId;
}

function close(h: Harness, key: string, lines = 0): void {
  h.state.request({ kind: 'incidentClosed', key, aggressiveLines: lines });
  h.step();
}

function openCase(h: Harness, key: string): string {
  close(h, key);
  const c = h.state.career.ia.findLast((x) => x.key === key);
  if (!c) throw new Error('no IA case opened');
  return c.id;
}

function statement(h: Harness, caseId: string, s: IaStatement): void {
  h.state.request({ kind: 'iaStatement', caseId, statement: s });
  h.step();
}

describe('ConductState: incident closed', () => {
  it('starts as a clean career at the baselines', () => {
    const h = harness();
    const c = h.state.career;
    expect(c).toMatchObject({ status: 'active', points: 0, credibility: 0.85, commendations: [], discipline: [], ia: [], reports: [] });
    expect(c.stats).toEqual({ incidents: 0, arrests: 0, lawfulArrests: 0, excessiveForce: 0, convictions: 0, dismissals: 0, reportsFiled: 0, avgReport: 0 });
    for (const [k, v] of TRUST) expect(h.state.trust(k)).toBe(v);
    expect(h.state.dutyStatus(h.game)).toEqual({ status: 'active', untilGame: -1, reason: '' });
  });

  it('opens an IA case and moves trust for an excessive-force incident', () => {
    const h = harness();
    excessive(h, 'C-1');
    close(h, 'C-1');
    const c = h.state.career;
    expect(c.ia).toHaveLength(1);
    expect(c.ia[0]).toMatchObject({ id: 'IA-0001', key: 'C-1', severity: 'major', status: 'open', finding: null, openedGame: h.game });
    expect(c.ia[0]?.triggers.map((t) => t.rule)).toEqual(['excessiveForce']);
    expect(topics(h, 'conduct:ia')).toEqual([{ caseId: 'IA-0001', key: 'C-1', reasons: ['Excessive force'] }]);
    const d = TRUST_CONFIG.deltas.excessiveForce;
    expect(h.state.trust('downtown')).toBeCloseTo(0.45 + d, 10);
    expect(h.state.trust('suburbs')).toBeCloseTo(0.65 + d * TRUST_CONFIG.spill, 10);
    expect(topics(h, 'conduct:trust')).toEqual([{ district: 'downtown', value: h.state.trust('downtown'), delta: d, reason: 'incident C-1', }]);
    expect(c.stats.incidents).toBe(1);
    expect(c.stats.excessiveForce).toBe(1);
    expect(h.state.iaCase('IA-0001')).toBe(c.ia[0]);
    expect(h.state.iaCase('IA-0002')).toBeNull();
  });

  it('numbers cases in order and ignores incidents the recorder does not know', () => {
    const h = harness();
    excessive(h, 'C-1');
    excessive(h, 'C-2');
    close(h, 'C-1');
    close(h, 'C-9');
    close(h, 'C-2');
    expect(h.state.career.ia.map((c) => c.id)).toEqual(['IA-0001', 'IA-0002']);
    expect(h.state.career.stats.incidents).toBe(2);
  });

  it('suppresses the trust event for a tiny delta but still applies it', () => {
    const h = harness();
    h.incidents.add(forceLog('C-1').log, assess('C-1'));
    close(h, 'C-1', 1);
    expect(h.state.trust('downtown')).toBeCloseTo(0.45 + TRUST_CONFIG.deltas.aggressiveLine, 10);
    expect(topics(h, 'conduct:trust')).toEqual([]);
  });

  it('makes exactly one complaint draw per closed incident', () => {
    const h = harness({ seed: 21 });
    const ref = createRng(21).stream('conduct');
    h.incidents.add(forceLog('C-1').log, assess('C-1'));
    h.incidents.add(forceLog('C-2').log, assess('C-2'));
    h.state.request({ kind: 'incidentClosed', key: 'C-1', aggressiveLines: 0 });
    h.state.request({ kind: 'incidentClosed', key: 'C-2', aggressiveLines: 3 });
    h.state.request({ kind: 'incidentClosed', key: 'C-404', aggressiveLines: 0 });
    h.step();
    ref.next();
    ref.next();
    expect(h.state.serialize().rng).toEqual(ref.state());
  });

  it('opens a complaint case from the roll and resolves a baseless one as unfounded', () => {
    const h = harness({ configs: { ia: { ...IA_CONFIG, complaint: { base: 1, perAggressiveLine: 0, lowTrust: 0, max: 1 } } } });
    h.incidents.add(forceLog('C-1').log, assess('C-1'));
    const id = openCase(h, 'C-1');
    expect(h.state.iaCase(id)?.severity).toBe('minor');
    statement(h, id, { kind: 'none' });
    expect(h.state.iaCase(id)).toMatchObject({ status: 'closed', finding: 'unfounded', discipline: [] });
    expect(topics(h, 'conduct:iaResolved')).toEqual([{ caseId: id, finding: 'unfounded', discipline: [] }]);
    expect(h.state.career.credibility).toBe(0.85);
  });

  it('counts arrests and awards incident commendations with trust', () => {
    const h = harness();
    const { log } = forceLog('C-1');
    log.events = log.events.filter((e) => e.kind !== 'force');
    log.events.push({ id: 90, t: 9, game: 1009, personId: 1, cam: 1, kind: 'indicator', indicator: 'weaponSeen', source: 'observation', sourceEvent: -1, detail: '' });
    log.events.push({ id: 91, t: 10, game: 1010, personId: 1, cam: 1, kind: 'arrest', how: 'cuff' });
    h.incidents.add(log, assess('C-1', { dets: [det('arrest', 'lawful', [91])], persons: [person(1, true, true), person(2, true, false)] }));
    close(h, 'C-1');
    expect(h.state.career.commendations.map((c) => c.id)).toEqual(['deEscalation']);
    expect(h.state.career.points).toBe(20);
    expect(h.state.career.stats).toMatchObject({ arrests: 2, lawfulArrests: 1 });
    expect(topics(h, 'conduct:commendation')).toEqual([{ id: 'deEscalation', label: 'De-escalation', key: 'C-1' }]);
    const t = TRUST_CONFIG.deltas;
    expect(h.state.trust('downtown')).toBeCloseTo(0.45 + t.lawfulArrest + t.deEscalation + t.commendation, 10);
  });
});

describe('ConductState: statements, findings and discipline', () => {
  it('a sustained major finding suspends, stacks, and ends with the clock', () => {
    const h = harness();
    excessive(h, 'C-1');
    const id = openCase(h, 'C-1');
    const at = h.game;
    statement(h, id, { kind: 'none' });
    const c = h.state.iaCase(id);
    expect(c).toMatchObject({ status: 'closed', finding: 'sustained', closedGame: at });
    expect(c?.discipline).toEqual([{ action: 'suspension', hours: 16, amount: 0, caseId: id, game: at }]);
    expect(h.state.career.discipline).toHaveLength(1);
    const until = at + 16 * HOUR;
    expect(h.state.dutyStatus(at + 1)).toEqual({ status: 'suspended', untilGame: until, reason: `Suspended (${id})` });
    expect(h.state.career.status).toBe('suspended');
    expect(h.state.career.points).toBe(-25);
    expect(h.state.career.credibility).toBeCloseTo(0.8, 10);
    expect(topics(h, 'conduct:discipline')).toEqual([{ action: 'suspension', hours: 16, amount: 0, caseId: id }]);
    expect(topics(h, 'conduct:status').at(-1)).toMatchObject({ status: 'suspended', untilGame: until });
    // the clock
    expect(h.state.dutyStatus(until - 1).status).toBe('suspended');
    expect(h.state.dutyStatus(until).status).toBe('active');
    h.step(until - 120);
    expect(h.state.career.status).toBe('suspended');
    h.step(until + 120);
    expect(h.state.career.status).toBe('active');
    expect(topics(h, 'conduct:status').at(-1)).toEqual({ status: 'active', untilGame: -1, reason: '' });
    // trust: excessive force at close, then the sustained finding
    expect(h.state.trust('downtown')).toBeGreaterThan(0);
  });

  it('a second suspension while suspended extends the first', () => {
    const h = harness();
    excessive(h, 'C-1');
    excessive(h, 'C-2');
    const a = openCase(h, 'C-1');
    const b = openCase(h, 'C-2');
    statement(h, a, { kind: 'none' });
    const first = h.state.career.statusUntilGame;
    statement(h, b, { kind: 'none' });
    expect(h.state.career.statusUntilGame).toBe(first + 40 * HOUR);
    expect(h.state.career.discipline.map((d) => d.hours)).toEqual([16, 40]);
  });

  it('acknowledging the violation steps down the ladder by one', () => {
    const h = harness();
    excessive(h, 'C-1');
    excessive(h, 'C-2');
    const a = openCase(h, 'C-1');
    const b = openCase(h, 'C-2');
    statement(h, a, { kind: 'none' });
    statement(h, b, { kind: 'acknowledge' });
    expect(h.state.iaCase(b)?.discipline.map((d) => `${d.action}:${d.hours}`)).toEqual(['suspension:16']);
  });

  it('a third major sustained case terminates, permanently', () => {
    const h = harness();
    for (const k of ['C-1', 'C-2', 'C-3']) excessive(h, k);
    for (const k of ['C-1', 'C-2', 'C-3']) statement(h, openCase(h, k), { kind: 'none' });
    expect(h.state.career.status).toBe('terminated');
    expect(h.state.career.statusUntilGame).toBe(-1);
    expect(h.state.dutyStatus(h.game + 9_999_999_999).status).toBe('terminated');
    h.step(h.game + 365 * 86400);
    expect(h.state.career.status).toBe('terminated');
    // later suspensions do not downgrade a termination
    excessive(h, 'C-4');
    statement(h, openCase(h, 'C-4'), { kind: 'none' });
    expect(h.state.career.status).toBe('terminated');
    expect(h.state.career.points).toBe(-25 - 25 - 100 - 100);
    // the console reinstates
    h.state.request({ kind: 'reinstate' });
    h.step();
    expect(h.state.career.status).toBe('active');
    expect(h.state.dutyStatus(h.game)).toEqual({ status: 'active', untilGame: -1, reason: '' });
  });

  it('a fatal sustained shooting files criminal charges and terminates', () => {
    const h = harness();
    excessive(h, 'C-1', { level: 'firearm', injury: 1, fatal: true });
    const id = openCase(h, 'C-1');
    expect(h.state.iaCase(id)?.severity).toBe('critical');
    statement(h, id, { kind: 'none' });
    expect(h.state.iaCase(id)?.discipline.map((d) => d.action)).toEqual(['termination', 'civilSuit', 'criminalCharges']);
    expect(h.state.career.status).toBe('terminated');
    expect(h.state.career.statusReason).toBe('Criminal charges filed');
  });

  it('a civil suit costs trust and records the amount', () => {
    const h = harness();
    excessive(h, 'C-1', { injury: 0.6 });
    const id = openCase(h, 'C-1');
    const before = h.state.trust('downtown');
    statement(h, id, { kind: 'none' });
    const suit = h.state.iaCase(id)?.discipline.find((d) => d.action === 'civilSuit');
    expect(suit?.amount).toBe(265000);
    const d = TRUST_CONFIG.deltas;
    expect(h.state.trust('downtown')).toBeCloseTo(before + d.sustainedIa + d.civilSuit, 10);
  });

  it('uses the people injury record for the civil suit amount', () => {
    const h = harness();
    excessive(h, 'C-1', { injury: 0.1 });
    const id = openCase(h, 'C-1');
    h.injuries.set(1, 0.6);
    statement(h, id, { kind: 'none' });
    expect(h.state.iaCase(id)?.discipline.find((d) => d.action === 'civilSuit')?.amount).toBe(265000);
  });

  it('an untruthful account sustains the case and costs credibility twice', () => {
    const h = harness();
    const forceId = excessive(h, 'C-1');
    const id = openCase(h, 'C-1');
    statement(h, id, { kind: 'account', claims: [{ eventId: forceId, resistance: 'assaultive' }] });
    expect(h.state.iaCase(id)).toMatchObject({ finding: 'sustained', untruthful: true });
    expect(h.state.career.credibility).toBeCloseTo(0.85 - 0.2 - 0.05, 10);
  });

  it('an unrecorded violation is not sustained: no discipline, no credibility loss', () => {
    const h = harness();
    excessive(h, 'C-1', { cam: false });
    const id = openCase(h, 'C-1');
    statement(h, id, { kind: 'none' });
    expect(h.state.iaCase(id)).toMatchObject({ finding: 'notSustained', discipline: [] });
    expect(h.state.career.status).toBe('active');
    expect(h.state.career.credibility).toBe(0.85);
  });

  it('ignores a statement for an unknown or already closed case', () => {
    const h = harness();
    excessive(h, 'C-1');
    const id = openCase(h, 'C-1');
    statement(h, 'IA-9999', { kind: 'none' });
    statement(h, id, { kind: 'none' });
    const discipline = h.state.career.discipline.length;
    statement(h, id, { kind: 'acknowledge' });
    expect(h.state.career.discipline).toHaveLength(discipline);
    expect(h.state.iaCase(id)?.statement).toEqual({ kind: 'none' });
  });

  it('auto-resolves a case without a statement after autoResolveH game hours', () => {
    const h = harness();
    excessive(h, 'C-1');
    const id = openCase(h, 'C-1');
    const opened = h.game;
    h.step(opened + 12 * HOUR - 120);
    expect(h.state.iaCase(id)?.status).toBe('open');
    h.step(opened + 12 * HOUR + 60);
    expect(h.state.iaCase(id)).toMatchObject({ status: 'closed', finding: 'sustained', statement: { kind: 'none' } });
    expect(h.state.career.status).toBe('suspended');
  });
});

describe('ConductState: reports', () => {
  function reportHarness(): Harness {
    const h = harness();
    const { log } = forceLog('C-1');
    h.incidents.add(log, assess('C-1'), [
      choice('a', 'true', { key: true }), choice('b', 'true', { key: true }), choice('c', 'false', { eventId: log.events[0]?.id ?? 1 }),
    ]);
    return h;
  }

  it('a blank report on an incident without key facts earns no commendation', () => {
    const h = harness();
    const { log } = forceLog('C-2');
    h.incidents.add(log, assess('C-2'), [choice('x', 'true')]);
    h.state.request({ kind: 'report', key: 'C-2', docId: 'DOC-2', assertions: [] });
    h.step();
    expect(h.state.reportGrade('DOC-2')).toMatchObject({ score: 0, letter: 'F' });
    expect(h.state.career.commendations).toEqual([]);
    h.state.request({ kind: 'report', key: 'C-2', docId: 'DOC-3', assertions: ['x'] });
    h.step();
    expect(h.state.reportGrade('DOC-3')?.score).toBe(100);
  });

  it('grades and stores a report, awarding points', () => {
    const h = reportHarness();
    h.state.request({ kind: 'report', key: 'C-1', docId: 'DOC-1', assertions: ['a', 'b'] });
    h.step();
    const g = h.state.reportGrade('DOC-1');
    expect(g).toMatchObject({ docId: 'DOC-1', key: 'C-1', score: 100, letter: 'A', game: h.game });
    expect(h.state.reportGrade('nope')).toBeNull();
    expect(topics(h, 'conduct:report')).toEqual([{ docId: 'DOC-1', key: 'C-1', score: 100, letter: 'A' }]);
    expect(h.state.career.points).toBe(6 + 10);
    expect(h.state.career.commendations.map((c) => c.id)).toEqual(['excellentReport']);
    expect(h.state.career.stats).toMatchObject({ reportsFiled: 1, avgReport: 100 });
  });

  it('refiling the same document replaces the grade without double counting', () => {
    const h = reportHarness();
    h.state.request({ kind: 'report', key: 'C-1', docId: 'DOC-1', assertions: ['a', 'b'] });
    h.state.request({ kind: 'report', key: 'C-1', docId: 'DOC-1', assertions: ['a'] });
    h.step();
    expect(h.state.career.reports).toHaveLength(1);
    expect(h.state.reportGrade('DOC-1')?.score).toBe(50);
    expect(h.state.career.stats).toMatchObject({ reportsFiled: 1, avgReport: 50 });
    expect(h.state.career.points).toBe(-4 + 10);
  });

  it('averages scores, keeps the last 50 reports and skips unknown incidents', () => {
    const h = reportHarness();
    h.state.request({ kind: 'report', key: 'C-1', docId: 'D1', assertions: ['a', 'b'] });
    h.state.request({ kind: 'report', key: 'C-1', docId: 'D2', assertions: ['a'] });
    h.state.request({ kind: 'report', key: 'C-9', docId: 'D3', assertions: [] });
    h.step();
    expect(h.state.career.stats.reportsFiled).toBe(2);
    expect(h.state.career.stats.avgReport).toBe(75);
    for (let i = 0; i < 60; i++) h.state.request({ kind: 'report', key: 'C-1', docId: `X${i}`, assertions: ['a'] });
    h.step();
    expect(h.state.career.reports).toHaveLength(50);
    expect(h.state.reportGrade('D1')).toBeNull();
    expect(h.state.reportGrade('X59')).not.toBeNull();
  });
});

describe('ConductState: verdicts and trust requests', () => {
  function filed(h: Harness, score: 'good' | 'bad'): void {
    const { log } = forceLog('C-1');
    h.incidents.add(log, assess('C-1'), [choice('a', 'true', { key: true }), choice('b', 'true', { key: true })]);
    h.state.request({ kind: 'report', key: 'C-1', docId: 'D1', assertions: score === 'good' ? ['a', 'b'] : ['a'] });
    h.step();
  }
  const verdict = (over: Partial<Extract<Parameters<ConductState['request']>[0], { kind: 'verdict' }>> = {}): Parameters<ConductState['request']>[0] => ({
    kind: 'verdict', key: 'C-1', caseId: 'CS-1', verdict: 'convicted', reason: '', credibilityDelta: 0, impeached: false, missed: false, ...over,
  });

  it('a clean conviction raises trust and earns commendations', () => {
    const h = harness();
    filed(h, 'good');
    h.state.request(verdict({ credibilityDelta: 0.05 }));
    h.step();
    const ids = h.state.career.commendations.map((c) => c.id);
    expect(ids).toEqual(['excellentReport', 'cleanCase', 'credibleTestimony']);
    expect(h.state.career.stats.convictions).toBe(1);
    expect(h.state.career.credibility).toBeCloseTo(0.9, 10);
    const d = TRUST_CONFIG.deltas;
    expect(h.state.trust('downtown')).toBeCloseTo(0.45 + d.conviction + 3 * d.commendation, 10);
  });

  it('an impeached conviction earns no testimony credit and a weak report no clean case', () => {
    const h = harness();
    filed(h, 'bad');
    h.state.request(verdict({ impeached: true, credibilityDelta: -0.1 }));
    h.step();
    expect(h.state.career.commendations).toEqual([]);
    expect(h.state.career.credibility).toBeCloseTo(0.75, 10);
    h.state.request(verdict({ credibilityDelta: -5 }));
    h.step();
    expect(h.state.career.credibility).toBe(0);
    h.state.request(verdict({ credibilityDelta: 5 }));
    h.step();
    expect(h.state.career.credibility).toBe(1);
  });

  it('a dismissal for misconduct costs trust; other dismissals only count', () => {
    const h = harness();
    const base = h.state.trust('downtown');
    h.state.request(verdict({ verdict: 'dismissed', reason: 'insufficientEvidence' }));
    h.step();
    expect(h.state.trust('downtown')).toBe(base);
    expect(h.state.career.stats.dismissals).toBe(1);
    h.state.request(verdict({ verdict: 'dismissed', reason: 'suppression' }));
    h.state.request(verdict({ verdict: 'dismissed', reason: 'unlawfulArrest' }));
    h.step();
    expect(h.state.trust('downtown')).toBeCloseTo(base + 2 * TRUST_CONFIG.deltas.dismissedMisconduct, 10);
    expect(h.state.career.stats.dismissals).toBe(3);
    expect(h.state.career.stats.convictions).toBe(0);
  });

  it('missing court costs trust and testimony credit', () => {
    const h = harness();
    const base = h.state.trust('downtown');
    h.state.request(verdict({ verdict: 'dismissed', missed: true, reason: 'missed' }));
    h.state.request(verdict({ verdict: 'convicted', missed: true }));
    h.step();
    const d = TRUST_CONFIG.deltas;
    expect(h.state.trust('downtown')).toBeCloseTo(base + 2 * d.missedCourt + d.conviction, 10);
    expect(h.state.career.commendations).toEqual([]);
  });

  it('applies a manual trust change with spill and an event', () => {
    const h = harness();
    h.state.request({ kind: 'trust', district: 'harbor', delta: -0.1, reason: 'console' });
    h.step();
    expect(h.state.trust('harbor')).toBeCloseTo(0.45 - 0.1, 10);
    expect(h.state.trust('park')).toBeCloseTo(0.55 - 0.1 * TRUST_CONFIG.spill, 10);
    expect(topics(h, 'conduct:trust')).toEqual([{ district: 'harbor', value: h.state.trust('harbor'), delta: -0.1, reason: 'console' }]);
  });
});

describe('ConductState: trust over time and effects', () => {
  it('drifts toward the baseline once per game minute and tracks the daily trend', () => {
    const h = harness();
    h.state.request({ kind: 'trust', district: 'downtown', delta: -0.2, reason: 'x' });
    h.step();
    const low = h.state.trust('downtown');
    const row = (): { value: number; baseline: number; trend: number } => {
      const r = h.state.trustRows().find((x) => x.district === 'downtown');
      if (!r) throw new Error('no row');
      return r;
    };
    expect(row()).toMatchObject({ baseline: 0.45, value: low });
    expect(row().trend).toBeLessThanOrEqual(0);
    // not yet a full minute
    h.step(h.game + 30);
    expect(h.state.trust('downtown')).toBe(low);
    // one day: gap shrinks by exp(-driftPerDay)
    const start = h.game;
    h.step(start + 86400);
    const gap = 0.45 - h.state.trust('downtown');
    expect(gap).toBeCloseTo((0.45 - low) * Math.exp(-TRUST_CONFIG.driftPerDay * (86400 + 30) / 86400), 3);
    // a midnight passed: the trend reference was refreshed
    h.step(start + 3 * 86400);
    expect(Math.abs(row().trend)).toBeLessThan(0.2);
    expect(row().value).toBeGreaterThan(low);
  });

  it('keeps the drift independent of how the minutes are chunked', () => {
    const a = harness();
    const b = harness();
    a.state.request({ kind: 'trust', district: 'park', delta: 0.3, reason: 'x' });
    b.state.request({ kind: 'trust', district: 'park', delta: 0.3, reason: 'x' });
    a.step();
    b.step();
    for (let i = 1; i <= 600; i++) a.step(100_000 + i * 60);
    b.step(100_000 + 600 * 60);
    expect(a.state.trust('park')).toBeCloseTo(b.state.trust('park'), 9);
  });

  it('reads effects of a district, the average for an unknown district', () => {
    const h = harness();
    const e = h.state.effects('suburbs');
    expect(e.cooperation).toBe(0.65);
    expect(e.errorScale).toBeCloseTo(1.6 + (0.4 - 1.6) * 0.65, 10);
    const mean = [...TRUST.values()].reduce((s, v) => s + v, 0) / TRUST.size;
    expect(h.state.trust('')).toBeCloseTo(mean, 10);
    expect(h.state.effects('atlantis').cooperation).toBeCloseTo(mean, 10);
    h.state.request({ kind: 'trust', district: 'downtown', delta: -0.4, reason: 'x' });
    h.step();
    expect(h.state.effects('downtown').hostility).toBeGreaterThan(0.3);
    expect(h.state.effects('downtown').crimeFactor).toBeGreaterThan(h.state.effects('suburbs').crimeFactor);
  });

  it('changes revision when something a panel shows changes', () => {
    const h = harness();
    const r0 = h.state.revision;
    h.state.request({ kind: 'trust', district: 'downtown', delta: 0.1, reason: 'x' });
    h.step();
    expect(h.state.revision).toBeGreaterThan(r0);
    const c = h.state.career;
    expect(h.state.career).toBe(c);
    h.state.request({ kind: 'reinstate' });
    h.step();
    expect(h.state.career).not.toBe(c);
  });
});

describe('ConductState: save', () => {
  function played(): Harness {
    const h = harness({ seed: 5 });
    excessive(h, 'C-1', { injury: 0.5 });
    excessive(h, 'C-2');
    const { log } = forceLog('C-3');
    h.incidents.add(log, assess('C-3'), [choice('a', 'true', { key: true })]);
    const id = openCase(h, 'C-1');
    statement(h, id, { kind: 'none' });
    close(h, 'C-2');
    h.state.request({ kind: 'report', key: 'C-3', docId: 'D1', assertions: ['a'] });
    h.step(h.game + 600);
    return h;
  }

  it('round trips through JSON and validates', () => {
    const h = played();
    const save = h.state.serialize();
    expect(isConductSave(save)).toBe(true);
    const json = JSON.parse(JSON.stringify(save)) as unknown;
    expect(isConductSave(json)).toBe(true);
    expect(json).toEqual(save);
    const h2 = harness({ seed: 99 });
    h2.state.restore(save);
    expect(h2.state.serialize()).toEqual(save);
    expect(h2.state.career.ia).toHaveLength(2);
    expect(h2.state.career.status).toBe('suspended');
    expect(h2.state.reportGrade('D1')).not.toBeNull();
  });

  it('serialize is a snapshot, not a live view', () => {
    const h = played();
    const save = h.state.serialize();
    h.state.request({ kind: 'trust', district: 'downtown', delta: -0.3, reason: 'x' });
    h.step();
    expect(save.trust.downtown).not.toBe(h.state.trust('downtown'));
    expect(save.ia).not.toBe(h.state.career.ia);
  });

  it('continues identically after a restore (rng, queue and open cases included)', () => {
    const a = played();
    excessive(a, 'C-5');
    excessive(a, 'C-6');
    a.state.request({ kind: 'incidentClosed', key: 'C-5', aggressiveLines: 2 });
    const snap = a.state.serialize();
    expect(snap.queue).toHaveLength(1);
    expect(isConductSave(JSON.parse(JSON.stringify(snap)))).toBe(true);
    const base = a.game;
    const b2 = harness({ seed: 1 });
    b2.incidents.logs = a.incidents.logs;
    b2.incidents.assessments = a.incidents.assessments;
    b2.incidents.choices = a.incidents.choices;
    b2.state.restore(JSON.parse(JSON.stringify(snap)) as typeof snap);
    for (const h of [a, b2]) {
      h.step(base + 60);
      h.state.request({ kind: 'incidentClosed', key: 'C-6', aggressiveLines: 0 });
      h.step(base + 120);
      h.step(base + 13 * HOUR);
    }
    expect(b2.state.serialize()).toEqual(a.state.serialize());
    expect(b2.state.career.ia.length).toBe(a.state.career.ia.length);
    expect(b2.state.career.ia.length).toBeGreaterThan(2);
  });

  it('restores missing districts from the baselines', () => {
    const h = harness();
    const save = h.state.serialize();
    delete save.trust.harbor;
    const h2 = harness();
    h2.state.restore(save);
    expect(h2.state.trust('harbor')).toBe(TRUST.get('harbor'));
  });
});
