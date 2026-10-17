import { describe, expect, it } from 'vitest';
import { addressAt, addressOnEdge, locationOf } from '../../src/cad/address';
import { createRng } from '../../src/core/rng';
import {
  DISTRICT,
  DISTRICT_NAMES,
  JUNCTION,
  ROAD_CLASS,
  RoadGraph,
  SURFACE,
  type RoadClassId,
  type RoadEdge,
  type RoadNode,
} from '../../src/world/roadGraph';
import { cityFor } from '../world/helpers';

interface Street {
  readonly name: string;
  readonly cls?: RoadClassId;
  /** Node indices along the street; each consecutive pair becomes an edge. */
  readonly nodes: readonly number[];
  /** Digitise the edges backwards (to -> from) to prove parity does not depend on it. */
  readonly reverse?: boolean;
}

/** Axis-aligned grid with named streets (adapted from test/world/helpers.ts buildGraph). */
function namedGraph(points: readonly [number, number][], streets: readonly Street[]): RoadGraph {
  const incident: number[][] = points.map(() => []);
  const edges: RoadEdge[] = [];
  for (const st of streets) {
    for (let i = 0; i + 1 < st.nodes.length; i++) {
      let a = st.nodes[i] as number;
      let b = st.nodes[i + 1] as number;
      if (st.reverse) [a, b] = [b, a];
      const [x0, z0] = points[a] as [number, number];
      const [x1, z1] = points[b] as [number, number];
      const id = edges.length;
      incident[a]?.push(id);
      incident[b]?.push(id);
      edges.push({
        id, from: a, to: b, roadClass: st.cls ?? ROAD_CLASS.local, lanesForward: 1, lanesBackward: 1, laneWidth: 3.5,
        median: 0, shoulder: 0.5, sidewalk: 2, width: 8, speedLimitMph: 25, flags: 0, surface: SURFACE.asphalt,
        length: Math.hypot(x1 - x0, z1 - z0), points: new Float32Array([x0, z0, x1, z1]), name: st.name,
        district: DISTRICT.suburbs,
      });
    }
  }
  const nodes: RoadNode[] = points.map(([x, z], id) => ({
    id, x, z, junction: JUNCTION.none, edges: incident[id] ?? [], signal: -1, setback: 0,
  }));
  return new RoadGraph(nodes, edges, []);
}

/**
 * Columns x = -200 (Elm Street), 0 (Oak Street), 200 (Highway 9); rows z = -400 (4th), -200 (2nd),
 * 0 (Main), 200 (3rd), 400 (5th). Oak Street also runs on to a dead end at z = -600; Lonely Lane
 * meets nothing.
 */
function grid(): RoadGraph {
  const xs = [-200, 0, 200];
  const zs = [-400, -200, 0, 200, 400];
  const points: [number, number][] = [];
  const at = (xi: number, zi: number): number => zi * xs.length + xi;
  for (const z of zs) for (const x of xs) points.push([x, z]);
  const deadEnd = points.push([0, -600]) - 1;
  const lonelyA = points.push([1500, 1500]) - 1;
  const lonelyB = points.push([1500, 1700]) - 1;
  const rowNames = ['4th Street', '2nd Street', 'Main Street', '3rd Street', '5th Street'];
  const streets: Street[] = [
    { name: 'Elm Street', nodes: zs.map((_, zi) => at(0, zi)) },
    // North half digitised outward (south -> north), south half inward: parity must not care.
    { name: 'Oak Street', nodes: [at(1, 2), at(1, 1), at(1, 0), deadEnd] },
    { name: 'Oak Street', nodes: [at(1, 2), at(1, 3), at(1, 4)], reverse: true },
    { name: 'Highway 9', cls: ROAD_CLASS.highway, nodes: zs.map((_, zi) => at(2, zi)) },
    { name: 'Lonely Lane', nodes: [lonelyA, lonelyB] },
  ];
  rowNames.forEach((name, zi) => streets.push({ name, nodes: xs.map((_, xi) => at(xi, zi)), reverse: zi % 2 === 1 }));
  return namedGraph(points, streets);
}

describe('addresses on a grid', () => {
  const g = grid();

  it('numbers north-south streets by |z| with N/S prefixes', () => {
    expect(addressAt(g, 3, -250)?.text).toBe('248 N Oak Street');
    expect(addressAt(g, 3, 250)?.text).toBe('248 S Oak Street');
    expect(addressAt(g, -197, -250)?.text).toBe('248 N Elm Street');
    const a = addressAt(g, 3, -250);
    expect(a?.street).toBe('Oak Street');
    expect(a?.number).toBe(248);
    expect(a?.district).toBe('Suburbs');
  });

  it('numbers east-west streets by |x| with E/W prefixes', () => {
    expect(addressAt(g, 150, 3)?.text).toBe('148 E Main Street');
    expect(addressAt(g, -150, 3)?.text).toBe('148 W Main Street');
    expect(addressAt(g, 150, -197)?.text).toBe('148 E 2nd Street');
  });

  it('gives highways no prefix', () => {
    const a = addressAt(g, 203, -250);
    expect(a?.text).toBe('248 Highway 9');
    expect(a?.near).toBe('200 block of Highway 9');
  });

  it('increases numbers away from the centre', () => {
    for (const sign of [-1, 1]) {
      let last = -1;
      for (let d = 10; d < 400; d += 15) {
        const n = addressAt(g, 3, sign * d)?.number ?? -1;
        expect(n).toBeGreaterThan(last);
        last = n;
      }
    }
    let last = -1;
    for (let d = 5; d < 200; d += 10) {
      const n = addressAt(g, d, 3)?.number ?? -1;
      expect(n).toBeGreaterThanOrEqual(last);
      last = n;
    }
  });

  it('gives each side of a street its own parity, whatever the edge direction', () => {
    for (const z of [-350, -250, -50, 50, 250, 350]) {
      const east = addressAt(g, 3, z)?.number ?? -1;
      const west = addressAt(g, -3, z)?.number ?? -1;
      expect(east % 2).toBe(0);
      expect(west % 2).toBe(1);
      expect(west).toBe(east + 1);
    }
    for (const z of [-400, -200, 0, 200, 400]) {
      expect((addressAt(g, 120, z + 3)?.number ?? -1) % 2).toBe(0);
      expect((addressAt(g, 120, z - 3)?.number ?? -1) % 2).toBe(1);
      expect((addressAt(g, -120, z + 3)?.number ?? -1) % 2).toBe(0);
    }
  });

  it('finds a cross street that differs from the street', () => {
    const a = addressAt(g, 3, -250);
    expect(a?.cross).toBe('2nd Street');
    expect(addressAt(g, 3, -370)?.cross).toBe('4th Street');
    expect(addressAt(g, 150, 3)?.cross).toBe('Highway 9');
    for (let z = -590; z <= 390; z += 20) {
      const b = addressAt(g, 2, z);
      expect(b?.cross).not.toBe('');
      expect(b?.cross).not.toBe(b?.street);
    }
  });

  it('falls back to the other end at a dead end, and to nothing on a lone road', () => {
    expect(addressAt(g, 3, -580)?.cross).toBe('4th Street');
    const lone = addressAt(g, 1503, 1600);
    expect(lone?.street).toBe('Lonely Lane');
    expect(lone?.cross).toBe('');
    expect(lone?.near).toBe('1600 block of S Lonely Lane');
  });

  it('switches near text at the intersection radius', () => {
    expect(addressAt(g, 2, -239)?.near).toBe('Oak Street at 2nd Street');
    expect(addressAt(g, 2, -241)?.near).toBe('200 block of N Oak Street');
    expect(addressAt(g, 2, -161)?.near).toBe('Oak Street at 2nd Street');
    expect(addressAt(g, 2, -159)?.near).toBe('100 block of N Oak Street');
    expect(addressAt(g, 160, 2)?.near).toBe('Main Street at Highway 9');
  });

  it('returns null off-road', () => {
    expect(addressAt(g, 100, -100)).toBeNull();
    expect(locationOf(g, 100, -100)).toBeNull();
    expect(addressAt(g, 100, -100, undefined, 200)).not.toBeNull();
    expect(addressAt(g, 5000, 5000)).toBeNull();
  });

  it('builds CAD locations and edge addresses', () => {
    const loc = locationOf(g, 3, -250, () => 'downtown');
    expect(loc).toEqual({
      x: 3, z: -250, edge: addressAt(g, 3, -250)?.edge, text: '248 N Oak Street', street: 'Oak Street',
      cross: '2nd Street', near: '200 block of N Oak Street', district: 'Downtown',
    });
    const a = addressAt(g, 3, -250);
    if (!a) throw new Error('no address');
    const onEdge = addressOnEdge(g, a.edge, a.s);
    expect(onEdge.text).toBe('248 N Oak Street');
    expect(onEdge.near).toBe(a.near);
    expect(addressOnEdge(g, a.edge, -50).s).toBe(0);
    expect(() => addressOnEdge(g, 9999, 0)).toThrow(RangeError);
    for (let e = 0; e < g.edges.length; e++) expect(addressOnEdge(g, e, 40).number % 2).toBe(0);
  });
});

describe('addresses in the generated city', () => {
  const city = cityFor(42);
  const graph = city.graph;
  const districtOf = (x: number, z: number): string => DISTRICT_NAMES[city.districtAt(x, z)] ?? '';

  it('formats edge midpoints with street, district and (mostly) a cross street', () => {
    const rng = createRng(42).stream('test:addresses');
    let withCross = 0;
    const n = 300;
    for (let i = 0; i < n; i++) {
      const edge = rng.nextInt(0, graph.edges.length - 1);
      const e = graph.edges[edge] as RoadEdge;
      const a = addressOnEdge(graph, edge, e.length / 2, districtOf);
      expect(a.text.length).toBeGreaterThan(0);
      expect(a.text).not.toMatch(/ {2}/);
      expect(a.street.length).toBeGreaterThan(0);
      expect(a.district.length).toBeGreaterThan(0);
      expect(a.district.charAt(0)).toBe(a.district.charAt(0).toUpperCase());
      expect(a.near.length).toBeGreaterThan(0);
      if (a.cross !== '') {
        withCross++;
        expect(a.cross).not.toBe(a.street);
      }
      expect(addressOnEdge(graph, edge, e.length / 2, districtOf)).toEqual(a);
    }
    expect(withCross / n).toBeGreaterThanOrEqual(0.9);
  });

  it('addresses points near roads and agrees with the edge formatter', () => {
    const rng = createRng(42).stream('test:addressAt');
    for (let i = 0; i < 100; i++) {
      const edge = rng.nextInt(0, graph.edges.length - 1);
      const e = graph.edges[edge] as RoadEdge;
      const s = e.length * rng.nextFloat(0.2, 0.8);
      const ref = addressOnEdge(graph, edge, s, districtOf);
      const p = e.points;
      const t = s / e.length;
      const x = (p[0] ?? 0) + ((p[p.length - 2] ?? 0) - (p[0] ?? 0)) * t;
      const z = (p[1] ?? 0) + ((p[p.length - 1] ?? 0) - (p[1] ?? 0)) * t;
      const loc = locationOf(graph, x, z, districtOf);
      expect(loc).not.toBeNull();
      if (loc && loc.edge === edge) expect(loc.street).toBe(ref.street);
    }
  });
});
