import { describe, expect, it } from 'vitest';
import { generateInterior } from '../../src/interior/generate';
import { findPath } from '../../src/interior/nav';
import { lineOfSight } from '../../src/interior/los';
import { BUILDING_KINDS } from '../../src/world/buildings';
import { cityBuildings, handBuilding, indexFor, SEED, templateSizes } from './helpers';

describe('interior performance', () => {
  it('generates an interior in <= 3 ms on average over 100 buildings', () => {
    const sample = cityBuildings(indexFor(), 100).slice(0, 100);
    // Top up with hand-made large buildings so the mix includes every kind.
    let id = 800_000;
    for (const kind of BUILDING_KINDS) {
      const { max } = templateSizes(kind, 0);
      if (!sample.some((b) => b.kind === kind)) sample.push(handBuilding(kind, max[0], max[1], 0, id++));
    }
    const batch = sample.slice(0, 100);
    for (const b of batch.slice(0, 10)) generateInterior(SEED, b);
    const t0 = performance.now();
    for (const b of batch) generateInterior(SEED, b);
    const avg = (performance.now() - t0) / batch.length;
    expect(avg).toBeLessThan(3);
  });

  it('keeps path and sight queries cheap', () => {
    const l = generateInterior(SEED, handBuilding('hospital', 40, 24, 0))!;
    const out = new Float32Array(64);
    const a = l.rooms[0]!.rect, b = l.rooms[l.rooms.length - 1]!.rect;
    const open = (): boolean => true;
    const t0 = performance.now();
    for (let i = 0; i < 2000; i++) {
      findPath(l, (a.minX + a.maxX) / 2, (a.minZ + a.maxZ) / 2, (b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2, open, out);
      lineOfSight(l, open, a.minX + 1, 1.6, a.minZ + 1, b.maxX - 1, 1.6, b.maxZ - 1);
    }
    expect((performance.now() - t0) / 2000).toBeLessThan(0.2);
  });
});
