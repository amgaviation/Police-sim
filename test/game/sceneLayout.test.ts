import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import {
  BOX_PALETTE,
  PYRAMID_BASE,
  SCATTER_COUNT,
  layoutPyramid,
  layoutScene,
  nextBoxColor,
  pyramidCount,
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
