import { afterEach, describe, expect, it } from 'vitest';
import type { InteriorMoveOfficerEvent, InteriorTransitionEvent } from '../../src/indoors';
import { INTERIOR_FLOOR_Y } from '../../src/interior/constants';
import { roomAt } from '../../src/interior/nav';
import type { InteriorDoor } from '../../src/interior/types';
import { BuildingIndex } from '../../src/world/buildings';
import { cityBuildings } from '../interior/helpers';
import { cityFor } from '../world/helpers';
import { SEED, findBuilding, layoutOf, makeRig, type Rig } from './helpers';

let rig: Rig | null = null;
afterEach(() => {
  rig?.dispose();
  rig = null;
});

const moves = (r: Rig): InteriorMoveOfficerEvent[] => r.events.filter((e) => e.topic === 'interior:moveOfficer').map((e) => e.payload as InteriorMoveOfficerEvent);
const phases = (r: Rig): string[] =>
  r.events.filter((e) => e.topic === 'interior:transition').map((e) => {
    const p = e.payload as InteriorTransitionEvent;
    return `${p.entering ? 'enter' : 'exit'}:${p.phase}`;
  });

describe('enter and exit', () => {
  it('enters through the main door: fade out, move at black, fade in', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const main = layout.doors.find((d) => d.main) as InteriorDoor;
    rig.sys.setDoorState(b.id, main.index, 'closed');
    rig.officer.x = main.exit?.x ?? 0;
    rig.officer.z = main.exit?.z ?? 0;
    rig.steps(2);
    rig.events.length = 0;
    rig.sys.request({ kind: 'enter', buildingId: b.id, door: main.index });

    const fades: number[] = [];
    let moveStep = -1;
    let officerAtMove = -2;
    for (let i = 0; i < 60; i++) {
      rig.steps(1);
      fades.push(rig.sys.fade);
      if (moveStep < 0 && moves(rig).length > 0) {
        moveStep = i;
        officerAtMove = rig.sys.officerBuilding;
      }
    }
    // The move happens exactly when the screen is black, after about 0.3 s.
    expect(moveStep).toBeGreaterThanOrEqual(17);
    expect(moveStep).toBeLessThanOrEqual(19);
    expect(fades[moveStep]).toBe(1);
    expect(officerAtMove).toBe(b.id);
    const m = moves(rig);
    expect(m).toHaveLength(1);
    expect(m[0]?.buildingId).toBe(b.id);
    expect(m[0]?.y).toBe(INTERIOR_FLOOR_Y);
    expect(m[0]?.x).toBeCloseTo(layout.entry.x, 4);
    expect(m[0]?.z).toBeCloseTo(layout.entry.z, 4);
    expect(m[0]?.yaw).toBeCloseTo(layout.entry.yaw, 4);
    // The fade rises monotonically to 1 and falls back to 0 about 0.3 s later.
    for (let i = 1; i <= moveStep; i++) expect(fades[i] as number).toBeGreaterThanOrEqual(fades[i - 1] as number);
    for (let i = moveStep + 1; i < fades.length; i++) expect(fades[i] as number).toBeLessThanOrEqual(fades[i - 1] as number);
    expect(fades.at(-1)).toBe(0);
    const clearAt = fades.findIndex((f, i) => i > moveStep && f === 0);
    expect(clearAt - moveStep).toBeGreaterThanOrEqual(17);
    expect(clearAt - moveStep).toBeLessThanOrEqual(19);
    expect(phases(rig)).toEqual(['enter:out', 'enter:in', 'enter:done']);
    // The door was opened for the officer.
    expect(rig.sys.doorState(b.id, main.index)).toBe('open');
    expect(rig.sys.officerBuilding).toBe(b.id);
    expect(rig.sys.resident).toEqual([b.id]);
  });

  it('exits to the door outdoor pose at ground level', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const main = layout.doors.find((d) => d.main) as InteriorDoor;
    rig.sys.placeOfficerInside(b.id, layout.entry);
    rig.officer.x = layout.entry.x;
    rig.officer.z = layout.entry.z;
    rig.steps(2);
    expect(rig.sys.officerBuilding).toBe(b.id);
    rig.events.length = 0;
    // A locked front door is unlocked from the inside by leaving through it.
    expect(rig.sys.doorState(b.id, main.index)).toBe('locked');
    rig.sys.request({ kind: 'exit', door: main.index });
    rig.steps(60);
    const m = moves(rig);
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ buildingId: -1, y: 0 });
    expect(m[0]?.x).toBeCloseTo(main.exit?.x ?? 0, 4);
    expect(m[0]?.z).toBeCloseTo(main.exit?.z ?? 0, 4);
    expect(m[0]?.yaw).toBeCloseTo(main.exit?.yaw ?? 0, 4);
    expect(rig.sys.officerBuilding).toBe(-1);
    expect(rig.sys.doorState(b.id, main.index)).toBe('open');
    expect(phases(rig)).toEqual(['exit:out', 'exit:in', 'exit:done']);
    expect(rig.sys.fade).toBe(0);
    // The building stays resident while the officer is at its door.
    rig.officer.x = main.exit?.x ?? 0;
    rig.officer.z = main.exit?.z ?? 0;
    rig.steps(16);
    expect(rig.sys.resident).toEqual([b.id]);
  });

  it('places the officer 1 m inside a secondary exterior door facing in', async () => {
    rig = await makeRig();
    let tested = 0;
    const candidates = cityBuildings(new BuildingIndex(cityFor(SEED)), 20).filter((x) => x.kind === 'house' || x.kind === 'warehouse');
    for (const b of candidates) {
      if (tested >= 6) break;
      const layout = layoutOf(b);
      const door = layout.doors.find((d) => d.b < 0 && !d.main);
      if (!door?.exit) continue;
      rig.sys.placeOfficerInside(b.id, layout.entry);
      rig.sys.setDoorState(b.id, door.index, 'closed');
      rig.sys.request({ kind: 'exit', door: door.index });
      rig.officer.x = door.x;
      rig.officer.z = door.z;
      rig.steps(60);
      expect(rig.sys.officerBuilding).toBe(-1);
      rig.events.length = 0;
      rig.officer.x = door.exit.x;
      rig.officer.z = door.exit.z;
      rig.steps(16);
      // Residency follows the footprint, so the back door's own building is resident whatever its neighbours' front doors.
      expect(rig.sys.resident).toContain(b.id);
      rig.sys.request({ kind: 'enter', buildingId: b.id, door: door.index });
      rig.steps(60);
      const m = moves(rig)[0] as InteriorMoveOfficerEvent;
      expect(m.buildingId).toBe(b.id);
      expect(Math.hypot(m.x - door.x, m.z - door.z)).toBeCloseTo(1, 3);
      expect(roomAt(layout, m.x, m.z)).toBe(door.a);
      // Facing in: forward = (-sin yaw, -cos yaw) points from the door towards the pose's side.
      const fx = -Math.sin(m.yaw), fz = -Math.cos(m.yaw);
      expect(fx * (m.x - door.x) + fz * (m.z - door.z)).toBeGreaterThan(0.9);
      tested++;
    }
    expect(tested).toBeGreaterThanOrEqual(4);
  });

  it('ignores enter from too far, while driving, and while a transition runs', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const main = layout.doors.find((d) => d.main) as InteriorDoor;
    rig.sys.setDoorState(b.id, main.index, 'closed');
    const ex = main.exit?.x ?? 0, ez = main.exit?.z ?? 0;
    rig.officer.x = ex;
    rig.officer.z = ez;
    rig.steps(2);
    rig.events.length = 0;
    rig.officer.z = ez + 4;
    rig.sys.request({ kind: 'enter', buildingId: b.id, door: main.index });
    rig.steps(5);
    expect(phases(rig)).toEqual([]);
    rig.officer.z = ez;
    rig.officer.onFoot = false;
    rig.sys.request({ kind: 'enter', buildingId: b.id, door: main.index });
    rig.steps(5);
    expect(phases(rig)).toEqual([]);
    rig.officer.onFoot = true;
    rig.sys.request({ kind: 'enter', buildingId: b.id, door: main.index });
    rig.sys.request({ kind: 'enter', buildingId: b.id, door: main.index });
    rig.steps(60);
    expect(phases(rig)).toEqual(['enter:out', 'enter:in', 'enter:done']);
    expect(moves(rig)).toHaveLength(1);
    // Exit from the wrong distance does nothing either.
    rig.events.length = 0;
    rig.officer.x = layout.entry.x + 6;
    rig.sys.request({ kind: 'exit', door: main.index });
    rig.steps(5);
    expect(phases(rig)).toEqual([]);
    expect(rig.sys.officerBuilding).toBe(b.id);
  });

  it('placeOfficerInside is synchronous: resident, officer level and the move event', async () => {
    rig = await makeRig();
    const station = rig.buildings.station();
    expect(station).not.toBeNull();
    const id = station?.id ?? -1;
    const layout = layoutOf(station as NonNullable<typeof station>);
    const pose = { x: layout.entry.x + 1, z: layout.entry.z, yaw: 1.5 };
    rig.sys.placeOfficerInside(id, pose);
    expect(rig.sys.officerBuilding).toBe(id);
    expect(rig.sys.resident).toEqual([id]);
    expect(rig.physics.raw.colliders.len()).toBe(rig.sys.stats.colliders);
    expect(moves(rig)).toEqual([{ buildingId: id, x: pose.x, y: INTERIOR_FLOOR_Y, z: pose.z, yaw: 1.5 }]);
    expect(rig.sys.fade).toBe(0);
    // Not an enterable building: nothing happens.
    rig.sys.placeOfficerInside(1_000_000_000, pose);
    expect(rig.sys.officerBuilding).toBe(id);
  });

  it('keeps only the officer building resident while indoors', async () => {
    rig = await makeRig();
    const a = findBuilding('house');
    const b = findBuilding('bank');
    rig.officer.x = a.door.x;
    rig.officer.z = a.door.z;
    rig.steps(2);
    expect(rig.sys.resident).toEqual([a.id]);
    rig.sys.placeOfficerInside(b.id, layoutOf(b).entry);
    expect(rig.sys.resident).toEqual([b.id]);
    rig.officer.x = a.door.x;
    rig.officer.z = a.door.z;
    rig.steps(40);
    expect(rig.sys.resident).toEqual([b.id]);
  });
});
