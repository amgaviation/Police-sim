import { describe, expect, it, vi } from 'vitest';
import { log } from '../../src/core/log';
import { GameLoop, stepAccumulator, type FrameScheduler, type LoopHooks } from '../../src/core/loop';
import { MAX_TIME_SCALE } from '../../src/core/time';

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
    scheduler.frame(10_000); // 10 s gap (a background tab): too long to be a frame
    expect(h.fixed).toHaveBeenCalledTimes(5);
    expect(h.upd).toHaveBeenLastCalledWith(0.25, loop.stats.alpha);
    expect(loop.stats.frameMs).toBe(0);
    expect(loop.stats.alpha).toBeLessThan(1);
  });

  it('reports the real length of a hitch while stepping at most maxFrameTime of simulation', () => {
    const scheduler = manualScheduler();
    const h = makeHooks();
    const loop = new GameLoop({ hooks: h.hooks, scheduler, simHz: 60, maxFrameTime: 0.25, maxSubSteps: 100 });
    loop.start();
    for (let i = 0; i < 60; i++) scheduler.frame(i * (1000 / 60));
    const before = h.fixed.mock.calls.length;
    const fps = loop.stats.fps;
    scheduler.frame(59 * (1000 / 60) + 1200); // 1.2 s stall
    expect(loop.stats.frameMs).toBeCloseTo(1200, 6);
    expect(loop.stats.fps).toBeLessThan(fps);
    expect(h.fixed.mock.calls.length - before).toBe(15); // 0.25 s of 1/60 s steps
    expect(h.upd).toHaveBeenLastCalledWith(0.25, loop.stats.alpha);
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

  it('keeps the interpolation alpha while paused so the image does not jump back', () => {
    const scheduler = manualScheduler();
    const h = makeHooks();
    const loop = new GameLoop({ hooks: h.hooks, scheduler, simHz: 60 });
    loop.start();
    scheduler.frame(0);
    scheduler.frame(1000 / 60 + 10);
    const alpha = loop.stats.alpha;
    expect(alpha).toBeGreaterThan(0.5);
    loop.paused = true;
    scheduler.frame(50);
    scheduler.frame(400);
    expect(h.ren).toHaveBeenLastCalledWith(alpha);
    expect(loop.stats.alpha).toBe(alpha);
    loop.paused = false;
    scheduler.frame(401);
    expect(loop.stats.alpha).toBeGreaterThan(alpha);
  });

  it('scales simulated time while keeping fixedDt steps (timeScale)', () => {
    const scheduler = manualScheduler();
    const h = makeHooks();
    const loop = new GameLoop({ hooks: h.hooks, scheduler, simHz: 60 });
    loop.timeScale = 0.5;
    loop.start();
    scheduler.frame(0);
    scheduler.frame(1000); // 1 s real = 0.5 s simulated, but only maxFrameTime (0.25 s) of real time counts
    expect(h.fixed.mock.calls.every((c) => c[0] === loop.fixedDt)).toBe(true);
    expect(h.fixed).toHaveBeenCalledTimes(5); // floor(0.25 * 0.5 * 60) = 7, capped at 5
    loop.timeScale = 0;
    scheduler.frame(1100);
    expect(h.fixed).toHaveBeenCalledTimes(5);
    expect(() => {
      loop.timeScale = -1;
    }).toThrow(RangeError);
  });

  it.each([0.25, 0.5, 1, 2, 3])('interpolated motion is monotonic at timeScale %s on a 144 Hz display', (scale) => {
    // One entity moving +1 unit per fixed step; render shows prev + (cur - prev) * alpha.
    let prev = 0;
    let cur = 0;
    const rendered: number[] = [];
    const hooks: LoopHooks = {
      fixedUpdate: () => {
        prev = cur;
        cur += 1;
      },
      update: () => undefined,
      render: (alpha) => rendered.push(prev + (cur - prev) * alpha),
    };
    const scheduler = manualScheduler();
    const loop = new GameLoop({ hooks, scheduler, simHz: 60 });
    loop.timeScale = scale;
    loop.start();
    for (let i = 0; i < 400; i++) scheduler.frame((i * 1000) / 144);
    // Skip the first frames: before the first step there is no previous state to interpolate from.
    const settled = rendered.slice(30);
    const deltas = settled.slice(1).map((v, i) => v - (settled[i] ?? 0));
    const ideal = (60 / 144) * scale;
    for (const d of deltas) {
      expect(d).toBeGreaterThanOrEqual(-1e-9);
      expect(Math.abs(d - ideal)).toBeLessThan(1e-6);
    }
  });

  it('frameCap skips frames offered faster than the cap', () => {
    const scheduler = manualScheduler();
    const h = makeHooks();
    const loop = new GameLoop({ hooks: h.hooks, scheduler, simHz: 60 });
    loop.frameCap = 30;
    loop.start();
    for (let i = 0; i < 60; i++) scheduler.frame((i * 1000) / 60); // 1 s of 60 Hz frames
    expect(h.ren).toHaveBeenCalledTimes(30);
    loop.frameCap = 0;
    for (let i = 60; i < 120; i++) scheduler.frame((i * 1000) / 60);
    expect(h.ren).toHaveBeenCalledTimes(90);
  });

  it('frameCap at the display rate tolerates timestamp jitter', () => {
    const scheduler = manualScheduler();
    const h = makeHooks();
    const loop = new GameLoop({ hooks: h.hooks, scheduler, simHz: 60 });
    loop.frameCap = 60;
    loop.start();
    for (let i = 0; i < 120; i++) scheduler.frame((i * 1000) / 60 + (i % 2 === 0 ? 0.4 : -0.4));
    expect(h.ren).toHaveBeenCalledTimes(120);
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

  it('bounds the fixed steps per frame however large the time scale (spiral-of-death guard)', () => {
    const scheduler = manualScheduler();
    const h = makeHooks();
    const loop = new GameLoop({ hooks: h.hooks, scheduler, simHz: 60 });
    expect(() => {
      loop.timeScale = 1e6;
    }).toThrow(RangeError);
    expect(() => {
      loop.timeScale = MAX_TIME_SCALE + 0.5;
    }).toThrow(RangeError);
    loop.timeScale = MAX_TIME_SCALE;
    loop.start();
    scheduler.frame(0);
    scheduler.frame(250);
    scheduler.frame(10_000); // a long stall is clamped to maxFrameTime
    expect(loop.stats.stepsLastFrame).toBeLessThanOrEqual(loop.maxSubSteps * MAX_TIME_SCALE);
    expect(h.fixed.mock.calls.length).toBeLessThanOrEqual(2 * loop.maxSubSteps * MAX_TIME_SCALE);
  });

  it('keeps running after a hook throws, and logs the error', () => {
    const scheduler = manualScheduler();
    const h = makeHooks();
    let once = true;
    h.fixed.mockImplementation(() => {
      if (once) {
        once = false;
        throw new Error('boom');
      }
    });
    const errors = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    try {
      const loop = new GameLoop({ hooks: h.hooks, scheduler, simHz: 60 });
      loop.start();
      scheduler.frame(0);
      scheduler.frame(20); // throws inside fixedUpdate
      expect(errors).toHaveBeenCalledTimes(1);
      expect(loop.isRunning).toBe(true);
      expect(scheduler.pending()).toBe(1);
      const rendered = h.ren.mock.calls.length;
      scheduler.frame(40);
      expect(h.ren.mock.calls.length).toBe(rendered + 1);
      expect(h.fixed.mock.calls.length).toBeGreaterThan(1);
    } finally {
      errors.mockRestore();
    }
  });

  it('rejects a non-positive simHz', () => {
    expect(() => new GameLoop({ hooks: makeHooks().hooks, simHz: 0 })).toThrow(RangeError);
  });
});
