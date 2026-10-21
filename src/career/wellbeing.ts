import { CAREER_CONFIG } from './data';
import type {
  OffDutyActivity, PerformanceMods, ShiftSlot, StressEvent, Wellbeing, WellbeingConfig,
} from './types';

/** Fatigue, stress and health model (Phase 8 design §5.3). Pure; every value clamps to 0..1 (`sleepDebtH` 0..24). */

const MAX_SLEEP_DEBT_H = 24;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampDebt(v: number): number {
  return v < 0 ? 0 : v > MAX_SLEEP_DEBT_H ? MAX_SLEEP_DEBT_H : v;
}

/** A rested officer at the start of a career. */
export function newWellbeing(): Wellbeing {
  return { fatigue: 0.1, stress: 0.15, health: 1, fitness: 0.6, family: 0.7, sleepDebtH: 0 };
}

/** `base * slotFactor[slot] * (1 + sleepDebtFactor * min(sleepDebtH, 16) / 8) * (1.2 - 0.4 * fitness)`. */
export function fatigueRatePerHour(slot: ShiftSlot, w: Readonly<Wellbeing>, cfg: WellbeingConfig = CAREER_CONFIG.wellbeing): number {
  const debt = 1 + (cfg.sleepDebtFactor * Math.min(w.sleepDebtH, 16)) / 8;
  return cfg.fatiguePerHour * cfg.slotFactor[slot] * debt * (1.2 - 0.4 * w.fitness);
}

/** On duty for `minutes`: fatigue grows by the rate, stress decays slowly. Mutates `w`. */
export function tickOnDuty(w: Wellbeing, minutes: number, slot: ShiftSlot, cfg: WellbeingConfig = CAREER_CONFIG.wellbeing): void {
  const hours = minutes / 60;
  w.fatigue = clamp01(w.fatigue + fatigueRatePerHour(slot, w, cfg) * hours);
  w.stress = clamp01(w.stress - cfg.stressDecayOnDutyPerHour * hours);
}

/** Adds the table delta (positive deltas scale by `1.2 - 0.2 * fitness - 0.2 * family`); returns the applied delta. */
export function applyStressEvent(w: Wellbeing, ev: StressEvent, cfg: WellbeingConfig = CAREER_CONFIG.wellbeing): number {
  let delta = cfg.stress[ev];
  if (delta > 0) delta *= 1.2 - 0.2 * w.fitness - 0.2 * w.family;
  w.stress = clamp01(w.stress + delta);
  return delta;
}

/** `health -= amount; stress += 0.5 * amount`. */
export function applyInjury(w: Wellbeing, amount: number): void {
  w.health = clamp01(w.health - amount);
  w.stress = clamp01(w.stress + 0.5 * amount);
}

/** Per-hour activity deltas times `hours`; returns the money earned and the hours slept. */
export function applyActivity(
  w: Wellbeing, a: OffDutyActivity, hours: number, cfg: WellbeingConfig = CAREER_CONFIG.wellbeing,
): { moneyDelta: number; sleptH: number } {
  const def = cfg.activities[a];
  w.fatigue = clamp01(w.fatigue + def.fatigue * hours);
  w.stress = clamp01(w.stress + def.stress * hours);
  w.fitness = clamp01(w.fitness + def.fitness * hours);
  w.family = clamp01(w.family + def.family * hours);
  return { moneyDelta: def.money * hours, sleptH: def.sleep * hours };
}

/** Unplanned off-duty hours; returns the hours slept. */
export function applyIdle(w: Wellbeing, hours: number, cfg: WellbeingConfig = CAREER_CONFIG.wellbeing): number {
  w.fatigue = clamp01(w.fatigue + cfg.idle.fatigue * hours);
  w.stress = clamp01(w.stress + cfg.idle.stress * hours);
  return cfg.idle.sleep * hours;
}

/**
 * Once per off-duty period (at Report for duty). Sleep debt grows by the shortfall to `sleepNeedH` and shrinks by any
 * sleep beyond the need; no family time -> `daysWithoutFamily++` and family falls by `familyPerDay` times that count;
 * family below `familyStressBelow` adds stress; no exercise beyond the grace days lowers fitness; money below zero adds
 * stress; health recovers per day. Mutates `w` and the counters `n`.
 */
export function applyNeglect(
  w: Wellbeing,
  n: { daysWithoutFamily: number; daysWithoutExercise: number },
  day: { family: boolean; exercise: boolean; sleptH: number; money: number; days: number },
  cfg: WellbeingConfig = CAREER_CONFIG.wellbeing,
): void {
  const c = cfg.neglect;
  const shortfall = Math.max(0, c.sleepNeedH - day.sleptH);
  const surplus = Math.max(0, day.sleptH - c.sleepNeedH);
  w.sleepDebtH = clampDebt(w.sleepDebtH + shortfall - surplus);

  if (day.family) {
    n.daysWithoutFamily = 0;
  } else {
    n.daysWithoutFamily++;
    w.family = clamp01(w.family - c.familyPerDay * n.daysWithoutFamily);
  }
  if (w.family < c.familyStressBelow) w.stress = clamp01(w.stress + c.familyStress);

  if (day.exercise) {
    n.daysWithoutExercise = 0;
  } else {
    n.daysWithoutExercise++;
    if (n.daysWithoutExercise > c.exerciseGraceDays) w.fitness = clamp01(w.fitness - c.fitnessPerDay);
  }

  if (day.money < 0) w.stress = clamp01(w.stress + c.debtStress);
  w.health = clamp01(w.health + c.healthRecoveryPerDay * day.days);
}

/**
 * Allocation-free performance penalties written into `out`:
 * `aimSpread = 1 + aimFatigue * max(0, fatigue - 0.5) + aimStress * max(0, stress - 0.5)`,
 * `steerLagS = lagMaxS * max(0, fatigue - lagFrom) / (1 - lagFrom)`, `vignette = max(0, fatigue - vignetteFrom) / (1 - vignetteFrom)`.
 */
export function performanceMods(w: Readonly<Wellbeing>, out: PerformanceMods, cfg: WellbeingConfig = CAREER_CONFIG.wellbeing): PerformanceMods {
  const p = cfg.performance;
  out.aimSpread = 1 + p.aimFatigue * Math.max(0, w.fatigue - 0.5) + p.aimStress * Math.max(0, w.stress - 0.5);
  out.steerLagS = (p.lagMaxS * Math.max(0, w.fatigue - p.lagFrom)) / (1 - p.lagFrom);
  out.vignette = Math.max(0, w.fatigue - p.vignetteFrom) / (1 - p.vignetteFrom);
  return out;
}

/** Health at least `fit.minHealth` and stress below `fit.maxStress`; otherwise the reason text. */
export function fitForDuty(w: Readonly<Wellbeing>, cfg: WellbeingConfig = CAREER_CONFIG.wellbeing): { ok: boolean; reason: string } {
  if (w.health < cfg.fit.minHealth) return { ok: false, reason: 'Injured: light duty' };
  if (w.stress >= cfg.fit.maxStress) return { ok: false, reason: 'Critical stress: mandatory leave' };
  return { ok: true, reason: '' };
}
