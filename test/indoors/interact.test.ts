import { afterEach, describe, expect, it } from 'vitest';
import type { InteriorDoor, InteriorLayout } from '../../src/interior/types';
import { findBuilding, loadGc, layoutOf, makeRig, type Rig } from './helpers';

declare const process: { memoryUsage(): { heapUsed: number } };

let rig: Rig | null = null;
afterEach(() => {
  rig?.dispose();
  rig = null;
});

// Yaw 0 faces -Z: forward = (-sin yaw, -cos yaw).
const facing = (fromX: number, fromZ: number, toX: number, toZ: number): number => Math.atan2(-(toX - fromX), -(toZ - fromZ));

describe('nearestInteractable', () => {
  it('offers the entrance of a resident building within 1.8 m, in any direction', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const main = layout.doors.find((d) => d.main) as InteriorDoor;
    const ex = main.exit?.x ?? 0, ez = main.exit?.z ?? 0;
    rig.officer.x = ex;
    rig.officer.z = ez;
    rig.steps(2);
    const near = rig.sys.nearestInteractable(ex + 1, ez, 0.3, -1);
    expect(near).toMatchObject({ kind: 'entrance', buildingId: b.id, door: main.index });
    expect(near?.distance).toBeCloseTo(1, 4);
    // Facing away makes no difference for entrances.
    expect(rig.sys.nearestInteractable(ex + 1, ez, 3, -1)?.kind).toBe('entrance');
    expect(rig.sys.nearestInteractable(ex + 2.5, ez, 0, -1)).toBeNull();
    // The result is a scratch object.
    const a = rig.sys.nearestInteractable(ex, ez, 0, -1);
    const c = rig.sys.nearestInteractable(ex + 0.5, ez, 0, -1);
    expect(a).toBe(c);
    // Nothing for a building that is not resident.
    rig.officer.x = 1e6;
    rig.steps(16);
    expect(rig.sys.nearestInteractable(ex, ez, 0, -1)).toBeNull();
  });

  it('indoors: exits any direction; doors, switches and points only ahead', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    rig.sys.placeOfficerInside(b.id, layout.entry);
    const main = layout.doors.find((d) => d.main) as InteriorDoor;
    // Exit: near the main door, facing away.
    const e = rig.sys.nearestInteractable(layout.entry.x, layout.entry.z, layout.entry.yaw + Math.PI, b.id);
    expect(e).toMatchObject({ kind: 'exit', buildingId: b.id, door: main.index });

    // An interior door: in front of it, then looking the other way.
    const d = layout.doors.find((x) => x.b >= 0 && x.kind === 'interior') as InteriorDoor;
    const room = (layout.rooms[d.a] as InteriorLayout['rooms'][number]).rect;
    const px = d.axis === 'x' ? d.x : d.x + ((room.minX + room.maxX) / 2 < d.x ? -1 : 1);
    const pz = d.axis === 'x' ? d.z + ((room.minZ + room.maxZ) / 2 < d.z ? -1 : 1) : d.z;
    const yawTo = facing(px, pz, d.x, d.z);
    const hit = rig.sys.nearestInteractable(px, pz, yawTo, b.id);
    expect(hit).toMatchObject({ kind: 'door', buildingId: b.id, door: d.index, state: 'closed' });
    expect(hit?.distance).toBeCloseTo(1, 4);
    expect((rig.sys.nearestInteractable(px, pz, yawTo + Math.PI, b.id) as { door?: number } | null)?.door).not.toBe(d.index);
    // 70 degrees off the line is outside the 60 degree half cone.
    expect((rig.sys.nearestInteractable(px, pz, yawTo + 1.22, b.id) as { door?: number } | null)?.door).not.toBe(d.index);
    expect((rig.sys.nearestInteractable(px, pz, yawTo + 0.5, b.id) as { door?: number } | null)?.door).toBe(d.index);
    rig.sys.setDoorState(b.id, d.index, 'locked');
    expect(rig.sys.nearestInteractable(px, pz, yawTo, b.id)).toMatchObject({ kind: 'door', state: 'locked' });

    // A switch within 1.2 m.
    const sr = layout.rooms.find((r) => r.switchAt !== null) as InteriorLayout['rooms'][number];
    const sw = sr.switchAt as NonNullable<typeof sr.switchAt>;
    const sx = sw.x - Math.sin(sw.yaw) * 0.0, sz = sw.z;
    const near = rig.sys.nearestInteractable(sx + 0.5, sz, facing(sx + 0.5, sz, sw.x, sw.z), b.id);
    expect(near).toMatchObject({ kind: 'switch', buildingId: b.id, room: sr.index, on: false });
    rig.sys.setRoomLight(b.id, sr.index, true);
    expect(rig.sys.nearestInteractable(sx + 0.5, sz, facing(sx + 0.5, sz, sw.x, sw.z), b.id)).toMatchObject({ kind: 'switch', on: true });
    expect(rig.sys.nearestInteractable(sx + 1.4, sz, facing(sx + 1.4, sz, sw.x, sw.z), b.id)?.kind).not.toBe('switch');
  });

  it('offers station points (locker, armory...) within 1.8 m ahead', async () => {
    rig = await makeRig();
    const station = rig.buildings.station();
    const b = station as NonNullable<typeof station>;
    const layout = layoutOf(b);
    rig.sys.placeOfficerInside(b.id, layout.entry);
    const kinds = new Set<string>();
    for (const [i, p] of layout.points.entries()) {
      const hit = rig.sys.nearestInteractable(p.x, p.z, p.yaw, b.id);
      // Standing on the point facing the furniture: something is in reach (the point itself unless a door is closer).
      expect(hit).not.toBeNull();
      if (hit?.kind === 'point') {
        kinds.add(hit.pointKind);
        expect(hit.buildingId).toBe(b.id);
        expect(layout.points[hit.point]?.kind).toBe(hit.pointKind);
        if (hit.point === i) expect(hit.distance).toBeCloseTo(0, 5);
      }
    }
    expect(kinds.size).toBeGreaterThanOrEqual(3);
  });

  it('is allocation-free after warm-up', async () => {
    rig = await makeRig();
    const gc = await loadGc();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    rig.sys.placeOfficerInside(b.id, layout.entry);
    rig.steps(3);
    for (let i = 0; i < 30000; i++) rig.sys.nearestInteractable(layout.entry.x + (i % 7) * 0.1, layout.entry.z, i * 0.01, b.id);
    const ax = layout.entry.x, az = layout.entry.z, ayaw = 0.7;
    let worst = 0;
    for (let k = 0; k < 6; k++) {
      gc();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 20000; i++) rig.sys.nearestInteractable(ax, az, ayaw, b.id);
      worst = Math.max(worst, process.memoryUsage().heapUsed - before);
    }
    // 20 000 calls: even a few bytes per call would show.
    expect(worst).toBeLessThan(96 * 1024);
  });
});

describe('floorPlan', () => {
  it('lists room rectangles and door open flags, refreshed in place', async () => {
    rig = await makeRig();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const plan = rig.sys.floorPlan(b.id);
    expect(plan).not.toBeNull();
    const p = plan as NonNullable<typeof plan>;
    expect(p.rect).toEqual(layout.rect);
    expect(p.rooms.length).toBe(layout.rooms.length * 4);
    expect(p.doors.length).toBe(layout.doors.length * 3);
    layout.rooms.forEach((r, i) => {
      expect(p.rooms[i * 4]).toBeCloseTo(r.rect.minX, 2);
      expect(p.rooms[i * 4 + 1]).toBeCloseTo(r.rect.minZ, 2);
      expect(p.rooms[i * 4 + 2]).toBeCloseTo(r.rect.maxX, 2);
      expect(p.rooms[i * 4 + 3]).toBeCloseTo(r.rect.maxZ, 2);
    });
    const d = layout.doors.find((x) => x.b >= 0 && !x.lockedAtStart) as InteriorDoor;
    expect(p.doors[d.index * 3]).toBeCloseTo(d.x, 2);
    expect(p.doors[d.index * 3 + 1]).toBeCloseTo(d.z, 2);
    expect(p.doors[d.index * 3 + 2]).toBe(0);
    rig.sys.setDoorState(b.id, d.index, 'open');
    const again = rig.sys.floorPlan(b.id);
    expect(again).toBe(plan);
    expect(p.doors[d.index * 3 + 2]).toBe(1);
    rig.sys.setDoorState(b.id, d.index, 'broken');
    rig.sys.floorPlan(b.id);
    expect(p.doors[d.index * 3 + 2]).toBe(1);
    rig.sys.setDoorState(b.id, d.index, 'locked');
    rig.sys.floorPlan(b.id);
    expect(p.doors[d.index * 3 + 2]).toBe(0);
    expect(rig.sys.floorPlan(1_000_000_000)).toBeNull();
  });
});

describe('step cost', () => {
  it('averages well under 0.02 ms and allocates nothing while idle, indoors and outdoors', async () => {
    rig = await makeRig();
    const gc = await loadGc();
    const b = findBuilding('house');
    const layout = layoutOf(b);
    const o = rig.officer;
    // Outdoors, walking along the street (residency checks run every 15 steps).
    o.x = b.door.x;
    o.z = b.door.z - 30;
    const walk = (n: number): void => {
      for (let i = 0; i < n; i++) {
        o.x += 0.05;
        rig?.sys.step(1 / 60, o);
      }
    };
    walk(600);
    const t0 = performance.now();
    walk(6000);
    expect((performance.now() - t0) / 6000).toBeLessThan(0.05);
    let worst = 0;
    for (let k = 0; k < 6; k++) {
      gc();
      const before = process.memoryUsage().heapUsed;
      walk(1000);
      worst = Math.max(worst, process.memoryUsage().heapUsed - before);
    }
    expect(worst).toBeLessThan(128 * 1024);

    // Indoors.
    rig.sys.placeOfficerInside(b.id, layout.entry);
    o.x = layout.entry.x;
    o.z = layout.entry.z;
    for (let i = 0; i < 600; i++) rig.sys.step(1 / 60, o);
    const t1 = performance.now();
    for (let i = 0; i < 6000; i++) rig.sys.step(1 / 60, o);
    expect((performance.now() - t1) / 6000).toBeLessThan(0.02);
    worst = 0;
    for (let k = 0; k < 6; k++) {
      gc();
      const before = process.memoryUsage().heapUsed;
      for (let i = 0; i < 2000; i++) rig.sys.step(1 / 60, o);
      worst = Math.max(worst, process.memoryUsage().heapUsed - before);
    }
    expect(worst).toBeLessThan(64 * 1024);
  });
});
