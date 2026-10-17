import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, MAX_CHUNK, MIN_CHUNK, chunkKey } from '../../src/world/constants';
import { generateCity } from '../../src/world/generate';
import { CityMaterials } from '../../src/world/render/cityMaterials';
import {
  ChunkStreamer,
  LOAD_MARGIN,
  UNLOAD_MARGIN,
  chunkDistance,
  chunkKeyX,
  chunkKeyZ,
  desiredChunks,
  type ChunkLod,
} from '../../src/world/render/chunkStreamer';
import { fakeChunkWorker, flush } from './fakeWorker';

const city = generateCity(12345);
const VIEW = 320;

describe('desiredChunks', () => {
  const none = new Map<number, ChunkLod>();

  it('loads every chunk within viewDistance + 32 with LOD0 nearer than 300 m', () => {
    const out = desiredChunks(128, 128, VIEW, none, new Map());
    expect(out.get(chunkKey(0, 0))).toBe(0);
    for (let cx = MIN_CHUNK; cx <= MAX_CHUNK; cx++) {
      for (let cz = MIN_CHUNK; cz <= MAX_CHUNK; cz++) {
        const d = chunkDistance(128, 128, cx, cz);
        const lod = out.get(chunkKey(cx, cz));
        if (d < VIEW + LOAD_MARGIN) expect(lod).toBe(d < 300 ? 0 : 1);
        else expect(lod).toBeUndefined();
      }
    }
  });

  it('applies LOD hysteresis between 300 and 340 m', () => {
    const key = chunkKey(1, 0);
    // Chunk (1, 0) starts at x = 256; the camera sits in chunk (0, 0)'s row.
    const at = (d: number, prev: ChunkLod | undefined): ChunkLod | undefined => {
      const current = new Map<number, ChunkLod>();
      if (prev !== undefined) current.set(key, prev);
      expect(chunkDistance(256 - d, 128, 1, 0)).toBeCloseTo(d, 9);
      return desiredChunks(256 - d, 128, VIEW, current, new Map()).get(key);
    };
    expect(at(320, undefined)).toBe(1);
    expect(at(320, 0)).toBe(0);
    expect(at(320, 1)).toBe(1);
    expect(at(345, 0)).toBe(1);
    expect(at(290, 1)).toBe(0);
  });

  it('keeps loaded chunks until viewDistance + 160 m', () => {
    const key = chunkKey(1, 0);
    const current = new Map<number, ChunkLod>([[key, 1]]);
    expect(desiredChunks(256 - 400, 128, VIEW, none, new Map()).has(key)).toBe(false);
    expect(desiredChunks(256 - 400, 128, VIEW, current, new Map()).get(key)).toBe(1);
    expect(desiredChunks(256 - (VIEW + UNLOAD_MARGIN + 10), 128, VIEW, current, new Map()).has(key)).toBe(false);
  });

  it('clamps to the 28 x 28 world', () => {
    const edge = desiredChunks(3584 + 100, 0, VIEW, none, new Map());
    expect(edge.size).toBeGreaterThan(0);
    for (const key of edge.keys()) {
      expect(chunkKeyX(key)).toBeLessThanOrEqual(MAX_CHUNK);
      expect(chunkKeyZ(key)).toBeGreaterThanOrEqual(MIN_CHUNK);
    }
    expect(desiredChunks(20000, 20000, VIEW, none, new Map()).size).toBe(0);
  });

  it('clears the output map first', () => {
    const out = new Map<number, ChunkLod>([[chunkKey(-14, -14), 0]]);
    desiredChunks(128, 128, VIEW, none, out);
    expect(out.has(chunkKey(-14, -14))).toBe(false);
  });
});

function chunkGroups(streamer: ChunkStreamer): THREE.Object3D[] {
  return [...streamer.root.children];
}

function groupOf(streamer: ChunkStreamer, cx: number, cz: number): THREE.Object3D | undefined {
  return streamer.root.getObjectByName(`chunk:${cx},${cz}`);
}

/** Answers and uploads until nothing is pending. */
async function settle(streamer: ChunkStreamer, fake: ReturnType<typeof fakeChunkWorker>, x: number, z: number): Promise<void> {
  for (let i = 0; i < 400; i++) {
    fake.answer();
    await flush();
    streamer.update(x, z, VIEW);
    if (fake.pending.length === 0 && streamer.stats.inFlight === 0) return;
  }
  throw new Error('streamer did not settle');
}

describe('ChunkStreamer with a worker', () => {
  const camX = 100, camZ = -400;

  it('initialises the worker once and requests nearest-first within maxInFlight', () => {
    const scene = new THREE.Scene();
    const fake = fakeChunkWorker();
    const streamer = new ChunkStreamer(scene, city, { worker: fake.client, maxInFlight: 3 });
    expect(fake.sent[0]).toMatchObject({ type: 'init', payload: { seed: city.seed } });
    streamer.update(camX, camZ, VIEW);
    const builds = fake.builds();
    expect(builds).toHaveLength(3);
    expect(builds[0]).toEqual({ cx: 0, cz: -2, lod: 0 });
    const wanted = [...desiredChunks(camX, camZ, VIEW, new Map(), new Map()).keys()]
      .map((k) => chunkDistance(camX, camZ, chunkKeyX(k), chunkKeyZ(k)))
      .sort((a, b) => a - b);
    const got = builds.map((b) => chunkDistance(camX, camZ, b.cx, b.cz));
    expect(got).toEqual(wanted.slice(0, 3));
    streamer.update(camX, camZ, VIEW);
    streamer.update(camX + 1, camZ, VIEW);
    expect(fake.builds()).toHaveLength(3);
    expect(streamer.stats.inFlight).toBe(3);
    expect(fake.sent.filter((r) => r.type === 'init')).toHaveLength(1);
    streamer.dispose();
  });

  it('uploads at most one chunk per update', async () => {
    const scene = new THREE.Scene();
    const fake = fakeChunkWorker();
    const streamer = new ChunkStreamer(scene, city, { worker: fake.client });
    streamer.update(camX, camZ, VIEW);
    fake.answer();
    await flush();
    streamer.update(camX, camZ, VIEW);
    expect(chunkGroups(streamer)).toHaveLength(1);
    expect(streamer.stats.loaded).toBe(1);
    streamer.update(camX, camZ, VIEW);
    expect(chunkGroups(streamer)).toHaveLength(2);
    streamer.update(camX, camZ, VIEW);
    expect(chunkGroups(streamer)).toHaveLength(3);
    expect(fake.builds().length).toBeLessThanOrEqual(6);
    const mesh = groupOf(streamer, 0, -2)?.children[0] as THREE.Mesh;
    expect(mesh.geometry.boundingSphere).not.toBeNull();
    expect(mesh.geometry.getAttribute('position').count).toBeGreaterThan(0);
    streamer.dispose();
  });

  it('streams the whole wanted set and only LOD0 buildings/props cast shadows', async () => {
    const scene = new THREE.Scene();
    const fake = fakeChunkWorker();
    const streamer = new ChunkStreamer(scene, city, { worker: fake.client });
    await settle(streamer, fake, camX, camZ);
    const wanted = desiredChunks(camX, camZ, VIEW, new Map(), new Map());
    expect(streamer.stats.loaded).toBe(wanted.size);
    expect(streamer.stats.lod0 + streamer.stats.lod1).toBe(wanted.size);
    expect(streamer.stats.lod0).toBe([...wanted.values()].filter((l) => l === 0).length);
    for (const group of chunkGroups(streamer)) {
      expect(group.children.length).toBeLessThanOrEqual(5);
      for (const mesh of group.children) {
        const lod0 = wanted.get(chunkKey(...(group.name.slice(6).split(',').map(Number) as [number, number]))) === 0;
        expect(mesh.castShadow).toBe(lod0 && (mesh.name === 'buildings' || mesh.name === 'props'));
      }
    }
    streamer.setShadows(false);
    expect(chunkGroups(streamer).every((g) => g.children.every((m) => !m.castShadow))).toBe(true);
    streamer.dispose();
  });

  it('keeps the old LOD visible until the new one arrives', async () => {
    const scene = new THREE.Scene();
    const fake = fakeChunkWorker();
    const streamer = new ChunkStreamer(scene, city, { worker: fake.client });
    // Chunk (1, -2) [256, 512] is LOD1 from x = -60 (316 m) and LOD0 from x = 0 (256 m).
    await settle(streamer, fake, -60, camZ);
    const before = groupOf(streamer, 1, -2);
    expect(before).toBeDefined();
    expect(streamer.stats.lod1).toBeGreaterThan(0);
    const sentBefore = fake.builds().length;
    streamer.update(0, camZ, VIEW);
    expect(fake.builds().slice(sentBefore)).toContainEqual({ cx: 1, cz: -2, lod: 0 });
    expect(groupOf(streamer, 1, -2)).toBe(before);
    await settle(streamer, fake, 0, camZ);
    const after = groupOf(streamer, 1, -2);
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(before?.parent).toBeNull();
    expect(streamer.stats.loaded).toBeGreaterThanOrEqual(desiredChunks(0, camZ, VIEW, new Map(), new Map()).size);
    streamer.dispose();
  });

  it('disposes the geometry of unloaded chunks', async () => {
    const scene = new THREE.Scene();
    const fake = fakeChunkWorker();
    const streamer = new ChunkStreamer(scene, city, { worker: fake.client });
    await settle(streamer, fake, camX, camZ);
    const disposed = new Set<THREE.BufferGeometry>();
    const groups = chunkGroups(streamer);
    for (const g of groups) {
      for (const m of g.children) (m as THREE.Mesh).geometry.addEventListener('dispose', (e) => disposed.add(e.target));
    }
    streamer.update(camX + 3000, camZ, VIEW);
    let total = 0;
    for (const g of groups) {
      expect(g.parent).toBeNull();
      for (const m of g.children) {
        total++;
        expect(disposed.has((m as THREE.Mesh).geometry)).toBe(true);
      }
    }
    expect(disposed.size).toBe(total);
    streamer.dispose();
  });

  it('caps residency at maxResident (nearest kept)', async () => {
    const scene = new THREE.Scene();
    const fake = fakeChunkWorker();
    const streamer = new ChunkStreamer(scene, city, { worker: fake.client, maxResident: 5 });
    await settle(streamer, fake, camX, camZ);
    expect(streamer.stats.loaded).toBe(5);
    expect(groupOf(streamer, 0, -2)).toBeDefined();
    streamer.dispose();
  });

  it('ignores replies that arrive after dispose', async () => {
    const scene = new THREE.Scene();
    const fake = fakeChunkWorker();
    const streamer = new ChunkStreamer(scene, city, { worker: fake.client });
    streamer.update(camX, camZ, VIEW);
    streamer.dispose();
    expect(scene.children).not.toContain(streamer.root);
    fake.answer();
    await flush();
    streamer.update(camX, camZ, VIEW);
    expect(chunkGroups(streamer)).toHaveLength(0);
    expect(streamer.stats.loaded).toBe(0);
  });

  it('drops a reply whose chunk is no longer wanted', async () => {
    const scene = new THREE.Scene();
    const fake = fakeChunkWorker();
    const streamer = new ChunkStreamer(scene, city, { worker: fake.client });
    streamer.update(camX, camZ, VIEW);
    streamer.update(camX + 3000, camZ, VIEW);
    fake.answer();
    await flush();
    streamer.update(camX + 3000, camZ, VIEW);
    expect(groupOf(streamer, 0, -2)).toBeUndefined();
    streamer.dispose();
  });

  it('falls back to synchronous meshing after a worker failure', async () => {
    const scene = new THREE.Scene();
    const fake = fakeChunkWorker();
    const streamer = new ChunkStreamer(scene, city, { worker: fake.client });
    streamer.update(camX, camZ, VIEW);
    fake.answer(1); // init
    fake.fail();
    await flush();
    streamer.update(camX, camZ, VIEW);
    streamer.update(camX, camZ, VIEW);
    expect(streamer.stats.loaded).toBe(2);
    const sent = fake.builds().length;
    streamer.update(camX, camZ, VIEW);
    expect(fake.builds()).toHaveLength(sent);
    streamer.dispose();
  });
});

describe('ChunkStreamer without a worker', () => {
  it('meshes one chunk per update on the main thread, nearest first', () => {
    const scene = new THREE.Scene();
    const streamer = new ChunkStreamer(scene, city, { worker: null });
    expect(scene.getObjectByName('city')).toBe(streamer.root);
    streamer.update(128, -384, VIEW);
    expect(streamer.stats).toEqual({ loaded: 1, inFlight: 0, lod0: 1, lod1: 0 });
    expect(groupOf(streamer, 0, -2)).toBeDefined();
    for (let i = 0; i < 4; i++) streamer.update(128, -384, VIEW);
    expect(streamer.stats.loaded).toBe(5);
    const chunkSizeOk = chunkGroups(streamer).every((g) => g.children.every((m) => {
      const s = (m as THREE.Mesh).geometry.boundingSphere;
      return s !== null && s.radius <= CHUNK_SIZE * 2;
    }));
    expect(chunkSizeOk).toBe(true);
    streamer.dispose();
    expect(scene.getObjectByName('city')).toBeUndefined();
  });
});

describe('CityMaterials', () => {
  it('drives lamp glow from streetlights and windows only with the texture', () => {
    const m = new CityMaterials();
    m.setLighting(1, true);
    expect(m.lamps.emissiveIntensity).toBeGreaterThan(0);
    // No DOM in node: no window texture, so buildings never glow as a whole.
    expect(m.buildings.map).toBeNull();
    expect(m.buildings.emissiveIntensity).toBe(0);
    m.setLighting(0, false);
    expect(m.lamps.emissiveIntensity).toBe(0);
    expect(m.markings.polygonOffset).toBe(true);
    expect(m.get('ground').vertexColors).toBe(true);
    m.dispose();
  });
});
