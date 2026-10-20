import { describe, expect, it } from 'vitest';
import { COURT_CONFIG, scoreTestimony, type Answer, type CrossExamQuestion } from '../../src/court';

let n = 0;
function q(over: Partial<CrossExamQuestion> = {}): CrossExamQuestion {
  n++;
  return {
    id: `q${n}`, kind: 'resistanceAt', text: 'Q?', truth: 'yes', reportSays: null, eventId: n, onCamera: false, weight: 1, pairOf: null,
    ...over,
  };
}

const score = (qs: CrossExamQuestion[], answers: Answer[]) => scoreTestimony(qs, answers, COURT_CONFIG);
const near = (a: number, b: number): void => expect(a).toBeCloseTo(b, 6);

describe('scoreTestimony', () => {
  it('truthful answers: positive credibility, no impeachment, strong testimony', () => {
    const qs = [q(), q({ truth: 'no' }), q({ onCamera: true }), q({ truth: 'no', onCamera: true })];
    const r = score(qs, ['yes', 'no', 'yes', 'no']);
    expect(r.consistent).toBe(4);
    expect(r.impeached).toBe(0);
    expect(r.contradictions).toBe(0);
    expect(r.evasive).toBe(0);
    expect(r.selfInconsistent).toBe(0);
    expect(r.reportMismatches).toBe(0);
    near(r.credibilityDelta, 0.04);
    near(r.score, 0.9);
    expect(r.credibilityDelta).toBeGreaterThan(0);
  });

  it('a lie about something on camera is impeached by the footage', () => {
    const r = score([q({ truth: 'no', onCamera: true, reportSays: 'yes' }), q()], ['yes', 'yes']);
    expect(r.impeached).toBe(1);
    expect(r.contradictions).toBe(0);
    expect(r.consistent).toBe(1);
    near(r.credibilityDelta, -0.15 + 0.01);
    near(r.score, 0.5 - 0.3 + 0.1);
    expect(r.notes).toContain('Impeached by bodycam footage on ' + (r.notes[0]?.split(' ').pop() ?? ''));
    expect(r.notes.some((x) => x.startsWith('Impeached by bodycam footage on q'))).toBe(true);
  });

  it('a lie off camera is a plain contradiction with a smaller penalty', () => {
    const r = score([q({ truth: 'yes', onCamera: false })], ['no']);
    expect(r.contradictions).toBe(1);
    expect(r.impeached).toBe(0);
    near(r.credibilityDelta, -0.05);
    near(r.score, 0.4);
    expect(r.notes[0]).toMatch(/^Contradicted the incident record on q/);
  });

  it("don't recall is evasive and neither right nor wrong", () => {
    const r = score([q(), q({ onCamera: true })], ['dontRecall', 'dontRecall']);
    expect(r.evasive).toBe(2);
    expect(r.consistent + r.impeached + r.contradictions).toBe(0);
    near(r.credibilityDelta, -0.02);
    near(r.score, 0.4);
    expect(r.notes).toHaveLength(2);
  });

  it('answering a repeat like its pair is self-inconsistent', () => {
    const first = q({ truth: 'yes' });
    const repeat = q({ kind: 'repeat', truth: 'no', pairOf: first.id });
    // Said yes to "X?" and then yes to "so it is NOT true that X?".
    const bad = score([first, repeat], ['yes', 'yes']);
    expect(bad.selfInconsistent).toBe(1);
    expect(bad.contradictions).toBe(1); // the repeat answer is also wrong
    near(bad.credibilityDelta, 0.01 - 0.05 - 0.08);
    near(bad.score, 0.5 + 0.1 - 0.1 - 0.2);
    expect(bad.notes.some((x) => x.startsWith('Contradicted own testimony'))).toBe(true);
    // Lying twice in a consistent way is still wrong on the record but not self-inconsistent.
    const lies = score([q({ truth: 'yes' }), q({ kind: 'repeat', truth: 'no', pairOf: `q${n - 1}` })], ['no', 'yes']);
    expect(lies.selfInconsistent).toBe(0);
    // The honest pair of answers.
    const good = score([q({ truth: 'yes' }), q({ kind: 'repeat', truth: 'no', pairOf: `q${n - 1}` })], ['yes', 'no']);
    expect(good.selfInconsistent).toBe(0);
    expect(good.consistent).toBe(2);
  });

  it("don't recall on either half of a pair is not self-inconsistent", () => {
    const first = q();
    const repeat = q({ kind: 'repeat', truth: 'no', pairOf: first.id });
    expect(score([first, repeat], ['dontRecall', 'dontRecall']).selfInconsistent).toBe(0);
    expect(score([first, repeat], ['yes', 'dontRecall']).selfInconsistent).toBe(0);
  });

  it('an honest admission that differs from the report is a report mismatch', () => {
    const r = score([q({ truth: 'no', reportSays: 'yes' }), q({ truth: 'yes', reportSays: 'yes' })], ['no', 'yes']);
    expect(r.consistent).toBe(2);
    expect(r.reportMismatches).toBe(1);
    near(r.credibilityDelta, 0.02 - 0.02);
    near(r.score, 0.7);
    expect(r.notes).toEqual([expect.stringMatching(/^Testimony differs from the filed report on q/)]);
  });

  it('a silent report is never a mismatch', () => {
    expect(score([q({ truth: 'no', reportSays: null })], ['no']).reportMismatches).toBe(0);
  });

  it('missing answers count as don\'t recall', () => {
    const r = score([q(), q(), q()], ['yes']);
    expect(r.consistent).toBe(1);
    expect(r.evasive).toBe(2);
  });

  it('score is clamped to 0..1', () => {
    const lies = Array.from({ length: 6 }, () => q({ truth: 'yes', onCamera: true }));
    expect(score(lies, lies.map(() => 'no')).score).toBe(0);
    const truths = Array.from({ length: 9 }, () => q());
    expect(score(truths, truths.map(() => 'yes')).score).toBe(1);
  });

  it('reads the weights from the configuration', () => {
    const cfg = {
      ...COURT_CONFIG,
      credibility: { ...COURT_CONFIG.credibility, impeachOnCam: -0.5 },
      testimony: { ...COURT_CONFIG.testimony, base: 0.8, impeached: -0.1 },
    };
    const r = scoreTestimony([q({ truth: 'no', onCamera: true })], ['yes'], cfg);
    near(r.credibilityDelta, -0.5);
    near(r.score, 0.7);
  });

  it('no questions: neutral', () => {
    const r = score([], []);
    expect(r.credibilityDelta).toBe(0);
    expect(r.score).toBe(0.5);
    expect(r.notes).toEqual([]);
  });
});
