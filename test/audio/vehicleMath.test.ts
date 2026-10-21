import { describe, expect, it } from 'vitest';
import { BODY_STYLES, CONTROL_KINDS } from '../../src/vehicles/model';
import { SURFACE } from '../../src/world/ids';
import { ENGINE_PROFILES, VEHICLE_AUDIO } from '../../src/audio/vehicleData';
import {
  crunchLevel,
  engineCutoffHz,
  engineGain,
  engineProfileFor,
  firingHz,
  rpmFromSpeed,
  squealHz,
  squealLevel,
  tireSlip,
} from '../../src/audio/vehicleMath';

const PROFILES = VEHICLE_AUDIO.engine.profiles;
const TIRES = VEHICLE_AUDIO.tires;
const TRAFFIC = VEHICLE_AUDIO.engine.traffic;

describe('engineProfileFor', () => {
  const table: [string, string, string | null][] = [
    ['car', 'sedan', 'car'],
    ['car', 'hatchback', 'car'],
    ['car', 'suv', 'v8'],
    ['car', 'pickup', 'v8'],
    ['car', 'van', 'v8'],
    ['car', 'truck', 'diesel'],
    ['car', 'bus', 'diesel'],
    ['bike', 'motorcycle', 'twin'],
    ['bike', 'bicycle', null],
    ['car', 'atv', 'single'],
    ['bike', 'atv', 'single'],
    ['boat', 'boat', 'outboard'],
    ['helicopter', 'helicopter', 'rotor'],
    ['drone', 'drone', 'drone'],
    // the control kind of a craft wins over any body style
    ['boat', 'sedan', 'outboard'],
    ['helicopter', 'sedan', 'rotor'],
    ['drone', 'sedan', 'drone'],
    // anything else is a car
    ['car', 'hovercraft', 'car'],
    ['', '', 'car'],
    ['car', 'constructor', 'car'],
    ['toString', 'sedan', 'car'],
  ];
  it.each(table)('%s / %s -> %s', (control, style, expected) => {
    expect(engineProfileFor(control, style)).toBe(expected);
  });

  it('maps every control kind and body style the vehicle model offers to a known profile or silence', () => {
    for (const control of CONTROL_KINDS) {
      for (const style of BODY_STYLES) {
        const id = engineProfileFor(control, style);
        if (id !== null) expect(ENGINE_PROFILES).toContain(id);
      }
    }
    expect(engineProfileFor('bike', 'bicycle')).toBeNull();
  });
});

describe('firingHz', () => {
  it('is rpm / 60 * cylinders / 2', () => {
    expect(firingHz(1200, 4)).toBe(40);
    expect(firingHz(6000, 8)).toBe(400);
    expect(firingHz(750, 6)).toBeCloseTo(37.5, 12);
    expect(firingHz(0, 6)).toBe(0);
    expect(firingHz(3000, 1)).toBe(25);
  });
});

describe('engineCutoffHz', () => {
  const car = PROFILES.car;
  it('follows base + perRpm * rpm * (0.3 + 0.7 * throttle)', () => {
    expect(engineCutoffHz(car, 0, 0)).toBe(Math.max(80, car.lowpassBaseHz));
    expect(engineCutoffHz(car, 3000, 0)).toBeCloseTo(car.lowpassBaseHz + car.lowpassPerRpm * 3000 * 0.3, 9);
    expect(engineCutoffHz(car, 3000, 1)).toBeCloseTo(car.lowpassBaseHz + car.lowpassPerRpm * 3000, 9);
    expect(engineCutoffHz(car, 3000, 0.5)).toBeCloseTo(car.lowpassBaseHz + car.lowpassPerRpm * 3000 * 0.65, 9);
  });
  it('is clamped to [80, 12000]', () => {
    expect(engineCutoffHz({ ...car, lowpassBaseHz: 20, lowpassPerRpm: 0 }, 0, 0)).toBe(80);
    expect(engineCutoffHz(PROFILES.drone, 20000, 1)).toBe(12000);
  });
});

describe('engineGain', () => {
  const p = PROFILES.v8;
  it('scales the profile gain between idleGain and 1 with the throttle', () => {
    const idle = VEHICLE_AUDIO.engine.idleGain;
    expect(engineGain(p, idle, 0, true)).toBeCloseTo(p.gain * idle, 12);
    expect(engineGain(p, idle, 1, true)).toBeCloseTo(p.gain, 12);
    expect(engineGain(p, idle, 0.5, true)).toBeCloseTo(p.gain * (idle + (1 - idle) * 0.5), 12);
  });
  it('is 0 when the engine is not running', () => {
    expect(engineGain(p, 0.35, 1, false)).toBe(0);
  });
});

describe('tireSlip', () => {
  const lock = TIRES.lockSpeedMs;
  it('is the lateral velocity when the ground speed exceeds the forward speed', () => {
    expect(tireSlip(8, 10, 0, false, false, lock)).toBeCloseTo(6, 12);
    expect(tireSlip(10, 10, 0, false, false, lock)).toBe(0);
    expect(tireSlip(10, 9, 0, false, false, lock)).toBe(0);
    expect(tireSlip(-8, 10, 0, false, false, lock)).toBeCloseTo(6, 12);
  });
  it('adds the forward speed for locked wheels (handbrake, or hard braking without ABS) above lockSpeedMs', () => {
    expect(tireSlip(10, 10, 0, false, true, lock)).toBe(10);
    expect(tireSlip(10, 10, 0.9, false, false, lock)).toBe(10);
    expect(tireSlip(10, 10, 0.9, true, false, lock)).toBe(0);
    expect(tireSlip(10, 10, 0.8, false, false, lock)).toBe(0);
    expect(tireSlip(lock, lock, 1, false, true, lock)).toBe(0);
    expect(tireSlip(lock + 0.1, lock + 0.1, 0, false, true, lock)).toBeCloseTo(lock + 0.1, 12);
    expect(tireSlip(-10, 10, 0, false, true, lock)).toBe(10);
    expect(tireSlip(6, 10, 0, false, true, lock)).toBeCloseTo(8 + 6, 12);
  });
});

describe('squealLevel', () => {
  it('is smoothstep(slipStart, slipFull, slip) on asphalt and concrete, 0 elsewhere', () => {
    expect(squealLevel(0, SURFACE.asphalt, false, TIRES)).toBe(0);
    expect(squealLevel(TIRES.slipStartMs, SURFACE.asphalt, false, TIRES)).toBe(0);
    expect(squealLevel(TIRES.slipFullMs, SURFACE.asphalt, false, TIRES)).toBe(1);
    expect(squealLevel(100, SURFACE.concrete, false, TIRES)).toBe(1);
    const mid = (TIRES.slipStartMs + TIRES.slipFullMs) / 2;
    expect(squealLevel(mid, SURFACE.asphalt, false, TIRES)).toBeCloseTo(0.5, 12);
    expect(squealLevel(100, SURFACE.gravel, false, TIRES)).toBe(0);
    expect(squealLevel(100, SURFACE.grass, false, TIRES)).toBe(0);
    expect(squealLevel(100, SURFACE.sand, false, TIRES)).toBe(0);
  });
  it('is 0 airborne and for an unknown surface', () => {
    expect(squealLevel(100, SURFACE.asphalt, true, TIRES)).toBe(0);
    expect(squealLevel(100, 99, false, TIRES)).toBe(0);
  });
});

describe('crunchLevel', () => {
  it('is clamp(groundSpeed / 15, 0, 1) * surfaceCrunch * gravelGain', () => {
    expect(crunchLevel(15, SURFACE.gravel, false, TIRES)).toBeCloseTo(TIRES.gravelGain, 12);
    expect(crunchLevel(30, SURFACE.gravel, false, TIRES)).toBeCloseTo(TIRES.gravelGain, 12);
    expect(crunchLevel(7.5, SURFACE.gravel, false, TIRES)).toBeCloseTo(TIRES.gravelGain / 2, 12);
    expect(crunchLevel(15, SURFACE.dirt, false, TIRES)).toBeCloseTo(0.8 * TIRES.gravelGain, 12);
    expect(crunchLevel(15, SURFACE.grass, false, TIRES)).toBeCloseTo(0.4 * TIRES.gravelGain, 12);
    expect(crunchLevel(15, SURFACE.sand, false, TIRES)).toBeCloseTo(0.6 * TIRES.gravelGain, 12);
  });
  it('is 0 on pavement, standing still, airborne', () => {
    expect(crunchLevel(20, SURFACE.asphalt, false, TIRES)).toBe(0);
    expect(crunchLevel(20, SURFACE.concrete, false, TIRES)).toBe(0);
    expect(crunchLevel(0, SURFACE.gravel, false, TIRES)).toBe(0);
    expect(crunchLevel(-5, SURFACE.gravel, false, TIRES)).toBe(0);
    expect(crunchLevel(20, SURFACE.gravel, true, TIRES)).toBe(0);
  });
});

describe('squealHz', () => {
  it('lerps between squealHzMin and squealHzMax up to twice slipFullMs', () => {
    expect(squealHz(0, TIRES)).toBe(TIRES.squealHzMin);
    expect(squealHz(2 * TIRES.slipFullMs, TIRES)).toBe(TIRES.squealHzMax);
    expect(squealHz(100, TIRES)).toBe(TIRES.squealHzMax);
    expect(squealHz(TIRES.slipFullMs, TIRES)).toBeCloseTo((TIRES.squealHzMin + TIRES.squealHzMax) / 2, 9);
    expect(squealHz(-3, TIRES)).toBe(TIRES.squealHzMin);
  });
});

describe('rpmFromSpeed', () => {
  const wheelRpm = (v: number): number => ((Math.abs(v) / TRAFFIC.wheelRadiusM) * 60) / (2 * Math.PI);
  it('idles when stopped and clamps to the redline', () => {
    expect(rpmFromSpeed(0, TRAFFIC)).toBe(TRAFFIC.idleRpm);
    expect(rpmFromSpeed(0.2, TRAFFIC)).toBe(TRAFFIC.idleRpm);
    expect(rpmFromSpeed(500, TRAFFIC)).toBe(TRAFFIC.redlineRpm);
  });
  it('uses gear 1 below the shift floor and the highest gear above it', () => {
    const floor = TRAFFIC.shiftRpm * 0.5;
    const g1 = TRAFFIC.gearRatios[0] ?? 1;
    const top = TRAFFIC.gearRatios[TRAFFIC.gearRatios.length - 1] ?? 1;
    // 5 m/s: gear 1 (every higher gear would be below the floor)
    const slow = 5;
    expect(wheelRpm(slow) * top * TRAFFIC.finalDrive).toBeLessThan(floor);
    expect(rpmFromSpeed(slow, TRAFFIC)).toBeCloseTo(wheelRpm(slow) * g1 * TRAFFIC.finalDrive, 9);
    // 25 m/s: top gear is above the floor and under the redline
    const fast = 25;
    expect(wheelRpm(fast) * top * TRAFFIC.finalDrive).toBeGreaterThanOrEqual(floor);
    expect(rpmFromSpeed(fast, TRAFFIC)).toBeCloseTo(wheelRpm(fast) * top * TRAFFIC.finalDrive, 9);
  });
  it('is symmetric in the sign of the speed and always within [idle, redline]', () => {
    for (let v = -60; v <= 60; v += 1.5) {
      const rpm = rpmFromSpeed(v, TRAFFIC);
      expect(rpm).toBe(rpmFromSpeed(-v, TRAFFIC));
      expect(rpm).toBeGreaterThanOrEqual(TRAFFIC.idleRpm);
      expect(rpm).toBeLessThanOrEqual(TRAFFIC.redlineRpm);
    }
  });
  it('picks the highest gear whose rpm is at or above half the shift rpm (custom ratios)', () => {
    const t = { ...TRAFFIC, gearRatios: [4, 2, 1], finalDrive: 1, wheelRadiusM: 1, shiftRpm: 1000, idleRpm: 100, redlineRpm: 9000 };
    // wheel rpm 600 -> gear 3: 600 >= 500
    const v600 = (600 * 2 * Math.PI) / 60;
    expect(rpmFromSpeed(v600, t)).toBeCloseTo(600, 9);
    // wheel rpm 400 -> gear 3: 400 < 500; gear 2: 800 >= 500
    const v400 = (400 * 2 * Math.PI) / 60;
    expect(rpmFromSpeed(v400, t)).toBeCloseTo(800, 9);
    // wheel rpm 100 -> gear 2: 200 < 500 -> gear 1 (400)
    const v100 = (100 * 2 * Math.PI) / 60;
    expect(rpmFromSpeed(v100, t)).toBeCloseTo(400, 9);
  });
});
