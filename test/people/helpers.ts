import { RecordsDb } from '../../src/records/db';
import { CALENDAR } from '../../src/records/calendar';
import { Population } from '../../src/people/population';
import { fakeCtx } from '../records/helpers';

export const SEED = 42;
export const DAY = 86400;

export interface Rig {
  readonly records: RecordsDb;
  readonly pop: Population;
  /** Game seconds; assign to move the clock. */
  clock: { t: number };
}

/** A records database (fake city) plus a population whose clock the test controls. */
export function makeRig(seed: number = SEED, start = 0): Rig {
  const clock = { t: start };
  const records = new RecordsDb(seed, fakeCtx(CALENDAR.startEpochDay));
  const pop = new Population({ seed, records, now: () => clock.t });
  return { records, pop, clock };
}

/** `count` ids spread over the whole population. */
export function ids(count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push((i * 49) % 100000 + (i % 7));
  return out;
}
