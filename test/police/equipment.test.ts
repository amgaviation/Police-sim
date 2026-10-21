import { describe, expect, it } from 'vitest';
import { createGameWorld, spawn } from '../../src/ecs/world';
import { PoliceLights, SIREN_FLAG, attachPoliceLights } from '../../src/police/components';
import {
  PatrolEquipment,
  RACK_ITEMS,
  SIREN_TONES,
  SPOTLIGHT,
  isEquipmentSave,
  type EquipmentSave,
  type VehicleEquipmentSpec,
} from '../../src/police/equipment';
import { OfficerKit, TRUNK_ITEMS, emptyOfficerKit, isOfficerKitSave } from '../../src/police/inventory';
import { LIGHTBAR_PATTERNS, patternIndex } from '../../src/police/lightbar';
import { vehicleModel } from '../../src/vehicles/model';

const FULL: VehicleEquipmentSpec = {
  pushBumper: { frontStrength: 1.8, engineShare: 0.5 },
  partition: true,
  rack: true,
  spotlight: true,
  mdt: true,
  trunk: 'patrol',
};
const BARE: VehicleEquipmentSpec = { pushBumper: null, partition: false, rack: false, spotlight: false, mdt: false, trunk: null };

describe('PatrolEquipment', () => {
  it('starts with the data defaults', () => {
    const eq = new PatrolEquipment(FULL);
    expect(eq.sirenOn).toBe(false);
    expect(eq.tone).toBe('wail');
    expect(eq.pattern).toBe(0);
    expect(eq.spotOn).toBe(false);
    expect(eq.spotYaw).toBe(SPOTLIGHT.defaultYaw);
    expect(eq.spotPitch).toBe(SPOTLIGHT.defaultPitch);
    expect(eq.rackLocked).toBe(true);
    for (const r of RACK_ITEMS) expect(eq.rackHas(r.id)).toBe(r.id !== 'lessLethal');
    expect(eq.rackHas('lessLethal')).toBe(false);
    expect(eq.trunkCount('cones')).toBe(6);
    expect(eq.trunkCount('naloxone')).toBe(2);
    expect(eq.trunkCount('tourniquet')).toBe(2);
    expect(eq.trunkCount('halligan')).toBe(1);
    expect(eq.trunkCount('flares')).toBe(8);
    expect(eq.trunkCount('aed')).toBe(1);
    expect(eq.trunkCount('nothing')).toBe(0);
    expect(eq.prisoner).toBe(-1);

    const bare = new PatrolEquipment(BARE);
    expect(bare.rackHas('shotgun')).toBe(false);
    for (const it of TRUNK_ITEMS) expect(bare.trunkCount(it.id)).toBe(0);
    expect(() => new PatrolEquipment({ ...BARE, trunk: 'armoury' })).toThrow(/Unknown trunk loadout "armoury"/);
  });

  it('works for both patrol models', () => {
    for (const id of ['patrol_sedan', 'patrol_suv']) {
      const spec = vehicleModel(id).equipment;
      expect(spec).not.toBeNull();
      expect(new PatrolEquipment(spec!).trunkCount('cones')).toBe(6);
    }
  });

  it('siren: toggle, tone cycle wraps, set tone', () => {
    const eq = new PatrolEquipment(FULL);
    eq.toggleSiren();
    expect(eq.sirenOn).toBe(true);
    const seen: string[] = [];
    for (let i = 0; i < SIREN_TONES.length + 1; i++) {
      seen.push(eq.tone);
      eq.cycleTone();
    }
    expect(seen).toEqual(['wail', 'yelp', 'phaser', 'hilo', 'wail']);
    expect(eq.setTone('hilo')).toBe(true);
    expect(eq.tone).toBe('hilo');
    eq.toggleSiren();
    expect(eq.sirenOn).toBe(false);
  });

  it('pattern: cycle wraps, set clamps', () => {
    const eq = new PatrolEquipment(FULL);
    for (let i = 1; i < LIGHTBAR_PATTERNS.length; i++) {
      eq.cyclePattern();
      expect(eq.pattern).toBe(i);
    }
    eq.cyclePattern();
    expect(eq.pattern).toBe(0);
    eq.setPattern(99);
    expect(eq.pattern).toBe(LIGHTBAR_PATTERNS.length - 1);
    eq.setPattern(-4);
    expect(eq.pattern).toBe(0);
    eq.setPattern(2.7);
    expect(eq.pattern).toBe(2);
    eq.setPattern(Number.NaN);
    expect(eq.pattern).toBe(0);
  });

  it('spotlight: toggles only when fitted, aim clamps to the limits', () => {
    const eq = new PatrolEquipment(FULL);
    eq.toggleSpot();
    expect(eq.spotOn).toBe(true);
    eq.aimSpot(0.1, 0.05);
    expect(eq.spotYaw).toBeCloseTo(SPOTLIGHT.defaultYaw + 0.1, 10);
    expect(eq.spotPitch).toBeCloseTo(SPOTLIGHT.defaultPitch + 0.05, 10);
    eq.aimSpot(100, 100);
    expect([eq.spotYaw, eq.spotPitch]).toEqual([SPOTLIGHT.yawMax, SPOTLIGHT.pitchMax]);
    eq.aimSpot(-100, -100);
    expect([eq.spotYaw, eq.spotPitch]).toEqual([SPOTLIGHT.yawMin, SPOTLIGHT.pitchMin]);
    const bare = new PatrolEquipment(BARE);
    bare.toggleSpot();
    expect(bare.spotOn).toBe(false);
  });

  it('rack: refuses to unlock while moving, checks long guns out and in', () => {
    const eq = new PatrolEquipment(FULL);
    const kit = new OfficerKit();
    expect(eq.checkOut('shotgun', kit)).toBe(false); // locked
    expect(eq.toggleRackLock(false)).toBe(false); // moving
    expect(eq.rackLocked).toBe(true);
    expect(eq.toggleRackLock(true)).toBe(true);
    expect(eq.rackLocked).toBe(false);

    expect(eq.checkOut('cannon', kit)).toBe(false);
    expect(eq.checkOut('shotgun', kit)).toBe(true);
    expect(kit.longGun).toBe('shotgun');
    expect(eq.rackHas('shotgun')).toBe(false);
    expect(eq.checkOut('rifle', kit)).toBe(false); // one long gun at a time
    expect(eq.checkOut('shotgun', kit)).toBe(false); // not racked
    expect(eq.checkIn('rifle', kit)).toBe(false); // not the one carried

    // Locking always works, even while moving.
    expect(eq.toggleRackLock(false)).toBe(true);
    expect(eq.rackLocked).toBe(true);
    expect(eq.checkIn('shotgun', kit)).toBe(true);
    expect(kit.longGun).toBeNull();
    expect(eq.rackHas('shotgun')).toBe(true);

    const bare = new PatrolEquipment(BARE);
    expect(bare.toggleRackLock(true)).toBe(false);
    expect(bare.rackLocked).toBe(true);
  });

  it('trunk: take needs stock and room under carryMax, stow needs a carried item', () => {
    const eq = new PatrolEquipment(FULL);
    const kit = new OfficerKit();
    const conesMax = TRUNK_ITEMS.find((i) => i.id === 'cones')!.carryMax;
    for (let i = 0; i < conesMax; i++) expect(eq.take('cones', kit)).toBe(true);
    expect(eq.take('cones', kit)).toBe(false); // hands full
    expect(kit.carried('cones')).toBe(conesMax);
    expect(eq.trunkCount('cones')).toBe(6 - conesMax);

    expect(eq.take('aed', kit)).toBe(true);
    expect(eq.trunkCount('aed')).toBe(0);
    expect(eq.stow('aed', kit)).toBe(true);
    expect(eq.stow('aed', kit)).toBe(false); // none carried
    expect(eq.trunkCount('aed')).toBe(1);
    expect(eq.take('unicorn', kit)).toBe(false);

    const empty = new PatrolEquipment(BARE);
    const kit2 = new OfficerKit();
    expect(empty.take('flares', kit2)).toBe(false); // trunk empty
    expect(eq.take('flares', kit2)).toBe(true);
    expect(empty.stow('flares', kit2)).toBe(true);
    expect(empty.trunkCount('flares')).toBe(1);
  });

  it('cage: needs a partition and an empty seat; release returns the id', () => {
    const eq = new PatrolEquipment(FULL);
    expect(eq.seatPrisoner(-3)).toBe(false);
    expect(eq.seatPrisoner(4711)).toBe(true);
    expect(eq.prisoner).toBe(4711);
    expect(eq.seatPrisoner(12)).toBe(false);
    expect(eq.releasePrisoner()).toBe(4711);
    expect(eq.prisoner).toBe(-1);
    expect(eq.releasePrisoner()).toBe(-1);
    expect(new PatrolEquipment(BARE).seatPrisoner(1)).toBe(false);
  });

  it('cage: a multi-seat cage fills the first free seat and releases the last occupied one', () => {
    const eq = new PatrolEquipment(FULL, { cageSeats: 3 });
    expect(eq.cageSeats).toBe(3);
    expect(eq.cageFree()).toBe(3);
    expect(eq.seatPrisoner(10)).toBe(true);
    expect(eq.seatPrisoner(11)).toBe(true);
    expect(eq.seatPrisoner(11)).toBe(false); // already in the cage
    expect(eq.seatPrisoner(12)).toBe(true);
    expect(eq.seatPrisoner(13)).toBe(false); // full
    expect(eq.prisoner).toBe(10);
    expect(eq.prisoners()).toEqual([10, 11, 12]);
    expect(eq.cageFree()).toBe(0);
    expect(eq.releasePrisoner()).toBe(12);
    expect(eq.prisoners()).toEqual([10, 11]);
    expect(eq.cageFree()).toBe(1);
    expect(eq.seatPrisoner(14)).toBe(true); // refills the freed seat
    expect(eq.prisoners()).toEqual([10, 11, 14]);
    expect(eq.releaseAll()).toEqual([10, 11, 14]);
    expect(eq.prisoner).toBe(-1);
    expect(eq.cageFree()).toBe(3);
    expect(eq.releaseAll()).toEqual([]);
    expect(eq.releasePrisoner()).toBe(-1);

    // A gap (seat 1 emptied by a restore) is filled first; "first occupied" skips it.
    const gap = PatrolEquipment.restore(FULL, { ...new PatrolEquipment(FULL, { cageSeats: 3 }).serialize(), prisoner: -1, extraPrisoners: [-1, 9] }, { cageSeats: 3 });
    expect(gap.prisoner).toBe(9);
    expect(gap.cageFree()).toBe(2);
    expect(gap.seatPrisoner(5)).toBe(true);
    expect(gap.prisoners()).toEqual([5, 9]);
  });

  it('cage: cageSeats 0 forces no cage; no partition means no seats', () => {
    const none = new PatrolEquipment(FULL, { cageSeats: 0 });
    expect(none.cageSeats).toBe(0);
    expect(none.seatPrisoner(1)).toBe(false);
    expect(none.cageFree()).toBe(0);
    expect(new PatrolEquipment(BARE, { cageSeats: 4 }).seatPrisoner(1)).toBe(false);
    expect(new PatrolEquipment(FULL).cageSeats).toBe(1);
  });

  it('options: trunk and rack override the model loadout', () => {
    const eq = new PatrolEquipment(FULL, { trunk: { cones: 2, naloxone: 3, ghost: 5 }, rack: ['lessLethal', 'rifle'] });
    expect(eq.trunkCount('cones')).toBe(2);
    expect(eq.trunkCount('naloxone')).toBe(3);
    expect(eq.trunkCount('flares')).toBe(0);
    expect(eq.rackHas('lessLethal')).toBe(true);
    expect(eq.rackHas('rifle')).toBe(true);
    expect(eq.rackHas('shotgun')).toBe(false);
    expect(new PatrolEquipment(FULL, { rack: [] }).rackHas('rifle')).toBe(false);
    expect(new PatrolEquipment(BARE, { rack: ['rifle'] }).rackHas('rifle')).toBe(false);
    // restore passes the options through
    const back = PatrolEquipment.restore(FULL, new PatrolEquipment(FULL).serialize(), { trunk: { cones: 1 } });
    expect(back.trunkCount('cones')).toBe(6); // the save wins over the options for known counts
  });

  it('lessLethal is a rack item that is only racked on request', () => {
    expect(RACK_ITEMS.map((r) => r.id)).toEqual(['shotgun', 'rifle', 'lessLethal']);
    const eq = new PatrolEquipment(FULL);
    const kit = new OfficerKit();
    eq.toggleRackLock(true);
    expect(eq.checkOut('lessLethal', kit)).toBe(false);
    const withLl = new PatrolEquipment(FULL, { rack: ['lessLethal'] });
    withLl.toggleRackLock(true);
    expect(withLl.checkOut('lessLethal', kit)).toBe(true);
    expect(kit.longGun).toBe('lessLethal');
  });

  it('save: extraPrisoners round-trips for multi-seat cages and is absent otherwise', () => {
    const single = new PatrolEquipment(FULL);
    single.seatPrisoner(321);
    expect(single.serialize()).not.toHaveProperty('extraPrisoners');

    const eq = new PatrolEquipment(FULL, { cageSeats: 4 });
    eq.seatPrisoner(1);
    eq.seatPrisoner(2);
    eq.seatPrisoner(3);
    const save = eq.serialize();
    expect(save.prisoner).toBe(1);
    expect(save.extraPrisoners).toEqual([2, 3, -1]);
    const json: unknown = JSON.parse(JSON.stringify(save));
    expect(isEquipmentSave(json)).toBe(true);
    const back = PatrolEquipment.restore(FULL, json as EquipmentSave, { cageSeats: 4 });
    expect(back.serialize()).toEqual(save);
    expect(back.prisoners()).toEqual([1, 2, 3]);

    // An old save (no extraPrisoners) loads into a multi-seat cage unchanged; fewer seats drop the extras.
    const old = { ...save };
    delete old.extraPrisoners;
    expect(PatrolEquipment.restore(FULL, old, { cageSeats: 4 }).prisoners()).toEqual([1]);
    expect(PatrolEquipment.restore(FULL, save, { cageSeats: 2 }).prisoners()).toEqual([1, 2]);
    expect(PatrolEquipment.restore(FULL, save).prisoners()).toEqual([1]);
    expect(isEquipmentSave({ ...save, extraPrisoners: [1.5] })).toBe(false);
    expect(isEquipmentSave({ ...save, extraPrisoners: [-2] })).toBe(false);
    expect(isEquipmentSave({ ...save, extraPrisoners: 'x' })).toBe(false);
  });

  it('writeLook writes the PoliceLights store', () => {
    const world = createGameWorld();
    const eid = spawn(world);
    attachPoliceLights(world, eid, 0.5);
    const eq = new PatrolEquipment(FULL);
    eq.writeLook(eid, true);
    expect(eq.lightsOn).toBe(true);
    expect([PoliceLights.pattern[eid], PoliceLights.siren[eid], PoliceLights.sirenFlags[eid], PoliceLights.spot[eid]]).toEqual([0, 0, 0, 0]);
    expect(PoliceLights.spotYaw[eid]).toBeCloseTo(SPOTLIGHT.defaultYaw, 6);
    expect(PoliceLights.spotPitch[eid]).toBeCloseTo(SPOTLIGHT.defaultPitch, 6);

    eq.toggleSiren();
    eq.cycleTone();
    eq.cycleTone();
    eq.setPattern(patternIndex('takedown'));
    eq.toggleSpot();
    eq.aimSpot(0.5, 0.1);
    eq.horn = true;
    eq.manual = true;
    eq.writeLook(eid, false);
    expect(eq.lightsOn).toBe(false);
    expect(PoliceLights.pattern[eid]).toBe(patternIndex('takedown'));
    expect(PoliceLights.siren[eid]).toBe(1 + SIREN_TONES.indexOf('phaser'));
    expect(PoliceLights.sirenFlags[eid]).toBe(SIREN_FLAG.horn | SIREN_FLAG.manual);
    expect(PoliceLights.spot[eid]).toBe(1);
    expect(PoliceLights.spotYaw[eid]).toBeCloseTo(SPOTLIGHT.defaultYaw + 0.5, 6);
    expect(PoliceLights.phase[eid]).toBe(0.5);
    eq.horn = false;
    eq.writeLook(eid, false);
    expect(PoliceLights.sirenFlags[eid]).toBe(SIREN_FLAG.manual);
  });

  it('serialize/restore round-trips through JSON', () => {
    const eq = new PatrolEquipment(FULL);
    const kit = new OfficerKit();
    eq.toggleSiren();
    eq.setTone('yelp');
    eq.setPattern(patternIndex('sweep'));
    eq.toggleSpot();
    eq.aimSpot(0.4, -0.2);
    eq.toggleRackLock(true);
    eq.checkOut('rifle', kit);
    eq.take('cones', kit);
    eq.take('flares', kit);
    eq.seatPrisoner(321);
    const save = eq.serialize();
    expect(save.pattern).toBe('sweep');
    expect(isEquipmentSave(save)).toBe(true);
    const json: unknown = JSON.parse(JSON.stringify(save));
    expect(isEquipmentSave(json)).toBe(true);
    const back = PatrolEquipment.restore(FULL, json as EquipmentSave);
    expect(back.serialize()).toEqual(save);
    expect(back.spotYaw).toBe(eq.spotYaw);
    expect(back.rackHas('rifle')).toBe(false);
    expect(back.trunkCount('cones')).toBe(5);

    const kitSave = kit.serialize();
    expect(kitSave).toEqual({ version: 1, carried: { cones: 1, flares: 1 }, longGun: 'rifle' });
    expect(isOfficerKitSave(JSON.parse(JSON.stringify(kitSave)))).toBe(true);
    expect(OfficerKit.restore(kitSave).serialize()).toEqual(kitSave);
  });

  it('restore falls back to defaults for unknown ids and clamps values', () => {
    const fresh = new PatrolEquipment(FULL).serialize();
    const save: EquipmentSave = {
      ...fresh,
      pattern: 'disco',
      spotYaw: 50,
      spotPitch: -50,
      racked: { shotgun: false, bazooka: true },
      trunk: { cones: 2, rocket: 3 },
      prisoner: 7,
    };
    const eq = PatrolEquipment.restore(FULL, save);
    expect(eq.pattern).toBe(0);
    expect(eq.spotYaw).toBe(SPOTLIGHT.yawMax);
    expect(eq.spotPitch).toBe(SPOTLIGHT.pitchMin);
    expect(eq.rackHas('shotgun')).toBe(false);
    expect(eq.rackHas('rifle')).toBe(true); // missing -> default
    expect(eq.trunkCount('cones')).toBe(2);
    expect(eq.trunkCount('flares')).toBe(8); // missing -> loadout
    expect(eq.serialize().trunk).not.toHaveProperty('rocket');

    // Features the car lacks are dropped.
    const bare = PatrolEquipment.restore(BARE, { ...fresh, spotOn: true, rackLocked: false, prisoner: 7 });
    expect([bare.spotOn, bare.rackLocked, bare.prisoner]).toEqual([false, true, -1]);

    const kit = OfficerKit.restore({ version: 1, carried: { cones: 99, rocket: 1, aed: 1 }, longGun: 'bazooka' });
    expect(kit.serialize()).toEqual({ version: 1, carried: { cones: 4, aed: 1 }, longGun: null });
    expect(OfficerKit.restore(emptyOfficerKit()).serialize()).toEqual(emptyOfficerKit());
  });

  it('save validators reject malformed data', () => {
    const good = new PatrolEquipment(FULL).serialize();
    expect(isEquipmentSave(good)).toBe(true);
    for (const bad of [
      null,
      { ...good, version: 2 },
      { ...good, tone: 'whoop' },
      { ...good, sirenOn: 'yes' },
      { ...good, spotYaw: Number.NaN },
      { ...good, racked: { shotgun: 1 } },
      { ...good, trunk: { cones: -1 } },
      { ...good, trunk: [] },
      { ...good, prisoner: -2 },
      { ...good, prisoner: 1.5 },
    ]) {
      expect(isEquipmentSave(bad)).toBe(false);
    }
    expect(isOfficerKitSave(emptyOfficerKit())).toBe(true);
    for (const bad of [null, { version: 1, carried: {}, longGun: 3 }, { version: 1, carried: { cones: 0.5 }, longGun: null }, { carried: {}, longGun: null }]) {
      expect(isOfficerKitSave(bad)).toBe(false);
    }
  });
});
