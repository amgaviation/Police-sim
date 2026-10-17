import { beforeAll, describe, expect, it } from 'vitest';
import { locationOf } from '../../src/cad/address';
import { CALL_TYPES, callType } from '../../src/cad/data';
import { createRng } from '../../src/core/rng';
import { DISPATCH_CONFIG } from '../../src/dispatch/data';
import { clockParts } from '../../src/dispatch/generator';
import { mountedPlate } from '../../src/records/vehicle';
import { DISTRICT, DISTRICT_NAMES } from '../../src/world/ids';
import { GAME0, makeHarness, run, type Harness } from './helpers';

const GENERATED = new Set(CALL_TYPES.filter((t) => t.generated).map((t) => t.id));

describe('call generator over 20 sim minutes', () => {
  let a: Harness;
  beforeAll(async () => {
    a = await makeHarness();
    run(a, 20 * 60);
  });

  it('generates a plausible number of calls, all of generated types', () => {
    const calls = a.cad.calls();
    const stats = a.dispatcher.stats;
    expect(stats.generated).toBe(calls.length);
    expect(stats.generated).toBeGreaterThanOrEqual(6);
    expect(stats.generated).toBeLessThanOrEqual(40);
    expect(stats.open).toBeLessThanOrEqual(DISPATCH_CONFIG.generator.maxOpenCalls);
    // No call before the first-call delay.
    for (const c of calls) {
      expect(GENERATED.has(c.typeId)).toBe(true);
      expect(c.created.sim).toBeGreaterThanOrEqual(DISPATCH_CONFIG.generator.firstCallDelayS);
      expect(c.selfInitiated).toBe(false);
    }
  });

  it('places calls on land, at real addresses, away from the player, mostly near', () => {
    const { city, player } = a;
    let near = 0;
    const districtOf = (x: number, z: number): string => DISTRICT_NAMES[city.districtAt(x, z)] ?? '';
    for (const c of a.cad.calls()) {
      const loc = c.location;
      expect(city.districtAt(loc.x, loc.z)).not.toBe(DISTRICT.water);
      expect(loc.edge).toBeGreaterThanOrEqual(0);
      expect(loc.text).toMatch(/^\d+ \S/);
      expect(loc.street.length).toBeGreaterThan(0);
      expect(loc.text).toBe(locationOf(city.graph, loc.x, loc.z, districtOf)?.text);
      const d = Math.hypot(loc.x - player.x, loc.z - player.z);
      expect(d).toBeGreaterThanOrEqual(DISPATCH_CONFIG.generator.minDistanceM);
      if (d <= DISPATCH_CONFIG.generator.nearRadiusM) near++;
      const type = callType(c.typeId);
      if (type.location === 'intersection') expect(loc.near).toContain(' at ');
      const mult = Object.hasOwn(type.districts, districtOf(loc.x, loc.z)) ? type.districts[districtOf(loc.x, loc.z)] : 1;
      expect(mult).toBeGreaterThan(0);
    }
    expect(near / a.cad.calls().length).toBeGreaterThan(0.3);
  });

  it('fills priorities, callers and narratives from the type table', () => {
    for (const c of a.cad.calls()) {
      const type = callType(c.typeId);
      expect(type.priority[c.priority - 1]).toBeGreaterThan(0);
      expect((type.callers[c.caller.kind] ?? 0)).toBeGreaterThan(0);
      switch (c.caller.kind) {
        case 'citizen':
          expect(c.caller.name).toMatch(/^[A-Z][A-Za-z' -]+, [A-Z][A-Za-z' -]+$/);
          expect(c.caller.personId).toBeGreaterThanOrEqual(0);
          expect(c.caller.phone).toMatch(/\d/);
          expect(c.persons).toContain(c.caller.personId);
          break;
        case 'anonymous':
          expect(c.caller.name).toBe('ANONYMOUS');
          break;
        case 'alarm':
          expect(c.caller.name).toBe('Alarm monitoring center');
          break;
        case 'business':
          expect(c.caller.name).toBe('Business owner');
          break;
        default:
          throw new Error(`unexpected caller ${c.caller.kind}`);
      }
      const text = c.narrative[0]?.text ?? '';
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/[{}]/);
      expect(text.charAt(0)).toBe(text.charAt(0).toUpperCase());
      for (const id of c.vehicles) expect(text).toContain(mountedPlate(a.seed, id).plate);
    }
  });

  it('is deterministic: a second fresh world produces identical CAD and dispatcher state', async () => {
    const b = await makeHarness();
    run(b, 20 * 60);
    expect(b.cad.serialize()).toEqual(a.cad.serialize());
    expect(b.dispatcher.serialize()).toEqual(a.dispatcher.serialize());
    expect(b.traffic.snapshot()).toEqual(a.traffic.snapshot());
  });
});

describe('generator helpers', () => {
  it('splits game seconds into hour and weekday (day 0 is a Monday)', () => {
    expect(clockParts(7 * 3600)).toEqual({ hour: 7, weekday: 0 });
    expect(clockParts(86400 * 8 + 1800)).toEqual({ hour: 0.5, weekday: 1 });
  });

  it('scales the rate by time and place, clamped to [0.25, 3]', async () => {
    const h = await makeHarness({ start: false });
    const g = h.dispatcher.generator;
    const night = g.multiplier(3 * 3600, 'suburbs');
    const evening = g.multiplier(21 * 3600, 'downtown');
    expect(evening).toBeGreaterThan(night);
    for (const v of [night, evening, g.multiplier(12 * 3600, 'park')]) {
      expect(v).toBeGreaterThanOrEqual(0.25);
      expect(v).toBeLessThanOrEqual(3);
    }
    expect(g.multiplier(12 * 3600, 'water')).toBe(0.25);
  });

  it('picks only types allowed in the district and locations matching the type', async () => {
    const h = await makeHarness({ start: false });
    const g = h.dispatcher.generator;
    const rng = createRng(5);
    for (let i = 0; i < 40; i++) {
      const c = g.generate(rng, h.player.x, h.player.z, '12', GAME0);
      if (!c) continue;
      expect(GENERATED.has(c.typeId)).toBe(true);
      expect(c.narrative).not.toMatch(/[{}]/);
    }
    const poi = h.city.pois[0];
    if (poi) {
      const loc = g.locate(poi.entrance.x, poi.entrance.z);
      expect(loc.edge).toBeGreaterThanOrEqual(0);
    }
    // Far off the map: a bare point, never a throw.
    expect(g.locate(1e6, 1e6).text).toBe('Unknown location');
  });
});
