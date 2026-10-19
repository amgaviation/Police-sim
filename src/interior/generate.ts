/**
 * Deterministic interior generator (design §5.3). Pure: draws only from
 * `createRng(seed).stream('interior:' + buildingId)`, in the order the design lists the steps.
 *
 * Layout is computed in a local frame (u along the front wall, v inward, origin at the front-left corner of the
 * extent) and converted to world coordinates at the end. All coordinates are rounded to 0.05 m.
 */
import { createRng, type Rng } from '../core/rng';
import type { BuildingInfo, FrontSide } from '../world/buildings';
import { frontYaw } from '../world/buildings';
import { DOOR_WIDTH, INTERIOR_FLOOR_Y, MIN_ROOM_SIDE } from './constants';
import {
  INTERIOR_TEMPLATES,
  type BuildingTemplate,
  type DoorSide,
  type FurnitureDef,
  type RoomDef,
  type TemplateSet,
} from './templates';
import type {
  FurnitureItem,
  HidingSpot,
  InteriorDoor,
  InteriorLayout,
  InteriorPoint,
  InteriorRoom,
  ItemSpot,
  Rect,
  RoomKind,
  SpawnSpot,
} from './types';

const EPS = 1e-6;
const TRIES = 8;
const FURNITURE_GAP = 0.3;
const WALL_BACK = 0.05;
const CORNER_MARGIN = 0.1;
const CLEARANCE_SIDE = 0.3;
const CLEARANCE_DEPTH = 1.0;
const EXIT_DISTANCE = 0.8;

const r05 = (v: number): number => Math.round(v * 20) / 20 + 0;
const r01 = (v: number): number => Math.round(v * 10) / 10 + 0;
const ceil05 = (v: number): number => Math.ceil(v * 20 - 1e-6) / 20 + 0;
const floor05 = (v: number): number => Math.floor(v * 20 + 1e-6) / 20 + 0;

// --- Local frame -------------------------------------------------------------------------------

interface LRect { u0: number; v0: number; u1: number; v1: number }

interface Frame {
  /** World position of local (0, 0). */
  ox: number; oz: number;
  /** World direction of +u and +v. */
  ux: number; uz: number; vx: number; vz: number;
  /** Extent size in the local frame. */
  W: number; D: number;
  front: FrontSide;
}

function worldX(f: Frame, u: number, v: number): number { return r05(f.ox + f.ux * u + f.vx * v); }
function worldZ(f: Frame, u: number, v: number): number { return r05(f.oz + f.uz * u + f.vz * v); }

function worldRect(f: Frame, r: LRect): Rect {
  const xa = worldX(f, r.u0, r.v0), xb = worldX(f, r.u1, r.v1);
  const za = worldZ(f, r.u0, r.v0), zb = worldZ(f, r.u1, r.v1);
  return { minX: Math.min(xa, xb), minZ: Math.min(za, zb), maxX: Math.max(xa, xb), maxZ: Math.max(za, zb) };
}

function sideOfDirection(dx: number, dz: number): FrontSide {
  if (Math.abs(dz) >= Math.abs(dx)) return dz < 0 ? 0 : 2;
  return dx > 0 ? 1 : 3;
}

// --- Working structures ------------------------------------------------------------------------

/** One room to place: a template def instance. */
interface Slot { def: RoomDef; defIndex: number; inst: number }

interface Part { rect: LRect; kind: RoomKind; def: RoomDef }

/** A door in the local frame: `span` is the local axis the opening runs along. */
interface LDoor {
  a: number; b: number;
  u: number; v: number;
  span: 'u' | 'v';
  width: number;
  main: boolean;
  /** Local side of the extent for exterior doors. */
  side: DoorSide | null;
}

interface Leaf { r: LRect; splittable: boolean }

interface TreeNode {
  leaf: number;
  axis: 'u' | 'v';
  coord: number;
  a: TreeNode | null;
  b: TreeNode | null;
}

interface Bsp { leaves: Leaf[]; nodes: TreeNode[] }

function dropOne(list: Slot[], allowSingles: boolean, keep: Slot | null): boolean {
  for (let i = list.length - 1; i >= 0; i--) {
    if (!(list[i] as Slot).def.required) { list.splice(i, 1); return true; }
  }
  for (let i = list.length - 1; i >= 0; i--) {
    if ((list[i] as Slot).inst > 0) { list.splice(i, 1); return true; }
  }
  if (allowSingles) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] !== keep) { list.splice(i, 1); return true; }
    }
  }
  return false;
}

function leafArea(r: LRect): number { return (r.u1 - r.u0) * (r.v1 - r.v0); }

/** BSP split of `extent` into up to `n` leaves (design §5.3 step 3). */
function bspSplit(rng: Rng, extent: LRect, n: number): Bsp {
  const root: TreeNode = { leaf: 0, axis: 'u', coord: 0, a: null, b: null };
  const leaves: Leaf[] = [{ r: extent, splittable: true }];
  const leafNodes: TreeNode[] = [root];
  const nodes: TreeNode[] = [];
  while (leaves.length < n) {
    let pick = -1;
    let best = -1;
    for (let i = 0; i < leaves.length; i++) {
      const l = leaves[i] as Leaf;
      if (!l.splittable) continue;
      const a = leafArea(l.r);
      if (a > best) { best = a; pick = i; }
    }
    if (pick < 0) break;
    const leaf = leaves[pick] as Leaf;
    const r = leaf.r;
    const w = r.u1 - r.u0, h = r.v1 - r.v0;
    const axes: ('u' | 'v')[] = w >= h ? ['u', 'v'] : ['v', 'u'];
    let done = false;
    for (const ax of axes) {
      const lo = ax === 'u' ? r.u0 : r.v0;
      const hi = ax === 'u' ? r.u1 : r.v1;
      if (hi - lo < 2 * MIN_ROOM_SIDE - EPS) continue;
      const t = rng.nextFloat(0.4, 0.6);
      let coord = r01(lo + t * (hi - lo));
      coord = r05(Math.min(hi - MIN_ROOM_SIDE, Math.max(lo + MIN_ROOM_SIDE, coord)));
      const a: LRect = ax === 'u' ? { u0: r.u0, v0: r.v0, u1: coord, v1: r.v1 } : { u0: r.u0, v0: r.v0, u1: r.u1, v1: coord };
      const b: LRect = ax === 'u' ? { u0: coord, v0: r.v0, u1: r.u1, v1: r.v1 } : { u0: r.u0, v0: coord, u1: r.u1, v1: r.v1 };
      const node = leafNodes[pick] as TreeNode;
      node.axis = ax;
      node.coord = coord;
      node.a = { leaf: pick, axis: 'u', coord: 0, a: null, b: null };
      node.b = { leaf: leaves.length, axis: 'u', coord: 0, a: null, b: null };
      node.leaf = -1;
      leafNodes[pick] = node.a;
      leafNodes.push(node.b);
      nodes.push(node);
      leaf.r = a;
      leaves.push({ r: b, splittable: true });
      done = true;
      break;
    }
    if (!done) leaf.splittable = false;
  }
  return { leaves, nodes };
}

function leavesOf(node: TreeNode, out: number[]): number[] {
  if (node.leaf >= 0) out.push(node.leaf);
  else {
    if (node.a) leavesOf(node.a, out);
    if (node.b) leavesOf(node.b, out);
  }
  return out;
}

interface BspDoor { a: number; b: number; u: number; v: number; span: 'u' | 'v' }

/** One door per internal node: the largest-overlap pair across the cut (a spanning tree of the leaves). */
function bspDoors(bsp: Bsp): BspDoor[] {
  const doors: BspDoor[] = [];
  for (const node of bsp.nodes) {
    const as = leavesOf(node.a as TreeNode, []).sort((x, y) => x - y);
    const bs = leavesOf(node.b as TreeNode, []).sort((x, y) => x - y);
    let best: { a: number; b: number; lo: number; hi: number } | null = null;
    for (const a of as) {
      const ra = (bsp.leaves[a] as Leaf).r;
      if ((node.axis === 'u' ? ra.u1 : ra.v1) !== node.coord) continue;
      for (const b of bs) {
        const rb = (bsp.leaves[b] as Leaf).r;
        if ((node.axis === 'u' ? rb.u0 : rb.v0) !== node.coord) continue;
        const lo = node.axis === 'u' ? Math.max(ra.v0, rb.v0) : Math.max(ra.u0, rb.u0);
        const hi = node.axis === 'u' ? Math.min(ra.v1, rb.v1) : Math.min(ra.u1, rb.u1);
        if (hi - lo <= 0) continue;
        if (best === null || hi - lo > best.hi - best.lo) best = { a, b, lo, hi };
      }
    }
    if (best === null) continue;
    const mid = r05((best.lo + best.hi) / 2);
    if (node.axis === 'u') doors.push({ a: best.a, b: best.b, u: node.coord, v: mid, span: 'v' });
    else doors.push({ a: best.a, b: best.b, u: mid, v: node.coord, span: 'u' });
  }
  return doors;
}

/** Kinds zipped onto leaves: the entry leaf (if any) takes the first slot, the rest by size / area. */
function assignKinds(slots: readonly Slot[], bsp: Bsp, entryLeaf: number): (Slot | undefined)[] {
  const out = new Array<Slot | undefined>(bsp.leaves.length).fill(undefined);
  const rest = slots.slice(entryLeaf >= 0 ? 1 : 0).sort((a, b) => b.def.size - a.def.size);
  if (entryLeaf >= 0) out[entryLeaf] = slots[0];
  const order: number[] = [];
  for (let i = 0; i < bsp.leaves.length; i++) if (i !== entryLeaf) order.push(i);
  order.sort((x, y) => leafArea((bsp.leaves[y] as Leaf).r) - leafArea((bsp.leaves[x] as Leaf).r) || x - y);
  order.forEach((leaf, k) => { out[leaf] = rest[k]; });
  return out;
}

function childDef(tpl: BuildingTemplate, kind: RoomKind): RoomDef {
  return tpl.rooms.find((r) => r.child && r.kind === kind) as RoomDef;
}

// --- Generator ---------------------------------------------------------------------------------

/** Deterministic layout for (seed, building); null when the building has no kind or no template fits. */
export function generateInterior(seed: number, building: BuildingInfo, templates: TemplateSet = INTERIOR_TEMPLATES): InteriorLayout | null {
  if (building.kind === null) return null;
  const tpl = templates.templates[building.kind];
  const rng = createRng(seed).stream(`interior:${building.id}`);

  // 1. Frame.
  const f = building.front;
  const bw = building.maxX - building.minX, bd = building.maxZ - building.minZ;
  const W = f === 0 || f === 2 ? bw : bd;
  const D = f === 0 || f === 2 ? bd : bw;
  const Wp = Math.min(W, tpl.maxWidth), Dp = Math.min(D, tpl.maxDepth);
  if (Wp < tpl.minWidth - EPS || Dp < tpl.minDepth - EPS) return null;
  const uA = (W - Wp) / 2, uB = uA + Wp;
  let ex0: number, ex1: number, ez0: number, ez1: number;
  switch (f) {
    case 0: ex0 = building.minX + uA; ex1 = building.minX + uB; ez0 = building.minZ; ez1 = building.minZ + Dp; break;
    case 2: ex0 = building.maxX - uB; ex1 = building.maxX - uA; ez0 = building.maxZ - Dp; ez1 = building.maxZ; break;
    case 1: ex0 = building.maxX - Dp; ex1 = building.maxX; ez0 = building.minZ + uA; ez1 = building.minZ + uB; break;
    default: ex0 = building.minX; ex1 = building.minX + Dp; ez0 = building.maxZ - uB; ez1 = building.maxZ - uA; break;
  }
  ex0 = ceil05(ex0); ez0 = ceil05(ez0); ex1 = floor05(ex1); ez1 = floor05(ez1);
  const frame: Frame = f === 0
    ? { ox: ex0, oz: ez0, ux: 1, uz: 0, vx: 0, vz: 1, W: r05(ex1 - ex0), D: r05(ez1 - ez0), front: f }
    : f === 2
      ? { ox: ex1, oz: ez1, ux: -1, uz: 0, vx: 0, vz: -1, W: r05(ex1 - ex0), D: r05(ez1 - ez0), front: f }
      : f === 1
        ? { ox: ex1, oz: ez0, ux: 0, uz: 1, vx: -1, vz: 0, W: r05(ez1 - ez0), D: r05(ex1 - ex0), front: f }
        : { ox: ex0, oz: ez1, ux: 0, uz: -1, vx: 1, vz: 0, W: r05(ez1 - ez0), D: r05(ex1 - ex0), front: f };
  const Wx = frame.W, Dx = frame.D;
  const extent: LRect = { u0: 0, v0: 0, u1: Wx, v1: Dx };

  // 2. Room list.
  const list: Slot[] = [];
  tpl.rooms.forEach((def, defIndex) => {
    if (def.child) return;
    const n = def.required ? rng.nextInt(def.count[0], def.count[1]) : rng.chance(def.chance) ? rng.nextInt(def.count[0], def.count[1]) : 0;
    for (let inst = 0; inst < n; inst++) list.push({ def, defIndex, inst });
  });
  const entryAt = list.findIndex((s) => s.def.kind === tpl.entry && s.inst === 0);
  const entrySlot = list[entryAt] as Slot;
  list.splice(entryAt, 1);
  list.unshift(entrySlot);
  const cap = Math.max(1, Math.floor((Wx * Dx) / tpl.minRoomArea));
  while (list.length > cap && dropOne(list, false, entrySlot)) { /* drop */ }

  // 3. Partition.
  const parts: Part[] = [];
  const doors: LDoor[] = [];
  const corridorAvailable = tpl.layout === 'corridor' && tpl.corridor !== null && Dx >= 2 * MIN_ROOM_SIDE + tpl.corridor.width - EPS;
  if (corridorAvailable && tpl.corridor) {
    partitionCorridor(rng, tpl, tpl.corridor, list, entrySlot, Wx, Dx, parts, doors);
  } else {
    const bsp = bspSplit(rng, extent, list.length);
    while (list.length > bsp.leaves.length && dropOne(list, true, entrySlot)) { /* drop */ }
    const mid = Wx / 2;
    let entryLeaf = -1;
    for (let i = 0; i < bsp.leaves.length; i++) {
      const r = (bsp.leaves[i] as Leaf).r;
      if (r.v0 === 0 && r.u0 < mid && mid <= r.u1) { entryLeaf = i; break; }
    }
    const kinds = assignKinds(list, bsp, entryLeaf);
    bsp.leaves.forEach((leaf, i) => {
      const slot = kinds[i] as Slot;
      parts.push({ rect: leaf.r, kind: slot.def.kind, def: slot.def });
    });
    for (const d of bspDoors(bsp)) doors.push({ a: d.a, b: d.b, u: d.u, v: d.v, span: d.span, width: DOOR_WIDTH, main: false, side: null });
  }

  // 4. Exterior doors.
  const entryPart = parts.findIndex((p) => p.def === entrySlot.def && p.rect.v0 === 0 && p.kind === tpl.entry);
  const entryRoom = entryPart >= 0 ? entryPart : parts.findIndex((p) => p.rect.v0 === 0);
  const er = (parts[entryRoom] as Part).rect;
  const half = tpl.mainDoorWidth / 2 + 0.2;
  const mainU = r05(Math.min(er.u1 - half, Math.max(er.u0 + half, Wx / 2)));
  doors.push({ a: entryRoom, b: -1, u: mainU, v: 0, span: 'u', width: tpl.mainDoorWidth, main: true, side: 'front' });
  for (const ed of tpl.exteriorDoors) {
    if (!rng.chance(ed.chance)) continue;
    const width = ed.width ?? DOOR_WIDTH;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i] as Part;
      if (p.kind !== ed.room) continue;
      const r = p.rect;
      let seg: [number, number] | null = null;
      let u = 0, v = 0;
      let span: 'u' | 'v' = 'u';
      if (ed.side === 'front' && r.v0 === 0) { seg = [r.u0, r.u1]; u = r05((r.u0 + r.u1) / 2); v = 0; }
      else if (ed.side === 'back' && r.v1 === Dx) { seg = [r.u0, r.u1]; u = r05((r.u0 + r.u1) / 2); v = Dx; }
      else if (ed.side === 'left' && r.u0 === 0) { seg = [r.v0, r.v1]; span = 'v'; v = r05((r.v0 + r.v1) / 2); u = 0; }
      else if (ed.side === 'right' && r.u1 === Wx) { seg = [r.v0, r.v1]; span = 'v'; v = r05((r.v0 + r.v1) / 2); u = Wx; }
      if (seg === null) continue;
      if (seg[1] - seg[0] >= width + 0.4 - EPS) doors.push({ a: i, b: -1, u, v, span, width, main: false, side: ed.side });
      break;
    }
  }

  // 5. To world: rooms, doors.
  const alongX = f === 0 || f === 2;
  const rooms: InteriorRoom[] = parts.map((p, index) => {
    const rect = worldRect(frame, p.rect);
    return {
      index, kind: p.kind, label: p.def.label, rect, surface: p.def.surface, public: p.def.public,
      light: p.def.light ? { x: r05((rect.minX + rect.maxX) / 2), z: r05((rect.minZ + rect.maxZ) / 2) } : null,
      switchAt: null,
    };
  });
  const footprint: Rect = { minX: building.minX, minZ: building.minZ, maxX: building.maxX, maxZ: building.maxZ };
  const outDoors: InteriorDoor[] = doors.map((d, index) => {
    const x = worldX(frame, d.u, d.v), z = worldZ(frame, d.u, d.v);
    const axis: 'x' | 'z' = d.span === 'u' ? (alongX ? 'x' : 'z') : alongX ? 'z' : 'x';
    const exterior = d.b < 0;
    const wide = exterior && d.width >= 2;
    const ra = (parts[d.a] as Part).kind, rb = exterior ? null : (parts[d.b] as Part).kind;
    const aLock = tpl.lockableRooms.includes(ra), bLock = rb !== null && tpl.lockableRooms.includes(rb);
    const cell = ra === 'cell' || rb === 'cell';
    const lockable = exterior ? !wide : aLock || bLock || cell;
    let lockSide = -1;
    if (!exterior && lockable) {
      const plain = (k: RoomKind): boolean => k === 'corridor' || k === 'hallway' || k === 'lobby';
      if (aLock && bLock) lockSide = plain(ra) && !plain(rb) ? d.b : d.a;
      else if (aLock) lockSide = d.a;
      else if (bLock) lockSide = d.b;
      else lockSide = ra === 'cell' ? d.b : d.a;
    }
    const lockedAtStart = lockable && (exterior ? tpl.exteriorLocked : tpl.lockedRooms.includes(ra) || (rb !== null && tpl.lockedRooms.includes(rb)));
    const strength = exterior
      ? tpl.exteriorStrength
      : ra === 'vault' || rb === 'vault' ? 1 : ra === 'armory' || ra === 'evidenceRoom' || ra === 'cell' || rb === 'armory' || rb === 'evidenceRoom' || rb === 'cell' ? 0.97 : 0.3;
    let exit: InteriorDoor['exit'] = null;
    if (exterior) {
      // Outward direction in world space from the door's local side.
      const lx = d.side === 'left' ? -1 : d.side === 'right' ? 1 : 0;
      const lv = d.side === 'front' ? -1 : d.side === 'back' ? 1 : 0;
      const nx = frame.ux * lx + frame.vx * lv, nz = frame.uz * lx + frame.vz * lv;
      const outSide = sideOfDirection(nx, nz);
      // 0.8 m beyond the footprint wall along the outward ray (the extent may sit inside a larger footprint).
      const ox = nx > 0 ? ceil05(Math.max(x, footprint.maxX) + EXIT_DISTANCE) : nx < 0 ? floor05(Math.min(x, footprint.minX) - EXIT_DISTANCE) : x;
      const oz = nz > 0 ? ceil05(Math.max(z, footprint.maxZ) + EXIT_DISTANCE) : nz < 0 ? floor05(Math.min(z, footprint.minZ) - EXIT_DISTANCE) : z;
      exit = { x: ox, z: oz, yaw: frontYaw(outSide) };
    }
    return {
      index, a: d.a, b: d.b, x, z, axis, width: d.width,
      kind: exterior ? (wide ? 'wide' : 'exterior') : cell ? 'cell' : 'interior',
      lockable, lockedAtStart, lockSide, strength, exit, main: d.main,
    };
  });
  const roomDoors: number[][] = rooms.map(() => []);
  for (const d of outDoors) {
    (roomDoors[d.a] as number[]).push(d.index);
    if (d.b >= 0) (roomDoors[d.b] as number[]).push(d.index);
  }

  // 6. Walls.
  const walls = buildWalls(rooms, outDoors);

  // 8. Furniture.
  const clearance = outDoors.map((d) => d.axis === 'x'
    ? { minX: d.x - d.width / 2 - CLEARANCE_SIDE, maxX: d.x + d.width / 2 + CLEARANCE_SIDE, minZ: d.z - CLEARANCE_DEPTH, maxZ: d.z + CLEARANCE_DEPTH }
    : { minX: d.x - CLEARANCE_DEPTH, maxX: d.x + CLEARANCE_DEPTH, minZ: d.z - d.width / 2 - CLEARANCE_SIDE, maxZ: d.z + d.width / 2 + CLEARANCE_SIDE });
  const furniture: FurnitureItem[] = [];
  const points: InteriorPoint[] = [];
  rooms.forEach((room, ri) => {
    const def = (parts[ri] as Part).def;
    placeFurniture(rng, templates.furniture, def, room, clearance, furniture, points);
  });

  // 9. Derived spots.
  const hidingSpots: HidingSpot[] = [];
  const spawnSpots: SpawnSpot[] = [];
  const itemSpots: ItemSpot[] = [];
  for (const p of furniture) {
    if (p.hide !== null) hidingSpots.push({ index: hidingSpots.length, room: p.room, furniture: p.index, kind: p.hide, x: p.x, z: p.z, yaw: p.yaw });
  }
  for (const p of furniture) {
    if (p.seat === null) continue;
    const fx = forwardX(p.yaw), fz = forwardZ(p.yaw);
    spawnSpots.push({ room: p.room, x: r05(p.x + fx * 0.3), z: r05(p.z + fz * 0.3), yaw: p.yaw, pose: p.seat === 'sit' ? 'sit' : 'lying' });
  }
  const inFurniture = (x: number, z: number): boolean => furniture.some((p) => x > p.minX && x < p.maxX && z > p.minZ && z < p.maxZ);
  rooms.forEach((room, ri) => {
    const r = room.rect;
    const cx = (r.minX + r.maxX) / 2, cz = (r.minZ + r.maxZ) / 2;
    const first = (roomDoors[ri] as number[])[0];
    const door = first === undefined ? null : (outDoors[first] as InteriorDoor);
    const towardDoor = door === null ? 0 : yawToward(cx, cz, door.x, door.z);
    if (!inFurniture(r05(cx), r05(cz))) spawnSpots.push({ room: ri, x: r05(cx), z: r05(cz), yaw: towardDoor, pose: 'stand' });
    const side = rng.nextInt(0, 3);
    const px = r05(cx + (side === 1 ? 1 : side === 3 ? -1 : 0)), pz = r05(cz + (side === 2 ? 1 : side === 0 ? -1 : 0));
    const insideRoom = px >= r.minX + 0.2 && px <= r.maxX - 0.2 && pz >= r.minZ + 0.2 && pz <= r.maxZ - 0.2;
    if (insideRoom && !inFurniture(px, pz)) spawnSpots.push({ room: ri, x: px, z: pz, yaw: yawToward(px, pz, cx, cz), pose: 'stand' });
  });
  for (const p of furniture) {
    if (p.surface !== null) itemSpots.push({ index: itemSpots.length, room: p.room, x: p.x, y: p.h, z: p.z, container: 'none', concealed: false, furniture: p.index });
    if (p.container !== 'none') itemSpots.push({ index: itemSpots.length, room: p.room, x: p.x, y: p.h / 2, z: p.z, container: p.container, concealed: true, furniture: p.index });
  }
  rooms.forEach((room, ri) => {
    const r = room.rect;
    const cx = (r.minX + r.maxX) / 2, cz = (r.minZ + r.maxZ) / 2;
    const dx = (r.maxX - r.minX) * 0.25, dz = (r.maxZ - r.minZ) * 0.25;
    for (const s of [1, -1]) {
      const x = r05(cx + s * dx), z = r05(cz + s * dz);
      if (!inFurniture(x, z)) itemSpots.push({ index: itemSpots.length, room: ri, x, z: z, y: 0, container: 'none', concealed: false, furniture: -1 });
    }
  });

  // Light switches, next to each lit room's lowest-index door.
  const litRooms: InteriorRoom[] = rooms.map((room, ri) => {
    if (room.light === null) return room;
    const first = (roomDoors[ri] as number[])[0];
    if (first === undefined) return room;
    return { ...room, switchAt: switchFor(room.rect, outDoors[first] as InteriorDoor) };
  });

  const entry = {
    x: r05(worldX(frame, mainU, 1.0)), z: r05(worldZ(frame, mainU, 1.0)), yaw: frontYaw(sideOfDirection(frame.vx, frame.vz)),
  };

  return {
    buildingId: building.id,
    kind: building.kind,
    floorY: INTERIOR_FLOOR_Y,
    rect: worldRect(frame, extent),
    rooms: litRooms,
    doors: outDoors,
    walls,
    furniture,
    hidingSpots,
    spawnSpots,
    itemSpots,
    points,
    entry,
    roomDoors,
    residential: tpl.residential,
    occupants: tpl.occupants,
  };
}

// --- Corridor partition ------------------------------------------------------------------------

function slabMinWidth(slot: Slot): number {
  const suite = slot.def.suite;
  return suite === null ? MIN_ROOM_SIDE : suite.length >= 3 ? 2 * MIN_ROOM_SIDE + 0.2 : 2 * MIN_ROOM_SIDE;
}

/** Slab widths proportional to size; drops rooms until every slab holds its minimum. */
function fitBand(band: Slot[], total: number, entry: Slot): number[] {
  for (;;) {
    const sum = band.reduce((acc, s) => acc + s.def.size, 0);
    const widths: number[] = [];
    let used = 0;
    band.forEach((s, i) => {
      const w = i === band.length - 1 ? r05(total - used) : r01((total * s.def.size) / sum);
      widths.push(w);
      used += w;
    });
    const ok = band.every((s, i) => (widths[i] as number) >= slabMinWidth(s) - EPS);
    if (ok || band.length <= 1) return widths;
    // The entry room stays; drop from the end of the band (optional, then extras, then the last other room).
    if (!dropOne(band, true, entry)) return widths;
  }
}

function partitionCorridor(
  rng: Rng, tpl: BuildingTemplate, cor: NonNullable<BuildingTemplate['corridor']>, list: Slot[], entry: Slot,
  Wx: number, Dx: number, parts: Part[], doors: LDoor[],
): void {
  const cw = cor.width;
  const fb = r05(Math.min(Dx - cw - MIN_ROOM_SIDE, Math.max(MIN_ROOM_SIDE, r01(Dx * cor.frontShare))));
  const bySeq = (a: Slot, b: Slot): number => a.defIndex - b.defIndex || a.inst - b.inst;
  const front = list.filter((s) => s.def.band === 'front').sort(bySeq);
  const back = list.filter((s) => s.def.band === 'back').sort(bySeq);
  const frontW = fitBand(front, Wx, entry);
  const backW = fitBand(back, Wx, entry);

  const lay = (band: Slot[], widths: number[], v0: number, v1: number, isFront: boolean): void => {
    let u = 0;
    band.forEach((slot, i) => {
      const u1 = i === band.length - 1 ? Wx : r05(u + (widths[i] as number));
      const slab: LRect = { u0: u, v0, u1, v1 };
      const line = isFront ? v1 : v0;
      if (slot.def.suite === null) {
        parts.push({ rect: slab, kind: slot.def.kind, def: slot.def });
        doors.push({ a: parts.length - 1, b: -2, u: r05((u + u1) / 2), v: line, span: 'u', width: DOOR_WIDTH, main: false, side: null });
      } else {
        const kinds = slot.def.suite;
        const bsp = bspSplit(rng, slab, kinds.length);
        const used = kinds.slice(0, bsp.leaves.length);
        // Leaf with the widest contact with the corridor line takes the first kind.
        let access = -1;
        let bestW = -1;
        bsp.leaves.forEach((leaf, k) => {
          const r = leaf.r;
          if ((isFront ? r.v1 : r.v0) !== line) return;
          if (r.u1 - r.u0 > bestW) { bestW = r.u1 - r.u0; access = k; }
        });
        const order: number[] = [];
        for (let k = 0; k < bsp.leaves.length; k++) if (k !== access) order.push(k);
        order.sort((x, y) => leafArea((bsp.leaves[y] as Leaf).r) - leafArea((bsp.leaves[x] as Leaf).r) || x - y);
        const kindOf = new Array<RoomKind>(bsp.leaves.length);
        kindOf[access] = used[0] as RoomKind;
        order.forEach((leaf, k) => { kindOf[leaf] = used[k + 1] as RoomKind; });
        const base = parts.length;
        bsp.leaves.forEach((leaf, k) => {
          const kind = kindOf[k] as RoomKind;
          parts.push({ rect: leaf.r, kind, def: childDef(tpl, kind) });
        });
        for (const d of bspDoors(bsp)) doors.push({ a: base + d.a, b: base + d.b, u: d.u, v: d.v, span: d.span, width: DOOR_WIDTH, main: false, side: null });
        const ar = (bsp.leaves[access] as Leaf).r;
        doors.push({ a: base + access, b: -2, u: r05((ar.u0 + ar.u1) / 2), v: line, span: 'u', width: DOOR_WIDTH, main: false, side: null });
      }
      u = u1;
    });
  };
  lay(front, frontW, 0, fb, true);
  lay(back, backW, fb + cw, Dx, false);
  parts.push({ rect: { u0: 0, v0: fb, u1: Wx, v1: fb + cw }, kind: cor.kind, def: corridorDef(cor) });
  const corridor = parts.length - 1;
  for (const d of doors) if (d.b === -2) d.b = corridor;
}

function corridorDef(cor: NonNullable<BuildingTemplate['corridor']>): RoomDef {
  return {
    kind: cor.kind, label: cor.label, size: 1, required: true, count: [1, 1], chance: 1, band: null, surface: cor.surface,
    public: false, light: true, suite: null, child: false, furniture: [],
  };
}

// --- Walls -------------------------------------------------------------------------------------

function buildWalls(rooms: readonly InteriorRoom[], doors: readonly InteriorDoor[]): Float32Array {
  // orientation 0: runs along X (constant z); 1: along Z (constant x).
  const lines = new Map<string, { ori: number; coord: number; ivals: [number, number][] }>();
  const add = (ori: number, coord: number, a: number, b: number): void => {
    const key = `${ori}:${Math.round(coord * 100)}`;
    let line = lines.get(key);
    if (line === undefined) { line = { ori, coord, ivals: [] }; lines.set(key, line); }
    line.ivals.push([a, b]);
  };
  for (const r of rooms) {
    add(0, r.rect.minZ, r.rect.minX, r.rect.maxX);
    add(0, r.rect.maxZ, r.rect.minX, r.rect.maxX);
    add(1, r.rect.minX, r.rect.minZ, r.rect.maxZ);
    add(1, r.rect.maxX, r.rect.minZ, r.rect.maxZ);
  }
  const cuts = new Map<string, [number, number][]>();
  for (const d of doors) {
    const ori = d.axis === 'x' ? 0 : 1;
    const coord = d.axis === 'x' ? d.z : d.x;
    const c = d.axis === 'x' ? d.x : d.z;
    const key = `${ori}:${Math.round(coord * 100)}`;
    const arr = cuts.get(key) ?? [];
    arr.push([c - d.width / 2, c + d.width / 2]);
    cuts.set(key, arr);
  }
  const sorted = [...lines.values()].sort((p, q) => p.ori - q.ori || p.coord - q.coord);
  const out: number[] = [];
  for (const line of sorted) {
    const merged: [number, number][] = [];
    for (const iv of line.ivals.sort((p, q) => p[0] - q[0])) {
      const last = merged[merged.length - 1];
      if (last !== undefined && iv[0] <= last[1] + 1e-3) last[1] = Math.max(last[1], iv[1]);
      else merged.push([iv[0], iv[1]]);
    }
    const holes = (cuts.get(`${line.ori}:${Math.round(line.coord * 100)}`) ?? []).slice().sort((p, q) => p[0] - q[0]);
    for (const [s, e] of merged) {
      let at = s;
      const emit = (a: number, b: number): void => {
        if (b - a <= 0.01) return;
        if (line.ori === 0) out.push(a, line.coord, b, line.coord);
        else out.push(line.coord, a, line.coord, b);
      };
      for (const [hs, he] of holes) {
        if (he <= at + 1e-6 || hs >= e - 1e-6) continue;
        emit(at, Math.min(hs, e));
        at = Math.max(at, he);
      }
      emit(at, e);
    }
  }
  return new Float32Array(out);
}

// --- Furniture ---------------------------------------------------------------------------------

/** Yaw of the facing direction used by wall, corner and centre placement: forward = (-sin yaw, -cos yaw). */
function forwardX(yaw: number): number { return Math.round(-Math.sin(yaw)); }
function forwardZ(yaw: number): number { return Math.round(-Math.cos(yaw)); }

function yawToward(x: number, z: number, tx: number, tz: number): number {
  const dx = tx - x, dz = tz - z;
  if (dx === 0 && dz === 0) return 0;
  return Math.atan2(-dx, -dz);
}

const WALL_YAW = [Math.PI, Math.PI / 2, 0, -Math.PI / 2] as const;

interface Box { minX: number; minZ: number; maxX: number; maxZ: number }

function placeFurniture(
  rng: Rng, catalog: Readonly<Record<string, FurnitureDef>>, def: RoomDef, room: InteriorRoom, clearance: readonly Box[],
  furniture: FurnitureItem[], points: InteriorPoint[],
): void {
  const R = room.rect;
  const cx = (R.minX + R.maxX) / 2, cz = (R.minZ + R.maxZ) / 2;
  const mine: Box[] = [];
  for (const entry of def.furniture) {
    const piece = catalog[entry.id] as FurnitureDef;
    const n = rng.chance(entry.chance) ? rng.nextInt(entry.count[0], entry.count[1]) : 0;
    for (let k = 0; k < n; k++) {
      for (let attempt = 0; attempt < TRIES; attempt++) {
        let x = 0, z = 0;
        let yaw: number;
        const swapped = (y: number): boolean => y === Math.PI / 2 || y === -Math.PI / 2;
        let ok = true;
        if (entry.place === 'wall') {
          const side = rng.nextInt(0, 3);
          yaw = WALL_YAW[side] as number;
          const hx = (swapped(yaw) ? piece.d : piece.w) / 2, hz = (swapped(yaw) ? piece.w : piece.d) / 2;
          if (side === 0 || side === 2) {
            const lo = R.minX + CORNER_MARGIN + hx, hi = R.maxX - CORNER_MARGIN - hx;
            if (hi < lo) ok = false;
            else x = r05(rng.nextFloat(lo, hi));
            z = side === 0 ? R.minZ + WALL_BACK + hz : R.maxZ - WALL_BACK - hz;
          } else {
            const lo = R.minZ + CORNER_MARGIN + hz, hi = R.maxZ - CORNER_MARGIN - hz;
            if (hi < lo) ok = false;
            else z = r05(rng.nextFloat(lo, hi));
            x = side === 3 ? R.minX + WALL_BACK + hx : R.maxX - WALL_BACK - hx;
          }
        } else if (entry.place === 'corner') {
          const corner = rng.nextInt(0, 3);
          yaw = WALL_YAW[corner] as number;
          const hx = (swapped(yaw) ? piece.d : piece.w) / 2, hz = (swapped(yaw) ? piece.w : piece.d) / 2;
          x = corner === 0 || corner === 3 ? R.minX + WALL_BACK + hx : R.maxX - WALL_BACK - hx;
          z = corner === 0 || corner === 1 ? R.minZ + WALL_BACK + hz : R.maxZ - WALL_BACK - hz;
        } else {
          yaw = rng.pick([0, Math.PI / 2]);
          const hx = (swapped(yaw) ? piece.d : piece.w) / 2, hz = (swapped(yaw) ? piece.w : piece.d) / 2;
          const jx = (R.maxX - R.minX - 2 * hx) / 4, jz = (R.maxZ - R.minZ - 2 * hz) / 4;
          if (jx < 0 || jz < 0) ok = false;
          else {
            x = r05(cx + rng.nextFloat(-jx, jx));
            z = r05(cz + rng.nextFloat(-jz, jz));
          }
        }
        if (!ok) continue;
        const hx = (swapped(yaw) ? piece.d : piece.w) / 2, hz = (swapped(yaw) ? piece.w : piece.d) / 2;
        const box: Box = { minX: x - hx, maxX: x + hx, minZ: z - hz, maxZ: z + hz };
        if (box.minX < R.minX + WALL_BACK - EPS || box.maxX > R.maxX - WALL_BACK + EPS) continue;
        if (box.minZ < R.minZ + WALL_BACK - EPS || box.maxZ > R.maxZ - WALL_BACK + EPS) continue;
        if (mine.some((o) => box.minX < o.maxX + FURNITURE_GAP - EPS && box.maxX > o.minX - FURNITURE_GAP + EPS
          && box.minZ < o.maxZ + FURNITURE_GAP - EPS && box.maxZ > o.minZ - FURNITURE_GAP + EPS)) continue;
        if (clearance.some((o) => box.minX < o.maxX - EPS && box.maxX > o.minX + EPS && box.minZ < o.maxZ - EPS && box.maxZ > o.minZ + EPS)) continue;
        let stand: { x: number; z: number } | null = null;
        if (entry.point !== null) {
          const sx = x + forwardX(yaw) * (piece.d / 2 + 0.6), sz = z + forwardZ(yaw) * (piece.d / 2 + 0.6);
          if (sx < R.minX + 0.2 || sx > R.maxX - 0.2 || sz < R.minZ + 0.2 || sz > R.maxZ - 0.2) continue;
          if (mine.some((o) => sx > o.minX && sx < o.maxX && sz > o.minZ && sz < o.maxZ)) continue;
          stand = { x: r05(sx), z: r05(sz) };
        }
        mine.push(box);
        const item: FurnitureItem = {
          index: furniture.length, id: piece.id, room: room.index, x, z, yaw, w: piece.w, d: piece.d, h: piece.h,
          minX: box.minX, minZ: box.minZ, maxX: box.maxX, maxZ: box.maxZ,
          color: piece.color, solid: piece.solid, cover: piece.h >= 0.8 && piece.h <= 1.3,
          surface: piece.surface, container: piece.container, hide: piece.hide, seat: piece.seat,
        };
        furniture.push(item);
        if (entry.point !== null && stand !== null) {
          points.push({ kind: entry.point, room: room.index, furniture: item.index, x: stand.x, z: stand.z, yaw: yawToward(stand.x, stand.z, x, z) });
        }
        break;
      }
    }
  }
}

function switchFor(R: Rect, d: InteriorDoor): { x: number; z: number; yaw: number } {
  const off = d.width / 2 + 0.35;
  const cx = (R.minX + R.maxX) / 2, cz = (R.minZ + R.maxZ) / 2;
  if (d.axis === 'x') {
    let x = d.x + off;
    if (x > R.maxX - 0.1) x = d.x - off;
    x = Math.min(R.maxX - 0.1, Math.max(R.minX + 0.1, x));
    const into = cz >= d.z ? 1 : -1;
    return { x: r05(x), z: r05(d.z) + into * 0.08, yaw: into > 0 ? Math.PI : 0 };
  }
  let z = d.z + off;
  if (z > R.maxZ - 0.1) z = d.z - off;
  z = Math.min(R.maxZ - 0.1, Math.max(R.minZ + 0.1, z));
  const into = cx >= d.x ? 1 : -1;
  return { x: r05(d.x) + into * 0.08, z: r05(z), yaw: into > 0 ? -Math.PI / 2 : Math.PI / 2 };
}
