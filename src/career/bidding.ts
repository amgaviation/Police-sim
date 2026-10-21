import { createRng, hashString } from '../core/rng';
import { SECONDS_PER_DAY } from '../environment/time';
import { CAREER_CONFIG } from './data';
import { BEATS, SHIFT_SLOTS, type BidAward, type Bidder, type BidPref, type Beat, type CareerConfig, type ShiftSlot } from './types';

/** Shift schedule and seniority bidding (Phase 8 design §5.4). Pure. */

const POSITIONS: readonly string[] = Object.freeze(SHIFT_SLOTS.flatMap((slot) => BEATS.map((beat) => `${slot}:${beat}`)));

/**
 * Next shift start strictly after `afterGame + minRestH * 3600`: the first day whose rotation entry is 1, at the slot's
 * start hour. `endGame = startGame + hours * 3600`.
 */
export function nextShiftStart(
  afterGame: number, slot: ShiftSlot, cfg: CareerConfig['shift'] = CAREER_CONFIG.shift,
): { startGame: number; endGame: number } {
  const earliest = afterGame + cfg.minRestH * 3600;
  const hourOffset = cfg.startHour[slot] * 3600;
  let day = Math.floor(earliest / SECONDS_PER_DAY);
  for (let guard = 0; guard < 16; guard++, day++) {
    const start = day * SECONDS_PER_DAY + hourOffset;
    if (start > earliest && cfg.rotation[((day % 7) + 7) % 7] === 1) return { startGame: start, endGame: start + cfg.hours * 3600 };
  }
  // Unreachable with a validated rotation (at least one working day in 7); keeps the function total.
  const start = day * SECONDS_PER_DAY + hourOffset;
  return { startGame: start, endGame: start + cfg.hours * 3600 };
}

/** The 12 positions in canonical order: `SHIFT_SLOTS` x `BEATS` ('day:downtown', 'day:suburbs', ...). */
export function positionKeys(): readonly string[] {
  return POSITIONS;
}

/** 'day:downtown' -> `{ slot: 'day', beat: 'downtown' }`. */
export function parsePositionKey(key: string): BidPref {
  const i = key.indexOf(':');
  return { slot: key.slice(0, i) as ShiftSlot, beat: key.slice(i + 1) as Beat };
}

/** The key of a preference ('night:highway'). */
export function positionKey(pref: Readonly<BidPref>): string {
  return `${pref.slot}:${pref.beat}`;
}

/**
 * Roster AI bidders plus `syntheticBidders` more (ids 'S1'.., names round robin from `names`). Seniority =
 * `20 + hashString(`${seed}:bid:${id}`) % 400`; prefs = the first `maxPrefs` of the shuffled positions (stream
 * `bid:${id}`), then one draw per pref moves day-slot prefs ahead with probability 0.5. Never on probation.
 */
export function aiBidders(
  seed: number, roster: readonly { id: string; name: string }[], names: readonly string[], cfg: CareerConfig['bidding'] = CAREER_CONFIG.bidding,
): Bidder[] {
  const people: { id: string; name: string }[] = roster.map((r) => ({ id: r.id, name: r.name }));
  for (let i = 0; i < cfg.syntheticBidders; i++) {
    people.push({ id: `S${i + 1}`, name: names.length > 0 ? (names[i % names.length] ?? `Officer S${i + 1}`) : `Officer S${i + 1}` });
  }
  return people.map((p) => {
    const rng = createRng(seed).stream(`bid:${p.id}`);
    const picked = rng.shuffle(POSITIONS.slice()).slice(0, cfg.maxPrefs).map(parsePositionKey);
    const ahead: BidPref[] = [];
    const rest: BidPref[] = [];
    for (const pref of picked) {
      const move = rng.next() < 0.5;
      (move && pref.slot === 'day' ? ahead : rest).push(pref);
    }
    return {
      id: p.id, name: p.name, seniority: 20 + (hashString(`${seed}:bid:${p.id}`) % 400), probation: false, prefs: [...ahead, ...rest],
    };
  });
}

/**
 * Seniority order: non-probation first, then seniority descending, then id ascending. Each bidder takes its first
 * preference with a seat left (`prefRank` = its index), else the first canonical position with a seat (`prefRank` -1),
 * else gets no award. `capacity` (seats left per position key) and the bidders are never mutated.
 */
export function resolveBids(bidders: readonly Bidder[], capacity: Readonly<Record<string, number>>): BidAward[] {
  const seats: Record<string, number> = { ...capacity };
  const order = bidders.slice().sort((a, b) => {
    if (a.probation !== b.probation) return a.probation ? 1 : -1;
    if (a.seniority !== b.seniority) return b.seniority - a.seniority;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const awards: BidAward[] = [];
  for (const bidder of order) {
    let prefRank = -2;
    let key = '';
    for (let i = 0; i < bidder.prefs.length; i++) {
      const pref = bidder.prefs[i];
      if (pref === undefined) continue;
      const k = positionKey(pref);
      if ((seats[k] ?? 0) > 0) {
        prefRank = i;
        key = k;
        break;
      }
    }
    if (prefRank === -2) {
      const fallback = POSITIONS.find((k) => (seats[k] ?? 0) > 0);
      if (fallback === undefined) continue;
      prefRank = -1;
      key = fallback;
    }
    seats[key] = (seats[key] ?? 0) - 1;
    const pos = parsePositionKey(key);
    awards.push({ id: bidder.id, slot: pos.slot, beat: pos.beat, prefRank });
  }
  return awards;
}

/** Every position key gets `seats` seats. */
export function uniformCapacity(seats: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of POSITIONS) out[k] = seats;
  return out;
}
