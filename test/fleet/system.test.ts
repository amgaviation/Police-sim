/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- tests mutate loosely typed raw JSON */
import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import {
  FleetSystem, MAINTENANCE, damageCost, emptyFleetSave, isFleetSave, migratedFleetSave, serviceQuote, type DamageIncident,
  type FleetSave,
} from '../../src/fleet';
import { defaultLivery, newLiveryId, type LiveryDoc } from '../../src/livery';
import { vehicleModel } from '../../src/vehicles/model';
import { CHARACTER_LINES, PRONOUN_PRESETS, applyPronouns } from '../../src/uniform/pronouns';
import { FakePort, rig, spawn, storedVehicle, time, topics, type Rig } from './helpers';

const P101 = 'P-101';
const P102 = 'P-102';

/** Damages the fake vehicle and emits the hit like the vehicle module does. */
function hit(r: Rig, port: FakePort, zone: 'front' | 'rear' | 'left' | 'right', add: number, speed: number): void {
  const i = ['front', 'rear', 'left', 'right'].indexOf(zone);
  port.cond.zones[i] = Math.min(1, (port.cond.zones[i] ?? 0) + add);
  r.bus.emit('vehicle:damaged', { eid: port.eid, zone, amount: add, impactSpeed: speed });
}

function incident(r: Rig, id: number): DamageIncident {
  const i = r.fleet.incidents().find((x) => x.id === id);
  if (i === undefined) throw new Error(`no incident ${id}`);
  return i;
}

describe('incidents', () => {
  it('merges hits within 5 s and closes 5 s after the last', () => {
    const r = rig();
    const port = spawn(r, P101, 10);
    hit(r, port, 'front', 0.2, 10);
    r.fleet.step(1 / 60, time(0));
    expect(r.fleet.incidents()).toHaveLength(1);
    expect(topics(r, 'fleet:damage')).toEqual([
      { unitId: P101, incidentId: 1, zone: 'front', amount: 0.2, impactSpeed: 10, pursuit: false, emergency: false },
    ]);
    expect(incident(r, 1).closed).toBe(false);

    hit(r, port, 'front', 0.2, 14);
    r.fleet.step(1 / 60, time(3));
    expect(r.fleet.incidents()).toHaveLength(1);
    expect(topics(r, 'fleet:damage')).toHaveLength(1);
    expect(incident(r, 1)).toMatchObject({ lastSim: 3, startSim: 0, maxImpact: 14 });

    r.fleet.step(1 / 60, time(7.9));
    expect(incident(r, 1).closed).toBe(false);
    expect(topics(r, 'fleet:incident')).toEqual([]);

    r.fleet.step(1 / 60, time(8));
    const inc = incident(r, 1);
    expect(inc.closed).toBe(true);
    expect(inc.zoneDelta[0]).toBeCloseTo(0.4, 6);
    expect(inc.cost).toBe(damageCost(inc.zoneDelta, 0, 0, false, 'patrol'));
    expect(inc.cost).toBe(Math.round(0.4 * 2400));
    expect(inc.wreck).toBe(false);
    expect(topics(r, 'fleet:incident')).toEqual([{ unitId: P101, incidentId: 1, cost: inc.cost, wreck: false }]);
    expect(topics(r, 'fleet:flash')).toEqual([{ text: 'Damage to P-101: file a damage report (fleet panel)' }]);
  });

  it('a later hit opens a new incident measured from the refreshed baseline', () => {
    const r = rig();
    const port = spawn(r, P101, 10);
    hit(r, port, 'front', 0.4, 10);
    r.fleet.step(1 / 60, time(0));
    r.fleet.step(1 / 60, time(5));
    expect(incident(r, 1).closed).toBe(true);
    hit(r, port, 'front', 0.1, 6);
    r.fleet.step(1 / 60, time(20));
    expect(r.fleet.incidents()).toHaveLength(2);
    r.fleet.step(1 / 60, time(25));
    const second = incident(r, 2);
    expect(second.closed).toBe(true);
    expect(second.zoneDelta[0]).toBeCloseTo(0.1, 6);
    expect(second.cost).toBe(240);
    expect(topics(r, 'fleet:damage')).toHaveLength(2);
  });

  it('records the pursuit / emergency context and call when the incident opens', () => {
    const r = rig();
    const port = spawn(r, P101, 10);
    r.context.pursuit = true;
    r.context.callId = 77;
    hit(r, port, 'rear', 0.1, 8);
    r.fleet.step(1 / 60, time(0));
    r.context.pursuit = false;
    r.context.emergency = true;
    expect(incident(r, 1)).toMatchObject({ pursuit: true, emergency: false, callId: 77 });
    expect(topics(r, 'fleet:damage')[0]).toMatchObject({ zone: 'rear', pursuit: true, emergency: false });
  });

  it('ignores hits on vehicles that are not fleet units and after dispose', () => {
    const r = rig();
    const port = spawn(r, P101, 10);
    r.bus.emit('vehicle:damaged', { eid: 99, zone: 'front', amount: 0.5, impactSpeed: 20 });
    r.fleet.step(1 / 60, time(0));
    expect(r.fleet.incidents()).toHaveLength(0);
    r.fleet.dispose();
    hit(r, port, 'front', 0.5, 20);
    r.fleet.step(1 / 60, time(1));
    expect(r.fleet.incidents()).toHaveLength(0);
  });

  it('a tyre burst counts the new flat and a failed engine uses the replacement price and makes a wreck', () => {
    const r = rig();
    const port = spawn(r, P101, 10);
    hit(r, port, 'front', 0.3, 25);
    port.cond.flats[2] = true;
    r.bus.emit('vehicle:tireBurst', { eid: 10, wheel: 2 });
    port.cond.engineFailed = true;
    port.cond.engineHealth = 0.02;
    r.fleet.step(1 / 60, time(0));
    r.fleet.step(1 / 60, time(5));
    const inc = incident(r, 1);
    expect(inc).toMatchObject({ closed: true, newFlats: 1, engineFailed: true, wreck: true });
    expect(inc.cost).toBe(Math.round(0.3 * 2400) + 14000 + 180);
    expect(topics(r, 'fleet:incident')).toEqual([{ unitId: P101, incidentId: 1, cost: inc.cost, wreck: true }]);
  });

  it('a burst on its own opens an incident with a zone from the wheel', () => {
    const r = rig();
    const port = spawn(r, P101, 10);
    port.cond.flats[3] = true;
    r.bus.emit('vehicle:tireBurst', { eid: 10, wheel: 3 });
    r.fleet.step(1 / 60, time(0));
    expect(topics(r, 'fleet:damage')[0]).toMatchObject({ zone: 'rear', amount: 0, impactSpeed: 0 });
    r.fleet.step(1 / 60, time(5));
    expect(incident(r, 1).newFlats).toBe(1);
    expect(incident(r, 1).cost).toBe(180);
  });

  it('damage that exists when the vehicle is bound is not part of an incident', () => {
    const r = rig();
    const port = spawn(r, P101, 10, 'patrol_sedan', { zones: [0.5, 0, 0, 0] });
    hit(r, port, 'rear', 0.1, 6);
    r.fleet.step(1 / 60, time(0));
    r.fleet.step(1 / 60, time(5));
    const inc = incident(r, 1);
    expect(inc.zoneDelta[0]).toBe(0);
    expect(inc.zoneDelta[1]).toBeCloseTo(0.1, 6);
  });

  it('unbinding closes an open incident from the stored condition', () => {
    const r = rig();
    const port = spawn(r, P101, 10);
    hit(r, port, 'front', 0.5, 12);
    r.fleet.step(1 / 60, time(0));
    const stored = storedVehicle();
    stored.zones = [0.5, 0, 0, 0];
    stored.engineHealth = 1;
    r.ports.delete(P101);
    r.fleet.unbindVehicle(P101, stored);
    expect(incident(r, 1)).toMatchObject({ closed: true, cost: 1200 });
    expect(r.fleet.unitOfEid(10)).toBeNull();
    expect(r.fleet.storedVehicle(P101)).toEqual(stored);
    expect(r.fleet.storedVehicle(P101)).not.toBe(stored);
  });

  it('keeps at most limits.incidents, dropping closed charged ones first', () => {
    const r = rig();
    const port = spawn(r, P101, 10);
    const limit = MAINTENANCE.limits.incidents;
    for (let i = 0; i < limit + 5; i++) {
      hit(r, port, 'front', 0.001, 5);
      r.fleet.step(1 / 60, time(i * 10));
      r.fleet.step(1 / 60, time(i * 10 + 6));
    }
    // Nothing is charged yet, so nothing may be dropped.
    expect(r.fleet.incidents()).toHaveLength(limit + 5);
    r.fleet.request({ kind: 'endShift' });
    r.fleet.step(1 / 60, time(limit * 10 + 101));
    hit(r, port, 'front', 0.001, 5);
    r.fleet.step(1 / 60, time(limit * 10 + 200));
    expect(r.fleet.incidents()).toHaveLength(limit);
  });
});

describe('reports', () => {
  it('stores a damage report with the officer, pronouns, zone, speed and context', () => {
    const r = rig();
    const port = spawn(r, P101, 10);
    r.context.pursuit = true;
    hit(r, port, 'left', 0.3, 14);
    r.fleet.step(1 / 60, time(0));
    r.fleet.step(1 / 60, time(5));
    r.fleet.request({ kind: 'report', incidentId: 1 });
    expect(r.fleet.reports()).toHaveLength(0);
    r.fleet.step(1 / 60, time(6, 180));
    expect(incident(r, 1).reported).toBe(true);
    const report = r.fleet.reports()[0];
    expect(report).toMatchObject({ id: 1, incidentId: 1, unitId: P101, game: 180 });
    expect(report?.text).toBe(
      applyPronouns(CHARACTER_LINES.damageReport ?? '', PRONOUN_PRESETS.they, {
        name: 'Alex Rivera', pronouns: 'they/them', unit: P101, zone: 'left', speed: '50', context: ' during a pursuit',
      }),
    );
    expect(report?.text).toContain('Alex Rivera (they/them) reported that they were operating unit P-101');
    expect(report?.text).toContain('left damage at 50 km/h during a pursuit');
    expect(r.fleet.openReports()).toBe(0);
  });

  it('can report an open incident, the largest zone is named, and a second report is ignored', () => {
    const r = rig();
    const port = spawn(r, P101, 10);
    r.context.emergency = true;
    hit(r, port, 'front', 0.1, 5);
    hit(r, port, 'right', 0.4, 9);
    r.fleet.step(1 / 60, time(0));
    expect(r.fleet.openReports()).toBe(1);
    r.fleet.request({ kind: 'report', incidentId: 1 });
    r.fleet.request({ kind: 'report', incidentId: 1 });
    r.fleet.request({ kind: 'report', incidentId: 42 });
    r.fleet.step(1 / 60, time(1));
    expect(r.fleet.reports()).toHaveLength(1);
    expect(r.fleet.reports()[0]?.text).toContain('right damage at 32 km/h on an emergency run');
    expect(r.fleet.openReports()).toBe(0);
  });

  it('keeps at most limits.reports', () => {
    const r = rig();
    const port = spawn(r, P101, 10);
    const n = MAINTENANCE.limits.reports + 3;
    for (let i = 0; i < n; i++) {
      hit(r, port, 'front', 0.001, 5);
      r.fleet.step(1 / 60, time(i * 10));
      r.fleet.request({ kind: 'report', incidentId: i + 1 });
      r.fleet.step(1 / 60, time(i * 10 + 6));
    }
    expect(r.fleet.reports()).toHaveLength(MAINTENANCE.limits.reports);
    expect(r.fleet.reports()[0]?.id).toBe(4);
  });
});

describe('endShift', () => {
  function crash(r: Rig, port: FakePort, simAt: number): void {
    // Two zones fully damaged: $4 800 for a patrol unit, not a wreck.
    hit(r, port, 'front', 1, 15);
    hit(r, port, 'rear', 1, 15);
    r.fleet.step(1 / 60, time(simAt));
  }

  it('charges reported and unreported incidents differently and closes open ones at once', () => {
    const r = rig();
    const a = spawn(r, P101, 10);
    const b = spawn(r, P102, 11, 'patrol_suv');
    crash(r, a, 0);
    crash(r, b, 0);
    expect(r.fleet.incidents().every((i) => !i.closed)).toBe(true);
    r.fleet.request({ kind: 'report', incidentId: 1 });
    r.fleet.request({ kind: 'endShift' });
    r.fleet.step(1 / 60, time(1, 100));
    expect(r.fleet.incidents().every((i) => i.closed && i.charged && i.cost === 4800)).toBe(true);
    expect(topics(r, 'fleet:charge')).toEqual([
      { unitId: P101, incidentId: 1, points: -5, cost: 4800, reason: 'Damaged P-101' },
      { unitId: P102, incidentId: 2, points: -10, cost: 4800, reason: 'Damaged P-102 (unreported)' },
    ]);
    expect(topics(r, 'fleet:shiftEnd')).toEqual([{ points: -15, departmentCost: 0, incidents: 2, unreported: 1 }]);
    expect(r.fleet.ledger.officerPoints).toBe(-15);
    expect(r.fleet.ledger.departmentCost).toBe(0);
    expect(r.fleet.ledger.entries().map((e) => [e.kind, e.unitId, e.cost, e.points])).toEqual([
      ['charge', P101, 4800, -5], ['charge', P102, 4800, -10],
    ]);
    expect(r.fleet.serialize(() => -1).shift).toBe(2);
  });

  it('pursuit and emergency scale the charge and a wreck adds points', () => {
    const r = rig();
    const a = spawn(r, P101, 10);
    const b = spawn(r, P102, 11, 'patrol_suv');
    r.context.pursuit = true;
    crash(r, a, 0);
    r.context.pursuit = false;
    r.context.emergency = true;
    crash(r, b, 0);
    r.fleet.request({ kind: 'report', incidentId: 1 });
    r.fleet.request({ kind: 'report', incidentId: 2 });
    r.fleet.request({ kind: 'endShift' });
    r.fleet.step(1 / 60, time(1));
    const charges = topics(r, 'fleet:charge') as { points: number; reason: string }[];
    expect(charges.map((c) => c.points)).toEqual([-1, -2]);
    expect(charges[0]?.reason).toBe('Damaged P-101 in a pursuit');
    expect(charges[1]?.reason).toBe('Damaged P-102 on an emergency run');

    const w = rig();
    const port = spawn(w, P101, 10);
    hit(w, port, 'front', 1, 20);
    hit(w, port, 'rear', 1, 20);
    hit(w, port, 'left', 0.6, 20);
    w.fleet.step(1 / 60, time(0));
    w.fleet.request({ kind: 'report', incidentId: 1 });
    w.fleet.request({ kind: 'endShift' });
    w.fleet.step(1 / 60, time(1));
    expect(incident(w, 1).wreck).toBe(true);
    // $6 240 reported: 6.24 + 10 wreck points = -16.
    expect(topics(w, 'fleet:charge')).toEqual([
      { unitId: P101, incidentId: 1, points: -16, cost: 6240, reason: 'Wrecked P-101' },
    ]);
  });

  it('skips a zero charge but still reports the shift', () => {
    const r = rig();
    const port = spawn(r, P101, 10);
    hit(r, port, 'front', 0.01, 5);
    r.fleet.step(1 / 60, time(0));
    r.fleet.request({ kind: 'report', incidentId: 1 });
    r.fleet.request({ kind: 'endShift' });
    r.fleet.step(1 / 60, time(1));
    expect(topics(r, 'fleet:charge')).toEqual([]);
    expect(r.fleet.ledger.entries()).toHaveLength(0);
    expect(topics(r, 'fleet:shiftEnd')).toEqual([{ points: 0, departmentCost: 0, incidents: 1, unreported: 0 }]);
  });

  it('charges each incident once and only the shift it belongs to', () => {
    const r = rig();
    const port = spawn(r, P101, 10);
    crash(r, port, 0);
    r.fleet.request({ kind: 'endShift' });
    r.fleet.step(1 / 60, time(1));
    r.fleet.request({ kind: 'endShift' });
    r.fleet.step(1 / 60, time(2));
    expect(topics(r, 'fleet:charge')).toHaveLength(1);
    expect(topics(r, 'fleet:shiftEnd')).toEqual([
      { points: -10, departmentCost: 0, incidents: 1, unreported: 1 },
      { points: 0, departmentCost: 0, incidents: 0, unreported: 0 },
    ]);
    hit(r, port, 'left', 1, 15);
    r.fleet.step(1 / 60, time(10));
    expect(incident(r, 3 - 1).shift).toBe(3);
  });

  it('the shift totals include the services of the shift', () => {
    const r = rig();
    const port = spawn(r, P101, 10, 'patrol_sedan', { fuelFraction: 0.5 });
    const fuelCost = Math.round(port.model.fuel.capacityL * 0.5 * 2);
    r.fleet.startShift(time(0, 1000));
    r.fleet.request({ kind: 'service', unitId: P101, service: 'refuel' });
    r.fleet.step(1 / 60, time(1, 1100));
    r.fleet.request({ kind: 'endShift' });
    r.fleet.step(1 / 60, time(2, 1200));
    expect(topics(r, 'fleet:shiftEnd')).toEqual([{ points: 0, departmentCost: fuelCost, incidents: 0, unreported: 0 }]);
  });
});

describe('service', () => {
  it('applies the mutations, books the ledger by kind and refreshes the baseline', () => {
    const r = rig();
    const cond = {
      fuelFraction: 0.5, oilFraction: 0.4, tread: [0.5, 1, 1, 1] as [number, number, number, number],
      zones: [0.5, 0, 0, 0] as [number, number, number, number], engineHealth: 0.9,
    };
    const port = spawn(r, P101, 10, 'patrol_sedan', cond);
    const quote = r.fleet.quote(P101, 'all');
    expect(quote).toEqual(serviceQuote('all', port.condition(), port.model.fuel.capacityL, 'patrol'));
    expect(quote?.total).toBeGreaterThan(0);
    r.fleet.request({ kind: 'service', unitId: P101, service: 'all' });
    expect(port.calls).toEqual([]);
    r.fleet.step(1 / 60, time(0, 50));
    expect(port.calls).toEqual(['refuel', 'oil', 'tires', 'repair']);
    expect(topics(r, 'fleet:service')).toEqual([{ unitId: P101, service: 'all', cost: quote?.total }]);
    const entries = r.fleet.ledger.entries();
    expect(entries.map((e) => e.kind)).toEqual(['fuel', 'oil', 'tire', 'repair']);
    expect(entries.map((e) => e.cost)).toEqual([port.model.fuel.capacityL * 0.5 * 2, 80, 180, 1200 + 900].map(Math.round));
    expect(entries.every((e) => e.game === 50 && e.points === 0 && e.unitId === P101)).toBe(true);
    expect(r.fleet.ledger.departmentCost).toBe(quote?.total);
    expect(r.fleet.quote(P101, 'all')?.total).toBe(0);

    // The repair is not new damage, and a new hit measures from the repaired state.
    hit(r, port, 'rear', 0.1, 7);
    r.fleet.step(1 / 60, time(1));
    r.fleet.step(1 / 60, time(6));
    expect(incident(r, 1).zoneDelta).toEqual([0, expect.closeTo(0.1, 6), 0, 0]);
    expect(incident(r, 1).cost).toBe(240);
  });

  it('each single service touches only its own mutation', () => {
    for (const [service, call] of [['refuel', 'refuel'], ['oil', 'oil'], ['tires', 'tires'], ['repair', 'repair']] as const) {
      const r = rig();
      const port = spawn(r, P101, 10);
      r.fleet.request({ kind: 'service', unitId: P101, service });
      r.fleet.step(1 / 60, time(0));
      expect(port.calls).toEqual([call]);
      expect(topics(r, 'fleet:service')).toEqual([{ unitId: P101, service, cost: 0 }]);
      expect(r.fleet.ledger.entries()).toHaveLength(0);
    }
  });

  it('refuel is not multiplied by the class and other lines are', () => {
    const r = rig();
    spawn(r, 'AIR-2', 20, 'police_helicopter', { fuelFraction: 0.5, oilFraction: 0.5 });
    const cap = r.ports.get('AIR-2')?.model.fuel.capacityL ?? 0;
    r.fleet.request({ kind: 'service', unitId: 'AIR-2', service: 'refuel' });
    r.fleet.request({ kind: 'service', unitId: 'AIR-2', service: 'oil' });
    r.fleet.step(1 / 60, time(0));
    expect(r.fleet.ledger.entries().map((e) => [e.kind, e.cost])).toEqual([['fuel', Math.round(cap * 0.5 * 2)], ['oil', 640]]);
  });

  it('does nothing for a unit that is not spawned or unknown, and quotes null', () => {
    const r = rig();
    r.fleet.request({ kind: 'service', unitId: P101, service: 'all' });
    r.fleet.request({ kind: 'service', unitId: 'Z-999', service: 'all' });
    r.fleet.step(1 / 60, time(0));
    expect(r.events).toEqual([]);
    expect(r.fleet.quote(P101, 'all')).toBeNull();
    expect(r.fleet.quote('Z-999', 'all')).toBeNull();
  });
});

describe('inspection', () => {
  const input = { faults: 0, loadoutMissing: [], hasRack: true, rackSecured: false, hasCage: true, cageEmpty: true };

  it('runs the checklist on the unit and counts its unreported incidents', () => {
    const r = rig();
    const port = spawn(r, P101, 10, 'patrol_sedan', { fuelFraction: 0.1 });
    hit(r, port, 'front', 0.2, 9);
    r.fleet.step(1 / 60, time(0));
    r.fleet.request({ kind: 'inspect', unitId: P101, input });
    r.fleet.step(1 / 60, time(1));
    const result = r.fleet.lastInspection();
    expect(result?.failed).toEqual(['fuel', 'body', 'longGuns']);
    expect(result?.rows.find((x) => x.id === 'fuel')?.detail).toBe('Fuel 10 %');
    expect(result?.rows.find((x) => x.id === 'body')?.detail).toBe('1 unreported');
    expect(result?.rows.find((x) => x.id === 'longGuns')?.detail).toBe('Rack unlocked');
    expect(topics(r, 'fleet:inspection')).toEqual([{ unitId: P101, passed: 7, failed: ['fuel', 'body', 'longGuns'] }]);

    r.fleet.request({ kind: 'report', incidentId: 1 });
    r.fleet.request({ kind: 'inspect', unitId: P101, input: { ...input, rackSecured: true } });
    r.fleet.step(1 / 60, time(2));
    expect(r.fleet.lastInspection()?.failed).toEqual(['fuel']);
  });

  it('is skipped for a unit that is not spawned', () => {
    const r = rig();
    r.fleet.request({ kind: 'inspect', unitId: P101, input });
    r.fleet.step(1 / 60, time(0));
    expect(r.fleet.lastInspection()).toBeNull();
    expect(topics(r, 'fleet:inspection')).toEqual([]);
  });
});

describe('units', () => {
  it('lists the 17 units with numbers, labels and the unspawned defaults', () => {
    const r = rig();
    const units = r.fleet.units();
    expect(units).toHaveLength(17);
    expect(r.fleet.unitIds()).toHaveLength(17);
    expect(units[0]).toEqual({
      id: P101, number: '101', modelId: 'patrol_sedan', label: 'Patrol Sedan', cls: 'patrol', liveryId: 'patrolMarked', spawned: false,
      assigned: false, fuel: 1, oil: 1, tread: 1, damage: 0, status: 'ready',
    });
    expect(units.find((u) => u.id === 'MAR-1')?.number).toBe('1');
  });

  it('is cached until the revision changes', () => {
    const r = rig();
    const a = r.fleet.units();
    const rev = r.fleet.revision;
    expect(r.fleet.units()).toBe(a);
    expect(r.fleet.revision).toBe(rev);
    r.fleet.assign(P102);
    expect(r.fleet.revision).toBeGreaterThan(rev);
    expect(r.fleet.units().find((u) => u.id === P102)?.assigned).toBe(true);
    expect(r.fleet.assigned()).toBe(P102);
    r.fleet.assign('Z-999');
    expect(r.fleet.assigned()).toBe(P102);
    r.fleet.assign(null);
    expect(r.fleet.assigned()).toBeNull();
  });

  it('derives the status from the condition, live for spawned units', () => {
    const r = rig();
    const port = spawn(r, P101, 10);
    const view = (): string | undefined => r.fleet.units().find((u) => u.id === P101)?.status;
    expect(view()).toBe('ready');
    expect(r.fleet.units().find((u) => u.id === P101)?.spawned).toBe(true);
    port.cond.fuelFraction = 0.2;
    expect(view()).toBe('service');
    port.cond.fuelFraction = 1;
    port.cond.oilFraction = 0.29;
    expect(view()).toBe('service');
    port.cond.oilFraction = 1;
    port.cond.tread = [1, 0.29, 1, 1];
    expect(view()).toBe('service');
    port.cond.tread = [1, 1, 1, 1];
    port.cond.zones = [0, 0, 0.06, 0];
    expect(view()).toBe('damaged');
    port.cond.zones = [0, 0, 0.05, 0];
    expect(view()).toBe('ready');
    port.cond.flats[0] = true;
    expect(view()).toBe('damaged');
    port.cond.flats[0] = false;
    port.cond.engineHealth = 0.59;
    expect(view()).toBe('damaged');
    port.cond.fuelFraction = 0.1;
    expect(view()).toBe('damaged');
    const v = r.fleet.units().find((u) => u.id === P101);
    expect(v).toMatchObject({ fuel: 0.1, oil: 1, tread: 1, damage: 0.05 });
  });

  it('a despawned unit reads its stored condition', () => {
    const r = rig();
    spawn(r, P101, 10);
    r.ports.delete(P101);
    r.fleet.unbindVehicle(P101, storedVehicle());
    const v = r.fleet.units().find((u) => u.id === P101);
    expect(v?.spawned).toBe(false);
    expect(v?.damage).toBeCloseTo(0.1, 6);
    expect(v?.tread).toBeCloseTo(0.7, 6);
    expect(v?.fuel).toBeCloseTo(30 / vehicleModel('patrol_sedan').fuel.capacityL, 6);
    expect(v?.status).toBe('damaged');
  });
});

describe('liveries and loadouts', () => {
  function custom(base: string): LiveryDoc {
    const doc = defaultLivery(base);
    return { ...doc, id: newLiveryId(doc.id, [doc.id]), name: 'Custom', author: 'Me' };
  }

  it('starts on the default livery of each unit', () => {
    const r = rig();
    expect(r.fleet.livery(P101)).toEqual(defaultLivery('patrolMarked'));
    expect(r.fleet.livery('D-1')).toEqual(defaultLivery('droneUnit'));
    expect(r.fleet.library()).toHaveLength(17);
    expect(r.fleet.library()[0]?.id).toBe('airSupport');
  });

  it('stores a custom livery first in the library and points the unit at it', () => {
    const r = rig();
    const doc = custom('patrolMarked');
    expect(r.fleet.setLivery(P101, doc)).toBe(true);
    expect(r.fleet.livery(P101)).toEqual(doc);
    expect(r.fleet.units().find((u) => u.id === P101)?.liveryId).toBe(doc.id);
    expect(r.fleet.library()[0]).toEqual(doc);
    expect(r.fleet.library()).toHaveLength(18);
    expect(r.fleet.livery(P102).id).toBe('patrolMarked');
    // Same id replaces.
    const edited = { ...doc, name: 'Edited' };
    expect(r.fleet.setLivery(P102, edited)).toBe(true);
    expect(r.fleet.library()).toHaveLength(18);
    expect(r.fleet.livery(P101).name).toBe('Edited');
    expect(r.fleet.livery(P102).name).toBe('Edited');
  });

  it('an unchanged default is pointed at, not copied, and an invalid doc is refused', () => {
    const r = rig();
    expect(r.fleet.setLivery(P101, defaultLivery('trafficMarked'))).toBe(true);
    expect(r.fleet.livery(P101).id).toBe('trafficMarked');
    expect(r.fleet.library()).toHaveLength(17);
    // An edited copy under a default id shadows that default.
    expect(r.fleet.setLivery(P101, { ...defaultLivery('trafficMarked'), name: 'Changed' })).toBe(true);
    expect(r.fleet.library()).toHaveLength(17);
    expect(r.fleet.library()[0]?.name).toBe('Changed');
    expect(r.fleet.livery(P101).name).toBe('Changed');
    expect(r.fleet.removeLivery('trafficMarked')).toBe(true);
    expect(r.fleet.livery(P101).name).not.toBe('Changed');
    expect(r.fleet.setLivery(P101, { id: 1 } as unknown as LiveryDoc)).toBe(false);
    expect(() => r.fleet.setLivery('Z-999', defaultLivery('patrolMarked'))).toThrow(/Unknown fleet unit/);
  });

  it('keeps at most 32 custom docs, evicting an unused one first', () => {
    const r = rig();
    const taken: string[] = [];
    for (let i = 0; i < 32; i++) {
      const id = newLiveryId('mine', taken);
      taken.push(id);
      expect(r.fleet.setLivery(i < 17 ? (r.fleet.unitIds()[i] ?? P101) : P101, { ...defaultLivery('patrolMarked'), id, name: `L${i}` })).toBe(true);
    }
    expect(r.fleet.library().filter((l) => taken.includes(l.id))).toHaveLength(32);
    // P-101 points at the last one; the others at earlier ones: every doc 0..16 is in use, 17..30 are free.
    const extraId = newLiveryId('mine', taken);
    expect(r.fleet.setLivery(P102, { ...defaultLivery('patrolMarked'), id: extraId, name: 'extra' })).toBe(true);
    const ids = r.fleet.library().map((l) => l.id);
    expect(ids.filter((id) => id.startsWith('mine') || id === extraId)).toHaveLength(32);
    expect(ids).toContain(extraId);
  });

  it('refuses a new livery when all 32 are in use', () => {
    const r = rig();
    const ids = r.fleet.unitIds();
    const docs: LiveryDoc[] = [];
    for (let i = 0; i < 32; i++) docs.push({ ...defaultLivery('patrolMarked'), id: `custom${i}`, name: `L${i}` });
    // 17 units can use at most 17 docs; the rest are unused, so use the library save path to fill it.
    const save = emptyFleetSave(createRng(1).state());
    save.liveries = docs;
    save.units.forEach((u, i) => { u.liveryId = `custom${i}`; });
    const full = new FleetSystem(r.deps, save);
    expect(ids).toHaveLength(17);
    expect(full.setLivery(P101, { ...defaultLivery('patrolMarked'), id: 'fresh', name: 'fresh' })).toBe(true);
    expect(full.library().some((l) => l.id === 'fresh')).toBe(true);
    expect(full.library().filter((l) => l.id.startsWith('custom'))).toHaveLength(31);
  });

  it('removeLivery drops a custom doc and its units fall back to their default', () => {
    const r = rig();
    const doc = custom('patrolMarked');
    r.fleet.setLivery(P101, doc);
    r.fleet.setLivery(P102, doc);
    expect(r.fleet.removeLivery('patrolMarked')).toBe(false);
    expect(r.fleet.removeLivery('nope')).toBe(false);
    expect(r.fleet.removeLivery(doc.id)).toBe(true);
    expect(r.fleet.livery(P101).id).toBe('patrolMarked');
    expect(r.fleet.livery(P102).id).toBe('patrolMarked');
    expect(r.fleet.library()).toHaveLength(17);
  });

  it('default loadouts follow the model: trunk loadout and a rack that fits', () => {
    const r = rig();
    const patrol = r.fleet.loadout(P101);
    expect(patrol.trunk).toEqual(expect.objectContaining({ firstAid: expect.any(Number) }));
    expect(patrol.rack).toHaveLength(2);
    expect(r.fleet.loadout('T-401').rack).toHaveLength(1);
    expect(r.fleet.loadout('D-1')).toEqual({ trunk: {}, rack: [] });
    expect(r.fleet.loadout('M-601').rack.length).toBeLessThanOrEqual(1);
    // A copy.
    patrol.trunk.cones = 99;
    expect(r.fleet.loadout(P101).trunk.cones).not.toBe(99);
  });

  it('setLoadout stores only a valid loadout', () => {
    const r = rig();
    const def = r.fleet.loadout(P101);
    const heavy = { trunk: { ...def.trunk, cones: 999 }, rack: def.rack };
    const bad = r.fleet.setLoadout(P101, heavy);
    expect(bad.ok).toBe(false);
    expect(r.fleet.loadout(P101)).toEqual(def);
    const lighter = { trunk: { ...def.trunk, cones: 1 }, rack: [def.rack[0] ?? 'shotgun'] };
    const rev = r.fleet.revision;
    const good = r.fleet.setLoadout(P101, lighter);
    expect(good.ok).toBe(true);
    expect(r.fleet.revision).toBeGreaterThan(rev);
    expect(r.fleet.loadout(P101)).toEqual(lighter);
    lighter.trunk.cones = 5;
    expect(r.fleet.loadout(P101).trunk.cones).toBe(1);
  });

  it('a class-required item cannot be removed', () => {
    const r = rig();
    const def = r.fleet.loadout(P101);
    const stripped = { trunk: { ...def.trunk }, rack: def.rack };
    delete stripped.trunk.firstAid;
    const result = r.fleet.setLoadout(P101, stripped);
    expect(result.ok).toBe(false);
    expect(r.fleet.loadout(P101)).toEqual(def);
  });
});

describe('save', () => {
  function busy(): { r: Rig; save: FleetSave } {
    const r = rig();
    const a = spawn(r, P101, 10, 'patrol_sedan', { fuelFraction: 0.5 });
    const b = spawn(r, P102, 11, 'patrol_suv');
    spawn(r, 'M-601', 12, 'police_motorcycle');
    r.fleet.assign(P101);
    r.fleet.startShift(time(0, 500));
    r.fleet.setLivery(P101, { ...defaultLivery('patrolMarked'), id: 'mine1', name: 'Mine' });
    const def = r.fleet.loadout(P102);
    expect(r.fleet.setLoadout(P102, { trunk: { ...def.trunk, cones: 2 }, rack: [] }).ok).toBe(true);
    r.context.pursuit = true;
    hit(r, a, 'front', 0.4, 12);
    r.fleet.step(1 / 60, time(0, 10));
    r.fleet.step(1 / 60, time(6, 190));
    r.context.pursuit = false;
    hit(r, b, 'rear', 0.2, 6);
    r.fleet.step(1 / 60, time(30, 900));
    r.fleet.request({ kind: 'report', incidentId: 1 });
    r.fleet.request({ kind: 'service', unitId: P101, service: 'refuel' });
    r.fleet.step(1 / 60, time(31, 930));
    r.fleet.request({ kind: 'inspect', unitId: P101, input: { faults: 0, loadoutMissing: ['aed'], hasRack: true, rackSecured: true, hasCage: true, cageEmpty: true } });
    r.fleet.step(1 / 60, time(32, 960));
    r.ports.delete('M-601');
    r.fleet.unbindVehicle('M-601', storedVehicle('police_motorcycle'));
    r.fleet.request({ kind: 'endShift' });
    const index = (eid: number): number => [10, 11].indexOf(eid);
    return { r, save: r.fleet.serialize(index) };
  }

  it('serialize -> constructor -> serialize is identical', () => {
    const { r, save } = busy();
    expect(isFleetSave(save)).toBe(true);
    expect(save.units.find((u) => u.id === P101)?.vehicleIndex).toBe(0);
    expect(save.units.find((u) => u.id === P102)?.vehicleIndex).toBe(1);
    expect(save.units.find((u) => u.id === 'M-601')?.stored?.modelId).toBe('police_motorcycle');
    expect(save.queue).toEqual([{ kind: 'endShift' }]);
    expect(save.liveries.map((l) => l.id)).toEqual(['mine1']);
    expect(save.incidents).toHaveLength(2);
    expect(save.reports).toHaveLength(1);
    expect(save.lastInspection?.failed).toEqual(['equipment']);
    expect(save.ledger.entries.length).toBeGreaterThan(0);
    expect(save.assigned).toBe(P101);

    const json = JSON.parse(JSON.stringify(save)) as FleetSave;
    expect(isFleetSave(json)).toBe(true);
    const again = rig(json, r.ports);
    const index = (eid: number): number => [10, 11].indexOf(eid);
    // Before the integrator rebinds, the saved indexes are still reported.
    expect(again.fleet.savedVehicleIndex(P101)).toBe(0);
    expect(again.fleet.savedVehicleIndex(P102)).toBe(1);
    expect(again.fleet.savedVehicleIndex('M-601')).toBe(-1);
    expect(again.fleet.serialize(index)).toEqual(json);
    // Rebinding the restored vehicles by savedVehicleIndex keeps it identical.
    again.fleet.bindVehicle(P101, 10);
    again.fleet.bindVehicle(P102, 11);
    expect(again.fleet.savedVehicleIndex(P101)).toBe(-1);
    expect(again.fleet.serialize(index)).toEqual(json);
  });

  it('restores the live state', () => {
    const { r, save } = busy();
    const again = rig(JSON.parse(JSON.stringify(save)) as FleetSave, r.ports);
    expect(again.fleet.assigned()).toBe(P101);
    expect(again.fleet.livery(P101).id).toBe('mine1');
    expect(again.fleet.loadout(P102)).toEqual(r.fleet.loadout(P102));
    expect(again.fleet.loadout(P102).trunk.cones).toBe(2);
    expect(again.fleet.incidents()).toEqual(r.fleet.incidents());
    expect(again.fleet.reports()).toEqual(r.fleet.reports());
    expect(again.fleet.lastInspection()).toEqual(r.fleet.lastInspection());
    expect(again.fleet.ledger.departmentCost).toBe(r.fleet.ledger.departmentCost);
    expect(again.fleet.storedVehicle('M-601')).toEqual(storedVehicle('police_motorcycle'));
    // The queued end-of-shift request still runs.
    again.fleet.step(1 / 60, time(40, 1200));
    expect(topics(again, 'fleet:shiftEnd')).toHaveLength(1);
    // Ids continue.
    again.fleet.bindVehicle(P101, 10);
    again.ports.get(P101)!.cond.zones[2] = 0.3;
    again.bus.emit('vehicle:damaged', { eid: 10, zone: 'left', amount: 0.3, impactSpeed: 8 });
    again.fleet.step(1 / 60, time(50, 1500));
    expect(again.fleet.incidents().at(-1)?.id).toBe(3);
  });

  it('an open incident survives a save and closes after the vehicle is rebound', () => {
    const r = rig();
    const port = spawn(r, P101, 10);
    hit(r, port, 'front', 0.5, 9);
    r.fleet.step(1 / 60, time(0));
    const save = JSON.parse(JSON.stringify(r.fleet.serialize(() => 0))) as FleetSave;
    const again = rig(save, r.ports);
    again.fleet.bindVehicle(P101, 10);
    again.fleet.step(1 / 60, time(1));
    expect(again.fleet.incidents()[0]?.closed).toBe(false);
    again.fleet.step(1 / 60, time(5.1));
    expect(again.fleet.incidents()[0]).toMatchObject({ closed: true, cost: 1200 });
  });

  it('restores the rng state', () => {
    const r = rig();
    r.deps.rng.next();
    const save = r.fleet.serialize(() => -1);
    expect(save.rng).toEqual(r.deps.rng.state());
    const other = rig(save);
    other.deps.rng.restore(save.rng);
    expect(other.fleet.serialize(() => -1).rng).toEqual(save.rng);
    expect(other.deps.rng.state()).toEqual(save.rng);
  });

  it('drops unknown units and falls back from a missing livery', () => {
    const base = emptyFleetSave(createRng(3).state());
    base.units.push({ id: 'Q-1', liveryId: 'x', loadout: null, vehicleIndex: 4, stored: null });
    base.units[0]!.liveryId = 'gone';
    base.assigned = 'Q-1';
    const r = rig(base);
    expect(r.fleet.unitIds()).not.toContain('Q-1');
    expect(r.fleet.assigned()).toBeNull();
    expect(r.fleet.livery(P101).id).toBe('patrolMarked');
  });
});

describe('isFleetSave', () => {
  const good = (): FleetSave => {
    const r = rig();
    const port = spawn(r, P101, 10);
    hit(r, port, 'front', 0.3, 9);
    r.fleet.step(1 / 60, time(0));
    r.fleet.setLivery(P101, { ...defaultLivery('patrolMarked'), id: 'mine1', name: 'Mine' });
    r.fleet.request({ kind: 'service', unitId: P101, service: 'oil' });
    r.fleet.request({ kind: 'inspect', unitId: P101, input: { faults: 0, loadoutMissing: [], hasRack: false, rackSecured: false, hasCage: false, cageEmpty: false } });
    r.fleet.request({ kind: 'report', incidentId: 1 });
    r.fleet.request({ kind: 'endShift' });
    r.fleet.step(1 / 60, time(1));
    r.fleet.request({ kind: 'endShift' });
    r.ports.delete(P101);
    r.fleet.unbindVehicle(P101, storedVehicle());
    return JSON.parse(JSON.stringify(r.fleet.serialize(() => -1))) as FleetSave;
  };

  it('accepts a real save, an empty save and a migrated save', () => {
    expect(isFleetSave(good())).toBe(true);
    expect(isFleetSave(emptyFleetSave(createRng(1).state()))).toBe(true);
    expect(isFleetSave(migratedFleetSave(createRng(1).state(), ['patrol_sedan']))).toBe(true);
  });

  type Mutate = (s: any) => void;
  const cases: [string, Mutate][] = [
    ['not an object', (s) => { Object.keys(s as object).forEach((k) => delete s[k]); s.x = 1; }],
    ['version', (s) => { s.version = 2; }],
    ['rng', (s) => { s.rng = { seed: 1, s: [1, 2, 3] }; }],
    ['rng word', (s) => { s.rng.s[0] = -1; }],
    ['shift', (s) => { s.shift = 1.5; }],
    ['shiftStartGame', (s) => { s.shiftStartGame = NaN; }],
    ['assigned', (s) => { s.assigned = 5; }],
    ['units', (s) => { s.units = {}; }],
    ['unit id', (s) => { s.units[0].id = 1; }],
    ['unit liveryId', (s) => { s.units[0].liveryId = null; }],
    ['unit loadout', (s) => { s.units[0].loadout = { trunk: { a: 'x' }, rack: [] }; }],
    ['unit loadout rack', (s) => { s.units[0].loadout = { trunk: {}, rack: [1] }; }],
    ['unit vehicleIndex', (s) => { s.units[0].vehicleIndex = -2; }],
    ['unit vehicleIndex float', (s) => { s.units[0].vehicleIndex = 0.5; }],
    ['unit stored', (s) => { s.units[0].stored = 'x'; }],
    ['stored modelId', (s) => { s.units[0].stored = { ...storedVehicle(), modelId: 3 }; }],
    ['stored number', (s) => { s.units[0].stored = { ...storedVehicle(), fuelL: Infinity }; }],
    ['stored zones', (s) => { s.units[0].stored = { ...storedVehicle(), zones: [0, 0, 0] }; }],
    ['stored tireFlat', (s) => { s.units[0].stored = { ...storedVehicle(), tireFlat: [0, 0, 0, 0] }; }],
    ['stored engineFailed', (s) => { s.units[0].stored = { ...storedVehicle(), engineFailed: 'no' }; }],
    ['stored wear', (s) => { s.units[0].stored = { ...storedVehicle(), wear: { oilL: 1, tread: [1], odometerM: 0 } }; }],
    ['stored craft', (s) => { s.units[0].stored = { ...storedVehicle(), craft: { speed: 1 } }; }],
    ['stored pushBar', (s) => { s.units[0].stored = { ...storedVehicle(), pushBar: 1 }; }],
    ['liveries', (s) => { s.liveries = 'x'; }],
    ['livery doc', (s) => { s.liveries[0].layers = 5; }],
    ['too many liveries', (s) => { s.liveries = Array.from({ length: 33 }, (_, i) => ({ ...s.liveries[0], id: `m${i}` })); }],
    ['incidents', (s) => { s.incidents = [{}]; }],
    ['incident zoneDelta', (s) => { s.incidents[0].zoneDelta = [0, 0, 0]; }],
    ['incident closed', (s) => { s.incidents[0].closed = 'yes'; }],
    ['incident cost', (s) => { s.incidents[0].cost = NaN; }],
    ['incident callId', (s) => { s.incidents[0].callId = 0.5; }],
    ['reports', (s) => { s.reports = [{ id: 1 }]; }],
    ['report text', (s) => { s.reports[0].text = 5; }],
    ['ledger', (s) => { s.ledger = null; }],
    ['ledger entry', (s) => { s.ledger.entries.push({ seq: 1 }); }],
    ['lastInspection', (s) => { s.lastInspection = {}; }],
    ['lastInspection row', (s) => { s.lastInspection.rows[0].pass = 'y'; }],
    ['queue', (s) => { s.queue = [{ kind: 'nope' }]; }],
    ['queue service', (s) => { s.queue = [{ kind: 'service', unitId: 'P-101', service: 'wash' }]; }],
    ['queue report', (s) => { s.queue = [{ kind: 'report', incidentId: 'x' }]; }],
    ['queue inspect', (s) => { s.queue = [{ kind: 'inspect', unitId: 'P-101', input: {} }]; }],
    ['nextIncident', (s) => { s.nextIncident = '1'; }],
    ['nextReport', (s) => { s.nextReport = 1.5; }],
  ];

  it.each(cases)('rejects a malformed %s', (_name, mutate) => {
    const s = good();
    mutate(s);
    expect(isFleetSave(s)).toBe(false);
  });

  it('good() sanity: every case above starts from a valid save with data to corrupt', () => {
    const s = good();
    expect(s.units[0]?.stored).not.toBeNull();
    expect(s.liveries).toHaveLength(1);
    expect(s.incidents).toHaveLength(1);
    expect(s.reports).toHaveLength(1);
    expect(s.lastInspection?.rows.length).toBeGreaterThan(0);
    expect(s.queue.length).toBeGreaterThan(0);
  });

  it('accepts the optional stored fields when well formed', () => {
    const s = good();
    s.units[0]!.stored = { ...storedVehicle(), craft: { speed: 1, vy: 0, yaw: 0, pitch: 0, roll: 0 }, pushBar: true };
    expect(isFleetSave(s)).toBe(true);
    delete (s.units[0]!.stored as Partial<ReturnType<typeof storedVehicle>>).wear;
    expect(isFleetSave(s)).toBe(true);
  });
});

describe('emptyFleetSave and migratedFleetSave', () => {
  it('empty: every unit, default livery, no loadout, nothing spawned', () => {
    const rng = createRng(5).state();
    const s = emptyFleetSave(rng);
    expect(s.units).toHaveLength(17);
    expect(s.units.every((u) => u.loadout === null && u.vehicleIndex === -1 && u.stored === null)).toBe(true);
    expect(s.units[0]).toMatchObject({ id: P101, liveryId: 'patrolMarked' });
    expect(s.rng).toEqual(rng);
    expect(s).toMatchObject({ version: 1, shift: 1, assigned: null, liveries: [], incidents: [], reports: [], queue: [], nextIncident: 1, nextReport: 1 });
  });

  it('migrated: the first unused unit of each model gets the vehicle', () => {
    const s = migratedFleetSave(createRng(5).state(), ['patrol_sedan', 'patrol_suv', 'sedan']);
    const idx = Object.fromEntries(s.units.map((u) => [u.id, u.vehicleIndex]));
    expect(idx[P101]).toBe(0);
    expect(idx[P102]).toBe(1);
    expect(Object.values(idx).filter((i) => i === 2)).toHaveLength(0);
    expect(Object.values(idx).filter((i) => i >= 0)).toHaveLength(2);
  });

  it('migrated: a second vehicle of the same model has no second unit', () => {
    const s = migratedFleetSave(createRng(5).state(), ['patrol_sedan', 'patrol_sedan', 'police_motorcycle']);
    expect(s.units.find((u) => u.id === P101)?.vehicleIndex).toBe(0);
    expect(s.units.find((u) => u.id === 'M-601')?.vehicleIndex).toBe(2);
    expect(s.units.filter((u) => u.vehicleIndex === 1)).toHaveLength(0);
  });

  it('a migrated save constructs a fleet whose savedVehicleIndex matches', () => {
    const r = rig(migratedFleetSave(createRng(5).state(), ['patrol_sedan', 'patrol_suv', 'sedan']));
    expect(r.fleet.savedVehicleIndex(P101)).toBe(0);
    expect(r.fleet.savedVehicleIndex(P102)).toBe(1);
    expect(r.fleet.savedVehicleIndex('S-201')).toBe(-1);
    expect(r.fleet.savedVehicleIndex('Z-999')).toBe(-1);
  });
});

describe('requests', () => {
  it('are applied at the next step, not when queued', () => {
    const r = rig();
    spawn(r, P101, 10, 'patrol_sedan', { oilFraction: 0 });
    r.fleet.request({ kind: 'service', unitId: P101, service: 'oil' });
    expect(topics(r, 'fleet:service')).toEqual([]);
    expect(r.fleet.serialize(() => -1).queue).toHaveLength(1);
    r.fleet.step(1 / 60, time(0));
    expect(topics(r, 'fleet:service')).toHaveLength(1);
    expect(r.fleet.serialize(() => -1).queue).toHaveLength(0);
  });

  it('an idle step does nothing and emits nothing', () => {
    const r = rig();
    spawn(r, P101, 10);
    const rev = r.fleet.revision;
    for (let i = 0; i < 1000; i++) r.fleet.step(1 / 60, time(i / 60));
    expect(r.fleet.revision).toBe(rev);
    expect(r.events).toEqual([]);
  });

  it('binding an unknown unit throws and rebinding moves the eid', () => {
    const r = rig();
    expect(() => r.fleet.bindVehicle('Z-999', 1)).toThrow(/Unknown fleet unit/);
    spawn(r, P101, 10);
    expect(r.fleet.unitOfEid(10)).toBe(P101);
    r.fleet.bindVehicle(P101, 11);
    expect(r.fleet.unitOfEid(10)).toBeNull();
    expect(r.fleet.unitOfEid(11)).toBe(P101);
  });
});

describe('review round 1: service', () => {
  it('"repair" fixes the body and engine and leaves a flat tyre flat; "tires" fixes the flat and is the priced line', () => {
    const r = rig();
    const port = spawn(r, P101, 10, 'patrol_sedan', { zones: [0.5, 0, 0, 0], flats: [true, false, false, false] });
    const repair = r.fleet.quote(P101, 'repair');
    expect(repair?.lines.map((l) => l.kind)).not.toContain('tire');
    r.fleet.request({ kind: 'service', unitId: P101, service: 'repair' });
    r.fleet.step(1 / 60, time(0, 10));
    expect(port.cond.zones).toEqual([0, 0, 0, 0]);
    expect(port.cond.flats).toEqual([true, false, false, false]);
    expect(r.fleet.ledger.entries().map((e) => e.kind)).toEqual(['repair']);
    // The flat is still there to be replaced, and priced by the tyre line.
    expect(r.fleet.quote(P101, 'tires')?.total).toBeGreaterThan(0);
    r.fleet.request({ kind: 'service', unitId: P101, service: 'tires' });
    r.fleet.step(1 / 60, time(1, 20));
    expect(port.cond.flats).toEqual([false, false, false, false]);
    expect(r.fleet.ledger.entries().map((e) => e.kind)).toEqual(['repair', 'tire']);
  });

  it('only services a unit that is in the yard', () => {
    const r = rig();
    const port = spawn(r, P101, 10, 'patrol_sedan', { oilFraction: 0.2 });
    let inYard = false;
    (r.deps as { inYard?: (id: string) => boolean }).inYard = () => inYard;
    r.fleet.request({ kind: 'service', unitId: P101, service: 'oil' });
    r.fleet.step(1 / 60, time(0, 10));
    expect(port.calls).toEqual([]);
    expect(topics(r, 'fleet:service')).toEqual([]);
    expect(r.fleet.ledger.entries()).toHaveLength(0);
    expect(topics(r, 'fleet:flash')).toEqual([{ text: 'Bring P-101 to the yard to service it' }]);
    inYard = true;
    r.fleet.request({ kind: 'service', unitId: P101, service: 'oil' });
    r.fleet.step(1 / 60, time(1, 20));
    expect(port.calls).toEqual(['oil']);
  });

  it('clearLoadout drops a custom loadout back to the default', () => {
    const r = rig();
    const def = r.fleet.loadout(P101);
    const custom = { ...def, trunk: { ...def.trunk, flares: 5 } };
    expect(r.fleet.setLoadout(P101, custom).ok).toBe(true);
    expect(r.fleet.loadout(P101).trunk['flares']).toBe(5);
    const rev = r.fleet.revision;
    r.fleet.clearLoadout(P101);
    expect(r.fleet.loadout(P101)).toEqual(def);
    expect(r.fleet.revision).toBeGreaterThan(rev);
    const again = r.fleet.revision;
    r.fleet.clearLoadout(P101);
    expect(r.fleet.revision).toBe(again);
  });
});
