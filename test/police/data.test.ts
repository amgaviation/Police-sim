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
    // Phase 4 appends the six scene-work trunk items after the eight required ones.
    expect(ITEMS_DATA.map((i) => i.id)).toEqual([
      ...REQUIRED_TRUNK_ITEMS,
      'ram', 'sceneTape', 'evidenceMarkers', 'evidenceBags', 'fingerprintKit', 'camera',
      // Phase 7 appends the medical, breaching, K9 and drone items.
      'naloxone', 'tourniquet', 'halligan', 'k9Treats', 'drone',
    ]);
    const eq = parseEquipment(equipmentJson, 'equipment.json', ITEMS_DATA);
    expect(eq.siren.tones).toEqual(['wail', 'yelp', 'phaser', 'hilo']);
    expect(eq.siren.defaultTone).toBe('wail');
    expect(eq.rack.items.map((r) => r.id)).toEqual(['shotgun', 'rifle', 'lessLethal']);
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
      [(j) => delete at(j, 'items', 0).weightKg, /^it\.json: items\[0\]\.weightKg must be a finite number/],
      [(j) => (at(j, 'items', 0).weightKg = -1), /^it\.json: items\[0\]\.weightKg must be in \[0, 1000\], got -1$/],
      [(j) => delete at(j, 'items', 2).size, /^it\.json: items\[2\]\.size must be a finite number/],
      [(j) => (at(j, 'items', 2).size = 1.5), /^it\.json: items\[2\]\.size must be an integer, got 1\.5$/],
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
    (more.items as unknown[]).push({ id: 'blanket', label: 'Blanket', carryMax: 2, deployable: false, weightKg: 0.8, size: 1 });
    expect(parseItems(more, 'it.json')).toHaveLength(ITEMS_DATA.length + 1);
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
  it('items carry the Phase 7 weights and sizes, including the new items', () => {
    const wk = (id: string): [number, number] => {
      const it = ITEMS_DATA.find((i) => i.id === id);
      return [it?.weightKg ?? -1, it?.size ?? -1];
    };
    expect(wk('flares')).toEqual([0.2, 0]);
    expect(wk('aed')).toEqual([2.5, 2]);
    expect(wk('spikeStrip')).toEqual([9, 4]);
    expect(wk('ram')).toEqual([16, 4]);
    expect(wk('evidenceBags')).toEqual([0.02, 0]);
    expect(wk('naloxone')).toEqual([0.05, 0]);
    expect(wk('tourniquet')).toEqual([0.1, 0]);
    expect(wk('halligan')).toEqual([5, 2]);
    expect(wk('k9Treats')).toEqual([0.1, 0]);
    expect(wk('drone')).toEqual([3, 3]);
    const byId = (id: string) => ITEMS_DATA.find((i) => i.id === id);
    expect(byId('naloxone')).toMatchObject({ carryMax: 3, deployable: false, label: 'Naloxone nasal spray' });
    expect(byId('tourniquet')?.carryMax).toBe(2);
    expect(byId('k9Treats')?.carryMax).toBe(5);
    expect(byId('drone')).toMatchObject({ carryMax: 1, deployable: true, label: 'Camera drone' });
  });

  it('equipment.json ships the Phase 7 trunk loadouts', () => {
    const eq = parseEquipment(equipmentJson, 'equipment.json', ITEMS_DATA);
    expect(Object.keys(eq.trunkLoadouts)).toEqual([
      'patrol', 'supervisor', 'unmarked', 'traffic', 'k9', 'motor', 'bicycle', 'atv', 'swat', 'armored', 'transport', 'command', 'lab', 'marine', 'air',
    ]);
    expect(eq.trunkLoadouts.patrol).toMatchObject({ naloxone: 2, tourniquet: 2, halligan: 1, cones: 6 });
    expect(eq.trunkLoadouts.swat).toEqual({ firstAid: 2, aed: 1, ram: 2, halligan: 2, tourniquet: 2, naloxone: 2, evidenceKit: 1, drone: 1 });
    expect(eq.trunkLoadouts.k9?.k9Treats).toBe(5);
    expect(eq.trunkLoadouts.air).toEqual({ firstAid: 1, tourniquet: 1 });
    expect(eq.trunkLoadouts.lab?.evidenceMarkers).toBe(20);
    // Loadouts naming an unknown item are refused.
    const bad = clone(equipmentJson);
    at(bad, 'trunkLoadouts', 'air').jetpack = 1;
    expect(() => parseEquipment(bad, 'eq.json', ITEMS_DATA)).toThrow(/^eq\.json: trunkLoadouts\.air\.jetpack is not an item in items\.json$/);
  });
});
