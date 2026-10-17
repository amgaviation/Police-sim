import { describe, expect, it } from 'vitest';
import { createGameTime, formatClock, gameTimeAt, validateTimeConfig, type TimeConfig } from '../../src/environment/time';

const CONFIG: TimeConfig = { startWeekday: 0, startHour: 7, gameSecondsPerSimSecond: 30 };

describe('gameTimeAt', () => {
  it('starts on Monday 07:00', () => {
    const t = gameTimeAt(0, 0, createGameTime(), CONFIG);
    expect(t).toEqual({ totalSeconds: 7 * 3600, day: 0, weekday: 0, isWeekday: true, hour: 7, minute: 0 });
  });

  it('runs one game hour per 120 sim seconds at rate 30', () => {
    const t = gameTimeAt(120, 0, createGameTime(), CONFIG);
    expect(t.hour).toBeCloseTo(8, 9);
    expect(t.minute).toBe(0);
  });

  it('reports the minute of the hour', () => {
    // 84 sim s = 2520 game s = 42 min
    const t = gameTimeAt(84, 0, createGameTime(), CONFIG);
    expect(t.minute).toBe(42);
    expect(Math.floor(t.hour)).toBe(7);
  });

  it('rolls the weekday over at midnight and adds the time offset', () => {
    const t = createGameTime();
    gameTimeAt((17 * 3600) / 30, 0, t, CONFIG);
    expect(t.day).toBe(1);
    expect(t.weekday).toBe(1);
    expect(t.hour).toBeCloseTo(0, 9);
    gameTimeAt(0, 17 * 3600 + 86400, t, CONFIG);
    expect(t.day).toBe(2);
    expect(t.weekday).toBe(2);
  });

  it('treats Saturday and Sunday as weekend and wraps back to Monday', () => {
    const t = createGameTime();
    const dayOffset = (d: number): number => d * 86400;
    expect(gameTimeAt(0, dayOffset(4), t, CONFIG).isWeekday).toBe(true);
    expect(gameTimeAt(0, dayOffset(5), t, CONFIG)).toMatchObject({ weekday: 5, isWeekday: false });
    expect(gameTimeAt(0, dayOffset(6), t, CONFIG)).toMatchObject({ weekday: 6, isWeekday: false });
    expect(gameTimeAt(0, dayOffset(7), t, CONFIG)).toMatchObject({ weekday: 0, isWeekday: true, day: 7 });
  });

  it('honours the start weekday from data', () => {
    const t = gameTimeAt(0, 0, createGameTime(), { ...CONFIG, startWeekday: 4 });
    expect(t.weekday).toBe(4);
    expect(gameTimeAt(0, 86400, t, { ...CONFIG, startWeekday: 4 }).weekday).toBe(5);
  });
});

describe('formatClock', () => {
  it('formats weekday and zero-padded HH:MM', () => {
    const t = createGameTime();
    expect(formatClock(gameTimeAt(84, 0, t, CONFIG))).toBe('Mon 07:42');
    expect(formatClock(gameTimeAt(0, 6 * 86400 + 17 * 3600 - 60, t, CONFIG))).toBe('Sun 23:59');
  });
});

describe('validateTimeConfig', () => {
  it('accepts the shipped shape', () => {
    expect(validateTimeConfig({ version: 1, startWeekday: 0, startHour: 7, gameSecondsPerSimSecond: 30 })).toEqual(CONFIG);
  });

  it('rejects malformed data with a readable error', () => {
    expect(() => validateTimeConfig({ version: 2, startWeekday: 0, startHour: 7, gameSecondsPerSimSecond: 30 })).toThrow(
      /time\.json: version/,
    );
    expect(() => validateTimeConfig({ version: 1, startWeekday: 9, startHour: 7, gameSecondsPerSimSecond: 30 })).toThrow(
      /time\.json: startWeekday must be in \[0, 6\]/,
    );
    expect(() => validateTimeConfig({ version: 1, startWeekday: 0, startHour: 7 })).toThrow(/gameSecondsPerSimSecond/);
    expect(() => validateTimeConfig(null)).toThrow(/must be an object/);
  });
});
