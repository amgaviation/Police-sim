import { describe, expect, it } from 'vitest';
import itemsJson from '../../src/data/people/items.json';
import peopleJson from '../../src/data/people/people.json';
import { ITEM_IDS, PEOPLE_DATA, parseItems, parsePeopleData } from '../../src/people/data';
import { ITEMS, itemDef } from '../../src/people/items';
import { SALT } from '../../src/people/salt';

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

describe('people data', () => {
  it('loads and validates', () => {
    expect(PEOPLE_DATA.temperament.map((t) => t.key)).toEqual(['calm', 'timid', 'irritable', 'volatile']);
    expect(PEOPLE_DATA.employment.employers).toHaveLength(20);
    expect(PEOPLE_DATA.appearance.tops).toHaveLength(10);
    expect(PEOPLE_DATA.appearance.hair.get('bald')).toBeNull();
    expect(PEOPLE_DATA.appearance.hair.get('black')).toBe(0x1b1b1b);
    expect(PEOPLE_DATA.occupants.passengers).toEqual([0.6, 0.28, 0.09, 0.03]);
  });

  it('names the file and path of a bad value', () => {
    const bad = clone(peopleJson) as Record<string, unknown>;
    (bad.honesty as Record<string, unknown>).min = 2;
    expect(() => parsePeopleData(bad)).toThrow(/people\.json: honesty\.min/);
    const noVersion = { ...clone(peopleJson), version: 2 };
    expect(() => parsePeopleData(noVersion)).toThrow(/people\.json: version/);
    const badWeekday = clone(peopleJson) as { drinking: { weekday: number[] } };
    badWeekday.drinking.weekday = [1, 2];
    expect(() => parsePeopleData(badWeekday)).toThrow(/people\.json: drinking\.weekday/);
    const badKind = clone(peopleJson) as { drugs: { kinds: Record<string, number> } };
    badKind.drugs.kinds = { heroin: 1 };
    expect(() => parsePeopleData(badKind)).toThrow(/people\.json: drugs\.kinds\.heroin/);
    const badPassengers = clone(peopleJson) as { occupants: { passengers: number[] } };
    badPassengers.occupants.passengers = [0.5, 0.2];
    expect(() => parsePeopleData(badPassengers)).toThrow(/occupants\.passengers must sum to 1/);
    const badColor = clone(peopleJson) as { appearance: { skinTones: string[] } };
    badColor.appearance.skinTones = ['red'];
    expect(() => parsePeopleData(badColor)).toThrow(/appearance\.skinTones\[0\]/);
    expect(() => parsePeopleData(null)).toThrow(/people\.json/);
  });
});

describe('item table', () => {
  it('has all 26 contract ids', () => {
    expect(ITEM_IDS).toHaveLength(26);
    const ids = new Set(ITEMS.map((i) => i.id));
    for (const id of ITEM_IDS) expect(ids.has(id)).toBe(true);
    expect(ids.size).toBe(ITEMS.length);
  });

  it('has sane fields', () => {
    for (const i of ITEMS) {
      expect(i.label.length).toBeGreaterThan(0);
      expect(i.concealment).toBeGreaterThanOrEqual(0);
      expect(i.concealment).toBeLessThanOrEqual(1);
      if (i.statute !== null) expect(i.statute).toMatch(/^(TR|PC)-\d{3}$/);
    }
    expect(itemDef('cannabis').odor).toBe('cannabis');
    expect(itemDef('openContainer').odor).toBe('alcohol');
    expect(itemDef('liquorBottle').odor).toBe('alcohol');
    expect(itemDef('openContainer').statute).toBe('TR-361');
    expect(itemDef('handgun')).toMatchObject({ weapon: true, statute: 'PC-262', prop: 'handgun' });
    expect(itemDef('narcotics').statute).toBe('PC-260');
    expect(itemDef('syringe').statute).toBe('PC-261');
    expect(itemDef('stolenGoods').statute).toBe('PC-240');
    expect(itemDef('shellCasing').category).toBe('evidence');
  });

  it('throws on an unknown id', () => {
    expect(() => itemDef('bazooka')).toThrow('Unknown item');
  });

  it('validators name file and path', () => {
    const bad = clone(itemsJson) as { items: Record<string, unknown>[] };
    bad.items[2] = { ...bad.items[2], concealment: 3 };
    expect(() => parseItems(bad)).toThrow(/items\.json: items\[2\]\.concealment/);
    const badStatute = clone(itemsJson) as { items: Record<string, unknown>[] };
    badStatute.items[0] = { ...badStatute.items[0], statute: 'X-1' };
    expect(() => parseItems(badStatute)).toThrow(/items\.json: items\[0\]\.statute/);
    const badProp = clone(itemsJson) as { items: Record<string, unknown>[] };
    badProp.items[0] = { ...badProp.items[0], prop: 'sword' };
    expect(() => parseItems(badProp)).toThrow(/items\.json: items\[0\]\.prop/);
    const missing = clone(itemsJson) as { items: { id: string }[] };
    missing.items = missing.items.filter((i) => i.id !== 'knife');
    expect(() => parseItems(missing)).toThrow(/missing required item "knife"/);
    const dup = clone(itemsJson) as { items: unknown[] };
    dup.items.push(dup.items[0]);
    expect(() => parseItems(dup)).toThrow(/duplicate item id/);
    const badCat = clone(itemsJson) as { items: Record<string, unknown>[] };
    badCat.items[1] = { ...badCat.items[1], category: 'toys' };
    expect(() => parseItems(badCat)).toThrow(/items\[1\]\.category/);
  });
});

describe('salts', () => {
  it('are distinct 0x5050_xxxx constants', () => {
    const values: number[] = Object.values(SALT);
    expect(new Set(values).size).toBe(values.length);
    for (const v of values) expect(v >>> 16).toBe(0x5050);
    // `passenger + k` (k < 4) must not collide with another salt.
    for (let k = 1; k < 4; k++) expect(values.includes(SALT.passenger + k)).toBe(false);
  });
});
