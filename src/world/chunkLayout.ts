import { createRng, type Rng } from '../core/rng';
import { BLOCK_KIND, blockSurface, cellIndexOf, type Block, type City } from './city';
import { CELLS_PER_SIDE, CHUNK_SIZE, MAX_CHUNK, MIN_CHUNK, WORLD_EDGE_MARGIN, WORLD_HALF_SIZE, WORLD_WALL } from './constants';
import { DISTRICTS, LANDMARKS, districtType, type DistrictTypeDef } from './data';
import { yawOf } from './geom';
import { DISTRICT, EDGE_FLAG, JUNCTION, ROAD_CLASS } from './ids';
import { constructionLimitMph, type RoadEdge, type RoadGraph, type RoadNode } from './roadGraph';
import { stationLayout } from './stationLayout';

/** minX, minZ, maxX, maxZ, height, roof (ROOF id), color (0xRRGGBB as float), style (district id). */
export const BUILDING_STRIDE = 8;
/** kind (PROP id), x, z, yaw, scale. */
export const PROP_STRIDE = 5;
/** kind (SIGN id), x, z, yaw, value (mph for speedLimit, else 0). */
export const SIGN_STRIDE = 5;
/** signal id, group (0|1), x, z, yaw (faces the approaching traffic). */
export const HEAD_STRIDE = 5;
/** minX, minZ, maxX, maxZ, surface (SURFACE id), block kind (BLOCK_KIND id). */
export const GROUND_STRIDE = 6;
/** centre x, y, z, half x, y, z, yaw. */
export const COLLIDER_STRIDE = 7;

export const ROOF = { flat: 0, pitched: 1 } as const;
export type RoofId = (typeof ROOF)[keyof typeof ROOF];
export const PROP = {
  streetlight: 0, tree: 1, bush: 2, hydrant: 3, bench: 4, cone: 5, barrier: 6, container: 7,
  fuelPump: 8, bollard: 9, lotLight: 10,
} as const;
export type PropId = (typeof PROP)[keyof typeof PROP];
export const SIGN = { stop: 0, yield: 1, speedLimit: 2, schoolZone: 3, oneWay: 4, construction: 5, noEntry: 6 } as const;
export type SignId = (typeof SIGN)[keyof typeof SIGN];

export interface ChunkLayout {
  readonly cx: number;
  readonly cz: number;
  readonly buildings: Float32Array;
  readonly props: Float32Array;
  readonly signs: Float32Array;
  readonly signalHeads: Float32Array;
  /** Block ground clipped to the chunk. */
  readonly ground: Float32Array;
  /** Edges / nodes touching the chunk, ascending. */
  readonly edges: Uint32Array;
  readonly nodes: Uint32Array;
  /** Buildings, poles, trunks, containers, pumps, quay walls (centre inside chunk). */
  readonly colliders: Float32Array;
  /** Walls to draw (COLLIDER_STRIDE): quay walls (also in `colliders`) and the world boundary (physics has its own). */
  readonly walls: Float32Array;
}

/** A chunk's rectangle; chunks on the world edge reach `WORLD_EDGE_MARGIN` past it on that side. */
export interface ChunkBounds {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

export function chunkBounds(cx: number, cz: number): ChunkBounds {
  const minX = cx * CHUNK_SIZE, minZ = cz * CHUNK_SIZE;
  return {
    minX: cx <= MIN_CHUNK ? minX - WORLD_EDGE_MARGIN : minX,
    minZ: cz <= MIN_CHUNK ? minZ - WORLD_EDGE_MARGIN : minZ,
    maxX: cx >= MAX_CHUNK ? minX + CHUNK_SIZE + WORLD_EDGE_MARGIN : minX + CHUNK_SIZE,
    maxZ: cz >= MAX_CHUNK ? minZ + CHUNK_SIZE + WORLD_EDGE_MARGIN : minZ + CHUNK_SIZE,
  };
}

/** Container length / width / height of one stacked unit (m). */
export const CONTAINER_SIZE = [12.2, 2.44, 2.6] as const;
/** Height of a streetlight pole (m). */
export const STREETLIGHT_HEIGHT = 8;
/** Height of a signal pole (m). */
export const SIGNAL_POLE_HEIGHT = 6;
/** Sign post height (the mesher's face sits on top of it); the post gets a collider. */
const SIGN_POST_HEIGHT = 2.2;
const LOT_LIGHT_HEIGHT = 10;
const TREE_TRUNK_HEIGHT = 4;
const QUAY_WALL_HEIGHT = 1.2;
const QUAY_WALL_HALF = 0.25;
/** Search radius from the chunk centre that covers everything an edge or node can place in it (m). */
const NEAR_RADIUS = CHUNK_SIZE * Math.SQRT1_2 + 48;

/** Accumulates one block's or edge's output. */
interface Sink {
  buildings: number[];
  props: number[];
}

// --- Block contents (buildings and props from the block's own stream) -------------

function pushBuilding(out: Sink, minX: number, minZ: number, maxX: number, maxZ: number, h: number, roof: number, color: number, style: number): void {
  out.buildings.push(minX, minZ, maxX, maxZ, h, roof, color, style);
}

function pushProp(out: Sink, kind: number, x: number, z: number, yaw: number, scale = 1): void {
  out.props.push(kind, x, z, yaw, scale);
}

function buildingHeight(t: DistrictTypeDef, rng: Rng, x: number, z: number): number {
  const [h0, h1] = t.buildings.height;
  const r = rng.next();
  let h = h0 + (h1 - h0) * r * r;
  if (t.buildings.centerBoost > 1) h *= 1 + (t.buildings.centerBoost - 1) * Math.max(0, 1 - Math.hypot(x, z) / 1200);
  return Math.round(h * 10) / 10;
}

function roofFor(t: DistrictTypeDef, rng: Rng, h: number): number {
  const pitched = t.buildings.roof === 'pitched' || (t.buildings.roof === 'mixed' && rng.chance(0.6));
  return pitched && h <= 15 ? ROOF.pitched : ROOF.flat;
}

/**
 * One row of lots along a block side. Axis 0 advances along x with the
 * front at z = `front`; axis 1 along z with the front at x = `front`;
 * `sign` points into the block. Returns the deepest building placed.
 */
function lotRow(out: Sink, b: Block, t: DistrictTypeDef, rng: Rng, axis: 0 | 1, a0: number, a1: number, front: number, sign: 1 | -1, maxDepth: number): number {
  const [f0, f1] = t.buildings.lotFrontage;
  const [d0, d1] = t.buildings.lotDepth;
  const cov = Math.sqrt(t.buildings.coverage);
  if (f0 <= 0 || maxDepth < 4) return 0;
  let used = 0;
  for (let p = a0; a1 - p > Math.max(6, f0 * 0.6); ) {
    let f = rng.nextFloat(f0, f1);
    if (a1 - p - f < f0 * 0.6) f = a1 - p;
    const depth = Math.max(3, Math.min(maxDepth, rng.nextFloat(d0, d1)) * cov);
    const width = Math.max(3, f * cov - 1);
    const mid = p + f / 2;
    const back = front + sign * depth;
    const [u0, u1, v0, v1] = [mid - width / 2, mid + width / 2, Math.min(front, back), Math.max(front, back)];
    const cx = axis === 0 ? mid : (v0 + v1) / 2;
    const cz = axis === 0 ? (v0 + v1) / 2 : mid;
    const h = buildingHeight(t, rng, cx, cz);
    const roof = roofFor(t, rng, h);
    const color = rng.pick(t.buildings.palette);
    if (axis === 0) pushBuilding(out, u0, v0, u1, v1, h, roof, color, b.district);
    else pushBuilding(out, v0, u0, v1, u1, h, roof, color, b.district);
    used = Math.max(used, depth);
    p += f;
  }
  return used;
}

/** Perimeter lots: north and south rows span the block, west and east rows fill between them. */
function lotsBlock(out: Sink, b: Block, t: DistrictTypeDef, rng: Rng): void {
  const sb = t.buildings.setback;
  const w = b.maxX - b.minX;
  const d = b.maxZ - b.minZ;
  const maxNS = Math.min(t.buildings.lotDepth[1], d / 2 - sb - 1);
  const north = lotRow(out, b, t, rng, 0, b.minX + sb, b.maxX - sb, b.minZ + sb, 1, maxNS);
  const south = lotRow(out, b, t, rng, 0, b.minX + sb, b.maxX - sb, b.maxZ - sb, -1, maxNS);
  const maxEW = Math.min(t.buildings.lotDepth[1], w / 2 - sb - 1);
  const z0 = b.minZ + sb + north + 2;
  const z1 = b.maxZ - sb - south - 2;
  lotRow(out, b, t, rng, 1, z0, z1, b.minX + sb, 1, maxEW);
  lotRow(out, b, t, rng, 1, z0, z1, b.maxX - sb, -1, maxEW);
}

/** True when (x, z) lies within `pad` of any building pushed since index `from`. */
function hitsBuilding(out: Sink, from: number, x: number, z: number, pad: number): boolean {
  const bl = out.buildings;
  for (let i = from; i < bl.length; i += BUILDING_STRIDE) {
    if (x > (bl[i] ?? 0) - pad && x < (bl[i + 2] ?? 0) + pad && z > (bl[i + 1] ?? 0) - pad && z < (bl[i + 3] ?? 0) + pad) return true;
  }
  return false;
}

/** Scatters `count` props of `kind` in the block, away from its buildings. */
function scatter(city: City, out: Sink, b: Block, rng: Rng, from: number, kind: number, count: number, scale0: number, scale1: number): void {
  const ground = blockSurface(b.kind, b.district);
  for (let placed = 0, tries = 0; placed < count && tries < count * 4; tries++) {
    const x = rng.nextFloat(b.minX + 1.5, b.maxX - 1.5);
    const z = rng.nextFloat(b.minZ + 1.5, b.maxZ - 1.5);
    const yaw = rng.nextFloat(0, Math.PI * 2);
    const scale = rng.nextFloat(scale0, scale1);
    // A junction square can reach over a block corner where the road class changes.
    if (hitsBuilding(out, from, x, z, 2.5) || city.surfaceAt(x, z) !== ground) continue;
    pushProp(out, kind, x, z, yaw, scale);
    placed++;
  }
}

function perArea(b: Block, per1000: number, rng: Rng): number {
  return Math.floor((((b.maxX - b.minX) * (b.maxZ - b.minZ)) / 1000) * per1000 + rng.next());
}

/** Building clamped inside the block (1 m margin); skipped when degenerate. */
function fixedBuilding(out: Sink, b: Block, minX: number, minZ: number, maxX: number, maxZ: number, h: number, roof: number, color: number): void {
  const x0 = Math.max(minX, b.minX + 1), x1 = Math.min(maxX, b.maxX - 1);
  const z0 = Math.max(minZ, b.minZ + 1), z1 = Math.min(maxZ, b.maxZ - 1);
  if (x1 - x0 >= 3 && z1 - z0 >= 3) pushBuilding(out, x0, z0, x1, z1, h, roof, color, b.district);
}

/** Container stacks on a grid over [x0, x1] x [z0, z1]. */
function containerYard(out: Sink, rng: Rng, x0: number, z0: number, x1: number, z1: number): void {
  const [len, wid] = CONTAINER_SIZE;
  for (let gx = x0 + len / 2; gx + len / 2 <= x1; gx += len + 4) {
    for (let gz = z0 + wid / 2; gz + wid / 2 <= z1; gz += wid + 6.5) {
      const stack = rng.nextInt(1, 3);
      if (rng.chance(0.55)) pushProp(out, PROP.container, gx, gz, Math.PI / 2, stack);
    }
  }
}

function lotLights(out: Sink, b: Block, spacing: number): void {
  for (let x = b.minX + 6; x <= b.maxX - 6; x += spacing) {
    for (let z = b.minZ + 6; z <= b.maxZ - 6; z += spacing) pushProp(out, PROP.lotLight, x, z, 0);
  }
}

const POI_COLOR = { station: 0x6d7b8c, hospital: 0xe4e4df, campus: 0xa8573f, airport: 0xc9ccd0, harbor: 0x7d8a92, school: 0xb5835a, fuel: 0xd8d4c8 } as const;

/** Buildings and props of one block, independent of which chunk asks. */
function blockContents(city: City, b: Block, out: Sink): void {
  const rng = createRng(city.seed).stream(`world:block:${b.id}`);
  const t = districtType(b.district);
  const start = out.buildings.length;
  const cx = (b.minX + b.maxX) / 2;
  const cz = (b.minZ + b.maxZ) / 2;
  const w = b.maxX - b.minX;
  const d = b.maxZ - b.minZ;
  const poi = b.poi >= 0 ? city.pois[b.poi] : undefined;
  switch (poi?.kind) {
    case 'station': {
      const s = stationLayout(b, LANDMARKS.station.yaw);
      const [x0, z0, x1, z1] = s.building;
      pushBuilding(out, x0, z0, x1, z1, s.buildingHeight, ROOF.flat, POI_COLOR.station, b.district);
      pushProp(out, PROP.fuelPump, s.pump.x, s.pump.z, s.pump.yaw);
      return;
    }
    case 'hospital': {
      const s = Math.min(18, w * 0.2, d * 0.2);
      fixedBuilding(out, b, cx - s, cz - s, cx + s, cz + s, 45, ROOF.flat, POI_COLOR.hospital);
      fixedBuilding(out, b, cx - s - 31, cz - 10, cx - s - 1, cz + 10, 15, ROOF.flat, POI_COLOR.hospital);
      fixedBuilding(out, b, cx + s + 1, cz - 10, cx + s + 31, cz + 10, 15, ROOF.flat, POI_COLOR.hospital);
      scatter(city, out, b, rng, start, PROP.tree, perArea(b, 0.2, rng), 0.8, 1.2);
      return;
    }
    case 'campus': {
      const m = 10;
      const hx = w * 0.3, hz = d * 0.3;
      fixedBuilding(out, b, cx - hx, b.minZ + m, cx + hx, b.minZ + m + 20, 16, ROOF.pitched, POI_COLOR.campus);
      fixedBuilding(out, b, cx - hx, b.maxZ - m - 20, cx + hx, b.maxZ - m, 16, ROOF.pitched, POI_COLOR.campus);
      fixedBuilding(out, b, b.minX + m, cz - hz, b.minX + m + 20, cz + hz, 20, ROOF.flat, POI_COLOR.campus);
      fixedBuilding(out, b, b.maxX - m - 20, cz - hz, b.maxX - m, cz + hz, 20, ROOF.flat, POI_COLOR.campus);
      scatter(city, out, b, rng, start, PROP.tree, perArea(b, 0.4, rng), 0.8, 1.3);
      return;
    }
    case 'airport': {
      fixedBuilding(out, b, b.minX + w * 0.15, b.minZ + 10, b.maxX - w * 0.15, b.minZ + 45, 16, ROOF.flat, POI_COLOR.airport);
      for (const side of [-1, 1]) {
        const hx = cx + side * w * 0.25;
        fixedBuilding(out, b, hx - 22, b.maxZ - 50, hx + 22, b.maxZ - 10, 14, ROOF.pitched, POI_COLOR.airport);
      }
      return;
    }
    case 'harbor': {
      fixedBuilding(out, b, b.minX + 10, b.minZ + 10, b.minX + 40, b.minZ + 30, 10, ROOF.flat, POI_COLOR.harbor);
      containerYard(out, rng, b.minX + 50, b.minZ + 10, b.maxX - 10, b.maxZ - 10);
      return;
    }
    case 'school': {
      fixedBuilding(out, b, cx - 30, b.minZ + 8, cx + 30, b.minZ + 32, 9, ROOF.flat, POI_COLOR.school);
      scatter(city, out, b, rng, start, PROP.tree, perArea(b, 0.3, rng), 0.8, 1.2);
      return;
    }
    case 'fuel': {
      fixedBuilding(out, b, cx - 8, b.minZ + 6, cx + 8, b.minZ + 16, 4.5, ROOF.flat, POI_COLOR.fuel);
      for (const [px, pz] of [[-4, -3], [4, -3], [-4, 3], [4, 3]] as const) pushProp(out, PROP.fuelPump, cx + px, cz + pz, 0);
      pushProp(out, PROP.lotLight, cx - 12, cz, 0);
      pushProp(out, PROP.lotLight, cx + 12, cz, 0);
      return;
    }
    default:
      break;
  }

  switch (b.kind) {
    case BLOCK_KIND.lots:
      lotsBlock(out, b, t, rng);
      scatter(city, out, b, rng, start, PROP.tree, perArea(b, t.props.treesPer1000m2, rng), 0.8, 1.3);
      if (t.buildings.setback >= 5) scatter(city, out, b, rng, start, PROP.bush, perArea(b, t.props.treesPer1000m2 * 0.5, rng), 0.7, 1.2);
      return;
    case BLOCK_KIND.park:
    case BLOCK_KIND.green: {
      if (w * d > 20000) fixedBuilding(out, b, cx - 5, cz - 5, cx + 5, cz + 5, 4, ROOF.pitched, t.buildings.palette[0] ?? 0xa58b6c);
      scatter(city, out, b, rng, start, PROP.tree, perArea(b, Math.max(0.4, t.props.treesPer1000m2), rng), 0.8, 1.4);
      scatter(city, out, b, rng, start, PROP.bench, perArea(b, 0.25, rng), 1, 1);
      return;
    }
    case BLOCK_KIND.plaza:
      scatter(city, out, b, rng, start, PROP.tree, perArea(b, 0.2, rng), 0.8, 1.1);
      scatter(city, out, b, rng, start, PROP.bench, perArea(b, 1.5, rng), 1, 1);
      return;
    case BLOCK_KIND.parking:
      lotLights(out, b, 35);
      return;
    case BLOCK_KIND.farm: {
      const sb = t.buildings.setback;
      if (w > 2 * sb + 40 && d > 2 * sb + 40) {
        const x0 = rng.chance(0.5) ? b.minX + sb : b.maxX - sb - 24;
        const z0 = rng.chance(0.5) ? b.minZ + sb : b.maxZ - sb - 32;
        const [house, barn] = [rng.pick(t.buildings.palette), rng.pick(t.buildings.palette)];
        pushBuilding(out, x0, z0, x0 + 14, z0 + 10, 7, ROOF.pitched, house, b.district);
        pushBuilding(out, x0, z0 + 16, x0 + 24, z0 + 32, 9, ROOF.pitched, barn, b.district);
      }
      for (let x = b.minX + 6; x < b.maxX - 6; x += 12) {
        if (rng.chance(0.5)) pushProp(out, PROP.bush, x, b.minZ + 1.5, 0, 1.2);
        if (rng.chance(0.5)) pushProp(out, PROP.bush, x, b.maxZ - 1.5, 0, 1.2);
      }
      scatter(city, out, b, rng, start, PROP.tree, perArea(b, t.props.treesPer1000m2, rng), 0.9, 1.4);
      return;
    }
    case BLOCK_KIND.yard: {
      const sb = t.buildings.setback;
      const depth = Math.min(30, d / 3);
      fixedBuilding(out, b, b.minX + sb, b.minZ + sb, Math.min(b.maxX - sb, b.minX + sb + 60), b.minZ + sb + depth, 12, ROOF.flat, rng.pick(t.buildings.palette));
      containerYard(out, rng, b.minX + sb, b.minZ + sb + depth + 8, b.maxX - sb, b.maxZ - sb);
      return;
    }
    default:
      return;
  }
}

// --- Road-side items (deterministic from the graph, no randomness) ------------------

interface Frame {
  x: number;
  z: number;
  /** from -> to unit direction. */
  ux: number;
  uz: number;
}

/** Centreline point and direction `along` metres from the edge's `from` node. */
function frameAt(e: RoadEdge, along: number, out: Frame): Frame {
  const p = e.points;
  let rest = Math.max(0, along);
  for (let i = 0; i + 3 < p.length; i += 2) {
    const ax = p[i] ?? 0, az = p[i + 1] ?? 0;
    const dx = (p[i + 2] ?? 0) - ax, dz = (p[i + 3] ?? 0) - az;
    const len = Math.hypot(dx, dz);
    if (rest <= len || i + 4 >= p.length) {
      const t = len > 0 ? Math.min(rest, len) / len : 0;
      out.x = ax + dx * t;
      out.z = az + dz * t;
      out.ux = len > 0 ? dx / len : 1;
      out.uz = len > 0 ? dz / len : 0;
      return out;
    }
    rest -= len;
  }
  return out;
}

/** Lateral distance from the centreline to a roadside item (sign, pole). */
function roadsideOffset(e: RoadEdge, extra: number): number {
  return e.width / 2 + (e.sidewalk > 0 ? e.sidewalk * 0.5 : 1) + extra;
}

/**
 * Point beside travel direction `dir` at `s` metres from that direction's
 * start node; `side` +1 = right of travel. Returns the yaw facing the traffic.
 */
function besideTravel(e: RoadEdge, dir: 0 | 1, s: number, lateral: number, side: 1 | -1, f: Frame): number {
  frameAt(e, dir === 0 ? s : e.length - s, f);
  const hx = dir === 0 ? f.ux : -f.ux;
  const hz = dir === 0 ? f.uz : -f.uz;
  // Right of travel heading (hx, hz) is (-hz, hx).
  f.x += -hz * lateral * side;
  f.z += hx * lateral * side;
  return yawOf(-hx, -hz);
}

function edgeItems(g: RoadGraph, e: RoadEdge, out: Sink, signs: number[]): void {
  const f: Frame = { x: 0, z: 0, ux: 1, uz: 0 };
  const from = g.nodes[e.from] as RoadNode;
  const to = g.nodes[e.to] as RoadNode;
  const s0 = from.setback;
  const s1 = e.length - to.setback;
  const props = districtType(e.district).props;
  // The yaw is computed first: besideTravel moves `f` to the item's position.
  const roadside = (kind: number, dir: 0 | 1, s: number, lateral: number, side: 1 | -1): void => {
    const yaw = besideTravel(e, dir, s, lateral, side, f);
    pushProp(out, kind, f.x, f.z, yaw);
  };

  // Streetlights: both kerbs at a spacing, or only beside junctions where the spacing is 0.
  const lightLateral = e.width / 2 + (e.sidewalk > 0 ? e.sidewalk - 0.6 : 1.2);
  if (props.streetlightSpacing > 0) {
    for (let s = s0 + props.streetlightSpacing / 2; s <= s1; s += props.streetlightSpacing) {
      for (const side of [1, -1] as const) {
        const yaw = besideTravel(e, 0, s, lightLateral, side, f);
        pushProp(out, PROP.streetlight, f.x, f.z, side === 1 ? yaw : yaw + Math.PI);
      }
    }
  } else {
    if (from.junction !== JUNCTION.none) roadside(PROP.streetlight, 0, s0 + 3, lightLateral, 1);
    if (to.junction !== JUNCTION.none) roadside(PROP.streetlight, 1, e.length - s1 + 3, lightLateral, 1);
  }
  if (e.sidewalk > 0) {
    if (props.hydrantSpacing > 0) {
      for (let s = s0 + props.hydrantSpacing * 0.3; s <= s1 - 2; s += props.hydrantSpacing) {
        roadside(PROP.hydrant, 0, s, e.width / 2 + e.sidewalk - 0.4, 1);
      }
    }
    if (props.benchSpacing > 0) {
      for (let s = s0 + props.benchSpacing * 0.4; s <= s1 - 2; s += props.benchSpacing) {
        roadside(PROP.bench, 0, s, e.width / 2 + e.sidewalk - 0.5, -1);
      }
    }
  }
  if (e.flags & EDGE_FLAG.construction) {
    for (let s = s0 + 6; s <= s1 - 6; s += 10) roadside(PROP.cone, 0, s, e.width / 2 - 0.4, 1);
    // End barriers stand on the shoulder turned along the kerb (their long side parallel to travel), clear of the lane.
    for (const s of [s0 + 3, s1 - 3]) {
      const yaw = besideTravel(e, 0, s, e.width / 2 - 0.15, 1, f);
      pushProp(out, PROP.barrier, f.x, f.z, yaw + Math.PI / 2);
    }
  }

  // Signs per travel direction, measured from that direction's start node.
  const lateral = roadsideOffset(e, 0);
  for (const dir of [0, 1] as const) {
    if ((dir === 0 ? e.lanesForward : e.lanesBackward) === 0) continue;
    const start = dir === 0 ? from : to;
    const usable = e.length - from.setback - to.setback;
    const sign = (kind: number, offset: number, value: number): void => {
      if (offset > usable - 5) return;
      const yaw = besideTravel(e, dir, start.setback + offset, lateral, 1, f);
      signs.push(kind, f.x, f.z, yaw, value);
    };
    // The posted limit includes the construction reduction (school zones have their own sign).
    if (start.junction !== JUNCTION.none) sign(SIGN.speedLimit, 12, constructionLimitMph(e));
    if (e.flags & EDGE_FLAG.schoolZone) {
      const boundary = start.edges.some((id) => ((g.edges[id] as RoadEdge).flags & EDGE_FLAG.schoolZone) === 0);
      if (boundary) sign(SIGN.schoolZone, 20, 0);
    }
    if (e.flags & EDGE_FLAG.construction) sign(SIGN.construction, 28, 0);
  }
  if (e.lanesBackward === 0) {
    signs.push(SIGN.oneWay, ...signAt(e, 0, from.setback + 5, lateral, f));
    // No-entry faces a wrong-way driver entering at `to`, on that driver's right.
    signs.push(SIGN.noEntry, ...signAt(e, 1, to.setback + 1, lateral, f));
  }
}

function signAt(e: RoadEdge, dir: 0 | 1, s: number, lateral: number, f: Frame): [number, number, number, number] {
  const yaw = besideTravel(e, dir, s, lateral, 1, f);
  return [f.x, f.z, yaw, 0];
}

/** Stop/yield signs and signal heads of one node's approaches. */
function nodeItems(g: RoadGraph, node: RoadNode, signs: number[], heads: number[]): void {
  if (node.junction === JUNCTION.none) return;
  const f: Frame = { x: 0, z: 0, ux: 1, uz: 0 };
  for (const id of node.edges) {
    const e = g.edges[id] as RoadEdge;
    const dir: 0 | 1 = e.to === node.id ? 0 : 1;
    if ((dir === 0 ? e.lanesForward : e.lanesBackward) === 0) continue;
    const stopLine = e.length - node.setback;
    if (node.junction === JUNCTION.signal) {
      // Head on the far-right corner: across the junction, beside the kerb line of the widest road on
      // the approach's axis (a county road continuing as an arterial widens past the junction).
      frameAt(e, dir === 0 ? e.length : 0, f);
      const hx = dir === 0 ? f.ux : -f.ux;
      const hz = dir === 0 ? f.uz : -f.uz;
      let half = e.width / 2;
      const axis = g.approachGroup(id, dir);
      for (const oid of node.edges) {
        const o = g.edges[oid] as RoadEdge;
        if (g.approachGroup(oid, o.to === node.id ? 0 : 1) === axis) half = Math.max(half, o.width / 2);
      }
      const lateral = half + 1;
      let x = node.x + hx * node.setback - hz * lateral;
      let z = node.z + hz * node.setback + hx * lateral;
      if (Math.abs(x) > WORLD_HALF_SIZE || Math.abs(z) > WORLD_HALF_SIZE) {
        // Far side past the world edge (perimeter junctions): the near-right corner instead.
        x = node.x - hx * node.setback - hz * lateral;
        z = node.z - hz * node.setback + hx * lateral;
      }
      heads.push(node.signal, g.approachGroup(id, dir), x, z, yawOf(-hx, -hz));
      continue;
    }
    if (!g.stopsAt(id, node.id)) continue;
    const kind = e.roadClass === ROAD_CLASS.service || e.roadClass === ROAD_CLASS.gravel ? SIGN.yield : SIGN.stop;
    const yaw = besideTravel(e, dir, stopLine, roadsideOffset(e, 0), 1, f);
    signs.push(kind, f.x, f.z, yaw, 0);
  }
}

/** Every signal head in the city (HEAD_STRIDE), in node order. */
export function allSignalHeads(city: City): Float32Array {
  const heads: number[] = [];
  const signs: number[] = [];
  for (const s of city.graph.signals) nodeItems(city.graph, city.graph.nodes[s.node] as RoadNode, signs, heads);
  return new Float32Array(heads);
}

// --- Colliders -----------------------------------------------------------------------

function pushCollider(out: number[], x: number, y: number, z: number, hx: number, hy: number, hz: number, yaw: number): void {
  out.push(x, y, z, hx, hy, hz, yaw);
}

function propCollider(out: number[], kind: number, x: number, z: number, yaw: number, scale: number): void {
  switch (kind) {
    case PROP.tree:
      pushCollider(out, x, (TREE_TRUNK_HEIGHT * scale) / 2, z, 0.25 * scale, (TREE_TRUNK_HEIGHT * scale) / 2, 0.25 * scale, 0);
      break;
    case PROP.streetlight:
      pushCollider(out, x, STREETLIGHT_HEIGHT / 2, z, 0.15, STREETLIGHT_HEIGHT / 2, 0.15, 0);
      break;
    case PROP.lotLight:
      pushCollider(out, x, LOT_LIGHT_HEIGHT / 2, z, 0.2, LOT_LIGHT_HEIGHT / 2, 0.2, 0);
      break;
    case PROP.container: {
      const [len, wid, h] = CONTAINER_SIZE;
      // Container length runs along local Z, so yaw pi/2 lays it along x.
      pushCollider(out, x, (h * scale) / 2, z, wid / 2, (h * scale) / 2, len / 2, yaw);
      break;
    }
    case PROP.fuelPump:
      pushCollider(out, x, 0.9, z, 0.5, 0.9, 0.35, yaw);
      break;
    case PROP.barrier:
      pushCollider(out, x, 0.4, z, 1.0, 0.4, 0.1, yaw);
      break;
    default:
      break;
  }
}

// --- Chunk layout ---------------------------------------------------------------------

/**
 * Everything static inside chunk (cx, cz): buildings, props and signs whose
 * centre lies inside it, clipped block ground, touching edges/nodes and the
 * physics colliders. Block contents come from each block's own stream, so the
 * result does not depend on which chunks were requested before.
 */
export function chunkLayout(city: City, cx: number, cz: number): ChunkLayout {
  const g = city.graph;
  const { minX, minZ, maxX, maxZ } = chunkBounds(cx, cz);
  const inside = (x: number, z: number): boolean => x >= minX && x < maxX && z >= minZ && z < maxZ;

  const buildings: number[] = [];
  const props: number[] = [];
  const signs: number[] = [];
  const heads: number[] = [];
  const ground: number[] = [];
  const colliders: number[] = [];
  const walls: number[] = [];

  const keep = (sink: Sink): void => {
    const bl = sink.buildings;
    for (let i = 0; i < bl.length; i += BUILDING_STRIDE) {
      const x0 = bl[i] ?? 0, z0 = bl[i + 1] ?? 0, x1 = bl[i + 2] ?? 0, z1 = bl[i + 3] ?? 0, h = bl[i + 4] ?? 0;
      const bx = (x0 + x1) / 2, bz = (z0 + z1) / 2;
      if (!inside(bx, bz)) continue;
      for (let k = 0; k < BUILDING_STRIDE; k++) buildings.push(bl[i + k] ?? 0);
      pushCollider(colliders, bx, h / 2, bz, (x1 - x0) / 2, h / 2, (z1 - z0) / 2, 0);
    }
    const pr = sink.props;
    for (let i = 0; i < pr.length; i += PROP_STRIDE) {
      const kind = pr[i] ?? 0, x = pr[i + 1] ?? 0, z = pr[i + 2] ?? 0, yaw = pr[i + 3] ?? 0, scale = pr[i + 4] ?? 1;
      if (!inside(x, z)) continue;
      props.push(kind, x, z, yaw, scale);
      propCollider(colliders, kind, x, z, yaw, scale);
    }
  };

  // Blocks: ground, contents, quay walls.
  const blockIds = city.blocksIn(minX, minZ, maxX, maxZ, []);
  const sink: Sink = { buildings: [], props: [] };
  for (const id of blockIds) {
    const b = city.blocks[id] as Block;
    const gx0 = Math.max(b.minX, minX), gx1 = Math.min(b.maxX, maxX);
    const gz0 = Math.max(b.minZ, minZ), gz1 = Math.min(b.maxZ, maxZ);
    if (gx1 > gx0 && gz1 > gz0) ground.push(gx0, gz0, gx1, gz1, blockSurface(b.kind, b.district), b.kind);
    sink.buildings.length = 0;
    sink.props.length = 0;
    blockContents(city, b, sink);
    keep(sink);
    if (b.kind === BLOCK_KIND.water) quayWalls(city, b, minX, minZ, maxX, maxZ, colliders, walls);
  }
  boundaryWalls(cx, cz, minX, minZ, maxX, maxZ, walls);

  // Road-side items.
  const near: number[] = [];
  const touching: number[] = [];
  const ccx = (cx + 0.5) * CHUNK_SIZE, ccz = (cz + 0.5) * CHUNK_SIZE;
  for (const id of g.edgesNear(ccx, ccz, NEAR_RADIUS, near)) {
    const e = g.edges[id] as RoadEdge;
    if (edgeTouches(e, minX, minZ, maxX, maxZ)) touching.push(id);
    sink.buildings.length = 0;
    sink.props.length = 0;
    const edgeSigns: number[] = [];
    edgeItems(g, e, sink, edgeSigns);
    keep(sink);
    keepSigns(edgeSigns, signs, colliders, inside);
  }
  const nodeIds: number[] = [];
  for (const id of g.nodesNear(ccx, ccz, NEAR_RADIUS, near)) {
    const n = g.nodes[id] as RoadNode;
    const r = Math.max(n.setback, 1);
    if (n.x + r >= minX && n.x - r < maxX && n.z + r >= minZ && n.z - r < maxZ) nodeIds.push(id);
    const nodeSigns: number[] = [];
    const nodeHeads: number[] = [];
    nodeItems(g, n, nodeSigns, nodeHeads);
    keepSigns(nodeSigns, signs, colliders, inside);
    for (let i = 0; i < nodeHeads.length; i += HEAD_STRIDE) {
      const x = nodeHeads[i + 2] ?? 0, z = nodeHeads[i + 3] ?? 0;
      if (!inside(x, z)) continue;
      for (let k = 0; k < HEAD_STRIDE; k++) heads.push(nodeHeads[i + k] ?? 0);
      pushCollider(colliders, x, SIGNAL_POLE_HEIGHT / 2, z, 0.15, SIGNAL_POLE_HEIGHT / 2, 0.15, 0);
    }
  }

  return {
    cx,
    cz,
    buildings: new Float32Array(buildings),
    props: new Float32Array(props),
    signs: new Float32Array(signs),
    signalHeads: new Float32Array(heads),
    ground: new Float32Array(ground),
    edges: new Uint32Array(touching),
    nodes: new Uint32Array(nodeIds),
    colliders: new Float32Array(colliders),
    walls: new Float32Array(walls),
  };
}

/** Keeps the signs inside the chunk, each with a collider for its post. */
function keepSigns(src: number[], dst: number[], colliders: number[], inside: (x: number, z: number) => boolean): void {
  for (let i = 0; i < src.length; i += SIGN_STRIDE) {
    const x = src[i + 1] ?? 0, z = src[i + 2] ?? 0;
    if (!inside(x, z)) continue;
    for (let k = 0; k < SIGN_STRIDE; k++) dst.push(src[i + k] ?? 0);
    pushCollider(colliders, x, SIGN_POST_HEIGHT / 2, z, 0.06, SIGN_POST_HEIGHT / 2, 0.06, 0);
  }
}

/** True when the edge's road + sidewalk box overlaps the chunk rectangle. */
function edgeTouches(e: RoadEdge, minX: number, minZ: number, maxX: number, maxZ: number): boolean {
  const pad = e.width / 2 + e.sidewalk;
  const p = e.points;
  for (let i = 0; i + 3 < p.length; i += 2) {
    const x0 = Math.min(p[i] ?? 0, p[i + 2] ?? 0) - pad, x1 = Math.max(p[i] ?? 0, p[i + 2] ?? 0) + pad;
    const z0 = Math.min(p[i + 1] ?? 0, p[i + 3] ?? 0) - pad, z1 = Math.max(p[i + 1] ?? 0, p[i + 3] ?? 0) + pad;
    if (x1 >= minX && x0 < maxX && z1 >= minZ && z0 < maxZ) return true;
  }
  return false;
}

/**
 * Quay walls along the sides of a water block that face land, cut to the chunk. Where land touches
 * the block only diagonally (two land roads meet in an L at the block corner), two stubs continue
 * the neighbours' walls across the corner square so the corner is closed too.
 */
function quayWalls(city: City, b: Block, minX: number, minZ: number, maxX: number, maxZ: number, out: number[], walls: number[]): void {
  const col = cellIndexOf((b.minX + b.maxX) / 2);
  const row = cellIndexOf((b.minZ + b.maxZ) / 2);
  const land = (c: number, r: number): boolean =>
    c >= 0 && r >= 0 && c < CELLS_PER_SIDE && r < CELLS_PER_SIDE && DISTRICTS.cells[r * CELLS_PER_SIDE + c] !== DISTRICT.water;
  const half = QUAY_WALL_HEIGHT / 2;
  const t = QUAY_WALL_HALF;
  // Wall along x (axis 0) at z = fixed, or along z (axis 1) at x = fixed, from a0 to a1; kept by the chunk holding its line.
  const wall = (axis: 0 | 1, fixed: number, a0: number, a1: number): void => {
    if (axis === 1) {
      const z0 = Math.max(a0, minZ), z1 = Math.min(a1, maxZ);
      if (z1 > z0 && fixed >= minX && fixed < maxX) pushWall(out, walls, fixed, half, (z0 + z1) / 2, t, half, (z1 - z0) / 2);
    } else {
      const x0 = Math.max(a0, minX), x1 = Math.min(a1, maxX);
      if (x1 > x0 && fixed >= minZ && fixed < maxZ) pushWall(out, walls, (x0 + x1) / 2, half, fixed, (x1 - x0) / 2, half, t);
    }
  };
  // [neighbour col, row, axis along which the wall runs, fixed coordinate]
  const sides: [number, number, 0 | 1, number][] = [
    [col - 1, row, 1, b.minX + t],
    [col + 1, row, 1, b.maxX - t],
    [col, row - 1, 0, b.minZ + t],
    [col, row + 1, 0, b.maxZ - t],
  ];
  for (const [c, r, axis, fixed] of sides) {
    if (!land(c, r)) continue;
    if (axis === 1) wall(1, fixed, b.minZ, b.maxZ);
    else wall(0, fixed, b.minX, b.maxX);
  }
  for (const sx of [-1, 1] as const) {
    for (const sz of [-1, 1] as const) {
      if (land(col + sx, row) || land(col, row + sz) || !land(col + sx, row + sz)) continue;
      const cornerX = sx < 0 ? b.minX : b.maxX;
      const cornerZ = sz < 0 ? b.minZ : b.maxZ;
      // The water blocks beside this one, across the corner from the land: their walls end at the corner.
      const above = waterBlockAt(city, cornerX - sx * 40, cornerZ + sz);
      const beside = waterBlockAt(city, cornerX + sx, cornerZ - sz * 40);
      if (!above || !beside) continue;
      const wallX = sx < 0 ? above.minX + t : above.maxX - t;
      const wallZ = sz < 0 ? beside.minZ + t : beside.maxZ - t;
      // Each stub runs from the corner to the other stub's far face, so the two overlap.
      wall(1, wallX, Math.min(cornerZ, wallZ - sz * t), Math.max(cornerZ, wallZ - sz * t));
      wall(0, wallZ, Math.min(cornerX, wallX - sx * t), Math.max(cornerX, wallX - sx * t));
    }
  }
}

function waterBlockAt(city: City, x: number, z: number): Block | undefined {
  for (const id of city.blocksIn(x, z, x, z, [])) {
    const b = city.blocks[id] as Block;
    if (b.kind === BLOCK_KIND.water) return b;
  }
  return undefined;
}

function pushWall(colliders: number[], walls: number[], x: number, y: number, z: number, hx: number, hy: number, hz: number): void {
  pushCollider(colliders, x, y, z, hx, hy, hz, 0);
  pushCollider(walls, x, y, z, hx, hy, hz, 0);
}

/** The world boundary walls (see `WORLD_WALL`; their colliders are global) drawn by the edge chunks. */
function boundaryWalls(cx: number, cz: number, minX: number, minZ: number, maxX: number, maxZ: number, walls: number[]): void {
  const c = WORLD_HALF_SIZE + WORLD_WALL.offset;
  const t = WORLD_WALL.halfThickness;
  const h = WORLD_WALL.height / 2;
  if (cx <= MIN_CHUNK) pushCollider(walls, -c, h, (minZ + maxZ) / 2, t, h, (maxZ - minZ) / 2, 0);
  if (cx >= MAX_CHUNK) pushCollider(walls, c, h, (minZ + maxZ) / 2, t, h, (maxZ - minZ) / 2, 0);
  if (cz <= MIN_CHUNK) pushCollider(walls, (minX + maxX) / 2, h, -c, (maxX - minX) / 2, h, t, 0);
  if (cz >= MAX_CHUNK) pushCollider(walls, (minX + maxX) / 2, h, c, (maxX - minX) / 2, h, t, 0);
}
