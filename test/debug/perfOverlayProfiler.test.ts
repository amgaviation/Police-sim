import { describe, expect, it } from 'vitest';
import { PerfOverlay, type PerfSample } from '../../src/debug/perfOverlay';
import { SystemProfiler } from '../../src/debug/profiler';

function sample(overrides: Partial<PerfSample> = {}): PerfSample {
  return { fps: 60, frameMs: 16, simMs: 2, steps: 1, drawCalls: 10, triangles: 100, entities: 5, ...overrides };
}

/** Lines under the `systems` heading up to the next non-indented line. */
function systemLines(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('systems'));
  if (start < 0) return [];
  const out: string[] = [];
  for (let i = start + 1; i < lines.length && (lines[i] ?? '').startsWith('  '); i++) out.push((lines[i] ?? '').trim());
  return out;
}

describe('PerfOverlay with a profiler', () => {
  function fill(p: SystemProfiler): void {
    const means: Record<string, number> = { a: 0.1, b: 0.6, c: 0.3, d: 0.5, e: 0.2, f: 0.4, g: 0.05 };
    for (const [name, ms] of Object.entries(means)) for (let i = 0; i < 10; i++) p.record(name, ms);
  }

  it('lists the top five systems by mean with mean / p95', () => {
    const profiler = new SystemProfiler();
    fill(profiler);
    const overlay = new PerfOverlay({ now: () => 0 });
    overlay.setProfiler(profiler);
    overlay.record(sample());
    const lines = systemLines(overlay.renderText());
    expect(lines.map((l) => l.split(/\s+/)[0])).toEqual(['b', 'd', 'f', 'c', 'e']);
    expect(lines[0]).toMatch(/^b\s+0\.600 \/ \d+\.\d{3}$/);
  });

  it('prefers the profiler over the last-run timings and falls back without one', () => {
    const profiler = new SystemProfiler();
    fill(profiler);
    const overlay = new PerfOverlay({ now: () => 0 });
    const systemTimings = new Map([['zzz', 9]]);
    overlay.record(sample({ systemTimings }));
    expect(systemLines(overlay.renderText()).map((l) => l.split(/\s+/)[0])).toEqual(['zzz']);
    overlay.setProfiler(profiler);
    expect(systemLines(overlay.renderText()).map((l) => l.split(/\s+/)[0])).not.toContain('zzz');
    overlay.setProfiler(null);
    expect(systemLines(overlay.renderText()).map((l) => l.split(/\s+/)[0])).toEqual(['zzz']);
  });

  it('rebuilds the profiler lines at 2 Hz only', () => {
    const profiler = new SystemProfiler();
    profiler.record('first', 1);
    let t = 1000;
    const overlay = new PerfOverlay({ now: () => t });
    overlay.setProfiler(profiler);
    overlay.record(sample());
    expect(systemLines(overlay.renderText()).map((l) => l.split(/\s+/)[0])).toEqual(['first']);
    profiler.record('second', 5);
    t += 200;
    expect(systemLines(overlay.renderText()).map((l) => l.split(/\s+/)[0])).toEqual(['first']);
    t += 400;
    expect(systemLines(overlay.renderText()).map((l) => l.split(/\s+/)[0])).toEqual(['second', 'first']);
  });
});
