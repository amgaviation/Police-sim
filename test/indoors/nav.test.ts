import { afterEach, describe, expect, it } from 'vitest';
import { roomAt } from '../../src/interior/nav';
import type { InteriorDoor, InteriorLayout } from '../../src/interior/types';
import { BuildingIndex } from '../../src/world/buildings';
import { cityBuildings } from '../interior/helpers';
import { cityFor } from '../world/helpers';
import { SEED, findBuilding, layoutOf, makeRig, type Rig } from './helpers';

let rig: Rig | null = null;
afterEach(() => {
  rig?.dispose();
  rig = null;
});

const centre = (l: InteriorLayout, room: number): { x: number; z: number } => {
  const r = (l.rooms[room] as InteriorLayout['rooms'][number]).rect;
  return { x: (r.minX + r.maxX) / 2, z: (r.minZ + r.maxZ) / 2 };
};

describe('navPort', () => {
  it('finds paths through unlocked doors and treats locked doors as walls', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const nav = rig.sys.navPort();
    const out = new Float32Array(64);
    const entryRoom = roomAt(layout, layout.entry.x, layout.entry.z);
    const far = layout.rooms.find((r) => r.index !== entryRoom && (layout.roomDoors[r.index]?.length ?? 0) > 0) as InteriorLayout['rooms'][number];
    const from = layout.entry;
    const to = centre(layout, far.index);
    // The main door starts locked but is not on an interior route.
    const open = nav.path(b.id, from.x, from.z, to.x, to.z, out);
    expect(open).toBeGreaterThan(0);
    expect(out[2 * (open - 1)]).toBeCloseTo(to.x, 3);
    expect(out[2 * (open - 1) + 1]).toBeCloseTo(to.z, 3);
    // Same room: just the target.
    expect(nav.path(b.id, from.x, from.z, from.x + 0.1, from.z, out)).toBe(1);
    // Lock every door of the destination room: unreachable.
    const doors = layout.roomDoors[far.index] as readonly number[];
    for (const di of doors) rig.sys.setDoorState(b.id, di, 'locked');
    expect(nav.path(b.id, from.x, from.z, to.x, to.z, out)).toBe(0);
    // Closed and broken doors are passable (NPCs open closed doors without animating them).
    for (const di of doors) rig.sys.setDoorState(b.id, di, 'closed');
    expect(nav.path(b.id, from.x, from.z, to.x, to.z, out)).toBe(open);
    for (const di of doors) rig.sys.setDoorState(b.id, di, 'broken');
    expect(nav.path(b.id, from.x, from.z, to.x, to.z, out)).toBe(open);
    // Unknown building: no path.
    expect(nav.path(1_000_000_000, 0, 0, 1, 1, out)).toBe(0);
  });

  it('exit routes to an unlocked exterior door and reports its outdoor pose', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const nav = rig.sys.navPort();
    const out = new Float32Array(64);
    const pose = { x: 0, z: 0, yaw: 0 };
    const room = layout.rooms.find((r) => r.index !== roomAt(layout, layout.entry.x, layout.entry.z)) as InteriorLayout['rooms'][number];
    const c = centre(layout, room.index);
    const exteriors = layout.doors.filter((d) => d.b < 0);
    // The main door is locked at the start: with it the only exit there is none; unlocking it opens the route.
    for (const d of exteriors) rig.sys.setDoorState(b.id, d.index, 'locked');
    expect(nav.exit(b.id, c.x, c.z, out, pose)).toBe(0);
    const main = exteriors.find((d) => d.main) as InteriorDoor;
    rig.sys.setDoorState(b.id, main.index, 'closed');
    const n = nav.exit(b.id, c.x, c.z, out, pose);
    expect(n).toBeGreaterThan(0);
    expect(pose).toEqual({ x: main.exit?.x, z: main.exit?.z, yaw: main.exit?.yaw });
    // The last waypoint is just inside the door.
    const lx = out[2 * (n - 1)] as number, lz = out[2 * (n - 1) + 1] as number;
    expect(Math.hypot(lx - main.x, lz - main.z)).toBeLessThan(0.5);
    expect(nav.exit(1_000_000_000, 0, 0, out, pose)).toBe(0);
  });

  it('claims distinct hiding spots, farthest from the threat, and releases them', async () => {
    rig = await makeRig();
    const index = new BuildingIndex(cityFor(SEED));
    const b = cityBuildings(index, 20).find((x) => layoutOf(x).hidingSpots.length >= 3);
    expect(b).toBeDefined();
    const info = b as NonNullable<typeof b>;
    const layout = layoutOf(info);
    const nav = rig.sys.navPort();
    // Make every door passable so reachability does not matter here.
    for (const d of layout.doors) if (d.lockedAtStart) rig.sys.setDoorState(info.id, d.index, 'closed');
    const from = centre(layout, roomAt(layout, layout.entry.x, layout.entry.z));
    const away = { x: layout.entry.x, z: layout.entry.z };
    const pose = { x: 0, z: 0, yaw: 0 };
        const claimed: number[] = [];
    let expectedFirst = -1;
    let bestD = -1;
    for (const s of layout.hidingSpots) {
      const d = (s.x - away.x) ** 2 + (s.z - away.z) ** 2;
      if (d > bestD) { bestD = d; expectedFirst = s.index; }
    }
    for (let i = 0; i < 2; i++) {
      const idx = nav.hideSpot(info.id, from.x, from.z, away.x, away.z, pose);
      if (idx < 0) break;
      claimed.push(idx);
      const spot = layout.hidingSpots[idx] as InteriorLayout['hidingSpots'][number];
      expect(pose).toEqual({ x: spot.x, z: spot.z, yaw: spot.yaw });
    }
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(claimed.length).toBeGreaterThanOrEqual(2);
    // Every room is reachable through unlocked doors, so the first claim is the spot farthest from the threat.
    expect(claimed[0]).toBe(expectedFirst);
    // All taken: none left. Releasing one frees exactly it.
    while (nav.hideSpot(info.id, from.x, from.z, away.x, away.z, pose) >= 0) { /* exhaust */ }
    expect(nav.hideSpot(info.id, from.x, from.z, away.x, away.z, pose)).toBe(-1);
    nav.releaseHide(info.id, claimed[0] as number);
    expect(nav.hideSpot(info.id, from.x, from.z, away.x, away.z, pose)).toBe(claimed[0]);
    // Claims are per building.
    expect(nav.hideSpot(1_000_000_000, 0, 0, 0, 0, pose)).toBe(-1);
  });

  it('does not hide an actor behind a locked door it cannot pass', async () => {
    rig = await makeRig();
    const index = new BuildingIndex(cityFor(SEED));
    const info = cityBuildings(index, 20).find((x) => layoutOf(x).hidingSpots.length >= 2 && layoutOf(x).rooms.length >= 3);
    expect(info).toBeDefined();
    const b = info as NonNullable<typeof info>;
    const layout = layoutOf(b);
    const nav = rig.sys.navPort();
    const pose = { x: 0, z: 0, yaw: 0 };
    const spotRoom = (layout.hidingSpots[0] as InteriorLayout['hidingSpots'][number]).room;
    const standIn = layout.rooms.find((r) => r.index !== spotRoom) as InteriorLayout['rooms'][number];
    // Seal the room that holds spot 0: every claim must come from other rooms.
    for (const di of layout.roomDoors[spotRoom] as readonly number[]) rig.sys.setDoorState(b.id, di, 'locked');
    const c = centre(layout, standIn.index);
    const idx = nav.hideSpot(b.id, c.x, c.z, 0, 0, pose);
    if (idx >= 0) expect((layout.hidingSpots[idx] as InteriorLayout['hidingSpots'][number]).room).not.toBe(spotRoom);
  });
});
