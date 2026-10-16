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
  /** Most fixed steps run in one frame. Default 5. */
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
  stepsLastFrame: number;
  /** Fraction of a fixed step left in the accumulator, in [0, 1). */
  alpha: number;
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
  if (!(fixedDt > 0)) throw new RangeError(`stepAccumulator: fixedDt must be > 0, got ${fixedDt}`);
  if (!(maxSteps >= 1)) throw new RangeError(`stepAccumulator: maxSteps must be >= 1, got ${maxSteps}`);
  let total = acc + Math.max(0, frameDt);
  const wanted = Math.floor(total / fixedDt);
  const steps = Math.min(wanted, Math.floor(maxSteps));
  total -= steps * fixedDt;
  if (total >= fixedDt) total %= fixedDt;
  if (total < 0) total = 0;
  return { steps, acc: total };
}

const FPS_SMOOTHING = 0.1;
const FALLBACK_FRAME_MS = 16;

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
  /** When true, no fixedUpdate runs; the accumulator is held at zero. */
  paused = false;

  readonly fixedDt: number;
  readonly maxFrameTime: number;
  readonly maxSubSteps: number;
  readonly stats: LoopStats = { fps: 0, frameMs: 0, simMs: 0, stepsLastFrame: 0, alpha: 0 };

  private readonly hooks: LoopHooks;
  private readonly scheduler: FrameScheduler;
  private running = false;
  private cancelFrame: (() => void) | null = null;
  private lastTimeMs: number | null = null;
  private acc = 0;
  private stepCount = 0;

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

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTimeMs = null;
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
    const frameDt =
      this.lastTimeMs === null ? 0 : Math.min(Math.max(0, (timeMs - this.lastTimeMs) / 1000), this.maxFrameTime);
    this.lastTimeMs = timeMs;

    let steps = 0;
    let simMs = 0;
    if (this.paused) {
      this.acc = 0;
    } else {
      const result = stepAccumulator(this.acc, frameDt, this.fixedDt, this.maxSubSteps);
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
    this.hooks.update(frameDt, alpha);
    this.hooks.render(alpha);

    const stats = this.stats;
    stats.frameMs = frameDt * 1000;
    stats.simMs = simMs;
    stats.stepsLastFrame = steps;
    stats.alpha = alpha;
    if (frameDt > 0) {
      const instant = 1 / frameDt;
      stats.fps = stats.fps === 0 ? instant : stats.fps + (instant - stats.fps) * FPS_SMOOTHING;
    }
  }

  private schedule(): void {
    this.cancelFrame = this.scheduler.request((t) => {
      this.cancelFrame = null;
      if (!this.running) return;
      this.tick(t);
      if (this.running) this.schedule();
    });
  }
}
