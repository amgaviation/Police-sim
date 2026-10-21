import { describe, expect, it } from 'vitest';
import { DEFAULT_WEAR, type WearSpec } from '../../src/vehicles/model';
import { createWearState, stepWear, treadGrip, type WearInputs } from '../../src/vehicles/wear';

const spec: WearSpec = { ...DEFAULT_WEAR };
const inputs = (over: Partial<WearInputs> = {}): WearInputs => ({
  engineKw: 0,
  dt: 1,
  distanceM: 0,
  running: true,
  slipping: new Uint8Array(4),
  ...over,
});

describe('createWearState', () => {
  it('starts with full oil, new tyres and a zero odometer', () => {
    const s = createWearState(spec);
    expect(s.oilL).toBe(6);
    expect(Array.from(s.tread)).toEqual([1, 1, 1, 1]);
    expect(s.odometerM).toBe(0);
  });
});

describe('stepWear', () => {
  it('burns oil by kWh x oilPerKWh while running', () => {
    const s = createWearState(spec);
    // 100 kW for 36 s = 1 kWh.
    for (let i = 0; i < 36; i++) stepWear(s, spec, inputs({ engineKw: 100 }));
    expect(s.oilL).toBeCloseTo(6 - 1 * spec.oilPerKWh, 9);
    const idle = createWearState(spec);
    stepWear(idle, spec, inputs({ engineKw: 100, running: false }));
    expect(idle.oilL).toBe(6);
  });

  it('never lets the oil go below zero', () => {
    const s = createWearState({ ...spec, oilL: 0.001 });
    stepWear(s, { ...spec, oilL: 0.001 }, inputs({ engineKw: 1e6, dt: 10 }));
    expect(s.oilL).toBe(0);
  });

  it('wears tread with distance, and faster on a slipping wheel', () => {
    const s = createWearState(spec);
    const slipping = new Uint8Array([0, 1, 0, 0]);
    stepWear(s, spec, inputs({ distanceM: 2000, dt: 2, slipping }));
    const rolled = 2 * spec.treadPerKm;
    expect(s.tread[0]).toBeCloseTo(1 - rolled, 6);
    expect(s.tread[2]).toBeCloseTo(1 - rolled, 6);
    expect(s.tread[1]).toBeCloseTo(1 - rolled - spec.treadSlipPerS * 2, 6);
    expect(s.odometerM).toBe(2000);
    expect(s.tread[1] ?? 1).toBeLessThan(s.tread[0] ?? 0);
  });

  it('clamps tread at 0 and accumulates the odometer', () => {
    const s = createWearState(spec);
    stepWear(s, spec, inputs({ distanceM: 1e9 }));
    expect(Array.from(s.tread)).toEqual([0, 0, 0, 0]);
    stepWear(s, spec, inputs({ distanceM: 5 }));
    expect(s.odometerM).toBe(1e9 + 5);
  });

  it('does not lose slow wear to the float32 grid, and honours a direct write to the tread', () => {
    const s = createWearState(spec);
    // 1 m/s for 10 minutes: 0.0167 m a step loses ~2.5e-8, below half a float32 step near 1.
    for (let n = 0; n < 36000; n++) stepWear(s, spec, inputs({ dt: 1 / 60, distanceM: 1 / 60 }));
    expect(s.odometerM).toBeCloseTo(600, 6);
    expect(1 - (s.tread[0] ?? 1)).toBeCloseTo(0.6 * spec.treadPerKm, 6);
    s.tread[1] = 0.5;
    stepWear(s, spec, inputs({ distanceM: 1000 }));
    expect(s.tread[1]).toBeCloseTo(0.5 - spec.treadPerKm, 6);
    const bare = { oilL: 1, tread: new Float32Array([1, 1, 1, 1]), odometerM: 0 };
    stepWear(bare, spec, inputs({ distanceM: 1000 }));
    expect(bare.tread[0]).toBeCloseTo(1 - spec.treadPerKm, 6);
  });

  it('returns engine wear only with empty oil and a running engine', () => {
    const s = createWearState(spec);
    expect(stepWear(s, spec, inputs({ engineKw: 50, dt: 0.5 }))).toBe(0);
    s.oilL = 0;
    expect(stepWear(s, spec, inputs({ dt: 0.5 }))).toBeCloseTo(spec.oilWearPerS * 0.5, 12);
    expect(stepWear(s, spec, inputs({ dt: 0.5, running: false }))).toBe(0);
  });

  it('empties the oil exactly on the step where the engine starts to wear', () => {
    const s = createWearState({ ...spec, oilL: 0.0001 });
    const sp = { ...spec, oilL: 0.0001 };
    // 0.0001 L / 0.004 L per kWh = 0.025 kWh = 90 kW for 1 s.
    expect(stepWear(s, sp, inputs({ engineKw: 90 }))).toBeGreaterThan(0);
    expect(s.oilL).toBe(0);
  });
});

describe('treadGrip', () => {
  it('is exactly 1 for a new tyre in any weather', () => {
    expect(treadGrip(1, 0, spec)).toBe(1);
    expect(treadGrip(1, 1, spec)).toBe(1);
    expect(treadGrip(1, 1, { ...spec, minTreadGrip: 0.123456789 })).toBe(1);
  });

  it('is minTreadGrip for a dry bald tyre and lower when wet', () => {
    expect(treadGrip(0, 0, spec)).toBe(spec.minTreadGrip);
    expect(treadGrip(0, 1, spec)).toBeCloseTo(spec.minTreadGrip - spec.wetTreadPenalty, 12);
    expect(treadGrip(0, 1, spec)).toBeLessThan(treadGrip(0, 0, spec));
    expect(treadGrip(0.5, 0, spec)).toBeCloseTo((spec.minTreadGrip + 1) / 2, 12);
  });

  it('wet worn tyres lose proportionally to the wetness and stay in [0.3, 1]', () => {
    expect(treadGrip(0, 0.5, spec)).toBeCloseTo(spec.minTreadGrip - spec.wetTreadPenalty / 2, 12);
    const harsh: WearSpec = { ...spec, minTreadGrip: 0.1, wetTreadPenalty: 1 };
    expect(treadGrip(0, 1, harsh)).toBe(0.3);
    expect(treadGrip(2, 0, spec)).toBe(1);
    expect(treadGrip(-1, 0, spec)).toBe(spec.minTreadGrip);
    expect(treadGrip(0.5, 5, spec)).toBe(treadGrip(0.5, 1, spec));
  });
});
