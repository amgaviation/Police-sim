/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- tests mutate loosely typed raw JSON */
import { describe, expect, it } from 'vitest';
import fleetJson from '../../src/data/fleet/fleet.json';
import inspectionJson from '../../src/data/fleet/inspection.json';
import maintenanceJson from '../../src/data/fleet/maintenance.json';
import {
  FLEET_CLASSES, FLEET_DATA, INSPECTION_ITEMS, MAINTENANCE, parseFleet, parseInspection, parseMaintenance, unitNumber,
} from '../../src/fleet';

function clone<T>(x: T): T {
  return structuredClone(x);
}

describe('fleet.json', () => {
  it('lists the 17 units of the design', () => {
    expect(FLEET_DATA.units.map((u) => u.id)).toEqual([
      'P-101', 'P-102', 'S-201', 'U-301', 'T-401', 'K-501', 'M-601', 'B-651', 'A-671', 'X-701', 'X-711', 'J-801', 'C-901', 'L-951',
      'MAR-1', 'AIR-2', 'D-1',
    ]);
    expect(FLEET_DATA.startParked).toEqual(['P-101', 'P-102']);
    expect(FLEET_DATA.startHome).toEqual(['MAR-1', 'AIR-2']);
    expect(FLEET_DATA.garageSlot).toBe(2);
    const homes = Object.fromEntries(FLEET_DATA.units.map((u) => [u.id, u.home]));
    expect(homes['MAR-1']).toBe('boatSlip');
    expect(homes['AIR-2']).toBe('helipad');
    expect(homes['D-1']).toBe('carried');
    expect(homes['P-101']).toBe('lot');
    expect(FLEET_DATA.units.find((u) => u.id === 'D-1')?.trunk).toBeNull();
  });

  it('uses every fleet class once', () => {
    expect(FLEET_DATA.units.map((u) => u.cls).sort()).toEqual([...FLEET_CLASSES, 'patrol'].sort());
  });

  it('unitNumber is the part after the dash', () => {
    expect(unitNumber('P-101')).toBe('101');
    expect(unitNumber('MAR-1')).toBe('1');
  });

  it('rejects bad unit ids, duplicates and unknown references', () => {
    const base = fleetJson as unknown as { units: Record<string, unknown>[]; startParked: string[]; startHome: string[]; garageSlot: number };
    const bad = (mutate: (j: typeof base) => void): (() => void) => () => {
      const j = clone(base);
      mutate(j);
      parseFleet(j, 'fleet.json');
    };
    expect(() => parseFleet(clone(base), 'fleet.json')).not.toThrow();
    expect(bad((j) => { j.units[0]!.id = 'p-101'; })).toThrow(/units\[0\]\.id/);
    expect(bad((j) => { j.units[1]!.id = 'P-101'; })).toThrow(/duplicates "P-101"/);
    expect(bad((j) => { j.units[0]!.model = 'nope'; })).toThrow(/units\[0\]\.model/);
    expect(bad((j) => { j.units[0]!.class = 'ghost'; })).toThrow(/units\[0\]\.class/);
    expect(bad((j) => { j.units[0]!.livery = 'nope'; })).toThrow(/units\[0\]\.livery/);
    expect(bad((j) => { j.units[0]!.trunk = 'nope'; })).toThrow(/units\[0\]\.trunk/);
    expect(bad((j) => { delete j.units[0]!.trunk; })).toThrow(/units\[0\]\.trunk/);
    expect(bad((j) => { j.units[0]!.home = 'garage'; })).toThrow(/units\[0\]\.home/);
    expect(bad((j) => { j.startParked = ['Z-999']; })).toThrow(/startParked\[0\]/);
    expect(bad((j) => { j.startHome = ['MAR-1', 'MAR-1']; })).toThrow(/startHome\[1\]/);
    expect(bad((j) => { j.garageSlot = 6; })).toThrow(/garageSlot/);
    expect(bad((j) => { j.units = []; })).toThrow(/units/);
  });

  it('accepts a null trunk and names the file in errors', () => {
    const j = clone(fleetJson) as unknown as { units: Record<string, unknown>[] };
    j.units[0]!.trunk = null;
    expect(parseFleet(j, 'x.json').units[0]?.trunk).toBeNull();
    j.units[0]!.id = 'bad';
    expect(() => parseFleet(j, 'x.json')).toThrow(/^x\.json: units\[0\]\.id/);
  });
});

describe('maintenance.json', () => {
  it('matches the design prices', () => {
    expect(MAINTENANCE.prices).toEqual({ fuelPerL: 2, oilChange: 80, tire: 180, bodyPerZone: 2400, enginePerHealth: 9000, engineReplace: 14000 });
    expect(MAINTENANCE.incidentMergeS).toBe(5);
    expect(MAINTENANCE.limits).toEqual({ incidents: 100, reports: 50, ledger: 200 });
    expect(MAINTENANCE.charges.maxPointsPerIncident).toBe(20);
    expect(Object.keys(MAINTENANCE.classMultiplier).sort()).toEqual([...FLEET_CLASSES].sort());
    expect(MAINTENANCE.classMultiplier.air).toBe(8);
  });

  it('rejects a missing class, a negative price and bad factors', () => {
    const j = (): Record<string, any> => clone(maintenanceJson) as Record<string, any>;
    expect(() => parseMaintenance(j(), 'm.json')).not.toThrow();
    const a = j();
    delete a.classMultiplier.air;
    expect(() => parseMaintenance(a, 'm.json')).toThrow(/classMultiplier\.air/);
    const b = j();
    b.classMultiplier.ghost = 1;
    expect(() => parseMaintenance(b, 'm.json')).toThrow(/classMultiplier\.ghost/);
    const c = j();
    c.prices.tire = -1;
    expect(() => parseMaintenance(c, 'm.json')).toThrow(/prices\.tire/);
    const d = j();
    d.charges.pursuitFactor = 2;
    expect(() => parseMaintenance(d, 'm.json')).toThrow(/charges\.pursuitFactor/);
    const e = j();
    e.limits.ledger = 0;
    expect(() => parseMaintenance(e, 'm.json')).toThrow(/limits\.ledger/);
    const f = j();
    e.version = 2;
    f.wreck.engineFailed = 'yes';
    expect(() => parseMaintenance(f, 'm.json')).toThrow(/wreck\.engineFailed/);
    expect(() => parseMaintenance(e, 'm.json')).toThrow(/version/);
  });
});

describe('inspection.json', () => {
  it('lists the ten design items', () => {
    expect(INSPECTION_ITEMS.map((i) => i.id)).toEqual(['fuel', 'oil', 'tread', 'flats', 'engine', 'body', 'lamps', 'equipment', 'longGuns', 'cage']);
    expect(INSPECTION_ITEMS[0]).toEqual({ id: 'fuel', label: 'Fuel at least a quarter tank', check: 'fuelMin', value: 0.25, fix: 'refuel' });
    expect(INSPECTION_ITEMS.find((i) => i.id === 'body')?.fix).toBeUndefined();
  });

  it('rejects unknown checks, fixes, duplicate ids and missing thresholds', () => {
    const j = (): { items: Record<string, unknown>[] } => clone(inspectionJson);
    expect(() => parseInspection(j(), 'i.json')).not.toThrow();
    const a = j();
    a.items[0]!.check = 'ghost';
    expect(() => parseInspection(a, 'i.json')).toThrow(/items\[0\]\.check/);
    const b = j();
    b.items[0]!.fix = 'wash';
    expect(() => parseInspection(b, 'i.json')).toThrow(/items\[0\]\.fix/);
    const c = j();
    c.items[1]!.id = 'fuel';
    expect(() => parseInspection(c, 'i.json')).toThrow(/items\[1\]\.id/);
    const d = j();
    delete d.items[0]!.value;
    expect(() => parseInspection(d, 'i.json')).toThrow(/items\[0\]\.value/);
    const e = j();
    e.items[0]!.value = 1.5;
    expect(() => parseInspection(e, 'i.json')).toThrow(/items\[0\]\.value/);
    const f = j();
    f.items[3]!.value = 0.5;
    expect(() => parseInspection(f, 'i.json')).toThrow(/items\[3\]\.value/);
    expect(() => parseInspection({ version: 1, items: [] }, 'i.json')).toThrow(/items/);
  });
});
