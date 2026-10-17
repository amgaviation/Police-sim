/**
 * Pure chunk meshing (no THREE, no DOM): turns a `ChunkLayout` into merged,
 * vertex-coloured triangle buffers per material group. Used inside the chunk
 * worker and as the synchronous fallback on the main thread.
 *
 * Roads are drawn as world-aligned rectangles, so this assumes axis-aligned
 * edge segments (true for every Phase 1 road).
 */
import {
  BUILDING_STRIDE,
  COLLIDER_STRIDE,
  CONTAINER_SIZE,
  GROUND_STRIDE,
  PROP,
  PROP_STRIDE,
  ROOF,
  SIGN,
  SIGN_STRIDE,
  STREETLIGHT_HEIGHT,
  chunkBounds,
  type ChunkLayout,
} from '../chunkLayout';
import { BLOCK_KIND, type City } from '../city';
import { CHUNK_SIZE } from '../constants';
import { districtType } from '../data';
import { JUNCTION, ROAD_CLASS, SURFACE } from '../ids';
import type { RoadEdge, RoadGraph, RoadNode } from '../roadGraph';

export type ChunkGroupName = 'ground' | 'markings' | 'buildings' | 'props' | 'lamps';
export const CHUNK_GROUP_NAMES: readonly ChunkGroupName[] = ['ground', 'markings', 'buildings', 'props', 'lamps'];

export interface ChunkMeshGroup {
  name: ChunkGroupName;
  positions: Float32Array;
  normals: Float32Array;
  /** Linear RGB per vertex. */
  colors: Float32Array;
  uvs: Float32Array | null;
  indices: Uint32Array;
  /** Bounding sphere x, y, z, radius. */
  sphere: [number, number, number, number];
}

export interface ChunkMeshData {
  cx: number;
  cz: number;
  lod: 0 | 1;
  /** Non-empty groups in CHUNK_GROUP_NAMES order. */
  groups: ChunkMeshGroup[];
}

/** Window texture tiling: metres per texture repeat along walls and up. */
export const WINDOW_TILE_U = 24;
export const WINDOW_TILE_V = 28;
/** Window texture size in texels and window cells per side (see cityMaterials). */
export const WINDOW_TEXTURE_SIZE = 256;
export const WINDOW_CELLS = 8;
/** UV of a plain wall texel (no window) used for roofs. */
const ROOF_UV = 0.5 / WINDOW_TEXTURE_SIZE;

const GROUND_Y = 0;
const BASE_Y = -0.1;
/** Water sits a little below the roads, so a junction square over a water block corner does not z-fight. */
const WATER_Y = -0.05;
const MARKING_Y = 0.02;
/** Junction squares sit just above the ground: one can reach over a block corner where the road class changes. */
const JUNCTION_Y = 0.005;
/** Streetlight arm length from the pole toward the road (local +X). */
const ARM_LENGTH = 2.2;
const LOT_LIGHT_POLE = 10;
const SIGN_Y = 2.3;

/** sRGB colours of the generic palette. */
const COLOR = {
  surface: [0x3b3c3f, 0x8f8c86, 0x8b8070, 0x6b5640, 0x4f6b34, 0xc2b088] as readonly number[],
  water: 0x2b5468,
  runway: 0x2f3033,
  parking: 0x47484c,
  farm: 0x77773f,
  sidewalk: 0xa19d96,
  median: 0x5d7040,
  white: 0xe8e8e2,
  yellow: 0xd9b026,
  black: 0x1b1c1e,
  red: 0xb3221c,
  orange: 0xe2701c,
  yellowGreen: 0xbcd62a,
  grey: 0x6f7378,
  darkGrey: 0x45484c,
  trunk: 0x5a4430,
  wood: 0x7a5a3a,
  lamp: 0xd8d6cc,
  pump: 0xd9d9d6,
  bollard: 0xd4b22a,
  concrete: 0x9a968e,
} as const;
const FOLIAGE = [0x3f6b2e, 0x4b7a35, 0x355c2a, 0x56803a] as const;
const ROOF_TILES = [0x5a3d32, 0x4a4d52, 0x6b4a3a, 0x3f4247] as const;
const CONTAINERS = [0x9c3b2a, 0x2e5c8a, 0x3d7a4a, 0x8a8f94, 0xc77a2a] as const;
/** 7-segment bits (a=1 top, b=2, c=4, d=8 bottom, e=16, f=32, g=64 middle) for 0-9. */
const SEGMENTS = [0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f] as const;

function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Deterministic hash of a position to [0, 1) for colour variation. */
function hash01(x: number, z: number, salt: number): number {
  let h = Math.imul(Math.round(x * 8) | 0, 0x9e3779b1) ^ Math.imul(Math.round(z * 8) | 0, 0x85ebca6b) ^ salt;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

function pick<T>(list: readonly T[], u: number): T {
  return list[Math.min(list.length - 1, Math.floor(u * list.length))] as T;
}

/** World point of a lamp head (where the light comes from) for a streetlight or lot light prop. */
export function lampHeadPosition(kind: number, x: number, z: number, yaw: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  if (kind === PROP.streetlight) {
    // Arm along local +X: (cos yaw, -sin yaw).
    out.x = x + Math.cos(yaw) * ARM_LENGTH;
    out.y = STREETLIGHT_HEIGHT - 0.35;
    out.z = z - Math.sin(yaw) * ARM_LENGTH;
  } else {
    out.x = x;
    out.y = LOT_LIGHT_POLE - 0.4;
    out.z = z;
  }
  return out;
}

// --- Geometry builder --------------------------------------------------------------

/** Growable buffers of one group; faces get flat normals and the current colour. */
class GroupBuilder {
  readonly name: ChunkGroupName;
  private readonly pos: number[] = [];
  private readonly nor: number[] = [];
  private readonly col: number[] = [];
  private readonly uv: number[] | null;
  private readonly idx: number[] = [];
  private r = 1;
  private g = 1;
  private b = 1;
  /** True: UVs from world metres (walls); false: the plain roof texel. */
  wallUv = false;

  constructor(name: ChunkGroupName, withUv: boolean) {
    this.name = name;
    this.uv = withUv ? [] : null;
  }

  setColor(hex: number, scale = 1): void {
    this.r = srgbToLinear(((hex >> 16) & 255) / 255) * scale;
    this.g = srgbToLinear(((hex >> 8) & 255) / 255) * scale;
    this.b = srgbToLinear((hex & 255) / 255) * scale;
  }

  private vertex(x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.col.push(this.r, this.g, this.b);
    if (this.uv) {
      if (this.wallUv) this.uv.push((x + z) / WINDOW_TILE_U, y / WINDOW_TILE_V);
      else this.uv.push(ROOF_UV, ROOF_UV);
    }
  }

  /** Parallelogram o, o+u, o+u+v, o+v, wound so its normal points along (ex, ey, ez). */
  quad(ox: number, oy: number, oz: number, ux: number, uy: number, uz: number, vx: number, vy: number, vz: number, ex: number, ey: number, ez: number): void {
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    if (nx * ex + ny * ey + nz * ez < 0) {
      [ux, uy, uz, vx, vy, vz] = [vx, vy, vz, ux, uy, uz];
      nx = -nx; ny = -ny; nz = -nz;
    }
    nx /= len; ny /= len; nz /= len;
    const base = this.pos.length / 3;
    this.vertex(ox, oy, oz, nx, ny, nz);
    this.vertex(ox + ux, oy + uy, oz + uz, nx, ny, nz);
    this.vertex(ox + ux + vx, oy + uy + vy, oz + uz + vz, nx, ny, nz);
    this.vertex(ox + vx, oy + vy, oz + vz, nx, ny, nz);
    this.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }

  /** Triangle wound so its normal points along (ex, ey, ez). */
  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, ex: number, ey: number, ez: number): void {
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-9) return;
    const flip = nx * ex + ny * ey + nz * ez < 0;
    if (flip) { nx = -nx; ny = -ny; nz = -nz; }
    nx /= len; ny /= len; nz /= len;
    const base = this.pos.length / 3;
    this.vertex(ax, ay, az, nx, ny, nz);
    if (flip) {
      this.vertex(cx, cy, cz, nx, ny, nz);
      this.vertex(bx, by, bz, nx, ny, nz);
    } else {
      this.vertex(bx, by, bz, nx, ny, nz);
      this.vertex(cx, cy, cz, nx, ny, nz);
    }
    this.idx.push(base, base + 1, base + 2);
  }

  finish(): ChunkMeshGroup | null {
    const n = this.pos.length / 3;
    if (n === 0) return null;
    const positions = new Float32Array(this.pos);
    let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i] ?? 0, y = positions[i + 1] ?? 0, z = positions[i + 2] ?? 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    const sx = (minX + maxX) / 2, sy = (minY + maxY) / 2, sz = (minZ + maxZ) / 2;
    let r2 = 0;
    for (let i = 0; i < positions.length; i += 3) {
      const dx = (positions[i] ?? 0) - sx, dy = (positions[i + 1] ?? 0) - sy, dz = (positions[i + 2] ?? 0) - sz;
      r2 = Math.max(r2, dx * dx + dy * dy + dz * dz);
    }
    return {
      name: this.name,
      positions,
      normals: new Float32Array(this.nor),
      colors: new Float32Array(this.col),
      uvs: this.uv ? new Float32Array(this.uv) : null,
      indices: new Uint32Array(this.idx),
      sphere: [sx, sy, sz, Math.sqrt(r2) + 1e-3],
    };
  }
}

/** Rectangle centred on (cx, cy, cz) with half axes a and b, facing n. */
function face(b: GroupBuilder, cx: number, cy: number, cz: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, nx: number, ny: number, nz: number): void {
  b.quad(cx - ax - bx, cy - ay - by, cz - az - bz, 2 * ax, 2 * ay, 2 * az, 2 * bx, 2 * by, 2 * bz, nx, ny, nz);
}

/** Box centred on (x, yc, z) with half extents, rotated by yaw (local +X = (cos, -sin), +Z = (sin, cos)). */
function box(b: GroupBuilder, x: number, yc: number, z: number, hx: number, hy: number, hz: number, yaw: number, bottom = false): void {
  const rx = Math.cos(yaw), rz = -Math.sin(yaw);
  const fx = -rz, fz = rx;
  face(b, x + rx * hx, yc, z + rz * hx, fx * hz, 0, fz * hz, 0, hy, 0, rx, 0, rz);
  face(b, x - rx * hx, yc, z - rz * hx, fx * hz, 0, fz * hz, 0, hy, 0, -rx, 0, -rz);
  face(b, x + fx * hz, yc, z + fz * hz, rx * hx, 0, rz * hx, 0, hy, 0, fx, 0, fz);
  face(b, x - fx * hz, yc, z - fz * hz, rx * hx, 0, rz * hx, 0, hy, 0, -fx, 0, -fz);
  face(b, x, yc + hy, z, rx * hx, 0, rz * hx, fx * hz, 0, fz * hz, 0, 1, 0);
  if (bottom) face(b, x, yc - hy, z, rx * hx, 0, rz * hx, fx * hz, 0, fz * hz, 0, -1, 0);
}

/** Upward-facing rectangle clipped to the chunk rectangle. */
function rectUp(b: GroupBuilder, clip: Clip, x0: number, z0: number, x1: number, z1: number, y: number): void {
  const a = Math.max(Math.min(x0, x1), clip.minX), c = Math.min(Math.max(x0, x1), clip.maxX);
  const d = Math.max(Math.min(z0, z1), clip.minZ), e = Math.min(Math.max(z0, z1), clip.maxZ);
  if (c - a < 1e-3 || e - d < 1e-3) return;
  b.quad(a, y, d, 0, 0, e - d, c - a, 0, 0, 0, 1, 0);
}

/** Double pyramid (diamond) around (x, yc, z): low-poly foliage and bushes. */
function diamond(b: GroupBuilder, x: number, yc: number, z: number, r: number, hy: number, yaw: number): void {
  const top = yc + hy, bottom = yc - hy;
  for (let k = 0; k < 4; k++) {
    const a0 = yaw + (k * Math.PI) / 2, a1 = a0 + Math.PI / 2;
    const x0 = x + Math.cos(a0) * r, z0 = z + Math.sin(a0) * r;
    const x1 = x + Math.cos(a1) * r, z1 = z + Math.sin(a1) * r;
    const mx = (x0 + x1) / 2 - x, mz = (z0 + z1) / 2 - z;
    b.tri(x0, yc, z0, x1, yc, z1, x, top, z, mx, r * 0.5, mz);
    b.tri(x0, yc, z0, x1, yc, z1, x, bottom, z, mx, -r * 0.5, mz);
  }
}

/** Four-sided pyramid standing on y = 0 (traffic cone). */
function pyramid(b: GroupBuilder, x: number, z: number, half: number, h: number): void {
  const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const;
  for (let k = 0; k < 4; k++) {
    const p = c[k] as readonly [number, number], q = c[(k + 1) % 4] as readonly [number, number];
    b.tri(x + p[0] * half, 0, z + p[1] * half, x + q[0] * half, 0, z + q[1] * half, x, h, z, p[0] + q[0], half, p[1] + q[1]);
  }
}

// --- Road shapes -------------------------------------------------------------------

interface Clip {
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
}

/** Junction footprint of a node: half extents of its square and the directions edges leave in. */
interface NodeShape {
  /** Half extent along x (half width of the widest edge running along z), 0 if none. */
  halfX: number;
  halfZ: number;
  square: boolean;
  posX: boolean;
  negX: boolean;
  posZ: boolean;
  negZ: boolean;
  surface: number;
}

/** Direction an edge leaves `node` in, as a unit axis vector. */
function leaving(e: RoadEdge, node: number, out: { x: number; z: number }): void {
  const p = e.points;
  const n = p.length;
  const [dx, dz] = e.from === node
    ? [(p[2] ?? 0) - (p[0] ?? 0), (p[3] ?? 0) - (p[1] ?? 0)]
    : [(p[n - 4] ?? 0) - (p[n - 2] ?? 0), (p[n - 3] ?? 0) - (p[n - 1] ?? 0)];
  if (Math.abs(dx) >= Math.abs(dz)) { out.x = Math.sign(dx); out.z = 0; } else { out.x = 0; out.z = Math.sign(dz); }
}

function nodeShape(g: RoadGraph, id: number, cache: Map<number, NodeShape>): NodeShape {
  const hit = cache.get(id);
  if (hit) return hit;
  const node = g.nodes[id] as RoadNode;
  const s: NodeShape = { halfX: 0, halfZ: 0, square: false, posX: false, negX: false, posZ: false, negZ: false, surface: SURFACE.asphalt };
  const d = { x: 0, z: 0 };
  let best = 99;
  for (const eid of node.edges) {
    const e = g.edges[eid] as RoadEdge;
    leaving(e, id, d);
    if (d.x !== 0) {
      s.halfZ = Math.max(s.halfZ, e.width / 2);
      if (d.x > 0) s.posX = true; else s.negX = true;
    } else {
      s.halfX = Math.max(s.halfX, e.width / 2);
      if (d.z > 0) s.posZ = true; else s.negZ = true;
    }
    if (e.roadClass < best) { best = e.roadClass; s.surface = e.surface; }
  }
  s.square = s.halfX > 0 && s.halfZ > 0;
  cache.set(id, s);
  return s;
}

/** Straight edge frame: start point, unit direction, right vector = (-uz, ux). */
interface EdgeFrame {
  ax: number;
  az: number;
  ux: number;
  uz: number;
  length: number;
  alongX: boolean;
}

function edgeFrame(e: RoadEdge, out: EdgeFrame): EdgeFrame {
  const p = e.points;
  const n = p.length;
  out.ax = p[0] ?? 0;
  out.az = p[1] ?? 0;
  const dx = (p[n - 2] ?? 0) - out.ax, dz = (p[n - 1] ?? 0) - out.az;
  out.length = Math.hypot(dx, dz);
  out.alongX = Math.abs(dx) >= Math.abs(dz);
  out.ux = out.alongX ? Math.sign(dx) : 0;
  out.uz = out.alongX ? 0 : Math.sign(dz);
  return out;
}

/** Edge-space rectangle [s0, s1] x [l0, l1] (l + = right of from -> to) as a clipped upward quad. */
function edgeRect(b: GroupBuilder, clip: Clip, f: EdgeFrame, s0: number, s1: number, l0: number, l1: number, y: number): void {
  if (s1 - s0 < 1e-3 || l1 - l0 < 1e-3) return;
  const rx = -f.uz, rz = f.ux;
  const x0 = f.ax + f.ux * s0 + rx * l0, z0 = f.az + f.uz * s0 + rz * l0;
  const x1 = f.ax + f.ux * s1 + rx * l1, z1 = f.az + f.uz * s1 + rz * l1;
  rectUp(b, clip, x0, z0, x1, z1, y);
}

/** True when the approach of `e` arriving at `node` must stop there (signal or stop sign). */
function approachStops(g: RoadGraph, e: RoadEdge, node: RoadNode): boolean {
  return node.junction === JUNCTION.signal || g.stopsAt(e.id, node.id);
}

interface Ctx {
  city: City;
  g: RoadGraph;
  clip: Clip;
  shapes: Map<number, NodeShape>;
  frame: EdgeFrame;
}

function edgeGround(ctx: Ctx, b: GroupBuilder, e: RoadEdge): void {
  const f = edgeFrame(e, ctx.frame);
  const from = nodeShape(ctx.g, e.from, ctx.shapes);
  const to = nodeShape(ctx.g, e.to, ctx.shapes);
  const trimOf = (s: NodeShape): number => (s.square ? (f.alongX ? s.halfX : s.halfZ) : 0);
  const trimA = trimOf(from), trimB = trimOf(to);
  const w = e.width / 2, m = e.median / 2;

  b.setColor(COLOR.surface[e.surface] ?? COLOR.surface[0] ?? 0);
  if (m > 0) {
    edgeRect(b, ctx.clip, f, trimA, f.length - trimB, -w, -m, GROUND_Y);
    edgeRect(b, ctx.clip, f, trimA, f.length - trimB, m, w, GROUND_Y);
    b.setColor(COLOR.median);
    edgeRect(b, ctx.clip, f, trimA, f.length - trimB, -m, m, GROUND_Y);
  } else {
    edgeRect(b, ctx.clip, f, trimA, f.length - trimB, -w, w, GROUND_Y);
  }
  if (e.sidewalk <= 0) return;
  b.setColor(COLOR.sidewalk);
  for (const side of [1, -1] as const) {
    // World direction of this side: right of travel (-uz, ux) times side.
    const sx = -f.uz * side, sz = f.ux * side;
    const sideTrim = (s: NodeShape, trim: number): number => {
      if (!s.square) return 0;
      const has = sx > 0 ? s.posX : sx < 0 ? s.negX : sz > 0 ? s.posZ : s.negZ;
      const lateralHalf = f.alongX ? s.halfZ : s.halfX;
      // Run through to the node centre only where nothing crosses on this side and the square is no wider than the road.
      return has || w + 1e-3 < lateralHalf ? trim : 0;
    };
    const a = sideTrim(from, trimA), c = sideTrim(to, trimB);
    if (side === 1) edgeRect(b, ctx.clip, f, a, f.length - c, w, w + e.sidewalk, GROUND_Y);
    else edgeRect(b, ctx.clip, f, a, f.length - c, -w - e.sidewalk, -w, GROUND_Y);
  }
}

function edgeMarkings(ctx: Ctx, b: GroupBuilder, e: RoadEdge): void {
  const f = edgeFrame(e, ctx.frame);
  const g = ctx.g;
  const fromNode = g.nodes[e.from] as RoadNode, toNode = g.nodes[e.to] as RoadNode;
  const from = nodeShape(g, e.from, ctx.shapes), to = nodeShape(g, e.to, ctx.shapes);
  const trimA = from.square ? (f.alongX ? from.halfX : from.halfZ) : 0;
  const trimB = to.square ? (f.alongX ? to.halfX : to.halfZ) : 0;
  const s0 = Math.max(fromNode.setback, trimA), s1 = f.length - Math.max(toNode.setback, trimB);
  const w = e.width / 2, m = e.median / 2, lw = e.laneWidth;
  const oneWay = e.lanesBackward === 0;
  const clip = ctx.clip;
  const line = (l: number, half: number): void => edgeRect(b, clip, f, s0, s1, l - half, l + half, MARKING_Y);
  const dashes = (l: number): void => {
    for (let s = s0 + 2; s + 3 <= s1; s += 12) edgeRect(b, clip, f, s, s + 3, l - 0.06, l + 0.06, MARKING_Y);
  };

  const plain = e.roadClass === ROAD_CLASS.gravel || e.roadClass === ROAD_CLASS.service;
  if (!plain) {
    // Centre: double yellow on two-way non-local roads, yellow edges of the median on divided roads.
    b.setColor(COLOR.yellow);
    if (!oneWay && m > 0) {
      line(m + 0.15, 0.07);
      line(-m - 0.15, 0.07);
    } else if (!oneWay && e.roadClass !== ROAD_CLASS.local) {
      line(0.12, 0.05);
      line(-0.12, 0.05);
    }
    b.setColor(COLOR.white);
    if (oneWay) {
      for (let k = 1; k < e.lanesForward; k++) dashes(-(e.lanesForward * lw) / 2 + k * lw);
    } else {
      for (let k = 1; k < e.lanesForward; k++) dashes(m + k * lw);
      for (let k = 1; k < e.lanesBackward; k++) dashes(-(m + k * lw));
    }
    if (e.shoulder >= 1) {
      line(w - e.shoulder, 0.07);
      line(-(w - e.shoulder), 0.07);
    }
  }

  // Stop lines and crosswalks at each end.
  b.setColor(COLOR.white);
  for (const atTo of [true, false]) {
    const node = atTo ? toNode : fromNode;
    const shape = atTo ? to : from;
    if (node.junction === JUNCTION.none || node.setback <= 0) continue;
    const trim = shape.square ? (f.alongX ? shape.halfX : shape.halfZ) : 0;
    // Edge-space s of a distance `d` measured from this node.
    const sAt = (d: number): number => (atTo ? f.length - d : d);
    const lanes = atTo ? e.lanesForward : e.lanesBackward;
    if (lanes > 0 && approachStops(g, e, node)) {
      let l0: number, l1: number;
      if (oneWay) { l0 = -(lanes * lw) / 2; l1 = (lanes * lw) / 2; }
      else if (atTo) { l0 = Math.max(m, 0.2); l1 = m + lanes * lw; }
      else { l0 = -(m + lanes * lw); l1 = -Math.max(m, 0.2); }
      const a = sAt(node.setback), c = sAt(node.setback + 0.45);
      edgeRect(b, clip, f, Math.min(a, c), Math.max(a, c), l0, l1, MARKING_Y);
    }
    if (e.sidewalk > 0) {
      const d0 = Math.max(trim + 0.2, node.setback - 3.2), d1 = node.setback - 0.2;
      if (d1 - d0 < 0.8) continue;
      const a = sAt(d0), c = sAt(d1);
      for (let l = -w + 0.4; l + 0.5 <= w - 0.2; l += 1.1) edgeRect(b, clip, f, Math.min(a, c), Math.max(a, c), l, l + 0.55, MARKING_Y);
    }
  }
}

// --- Buildings ---------------------------------------------------------------------

function building(b: GroupBuilder, x0: number, z0: number, x1: number, z1: number, h: number, roof: number, color: number, lod: 0 | 1): void {
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const hx = (x1 - x0) / 2, hz = (z1 - z0) / 2;
  const pitched = roof === ROOF.pitched;
  const rh = pitched ? Math.min(4, Math.min(hx, hz) * 0.6) : 0;
  const top = lod === 1 ? h + rh * 0.5 : h;
  b.setColor(color);
  b.wallUv = true;
  face(b, x1, top / 2, cz, 0, 0, hz, 0, top / 2, 0, 1, 0, 0);
  face(b, x0, top / 2, cz, 0, 0, hz, 0, top / 2, 0, -1, 0, 0);
  face(b, cx, top / 2, z1, hx, 0, 0, 0, top / 2, 0, 0, 0, 1);
  face(b, cx, top / 2, z0, hx, 0, 0, 0, top / 2, 0, 0, 0, -1);
  b.wallUv = false;
  if (!pitched || lod === 1) {
    if (pitched) b.setColor(pick(ROOF_TILES, hash01(cx, cz, 7)));
    else b.setColor(color, 0.55);
    face(b, cx, top, cz, hx, 0, 0, 0, 0, hz, 0, 1, 0);
    return;
  }
  // Gable roof with the ridge along the longer side.
  b.setColor(color);
  const ridge = h + rh;
  if (hx >= hz) {
    b.tri(x1, h, z0, x1, h, z1, x1, ridge, cz, 1, 0, 0);
    b.tri(x0, h, z0, x0, h, z1, x0, ridge, cz, -1, 0, 0);
    b.setColor(pick(ROOF_TILES, hash01(cx, cz, 7)));
    b.quad(x0, h, z1, 2 * hx, 0, 0, 0, rh, -hz, 0, 1, 1);
    b.quad(x0, h, z0, 2 * hx, 0, 0, 0, rh, hz, 0, 1, -1);
  } else {
    b.tri(x0, h, z1, x1, h, z1, cx, ridge, z1, 0, 0, 1);
    b.tri(x0, h, z0, x1, h, z0, cx, ridge, z0, 0, 0, -1);
    b.setColor(pick(ROOF_TILES, hash01(cx, cz, 7)));
    b.quad(x1, h, z0, 0, 0, 2 * hz, -hx, rh, 0, 1, 1, 0);
    b.quad(x0, h, z0, 0, 0, 2 * hz, hx, rh, 0, -1, 1, 0);
  }
}

// --- Props, lamps, signs -----------------------------------------------------------

const scratchLamp = { x: 0, y: 0, z: 0 };

function lampHead(b: GroupBuilder, kind: number, x: number, z: number, yaw: number): void {
  const p = lampHeadPosition(kind, x, z, yaw, scratchLamp);
  b.setColor(COLOR.lamp);
  if (kind === PROP.streetlight) box(b, p.x, p.y, p.z, 0.35, 0.07, 0.16, yaw, true);
  else box(b, p.x, p.y, p.z, 0.4, 0.08, 0.4, yaw, true);
}

function prop(b: GroupBuilder, kind: number, x: number, z: number, yaw: number, scale: number): void {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  switch (kind) {
    case PROP.streetlight:
      b.setColor(COLOR.grey);
      box(b, x, STREETLIGHT_HEIGHT / 2, z, 0.1, STREETLIGHT_HEIGHT / 2, 0.1, yaw);
      box(b, x + c * (ARM_LENGTH / 2), STREETLIGHT_HEIGHT - 0.15, z - s * (ARM_LENGTH / 2), ARM_LENGTH / 2, 0.05, 0.05, yaw, true);
      return;
    case PROP.lotLight:
      b.setColor(COLOR.grey);
      box(b, x, LOT_LIGHT_POLE / 2 - 0.25, z, 0.12, LOT_LIGHT_POLE / 2 - 0.25, 0.12, 0);
      return;
    case PROP.tree:
      b.setColor(COLOR.trunk);
      box(b, x, 1.6 * scale, z, 0.18 * scale, 1.6 * scale, 0.18 * scale, yaw);
      b.setColor(pick(FOLIAGE, hash01(x, z, 1)));
      diamond(b, x, 4.4 * scale, z, 2.3 * scale, 2.4 * scale, yaw);
      return;
    case PROP.bush:
      b.setColor(pick(FOLIAGE, hash01(x, z, 2)), 0.85);
      diamond(b, x, 0.6 * scale, z, 0.9 * scale, 0.6 * scale, yaw);
      return;
    case PROP.hydrant:
      b.setColor(COLOR.red);
      box(b, x, 0.35, z, 0.14, 0.35, 0.14, yaw);
      box(b, x, 0.55, z, 0.22, 0.05, 0.06, yaw);
      return;
    case PROP.bench:
      b.setColor(COLOR.wood);
      box(b, x, 0.42, z, 0.9, 0.04, 0.22, yaw, true);
      box(b, x + s * 0.2, 0.68, z + c * 0.2, 0.9, 0.2, 0.03, yaw, true);
      b.setColor(COLOR.darkGrey);
      box(b, x + c * 0.75, 0.19, z - s * 0.75, 0.04, 0.19, 0.2, yaw);
      box(b, x - c * 0.75, 0.19, z + s * 0.75, 0.04, 0.19, 0.2, yaw);
      return;
    case PROP.cone:
      b.setColor(COLOR.orange);
      pyramid(b, x, z, 0.2, 0.7);
      return;
    case PROP.barrier:
      b.setColor(COLOR.orange);
      box(b, x, 0.25, z, 1.0, 0.25, 0.1, yaw);
      b.setColor(COLOR.white);
      box(b, x, 0.65, z, 1.0, 0.15, 0.1, yaw);
      return;
    case PROP.container: {
      const [len, wid, h] = CONTAINER_SIZE;
      b.setColor(pick(CONTAINERS, hash01(x, z, 3)));
      box(b, x, (h * scale) / 2, z, wid / 2, (h * scale) / 2, len / 2, yaw);
      return;
    }
    case PROP.fuelPump:
      b.setColor(COLOR.pump);
      box(b, x, 0.75, z, 0.5, 0.75, 0.35, yaw);
      b.setColor(COLOR.red);
      box(b, x, 1.65, z, 0.52, 0.15, 0.37, yaw);
      return;
    case PROP.bollard:
      b.setColor(COLOR.bollard);
      box(b, x, 0.45, z, 0.1, 0.45, 0.1, yaw);
      return;
    default:
      return;
  }
}

/** Sign face drawing frame: centre, viewer's right (rx, rz), facing normal (nx, nz). */
interface SignFrame {
  x: number;
  y: number;
  z: number;
  rx: number;
  rz: number;
  nx: number;
  nz: number;
}

/** Rectangle in face coordinates (metres from the centre), `d` metres in front of the face. */
function signRect(b: GroupBuilder, f: SignFrame, x0: number, y0: number, x1: number, y1: number, d: number, back = false): void {
  const n = back ? -1 : 1;
  b.quad(f.x + f.rx * x0 + f.nx * d, f.y + y0, f.z + f.rz * x0 + f.nz * d, f.rx * (x1 - x0), 0, f.rz * (x1 - x0), 0, y1 - y0, 0, f.nx * n, 0, f.nz * n);
}

/** Regular polygon in face coordinates; `rot` is the angle of the first vertex. */
function signPoly(b: GroupBuilder, f: SignFrame, sides: number, r: number, rot: number, d: number, back = false): void {
  const cx = f.x + f.nx * d, cz = f.z + f.nz * d;
  const n = back ? -1 : 1;
  for (let k = 0; k < sides; k++) {
    const a0 = rot + (2 * Math.PI * k) / sides, a1 = rot + (2 * Math.PI * (k + 1)) / sides;
    b.tri(
      cx, f.y, cz,
      cx + f.rx * Math.cos(a0) * r, f.y + Math.sin(a0) * r, cz + f.rz * Math.cos(a0) * r,
      cx + f.rx * Math.cos(a1) * r, f.y + Math.sin(a1) * r, cz + f.rz * Math.cos(a1) * r,
      f.nx * n, 0, f.nz * n,
    );
  }
}

/** One 7-segment digit with its lower-left corner at (x, y). */
function digit(b: GroupBuilder, f: SignFrame, value: number, x: number, y: number, d: number): void {
  const w = 0.13, h = 0.26, t = 0.035;
  const bits = SEGMENTS[value] ?? 0;
  if (bits & 1) signRect(b, f, x, y + h - t, x + w, y + h, d);
  if (bits & 2) signRect(b, f, x + w - t, y + h / 2, x + w, y + h, d);
  if (bits & 4) signRect(b, f, x + w - t, y, x + w, y + h / 2, d);
  if (bits & 8) signRect(b, f, x, y, x + w, y + t, d);
  if (bits & 16) signRect(b, f, x, y, x + t, y + h / 2, d);
  if (bits & 32) signRect(b, f, x, y + h / 2, x + t, y + h, d);
  if (bits & 64) signRect(b, f, x, y + h / 2 - t / 2, x + w, y + h / 2 + t / 2, d);
}

const signFrame: SignFrame = { x: 0, y: 0, z: 0, rx: 0, rz: 0, nx: 0, nz: 0 };

function sign(b: GroupBuilder, kind: number, x: number, z: number, yaw: number, value: number): void {
  // The face looks along the yaw heading (-sin, -cos); the viewer's right is (-cos, sin).
  const f = signFrame;
  f.nx = -Math.sin(yaw);
  f.nz = -Math.cos(yaw);
  f.rx = f.nz;
  f.rz = -f.nx;
  f.x = x + f.nx * 0.06;
  f.y = SIGN_Y;
  f.z = z + f.nz * 0.06;
  b.setColor(COLOR.grey);
  box(b, x, (SIGN_Y - 0.1) / 2, z, 0.04, (SIGN_Y - 0.1) / 2, 0.04, yaw);
  const d = 0.015;
  switch (kind) {
    case SIGN.stop:
      signPoly(b, f, 8, 0.4, Math.PI / 8, -d, true);
      b.setColor(COLOR.white);
      signPoly(b, f, 8, 0.4, Math.PI / 8, 0);
      b.setColor(COLOR.red);
      signPoly(b, f, 8, 0.36, Math.PI / 8, d);
      b.setColor(COLOR.white);
      signRect(b, f, -0.24, -0.05, 0.24, 0.05, 2 * d);
      return;
    case SIGN.yield:
      signPoly(b, f, 3, 0.48, -Math.PI / 2, -d, true);
      b.setColor(COLOR.red);
      signPoly(b, f, 3, 0.48, -Math.PI / 2, 0);
      b.setColor(COLOR.white);
      signPoly(b, f, 3, 0.28, -Math.PI / 2, d);
      return;
    case SIGN.speedLimit: {
      signRect(b, f, -0.3, -0.38, 0.3, 0.38, -d, true);
      b.setColor(COLOR.black);
      signRect(b, f, -0.3, -0.38, 0.3, 0.38, 0);
      b.setColor(COLOR.white);
      signRect(b, f, -0.27, -0.35, 0.27, 0.35, d);
      b.setColor(COLOR.black);
      signRect(b, f, -0.19, 0.2, 0.19, 0.26, 2 * d);
      const v = Math.max(0, Math.min(99, Math.round(value)));
      if (v >= 10) {
        digit(b, f, Math.floor(v / 10), -0.155, -0.24, 2 * d);
        digit(b, f, v % 10, 0.025, -0.24, 2 * d);
      } else {
        digit(b, f, v, -0.065, -0.24, 2 * d);
      }
      return;
    }
    case SIGN.schoolZone:
      signPoly(b, f, 5, 0.44, Math.PI / 2, -d, true);
      b.setColor(COLOR.black);
      signPoly(b, f, 5, 0.44, Math.PI / 2, 0);
      b.setColor(COLOR.yellowGreen);
      signPoly(b, f, 5, 0.4, Math.PI / 2, d);
      b.setColor(COLOR.black);
      signRect(b, f, -0.14, -0.2, -0.06, 0.08, 2 * d);
      signRect(b, f, 0.06, -0.2, 0.14, 0.02, 2 * d);
      return;
    case SIGN.oneWay:
      // Faces oncoming traffic, so the arrow points up: straight ahead along the street.
      signRect(b, f, -0.16, -0.45, 0.16, 0.45, -d, true);
      b.setColor(COLOR.black);
      signRect(b, f, -0.16, -0.45, 0.16, 0.45, 0);
      b.setColor(COLOR.white);
      signRect(b, f, -0.04, -0.33, 0.04, 0.15, d);
      b.tri(
        f.x + f.rx * 0.11 + f.nx * d, f.y + 0.15, f.z + f.rz * 0.11 + f.nz * d,
        f.x - f.rx * 0.11 + f.nx * d, f.y + 0.15, f.z - f.rz * 0.11 + f.nz * d,
        f.x + f.nx * d, f.y + 0.36, f.z + f.nz * d,
        f.nx, 0, f.nz,
      );
      return;
    case SIGN.construction:
      signPoly(b, f, 4, 0.45, 0, -d, true);
      b.setColor(COLOR.orange);
      signPoly(b, f, 4, 0.45, 0, 0);
      b.setColor(COLOR.black);
      signRect(b, f, -0.12, -0.04, 0.12, 0.04, d);
      signRect(b, f, -0.04, -0.15, 0.04, 0.15, d);
      return;
    case SIGN.noEntry:
      signPoly(b, f, 16, 0.38, 0, -d, true);
      b.setColor(COLOR.red);
      signPoly(b, f, 16, 0.38, 0, 0);
      b.setColor(COLOR.white);
      signRect(b, f, -0.26, -0.06, 0.26, 0.06, d);
      return;
    default:
      return;
  }
}

// --- Chunk -------------------------------------------------------------------------

function blockGroundColor(surface: number, kind: number): number {
  switch (kind) {
    case BLOCK_KIND.water: return COLOR.water;
    case BLOCK_KIND.runway: return COLOR.runway;
    case BLOCK_KIND.parking: return COLOR.parking;
    case BLOCK_KIND.farm: return COLOR.farm;
    default: return COLOR.surface[surface] ?? COLOR.surface[0] ?? 0;
  }
}

/**
 * Merged meshes of one chunk. LOD0: ground, markings, buildings (gabled roofs),
 * props (with sign faces) and lamp heads; LOD1: ground, box buildings and lamp
 * heads. Both draw the quay and world boundary walls. Deterministic for a given city and layout.
 */
export function buildChunkMesh(city: City, layout: ChunkLayout, lod: 0 | 1): ChunkMeshData {
  const g = city.graph;
  // Edge chunks reach past the world edge, so the outer half of the perimeter roads is drawn.
  const clip: Clip = chunkBounds(layout.cx, layout.cz);
  const minX = layout.cx * CHUNK_SIZE, minZ = layout.cz * CHUNK_SIZE;
  const ctx: Ctx = { city, g, clip, shapes: new Map(), frame: { ax: 0, az: 0, ux: 1, uz: 0, length: 0, alongX: true } };
  const ground = new GroupBuilder('ground', false);
  const markings = new GroupBuilder('markings', false);
  const buildings = new GroupBuilder('buildings', true);
  const props = new GroupBuilder('props', false);
  const lamps = new GroupBuilder('lamps', false);

  // Ground: a base slab under everything (fills gaps), blocks, roads, sidewalks, junctions.
  const district = city.districtAt(minX + CHUNK_SIZE / 2, minZ + CHUNK_SIZE / 2);
  ground.setColor(COLOR.surface[districtType(district).ground] ?? COLOR.surface[0] ?? 0);
  rectUp(ground, clip, clip.minX, clip.minZ, clip.maxX, clip.maxZ, BASE_Y);
  const gr = layout.ground;
  for (let i = 0; i + GROUND_STRIDE <= gr.length; i += GROUND_STRIDE) {
    const kind = gr[i + 5] ?? 0;
    ground.setColor(blockGroundColor(gr[i + 4] ?? 0, kind));
    rectUp(ground, clip, gr[i] ?? 0, gr[i + 1] ?? 0, gr[i + 2] ?? 0, gr[i + 3] ?? 0, kind === BLOCK_KIND.water ? WATER_Y : GROUND_Y);
  }

  for (const id of layout.edges) {
    const e = g.edges[id] as RoadEdge;
    edgeGround(ctx, ground, e);
    if (lod === 0) edgeMarkings(ctx, markings, e);
  }
  for (const id of layout.nodes) {
    const n = g.nodes[id] as RoadNode;
    const s = nodeShape(g, id, ctx.shapes);
    if (!s.square) continue;
    ground.setColor(COLOR.surface[s.surface] ?? COLOR.surface[0] ?? 0);
    rectUp(ground, clip, n.x - s.halfX, n.z - s.halfZ, n.x + s.halfX, n.z + s.halfZ, JUNCTION_Y);
  }

  const bl = layout.buildings;
  for (let i = 0; i + BUILDING_STRIDE <= bl.length; i += BUILDING_STRIDE) {
    building(buildings, bl[i] ?? 0, bl[i + 1] ?? 0, bl[i + 2] ?? 0, bl[i + 3] ?? 0, bl[i + 4] ?? 0, bl[i + 5] ?? 0, (bl[i + 6] ?? 0) | 0, lod);
  }
  // Quay and world boundary walls: plain (windowless) concrete in the buildings group, so both LODs draw them.
  buildings.wallUv = false;
  buildings.setColor(COLOR.concrete);
  const wl = layout.walls;
  for (let i = 0; i + COLLIDER_STRIDE <= wl.length; i += COLLIDER_STRIDE) {
    box(buildings, wl[i] ?? 0, wl[i + 1] ?? 0, wl[i + 2] ?? 0, wl[i + 3] ?? 0, wl[i + 4] ?? 0, wl[i + 5] ?? 0, wl[i + 6] ?? 0);
  }

  const pr = layout.props;
  for (let i = 0; i + PROP_STRIDE <= pr.length; i += PROP_STRIDE) {
    const kind = pr[i] ?? 0, x = pr[i + 1] ?? 0, z = pr[i + 2] ?? 0, yaw = pr[i + 3] ?? 0, scale = pr[i + 4] ?? 1;
    if (kind === PROP.streetlight || kind === PROP.lotLight) lampHead(lamps, kind, x, z, yaw);
    if (lod === 0) prop(props, kind, x, z, yaw, scale);
  }
  if (lod === 0) {
    const sg = layout.signs;
    for (let i = 0; i + SIGN_STRIDE <= sg.length; i += SIGN_STRIDE) sign(props, sg[i] ?? 0, sg[i + 1] ?? 0, sg[i + 2] ?? 0, sg[i + 3] ?? 0, sg[i + 4] ?? 0);
  }

  const groups: ChunkMeshGroup[] = [];
  for (const builder of [ground, markings, buildings, props, lamps]) {
    const group = builder.finish();
    if (group) groups.push(group);
  }
  return { cx: layout.cx, cz: layout.cz, lod, groups };
}

/** The transferable buffers of a mesh (for postMessage transfer lists). */
export function chunkMeshTransferables(data: ChunkMeshData): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const g of data.groups) {
    out.push(g.positions.buffer as ArrayBuffer, g.normals.buffer as ArrayBuffer, g.colors.buffer as ArrayBuffer, g.indices.buffer as ArrayBuffer);
    if (g.uvs) out.push(g.uvs.buffer as ArrayBuffer);
  }
  return out;
}

