import type { BrakeSpec } from './model';

/** ABS pulse frequency (Hz) and the band of the grip limit it modulates within. */
export const ABS_HZ = 12;
export const ABS_LOW = 0.88;
export const ABS_HIGH = 0.98;
/** Sliding (locked-wheel) friction as a fraction of the peak grip limit. */
export const LOCKED_GRIP = 0.75;

export interface AbsResult {
  /** Brake actually transmitted to the road, same unit as `demand`/`limit`. */
  brake: number;
  /** Wheel is locked (sliding): it keeps little side grip. */
  locked: boolean;
}

/**
 * A wheel locks when the demanded brake exceeds what its grip can carry (`limit`). With ABS the brake
 * is instead held just under the limit and pulsed at `ABS_HZ` (a triangle wave between `ABS_LOW` and
 * `ABS_HIGH` of the limit), so the wheel keeps rolling and steering. Without ABS the locked wheel slides
 * and transmits only `LOCKED_GRIP` of the limit.
 */
export function absModulate(demand: number, limit: number, absEnabled: boolean, timeS: number, out: AbsResult): AbsResult {
  if (demand <= limit) {
    out.brake = demand;
    out.locked = false;
  } else if (absEnabled) {
    const phase = (timeS * ABS_HZ) % 1;
    const tri = phase < 0.5 ? phase * 2 : 2 - phase * 2;
    out.brake = limit * (ABS_LOW + (ABS_HIGH - ABS_LOW) * tri);
    out.locked = false;
  } else {
    out.brake = limit * LOCKED_GRIP;
    out.locked = true;
  }
  return out;
}

/**
 * Axle brake temperature after one step: heats by `energyKJ x heatPerKJ`, then cools toward ambient at
 * `coolingPerS + airflowCooling x speed` per second (Newtonian cooling).
 */
export function updateBrakeTemp(
  tempC: number,
  energyKJ: number,
  speed: number,
  ambientC: number,
  dt: number,
  brakes: BrakeSpec,
): number {
  const heated = tempC + energyKJ * brakes.heatPerKJ;
  const k = (brakes.coolingPerS + brakes.airflowCooling * Math.abs(speed)) * dt;
  return heated - (heated - ambientC) * (k < 1 ? k : 1);
}

/** 1 below `fadeStartC`, falling linearly to `minEfficiency` at `fadeEndC` and beyond. */
export function brakeEfficiency(tempC: number, brakes: BrakeSpec): number {
  if (tempC <= brakes.fadeStartC) return 1;
  if (tempC >= brakes.fadeEndC) return brakes.minEfficiency;
  const t = (tempC - brakes.fadeStartC) / (brakes.fadeEndC - brakes.fadeStartC);
  return 1 + (brakes.minEfficiency - 1) * t;
}
