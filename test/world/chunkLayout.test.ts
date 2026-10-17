import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import {
  BUILDING_STRIDE,
  COLLIDER_STRIDE,
  GROUND_STRIDE,
  HEAD_STRIDE,
  PROP,
  PROP_STRIDE,
  SIGN,
  SIGN_STRIDE,
  allSignalHeads,
  chunkLayout,
  type ChunkLayout,
} from '../../src/world/chunkLayout';
import { CHUNK_SIZE, MAX_CHUNK, MIN_CHUNK, chunkCoord } from '../../src/world/constants';
import { generateCity } from '../../src/world/generate';
import { DISTRICT } from '../../src/world/roadGraph';
import { cityFor } from './helpers';

function inChunk(l: ChunkLayout, x: number, z: number): boolean {
  const x0 = l.cx * CHUNK_SIZE, z0 = l.cz * CHUNK_SIZE;
  return x >= x0 && x < x0 + CHUNK_SIZE && z >= z0 && z < z0 + CHUNK_SIZE;
}

describe('chunkLayout', () => {
  const city = cityFor(3);
  const g = city.graph;

  it('is deterministic and independent of request order', () => {
    const other = generateCity(3);
    const wanted: [number, number][] = [[1, -3], [0, 0], [-5, 4], [8, 6], [-14, -14]];
    const first = wanted.map(([cx, cz]) => chunkLayout(city, cx, cz));
    // Request neighbours first, then the same chunks in reverse order.
    for (const [cx, cz] of wanted) chunkLayout(other, cx + 1, cz);
    const second = [...wanted].reverse().map(([cx, cz]) => chunkLayout(other, cx, cz)).reverse();
    expect(second).toEqual(first);
  });

  it('fills a downtown chunk with buildings, ground, roads and colliders', () => {
    const cx = chunkCoord(300), cz = chunkCoord(-700);
    expect(city.districtAt(300, -700)).toBe(DISTRICT.downtown);
    const l = chunkLayout(city, cx, cz);
    expect(l.buildings.length / BUILDING_STRIDE).toBeGreaterThan(10);
    expect(l.ground.length / GROUND_STRIDE).toBeGreaterThan(0);
    expect(l.edges.length).toBeGreaterThan(0);
    expect(l.nodes.length).toBeGreaterThan(0);
    expect(l.colliders.length / COLLIDER_STRIDE).toBeGreaterThanOrEqual(l.buildings.length / BUILDING_STRIDE);
    for (let i = 0; i < l.buildings.length; i += BUILDING_STRIDE) {
      expect(inChunk(l, ((l.buildings[i] ?? 0) + (l.buildings[i + 2] ?? 0)) / 2, ((l.buildings[i + 1] ?? 0) + (l.buildings[i + 3] ?? 0)) / 2)).toBe(true);
      expect(l.buildings[i + 4]).toBeGreaterThan(0);
    }
    for (let i = 0; i < l.props.length; i += PROP_STRIDE) expect(inChunk(l, l.props[i + 1] ?? 0, l.props[i + 2] ?? 0)).toBe(true);
    for (let i = 0; i < l.signs.length; i += SIGN_STRIDE) expect(inChunk(l, l.signs[i + 1] ?? 0, l.signs[i + 2] ?? 0)).toBe(true);
    for (let i = 0; i < l.ground.length; i += GROUND_STRIDE) {
      expect(l.ground[i + 2]).toBeGreaterThan(l.ground[i] ?? 0);
      expect(inChunk(l, l.ground[i] ?? 0, l.ground[i + 1] ?? 0)).toBe(true);
    }
    for (let i = 0; i < l.colliders.length; i += COLLIDER_STRIDE) expect(inChunk(l, l.colliders[i] ?? 0, l.colliders[i + 2] ?? 0)).toBe(true);
  });

  it('never places a building on a road or sidewalk (20 sampled chunks)', () => {
    const rng = createRng(5).stream('chunks');
    let checked = 0;
    let buildings = 0;
    let overlaps = 0;
    while (checked < 20) {
      const cx = rng.nextInt(MIN_CHUNK, MAX_CHUNK), cz = rng.nextInt(MIN_CHUNK, MAX_CHUNK);
      const l = chunkLayout(city, cx, cz);
      if (l.buildings.length === 0) continue;
      checked++;
      for (let i = 0; i < l.buildings.length; i += BUILDING_STRIDE) {
        buildings++;
        const [x0, z0, x1, z1] = [l.buildings[i] ?? 0, l.buildings[i + 1] ?? 0, l.buildings[i + 2] ?? 0, l.buildings[i + 3] ?? 0];
        for (const e of g.edges) {
          const pad = e.width / 2 + e.sidewalk;
          const [a, b, c, d] = e.points as unknown as [number, number, number, number];
          if (x0 < Math.max(a, c) + pad && x1 > Math.min(a, c) - pad && z0 < Math.max(b, d) + pad && z1 > Math.min(b, d) - pad) overlaps++;
        }
      }
    }
    expect(overlaps).toBe(0);
    expect(buildings).toBeGreaterThan(50);
  });

  it('places signs and signal heads next to junctions', () => {
    const heads = allSignalHeads(city);
    expect(heads.length / HEAD_STRIDE).toBeGreaterThan(g.signals.length * 2);
    for (let i = 0; i < heads.length; i += HEAD_STRIDE) {
      const sig = g.signals[heads[i] ?? -1];
      expect(sig).toBeDefined();
      const node = g.nodes[sig?.node ?? 0];
      expect(Math.hypot((heads[i + 2] ?? 0) - (node?.x ?? 0), (heads[i + 3] ?? 0) - (node?.z ?? 0))).toBeLessThan(40);
      expect([0, 1]).toContain(heads[i + 1]);
    }
    // Over a whole district cell there are stop signs and speed limit signs with values.
    let stops = 0, limits = 0, headCount = 0;
    for (let cz = -2; cz < 0; cz++) {
      for (let cx = 0; cx < 4; cx++) {
        const l = chunkLayout(city, cx, cz);
        headCount += l.signalHeads.length / HEAD_STRIDE;
        for (let i = 0; i < l.signs.length; i += SIGN_STRIDE) {
          if (l.signs[i] === SIGN.stop) stops++;
          if (l.signs[i] === SIGN.speedLimit) {
            limits++;
            expect(l.signs[i + 4]).toBeGreaterThanOrEqual(15);
          }
        }
      }
    }
    expect(stops + headCount).toBeGreaterThan(0);
    expect(limits).toBeGreaterThan(0);
  });

  it('puts a fuel pump and lot lights in the station block, away from the parking slots', () => {
    const station = city.pois.find((p) => p.kind === 'station');
    const block = city.blocks[station?.block ?? -1];
    if (!block) throw new Error('no station block');
    const cx0 = chunkCoord(block.minX), cx1 = chunkCoord(block.maxX);
    const cz0 = chunkCoord(block.minZ), cz1 = chunkCoord(block.maxZ);
    const pumps: [number, number][] = [];
    for (let cz = cz0; cz <= cz1; cz++) {
      for (let cx = cx0; cx <= cx1; cx++) {
        const l = chunkLayout(city, cx, cz);
        for (let i = 0; i < l.props.length; i += PROP_STRIDE) {
          const px = l.props[i + 1] ?? 0, pz = l.props[i + 2] ?? 0;
          const inBlock = px > block.minX && px < block.maxX && pz > block.minZ && pz < block.maxZ;
          if (l.props[i] === PROP.fuelPump && inBlock) pumps.push([px, pz]);
        }
      }
    }
    expect(pumps.length).toBe(1);
    for (const slot of city.parking) {
      expect(Math.hypot((pumps[0]?.[0] ?? 0) - slot.x, (pumps[0]?.[1] ?? 0) - slot.z)).toBeGreaterThan(5);
    }
  });

  it('adds a quay wall where water meets land', () => {
    // Cell (13, 8) is water with harbor (land) to its west.
    const x = -3584 + 13 * 512 + 2;
    const z = -3584 + 8 * 512 + 200;
    expect(city.districtAt(x, z)).toBe(DISTRICT.water);
    expect(city.districtAt(x - 512, z)).toBe(DISTRICT.harbor);
    const water = city.blocks.find((b) => b.district === DISTRICT.water && b.minX < x + 20 && b.maxX > x && b.minZ < z && b.maxZ > z);
    if (!water) throw new Error('no water block');
    const l = chunkLayout(city, chunkCoord(water.minX + 0.25), chunkCoord(z));
    let walls = 0;
    for (let i = 0; i < l.colliders.length; i += COLLIDER_STRIDE) {
      if (Math.abs((l.colliders[i] ?? 0) - (water.minX + 0.25)) < 1e-3 && (l.colliders[i + 5] ?? 0) > 50) walls++;
    }
    expect(walls).toBe(1);
  });

  it('builds a chunk in under 15 ms on average', () => {
    const t0 = performance.now();
    let n = 0;
    for (let cz = -6; cz < 6; cz += 2) for (let cx = -6; cx < 6; cx += 2, n++) chunkLayout(city, cx, cz);
    const ms = (performance.now() - t0) / n;
    console.log(`chunkLayout: ${ms.toFixed(2)} ms/chunk`);
    expect(ms).toBeLessThan(15);
  });
});
