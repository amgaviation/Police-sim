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

  setTimeScale(scale: number): void {
    if (!Number.isFinite(scale) || scale < 0) {
      throw new RangeError(`setTimeScale: scale must be a finite number >= 0, got ${scale}`);
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
    this.setTimeScale(Number.isFinite(state.timeScale) ? state.timeScale : 1);
    this._paused = state.paused === true;
    return this;
  }

  static fromJSON(state: GameClockState): GameClock {
    return new GameClock().fromJSON(state);
  }
}
