import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { BOX_PALETTE, BOX_SIZE, DROP_WIDTH, layoutDropLattice, nextBoxColor, type BoxPlacement } from '../../src/game/sceneLayout';

describe('nextBoxColor', () => {
  it('only returns palette entries', () => {
    const rng = createRng(7);
    for (let i = 0; i < 50; i++) expect(BOX_PALETTE).toContain(nextBoxColor(rng));
  });
});

describe('layoutDropLattice', () => {
  /** Axis-aligned unit cubes overlap only when every axis is closer than BOX_SIZE. */
  function minSeparation(boxes: readonly BoxPlacement[]): number {
    let min = Infinity;
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const a = boxes[i];
        const b = boxes[j];
        if (!a || !b) continue;
        min = Math.min(min, Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.z - b.z)));
      }
    }
    return min;
  }

  it('places boxes without any overlap, stacking layers upward from baseY', () => {
    const boxes = layoutDropLattice(createRng(42), 1000, 3, -2, 4);
    expect(boxes).toHaveLength(1000);
    expect(minSeparation(boxes)).toBeGreaterThanOrEqual(BOX_SIZE);
    expect(Math.min(...boxes.map((b) => b.y))).toBeGreaterThan(4 - BOX_SIZE / 2);
    const perLayer = DROP_WIDTH * DROP_WIDTH;
    const layers = Math.ceil(1000 / perLayer);
    expect(Math.max(...boxes.map((b) => b.y))).toBeLessThan(4 + layers * 1.5 * BOX_SIZE);
    const xs = boxes.map((b) => b.x);
    expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(3, 0);
  });

  it('is deterministic for a seed', () => {
    expect(layoutDropLattice(createRng(7), 50, 0, 0, 4)).toEqual(layoutDropLattice(createRng(7), 50, 0, 0, 4));
    expect(layoutDropLattice(createRng(7), 50, 0, 0, 4)).not.toEqual(layoutDropLattice(createRng(8), 50, 0, 0, 4));
  });
});
