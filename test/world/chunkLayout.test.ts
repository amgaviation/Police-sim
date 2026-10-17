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
import { BLOCK_KIND, type City } from '../../src/world/city';
import { CHUNK_SIZE, MAX_CHUNK, MIN_CHUNK, WORLD_HALF_SIZE, WORLD_WALL, chunkCoord } from '../../src/world/constants';
import { generateCity } from '../../src/world/generate';
import { DISTRICT, EDGE_FLAG, constructionLimitMph } from '../../src/world/roadGraph';
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

  it('puts hydrants and benches on their own kerb offset beside an edge', () => {
    const l = chunkLayout(city, chunkCoord(300), chunkCoord(-700));
    const inset = { [PROP.hydrant]: 0.4, [PROP.bench]: 0.5 } as Record<number, number>;
    let items = 0;
    for (let i = 0; i < l.props.length; i += PROP_STRIDE) {
      const d = inset[l.props[i] ?? -1];
      if (d === undefined) continue;
      items++;
      const x = l.props[i + 1] ?? 0, z = l.props[i + 2] ?? 0;
      const onKerb = g.edges.some((e) => {
        const [a, b, c, dz] = e.points as unknown as [number, number, number, number];
        const lateral = e.width / 2 + e.sidewalk - d;
        if (a === c) return Math.abs(Math.abs(x - a) - lateral) < 0.01 && z >= Math.min(b, dz) && z <= Math.max(b, dz);
        return Math.abs(Math.abs(z - b) - lateral) < 0.01 && x >= Math.min(a, c) && x <= Math.max(a, c);
      });
      expect(onKerb).toBe(true);
    }
    expect(items).toBeGreaterThan(2);
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

  it('closes the quay at concave water corners where two land roads meet in an L', () => {
    const city42 = cityFor(42);
    /** True when a point lies inside any collider of its chunk (all quay walls are axis-aligned). */
    const blocked = (x: number, z: number): boolean => {
      const c = chunkLayout(city42, chunkCoord(x), chunkCoord(z)).colliders;
      for (let i = 0; i < c.length; i += COLLIDER_STRIDE) {
        if (Math.abs(x - (c[i] ?? 0)) <= (c[i + 3] ?? 0) && Math.abs(z - (c[i + 2] ?? 0)) <= (c[i + 5] ?? 0)) return true;
      }
      return false;
    };
    let corners = 0;
    for (const [nx, nz] of [[3072, 1536], [2048, 3072]] as const) {
      for (const [dx, dz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
        // Only the diagonal that heads into water from the L's inside corner.
        if (city42.districtAt(nx + dx * 30, nz + dz * 30) !== DISTRICT.water) continue;
        if (city42.districtAt(nx + dx * 30, nz - dz * 30) !== DISTRICT.water) continue;
        if (city42.districtAt(nx - dx * 30, nz + dz * 30) !== DISTRICT.water) continue;
        corners++;
        let hit = false;
        for (let d = 0; d < 30 && !hit; d += 0.1) hit = blocked(nx + (dx * d) / Math.SQRT2, nz + (dz * d) / Math.SQRT2);
        expect(hit, `${String(nx)}, ${String(nz)}`).toBe(true);
      }
    }
    expect(corners).toBe(2);
  });

  it('lists quay walls in walls (drawn) as well as in colliders', () => {
    const x = -3584 + 13 * 512 + 2;
    const z = -3584 + 8 * 512 + 200;
    const l = chunkLayout(city, chunkCoord(x), chunkCoord(z));
    expect(l.walls.length).toBeGreaterThan(0);
    for (let i = 0; i < l.walls.length; i += COLLIDER_STRIDE) {
      const w = l.walls.slice(i, i + COLLIDER_STRIDE).join();
      let found = false;
      for (let j = 0; j < l.colliders.length && !found; j += COLLIDER_STRIDE) found = l.colliders.slice(j, j + COLLIDER_STRIDE).join() === w;
      expect(found).toBe(true);
    }
  });

  it('keeps signal heads inside the world and lays out the perimeter roads past the edge in edge chunks', () => {
    const city42 = cityFor(42);
    const heads = allSignalHeads(city42);
    // Inside the boundary wall (its inner face is 14 m out); heads on a perimeter road's outer
    // sidewalk are in an edge chunk's margin and get their pole collider there.
    const limit = WORLD_HALF_SIZE + WORLD_WALL.offset - WORLD_WALL.halfThickness - 1;
    let pastEdge = 0;
    for (let i = 0; i < heads.length; i += HEAD_STRIDE) {
      const x = heads[i + 2] ?? 0, z = heads[i + 3] ?? 0;
      expect(Math.max(Math.abs(x), Math.abs(z))).toBeLessThan(limit);
      if (Math.abs(x) < WORLD_HALF_SIZE && Math.abs(z) < WORLD_HALF_SIZE) continue;
      pastEdge++;
      const c = chunkLayout(city42, Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, chunkCoord(x))), Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, chunkCoord(z)))).colliders;
      let pole = false;
      for (let j = 0; j < c.length; j += COLLIDER_STRIDE) pole ||= c[j] === x && c[j + 2] === z;
      expect(pole).toBe(true);
    }
    expect(pastEdge).toBeGreaterThan(0);
    // The west highway end: its chunk lists the perimeter road's outer sidewalk items and the boundary wall.
    const l = chunkLayout(city42, MIN_CHUNK, chunkCoord(256));
    let outside = 0;
    for (let i = 0; i < l.props.length; i += PROP_STRIDE) if ((l.props[i + 1] ?? 0) < -WORLD_HALF_SIZE) outside++;
    expect(outside).toBeGreaterThan(0);
    const wall = Array.from(l.walls).findIndex((v, i) => i % COLLIDER_STRIDE === 0 && v < -WORLD_HALF_SIZE - 14);
    expect(wall).toBeGreaterThanOrEqual(0);
    expect(l.walls[wall + 4]).toBe(1.5);
  });

  it('keeps construction barriers on the shoulder, along the kerb, and posts the reduced limit', () => {
    const construction = g.edges.filter((e) => (e.flags & EDGE_FLAG.construction) !== 0 && e.lanesBackward > 0);
    expect(construction.length).toBeGreaterThan(5);
    let barriers = 0, signs = 0;
    for (const e of construction.slice(0, 8)) {
      const [ax, az, bx, bz] = e.points as unknown as [number, number, number, number];
      const ux = Math.sign(bx - ax), uz = Math.sign(bz - az);
      for (const [px, pz] of [[ax, az], [bx, bz]] as const) {
        const l = chunkLayout(city, chunkCoord(px + ux * 20), chunkCoord(pz + uz * 20));
        for (let i = 0; i < l.props.length; i += PROP_STRIDE) {
          if (l.props[i] !== PROP.barrier) continue;
          const x = l.props[i + 1] ?? 0, z = l.props[i + 2] ?? 0, yaw = l.props[i + 3] ?? 0;
          const along = (x - ax) * ux + (z - az) * uz;
          const lateral = Math.abs((x - ax) * uz - (z - az) * ux);
          if (along < 0 || along > e.length || lateral > e.width / 2) continue;
          barriers++;
          // Clear of the travel lanes (barrier half thickness 0.1 m), its long local X parallel to the road.
          expect(lateral - 0.1).toBeGreaterThanOrEqual(e.width / 2 - e.shoulder);
          expect(Math.abs(Math.cos(yaw) * uz + Math.sin(yaw) * ux)).toBeLessThan(1e-6);
        }
        for (let i = 0; i < l.signs.length; i += SIGN_STRIDE) {
          const x = l.signs[i + 1] ?? 0, z = l.signs[i + 2] ?? 0;
          const lateral = Math.abs((x - ax) * uz - (z - az) * ux);
          const along = (x - ax) * ux + (z - az) * uz;
          if (l.signs[i] !== SIGN.speedLimit || along < 0 || along > e.length || lateral > e.width / 2 + e.sidewalk + 1) continue;
          signs++;
          expect(l.signs[i + 4]).toBe(constructionLimitMph(e));
          expect(constructionLimitMph(e)).toBeLessThan(e.speedLimitMph);
        }
      }
    }
    expect(barriers).toBeGreaterThan(4);
    expect(signs).toBeGreaterThan(0);
  });

  it('gives sign posts and construction barriers colliders', () => {
    const hasCollider = (l: ChunkLayout, x: number, z: number, hx: number): boolean => {
      for (let i = 0; i < l.colliders.length; i += COLLIDER_STRIDE) {
        if (Math.abs((l.colliders[i] ?? 0) - x) < 1e-3 && Math.abs((l.colliders[i + 2] ?? 0) - z) < 1e-3 && Math.abs((l.colliders[i + 3] ?? 0) - hx) < 1e-6) return true;
      }
      return false;
    };
    let signs = 0, barriers = 0;
    for (const e of g.edges.filter((x) => (x.flags & EDGE_FLAG.construction) !== 0).slice(0, 6)) {
      const [ax, az] = e.points as unknown as [number, number];
      const l = chunkLayout(city, chunkCoord(ax), chunkCoord(az));
      for (let i = 0; i < l.signs.length; i += SIGN_STRIDE, signs++) expect(hasCollider(l, l.signs[i + 1] ?? 0, l.signs[i + 2] ?? 0, 0.06)).toBe(true);
      for (let i = 0; i < l.props.length; i += PROP_STRIDE) {
        if (l.props[i] !== PROP.barrier) continue;
        barriers++;
        expect(hasCollider(l, l.props[i + 1] ?? 0, l.props[i + 2] ?? 0, 1)).toBe(true);
      }
    }
    expect(signs).toBeGreaterThan(5);
    expect(barriers).toBeGreaterThan(0);
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

describe('chunkLayout clearances (whole city)', () => {
  /** Distance from (x, z) to the edge centreline and how far along from `node` the closest point is. */
  function fromCentreline(city: City, edge: number, node: number, x: number, z: number): [number, number] {
    const e = city.graph.edges[edge];
    const n = city.graph.nodes[node];
    if (!e || !n) return [Infinity, 0];
    const p = e.points;
    let best = Infinity, along = 0;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i] ?? 0, az = p[i + 1] ?? 0, dx = (p[i + 2] ?? 0) - ax, dz = (p[i + 3] ?? 0) - az;
      const t = Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / (dx * dx + dz * dz)));
      const px = ax + dx * t, pz = az + dz * t;
      const d = Math.hypot(x - px, z - pz);
      if (d < best) {
        best = d;
        along = Math.hypot(px - n.x, pz - n.z);
      }
    }
    return [best, along];
  }

  it('never stands a signal head in a carriageway, also where the road widens across the junction', () => {
    for (const seed of [1, 2, 7]) {
      const city = cityFor(seed);
      const heads = allSignalHeads(city);
      let inside = 0;
      for (let i = 0; i < heads.length; i += HEAD_STRIDE) {
        const node = city.graph.signals[heads[i] ?? 0]?.node ?? -1;
        const n = city.graph.nodes[node];
        if (!n) continue;
        for (const id of n.edges) {
          const [d, along] = fromCentreline(city, id, node, heads[i + 2] ?? 0, heads[i + 3] ?? 0);
          if (along > n.setback - 1.5 && d < (city.graph.edges[id]?.width ?? 0) / 2) inside++;
        }
      }
      expect(inside, `seed ${String(seed)}`).toBe(0);
    }
  });

  it('keeps streetlights, signs and signal heads out of the water beyond the quay wall', () => {
    const city = cityFor(1);
    const chunks = new Set<string>();
    for (const b of city.blocks) {
      if (b.kind !== BLOCK_KIND.water) continue;
      for (let cz = chunkCoord(b.minZ - 4); cz <= chunkCoord(b.maxZ + 4); cz++) {
        for (let cx = chunkCoord(b.minX - 4); cx <= chunkCoord(b.maxX + 4); cx++) {
          if (cx >= MIN_CHUNK && cx <= MAX_CHUNK && cz >= MIN_CHUNK && cz <= MAX_CHUNK) chunks.add(`${String(cx)},${String(cz)}`);
        }
      }
    }
    const inWater = (x: number, z: number): boolean =>
      city.blocksIn(x, z, x, z, []).some((id) => {
        const b = city.blocks[id];
        return b?.kind === BLOCK_KIND.water && x > b.minX + 0.5 && x < b.maxX - 0.5 && z > b.minZ + 0.5 && z < b.maxZ - 0.5;
      });
    let checked = 0, wet = 0;
    for (const key of chunks) {
      const [cx, cz] = key.split(',').map(Number) as [number, number];
      const l = chunkLayout(city, cx, cz);
      for (const [items, stride, at] of [[l.props, PROP_STRIDE, 1], [l.signs, SIGN_STRIDE, 1], [l.signalHeads, HEAD_STRIDE, 2]] as const) {
        for (let i = 0; i < items.length; i += stride, checked++) if (inWater(items[i + at] ?? 0, items[i + at + 1] ?? 0)) wet++;
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect(wet).toBe(0);
  });
});
