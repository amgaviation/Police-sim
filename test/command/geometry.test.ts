import { beforeAll, describe, expect, it } from 'vitest';
import { circleZone, evacProgress, facing, innerPosts, postSpot, tcpPoints } from '../../src/command/geometry';
import type { City } from '../../src/world/city';
import { generateCity } from '../../src/world/generate';
import type { RoadHit } from '../../src/world/roadGraph';

let city: City;
let cx = 0;
let cz = 0;

beforeAll(() => {
  city = generateCity(42);
  // A road node near the middle of the map gives the tests a realistic centre with roads all around.
  let best = Infinity;
  for (const n of city.graph.nodes) {
    const d = Math.hypot(n.x, n.z);
    if (d < best && n.edges.length >= 3) {
      best = d;
      cx = n.x;
      cz = n.z;
    }
  }
});

describe('postSpot', () => {
  it('is on a road, near the standoff point on the player side of the incident', () => {
    const g = city.graph;
    const spot = postSpot(g, cx, cz, cx + 200, cz, 60);
    const hit: RoadHit = { edge: 0, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 };
    expect(g.nearestEdge(spot.x, spot.z, 5, hit)).not.toBeNull();
    const d = Math.hypot(spot.x - cx, spot.z - cz);
    expect(d).toBeGreaterThan(20);
    expect(d).toBeLessThan(140);
    expect(spot.x).toBeGreaterThan(cx);
  });

  it('is deterministic, and uses +X when the player stands on the incident', () => {
    const g = city.graph;
    expect(postSpot(g, cx, cz, cx - 90, cz + 30, 60)).toEqual(postSpot(g, cx, cz, cx - 90, cz + 30, 60));
    const same = postSpot(g, cx, cz, cx, cz, 60);
    const plus = postSpot(g, cx, cz, cx + 1, cz, 60);
    expect(same).toEqual(plus);
  });

  it('keeps the unsnapped point when no road is within 200 m', () => {
    const spot = postSpot(city.graph, 1e6, 1e6, 1e6 + 10, 1e6, 60);
    expect(spot.x).toBeCloseTo(1e6 + 60, 3);
    expect(spot.z).toBeCloseTo(1e6, 3);
  });
});

describe('tcpPoints', () => {
  it('returns at most max nodes within [0.6, 1.3] x radius, each with an edge leading towards the incident', () => {
    const g = city.graph;
    for (const [r, max] of [[140, 4], [100, 2], [150, 6]] as const) {
      const pts = tcpPoints(g, cx, cz, r, max);
      expect(pts.length).toBeLessThanOrEqual(max);
      expect(pts.length).toBeGreaterThan(0);
      for (const p of pts) {
        const d = Math.hypot(p.x - cx, p.z - cz);
        expect(d).toBeGreaterThanOrEqual(r * 0.6 - 1e-6);
        expect(d).toBeLessThanOrEqual(r * 1.3 + 1e-6);
        const node = g.nodes[p.node];
        expect(node?.x).toBe(p.x);
        const inward = (node?.edges ?? []).some((eid) => {
          const e = g.edges[eid];
          const other = g.nodes[e && e.from === p.node ? e.to : (e?.from ?? 0)];
          return other !== undefined && Math.hypot(other.x - cx, other.z - cz) < d;
        });
        expect(inward).toBe(true);
        // facing the incident: forward = (-sin yaw, -cos yaw)
        const fx = -Math.sin(p.yaw);
        const fz = -Math.cos(p.yaw);
        expect(fx * (cx - p.x) + fz * (cz - p.z)).toBeGreaterThan(0.99 * d);
      }
    }
  });

  it('is sorted by closeness to the radius and deterministic', () => {
    const a = tcpPoints(city.graph, cx, cz, 140, 6);
    const b = tcpPoints(city.graph, cx, cz, 140, 6);
    expect(a).toEqual(b);
    for (let i = 1; i < a.length; i++) {
      const p = a[i - 1];
      const q = a[i];
      expect(p && q).toBeTruthy();
      if (!p || !q) continue;
      const dp = Math.abs(Math.hypot(p.x - cx, p.z - cz) - 140);
      const dq = Math.abs(Math.hypot(q.x - cx, q.z - cz) - 140);
      expect(dp).toBeLessThanOrEqual(dq + 1e-9);
    }
  });

  it('finds nothing far outside the map', () => {
    expect(tcpPoints(city.graph, 1e6, 1e6, 140, 4)).toEqual([]);
  });
});

describe('innerPosts', () => {
  const rect = { minX: 0, minZ: 0, maxX: 20, maxZ: 10 };

  it('pushes the 4 corners out diagonally by the offset', () => {
    const posts = innerPosts(rect, 8);
    expect(posts).toHaveLength(4);
    const corners: [number, number][] = [[0, 0], [20, 0], [20, 10], [0, 10]];
    posts.forEach((p, i) => {
      const [x, z] = corners[i] as [number, number];
      expect(Math.hypot(p.x - x, p.z - z)).toBeCloseTo(8, 6);
      // outside the footprint on both axes
      expect(p.x < rect.minX || p.x > rect.maxX).toBe(true);
      expect(p.z < rect.minZ || p.z > rect.maxZ).toBe(true);
    });
  });

  it('every post faces the building centre', () => {
    for (const p of innerPosts(rect, 8)) {
      const want = facing(10 - p.x, 5 - p.z);
      expect(Math.cos(p.yaw - want)).toBeCloseTo(1, 6);
    }
  });
});

describe('evacProgress', () => {
  it('is cleared building-seconds over buildings x buildingS, clamped', () => {
    expect(evacProgress(0, 4, 25)).toBe(0);
    expect(evacProgress(50, 4, 25)).toBeCloseTo(0.5, 9);
    expect(evacProgress(100, 4, 25)).toBe(1);
    expect(evacProgress(500, 4, 25)).toBe(1);
    expect(evacProgress(-5, 4, 25)).toBe(0);
  });

  it('an empty zone is already evacuated', () => {
    expect(evacProgress(0, 0, 25)).toBe(1);
  });
});

describe('circleZone', () => {
  it('is a closed polygon with `segments` corners on the circle and exact bounds', () => {
    const z = circleZone(77, 100, -50, 30, 12);
    expect(z.id).toBe(77);
    expect(z.points).toBeInstanceOf(Float32Array);
    expect(z.points.length).toBe(24);
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < 24; i += 2) {
      const x = z.points[i] as number;
      const q = z.points[i + 1] as number;
      expect(Math.hypot(x - 100, q + 50)).toBeCloseTo(30, 3);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minZ = Math.min(minZ, q);
      maxZ = Math.max(maxZ, q);
    }
    expect([z.minX, z.maxX, z.minZ, z.maxZ]).toEqual([minX, maxX, minZ, maxZ]);
    expect(z.minX).toBeCloseTo(70, 3);
    expect(z.maxX).toBeCloseTo(130, 3);
    // the first corner is not repeated at the end
    expect(z.points[0] === z.points[22] && z.points[1] === z.points[23]).toBe(false);
  });
});
