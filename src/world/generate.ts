import { createRng, type Rng } from '../core/rng';
import { BLOCK_KIND, CityModel, cellIndexOf, type Block, type BlockKindId, type City, type Poi, type PoiKind } from './city';
import { CELLS_PER_SIDE, DISTRICT_CELL, WORLD_HALF_SIZE } from './constants';
import { DISTRICTS, LANDMARKS, ROAD_CLASSES, STREET_NAMES, ZONES, districtType, roadClassDef } from './data';
import { distanceToPolyline, rectDistanceSq } from './geom';
import { DISTRICT, EDGE_FLAG, JUNCTION, ROAD_CLASS, type DistrictId, type JunctionId, type RoadClassId } from './ids';
import { RoadGraph, type RoadEdge, type RoadNode, type SignalDef } from './roadGraph';
import { stationLayout } from './stationLayout';

/** Interior lines parallel to an authored highway and closer than this are dropped (m). */
const HIGHWAY_CLEARANCE = 64;
/** Interior lines closer than this to a neighbour cell's line continue it instead (m). */
const ALIGN_SNAP = 60;
/** Chance that a rural cell gets one gravel interior line. */
const RURAL_GRAVEL_CHANCE = 0.3;
/** Nominal line spacing used to number streets (m). */
const NAME_SLOT = 128;
/** Crosswalk depth added to the junction half width for the stop line (m). */
const CROSSWALK = 1.5;
/** Blocks narrower than this are not created (m). */
const MIN_BLOCK = 8;

/** Axis 0: the line runs along x at z = coord; axis 1: along z at x = coord. */
type Axis = 0 | 1;

interface Line {
  readonly axis: Axis;
  /** Nominal 128 m slot index used for names. */
  readonly slot: number;
  /** Authored name (highways). */
  readonly name: string | null;
}

interface Segment {
  readonly axis: Axis;
  readonly coord: number;
  readonly a: number;
  readonly b: number;
  readonly cls: RoadClassId;
  readonly sidewalk: number;
  /** 0 two-way; +1 one-way toward increasing a -> b; -1 toward decreasing. */
  readonly oneWay: -1 | 0 | 1;
  readonly line: number;
  readonly stops: number[];
}

interface CellLine {
  readonly coord: number;
  /** Half road width + sidewalk: distance from the line to the block edge. */
  readonly inset: number;
  /** Line is a cell boundary. */
  readonly boundary: boolean;
}

interface EdgeRec {
  from: number;
  to: number;
  readonly seg: Segment;
  readonly lanesF: number;
  readonly lanesB: number;
  readonly district: DistrictId;
  removed: boolean;
  flags: number;
}

const H = WORLD_HALF_SIZE;
const N = CELLS_PER_SIDE;

function round2(v: number): number {
  return Math.round(v * 2) / 2;
}

function cellDistrict(col: number, row: number): DistrictId | -1 {
  if (col < 0 || row < 0 || col >= N || row >= N) return -1;
  return (DISTRICTS.cells[row * N + col] ?? DISTRICT.water) as DistrictId;
}

/** Boundary class of one side: none for water/outside, county for rural/airport, else arterial. */
function sideClass(d: DistrictId | -1): RoadClassId | -1 {
  if (d === -1 || d === DISTRICT.water) return -1;
  return d === DISTRICT.rural || d === DISTRICT.airport ? ROAD_CLASS.county : ROAD_CLASS.arterial;
}

function sidewalkFor(cls: RoadClassId, a: DistrictId | -1, b: DistrictId | -1): number {
  const has = (d: DistrictId | -1): boolean => d !== -1 && districtType(d).sidewalk;
  return has(a) || has(b) ? roadClassDef(cls).sidewalk : 0;
}

function roadWidth(cls: RoadClassId, lanes: number): number {
  const c = roadClassDef(cls);
  return lanes * c.laneWidth + c.median + 2 * c.shoulder;
}

function laneSplit(seg: Segment): [number, number] {
  if (seg.oneWay !== 0) return [2, 0];
  const lanes = roadClassDef(seg.cls).lanes;
  return [lanes, lanes];
}

function ordinal(n: number): string {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
  return `${n}${suffix}`;
}

/** Generic street name of a line for a road class (§4.1). */
function streetName(line: Line, cls: RoadClassId, words: readonly string[]): string {
  if (line.name) return line.name;
  const suffix = STREET_NAMES.suffix[cls] ?? 'Street';
  if (cls === ROAD_CLASS.county) return `${suffix} ${line.axis === 1 ? 2 * line.slot + 1 : 2 * line.slot + 2}`;
  if (line.axis === 1) return `${words[line.slot % words.length] ?? 'Main'} ${suffix}`;
  return `${ordinal(line.slot + 1)} ${suffix}`;
}

/** True when every node can reach every other along legal directions (forward + reverse BFS). */
function isStronglyConnected(nodeCount: number, edges: readonly EdgeRec[]): boolean {
  if (nodeCount === 0) return true;
  const fwd: number[][] = Array.from({ length: nodeCount }, () => []);
  const rev: number[][] = Array.from({ length: nodeCount }, () => []);
  for (const e of edges) {
    if (e.removed) continue;
    fwd[e.from]?.push(e.to);
    rev[e.to]?.push(e.from);
    if (e.lanesB > 0) {
      fwd[e.to]?.push(e.from);
      rev[e.from]?.push(e.to);
    }
  }
  const reachesAll = (adj: number[][]): boolean => {
    const seen = new Uint8Array(nodeCount);
    const stack = [0];
    seen[0] = 1;
    let count = 1;
    while (stack.length > 0) {
      for (const v of adj[stack.pop() ?? 0] ?? []) {
        if (seen[v]) continue;
        seen[v] = 1;
        count++;
        stack.push(v);
      }
    }
    return count === nodeCount;
  };
  return reachesAll(fwd) && reachesAll(rev);
}

/**
 * Generates the whole city for a seed (§6). Pure and deterministic: every
 * random draw comes from a named stream of `createRng(seed)`.
 */
export function generateCity(seed: number): City {
  const root = createRng(seed);
  const cellRngs: Rng[] = [];
  for (let row = 0; row < N; row++) for (let col = 0; col < N; col++) cellRngs.push(root.stream(`world:cell:${col},${row}`));

  const lines: Line[] = [];
  const segments: Segment[] = [];
  const cellLines: { x: CellLine[]; z: CellLine[] }[] = Array.from({ length: N * N }, () => ({ x: [], z: [] }));
  const addSegment = (s: Omit<Segment, 'stops'>): Segment => {
    const seg = { ...s, stops: [] };
    segments.push(seg);
    return seg;
  };
  const insetOf = (cls: RoadClassId, oneWay: number, sidewalk: number): number =>
    roadWidth(cls, oneWay !== 0 ? 2 : 2 * roadClassDef(cls).lanes) / 2 + sidewalk;

  // 1-2. Cell boundary lines: a segment wherever a non-water cell borders it.
  for (let k = 0; k <= N; k++) {
    const coord = -H + k * DISTRICT_CELL;
    for (const axis of [0, 1] as const) {
      const line = lines.push({ axis, slot: k * (DISTRICT_CELL / NAME_SLOT), name: null }) - 1;
      for (let i = 0; i < N; i++) {
        // axis 0: z = coord between rows k-1 / k at column i; axis 1: x = coord between columns k-1 / k at row i.
        const da = axis === 0 ? cellDistrict(i, k - 1) : cellDistrict(k - 1, i);
        const db = axis === 0 ? cellDistrict(i, k) : cellDistrict(k, i);
        const ca = sideClass(da), cb = sideClass(db);
        const a = -H + i * DISTRICT_CELL;
        let inset = 0;
        if (ca !== -1 || cb !== -1) {
          const cls = (ca === -1 ? cb : cb === -1 ? ca : Math.min(ca, cb)) as RoadClassId;
          const sidewalk = sidewalkFor(cls, da, db);
          addSegment({ axis, coord, a, b: a + DISTRICT_CELL, cls, sidewalk, oneWay: 0, line });
          inset = insetOf(cls, 0, sidewalk);
        }
        // Register the boundary with both neighbouring cells (axis 0 bounds cells on z, axis 1 on x).
        for (const side of [k - 1, k]) {
          if (side < 0 || side >= N) continue;
          const cell = axis === 0 ? side * N + i : i * N + side;
          (cellLines[cell] as { x: CellLine[]; z: CellLine[] })[axis === 0 ? 'z' : 'x'].push({ coord, inset, boundary: true });
        }
      }
    }
  }

  // Authored highways, split per cell so each piece registers with its cell.
  for (const hw of DISTRICTS.highways) {
    const axis: Axis = hw.axis === 'x' ? 0 : 1;
    const line = lines.push({ axis, slot: Math.round((hw.coord + H) / NAME_SLOT), name: hw.name }) - 1;
    const cross = cellIndexOf(hw.coord);
    for (let a = hw.from; a < hw.to; ) {
      const b = Math.min(hw.to, (Math.floor((a + H) / DISTRICT_CELL) + 1) * DISTRICT_CELL - H);
      addSegment({ axis, coord: hw.coord, a, b, cls: ROAD_CLASS.highway, sidewalk: 0, oneWay: 0, line });
      const along = cellIndexOf((a + b) / 2);
      if (cross >= 0 && along >= 0) {
        const cell = axis === 0 ? cross * N + along : along * N + cross;
        const inset = insetOf(ROAD_CLASS.highway, 0, 0);
        (cellLines[cell] as { x: CellLine[]; z: CellLine[] })[axis === 0 ? 'z' : 'x'].push({ coord: hw.coord, inset, boundary: false });
      }
      a = b;
    }
  }

  // 2-3. Interior lines per cell (row-major), clipped to the cell.
  const interiorCoords: number[][][] = Array.from({ length: N * N }, () => [[], []]);
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const cell = row * N + col;
      const d = cellDistrict(col, row) as DistrictId;
      const type = districtType(d);
      const rng = cellRngs[cell] as Rng;
      const n = type.subdivisions;
      if (n < 2) continue;
      const block = DISTRICT_CELL / n;
      const x0 = -H + col * DISTRICT_CELL;
      const z0 = -H + row * DISTRICT_CELL;
      // Candidate coordinates (always drawn, so the stream stays aligned).
      const cand: number[][] = [[], []];
      for (const axis of [0, 1] as const) {
        const base = axis === 0 ? z0 : x0;
        for (let k = 1; k < n; k++) {
          let coord = round2(base + k * block + rng.nextFloat(-1, 1) * type.jitter * block);
          // Continue the line of the west (axis 0) or north (axis 1) neighbour when it is close.
          const prev = axis === 0 ? (col > 0 ? interiorCoords[cell - 1] : undefined) : row > 0 ? interiorCoords[cell - N] : undefined;
          for (const c of prev?.[axis] ?? []) if (Math.abs(c - coord) < ALIGN_SNAP) coord = c;
          (cand[axis] as number[]).push(coord);
        }
      }
      const keep: { axis: Axis; coord: number; cls: RoadClassId; k: number }[] = [];
      if (d === DISTRICT.rural) {
        if (rng.chance(RURAL_GRAVEL_CHANCE)) {
          const axis: Axis = rng.chance(0.5) ? 0 : 1;
          keep.push({ axis, coord: cand[axis]?.[0] ?? 0, cls: ROAD_CLASS.gravel, k: 1 });
        }
      } else {
        for (const axis of [0, 1] as const) {
          // Airports keep only east-west interior lines so the runway strips stay whole.
          if (d === DISTRICT.airport && axis === 1) continue;
          (cand[axis] as number[]).forEach((coord, i) => {
            const k = i + 1;
            const cls =
              d === DISTRICT.airport || d === DISTRICT.harbor
                ? ROAD_CLASS.service
                : (d === DISTRICT.downtown || d === DISTRICT.suburbs) && k * 2 === n
                  ? ROAD_CLASS.collector
                  : ROAD_CLASS.local;
            keep.push({ axis, coord, cls, k });
          });
        }
      }
      const oneWayCount: [number, number] = [0, 0];
      const kept: [number[], number[]] = [[], []];
      for (const l of keep) {
        if (kept[l.axis].includes(l.coord)) continue;
        const along0 = l.axis === 0 ? x0 : z0;
        const nearHighway = DISTRICTS.highways.some(
          (hw) =>
            (hw.axis === 'x' ? 0 : 1) === l.axis &&
            Math.abs(hw.coord - l.coord) < HIGHWAY_CLEARANCE &&
            hw.from < along0 + DISTRICT_CELL &&
            hw.to > along0,
        );
        if (nearHighway) continue;
        let oneWay: -1 | 0 | 1 = 0;
        if (type.oneWayPairs && l.cls === ROAD_CLASS.local) {
          const i = oneWayCount[l.axis];
          oneWayCount[l.axis] = i + 1;
          // Odd: east (axis 0, +x) or north (axis 1, -z); even: west or south.
          oneWay = i % 2 === 1 ? (l.axis === 0 ? 1 : -1) : l.axis === 0 ? -1 : 1;
        }
        const sidewalk = type.sidewalk ? roadClassDef(l.cls).sidewalk : 0;
        const line = lines.push({ axis: l.axis, slot: Math.round((l.coord + H) / NAME_SLOT), name: null }) - 1;
        addSegment({ axis: l.axis, coord: l.coord, a: along0, b: along0 + DISTRICT_CELL, cls: l.cls, sidewalk, oneWay, line });
        kept[l.axis].push(l.coord);
        (interiorCoords[cell]?.[l.axis] as number[]).push(l.coord);
        (cellLines[cell] as { x: CellLine[]; z: CellLine[] })[l.axis === 0 ? 'z' : 'x'].push({
          coord: l.coord,
          inset: insetOf(l.cls, oneWay, sidewalk),
          boundary: false,
        });
      }
    }
  }

  // 4. Nodes at every crossing and segment end; edges between consecutive nodes on a segment.
  const segX = segments.filter((s) => s.axis === 0);
  const segZ = segments.filter((s) => s.axis === 1);
  for (const s of segments) s.stops.push(s.a, s.b);
  for (const sx of segX) {
    for (const sz of segZ) {
      if (sz.coord >= sx.a && sz.coord <= sx.b && sx.coord >= sz.a && sx.coord <= sz.b) {
        sx.stops.push(sz.coord);
        sz.stops.push(sx.coord);
      }
    }
  }
  const pointKey = (x: number, z: number): number => (x * 2 + 2 * H + 1) * 65536 + (z * 2 + 2 * H + 1);
  const pointSet = new Map<number, [number, number]>();
  for (const s of segments) {
    for (const p of s.stops) {
      const x = s.axis === 0 ? p : s.coord;
      const z = s.axis === 0 ? s.coord : p;
      pointSet.set(pointKey(x, z), [x, z]);
    }
  }
  const points = [...pointSet.values()].sort((p, q) => p[1] - q[1] || p[0] - q[0]);
  const nodeOf = new Map<number, number>();
  points.forEach(([x, z], i) => nodeOf.set(pointKey(x, z), i));
  const nodeCount = points.length;

  const recs: EdgeRec[] = [];
  const midDistrict = (seg: Segment, p: number, q: number): DistrictId => {
    const m = (p + q) / 2;
    const mx = seg.axis === 0 ? m : seg.coord;
    const mz = seg.axis === 0 ? seg.coord : m;
    const at = (x: number, z: number): DistrictId | -1 => cellDistrict(cellIndexOf(x), cellIndexOf(z));
    const d = at(mx, mz);
    if (d !== -1 && d !== DISTRICT.water) return d;
    // Boundary edges next to water take the land side.
    const other = seg.axis === 0 ? at(mx, mz - 1) : at(mx - 1, mz);
    return other !== -1 ? other : d === -1 ? DISTRICT.water : d;
  };
  for (const seg of segments) {
    const stops = [...new Set(seg.stops)].sort((p, q) => p - q);
    const [lanesF, lanesB] = laneSplit(seg);
    for (let i = 0; i + 1 < stops.length; i++) {
      const p = stops[i] ?? 0, q = stops[i + 1] ?? 0;
      const np = nodeOf.get(seg.axis === 0 ? pointKey(p, seg.coord) : pointKey(seg.coord, p)) ?? 0;
      const nq = nodeOf.get(seg.axis === 0 ? pointKey(q, seg.coord) : pointKey(seg.coord, q)) ?? 0;
      const reverse = seg.oneWay === -1;
      let flags = 0;
      if (seg.oneWay !== 0) flags |= EDGE_FLAG.oneWay;
      if (seg.cls === ROAD_CLASS.highway) flags |= EDGE_FLAG.divided;
      recs.push({
        from: reverse ? nq : np,
        to: reverse ? np : nq,
        seg,
        lanesF,
        lanesB,
        district: midDistrict(seg, p, q),
        removed: false,
        flags,
      });
    }
  }

  // 5. Variety: drop some local edges whose end nodes keep degree >= 3, then repair connectivity.
  const degree = new Int32Array(nodeCount);
  for (const e of recs) {
    degree[e.from] = (degree[e.from] ?? 0) + 1;
    degree[e.to] = (degree[e.to] ?? 0) + 1;
  }
  const removed: EdgeRec[] = [];
  for (const e of recs) {
    const fraction = districtType(e.district).removeLocalFraction;
    if (e.seg.cls !== ROAD_CLASS.local || fraction <= 0 || e.lanesB === 0) continue;
    if ((degree[e.from] ?? 0) < 4 || (degree[e.to] ?? 0) < 4) continue;
    const p = points[e.from] as [number, number], q = points[e.to] as [number, number];
    const cell = cellIndexOf((p[1] + q[1]) / 2) * N + cellIndexOf((p[0] + q[0]) / 2);
    if (!(cellRngs[cell] as Rng).chance(fraction)) continue;
    e.removed = true;
    degree[e.from] = (degree[e.from] ?? 0) - 1;
    degree[e.to] = (degree[e.to] ?? 0) - 1;
    removed.push(e);
  }
  while (!isStronglyConnected(nodeCount, recs)) {
    const e = removed.pop();
    if (!e) throw new Error('generateCity: road graph is not strongly connected');
    e.removed = false;
  }
  const live = recs.filter((e) => !e.removed);
  const edgePoints = live.map((e) => {
    const p = points[e.from] as [number, number], q = points[e.to] as [number, number];
    return new Float32Array([p[0], p[1], q[0], q[1]]);
  });

  // 6. Incident lists (CCW from +X by leaving heading), junction control, setbacks.
  const incident: number[][] = Array.from({ length: nodeCount }, () => []);
  live.forEach((e, id) => {
    incident[e.from]?.push(id);
    incident[e.to]?.push(id);
  });
  const leaveAngle = (node: number, id: number): number => {
    const e = live[id] as EdgeRec;
    const here = points[node] as [number, number];
    const there = points[e.from === node ? e.to : e.from] as [number, number];
    const a = Math.atan2(-(there[1] - here[1]), there[0] - here[0]);
    return a < 0 ? a + 2 * Math.PI : a;
  };
  const widthOf = (e: EdgeRec): number => roadWidth(e.seg.cls, e.lanesF + e.lanesB);
  const junctions: JunctionId[] = [];
  const setbacks: number[] = [];
  for (let n = 0; n < nodeCount; n++) {
    const inc = incident[n] as number[];
    inc.sort((a, b) => leaveAngle(n, a) - leaveAngle(n, b));
    const recsHere = inc.map((id) => live[id] as EdgeRec);
    const deg = inc.length;
    let junction: JunctionId = JUNCTION.none;
    if (deg >= 3) {
      // "Two collector-or-higher edges" counts roads, not edge halves: both axes must carry one,
      // otherwise every local T on an arterial would get a signal.
      const majorAxes = new Set(recsHere.filter((e) => e.seg.cls <= ROAD_CLASS.collector).map((e) => e.seg.axis)).size;
      if (recsHere.some((e) => e.seg.cls === ROAD_CLASS.highway) || majorAxes >= 2) junction = JUNCTION.signal;
      else if (recsHere.every((e) => e.seg.cls === ROAD_CLASS.local)) junction = JUNCTION.allWayStop;
      else junction = JUNCTION.minorStop;
    }
    junctions.push(junction);
    const straight = deg === 2 && (recsHere[0] as EdgeRec).seg.axis === (recsHere[1] as EdgeRec).seg.axis;
    setbacks.push(deg < 2 || straight ? 0 : Math.max(...recsHere.map(widthOf)) / 2 + CROSSWALK);
  }

  // 7. Signals: cycle by the highest incident class, greens split by axis weight.
  const sigRng = root.stream('world:signals');
  const { yellow, allRed, minGreen, cycle: cycles } = ROAD_CLASSES.signals;
  const signals: SignalDef[] = [];
  const signalOf = new Int32Array(nodeCount).fill(-1);
  for (let n = 0; n < nodeCount; n++) {
    if (junctions[n] !== JUNCTION.signal) continue;
    const here = (incident[n] as number[]).map((id) => live[id] as EdgeRec);
    const top = Math.min(...here.map((e) => e.seg.cls));
    let cycle = 0;
    for (let c = top; c <= ROAD_CLASS.local && cycle === 0; c++) cycle = cycles[c] ?? 0;
    if (cycle === 0) cycle = cycles[ROAD_CLASS.local] ?? 50;
    const weight = (axis: Axis): number =>
      Math.max(0, ...here.filter((e) => e.seg.axis === axis).map((e) => roadClassDef(e.seg.cls).signalWeight));
    const w0 = weight(0) || 1;
    const w1 = weight(1) || 1;
    const available = cycle - 2 * (yellow + allRed);
    const g0 = Math.round(Math.max(minGreen, Math.min(available - minGreen, (available * w0) / (w0 + w1))) * 10) / 10;
    const offset = Math.round(sigRng.nextFloat(0, cycle) * 100) / 100;
    signalOf[n] = signals.length;
    signals.push({ id: signals.length, node: n, cycle, offset, green: [g0, available - g0], yellow, allRed });
  }

  // 10. Blocks: rectangles between consecutive lines of each cell, inset by road + sidewalk.
  const blocks: { id: number; minX: number; minZ: number; maxX: number; maxZ: number; district: DistrictId; kind: BlockKindId; poi: number }[] = [];
  for (let row = 0; row < N; row++) {
    for (let col = 0; col < N; col++) {
      const cell = row * N + col;
      const d = cellDistrict(col, row) as DistrictId;
      const rng = cellRngs[cell] as Rng;
      const cl = cellLines[cell] as { x: CellLine[]; z: CellLine[] };
      const xs = [...cl.x].sort((a, b) => a.coord - b.coord);
      const zs = [...cl.z].sort((a, b) => a.coord - b.coord);
      for (let j = 0; j + 1 < zs.length; j++) {
        for (let i = 0; i + 1 < xs.length; i++) {
          const xa = xs[i] as CellLine, xb = xs[i + 1] as CellLine, za = zs[j] as CellLine, zb = zs[j + 1] as CellLine;
          const minX = xa.coord + xa.inset, maxX = xb.coord - xb.inset;
          const minZ = za.coord + za.inset, maxZ = zb.coord - zb.inset;
          if (maxX - minX < MIN_BLOCK || maxZ - minZ < MIN_BLOCK) continue;
          blocks.push({ id: blocks.length, minX, minZ, maxX, maxZ, district: d, kind: blockKind(d, col, row, za, zb, rng), poi: -1 });
        }
      }
    }
  }

  // 10. POIs (station, district landmarks, parks, schools, fuel).
  const poiRng = root.stream('world:pois');
  const words = root.stream('world:lines').shuffle([...STREET_NAMES.words]);
  let nameCursor = poiRng.nextInt(0, words.length - 1);
  const nextWord = (): string => words[nameCursor++ % words.length] ?? 'Central';
  const pois: Poi[] = [];
  const nearestRoad = (x: number, z: number): { x: number; z: number; edge: number } => {
    let best = Infinity;
    let hit = { x, z, edge: -1 };
    edgePoints.forEach((pts, id) => {
      const d = distanceToPolyline(pts, x, z);
      if (d < best) {
        best = d;
        const [px, pz, qx, qz] = pts as unknown as [number, number, number, number];
        const t = Math.max(0, Math.min(1, ((x - px) * (qx - px) + (z - pz) * (qz - pz)) / ((qx - px) ** 2 + (qz - pz) ** 2)));
        hit = { x: px + (qx - px) * t, z: pz + (qz - pz) * t, edge: id };
      }
    });
    return hit;
  };
  const addPoi = (kind: PoiKind, name: string, blockId: number, x: number, z: number, yaw: number, entranceFrom?: { x: number; z: number }): void => {
    const b = blocks[blockId];
    if (!b) return;
    b.poi = pois.length;
    const from = entranceFrom ?? { x, z };
    pois.push({ id: pois.length, kind, name, x, z, yaw, block: blockId, entrance: nearestRoad(from.x, from.z) });
  };
  const blockCentre = (id: number): [number, number] => {
    const b = blocks[id] as Block;
    return [(b.minX + b.maxX) / 2, (b.minZ + b.maxZ) / 2];
  };
  const freeLots = (pred: (b: Block) => boolean): number[] =>
    blocks.filter((b) => b.poi < 0 && (b.kind === BLOCK_KIND.lots || b.kind === BLOCK_KIND.yard) && pred(b)).map((b) => b.id);
  const nearestBlock = (ids: readonly number[], x: number, z: number): number => {
    let best = -1;
    let bestD = Infinity;
    for (const id of ids) {
      const b = blocks[id] as Block;
      const dist = rectDistanceSq(b.minX, b.minZ, b.maxX, b.maxZ, x, z) + 1e-6 * ((blockCentre(id)[0] - x) ** 2 + (blockCentre(id)[1] - z) ** 2);
      if (dist < bestD) {
        bestD = dist;
        best = id;
      }
    }
    return best;
  };

  // Station: the land block containing (or nearest) the landmark; the whole block is its lot.
  const st = LANDMARKS.station;
  const stationBlock = nearestBlock(freeLots(() => true), st.x, st.z);
  if (stationBlock < 0) throw new Error('generateCity: no block for the station');
  const station = stationLayout(blocks[stationBlock] as Block, st.yaw);
  (blocks[stationBlock] as { kind: BlockKindId }).kind = BLOCK_KIND.parking;
  const sb = station.building;
  addPoi('station', 'Police Station', stationBlock, (sb[0] + sb[2]) / 2, (sb[1] + sb[3]) / 2, station.door.yaw, station.lotFront);

  // One landmark per special district, at the block nearest the district's centroid.
  const landmark: [DistrictId, PoiKind, string][] = [
    [DISTRICT.hospital, 'hospital', 'General Hospital'],
    [DISTRICT.campus, 'campus', 'City College'],
    [DISTRICT.airport, 'airport', 'Regional Airport'],
    [DISTRICT.harbor, 'harbor', 'Harbor Office'],
  ];
  for (const [d, kind, name] of landmark) {
    let sx = 0, sz = 0, count = 0;
    for (let c = 0; c < N * N; c++) {
      if (DISTRICTS.cells[c] !== d) continue;
      sx += -H + ((c % N) + 0.5) * DISTRICT_CELL;
      sz += -H + (Math.floor(c / N) + 0.5) * DISTRICT_CELL;
      count++;
    }
    if (count === 0) continue;
    const id = nearestBlock(freeLots((b) => b.district === d), sx / count, sz / count);
    if (id >= 0) addPoi(kind, name, id, ...blockCentre(id), 0);
  }
  // Parks: one POI per park cell, on its largest park block.
  for (const b of blocks) {
    if (b.kind !== BLOCK_KIND.park || b.poi >= 0) continue;
    const cellBlocks = blocks.filter((o) => o.kind === BLOCK_KIND.park && sameCell(o, b));
    if (cellBlocks.some((o) => o.poi >= 0)) continue;
    const largest = cellBlocks.reduce((m, o) => (area(o) > area(m) ? o : m), b);
    addPoi('park', `${nextWord()} Park`, largest.id, ...blockCentre(largest.id), 0);
  }
  // Schools and fuel stations, drawn per cell in row-major order.
  for (let cell = 0; cell < N * N; cell++) {
    const d = DISTRICTS.cells[cell] as DistrictId;
    const inCell = (b: Block): boolean => cellIndexOf((b.minX + b.maxX) / 2) === cell % N && cellIndexOf((b.minZ + b.maxZ) / 2) === Math.floor(cell / N);
    if (d === DISTRICT.suburbs && poiRng.chance(ZONES.schoolZone.schoolsPerSuburbCell)) {
      const free = freeLots(inCell);
      if (free.length > 0) {
        const id = poiRng.pick(free);
        addPoi('school', `${nextWord()} Elementary School`, id, ...blockCentre(id), 0);
      }
    }
    const fuelChance =
      d === DISTRICT.highway
        ? LANDMARKS.fuelStationsPerHighwayCell
        : d === DISTRICT.downtown || d === DISTRICT.suburbs || d === DISTRICT.industrial
          ? LANDMARKS.fuelStationsPerUrbanCell
          : 0;
    if (fuelChance > 0 && poiRng.chance(fuelChance)) {
      const free = freeLots(inCell);
      if (free.length > 0) {
        const id = poiRng.pick(free);
        (blocks[id] as { kind: BlockKindId }).kind = BLOCK_KIND.parking;
        addPoi('fuel', 'Fuel Station', id, ...blockCentre(id), 0);
      }
    }
  }

  // 8. Zones: school zones by distance, construction by chance.
  const schools = pois.filter((p) => p.kind === 'school');
  const zoneRng = root.stream('world:zones');
  const { classes: constructionClasses, edgeFraction } = ZONES.construction;
  live.forEach((e, id) => {
    const pts = edgePoints[id] as Float32Array;
    if (schools.some((s) => distanceToPolyline(pts, s.x, s.z) <= ZONES.schoolZone.radius)) e.flags |= EDGE_FLAG.schoolZone;
    if (constructionClasses.includes(e.seg.cls) && zoneRng.chance(edgeFraction)) e.flags |= EDGE_FLAG.construction;
  });

  // 9. Build the graph.
  const nodes: RoadNode[] = points.map(([x, z], id) => ({
    id,
    x,
    z,
    junction: junctions[id] ?? JUNCTION.none,
    edges: incident[id] ?? [],
    signal: signalOf[id] ?? -1,
    setback: setbacks[id] ?? 0,
  }));
  const edges: RoadEdge[] = live.map((e, id) => {
    const c = roadClassDef(e.seg.cls);
    const pts = edgePoints[id] as Float32Array;
    const override = ROAD_CLASSES.districtSpeedMph[e.district]?.[e.seg.cls] ?? 0;
    return {
      id,
      from: e.from,
      to: e.to,
      roadClass: e.seg.cls,
      lanesForward: e.lanesF,
      lanesBackward: e.lanesB,
      laneWidth: c.laneWidth,
      median: c.median,
      shoulder: c.shoulder,
      sidewalk: e.seg.sidewalk,
      width: widthOf(e),
      speedLimitMph: override > 0 ? override : c.speedMph,
      flags: e.flags,
      surface: c.surface,
      length: Math.hypot((pts[2] ?? 0) - (pts[0] ?? 0), (pts[3] ?? 0) - (pts[1] ?? 0)),
      points: pts,
      name: streetName(lines[e.seg.line] as Line, e.seg.cls, words),
      district: e.district,
    };
  });
  const graph = new RoadGraph(nodes, edges, signals);
  return new CityModel(seed, graph, blocks, pois, station.door, station.slots, DISTRICTS.cells);
}

function area(b: Block): number {
  return (b.maxX - b.minX) * (b.maxZ - b.minZ);
}

function sameCell(a: Block, b: Block): boolean {
  return (
    cellIndexOf((a.minX + a.maxX) / 2) === cellIndexOf((b.minX + b.maxX) / 2) &&
    cellIndexOf((a.minZ + a.maxZ) / 2) === cellIndexOf((b.minZ + b.maxZ) / 2)
  );
}

/** Block kind from the district (§6 step 10); draws from the cell stream. */
function blockKind(d: DistrictId, col: number, row: number, za: CellLine, zb: CellLine, rng: Rng): BlockKindId {
  const r = rng.next();
  switch (d) {
    case DISTRICT.water:
      return BLOCK_KIND.water;
    case DISTRICT.park:
      return BLOCK_KIND.park;
    case DISTRICT.rural:
      return BLOCK_KIND.farm;
    case DISTRICT.harbor:
      return BLOCK_KIND.yard;
    case DISTRICT.airport: {
      // Runway strips run along the internal east-west boundaries of the airport.
      const north = za.boundary && cellDistrict(col, row - 1) === DISTRICT.airport;
      const south = zb.boundary && cellDistrict(col, row + 1) === DISTRICT.airport;
      return north || south ? BLOCK_KIND.runway : BLOCK_KIND.lots;
    }
    case DISTRICT.downtown:
      return r < 0.08 ? BLOCK_KIND.plaza : BLOCK_KIND.lots;
    case DISTRICT.suburbs:
      return r < 0.05 ? BLOCK_KIND.green : BLOCK_KIND.lots;
    case DISTRICT.industrial:
      return r < 0.1 ? BLOCK_KIND.parking : BLOCK_KIND.lots;
    case DISTRICT.highway:
      return r < 0.15 ? BLOCK_KIND.parking : BLOCK_KIND.lots;
    case DISTRICT.campus:
      return r < 0.25 ? BLOCK_KIND.green : BLOCK_KIND.lots;
    case DISTRICT.hospital:
      return r < 0.25 ? BLOCK_KIND.parking : BLOCK_KIND.lots;
    default:
      return BLOCK_KIND.lots;
  }
}
