import { WORLD_HALF_SIZE } from './constants';

/** Edge length of the spatial hash cells (m). */
export const HASH_CELL = 64;
/** Hash covers the world plus this margin on every side. */
const MARGIN = 128;
/** World coordinate of the grid's min corner on x and z. */
export const HASH_ORIGIN = -WORLD_HALF_SIZE - MARGIN;
/** Cells per side. */
export const HASH_DIM = Math.ceil((2 * (WORLD_HALF_SIZE + MARGIN)) / HASH_CELL);

/** Clamped hash column/row of a world coordinate. */
export function hashCoord(v: number): number {
  const c = Math.floor((v - HASH_ORIGIN) / HASH_CELL);
  return c < 0 ? 0 : c >= HASH_DIM ? HASH_DIM - 1 : c;
}

/**
 * Static uniform-grid index of axis-aligned boxes in compressed (CSR) form:
 * the items of cell `c` are `items[start[c] .. start[c + 1])`, ascending.
 * Built once; queries never allocate.
 */
export class SpatialHash {
  readonly start: Int32Array;
  readonly items: Int32Array;

  /** `boxes` holds minX, minZ, maxX, maxZ per item. */
  constructor(boxes: Float64Array) {
    const count = boxes.length / 4;
    const cells = HASH_DIM * HASH_DIM;
    const start = new Int32Array(cells + 1);
    const forEachCell = (i: number, fn: (cell: number) => void): void => {
      const x0 = hashCoord(boxes[i * 4] ?? 0);
      const z0 = hashCoord(boxes[i * 4 + 1] ?? 0);
      const x1 = hashCoord(boxes[i * 4 + 2] ?? 0);
      const z1 = hashCoord(boxes[i * 4 + 3] ?? 0);
      for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) fn(cz * HASH_DIM + cx);
    };
    for (let i = 0; i < count; i++) forEachCell(i, (c) => (start[c + 1] = (start[c + 1] ?? 0) + 1));
    for (let c = 0; c < cells; c++) start[c + 1] = (start[c + 1] ?? 0) + (start[c] ?? 0);
    const fill = start.slice(0, cells);
    const items = new Int32Array(start[cells] ?? 0);
    for (let i = 0; i < count; i++) {
      forEachCell(i, (c) => {
        const at = fill[c] ?? 0;
        items[at] = i;
        fill[c] = at + 1;
      });
    }
    this.start = start;
    this.items = items;
  }

  /** Cell index of a point (clamped to the grid). */
  cellAt(x: number, z: number): number {
    return hashCoord(z) * HASH_DIM + hashCoord(x);
  }
}
