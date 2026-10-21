import { SECONDS_PER_DAY } from '../environment/time';
import { CAREER_CONFIG } from './data';
import { assignmentEffects } from './progression';
import type { CareerConfig, CareerRank, DutyAssignment, PayBreakdown, ShiftSlot, ShiftStats } from './types';

/** Shift pay and rent (Phase 8 design §5.5). Pure; whole game dollars. */

/**
 * `hours` = scheduled hours; `base = hours x hourly[rank]`; night slot adds `hours x nightPerHour`; the specialty (or fto)
 * premium is `hours x payPerHour`; overtime = `overtimeMinutes / 60 x hourly x overtimeMultiplier`; court = `courtMinutes
 * / 60 x hourly x courtMultiplier`. A suspended shift deducts base + night + specialty + fto. Every part is rounded.
 */
export function payForShift(
  input: {
    shiftNo: number; rank: CareerRank; assignment: DutyAssignment; slot: ShiftSlot; startGame: number; endGame: number;
    stats: Readonly<ShiftStats>; suspended: boolean;
  },
  cfg: CareerConfig = CAREER_CONFIG,
): PayBreakdown {
  const hours = (input.endGame - input.startGame) / 3600;
  const hourly = cfg.pay.hourly[input.rank];
  const premium = hours * assignmentEffects(input.assignment, cfg).payPerHour;
  const base = Math.round(hours * hourly);
  const night = input.slot === 'night' ? Math.round(hours * cfg.pay.nightPerHour) : 0;
  const specialty = input.assignment === 'patrol' || input.assignment === 'fto' ? 0 : Math.round(premium);
  const fto = input.assignment === 'fto' ? Math.round(premium) : 0;
  const overtime = Math.round((input.stats.overtimeMinutes / 60) * hourly * cfg.pay.overtimeMultiplier);
  const court = Math.round((input.stats.courtMinutes / 60) * hourly * cfg.pay.courtMultiplier);
  const deductions = input.suspended ? base + night + specialty + fto : 0;
  return { shiftNo: input.shiftNo, hours, base, night, specialty, fto, overtime, court, deductions, total: base + night + specialty + fto + overtime + court - deductions };
}

/** Rent due when `floor(epochDay / 7)` advanced since `lastRentDay`: `rentPerWeek` per week elapsed. */
export function rentDue(lastRentDay: number, epochDay: number, cfg: CareerConfig = CAREER_CONFIG): { amount: number; weeks: number } {
  const weeks = Math.max(0, Math.floor(epochDay / 7) - Math.floor(lastRentDay / 7));
  return { amount: weeks * cfg.pay.rentPerWeek, weeks };
}

/** Epoch day of a game time in seconds. */
export function epochDayOf(game: number): number {
  return Math.floor(game / SECONDS_PER_DAY);
}
