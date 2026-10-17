import { describe, expect, it } from 'vitest';
import { chunkBounds, chunkLayout, type ChunkLayout } from '../../src/world/chunkLayout';
import { chunkCoord } from '../../src/world/constants';
import { generateCity } from '../../src/world/generate';
import { buildChunkMesh, chunkMeshTransferables, type ChunkMeshData, type ChunkMeshGroup } from '../../src/world/render/chunkMesher';

const city = generateCity(12345);
/** Station, city centre, suburbs, industrial, rural, harbor water. */
const CHUNKS: readonly [number, number][] = [
  [chunkCoord(city.spawn.x), chunkCoord(city.spawn.z)],
  [0, 0],
  [-6, -2],
  [3, 1],
  [-12, -12],
  [12, 5],
  [13, 13],
];
const layouts = new Map<string, ChunkLayout>(CHUNKS.map(([cx, cz]) => [`${cx},${cz}`, chunkLayout(city, cx, cz)]));
const meshes = new Map<string, [ChunkMeshData, ChunkMeshData]>(
  CHUNKS.map(([cx, cz]) => {
    const l = layouts.get(`${cx},${cz}`) as ChunkLayout;
    return [`${cx},${cz}`, [buildChunkMesh(city, l, 0), buildChunkMesh(city, l, 1)]];
  }),
);

function vertexCount(d: ChunkMeshData): number {
  return d.groups.reduce((n, g) => n + g.positions.length / 3, 0);
}

function groupOf(d: ChunkMeshData, name: string): ChunkMeshGroup | undefined {
  return d.groups.find((g) => g.name === name);
}

function allGroups(): ChunkMeshGroup[] {
  return [...meshes.values()].flatMap(([a, b]) => [...a.groups, ...b.groups]);
}

describe('buildChunkMesh', () => {
  it('is deterministic', () => {
    for (const [cx, cz] of CHUNKS.slice(0, 3)) {
      const again = buildChunkMesh(city, chunkLayout(city, cx, cz), 0);
      expect(again).toEqual(meshes.get(`${cx},${cz}`)?.[0]);
    }
  });

  it('stays within the group budget and keeps group order', () => {
    for (const [lod0, lod1] of meshes.values()) {
      expect(lod0.groups.length).toBeGreaterThan(0);
      expect(lod0.groups.length).toBeLessThanOrEqual(5);
      expect(lod1.groups.length).toBeLessThanOrEqual(3);
      expect(lod1.groups.every((g) => g.name === 'ground' || g.name === 'buildings' || g.name === 'lamps')).toBe(true);
      const order = ['ground', 'markings', 'buildings', 'props', 'lamps'];
      const idx = lod0.groups.map((g) => order.indexOf(g.name));
      expect(idx).toEqual([...idx].sort((a, b) => a - b));
    }
  });

  it('produces consistent buffers: indices in range, unit normals, matching lengths', () => {
    for (const g of allGroups()) {
      const n = g.positions.length / 3;
      expect(Number.isInteger(n)).toBe(true);
      expect(g.normals.length).toBe(n * 3);
      expect(g.colors.length).toBe(n * 3);
      if (g.uvs) expect(g.uvs.length).toBe(n * 2);
      expect(g.uvs !== null).toBe(g.name === 'buildings');
      expect(g.indices.length % 3).toBe(0);
      let maxIndex = 0;
      for (const i of g.indices) maxIndex = Math.max(maxIndex, i);
      expect(maxIndex).toBeLessThan(n);
      for (let i = 0; i < g.normals.length; i += 3) {
        expect(Math.hypot(g.normals[i] ?? 0, g.normals[i + 1] ?? 0, g.normals[i + 2] ?? 0)).toBeCloseTo(1, 5);
      }
      for (const c of g.colors) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });

  it('winds every triangle to match its normal', () => {
    for (const g of allGroups()) {
      const p = g.positions;
      for (let t = 0; t < g.indices.length; t += 3) {
        const [a, b, c] = [g.indices[t] ?? 0, g.indices[t + 1] ?? 0, g.indices[t + 2] ?? 0];
        const ux = (p[b * 3] ?? 0) - (p[a * 3] ?? 0), uy = (p[b * 3 + 1] ?? 0) - (p[a * 3 + 1] ?? 0), uz = (p[b * 3 + 2] ?? 0) - (p[a * 3 + 2] ?? 0);
        const vx = (p[c * 3] ?? 0) - (p[a * 3] ?? 0), vy = (p[c * 3 + 1] ?? 0) - (p[a * 3 + 1] ?? 0), vz = (p[c * 3 + 2] ?? 0) - (p[a * 3 + 2] ?? 0);
        const cross = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx] as const;
        const dot = cross[0] * (g.normals[a * 3] ?? 0) + cross[1] * (g.normals[a * 3 + 1] ?? 0) + cross[2] * (g.normals[a * 3 + 2] ?? 0);
        expect(dot).toBeGreaterThan(0);
      }
    }
  });

  it('has fewer vertices at LOD1 than LOD0 wherever there is detail', () => {
    for (const [key, [lod0, lod1]] of meshes) {
      const l = layouts.get(key) as ChunkLayout;
      expect(vertexCount(lod1)).toBeLessThanOrEqual(vertexCount(lod0));
      if (l.props.length > 0 || l.edges.length > 0) expect(vertexCount(lod1)).toBeLessThan(vertexCount(lod0));
    }
  });

  it('keeps every vertex inside its group sphere', () => {
    for (const g of allGroups()) {
      const [x, y, z, r] = g.sphere;
      for (let i = 0; i < g.positions.length; i += 3) {
        const d = Math.hypot((g.positions[i] ?? 0) - x, (g.positions[i + 1] ?? 0) - y, (g.positions[i + 2] ?? 0) - z);
        expect(d).toBeLessThanOrEqual(r);
      }
    }
  });

  it('draws flat upward ground inside the chunk and markings above it', () => {
    for (const [lod0] of meshes.values()) {
      const ground = groupOf(lod0, 'ground') as ChunkMeshGroup;
      expect(ground).toBeDefined();
      let groundTop = -Infinity;
      for (let i = 0; i < ground.positions.length; i += 3) {
        groundTop = Math.max(groundTop, ground.positions[i + 1] ?? 0);
        expect(ground.normals[i + 1]).toBe(1);
        const x = ground.positions[i] ?? 0, z = ground.positions[i + 2] ?? 0;
        const b = chunkBounds(lod0.cx, lod0.cz);
        expect(x).toBeGreaterThanOrEqual(b.minX);
        expect(x).toBeLessThanOrEqual(b.maxX);
        expect(z).toBeGreaterThanOrEqual(b.minZ);
        expect(z).toBeLessThanOrEqual(b.maxZ);
      }
      const markings = groupOf(lod0, 'markings');
      if (!markings) continue;
      for (let i = 0; i < markings.positions.length; i += 3) {
        expect(markings.positions[i + 1]).toBeGreaterThan(groundTop);
        expect(markings.positions[i + 1]).toBeLessThan(0.05);
        expect(markings.normals[i + 1]).toBe(1);
      }
    }
  });

  it('draws the outer half of the perimeter roads and the world boundary wall in an edge chunk, at both LODs', () => {
    const [lod0, lod1] = meshes.get('13,13') as [ChunkMeshData, ChunkMeshData];
    const ground = groupOf(lod0, 'ground') as ChunkMeshGroup;
    let maxX = -Infinity;
    for (let i = 0; i < ground.positions.length; i += 3) maxX = Math.max(maxX, ground.positions[i] ?? 0);
    expect(maxX).toBe(3584 + 16);
    for (const lod of [lod0, lod1]) {
      const walls = groupOf(lod, 'buildings') as ChunkMeshGroup;
      let wallTop = 0;
      for (let i = 0; i < walls.positions.length; i += 3) {
        if ((walls.positions[i] ?? 0) > 3584 + 13) wallTop = Math.max(wallTop, walls.positions[i + 1] ?? 0);
      }
      expect(wallTop).toBe(3);
    }
  });

  it('meshes roads, markings, buildings, props and lamps in a city chunk', () => {
    const [lod0] = meshes.get('0,0') as [ChunkMeshData, ChunkMeshData];
    expect(lod0.groups.map((g) => g.name)).toEqual(['ground', 'markings', 'buildings', 'props', 'lamps']);
  });

  it('lists every buffer once for the transfer list', () => {
    const [lod0] = meshes.get('0,0') as [ChunkMeshData, ChunkMeshData];
    const buffers = chunkMeshTransferables(lod0);
    expect(new Set(buffers).size).toBe(buffers.length);
    expect(buffers.length).toBe(lod0.groups.length * 4 + lod0.groups.filter((g) => g.uvs).length);
  });

  it('meshes a chunk well within the worker budget', () => {
    const t0 = performance.now();
    let n = 0;
    for (const l of layouts.values()) {
      buildChunkMesh(city, l, 0);
      n++;
    }
    // Budget is 20 ms per chunk in the worker; generous here for slow CI machines.
    expect((performance.now() - t0) / n).toBeLessThan(40);
  });
});
