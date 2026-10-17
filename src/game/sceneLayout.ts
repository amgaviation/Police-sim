import type { Rng } from '../core/rng';

/** Full edge length of every debug box (`spawn box`). */
export const BOX_SIZE = 1;
/** Free space between neighbouring cells of the drop lattice. */
const DROP_GAP = 0.25;
/** Drop-lattice jitter per axis; under half the gap, so neighbours never touch. */
const DROP_JITTER = DROP_GAP * 0.4;
/** Columns per side of the drop lattice (one layer holds DROP_WIDTH^2 boxes). */
export const DROP_WIDTH = 10;

/** Muted palette; indexes are drawn from the seeded colour stream. */
export const BOX_PALETTE: readonly number[] = [
  0xc8553d, 0xe1a04a, 0x8fb339, 0x3f9ea6, 0x4a6fa5, 0x8e5ba6, 0xb8b8b8, 0x6b4f3a,
];

export interface BoxPlacement {
  x: number;
  y: number;
  z: number;
}

/**
 * `count` boxes on a non-overlapping lattice centred on (cx, cz): layers of
 * DROP_WIDTH x DROP_WIDTH cells stacked upward from `baseY` (the lowest box
 * centre), each with a little seeded jitter (three draws per box).
 */
export function layoutDropLattice(rng: Rng, count: number, cx: number, cz: number, baseY: number): BoxPlacement[] {
  const pitch = BOX_SIZE + DROP_GAP;
  const offset = ((DROP_WIDTH - 1) * pitch) / 2;
  const perLayer = DROP_WIDTH * DROP_WIDTH;
  const out: BoxPlacement[] = [];
  for (let i = 0; i < count; i++) {
    const cell = i % perLayer;
    const layer = Math.floor(i / perLayer);
    out.push({
      x: cx - offset + (cell % DROP_WIDTH) * pitch + rng.nextFloat(-DROP_JITTER, DROP_JITTER),
      y: baseY + layer * pitch + rng.nextFloat(-DROP_JITTER, DROP_JITTER),
      z: cz - offset + Math.floor(cell / DROP_WIDTH) * pitch + rng.nextFloat(-DROP_JITTER, DROP_JITTER),
    });
  }
  return out;
}

/** Next palette colour from the colour stream. */
export function nextBoxColor(rng: Rng): number {
  return rng.pick(BOX_PALETTE);
}
