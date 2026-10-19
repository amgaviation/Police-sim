/**
 * Neighbourhood canvass roll (design phase 4 §9.5): whether a door is answered and what the resident saw,
 * decided by integer hashing so the same call and building always give the same answer.
 */
import { unitHash } from '../records/hash';
import type { CanvassRecord } from './caseFile';

/** Hours (inclusive) at which residents are usually home and awake. */
export const CANVASS_DAY_HOURS: readonly [number, number] = [8, 21];
export const ANSWER_CHANCE_DAY = 0.75;
export const ANSWER_CHANCE_NIGHT = 0.35;
export const REFUSE_CHANCE = 0.1;

export function canvassResult(
  seed: number,
  callId: number,
  buildingId: number,
  hour: number,
  sawChance: number,
): { answered: boolean; result: CanvassRecord['result']; residentIndex: number } {
  const id = callId * 4099 + buildingId;
  const u1 = unitHash(seed, 0x6a11, id);
  const u2 = unitHash(seed, 0x6a12, id);
  const u3 = unitHash(seed, 0x6a13, id);
  const day = hour >= CANVASS_DAY_HOURS[0] && hour <= CANVASS_DAY_HOURS[1];
  const answered = u1 < (day ? ANSWER_CHANCE_DAY : ANSWER_CHANCE_NIGHT);
  let result: CanvassRecord['result'] = 'noAnswer';
  if (answered) {
    if (u2 < REFUSE_CHANCE) result = 'refused';
    else if (u2 < REFUSE_CHANCE + sawChance) result = 'sawSomething';
    else result = 'nothingSeen';
  }
  return { answered, result, residentIndex: Math.floor(u3 * 3) };
}
