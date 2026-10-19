import { describe, expect, it } from 'vitest';
import { hourOf, isOpenAt, occupantPlan } from '../../src/indoors/occupants';
import type { OccupantSpawn } from '../../src/indoors/types';
import { PERSON_POPULATION } from '../../src/records/ids';
import { BuildingIndex } from '../../src/world/buildings';
import { cityBuildings } from '../interior/helpers';
import { cityFor } from '../world/helpers';
import { SEED, findBuilding, layoutOf } from './helpers';

const DAY = 86400;
const at = (day: number, hour: number): number => day * DAY + hour * 3600 + 30;
const plan = (kind: Parameters<typeof findBuilding>[0], t: number): OccupantSpawn[] => occupantPlan(SEED, layoutOf(findBuilding(kind)), t, []);

describe('occupantPlan', () => {
  it('is deterministic and independent of call history', () => {
    const layout = layoutOf(findBuilding('house'));
    const a = occupantPlan(SEED, layout, at(3, 23), []);
    occupantPlan(SEED, layout, at(9, 4), []);
    const b = occupantPlan(SEED, layout, at(3, 23), []);
    expect(b).toEqual(a);
    expect(a.length).toBeGreaterThan(0);
    // A different seed picks different people.
    expect(occupantPlan(SEED + 1, layout, at(3, 23), []).map((o) => o.personId)).not.toEqual(a.map((o) => o.personId));
  });

  it('clears and returns the output array', () => {
    const layout = layoutOf(findBuilding('house'));
    const out: OccupantSpawn[] = [{ buildingId: 1, personId: 1, x: 0, z: 0, yaw: 0, pose: 'stand', profile: 'x', role: 'staff' }];
    expect(occupantPlan(SEED, layout, at(0, 12), out)).toBe(out);
    expect(out.every((o) => o.buildingId === layout.buildingId)).toBe(true);
  });

  it('keeps counts inside the template ranges and every field valid', () => {
    const buildings = cityBuildings(new BuildingIndex(cityFor(SEED)), 6);
    let nonEmpty = 0;
    for (const b of buildings) {
      const layout = layoutOf(b);
      for (const hour of [2, 8, 12, 18, 21]) {
        const out = occupantPlan(SEED, layout, at(4, hour), []);
        const spec = layout.occupants;
        const open = isOpenAt(spec.openHours, hour);
        const night = hour >= 19 || hour < 7;
        const range = night ? spec.night : spec.day;
        // Template occupants plus the kind's extra patrons / staff (at most 3 and 1).
        if (!open) expect(out).toEqual([]);
        else expect(out.length).toBeLessThanOrEqual(Math.max(range[1], 0) + 4);
        if (out.length > 0) nonEmpty++;
        const people = new Set<number>();
        const spots = new Set<string>();
        for (const o of out) {
          expect(o.buildingId).toBe(b.id);
          expect(o.personId).toBeGreaterThanOrEqual(0);
          expect(o.personId).toBeLessThan(PERSON_POPULATION);
          expect(['stand', 'sit', 'lying']).toContain(o.pose);
          expect(['resident', 'staff', 'patron']).toContain(o.role);
          expect(o.profile.length).toBeGreaterThan(0);
          const onSpot = layout.spawnSpots.some((s) => s.x === o.x && s.z === o.z && s.yaw === o.yaw && s.pose === o.pose);
          // Patrons may stand anywhere free on a public floor instead.
          const free = o.role === 'patron' && layout.rooms.some((r) => r.public && o.x > r.rect.minX && o.x < r.rect.maxX && o.z > r.rect.minZ && o.z < r.rect.maxZ);
          expect(onSpot || free).toBe(true);
          expect(layout.furniture.some((f) => f.solid && !onSpot && o.x > f.minX && o.x < f.maxX && o.z > f.minZ && o.z < f.maxZ)).toBe(false);
          people.add(o.personId);
          spots.add(`${o.x},${o.z}`);
        }
        expect(people.size).toBe(out.length);
        expect(spots.size).toBe(out.length);
        if (layout.residential) expect(out.every((o) => o.role === 'resident')).toBe(true);
      }
    }
    expect(nonEmpty).toBeGreaterThan(20);
  });

  it('businesses are empty when closed and staffed (plus patrons) when open', () => {
    // Bank 9-17, office 8-18, warehouse 6-18, school 7-16: nobody outside those hours.
    for (const kind of ['bank', 'office', 'warehouse', 'school'] as const) {
      const open = layoutOf(findBuilding(kind)).occupants.openHours as readonly [number, number];
      const outside = (open[1] + 2) % 24;
      for (let day = 0; day < 5; day++) expect(plan(kind, at(day, outside))).toEqual([]);
      expect(plan(kind, at(1, open[0] + 1)).every((o) => o.role === 'staff')).toBe(true);
    }
    // The bank has staff by day.
    expect(plan('bank', at(2, 11)).length).toBeGreaterThan(0);
    // A store always has a clerk while open (6-24) and may have patrons; closed 00-06.
    for (let day = 0; day < 6; day++) {
      const out = plan('convenienceStore', at(day, 14));
      expect(out.filter((o) => o.role === 'staff').length).toBeGreaterThanOrEqual(1);
      expect(out.filter((o) => o.role === 'patron').length).toBeLessThanOrEqual(3);
      expect(plan('convenienceStore', at(day, 3))).toEqual([]);
    }
    const patrons = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].map((h) => plan('convenienceStore', at(2, 10 + h % 8)).filter((o) => o.role === 'patron').length);
    expect(Math.max(...patrons)).toBeGreaterThan(0);
  });

  it('bars fill with 3-8 patrons and a bartender after 16:00 and are empty at 09:00', () => {
    for (let day = 0; day < 4; day++) {
      const out = plan('bar', at(day, 21));
      const patrons = out.filter((o) => o.role === 'patron');
      expect(patrons.length).toBeGreaterThanOrEqual(3);
      expect(patrons.length).toBeLessThanOrEqual(8);
      expect(out.filter((o) => o.role === 'staff')).toHaveLength(1);
      expect(plan('bar', at(day, 9))).toEqual([]);
      expect(plan('bar', at(day, 1)).length).toBeGreaterThan(0);
    }
  });

  it('residents are stable people of the building across days; sleepers lie in bedrooms at night', () => {
    const b = findBuilding('apartment');
    const layout = layoutOf(b);
    const seen: number[][] = [];
    for (let day = 0; day < 8; day++) seen.push(occupantPlan(SEED, layout, at(day, 23), []).map((o) => o.personId));
    // The k-th resident is the same person every day (the shorter list is a prefix of the longer).
    for (const ids of seen) {
      const n = Math.min(ids.length, (seen[0] as number[]).length);
      expect(ids.slice(0, n)).toEqual((seen[0] as number[]).slice(0, n));
    }
    expect(Math.max(...seen.map((s) => s.length))).toBeGreaterThan(1);
    // Day and evening use the same people too.
    const noon = occupantPlan(SEED, layout, at(0, 12), []).map((o) => o.personId);
    for (let i = 0; i < Math.min(noon.length, seen[0]?.length ?? 0); i++) expect(noon[i]).toBe((seen[0] as number[])[i]);
    const night = occupantPlan(SEED, layout, at(0, 23), []);
    const lying = night.filter((o) => o.pose === 'lying');
    expect(lying.length).toBe(Math.min(night.length, layout.spawnSpots.filter((s) => s.pose === 'lying').length));
    expect(occupantPlan(SEED, layout, at(0, 12), []).every((o) => o.pose !== 'lying')).toBe(true);
  });

  it('hours wrap and open windows follow [open, close)', () => {
    expect(hourOf(at(0, 5))).toBe(5);
    expect(hourOf(-1)).toBe(23);
    expect(isOpenAt(null, 3)).toBe(true);
    expect(isOpenAt([9, 17], 9)).toBe(true);
    expect(isOpenAt([9, 17], 17)).toBe(false);
    expect(isOpenAt([6, 24], 23)).toBe(true);
    expect(isOpenAt([6, 24], 0)).toBe(false);
    expect(isOpenAt([16, 2], 1)).toBe(true);
    expect(isOpenAt([16, 2], 2)).toBe(false);
    expect(isOpenAt([16, 2], 20)).toBe(true);
  });
});
