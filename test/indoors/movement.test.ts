import RAPIER, { type Collider, type KinematicCharacterController } from '@dimforge/rapier3d-compat';
import { afterEach, describe, expect, it } from 'vitest';
import { INTERIOR_FLOOR_Y } from '../../src/interior/constants';
import { roomAt } from '../../src/interior/nav';
import type { InteriorDoor, InteriorLayout } from '../../src/interior/types';
import { findBuilding, layoutOf, makeRig, type Rig } from './helpers';

let rig: Rig | null = null;
afterEach(() => {
  rig?.dispose();
  rig = null;
});

const DT = 1 / 60;
const HALF = { x: 0.4, y: 0.9, z: 0.4 };
const EID = 9001;
const FILTER = RAPIER.QueryFilterFlags.EXCLUDE_KINEMATIC | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS;

/** An officer body and character controller set up like game/session.ts (same cylinder, skin and filter). */
function walker(
  r: Rig, x: number, z: number, yaw = 0, shape: 'cylinder' | 'box' = 'cylinder',
): { walk(vx: number, vz: number, steps: number): { x: number; z: number } } {
  const at = { x, y: INTERIOR_FLOOR_Y + HALF.y, z };
  const body = shape === 'cylinder'
    ? r.physics.addCylinder(EID, at, HALF.y, HALF.x, { kinematic: true, friction: 0.2 })
    : r.physics.addBox(EID, at, HALF, { kinematic: true, friction: 0.2 });
  body.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
  r.physics.step();
  const collider: Collider = body.collider(0);
  const mover: KinematicCharacterController = r.physics.raw.createCharacterController(0.02);
  mover.disableSnapToGround();
  mover.setApplyImpulsesToDynamicBodies(false);
  const blocks = (c: Collider): boolean => (r.physics.eidOfCollider(c.handle) === undefined ? !r.physics.isGround(c.handle) : false);
  const v = { x: 0, y: 0, z: 0 };
  return {
    walk(vx, vz, steps) {
      for (let i = 0; i < steps; i++) {
        v.x = vx * DT;
        v.y = 0;
        v.z = vz * DT;
        mover.computeColliderMovement(collider, v, FILTER, undefined, blocks);
        const m = mover.computedMovement();
        body.setLinvel({ x: m.x / DT, y: 0, z: m.z / DT }, true);
        r.physics.step();
      }
      const t = body.translation();
      return { x: t.x, z: t.z };
    },
  };
}

/** Unit normal from room `a` side towards room `b` of a door, plus the point `back` m before the door on a's side. */
function approach(layout: InteriorLayout, d: InteriorDoor, back: number): { nx: number; nz: number; sx: number; sz: number } {
  const room = (layout.rooms[d.a] as InteriorLayout['rooms'][number]).rect;
  const cx = (room.minX + room.maxX) / 2, cz = (room.minZ + room.maxZ) / 2;
  if (d.axis === 'x') {
    const s = cz < d.z ? 1 : -1;
    return { nx: 0, nz: s, sx: d.x, sz: d.z - s * back };
  }
  const s = cx < d.x ? 1 : -1;
  return { nx: s, nz: 0, sx: d.x - s * back, sz: d.z };
}

function clear(layout: InteriorLayout, x: number, z: number, r: number): boolean {
  return layout.furniture.every((f) => !f.solid || x < f.minX - r || x > f.maxX + r || z < f.minZ - r || z > f.maxZ + r);
}

describe('officer movement through interiors', () => {
  it('cannot cross an interior wall', async () => {
    rig = await makeRig();
    // A long wall segment with clear floor 1.2 m in front of its middle, in the first building that has one.
    let found = false;
    for (const kind of ['house', 'office', 'warehouse', 'bank', 'convenienceStore'] as const) {
      if (found) break;
      const b = findBuilding(kind);
      const layout = layoutOf(b);
      rig.sys.placeOfficerInside(b.id, layout.entry);
      rig.steps(2);
      for (let i = 0; i + 3 < layout.walls.length && !found; i += 4) {
        const x0 = layout.walls[i] as number, z0 = layout.walls[i + 1] as number, x1 = layout.walls[i + 2] as number, z1 = layout.walls[i + 3] as number;
        const horizontal = Math.abs(z1 - z0) < 1e-3;
        const len = horizontal ? Math.abs(x1 - x0) : Math.abs(z1 - z0);
        if (len < 2.5) continue;
        const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
        for (const side of [-1, 1]) {
          const sx = horizontal ? mx : mx + side * 1.2;
          const sz = horizontal ? mz + side * 1.2 : mz;
          if (roomAt(layout, sx, sz) < 0 || !clear(layout, sx, sz, 1.0)) continue;
          const w = walker(rig, sx, sz);
          const end = horizontal ? w.walk(0, -side * 3, 90) : w.walk(-side * 3, 0, 90);
          const across = horizontal ? (end.z - mz) * side : (end.x - mx) * side;
          // Stopped on its own side of the wall: centre at least half the box (0.4) plus half the wall (0.075) away.
          expect(across).toBeGreaterThan(0.4);
          expect(across).toBeLessThan(1.25);
          rig.physics.removeBody(EID);
          found = true;
          break;
        }
      }
    }
    expect(found).toBe(true);
  });

  it('stops at a closed door and passes once it is open', async () => {
    rig = await makeRig();
    let passed = 0;
    for (const kind of ['house', 'office', 'bank', 'hospital'] as const) {
      const b = findBuilding(kind);
      const layout = layoutOf(b);
      for (const d of layout.doors) {
        if (d.b < 0 || d.kind !== 'interior' || d.lockedAtStart) continue;
        const a = approach(layout, d, 0.9);
        const beyondX = d.x + a.nx * 0.9, beyondZ = d.z + a.nz * 0.9;
        if (!clear(layout, a.sx, a.sz, 0.6) || !clear(layout, beyondX, beyondZ, 0.6)) continue;
        const along = (p: { x: number; z: number }): number => (p.x - d.x) * a.nx + (p.z - d.z) * a.nz;

        rig.sys.placeOfficerInside(b.id, layout.entry);
        rig.steps(2);
        rig.sys.setDoorState(b.id, d.index, 'closed');
        rig.steps(1);
        const closedWalker = walker(rig, a.sx, a.sz);
        const blocked = closedWalker.walk(a.nx * 2, a.nz * 2, 90);
        expect(along(blocked)).toBeLessThan(-0.3);

        rig.physics.removeBody(EID);
        rig.sys.setDoorState(b.id, d.index, 'open');
        rig.steps(1);
        const openWalker = walker(rig, a.sx, a.sz);
        const through = openWalker.walk(a.nx * 2, a.nz * 2, 90);
        expect(along(through)).toBeGreaterThan(0.2);
        rig.physics.removeBody(EID);
        passed++;
        break;
      }
    }
    expect(passed).toBeGreaterThanOrEqual(3);
  });

  it('passes a 0.9 m door at every facing (the collider footprint does not depend on the yaw)', async () => {
    rig = await makeRig();
    // Two wall slabs 0.15 m thick with a 0.9 m gap at x = 0, 2 m of floor on the near side (the interior level).
    const y = INTERIOR_FLOOR_Y + 0.5;
    // Untracked static colliders, like the interior walls.
    for (const cx of [-1.9, 1.9]) rig.physics.raw.createCollider(RAPIER.ColliderDesc.cuboid(1.45, 0.5, 0.075).setTranslation(cx, y, 0));
    for (const deg of [0, 10, 15, 20, 30, 45, 60, 75, 90]) {
      const yaw = (deg * Math.PI) / 180;
      const w = walker(rig, 0, 2, yaw, 'cylinder');
      const end = w.walk(0, -2, 120);
      expect(end.z, `yaw ${String(deg)}`).toBeLessThan(-1);
      rig.physics.removeBody(EID);
    }
    // Control: the old yawed box is stuck in front of the door at 20 degrees.
    const stuck = walker(rig, 0, 2, (20 * Math.PI) / 180, 'box').walk(0, -2, 120);
    expect(stuck.z).toBeGreaterThan(0);
  });
});
