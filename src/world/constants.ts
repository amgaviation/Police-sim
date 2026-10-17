/** Half the world extent: x and z lie in [-WORLD_HALF_SIZE, WORLD_HALF_SIZE] metres. */
export const WORLD_HALF_SIZE = 3584;
/** Streaming chunk edge length (m); chunk (cx, cz) covers [cx * 256, cx * 256 + 256) on x and z. */
export const CHUNK_SIZE = 256;
/**
 * World boundary walls, centred `offset` outside each world edge: beyond the perimeter roads' outer
 * kerb and junction squares (the widest, a highway end, reaches 13.3 m out).
 */
export const WORLD_WALL = { offset: 14.5, halfThickness: 0.5, height: 3 } as const;
/** Chunks on the world edge draw and collide this far past it, so the outer half of the perimeter roads exists (m). */
export const WORLD_EDGE_MARGIN = 16;
/** Authored district cell edge length (m). */
export const DISTRICT_CELL = 512;
/** Chunks per world side; chunk coordinates run from -14 to 13. */
export const CHUNKS_PER_SIDE = 28;
/** District cells per world side. */
export const CELLS_PER_SIDE = 14;
/** Smallest and largest valid chunk coordinate. */
export const MIN_CHUNK = -CHUNKS_PER_SIDE / 2;
export const MAX_CHUNK = CHUNKS_PER_SIDE / 2 - 1;
/** Metres per second in one mile per hour. */
export const MPH = 0.44704;

/** Chunk coordinate containing world coordinate `v`. */
export function chunkCoord(v: number): number {
  return Math.floor(v / CHUNK_SIZE);
}

/** Stable integer key of chunk (cx, cz); valid for coordinates in [-64, 63]. */
export function chunkKey(cx: number, cz: number): number {
  return (cx + 64) * 128 + (cz + 64);
}
