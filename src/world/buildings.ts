/**
 * Building index (design §5.1): stable building ids, kinds, front sides and entrance approach points over a
 * generated city. Pure: no THREE, DOM or Rapier. A building id is `block * 256 + local`, where `local` is the
 * building's index in `blockBuildingRects(city, block)`.
 */
import kindsJson from '../data/interior/buildingKinds.json';
import { BUILDING_KINDS, type BuildingKind } from '../interior/kinds';
import { INTERIOR_TEMPLATES } from '../interior/templates';
import { unitHash } from '../records/hash';
import { fail, readArray, readNumber, readObject, readOneOf, readVersion } from '../vehicles/json';
import { BLOCK_KIND, type Block, type BlockKindId, type City, type PoiKind } from './city';
import { BUILDING_STRIDE, blockBuildingRects } from './chunkLayout';
import { LANDMARKS } from './data';
import { rectDistanceSq } from './geom';
import { DISTRICT, DISTRICT_NAMES, type DistrictId } from './ids';
import { stationLayout } from './stationLayout';

export { BUILDING_KINDS, type BuildingKind };

/** Hash salt of the district kind draw. */
const SALT_KIND = 0x4b1d;
/** Buildings per block id space. */
const LOCAL_LIMIT = 256;
const MIN_SIDE = 5;
const MIN_AREA = 30;
const DOOR_OFFSET = 0.6;
const JAIL_RADIUS = 2000;
const JAIL_BLOCKS = 60;
const JAIL_MIN_SIDE = 16;

/** Front side: 0 = the minZ side (faces -Z), 1 = maxX (+X), 2 = maxZ (+Z), 3 = minX (-X). */
export type FrontSide = 0 | 1 | 2 | 3;

export interface Rect4 {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export interface BuildingInfo {
  /** blockId * 256 + local index (index in blockBuildingRects / BUILDING_STRIDE). */
  readonly id: number;
  readonly block: number;
  readonly local: number;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly height: number;
  readonly district: DistrictId;
  /** null: not enterable (too small, or no kind fits). */
  readonly kind: BuildingKind | null;
  readonly front: FrontSide;
  /** Approach point 0.6 m outside the front wall centre (the station: stationLayout door), yaw facing out. */
  readonly door: { readonly x: number; readonly z: number; readonly yaw: number };
  /** Street address text, filled by the index from the nearest edge, '' when none. */
  readonly address: string;
}

export interface ClassifyInput {
  id: number;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  height: number;
  district: DistrictId;
  blockKind: BlockKindId;
  poiKind: PoiKind | null;
  poiFirst: boolean;
  station: boolean;
  jail: boolean;
  /**
   * Front side of the building. When given, the template size constraint is checked in that orientation
   * (exactly what `generateInterior` will use); otherwise either orientation may fit.
   */
  front?: FrontSide;
}

// --- Ids ---------------------------------------------------------------------------------------

/** Building id of (block, local index); `local` must be below 256. */
export function buildingId(block: number, local: number): number {
  if (!Number.isInteger(local) || local < 0 || local >= LOCAL_LIMIT) throw new RangeError(`buildingId: local index ${local} is outside [0, ${LOCAL_LIMIT})`);
  return block * LOCAL_LIMIT + local;
}

export function blockOfBuilding(id: number): number {
  return Math.floor(id / LOCAL_LIMIT);
}

export function localOfBuilding(id: number): number {
  return id - Math.floor(id / LOCAL_LIMIT) * LOCAL_LIMIT;
}

// --- Front side --------------------------------------------------------------------------------

/** Front side of `rect` inside `block`: the side with the smallest gap to the block edge (ties: 0, 1, 2, 3). */
export function frontSideOf(rect: Rect4, block: Rect4): FrontSide {
  const gaps = [rect.minZ - block.minZ, block.maxX - rect.maxX, block.maxZ - rect.maxZ, rect.minX - block.minX] as const;
  let best: FrontSide = 0;
  for (let s = 1; s < 4; s++) {
    if ((gaps[s] as number) < gaps[best]) best = s as FrontSide;
  }
  return best;
}

/** Outward yaw per side: 0 -> 0, 1 -> -PI/2, 2 -> PI, 3 -> PI/2. */
export function frontYaw(side: FrontSide): number {
  switch (side) {
    case 0: return 0;
    case 1: return -Math.PI / 2;
    case 2: return Math.PI;
    default: return Math.PI / 2;
  }
}

// --- Kind rules --------------------------------------------------------------------------------

export interface KindRule {
  readonly kind: BuildingKind;
  readonly weight: number;
  readonly minArea: number;
  readonly maxArea: number;
  readonly minSide: number;
  readonly minHeight: number;
  readonly maxHeight: number;
}

/** Validates `buildingKinds.json`: per-district weighted kind rules. */
export function validateBuildingKinds(raw: unknown, file = 'buildingKinds.json'): Readonly<Record<string, readonly KindRule[]>> {
  const root = readObject(raw, file, '');
  readVersion(root, file);
  const districts = readObject(root.districts, file, 'districts');
  for (const key of Object.keys(districts)) {
    if (!(DISTRICT_NAMES as readonly string[]).includes(key)) fail(file, `districts.${key}`, `is not a district (${DISTRICT_NAMES.join(', ')})`);
  }
  const out: Record<string, KindRule[]> = {};
  for (const name of DISTRICT_NAMES) {
    const path = `districts.${name}`;
    out[name] = readArray(districts[name], file, path).map((v, i): KindRule => {
      const p = `${path}[${i}]`;
      const o = readObject(v, file, p);
      for (const key of Object.keys(o)) {
        if (!['kind', 'weight', 'minArea', 'maxArea', 'minSide', 'minHeight', 'maxHeight'].includes(key)) fail(file, `${p}.${key}`, 'is not a known field');
      }
      return {
        kind: readOneOf(o.kind, BUILDING_KINDS, file, `${p}.kind`),
        weight: readNumber(o.weight, file, `${p}.weight`, 0.0001),
        minArea: o.minArea === undefined ? 0 : readNumber(o.minArea, file, `${p}.minArea`, 0),
        maxArea: o.maxArea === undefined ? Infinity : readNumber(o.maxArea, file, `${p}.maxArea`, 0),
        minSide: o.minSide === undefined ? 0 : readNumber(o.minSide, file, `${p}.minSide`, 0),
        minHeight: o.minHeight === undefined ? 0 : readNumber(o.minHeight, file, `${p}.minHeight`, 0),
        maxHeight: o.maxHeight === undefined ? Infinity : readNumber(o.maxHeight, file, `${p}.maxHeight`, 0),
      };
    });
  }
  return out;
}

const KIND_RULES = validateBuildingKinds(kindsJson);

/** True when a footprint of w x d (front side `front`, or either orientation) holds the kind's template. */
function fitsTemplate(kind: BuildingKind, w: number, d: number, front: FrontSide | undefined): boolean {
  const t = INTERIOR_TEMPLATES.templates[kind];
  const along = (a: number, b: number): boolean => a >= t.minWidth && b >= t.minDepth;
  if (front === undefined) return along(w, d) || along(d, w);
  return front === 0 || front === 2 ? along(w, d) : along(d, w);
}

/** Pure kind rule (design §5.1.1): the first matching rule wins. */
export function classifyBuilding(seed: number, info: ClassifyInput): BuildingKind | null {
  if (info.station) return 'policeStation';
  if (info.jail) return 'jail';
  const w = info.maxX - info.minX;
  const d = info.maxZ - info.minZ;
  const area = w * d;
  const side = Math.min(w, d);
  if (side < MIN_SIDE || area < MIN_AREA) return null;
  const fit = (kind: BuildingKind): BuildingKind | null => (fitsTemplate(kind, w, d, info.front) ? kind : null);

  switch (info.poiKind) {
    case 'hospital': return fit(info.poiFirst ? 'hospital' : 'office');
    case 'school':
    case 'campus': return fit(info.poiFirst ? 'school' : 'office');
    case 'fuel': return fit('convenienceStore');
    case 'harbor': return fit('warehouse');
    case 'airport': return fit('office');
    default: break;
  }
  switch (info.blockKind) {
    case BLOCK_KIND.yard: return fit('warehouse');
    case BLOCK_KIND.farm: return fit(info.id % LOCAL_LIMIT === 0 ? 'house' : 'warehouse');
    case BLOCK_KIND.park:
    case BLOCK_KIND.green: return null;
    default: break;
  }

  const rules = KIND_RULES[DISTRICT_NAMES[info.district] ?? 'water'] ?? [];
  let total = 0;
  const ok: KindRule[] = [];
  for (const r of rules) {
    if (area < r.minArea || area > r.maxArea || side < r.minSide || info.height < r.minHeight || info.height > r.maxHeight) continue;
    if (!fitsTemplate(r.kind, w, d, info.front)) continue;
    ok.push(r);
    total += r.weight;
  }
  if (ok.length === 0) return null;
  const target = unitHash(seed, SALT_KIND, info.id) * total;
  let acc = 0;
  for (const r of ok) {
    acc += r.weight;
    if (target < acc) return r.kind;
  }
  return (ok[ok.length - 1] as KindRule).kind;
}

// --- Index -------------------------------------------------------------------------------------

interface BlockEntry {
  readonly block: Block;
  readonly rects: Float32Array;
  readonly infos: (BuildingInfo | undefined)[];
}

const sideOfQuarter = [0, 3, 2, 1] as const;

/** Lazy, cached (LRU of blocks) building lookup over a city. */
export class BuildingIndex {
  private readonly city: City;
  private readonly cacheBlocks: number;
  private readonly addressAt: (x: number, z: number) => string;
  private readonly cache = new Map<number, BlockEntry>();
  private readonly scratchBlocks: number[] = [];
  private jailBuilding = -2;
  readonly stats = { blocksCached: 0, lookups: 0 };

  constructor(city: City, options: { cacheBlocks?: number; addressAt?: (x: number, z: number) => string } = {}) {
    this.city = city;
    this.cacheBlocks = Math.max(1, options.cacheBlocks ?? 256);
    this.addressAt = options.addressAt ?? ((): string => '');
  }

  /** The building with this id, null for an unknown id. */
  building(id: number): BuildingInfo | null {
    this.stats.lookups++;
    if (!Number.isInteger(id) || id < 0) return null;
    const entry = this.entry(blockOfBuilding(id));
    return entry === null ? null : this.info(entry, localOfBuilding(id));
  }

  /** Clears `out`, fills it with buildings whose footprint is within `radius` of (x, z), ascending id. */
  near(x: number, z: number, radius: number, out: BuildingInfo[]): BuildingInfo[] {
    this.stats.lookups++;
    out.length = 0;
    const r2 = radius * radius;
    const blocks = this.city.blocksIn(x - radius, z - radius, x + radius, z + radius, this.scratchBlocks);
    for (const id of blocks) {
      const entry = this.entry(id);
      if (entry === null) continue;
      const rects = entry.rects;
      for (let i = 0, local = 0; i < rects.length; i += BUILDING_STRIDE, local++) {
        if (rectDistanceSq(rects[i] ?? 0, rects[i + 1] ?? 0, rects[i + 2] ?? 0, rects[i + 3] ?? 0, x, z) > r2) continue;
        const info = this.info(entry, local);
        if (info !== null) out.push(info);
      }
    }
    for (let i = 1; i < out.length; i++) {
      if ((out[i - 1] as BuildingInfo).id > (out[i] as BuildingInfo).id) {
        out.sort((a, b) => a.id - b.id);
        break;
      }
    }
    return out;
  }

  /** Enterable building whose `door` is nearest to (x, z) within maxDist (kinds filter optional); ties: lower id. */
  nearestEntrance(x: number, z: number, maxDist: number, kinds?: readonly BuildingKind[] | null): BuildingInfo | null {
    this.stats.lookups++;
    let best: BuildingInfo | null = null;
    let bestD = maxDist * maxDist;
    const reach = maxDist + 1;
    const blocks = this.city.blocksIn(x - reach, z - reach, x + reach, z + reach, this.scratchBlocks);
    for (const id of blocks) {
      const entry = this.entry(id);
      if (entry === null) continue;
      const rects = entry.rects;
      for (let i = 0, local = 0; i < rects.length; i += BUILDING_STRIDE, local++) {
        // The door is at most 0.6 m outside the footprint.
        if (rectDistanceSq(rects[i] ?? 0, rects[i + 1] ?? 0, rects[i + 2] ?? 0, rects[i + 3] ?? 0, x, z) > (reach + 0.1) * (reach + 0.1)) continue;
        const info = this.info(entry, local);
        if (info === null || info.kind === null) continue;
        if (kinds && !kinds.includes(info.kind)) continue;
        const dx = info.door.x - x, dz = info.door.z - z;
        const d2 = dx * dx + dz * dz;
        if (d2 < bestD || (d2 === bestD && best !== null && info.id < best.id)) {
          best = info;
          bestD = d2;
        }
      }
    }
    return best;
  }

  /** The building containing (x, z) in its footprint, else null. */
  at(x: number, z: number): BuildingInfo | null {
    this.stats.lookups++;
    const blocks = this.city.blocksIn(x, z, x, z, this.scratchBlocks);
    for (const id of blocks) {
      const entry = this.entry(id);
      if (entry === null) continue;
      const rects = entry.rects;
      for (let i = 0, local = 0; i < rects.length; i += BUILDING_STRIDE, local++) {
        if (x >= (rects[i] ?? 0) && x <= (rects[i + 2] ?? 0) && z >= (rects[i + 1] ?? 0) && z <= (rects[i + 3] ?? 0)) return this.info(entry, local);
      }
    }
    return null;
  }

  /** The police station POI's building. */
  station(): BuildingInfo | null {
    const poi = this.city.pois.find((p) => p.kind === 'station');
    return poi === undefined ? null : this.building(buildingId(poi.block, 0));
  }

  /** The city's jail (design §5.1.1), null when none qualifies. */
  jail(): BuildingInfo | null {
    if (this.jailBuilding === -2) this.jailBuilding = this.findJail();
    return this.jailBuilding < 0 ? null : this.building(this.jailBuilding);
  }

  private findJail(): number {
    const station = this.city.pois.find((p) => p.kind === 'station');
    if (station === undefined) return -1;
    const near: { id: number; d2: number }[] = [];
    for (const b of this.city.blocks) {
      if (b.kind !== BLOCK_KIND.lots || b.poi >= 0) continue;
      if (b.district !== DISTRICT.downtown && b.district !== DISTRICT.industrial) continue;
      const dx = (b.minX + b.maxX) / 2 - station.x, dz = (b.minZ + b.maxZ) / 2 - station.z;
      const d2 = dx * dx + dz * dz;
      if (d2 <= JAIL_RADIUS * JAIL_RADIUS) near.push({ id: b.id, d2 });
    }
    near.sort((a, b) => a.d2 - b.d2 || a.id - b.id);
    let bestId = -1;
    let bestArea = 0;
    for (const { id } of near.slice(0, JAIL_BLOCKS)) {
      const entry = this.entry(id);
      if (entry === null) continue;
      const rects = entry.rects;
      for (let i = 0, local = 0; i < rects.length; i += BUILDING_STRIDE, local++) {
        const w = (rects[i + 2] ?? 0) - (rects[i] ?? 0), d = (rects[i + 3] ?? 0) - (rects[i + 1] ?? 0);
        if (Math.min(w, d) < JAIL_MIN_SIDE) continue;
        const bid = buildingId(id, local);
        const area = w * d;
        if (area > bestArea || (area === bestArea && bid < bestId)) {
          bestArea = area;
          bestId = bid;
        }
      }
    }
    return bestId;
  }

  private entry(blockId: number): BlockEntry | null {
    const hit = this.cache.get(blockId);
    if (hit !== undefined) {
      // Refresh recency.
      this.cache.delete(blockId);
      this.cache.set(blockId, hit);
      return hit;
    }
    const block = this.city.blocks[blockId];
    if (block === undefined) return null;
    const rects = blockBuildingRects(this.city, blockId);
    const count = Math.min(LOCAL_LIMIT, rects.length / BUILDING_STRIDE);
    const entry: BlockEntry = { block, rects, infos: new Array<BuildingInfo | undefined>(count).fill(undefined) };
    this.cache.set(blockId, entry);
    if (this.cache.size > this.cacheBlocks) {
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.stats.blocksCached = this.cache.size;
    return entry;
  }

  private info(entry: BlockEntry, local: number): BuildingInfo | null {
    if (local < 0 || local >= entry.infos.length) return null;
    const cached = entry.infos[local];
    if (cached !== undefined) return cached;
    const info = this.make(entry, local);
    entry.infos[local] = info;
    return info;
  }

  private make(entry: BlockEntry, local: number): BuildingInfo {
    const { block, rects } = entry;
    const o = local * BUILDING_STRIDE;
    const minX = rects[o] ?? 0, minZ = rects[o + 1] ?? 0, maxX = rects[o + 2] ?? 0, maxZ = rects[o + 3] ?? 0;
    const id = buildingId(block.id, local);
    const poi = block.poi >= 0 ? this.city.pois[block.poi] : undefined;
    const station = poi?.kind === 'station';

    let front = frontSideOf({ minX, minZ, maxX, maxZ }, block);
    let door: { x: number; z: number; yaw: number };
    if (station) {
      const d = stationLayout(block, LANDMARKS.station.yaw).door;
      const q = ((Math.round(d.yaw / (Math.PI / 2)) % 4) + 4) % 4;
      front = sideOfQuarter[q] as FrontSide;
      door = { x: d.x, z: d.z, yaw: frontYaw(front) };
    } else {
      const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
      door = {
        x: front === 1 ? maxX + DOOR_OFFSET : front === 3 ? minX - DOOR_OFFSET : cx,
        z: front === 0 ? minZ - DOOR_OFFSET : front === 2 ? maxZ + DOOR_OFFSET : cz,
        yaw: frontYaw(front),
      };
    }
    const kind = classifyBuilding(this.city.seed, {
      id, minX, minZ, maxX, maxZ,
      height: rects[o + 4] ?? 0,
      district: block.district,
      blockKind: block.kind,
      poiKind: poi?.kind ?? null,
      poiFirst: local === 0,
      station,
      jail: this.jail0() === id,
      front,
    });
    return {
      id, block: block.id, local, minX, minZ, maxX, maxZ,
      height: rects[o + 4] ?? 0,
      district: block.district,
      kind, front, door,
      address: this.addressAt(door.x, door.z),
    };
  }

  /** Jail id without building infos (the jail search only reads raw rectangles). */
  private jail0(): number {
    if (this.jailBuilding === -2) this.jailBuilding = this.findJail();
    return this.jailBuilding;
  }
}
