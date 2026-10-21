import { createRng, type Rng } from '../core/rng';
import { CAREER_CONFIG, DEFENSIVE_DRILLS, LEGAL_QUIZ, REPORT_EXERCISES } from './data';
import type { CareerConfig, DefensiveDrill, PerformanceMods, QuizLevel, QuizQuestion, ReportExercise } from './types';

/** Academy grading (Phase 8 design §5.5). Pure; presentation lives in the UI modules. */

/** Fisher-Yates of the level's question ids; the first `n` (fewer when the level has fewer questions). */
export function drawQuiz(level: QuizLevel, n: number, rng: Rng, questions: readonly QuizQuestion[] = LEGAL_QUIZ): string[] {
  const ids = questions.filter((q) => q.level === level).map((q) => q.id);
  rng.shuffle(ids);
  return ids.slice(0, Math.max(0, n));
}

/** `score = round(100 x correct / ids.length)`; missing answers and unknown ids count as wrong. */
export function gradeQuiz(
  ids: readonly string[], answers: readonly number[], questions: readonly QuizQuestion[] = LEGAL_QUIZ,
): { score: number; correct: number; total: number } {
  let correct = 0;
  ids.forEach((id, i) => {
    if (questions.find((q) => q.id === id)?.answer === answers[i]) correct++;
  });
  return { score: ids.length === 0 ? 0 : Math.round((100 * correct) / ids.length), correct, total: ids.length };
}

/** correct 10, partial 5, wrong or -1 (timeout) 0; `score = round(100 x sum / (10 x n))`. */
export function gradeDefensive(ids: readonly string[], picks: readonly number[], drills: readonly DefensiveDrill[] = DEFENSIVE_DRILLS): number {
  let sum = 0;
  ids.forEach((id, i) => {
    const pick = picks[i];
    const grade = pick === undefined || pick < 0 ? undefined : drills.find((d) => d.id === id)?.options[pick]?.grade;
    if (grade === 'correct') sum += 10;
    else if (grade === 'partial') sum += 5;
  });
  return ids.length === 0 ? 0 : Math.round((100 * sum) / (10 * ids.length));
}

/**
 * `score = round(70 x keyCompleteness + 30 - 15 x falseSelected)` clamped 0..100, where keyCompleteness is the share of
 * key statements selected. Throws on an unknown exercise id.
 */
export function gradeReportExercise(
  exerciseId: string, selected: readonly string[], exercises: readonly ReportExercise[] = REPORT_EXERCISES,
): { score: number; missing: string[]; falseSelected: string[] } {
  const exercise = exercises.find((e) => e.id === exerciseId);
  if (exercise === undefined) throw new RangeError(`gradeReportExercise: unknown exercise "${exerciseId}"`);
  const picked = new Set(selected);
  const keys = exercise.statements.filter((s) => s.key);
  const missing = keys.filter((s) => !picked.has(s.id)).map((s) => s.id);
  const falseSelected = exercise.statements.filter((s) => !s.truth && picked.has(s.id)).map((s) => s.id);
  const completeness = keys.length === 0 ? 1 : (keys.length - missing.length) / keys.length;
  const score = Math.min(100, Math.max(0, Math.round(70 * completeness + 30 - 15 * falseSelected.length)));
  return { score, missing, falseSelected };
}

export interface RangeTarget {
  id: number;
  x: number;
  y: number;
  radius: number;
  appearAt: number;
  duration: number;
  noShoot: boolean;
}

/**
 * The firearms range: `targets` targets of which `noShoot` are no-shoot, positions in 0.1..0.9, `appearAt` spread over
 * `durationS - 3`, `duration` within `showS`. Drawn from `createRng(seed).stream('academy:firearms:<attempt>')`; sorted by
 * `appearAt`.
 */
export function rangeSchedule(seed: number, attempt: number, cfg: CareerConfig['range'] = CAREER_CONFIG.range): RangeTarget[] {
  const rng = createRng(seed).stream(`academy:firearms:${attempt}`);
  const flags: boolean[] = [];
  for (let i = 0; i < cfg.targets; i++) flags.push(i < cfg.noShoot);
  rng.shuffle(flags);
  const slot = (cfg.durationS - 3) / cfg.targets;
  const out: RangeTarget[] = flags.map((noShoot, i) => {
    const x = rng.nextFloat(0.1, 0.9);
    const y = rng.nextFloat(0.1, 0.9);
    const appearAt = (i + rng.next() * 0.5) * slot;
    const duration = rng.nextFloat(cfg.showS[0], cfg.showS[1]);
    return { id: i, x, y, radius: cfg.radius, appearAt, duration, noShoot };
  });
  return out.sort((a, b) => a.appearAt - b.appearAt || a.id - b.id);
}

/** Aim sway in normalized screen units: `a = swayBase x aimSpread`, `x = a sin(1.3 t) + 0.5 a sin(3.1 t)`, `y = a cos(1.7 t)`. */
export function swayOffset(
  tS: number, mods: Readonly<PerformanceMods>, out: { x: number; y: number }, cfg: CareerConfig['range'] = CAREER_CONFIG.range,
): { x: number; y: number } {
  const a = cfg.swayBase * mods.aimSpread;
  out.x = a * Math.sin(1.3 * tS) + 0.5 * a * Math.sin(3.1 * tS);
  out.y = a * Math.cos(1.7 * tS);
  return out;
}

/**
 * Each shot hits the nearest active target (`appearAt <= t < appearAt + duration`) within its radius; `ring = 10 -
 * floor(5 d / radius)`; only each target's best shot counts; every shot on a no-shoot target costs 15 points;
 * `score = clamp(round(100 x rings / (10 x shootTargets) - 15 x noShootHits), 0, 100)`. `hits` counts distinct shoot targets hit.
 */
export function scoreRange(
  targets: readonly RangeTarget[], shots: readonly { t: number; x: number; y: number }[],
): { score: number; hits: number; noShootHits: number; misses: number } {
  const best = new Map<number, number>();
  let noShootHits = 0;
  let misses = 0;
  for (const shot of shots) {
    let nearest: RangeTarget | null = null;
    let nearestD = Infinity;
    for (const target of targets) {
      if (shot.t < target.appearAt || shot.t >= target.appearAt + target.duration) continue;
      const d = Math.hypot(shot.x - target.x, shot.y - target.y);
      if (d <= target.radius && d < nearestD) {
        nearest = target;
        nearestD = d;
      }
    }
    if (nearest === null) {
      misses++;
    } else if (nearest.noShoot) {
      noShootHits++;
    } else {
      const ring = 10 - Math.floor((5 * nearestD) / nearest.radius);
      if (ring > (best.get(nearest.id) ?? 0)) best.set(nearest.id, ring);
    }
  }
  let rings = 0;
  for (const r of best.values()) rings += r;
  const shootTargets = targets.filter((t) => !t.noShoot).length;
  const raw = shootTargets === 0 ? 0 : Math.round((100 * rings) / (10 * shootTargets) - 15 * noShootHits);
  return { score: Math.min(100, Math.max(0, raw)), hits: best.size, noShootHits, misses };
}
