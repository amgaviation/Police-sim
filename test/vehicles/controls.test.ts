import { describe, expect, it } from 'vitest';
import { mapDriverInput, type DriverControls, type DriverInput } from '../../src/vehicles/controls';

function map(input: Partial<DriverInput>, speed: number, reversing: boolean): DriverControls {
  const out: DriverControls = { throttle: -1, brake: -1, steer: -1, handbrake: false, reverse: false };
  return mapDriverInput({ accelerate: 0, brake: 0, steer: 0, handbrake: false, ...input }, speed, reversing, out);
}

describe('mapDriverInput', () => {
  it('drives forward and brakes while moving', () => {
    expect(map({ accelerate: 0.7, steer: 0.4 }, 0, false)).toEqual({ throttle: 0.7, brake: 0, steer: 0.4, handbrake: false, reverse: false });
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
    });
    expect(map({ steer: Number.NaN }, 0, false).steer).toBe(0);
  });
});
