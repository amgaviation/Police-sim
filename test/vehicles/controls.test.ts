import { describe, expect, it } from 'vitest';
import { mapDriverInput, type DriverControls, type DriverInput } from '../../src/vehicles/controls';

function map(input: Partial<DriverInput>, speed: number, reversing: boolean, groundSpeed = Math.abs(speed)): DriverControls {
  const out: DriverControls = { throttle: -1, brake: -1, steer: -1, handbrake: false, reverse: false };
  return mapDriverInput({ accelerate: 0, brake: 0, steer: 0, handbrake: false, ...input }, speed, groundSpeed, reversing, out);
}

describe('mapDriverInput', () => {
  it('drives forward and brakes while moving', () => {
    expect(map({ accelerate: 0.7, steer: 0.4 }, 0, false)).toEqual({ throttle: 0.7, brake: 0, steer: 0.4, handbrake: false, reverse: false, lift: 0 });
    expect(map({ brake: 1 }, 12, false)).toMatchObject({ throttle: 0, brake: 1, reverse: false });
  });

  it('engages reverse when the brake is held while stopped; the brake pedal is then the throttle', () => {
    expect(map({ brake: 0.8 }, 0.3, false)).toMatchObject({ throttle: 0.8, brake: 0, reverse: true });
    expect(map({ brake: 0.8 }, -2, true)).toMatchObject({ throttle: 0.8, brake: 0, reverse: true });
    expect(map({}, -1, true)).toMatchObject({ throttle: 0, brake: 0, reverse: true });
    // Not while still rolling forward, nor with both pedals pressed.
    expect(map({ brake: 0.8 }, 3, false)).toMatchObject({ brake: 0.8, reverse: false });
    expect(map({ brake: 0.8, accelerate: 0.2 }, 0, false)).toMatchObject({ throttle: 0.2, brake: 0.8, reverse: false });
  });

  it('brake while rolling backwards in forward gear brakes (reverse engages only once stopped)', () => {
    expect(map({ brake: 1 }, -4, false)).toMatchObject({ throttle: 0, brake: 1, reverse: false });
    expect(map({ brake: 1 }, -0.3, false)).toMatchObject({ throttle: 1, brake: 0, reverse: true });
  });

  it('brake while sliding sideways or spinning brakes (zero forward speed is not a standstill)', () => {
    expect(map({ brake: 1 }, 0, false, 15)).toMatchObject({ throttle: 0, brake: 1, reverse: false });
    expect(map({ brake: 1 }, 0.2, false, 8)).toMatchObject({ throttle: 0, brake: 1, reverse: false });
    expect(map({ brake: 1 }, 0.2, false, 0.3)).toMatchObject({ throttle: 1, brake: 0, reverse: true });
  });

  it('accelerate while rolling backwards brakes first, then drives forward once stopped', () => {
    expect(map({ accelerate: 1 }, -4, true)).toMatchObject({ throttle: 0, brake: 1, reverse: true });
    expect(map({ accelerate: 1 }, -0.2, true)).toMatchObject({ throttle: 1, brake: 0, reverse: false });
  });

  it('clamps inputs and passes the handbrake through', () => {
    expect(map({ accelerate: 3, steer: -7, handbrake: true }, 5, false)).toEqual({
      throttle: 1,
      brake: 0,
      steer: -1,
      handbrake: true,
      reverse: false,
      lift: 0,
    });
    expect(map({ steer: Number.NaN }, 0, false).steer).toBe(0);
  });

  it('copies the clamped aircraft lift (absent or NaN = 0)', () => {
    expect(map({ lift: 0.4 }, 0, false).lift).toBe(0.4);
    expect(map({ lift: -3 }, 0, false).lift).toBe(-1);
    expect(map({ lift: 7 }, 0, false).lift).toBe(1);
    expect(map({}, 0, false).lift).toBe(0);
    expect(map({ lift: Number.NaN }, 0, false).lift).toBe(0);
  });
});
