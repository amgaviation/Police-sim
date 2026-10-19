/** Stance: crouch toggle, held lean, eye offset (design §7.2). Pure. */
import type { TacticsConfig } from './data';

export interface StanceState {
  crouched: boolean;
  lean: -1 | 0 | 1;
  /** Smoothed lean, -1 (left) .. 1 (right). */
  leanAmount: number;
}

export function createStance(): StanceState {
  return { crouched: false, lean: 0, leanAmount: 0 };
}

/** Moves `leanAmount` towards `lean` at `leanRate` per second without overshooting. */
export function stepLean(state: StanceState, dt: number, cfg: TacticsConfig): void {
  const target = state.lean;
  const step = cfg.stance.leanRate * dt;
  const diff = target - state.leanAmount;
  state.leanAmount = Math.abs(diff) <= step ? target : state.leanAmount + (diff > 0 ? step : -step);
}

/** Movement speed multiplier: crouched `crouchSpeed`, leaning `leanSpeedFactor`; both multiply. Sprint is not considered (callers pass sprint false while crouched). */
export function speedFactor(state: StanceState, cfg: TacticsConfig): number {
  return (state.crouched ? cfg.stance.crouchSpeed : 1) * (state.lean !== 0 ? cfg.stance.leanSpeedFactor : 1);
}

/**
 * Eye offset from the feet: lateral (right vector x leanAmount x leanOffset), y (crouch or stand eye height) and roll
 * (-leanAmount x leanRoll: leaning right rolls the view clockwise). Right is (cos yaw, -sin yaw) (yaw 0 faces -Z).
 */
export function eyeOffset(state: StanceState, yaw: number, cfg: TacticsConfig, out: { x: number; y: number; z: number; roll: number }): void {
  const side = state.leanAmount * cfg.stance.leanOffset;
  out.x = Math.cos(yaw) * side;
  out.z = 0 - Math.sin(yaw) * side;
  out.y = state.crouched ? cfg.stance.crouchEye : cfg.stance.standEye;
  out.roll = 0 - state.leanAmount * cfg.stance.leanRoll;
}
