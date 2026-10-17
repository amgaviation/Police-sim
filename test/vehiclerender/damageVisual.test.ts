import { describe, expect, it } from 'vitest';
import { damageTransform, MAX_CRUMPLE, MAX_TINT, type DamageTransform } from '../../src/render/vehicles/damageVisual';

function fresh(): DamageTransform {
  return { scaleX: NaN, scaleZ: NaN, offsetX: NaN, offsetZ: NaN, tint: NaN };
}

describe('damageTransform', () => {
  it('is the identity with no damage', () => {
    const out = damageTransform(0, 0, 0, 0, fresh(), 5, 2);
    expect(out).toEqual({ scaleX: 1, scaleZ: 1, offsetX: 0, offsetZ: 0, tint: 0 });
  });

  it('crumples the hit end by up to MAX_CRUMPLE and moves the centre away from it', () => {
    const out = damageTransform(1, 0, 0, 0, fresh(), 5, 2);
    expect(out.scaleZ * 5).toBeCloseTo(5 - MAX_CRUMPLE, 9);
    expect(out.offsetZ).toBeCloseTo(MAX_CRUMPLE / 2, 9); // front is -Z, so the centre moves to +Z
    expect(out.scaleX).toBe(1);
    // The rear face stays put: centre + half length is unchanged.
    expect(out.offsetZ + (out.scaleZ * 5) / 2).toBeCloseTo(2.5, 9);
    const left = damageTransform(0, 0, 1, 0, fresh(), 5, 2);
    expect(left.offsetX).toBeCloseTo(MAX_CRUMPLE / 2, 9);
    expect(left.scaleX * 2).toBeCloseTo(2 - MAX_CRUMPLE, 9);
  });

  it('is monotonic in every zone and bounded', () => {
    const steps = [0, 0.1, 0.3, 0.5, 0.8, 1, 1.5];
    for (let zone = 0; zone < 4; zone++) {
      let prev: DamageTransform | null = null;
      for (const v of steps) {
        const z = [0.2, 0.2, 0.2, 0.2];
        z[zone] = v;
        const out = damageTransform(z[0] ?? 0, z[1] ?? 0, z[2] ?? 0, z[3] ?? 0, fresh(), 4.5, 1.8);
        expect(out.tint).toBeGreaterThanOrEqual(0);
        expect(out.tint).toBeLessThanOrEqual(MAX_TINT);
        expect(out.scaleX).toBeGreaterThan(0.5 - 1e-9);
        expect(out.scaleZ).toBeGreaterThan(0.5 - 1e-9);
        expect(Math.abs(out.offsetX)).toBeLessThanOrEqual(MAX_CRUMPLE / 2 + 1e-9);
        expect(Math.abs(out.offsetZ)).toBeLessThanOrEqual(MAX_CRUMPLE / 2 + 1e-9);
        if (prev) {
          expect(out.tint).toBeGreaterThanOrEqual(prev.tint);
          if (zone < 2) expect(out.scaleZ).toBeLessThanOrEqual(prev.scaleZ);
          else expect(out.scaleX).toBeLessThanOrEqual(prev.scaleX);
          if (zone === 0) expect(out.offsetZ).toBeGreaterThanOrEqual(prev.offsetZ);
          if (zone === 1) expect(out.offsetZ).toBeLessThanOrEqual(prev.offsetZ);
          if (zone === 2) expect(out.offsetX).toBeGreaterThanOrEqual(prev.offsetX);
          if (zone === 3) expect(out.offsetX).toBeLessThanOrEqual(prev.offsetX);
        }
        prev = out;
      }
    }
    expect(damageTransform(1, 1, 1, 1, fresh(), 4.5, 1.8).tint).toBeCloseTo(MAX_TINT, 9);
    expect(damageTransform(-1, Number.NaN, 0, 0, fresh(), 4.5, 1.8).tint).toBe(0);
  });
});
