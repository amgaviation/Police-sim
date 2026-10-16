import { describe, expect, it, vi } from 'vitest';
import { GameLoop, stepAccumulator, type FrameScheduler, type LoopHooks } from '../../src/core/loop';

const FIXED = 1 / 60;

describe('stepAccumulator', () => {
  it('runs no step until a full fixed step has accumulated', () => {
    const r = stepAccumulator(0, FIXED / 2, FIXED, 5);
    expect(r.steps).toBe(0);
    expect(r.acc).toBeCloseTo(FIXED / 2, 12);
  });

  it('runs exactly the whole steps that fit and keeps the remainder', () => {
    const r = stepAccumulator(0, FIXED * 2.5, FIXED, 5);
    expect(r.steps).toBe(2);
    expect(r.acc).toBeCloseTo(FIXED / 2, 12);
  });

  it('carries the previous accumulator forward', () => {
    const first = stepAccumulator(0, FIXED * 0.75, FIXED, 5);
    const second = stepAccumulator(first.acc, FIXED * 0.75, FIXED, 5);
    expect(first.steps).toBe(0);
    expect(second.steps).toBe(1);
    expect(second.acc).toBeCloseTo(FIXED / 2, 12);
  });

  it('clamps to maxSteps and discards surplus (spiral-of-death guard)', () => {
    const r = stepAccumulator(0, 1, FIXED, 5);
    expect(r.steps).toBe(5);
    expect(r.acc).toBeGreaterThanOrEqual(0);
    expect(r.acc).toBeLessThan(FIXED);
  });

  it('keeps alpha = acc / fixedDt within [0, 1) over a long random run', () => {
    let acc = 0;
    let seed = 1;
    for (let i = 0; i < 10_000; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      const frameDt = (seed / 2 ** 32) * 0.3;
      const r = stepAccumulator(acc, frameDt, FIXED, 5);
      acc = r.acc;
      const alpha = acc / FIXED;
      expect(alpha).toBeGreaterThanOrEqual(0);
      expect(alpha).toBeLessThan(1);
      expect(r.steps).toBeLessThanOrEqual(5);
    }
  });

  it('ignores negative frame time and validates arguments', () => {
    expect(stepAccumulator(0.01, -1, FIXED, 5)).toEqual({ steps: 0, acc: 0.01 });
    expect(() => stepAccumulator(0, 0.1, 0, 5)).toThrow(RangeError);
    expect(() => stepAccumulator(0, 0.1, FIXED, 0)).toThrow(RangeError);
  });
});

/** Scheduler driven by hand: `frame(t)` runs the pending callback at time t. */
function manualScheduler(): FrameScheduler & { frame(t: number): void; pending(): number } {
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
      const cb = callbacks.shift();
      if (cb) cb(t);
    },
    pending: () => callbacks.length,
  };
}

function makeHooks() {
  const fixed = vi.fn<LoopHooks['fixedUpdate']>();
  const upd = vi.fn<LoopHooks['update']>();
  const ren = vi.fn<LoopHooks['render']>();
  const hooks: LoopHooks = { fixedUpdate: fixed, update: upd, render: ren };
  return { hooks, fixed, upd, ren };
}

describe('GameLoop', () => {
  it('start/stop toggles isRunning and schedules frames', () => {
    const scheduler = manualScheduler();
    const loop = new GameLoop({ hooks: makeHooks().hooks, scheduler });
    expect(loop.isRunning).toBe(false);
    loop.start();
    expect(loop.isRunning).toBe(true);
    expect(scheduler.pending()).toBe(1);
    loop.start(); // idempotent
    expect(scheduler.pending()).toBe(1);
    loop.stop();
    expect(loop.isRunning).toBe(false);
    expect(scheduler.pending()).toBe(0);
  });

  it('runs the expected fixed steps per frame with monotonically increasing step ids', () => {
    const scheduler = manualScheduler();
    const h = makeHooks();
    const loop = new GameLoop({ hooks: h.hooks, scheduler, simHz: 60 });
    loop.start();
    scheduler.frame(0); // first frame establishes the clock: no steps
    expect(h.fixed).not.toHaveBeenCalled();
    expect(h.upd).toHaveBeenCalledTimes(1);
    expect(h.ren).toHaveBeenCalledTimes(1);

    scheduler.frame(1000 / 60); // one step
    scheduler.frame(1000 / 60 + 50); // 3 steps (50 ms)
    expect(h.fixed).toHaveBeenCalledTimes(4);
    expect(h.fixed.mock.calls.map((c) => c[1])).toEqual([1, 2, 3, 4]);
    expect(h.fixed.mock.calls[0]?.[0]).toBeCloseTo(FIXED, 12);
    expect(loop.step).toBe(4);
    expect(loop.stats.stepsLastFrame).toBe(3);
    expect(loop.stats.frameMs).toBeCloseTo(50, 9);
    expect(loop.stats.alpha).toBeGreaterThanOrEqual(0);
    expect(loop.stats.alpha).toBeLessThan(1);
    expect(loop.stats.fps).toBeGreaterThan(0);
    expect(h.upd).toHaveBeenLastCalledWith(expect.closeTo(0.05, 9), loop.stats.alpha);
    expect(h.ren).toHaveBeenLastCalledWith(loop.stats.alpha);
  });

  it('clamps long frames to maxFrameTime and maxSubSteps', () => {
    const scheduler = manualScheduler();
    const h = makeHooks();
    const loop = new GameLoop({ hooks: h.hooks, scheduler, simHz: 60, maxFrameTime: 0.25, maxSubSteps: 5 });
    loop.start();
    scheduler.frame(0);
    scheduler.frame(10_000); // 10 s stall
    expect(h.fixed).toHaveBeenCalledTimes(5);
    expect(loop.stats.frameMs).toBe(250);
    expect(loop.stats.alpha).toBeLessThan(1);
  });

  it('skips fixedUpdate while paused but still updates and renders', () => {
    const scheduler = manualScheduler();
    const h = makeHooks();
    const loop = new GameLoop({ hooks: h.hooks, scheduler });
    loop.start();
    scheduler.frame(0);
    loop.paused = true;
    scheduler.frame(100);
    scheduler.frame(200);
    expect(h.fixed).not.toHaveBeenCalled();
    expect(h.upd).toHaveBeenCalledTimes(3);
    expect(h.ren).toHaveBeenCalledTimes(3);
    expect(loop.stats.alpha).toBe(0);

    // Resuming does not replay the paused interval.
    loop.paused = false;
    scheduler.frame(217);
    expect(h.fixed).toHaveBeenCalledTimes(1);
  });

  it('stops scheduling after stop() is called from inside a hook', () => {
    const scheduler = manualScheduler();
    const h = makeHooks();
    const loop = new GameLoop({ hooks: h.hooks, scheduler });
    h.ren.mockImplementation(() => loop.stop());
    loop.start();
    scheduler.frame(0);
    expect(loop.isRunning).toBe(false);
    expect(scheduler.pending()).toBe(0);
  });

  it('falls back to setTimeout when requestAnimationFrame is unavailable', async () => {
    vi.useFakeTimers();
    try {
      const h = makeHooks();
      const loop = new GameLoop({ hooks: h.hooks, simHz: 60 });
      loop.start();
      await vi.advanceTimersByTimeAsync(100);
      loop.stop();
      expect(h.ren.mock.calls.length).toBeGreaterThan(1);
      expect(h.fixed.mock.calls.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a non-positive simHz', () => {
    expect(() => new GameLoop({ hooks: makeHooks().hooks, simHz: 0 })).toThrow(RangeError);
  });
});
