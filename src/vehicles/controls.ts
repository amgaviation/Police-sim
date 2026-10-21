/** Raw driver input from the player module: pedals 0..1, steer -1 (left) .. +1 (right). */
export interface DriverInput {
  accelerate: number;
  brake: number;
  steer: number;
  handbrake: boolean;
  /** Aircraft climb (+) / descend (-), -1..1; absent = 0. */
  lift?: number;
}

/** What the vehicle applies: `throttle` drives along the selected direction (backwards when `reverse`). */
export interface DriverControls {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
  reverse: boolean;
  /** Aircraft climb (+) / descend (-), -1..1; absent = 0. */
  lift?: number;
}

/** Below this horizontal ground speed (m/s) the car counts as stopped for selecting reverse. */
export const STOPPED_SPEED = 0.5;

function clamp01(v: number): number {
  return v > 1 ? 1 : v > 0 ? v : 0;
}

/**
 * Automatic forward/reverse selection. Holding the brake while stopped engages reverse and the brake
 * pedal then works as reverse throttle; pressing accelerate while still rolling backwards brakes first,
 * and switches back to forward once stopped. `forwardSpeed` is signed (+ = forwards); `groundSpeed` is the
 * horizontal speed in any direction, so a car sliding sideways or spinning is not taken as stopped.
 */
export function mapDriverInput(
  input: DriverInput,
  forwardSpeed: number,
  groundSpeed: number,
  reversing: boolean,
  out: DriverControls,
): DriverControls {
  const accelerate = clamp01(input.accelerate);
  const brake = clamp01(input.brake);
  out.steer = input.steer > 1 ? 1 : input.steer < -1 ? -1 : input.steer || 0;
  out.handbrake = input.handbrake;
  const lift = input.lift ?? 0;
  out.lift = lift > 1 ? 1 : lift < -1 ? -1 : lift || 0;
  let reverse = reversing;
  if (reverse && accelerate > 0 && forwardSpeed > -STOPPED_SPEED) reverse = false;
  else if (!reverse && brake > 0 && accelerate === 0 && groundSpeed < STOPPED_SPEED) reverse = true;
  out.reverse = reverse;
  if (reverse) {
    // Brake pedal is the reverse throttle; accelerate (while still rolling back) brakes.
    out.throttle = accelerate > 0 ? 0 : brake;
    out.brake = accelerate;
  } else {
    out.throttle = accelerate;
    out.brake = brake;
  }
  return out;
}
