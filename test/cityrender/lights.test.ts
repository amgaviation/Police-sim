import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { HEAD_STRIDE, PROP, PROP_STRIDE, allSignalHeads, chunkLayout } from '../../src/world/chunkLayout';
import { chunkCoord } from '../../src/world/constants';
import { generateCity } from '../../src/world/generate';
import { lampHeadPosition } from '../../src/world/render/chunkMesher';
import { SIGNAL_HEAD_PARTS, SIGNAL_LIT, SIGNAL_PART, SIGNAL_UNLIT, SignalHeads } from '../../src/world/render/signalHeads';
import { StreetlightPool } from '../../src/world/render/streetlightPool';
import { ASPECT } from '../../src/world/roadGraph';

const city = generateCity(12345);
const heads = allSignalHeads(city);

function lampColor(sh: SignalHeads, head: number, part: number): number[] {
  const c = sh.mesh.instanceColor as THREE.InstancedBufferAttribute;
  const i = head * SIGNAL_HEAD_PARTS + part;
  return [c.getX(i), c.getY(i), c.getZ(i)];
}

describe('SignalHeads', () => {
  it('draws every head in one InstancedMesh', () => {
    const scene = new THREE.Scene();
    const sh = new SignalHeads(scene, city);
    expect(sh.count).toBe(heads.length / HEAD_STRIDE);
    expect(sh.count).toBeGreaterThan(0);
    expect(sh.mesh.count).toBe(sh.count * SIGNAL_HEAD_PARTS);
    expect(scene.children).toEqual([sh.mesh]);
    sh.dispose();
    expect(scene.children).toHaveLength(0);
  });

  it('lights the lamp matching signalAspect for heads near the camera', () => {
    const scene = new THREE.Scene();
    const sh = new SignalHeads(scene, city);
    const camX = heads[2] ?? 0, camZ = heads[3] ?? 0;
    const lampOf = { [ASPECT.green]: SIGNAL_PART.green, [ASPECT.yellow]: SIGNAL_PART.yellow, [ASPECT.red]: SIGNAL_PART.red };
    const seen = new Set<number>();
    for (const t of [0, 7.5, 21, 33.3, 47, 58.9, 66, 81.2, 97]) {
      sh.update(t, camX, camZ);
      let checked = 0;
      for (let h = 0; h < sh.count; h++) {
        const o = h * HEAD_STRIDE;
        if (Math.hypot((heads[o + 2] ?? 0) - camX, (heads[o + 3] ?? 0) - camZ) > 200) continue;
        const aspect = city.graph.signalAspect(heads[o] ?? 0, (heads[o + 1] ?? 0) === 1 ? 1 : 0, t);
        seen.add(aspect);
        for (const part of [SIGNAL_PART.red, SIGNAL_PART.yellow, SIGNAL_PART.green]) {
          const table = part === lampOf[aspect] ? SIGNAL_LIT : SIGNAL_UNLIT;
          const expected = table[part - SIGNAL_PART.red] as readonly number[];
          lampColor(sh, h, part).forEach((v, k) => expect(v).toBeCloseTo(expected[k] ?? -1, 6));
        }
        checked++;
      }
      expect(checked).toBeGreaterThan(0);
    }
    expect(seen.size).toBeGreaterThan(1);
    sh.dispose();
  });

  it('leaves far heads alone', () => {
    const scene = new THREE.Scene();
    const sh = new SignalHeads(scene, city);
    const c = sh.mesh.instanceColor as THREE.InstancedBufferAttribute;
    const before = Float32Array.from(c.array as Float32Array);
    const version = c.version;
    sh.update(0, 1e6, 1e6);
    expect(c.version).toBe(version);
    expect(Float32Array.from(c.array as Float32Array)).toEqual(before);
    sh.dispose();
  });
});

describe('StreetlightPool', () => {
  const camX = city.spawn.x, camZ = city.spawn.z;

  /** Lamp heads of the 3 x 3 chunks around the camera, nearest first. */
  function nearestLamps(n: number): [number, number, number][] {
    const all: [number, number, number][] = [];
    const ccx = chunkCoord(camX), ccz = chunkCoord(camZ);
    const p = { x: 0, y: 0, z: 0 };
    for (let cz = ccz - 1; cz <= ccz + 1; cz++) {
      for (let cx = ccx - 1; cx <= ccx + 1; cx++) {
        const props = chunkLayout(city, cx, cz).props;
        for (let i = 0; i < props.length; i += PROP_STRIDE) {
          const kind = props[i] ?? 0;
          if (kind !== PROP.streetlight && kind !== PROP.lotLight) continue;
          lampHeadPosition(kind, props[i + 1] ?? 0, props[i + 2] ?? 0, props[i + 3] ?? 0, p);
          all.push([p.x, p.y, p.z]);
        }
      }
    }
    return all.sort((a, b) => Math.hypot(a[0] - camX, a[2] - camZ) - Math.hypot(b[0] - camX, b[2] - camZ)).slice(0, n);
  }

  it('moves a fixed pool to the nearest lamp heads and turns it off by day', () => {
    const scene = new THREE.Scene();
    const pool = new StreetlightPool(scene, city, 4);
    expect(pool.lights).toHaveLength(4);
    const objectsBefore = scene.getObjectByName('streetlights')?.children.length;
    pool.update(camX, camZ, false);
    expect(pool.lights.every((l) => l.intensity === 0)).toBe(true);
    for (let i = 0; i < 9; i++) pool.update(camX, camZ, true);
    const expected = nearestLamps(4);
    expect(expected).toHaveLength(4);
    pool.lights.forEach((light, i) => {
      const [x, y, z] = expected[i] as [number, number, number];
      expect(light.position.x).toBeCloseTo(x, 3);
      expect(light.position.y).toBeCloseTo(y, 3);
      expect(light.position.z).toBeCloseTo(z, 3);
      expect(light.intensity).toBeGreaterThan(0);
    });
    pool.update(camX, camZ, false);
    expect(pool.lights.every((l) => l.intensity === 0)).toBe(true);
    expect(scene.getObjectByName('streetlights')?.children.length).toBe(objectsBefore);
    pool.dispose();
    expect(scene.getObjectByName('streetlights')).toBeUndefined();
  });

  it('keeps unused lights dark where there are fewer lamps than lights', () => {
    const scene = new THREE.Scene();
    const pool = new StreetlightPool(scene, city, 4);
    // Far outside the map: no chunks, no lamps.
    pool.update(20000, 20000, true);
    expect(pool.lights.every((l) => l.intensity === 0)).toBe(true);
    pool.dispose();
  });
});
