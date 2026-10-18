import { CALENDAR_DATA } from './data';

/**
 * Game calendar (design §2): dates are integer epoch days (days since 1970-01-01, UTC civil
 * calendar). Pure integer maths (Hinnant's days-from-civil / civil-from-days); no `Date` at runtime.
 */

const SECONDS_PER_DAY = 86400;

/** Days since 1970-01-01 of a proleptic Gregorian date (`m` 1..12, `d` 1..31). */
export function epochDayFromYmd(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** Inverse of `epochDayFromYmd`. */
export function ymdOfEpochDay(day: number): { y: number; m: number; d: number } {
  const z = Math.floor(day) + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

/** Game day 0 (`calendar.json` startDate, 2026-06-01 = epoch day 20605, a Monday). */
export const CALENDAR: { readonly startEpochDay: number } = {
  startEpochDay: epochDayFromYmd(CALENDAR_DATA.y, CALENDAR_DATA.m, CALENDAR_DATA.d),
};

/** Epoch day of a game time (`env.time.totalSeconds`, 0 = 00:00 on game day 0). */
export function epochDayOfGameSeconds(gameSeconds: number): number {
  return CALENDAR.startEpochDay + Math.floor(gameSeconds / SECONDS_PER_DAY);
}

/** Game hour at which "today's" clothes and daily items change over (a quiet hour, not midnight). */
export const WARDROBE_ROLLOVER_H = 5;

/**
 * The day that keys clothes and daily items: like `epochDayOfGameSeconds` but rolling over at 05:00, so a person
 * does not change clothes or pockets in the middle of a night shift.
 */
export function wardrobeDayOfGameSeconds(gameSeconds: number): number {
  return CALENDAR.startEpochDay + Math.floor((gameSeconds - WARDROBE_ROLLOVER_H * 3600) / SECONDS_PER_DAY);
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "MM/DD/YYYY". */
export function formatDate(epochDay: number): string {
  const { y, m, d } = ymdOfEpochDay(epochDay);
  return `${pad2(m)}/${pad2(d)}/${String(y).padStart(4, '0')}`;
}

/** "HH:MM" time of day of a game time. */
export function formatClockTime(gameSeconds: number): string {
  const s = ((Math.floor(gameSeconds) % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}`;
}

/** "MM/DD/YYYY HH:MM". */
export function formatStamp(gameSeconds: number): string {
  return `${formatDate(epochDayOfGameSeconds(gameSeconds))} ${formatClockTime(gameSeconds)}`;
}

/** Whole years from `dob` to `epochDay` (both epoch days). */
export function ageOn(dob: number, epochDay: number): number {
  const a = ymdOfEpochDay(dob);
  const b = ymdOfEpochDay(epochDay);
  const beforeBirthday = b.m < a.m || (b.m === a.m && b.d < a.d);
  return b.y - a.y - (beforeBirthday ? 1 : 0);
}
