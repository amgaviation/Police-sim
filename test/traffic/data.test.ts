import { describe, expect, it } from 'vitest';
import densityJson from '../../src/data/traffic/density.json';
import pulloverJson from '../../src/data/traffic/pullover.json';
import registryJson from '../../src/data/traffic/registry.json';
import violationsJson from '../../src/data/traffic/violations.json';
import {
  DENSITY,
  PULLOVER,
  REGISTRY,
  VIOLATIONS,
  validateDensity,
  validatePullover,
  validateRegistry,
  validateViolations,
} from '../../src/traffic/data';
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

  it('loads pullover.json (design §4.3) and names the file and field on errors', () => {
    expect(PULLOVER.detect).toEqual({ minDistance: 3, maxDistance: 35, lateral: 2.5, headingDot: 0.8, delayS: 1.5, minPatrolSpeed: 2, closingTol: 0.5 });
    expect(PULLOVER.curb).toEqual({ clearance: 0.15, lateralSpeed: 0.9, decel: 2, noPullNearLineM: 30, approachSpeed: 9, hazards: true });
    expect(PULLOVER.release).toEqual({ lateralSpeed: 0.7, autoReleaseM: 150 });
    expect(PULLOVER.yield).toEqual({ range: 50, lateral: 6, passMargin: 10, timeoutS: 20 });
    expect(PULLOVER.fleet.maxCars).toBe(32);
    expect(PULLOVER.fleet.maxEmergencySpeed).toBe(30);
    expect(PULLOVER.spikes).toEqual({ speedFactor: [1, 0.75, 0.5, 0.35, 0.25], stopAfterS: 12, minTires: 2 });
    expect(PULLOVER.spin).toEqual({ durationS: 1.4, yawDeg: 150, slideDecel: 9 });
    expect(PULLOVER.blockade).toEqual({ lookaheadM: 40, waitS: 20, noSpawnM: 80, max: 16 });
    expect(PULLOVER.pit).toEqual({ crashOnRamMps: 11 });
    const p = clone(pulloverJson) as Record<string, unknown> & { curb: Record<string, unknown>; fleet: Record<string, unknown> };
    p.curb.hazards = 1;
    expect(() => validatePullover(p)).toThrow(/pullover\.json: curb\.hazards/);
    const q = clone(pulloverJson) as Record<string, unknown> & { fleet: Record<string, unknown> };
    q.fleet.maxCars = 2.5;
    expect(() => validatePullover(q)).toThrow(/pullover\.json: fleet\.maxCars/);
    const r = clone(pulloverJson) as Record<string, unknown> & { detect: Record<string, unknown> };
    r.detect.minDistance = 50;
    expect(() => validatePullover(r)).toThrow(/pullover\.json: detect\.minDistance/);
    const v = clone(pulloverJson) as Record<string, unknown>;
    delete v.yield;
    expect(() => validatePullover(v)).toThrow(/pullover\.json: yield/);
    // The Phase 6 sections are required and checked with their path.
    for (const key of ['spikes', 'spin', 'blockade', 'pit']) {
      const w = clone(pulloverJson) as Record<string, unknown>;
      delete w[key];
      expect(() => validatePullover(w)).toThrow(new RegExp(`pullover\\.json: ${key}`));
    }
    const sp = clone(pulloverJson) as Record<string, unknown> & { spikes: { speedFactor: number[]; minTires: number } };
    sp.spikes.speedFactor = [1, 0.5];
    expect(() => validatePullover(sp)).toThrow(/pullover\.json: spikes\.speedFactor/);
    sp.spikes.speedFactor = [1, 0.5, 0.75, 0.3, 0.2];
    expect(() => validatePullover(sp)).toThrow(/pullover\.json: spikes\.speedFactor\[2\]/);
    const bl = clone(pulloverJson) as Record<string, unknown> & { blockade: Record<string, unknown>; spin: Record<string, unknown> };
    bl.blockade.max = 1.5;
    expect(() => validatePullover(bl)).toThrow(/pullover\.json: blockade\.max/);
    bl.blockade.max = 16;
    bl.spin.durationS = 0;
    expect(() => validatePullover(bl)).toThrow(/pullover\.json: spin\.durationS/);
  });
});
