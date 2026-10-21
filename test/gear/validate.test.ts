import { describe, expect, it } from 'vitest';
import { OFFICER_PRESETS, REQUIRED_OFFICER_PRESETS } from '../../src/gear/data';
import {
  defaultVehicleLoadout,
  loadoutWeightKg,
  officerPreset,
  validateOfficerLoadout,
  validateVehicleLoadout,
} from '../../src/gear/validate';
import type { GearIssueCode, LoadoutValidation, OfficerLoadout, VehicleCapacity } from '../../src/gear/types';

const codes = (v: LoadoutValidation): GearIssueCode[] => v.errors.map((e) => e.code);
const warnCodes = (v: LoadoutValidation): GearIssueCode[] => v.warnings.map((e) => e.code);

/** The `patrolStandard` preset with edits applied. */
function patrol(edit: (l: OfficerLoadout) => void): OfficerLoadout {
  const l = officerPreset('patrolStandard');
  edit(l);
  return l;
}
const without = (l: OfficerLoadout, ...ids: string[]): void => {
  l.items = l.items.filter((it) => !ids.includes(it.id));
};

describe('officer presets', () => {
  it('defines the ten presets and every one validates cleanly against its assignment', () => {
    expect(Object.keys(OFFICER_PRESETS).sort()).toEqual([...REQUIRED_OFFICER_PRESETS].sort());
    for (const id of REQUIRED_OFFICER_PRESETS) {
      const v = validateOfficerLoadout(officerPreset(id));
      expect(v.errors, id).toEqual([]);
      expect(v.ok, id).toBe(true);
      expect(v.warnings, id).toEqual([]);
    }
  });

  it('patrolStandard holds the listed items and weighs 8.75 kg', () => {
    const l = officerPreset('patrolStandard');
    expect(l.assignment).toBe('patrol');
    expect(l.items.map((i) => `${i.id}x${String(i.count)}`)).toEqual([
      'radiox1', 'dutyBeltx1', 'holsterx1', 'sidearmx1', 'taserx1', 'ocSprayx1', 'batonx1', 'cuffsx2', 'flashlightx1',
      'medKitx1', 'naloxonex2', 'tourniquetx1', 'ballisticVestx1',
    ]);
    expect(l.items.find((i) => i.id === 'holster')?.retention).toBe(2);
    expect(loadoutWeightKg(l)).toBe(8.75);
    expect(validateOfficerLoadout(l).weightKg).toBe(8.75);
    expect(validateOfficerLoadout(l).capacityKg).toBe(14);
  });

  it('officerPreset returns deep copies and throws on an unknown id', () => {
    const a = officerPreset('swatOperator');
    a.items[0]!.count = 9;
    a.items.pop();
    expect(officerPreset('swatOperator').items[0]?.count).toBe(1);
    expect(() => officerPreset('nobody')).toThrow(/Unknown officer preset "nobody"/);
  });

  it('assignment rules: detective rejects a rifle, motor rejects the ram, SWAT requires retention 3', () => {
    const det = officerPreset('detective');
    det.items.push({ id: 'rifle', count: 1 });
    const dv = validateOfficerLoadout(det);
    expect(dv.ok).toBe(false);
    expect(dv.errors.find((e) => e.code === 'forbidden')?.item).toBe('rifle');
    expect(codes(dv)).toContain('tooManyLongGuns');

    const motor = officerPreset('motorOfficer');
    motor.items.push({ id: 'ram', count: 1 });
    const mv = validateOfficerLoadout(motor);
    expect(mv.errors.find((e) => e.code === 'forbidden')?.item).toBe('ram');

    const swat = officerPreset('swatOperator');
    expect(validateOfficerLoadout(swat).ok).toBe(true);
    swat.items.find((i) => i.id === 'holster')!.retention = 2;
    const sv = validateOfficerLoadout(swat);
    expect(sv.ok).toBe(false);
    expect(codes(sv)).toEqual(['retentionTooLow']);
    expect(sv.errors[0]?.item).toBe('holster');
  });

  it('the K9 assignment requires treats', () => {
    const k9 = officerPreset('k9Handler');
    expect(validateOfficerLoadout(k9).ok).toBe(true);
    without(k9, 'k9Treats');
    const v = validateOfficerLoadout(k9);
    expect(v.errors).toEqual([expect.objectContaining({ code: 'missingRequired', item: 'k9Treats' })]);
    // the same loadout is fine for patrol
    expect(validateOfficerLoadout({ ...k9, assignment: 'patrol' }).ok).toBe(true);
  });
});

describe('officer loadout issue codes', () => {
  it('unknownItem', () => {
    const v = validateOfficerLoadout(patrol((l) => l.items.push({ id: 'ghost', count: 1 })));
    expect(v.errors).toEqual([expect.objectContaining({ code: 'unknownItem', item: 'ghost' })]);
    expect(loadoutWeightKg(patrol((l) => l.items.push({ id: 'ghost', count: 5 })))).toBe(8.75); // unknown ids weigh nothing
  });

  it('countRange: zero, above max, fractional and duplicate ids', () => {
    expect(codes(validateOfficerLoadout(patrol((l) => (l.items.find((i) => i.id === 'cuffs')!.count = 3))))).toContain('countRange');
    expect(codes(validateOfficerLoadout(patrol((l) => (l.items.find((i) => i.id === 'naloxone')!.count = 4))))).toContain('countRange');
    expect(codes(validateOfficerLoadout(patrol((l) => (l.items.find((i) => i.id === 'baton')!.count = 0))))).toEqual(['countRange']);
    expect(codes(validateOfficerLoadout(patrol((l) => (l.items.find((i) => i.id === 'baton')!.count = 1.5))))).toEqual(['countRange']);
    expect(codes(validateOfficerLoadout(patrol((l) => l.items.push({ id: 'taser', count: 1 }))))).toContain('countRange');
    // a count above max still weighs and takes room (and the item is listed, so it is not "missing")
    const v = validateOfficerLoadout(patrol((l) => (l.items.find((i) => i.id === 'cuffs')!.count = 3)));
    expect(v.weightKg).toBe(9.05);
    // a count below 1 is ignored
    expect(validateOfficerLoadout(patrol((l) => (l.items.find((i) => i.id === 'cuffs')!.count = 0))).weightKg).toBe(8.15);
  });

  it('overweight: an error over the limit, a warning above 85 %', () => {
    const heavy = validateOfficerLoadout(patrol((l) => l.items.push({ id: 'rifle', count: 1 }, { id: 'halligan', count: 1 })));
    expect(heavy.ok).toBe(false);
    expect(heavy.weightKg).toBe(17.15);
    expect(codes(heavy)).toEqual(['overweight']);
    expect(warnCodes(heavy)).toEqual([]);

    const close = validateOfficerLoadout(patrol((l) => l.items.push({ id: 'rifle', count: 1 })));
    expect(close.weightKg).toBe(12.15);
    expect(close.ok).toBe(true);
    expect(warnCodes(close)).toEqual(['overweight']);
  });

  it('slotsFull: belt, vest, body, longGun and carry', () => {
    const noBelt = validateOfficerLoadout(patrol((l) => without(l, 'dutyBelt')));
    expect(codes(noBelt)).toContain('slotsFull');
    expect(noBelt.slots.belt).toEqual({ used: 12, cap: 0 });
    expect(codes(noBelt)).toContain('missingRequired');
    const twoLong = validateOfficerLoadout(patrol((l) => l.items.push({ id: 'rifle', count: 1 }, { id: 'shotgun', count: 1 })));
    expect(twoLong.slots.longGun).toEqual({ used: 2, cap: 1 });
    expect(codes(twoLong)).toContain('slotsFull');
    expect(codes(twoLong)).toContain('tooManyLongGuns');
    const carry = validateOfficerLoadout(patrol((l) => l.items.push({ id: 'ram', count: 1 }, { id: 'halligan', count: 1 })));
    expect(carry.slots.carry).toEqual({ used: 3, cap: 2 });
    expect(codes(carry)).toContain('slotsFull');
    const belt = validateOfficerLoadout(patrol((l) => l.items.push({ id: 'cuffs', count: 1 })));
    expect(codes(belt)).toContain('countRange'); // cuffs listed twice
  });

  it('missingRequired and forbidden', () => {
    const v = validateOfficerLoadout(patrol((l) => without(l, 'flashlight', 'cuffs')));
    expect(v.errors.map((e) => e.item)).toEqual(['cuffs', 'flashlight']);
    expect(codes(v)).toEqual(['missingRequired', 'missingRequired']);
    const traffic = officerPreset('trafficStandard');
    traffic.items.push({ id: 'ram', count: 1 });
    expect(validateOfficerLoadout(traffic).errors.find((e) => e.code === 'forbidden')?.item).toBe('ram');
  });

  it('retentionMissing and retentionTooLow', () => {
    const missing = validateOfficerLoadout(patrol((l) => delete l.items.find((i) => i.id === 'holster')!.retention));
    expect(missing.errors).toEqual([expect.objectContaining({ code: 'retentionMissing', item: 'holster' })]);
    const low = validateOfficerLoadout(patrol((l) => (l.items.find((i) => i.id === 'holster')!.retention = 1)));
    expect(low.errors).toEqual([expect.objectContaining({ code: 'retentionTooLow', item: 'holster' })]);
    // the detective policy accepts level 1
    const det = officerPreset('detective');
    det.items.find((i) => i.id === 'holster')!.retention = 1;
    expect(validateOfficerLoadout(det).ok).toBe(true);
  });

  it('tooManyLongGuns', () => {
    const motor = officerPreset('motorOfficer');
    motor.items.push({ id: 'shotgun', count: 1 });
    expect(codes(validateOfficerLoadout(motor))).toEqual(expect.arrayContaining(['forbidden', 'tooManyLongGuns']));
    const air = officerPreset('airCrew');
    air.items.push({ id: 'rifle', count: 1 });
    expect(codes(validateOfficerLoadout(air))).toEqual(['tooManyLongGuns']);
    const marine = officerPreset('marineUnit');
    marine.items.push({ id: 'rifle', count: 1 });
    expect(validateOfficerLoadout(marine).ok).toBe(true); // one long gun is allowed
  });

  it('requiresItem: the sidearm needs a holster', () => {
    const v = validateOfficerLoadout(patrol((l) => without(l, 'holster')));
    expect(codes(v)).toEqual(['missingRequired', 'requiresItem']);
    expect(v.errors[1]?.item).toBe('sidearm');
  });

  it('collects every failure in the documented order', () => {
    const l: OfficerLoadout = { assignment: 'detective', items: [{ id: 'ghost', count: 1 }, { id: 'rifle', count: 1 }, { id: 'rifle', count: 1 }] };
    expect(codes(validateOfficerLoadout(l))).toEqual([
      'unknownItem', 'countRange', 'slotsFull', 'overweight', 'missingRequired', 'missingRequired', 'missingRequired', 'missingRequired',
      'forbidden', 'tooManyLongGuns',
    ]);
  });

  it('warns when a patrol, traffic or supervisor loadout has no TASER', () => {
    for (const [id, taser] of [['patrolStandard', true], ['trafficStandard', true], ['supervisor', true], ['detective', false], ['swatOperator', false]] as const) {
      const l = officerPreset(id);
      if (taser) without(l, 'taser');
      const v = validateOfficerLoadout(l);
      expect(v.ok, id).toBe(true);
      expect(v.warnings.some((w) => w.code === 'missingRequired' && w.item === 'taser'), id).toBe(taser);
    }
  });

  it('an unknown assignment is checked against the patrol policy', () => {
    const l = { ...officerPreset('patrolStandard'), assignment: 'astronaut' } as unknown as OfficerLoadout;
    expect(validateOfficerLoadout(l).ok).toBe(true);
  });
});

describe('weight arithmetic', () => {
  it('is exact for counts of small items', () => {
    expect(loadoutWeightKg({ assignment: 'patrol', items: [{ id: 'cuffs', count: 2 }] })).toBe(0.6);
    expect(loadoutWeightKg({ assignment: 'patrol', items: [{ id: 'naloxone', count: 3 }] })).toBe(0.15);
    expect(loadoutWeightKg({ assignment: 'patrol', items: [{ id: 'cuffs', count: 2 }, { id: 'naloxone', count: 3 }, { id: 'ballisticVest', count: 1 }] })).toBe(3.95);
    expect(loadoutWeightKg({ assignment: 'patrol', items: [] })).toBe(0);
    expect(validateOfficerLoadout({ assignment: 'patrol', items: [{ id: 'naloxone', count: 3 }] }).weightKg).toBe(0.15);
  });
});

describe('slot capacity', () => {
  const only = (...items: [string, number][]): OfficerLoadout => ({ assignment: 'detective', items: items.map(([id, count]) => ({ id, count })) });

  it('belt items need a duty belt', () => {
    expect(validateOfficerLoadout(only(['radio', 1])).slots.belt).toEqual({ used: 1, cap: 0 });
    expect(codes(validateOfficerLoadout(only(['radio', 1])))).toContain('slotsFull');
    const withBelt = validateOfficerLoadout(only(['dutyBelt', 1], ['radio', 1]));
    expect(withBelt.slots.belt).toEqual({ used: 1, cap: 12 });
    expect(codes(withBelt)).not.toContain('slotsFull');
    expect(withBelt.slots.body).toEqual({ used: 1, cap: 2 });
  });

  it('vest items need a ballistic vest or the external carrier bonus', () => {
    const treats = only(['k9Treats', 1]);
    expect(validateOfficerLoadout(treats).slots.vest).toEqual({ used: 1, cap: 0 });
    expect(codes(validateOfficerLoadout(treats))).toContain('slotsFull');
    expect(codes(validateOfficerLoadout(treats, { extraVestSlots: 2 }))).not.toContain('slotsFull');
    expect(validateOfficerLoadout(treats, { extraVestSlots: 2 }).slots.vest).toEqual({ used: 1, cap: 2 });

    const withVest = only(['ballisticVest', 1], ['k9Treats', 3], ['evidenceKit', 1]);
    expect(validateOfficerLoadout(withVest).slots.vest).toEqual({ used: 5, cap: 4 });
    expect(codes(validateOfficerLoadout(withVest))).toContain('slotsFull');
    expect(validateOfficerLoadout(withVest, { extraVestSlots: 2 }).slots.vest).toEqual({ used: 5, cap: 6 });
    expect(codes(validateOfficerLoadout(withVest, { extraVestSlots: 2 }))).not.toContain('slotsFull');
    expect(validateOfficerLoadout(only(['ballisticVest', 1], ['evidenceKit', 1])).slots.vest).toEqual({ used: 2, cap: 4 });
  });

  it('has the base capacities body 2, longGun 1, carry 2', () => {
    const v = validateOfficerLoadout(only());
    expect(v.slots).toEqual({ belt: { used: 0, cap: 0 }, vest: { used: 0, cap: 0 }, body: { used: 0, cap: 2 }, longGun: { used: 0, cap: 1 }, carry: { used: 0, cap: 2 } });
  });
});

describe('vehicle loadouts', () => {
  const sedan: VehicleCapacity = { kg: 150, slots: 30, rackSlots: 2 };
  const bicycle: VehicleCapacity = { kg: 12, slots: 4, rackSlots: 0 };

  it('the patrol trunk loadout fits patrol_sedan cargo', () => {
    const l = defaultVehicleLoadout('patrol', true);
    expect(l.rack).toEqual(['shotgun', 'rifle']);
    expect(l.trunk.cones).toBe(6);
    const v = validateVehicleLoadout(l, sedan, 'patrol');
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.weightKg).toBe(63.1);
    expect(v.capacityKg).toBe(150);
    expect(v.slots.carry).toEqual({ used: 26, cap: 30 });
    expect(v.slots.longGun).toEqual({ used: 2, cap: 2 });
  });

  it('every shipped trunk loadout fits its fleet class vehicle and carries what the class requires', () => {
    const caps: Record<string, VehicleCapacity> = {
      patrol: sedan, supervisor: { kg: 220, slots: 30, rackSlots: 2 }, unmarked: { kg: 150, slots: 24, rackSlots: 2 },
      traffic: { kg: 150, slots: 26, rackSlots: 1 }, k9: { kg: 200, slots: 28, rackSlots: 1 }, motor: { kg: 25, slots: 6, rackSlots: 0 },
      bicycle, atv: { kg: 40, slots: 8, rackSlots: 0 }, swat: { kg: 900, slots: 80, rackSlots: 4 }, armored: { kg: 600, slots: 50, rackSlots: 4 },
      transport: { kg: 120, slots: 16, rackSlots: 0 }, command: { kg: 800, slots: 80, rackSlots: 2 }, lab: { kg: 500, slots: 60, rackSlots: 0 },
      marine: { kg: 400, slots: 30, rackSlots: 2 }, air: { kg: 150, slots: 12, rackSlots: 0 },
    };
    for (const [cls, cap] of Object.entries(caps)) {
      const v = validateVehicleLoadout(defaultVehicleLoadout(cls === 'unmarked' ? 'unmarked' : cls, false), cap, cls);
      expect(v.errors, cls).toEqual([]);
    }
  });

  it('a ram in a bicycle fails on weight and slots', () => {
    const l = defaultVehicleLoadout('bicycle', false);
    expect(validateVehicleLoadout(l, bicycle, 'bicycle').ok).toBe(true);
    l.trunk.ram = 1;
    const v = validateVehicleLoadout(l, bicycle, 'bicycle');
    expect(v.ok).toBe(false);
    expect(codes(v)).toEqual(['cargoWeight', 'cargoSlots']);
    expect(v.weightKg).toBe(17.65);
    expect(v.slots.carry).toEqual({ used: 5, cap: 4 });
  });

  it('three long guns in a 2-slot rack fail; non-rack items are refused', () => {
    const rack3 = { trunk: {}, rack: ['shotgun', 'rifle', 'lessLethal'] };
    const v = validateVehicleLoadout(rack3, sedan, null);
    expect(codes(v)).toEqual(['rackFull']);
    expect(validateVehicleLoadout({ trunk: {}, rack: ['shotgun', 'rifle'] }, sedan, null).ok).toBe(true);
    expect(validateVehicleLoadout({ trunk: {}, rack: ['shotgun'] }, bicycle, null).errors.map((e) => e.code)).toEqual(['rackFull']);
    const bad = validateVehicleLoadout({ trunk: {}, rack: ['bazooka'] }, sedan, null);
    expect(bad.errors).toEqual([expect.objectContaining({ code: 'notRackItem', item: 'bazooka' })]);
  });

  it('unknownTrunkItem and countRange', () => {
    const v = validateVehicleLoadout({ trunk: { ghost: 1, cones: 100, flares: -1, aed: 1.5 }, rack: [] }, sedan, null);
    expect(v.errors.map((e) => `${e.code}:${String(e.item)}`)).toEqual(['unknownTrunkItem:ghost', 'countRange:cones', 'countRange:flares', 'countRange:aed']);
    expect(validateVehicleLoadout({ trunk: { cones: 99 }, rack: [] }, { kg: 1000, slots: 1000, rackSlots: 0 }, null).ok).toBe(true);
    expect(validateVehicleLoadout({ trunk: { cones: 0 }, rack: [] }, sedan, null).ok).toBe(true);
  });

  it('missingVehicleItem: the class requires its items; null skips the check', () => {
    const empty = { trunk: {}, rack: [] };
    const v = validateVehicleLoadout(empty, sedan, 'patrol');
    expect(v.errors.map((e) => `${e.code}:${String(e.item)}`)).toEqual(['missingVehicleItem:firstAid', 'missingVehicleItem:aed', 'missingVehicleItem:cones', 'missingVehicleItem:flares']);
    expect(validateVehicleLoadout(empty, sedan, null).ok).toBe(true);
    expect(validateVehicleLoadout(empty, sedan, 'drone').ok).toBe(true); // no requirement listed
    expect(validateVehicleLoadout({ trunk: { firstAid: 0 }, rack: [] }, sedan, 'transport').ok).toBe(false);
  });

  it('the K9 vehicle class requires treats', () => {
    const k9 = defaultVehicleLoadout('k9', false);
    expect(validateVehicleLoadout(k9, { kg: 200, slots: 28, rackSlots: 1 }, 'k9').ok).toBe(true);
    delete k9.trunk.k9Treats;
    const v = validateVehicleLoadout(k9, { kg: 200, slots: 28, rackSlots: 1 }, 'k9');
    expect(v.errors).toEqual([expect.objectContaining({ code: 'missingVehicleItem', item: 'k9Treats' })]);
  });

  it('defaultVehicleLoadout copies the data, handles null and throws on unknown ids', () => {
    const a = defaultVehicleLoadout('patrol', true);
    a.trunk.cones = 99;
    a.rack.pop();
    expect(defaultVehicleLoadout('patrol', true).trunk.cones).toBe(6);
    expect(defaultVehicleLoadout('patrol', true).rack).toEqual(['shotgun', 'rifle']);
    expect(defaultVehicleLoadout(null, false)).toEqual({ trunk: {}, rack: [] });
    expect(defaultVehicleLoadout(null, true).rack).toEqual(['shotgun', 'rifle']);
    expect(defaultVehicleLoadout('patrol', false).rack).toEqual([]);
    expect(() => defaultVehicleLoadout('nope', false)).toThrow(/Unknown trunk loadout "nope"/);
  });
});
