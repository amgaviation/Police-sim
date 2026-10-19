import { describe, expect, it } from 'vitest';
import houseJson from '../../src/data/interior/templates/house.json';
import apartmentJson from '../../src/data/interior/templates/apartment.json';
import furnitureJson from '../../src/data/interior/furniture.json';
import { generateInterior } from '../../src/interior/generate';
import {
  FURNITURE,
  INTERIOR_TEMPLATES,
  parseFurniture,
  parseTemplate,
  parseTemplateSet,
} from '../../src/interior/templates';
import { POINT_KINDS, ROOM_KINDS, CONTAINERS, HIDE_KINDS, PRINT_SURFACES, SURFACE_KINDS } from '../../src/interior/types';
import { BUILDING_KINDS } from '../../src/world/buildings';
import { handBuilding, handBuildings, templateSizes } from './helpers';

type Json = Record<string, unknown>;

/** Deep clone of parsed JSON with `fn` applied to the clone. */
function edited(source: unknown, fn: (root: Json) => void): Json {
  const copy = structuredClone(source) as Json;
  fn(copy);
  return copy;
}
function at(value: unknown, ...path: (string | number)[]): Json {
  let cur = value;
  for (const key of path) cur = (cur as Record<string | number, unknown>)[key];
  return cur as Json;
}

const REQUIRED_FURNITURE = ('sofa armchair chair stool bed wardrobe dresser nightstand table coffeeTable desk counter kitchenCounter fridge '
  + 'stove sink toilet bathtub tvStand bookshelf shelf checkoutCounter cooler tellerCounter safe barCounter barTable hospitalBed examTable '
  + 'schoolDesk teacherDesk whiteboard filingCabinet conferenceTable crate palletRack pillar parkedCar locker bench podium armoryCounter '
  + 'evidenceLocker cellBench interviewTable frontDesk computerDesk washer plant').split(' ');

describe('interior id lists', () => {
  it('has the contract sizes and no duplicates', () => {
    expect(ROOM_KINDS.length).toBe(55);
    expect(POINT_KINDS.length).toBe(10);
    expect(SURFACE_KINDS.length).toBe(5);
    expect(PRINT_SURFACES.length).toBe(5);
    expect(CONTAINERS.length).toBe(5);
    expect(HIDE_KINDS.length).toBe(5);
    expect(BUILDING_KINDS.length).toBe(12);
    for (const list of [ROOM_KINDS, POINT_KINDS, SURFACE_KINDS, PRINT_SURFACES, CONTAINERS, HIDE_KINDS, BUILDING_KINDS]) {
      expect(new Set(list).size).toBe(list.length);
    }
  });
});

describe('shipped templates', () => {
  it('has one template per building kind and the whole furniture catalog', () => {
    for (const kind of BUILDING_KINDS) expect(INTERIOR_TEMPLATES.templates[kind].kind).toBe(kind);
    for (const id of REQUIRED_FURNITURE) expect(FURNITURE[id]).toBeDefined();
    expect(INTERIOR_TEMPLATES.furniture).toBe(FURNITURE);
  });

  it('generates every kind on every front at its minimum, a middle and its maximum size', () => {
    const buildings = handBuildings();
    expect(buildings.length).toBe(12 * 4 * 3);
    for (const b of buildings) expect(generateInterior(3, b), `${b.kind} ${b.front} ${b.maxX - b.minX}x${b.maxZ - b.minZ}`).not.toBeNull();
  });

  it('rejects a footprint below the template minimum', () => {
    for (const kind of BUILDING_KINDS) {
      const { min } = templateSizes(kind, 0);
      expect(generateInterior(3, handBuilding(kind, min[0] - 0.5, min[1] + 2, 0))).toBeNull();
      expect(generateInterior(3, handBuilding(kind, min[0] + 2, min[1] - 0.5, 0))).toBeNull();
    }
  });

  it('places every station point kind but booking, over many seeds, sizes and fronts', () => {
    const wanted = POINT_KINDS.filter((k) => k !== 'booking');
    for (let seed = 1; seed <= 40; seed++) {
      for (const front of [0, 1, 2, 3] as const) {
        const { min, max } = templateSizes('policeStation', front);
        for (const [w, d] of [min, max, [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2]] as const) {
          const l = generateInterior(seed, handBuilding('policeStation', w, d, front, 1000 + seed))!;
          const kinds = new Set(l.points.map((p) => p.kind));
          for (const k of wanted) expect(kinds.has(k), `seed ${seed} front ${front} ${w}x${d} lacks ${k}`).toBe(true);
          expect(kinds.has('booking')).toBe(false);
          // Station: cells are lockable but not locked, garage and sally port are wide.
          expect(l.doors.filter((x) => x.kind === 'wide').length).toBeGreaterThanOrEqual(1);
          expect(l.doors.find((x) => x.main)!.lockedAtStart).toBe(false);
          expect(l.rooms.filter((r) => r.kind === 'cell').length).toBe(3);
          for (const p of l.points) expect(l.rooms[p.room]!.kind).toBe(p.kind === 'frontDesk' ? 'lobby' : p.kind === 'reportDesk' ? 'reportRoom' : p.kind === 'briefing' ? 'rollCall' : p.kind === 'evidence' ? 'evidenceRoom' : p.kind === 'locker' ? 'lockerRoom' : p.kind);
        }
      }
    }
  });

  it('places booking and cell points in a jail and locks only the control room', () => {
    for (let seed = 1; seed <= 30; seed++) {
      for (const front of [0, 1, 2, 3] as const) {
        const { min, max } = templateSizes('jail', front);
        for (const [w, d] of [min, max] as const) {
          const l = generateInterior(seed, handBuilding('jail', w, d, front, 2000 + seed))!;
          const kinds = new Set(l.points.map((p) => p.kind));
          expect(kinds.has('booking')).toBe(true);
          expect(kinds.has('cell')).toBe(true);
          expect(l.rooms.filter((r) => r.kind === 'cell').length).toBeGreaterThanOrEqual(4 - 1);
          for (const door of l.doors) {
            if (door.b < 0) continue;
            const kindsOf = [l.rooms[door.a]!.kind, l.rooms[door.b]!.kind];
            expect(door.lockedAtStart).toBe(kindsOf.includes('control'));
            expect(door.kind === 'cell').toBe(kindsOf.includes('cell'));
            if (door.kind === 'cell') { expect(door.lockable).toBe(true); expect(door.strength).toBe(0.97); }
          }
        }
      }
    }
  });

  it('locks a vault and gives it strength 1', () => {
    let seen = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const l = generateInterior(seed, handBuilding('bank', 24, 18, 0, 3000 + seed))!;
      for (const d of l.doors) {
        if (d.b < 0) continue;
        if (l.rooms[d.a]!.kind === 'vault' || l.rooms[d.b]!.kind === 'vault') { seen++; expect(d.lockedAtStart).toBe(true); expect(d.strength).toBe(1); }
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('keeps the template facts the design lists', () => {
    const t = INTERIOR_TEMPLATES.templates;
    expect(t.house.rooms.map((r) => r.kind)).toEqual(['living', 'kitchen', 'bedroom', 'bathroom', 'laundry', 'dining']);
    expect(t.house.residential).toBe(true);
    expect(t.parkingStructure.mainDoorWidth).toBe(2.8);
    expect(t.parkingStructure.lockableRooms).toEqual([]);
    expect(t.bar.occupants.openHours).toEqual([16, 2]);
    expect(t.hospital.occupants.openHours).toBeNull();
    expect(t.apartment.layout).toBe('corridor');
    expect(t.policeStation.exteriorLocked).toBe(false);
    expect(t.policeStation.rooms.filter((r) => r.band === 'front').map((r) => r.kind)).toEqual(['garage', 'lockerRoom', 'lobby', 'rollCall', 'reportRoom']);
  });
});

describe('template validation', () => {
  const file = 'house.json';
  const parse = (raw: unknown): unknown => parseTemplate(raw, FURNITURE, file);

  it('accepts the shipped files', () => {
    expect(() => parse(houseJson)).not.toThrow();
    expect(() => parseFurniture(furnitureJson)).not.toThrow();
  });

  it('names the file and path of an unknown furniture id', () => {
    const bad = edited(houseJson, (r) => { at(r, 'rooms', 0, 'furniture', 1).id = 'nope'; });
    expect(() => parse(bad)).toThrow(/house\.json: rooms\[0\]\.furniture\[1\]\.id .*nope/);
  });

  it('names the path of an unknown room kind', () => {
    const bad = edited(houseJson, (r) => { at(r, 'rooms', 1).kind = 'nope'; });
    expect(() => parse(bad)).toThrow(/house\.json: rooms\[1\]\.kind /);
  });

  it('rejects a missing, non-required or unplaced entry room', () => {
    expect(() => parse(edited(houseJson, (r) => { r.entry = 'garage'; }))).toThrow(/house\.json: entry /);
    expect(() => parse(edited(houseJson, (r) => { r.entry = 'laundry'; }))).toThrow(/house\.json: entry /);
    expect(() => parse(edited(houseJson, (r) => { delete r.entry; }))).toThrow(/house\.json: entry /);
  });

  it('requires the entry room in the front band of a corridor layout', () => {
    const bad = edited(apartmentJson, (r) => { at(r, 'rooms', 0).band = 'back'; });
    expect(() => parseTemplate(bad, FURNITURE, 'apartment.json')).toThrow(/apartment\.json: entry /);
    const noBand = edited(apartmentJson, (r) => { delete at(r, 'rooms', 3).band; });
    expect(() => parseTemplate(noBand, FURNITURE, 'apartment.json')).toThrow(/apartment\.json: rooms\[3\]\.band /);
  });

  it('checks counts, sizes, points, exterior door rooms and lock lists', () => {
    expect(() => parse(edited(houseJson, (r) => { at(r, 'rooms', 2).count = [3, 1]; }))).toThrow(/rooms\[2\]\.count /);
    expect(() => parse(edited(houseJson, (r) => { at(r, 'rooms', 0).size = 0; }))).toThrow(/rooms\[0\]\.size /);
    expect(() => parse(edited(houseJson, (r) => { at(r, 'rooms', 0, 'furniture', 0).point = 'nope'; }))).toThrow(/rooms\[0\]\.furniture\[0\]\.point /);
    expect(() => parse(edited(houseJson, (r) => { at(r, 'exteriorDoors', 0).room = 'garage'; }))).toThrow(/exteriorDoors\[0\]\.room /);
    expect(() => parse(edited(houseJson, (r) => { r.lockedRooms = ['kitchen']; }))).toThrow(/lockedRooms\[0\] /);
    expect(() => parse(edited(houseJson, (r) => { r.layout = 'maze'; }))).toThrow(/house\.json: layout /);
    expect(() => parse(edited(houseJson, (r) => { r.surprise = 1; }))).toThrow(/house\.json: surprise /);
    expect(() => parse(edited(houseJson, (r) => { at(r, 'rooms', 0, 'furniture', 0).place = 'ceiling'; }))).toThrow(/furniture\[0\]\.place /);
    expect(() => parse(edited(houseJson, (r) => { r.version = 2; }))).toThrow(/house\.json: version /);
  });

  it('checks the furniture catalog', () => {
    const dup = edited(furnitureJson, (r) => { at(r, 'items', 1).id = 'sofa'; });
    expect(() => parseFurniture(dup)).toThrow(/furniture\.json: items\[1\]\.id .*duplicates/);
    expect(() => parseFurniture(edited(furnitureJson, (r) => { at(r, 'items', 2).container = 'vault'; }))).toThrow(/items\[2\]\.container /);
    expect(() => parseFurniture(edited(furnitureJson, (r) => { at(r, 'items', 3).size = [1, 2]; }))).toThrow(/items\[3\]\.size /);
    expect(() => parseFurniture(edited(furnitureJson, (r) => { at(r, 'items', 4).seat = 'stand'; }))).toThrow(/items\[4\]\.seat /);
  });

  it('requires exactly one template per building kind', () => {
    const raw = import.meta.glob<unknown>('../../src/data/interior/templates/*.json', { eager: true, import: 'default' });
    const paths = Object.keys(raw);
    expect(paths.length).toBe(12);
    expect(() => parseTemplateSet(furnitureJson, raw)).not.toThrow();
    const missing = { ...raw };
    delete missing[paths[0] as string];
    expect(() => parseTemplateSet(furnitureJson, missing)).toThrow(/has no template file/);
    const dupe = { ...raw, 'copy/house.json': houseJson };
    expect(() => parseTemplateSet(furnitureJson, dupe)).toThrow(/house\.json: kind .*duplicates/);
  });
});
