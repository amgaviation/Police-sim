import { describe, expect, it } from 'vitest';
import {
  ABS_HIGH,
  ABS_LOW,
  LOCKED_GRIP,
  absModulate,
  brakeEfficiency,
  updateBrakeTemp,
  type AbsResult,
} from '../../src/vehicles/brakes';
import { fuelBurnLiters } from '../../src/vehicles/fuel';
import { vehicleModel } from '../../src/vehicles/model';

const brakes = vehicleModel('patrol_sedan').brakes;
const fuel = vehicleModel('patrol_sedan').fuel;

describe('absModulate', () => {
  const out: AbsResult = { brake: 0, locked: false };

  it('passes demand through below the grip limit', () => {
    expect(absModulate(40, 100, true, 0, out)).toEqual({ brake: 40, locked: false });
    expect(absModulate(40, 100, false, 0, out)).toEqual({ brake: 40, locked: false });
  });

  it('with ABS holds the brake just under the limit and pulses it at ~12 Hz without locking', () => {
    const samples: number[] = [];
    for (let i = 0; i < 60; i++) {
      absModulate(300, 100, true, i / 600, out);
      expect(out.locked).toBe(false);
      samples.push(out.brake);
    }
    expect(Math.min(...samples)).toBeGreaterThanOrEqual(100 * ABS_LOW - 1e-9);
    expect(Math.max(...samples)).toBeLessThanOrEqual(100 * ABS_HIGH + 1e-9);
    expect(Math.max(...samples) - Math.min(...samples)).toBeGreaterThan(5);
    // One period is 1/12 s.
    expect(absModulate(300, 100, true, 0.02, out).brake).toBeCloseTo(absModulate(300, 100, true, 0.02 + 1 / 12, out).brake, 9);
  });

  it('without ABS the wheel locks and only slides at LOCKED_GRIP of the limit', () => {
    expect(absModulate(300, 100, false, 0, out)).toEqual({ brake: 100 * LOCKED_GRIP, locked: true });
    expect(LOCKED_GRIP).toBeLessThan(ABS_LOW);
  });
});

describe('brake temperature', () => {
  it('heats with braking energy and cools toward ambient, faster with airflow', () => {
    const hot = updateBrakeTemp(20, 1000, 0, 20, 1 / 60, brakes);
    expect(hot).toBeCloseTo(20 + 1000 * brakes.heatPerKJ, 0);
    let still = 400;
    let moving = 400;
    for (let i = 0; i < 600; i++) {
      still = updateBrakeTemp(still, 0, 0, 20, 1 / 60, brakes);
      moving = updateBrakeTemp(moving, 0, 30, 20, 1 / 60, brakes);
    }
    expect(still).toBeLessThan(400);
    expect(moving).toBeLessThan(still);
    expect(moving).toBeGreaterThan(20);
    expect(updateBrakeTemp(20, 0, 30, 20, 1 / 60, brakes)).toBe(20);
  });

  it('efficiency is 1 below fadeStart, linear to minEfficiency at fadeEnd, flat beyond', () => {
    expect(brakeEfficiency(20, brakes)).toBe(1);
    expect(brakeEfficiency(brakes.fadeStartC, brakes)).toBe(1);
    const mid = (brakes.fadeStartC + brakes.fadeEndC) / 2;
    expect(brakeEfficiency(mid, brakes)).toBeCloseTo((1 + brakes.minEfficiency) / 2, 10);
    expect(brakeEfficiency(brakes.fadeEndC, brakes)).toBe(brakes.minEfficiency);
    expect(brakeEfficiency(2000, brakes)).toBe(brakes.minEfficiency);
  });
});

describe('fuelBurnLiters', () => {
  it('burns idleLph at idle and adds litersPerKWh under load', () => {
    expect(fuelBurnLiters(0, 3600, fuel)).toBeCloseTo(fuel.idleLph, 10);
    expect(fuelBurnLiters(-50, 3600, fuel)).toBeCloseTo(fuel.idleLph, 10);
    expect(fuelBurnLiters(100, 3600, fuel)).toBeCloseTo(fuel.idleLph + 100 * fuel.litersPerKWh, 10);
    expect(fuelBurnLiters(100, 1 / 60, fuel)).toBeCloseTo((fuel.idleLph + 100 * fuel.litersPerKWh) / 216000, 12);
  });
});
