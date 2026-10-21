import type { InputManager } from '../input/input';

/** Raw driver input: pedals 0..1, steer -1 (left) .. +1 (right). Same shape as the vehicles module's. */
export interface DriverInput {
  accelerate: number;
  brake: number;
  steer: number;
  handbrake: boolean;
  /** Aircraft climb (+) / descend (-), -1..1. */
  lift?: number;
}

/** Reads the driving actions into `out` (vehicles' `mapDriverInput` adds automatic reverse). */
export function readDriverInput(input: Pick<InputManager, 'axis' | 'isDown'>, out: DriverInput): DriverInput {
  out.accelerate = Math.max(0, input.axis('vehicle.accelerate'));
  out.brake = Math.max(0, input.axis('vehicle.brake'));
  out.steer = input.axis('vehicle.steer');
  out.handbrake = input.isDown('vehicle.handbrake');
  out.lift = input.axis('vehicle.lift');
  return out;
}
