import { BuildingIndex, BUILDING_KINDS, frontYaw, type BuildingInfo, type BuildingKind, type FrontSide } from '../../src/world/buildings';
import { DISTRICT } from '../../src/world/ids';
import { INTERIOR_TEMPLATES } from '../../src/interior/templates';
import type { InteriorLayout } from '../../src/interior/types';
import { generateInterior } from '../../src/interior/generate';
import { cityFor } from '../world/helpers';

export const SEED = 42;

export function indexFor(seed: number = SEED): BuildingIndex {
  return new BuildingIndex(cityFor(seed));
}

/** A hand-made building of `kind` with the given footprint size, centred at (cx, cz). */
export function handBuilding(kind: BuildingKind, w: number, d: number, front: FrontSide = 0, id = 900_000, cx = 100.013, cz = -200.027): BuildingInfo {
  return {
    id, block: Math.floor(id / 256), local: id % 256,
    minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2,
    height: 6, district: DISTRICT.downtown, kind, front,
    door: { x: cx, z: cz - d / 2 - 0.6, yaw: frontYaw(front) }, address: '',
  };
}

/** Minimum and maximum footprint of a kind's template for the given front side. */
export function templateSizes(kind: BuildingKind, front: FrontSide): { min: [number, number]; max: [number, number] } {
  const t = INTERIOR_TEMPLATES.templates[kind];
  const swap = front === 1 || front === 3;
  const min: [number, number] = swap ? [t.minDepth, t.minWidth] : [t.minWidth, t.minDepth];
  const max: [number, number] = swap ? [t.maxDepth + 6, t.maxWidth + 6] : [t.maxWidth + 6, t.maxDepth + 6];
  return { min, max };
}

/** Up to `perKind` enterable buildings per kind, iterating blocks in id order. */
export function cityBuildings(index: BuildingIndex, perKind = 20): BuildingInfo[] {
  const counts = new Map<string, number>();
  const out: BuildingInfo[] = [];
  const city = cityFor(SEED);
  for (const b of city.blocks) {
    for (let local = 0; local < 40; local++) {
      const info = index.building(b.id * 256 + local);
      if (info === null) break;
      if (info.kind === null) continue;
      const n = counts.get(info.kind) ?? 0;
      if (n >= perKind) continue;
      counts.set(info.kind, n + 1);
      out.push(info);
    }
  }
  return out;
}

/** Hand-made sample: every kind on every front, at minimum and a large size. */
export function handBuildings(): BuildingInfo[] {
  const out: BuildingInfo[] = [];
  let id = 900_000;
  for (const kind of BUILDING_KINDS) {
    for (const front of [0, 1, 2, 3] as const) {
      const { min, max } = templateSizes(kind, front);
      out.push(handBuilding(kind, min[0], min[1], front, id++));
      out.push(handBuilding(kind, (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, front, id++));
      out.push(handBuilding(kind, max[0], max[1], front, id++));
    }
  }
  return out;
}

export function layoutsOf(seed: number, buildings: readonly BuildingInfo[]): InteriorLayout[] {
  const out: InteriorLayout[] = [];
  for (const b of buildings) {
    const l = generateInterior(seed, b);
    if (l === null) throw new Error(`no layout for ${b.kind} ${b.id}`);
    out.push(l);
  }
  return out;
}
