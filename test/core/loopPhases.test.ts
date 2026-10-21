import { afterEach, describe, expect, it, vi } from 'vitest';
import { GameLoop, stepAccumulator, stepAccumulatorInto, type AccumulatorResult, type FrameScheduler, type LoopHooks } from '../../src/core/loop';

const FIXED = 1 / 60;

function manualScheduler(): FrameScheduler & { frame(t: number): void } {
  const callbacks: Array<(t: number) => void> = [];
  return {
    request(cb) {
      callbacks.push(cb);
      return () => {
        const i = callbacks.indexOf(cb);
        if (i !== -1) callbacks.splice(i, 1);
      };
    },
    frame(t) {
      callbacks.shift()?.(t);
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('stepAccumulatorInto', () => {
  it('matches stepAccumulator and reuses the result object', () => {
    const out: AccumulatorResult = { steps: -1, acc: -1 };
    let acc = 0;
    let seed = 7;
    for (let i = 0; i < 5000; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const frameDt = (seed / 2 ** 32) * 0.4;
      const a = stepAccumulator(acc, frameDt, FIXED, 5);
      const b = stepAccumulatorInto(out, acc, frameDt, FIXED, 5);
      expect(b).toBe(out);
      expect(b).toEqual(a);
      acc = a.acc;
    }
  });

  it('validates its arguments like stepAccumulator', () => {
    const out: AccumulatorResult = { steps: 0, acc: 0 };
    expect(() => stepAccumulatorInto(out, 0, 0.1, 0, 5)).toThrow(RangeError);
    expect(() => stepAccumulatorInto(out, 0, 0.1, FIXED, 0)).toThrow(RangeError);
  });
});

describe('GameLoop phase times', () => {
  function setup() {
    const clock = { t: 0 };
    vi.spyOn(performance, 'now').mockImplementation(() => clock.t);
    const hooks: LoopHooks = {
      fixedUpdate: () => {
        clock.t += 2;
      },
      update: () => {
        clock.t += 3;
      },
      render: () => {
        clock.t += 5;
      },
    };
    const loop = new GameLoop({ hooks, scheduler: manualScheduler() });
    return { loop, clock };
  }

  it('measures the update and render hooks next to the simulation', () => {
    const { loop } = setup();
    loop.tick(0);
    loop.tick(FIXED * 1000 * 2); // two fixed steps worth of real time
    expect(loop.stats.stepsLastFrame).toBe(2);
    expect(loop.stats.simMs).toBe(4);
    expect(loop.stats.updateMs).toBe(3);
    expect(loop.stats.renderMs).toBe(5);
  });

  it('reports each frame to the phase sink, sim only for frames with steps', () => {
    const { loop } = setup();
    const calls: string[] = [];
    loop.setPhaseSink({ frame: (phase, ms) => calls.push(`${phase}:${String(ms)}`) });
    loop.tick(0); // first frame: no elapsed time, no steps
    expect(calls).toEqual(['update:3', 'render:5']);
    calls.length = 0;
    loop.tick(FIXED * 1000);
    expect(calls).toEqual(['sim:2', 'update:3', 'render:5']);
    loop.setPhaseSink(null);
    calls.length = 0;
    loop.tick(FIXED * 2000);
    expect(calls).toEqual([]);
  });

  it('reports no sim time while paused', () => {
    const { loop } = setup();
    const calls: string[] = [];
    loop.setPhaseSink({ frame: (phase) => calls.push(phase) });
    loop.paused = true;
    loop.tick(0);
    loop.tick(100);
    expect(calls).toEqual(['update', 'render', 'update', 'render']);
    expect(loop.stats.simMs).toBe(0);
  });
});
