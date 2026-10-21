import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import {
  CAREER_CONFIG, DEFENSIVE_DRILLS, LEGAL_QUIZ, REPORT_EXERCISES, drawQuiz, gradeDefensive, gradeQuiz, gradeReportExercise, rangeSchedule,
  scoreRange, swayOffset, type RangeTarget,
} from '../../src/career';

describe('drawQuiz', () => {
  it('is deterministic and filtered by level', () => {
    const a = drawQuiz('academy', 10, createRng(3));
    const b = drawQuiz('academy', 10, createRng(3));
    expect(a).toEqual(b);
    expect(a).toHaveLength(10);
    expect(new Set(a).size).toBe(10);
    for (const id of a) expect(LEGAL_QUIZ.find((q) => q.id === id)?.level).toBe('academy');
    expect(drawQuiz('academy', 10, createRng(4))).not.toEqual(a);
    for (const level of ['sergeant', 'lieutenant', 'captain'] as const) {
      for (const id of drawQuiz(level, 5, createRng(1))) expect(LEGAL_QUIZ.find((q) => q.id === id)?.level).toBe(level);
    }
  });

  it('returns fewer ids when the level is smaller than n', () => {
    expect(drawQuiz('captain', 99, createRng(1))).toHaveLength(LEGAL_QUIZ.filter((q) => q.level === 'captain').length);
    expect(drawQuiz('captain', 0, createRng(1))).toEqual([]);
  });
});

describe('gradeQuiz', () => {
  it('scores correct answers as a percentage', () => {
    const ids = drawQuiz('academy', 10, createRng(9));
    const answers = ids.map((id) => LEGAL_QUIZ.find((q) => q.id === id)?.answer ?? -1);
    expect(gradeQuiz(ids, answers)).toEqual({ score: 100, correct: 10, total: 10 });
    const wrong = answers.map((a, i) => (i < 3 ? (a + 1) % 4 : a));
    expect(gradeQuiz(ids, wrong)).toEqual({ score: 70, correct: 7, total: 10 });
    expect(gradeQuiz(ids, [])).toEqual({ score: 0, correct: 0, total: 10 });
    expect(gradeQuiz([], [])).toEqual({ score: 0, correct: 0, total: 0 });
  });

  it('counts unknown ids as wrong', () => {
    expect(gradeQuiz(['nope'], [0])).toEqual({ score: 0, correct: 0, total: 1 });
  });
});

describe('gradeDefensive', () => {
  const eight = DEFENSIVE_DRILLS.slice(0, 8);
  const ids = eight.map((d) => d.id);
  const pick = (grade: 'correct' | 'partial' | 'wrong') => eight.map((d) => d.options.findIndex((o) => o.grade === grade));

  it('correct 10, partial 5, wrong or timeout 0', () => {
    expect(gradeDefensive(ids, pick('correct'))).toBe(100);
    const partial = eight.map((d) => d.options.findIndex((o) => o.grade === 'partial'));
    if (partial.every((i) => i >= 0)) expect(gradeDefensive(ids, partial)).toBe(50);
    expect(gradeDefensive(ids, ids.map(() => -1))).toBe(0);
    expect(gradeDefensive(ids, [])).toBe(0);
  });

  it('mixes grades as 100 x sum / (10 n)', () => {
    const correct = pick('correct');
    const mixed = correct.map((c, i) => (i < 4 ? c : -1));
    expect(gradeDefensive(ids, mixed)).toBe(50);
    const wrongIdx = eight.map((d) => d.options.findIndex((o) => o.grade === 'wrong'));
    expect(gradeDefensive(ids, correct.map((c, i) => (i === 0 ? (wrongIdx[0] ?? -1) : c)))).toBe(88);
  });

  it('handles an empty drill list and unknown ids', () => {
    expect(gradeDefensive([], [])).toBe(0);
    expect(gradeDefensive(['nope'], [0])).toBe(0);
  });
});

describe('gradeReportExercise', () => {
  const ex = REPORT_EXERCISES[0];
  if (ex === undefined) throw new Error('no exercises');
  const keys = ex.statements.filter((s) => s.key).map((s) => s.id);
  const falses = ex.statements.filter((s) => !s.truth).map((s) => s.id);
  const trueNonKey = ex.statements.filter((s) => s.truth && !s.key).map((s) => s.id);

  it('selecting exactly the key statements scores 100', () => {
    expect(gradeReportExercise(ex.id, keys)).toEqual({ score: 100, missing: [], falseSelected: [] });
  });

  it('missing key statements cost 70 x share', () => {
    const r = gradeReportExercise(ex.id, keys.slice(1));
    expect(r.missing).toEqual([keys[0]]);
    expect(r.score).toBe(Math.round(70 * ((keys.length - 1) / keys.length) + 30));
    expect(gradeReportExercise(ex.id, []).score).toBe(30);
  });

  it('false statements cost 15 each and the score clamps at 0', () => {
    const r = gradeReportExercise(ex.id, [...keys, ...falses.slice(0, 2)]);
    expect(r.falseSelected).toEqual(falses.slice(0, 2));
    expect(r.score).toBe(70);
    expect(gradeReportExercise(ex.id, falses).score).toBe(0);
  });

  it('true non-key statements are neutral, duplicates and unknown ids are ignored', () => {
    expect(gradeReportExercise(ex.id, [...keys, ...trueNonKey, ...keys, 'zzz']).score).toBe(100);
  });

  it('throws on an unknown exercise', () => {
    expect(() => gradeReportExercise('nope', [])).toThrow(/nope/);
  });
});

describe('rangeSchedule', () => {
  const R = CAREER_CONFIG.range;

  it('is deterministic per (seed, attempt) and varies with both', () => {
    expect(rangeSchedule(11, 0)).toEqual(rangeSchedule(11, 0));
    expect(rangeSchedule(11, 1)).not.toEqual(rangeSchedule(11, 0));
    expect(rangeSchedule(12, 0)).not.toEqual(rangeSchedule(11, 0));
  });

  it('has the configured targets with exactly noShoot no-shoot targets', () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const list = rangeSchedule(99, attempt);
      expect(list).toHaveLength(R.targets);
      expect(list.filter((t) => t.noShoot)).toHaveLength(R.noShoot);
      expect(new Set(list.map((t) => t.id)).size).toBe(R.targets);
    }
  });

  it('keeps positions, timing and ordering inside the design ranges', () => {
    const list = rangeSchedule(5, 2);
    for (let i = 0; i < list.length; i++) {
      const t = list[i] as RangeTarget;
      expect(t.x).toBeGreaterThanOrEqual(0.1);
      expect(t.x).toBeLessThan(0.9);
      expect(t.y).toBeGreaterThanOrEqual(0.1);
      expect(t.y).toBeLessThan(0.9);
      expect(t.radius).toBe(R.radius);
      expect(t.duration).toBeGreaterThanOrEqual(R.showS[0]);
      expect(t.duration).toBeLessThan(R.showS[1]);
      expect(t.appearAt).toBeGreaterThanOrEqual(0);
      expect(t.appearAt + t.duration).toBeLessThanOrEqual(R.durationS);
      if (i > 0) expect(t.appearAt).toBeGreaterThanOrEqual((list[i - 1] as RangeTarget).appearAt);
    }
  });
});

describe('scoreRange', () => {
  const t = (id: number, over: Partial<RangeTarget> = {}): RangeTarget => ({
    id, x: 0.5, y: 0.5, radius: 0.1, appearAt: 0, duration: 2, noShoot: false, ...over,
  });

  it('a center hit scores ring 10', () => {
    expect(scoreRange([t(0)], [{ t: 1, x: 0.5, y: 0.5 }])).toEqual({ score: 100, hits: 1, noShootHits: 0, misses: 0 });
  });

  it('rings fall off with distance and the edge is ring 5', () => {
    // ring = 10 - floor(5 d / r): d = 0.03 of r = 0.1 -> floor(1.5) = 1 -> 9
    expect(scoreRange([t(0)], [{ t: 1, x: 0.53, y: 0.5 }]).score).toBe(90);
    expect(scoreRange([t(0)], [{ t: 1, x: 0.5, y: 0.59 }]).score).toBe(60);
    // A radius of 0.25 keeps the edge distance exact in binary floating point.
    expect(scoreRange([t(0, { radius: 0.25 })], [{ t: 1, x: 0.75, y: 0.5 }]).score).toBe(50);
    expect(scoreRange([t(0, { radius: 0.25 })], [{ t: 1, x: 0.751, y: 0.5 }])).toEqual({ score: 0, hits: 0, noShootHits: 0, misses: 1 });
  });

  it('only the best shot per target counts', () => {
    const r = scoreRange([t(0)], [{ t: 0.5, x: 0.58, y: 0.5 }, { t: 1, x: 0.5, y: 0.5 }, { t: 1.5, x: 0.55, y: 0.5 }]);
    expect(r).toEqual({ score: 100, hits: 1, noShootHits: 0, misses: 0 });
  });

  it('a shot only hits a target while it is shown', () => {
    const targets = [t(0, { appearAt: 5, duration: 2 })];
    expect(scoreRange(targets, [{ t: 4.99, x: 0.5, y: 0.5 }]).misses).toBe(1);
    expect(scoreRange(targets, [{ t: 5, x: 0.5, y: 0.5 }]).hits).toBe(1);
    expect(scoreRange(targets, [{ t: 7, x: 0.5, y: 0.5 }]).misses).toBe(1);
  });

  it('no-shoot hits cost 15 each', () => {
    const targets = [t(0), t(1, { x: 0.2, y: 0.2, noShoot: true })];
    const r = scoreRange(targets, [{ t: 1, x: 0.5, y: 0.5 }, { t: 1, x: 0.2, y: 0.2 }, { t: 1.2, x: 0.2, y: 0.21 }]);
    expect(r.noShootHits).toBe(2);
    expect(r.hits).toBe(1);
    expect(r.score).toBe(70);
  });

  it('the score clamps at 0 and misses are counted', () => {
    const targets = [t(0, { x: 0.8 }), t(1, { x: 0.2, noShoot: true })];
    const r = scoreRange(targets, [{ t: 1, x: 0.2, y: 0.5 }, { t: 1, x: 0.9, y: 0.9 }]);
    expect(r).toEqual({ score: 0, hits: 0, noShootHits: 1, misses: 1 });
  });

  it('hits the nearest of overlapping targets', () => {
    const targets = [t(0, { x: 0.5 }), t(1, { x: 0.55, noShoot: true })];
    expect(scoreRange(targets, [{ t: 1, x: 0.52, y: 0.5 }]).hits).toBe(1);
    expect(scoreRange(targets, [{ t: 1, x: 0.54, y: 0.5 }]).noShootHits).toBe(1);
  });

  it('scores a partial run proportionally and handles no shoot targets', () => {
    const targets = [t(0), t(1, { x: 0.2 }), t(2, { x: 0.8 }), t(3, { x: 0.1 })];
    expect(scoreRange(targets, [{ t: 1, x: 0.5, y: 0.5 }, { t: 1, x: 0.2, y: 0.5 }]).score).toBe(50);
    expect(scoreRange([t(0, { noShoot: true })], [])).toEqual({ score: 0, hits: 0, noShootHits: 0, misses: 0 });
  });
});

describe('swayOffset', () => {
  it('follows the Lissajous formula and returns the output object', () => {
    const out = { x: 9, y: 9 };
    const mods = { aimSpread: 1, steerLagS: 0, vignette: 0 };
    const r = swayOffset(0, mods, out);
    expect(r).toBe(out);
    expect(out.x).toBeCloseTo(0, 12);
    expect(out.y).toBeCloseTo(0.012, 12);
    swayOffset(2, mods, out);
    expect(out.x).toBeCloseTo(0.012 * Math.sin(2.6) + 0.006 * Math.sin(6.2), 12);
    expect(out.y).toBeCloseTo(0.012 * Math.cos(3.4), 12);
  });

  it('the amplitude grows with aimSpread', () => {
    const calm = swayOffset(1.3, { aimSpread: 1, steerLagS: 0, vignette: 0 }, { x: 0, y: 0 });
    const tired = swayOffset(1.3, { aimSpread: 1.5, steerLagS: 0, vignette: 0 }, { x: 0, y: 0 });
    expect(tired.x).toBeCloseTo(calm.x * 1.5, 12);
    expect(tired.y).toBeCloseTo(calm.y * 1.5, 12);
    expect(Math.hypot(tired.x, tired.y)).toBeGreaterThan(Math.hypot(calm.x, calm.y));
  });
});
