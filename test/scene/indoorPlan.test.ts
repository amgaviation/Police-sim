/* The fixtures break the shipped JSON files on purpose, so they are mutated as untyped objects. */
/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment */
import { describe, expect, it } from 'vitest';
import { CALL_CATALOG } from '../../src/calls';
import { ROOM_KINDS } from '../../src/interior/types';
import { generateInterior } from '../../src/interior/generate';
import type { InteriorLayout } from '../../src/interior/types';
import { BuildingIndex, type BuildingKind } from '../../src/world/buildings';
import indoorJson from '../../src/data/scene/indoor.json';
import {
  INDOOR,
  bindingKinds,
  doorSlot,
  fallbackKinds,
  indoorFamily,
  lockRoll,
  mainDoor,
  planInterior,
  validateIndoor,
  zoneOf,
  type PlanParticipant,
} from '../../src/scene/indoor';
import { roomAt } from '../../src/interior/nav';
import { cityFor } from '../world/helpers';
import { cityBuildings, SEED } from '../interior/helpers';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>

function broken(edit: (j: Json) => void): unknown {
  const j = JSON.parse(JSON.stringify(indoorJson)) as Json;
  edit(j);
  return j;
}

const layouts: InteriorLayout[] = (() => {
  const idx = new BuildingIndex(cityFor(SEED));
  const out: InteriorLayout[] = [];
  for (const b of cityBuildings(idx, 8)) {
    const l = generateInterior(SEED, b);
    if (l) out.push(l);
  }
  return out;
})();

function of(kind: BuildingKind): InteriorLayout[] {
  return layouts.filter((l) => l.kind === kind);
}

describe('indoor.json', () => {
  it('is the design table and validates against the catalog', () => {
    expect(Object.keys(INDOOR.families).sort()).toEqual(['barricade', 'domestic', 'inProgress', 'investigation', 'property', 'retail', 'welfare']);
    expect(Object.keys(INDOOR.types).sort()).toEqual(['commercialBurglaryInProgress', 'customerDispute', 'loudParty', 'schoolThreat', 'squatters', 'trespassVacantBuilding']);
    expect(INDOOR.excludeTypes).toHaveLength(7);
    expect(INDOOR.families.barricade?.doorLocked).toBe(1);
    expect(INDOOR.families.retail?.moveInside).toEqual(['guard', 'suspect']);
    for (const f of Object.values(INDOOR.families)) {
      for (const rooms of Object.values(f.rooms)) for (const k of rooms) expect(ROOM_KINDS).toContain(k);
      for (const e of f.evidence) for (const k of e.rooms) expect(ROOM_KINDS).toContain(k);
    }
  });

  it('rejects unknown families, types, roles, rooms, items, kinds and fields, naming the path', () => {
    const cases: [(j: Json) => void, RegExp][] = [
      [(j) => { j.families.bogus = j.families.domestic; }, /indoor\.json: families\.bogus is not a family/],
      [(j) => { j.types.noSuchType = { kinds: ['house'] }; }, /types\.noSuchType is not a call type/],
      [(j) => { j.types.loudParty.family = 'domestic'; }, /types\.loudParty\.family must be the catalog family of loudParty \("disturbance"\)/],
      [(j) => { j.families.domestic.rooms.wizard = ['living']; }, /families\.domestic\.rooms\.wizard: ?role "wizard"|families\.domestic\.rooms\.wizard .*role "wizard"/],
      [(j) => { j.families.domestic.rooms.suspect = ['ballroom']; }, /families\.domestic\.rooms\.suspect\[0\] must be one of/],
      [(j) => { j.families.domestic.evidence[0].item = 'laserGun'; }, /families\.domestic\.evidence\[0\]\.item is not an item id/],
      [(j) => { j.families.domestic.evidence[0].where = 'ceiling'; }, /evidence\[0\]\.where must be one of floor, surface, container/],
      [(j) => { j.families.domestic.evidence[0].chance = 2; }, /evidence\[0\]\.chance/],
      [(j) => { j.families.domestic.kinds = ['castle']; }, /families\.domestic\.kinds\[0\] must be one of/],
      [(j) => { j.families.domestic.kinds = []; }, /families\.domestic\.kinds/],
      [(j) => { j.families.domestic.mystery = 1; }, /families\.domestic\.mystery is not one of/],
      [(j) => { j.excludeTypes.push('noSuchType'); }, /excludeTypes\[7\] is not a call type/],
      [(j) => { j.families.retail.moveInside = ['janitor']; }, /moveInside\[0\]/],
      [(j) => { j.version = 2; }, /version/],
    ];
    for (const [edit, re] of cases) expect(() => validateIndoor(broken(edit), CALL_CATALOG)).toThrow(re);
  });
});

describe('binding rule', () => {
  it('binds listed types and indoor families, never road, poi or excluded types', () => {
    expect(bindingKinds(INDOOR, 'domesticDisturbance', 'domestic', 'block')).toEqual(['house', 'apartment']);
    expect(bindingKinds(INDOOR, 'schoolThreat', 'investigation', 'poi:school')).toEqual(['school']);
    expect(bindingKinds(INDOOR, 'loudParty', 'disturbance', 'block')).toEqual(['house', 'apartment']);
    expect(bindingKinds(INDOOR, 'commercialBurglaryInProgress', 'inProgress', 'block')).toEqual(['convenienceStore', 'warehouse', 'office']);
    expect(bindingKinds(INDOOR, 'vehicleBurglaryCold', 'property', 'road')).toBeNull();
    expect(bindingKinds(INDOOR, 'gasDriveOff', 'retail', 'poi:fuel')).toBeNull();
    expect(bindingKinds(INDOOR, 'citizenAssist', 'welfare', 'road')).toBeNull();
    expect(bindingKinds(INDOOR, 'someRoadType', 'domestic', 'road')).toBeNull();
    expect(bindingKinds(INDOOR, 'injuryCollision', 'collision', 'block')).toBeNull();
    expect(bindingKinds(INDOOR, 'verbalDispute', 'disturbance', 'block')).toBeNull();
  });

  it('the fallback uses the other kinds of the same class', () => {
    expect(fallbackKinds(['house', 'apartment'])).toEqual([]);
    expect(fallbackKinds(['house'])).toEqual(['apartment']);
    expect(fallbackKinds(['convenienceStore'])).toEqual(['bank', 'bar', 'warehouse', 'office']);
    expect(fallbackKinds(['school'])).toEqual([]);
    expect(indoorFamily(INDOOR, 'domestic')?.kinds).toEqual(['house', 'apartment']);
    expect(indoorFamily(INDOOR, 'collision')).toBeNull();
  });

  it('the door lock roll follows doorLocked deterministically', () => {
    let locked = 0;
    for (let c = 1; c <= 2000; c++) if (lockRoll(SEED, c, 0.3)) locked++;
    expect(locked / 2000).toBeGreaterThan(0.25);
    expect(locked / 2000).toBeLessThan(0.35);
    for (let c = 1; c <= 100; c++) {
      expect(lockRoll(SEED, c, 1)).toBe(true);
      expect(lockRoll(SEED, c, 0)).toBe(false);
      expect(lockRoll(SEED, c, 0.5)).toBe(lockRoll(SEED, c, 0.5));
    }
  });
});

describe('placement plan', () => {
  const parts = (...p: Partial<PlanParticipant>[]): PlanParticipant[] =>
    p.map((x, index) => ({ index, role: 'suspect', spot: 'inside', lying: false, skip: false, ...x }));

  it('is a pure function of (seed, call, layout)', () => {
    const l = of('house')[0]!;
    const fam = indoorFamily(INDOOR, 'domestic');
    const people = parts({ role: 'suspect' }, { role: 'victim', spot: 'door' });
    expect(planInterior(SEED, 7, l, fam, people)).toEqual(planInterior(SEED, 7, l, fam, people));
    expect(planInterior(SEED, 7, l, fam, people)).not.toEqual(planInterior(SEED, 8, l, fam, people));
  });

  it('inside people get distinct free spots in one zone, in preferred rooms when they exist', () => {
    const fam = indoorFamily(INDOOR, 'barricade');
    for (const l of [...of('house'), ...of('apartment')]) {
      for (let call = 1; call <= 20; call++) {
        const plan = planInterior(SEED, call, l, fam, parts({ role: 'subject' }, { role: 'hostage' }));
        expect(plan.places).toHaveLength(2);
        const [a, b] = plan.places;
        expect(a!.spotIndex).not.toBe(b!.spotIndex);
        const zone = zoneOf(l, a!.room);
        expect(zone.has(b!.room)).toBe(true);
        expect(roomAt(l, a!.x, a!.z)).toBe(a!.room);
        expect(l.rooms[a!.room]!.kind).toMatch(/bedroom|bathroom|Bedroom|Bath|unitBedroom|living|kitchen|dining|laundry|unit/i);
        expect(a!.pose).not.toBe('lying');
      }
    }
  });

  it('the dead lie on lying spots (bedroom first), hidden people use hiding spots, door people stand at the exit pose', () => {
    const fam = indoorFamily(INDOOR, 'investigation');
    for (const l of of('house')) {
      const plan = planInterior(SEED, 3, l, fam, parts({ role: 'deceased', lying: true }, { role: 'reporter', spot: 'door' }, { role: 'suspect', spot: 'hidden' }));
      const dead = plan.places.find((p) => p.index === 0)!;
      expect(dead.pose).toBe('lying');
      expect(l.rooms[dead.room]!.kind).toBe('bedroom');
      expect(l.spawnSpots[dead.spotIndex]!.pose).toBe('lying');
      const door = plan.places.find((p) => p.index === 1)!;
      const exit = l.doors[mainDoor(l)]!.exit!;
      expect(door.mode).toBe('door');
      expect(Math.hypot(door.x - exit.x, door.z - exit.z)).toBeLessThan(0.01);
      expect(door.yaw).toBe(exit.yaw);
      const hid = plan.places.find((p) => p.index === 2)!;
      expect(hid.mode).toBe('hidden');
      expect(l.hidingSpots[hid.spotIndex]!.x).toBe(hid.x);
    }
  });

  it('moveInside roles of the retail family stand in the sales floor or back office; removed roles are skipped', () => {
    const fam = indoorFamily(INDOOR, 'retail');
    for (const l of of('convenienceStore')) {
      const plan = planInterior(SEED, 11, l, fam, parts({ role: 'guard', spot: 'door' }, { role: 'suspect', spot: 'door' }, { role: 'witness', spot: 'curb' }, { role: 'x', spot: 'inside', skip: true }));
      expect(plan.places).toHaveLength(2);
      for (const p of plan.places) {
        expect(p.mode).toBe('inside');
        expect(['backOffice', 'salesFloor']).toContain(l.rooms[p.room]!.kind);
      }
    }
  });

  it('door people stand side by side without overlapping', () => {
    const exit = { x: 10, z: 20, yaw: Math.PI };
    const seen: string[] = [];
    const out = { x: 0, z: 0, yaw: 0 };
    for (let n = 0; n < 6; n++) {
      doorSlot(exit, n, out);
      expect(out.yaw).toBe(exit.yaw);
      seen.push(`${out.x.toFixed(2)},${out.z.toFixed(2)}`);
    }
    expect(new Set(seen).size).toBe(6);
  });

  it('indoor evidence follows its chance and where: floor items lie on the floor, container items are concealed', () => {
    let placed = 0;
    let concealed = 0;
    for (const l of [...of('house'), ...of('apartment')]) {
      for (let call = 1; call <= 60; call++) {
        const plan = planInterior(SEED, call, l, indoorFamily(INDOOR, 'domestic'), []);
        const slots = new Set<number>();
        for (const it of plan.items) {
          placed++;
          expect(slots.has(it.itemSpot)).toBe(false);
          slots.add(it.itemSpot);
          if (it.where === 'floor') expect(it).toMatchObject({ furniture: -1, container: 'none', concealed: false });
          if (it.where === 'surface') expect(it).toMatchObject({ container: 'none', concealed: false });
          if (it.where === 'container') {
            expect(it.concealed).toBe(true);
            expect(it.container).not.toBe('none');
            concealed++;
          }
          expect(l.rooms[it.room]).toBeDefined();
        }
      }
    }
    expect(placed).toBeGreaterThan(50);
    expect(concealed).toBeGreaterThan(0);
  });

  it('works for every layout of the sample city with every indoor family (no throw, spots valid)', () => {
    for (const l of layouts) {
      for (const f of Object.values(INDOOR.families)) {
        const people = parts({ role: 'a' }, { role: 'b', spot: 'hidden' }, { role: 'c', spot: 'door' }, { role: 'd', lying: true });
        const plan = planInterior(SEED, 5, l, f, people);
        for (const p of plan.places) {
          expect(Number.isFinite(p.x) && Number.isFinite(p.z)).toBe(true);
          if (p.mode === 'inside') expect(l.spawnSpots[p.spotIndex]).toBeDefined();
        }
      }
    }
  });
});
