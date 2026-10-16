import { describe, expect, it } from 'vitest';
import { PerfOverlay, type PerfSample } from '../../src/debug/perfOverlay';

function sample(overrides: Partial<PerfSample> = {}): PerfSample {
  return {
    fps: 60,
    frameMs: 16.5,
    simMs: 2.25,
    steps: 1,
    drawCalls: 12,
    triangles: 3456,
    entities: 7,
    ...overrides,
  };
}

describe('PerfOverlay (headless)', () => {
  it('starts hidden and toggles', () => {
    const overlay = new PerfOverlay({ now: () => 0 });
    expect(overlay.visible).toBe(false);
    overlay.toggle();
    expect(overlay.visible).toBe(true);
    overlay.setVisible(false);
    expect(overlay.visible).toBe(false);
    overlay.dispose();
  });

  it('renders the core metrics from the rolling window', () => {
    const overlay = new PerfOverlay({ now: () => 0, windowSize: 4 });
    overlay.record(sample({ frameMs: 10, simMs: 1 }));
    overlay.record(sample({ frameMs: 20, simMs: 3 }));
    const text = overlay.renderText();
    expect(text).toContain('fps            60');
    expect(text).toContain('frame ms    15.00  1% low 20.00');
    expect(text).toContain('sim ms       2.00  steps/frame 1');
    expect(text).toContain('draw calls     12  tris 3456');
    expect(text).toContain('entities        7');
    expect(text).not.toContain('systems');
  });

  it('lists the top five systems by time', () => {
    const overlay = new PerfOverlay({ now: () => 0 });
    const systemTimings = new Map<string, number>([
      ['a', 0.1],
      ['b', 0.6],
      ['c', 0.3],
      ['d', 0.5],
      ['e', 0.2],
      ['f', 0.4],
    ]);
    overlay.record(sample({ systemTimings }));
    const lines = overlay.renderText().split('\n');
    const start = lines.indexOf('systems');
    expect(start).toBeGreaterThan(0);
    const names = lines.slice(start + 1, start + 6).map((l) => l.trim().split(/\s+/)[0]);
    expect(names).toEqual(['b', 'd', 'f', 'c', 'e']);
    expect(lines.slice(start + 1).some((l) => l.trim().startsWith('a '))).toBe(false);
  });

  it('shows and removes extra lines', () => {
    const overlay = new PerfOverlay({ now: () => 0 });
    overlay.setExtra('worker', 1.2345);
    overlay.setExtra('note', 'hello');
    let text = overlay.renderText();
    expect(text).toContain('worker     1.23');
    expect(text).toContain('note       hello');
    overlay.setExtra('worker', undefined);
    text = overlay.renderText();
    expect(text).not.toContain('worker');
    expect(text).toContain('note       hello');
  });
});
