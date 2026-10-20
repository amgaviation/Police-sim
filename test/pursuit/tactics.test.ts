import { describe, expect, it } from 'vitest';
import { inCity, timeToBoundary } from '../../src/pursuit/jurisdiction';
import { PURSUIT_CONFIG } from '../../src/pursuit/data';
import { perimeterPosts } from '../../src/pursuit/perimeter';
import { predictPath, predictRoute } from '../../src/pursuit/predict';
import { crossesStrip, stripAcrossEdge } from '../../src/pursuit/strips';
import { canBoxIn, unitsAhead } from '../../src/pursuit/tactics';
import type { Strip } from '../../src/pursuit/types';
import { generateCity } from '../../src/world/generate';
import { laneRef, type LanePoint } from '../../src/world/roadGraph';
import { gridGraph } from '../traffic/helpers';

const BOX = PURSUIT_CONFIG.boxIn;
const RB = PURSUIT_CONFIG.roadblock;

describe('canBoxIn', () => {
  const suspect = { x: 0, z: 0, yaw: 0, speedMph: 5 };
  const player = { x: 5, z: 3, player: true };
  const ai = (x: number, z: number): { x: number; z: number; player: boolean } => ({ x, z, player: false });

  it('is ok with a slow suspect, the player and enough AI units close by', () => {
    expect(canBoxIn(suspect, [player, ai(-6, 4), ai(2, 12)])).toEqual({ ok: true, reason: '' });
  });

  it('fails when the suspect is too fast', () => {
    const r = canBoxIn({ ...suspect, speedMph: BOX.maxSuspectMph + 1 }, [player, ai(-6, 4), ai(2, 12)]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/too fast/);
    expect(canBoxIn({ ...suspect, speedMph: BOX.maxSuspectMph }, [player, ai(-6, 4), ai(2, 12)]).ok).toBe(true);
  });

  it('fails with too few AI units close by', () => {
    const r = canBoxIn(suspect, [player, ai(-6, 4)]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/more units/);
    // A unit just outside the radius does not count.
    expect(canBoxIn(suspect, [player, ai(-6, 4), ai(BOX.radiusM + 1, 0)]).ok).toBe(false);
    expect(canBoxIn(suspect, [player, ai(-6, 4), ai(BOX.radiusM - 1, 0)]).ok).toBe(true);
  });

  it('needs the player close by', () => {
    const r = canBoxIn(suspect, [ai(-6, 4), ai(2, 12), ai(3, 3)]);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/Your car/);
    expect(canBoxIn(suspect, [{ x: 100, z: 0, player: true }, ai(-6, 4), ai(2, 12)]).ok).toBe(false);
  });
});

describe('unitsAhead', () => {
  // Facing -Z: ahead is negative z, the right-hand side is +X.
  const suspect = { x: 0, z: 0, yaw: 0 };

  it('counts units within aheadM and lateralM in front of the suspect', () => {
    const units = [{ x: 0, z: -50 }, { x: 5, z: -99 }, { x: -RB.lateralM, z: -30 }];
    expect(unitsAhead(suspect, units)).toBe(3);
  });

  it('ignores units behind, too far ahead or too far to the side', () => {
    expect(unitsAhead(suspect, [{ x: 0, z: 10 }, { x: 0, z: 0 }])).toBe(0);
    expect(unitsAhead(suspect, [{ x: 0, z: -RB.aheadM - 1 }])).toBe(0);
    expect(unitsAhead(suspect, [{ x: RB.lateralM + 1, z: -20 }])).toBe(0);
    expect(unitsAhead(suspect, [{ x: 0, z: -RB.aheadM }])).toBe(1);
  });

  it('follows the suspect heading', () => {
    // Facing +X (yaw -90 deg): ahead is +X.
    const east = { x: 0, z: 0, yaw: -Math.PI / 2 };
    expect(unitsAhead(east, [{ x: 40, z: 3 }, { x: -40, z: 0 }])).toBe(1);
  });
});

describe('crossesStrip', () => {
  const strip: Strip = { id: 1, x0: 0, z0: -3, x1: 0, z1: 3, placedSim: 0, owner: 'U', active: true };

  it('detects a crossing', () => {
    expect(crossesStrip(-5, 0, 5, 0, strip)).toBe(true);
    expect(crossesStrip(-5, 2, 5, -2, strip)).toBe(true);
  });

  it('misses a segment that stops short, passes beside or beyond the strip', () => {
    expect(crossesStrip(-5, 0, -0.1, 0, strip)).toBe(false);
    expect(crossesStrip(-5, 10, 5, 10, strip)).toBe(false);
    expect(crossesStrip(-5, 3.1, 5, 3.1, strip)).toBe(false);
  });

  it('is false for a parallel segment', () => {
    expect(crossesStrip(1, -3, 1, 3, strip)).toBe(false);
    expect(crossesStrip(0, 4, 0, 8, strip)).toBe(false);
  });

  it('counts touching: an endpoint of either segment on the other', () => {
    expect(crossesStrip(-5, 3, 5, 3, strip)).toBe(true);
    expect(crossesStrip(-5, 0, 0, 0, strip)).toBe(true);
    expect(crossesStrip(0, -1, 0, 5, strip)).toBe(true);
  });
});

describe('stripAcrossEdge', () => {
  const city = generateCity(42);
  const graph = city.graph;

  /** Centre of the travel half: the midpoint of the first and last lane at s. */
  function laneCentre(edge: number, dir: 0 | 1, s: number): { x: number; z: number; hx: number; hz: number } {
    const a: LanePoint = { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 };
    const b: LanePoint = { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 };
    const n = graph.laneCount(edge, dir);
    graph.lanePoint(laneRef(edge, dir, 0), s, a);
    graph.lanePoint(laneRef(edge, dir, n - 1), s, b);
    return { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, hx: a.hx, hz: a.hz };
  }

  const out = (): Strip => ({ id: 0, x0: 0, z0: 0, x1: 0, z1: 0, placedSim: 0, owner: '', active: true });

  it('lies perpendicular to the travel heading and centred on the travel half, in both directions', () => {
    const edges = graph.edges.filter((e) => e.length > 80 && e.lanesForward >= 1 && e.lanesBackward >= 1).slice(0, 12);
    expect(edges.length).toBeGreaterThan(5);
    for (const e of edges) {
      for (const dir of [0, 1] as const) {
        const node = dir === 0 ? e.to : e.from;
        const s = out();
        expect(stripAcrossEdge(graph, e.id, node, 25, 6, s)).toBe(true);
        const sLane = e.length - 25;
        const c = laneCentre(e.id, dir, sLane);
        expect((s.x0 + s.x1) / 2).toBeCloseTo(c.x, 4);
        expect((s.z0 + s.z1) / 2).toBeCloseTo(c.z, 4);
        expect(Math.hypot(s.x1 - s.x0, s.z1 - s.z0)).toBeCloseTo(6, 4);
        const dot = ((s.x1 - s.x0) * c.hx + (s.z1 - s.z0) * c.hz) / 6;
        expect(Math.abs(dot)).toBeLessThan(1e-4);
      }
    }
  });

  it('puts the strip the setback before the node and on the correct side of the road', () => {
    const e = graph.edges.find((x) => x.length > 120 && x.lanesForward >= 1 && x.lanesBackward >= 1);
    if (!e) throw new Error('no suitable edge');
    const to = graph.nodes[e.to];
    const s = out();
    stripAcrossEdge(graph, e.id, e.to, 30, 6, s);
    const mid = { x: (s.x0 + s.x1) / 2, z: (s.z0 + s.z1) / 2 };
    const d = Math.hypot(mid.x - (to?.x ?? 0), mid.z - (to?.z ?? 0));
    expect(d).toBeGreaterThan(25);
    expect(d).toBeLessThan(35);
    // The forward strip and the backward strip are on opposite sides of the centreline.
    const back = out();
    stripAcrossEdge(graph, e.id, e.from, 30, 6, back);
    expect(Math.hypot((back.x0 + back.x1) / 2 - mid.x, (back.z0 + back.z1) / 2 - mid.z)).toBeGreaterThan(e.length / 2);
  });

  it('refuses a node that is not an end of the edge', () => {
    const e = graph.edges[0];
    if (!e) throw new Error('no edge');
    const other = graph.nodes.find((n) => n.id !== e.from && n.id !== e.to);
    expect(stripAcrossEdge(graph, e.id, other?.id ?? -1, 25, 6, out())).toBe(false);
    expect(stripAcrossEdge(graph, -1, 0, 25, 6, out())).toBe(false);
  });

  it('refuses the direction a one-way edge does not allow', () => {
    const e = graph.edges.find((x) => x.lanesBackward === 0 && x.length > 60);
    if (!e) return;
    expect(stripAcrossEdge(graph, e.id, e.to, 25, 6, out())).toBe(true);
    expect(stripAcrossEdge(graph, e.id, e.from, 25, 6, out())).toBe(false);
  });
});

describe('predictPath', () => {
  const grid = gridGraph();
  // Edge 2 runs west -> east on the middle row from node 3 (0, 200) to node 4 (200, 200). Yaw -90 deg faces +X.
  const EAST = -Math.PI / 2;
  const WEST = Math.PI / 2;

  it('goes straight on across a grid', () => {
    expect(predictPath(grid, 2, 50, 200, EAST, 2)).toEqual([4, 5]);
    expect(predictPath(grid, 2, 50, 200, EAST, 1)).toEqual([4]);
  });

  it('breaks ties between equal turns by the lower edge id', () => {
    // At node 5 (400, 200) heading east the only exits are north (edge 10) and south (edge 11).
    expect(predictPath(grid, 2, 50, 200, EAST, 3)).toEqual([4, 5, 2]);
  });

  it('starts from the end node in the travel direction', () => {
    expect(predictPath(grid, 2, 50, 200, WEST, 2)[0]).toBe(3);
    expect(predictPath(grid, 2, 50, 200, WEST, 2)).toEqual([3, 0]);
  });

  it('turns the corner where the road ends and reports the entering edges', () => {
    // Edge 0 (0,0) -> (200,0) heading west ends at corner node 0, whose only other road is edge 6 (south).
    const route = predictRoute(grid, 0, 100, 0, WEST, 2);
    expect(route.nodes).toEqual([0, 3]);
    expect(route.edges).toEqual([0, 6]);
  });

  it('predicts a route on a generated city', () => {
    const city = generateCity(42);
    const e = city.graph.edges.find((x) => x.length > 100);
    if (!e) throw new Error('no edge');
    const a = city.graph.nodes[e.from];
    const b = city.graph.nodes[e.to];
    if (!a || !b) throw new Error('no nodes');
    const yaw = Math.atan2(-(b.x - a.x), -(b.z - a.z));
    const nodes = predictPath(city.graph, e.id, (a.x + b.x) / 2, (a.z + b.z) / 2, yaw, 4);
    expect(nodes[0]).toBe(e.to);
    expect(nodes.length).toBeGreaterThanOrEqual(2);
  });
});

describe('perimeterPosts', () => {
  const grid = gridGraph();

  it('returns at most n posts near the radius, one per sector', () => {
    const posts = perimeterPosts(grid, 200, 200, 200, 4);
    expect(posts.length).toBeLessThanOrEqual(4);
    expect(posts.length).toBeGreaterThanOrEqual(3);
    expect(new Set(posts.map((p) => p.node)).size).toBe(posts.length);
    for (const p of posts) {
      const d = Math.hypot(p.x - 200, p.z - 200);
      expect(d).toBeGreaterThanOrEqual(200 - 1);
      expect(d).toBeLessThanOrEqual(200 * 1.5);
      expect(grid.nodes[p.node]?.x).toBe(p.x);
    }
  });

  it('skips sectors without a node and returns nothing in empty country', () => {
    expect(perimeterPosts(grid, 100, 100, 40, 4)).toEqual([]);
    expect(perimeterPosts(grid, 200, 200, 200, 0)).toEqual([]);
  });

  it('works on a generated city', () => {
    const city = generateCity(42);
    const centre = city.graph.nodes[Math.floor(city.graph.nodes.length / 2)];
    if (!centre) throw new Error('no node');
    const posts = perimeterPosts(city.graph, centre.x, centre.z, 200, 4);
    expect(posts.length).toBeGreaterThan(0);
    expect(posts.length).toBeLessThanOrEqual(4);
    for (const p of posts) expect(Math.hypot(p.x - centre.x, p.z - centre.z)).toBeLessThanOrEqual(300);
  });
});

describe('jurisdiction', () => {
  it('inCity is inclusive of the borders', () => {
    expect(inCity(0, 0)).toBe(true);
    expect(inCity(2560, -2560)).toBe(true);
    expect(inCity(2560.1, 0)).toBe(false);
    expect(inCity(0, -2561)).toBe(false);
  });

  it('timeToBoundary is the straight-line time to the nearest border ahead', () => {
    expect(timeToBoundary(0, 0, 0, 10)).toBeCloseTo(256, 6); // facing -Z, 2560 m to go
    expect(timeToBoundary(0, 0, -Math.PI / 2, 10)).toBeCloseTo(256, 6); // facing +X
    expect(timeToBoundary(0, 0, Math.PI / 2, 20)).toBeCloseTo(128, 6); // facing -X
    expect(timeToBoundary(2000, 0, -Math.PI / 2, 10)).toBeCloseTo(56, 6);
    // Diagonal towards the +X/-Z corner at (0, 2000): the z border is nearer.
    expect(timeToBoundary(0, -2000, -Math.PI / 4, 10)).toBeCloseTo((560 * Math.SQRT2) / 10, 5);
  });

  it('timeToBoundary is 0 outside, Infinity when not moving', () => {
    expect(timeToBoundary(3000, 0, 0, 10)).toBe(0);
    expect(timeToBoundary(0, 0, 0, 0)).toBe(Infinity);
  });
});
