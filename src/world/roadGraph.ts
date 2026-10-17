import { MPH } from './constants';
import { ZONES } from './data';
import { yawOf } from './geom';
import {
  ASPECT,
  EDGE_FLAG,
  JUNCTION,
  TURN,
  type AspectId,
  type DistrictId,
  type JunctionId,
  type RoadClassId,
  type SurfaceId,
  type TurnId,
} from './ids';
import { HASH_CELL, HASH_DIM, HASH_ORIGIN, SpatialHash, hashCoord } from './spatialHash';

export {
  ASPECT,
  ASPECT_NAMES,
  DISTRICT,
  DISTRICT_NAMES,
  EDGE_FLAG,
  EDGE_FLAG_NAMES,
  JUNCTION,
  JUNCTION_NAMES,
  ROAD_CLASS,
  ROAD_CLASS_NAMES,
  SURFACE,
  SURFACE_NAMES,
  TURN,
  TURN_NAMES,
} from './ids';
export type {
  AspectId,
  DistrictId,
  DistrictName,
  EdgeFlagId,
  JunctionId,
  RoadClassId,
  RoadClassName,
  SurfaceId,
  SurfaceName,
  TurnId,
} from './ids';

export interface RoadNode {
  readonly id: number;
  readonly x: number;
  readonly z: number;
  readonly junction: JunctionId;
  /** Incident edges, sorted CCW (from +X) by the heading leaving the node. */
  readonly edges: readonly number[];
  /** Index into graph.signals, -1 if none. */
  readonly signal: number;
  /** Metres from the node centre to the stop line / lane start. */
  readonly setback: number;
}

export interface RoadEdge {
  readonly id: number;
  readonly from: number;
  readonly to: number;
  readonly roadClass: RoadClassId;
  /** Lanes travelling from -> to (>= 1). */
  readonly lanesForward: number;
  /** Lanes travelling to -> from; 0 = one-way (from -> to is the travel direction). */
  readonly lanesBackward: number;
  readonly laneWidth: number;
  readonly median: number;
  readonly shoulder: number;
  readonly sidewalk: number;
  /** Kerb to kerb: (lanesF + lanesB) * laneWidth + median + 2 * shoulder. */
  readonly width: number;
  /** Class/district limit; zones are applied by effectiveSpeedLimitMph. */
  readonly speedLimitMph: number;
  /** EDGE_FLAG bits. */
  readonly flags: number;
  readonly surface: SurfaceId;
  /** Metres along the centreline polyline. */
  readonly length: number;
  /** Centreline x0, z0, x1, z1, ...; first = from node, last = to node. */
  readonly points: Float32Array;
  readonly name: string;
  /** District at the edge midpoint. */
  readonly district: DistrictId;
}

/** Phase order: G0 green, G0 yellow, all red, G1 green, G1 yellow, all red. */
export interface SignalDef {
  readonly id: number;
  readonly node: number;
  /** Seconds; local t = (simTime + offset) mod cycle. */
  readonly cycle: number;
  readonly offset: number;
  /** Green seconds for group 0 (x-axis approaches) and group 1 (z-axis). */
  readonly green: readonly [number, number];
  /** cycle = g0 + g1 + 2 * (yellow + allRed). */
  readonly yellow: number;
  readonly allRed: number;
}

/** edge * 16 + dir * 8 + index; dir 0 = from -> to, 1 = to -> from; index 0 = curb lane. */
export type LaneRef = number;

/** Packs a lane reference. */
export function laneRef(edge: number, dir: 0 | 1, index: number): LaneRef {
  return edge * 16 + dir * 8 + index;
}

/** Edge of a lane. */
export function laneEdge(lane: LaneRef): number {
  return lane >>> 4;
}

/** Travel direction of a lane: 0 = from -> to, 1 = to -> from. */
export function laneDir(lane: LaneRef): 0 | 1 {
  return ((lane >>> 3) & 1) as 0 | 1;
}

/** Lane index within its direction, 0 = curb lane. */
export function laneIndex(lane: LaneRef): number {
  return lane & 7;
}

export interface LanePoint {
  x: number;
  z: number;
  hx: number;
  hz: number;
  yaw: number;
}

export interface RoadHit {
  edge: number;
  /** Metres along the edge from its `from` node. */
  s: number;
  /** s / length. */
  t: number;
  x: number;
  z: number;
  distance: number;
  /** +1 when the query point is right of from -> to (or on the centreline), else -1. */
  side: -1 | 1;
}

export interface LaneConnection {
  readonly edge: number;
  readonly dir: 0 | 1;
  readonly turn: TurnId;
}

/** Environment's GameTime satisfies it. */
export interface ZoneTime {
  readonly hour: number;
  readonly isWeekday: boolean;
}

export interface RouteOptions {
  readonly cost?: 'time' | 'distance';
  readonly ignoreOneWay?: boolean;
  readonly avoidEdges?: ReadonlySet<number>;
}

export interface Route {
  readonly nodes: readonly number[];
  readonly edges: readonly number[];
  readonly length: number;
  /** Travel time in seconds: length / limit plus junction penalties. */
  readonly time: number;
}

export interface PointRoute extends Route {
  readonly start: RoadHit;
  readonly end: RoadHit;
  /** x, z pairs along the centrelines from start (x, z) to end (x, z). */
  readonly polyline: Float32Array;
}

/** Route time penalty for passing a signalised junction (s). */
export const SIGNAL_PENALTY_S = 8;
/** Route time penalty for passing a stop-controlled junction (s). */
export const STOP_PENALTY_S = 4;

/** Search radius used by routeBetweenPoints to snap points onto roads (m). */
const SNAP_DISTANCE = 2000;

function newHit(): RoadHit {
  return { edge: -1, s: 0, t: 0, x: 0, z: 0, distance: 0, side: 1 };
}

function copyHit(src: RoadHit, dst: RoadHit): void {
  dst.edge = src.edge;
  dst.s = src.s;
  dst.t = src.t;
  dst.x = src.x;
  dst.z = src.z;
  dst.distance = src.distance;
  dst.side = src.side;
}

function ascending(a: number, b: number): number {
  return a - b;
}

function posMod(a: number, m: number): number {
  const r = a % m;
  return r < 0 ? r + m : r;
}

/**
 * Directed road network with lane geometry, signal timing, zone limits,
 * spatial queries and A* routing. Node and edge ids equal their array index.
 */
export class RoadGraph {
  readonly nodes: readonly RoadNode[];
  readonly edges: readonly RoadEdge[];
  readonly signals: readonly SignalDef[];
  /** Fastest route speed in m/s (the A* time heuristic divides by it). */
  readonly maxSpeed: number;

  private readonly edgeHash: SpatialHash;
  private readonly nodeHash: SpatialHash;
  private readonly conns: readonly (readonly LaneConnection[])[];
  /** Construction-adjusted speed limit per edge, m/s. */
  private readonly routeSpeed: Float64Array;
  private readonly edgeStamp: Uint32Array;
  private readonly nodeStamp: Uint32Array;
  private stamp = 0;
  private readonly scratchHit = newHit();
  private readonly heading = { x: 0, z: 0 };

  // A* scratch, sized once.
  private readonly g: Float64Array;
  private readonly tail: Float64Array;
  private readonly prevEdge: Int32Array;
  private readonly seen: Uint32Array;
  private readonly closed: Uint32Array;
  private readonly isTarget: Uint32Array;
  private searchStamp = 0;
  private readonly heapNode: Int32Array;
  private readonly heapKey: Float64Array;
  private heapSize = 0;

  constructor(nodes: RoadNode[], edges: RoadEdge[], signals: SignalDef[]) {
    this.nodes = nodes;
    this.edges = edges;
    this.signals = signals;

    const edgeBoxes = new Float64Array(edges.length * 4);
    edges.forEach((e, i) => {
      const pad = e.width / 2 + e.sidewalk;
      let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
      for (let k = 0; k + 1 < e.points.length; k += 2) {
        const x = e.points[k] ?? 0;
        const z = e.points[k + 1] ?? 0;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      edgeBoxes.set([minX - pad, minZ - pad, maxX + pad, maxZ + pad], i * 4);
    });
    this.edgeHash = new SpatialHash(edgeBoxes);
    const nodeBoxes = new Float64Array(nodes.length * 4);
    nodes.forEach((n, i) => nodeBoxes.set([n.x, n.z, n.x, n.z], i * 4));
    this.nodeHash = new SpatialHash(nodeBoxes);
    this.edgeStamp = new Uint32Array(edges.length);
    this.nodeStamp = new Uint32Array(nodes.length);

    const { limitReductionMph, minLimitMph } = ZONES.construction;
    this.routeSpeed = new Float64Array(edges.length);
    let maxSpeed = 1;
    edges.forEach((e, i) => {
      let mph = e.speedLimitMph;
      if (e.flags & EDGE_FLAG.construction) mph = Math.max(Math.min(mph, minLimitMph), mph - limitReductionMph);
      this.routeSpeed[i] = Math.max(1, mph * MPH);
      maxSpeed = Math.max(maxSpeed, mph * MPH);
    });
    this.maxSpeed = maxSpeed;

    const conns: LaneConnection[][] = [];
    for (let e = 0; e < edges.length; e++) {
      conns.push(this.buildConnections(e, 0), this.buildConnections(e, 1));
    }
    this.conns = conns;

    const n = nodes.length;
    this.g = new Float64Array(n);
    this.tail = new Float64Array(n);
    this.prevEdge = new Int32Array(n);
    this.seen = new Uint32Array(n);
    this.closed = new Uint32Array(n);
    this.isTarget = new Uint32Array(n);
    this.heapNode = new Int32Array(edges.length * 2 + n + 4);
    this.heapKey = new Float64Array(edges.length * 2 + n + 4);
  }

  // --- Spatial queries --------------------------------------------------------------

  /** Closest edge centreline within `maxDistance` (ties: lowest edge id); allocation-free. */
  nearestEdge(x: number, z: number, maxDistance: number, out: RoadHit): RoadHit | null {
    const stamp = this.nextStamp();
    const cx = hashCoord(x);
    const cz = hashCoord(z);
    const { start, items } = this.edgeHash;
    const scratch = this.scratchHit;
    let best = maxDistance;
    let found = false;
    for (let k = 0; k < HASH_DIM; k++) {
      const z0 = cz - k, z1 = cz + k, x0 = cx - k, x1 = cx + k;
      for (let gz = z0; gz <= z1; gz++) {
        if (gz < 0 || gz >= HASH_DIM) continue;
        const edgeRow = gz === z0 || gz === z1;
        for (let gx = x0; gx <= x1; gx += edgeRow ? 1 : x1 - x0 || 1) {
          if (gx < 0 || gx >= HASH_DIM) continue;
          const cell = gz * HASH_DIM + gx;
          for (let i = start[cell] ?? 0, end = start[cell + 1] ?? 0; i < end; i++) {
            const e = items[i] ?? 0;
            if (this.edgeStamp[e] === stamp) continue;
            this.edgeStamp[e] = stamp;
            this.project(e, x, z, scratch);
            if (scratch.distance < best || (scratch.distance === best && found && e < out.edge)) {
              best = scratch.distance;
              copyHit(scratch, out);
              found = true;
            }
          }
        }
      }
      if (x0 <= 0 && z0 <= 0 && x1 >= HASH_DIM - 1 && z1 >= HASH_DIM - 1) break;
      // Anything not yet visited lies outside the ring square, at least `bound` away.
      const minX = HASH_ORIGIN + x0 * HASH_CELL, maxX = HASH_ORIGIN + (x1 + 1) * HASH_CELL;
      const minZ = HASH_ORIGIN + z0 * HASH_CELL, maxZ = HASH_ORIGIN + (z1 + 1) * HASH_CELL;
      const bound = Math.max(0, Math.min(x - minX, maxX - x, z - minZ, maxZ - z));
      if (bound > best) break;
    }
    return found ? out : null;
  }

  /** Clears `out` and fills it with the edges whose centreline is within `radius`, ascending. */
  edgesNear(x: number, z: number, radius: number, out: number[]): number[] {
    out.length = 0;
    const stamp = this.nextStamp();
    const { start, items } = this.edgeHash;
    const x0 = hashCoord(x - radius), x1 = hashCoord(x + radius);
    const z0 = hashCoord(z - radius), z1 = hashCoord(z + radius);
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const cell = gz * HASH_DIM + gx;
        for (let i = start[cell] ?? 0, end = start[cell + 1] ?? 0; i < end; i++) {
          const e = items[i] ?? 0;
          if (this.edgeStamp[e] === stamp) continue;
          this.edgeStamp[e] = stamp;
          if (this.project(e, x, z, this.scratchHit).distance <= radius) out.push(e);
        }
      }
    }
    return out.sort(ascending);
  }

  /** Clears `out` and fills it with the nodes within `radius`, ascending. */
  nodesNear(x: number, z: number, radius: number, out: number[]): number[] {
    out.length = 0;
    const stamp = this.nextStamp();
    const { start, items } = this.nodeHash;
    const x0 = hashCoord(x - radius), x1 = hashCoord(x + radius);
    const z0 = hashCoord(z - radius), z1 = hashCoord(z + radius);
    const r2 = radius * radius;
    for (let gz = z0; gz <= z1; gz++) {
      for (let gx = x0; gx <= x1; gx++) {
        const cell = gz * HASH_DIM + gx;
        for (let i = start[cell] ?? 0, end = start[cell + 1] ?? 0; i < end; i++) {
          const id = items[i] ?? 0;
          if (this.nodeStamp[id] === stamp) continue;
          this.nodeStamp[id] = stamp;
          const node = this.nodes[id] as RoadNode;
          const dx = node.x - x, dz = node.z - z;
          if (dx * dx + dz * dz <= r2) out.push(id);
        }
      }
    }
    return out.sort(ascending);
  }

  // --- Lanes ---------------------------------------------------------------------------

  laneCount(edge: number, dir: 0 | 1): number {
    const e = this.edges[edge] as RoadEdge;
    return dir === 0 ? e.lanesForward : e.lanesBackward;
  }

  /** Signed offset of the lane centre from the centreline, + = right of from -> to. */
  laneOffset(lane: LaneRef): number {
    const e = this.edges[laneEdge(lane)] as RoadEdge;
    const i = laneIndex(lane);
    const w = e.laneWidth;
    if (e.lanesBackward === 0) return ((e.lanesForward - 1) / 2 - i) * w;
    if (laneDir(lane) === 0) return e.median / 2 + (e.lanesForward - i - 0.5) * w;
    return -(e.median / 2 + (e.lanesBackward - i - 0.5) * w);
  }

  laneLength(lane: LaneRef): number {
    return (this.edges[laneEdge(lane)] as RoadEdge).length;
  }

  laneStartNode(lane: LaneRef): number {
    const e = this.edges[laneEdge(lane)] as RoadEdge;
    return laneDir(lane) === 0 ? e.from : e.to;
  }

  laneEndNode(lane: LaneRef): number {
    const e = this.edges[laneEdge(lane)] as RoadEdge;
    return laneDir(lane) === 0 ? e.to : e.from;
  }

  /** First usable s (the start node's setback). */
  laneStart(lane: LaneRef): number {
    return (this.nodes[this.laneStartNode(lane)] as RoadNode).setback;
  }

  /** Last usable s (length minus the end node's setback): the stop line. */
  laneEnd(lane: LaneRef): number {
    return this.laneLength(lane) - (this.nodes[this.laneEndNode(lane)] as RoadNode).setback;
  }

  /** Lane-centre position and travel heading at `s` metres from the lane's start node. */
  lanePoint(lane: LaneRef, s: number, out: LanePoint): LanePoint {
    const e = this.edges[laneEdge(lane)] as RoadEdge;
    const dir = laneDir(lane);
    const along = dir === 0 ? s : e.length - s;
    this.pointAlong(e, along, out);
    const ux = out.hx, uz = out.hz;
    const off = this.laneOffset(lane);
    // Right of the from -> to heading (ux, uz) is (-uz, ux).
    out.x += -uz * off;
    out.z += ux * off;
    if (dir === 1) {
      out.hx = -ux;
      out.hz = -uz;
    }
    out.yaw = yawOf(out.hx, out.hz);
    return out;
  }

  /** Exits at the lane direction's end node; a U-turn only where nothing else leaves. */
  connections(edge: number, dir: 0 | 1): readonly LaneConnection[] {
    return this.conns[edge * 2 + dir] ?? [];
  }

  /** 0 when the arriving travel heading runs along x, 1 along z. */
  approachGroup(edge: number, dir: 0 | 1): 0 | 1 {
    this.arrivalHeading(this.edges[edge] as RoadEdge, dir, this.heading);
    return Math.abs(this.heading.x) >= Math.abs(this.heading.z) ? 0 : 1;
  }

  // --- Signals and zones --------------------------------------------------------------

  signalAspect(signal: number, group: 0 | 1, simTime: number): AspectId {
    const sig = this.signals[signal] as SignalDef;
    const t = posMod(simTime + sig.offset, sig.cycle);
    const g0 = sig.green[0], y = sig.yellow;
    if (group === 0) return t < g0 ? ASPECT.green : t < g0 + y ? ASPECT.yellow : ASPECT.red;
    const s1 = g0 + y + sig.allRed;
    if (t < s1) return ASPECT.red;
    const g1 = sig.green[1];
    return t < s1 + g1 ? ASPECT.green : t < s1 + g1 + y ? ASPECT.yellow : ASPECT.red;
  }

  /** Seconds until the group's aspect next changes. */
  signalTimeToChange(signal: number, group: 0 | 1, simTime: number): number {
    const sig = this.signals[signal] as SignalDef;
    const t = posMod(simTime + sig.offset, sig.cycle);
    const g0 = sig.green[0], y = sig.yellow;
    if (group === 0) return t < g0 ? g0 - t : t < g0 + y ? g0 + y - t : sig.cycle - t;
    const s1 = g0 + y + sig.allRed;
    const g1 = sig.green[1];
    if (t < s1) return s1 - t;
    if (t < s1 + g1) return s1 + g1 - t;
    if (t < s1 + g1 + y) return s1 + g1 + y - t;
    return sig.cycle - t + s1;
  }

  isSchoolZoneActive(edge: number, time: ZoneTime): boolean {
    const e = this.edges[edge] as RoadEdge;
    if ((e.flags & EDGE_FLAG.schoolZone) === 0) return false;
    const zone = ZONES.schoolZone;
    if (zone.weekdaysOnly && !time.isWeekday) return false;
    for (let i = 0; i < zone.windows.length; i++) {
      const w = zone.windows[i] as readonly [number, number];
      if (time.hour >= w[0] && time.hour < w[1]) return true;
    }
    return false;
  }

  /** Posted limit with the construction reduction and an active school zone applied. */
  effectiveSpeedLimitMph(edge: number, time: ZoneTime): number {
    const e = this.edges[edge] as RoadEdge;
    let mph = e.speedLimitMph;
    if (e.flags & EDGE_FLAG.construction) {
      const c = ZONES.construction;
      mph = Math.max(Math.min(mph, c.minLimitMph), mph - c.limitReductionMph);
    }
    if (this.isSchoolZoneActive(edge, time)) mph = Math.min(mph, ZONES.schoolZone.limitMph);
    return mph;
  }

  // --- Routing --------------------------------------------------------------------------

  /** A* between two nodes; null when unreachable. */
  findRoute(fromNode: number, toNode: number, options: RouteOptions = {}): Route | null {
    if (!this.nodes[fromNode] || !this.nodes[toNode]) return null;
    const target = this.nodes[toNode];
    this.beginSearch();
    this.addSource(fromNode, 0);
    this.addTarget(toNode, 0);
    const best = this.search(options, fromNode, target.x, target.z);
    if (best < 0) return null;
    const nodes: number[] = [];
    const edges: number[] = [];
    this.unwind(best, nodes, edges);
    let length = 0;
    let time = 0;
    for (const e of edges) {
      length += (this.edges[e] as RoadEdge).length;
      time += this.edgeTime(e, (this.edges[e] as RoadEdge).length);
    }
    for (let i = 1; i < nodes.length - 1; i++) time += this.penalty(nodes[i] ?? 0);
    return { nodes, edges, length, time };
  }

  /** Snaps both points onto the nearest roads and routes between them (multi-source A*). */
  routeBetweenPoints(ax: number, az: number, bx: number, bz: number, options: RouteOptions = {}): PointRoute | null {
    const start = this.nearestEdge(ax, az, SNAP_DISTANCE, newHit());
    const end = this.nearestEdge(bx, bz, SNAP_DISTANCE, newHit());
    if (!start || !end) return null;
    const ea = this.edges[start.edge] as RoadEdge;
    const eb = this.edges[end.edge] as RoadEdge;
    const time = options.cost !== 'distance';
    const wrongWayOk = options.ignoreOneWay === true;
    const avoid = options.avoidEdges;
    const cost = (e: number, len: number): number => (time ? this.edgeTime(e, len) : len);

    // Direct travel along a shared edge.
    let directCost = Infinity;
    if (ea.id === eb.id && !avoid?.has(ea.id)) {
      if (end.s >= start.s || ea.lanesBackward > 0 || wrongWayOk) directCost = cost(ea.id, Math.abs(end.s - start.s));
    }

    this.beginSearch();
    if (!avoid?.has(ea.id)) {
      this.addSource(ea.to, cost(ea.id, ea.length - start.s));
      if (ea.lanesBackward > 0 || wrongWayOk) this.addSource(ea.from, cost(ea.id, start.s));
    }
    if (!avoid?.has(eb.id)) {
      const pen = (n: number): number => (time ? this.penalty(n) : 0);
      this.addTarget(eb.from, cost(eb.id, end.s) + pen(eb.from));
      if (eb.lanesBackward > 0 || wrongWayOk) this.addTarget(eb.to, cost(eb.id, eb.length - end.s) + pen(eb.to));
    }
    const bestNode = this.search(options, -1, end.x, end.z);
    const graphCost = bestNode >= 0 ? (this.g[bestNode] ?? 0) + (this.tail[bestNode] ?? 0) : Infinity;
    if (directCost === Infinity && graphCost === Infinity) return null;

    const nodes: number[] = [];
    const edges: number[] = [];
    const pts: number[] = [start.x, start.z];
    let length: number;
    let travel: number;
    if (directCost <= graphCost) {
      edges.push(ea.id);
      this.appendAlong(ea, start.s, end.s, pts);
      length = Math.abs(end.s - start.s);
      travel = this.edgeTime(ea.id, length);
    } else {
      this.unwind(bestNode, nodes, edges);
      const first = nodes[0] ?? 0;
      const sFirst = first === ea.to ? ea.length : 0;
      length = Math.abs(sFirst - start.s);
      travel = this.edgeTime(ea.id, length);
      this.appendAlong(ea, start.s, sFirst, pts);
      for (let i = 0; i < edges.length; i++) {
        const e = this.edges[edges[i] ?? 0] as RoadEdge;
        const forward = e.from === nodes[i];
        this.appendAlong(e, forward ? 0 : e.length, forward ? e.length : 0, pts);
        length += e.length;
        travel += this.edgeTime(e.id, e.length);
      }
      const last = nodes[nodes.length - 1] ?? 0;
      const sLast = last === eb.from ? 0 : eb.length;
      this.appendAlong(eb, sLast, end.s, pts);
      length += Math.abs(end.s - sLast);
      travel += this.edgeTime(eb.id, Math.abs(end.s - sLast));
      for (const n of nodes) travel += this.penalty(n);
      edges.unshift(ea.id);
      edges.push(eb.id);
    }
    return { nodes, edges, length, time: travel, start, end, polyline: new Float32Array(pts) };
  }

  // --- Internals -------------------------------------------------------------------------

  private nextStamp(): number {
    this.stamp = (this.stamp + 1) >>> 0;
    if (this.stamp === 0) {
      this.edgeStamp.fill(0);
      this.nodeStamp.fill(0);
      this.stamp = 1;
    }
    return this.stamp;
  }

  /** Projects (x, z) onto edge `id`; fills every RoadHit field. */
  private project(id: number, x: number, z: number, out: RoadHit): RoadHit {
    const e = this.edges[id] as RoadEdge;
    const p = e.points;
    let best = Infinity;
    let acc = 0;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const ax = p[i] ?? 0, az = p[i + 1] ?? 0;
      const dx = (p[i + 2] ?? 0) - ax, dz = (p[i + 3] ?? 0) - az;
      const len2 = dx * dx + dz * dz;
      const len = Math.sqrt(len2);
      let t = len2 > 0 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const px = ax + dx * t, pz = az + dz * t;
      const d2 = (x - px) * (x - px) + (z - pz) * (z - pz);
      if (d2 < best) {
        best = d2;
        out.s = acc + t * len;
        out.x = px;
        out.z = pz;
        out.side = (x - px) * -dz + (z - pz) * dx >= 0 ? 1 : -1;
      }
      acc += len;
    }
    out.edge = id;
    out.distance = Math.sqrt(best);
    out.t = e.length > 0 ? out.s / e.length : 0;
    return out;
  }

  /** Centreline point at `along` metres from `from`; hx/hz = from -> to unit direction there. */
  private pointAlong(e: RoadEdge, along: number, out: LanePoint): void {
    const p = e.points;
    let rest = along < 0 ? 0 : along;
    const last = p.length - 4;
    for (let i = 0; i <= last; i += 2) {
      const ax = p[i] ?? 0, az = p[i + 1] ?? 0;
      const dx = (p[i + 2] ?? 0) - ax, dz = (p[i + 3] ?? 0) - az;
      const len = Math.sqrt(dx * dx + dz * dz);
      if (rest <= len || i === last) {
        const inv = len > 0 ? 1 / len : 0;
        const t = Math.min(rest, len);
        out.hx = dx * inv;
        out.hz = dz * inv;
        out.x = ax + out.hx * t;
        out.z = az + out.hz * t;
        return;
      }
      rest -= len;
    }
  }

  /** Unit heading leaving node `atFrom ? from : to` along edge `e`. */
  private leavingHeading(e: RoadEdge, atFrom: boolean, out: { x: number; z: number }): void {
    const p = e.points;
    const n = p.length;
    const [i0, i1] = atFrom ? [0, 2] : [n - 2, n - 4];
    const dx = (p[i1] ?? 0) - (p[i0] ?? 0);
    const dz = (p[i1 + 1] ?? 0) - (p[i0 + 1] ?? 0);
    const len = Math.hypot(dx, dz) || 1;
    out.x = dx / len;
    out.z = dz / len;
  }

  /** Travel heading arriving at the end node of direction `dir`. */
  private arrivalHeading(e: RoadEdge, dir: 0 | 1, out: { x: number; z: number }): void {
    // Arriving at `to` is the reverse of leaving `to`.
    this.leavingHeading(e, dir === 1, out);
    out.x = -out.x;
    out.z = -out.z;
  }

  private buildConnections(edge: number, dir: 0 | 1): LaneConnection[] {
    const e = this.edges[edge] as RoadEdge;
    if ((dir === 0 ? e.lanesForward : e.lanesBackward) === 0) return [];
    const nodeId = dir === 0 ? e.to : e.from;
    const node = this.nodes[nodeId] as RoadNode;
    const inH = { x: 0, z: 0 };
    const outH = { x: 0, z: 0 };
    this.arrivalHeading(e, dir, inH);
    const out: LaneConnection[] = [];
    for (const id of node.edges) {
      if (id === edge) continue;
      const next = this.edges[id] as RoadEdge;
      const nextDir: 0 | 1 = next.from === nodeId ? 0 : 1;
      if (nextDir === 1 && next.lanesBackward === 0) continue;
      this.leavingHeading(next, nextDir === 0, outH);
      const dot = inH.x * outH.x + inH.z * outH.z;
      const right = -inH.z * outH.x + inH.x * outH.z;
      const turn = dot > 0.7 ? TURN.straight : dot < -0.7 ? TURN.uturn : right > 0 ? TURN.right : TURN.left;
      out.push({ edge: id, dir: nextDir, turn });
    }
    const reverse: 0 | 1 = dir === 0 ? 1 : 0;
    if (out.length === 0 && (reverse === 0 ? e.lanesForward : e.lanesBackward) > 0) {
      out.push({ edge, dir: reverse, turn: TURN.uturn });
    }
    return out;
  }

  private edgeTime(edge: number, length: number): number {
    return length / (this.routeSpeed[edge] ?? 1);
  }

  private penalty(node: number): number {
    const j = (this.nodes[node] as RoadNode).junction;
    return j === JUNCTION.signal ? SIGNAL_PENALTY_S : j === JUNCTION.none ? 0 : STOP_PENALTY_S;
  }

  private beginSearch(): void {
    this.searchStamp = (this.searchStamp + 1) >>> 0;
    if (this.searchStamp === 0) {
      this.seen.fill(0);
      this.closed.fill(0);
      this.isTarget.fill(0);
      this.searchStamp = 1;
    }
    this.heapSize = 0;
  }

  /** Seeds the search at `node` with cost `cost`; unwinding stops at sources. */
  private addSource(node: number, cost: number): void {
    if (this.seen[node] === this.searchStamp && (this.g[node] ?? 0) <= cost) return;
    this.seen[node] = this.searchStamp;
    this.g[node] = cost;
    this.prevEdge[node] = -1;
    this.push(node, cost);
  }

  private addTarget(node: number, tailCost: number): void {
    if (this.isTarget[node] === this.searchStamp && (this.tail[node] ?? 0) <= tailCost) return;
    this.isTarget[node] = this.searchStamp;
    this.tail[node] = tailCost;
  }

  /**
   * Runs A* from the seeded sources to the cheapest target (g + tail).
   * `originNode` (or -1) is exempt from the junction penalty.
   * Returns the best target node or -1.
   */
  private search(options: RouteOptions, originNode: number, hx: number, hz: number): number {
    const time = options.cost !== 'distance';
    const wrongWayOk = options.ignoreOneWay === true;
    const avoid = options.avoidEdges;
    const hScale = time ? 1 / this.maxSpeed : 1;
    const stamp = this.searchStamp;
    let best = Infinity;
    let bestNode = -1;
    while (this.heapSize > 0) {
      const f = this.heapKey[0] ?? 0;
      const u = this.pop();
      if (f >= best) break;
      if (this.closed[u] === stamp) continue;
      this.closed[u] = stamp;
      const gu = this.g[u] ?? 0;
      if (this.isTarget[u] === stamp && gu + (this.tail[u] ?? 0) < best) {
        best = gu + (this.tail[u] ?? 0);
        bestNode = u;
      }
      const node = this.nodes[u] as RoadNode;
      const leave = time && u !== originNode ? this.penalty(u) : 0;
      for (let i = 0; i < node.edges.length; i++) {
        const id = node.edges[i] ?? 0;
        if (avoid?.has(id)) continue;
        const e = this.edges[id] as RoadEdge;
        let v: number;
        if (e.from === u) v = e.to;
        else if (e.lanesBackward > 0 || wrongWayOk) v = e.from;
        else continue;
        if (this.closed[v] === stamp) continue;
        const ng = gu + leave + (time ? this.edgeTime(id, e.length) : e.length);
        if (this.seen[v] !== stamp || ng < (this.g[v] ?? 0)) {
          this.seen[v] = stamp;
          this.g[v] = ng;
          this.prevEdge[v] = id;
          const target = this.nodes[v] as RoadNode;
          this.push(v, ng + Math.hypot(target.x - hx, target.z - hz) * hScale);
        }
      }
    }
    return bestNode;
  }

  /** Walks prevEdge back from `node`; fills nodes (start..node) and edges in travel order. */
  private unwind(node: number, nodes: number[], edges: number[]): void {
    let n = node;
    nodes.push(n);
    for (let e = this.prevEdge[n] ?? -1; e >= 0; e = this.prevEdge[n] ?? -1) {
      edges.push(e);
      const edge = this.edges[e] as RoadEdge;
      n = edge.from === n ? edge.to : edge.from;
      nodes.push(n);
    }
    nodes.reverse();
    edges.reverse();
  }

  /** Appends polyline vertices strictly between sFrom and sTo, then the point at sTo. */
  private appendAlong(e: RoadEdge, sFrom: number, sTo: number, out: number[]): void {
    const p = e.points;
    const forward = sTo >= sFrom;
    const count = p.length / 2;
    let acc = 0;
    const vertexS: number[] = [0];
    for (let i = 1; i < count; i++) {
      acc += Math.hypot((p[i * 2] ?? 0) - (p[i * 2 - 2] ?? 0), (p[i * 2 + 1] ?? 0) - (p[i * 2 - 1] ?? 0));
      vertexS.push(acc);
    }
    for (let k = 0; k < count; k++) {
      const i = forward ? k : count - 1 - k;
      const s = vertexS[i] ?? 0;
      if (forward ? s > sFrom && s < sTo : s < sFrom && s > sTo) out.push(p[i * 2] ?? 0, p[i * 2 + 1] ?? 0);
    }
    const pt: LanePoint = { x: 0, z: 0, hx: 0, hz: 0, yaw: 0 };
    this.pointAlong(e, sTo, pt);
    out.push(pt.x, pt.z);
  }

  private push(node: number, key: number): void {
    let i = this.heapSize++;
    const hn = this.heapNode, hk = this.heapKey;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((hk[parent] ?? 0) <= key) break;
      hn[i] = hn[parent] ?? 0;
      hk[i] = hk[parent] ?? 0;
      i = parent;
    }
    hn[i] = node;
    hk[i] = key;
  }

  private pop(): number {
    const hn = this.heapNode, hk = this.heapKey;
    const top = hn[0] ?? 0;
    const n = --this.heapSize;
    const node = hn[n] ?? 0;
    const key = hk[n] ?? 0;
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && (hk[c + 1] ?? 0) < (hk[c] ?? 0)) c++;
      if ((hk[c] ?? 0) >= key) break;
      hn[i] = hn[c] ?? 0;
      hk[i] = hk[c] ?? 0;
      i = c;
    }
    hn[i] = node;
    hk[i] = key;
    return top;
  }
}
