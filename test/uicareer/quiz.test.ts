import { describe, expect, it } from 'vitest';
import { CAREER_CONFIG, LEGAL_QUIZ, REPORT_EXERCISES, drawQuiz } from '../../src/career';
import { createRng } from '../../src/core/rng';
import { LegalQuizScreen, QuizRun, examAttempt, examLevelFor } from '../../src/ui/career/legalQuiz';
import { ReportExerciseScreen, ReportRun, exerciseForAttempt } from '../../src/ui/career/reportExercise';
import { key } from './helpers';

describe('QuizRun', () => {
  it('draws the academy questions from the seeded stream', () => {
    const run = new QuizRun(3, 'academy:legal:0', 'academy');
    expect(run.total).toBe(CAREER_CONFIG.academy.quizQuestions);
    expect(run.ids).toEqual(drawQuiz('academy', run.total, createRng(3).stream('academy:legal:0')));
    expect(new QuizRun(3, 'academy:legal:1', 'academy').ids).not.toEqual(run.ids);
  });

  it('flows question -> explanation -> next -> result with the rounded score', () => {
    const run = new QuizRun(3, 'academy:legal:0', 'academy');
    expect(run.phase).toBe('question');
    expect(run.next()).toBe(false);
    for (let i = 0; i < run.total; i++) {
      const q = run.question;
      expect(q?.options).toHaveLength(4);
      // Seven right, the rest deliberately wrong.
      const pick = i < 7 ? (q?.answer ?? 0) : ((q?.answer ?? 0) + 1) % 4;
      expect(run.answer(pick)).toBe(true);
      expect(run.phase).toBe('explain');
      expect(run.wasCorrect).toBe(i < 7);
      expect(run.answer(0)).toBe(false);
      run.next();
    }
    expect(run.phase).toBe('done');
    expect(run.correct).toBe(7);
    expect(run.score).toBe(70);
    expect(run.question).toBeNull();
  });

  it('rejects options outside 0..3', () => {
    const run = new QuizRun(3, 'x', 'academy');
    expect(run.answer(4)).toBe(false);
    expect(run.answer(-1)).toBe(false);
    expect(run.answer(0.5)).toBe(false);
  });

  it('is done at once for a level without questions', () => {
    const run = new QuizRun(3, 'x', 'captain', 5, LEGAL_QUIZ.filter((q) => q.level === 'academy'));
    expect(run.done).toBe(true);
    expect(run.score).toBe(0);
  });

  it('maps promotion ranks to their question sets', () => {
    expect(examLevelFor('sergeant')).toBe('sergeant');
    expect(examLevelFor('lieutenant')).toBe('lieutenant');
    expect(examLevelFor('captain')).toBe('captain');
    expect(examLevelFor('corporal')).toBe('academy');
    expect(examLevelFor('officer')).toBe('academy');
  });
});

describe('LegalQuizScreen (headless)', () => {
  it('academy mode: keys answer, Enter continues, the score is reported once', () => {
    const scores: number[] = [];
    const exits: number[] = [];
    const screen = new LegalQuizScreen(null, { mode: 'academy', seed: 4, attempt: 0, onScore: (s) => scores.push(s), onExit: () => exits.push(1) });
    screen.open();
    expect(screen.mode).toBe('academy');
    while (!screen.state.done) {
      const right = screen.state.question?.answer ?? 0;
      expect(screen.onKeyDown(key(String(right + 1)))).toBe(true);
      expect(screen.onKeyDown(key('Enter'))).toBe(true);
    }
    expect(scores).toEqual([100]);
    screen.onKeyDown(key('Enter')); // leaves
    expect(exits).toEqual([1]);
    expect(scores).toEqual([100]);
  });

  it('exam mode: draws the level questions and returns the score through the callback', () => {
    const scores: number[] = [];
    const screen = new LegalQuizScreen(null, { mode: 'exam', level: 'sergeant', seed: 4, attempt: 0, questions: 5, onScore: (s) => scores.push(s), onExit: () => undefined });
    screen.open();
    expect(screen.mode).toBe('exam');
    expect(screen.state.total).toBe(5);
    expect(screen.state.ids.every((id) => LEGAL_QUIZ.find((q) => q.id === id)?.level === 'sergeant')).toBe(true);
    while (!screen.state.done) {
      screen.answer(((screen.state.question?.answer ?? 0) + 1) % 4); // all wrong
      screen.advance();
    }
    expect(scores).toEqual([0]);
  });

  it('Escape leaves without a score', () => {
    const scores: number[] = [];
    const exits: number[] = [];
    const screen = new LegalQuizScreen(null, { mode: 'academy', seed: 4, attempt: 0, onScore: (s) => scores.push(s), onExit: () => exits.push(1) });
    screen.open();
    screen.answer(0);
    expect(screen.onKeyDown(key('Escape'))).toBe(true);
    expect(scores).toEqual([]);
    expect(exits).toEqual([1]);
    expect(screen.onKeyDown(key('1'))).toBe(false); // closed
  });
});

describe('report exercise', () => {
  it('picks the exercise round robin by attempt', () => {
    const n = REPORT_EXERCISES.length;
    expect(n).toBeGreaterThanOrEqual(6);
    expect(exerciseForAttempt(0)?.id).toBe(REPORT_EXERCISES[0]?.id);
    expect(exerciseForAttempt(1)?.id).toBe(REPORT_EXERCISES[1]?.id);
    expect(exerciseForAttempt(n)?.id).toBe(REPORT_EXERCISES[0]?.id);
    expect(exerciseForAttempt(n + 2)?.id).toBe(REPORT_EXERCISES[2]?.id);
    expect(exerciseForAttempt(0, [])).toBeNull();
    expect(() => new ReportRun(1, 0, [])).toThrow(RangeError);
  });

  it('shuffles the statements by seed without losing any', () => {
    const a = new ReportRun(5, 0);
    const b = new ReportRun(5, 0);
    expect(a.order).toEqual(b.order);
    expect([...a.order].sort()).toEqual(a.exercise.statements.map((s) => s.id).sort());
    expect(a.statements().map((s) => s.id)).toEqual(a.order);
  });

  it('ticking every key statement and nothing false scores 100', () => {
    const run = new ReportRun(5, 0);
    for (const s of run.exercise.statements) if (s.key) expect(run.toggle(s.id)).toBe(true);
    const fb = run.submit();
    expect(fb).toEqual({ score: 100, missing: [], falseSelected: [] });
    expect(run.submitted).toBe(true);
    expect(run.submit()).toBe(fb);
    expect(run.toggle(run.order[0] as string)).toBe(false); // locked after submitting
  });

  it('lists the missing key statements and the false ones by text', () => {
    const run = new ReportRun(5, 1);
    const keys = run.exercise.statements.filter((s) => s.key);
    const falses = run.exercise.statements.filter((s) => !s.truth);
    expect(falses.length).toBeGreaterThan(0);
    for (const s of keys.slice(1)) run.toggle(s.id);
    run.toggle((falses[0] as { id: string }).id);
    run.toggle('no-such-statement');
    run.toggle(keys[1]?.id as string); // untick one
    const fb = run.submit();
    expect(fb.missing).toContain(keys[0]?.text);
    expect(fb.missing).toContain(keys[1]?.text);
    expect(fb.falseSelected).toEqual([falses[0]?.text]);
    expect(fb.score).toBeLessThan(100);
    expect(fb.score).toBeGreaterThanOrEqual(0);
  });

  it('the screen reports the score once and leaves on Escape', () => {
    const scores: number[] = [];
    const exits: number[] = [];
    const screen = new ReportExerciseScreen(null, { seed: 2, attempt: 0, onScore: (s) => scores.push(s), onExit: () => exits.push(1) });
    screen.open();
    for (const s of screen.state.exercise.statements) if (s.key) screen.toggle(s.id);
    const fb = screen.submit();
    screen.submit();
    expect(scores).toEqual([fb.score]);
    expect(screen.onKeyDown(key('Escape'))).toBe(true);
    expect(exits).toEqual([1]);
  });
});

describe('examAttempt', () => {
  it('is unique per run in the same game minute and per minute', () => {
    const a = examAttempt(1000, 0);
    const b = examAttempt(1000, 1);
    const c = examAttempt(1000 + 60, 0);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('gives different question sets for consecutive retries', () => {
    const ids = (attempt: number): string[] => {
      return new QuizRun(42, `exam:sergeant:${String(attempt)}`, 'sergeant').ids;
    };
    expect(ids(examAttempt(5000, 0))).not.toEqual(ids(examAttempt(5000, 1)));
  });

  it('tolerates junk input', () => {
    expect(examAttempt(Number.NaN, -3)).toBe(0);
  });
});
