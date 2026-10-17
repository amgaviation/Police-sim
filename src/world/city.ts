import { CELLS_PER_SIDE, DISTRICT_CELL, WORLD_HALF_SIZE } from './constants';
import { districtType } from './data';
import { distanceToPolyline } from './geom';
import { DISTRICT, SURFACE, type DistrictId, type SurfaceId } from './ids';
import type { RoadEdge, RoadGraph, RoadNode } from './roadGraph';
import { SpatialHash } from './spatialHash';

export const BLOCK_KIND = { lots: 0, park: 1, parking: 2, plaza: 3, runway: 4, water: 5, farm: 6, yard: 7, green: 8 } as const;
export type BlockKindId = (typeof BLOCK_KIND)[keyof typeof BLOCK_KIND];
export const BLOCK_KIND_NAMES: readonly (keyof typeof BLOCK_KIND)[] = [
  'lots', 'park', 'parking', 'plaza', 'runway', 'water', 'farm', 'yard', 'green',
];

export type PoiKind = 'station' | 'hospital' | 'campus' | 'airport' | 'harbor' | 'school' | 'fuel' | 'park';

/** Rectangle between road lines (kerb + sidewalk excluded), entirely inside one district cell. */
export interface Block {
  readonly id: number;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly district: DistrictId;
  readonly kind: BlockKindId;
  /** POI id reserving this block, -1 if none. */
  readonly poi: number;
}

export interface Poi {
  readonly id: number;
  readonly kind: PoiKind;
  readonly name: string;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly block: number;
  /** Closest point on the nearest road centreline. */
  readonly entrance: { readonly x: number; readonly z: number; readonly edge: number };
}

export interface Pose2 {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

export interface City {
  readonly seed: number;
  readonly graph: RoadGraph;
  readonly blocks: readonly Block[];
  readonly pois: readonly Poi[];
  /** Station door, on foot. */
  readonly spawn: Pose2;
  /** Station lot slots (>= 4). */
  readonly parking: readonly Pose2[];
  /** District of a point; water outside the map. */
  districtAt(x: number, z: number): DistrictId;
  /** Road -> class surface, sidewalk -> concrete, else block ground; allocation-free. */
  surfaceAt(x: number, z: number): SurfaceId;
  /** Clears `out` and fills it with the blocks overlapping the rectangle, ascending. */
  blocksIn(minX: number, minZ: number, maxX: number, maxZ: number, out: number[]): number[];
}

/** Ground surface of a block. */
export function blockSurface(kind: BlockKindId, district: DistrictId): SurfaceId {
  switch (kind) {
    case BLOCK_KIND.park:
    case BLOCK_KIND.green:
    case BLOCK_KIND.farm:
      return SURFACE.grass;
    case BLOCK_KIND.parking:
    case BLOCK_KIND.runway:
      return SURFACE.asphalt;
    case BLOCK_KIND.plaza:
    case BLOCK_KIND.yard:
      return SURFACE.concrete;
    default:
      return districtType(district).ground;
  }
}

/** District cell (column or row) containing a world coordinate, or -1 outside the map. */
export function cellIndexOf(v: number): number {
  const c = Math.floor((v + WORLD_HALF_SIZE) / DISTRICT_CELL);
  return c >= 0 && c < CELLS_PER_SIDE ? c : -1;
}

/**
 * Generated city: road graph, blocks, POIs and the O(1) point lookups.
 * Blocks are stored row-major by district cell, so `cellBlockStart` maps a
 * cell to a contiguous id range.
 */
export class CityModel implements City {
  readonly seed: number;
  readonly graph: RoadGraph;
  readonly blocks: readonly Block[];
  readonly pois: readonly Poi[];
  readonly spawn: Pose2;
  readonly parking: readonly Pose2[];
  private readonly cells: Uint8Array;
  private readonly cellBlockStart: Int32Array;
  private readonly surfaceHash: SpatialHash;
  /** Junction square half extents per node (0 when the node has no crossing edges) and its surface. */
  private readonly squareX: Float32Array;
  private readonly squareZ: Float32Array;
  private readonly squareSurface: Uint8Array;

  constructor(
    seed: number,
    graph: RoadGraph,
    blocks: readonly Block[],
    pois: readonly Poi[],
    spawn: Pose2,
    parking: readonly Pose2[],
    cells: Uint8Array,
  ) {
    this.seed = seed;
    this.graph = graph;
    this.blocks = blocks;
    this.pois = pois;
    this.spawn = spawn;
    this.parking = parking;
    this.cells = cells;
    const cellCount = CELLS_PER_SIDE * CELLS_PER_SIDE;
    this.cellBlockStart = new Int32Array(cellCount + 1);
    for (const b of blocks) {
      const cell = cellIndexOf((b.minZ + b.maxZ) / 2) * CELLS_PER_SIDE + cellIndexOf((b.minX + b.maxX) / 2);
      this.cellBlockStart[cell + 1] = (this.cellBlockStart[cell + 1] ?? 0) + 1;
    }
    for (let c = 0; c < cellCount; c++) {
      this.cellBlockStart[c + 1] = (this.cellBlockStart[c + 1] ?? 0) + (this.cellBlockStart[c] ?? 0);
    }
    const boxes = new Float64Array(graph.edges.length * 4);
    graph.edges.forEach((e, i) => {
      const pad = e.width / 2 + e.sidewalk;
      const p = e.points;
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (let k = 0; k + 1 < p.length; k += 2) {
        minX = Math.min(minX, p[k] ?? 0); maxX = Math.max(maxX, p[k] ?? 0);
        minZ = Math.min(minZ, p[k + 1] ?? 0); maxZ = Math.max(maxZ, p[k + 1] ?? 0);
      }
      boxes.set([minX - pad, minZ - pad, maxX + pad, maxZ + pad], i * 4);
    });
    this.surfaceHash = new SpatialHash(boxes);
    // Junction squares, sized as the chunk mesher draws them: the widest edge on each axis.
    const nodeCount = graph.nodes.length;
    this.squareX = new Float32Array(nodeCount);
    this.squareZ = new Float32Array(nodeCount);
    this.squareSurface = new Uint8Array(nodeCount);
    const bestClass = new Uint8Array(nodeCount).fill(255);
    for (const e of graph.edges) {
      const p = e.points;
      const n = p.length;
      for (const [node, dx, dz] of [
        [e.from, (p[2] ?? 0) - (p[0] ?? 0), (p[3] ?? 0) - (p[1] ?? 0)],
        [e.to, (p[n - 4] ?? 0) - (p[n - 2] ?? 0), (p[n - 3] ?? 0) - (p[n - 1] ?? 0)],
      ] as const) {
        const half = Math.abs(dx) >= Math.abs(dz) ? this.squareZ : this.squareX;
        half[node] = Math.max(half[node] ?? 0, e.width / 2);
        if (e.roadClass < (bestClass[node] ?? 255)) {
          bestClass[node] = e.roadClass;
          this.squareSurface[node] = e.surface;
        }
      }
    }
  }

  districtAt(x: number, z: number): DistrictId {
    const col = cellIndexOf(x);
    const row = cellIndexOf(z);
    if (col < 0 || row < 0) return DISTRICT.water;
    return (this.cells[row * CELLS_PER_SIDE + col] ?? DISTRICT.water) as DistrictId;
  }

  surfaceAt(x: number, z: number): SurfaceId {
    const { start, items } = this.surfaceHash;
    const cell = this.surfaceHash.cellAt(x, z);
    const edges = this.graph.edges;
    let sidewalk = false;
    for (let i = start[cell] ?? 0, end = start[cell + 1] ?? 0; i < end; i++) {
      const e = edges[items[i] ?? 0] as RoadEdge;
      const sq = this.inSquare(e.from, x, z) ? e.from : this.inSquare(e.to, x, z) ? e.to : -1;
      if (sq >= 0) return (this.squareSurface[sq] ?? SURFACE.asphalt) as SurfaceId;
      const d = distanceToPolyline(e.points, x, z);
      const half = e.width / 2;
      if (d <= half) return e.surface;
      if (d <= half + e.sidewalk) sidewalk = true;
    }
    if (sidewalk) return SURFACE.concrete;
    const col = cellIndexOf(x);
    const row = cellIndexOf(z);
    if (col < 0 || row < 0) return districtType(DISTRICT.water).ground;
    const cell2 = row * CELLS_PER_SIDE + col;
    for (let id = this.cellBlockStart[cell2] ?? 0, end = this.cellBlockStart[cell2 + 1] ?? 0; id < end; id++) {
      const b = this.blocks[id] as Block;
      if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return blockSurface(b.kind, b.district);
    }
    return districtType(this.districtAt(x, z)).ground;
  }

  private inSquare(node: number, x: number, z: number): boolean {
    const hx = this.squareX[node] ?? 0, hz = this.squareZ[node] ?? 0;
    if (hx === 0 || hz === 0) return false;
    const n = this.graph.nodes[node] as RoadNode;
    return Math.abs(x - n.x) <= hx && Math.abs(z - n.z) <= hz;
  }

  blocksIn(minX: number, minZ: number, maxX: number, maxZ: number, out: number[]): number[] {
    out.length = 0;
    const last = CELLS_PER_SIDE - 1;
    const clamp = (v: number): number => Math.min(last, Math.max(0, Math.floor((v + WORLD_HALF_SIZE) / DISTRICT_CELL)));
    const c0 = clamp(minX), c1 = clamp(maxX), r0 = clamp(minZ), r1 = clamp(maxZ);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = r * CELLS_PER_SIDE + c;
        for (let id = this.cellBlockStart[cell] ?? 0, end = this.cellBlockStart[cell + 1] ?? 0; id < end; id++) {
          const b = this.blocks[id] as Block;
          if (b.maxX >= minX && b.minX <= maxX && b.maxZ >= minZ && b.minZ <= maxZ) out.push(id);
        }
      }
    }
    return out;
  }
}
