import { describe, expect, it } from 'vitest';
import {
  BEATS, CAREER_CONFIG, SHIFT_SLOTS, aiBidders, nextShiftStart, positionKeys, resolveBids, uniformCapacity, type Bidder, type BidPref,
} from '../../src/career';

const DAY = 86400;
const H = 3600;

function bidder(id: string, seniority: number, prefs: string[], probation = false): Bidder {
  return {
    id, name: id, seniority, probation,
    prefs: prefs.map((p): BidPref => {
      const [slot, beat] = p.split(':');
      return { slot: slot as BidPref['slot'], beat: beat as BidPref['beat'] };
    }),
  };
}

describe('positionKeys', () => {
  it('lists the 12 positions in SHIFT_SLOTS x BEATS order', () => {
    const keys = positionKeys();
    expect(keys).toHaveLength(12);
    expect(keys[0]).toBe('day:downtown');
    expect(keys[1]).toBe('day:suburbs');
    expect(keys[4]).toBe('swing:downtown');
    expect(keys[11]).toBe('night:highway');
    expect(keys).toEqual(SHIFT_SLOTS.flatMap((s) => BEATS.map((b) => `${s}:${b}`)));
  });
});

describe('nextShiftStart', () => {
  it('starts the night slot at 22:00 the same day when the rest allows', () => {
    const r = nextShiftStart(12 * H, 'night');
    expect(r.startGame).toBe(22 * H);
    expect(r.endGame).toBe(22 * H + 8 * H);
  });

  it('is strictly after the rest: a start exactly at the rest limit moves a day', () => {
    expect(nextShiftStart(14 * H, 'night').startGame).toBe(DAY + 22 * H);
    expect(nextShiftStart(14 * H, 'day').startGame).toBe(DAY + 6 * H);
  });

  it('respects the minimum rest for a day slot after a night shift', () => {
    // A night shift ends at 06:00 on day 1: 8 h of rest puts the earliest start at 14:00, so the day slot is day 2.
    const r = nextShiftStart(DAY + 6 * H, 'day');
    expect(r.startGame).toBe(2 * DAY + 6 * H);
    expect(nextShiftStart(DAY + 6 * H, 'swing').startGame).toBe(2 * DAY + 14 * H);
  });

  it('skips the rotation days off (days 5 and 6 of the week)', () => {
    const r = nextShiftStart(4 * DAY + 14 * H, 'day');
    expect(r.startGame).toBe(7 * DAY + 6 * H);
    expect(nextShiftStart(4 * DAY + 14 * H, 'night').startGame).toBe(7 * DAY + 22 * H);
  });

  it('uses the weekday of negative epoch days correctly', () => {
    expect(nextShiftStart(-2 * DAY, 'day').startGame).toBe(6 * H);
  });

  it('respects a custom schedule', () => {
    const cfg = { ...CAREER_CONFIG.shift, rotation: [0, 0, 1, 0, 0, 0, 0], hours: 10, minRestH: 0 };
    const r = nextShiftStart(0, 'swing', cfg);
    expect(r.startGame).toBe(2 * DAY + 14 * H);
    expect(r.endGame).toBe(2 * DAY + 24 * H);
  });
});

describe('resolveBids', () => {
  const cap1 = uniformCapacity(1);

  it('uniformCapacity gives every position the same seats', () => {
    const c = uniformCapacity(2);
    expect(Object.keys(c)).toHaveLength(12);
    expect(new Set(Object.values(c))).toEqual(new Set([2]));
  });

  it('the highest seniority gets its first choice', () => {
    const awards = resolveBids([bidder('a', 10, ['night:highway']), bidder('b', 50, ['night:highway'])], cap1);
    const b = awards.find((x) => x.id === 'b');
    expect(b).toEqual({ id: 'b', slot: 'night', beat: 'highway', prefRank: 0 });
    expect(awards[0]?.id).toBe('b');
  });

  it('a junior bidder gets the same choice only while capacity remains, else its second', () => {
    const bidders = [
      bidder('a', 50, ['day:downtown', 'swing:suburbs']),
      bidder('b', 40, ['day:downtown', 'swing:suburbs']),
      bidder('c', 30, ['day:downtown', 'swing:suburbs']),
    ];
    const one = resolveBids(bidders, cap1);
    expect(one.map((x) => [x.id, x.slot, x.beat, x.prefRank])).toEqual([
      ['a', 'day', 'downtown', 0], ['b', 'swing', 'suburbs', 1], ['c', 'day', 'suburbs', -1],
    ]);
    const two = resolveBids(bidders, uniformCapacity(2));
    expect(two.map((x) => x.prefRank)).toEqual([0, 0, 1]);
  });

  it('probationers bid last regardless of seniority', () => {
    const awards = resolveBids([bidder('rookie', 999, ['day:downtown'], true), bidder('vet', 1, ['day:downtown'])], cap1);
    expect(awards.map((a) => a.id)).toEqual(['vet', 'rookie']);
    expect(awards[0]?.prefRank).toBe(0);
    expect(awards[1]?.prefRank).toBe(-1);
  });

  it('breaks seniority ties by id ascending', () => {
    const awards = resolveBids([bidder('b', 20, ['day:downtown']), bidder('a', 20, ['day:downtown'])], cap1);
    expect(awards[0]).toEqual({ id: 'a', slot: 'day', beat: 'downtown', prefRank: 0 });
    expect(awards[1]?.prefRank).toBe(-1);
  });

  it('falls back to the first canonical position with a seat, in order', () => {
    const awards = resolveBids(
      [bidder('a', 30, ['day:downtown']), bidder('b', 20, ['day:downtown']), bidder('c', 10, [])], cap1,
    );
    expect(awards[1]).toEqual({ id: 'b', slot: 'day', beat: 'suburbs', prefRank: -1 });
    expect(awards[2]).toEqual({ id: 'c', slot: 'day', beat: 'industrial', prefRank: -1 });
  });

  it('gives no award when every seat is taken', () => {
    const bidders = Array.from({ length: 13 }, (_, i) => bidder(`b${String(i).padStart(2, '0')}`, 100 - i, []));
    const awards = resolveBids(bidders, cap1);
    expect(awards).toHaveLength(12);
    expect(awards.find((a) => a.id === 'b12')).toBeUndefined();
    expect(new Set(awards.map((a) => `${a.slot}:${a.beat}`)).size).toBe(12);
  });

  it('never mutates its inputs and is deterministic', () => {
    const bidders = [bidder('x', 5, ['day:downtown']), bidder('y', 9, ['day:downtown']), bidder('z', 1, ['night:highway'], true)];
    const capacity = uniformCapacity(1);
    const bidderCopy = JSON.stringify(bidders);
    const capacityCopy = JSON.stringify(capacity);
    const first = resolveBids(bidders, capacity);
    expect(JSON.stringify(bidders)).toBe(bidderCopy);
    expect(JSON.stringify(capacity)).toBe(capacityCopy);
    expect(resolveBids(bidders, capacity)).toEqual(first);
  });

  it('ignores positions missing from the capacity table', () => {
    const awards = resolveBids([bidder('a', 5, ['night:highway'])], { 'day:downtown': 1 });
    expect(awards).toEqual([{ id: 'a', slot: 'day', beat: 'downtown', prefRank: -1 }]);
  });
});

describe('aiBidders', () => {
  const roster = [{ id: 'A-12', name: 'Rivera' }, { id: 'A-14', name: 'Chen' }];
  const names = ['Pat', 'Sam', 'Lee'];

  it('builds roster bidders then synthetic ones, never on probation', () => {
    const list = aiBidders(42, roster, names);
    expect(list).toHaveLength(2 + CAREER_CONFIG.bidding.syntheticBidders);
    expect(list.slice(0, 2).map((b) => b.id)).toEqual(['A-12', 'A-14']);
    expect(list[2]?.id).toBe('S1');
    expect(list[10]?.id).toBe('S9');
    expect(list[2]?.name).toBe('Pat');
    expect(list[5]?.name).toBe('Pat');
    for (const b of list) {
      expect(b.probation).toBe(false);
      expect(b.seniority).toBeGreaterThanOrEqual(20);
      expect(b.seniority).toBeLessThan(420);
      expect(b.prefs).toHaveLength(CAREER_CONFIG.bidding.maxPrefs);
      const keys = b.prefs.map((p) => `${p.slot}:${p.beat}`);
      expect(new Set(keys).size).toBe(keys.length);
      for (const k of keys) expect(positionKeys()).toContain(k);
    }
  });

  it('is deterministic per seed and differs between seeds', () => {
    expect(aiBidders(42, roster, names)).toEqual(aiBidders(42, roster, names));
    expect(aiBidders(43, roster, names)).not.toEqual(aiBidders(42, roster, names));
  });

  it('moves day-slot preferences ahead of the others', () => {
    // With many bidders at least one has a day pref ahead of a non-day pref that the plain shuffle would not.
    const list = aiBidders(5, [], names, { ...CAREER_CONFIG.bidding, syntheticBidders: 60 });
    const ahead = list.filter((b) => {
      const firstNonDay = b.prefs.findIndex((p) => p.slot !== 'day');
      return firstNonDay > 0;
    });
    expect(ahead.length).toBeGreaterThan(0);
  });

  it('works with no names', () => {
    const list = aiBidders(1, [], [], { ...CAREER_CONFIG.bidding, syntheticBidders: 2 });
    expect(list.map((b) => b.name)).toEqual(['Officer S1', 'Officer S2']);
  });
});
