import { describe, expect, it } from 'vitest';
import { payForShift, rentDue, type CareerRank, type DutyAssignment, type ShiftSlot, type ShiftStats } from '../../src/career';
import { emptyShiftStats } from '../../src/career/save';

const H = 3600;

function pay(over: {
  rank?: CareerRank; assignment?: DutyAssignment; slot?: ShiftSlot; stats?: Partial<ShiftStats>; suspended?: boolean; hours?: number;
} = {}) {
  return payForShift({
    shiftNo: 4, rank: over.rank ?? 'officer', assignment: over.assignment ?? 'patrol', slot: over.slot ?? 'day', startGame: 6 * H,
    endGame: 6 * H + (over.hours ?? 8) * H, stats: { ...emptyShiftStats(), ...over.stats }, suspended: over.suspended ?? false,
  });
}

describe('payForShift', () => {
  it('pays a plain day shift at the hourly rate', () => {
    expect(pay()).toEqual({ shiftNo: 4, hours: 8, base: 240, night: 0, specialty: 0, fto: 0, overtime: 0, court: 0, deductions: 0, total: 240 });
  });

  it('pays the hourly rate of the rank', () => {
    expect(pay({ rank: 'sergeant' }).base).toBe(304);
    expect(pay({ rank: 'captain' }).total).toBe(400);
  });

  it('adds the night differential on the night slot only', () => {
    expect(pay({ slot: 'night' }).night).toBe(16);
    expect(pay({ slot: 'night' }).total).toBe(256);
    expect(pay({ slot: 'swing' }).night).toBe(0);
  });

  it('pays overtime at 1.5x and court time at 1.5x', () => {
    const p = pay({ slot: 'night', stats: { overtimeMinutes: 90, courtMinutes: 60 } });
    expect(p.overtime).toBe(68);
    expect(p.court).toBe(45);
    expect(p.total).toBe(240 + 16 + 68 + 45);
  });

  it('adds the specialty premium and the fto premium', () => {
    const traffic = pay({ assignment: 'traffic' });
    expect(traffic.specialty).toBe(16);
    expect(traffic.fto).toBe(0);
    expect(traffic.total).toBe(256);
    const fto = pay({ assignment: 'fto' });
    expect(fto.fto).toBe(24);
    expect(fto.specialty).toBe(0);
    expect(fto.total).toBe(264);
    expect(pay({ assignment: 'detective' }).specialty).toBe(32);
  });

  it('a suspended shift deducts base, night, specialty and fto but keeps overtime and court', () => {
    const p = pay({ slot: 'night', assignment: 'k9', suspended: true, stats: { overtimeMinutes: 60 } });
    expect(p.deductions).toBe(240 + 16 + 24);
    expect(p.overtime).toBe(45);
    expect(p.total).toBe(45);
    expect(pay({ suspended: true }).total).toBe(0);
  });

  it('scales with the scheduled hours and rounds to whole dollars', () => {
    expect(pay({ hours: 10 }).base).toBe(300);
    expect(pay({ hours: 10 }).hours).toBe(10);
    const odd = pay({ rank: 'corporal', hours: 7.5, stats: { overtimeMinutes: 7 } });
    expect(Number.isInteger(odd.base)).toBe(true);
    expect(Number.isInteger(odd.overtime)).toBe(true);
    expect(odd.base).toBe(Math.round(7.5 * 33));
    expect(odd.overtime).toBe(Math.round((7 / 60) * 33 * 1.5));
  });
});

describe('rentDue', () => {
  it('is due when the week number advanced', () => {
    expect(rentDue(0, 6)).toEqual({ amount: 0, weeks: 0 });
    expect(rentDue(0, 7)).toEqual({ amount: 600, weeks: 1 });
    expect(rentDue(6, 7)).toEqual({ amount: 600, weeks: 1 });
    expect(rentDue(7, 13)).toEqual({ amount: 0, weeks: 0 });
    expect(rentDue(1, 22)).toEqual({ amount: 1800, weeks: 3 });
  });

  it('never goes negative', () => {
    expect(rentDue(30, 10)).toEqual({ amount: 0, weeks: 0 });
  });
});
