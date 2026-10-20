import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { CourtState, MAX_CASES, emptyCourtSave, isCourtSave, type CourtCase, type CourtSave } from '../../src/court';
import { HOUR, SEED, harness, richFixture, scriptedRng, sourceOf, time, withReport } from './helpers';

const clone = <T>(v: T): T => structuredClone(v);

/** A booking in session (questions, motions), a paid citation, and a queued testimony. */
function populated(): CourtSave {
  const f = withReport(richFixture(), ['arrest:1']);
  const h = harness(sourceOf(f), scriptedRng(0.99, 0.5, 0.9, 0.5));
  const court = new CourtState(h.deps);
  court.request({ kind: 'open', docId: 'D1', docKind: 'booking', personId: 1, personLabel: 'Sam Rivera', callId: 7, statutes: ['TR-360'] });
  court.request({ kind: 'open', docId: 'D2', docKind: 'citation', personId: 1, personLabel: 'Sam Rivera', callId: 7, statutes: ['TR-300'] });
  court.step(1 / 60, time(10 * HOUR));
  court.request({ kind: 'attend', caseId: 'CR-0001' });
  court.step(1 / 60, time(14 * HOUR));
  court.request({ kind: 'testify', caseId: 'CR-0001', answers: ['yes'] });
  return court.serialize();
}

describe('CourtSave', () => {
  it('emptyCourtSave is a valid, empty save', () => {
    const s = emptyCourtSave(createRng('x').state());
    expect(s).toMatchObject({ version: 1, nextId: 1, cases: [], lastMinute: -1, queue: [] });
    expect(isCourtSave(s)).toBe(true);
  });

  it('a played save validates and survives JSON', () => {
    const s = populated();
    expect(s.cases.length).toBeGreaterThan(0);
    expect(s.queue.length).toBeGreaterThan(0);
    expect(isCourtSave(s)).toBe(true);
    expect(isCourtSave(JSON.parse(JSON.stringify(s)))).toBe(true);
  });

  it('holds the session in progress: questions, motions and a queued testimony', () => {
    const s = populated();
    const c = s.cases.find((x) => x.id === 'CR-0001');
    expect(c?.status).toBe('inSession');
    expect(c?.questions.length).toBeGreaterThan(0);
    expect(c?.motions.length).toBeGreaterThan(0);
    expect(s.cases.find((x) => x.id === 'CR-0002')).toMatchObject({ status: 'closed', verdict: 'paid' });
    expect(s.queue).toEqual([{ kind: 'testify', caseId: 'CR-0001', answers: ['yes'] }]);
  });

  it.each<[string, (s: CourtSave) => unknown]>([
    ['null', () => null],
    ['a string', () => 'save'],
    ['wrong version', (s) => ({ ...s, version: 2 })],
    ['missing rng', (s) => ({ ...s, rng: undefined })],
    ['bad rng state', (s) => ({ ...s, rng: { seed: 1, s: [1, 2, 3] } })],
    ['rng word out of range', (s) => ({ ...s, rng: { seed: 1, s: [1, 2, 3, 4294967296] } })],
    ['fractional nextId', (s) => ({ ...s, nextId: 1.5 })],
    ['cases not an array', (s) => ({ ...s, cases: {} })],
    ['bad lastMinute', (s) => ({ ...s, lastMinute: 'x' })],
    ['queue not an array', (s) => ({ ...s, queue: null })],
    ['unknown request kind', (s) => ({ ...s, queue: [{ kind: 'hang', caseId: 'CR-0001' }] })],
    ['testify with a bad answer', (s) => ({ ...s, queue: [{ kind: 'testify', caseId: 'CR-0001', answers: ['maybe'] }] })],
    ['open without statutes', (s) => ({ ...s, queue: [{ kind: 'open', docId: 'D', docKind: 'booking', personId: 1, personLabel: 'x', callId: 1 }] })],
    ['attend without a case', (s) => ({ ...s, queue: [{ kind: 'attend' }] })],
  ])('rejects %s', (_name, mutate) => {
    expect(isCourtSave(mutate(clone(populated())))).toBe(false);
  });

  const caseMutations: [string, (c: CourtCase) => void][] = [
    ['unknown status', (c) => { (c as { status: string }).status = 'over'; }],
    ['unknown verdict', (c) => { (c as { verdict: string | null }).verdict = 'jailed'; }],
    ['unknown doc kind', (c) => { (c as { docKind: string }).docKind = 'ticket'; }],
    ['non-numeric hearing', (c) => { (c as { hearingGame: unknown }).hearingGame = '14:00'; }],
    ['statutes not strings', (c) => { (c as { statutes: unknown }).statutes = [1]; }],
    ['bad question kind', (c) => { c.questions = [{ id: 'q1', kind: 'trick' as never, text: 't', truth: 'yes', reportSays: null, eventId: 1, onCamera: true, weight: 1, pairOf: null }]; }],
    ['bad question truth', (c) => { c.questions = [{ id: 'q1', kind: 'camDuring', text: 't', truth: 'maybe' as never, reportSays: null, eventId: 1, onCamera: true, weight: 1, pairOf: null }]; }],
    ['question missing weight', (c) => { c.questions = [{ id: 'q1', kind: 'camDuring', text: 't', truth: 'yes', reportSays: null, eventId: 1, onCamera: true, pairOf: null } as never]; }],
    ['bad motion', (c) => { c.motions = [{ text: 'm', granted: 'yes' as never, ruleIds: [], dismissesCase: false }]; }],
    ['bad testimony', (c) => { c.testimony = { credibilityDelta: 0 } as never; }],
    ['reminded not boolean', (c) => { (c as { reminded: unknown }).reminded = 1; }],
  ];

  it.each(caseMutations)('rejects a case with %s', (_name, mutate) => {
    const s = clone(populated());
    const c = s.cases[0] as CourtCase;
    mutate(c);
    expect(isCourtSave(s)).toBe(false);
  });

  it('accepts a valid question, motion and testimony', () => {
    const s = clone(populated());
    const c = s.cases[0] as CourtCase;
    c.questions = [{ id: 'q1', kind: 'repeat', text: 't', truth: 'no', reportSays: 'yes', eventId: 3, onCamera: false, weight: 2.5, pairOf: 'q2' }];
    c.motions = [{ text: 'Motion', granted: true, ruleIds: ['GS-12.1'], dismissesCase: false }];
    c.testimony = {
      credibilityDelta: -0.1, score: 0.3, consistent: 1, impeached: 1, contradictions: 0, evasive: 0, selfInconsistent: 0, reportMismatches: 0, notes: ['x'],
    };
    c.verdict = 'dismissed';
    expect(isCourtSave(s)).toBe(true);
  });

  it('rejects more than the maximum number of cases', () => {
    const s = clone(populated());
    const c = s.cases[0] as CourtCase;
    s.cases = Array.from({ length: MAX_CASES + 1 }, () => clone(c));
    expect(isCourtSave(s)).toBe(false);
    s.cases.pop();
    expect(isCourtSave(s)).toBe(true);
  });

  it('restoring adopts the saved generator state', () => {
    const rng = createRng(SEED).stream('court');
    rng.next();
    const saved = emptyCourtSave(rng.state());
    const live = createRng(9);
    const court = new CourtState(harness(sourceOf(richFixture()), live).deps);
    court.restore(saved);
    expect(live.next()).toBe(rng.next());
  });
});
