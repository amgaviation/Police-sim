import { describe, expect, it } from 'vitest';
import surfacesJson from '../../src/data/physics/surfaces.json';
import { SURFACE_NAMES, parseSurfaces, surfaceGrip, surfaceRolling } from '../../src/vehicles/surfaces';

const id = (name: (typeof SURFACE_NAMES)[number]): number => SURFACE_NAMES.indexOf(name);

describe('surfaces', () => {
  it('uses the shared id order', () => {
    expect(SURFACE_NAMES).toEqual(['asphalt', 'concrete', 'gravel', 'dirt', 'grass', 'sand']);
    expect(parseSurfaces(surfacesJson)).toHaveLength(6);
  });

  it('orders grip: dry asphalt > wet > snow, loose surfaces below asphalt', () => {
    const asphalt = id('asphalt');
    const dry = surfaceGrip(asphalt, 0, 0);
    const wet = surfaceGrip(asphalt, 1, 0);
    const snow = surfaceGrip(asphalt, 0, 1);
    expect(dry).toBe(1);
    expect(wet).toBeLessThan(dry);
    expect(snow).toBeLessThan(wet);
    expect(surfaceGrip(id('grass'), 0, 0)).toBeLessThan(dry);
    expect(surfaceGrip(id('gravel'), 0, 0)).toBeLessThan(dry);
    expect(surfaceGrip(asphalt, 0.5, 0)).toBeCloseTo((1 + 0.72) / 2, 10);
    expect(surfaceGrip(asphalt, 1, 1)).toBeCloseTo(0.72 * 0.35, 10);
    expect(surfaceRolling(id('grass'))).toBeGreaterThan(surfaceRolling(asphalt));
  });

  it('reads unknown ids as asphalt', () => {
    expect(surfaceGrip(99, 1, 0)).toBe(surfaceGrip(0, 1, 0));
    expect(surfaceGrip(-1, 0, 0)).toBe(1);
    expect(surfaceRolling(42)).toBe(surfaceRolling(0));
  });

  it('rejects missing or unknown surfaces readably', () => {
    const missing = structuredClone(surfacesJson) as { surfaces: Record<string, unknown> };
    delete missing.surfaces.sand;
    expect(() => parseSurfaces(missing)).toThrow(/^surfaces\.json: surfaces\.sand must be an object, got undefined$/);
    const extra = structuredClone(surfacesJson) as { surfaces: Record<string, unknown> };
    extra.surfaces.ice = { grip: 0.1, rolling: 0.01, wet: 1, snow: 1 };
    expect(() => parseSurfaces(extra)).toThrow(/surfaces\.ice is not one of/);
  });
});
