import { afterEach, describe, expect, it } from 'vitest';
import { unitHash } from '../../src/records/hash';
import { cityBuildings } from '../interior/helpers';
import { findBuilding, layoutOf, makeRig, SEED, type Rig } from './helpers';

let rig: Rig | null = null;
afterEach(() => {
  rig?.dispose();
  rig = null;
});

const switchEvents = (r: Rig): unknown[] => r.events.filter((e) => e.topic === 'interior:switch').map((e) => e.payload);

describe('room lights', () => {
  it('residential rooms are lit only at night, for the hashed 35% of rooms', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const lit = (hour: number): number[] => {
      (rig as Rig).time.now = hour * 3600 + 120;
      return layout.rooms.filter((r) => (rig as Rig).sys.roomLit(b.id, r.index)).map((r) => r.index);
    };
    expect(lit(12)).toEqual([]);
    expect(lit(8)).toEqual([]);
    const expected = layout.rooms.filter((r) => r.light !== null && unitHash(SEED, 0x11c7, b.id * 64 + r.index) < 0.35).map((r) => r.index);
    for (const hour of [19, 22, 3, 6]) expect(lit(hour)).toEqual(expected);
    // Across many houses a third or so of the lightable rooms are on.
    let on = 0, total = 0;
    rig.time.now = 23 * 3600;
    for (const info of cityBuildings(rig.buildings, 20)) {
      if (info.kind !== 'house' && info.kind !== 'apartment') continue;
      for (const r of layoutOf(info).rooms) {
        if (r.light === null) continue;
        total++;
        if (rig.sys.roomLit(info.id, r.index)) on++;
      }
    }
    expect(total).toBeGreaterThan(60);
    expect(on / total).toBeGreaterThan(0.2);
    expect(on / total).toBeLessThan(0.5);
  });

  it('businesses are lit while open, and hospitals, jails and the station always', async () => {
    rig = await makeRig();
    const store = findBuilding('convenienceStore');
    const layout = layoutOf(store);
    expect(layout.occupants.openHours).toEqual([6, 24]);
    const lights = layout.rooms.filter((r) => r.light !== null).map((r) => r.index);
    expect(lights.length).toBeGreaterThan(0);
    rig.time.now = 12 * 3600;
    expect(lights.every((i) => rig?.sys.roomLit(store.id, i))).toBe(true);
    rig.time.now = 3 * 3600;
    expect(lights.some((i) => rig?.sys.roomLit(store.id, i))).toBe(false);

    const bank = findBuilding('bank');
    const bankLights = layoutOf(bank).rooms.filter((r) => r.light !== null).map((r) => r.index);
    rig.time.now = 10 * 3600;
    expect(bankLights.every((i) => rig?.sys.roomLit(bank.id, i))).toBe(true);
    rig.time.now = 20 * 3600;
    expect(bankLights.some((i) => rig?.sys.roomLit(bank.id, i))).toBe(false);

    // A bar opens at 16:00 and closes at 02:00 (wraps past midnight).
    const bar = findBuilding('bar');
    const barLight = layoutOf(bar).rooms.find((r) => r.light !== null)?.index ?? -1;
    for (const [hour, on] of [[15, false], [16, true], [23, true], [1, true], [2, false], [9, false]] as const) {
      rig.time.now = hour * 3600;
      expect(rig.sys.roomLit(bar.id, barLight)).toBe(on);
    }

    const jail = rig.buildings.jail();
    const station = rig.buildings.station();
    for (const info of [jail, station, findBuilding('hospital')]) {
      expect(info).not.toBeNull();
      const l = layoutOf(info as NonNullable<typeof info>);
      for (const hour of [3, 12]) {
        rig.time.now = hour * 3600;
        for (const r of l.rooms) expect(rig.sys.roomLit(l.buildingId, r.index)).toBe(r.light !== null);
      }
    }
  });

  it('a room without a fixture is never lit, whatever the override', async () => {
    rig = await makeRig();
    const b = findBuilding('office');
    const layout = layoutOf(b);
    const dark = layout.rooms.find((r) => r.light === null);
    if (!dark) return;
    rig.sys.setRoomLight(b.id, dark.index, true);
    expect(rig.sys.roomLit(b.id, dark.index)).toBe(false);
  });

  it('overrides win over the default and a switch toggles within reach only', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    rig.time.now = 12 * 3600;
    const room = layout.rooms.find((r) => r.switchAt !== null && r.light !== null);
    expect(room).toBeDefined();
    const r = room as NonNullable<typeof room>;
    const sw = r.switchAt as NonNullable<typeof r.switchAt>;
    rig.sys.placeOfficerInside(b.id, { x: sw.x, z: sw.z, yaw: 0 });
    rig.officer.x = sw.x + 0.5;
    rig.officer.z = sw.z;
    rig.steps(2);
    rig.events.length = 0;
    expect(rig.sys.roomLit(b.id, r.index)).toBe(false);
    const rev = rig.sys.revision;
    rig.sys.request({ kind: 'switch', buildingId: b.id, room: r.index });
    rig.steps(1);
    expect(rig.sys.roomLit(b.id, r.index)).toBe(true);
    expect(rig.sys.revision).toBeGreaterThan(rev);
    expect(switchEvents(rig)).toEqual([{ buildingId: b.id, room: r.index, on: true }]);
    // The override survives the hour changing; the default would be off at noon and on at night for some rooms.
    rig.time.now = 2 * 3600;
    expect(rig.sys.roomLit(b.id, r.index)).toBe(true);
    rig.sys.request({ kind: 'switch', buildingId: b.id, room: r.index });
    rig.steps(1);
    expect(rig.sys.roomLit(b.id, r.index)).toBe(false);
    // Out of reach: ignored.
    rig.officer.x = sw.x + 3;
    rig.events.length = 0;
    rig.sys.request({ kind: 'switch', buildingId: b.id, room: r.index });
    rig.steps(1);
    expect(rig.sys.roomLit(b.id, r.index)).toBe(false);
    expect(switchEvents(rig)).toEqual([]);
    // Scenes force a light directly.
    rig.sys.setRoomLight(b.id, r.index, true);
    expect(rig.sys.roomLit(b.id, r.index)).toBe(true);
  });

  it('bumps the revision when the hour changes while an interior is resident', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    rig.time.now = 12 * 3600;
    rig.officer.x = b.door.x;
    rig.officer.z = b.door.z;
    rig.steps(20);
    const rev = rig.sys.revision;
    rig.steps(5);
    expect(rig.sys.revision).toBe(rev);
    rig.time.now = 13 * 3600;
    rig.steps(1);
    expect(rig.sys.revision).toBeGreaterThan(rev);
  });
});
