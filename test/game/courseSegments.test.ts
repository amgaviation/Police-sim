import { describe, expect, it } from 'vitest';
import { straightSegments } from '../../src/game/courseSegments';
import { MIN_SEGMENT_M, pickCourseSegment } from '../../src/training';
import { generateCity } from '../../src/world/generate';

describe('straightSegments', () => {
  const city = generateCity(42);
  const segments = straightSegments(city.graph);

  it('finds straight arterial and collector stretches of at least the minimum length', () => {
    expect(segments.length).toBeGreaterThan(0);
    for (const s of segments) expect(Math.hypot(s.bx - s.ax, s.bz - s.az)).toBeGreaterThanOrEqual(MIN_SEGMENT_M);
  });

  it('is deterministic and gives the course an anchor near the station', () => {
    expect(straightSegments(city.graph)).toEqual(segments);
    const anchor = pickCourseSegment(segments, city.spawn.x, city.spawn.z);
    expect(anchor).not.toBeNull();
    expect(anchor?.length).toBeGreaterThanOrEqual(MIN_SEGMENT_M);
    expect(Math.hypot((anchor?.x ?? 0) - city.spawn.x, (anchor?.z ?? 0) - city.spawn.z)).toBeLessThan(2500);
  });

  it('finds a segment in other cities too', () => {
    for (const seed of [1, 7, 123]) {
      const c = generateCity(seed);
      expect(pickCourseSegment(straightSegments(c.graph), c.spawn.x, c.spawn.z)).not.toBeNull();
    }
  });
});
