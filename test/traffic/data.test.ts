import { describe, expect, it } from 'vitest';
import densityJson from '../../src/data/traffic/density.json';
import registryJson from '../../src/data/traffic/registry.json';
import violationsJson from '../../src/data/traffic/violations.json';
import { DENSITY, REGISTRY, VIOLATIONS, validateDensity, validateRegistry, validateViolations } from '../../src/traffic/data';
import { DISTRICT } from '../../src/world/roadGraph';

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe('traffic data', () => {
  it('loads the shipped files', () => {
    expect(DENSITY.capacity).toBe(192);
    expect(DENSITY.district[DISTRICT.downtown]).toBe(1.4);
    expect(DENSITY.district[DISTRICT.water]).toBe(0);
    expect(DENSITY.hourMultiplier).toHaveLength(24);
    expect(REGISTRY.population).toBe(60000);
    expect(VIOLATIONS.behaviors.dui.hourMultiplier).toHaveLength(24);
    expect(VIOLATIONS.observeRadius).toBe(150);
  });

  it('names the file and field on errors', () => {
    const v = clone(violationsJson) as Record<string, unknown> & { behaviors: { speeding: { speedFactor: number[] } } };
    v.behaviors.speeding.speedFactor = [1.5, 1.2];
    expect(() => validateViolations(v)).toThrow(/violations\.json: behaviors\.speeding\.speedFactor/);
    const d = clone(densityJson) as Record<string, unknown> & { district: Record<string, number> };
    d.district.nowhere = 1;
    expect(() => validateDensity(d)).toThrow(/density\.json: district\.nowhere/);
    const d2 = clone(densityJson) as Record<string, unknown>;
    d2.hourMultiplier = [1, 2];
    expect(() => validateDensity(d2)).toThrow(/density\.json: hourMultiplier/);
    const r = clone(registryJson) as Record<string, unknown>;
    r.version = 2;
    expect(() => validateRegistry(r)).toThrow(/registry\.json: version/);
    r.version = 1;
    r.population = 1.5;
    expect(() => validateRegistry(r)).toThrow(/registry\.json: population/);
  });
});
