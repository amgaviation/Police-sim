import { describe, expect, it } from 'vitest';
import { INTERIOR_TEMPLATES } from '../../src/interior/templates';
import { generateInterior } from '../../src/interior/generate';
import { BUILDING_STRIDE, blockBuildingRects, chunkLayout } from '../../src/world/chunkLayout';
import { BLOCK_KIND, type City } from '../../src/world/city';
import { chunkCoord } from '../../src/world/constants';
import { LANDMARKS } from '../../src/world/data';
import { generateCity } from '../../src/world/generate';
import { DISTRICT, DISTRICT_NAMES } from '../../src/world/ids';
import { stationLayout } from '../../src/world/stationLayout';
import {
  BUILDING_KINDS,
  BuildingIndex,
  blockOfBuilding,
  buildingId,
  classifyBuilding,
  frontSideOf,
  frontYaw,
  localOfBuilding,
  validateBuildingKinds,
  type BuildingInfo,
  type ClassifyInput,
} from '../../src/world/buildings';
import { cityFor } from './helpers';

const SEED = 42;
const city: City = cityFor(SEED);

function input(over: Partial<ClassifyInput> = {}): ClassifyInput {
  return {
    id: 5 * 256 + 1, minX: 0, minZ: 0, maxX: 20, maxZ: 12, height: 8, district: DISTRICT.suburbs,
    blockKind: BLOCK_KIND.lots, poiKind: null, poiFirst: false, station: false, jail: false, ...over,
  };
}

function allBuildings(index: BuildingIndex, limit = Infinity): BuildingInfo[] {
  const out: BuildingInfo[] = [];
  for (const b of city.blocks) {
    const n = blockBuildingRects(city, b.id).length / BUILDING_STRIDE;
    for (let local = 0; local < n && out.length < limit; local++) out.push(index.building(buildingId(b.id, local))!);
  }
  return out;
}

describe('building ids', () => {
  it('round-trips block and local index', () => {
    for (const [block, local] of [[0, 0], [1, 255], [123, 7], [4000, 100]] as const) {
      const id = buildingId(block, local);
      expect(id).toBe(block * 256 + local);
      expect(blockOfBuilding(id)).toBe(block);
      expect(localOfBuilding(id)).toBe(local);
    }
  });

  it('rejects a local index of 256 or more', () => {
    expect(() => buildingId(3, 256)).toThrow(RangeError);
    expect(() => buildingId(3, -1)).toThrow(RangeError);
    expect(() => buildingId(3, 1.5)).toThrow(RangeError);
  });
});

describe('frontSideOf and frontYaw', () => {
  const block = { minX: 0, minZ: 0, maxX: 100, maxZ: 100 };
  it('picks the side with the smallest gap to the block edge', () => {
    expect(frontSideOf({ minX: 40, minZ: 5, maxX: 60, maxZ: 30 }, block)).toBe(0);
    expect(frontSideOf({ minX: 40, minZ: 40, maxX: 95, maxZ: 60 }, block)).toBe(1);
    expect(frontSideOf({ minX: 40, minZ: 40, maxX: 60, maxZ: 96 }, block)).toBe(2);
    expect(frontSideOf({ minX: 4, minZ: 40, maxX: 30, maxZ: 60 }, block)).toBe(3);
  });

  it('breaks ties towards the lower side', () => {
    expect(frontSideOf({ minX: 10, minZ: 10, maxX: 90, maxZ: 90 }, block)).toBe(0);
    expect(frontSideOf({ minX: 40, minZ: 40, maxX: 90, maxZ: 90 }, block)).toBe(1);
    expect(frontSideOf({ minX: 40, minZ: 40, maxX: 60, maxZ: 60 }, block)).toBe(0);
    expect(frontSideOf({ minX: 10, minZ: 40, maxX: 60, maxZ: 90 }, block)).toBe(2);
  });

  it('maps sides to outward yaws', () => {
    expect(frontYaw(0)).toBe(0);
    expect(frontYaw(1)).toBeCloseTo(-Math.PI / 2, 12);
    expect(frontYaw(2)).toBeCloseTo(Math.PI, 12);
    expect(frontYaw(3)).toBeCloseTo(Math.PI / 2, 12);
  });
});

describe('blockBuildingRects', () => {
  it('equals the buildings chunkLayout places for that block', () => {
    const chunks = new Map<string, Float32Array>();
    const placed = (cx: number, cz: number): Float32Array => {
      const key = `${cx},${cz}`;
      let b = chunks.get(key);
      if (b === undefined) { b = chunkLayout(city, cx, cz).buildings; chunks.set(key, b); }
      return b;
    };
    let checked = 0;
    for (const b of city.blocks) {
      if (b.id % 29 !== 0 && b.poi < 0) continue;
      const rects = blockBuildingRects(city, b.id);
      expect(rects.length % BUILDING_STRIDE).toBe(0);
      for (let i = 0; i < rects.length; i += BUILDING_STRIDE) {
        const cx = ((rects[i] ?? 0) + (rects[i + 2] ?? 0)) / 2, cz = ((rects[i + 1] ?? 0) + (rects[i + 3] ?? 0)) / 2;
        const list = placed(chunkCoord(cx), chunkCoord(cz));
        let found = false;
        for (let k = 0; k < list.length && !found; k += BUILDING_STRIDE) {
          found = true;
          for (let j = 0; j < BUILDING_STRIDE; j++) if (list[k + j] !== rects[i + j]) { found = false; break; }
        }
        expect(found, `block ${b.id} building ${i / BUILDING_STRIDE}`).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(50);
  });

  it('is empty for an unknown block and does not depend on call order', () => {
    expect(blockBuildingRects(city, -1).length).toBe(0);
    expect(blockBuildingRects(city, city.blocks.length).length).toBe(0);
    const id = city.blocks.find((b) => b.kind === BLOCK_KIND.lots)!.id;
    const a = blockBuildingRects(city, id);
    blockBuildingRects(city, id + 1);
    expect(blockBuildingRects(city, id)).toEqual(a);
  });
});

describe('classifyBuilding', () => {
  it('puts station and jail first', () => {
    expect(classifyBuilding(SEED, input({ station: true, maxX: 3, maxZ: 3 }))).toBe('policeStation');
    expect(classifyBuilding(SEED, input({ jail: true }))).toBe('jail');
    expect(classifyBuilding(SEED, input({ station: true, jail: true }))).toBe('policeStation');
  });

  it('rejects footprints that are too small', () => {
    expect(classifyBuilding(SEED, input({ maxX: 4.9, maxZ: 40 }))).toBeNull();
    expect(classifyBuilding(SEED, input({ maxX: 10, maxZ: 2.9 }))).toBeNull();
    expect(classifyBuilding(SEED, input({ maxX: 5.5, maxZ: 5.5 }))).toBeNull();
  });

  it('applies the POI rules', () => {
    const big = { maxX: 36, maxZ: 36 };
    expect(classifyBuilding(SEED, input({ ...big, poiKind: 'hospital', poiFirst: true }))).toBe('hospital');
    expect(classifyBuilding(SEED, input({ ...big, poiKind: 'hospital', poiFirst: false }))).toBe('office');
    expect(classifyBuilding(SEED, input({ ...big, poiKind: 'school', poiFirst: true }))).toBe('school');
    expect(classifyBuilding(SEED, input({ ...big, poiKind: 'campus', poiFirst: true }))).toBe('school');
    expect(classifyBuilding(SEED, input({ ...big, poiKind: 'campus', poiFirst: false }))).toBe('office');
    expect(classifyBuilding(SEED, input({ maxX: 16, maxZ: 10, poiKind: 'fuel' }))).toBe('convenienceStore');
    expect(classifyBuilding(SEED, input({ ...big, poiKind: 'harbor' }))).toBe('warehouse');
    expect(classifyBuilding(SEED, input({ ...big, poiKind: 'airport' }))).toBe('office');
    // A park POI is not a building rule: the block kind decides.
    expect(classifyBuilding(SEED, input({ ...big, poiKind: 'park', blockKind: BLOCK_KIND.park }))).toBeNull();
  });

  it('applies the block kind rules', () => {
    expect(classifyBuilding(SEED, input({ maxX: 30, maxZ: 20, blockKind: BLOCK_KIND.yard }))).toBe('warehouse');
    expect(classifyBuilding(SEED, input({ id: 7 * 256, blockKind: BLOCK_KIND.farm }))).toBe('house');
    expect(classifyBuilding(SEED, input({ id: 7 * 256 + 1, maxX: 24, maxZ: 16, blockKind: BLOCK_KIND.farm }))).toBe('warehouse');
    expect(classifyBuilding(SEED, input({ blockKind: BLOCK_KIND.park }))).toBeNull();
    expect(classifyBuilding(SEED, input({ blockKind: BLOCK_KIND.green }))).toBeNull();
  });

  it('draws from the district table: deterministic, constrained and roughly weighted', () => {
    const counts = new Map<string, number>();
    const n = 3000;
    for (let id = 0; id < n; id++) {
      const a = classifyBuilding(SEED, input({ id, maxX: 18, maxZ: 12 }));
      expect(classifyBuilding(SEED, input({ id, maxX: 18, maxZ: 12 }))).toBe(a);
      counts.set(String(a), (counts.get(String(a)) ?? 0) + 1);
    }
    // 18 x 12 = 216 m2 in the suburbs: house (<= 450), convenienceStore, bar, bank (>= 150); no apartment (>= 300).
    expect(counts.has('apartment')).toBe(false);
    expect(counts.get('house')! / n).toBeGreaterThan(0.8);
    expect(counts.get('house')! / n).toBeLessThan(0.97);
    for (const kind of counts.keys()) expect(['house', 'convenienceStore', 'bar', 'bank']).toContain(kind);
    // The seed changes the draw.
    let differ = 0;
    for (let id = 0; id < 300; id++) if (classifyBuilding(SEED + 1, input({ id, maxX: 18, maxZ: 12 })) !== classifyBuilding(SEED, input({ id, maxX: 18, maxZ: 12 }))) differ++;
    expect(differ).toBeGreaterThan(0);
  });

  it('honours size constraints per kind', () => {
    for (let id = 0; id < 2000; id++) {
      const big = classifyBuilding(SEED, input({ id, district: DISTRICT.downtown, maxX: 40, maxZ: 30, height: 40 }));
      expect(big).not.toBe('house'); // downtown house needs <= 300 m2
      const small = classifyBuilding(SEED, input({ id, district: DISTRICT.downtown, maxX: 12, maxZ: 10 }));
      expect(['house', 'bar', 'convenienceStore', null]).toContain(small);
    }
  });

  it('yields no kind for park and water districts and for footprints no template fits', () => {
    expect(classifyBuilding(SEED, input({ district: DISTRICT.park }))).toBeNull();
    expect(classifyBuilding(SEED, input({ district: DISTRICT.water }))).toBeNull();
    // 6 x 6 fits the house template only.
    for (let id = 0; id < 200; id++) {
      const k = classifyBuilding(SEED, input({ id, maxX: 6, maxZ: 6 }));
      expect(k === null || k === 'house').toBe(true);
    }
  });

  it('checks the template size in the given front orientation', () => {
    // A bank needs 14 wide x 12 deep: a 12 x 14 footprint fits only when the front faces +-X.
    const t = INTERIOR_TEMPLATES.templates.bank;
    expect([t.minWidth, t.minDepth]).toEqual([14, 12]);
    const rule = { district: DISTRICT.suburbs, maxX: 12, maxZ: 14 };
    const kinds0 = new Set<string>(), kinds1 = new Set<string>();
    for (let id = 0; id < 4000; id++) {
      kinds0.add(String(classifyBuilding(SEED, input({ id, ...rule, front: 0 }))));
      kinds1.add(String(classifyBuilding(SEED, input({ id, ...rule, front: 1 }))));
    }
    expect(kinds0.has('bank')).toBe(false);
    expect(kinds1.has('bank')).toBe(true);
  });
});

describe('validateBuildingKinds', () => {
  it('names the file and path of a bad rule', () => {
    const district = (rules: unknown): unknown => ({ version: 1, districts: Object.fromEntries(DISTRICT_NAMES.map((n) => [n, n === 'rural' ? rules : []])) });
    expect(() => validateBuildingKinds(district([{ kind: 'castle', weight: 1 }]))).toThrow(/buildingKinds\.json: districts\.rural\[0\]\.kind /);
    expect(() => validateBuildingKinds(district([{ kind: 'house', weight: 0 }]))).toThrow(/rural\[0\]\.weight /);
    expect(() => validateBuildingKinds(district([{ kind: 'house', weight: 1, bogus: 1 }]))).toThrow(/rural\[0\]\.bogus /);
    expect(() => validateBuildingKinds({ version: 1, districts: { moon: [] } })).toThrow(/districts\.moon /);
    expect(() => validateBuildingKinds({ version: 1, districts: {} })).toThrow(/districts\.downtown /);
    expect(() => validateBuildingKinds({ version: 2, districts: {} })).toThrow(/version /);
  });
});

describe('BuildingIndex', () => {
  const index = new BuildingIndex(city);
  const station = index.station();

  it('classifies deterministically, also from a fresh city, and every kind it assigns is enterable', () => {
    const fresh = new BuildingIndex(generateCity(SEED));
    const sample = allBuildings(index).filter((_, i) => i % 7 === 0);
    expect(sample.length).toBeGreaterThan(200);
    let enterable = 0;
    for (const b of sample) {
      expect(fresh.building(b.id)).toEqual(b);
      expect(b.id).toBe(buildingId(b.block, b.local));
      if (b.kind === null) continue;
      enterable++;
      expect(BUILDING_KINDS).toContain(b.kind);
      if (b.kind !== 'policeStation' && b.kind !== 'jail') {
        expect(Math.min(b.maxX - b.minX, b.maxZ - b.minZ)).toBeGreaterThanOrEqual(5);
        expect((b.maxX - b.minX) * (b.maxZ - b.minZ)).toBeGreaterThanOrEqual(30);
      }
    }
    expect(enterable).toBeGreaterThan(50);
    // Classification implies a generated interior.
    for (const b of sample.filter((x) => x.kind !== null).slice(0, 120)) expect(generateInterior(SEED, b), `${b.kind} ${b.id}`).not.toBeNull();
  });

  it('puts door and front on the front wall', () => {
    for (const b of allBuildings(index).filter((_, i) => i % 11 === 0)) {
      if (b.id === station?.id) continue;
      const cx = (b.minX + b.maxX) / 2, cz = (b.minZ + b.maxZ) / 2;
      const expected = [
        [cx, b.minZ - 0.6], [b.maxX + 0.6, cz], [cx, b.maxZ + 0.6], [b.minX - 0.6, cz],
      ][b.front] as [number, number];
      expect(b.door.x).toBeCloseTo(expected[0], 9);
      expect(b.door.z).toBeCloseTo(expected[1], 9);
      expect(b.door.yaw).toBe(frontYaw(b.front));
      const block = city.blocks[b.block]!;
      expect(frontSideOf(b, block)).toBe(b.front);
    }
  });

  it('knows the station building', () => {
    expect(station).not.toBeNull();
    expect(station!.kind).toBe('policeStation');
    expect(station!.local).toBe(0);
    const poi = city.pois.find((p) => p.kind === 'station')!;
    expect(station!.block).toBe(poi.block);
    const door = stationLayout(city.blocks[poi.block]!, LANDMARKS.station.yaw).door;
    expect(station!.door.x).toBe(door.x);
    expect(station!.door.z).toBe(door.z);
    // The door faces out of the front wall.
    const nx = -Math.sin(station!.door.yaw), nz = -Math.cos(station!.door.yaw);
    const wall = [station!.minZ, station!.maxX, station!.maxZ, station!.minX][station!.front]!;
    const along = station!.front === 0 || station!.front === 2 ? station!.door.z : station!.door.x;
    const sign = station!.front === 0 || station!.front === 3 ? -1 : 1;
    expect(Math.abs(nx) + Math.abs(nz)).toBeCloseTo(1, 9);
    expect((along - wall) * sign).toBeGreaterThan(0);
    expect(generateInterior(SEED, station!)).not.toBeNull();
    // Every other building of the station block does not exist.
    expect(index.building(buildingId(poi.block, 1))).toBeNull();
  });

  it('finds the jail in downtown or industrial, near the station', () => {
    const jail = index.jail();
    expect(jail).not.toBeNull();
    expect(jail!.kind).toBe('jail');
    expect([DISTRICT.downtown, DISTRICT.industrial]).toContain(jail!.district);
    expect(Math.min(jail!.maxX - jail!.minX, jail!.maxZ - jail!.minZ)).toBeGreaterThanOrEqual(16);
    const block = city.blocks[jail!.block]!;
    expect(block.kind).toBe(BLOCK_KIND.lots);
    const poi = city.pois.find((p) => p.kind === 'station')!;
    expect(Math.hypot((block.minX + block.maxX) / 2 - poi.x, (block.minZ + block.maxZ) / 2 - poi.z)).toBeLessThanOrEqual(2000);
    expect(index.building(jail!.id)).toBe(jail);
    expect(generateInterior(SEED, jail!)).not.toBeNull();
    // Exactly one jail among the buildings of its neighbourhood.
    const near = index.near((jail!.minX + jail!.maxX) / 2, (jail!.minZ + jail!.maxZ) / 2, 600, []);
    expect(near.filter((b) => b.kind === 'jail').length).toBe(1);
    // Largest qualifying building among the first 60 blocks by distance is picked: no larger one in its own block.
    const rects = blockBuildingRects(city, jail!.block);
    const area = (jail!.maxX - jail!.minX) * (jail!.maxZ - jail!.minZ);
    for (let i = 0; i < rects.length; i += BUILDING_STRIDE) {
      const w = (rects[i + 2] ?? 0) - (rects[i] ?? 0), d = (rects[i + 3] ?? 0) - (rects[i + 1] ?? 0);
      if (Math.min(w, d) >= 16) expect(w * d).toBeLessThanOrEqual(area + 1e-6);
    }
  });

  it('answers unknown ids with null', () => {
    expect(index.building(-1)).toBeNull();
    expect(index.building(0.5)).toBeNull();
    expect(index.building(city.blocks.length * 256)).toBeNull();
    expect(index.building(buildingId(station!.block, 200))).toBeNull();
  });

  it('lists near buildings in ascending id and finds the one containing a point', () => {
    const cx = (station!.minX + station!.maxX) / 2, cz = (station!.minZ + station!.maxZ) / 2;
    const out: BuildingInfo[] = [];
    for (const [x, z, r] of [[cx, cz, 30], [0, 0, 120], [-1200, 800, 200]] as const) {
      const list = index.near(x, z, r, out);
      expect(list).toBe(out);
      for (let i = 1; i < list.length; i++) expect(list[i]!.id).toBeGreaterThan(list[i - 1]!.id);
      // Brute force over the blocks around the point.
      const expected: number[] = [];
      for (const bid of city.blocksIn(x - r, z - r, x + r, z + r, [])) {
        const rects = blockBuildingRects(city, bid);
        for (let i = 0; i < rects.length; i += BUILDING_STRIDE) {
          const dx = Math.max((rects[i] ?? 0) - x, 0, x - (rects[i + 2] ?? 0)), dz = Math.max((rects[i + 1] ?? 0) - z, 0, z - (rects[i + 3] ?? 0));
          if (dx * dx + dz * dz <= r * r) expected.push(buildingId(bid, i / BUILDING_STRIDE));
        }
      }
      expect(list.map((b) => b.id)).toEqual(expected.sort((a, b) => a - b));
    }
    expect(index.near(cx, cz, 5, out).some((b) => b.id === station!.id)).toBe(true);
    expect(index.at(cx, cz)?.id).toBe(station!.id);
    expect(index.at(station!.minX - 1, station!.minZ - 1)?.id).not.toBe(station!.id);
    const nothing = index.at(-3500, -3500);
    expect(nothing === null || nothing.minX <= -3500).toBe(true);
  });

  it('returns the nearest entrance', () => {
    const cx = (station!.minX + station!.maxX) / 2, cz = (station!.minZ + station!.maxZ) / 2;
    const probes: [number, number][] = [[cx, cz], [cx + 40, cz - 25], [60, 90], [-800, -700], [1500, 1200]];
    for (const [x, z] of probes) {
      for (const maxDist of [10, 60]) {
        const got = index.nearestEntrance(x, z, maxDist);
        let best: BuildingInfo | null = null;
        let bestD = maxDist * maxDist;
        for (const b of index.near(x, z, maxDist + 1, [])) {
          if (b.kind === null) continue;
          const d2 = (b.door.x - x) ** 2 + (b.door.z - z) ** 2;
          if (d2 < bestD || (d2 === bestD && best !== null && b.id < best.id)) { best = b; bestD = d2; }
        }
        expect(got?.id).toBe(best?.id);
        if (got) expect(got.kind).not.toBeNull();
      }
    }
    // The station's own door finds the station; a kinds filter excludes it.
    expect(index.nearestEntrance(station!.door.x, station!.door.z, 5)?.id).toBe(station!.id);
    const filtered = index.nearestEntrance(station!.door.x, station!.door.z, 200, ['house']);
    expect(filtered === null || filtered.kind === 'house').toBe(true);
    expect(index.nearestEntrance(-3500, -3500, 0.5)).toBeNull();
  });

  it('caches blocks with an LRU and counts lookups', () => {
    const small = new BuildingIndex(city, { cacheBlocks: 3 });
    const ids = city.blocks.filter((b) => b.kind === BLOCK_KIND.lots).slice(0, 10).map((b) => b.id);
    const first = ids.map((id) => small.building(buildingId(id, 0)));
    expect(small.stats.blocksCached).toBeLessThanOrEqual(3);
    expect(small.stats.lookups).toBe(10);
    // Evicted blocks rebuild to equal infos.
    expect(ids.map((id) => small.building(buildingId(id, 0)))).toEqual(first);
    const warm = new BuildingIndex(city);
    warm.building(buildingId(ids[0]!, 0));
    const before = warm.stats.blocksCached;
    warm.building(buildingId(ids[0]!, 0));
    expect(warm.stats.blocksCached).toBe(before);
  });

  it('fills the address through the callback', () => {
    const seen: [number, number][] = [];
    const addressed = new BuildingIndex(city, { addressAt: (x, z) => { seen.push([x, z]); return `${Math.round(x)} Test St`; } });
    const b = addressed.building(station!.id)!;
    expect(b.address).toBe(`${Math.round(b.door.x)} Test St`);
    expect(seen[0]).toEqual([b.door.x, b.door.z]);
    expect(index.building(station!.id)!.address).toBe('');
  });

  it('warm nearestEntrance is cheap', () => {
    const cx = (station!.minX + station!.maxX) / 2, cz = (station!.minZ + station!.maxZ) / 2;
    index.nearestEntrance(cx, cz, 30);
    const t0 = performance.now();
    for (let i = 0; i < 500; i++) index.nearestEntrance(cx + (i % 7), cz - (i % 5), 30);
    expect((performance.now() - t0) / 500).toBeLessThan(0.2);
  });
});
