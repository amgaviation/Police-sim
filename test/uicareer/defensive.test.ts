import { describe, expect, it } from 'vitest';
import { DEFENSIVE_DRILLS, DEFENSIVE_TIME_LIMIT_S, gradeDefensive } from '../../src/career';
import { DRILLS_PER_ATTEMPT, DefensiveDrillScreen, DefensiveRun, gradeLabel } from '../../src/ui/career/defensive';
import { key } from './helpers';

function best(run: DefensiveRun): number {
  return run.bestOption;
}

function worst(run: DefensiveRun): number {
  return run.drill?.options.findIndex((o) => o.grade === 'wrong') ?? 0;
}

describe('DefensiveRun', () => {
  it('draws 8 distinct drills from the seeded stream, differently per attempt', () => {
    const a = new DefensiveRun(7, 0);
    expect(a.ids).toHaveLength(DRILLS_PER_ATTEMPT);
    expect(new Set(a.ids).size).toBe(DRILLS_PER_ATTEMPT);
    expect(new DefensiveRun(7, 0).ids).toEqual(a.ids);
    expect(new DefensiveRun(7, 1).ids).not.toEqual(a.ids);
    expect(new DefensiveRun(8, 0).ids).not.toEqual(a.ids);
    expect(a.timeLimitS).toBe(DEFENSIVE_TIME_LIMIT_S);
  });

  it('answering every drill with the best option scores 100', () => {
    const run = new DefensiveRun(3, 0);
    for (let i = 0; i < run.total; i++) {
      expect(run.phase).toBe('question');
      expect(run.answer(best(run))).toBe(true);
      expect(run.lastGrade).toBe('correct');
      expect(run.next()).toBe(true);
    }
    expect(run.phase).toBe('done');
    expect(run.score).toBe(100);
    expect(run.drill).toBeNull();
  });

  it('wrong answers score 0 and partial ones half', () => {
    const wrong = new DefensiveRun(3, 0);
    for (let i = 0; i < wrong.total; i++) {
      wrong.answer(worst(wrong));
      wrong.next();
    }
    expect(wrong.score).toBe(0);
    const mixed = new DefensiveRun(3, 0);
    for (let i = 0; i < mixed.total; i++) {
      const partial = mixed.drill?.options.findIndex((o) => o.grade === 'partial') ?? -1;
      mixed.answer(partial >= 0 ? partial : best(mixed));
      mixed.next();
    }
    expect(mixed.score).toBe(gradeDefensive(mixed.ids, mixed.picks));
  });

  it('times out at the limit: pick -1, grade timeout, zero points', () => {
    const run = new DefensiveRun(3, 0);
    expect(run.tick(run.timeLimitS - 0.1)).toBe(false);
    expect(run.fraction).toBeCloseTo(0.1 / run.timeLimitS, 6);
    expect(run.tick(0.2)).toBe(true);
    expect(run.phase).toBe('feedback');
    expect(run.picks[0]).toBe(-1);
    expect(run.lastGrade).toBe('timeout');
    expect(gradeLabel('timeout')).toContain('Time expired');
    // The clock is stopped during feedback and an answer is refused.
    expect(run.tick(100)).toBe(false);
    expect(run.answer(0)).toBe(false);
    run.next();
    expect(run.elapsedS).toBe(0);
    expect(run.index).toBe(1);
    // All timeouts -> 0.
    while (run.phase !== 'done') {
      run.tick(run.timeLimitS);
      run.next();
    }
    expect(run.score).toBe(0);
  });

  it('refuses out-of-range options and next() before an answer', () => {
    const run = new DefensiveRun(3, 0);
    expect(run.next()).toBe(false);
    expect(run.answer(-1)).toBe(false);
    expect(run.answer(9)).toBe(false);
    expect(run.answer(1.5)).toBe(false);
    expect(run.phase).toBe('question');
  });

  it('survives an empty drill list', () => {
    const run = new DefensiveRun(1, 0, [], 10);
    expect(run.phase).toBe('done');
    expect(run.score).toBe(0);
    expect(DEFENSIVE_DRILLS.length).toBeGreaterThanOrEqual(DRILLS_PER_ATTEMPT);
  });
});

describe('DefensiveDrillScreen (headless)', () => {
  it('keys 1-4 answer, Enter continues, the score is submitted once at the end', () => {
    const scores: number[] = [];
    const exits: number[] = [];
    const screen = new DefensiveDrillScreen(null, { seed: 5, attempt: 0, onScore: (s) => scores.push(s), onExit: () => exits.push(1) });
    screen.open();
    for (let i = 0; i < DRILLS_PER_ATTEMPT; i++) {
      const bestIdx = screen.state.bestOption;
      expect(screen.onKeyDown(key(String(bestIdx + 1)))).toBe(true);
      expect(screen.onKeyDown(key('Enter'))).toBe(true);
    }
    expect(screen.state.phase).toBe('done');
    expect(scores).toEqual([100]);
    expect(screen.onKeyDown(key('Enter'))).toBe(true);
    expect(exits).toEqual([1]);
    expect(scores).toEqual([100]);
  });

  it('a timeout through advance() counts as no response', () => {
    const scores: number[] = [];
    const screen = new DefensiveDrillScreen(null, { seed: 5, attempt: 0, onScore: (s) => scores.push(s), onExit: () => undefined });
    screen.open();
    screen.advance(DEFENSIVE_TIME_LIMIT_S + 1);
    expect(screen.state.picks[0]).toBe(-1);
    expect(screen.press('9')).toBe(false);
    expect(screen.onKeyDown(key('Escape'))).toBe(true);
    expect(scores).toEqual([]);
  });
});
