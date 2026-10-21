import { describe, expect, it } from 'vitest';
import { GEAR_POLICY } from '../../src/gear/data';
import { MAX_GEAR_PRESETS, OfficerGear, defaultGearSave, isGearSave, officerHit, startingGearSave, type GearSave } from '../../src/gear/officerGear';
import { officerPreset } from '../../src/gear/validate';

describe('OfficerGear', () => {
  it('starts with patrolStandard and a valid, cached validation', () => {
    const g = new OfficerGear();
    expect(g.loadout).toEqual(officerPreset('patrolStandard'));
    expect(g.validation.ok).toBe(true);
    expect(g.validation).toBe(g.validation); // cached
    expect(g.presets()).toEqual([]);
    expect(defaultGearSave()).toEqual({ version: 1, loadout: officerPreset('patrolStandard'), presets: [] });
  });

  it('setLoadout applies even an invalid loadout, copies it and refreshes the validation', () => {
    const g = new OfficerGear();
    const before = g.validation;
    const bad = officerPreset('patrolStandard');
    bad.items = bad.items.filter((i) => i.id !== 'sidearm');
    const v = g.setLoadout(bad);
    expect(v.ok).toBe(false);
    expect(g.validation).toBe(v);
    expect(g.validation).not.toBe(before);
    expect(g.has('sidearm')).toBe(false);
    bad.items.length = 0; // the caller's object is not shared
    expect(g.has('radio')).toBe(true);
    g.setLoadout(officerPreset('swatOperator'));
    expect(g.validation.ok).toBe(true);
    expect(g.loadout.assignment).toBe('swat');
  });

  it('retention reads the holster level (1 without a holster)', () => {
    expect(new OfficerGear().retention()).toBe(2);
    const swat = new OfficerGear();
    swat.setLoadout(officerPreset('swatOperator'));
    expect(swat.retention()).toBe(3);
    const none = new OfficerGear();
    none.setLoadout({ assignment: 'patrol', items: [{ id: 'radio', count: 1 }] });
    expect(none.retention()).toBe(1);
    none.setLoadout({ assignment: 'patrol', items: [{ id: 'holster', count: 1 }] }); // no level chosen
    expect(none.retention()).toBe(1);
  });

  it('protection comes from the vest; setVest adds and removes it', () => {
    const g = new OfficerGear();
    expect(g.protection()).toBe(0.85);
    expect(g.has('ballisticVest')).toBe(true);
    g.setVest(false);
    expect(g.has('ballisticVest')).toBe(false);
    expect(g.protection()).toBe(0);
    expect(g.validation.errors.map((e) => e.code)).toEqual(['missingRequired']);
    g.setVest(false); // idempotent
    g.setVest(true);
    g.setVest(true);
    expect(g.loadout.items.filter((i) => i.id === 'ballisticVest')).toHaveLength(1);
    expect(g.protection()).toBe(0.85);
    expect(g.validation.ok).toBe(true);
  });

  it('kitGrants sums kit x count', () => {
    expect(new OfficerGear().kitGrants()).toEqual({ firstAid: 1, naloxone: 2, tourniquet: 1 });
    const k9 = new OfficerGear();
    k9.setLoadout(officerPreset('k9Handler'));
    expect(k9.kitGrants()).toEqual({ firstAid: 1, naloxone: 1, tourniquet: 1, k9Treats: 3 });
    const swat = new OfficerGear();
    swat.setLoadout(officerPreset('swatOperator'));
    expect(swat.kitGrants()).toEqual({ firstAid: 1, tourniquet: 2, halligan: 1 });
    const g = new OfficerGear();
    g.setLoadout({
      assignment: 'patrol',
      items: [{ id: 'evidenceKit', count: 1 }, { id: 'naloxone', count: 3 }, { id: 'medKit', count: 1 }, { id: 'ram', count: 1 }, { id: 'ghost', count: 4 }, { id: 'radio', count: 1 }],
    });
    expect(g.kitGrants()).toEqual({
      evidenceKit: 1, evidenceBags: 8, evidenceMarkers: 8, camera: 1, fingerprintKit: 1, sceneTape: 1, naloxone: 3, firstAid: 1, ram: 1,
    });
  });

  it('armoryItems lists the loadout weapons in ARMORY_ITEMS order', () => {
    expect(new OfficerGear().armoryItems()).toEqual(['sidearm', 'taser', 'ocSpray', 'baton']);
    const g = new OfficerGear();
    g.setLoadout({
      assignment: 'swat',
      items: [{ id: 'rifle', count: 1 }, { id: 'lessLethalLauncher', count: 1 }, { id: 'baton', count: 1 }, { id: 'sidearm', count: 1 }, { id: 'taser', count: 1 }, { id: 'shotgun', count: 1 }],
    });
    expect(g.armoryItems()).toEqual(['sidearm', 'taser', 'baton', 'beanbag', 'rifle']);
    g.setLoadout({ assignment: 'patrol', items: [] });
    expect(g.armoryItems()).toEqual([]);
  });

  it('extraVestSlots (the external carrier) widens the vest slot', () => {
    const g = new OfficerGear();
    g.setLoadout({ assignment: 'patrol', items: [...officerPreset('patrolStandard').items, { id: 'evidenceKit', count: 1 }, { id: 'k9Treats', count: 3 }] });
    expect(g.validation.slots.vest).toEqual({ used: 5, cap: 4 });
    expect(g.validation.ok).toBe(false);
    g.setExtraVestSlots(2);
    expect(g.validation.slots.vest).toEqual({ used: 5, cap: 6 });
    expect(g.validation.ok).toBe(true);
    g.setExtraVestSlots(Number.NaN);
    expect(g.validation.slots.vest.cap).toBe(4);
  });

  it('presets: save, replace, delete, bounded to eight', () => {
    const g = new OfficerGear();
    expect(g.savePreset('  Day shift  ')).toBe(true);
    expect(g.presets().map((p) => p.name)).toEqual(['Day shift']);
    expect(g.savePreset('')).toBe(false);
    expect(g.savePreset('   ')).toBe(false);
    g.setLoadout(officerPreset('swatOperator'));
    expect(g.savePreset('Day shift')).toBe(true); // replaces
    expect(g.presets()).toHaveLength(1);
    expect(g.presets()[0]?.loadout.assignment).toBe('swat');
    for (let i = 0; i < 20; i++) g.savePreset(`p${String(i)}`);
    expect(g.presets()).toHaveLength(MAX_GEAR_PRESETS);
    expect(g.savePreset('one too many')).toBe(false);
    expect(g.savePreset('Day shift')).toBe(true); // replacing is still fine when full
    g.deletePreset('Day shift');
    g.deletePreset('missing');
    expect(g.presets()).toHaveLength(MAX_GEAR_PRESETS - 1);
    expect(g.savePreset('one more')).toBe(true);
    expect(g.savePreset('x'.repeat(60))).toBe(false); // full again
    g.deletePreset('p0');
    g.savePreset('x'.repeat(60));
    expect(g.presets().at(-1)?.name).toHaveLength(24);
    // the stored loadout is a copy
    g.setLoadout({ assignment: 'patrol', items: [] });
    expect(g.presets()[0]?.loadout.items.length).toBeGreaterThan(0);
  });

  it('serializes through JSON and restores to the same state', () => {
    const g = new OfficerGear();
    g.setLoadout(officerPreset('k9Handler'));
    g.savePreset('Dog day');
    g.setLoadout(officerPreset('detective'));
    const save = g.serialize();
    expect(isGearSave(save)).toBe(true);
    const json: unknown = JSON.parse(JSON.stringify(save));
    expect(isGearSave(json)).toBe(true);
    const back = OfficerGear.restore(json as GearSave);
    expect(back.serialize()).toEqual(save);
    expect(back.loadout.assignment).toBe('detective');
    expect(back.presets()[0]?.name).toBe('Dog day');
    expect(back.kitGrants()).toEqual(g.kitGrants());
    // serialize returns copies
    save.loadout.items.length = 0;
    expect(g.loadout.items.length).toBeGreaterThan(0);
    expect(new OfficerGear(defaultGearSave()).serialize()).toEqual(defaultGearSave());
  });

  it('isGearSave is structural: unknown ids load, malformed data does not', () => {
    const old: GearSave = { version: 1, loadout: { assignment: 'patrol', items: [{ id: 'retiredItem', count: 2 }] }, presets: [{ name: 'a', loadout: { assignment: 'patrol', items: [] } }] };
    expect(isGearSave(old)).toBe(true);
    const g = OfficerGear.restore(old);
    expect(g.has('retiredItem')).toBe(true);
    expect(g.validation.ok).toBe(false);
    expect(g.kitGrants()).toEqual({});
    expect(isGearSave({ ...old, assignment: 3 })).toBe(true);
    for (const bad of [
      null, 5, {}, { ...old, version: 2 }, { ...old, loadout: null }, { ...old, loadout: { assignment: 4, items: [] } },
      { ...old, loadout: { assignment: 'patrol', items: [{ id: 3, count: 1 }] } },
      { ...old, loadout: { assignment: 'patrol', items: [{ id: 'radio', count: 1.5 }] } },
      { ...old, loadout: { assignment: 'patrol', items: [{ id: 'holster', count: 1, retention: 4 }] } },
      { ...old, presets: 'x' }, { ...old, presets: [{ name: 1, loadout: old.loadout }] },
      { ...old, presets: Array.from({ length: 9 }, () => old.presets[0]) },
    ]) {
      expect(isGearSave(bad)).toBe(false);
    }
  });
});

describe('officerHit', () => {
  const b = GEAR_POLICY.ballistics;

  it('reads the ballistics table', () => {
    expect(b).toEqual({ hitChance: 0.3, torsoShare: 0.7, maxRangeM: 30 });
  });

  it('misses beyond the maximum range and on a failed hit roll', () => {
    expect(officerHit(0, 0, 0.85, 30.01)).toBe('miss');
    expect(officerHit(0, 0, 0.85, 30)).toBe('stopped');
    expect(officerHit(0.3, 0, 0.85, 5)).toBe('miss');
    expect(officerHit(0.99, 0.99, 0, 5)).toBe('miss');
    expect(officerHit(0.2999, 0.99, 0, 5)).toBe('wounded');
  });

  it('a vest stops torso hits in proportion to its protection', () => {
    expect(officerHit(0.1, 0.0, 0.85, 10)).toBe('stopped');
    expect(officerHit(0.1, 0.59, 0.85, 10)).toBe('stopped'); // < 0.7 x 0.85 = 0.595
    expect(officerHit(0.1, 0.6, 0.85, 10)).toBe('wounded'); // torso, but past the vest's coverage
    expect(officerHit(0.1, 0.69, 0.85, 10)).toBe('wounded');
    expect(officerHit(0.1, 0.3, 0, 10)).toBe('wounded'); // no vest
    expect(officerHit(0.1, 0.5, 1, 10)).toBe('stopped');
  });

  it('limb hits wound regardless of the vest', () => {
    expect(officerHit(0.1, 0.7, 1, 10)).toBe('wounded');
    expect(officerHit(0.1, 0.99, 0.85, 10)).toBe('wounded');
  });
});

describe('startingGearSave', () => {
  it('is the standard patrol loadout plus the evidence field kit, valid, and its grants include the kit items', () => {
    const save = startingGearSave();
    expect(save.loadout.items.map((i) => i.id)).toEqual([...defaultGearSave().loadout.items.map((i) => i.id), 'evidenceKit']);
    const gear = OfficerGear.restore(save);
    expect(gear.validation.ok).toBe(true);
    const grants = gear.kitGrants();
    for (const item of ['evidenceBags', 'evidenceMarkers', 'camera', 'fingerprintKit', 'sceneTape']) expect(grants[item]).toBeGreaterThan(0);
    expect(OfficerGear.restore(defaultGearSave()).kitGrants()['evidenceBags']).toBeUndefined();
  });
});
