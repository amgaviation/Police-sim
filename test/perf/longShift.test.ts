import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { SystemProfiler, formatProfile } from '../../src/debug/profiler';
import { initRapier } from '../../src/physics/physics';
import { DT, Harness } from '../game/harness';

/** Node pieces the test needs (the project's tsconfig carries no Node globals). */
declare const process: { env: Record<string, string | undefined> };

const LONG = process.env.PATROL_LONG === '1';
const SEED = 4242;
/** `src/data/environment/time.json`: one simulation second is 30 game seconds. */
const GAME_SECONDS_PER_SIM_SECOND = 30;
const gameHours = (steps: number): number => (steps * DT * GAME_SECONDS_PER_SIM_SECOND) / 3600;
/** One game hour at 60 steps/s; PATROL_LONG runs the full 8-hour shift. */
const STEPS = LONG ? 57_600 : 7_200;
const MEAN_BUDGET_MS = 4;
const P95_BUDGET_MS = 12;
const OUT_DIR = fileURLToPath(new URL('../../docs/perf/', import.meta.url));

beforeAll(async () => {
  await initRapier();
});

function percentile(sorted: Float64Array, p: number): number {
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[rank - 1] ?? 0;
}

describe('long shift profile (Node)', () => {
  it(
    `${LONG ? '8 game hours' : '1 game hour'} of free patrol at the station stays inside the step budget`,
    () => {
      const harness = new Harness(undefined, undefined, true);
      const profiler = new SystemProfiler();
      harness.registry.setProfiler(profiler);
      try {
        const session = harness.start(SEED, true);
        // Warm-up: the first steps include lazy initialisation that a long shift amortises.
        harness.step(session, 120);
        profiler.reset();

        const stepMs = new Float64Array(STEPS);
        const wall0 = performance.now();
        for (let i = 0; i < STEPS; i++) {
          const t0 = performance.now();
          harness.step(session, 1);
          stepMs[i] = performance.now() - t0;
        }
        const wallMs = performance.now() - wall0;

        let total = 0;
        for (const v of stepMs) total += v;
        const mean = total / STEPS;
        const sorted = stepMs.slice().sort();
        const p95 = percentile(sorted, 0.95);
        const max = sorted[STEPS - 1] ?? 0;
        const report = profiler.report();
        const table = formatProfile(report, 15);
        console.log(
          `long shift: ${String(STEPS)} steps (${gameHours(STEPS).toFixed(1)} game h) in ${(wallMs / 1000).toFixed(1)} s; ` +
            `step mean ${mean.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, max ${max.toFixed(3)} ms\n${table}`,
        );

        expect(report.steps).toBe(STEPS);
        expect(mean).toBeLessThan(MEAN_BUDGET_MS);
        expect(p95).toBeLessThan(P95_BUDGET_MS);

        if (LONG) {
          const date = process.env.PATROL_DATE ?? new Date().toISOString();
          mkdirSync(OUT_DIR, { recursive: true });
          const summary = { meanStepMs: mean, p95StepMs: p95, maxStepMs: max, wallSeconds: wallMs / 1000 };
          writeFileSync(`${OUT_DIR}node-long-shift.json`, `${JSON.stringify({ date, steps: STEPS, seed: SEED, step: summary, report }, null, 2)}\n`);
          const md = [
            '# Node long shift',
            '',
            `Seed ${String(SEED)}, ${String(STEPS)} fixed steps (${gameHours(STEPS).toFixed(1)} game hours), free patrol, officer idle at the station.`,
            `Date: ${date}`,
            '',
            `Whole step: mean ${mean.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms, max ${max.toFixed(3)} ms (wall ${(wallMs / 1000).toFixed(1)} s).`,
            '',
            table,
            '',
          ].join('\n');
          writeFileSync(`${OUT_DIR}node-long-shift.md`, md);
        }
      } finally {
        harness.dispose();
      }
    },
    LONG ? 20 * 60_000 : 180_000,
  );
});
