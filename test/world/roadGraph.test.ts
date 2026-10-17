import { describe, expect, it } from 'vitest';
import { createRng } from '../../src/core/rng';
import { MPH } from '../../src/world/constants';
import {
  ASPECT,
  EDGE_FLAG,
  JUNCTION,
  SIGNAL_PENALTY_S,
  STOP_PENALTY_S,
  TURN,
  laneDir,
  laneEdge,
  laneIndex,
  laneRef,
  type LanePoint,
  type RoadGraph,
  type RoadHit,
  type RouteOptions,
  type SignalDef,
} from '../../src/world/roadGraph';
import { buildGraph, cityFor } from './helpers';

const lp = (): LanePoint => ({ x: 0, z: 0, hx: 0, hz: 0, yaw: 0 });
const hit = (): RoadHit => ({ edge: -1, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 });

/** Plus-shaped junction: centre 0, arms east 1, north 2, west 3, south 4. */
function plus(): RoadGraph {
  return buildGraph(
    [[0, 0], [100, 0], [0, -100], [-100, 0], [0, 100]],
    [{ from: 0, to: 1 }, { from: 2, to: 0 }, { from: 3, to: 0 }, { from: 0, to: 4 }],
    [JUNCTION.allWayStop],
  );
}

describe('lane refs', () => {
  it('packs edge, dir and index', () => {
    const lane = laneRef(1234, 1, 3);
    expect(lane).toBe(1234 * 16 + 8 + 3);
    expect(laneEdge(lane)).toBe(1234);
    expect(laneDir(lane)).toBe(1);
    expect(laneIndex(lane)).toBe(3);
    expect(laneDir(laneRef(5, 0, 1))).toBe(0);
  });
});

describe('lane geometry', () => {
  const g = buildGraph(
    [[0, 0], [100, 0], [0, 50], [100, 50], [0, 90], [100, 90]],
    [
      { from: 0, to: 1, lanesF: 2, lanesB: 2, laneWidth: 3.5 },
      { from: 2, to: 3, lanesF: 2, lanesB: 0, laneWidth: 3.25, flags: EDGE_FLAG.oneWay },
      { from: 4, to: 5, lanesF: 2, lanesB: 2, laneWidth: 3.65, median: 4, flags: EDGE_FLAG.divided },
    ],
  );

  it('laneOffset follows the two-way, one-way and divided formulas', () => {
    expect(g.laneOffset(laneRef(0, 0, 0))).toBeCloseTo(5.25);
    expect(g.laneOffset(laneRef(0, 0, 1))).toBeCloseTo(1.75);
    expect(g.laneOffset(laneRef(0, 1, 0))).toBeCloseTo(-5.25);
    expect(g.laneOffset(laneRef(0, 1, 1))).toBeCloseTo(-1.75);
    expect(g.laneOffset(laneRef(1, 0, 0))).toBeCloseTo(1.625);
    expect(g.laneOffset(laneRef(1, 0, 1))).toBeCloseTo(-1.625);
    expect(g.laneOffset(laneRef(2, 0, 0))).toBeCloseTo(2 + 1.5 * 3.65);
    expect(g.laneOffset(laneRef(2, 0, 1))).toBeCloseTo(2 + 0.5 * 3.65);
    expect(g.laneOffset(laneRef(2, 1, 0))).toBeCloseTo(-(2 + 1.5 * 3.65));
    expect(g.laneCount(1, 1)).toBe(0);
  });

  it('lanePoint is on the right of travel with yaw = atan2(-hx, -hz)', () => {
    // Edge 0 runs east (+x); right of east is +z.
    const a = g.lanePoint(laneRef(0, 0, 0), 10, lp());
    expect(a.x).toBeCloseTo(10);
    expect(a.z).toBeCloseTo(5.25);
    expect(a.hx).toBeCloseTo(1);
    expect(a.hz).toBeCloseTo(0);
    expect(a.yaw).toBeCloseTo(-Math.PI / 2);
    // Heading from yaw: (-sin yaw, -cos yaw).
    expect(-Math.sin(a.yaw)).toBeCloseTo(a.hx);
    expect(-Math.cos(a.yaw)).toBeCloseTo(a.hz);
    // Opposite direction: s is measured from `to`, right of west is -z.
    const b = g.lanePoint(laneRef(0, 1, 0), 10, lp());
    expect(b.x).toBeCloseTo(90);
    expect(b.z).toBeCloseTo(-5.25);
    expect(b.hx).toBeCloseTo(-1);
    expect(b.yaw).toBeCloseTo(Math.PI / 2);
  });

  it('a heading of -Z (north) has yaw 0', () => {
    const g2 = buildGraph([[0, 0], [0, -100]], [{ from: 0, to: 1 }]);
    const p = g2.lanePoint(laneRef(0, 0, 0), 50, lp());
    expect(p.yaw).toBeCloseTo(0);
    // Right of north is east (+x).
    expect(p.x).toBeCloseTo(1.75);
    expect(p.z).toBeCloseTo(-50);
  });

  it('laneStart/laneEnd use the node setbacks', () => {
    const g3 = plus();
    const lane = laneRef(0, 0, 0); // centre (setback 8) -> east arm (dead end, 0)
    expect(g3.laneStartNode(lane)).toBe(0);
    expect(g3.laneEndNode(lane)).toBe(1);
    expect(g3.laneStart(lane)).toBe(8);
    expect(g3.laneEnd(lane)).toBe(100);
    expect(g3.laneLength(lane)).toBe(100);
  });
});

describe('connections and approach groups', () => {
  it('a 4-way junction offers straight, left and right but no U-turn', () => {
    const g = plus();
    // Edge 2 runs west arm -> centre: travelling east.
    const c = g.connections(2, 0);
    expect(c.map((x) => x.turn).sort()).toEqual([TURN.straight, TURN.left, TURN.right].sort());
    expect(c.find((x) => x.turn === TURN.straight)).toEqual({ edge: 0, dir: 0, turn: TURN.straight });
    // Right of east is south (+z): edge 3 leaves the centre southwards.
    expect(c.find((x) => x.turn === TURN.right)).toEqual({ edge: 3, dir: 0, turn: TURN.right });
    expect(c.find((x) => x.turn === TURN.left)).toEqual({ edge: 1, dir: 1, turn: TURN.left });
    expect(c.some((x) => x.edge === 2)).toBe(false);
  });

  it('only a dead end offers a U-turn', () => {
    const g = plus();
    expect(g.connections(0, 0)).toEqual([{ edge: 0, dir: 1, turn: TURN.uturn }]);
  });

  it('one-way edges are never entered against their direction', () => {
    const g = buildGraph(
      [[0, 0], [100, 0], [0, -100], [-100, 0]],
      [{ from: 0, to: 1 }, { from: 0, to: 2, lanesB: 0, lanesF: 2 }, { from: 3, to: 0 }],
    );
    expect(g.connections(2, 0).some((c) => c.edge === 1 && c.dir === 1)).toBe(false);
    expect(g.connections(1, 1)).toEqual([]);
  });

  it('approachGroup is 0 along x and 1 along z', () => {
    const g = plus();
    expect(g.approachGroup(2, 0)).toBe(0);
    expect(g.approachGroup(0, 1)).toBe(0);
    expect(g.approachGroup(1, 0)).toBe(1);
    expect(g.approachGroup(3, 1)).toBe(1);
  });
});

describe('signals', () => {
  const sig: SignalDef = { id: 0, node: 0, cycle: 60, offset: 7, green: [20, 29], yellow: 4, allRed: 1.5 };
  const g = buildGraph(
    [[0, 0], [100, 0], [0, -100], [-100, 0], [0, 100]],
    [{ from: 0, to: 1 }, { from: 2, to: 0 }, { from: 3, to: 0 }, { from: 0, to: 4 }],
    [JUNCTION.signal],
    [sig],
  );

  it('runs G0 green, yellow, all red, G1 green, yellow, all red', () => {
    const at = (t: number, group: 0 | 1): number => g.signalAspect(0, group, t - sig.offset);
    expect([at(0, 0), at(0, 1)]).toEqual([ASPECT.green, ASPECT.red]);
    expect([at(21, 0), at(21, 1)]).toEqual([ASPECT.yellow, ASPECT.red]);
    expect([at(24.5, 0), at(24.5, 1)]).toEqual([ASPECT.red, ASPECT.red]);
    expect([at(26, 0), at(26, 1)]).toEqual([ASPECT.red, ASPECT.green]);
    expect([at(55, 0), at(55, 1)]).toEqual([ASPECT.red, ASPECT.yellow]);
    expect([at(59, 0), at(59, 1)]).toEqual([ASPECT.red, ASPECT.red]);
    expect(at(60, 0)).toBe(ASPECT.green);
  });

  it('has the configured durations and never shows two non-red groups', () => {
    const dt = 0.05;
    const time = [new Float64Array(3), new Float64Array(3)];
    for (let t = 0; t < sig.cycle * 2; t += dt) {
      const a0 = g.signalAspect(0, 0, t);
      const a1 = g.signalAspect(0, 1, t);
      expect(a0 === ASPECT.red || a1 === ASPECT.red).toBe(true);
      (time[0] as Float64Array)[a0] = ((time[0] as Float64Array)[a0] ?? 0) + dt;
      (time[1] as Float64Array)[a1] = ((time[1] as Float64Array)[a1] ?? 0) + dt;
    }
    expect((time[0] as Float64Array)[ASPECT.green]).toBeCloseTo(40, 0);
    expect((time[1] as Float64Array)[ASPECT.green]).toBeCloseTo(58, 0);
    expect((time[0] as Float64Array)[ASPECT.yellow]).toBeCloseTo(8, 0);
    expect((time[1] as Float64Array)[ASPECT.yellow]).toBeCloseTo(8, 0);
  });

  it('signalTimeToChange points at the next aspect change', () => {
    for (let t = -30; t < 120; t += 1.37) {
      for (const group of [0, 1] as const) {
        const ttc = g.signalTimeToChange(0, group, t);
        expect(ttc).toBeGreaterThan(0);
        const now = g.signalAspect(0, group, t);
        expect(g.signalAspect(0, group, t + ttc - 1e-6)).toBe(now);
        expect(g.signalAspect(0, group, t + ttc + 1e-6)).not.toBe(now);
      }
    }
  });
});

describe('zones', () => {
  const g = buildGraph(
    [[0, 0], [100, 0], [0, 50], [100, 50], [0, 90], [100, 90], [0, 120], [100, 120]],
    [
      { from: 0, to: 1, flags: EDGE_FLAG.schoolZone, speedMph: 30 },
      { from: 2, to: 3, flags: EDGE_FLAG.construction, speedMph: 40 },
      { from: 4, to: 5, flags: EDGE_FLAG.construction, speedMph: 25 },
      { from: 6, to: 7, flags: EDGE_FLAG.construction, speedMph: 15 },
    ],
  );
  const mon0730 = { hour: 7.5, isWeekday: true };
  const sat0730 = { hour: 7.5, isWeekday: false };
  const mon1200 = { hour: 12, isWeekday: true };

  it('school zones are active only in the weekday windows', () => {
    expect(g.isSchoolZoneActive(0, mon0730)).toBe(true);
    expect(g.isSchoolZoneActive(0, sat0730)).toBe(false);
    expect(g.isSchoolZoneActive(0, mon1200)).toBe(false);
    expect(g.isSchoolZoneActive(0, { hour: 15, isWeekday: true })).toBe(true);
    expect(g.isSchoolZoneActive(1, mon0730)).toBe(false);
    expect(g.effectiveSpeedLimitMph(0, mon0730)).toBe(20);
    expect(g.effectiveSpeedLimitMph(0, sat0730)).toBe(30);
    expect(g.effectiveSpeedLimitMph(0, mon1200)).toBe(30);
  });

  it('construction reduces the limit down to the floor, never raising it', () => {
    expect(g.effectiveSpeedLimitMph(1, mon1200)).toBe(30);
    expect(g.effectiveSpeedLimitMph(2, mon1200)).toBe(20);
    expect(g.effectiveSpeedLimitMph(3, mon1200)).toBe(15);
  });
});

// --- Generated city queries -----------------------------------------------------------

function bruteNearest(g: RoadGraph, x: number, z: number): number {
  let best = Infinity;
  for (const e of g.edges) {
    const [x0, z0, x1, z1] = e.points as unknown as [number, number, number, number];
    const dx = x1 - x0, dz = z1 - z0;
    const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / (dx * dx + dz * dz)));
    best = Math.min(best, Math.hypot(x0 + dx * t - x, z0 + dz * t - z));
  }
  return best;
}

/** Plain Dijkstra with the same cost model as RoadGraph routing. */
function dijkstra(g: RoadGraph, from: number, to: number, options: RouteOptions): number {
  const time = options.cost !== 'distance';
  const dist = new Float64Array(g.nodes.length).fill(Infinity);
  const done = new Uint8Array(g.nodes.length);
  dist[from] = 0;
  const noZone = { hour: 12, isWeekday: false };
  const penalty = (n: number): number => {
    const j = g.nodes[n]?.junction;
    return !time || n === from ? 0 : j === JUNCTION.signal ? SIGNAL_PENALTY_S : j === JUNCTION.none ? 0 : STOP_PENALTY_S;
  };
  const queue: [number, number][] = [[0, from]];
  while (queue.length > 0) {
    queue.sort((a, b) => b[0] - a[0]);
    const [d, u] = queue.pop() as [number, number];
    if (done[u]) continue;
    done[u] = 1;
    if (u === to) return d;
    for (const id of g.nodes[u]?.edges ?? []) {
      const e = g.edges[id];
      if (!e) continue;
      const v = e.from === u ? e.to : e.from;
      if (e.from !== u && e.lanesBackward === 0 && !options.ignoreOneWay) continue;
      const cost = time ? e.length / Math.max(1, g.effectiveSpeedLimitMph(id, noZone) * MPH) : e.length;
      const nd = d + penalty(u) + cost;
      if (nd < (dist[v] ?? Infinity)) {
        dist[v] = nd;
        queue.push([nd, v]);
      }
    }
  }
  return Infinity;
}

describe('generated graph queries', () => {
  const city = cityFor(7);
  const g = city.graph;
  const rng = createRng(99).stream('test');

  it('nearestEdge matches brute force on 200 random points', () => {
    const out = hit();
    for (let i = 0; i < 200; i++) {
      const x = rng.nextFloat(-3700, 3700);
      const z = rng.nextFloat(-3700, 3700);
      const h = g.nearestEdge(x, z, 5000, out);
      expect(h).not.toBeNull();
      expect(out.distance).toBeCloseTo(bruteNearest(g, x, z), 4);
      expect(Math.hypot(out.x - x, out.z - z)).toBeCloseTo(out.distance, 4);
    }
  });

  it('nearestEdge honours maxDistance and fills s, t and side', () => {
    const e = g.edges[10];
    if (!e) throw new Error('missing edge');
    const [x0, z0, x1, z1] = e.points as unknown as [number, number, number, number];
    const ux = (x1 - x0) / e.length, uz = (z1 - z0) / e.length;
    // 1 m right of from -> to at 40 % of the edge.
    const px = x0 + ux * e.length * 0.4 - uz;
    const pz = z0 + uz * e.length * 0.4 + ux;
    const h = g.nearestEdge(px, pz, 50, hit());
    expect(h?.edge).toBe(10);
    expect(h?.s).toBeCloseTo(e.length * 0.4, 3);
    expect(h?.t).toBeCloseTo(0.4, 4);
    expect(h?.side).toBe(1);
    expect(g.nearestEdge(px, pz, 0.5, hit())).toBeNull();
  });

  it('edgesNear and nodesNear match brute force', () => {
    for (let i = 0; i < 20; i++) {
      const x = rng.nextFloat(-3000, 3000);
      const z = rng.nextFloat(-3000, 3000);
      const near = g.edgesNear(x, z, 150, []);
      const brute = g.edges.filter((e) => {
        const [x0, z0, x1, z1] = e.points as unknown as [number, number, number, number];
        const dx = x1 - x0, dz = z1 - z0;
        const t = Math.max(0, Math.min(1, ((x - x0) * dx + (z - z0) * dz) / (dx * dx + dz * dz)));
        return Math.hypot(x0 + dx * t - x, z0 + dz * t - z) <= 150;
      });
      expect(near).toEqual(brute.map((e) => e.id));
      const nodes = g.nodesNear(x, z, 300, []);
      expect(nodes).toEqual(g.nodes.filter((n) => Math.hypot(n.x - x, n.z - z) <= 300).map((n) => n.id));
    }
  });

  it('A* matches Dijkstra on 50 random pairs and only uses legal directions', () => {
    for (let i = 0; i < 50; i++) {
      const a = rng.nextInt(0, g.nodes.length - 1);
      const b = rng.nextInt(0, g.nodes.length - 1);
      for (const cost of ['distance', 'time'] as const) {
        const route = g.findRoute(a, b, { cost });
        expect(route).not.toBeNull();
        if (!route) continue;
        const expected = dijkstra(g, a, b, { cost });
        expect(cost === 'distance' ? route.length : route.time).toBeCloseTo(expected, 4);
        expect(route.nodes[0]).toBe(a);
        expect(route.nodes[route.nodes.length - 1]).toBe(b);
        expect(route.edges.length).toBe(route.nodes.length - 1);
        route.edges.forEach((id, k) => {
          const e = g.edges[id];
          const u = route.nodes[k];
          const v = route.nodes[k + 1];
          expect(e).toBeDefined();
          if (!e) return;
          const forward = e.from === u && e.to === v;
          const backward = e.to === u && e.from === v;
          expect(forward || (backward && e.lanesBackward > 0)).toBe(true);
        });
      }
    }
  });

  it('ignoreOneWay can only shorten a route, avoidEdges is respected', () => {
    for (let i = 0; i < 30; i++) {
      const a = rng.nextInt(0, g.nodes.length - 1);
      const b = rng.nextInt(0, g.nodes.length - 1);
      const legal = g.findRoute(a, b, { cost: 'distance' });
      const free = g.findRoute(a, b, { cost: 'distance', ignoreOneWay: true });
      expect(free).not.toBeNull();
      expect((free?.length ?? Infinity) <= (legal?.length ?? 0) + 1e-6).toBe(true);
      if (legal && legal.edges.length > 0) {
        const avoid = new Set([legal.edges[0] as number]);
        const detour = g.findRoute(a, b, { cost: 'distance', avoidEdges: avoid });
        if (detour) {
          expect(detour.edges.includes(legal.edges[0] as number)).toBe(false);
          expect(detour.length).toBeGreaterThanOrEqual(legal.length - 1e-6);
        }
      }
    }
  });

  it('findRoute to itself is empty and unknown nodes give null', () => {
    expect(g.findRoute(3, 3)).toEqual({ nodes: [3], edges: [], length: 0, time: 0 });
    expect(g.findRoute(-1, 3)).toBeNull();
  });

  it('routeBetweenPoints joins two mid-edge points along the roads', () => {
    for (let i = 0; i < 20; i++) {
      const ax = rng.nextFloat(-3000, 3000), az = rng.nextFloat(-3000, 3000);
      const bx = rng.nextFloat(-3000, 3000), bz = rng.nextFloat(-3000, 3000);
      const r = g.routeBetweenPoints(ax, az, bx, bz, { cost: 'distance' });
      expect(r).not.toBeNull();
      if (!r) continue;
      const p = r.polyline;
      expect(p[0]).toBeCloseTo(r.start.x, 3);
      expect(p[1]).toBeCloseTo(r.start.z, 3);
      expect(p[p.length - 2]).toBeCloseTo(r.end.x, 3);
      expect(p[p.length - 1]).toBeCloseTo(r.end.z, 3);
      let len = 0;
      for (let k = 2; k < p.length; k += 2) len += Math.hypot((p[k] ?? 0) - (p[k - 2] ?? 0), (p[k + 1] ?? 0) - (p[k - 1] ?? 0));
      expect(len).toBeCloseTo(r.length, 1);
      expect(r.edges[0]).toBe(r.start.edge);
      expect(r.edges[r.edges.length - 1]).toBe(r.end.edge);
      // Never longer than snapping to the nodes and routing between them.
      const viaNodes = g.findRoute(g.edges[r.start.edge]?.to ?? 0, g.edges[r.end.edge]?.from ?? 0, { cost: 'distance' });
      const se = g.edges[r.start.edge], ee = g.edges[r.end.edge];
      if (viaNodes && se && ee && se.lanesBackward > 0 && ee.lanesBackward > 0) {
        expect(r.length).toBeLessThanOrEqual(viaNodes.length + (se.length - r.start.s) + r.end.s + 1e-3);
      }
    }
  });

  it('routeBetweenPoints on one two-way edge travels directly', () => {
    const e = g.edges.find((x) => x.lanesBackward > 0 && x.length > 100);
    if (!e) throw new Error('no two-way edge');
    const [x0, z0, x1, z1] = e.points as unknown as [number, number, number, number];
    const at = (s: number): [number, number] => [x0 + ((x1 - x0) * s) / e.length, z0 + ((z1 - z0) * s) / e.length];
    const fwd = g.routeBetweenPoints(...at(20), ...at(70), { cost: 'distance' });
    expect(fwd?.edges).toEqual([e.id]);
    expect(fwd?.nodes).toEqual([]);
    expect(fwd?.length).toBeCloseTo(50, 3);
    const back = g.routeBetweenPoints(...at(70), ...at(20), { cost: 'distance' });
    expect(back?.edges).toEqual([e.id]);
    expect(back?.length).toBeCloseTo(50, 3);
  });

  it('routeBetweenPoints backwards on a one-way edge goes around the block', () => {
    const e = g.edges.find((x) => x.lanesBackward === 0 && x.length > 80);
    if (!e) throw new Error('no one-way edge');
    const [x0, z0, x1, z1] = e.points as unknown as [number, number, number, number];
    const at = (s: number): [number, number] => [x0 + ((x1 - x0) * s) / e.length, z0 + ((z1 - z0) * s) / e.length];
    const r = g.routeBetweenPoints(...at(60), ...at(20), { cost: 'distance' });
    expect(r).not.toBeNull();
    expect((r?.length ?? 0) > 40).toBe(true);
    expect(r?.nodes.length).toBeGreaterThan(1);
    const wrongWay = g.routeBetweenPoints(...at(60), ...at(20), { cost: 'distance', ignoreOneWay: true });
    expect(wrongWay?.length).toBeCloseTo(40, 3);
  });
});
