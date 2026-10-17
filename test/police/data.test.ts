import { describe, expect, it } from 'vitest';
import equipmentJson from '../../src/data/police/equipment.json';
import itemsJson from '../../src/data/police/items.json';
import lightbarJson from '../../src/data/police/lightbar.json';
import { ITEMS_DATA, REQUIRED_TRUNK_ITEMS, parseEquipment, parseItems, parseLightbar } from '../../src/police/data';

type Json = Record<string, unknown>;
const clone = (x: unknown): Json => structuredClone(x) as Json;
const at = (o: unknown, ...path: (string | number)[]): Json => {
  let cur = o;
  for (const p of path) cur = (cur as Record<string | number, unknown>)[p];
  return cur as Json;
};

describe('police data', () => {
  it('parses the shipped tables', () => {
    const lb = parseLightbar(lightbarJson, 'lightbar.json');
    expect(lb.patterns.map((p) => p.id)).toEqual(['alternate', 'quad', 'sweep', 'takedown', 'cruise', 'arrowLeft']);
    for (const p of lb.patterns) {
      for (const f of p.frames) expect(f.colors).toHaveLength(8);
      expect(p.periodS).toBeCloseTo(p.frames.reduce((s, f) => s + f.durationS, 0), 10);
    }
    expect(ITEMS_DATA.map((i) => i.id)).toEqual([...REQUIRED_TRUNK_ITEMS]);
    const eq = parseEquipment(equipmentJson, 'equipment.json', ITEMS_DATA);
    expect(eq.siren.tones).toEqual(['wail', 'yelp', 'phaser', 'hilo']);
    expect(eq.siren.defaultTone).toBe('wail');
    expect(eq.rack.items.map((r) => r.id)).toEqual(['shotgun', 'rifle']);
    expect(eq.trunkLoadouts.patrol?.cones).toBe(6);
  });

  it('lightbar.json errors name the file and field', () => {
    const cases: [(j: Json) => void, RegExp][] = [
      [(j) => (j.version = 2), /^lb\.json: version must be 1, got 2$/],
      [(j) => (at(j, 'patterns', 0, 'frames', 1)[0] = 'RRR'), /^lb\.json: patterns\[0\]\.frames\[1\]\[0\] must have 8 characters, got 3$/],
      [(j) => (at(j, 'patterns', 0, 'frames', 0)[0] = 'RRRRX...'), /^lb\.json: patterns\[0\]\.frames\[0\]\[0\] has unknown colour "X"/],
      [(j) => (at(j, 'patterns', 1, 'frames', 0)[1] = 0), /^lb\.json: patterns\[1\]\.frames\[0\]\[1\] must be in/],
      [(j) => (at(j, 'patterns', 2).id = 'alternate'), /^lb\.json: patterns\[2\]\.id duplicates "alternate"$/],
      [(j) => (at(j, 'patterns', 0).frames = []), /^lb\.json: patterns\[0\]\.frames must have at least 1 items/],
      [(j) => delete at(j, 'reducedFlash').minFrameS, /^lb\.json: reducedFlash\.minFrameS must be a finite number/],
    ];
    for (const [mutate, message] of cases) {
      const json = clone(lightbarJson);
      mutate(json);
      expect(() => parseLightbar(json, 'lb.json')).toThrow(message);
    }
  });

  it('items.json errors name the file and field; all eight items are required', () => {
    const cases: [(j: Json) => void, RegExp][] = [
      [(j) => (at(j, 'items', 0).carryMax = 0), /^it\.json: items\[0\]\.carryMax must be in \[1, 999\], got 0$/],
      [(j) => (at(j, 'items', 0).carryMax = 1.5), /^it\.json: items\[0\]\.carryMax must be an integer, got 1\.5$/],
      [(j) => (at(j, 'items', 1).deployable = 'no'), /^it\.json: items\[1\]\.deployable must be true or false/],
      [(j) => (at(j, 'items', 3).id = 'cones'), /^it\.json: items\[3\]\.id duplicates "cones"$/],
      [(j) => (j.items = (j.items as unknown[]).slice(0, 7)), /^it\.json: items must include "trafficVest"$/],
    ];
    for (const [mutate, message] of cases) {
      const json = clone(itemsJson);
      mutate(json);
      expect(() => parseItems(json, 'it.json')).toThrow(message);
    }
    // Extra items are fine: content scales without code changes.
    const more = clone(itemsJson);
    (more.items as unknown[]).push({ id: 'blanket', label: 'Blanket', carryMax: 2, deployable: false });
    expect(parseItems(more, 'it.json')).toHaveLength(9);
  });

  it('equipment.json errors name the file and field; tones are checked against the union', () => {
    const cases: [(j: Json) => void, RegExp][] = [
      [(j) => (at(j, 'siren').tones = ['wail', 'whoop']), /^eq\.json: siren\.tones\[1\] must be one of wail, yelp, phaser, hilo, got "whoop"$/],
      [(j) => (at(j, 'siren').tones = ['wail', 'wail']), /^eq\.json: siren\.tones\[1\] duplicates "wail"$/],
      [
        (j) => {
          at(j, 'siren').defaultTone = 'hilo';
          at(j, 'siren').tones = ['wail'];
        },
        /^eq\.json: siren\.defaultTone must be one of wail, got "hilo"$/,
      ],
      [(j) => (at(j, 'spotlight').yawMin = 3), /^eq\.json: spotlight\.yawMin must be less than spotlight\.yawMax$/],
      [(j) => (at(j, 'spotlight').defaultPitch = 0.4), /^eq\.json: spotlight\.defaultPitch must be within/],
      [(j) => (at(j, 'rack').unlockRequiresStop = 1), /^eq\.json: rack\.unlockRequiresStop must be true or false/],
      [(j) => (at(j, 'trunkLoadouts', 'patrol').torch = 1), /^eq\.json: trunkLoadouts\.patrol\.torch is not an item in items\.json$/],
      [(j) => (at(j, 'trunkLoadouts', 'patrol').cones = -1), /^eq\.json: trunkLoadouts\.patrol\.cones must be in \[0, 999\], got -1$/],
    ];
    for (const [mutate, message] of cases) {
      const json = clone(equipmentJson);
      mutate(json);
      expect(() => parseEquipment(json, 'eq.json', ITEMS_DATA)).toThrow(message);
    }
  });
});
