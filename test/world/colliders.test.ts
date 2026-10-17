import { afterEach, describe, expect, it } from 'vitest';
import { PhysicsWorld } from '../../src/physics/physics';
import { BUILDING_STRIDE, chunkLayout } from '../../src/world/chunkLayout';
import { WorldColliders } from '../../src/world/colliders';
import { CHUNK_SIZE, chunkCoord } from '../../src/world/constants';
import { cityFor } from './helpers';

const worlds: PhysicsWorld[] = [];
afterEach(() => {
  for (const w of worlds.splice(0)) w.dispose();
});

async function makeWorld(): Promise<PhysicsWorld> {
  const w = await PhysicsWorld.create();
  worlds.push(w);
  return w;
}

describe('WorldColliders', () => {
  const city = cityFor(1);
  // Middle of a downtown chunk.
  const x = 1 * CHUNK_SIZE + 128;
  const z = -3 * CHUNK_SIZE + 128;

  it('prime loads the 3 x 3 window at once', async () => {
    const physics = await makeWorld();
    const wc = new WorldColliders(physics, city);
    wc.prime(x, z);
    expect(wc.loadedChunks).toBe(9);
    expect(wc.colliderCount).toBeGreaterThan(0);
    expect(physics.raw.colliders.len()).toBe(wc.colliderCount);
  });

  it('streams across a chunk border one op per update, adds before removes', async () => {
    const physics = await makeWorld();
    const wc = new WorldColliders(physics, city);
    wc.prime(x, z);
    const counts: number[] = [];
    for (let i = 0; i < 8; i++) {
      wc.update(x + CHUNK_SIZE, z);
      counts.push(wc.loadedChunks);
    }
    expect(counts).toEqual([10, 11, 12, 11, 10, 9, 9, 9]);
    expect(physics.raw.colliders.len()).toBe(wc.colliderCount);
    // Staying in the same chunk does no further work.
    wc.update(x + CHUNK_SIZE + 50, z + 50);
    expect(wc.loadedChunks).toBe(9);
  });

  it('respects radiusChunks and maxChunkOpsPerStep', async () => {
    const physics = await makeWorld();
    const wc = new WorldColliders(physics, city, { radiusChunks: 0, maxChunkOpsPerStep: 2 });
    wc.update(x, z);
    expect(wc.loadedChunks).toBe(1);
    wc.update(x + 3 * CHUNK_SIZE, z);
    expect(wc.loadedChunks).toBe(1);
    wc.dispose();
  });

  it('skips chunks outside the world', async () => {
    const physics = await makeWorld();
    const wc = new WorldColliders(physics, city);
    wc.prime(-3584 + 10, -3584 + 10);
    expect(wc.loadedChunks).toBe(4);
  });

  it('a ray hits a building collider and dispose removes everything', async () => {
    const physics = await makeWorld();
    const wc = new WorldColliders(physics, city);
    wc.prime(x, z);
    const b = chunkLayout(city, chunkCoord(x), chunkCoord(z)).buildings;
    expect(b.length).toBeGreaterThanOrEqual(BUILDING_STRIDE);
    const bx = ((b[0] ?? 0) + (b[2] ?? 0)) / 2;
    const bz = ((b[1] ?? 0) + (b[3] ?? 0)) / 2;
    const h = b[4] ?? 0;
    physics.step(); // scene queries see new colliders after a step
    const hit = physics.castRay({ x: bx, y: h + 20, z: bz }, { x: 0, y: -1, z: 0 }, 100);
    expect(hit).not.toBeNull();
    expect(hit?.toi).toBeCloseTo(20, 2);
    expect(hit?.eid).toBeUndefined();
    wc.dispose();
    expect(wc.colliderCount).toBe(0);
    expect(wc.loadedChunks).toBe(0);
    expect(physics.raw.colliders.len()).toBe(0);
    physics.step();
    expect(physics.castRay({ x: bx, y: h + 20, z: bz }, { x: 0, y: -1, z: 0 }, 100)).toBeNull();
  });
});
