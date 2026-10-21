import { log } from './log';
import { MAX_TIME_SCALE } from './time';

export interface LoopHooks {
  /** Deterministic simulation step at `simHz`; `step` counts from 1. */
  fixedUpdate(dtSeconds: number, step: number): void;
  /** Per-frame work (input polling, camera); `alpha` interpolates between fixed steps. */
  update(dtSeconds: number, alpha: number): void;
  render(alpha: number): void;
}

/** Requests one frame callback; returns a function that cancels it. */
export interface FrameScheduler {
  request(callback: (timeMs: number) => void): () => void;
}

export interface GameLoopOptions {
  hooks: LoopHooks;
  /** Fixed simulation rate in steps per second. Default 60. */
  simHz?: number;
  /** Longest real frame (seconds) fed to the accumulator. Default 0.25. */
  maxFrameTime?: number;
  /** Most fixed steps run in one frame at time scale 1 (scaled with timeScale, up to MAX_TIME_SCALE). Default 5. */
  maxSubSteps?: number;
  /** Frame source; defaults to requestAnimationFrame, else setTimeout. */
  scheduler?: FrameScheduler;
}

export interface LoopStats {
  /** Smoothed frames per second. */
  fps: number;
  /** Real duration of the last frame in ms. */
  frameMs: number;
  /** Time spent in fixedUpdate during the last frame in ms. */
  simMs: number;
  /** Time spent in the `update` hook during the last frame in ms. */
  updateMs: number;
  /** Time spent in the `render` hook during the last frame in ms. */
  renderMs: number;
  stepsLastFrame: number;
  /** Fraction of a fixed step left in the accumulator, in [0, 1). */
  alpha: number;
}

/** Receives each frame's phase times (a `SystemProfiler` fits). `sim` is reported only for frames that ran steps. */
export interface FramePhaseSink {
  frame(phase: 'sim' | 'update' | 'render', ms: number): void;
}

export interface AccumulatorResult {
  steps: number;
  acc: number;
}

/**
 * Pure accumulator step: adds `frameDt`, returns how many fixed steps to run
 * (at most `maxSteps`) and the remaining accumulator. When the cap is hit,
 * surplus whole steps are discarded so the remainder stays below `fixedDt`
 * and the simulation falls behind instead of spiralling.
 */
export function stepAccumulator(
  acc: number,
  frameDt: number,
  fixedDt: number,
  maxSteps: number,
): AccumulatorResult {
  return stepAccumulatorInto({ steps: 0, acc: 0 }, acc, frameDt, fixedDt, maxSteps);
}

/** `stepAccumulator` writing into `out` (returned), so the per-frame loop allocates no result object. */
export function stepAccumulatorInto(
  out: AccumulatorResult,
  acc: number,
  frameDt: number,
  fixedDt: number,
  maxSteps: number,
): AccumulatorResult {
  if (!(fixedDt > 0)) throw new RangeError(`stepAccumulator: fixedDt must be > 0, got ${fixedDt}`);
  if (!(maxSteps >= 1)) throw new RangeError(`stepAccumulator: maxSteps must be >= 1, got ${maxSteps}`);
  let total = acc + Math.max(0, frameDt);
  const wanted = Math.floor(total / fixedDt);
  const steps = Math.min(wanted, Math.floor(maxSteps));
  total -= steps * fixedDt;
  if (total >= fixedDt) total %= fixedDt;
  if (total < 0) total = 0;
  out.steps = steps;
  out.acc = total;
  return out;
}

/** Frame intervals longer than this (s) are left out of the stats. */
const STATS_MAX_FRAME_S = 5;
const FPS_SMOOTHING = 0.1;
const FALLBACK_FRAME_MS = 16;
/** Frames this close to their frame-cap due time still run (absorbs rAF jitter). */
const FRAME_CAP_SLACK_MS = 1;

function now(): number {
  return performance.now();
}

function defaultScheduler(): FrameScheduler {
  const g = globalThis as { requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown };
  if (typeof g.requestAnimationFrame === 'function' && typeof g.cancelAnimationFrame === 'function') {
    return {
      request: (cb) => {
        const id = requestAnimationFrame(cb);
        return () => cancelAnimationFrame(id);
      },
    };
  }
  return {
    request: (cb) => {
      const id = setTimeout(() => cb(now()), FALLBACK_FRAME_MS);
      return () => clearTimeout(id);
    },
  };
}

/**
 * Fixed-timestep game loop with a variable-rate render. While `paused`,
 * fixed steps are skipped but `update` and `render` keep running.
 */
export class GameLoop {
  /**
   * When true, no fixedUpdate runs. The accumulator is left untouched, so the
   * paused frames render the same interpolated pose as the last running frame.
   */
  paused = false;
  /** Frames per second the scheduler runs at most; 0 = every frame it offers. */
  frameCap = 0;

  readonly fixedDt: number;
  readonly maxFrameTime: number;
  readonly maxSubSteps: number;
  readonly stats: LoopStats = { fps: 0, frameMs: 0, simMs: 0, updateMs: 0, renderMs: 0, stepsLastFrame: 0, alpha: 0 };

  private readonly hooks: LoopHooks;
  private readonly scheduler: FrameScheduler;
  private running = false;
  private cancelFrame: (() => void) | null = null;
  private lastTimeMs: number | null = null;
  private acc = 0;
  private stepCount = 0;
  private scale = 1;
  private nextFrameDueMs: number | null = null;
  private lastError: string | null = null;
  private readonly accResult: AccumulatorResult = { steps: 0, acc: 0 };
  private phaseSink: FramePhaseSink | null = null;

  constructor(options: GameLoopOptions) {
    const simHz = options.simHz ?? 60;
    if (!(simHz > 0)) throw new RangeError(`GameLoop: simHz must be > 0, got ${simHz}`);
    this.hooks = options.hooks;
    this.fixedDt = 1 / simHz;
    this.maxFrameTime = options.maxFrameTime ?? 0.25;
    this.maxSubSteps = options.maxSubSteps ?? 5;
    this.scheduler = options.scheduler ?? defaultScheduler();
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** Total fixed steps run since construction. */
  get step(): number {
    return this.stepCount;
  }

  /**
   * Simulation seconds per real second (0 freezes, 2 runs twice as fast).
   * Each fixed step still advances exactly `fixedDt`, so the interpolation
   * alpha stays consistent with the pair of states the steps produced.
   * Must be in [0, MAX_TIME_SCALE] so the per-frame work stays bounded.
   */
  get timeScale(): number {
    return this.scale;
  }

  set timeScale(scale: number) {
    if (!Number.isFinite(scale) || scale < 0 || scale > MAX_TIME_SCALE) {
      throw new RangeError(`GameLoop: timeScale must be in [0, ${MAX_TIME_SCALE}], got ${scale}`);
    }
    this.scale = scale;
  }

  /** Reports the sim, update and render time of every frame to `sink` (null stops). */
  setPhaseSink(sink: FramePhaseSink | null): void {
    this.phaseSink = sink;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTimeMs = null;
    this.nextFrameDueMs = null;
    this.schedule();
  }

  stop(): void {
    this.running = false;
    this.cancelFrame?.();
    this.cancelFrame = null;
  }

  /**
   * Runs one frame at the given timestamp (ms). Called by the scheduler;
   * callable directly for headless/manual stepping.
   */
  tick(timeMs: number): void {
    // The real interval feeds the stats (so hitches show); the capped one drives the sim.
    const rawDt = this.lastTimeMs === null ? 0 : Math.max(0, (timeMs - this.lastTimeMs) / 1000);
    const frameDt = Math.min(rawDt, this.maxFrameTime);
    this.lastTimeMs = timeMs;

    let steps = 0;
    let simMs = 0;
    if (!this.paused) {
      const scaledCap = Math.ceil(this.maxSubSteps * Math.min(this.scale, MAX_TIME_SCALE));
      const maxSteps = Math.max(this.maxSubSteps, scaledCap);
      const result = stepAccumulatorInto(this.accResult, this.acc, frameDt * this.scale, this.fixedDt, maxSteps);
      steps = result.steps;
      this.acc = result.acc;
      const simStart = now();
      for (let i = 0; i < steps; i++) {
        this.stepCount++;
        this.hooks.fixedUpdate(this.fixedDt, this.stepCount);
      }
      simMs = steps > 0 ? now() - simStart : 0;
    }

    const alpha = this.acc / this.fixedDt;
    const updateStart = now();
    this.hooks.update(frameDt, alpha);
    const renderStart = now();
    this.hooks.render(alpha);
    const renderEnd = now();

    const stats = this.stats;
    stats.simMs = simMs;
    stats.updateMs = renderStart - updateStart;
    stats.renderMs = renderEnd - renderStart;
    const sink = this.phaseSink;
    if (sink !== null) {
      if (steps > 0) sink.frame('sim', simMs);
      sink.frame('update', stats.updateMs);
      sink.frame('render', stats.renderMs);
    }
    stats.stepsLastFrame = steps;
    stats.alpha = alpha;
    // A gap this long is a background tab (no frames), not a slow frame.
    if (rawDt > 0 && rawDt <= STATS_MAX_FRAME_S) {
      stats.frameMs = rawDt * 1000;
      const instant = 1 / rawDt;
      stats.fps = stats.fps === 0 ? instant : stats.fps + (instant - stats.fps) * FPS_SMOOTHING;
    }
  }

  private schedule(): void {
    this.cancelFrame = this.scheduler.request((t) => {
      this.cancelFrame = null;
      if (!this.running) return;
      try {
        if (this.frameDue(t)) this.tick(t);
        this.lastError = null;
      } catch (error) {
        // A throwing hook must not kill the loop; log once per run of identical errors.
        const message = String(error);
        if (message !== this.lastError) log.error('Game loop frame failed:', error);
        this.lastError = message;
      } finally {
        if (this.running) this.schedule();
      }
    });
  }

  /** Applies `frameCap`: true when a frame offered at `timeMs` should run. */
  private frameDue(timeMs: number): boolean {
    if (!(this.frameCap > 0)) {
      this.nextFrameDueMs = null;
      return true;
    }
    const interval = 1000 / this.frameCap;
    const due = this.nextFrameDueMs;
    if (due !== null && timeMs < due - FRAME_CAP_SLACK_MS) return false;
    // Keep a steady cadence; resynchronise after a long stall.
    const base = due !== null && timeMs - due < interval ? due : timeMs;
    this.nextFrameDueMs = base + interval;
    return true;
  }
}
