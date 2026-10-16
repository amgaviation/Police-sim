import { describe, expect, it } from 'vitest';
import { GameClock, MAX_TIME_SCALE } from '../../src/core/time';

describe('GameClock', () => {
  it('starts at zero, unscaled and unpaused', () => {
    const clock = new GameClock();
    expect(clock.simTime).toBe(0);
    expect(clock.timeScale).toBe(1);
    expect(clock.paused).toBe(false);
  });

  it('advances by scaled dt and reports the amount applied', () => {
    const clock = new GameClock();
    expect(clock.advance(0.5)).toBe(0.5);
    clock.setTimeScale(2);
    expect(clock.advance(0.25)).toBe(0.5);
    expect(clock.simTime).toBe(1);
    clock.setTimeScale(0);
    expect(clock.advance(10)).toBe(0);
    expect(clock.simTime).toBe(1);
  });

  it('ignores non-positive or NaN dt', () => {
    const clock = new GameClock();
    expect(clock.advance(-1)).toBe(0);
    expect(clock.advance(Number.NaN)).toBe(0);
    expect(clock.simTime).toBe(0);
  });

  it('does not advance while paused', () => {
    const clock = new GameClock();
    clock.pause();
    expect(clock.paused).toBe(true);
    expect(clock.advance(1)).toBe(0);
    clock.resume();
    expect(clock.advance(1)).toBe(1);
    expect(clock.simTime).toBe(1);
  });

  it('rejects negative or non-finite time scales', () => {
    const clock = new GameClock();
    expect(() => clock.setTimeScale(-1)).toThrow(RangeError);
    expect(() => clock.setTimeScale(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => clock.setTimeScale(MAX_TIME_SCALE + 0.01)).toThrow(RangeError);
    expect(() => clock.setTimeScale(1e6)).toThrow(RangeError);
    expect(clock.timeScale).toBe(1);
    clock.setTimeScale(MAX_TIME_SCALE);
    expect(clock.timeScale).toBe(MAX_TIME_SCALE);
  });

  it('fromJSON clamps an out-of-range time scale', () => {
    expect(GameClock.fromJSON({ simTime: 0, timeScale: 1e6, paused: false }).timeScale).toBe(MAX_TIME_SCALE);
  });

  it('round-trips through toJSON/fromJSON', () => {
    const clock = new GameClock();
    clock.setTimeScale(3);
    clock.advance(2);
    clock.pause();
    const json = JSON.parse(JSON.stringify(clock)) as ReturnType<GameClock['toJSON']>;
    expect(json).toEqual({ simTime: 6, timeScale: 3, paused: true });

    const restored = GameClock.fromJSON(json);
    expect(restored.simTime).toBe(6);
    expect(restored.timeScale).toBe(3);
    expect(restored.paused).toBe(true);

    const inPlace = new GameClock().fromJSON(json);
    expect(inPlace.toJSON()).toEqual(json);
  });

  it('reset() clears elapsed time only', () => {
    const clock = new GameClock();
    clock.setTimeScale(2);
    clock.advance(1);
    clock.reset();
    expect(clock.simTime).toBe(0);
    expect(clock.timeScale).toBe(2);
    clock.reset(5);
    expect(clock.simTime).toBe(5);
  });

  it('addSimTime adds unscaled simulation seconds', () => {
    const clock = new GameClock();
    clock.setTimeScale(4);
    clock.addSimTime(1 / 60);
    clock.addSimTime(-1);
    expect(clock.simTime).toBe(1 / 60);
  });
});
