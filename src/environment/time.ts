import timeJson from '../data/environment/time.json';
import { readNumber, readObject, readVersion } from './validate';

/** Game (wall-clock) time derived from sim time. Weekday 0 = Monday. */
export interface GameTime {
  /** Game seconds since 00:00 of day 0. */
  totalSeconds: number;
  /** Whole days since the session's first day. */
  day: number;
  /** 0 = Monday .. 6 = Sunday. */
  weekday: number;
  isWeekday: boolean;
  /** Fractional hour of day in [0, 24). */
  hour: number;
  /** Whole minute of the hour in [0, 59]. */
  minute: number;
}

export interface TimeConfig {
  readonly startWeekday: number;
  readonly startHour: number;
  readonly gameSecondsPerSimSecond: number;
}

export const SECONDS_PER_DAY = 86400;
export const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

export function validateTimeConfig(data: unknown, file = 'time.json'): TimeConfig {
  const root = readObject(data, file, '');
  readVersion(root, file);
  return {
    startWeekday: readNumber(root.startWeekday, file, 'startWeekday', 0, 6),
    startHour: readNumber(root.startHour, file, 'startHour', 0, 23.999),
    gameSecondsPerSimSecond: readNumber(root.gameSecondsPerSimSecond, file, 'gameSecondsPerSimSecond', 0.001, 100000),
  };
}

export const TIME_CONFIG: TimeConfig = validateTimeConfig(timeJson);

export function createGameTime(): GameTime {
  return { totalSeconds: 0, day: 0, weekday: 0, isWeekday: true, hour: 0, minute: 0 };
}

/** Game seconds since 00:00 of day 0 at `simTime` (sim seconds) plus a saved forward offset. */
export function gameSecondsAt(simTime: number, timeOffset: number, config: TimeConfig = TIME_CONFIG): number {
  return config.startHour * 3600 + simTime * config.gameSecondsPerSimSecond + timeOffset;
}

/** Fills `out` with the game time at `simTime`; allocation-free. */
export function gameTimeAt(simTime: number, timeOffset: number, out: GameTime, config: TimeConfig = TIME_CONFIG): GameTime {
  const total = Math.max(0, gameSecondsAt(simTime, timeOffset, config));
  const day = Math.floor(total / SECONDS_PER_DAY);
  const secondOfDay = total - day * SECONDS_PER_DAY;
  out.totalSeconds = total;
  out.day = day;
  out.weekday = (Math.floor(config.startWeekday) + day) % 7;
  out.isWeekday = out.weekday < 5;
  out.hour = secondOfDay / 3600;
  out.minute = Math.floor((secondOfDay % 3600) / 60);
  return out;
}

/** `"Mon 07:42"`. */
export function formatClock(time: Readonly<GameTime>): string {
  const name = WEEKDAY_NAMES[time.weekday] ?? '???';
  const hh = String(Math.floor(time.hour)).padStart(2, '0');
  const mm = String(time.minute).padStart(2, '0');
  return `${name} ${hh}:${mm}`;
}
