import { BLOCK_KIND, type Block, type City, type Pose2 } from '../world/city';
import { LANDMARKS } from '../world/data';
import { stationLayout } from '../world/stationLayout';
import { FLEET_DATA } from './data';

/** Station yard: where fleet units are kept and spawned (Phase 7 design §9.4). Pure. */

export interface YardLayout {
  /** Parking slots, the six Phase 1-6 slots first. */
  slots: Pose2[];
  /** Where a checked-out unit spawns (`slots[garageSlot]`; the integrator frees it first). */
  garage: Pose2;
  helipad: Pose2 | null;
  boatSlip: Pose2 | null;
  /** The station pump: the fleet service point. */
  service: { x: number; z: number };
}

const SLOT_PITCH = 3.6;
const MIN_SLOT_SPACING = 3.4;
const BLOCK_MARGIN = 2.5;
const PUMP_CLEARANCE = 5;
const BUILDING_CLEARANCE = 2;
const HELIPAD_CLEARANCE = 10;
const SECOND_ROW_OFFSET = 7;
const BOAT_QUAY_INSET = 2;
const BOAT_SIDE_MARGIN = 8;

function rectDistance(minX: number, minZ: number, maxX: number, maxZ: number, x: number, z: number): number {
  return Math.hypot(Math.max(minX - x, 0, x - maxX), Math.max(minZ - z, 0, z - maxZ));
}

function stationBlock(city: City): Block {
  const { x, z } = city.spawn;
  const block = city.blocks.find(
    (b) => b.kind === BLOCK_KIND.parking && x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ,
  );
  if (block === undefined) throw new Error('fleetYard: the station lot block was not found');
  return block;
}

/**
 * The boat slip: 2 m into the water block nearest the harbor POI, on its side nearest the POI, with the driver side
 * (local -X) toward the quay.
 */
function boatSlip(city: City): Pose2 | null {
  const poi = city.pois.find((p) => p.kind === 'harbor');
  if (poi === undefined) return null;
  let water: Block | null = null;
  let best = Infinity;
  for (const b of city.blocks) {
    if (b.kind !== BLOCK_KIND.water) continue;
    const d = rectDistance(b.minX, b.minZ, b.maxX, b.maxZ, poi.x, poi.z);
    if (d < best) {
      best = d;
      water = b;
    }
  }
  if (water === null) return null;
  // The four sides as [axis, fixed coordinate, start, end, outward normal x, z]; the nearest to the POI is the quay.
  const sides: readonly (readonly [0 | 1, number, number, number, number, number])[] = [
    [1, water.minX, water.minZ, water.maxZ, -1, 0],
    [1, water.maxX, water.minZ, water.maxZ, 1, 0],
    [0, water.minZ, water.minX, water.maxX, 0, -1],
    [0, water.maxZ, water.minX, water.maxX, 0, 1],
  ];
  let side = sides[0] as (typeof sides)[number];
  let sideBest = Infinity;
  for (const s of sides) {
    const along = s[0] === 1 ? poi.z : poi.x;
    const across = s[0] === 1 ? poi.x : poi.z;
    const t = Math.min(Math.max(along, s[2]), s[3]);
    const d = Math.hypot(along - t, across - s[1]);
    if (d < sideBest) {
      sideBest = d;
      side = s;
    }
  }
  const [axis, fixed, start, end, nx, nz] = side;
  const along = axis === 1 ? poi.z : poi.x;
  const lo = start + BOAT_SIDE_MARGIN;
  const hi = end - BOAT_SIDE_MARGIN;
  const t = hi <= lo ? (start + end) / 2 : Math.min(Math.max(along, lo), hi);
  // `n` points from the water to the land; the slip is moved the other way, into the water.
  const x = axis === 1 ? fixed - nx * BOAT_QUAY_INSET : t;
  const z = axis === 1 ? t : fixed - nz * BOAT_QUAY_INSET;
  return { x, z, yaw: Math.atan2(nz, -nx) };
}

/**
 * The yard of the station lot: six original slots, a row extension and a second row, the garage, a helipad and a boat
 * slip at the harbor. Slot candidates keep 3.4 m from the slots already kept (the design's `(3 + j) x 3.6` extension
 * starts 1.8 m from the last original slot).
 */
export function fleetYard(city: City): YardLayout {
  const block = stationBlock(city);
  const yaw = LANDMARKS.station.yaw;
  const layout = stationLayout(block, yaw);
  const q = ((Math.round(yaw / (Math.PI / 2)) % 4) + 4) % 4;
  const snapped = q * (Math.PI / 2);
  const fx = Math.round(-Math.sin(snapped));
  const fz = Math.round(-Math.cos(snapped));
  const rx = -fz;
  const rz = fx;
  const cx = (block.minX + block.maxX) / 2;
  const cz = (block.minZ + block.maxZ) / 2;
  const sizeX = block.maxX - block.minX;
  const sizeZ = block.maxZ - block.minZ;
  const hf = (fx !== 0 ? sizeX : sizeZ) / 2;
  const hr = (fx !== 0 ? sizeZ : sizeX) / 2;
  const local = (u: number, v: number): Pose2 => ({ x: cx + rx * u + fx * v, z: cz + rz * u + fz * v, yaw: snapped });
  const uOf = (p: { x: number; z: number }): number => (p.x - cx) * rx + (p.z - cz) * rz;
  const vOf = (p: { x: number; z: number }): number => (p.x - cx) * fx + (p.z - cz) * fz;

  const [bMinX, bMinZ, bMaxX, bMaxZ] = layout.building;
  const pump = layout.pump;
  const uPump = uOf(pump);

  // Helipad: the far corner of the lot front, opposite the pump.
  let helipad: Pose2 | null = null;
  if (hr >= 20 && hf >= 20) {
    const pad = local(-(uPump < 0 ? -1 : 1) * (hr - 9), hf - 9);
    if (rectDistance(bMinX, bMinZ, bMaxX, bMaxZ, pad.x, pad.z) >= 12 && Math.hypot(pad.x - pump.x, pad.z - pump.z) >= 12) helipad = pad;
  }

  const slots: Pose2[] = layout.slots.map((s) => ({ x: s.x, z: s.z, yaw: snapped }));
  const vRow = vOf(layout.slots[0] ?? pump);
  const accept = (p: Pose2): boolean => {
    if (p.x < block.minX + BLOCK_MARGIN || p.x > block.maxX - BLOCK_MARGIN) return false;
    if (p.z < block.minZ + BLOCK_MARGIN || p.z > block.maxZ - BLOCK_MARGIN) return false;
    if (Math.hypot(p.x - pump.x, p.z - pump.z) < PUMP_CLEARANCE) return false;
    if (rectDistance(bMinX, bMinZ, bMaxX, bMaxZ, p.x, p.z) < BUILDING_CLEARANCE) return false;
    if (helipad !== null && Math.hypot(p.x - helipad.x, p.z - helipad.z) < HELIPAD_CLEARANCE) return false;
    for (const s of slots) if (Math.hypot(p.x - s.x, p.z - s.z) < MIN_SLOT_SPACING) return false;
    return true;
  };
  for (let j = 0; j < 4; j++) {
    for (const sign of [1, -1]) {
      const p = local(sign * (3 + j) * SLOT_PITCH, vRow);
      if (accept(p)) slots.push(p);
    }
  }
  for (let k = 0; k < 8; k++) {
    const p = local((k - 3.5) * SLOT_PITCH, vRow + SECOND_ROW_OFFSET);
    if (accept(p)) slots.push(p);
  }
  return { slots, garage: slots[FLEET_DATA.garageSlot] ?? (slots[0] as Pose2), helipad, boatSlip: boatSlip(city), service: { x: pump.x, z: pump.z } };
}
