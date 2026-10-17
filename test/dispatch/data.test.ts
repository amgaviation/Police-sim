import { describe, expect, it } from 'vitest';
import dispatchJson from '../../src/data/dispatch/dispatch.json';
import unitsJson from '../../src/data/dispatch/units.json';
import { DISPATCH_CONFIG, UNITS_DATA, validateDispatchConfig, validateUnits } from '../../src/dispatch/data';
import { vehicleModel } from '../../src/vehicles/model';

function clone<T>(x: T): T {
  return structuredClone(x);
}

describe('dispatch data', () => {
  it('loads the roster: player 12 on downtown, six AI units on patrol models over four beats', () => {
    expect(UNITS_DATA.player).toEqual({ callsign: '12', officer: 'Officer Doe', beat: 'downtown' });
    expect(UNITS_DATA.units).toHaveLength(6);
    const beats = new Set(UNITS_DATA.units.map((u) => u.beat));
    for (const b of ['downtown', 'suburbs', 'industrial', 'highway']) expect(beats.has(b)).toBe(true);
    for (const u of UNITS_DATA.units) {
      expect(['patrol_sedan', 'patrol_suv']).toContain(u.model);
      expect(vehicleModel(u.model).equipment).not.toBeNull();
      expect(u.officer).toMatch(/^Officer [A-Z][a-z]+$/);
    }
    expect(new Set(UNITS_DATA.units.map((u) => u.callsign)).size).toBe(6);
  });

  it('loads the dispatcher tuning from dispatch.json', () => {
    expect(DISPATCH_CONFIG.generator.meanIntervalS).toBe(75);
    expect(DISPATCH_CONFIG.offer).toEqual({ radiusM: 2500, timeoutS: 25 });
    expect(DISPATCH_CONFIG.aiUnits.breakS).toEqual([300, 600]);
    expect(DISPATCH_CONFIG.backup.releaseS).toBe(30);
    expect(DISPATCH_CONFIG.avlIntervalS).toBe(0.5);
  });

  it('rejects bad rosters naming the file and field', () => {
    const dup = clone(unitsJson);
    dup.units[1] = { ...dup.units[1]!, callsign: '12' };
    expect(() => validateUnits(dup)).toThrow('units.json: units[1].callsign duplicates callsign "12"');
    const model = clone(unitsJson);
    model.units[0] = { ...model.units[0]!, model: 'sedan_compact' };
    expect(() => validateUnits(model)).toThrow(/units\.json: units\[0\]\.model must be/);
    const beat = clone(unitsJson);
    beat.units[2] = { ...beat.units[2]!, beat: 'water' };
    expect(() => validateUnits(beat)).toThrow(/units\.json: units\[2\]\.beat must be a land district/);
    expect(() => validateUnits({ ...clone(unitsJson), version: 2 })).toThrow('units.json: version must be 1');
    expect(() => validateUnits({ ...clone(unitsJson), extra: 1 })).toThrow(/units\.json: extra is not one of/);
  });

  it('rejects bad tuning naming the file and field', () => {
    const neg = clone(dispatchJson);
    neg.generator.meanIntervalS = -1;
    expect(() => validateDispatchConfig(neg)).toThrow(/dispatch\.json: generator\.meanIntervalS must be in/);
    const share = clone(dispatchJson);
    share.generator.nearPlayerShare = 1.5;
    expect(() => validateDispatchConfig(share)).toThrow(/dispatch\.json: generator\.nearPlayerShare/);
    const brk = clone(dispatchJson);
    brk.aiUnits.breakS = [600, 300];
    expect(() => validateDispatchConfig(brk)).toThrow(/dispatch\.json: aiUnits\.breakS must be \[min, max\]/);
    const units = clone(dispatchJson);
    units.statusCheck.attempts = 1.5;
    expect(() => validateDispatchConfig(units)).toThrow(/dispatch\.json: statusCheck\.attempts must be an integer/);
    const missing = clone(dispatchJson) as Record<string, unknown>;
    delete missing.offer;
    expect(() => validateDispatchConfig(missing)).toThrow(/dispatch\.json: offer must be an object/);
  });
});
