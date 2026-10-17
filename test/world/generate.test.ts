import { describe, expect, it } from 'vitest';
import { hashString } from '../../src/core/rng';
import { BLOCK_KIND, type City } from '../../src/world/city';
import { CELLS_PER_SIDE, DISTRICT_CELL, WORLD_HALF_SIZE } from '../../src/world/constants';
import { generateCity } from '../../src/world/generate';
import {
  DISTRICT,
  EDGE_FLAG,
  JUNCTION,
  ROAD_CLASS,
  SURFACE,
  type RoadGraph,
} from '../../src/world/roadGraph';
import { cityFor } from './helpers';

/** FNV digest of the graph (nodes, edges, signals). */
function digest(g: RoadGraph): number {
  const parts: (string | number)[] = [];
  for (const n of g.nodes) parts.push(n.x, n.z, n.junction, n.signal, n.setback, n.edges.join(','));
  for (const e of g.edges) {
    parts.push(e.from, e.to, e.roadClass, e.lanesForward, e.lanesBackward, e.flags, e.length, e.name, e.district, e.speedLimitMph);
  }
  for (const s of g.signals) parts.push(s.node, s.cycle, s.offset, s.green[0], s.green[1]);
  return hashString(parts.join('|'));
}

function cellCentre(i: number): number {
  return -WORLD_HALF_SIZE + (i + 0.5) * DISTRICT_CELL;
}

function stronglyConnected(g: RoadGraph): boolean {
  const reach = (forward: boolean): number => {
    const seen = new Uint8Array(g.nodes.length);
    const stack = [0];
    seen[0] = 1;
    let count = 1;
    while (stack.length > 0) {
      const u = stack.pop() as number;
      for (const id of g.nodes[u]?.edges ?? []) {
        const e = g.edges[id];
        if (!e) continue;
        // Forward: edges usable leaving u; reverse: edges usable arriving at u.
        const leaves = e.from === u || e.lanesBackward > 0;
        const arrives = e.to === u || e.lanesBackward > 0;
        if (forward ? !leaves : !arrives) continue;
        const v = e.from === u ? e.to : e.from;
        if (seen[v]) continue;
        seen[v] = 1;
        count++;
        stack.push(v);
      }
    }
    return count;
  };
  return reach(true) === g.nodes.length && reach(false) === g.nodes.length;
}

describe('generateCity', () => {
  const city: City = cityFor(1);
  const g = city.graph;

  it('is deterministic per seed and differs between seeds', () => {
    const t0 = performance.now();
    const again = generateCity(1);
    const ms = performance.now() - t0;
    console.log(`generateCity: ${ms.toFixed(1)} ms, ${g.nodes.length} nodes, ${g.edges.length} edges, ${g.signals.length} signals, ${city.blocks.length} blocks`);
    expect(ms).toBeLessThan(2000);
    expect(digest(again.graph)).toBe(digest(g));
    expect(again.blocks).toEqual(city.blocks);
    expect(again.pois).toEqual(city.pois);
    expect(digest(cityFor(2).graph)).not.toBe(digest(g));
  });

  it('contains all 11 district types and at least 40 km² of land', () => {
    const seen = new Set<number>();
    let land = 0;
    for (let r = 0; r < CELLS_PER_SIDE; r++) {
      for (let c = 0; c < CELLS_PER_SIDE; c++) {
        const d = city.districtAt(cellCentre(c), cellCentre(r));
        seen.add(d);
        if (d !== DISTRICT.water) land += (DISTRICT_CELL * DISTRICT_CELL) / 1e6;
      }
    }
    expect(seen.size).toBe(11);
    expect(land).toBeGreaterThanOrEqual(40);
    expect(city.districtAt(WORLD_HALF_SIZE + 10, 0)).toBe(DISTRICT.water);
    expect(city.districtAt(192, -320)).toBe(DISTRICT.downtown);
  });

  it('is strongly connected', () => {
    expect(stronglyConnected(g)).toBe(true);
  });

  it('has axis-aligned edges whose length matches their points and nodes', () => {
    for (const e of g.edges) {
      const p = e.points;
      expect(p.length).toBe(4);
      const [x0, z0, x1, z1] = p as unknown as [number, number, number, number];
      expect(x0 === x1 || z0 === z1).toBe(true);
      expect(e.length).toBeCloseTo(Math.hypot(x1 - x0, z1 - z0), 4);
      expect([x0, z0]).toEqual([g.nodes[e.from]?.x, g.nodes[e.from]?.z]);
      expect([x1, z1]).toEqual([g.nodes[e.to]?.x, g.nodes[e.to]?.z]);
      expect(e.length).toBeGreaterThan((g.nodes[e.from]?.setback ?? 0) + (g.nodes[e.to]?.setback ?? 0));
      expect(e.width).toBeCloseTo((e.lanesForward + e.lanesBackward) * e.laneWidth + e.median + 2 * e.shoulder, 5);
      expect(e.name.length).toBeGreaterThan(0);
    }
  });

  it('marks one-way edges with no backward lanes and highways divided', () => {
    const oneWay = g.edges.filter((e) => e.flags & EDGE_FLAG.oneWay);
    expect(oneWay.length).toBeGreaterThan(0);
    for (const e of g.edges) {
      expect((e.flags & EDGE_FLAG.oneWay) !== 0).toBe(e.lanesBackward === 0);
      expect(e.lanesForward).toBeGreaterThanOrEqual(1);
      if (e.roadClass === ROAD_CLASS.highway) {
        expect(e.flags & EDGE_FLAG.divided).toBe(EDGE_FLAG.divided);
        expect(e.name).toBe('State Highway 9');
      }
    }
    for (const e of oneWay) expect(e.district).toBe(DISTRICT.downtown);
  });

  it('applies the junction control rules and signal timing', () => {
    for (const n of g.nodes) {
      const inc = n.edges.map((id) => g.edges[id]);
      if (inc.length <= 2) expect(n.junction).toBe(JUNCTION.none);
      if (inc.some((e) => e?.roadClass === ROAD_CLASS.highway) && inc.length >= 3) expect(n.junction).toBe(JUNCTION.signal);
      if (inc.length >= 3 && inc.every((e) => e?.roadClass === ROAD_CLASS.local)) expect(n.junction).toBe(JUNCTION.allWayStop);
      expect(n.signal >= 0).toBe(n.junction === JUNCTION.signal);
      // Incident edges sorted CCW from +X by leaving heading.
      const angles = n.edges.map((id) => {
        const e = g.edges[id];
        const o = e?.from === n.id ? g.nodes[e.to] : g.nodes[e?.from ?? 0];
        const a = Math.atan2(-((o?.z ?? 0) - n.z), (o?.x ?? 0) - n.x);
        return a < 0 ? a + 2 * Math.PI : a;
      });
      expect([...angles].sort((a, b) => a - b)).toEqual(angles);
      if (n.edges.length >= 3) {
        const widest = Math.max(...inc.map((e) => e?.width ?? 0));
        expect(n.setback).toBeCloseTo(widest / 2 + 1.5, 5);
      }
    }
    for (const s of g.signals) {
      expect(g.nodes[s.node]?.signal).toBe(s.id);
      expect(s.green[0] + s.green[1] + 2 * (s.yellow + s.allRed)).toBeCloseTo(s.cycle, 5);
      expect(Math.min(...s.green)).toBeGreaterThanOrEqual(15);
      expect(s.offset).toBeGreaterThanOrEqual(0);
      expect(s.offset).toBeLessThan(s.cycle);
    }
  });

  it('places school zones around schools and some construction', () => {
    const schools = city.pois.filter((p) => p.kind === 'school');
    expect(schools.length).toBeGreaterThan(0);
    const zoned = g.edges.filter((e) => e.flags & EDGE_FLAG.schoolZone);
    expect(zoned.length).toBeGreaterThan(0);
    for (const e of zoned) {
      const [x0, z0, x1, z1] = e.points as unknown as [number, number, number, number];
      const near = schools.some((s) => {
        const t = Math.max(0, Math.min(1, ((s.x - x0) * (x1 - x0) + (s.z - z0) * (z1 - z0)) / (e.length * e.length)));
        return Math.hypot(x0 + (x1 - x0) * t - s.x, z0 + (z1 - z0) * t - s.z) <= 150;
      });
      expect(near).toBe(true);
    }
    const construction = g.edges.filter((e) => e.flags & EDGE_FLAG.construction);
    expect(construction.length).toBeGreaterThan(0);
    for (const e of construction) expect([ROAD_CLASS.arterial, ROAD_CLASS.collector, ROAD_CLASS.local]).toContain(e.roadClass);
  });

  it('gives a district the same limits on every side: boundary edges take the side with the lower limit', () => {
    const arterial = (axis: 'x' | 'z', coord: number, from: number, to: number) =>
      g.edges.filter((e) => {
        const [x0, z0, x1, z1] = e.points as unknown as [number, number, number, number];
        const [c0, c1, a0, a1] = axis === 'x' ? [z0, z1, x0, x1] : [x0, x1, z0, z1];
        return e.roadClass === ROAD_CLASS.arterial && c0 === coord && c1 === coord && Math.min(a0, a1) >= from && Math.max(a0, a1) <= to;
      });
    // Downtown spans x -512..1024, z -1024..0: its north (z = -1024) and south (z = 0) sides alike.
    for (const coord of [-1024, 0]) {
      const side = arterial('x', coord, -512, 1024);
      expect(side.length).toBeGreaterThan(0);
      for (const e of side) {
        expect(e.district).toBe(DISTRICT.downtown);
        expect(e.speedLimitMph).toBe(35);
      }
    }
    for (const coord of [-512, 1024]) {
      for (const e of arterial('z', coord, -1024, 0)) expect(e.speedLimitMph).toBe(35);
    }
    // Rural (55 mph county roads) next to the airport (50): 50 on both of the airport's sides.
    for (const e of g.edges) {
      if (e.roadClass !== ROAD_CLASS.county) continue;
      const [x0, z0, x1, z1] = e.points as unknown as [number, number, number, number];
      const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
      const [a, b] = z0 === z1 ? [city.districtAt(mx, mz - 1), city.districtAt(mx, mz + 1)] : [city.districtAt(mx - 1, mz), city.districtAt(mx + 1, mz)];
      if ((a === DISTRICT.rural && b === DISTRICT.airport) || (a === DISTRICT.airport && b === DISTRICT.rural)) {
        expect(e.speedLimitMph).toBe(50);
      }
    }
  });

  it('has the station, landmarks, spawn and parking', () => {
    const kinds = new Set(city.pois.map((p) => p.kind));
    for (const k of ['station', 'hospital', 'campus', 'airport', 'harbor', 'school', 'fuel', 'park']) expect(kinds.has(k as never)).toBe(true);
    const station = city.pois.find((p) => p.kind === 'station');
    expect(station).toBeDefined();
    const block = city.blocks[station?.block ?? -1];
    expect(block?.poi).toBe(station?.id);
    expect(Math.hypot((station?.x ?? 0) - 192, (station?.z ?? 0) + 320)).toBeLessThan(80);
    expect(city.parking.length).toBeGreaterThanOrEqual(4);
    // Spawn and every slot lie inside the station block, clear of the roads.
    for (const p of [city.spawn, ...city.parking]) {
      expect(p.x).toBeGreaterThan(block?.minX ?? 0);
      expect(p.x).toBeLessThan(block?.maxX ?? 0);
      expect(p.z).toBeGreaterThan(block?.minZ ?? 0);
      expect(p.z).toBeLessThan(block?.maxZ ?? 0);
    }
    for (const p of city.pois) {
      const e = g.edges[p.entrance.edge];
      expect(e).toBeDefined();
      expect(city.blocks[p.block]?.poi).toBe(p.id);
    }
    // Slots are far enough apart for a 1.95 m wide car.
    const xs = city.parking.map((p) => p.x + p.z).sort((a, b) => a - b);
    for (let i = 1; i < xs.length; i++) expect((xs[i] ?? 0) - (xs[i - 1] ?? 0)).toBeGreaterThan(3);
  });

  it('builds every landmark even when all of its district blocks roll parking', () => {
    // 483, 665, 744, 514736 and 1092823 once had four parking blocks in the hospital cell and no hospital.
    for (const seed of [483, 665, 744, 514736, 1092823, ...Array.from({ length: 40 }, (_, i) => i)]) {
      const c = generateCity(seed);
      for (const k of ['hospital', 'campus', 'airport', 'harbor'] as const) {
        const p = c.pois.find((q) => q.kind === k);
        expect(p, `seed ${seed} ${k}`).toBeDefined();
        expect(c.blocks[p?.block ?? -1]?.kind).not.toBe(BLOCK_KIND.parking);
      }
    }
  });

  it('blocks stay inside their cell and blocksIn returns overlapping ids ascending', () => {
    for (const b of city.blocks) {
      expect(b.maxX).toBeGreaterThan(b.minX);
      expect(b.maxZ).toBeGreaterThan(b.minZ);
      const col = Math.floor((b.minX + WORLD_HALF_SIZE) / DISTRICT_CELL);
      expect(Math.floor((b.maxX - 1e-6 + WORLD_HALF_SIZE) / DISTRICT_CELL)).toBe(col);
      expect(city.districtAt((b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2)).toBe(b.district);
    }
    const out = city.blocksIn(-300, -300, 300, 300, [99]);
    const brute = city.blocks.filter((b) => b.maxX >= -300 && b.minX <= 300 && b.maxZ >= -300 && b.minZ <= 300).map((b) => b.id);
    expect(out).toEqual(brute);
  });

  it('surfaceAt classifies roads, sidewalks and block ground', () => {
    const mid = (id: number): [number, number] => {
      const e = g.edges[id];
      const p = e?.points as unknown as [number, number, number, number];
      return [(p[0] + p[2]) / 2, (p[1] + p[3]) / 2];
    };
    const arterial = g.edges.find((e) => e.roadClass === ROAD_CLASS.arterial && e.sidewalk > 0);
    if (!arterial) throw new Error('no arterial');
    const [ax, az] = mid(arterial.id);
    expect(city.surfaceAt(ax, az)).toBe(SURFACE.asphalt);
    // Sidewalk: halfway across the sidewalk, perpendicular to the edge.
    const [x0, z0, x1, z1] = arterial.points as unknown as [number, number, number, number];
    const nx = -(z1 - z0) / arterial.length, nz = (x1 - x0) / arterial.length;
    const off = arterial.width / 2 + arterial.sidewalk / 2;
    expect(city.surfaceAt(ax + nx * off, az + nz * off)).toBe(SURFACE.concrete);
    expect(city.surfaceAt(ax - nx * off, az - nz * off)).toBe(SURFACE.concrete);
    const gravel = g.edges.find((e) => e.roadClass === ROAD_CLASS.gravel);
    if (!gravel) throw new Error('no gravel road');
    expect(city.surfaceAt(...mid(gravel.id))).toBe(SURFACE.gravel);
    const yard = city.blocks.find((b) => b.district === DISTRICT.suburbs && b.kind === BLOCK_KIND.lots);
    if (!yard) throw new Error('no suburb lot');
    expect(city.surfaceAt(yard.minX + 1, yard.minZ + 1)).toBe(SURFACE.grass);
    const downtown = city.blocks.find((b) => b.district === DISTRICT.downtown && b.kind === BLOCK_KIND.lots);
    if (!downtown) throw new Error('no downtown lot');
    expect(city.surfaceAt((downtown.minX + downtown.maxX) / 2, (downtown.minZ + downtown.maxZ) / 2)).toBe(SURFACE.concrete);
  });

  it('surfaceAt reports the junction square where it reaches over a block corner', () => {
    // Seed 42, node 49: county edges meet arterial ones, so the square covers farm block 21's corner.
    const c = cityFor(42);
    const n = c.graph.nodes[49];
    expect([n?.x, n?.z]).toEqual([-2048, -2560]);
    const b = c.blocks[21];
    expect(b?.kind).toBe(BLOCK_KIND.farm);
    expect(-2054).toBeGreaterThan(b?.minX ?? 0);
    expect(c.surfaceAt(-2054, -2566)).toBe(SURFACE.asphalt);
    expect(c.surfaceAt(-2054, -2570)).toBe(SURFACE.grass);
  });
});
