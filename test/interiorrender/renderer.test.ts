import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import { DOOR_HEIGHT } from '../../src/interior/constants';
import type { InteriorDoor, InteriorLayout } from '../../src/interior/types';
import { InteriorRenderer } from '../../src/render/interior';
import { findBuilding, loadGc, layoutOf, makeRig, type Rig } from '../indoors/helpers';

declare const process: { memoryUsage(): { heapUsed: number } };

let rig: Rig | null = null;
let renderer: InteriorRenderer | null = null;
afterEach(() => {
  renderer?.dispose();
  renderer = null;
  rig?.dispose();
  rig = null;
});

const DT = 1 / 60;
const mesh = (scene: THREE.Scene, name: string): THREE.InstancedMesh => {
  const m = scene.getObjectByName(name);
  if (!(m instanceof THREE.InstancedMesh)) throw new Error(`no mesh ${name}`);
  return m as THREE.InstancedMesh;
};

/** World position of the free end of a door panel (local x = 1) from its instance matrix. */
function freeEnd(m: THREE.InstancedMesh, index: number): { x: number; z: number } {
  const a = m.instanceMatrix.array;
  const o = index * 16;
  // Column 0 is the panel's length direction (scaled by the width); column 3 is the hinge.
  return { x: (a[o + 12] as number) + (a[o] as number), z: (a[o + 14] as number) + (a[o + 2] as number) };
}

describe('InteriorRenderer (headless)', () => {
  it('draws at most six calls for the officer building and nothing outdoors', async () => {
    rig = await makeRig();
    const scene = new THREE.Scene();
    renderer = new InteriorRenderer(scene);
    const b = findBuilding('house');
    const layout = layoutOf(b);
    rig.officer.x = b.door.x;
    rig.officer.z = b.door.z;
    rig.steps(2);
    renderer.update(rig.sys, DT, b.door.x, b.door.z);
    // Resident but the officer is outdoors: built, invisible, no draw calls.
    expect(renderer.drawCalls).toBe(0);
    const group = scene.getObjectByName(`interior:${b.id}`);
    expect(group).toBeDefined();
    expect(group?.visible).toBe(false);

    rig.sys.placeOfficerInside(b.id, layout.entry);
    renderer.update(rig.sys, DT, layout.entry.x, layout.entry.z);
    expect(group?.visible).toBe(true);
    expect(renderer.drawCalls).toBeGreaterThanOrEqual(5);
    expect(renderer.drawCalls).toBeLessThanOrEqual(6);

    // Instance counts follow the layout.
    expect(mesh(scene, 'interior-walls').count).toBe(layout.walls.length / 4);
    expect(mesh(scene, 'interior-floors').count).toBe(layout.rooms.length);
    expect(mesh(scene, 'interior-ceiling').count).toBe(1);
    expect(mesh(scene, 'interior-furniture').count).toBe(layout.furniture.length);
    expect(mesh(scene, 'interior-doors').count).toBe(layout.doors.filter((d) => d.kind !== 'wide').length);
    const fixtures = layout.rooms.filter((r) => r.light !== null).length + layout.rooms.filter((r) => r.switchAt !== null).length;
    expect(mesh(scene, 'interior-fixtures').count).toBe(fixtures);
    for (const name of ['interior-walls', 'interior-floors', 'interior-ceiling', 'interior-furniture', 'interior-doors', 'interior-fixtures']) {
      const m = mesh(scene, name);
      expect(m.castShadow).toBe(false);
      expect(m.receiveShadow).toBe(false);
      expect(m.frustumCulled).toBe(false);
    }
    expect(mesh(scene, 'interior-walls').material).toBeInstanceOf(THREE.MeshLambertMaterial);

    // Leave: invisible again.
    rig.sys.restore({ ...rig.sys.serialize(), officerBuilding: -1 });
    renderer.update(rig.sys, DT, 0, 0);
    expect(renderer.drawCalls).toBe(0);
  });

  it('shows only the officer building and frees the meshes of an unloaded one', async () => {
    rig = await makeRig();
    const scene = new THREE.Scene();
    renderer = new InteriorRenderer(scene);
    const a = findBuilding('house');
    const b = findBuilding('bank');
    rig.officer.x = a.door.x;
    rig.officer.z = a.door.z;
    rig.steps(2);
    renderer.update(rig.sys, DT, 0, 0);
    expect(scene.getObjectByName(`interior:${a.id}`)).toBeDefined();
    rig.sys.placeOfficerInside(b.id, layoutOf(b).entry);
    renderer.update(rig.sys, DT, 0, 0);
    expect(scene.getObjectByName(`interior:${a.id}`)).toBeUndefined();
    expect(scene.getObjectByName(`interior:${b.id}`)?.visible).toBe(true);
    expect(renderer.drawCalls).toBeLessThanOrEqual(6);
  });

  it('rebuilds buffers only when a building becomes resident, not on door or light changes', async () => {
    rig = await makeRig();
    const scene = new THREE.Scene();
    renderer = new InteriorRenderer(scene);
    const b = findBuilding('house');
    const layout = layoutOf(b);
    rig.sys.placeOfficerInside(b.id, layout.entry);
    renderer.update(rig.sys, DT, 0, 0);
    const walls = mesh(scene, 'interior-walls');
    const doors = mesh(scene, 'interior-doors');
    const d = layout.doors.find((x) => x.b >= 0 && !x.lockedAtStart) as InteriorDoor;
    rig.sys.setDoorState(b.id, d.index, 'open');
    const room = layout.rooms.find((r) => r.light !== null) as InteriorLayout['rooms'][number];
    rig.sys.setRoomLight(b.id, room.index, true);
    renderer.update(rig.sys, DT, 0, 0);
    expect(mesh(scene, 'interior-walls')).toBe(walls);
    expect(mesh(scene, 'interior-doors')).toBe(doors);
    // The fixture colour follows the light: lit is brighter than unlit.
    const fix = mesh(scene, 'interior-fixtures');
    const colors = fix.instanceColor?.array as Float32Array;
    const slot = layout.rooms.filter((r) => r.light !== null).findIndex((r) => r.index === room.index);
    const lit = colors[slot * 3] as number;
    rig.sys.setRoomLight(b.id, room.index, false);
    renderer.update(rig.sys, DT, 0, 0);
    expect(lit).toBeGreaterThan(colors[slot * 3] as number);
  });

  it('swings a door panel 95 degrees into room a over 0.25 s', async () => {
    rig = await makeRig();
    const scene = new THREE.Scene();
    renderer = new InteriorRenderer(scene);
    const b = findBuilding('house');
    const layout = layoutOf(b);
    rig.sys.placeOfficerInside(b.id, layout.entry);
    const doors = layout.doors.filter((d) => d.kind !== 'wide');
    for (const d of doors) {
      if (d.b < 0 || d.lockedAtStart) continue;
      const panel = doors.indexOf(d);
      renderer.update(rig.sys, DT, d.x, d.z);
      const m = mesh(scene, 'interior-doors');
      const closed = freeEnd(m, panel);
      // Closed: the panel spans the opening along its axis.
      if (d.axis === 'x') expect(Math.abs(closed.x - (d.x + d.width / 2))).toBeLessThan(1e-3);
      else expect(Math.abs(closed.z - (d.z + d.width / 2))).toBeLessThan(1e-3);
      rig.sys.setDoorState(b.id, d.index, 'open');
      // Mid-swing after ~0.12 s, finished after 0.25 s.
      for (let i = 0; i < 7; i++) renderer.update(rig.sys, DT, d.x, d.z);
      const mid = freeEnd(m, panel);
      const midAngle = Math.atan2(Math.hypot(mid.x - closed.x, mid.z - closed.z), 0);
      expect(midAngle).toBeGreaterThan(0);
      for (let i = 0; i < 12; i++) renderer.update(rig.sys, DT, d.x, d.z);
      const open = freeEnd(m, panel);
      // Hinge-to-end vectors: closed along the opening, open turned by 95 degrees.
      const a = m.instanceMatrix.array;
      const hx = a[panel * 16 + 12] as number, hz = a[panel * 16 + 14] as number;
      const v0 = { x: closed.x - hx, z: closed.z - hz };
      const v1 = { x: open.x - hx, z: open.z - hz };
      const angle = Math.acos((v0.x * v1.x + v0.z * v1.z) / (Math.hypot(v0.x, v0.z) * Math.hypot(v1.x, v1.z)));
      expect(angle).toBeCloseTo((95 * Math.PI) / 180, 2);
      // The open panel lies on room a's side of the door line.
      const ra = (layout.rooms[d.a] as InteriorLayout['rooms'][number]).rect;
      if (d.axis === 'x') expect(Math.sign(open.z - d.z)).toBe(Math.sign((ra.minZ + ra.maxZ) / 2 - d.z));
      else expect(Math.sign(open.x - d.x)).toBe(Math.sign((ra.minX + ra.maxX) / 2 - d.x));
      // And swings back when closed again.
      rig.sys.setDoorState(b.id, d.index, 'closed');
      for (let i = 0; i < 20; i++) renderer.update(rig.sys, DT, d.x, d.z);
      const back = freeEnd(m, panel);
      expect(Math.hypot(back.x - closed.x, back.z - closed.z)).toBeLessThan(1e-3);
      // The panel is DOOR_HEIGHT tall.
      expect(a[panel * 16 + 5]).toBeCloseTo(DOOR_HEIGHT, 5);
      return;
    }
    throw new Error('no suitable door');
  });

  it('snaps doors that are far from the camera', async () => {
    rig = await makeRig();
    const scene = new THREE.Scene();
    renderer = new InteriorRenderer(scene);
    const b = findBuilding('house');
    const layout = layoutOf(b);
    rig.sys.placeOfficerInside(b.id, layout.entry);
    const d = layout.doors.find((x) => x.b >= 0 && !x.lockedAtStart && x.kind !== 'wide') as InteriorDoor;
    const panel = layout.doors.filter((x) => x.kind !== 'wide').indexOf(d);
    renderer.update(rig.sys, DT, d.x, d.z);
    const m = mesh(scene, 'interior-doors');
    const closed = freeEnd(m, panel);
    rig.sys.setDoorState(b.id, d.index, 'open');
    renderer.update(rig.sys, DT, d.x + 500, d.z);
    renderer.update(rig.sys, DT, d.x + 500, d.z);
    const after = freeEnd(m, panel);
    expect(Math.hypot(after.x - closed.x, after.z - closed.z)).toBeGreaterThan(0.5);
  });

  it('does not allocate in update, idle or while a door swings', async () => {
    rig = await makeRig();
    const gc = await loadGc();
    const scene = new THREE.Scene();
    renderer = new InteriorRenderer(scene);
    const b = findBuilding('house');
    const layout = layoutOf(b);
    rig.sys.placeOfficerInside(b.id, layout.entry);
    const d = layout.doors.find((x) => x.b >= 0 && !x.lockedAtStart && x.kind !== 'wide') as InteriorDoor;
    const sys = rig.sys;
    const r = renderer;
    // Hoisted so the harness does not box the camera numbers on every call.
    const cx = d.x, cz = d.z;
    for (let i = 0; i < 400; i++) {
      sys.setDoorState(b.id, d.index, i % 2 === 0 ? 'open' : 'closed');
      for (let k = 0; k < 20; k++) r.update(sys, DT, cx, cz);
    }
    for (let i = 0; i < 20000; i++) r.update(sys, DT, cx, cz);
    let worst = 0;
    for (let trial = 0; trial < 6; trial++) {
      sys.setDoorState(b.id, d.index, trial % 2 === 0 ? 'open' : 'closed');
      // The update that sees the new revision refreshes door targets and fixture colours (not per-frame work).
      r.update(sys, DT, cx, cz);
      gc();
      const before = process.memoryUsage().heapUsed;
      for (let k = 0; k < 30; k++) r.update(sys, DT, cx, cz);
      for (let k = 0; k < 5000; k++) r.update(sys, DT, cx, cz);
      worst = Math.max(worst, process.memoryUsage().heapUsed - before);
    }
    expect(worst).toBeLessThan(64 * 1024);
    const t = performance.now();
    for (let k = 0; k < 2000; k++) r.update(sys, DT, cx, cz);
    expect((performance.now() - t) / 2000).toBeLessThan(0.1);
  });

  it('removes everything it added on dispose', async () => {
    rig = await makeRig();
    const scene = new THREE.Scene();
    renderer = new InteriorRenderer(scene);
    const b = findBuilding('house');
    rig.sys.placeOfficerInside(b.id, layoutOf(b).entry);
    renderer.update(rig.sys, DT, 0, 0);
    expect(scene.getObjectByName('interiors')).toBeDefined();
    renderer.dispose();
    expect(scene.getObjectByName('interiors')).toBeUndefined();
    renderer.update(rig.sys, DT, 0, 0);
    renderer = null;
  });
});
