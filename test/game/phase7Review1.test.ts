import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Transform } from '../../src/ecs/components';
import { officerPreset } from '../../src/gear';
import { PLAYER_SIZE, startNewGame, type DoorTarget, type GameSession } from '../../src/game/session';
import { doorPanelModel } from '../../src/game/stationPanels';
import { defaultLivery } from '../../src/livery';
import { initRapier } from '../../src/physics/physics';
import { defaultCharacter } from '../../src/uniform';
import type { DrivableVehicle } from '../../src/vehicles/drivableVehicle';
import type { City } from '../../src/world/city';
import { generateCity } from '../../src/world/generate';
import { Harness } from './harness';

const SEED = 42;
let city: City;

beforeAll(async () => {
  await initRapier();
  city = generateCity(SEED);
});

function placeOfficer(session: GameSession, x: number, z: number): void {
  session.physics.getBody(session.player)?.setTranslation({ x, y: PLAYER_SIZE.y / 2, z }, true);
  Transform.x[session.player] = x;
  Transform.z[session.player] = z;
}

function placeVehicle(session: GameSession, car: DrivableVehicle, x: number, z: number): void {
  const body = session.physics.getBody(car.eid);
  body?.setTranslation({ x, y: Transform.y[car.eid] ?? 1, z }, true);
  body?.setLinvel({ x: 0, y: 0, z: 0 }, true);
  body?.setAngvel({ x: 0, y: 0, z: 0 }, true);
  Transform.x[car.eid] = x;
  Transform.z[car.eid] = z;
}

function unit(session: GameSession, id: string): DrivableVehicle {
  const v = session.unitVehicle(id);
  if (!v) throw new Error(`unit ${id} is not out`);
  return v;
}

describe('Phase 7 review round 1 (session)', () => {
  const live: Harness[] = [];
  afterEach(() => {
    for (const h of live.splice(0)) h.dispose();
  });

  function begin(): { h: Harness; session: GameSession } {
    const h = new Harness(city);
    live.push(h);
    const session = h.attach(
      startNewGame(h.ctx, SEED, { inStation: false, character: { profile: defaultCharacter(), gear: officerPreset('patrolStandard') } }),
    );
    return { h, session };
  }

  /** Checks `id` out, gets in and out of it so it is the last-driven car. */
  function drive(h: Harness, session: GameSession, id: string): DrivableVehicle {
    expect(session.checkOut(id).ok).toBe(true);
    const v = unit(session, id);
    session.enterVehicle(v);
    h.step(session, 2);
    expect(session.exitVehicle()).toBe('exited');
    return v;
  }

  it('the locker gear carries into the officer kit: added items are picked up, removed ones put down', () => {
    const { session } = begin();
    // This start is outdoors (no shift-start grant): the officer carries the med kit the standard loadout grants.
    session.officerKit.adjust('firstAid', 1);
    expect(session.officerKit.carried('halligan')).toBe(0);
    const base = session.gear.loadout;
    const without = { assignment: base.assignment, items: base.items.filter((i) => i.id !== 'medKit') };
    session.setGear({ assignment: base.assignment, items: [...without.items, { id: 'halligan', count: 1 }, { id: 'k9Treats', count: 3 }] });
    expect(session.officerKit.carried('halligan')).toBe(1);
    expect(session.officerKit.carried('k9Treats')).toBe(3);
    expect(session.officerKit.carried('firstAid')).toBe(0);
    expect(session.gear.has('halligan')).toBe(true);
    // Taking them off again puts them down; what was never granted (a trunk item) is not touched by the delta.
    session.setGear(base);
    expect(session.officerKit.carried('halligan')).toBe(0);
    expect(session.officerKit.carried('k9Treats')).toBe(0);
    expect(session.officerKit.carried('firstAid')).toBe(1);
  });

  it('locker rows other than the vest never add a vest, and the Vest row shows the real gear', () => {
    const { h, session } = begin();
    const base = session.gear.loadout;
    session.setGear({ assignment: base.assignment, items: base.items.filter((i) => i.id !== 'ballisticVest') });
    expect(session.gear.has('ballisticVest')).toBe(false);
    expect(session.station.loadout.vest).toBe(false);
    for (const field of ['flashlight', 'bodycamMount', 'radioAudio', 'uniform'] as const) {
      session.station.request({ kind: 'loadout', field });
      h.step(session, 1);
      expect(session.gear.has('ballisticVest')).toBe(false);
    }
    // The Vest row itself still toggles the gear, both ways.
    session.station.request({ kind: 'loadout', field: 'vest' });
    h.step(session, 1);
    expect(session.gear.has('ballisticVest')).toBe(true);
    session.station.request({ kind: 'loadout', field: 'vest' });
    h.step(session, 1);
    expect(session.gear.has('ballisticVest')).toBe(false);
  });

  it('a long gun in the loadout is in the officer\'s hands and follows the locker', () => {
    const { session } = begin();
    expect(session.officerKit.longGun).toBeNull();
    const base = session.gear.loadout;
    session.setGear({ assignment: base.assignment, items: [...base.items, { id: 'shotgun', count: 1 }] });
    expect(session.officerKit.longGun).toBe('shotgun');
    session.setGear(base);
    expect(session.officerKit.longGun).toBeNull();
    // A gun taken from the rack is not replaced by the loadout, nor dropped when the loadout loses its own.
    session.officerKit.setLongGun('rifle');
    session.setGear({ assignment: base.assignment, items: [...base.items, { id: 'shotgun', count: 1 }] });
    expect(session.officerKit.longGun).toBe('rifle');
    session.setGear(base);
    expect(session.officerKit.longGun).toBe('rifle');
  });

  it('a K9 unit (partition, no cage seat) is never the arrest car', () => {
    const { h, session } = begin();
    const k9 = drive(h, session, 'K-501');
    expect(k9.model.id).toBe('k9_suv');
    expect(session.arrestVehicle()?.model.id).not.toBe('k9_suv');
  });

  it('the prisoner van takes several prisoners and each is released on their own booking', () => {
    const { h, session } = begin();
    const van = drive(h, session, 'J-801');
    const eq = session.equipmentOf(van);
    expect(eq?.cageSeats).toBeGreaterThan(2);
    expect(session.arrestVehicle()).toBe(van);
    expect(session.seatPrisoner(7)).toBe(true);
    // Still the arrest car with a prisoner aboard, and still holds the next one.
    expect(session.arrestVehicle()).toBe(van);
    expect(session.seatPrisoner(8)).toBe(true);
    expect(eq?.prisoners()).toEqual([7, 8]);
    expect(session.prisoner()).toBe(7);
    expect(session.prisoner(8)).toBe(8);
    expect(session.releasePrisoner(8)).toBe(8);
    expect(eq?.prisoners()).toEqual([7]);
    expect(session.releasePrisoner(8)).toBe(-1);
    expect(session.releasePrisoner(-1)).toBe(7);
    expect(session.prisoner()).toBe(-1);
  });

  it('the station pump does not repair a fleet unit for free: it goes to the fleet counter', () => {
    const { h, session } = begin();
    const car = drive(h, session, 'M-601');
    const pump = (session as unknown as { pumps: number[] }).pumps;
    const px = pump[0] ?? 0;
    const pz = pump[1] ?? 0;
    placeVehicle(session, car, px + 3, pz);
    placeOfficer(session, px, pz);
    car.burstTire(0);
    h.step(session, 2);
    expect(car.needsRepair).toBe(true);
    const hint = session.interactHint();
    expect(hint).not.toBe('repair');
    expect(session.interact()).not.toBe('repaired');
    expect(car.needsRepair).toBe(true);
    expect(session.fleet.ledger.entries()).toHaveLength(0);
  });

  it('service happens only in the yard', () => {
    const { h, session } = begin();
    expect(session.unitInYard('P-101')).toBe(true);
    const boat = unit(session, 'MAR-1');
    expect(session.unitInYard('MAR-1')).toBe(true);
    placeVehicle(session, boat, 0, 0);
    expect(session.unitInYard('MAR-1')).toBe(false);
    boat.refuel(1);
    session.fleet.request({ kind: 'service', unitId: 'MAR-1', service: 'oil' });
    h.step(session, 2);
    expect(session.fleet.ledger.entries()).toHaveLength(0);
    expect(session.unitInYard('K-501')).toBe(false);
  });

  it('a livery restocks the unit: its loadout replaces the trunk, and a livery without one clears it back to the default', () => {
    const { session } = begin();
    const def = session.fleet.loadout('P-101');
    const eq = session.equipmentOf(unit(session, 'P-101'));
    expect(eq?.trunkCount('flares')).toBe(def.trunk['flares'] ?? 0);
    const custom = { ...defaultLivery('patrolMarked'), id: 'custom-1', name: 'Custom', loadout: { ...def, trunk: { ...def.trunk, flares: 5 } } };
    expect(session.assignLivery('P-101', custom)).toBe(true);
    expect(session.fleet.loadout('P-101').trunk['flares']).toBe(5);
    expect(eq?.trunkCount('flares')).toBe(5);
    expect(session.inspectionInput('P-101')?.loadoutMissing).toEqual([]);
    // "Use default" then Save: the loadout of the document is null.
    const plain = { ...custom, id: 'custom-2', name: 'Plain', loadout: null };
    expect(session.assignLivery('P-101', plain)).toBe(true);
    expect(session.fleet.loadout('P-101')).toEqual(def);
    expect(session.equipmentOf(unit(session, 'P-101'))?.trunkCount('flares')).toBe(def.trunk['flares'] ?? 0);
  });
});

describe('door panel', () => {
  function panelFor(carried: Record<string, number>) {
    const session = {
      interiors: {
        layout: () => ({ kind: 'house', doors: [{ kind: 'door', strength: 0.3, lockable: true }] }),
        doorState: () => 'closed',
      },
      officerKit: { carried: (id: string) => carried[id] ?? 0 },
      canvassAllowed: () => false,
    } as unknown as GameSession;
    const target: DoorTarget = { buildingId: 1, door: 0, outdoors: true, locked: false };
    return doorPanelModel(session, target).options[4];
  }

  it('forces entry with a Halligan bar or a ram, and says what is missing', () => {
    expect(panelFor({})).toMatchObject({ label: 'Force entry', detail: 'No ram or Halligan (trunk)', enabled: false });
    expect(panelFor({ halligan: 1 })).toMatchObject({ label: 'Force entry', detail: '', enabled: true });
    expect(panelFor({ ram: 1 })).toMatchObject({ label: 'Force entry', enabled: true });
  });
});
