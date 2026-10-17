import { epochDayOfGameSeconds } from '../records/calendar';
import { unitHash } from '../records/hash';
import { PEOPLE_DATA } from './data';
import { SALT } from './salt';
import type { DrugKind, Intoxication } from './types';

/** Alcohol and drug sessions as a pure function of (seed, id, game time) (design §5.3). */

const SECONDS_PER_DAY = 86400;
/** BAC at which `level` reaches 1. */
const LEVEL_BAC = 0.2;
/** Drug-use level range, window start (hour) and length (hours, past midnight into the next day). */
const DRUG_LEVEL: readonly [number, number] = [0.3, 0.8];
const DRUG_FROM_HOUR = 18;
const DRUG_TO_HOUR = 2;

interface Session {
  /** Hours from the start of the session's day. */
  readonly start: number;
  readonly end: number;
  readonly peak: number;
}

/** Weekday of an epoch day, Monday = 0 (1970-01-01 was a Thursday). */
export function weekdayOfEpochDay(epochDay: number): number {
  return (((epochDay + 3) % 7) + 7) % 7;
}

function lerp(range: readonly [number, number], u: number): number {
  return range[0] + (range[1] - range[0]) * u;
}

/** The drinking session starting on game day `d` (days since game day 0), or null. */
function sessionOn(seed: number, id: number, d: number, drinker: number): Session | null {
  const dr = PEOPLE_DATA.drinking;
  const weekday = dr.weekday[weekdayOfEpochDay(epochDayOfGameSeconds(d * SECONDS_PER_DAY))] ?? 1;
  if (unitHash(seed, SALT.drinkDay ^ d, id) >= drinker * weekday * dr.sessionRate) return null;
  const start = lerp(dr.startHour, unitHash(seed, SALT.drinkStart ^ d, id));
  const duration = lerp(dr.durationH, unitHash(seed, SALT.drinkDuration ^ d, id));
  return { start, end: start + duration, peak: lerp(dr.peakBac, unitHash(seed, SALT.drinkPeak ^ d, id)) };
}

/** BAC of `s` at `t` hours after the start of the session's day. */
function sessionBac(s: Session, t: number): number {
  const dr = PEOPLE_DATA.drinking;
  if (t <= s.start) return 0;
  if (t <= s.end) return s.peak * Math.min(1, (t - s.start) / dr.riseH);
  const atEnd = s.peak * Math.min(1, (s.end - s.start) / dr.riseH);
  return Math.max(0, atEnd - dr.eliminationPerHour * (t - s.end));
}

/** Drug level at `hour` of game day `d` (0 outside the window or when no use that day). */
function drugLevelAt(seed: number, id: number, d: number, hour: number): number {
  const rate = PEOPLE_DATA.drugs.dailyUseRate;
  if (hour >= DRUG_FROM_HOUR && unitHash(seed, SALT.drugDay ^ d, id) < rate) return lerp(DRUG_LEVEL, unitHash(seed, SALT.drugLevel ^ d, id));
  if (hour < DRUG_TO_HOUR && unitHash(seed, SALT.drugDay ^ (d - 1), id) < rate) return lerp(DRUG_LEVEL, unitHash(seed, SALT.drugLevel ^ (d - 1), id));
  return 0;
}

/**
 * Base intoxication of a person at `gameSeconds`: a session on day d happens when
 * `unitHash(drinkDay ^ d) < drinker * weekday * sessionRate`; BAC rises linearly for `riseH`, holds until the
 * session ends, then falls by `eliminationPerHour` (sessions of the previous day that run past midnight count
 * too; the larger BAC wins). A drug user is under the influence at `dailyUseRate` of the evenings.
 */
export function baseIntoxication(seed: number, id: number, gameSeconds: number, drinker: number, drugUse: DrugKind): Intoxication {
  const d = Math.floor(gameSeconds / SECONDS_PER_DAY);
  const hour = (gameSeconds - d * SECONDS_PER_DAY) / 3600;
  let bac = 0;
  if (drinker > 0) {
    const today = sessionOn(seed, id, d, drinker);
    if (today) bac = sessionBac(today, hour);
    const yesterday = sessionOn(seed, id, d - 1, drinker);
    if (yesterday) bac = Math.max(bac, sessionBac(yesterday, hour + 24));
  }
  const drugLevel = drugUse === 'none' ? 0 : drugLevelAt(seed, id, d, hour);
  const level = Math.min(1, Math.max(0, Math.max(bac / LEVEL_BAC, drugLevel)));
  return { bac, drug: drugLevel > 0 ? drugUse : 'none', level };
}

/** Level of an intoxication from its parts (alcohol scaled by `LEVEL_BAC`, drug as given). */
export function intoxicationLevel(bac: number, drugLevel: number): number {
  return Math.min(1, Math.max(0, Math.max(bac / LEVEL_BAC, drugLevel)));
}
