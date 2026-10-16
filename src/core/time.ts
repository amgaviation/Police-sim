/**
 * Largest supported time scale. The game loop runs up to `maxSubSteps * timeScale`
 * fixed steps per frame, so an unbounded scale would defeat its spiral-of-death guard.
 */
export const MAX_TIME_SCALE = 8;

/** Serialized form of a GameClock. */
export interface GameClockState {
  readonly simTime: number;
  readonly timeScale: number;
  readonly paused: boolean;
}

/** Tracks simulation time, independent of wall-clock time. */
export class GameClock {
  private _simTime = 0;
  private _timeScale = 1;
  private _paused = false;

  /** Elapsed simulation time in seconds. */
  get simTime(): number {
    return this._simTime;
  }

  /** Multiplier applied to advanced time (0 = frozen, 2 = double speed). */
  get timeScale(): number {
    return this._timeScale;
  }

  get paused(): boolean {
    return this._paused;
  }

  /**
   * Advances the clock by `dt` real seconds scaled by `timeScale`.
   * Returns the simulation seconds actually added (0 while paused).
   */
  advance(dt: number): number {
    if (this._paused || !(dt > 0)) return 0;
    const scaled = dt * this._timeScale;
    this._simTime += scaled;
    return scaled;
  }

  /** Adds `simDt` simulation seconds unscaled (the caller already applied the time scale, e.g. one fixed step). */
  addSimTime(simDt: number): void {
    if (simDt > 0) this._simTime += simDt;
  }

  /** Throws a RangeError unless `scale` is in [0, MAX_TIME_SCALE]. */
  setTimeScale(scale: number): void {
    if (!Number.isFinite(scale) || scale < 0 || scale > MAX_TIME_SCALE) {
      throw new RangeError(`setTimeScale: scale must be in [0, ${MAX_TIME_SCALE}], got ${scale}`);
    }
    this._timeScale = scale;
  }

  pause(): void {
    this._paused = true;
  }

  resume(): void {
    this._paused = false;
  }

  /** Resets elapsed time (keeps scale and pause state). */
  reset(simTime = 0): void {
    this._simTime = simTime;
  }

  toJSON(): GameClockState {
    return { simTime: this._simTime, timeScale: this._timeScale, paused: this._paused };
  }

  /** Overwrites this clock from a serialized state. */
  fromJSON(state: GameClockState): this {
    this._simTime = Number.isFinite(state.simTime) ? state.simTime : 0;
    this.setTimeScale(Number.isFinite(state.timeScale) ? Math.min(Math.max(state.timeScale, 0), MAX_TIME_SCALE) : 1);
    this._paused = state.paused === true;
    return this;
  }

  static fromJSON(state: GameClockState): GameClock {
    return new GameClock().fromJSON(state);
  }
}
