import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import type { InteriorLayout } from '../../src/interior/types';
import { InteriorLightPool } from '../../src/render/interior';
import { findBuilding, heapDelta, layoutOf, loadGc, makeRig, type Rig } from '../indoors/helpers';

let rig: Rig | null = null;
let pool: InteriorLightPool | null = null;
afterEach(() => {
  pool?.dispose();
  pool = null;
  rig?.dispose();
  rig = null;
});

function lightsOf(scene: THREE.Scene): THREE.PointLight[] {
  const out: THREE.PointLight[] = [];
  scene.traverse((o) => {
    if (o instanceof THREE.PointLight) out.push(o);
  });
  return out;
}

/** Rooms of a layout that have a fixture, with their fixture position. */
function fixtures(layout: InteriorLayout): { room: number; x: number; z: number }[] {
  return layout.rooms.flatMap((r) => (r.light === null ? [] : [{ room: r.index, x: r.light.x, z: r.light.z }]));
}

describe('InteriorLightPool', () => {
  it('keeps exactly four point lights in the scene with the specified parameters', () => {
    const scene = new THREE.Scene();
    pool = new InteriorLightPool(scene);
    const lights = lightsOf(scene);
    expect(lights).toHaveLength(4);
    for (const l of lights) {
      expect(l.intensity).toBe(0);
      expect(l.distance).toBe(10);
      expect(l.decay).toBe(2);
      expect(l.color.getHex()).toBe(0xfff1d6);
      expect(l.castShadow).toBe(false);
    }
    pool.dispose();
    expect(lightsOf(scene)).toHaveLength(0);
    pool = null;
  });

  it('lights the lit rooms nearest the camera, at the fixture 2.7 m above the floor', async () => {
    rig = await makeRig();
    const scene = new THREE.Scene();
    pool = new InteriorLightPool(scene);
    // A hospital is lit everywhere and has many rooms.
    const b = findBuilding('hospital');
    const layout = layoutOf(b);
    const all = fixtures(layout);
    expect(all.length).toBeGreaterThan(5);
    rig.sys.placeOfficerInside(b.id, layout.entry);
    const cams: [number, number][] = [
      [layout.entry.x, layout.entry.z],
      [layout.rect.minX, layout.rect.minZ],
      [layout.rect.maxX, layout.rect.maxZ],
    ];
    for (const [cx, cz] of cams) {
      pool.update(rig.sys, cx, cz);
      const expected = all
        .map((f) => ({ ...f, d: (f.x - cx) ** 2 + (f.z - cz) ** 2 }))
        .sort((p, q) => p.d - q.d)
        .slice(0, 4);
      const on = pool.lights.filter((l) => l.intensity > 0);
      expect(on).toHaveLength(4);
      // Sorted nearest first, at the fixture of the expected rooms.
      pool.lights.forEach((l, i) => {
        const e = expected[i] as (typeof expected)[number];
        expect(l.intensity).toBe(12);
        expect(l.position.x).toBeCloseTo(e.x, 3);
        expect(l.position.z).toBeCloseTo(e.z, 3);
        expect(l.position.y).toBeCloseTo(layout.floorY + 2.7, 5);
      });
    }
  });

  it('only lit rooms count and the unused lights go dark', async () => {
    rig = await makeRig();
    const scene = new THREE.Scene();
    pool = new InteriorLightPool(scene);
    const b = findBuilding('house');
    const layout = layoutOf(b);
    rig.time.now = 12 * 3600;
    rig.sys.placeOfficerInside(b.id, layout.entry);
    const all = fixtures(layout);
    expect(all.length).toBeGreaterThanOrEqual(3);
    // Midday: nothing lit.
    pool.update(rig.sys, layout.entry.x, layout.entry.z);
    expect(pool.lights.every((l) => l.intensity === 0)).toBe(true);
    // Two rooms on: two lights, the nearer first.
    const [first, second] = all.slice().sort((p, q) => Math.hypot(p.x - layout.entry.x, p.z - layout.entry.z) - Math.hypot(q.x - layout.entry.x, q.z - layout.entry.z));
    rig.sys.setRoomLight(b.id, (second as NonNullable<typeof second>).room, true);
    rig.sys.setRoomLight(b.id, (first as NonNullable<typeof first>).room, true);
    pool.update(rig.sys, layout.entry.x, layout.entry.z);
    expect(pool.lights.map((l) => l.intensity)).toEqual([12, 12, 0, 0]);
    expect(pool.lights[0]?.position.x).toBeCloseTo((first as NonNullable<typeof first>).x, 3);
    expect(pool.lights[1]?.position.x).toBeCloseTo((second as NonNullable<typeof second>).x, 3);
    // Switching a room off frees its light.
    rig.sys.setRoomLight(b.id, (first as NonNullable<typeof first>).room, false);
    pool.update(rig.sys, layout.entry.x, layout.entry.z);
    expect(pool.lights.map((l) => l.intensity)).toEqual([12, 0, 0, 0]);
    // Outdoors: all dark.
    rig.sys.restore({ ...rig.sys.serialize(), officerBuilding: -1 });
    pool.update(rig.sys, 0, 0);
    expect(pool.lights.every((l) => l.intensity === 0)).toBe(true);
  });

  it('follows the camera through a building and never changes the light count', async () => {
    rig = await makeRig();
    const scene = new THREE.Scene();
    pool = new InteriorLightPool(scene, 4);
    const b = findBuilding('office');
    const layout = layoutOf(b);
    rig.time.now = 11 * 3600;
    rig.sys.placeOfficerInside(b.id, layout.entry);
    const all = fixtures(layout);
    const chosen = new Set<string>();
    for (const f of all) {
      pool.update(rig.sys, f.x, f.z);
      // The light of the room the camera is in is always one of the four.
      expect(pool.lights.some((l) => Math.abs(l.position.x - f.x) < 1e-3 && Math.abs(l.position.z - f.z) < 1e-3 && l.intensity > 0)).toBe(true);
      chosen.add(pool.lights.map((l) => l.position.x.toFixed(2)).join(','));
      expect(lightsOf(scene)).toHaveLength(4);
    }
    expect(chosen.size).toBeGreaterThan(1);
  });

  it('does not allocate per frame', async () => {
    rig = await makeRig();
    const gc = await loadGc();
    const scene = new THREE.Scene();
    pool = new InteriorLightPool(scene);
    const b = findBuilding('hospital');
    const layout = layoutOf(b);
    rig.sys.placeOfficerInside(b.id, layout.entry);
    const sys = rig.sys;
    const p = pool;
    const cx = layout.entry.x, cz = layout.entry.z;
    for (let i = 0; i < 30000; i++) p.update(sys, cx, cz);
    let worst = 0;
    for (let k = 0; k < 6; k++) worst = Math.max(worst, heapDelta(gc, () => { for (let i = 0; i < 5000; i++) p.update(sys, cx, cz); }));
    // A heap delta is noisy while other test files run in parallel: the bound only rules out a per-frame allocation (30 000 frames).
    expect(worst).toBeLessThan(128 * 1024);
  });
});
