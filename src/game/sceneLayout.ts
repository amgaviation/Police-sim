import type { Rng } from '../core/rng';

/** Full edge length of every demo box. */
export const BOX_SIZE = 1;
/** Layers in the demo pyramid (base is `PYRAMID_BASE` x `PYRAMID_BASE`). */
export const PYRAMID_BASE = 7;
/** Loose boxes dropped around the pyramid. */
export const SCATTER_COUNT = 10;
/** Gap between neighbouring boxes so the stack does not start interpenetrating. */
const GAP = 0.04;
const JITTER = 0.015;
const SCATTER_RADIUS = 12;
const SCATTER_MIN_RADIUS = 7;

/** Muted palette; indexes are drawn from the seeded colour stream. */
export const BOX_PALETTE: readonly number[] = [
  0xc8553d, 0xe1a04a, 0x8fb339, 0x3f9ea6, 0x4a6fa5, 0x8e5ba6, 0xb8b8b8, 0x6b4f3a,
];

export interface BoxPlacement {
  x: number;
  y: number;
  z: number;
}

/** Number of boxes `layoutPyramid` produces for a given base width. */
export function pyramidCount(base: number): number {
  let n = 0;
  for (let k = 1; k <= base; k++) n += k * k;
  return n;
}

/**
 * Square pyramid centred on (cx, cz) resting on y = 0, with a little seeded
 * jitter so the stack settles in a lively, but reproducible, way.
 */
export function layoutPyramid(rng: Rng, base: number = PYRAMID_BASE, cx = 0, cz = -8): BoxPlacement[] {
  const pitch = BOX_SIZE + GAP;
  const out: BoxPlacement[] = [];
  for (let layer = 0; layer < base; layer++) {
    const width = base - layer;
    const offset = ((width - 1) * pitch) / 2;
    const y = BOX_SIZE / 2 + layer * (BOX_SIZE + GAP / 2);
    for (let i = 0; i < width; i++) {
      for (let j = 0; j < width; j++) {
        out.push({
          x: cx - offset + i * pitch + rng.nextFloat(-JITTER, JITTER),
          y,
          z: cz - offset + j * pitch + rng.nextFloat(-JITTER, JITTER),
        });
      }
    }
  }
  return out;
}

/** Loose boxes in a ring around the pyramid, dropped from a few metres up. */
export function layoutScatter(rng: Rng, count: number = SCATTER_COUNT, cx = 0, cz = -8): BoxPlacement[] {
  const out: BoxPlacement[] = [];
  for (let i = 0; i < count; i++) {
    const angle = rng.nextFloat(0, Math.PI * 2);
    const radius = rng.nextFloat(SCATTER_MIN_RADIUS, SCATTER_RADIUS);
    out.push({
      x: cx + Math.cos(angle) * radius,
      y: rng.nextFloat(2, 6),
      z: cz + Math.sin(angle) * radius,
    });
  }
  return out;
}

/** The complete demo layout (pyramid first, then scatter) drawn from one stream. */
export function layoutScene(rng: Rng): BoxPlacement[] {
  return [...layoutPyramid(rng), ...layoutScatter(rng)];
}

/** Next palette colour from the colour stream. */
export function nextBoxColor(rng: Rng): number {
  return rng.pick(BOX_PALETTE);
}
