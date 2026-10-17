import { describe, expect, it } from 'vitest';
import {
  CALENDAR,
  ageOn,
  epochDayFromYmd,
  epochDayOfGameSeconds,
  formatClockTime,
  formatDate,
  formatStamp,
  ymdOfEpochDay,
} from '../../src/records/calendar';

describe('calendar', () => {
  it('starts on 2026-06-01 = epoch day 20605, a Monday', () => {
    expect(CALENDAR.startEpochDay).toBe(20605);
    // Cross-check once against the platform Date (tests only; runtime code never uses Date).
    expect(Date.UTC(2026, 5, 1) / 86400000).toBe(20605);
    expect(new Date(Date.UTC(2026, 5, 1)).getUTCDay()).toBe(1);
    expect(ymdOfEpochDay(CALENDAR.startEpochDay)).toEqual({ y: 2026, m: 6, d: 1 });
  });

  it('round-trips epoch days and agrees with Date.UTC', () => {
    for (let day = CALENDAR.startEpochDay - 1000; day < CALENDAR.startEpochDay + 1000; day++) {
      const { y, m, d } = ymdOfEpochDay(day);
      expect(epochDayFromYmd(y, m, d)).toBe(day);
      if (day % 97 === 0) expect(Date.UTC(y, m - 1, d) / 86400000).toBe(day);
    }
    expect(epochDayFromYmd(1970, 1, 1)).toBe(0);
    expect(ymdOfEpochDay(-1)).toEqual({ y: 1969, m: 12, d: 31 });
    expect(ymdOfEpochDay(epochDayFromYmd(2024, 2, 29))).toEqual({ y: 2024, m: 2, d: 29 });
    expect(epochDayFromYmd(2000, 3, 1) - epochDayFromYmd(2000, 2, 28)).toBe(2);
    expect(epochDayFromYmd(1900, 3, 1) - epochDayFromYmd(1900, 2, 28)).toBe(1);
  });

  it('formats dates, clock times and stamps', () => {
    expect(formatDate(CALENDAR.startEpochDay)).toBe('06/01/2026');
    expect(formatDate(epochDayFromYmd(1987, 12, 9))).toBe('12/09/1987');
    expect(formatClockTime(0)).toBe('00:00');
    expect(formatClockTime(14 * 3600 + 32 * 60 + 59)).toBe('14:32');
    expect(formatClockTime(86400 + 3600)).toBe('01:00');
    expect(formatStamp(14 * 3600 + 32 * 60)).toBe('06/01/2026 14:32');
    expect(formatStamp(2 * 86400 + 23 * 3600 + 59 * 60)).toBe('06/03/2026 23:59');
    expect(epochDayOfGameSeconds(0)).toBe(20605);
    expect(epochDayOfGameSeconds(86399)).toBe(20605);
    expect(epochDayOfGameSeconds(86400)).toBe(20606);
  });

  it('computes whole-year ages', () => {
    const dob = epochDayFromYmd(1990, 6, 2);
    expect(ageOn(dob, epochDayFromYmd(2026, 6, 1))).toBe(35);
    expect(ageOn(dob, epochDayFromYmd(2026, 6, 2))).toBe(36);
    expect(ageOn(epochDayFromYmd(2008, 2, 29), epochDayFromYmd(2026, 2, 28))).toBe(17);
    expect(ageOn(epochDayFromYmd(2008, 2, 29), epochDayFromYmd(2026, 3, 1))).toBe(18);
  });
});
