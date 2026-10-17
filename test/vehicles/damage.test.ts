import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import {
  ZONE,
  applyImpact,
  cornerWheel,
  createDamageState,
  impactZone,
  resetDamageState,
  rollStall,
  type ImpactResult,
} from '../../src/vehicles/damage';
import { vehicleModel } from '../../src/vehicles/model';

const params = vehicleModel('patrol_sedan').damage;

function result(): ImpactResult {
  return { zone: ZONE.front, amount: 0, tireBurst: -1, engineFailedNow: false };
}

describe('damage', () => {
  it('picks the zone from the impact direction (-Z = front, +X = right)', () => {
    expect(impactZone(0, -1)).toBe(ZONE.front);
    expect(impactZone(0.3, 1)).toBe(ZONE.rear);
    expect(impactZone(-1, 0.2)).toBe(ZONE.left);
    expect(impactZone(1, -0.5)).toBe(ZONE.right);
    expect(cornerWheel(-0.7, -0.7)).toBe(0);
    expect(cornerWheel(0.7, -0.7)).toBe(1);
    expect(cornerWheel(-0.6, 0.8)).toBe(2);
    expect(cornerWheel(0.8, 0.6)).toBe(3);
    expect(cornerWheel(0, -1)).toBe(-1);
    expect(cornerWheel(1, 0.1)).toBe(-1);
  });

  it('accumulates zone damage by impact speed and ignores impacts below the threshold', () => {
    const state = createDamageState();
    const rng = createRng(1);
    applyImpact(state, 0, 1, params.minImpactSpeed * 0.9, -1, params, rng, result());
    expect(Array.from(state.zones)).toEqual([0, 0, 0, 0]);

    const out = applyImpact(state, 0, 1, 7, -1, params, rng, result());
    expect(out.zone).toBe(ZONE.rear);
    expect(out.amount).toBeGreaterThan((7 / params.zoneStrength) * 0.89);
    expect(out.amount).toBeLessThan((7 / params.zoneStrength) * 1.11);
    expect(state.zones[ZONE.rear]).toBeCloseTo(out.amount, 6);
    expect(state.engineHealth).toBe(1);

    for (let i = 0; i < 10; i++) applyImpact(state, 0, 1, 30, -1, params, rng, result());
    expect(state.zones[ZONE.rear]).toBe(1);
  });

  it('front hits cost engine health; the engine fails once below failBelow', () => {
    const state = createDamageState();
    const rng = createRng(2);
    const first = applyImpact(state, 0, -1, 10, -1, params, rng, result());
    expect(state.engineHealth).toBeCloseTo(1 - first.amount * params.engineFrontShare, 6);
    expect(first.engineFailedNow).toBe(false);
    const fails: boolean[] = [];
    for (let i = 0; i < 4; i++) fails.push(applyImpact(state, 0, -1, 10, -1, params, rng, result()).engineFailedNow);
    expect(state.engineFailed).toBe(true);
    expect(state.engineHealth).toBe(0);
    expect(fails.filter(Boolean)).toHaveLength(1);
  });

  it('bursts a tyre only above tireBurstSpeed next to a wheel, once', () => {
    const state = createDamageState();
    const rng = createRng(3);
    expect(applyImpact(state, -0.7, -0.7, params.tireBurstSpeed - 0.5, 0, params, rng, result()).tireBurst).toBe(-1);
    expect(applyImpact(state, -0.7, -0.7, params.tireBurstSpeed + 0.5, -1, params, rng, result()).tireBurst).toBe(-1);
    expect(applyImpact(state, -0.7, -0.7, params.tireBurstSpeed + 0.5, 0, params, rng, result()).tireBurst).toBe(0);
    expect(applyImpact(state, -0.7, -0.7, params.tireBurstSpeed + 3, 0, params, rng, result()).tireBurst).toBe(-1);
    expect(Array.from(state.tireFlat)).toEqual([1, 0, 0, 0]);
    resetDamageState(state);
    expect(Array.from(state.tireFlat)).toEqual([0, 0, 0, 0]);
    expect(state.engineHealth).toBe(1);
  });

  it('stalls and fails deterministically for a seeded Rng', () => {
    const run = (seed: number): number[] => {
      const state = createDamageState();
      const rng = createRng(seed);
      const log: number[] = [];
      for (let i = 0; i < 2; i++) log.push(applyImpact(state, 0.1, -1, 8, -1, params, rng, result()).amount);
      log.push(state.engineHealth);
      expect(state.engineHealth).toBeLessThan(params.stallBelow);
      expect(state.engineFailed).toBe(false);
      for (let step = 0; step < 60 * 120; step++) {
        const stall = rollStall(state, params, 1 / 60, rng);
        if (stall > 0) log.push(step, stall);
      }
      return log;
    };
    const a = run(7);
    expect(run(7)).toEqual(a);
    expect(run(8)).not.toEqual(a);
    // Health below stallBelow: some stalls of 1-3 s within two minutes.
    const stalls = a.slice(3).filter((_, i) => i % 2 === 1);
    expect(stalls.length).toBeGreaterThan(0);
    for (const s of stalls) {
      expect(s).toBeGreaterThanOrEqual(1);
      expect(s).toBeLessThan(3);
    }
    // A healthy engine never stalls and draws nothing.
    const healthy = createDamageState();
    const rng = createRng(9);
    const before = rng.state();
    for (let i = 0; i < 1000; i++) expect(rollStall(healthy, params, 1, rng)).toBe(0);
    expect(rng.state()).toEqual(before);
  });
});
