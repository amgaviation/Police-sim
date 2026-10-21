import { describe, expect, it } from 'vitest';
import { runInspection } from '../../src/fleet/inspection';
import type { InspectionInput } from '../../src/fleet/inspection';
import type { DamageIncident, FleetUnitView, LedgerEntry, Quote } from '../../src/fleet/types';
import {
  formatMoney,
  formatPercent,
  formatPoints,
  garagePanelModel,
  garagePanelPick,
  incidentZone,
  inspectionPanelModel,
  inspectionPanelPick,
  reportRowLabel,
  servicePanelModel,
  servicePanelPick,
  shiftSummaryModel,
  shiftSummaryPick,
  toggleExpanded,
  unitDetail,
  type GarageContext,
  type ServiceQuotes,
} from '../../src/ui/fleet';

function unit(over: Partial<FleetUnitView> = {}): FleetUnitView {
  return {
    id: 'P-101', number: '101', modelId: 'patrol_sedan', label: 'Patrol sedan', cls: 'patrol', liveryId: 'patrolMarked',
    spawned: false, assigned: false, fuel: 0.8, oil: 0.9, tread: 0.7, damage: 0, status: 'ready', ...over,
  };
}

function incident(over: Partial<DamageIncident> = {}): DamageIncident {
  return {
    id: 7, unitId: 'P-101', shift: 1, startSim: 10, lastSim: 11, game: 50500, zoneDelta: [0.3, 0, 0.05, 0], engineDelta: 0, newFlats: 0,
    engineFailed: false, maxImpact: 34 / 3.6, pursuit: false, emergency: false, callId: -1, closed: true, cost: 1200, wreck: false,
    reported: false, charged: false, ...over,
  };
}

const ctx = (over: Partial<GarageContext> = {}): GarageContext => ({ atStation: true, driving: null, nearUnit: null, ...over });
const units = [unit(), unit({ id: 'P-102', label: 'Patrol SUV', modelId: 'patrol_suv', spawned: true }), unit({ id: 'M-601', label: 'Police motorcycle', status: 'damaged' })];

describe('format helpers', () => {
  it('formats money with thousands spaces and points with a sign', () => {
    expect(formatMoney(46)).toBe('$ 46');
    expect(formatMoney(2640)).toBe('$ 2 640');
    expect(formatMoney(3126.4)).toBe('$ 3 126');
    expect(formatMoney(1234567)).toBe('$ 1 234 567');
    expect(formatMoney(0)).toBe('$ 0');
    expect(formatMoney(-500)).toBe('-$ 500');
    expect(formatMoney(Number.NaN)).toBe('$ 0');
    expect(formatPoints(-12)).toBe('-12');
    expect(formatPoints(0)).toBe('0');
    expect(formatPercent(0.8)).toBe('80 %');
  });
});

describe('garage panel', () => {
  it('lists one row per unit with its status', () => {
    const m = garagePanelModel(units, ctx());
    expect(m.title).toBe('Fleet');
    expect(m.subtitle).toBe('City Police · yard');
    expect(m.options).toHaveLength(4);
    expect(m.options[3]).toMatchObject({ label: 'End shift' });
    expect(garagePanelPick(3, units, ctx())).toEqual({ kind: 'finish' });
    expect(m.options[0]).toMatchObject({ label: 'P-101 Patrol sedan', detail: 'READY · fuel 80 % · in yard', enabled: true });
    expect(m.options[1]?.detail).toBe('OUT · fuel 80 %');
    expect(m.options[2]?.detail).toBe('DAMAGED · fuel 80 % · in yard');
  });

  it('marks the unit the officer drives', () => {
    expect(unitDetail(units[1] as FleetUnitView, 'P-102')).toBe('OUT (you)');
    expect(garagePanelModel(units, ctx({ driving: 'P-102' })).options[1]?.detail).toBe('OUT (you)');
    expect(unitDetail(unit({ spawned: true, status: 'damaged' }), null)).toBe('OUT · DAMAGED · fuel 80 %');
    expect(unitDetail(unit({ status: 'service' }), null)).toBe('SERVICE DUE · fuel 80 % · in yard');
  });

  it('a unit pick selects the unit; the same unit again closes its rows', () => {
    expect(garagePanelPick(0, units, ctx())).toEqual({ kind: 'select', unitId: 'P-101' });
    expect(garagePanelPick(2, units, ctx())).toEqual({ kind: 'select', unitId: 'M-601' });
    expect(toggleExpanded(null, 'P-101')).toBe('P-101');
    expect(toggleExpanded('P-101', 'P-101')).toBeNull();
    expect(toggleExpanded('P-101', 'P-102')).toBe('P-102');
    expect(toggleExpanded(undefined, 'P-102')).toBe('P-102');
  });

  it('opens the action rows under an unselected-out unit: only Check out is possible', () => {
    const c = ctx({ expanded: 'P-101' });
    const m = garagePanelModel(units, c);
    expect(m.options.map((o) => o.label)).toEqual([
      'P-101 Patrol sedan', '› Check out', '› Return', '› Customize…', '› Service…', '› Inspect', 'P-102 Patrol SUV', 'M-601 Police motorcycle', 'End shift',
    ]);
    expect(m.options.slice(1, 6).map((o) => o.enabled)).toEqual([true, false, false, false, false]);
    expect(garagePanelPick(1, units, c)).toEqual({ kind: 'checkout', unitId: 'P-101' });
    expect(garagePanelPick(2, units, c)).toEqual({ kind: 'checkin', unitId: 'P-101' });
    expect(garagePanelPick(3, units, c)).toEqual({ kind: 'customize', unitId: 'P-101' });
    expect(garagePanelPick(4, units, c)).toEqual({ kind: 'service', unitId: 'P-101' });
    expect(garagePanelPick(5, units, c)).toEqual({ kind: 'inspect', unitId: 'P-101' });
  });

  it('a spawned unit next to the officer can be returned, customised, serviced and inspected', () => {
    const c = ctx({ expanded: 'P-102', nearUnit: 'P-102' });
    const m = garagePanelModel(units, c);
    // rows: P-101, P-102, then its five actions
    expect(m.options.slice(2, 7).map((o) => o.enabled)).toEqual([false, true, true, true, true]);
    const far = garagePanelModel(units, ctx({ expanded: 'P-102' }));
    expect(far.options.slice(2, 7).map((o) => o.enabled)).toEqual([false, false, false, true, false]);
    const driving = garagePanelModel(units, ctx({ expanded: 'P-102', driving: 'P-102' }));
    expect(driving.options.slice(2, 7).map((o) => o.enabled)).toEqual([false, true, true, true, true]);
  });

  it('Service needs the unit in the yard', () => {
    const c = ctx({ expanded: 'P-102', nearUnit: 'P-102', inYard: () => false });
    const service = garagePanelModel(units, c).options[5];
    expect(service).toMatchObject({ label: '› Service…', detail: 'Bring it to the yard', enabled: false });
    expect(garagePanelModel(units, ctx({ expanded: 'P-102', inYard: (id) => id === 'P-102' })).options[5]?.enabled).toBe(true);
  });

  it('away from the station the units are read-only and unreported damage can be filed', () => {
    const c = ctx({ atStation: false, expanded: 'P-101', incidents: [incident(), incident({ id: 8, reported: true })] });
    const m = garagePanelModel(units, c);
    expect(m.subtitle).toContain('away');
    expect(m.options.slice(0, 3).every((o) => o.enabled === false)).toBe(true);
    expect(m.options).toHaveLength(4);
    expect(m.options[3]).toMatchObject({ label: 'File damage report: P-101 front, 34 km/h', detail: '$ 1 200' });
    expect(garagePanelPick(3, units, c)).toEqual({ kind: 'report', incidentId: 7 });
    expect(garagePanelPick(99, units, c)).toBeNull();
  });

  it('handles an empty fleet', () => {
    const m = garagePanelModel([], ctx());
    expect(m.options.map((o) => o.label)).toEqual(['End shift']);
    expect(garagePanelPick(1, [], ctx())).toBeNull();
    expect(garagePanelModel([], ctx({ atStation: false })).options).toEqual([]);
  });
});

describe('damage report rows', () => {
  it('names the worst zone and the impact in km/h', () => {
    expect(incidentZone({ zoneDelta: [0, 0.2, 0.5, 0.1] })).toBe('left');
    expect(incidentZone({ zoneDelta: [0, 0, 0, 0] })).toBe('front');
    expect(incidentZone({ zoneDelta: [0, 0, 0, 0.4] })).toBe('right');
    expect(reportRowLabel(incident({ zoneDelta: [0, 0.6, 0, 0], maxImpact: 10 }))).toBe('File damage report: P-101 rear, 36 km/h');
  });
});

describe('service panel', () => {
  const quote = (total: number, label = 'Fuel 12 L'): Quote => ({ total, lines: total > 0 ? [{ kind: 'fuel', label, cost: total }] : [] });
  const quotes = (over: Partial<ServiceQuotes> = {}): ServiceQuotes => ({
    refuel: quote(46), oil: quote(80, 'Oil change'), tires: quote(360, 'Tyres x4'), repair: quote(2640, 'Body'), all: quote(3126, 'Everything'), ...over,
  });

  it('prices every service in its label', () => {
    const m = servicePanelModel(unit({ spawned: true }), quotes());
    expect(m.title).toBe('Service P-101');
    expect(m.subtitle).toContain('Patrol sedan');
    expect(m.options.map((o) => o.label)).toEqual([
      'Refuel ($ 46)', 'Oil change ($ 80)', 'Replace tyres ($ 360)', 'Repair ($ 2 640)', 'Everything ($ 3 126)', 'Back',
    ]);
    expect(m.options.map((o) => o.enabled)).toEqual([true, true, true, true, true, undefined]);
    expect(m.options[0]?.detail).toBe('Fuel 12 L');
  });

  it('disables a service whose quote is 0 or missing', () => {
    const m = servicePanelModel(unit(), quotes({ refuel: quote(0), oil: null, all: quote(0) }));
    expect(m.options[0]).toMatchObject({ label: 'Refuel ($ 0)', enabled: false, detail: 'Nothing to do' });
    expect(m.options[1]).toMatchObject({ enabled: false, detail: 'No quote' });
    expect(m.options[4]?.enabled).toBe(false);
    expect(m.options[2]?.enabled).toBe(true);
  });

  it('picks the service request for the unit, then back', () => {
    const u = unit({ id: 'K-501' });
    expect(servicePanelPick(0, u)).toEqual({ kind: 'request', request: { kind: 'service', unitId: 'K-501', service: 'refuel' } });
    expect(servicePanelPick(2, u)).toEqual({ kind: 'request', request: { kind: 'service', unitId: 'K-501', service: 'tires' } });
    expect(servicePanelPick(4, u)).toEqual({ kind: 'request', request: { kind: 'service', unitId: 'K-501', service: 'all' } });
    expect(servicePanelPick(5, u)).toEqual({ kind: 'back' });
    expect(servicePanelPick(6, u)).toBeNull();
    expect(servicePanelPick(-1, u)).toBeNull();
  });
});

describe('inspection panel', () => {
  const input = (over: Partial<InspectionInput['condition']> = {}, rest: Partial<InspectionInput> = {}): InspectionInput => ({
    condition: {
      modelId: 'patrol_sedan', fuelFraction: 0.8, fuelL: 40, oilFraction: 0.9, tread: [0.25, 0.9, 0.9, 0.9], flats: [false, false, false, false],
      zones: [0, 0, 0, 0], engineHealth: 1, engineFailed: false, odometerKm: 10, ...over,
    },
    faults: 0, unreportedIncidents: 0, loadoutMissing: [], hasRack: true, rackSecured: true, hasCage: true, cageEmpty: true, ...rest,
  });
  // Tread 25 % on the first wheel fails; wheels are named FL FR RL RR, so make the worst wheel the rear left.
  const failing = runInspection(input({ tread: [0.9, 0.9, 0.25, 0.9] }));
  const passing = runInspection(input());

  it('shows a tick or a cross with the detail and the fix per check', () => {
    const m = inspectionPanelModel(failing, [], 'P-101');
    expect(m.title).toBe('Inspection P-101');
    expect(m.subtitle).toBe(`${String(failing.passed)}/${String(failing.rows.length)} checks passed`);
    expect(m.options[0]).toMatchObject({ label: '✓ Fuel at least a quarter tank', enabled: false });
    const tread = m.options.find((o) => o.label === '✗ Tyre tread');
    expect(tread).toMatchObject({ detail: 'Tread 25 % (RL) · fix: tires', enabled: true });
    expect(m.options.at(-3)?.label).toBe('Re-inspect');
    expect(m.options.at(-2)).toMatchObject({ label: 'End shift', enabled: true });
    expect(m.options.at(-1)?.label).toBe('Back');
  });

  it('a failed row with a fix runs that service; a passing row does nothing', () => {
    const treadIndex = failing.rows.findIndex((r) => r.id === 'tread');
    expect(inspectionPanelPick(treadIndex, failing, [], 'P-101')).toEqual({ kind: 'request', request: { kind: 'service', unitId: 'P-101', service: 'tires' } });
    expect(inspectionPanelPick(0, failing, [], 'P-101')).toBeNull();
    const bodyIndex = failing.rows.findIndex((r) => r.id === 'body');
    expect(inspectionPanelPick(bodyIndex, failing, [], 'P-101')).toBeNull();
  });

  it('lists unreported incidents of this unit as report rows', () => {
    const incidents = [incident(), incident({ id: 9, unitId: 'P-102' }), incident({ id: 10, reported: true })];
    const m = inspectionPanelModel(passing, incidents, 'P-101');
    const rows = passing.rows.length;
    expect(m.options[rows]?.label).toBe('File damage report: P-101 front, 34 km/h');
    expect(m.options).toHaveLength(rows + 1 + 3);
    expect(inspectionPanelPick(rows, passing, incidents, 'P-101')).toEqual({ kind: 'report', incidentId: 7 });
  });

  it('re-inspects, ends the shift only at the station and goes back', () => {
    const rows = passing.rows.length;
    expect(inspectionPanelPick(rows, passing, [], 'P-101')).toEqual({ kind: 'inspect', unitId: 'P-101' });
    expect(inspectionPanelPick(rows + 1, passing, [], 'P-101')).toEqual({ kind: 'endShift' });
    expect(inspectionPanelPick(rows + 2, passing, [], 'P-101')).toEqual({ kind: 'back' });
    expect(inspectionPanelPick(rows + 3, passing, [], 'P-101')).toBeNull();
    const away = inspectionPanelModel(passing, [], 'P-101', false);
    expect(away.options[rows + 1]).toMatchObject({ label: 'End shift', enabled: false });
  });

  it('works before the first inspection', () => {
    const m = inspectionPanelModel(null, [], 'P-101');
    expect(m.subtitle).toBe('Not inspected yet');
    expect(m.options.map((o) => o.label)).toEqual(['No inspection yet', 'Run inspection', 'End shift', 'Back']);
    expect(inspectionPanelPick(1, null, [], 'P-101')).toEqual({ kind: 'inspect', unitId: 'P-101' });
    expect(inspectionPanelPick(0, null, [], 'P-101')).toBeNull();
  });
});

describe('shift summary', () => {
  const entry = (seq: number, over: Partial<LedgerEntry> = {}): LedgerEntry => ({ seq, game: 50000 + seq * 60, unitId: 'P-101', kind: 'charge', cost: 1200, points: -3, note: 'front damage', ...over });

  it('shows the totals, the newest charges and a Close row', () => {
    const charges = [entry(1), entry(2, { unitId: 'P-102', cost: 400, points: -1 }), entry(3, { kind: 'fuel', cost: 50, points: 0 })];
    const m = shiftSummaryModel({ points: -4, departmentCost: 3126, incidents: 2, unreported: 1 }, charges);
    expect(m.title).toBe('Shift summary');
    expect(m.options.slice(0, 4).map((o) => [o.label, o.detail])).toEqual([
      ['Career points', '-4'], ['Department cost', '$ 3 126'], ['Damage incidents', '2'], ['Unreported damage', '1 · file a report'],
    ]);
    expect(m.options[4]).toMatchObject({ label: 'P-102 front damage', detail: '$ 400 · -1 pts' });
    expect(m.options[5]?.label).toBe('P-101 front damage');
    expect(m.options.at(-1)?.label).toBe('Close');
    expect(m.options.slice(0, -1).every((o) => o.enabled === false)).toBe(true);
    expect(shiftSummaryPick(6, charges)).toEqual({ kind: 'back' });
    expect(shiftSummaryPick(0, charges)).toBeNull();
  });

  it('caps the charge list and works without charges', () => {
    const many = Array.from({ length: 9 }, (_, i) => entry(i + 1));
    expect(shiftSummaryModel({ points: 0, departmentCost: 0, incidents: 0, unreported: 0 }, many).options).toHaveLength(4 + 5 + 1);
    const empty = shiftSummaryModel({ points: 0, departmentCost: 0, incidents: 0, unreported: 0 }, []);
    expect(empty.options).toHaveLength(5);
    expect(empty.options[3]?.detail).toBe('0');
    expect(shiftSummaryPick(4, [])).toEqual({ kind: 'back' });
  });
});
