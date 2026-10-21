import { describe, expect, it } from 'vitest';
import { INSPECTION_ITEMS, runInspection, type InspectionInput } from '../../src/fleet';
import { condition } from './helpers';

function input(over: Partial<InspectionInput> = {}): InspectionInput {
  return {
    condition: condition(), faults: 0, unreportedIncidents: 0, loadoutMissing: [], hasRack: true, rackSecured: true, hasCage: true,
    cageEmpty: true, ...over,
  };
}

function row(result: ReturnType<typeof runInspection>, id: string) {
  const r = result.rows.find((x) => x.id === id);
  if (r === undefined) throw new Error(`no row ${id}`);
  return r;
}

describe('runInspection', () => {
  it('a clean vehicle passes every row', () => {
    const r = runInspection(input());
    expect(r.rows).toHaveLength(INSPECTION_ITEMS.length);
    expect(r.rows.every((x) => x.pass)).toBe(true);
    expect(r.passed).toBe(10);
    expect(r.failed).toEqual([]);
  });

  it('rows carry the item label and fix', () => {
    const r = runInspection(input());
    expect(row(r, 'fuel').label).toBe('Fuel at least a quarter tank');
    expect(row(r, 'fuel').fix).toBe('refuel');
    expect(row(r, 'body').fix).toBeNull();
    expect(row(r, 'fuel').detail).toBe('Fuel 100 %');
  });

  it('fuel, oil and tread fail below their thresholds with the listed details', () => {
    const r = runInspection(input({ condition: condition({ fuelFraction: 0.18, oilFraction: 0.22, tread: [0.8, 0.9, 0.25, 0.7] }) }));
    expect(row(r, 'fuel')).toMatchObject({ pass: false, detail: 'Fuel 18 %' });
    expect(row(r, 'oil')).toMatchObject({ pass: false, detail: 'Oil 22 %' });
    expect(row(r, 'tread')).toMatchObject({ pass: false, detail: 'Tread 25 % (RL)', fix: 'tires' });
    expect(r.failed).toEqual(['fuel', 'oil', 'tread']);
    expect(r.passed).toBe(7);
  });

  it('thresholds are inclusive', () => {
    const r = runInspection(input({ condition: condition({ fuelFraction: 0.25, oilFraction: 0.3, tread: [0.3, 1, 1, 1], engineHealth: 0.6 }) }));
    expect(r.failed).toEqual([]);
  });

  it('flats list the wheels', () => {
    const r = runInspection(input({ condition: condition({ flats: [true, false, false, true] }) }));
    expect(row(r, 'flats')).toMatchObject({ pass: false, detail: 'Flat: FL, RR', fix: 'tires' });
  });

  it('the engine warning shows the health, or failed', () => {
    expect(row(runInspection(input({ condition: condition({ engineHealth: 0.54 }) })), 'engine')).toMatchObject({ pass: false, detail: 'Engine 54 %', fix: 'repair' });
    expect(row(runInspection(input({ condition: condition({ engineHealth: 0.9, engineFailed: true }) })), 'engine')).toMatchObject({ pass: false, detail: 'Engine failed' });
  });

  it('unreported damage, faults and missing equipment', () => {
    const r = runInspection(input({ unreportedIncidents: 2, faults: 1, loadoutMissing: ['flares x2', 'aed'] }));
    expect(row(r, 'body')).toMatchObject({ pass: false, detail: '2 unreported' });
    expect(row(r, 'lamps')).toMatchObject({ pass: false, detail: '1 fault' });
    expect(row(r, 'equipment')).toMatchObject({ pass: false, detail: 'Missing: flares x2, aed' });
    expect(runInspection(input({ faults: 3 })).rows.find((x) => x.id === 'lamps')?.detail).toBe('3 faults');
  });

  it('an unlocked rack and a prisoner aboard fail', () => {
    const r = runInspection(input({ rackSecured: false, cageEmpty: false }));
    expect(row(r, 'longGuns')).toMatchObject({ pass: false, applicable: true, detail: 'Rack unlocked' });
    expect(row(r, 'cage')).toMatchObject({ pass: false, applicable: true, detail: 'Prisoner aboard' });
  });

  it('rows that do not apply pass with n/a', () => {
    const r = runInspection(input({ hasRack: false, rackSecured: false, hasCage: false, cageEmpty: false }));
    expect(row(r, 'longGuns')).toMatchObject({ pass: true, applicable: false, detail: 'n/a' });
    expect(row(r, 'cage')).toMatchObject({ pass: true, applicable: false, detail: 'n/a' });
    expect(r.failed).toEqual([]);
  });

  it('runs a custom item list', () => {
    const r = runInspection(input({ condition: condition({ fuelFraction: 0.5 }) }), [{ id: 'half', label: 'Half tank', check: 'fuelMin', value: 0.75 }]);
    expect(r.rows).toHaveLength(1);
    expect(r.failed).toEqual(['half']);
    expect(r.passed).toBe(0);
  });
});
