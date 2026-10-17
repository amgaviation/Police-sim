import { CALENDAR } from '../../src/records/calendar';
import type { RecordsContext } from '../../src/records/person';

export const SEEDS = [42, 1234] as const;

/** Fake city context: ten home edges with a fixed address text. */
export function fakeCtx(today: number = CALENDAR.startEpochDay): RecordsContext {
  return {
    homeEdges: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    formatAddress: (e: number) => `${100 + e} Test Street`,
    today: () => today,
  };
}

/** `count` ids spread evenly over [0, size), plus 0 and size - 1. */
export function spreadIds(size: number, count: number): number[] {
  const ids = new Set<number>([0, size - 1]);
  for (let i = 0; i < count; i++) ids.add(Math.floor((i * size) / count + (i * 7) % Math.max(1, Math.floor(size / count))));
  return [...ids].filter((id) => id >= 0 && id < size).sort((a, b) => a - b);
}
