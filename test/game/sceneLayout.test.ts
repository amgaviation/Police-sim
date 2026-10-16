import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import {
  BOX_PALETTE,
  BOX_SIZE,
  DROP_WIDTH,
  PYRAMID_BASE,
  SCATTER_COUNT,
  layoutDropLattice,
  layoutPyramid,
  layoutScene,
  nextBoxColor,
  pyramidCount,
  type BoxPlacement,
} from '../../src/game/sceneLayout';

describe('sceneLayout', () => {
  it('pyramidCount sums the square layers', () => {
    expect(pyramidCount(1)).toBe(1);
    expect(pyramidCount(3)).toBe(14);
    expect(pyramidCount(PYRAMID_BASE)).toBe(140);
  });

  it('layoutScene is deterministic for a seed and holds ~150 boxes', () => {
    const a = layoutScene(createRng(42).stream('scene'));
    const b = layoutScene(createRng(42).stream('scene'));
    expect(a).toEqual(b);
    expect(a.length).toBe(pyramidCount(PYRAMID_BASE) + SCATTER_COUNT);
    expect(a.length).toBeGreaterThanOrEqual(150);
  });

  it('different seeds give different layouts', () => {
    const a = layoutScene(createRng(1).stream('scene'));
    const b = layoutScene(createRng(2).stream('scene'));
    expect(a).not.toEqual(b);
  });

  it('pyramid boxes rest at or above the ground and the top is a single box', () => {
    const boxes = layoutPyramid(createRng('x'), 4);
    expect(boxes.length).toBe(pyramidCount(4));
    for (const box of boxes) expect(box.y).toBeGreaterThanOrEqual(0.5);
    const top = Math.max(...boxes.map((b) => b.y));
    expect(boxes.filter((b) => b.y === top)).toHaveLength(1);
  });

  it('nextBoxColor only returns palette entries', () => {
    const rng = createRng(7);
    for (let i = 0; i < 50; i++) expect(BOX_PALETTE).toContain(nextBoxColor(rng));
  });
});

describe('layoutScene golden output', () => {
  // The demo scene for seed 42; a change here means "same seed, same shift" no longer holds.
  it('seed 42 places the same boxes', () => {
    const placements = layoutScene(createRng(42).stream('scene'));
    expect(placements).toHaveLength(150);
    expect(placements.slice(0, 3)).toEqual([
      { x: -3.133074926293921, y: 0.5, z: -11.111728974774016 },
      { x: -3.120719654846471, y: 0.5, z: -10.092795533055908 },
      { x: -3.125392128468957, y: 0.5, z: -9.048053293263076 },
    ]);
    expect(placements.slice(-2)).toEqual([
      { x: -10.364456088624983, y: 4.140079630538821, z: -5.169049418013541 },
      { x: 7.138479785826387, y: 3.8597257556393743, z: -13.589400671682384 },
    ]);
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
