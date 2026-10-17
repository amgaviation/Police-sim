import * as THREE from 'three';
import { PROP, PROP_STRIDE, chunkLayout } from '../chunkLayout';
import type { City } from '../city';
import { MAX_CHUNK, MIN_CHUNK, chunkCoord, chunkKey } from '../constants';
import { lampHeadPosition } from './chunkMesher';

/** Point light intensity (cd) and range (m) of a pooled streetlight. */
const LIGHT_INTENSITY = 60;
const LIGHT_DISTANCE = 35;
const LIGHT_COLOR = 0xffd9a0;
/** Cached chunk lamp lists are kept within this many chunks of the camera chunk. */
const KEEP_CHUNKS = 2;

/**
 * A fixed pool of `PointLight`s (never added or removed, so shaders never
 * recompile) moved to the lamp heads nearest the camera while streetlights are
 * on; intensity 0 otherwise. Lamp positions come from the chunk layouts of the
 * 3 x 3 chunks around the camera, computed on demand (at most one per update).
 */
export class StreetlightPool {
  readonly lights: readonly THREE.PointLight[];
  private readonly city: City;
  private readonly group = new THREE.Group();
  /** chunkKey -> lamp head positions (x, y, z per lamp). */
  private readonly lamps = new Map<number, Float32Array>();
  private readonly bestD2: Float64Array;
  private readonly bestPos: Float32Array;
  private disposed = false;

  constructor(scene: THREE.Scene, city: City, size = 4) {
    this.city = city;
    const lights: THREE.PointLight[] = [];
    for (let i = 0; i < size; i++) {
      const light = new THREE.PointLight(LIGHT_COLOR, 0, LIGHT_DISTANCE, 2);
      light.name = `streetlight:${i}`;
      light.position.set(0, -1000, 0);
      lights.push(light);
      this.group.add(light);
    }
    this.lights = lights;
    this.bestD2 = new Float64Array(size);
    this.bestPos = new Float32Array(size * 3);
    this.group.name = 'streetlights';
    scene.add(this.group);
  }

  /** Per frame: when `on`, moves the pool to the nearest lamp heads; otherwise all intensities are 0. */
  update(cameraX: number, cameraZ: number, on: boolean): void {
    if (this.disposed) return;
    const lights = this.lights;
    if (!on) {
      for (const light of lights) light.intensity = 0;
      return;
    }
    const ccx = chunkCoord(cameraX), ccz = chunkCoord(cameraZ);
    this.loadOne(ccx, ccz);
    this.evict(ccx, ccz);

    const n = lights.length;
    const best = this.bestD2;
    best.fill(Infinity);
    for (let cz = ccz - 1; cz <= ccz + 1; cz++) {
      for (let cx = ccx - 1; cx <= ccx + 1; cx++) {
        const list = this.lamps.get(chunkKey(cx, cz));
        if (!list) continue;
        for (let i = 0; i < list.length; i += 3) {
          const dx = (list[i] ?? 0) - cameraX, dz = (list[i + 2] ?? 0) - cameraZ;
          const d2 = dx * dx + dz * dz;
          if (!(d2 < (best[n - 1] ?? 0))) continue;
          // Insertion into the sorted top-n.
          let k = n - 1;
          while (k > 0 && (best[k - 1] ?? 0) > d2) {
            best[k] = best[k - 1] ?? 0;
            this.bestPos.copyWithin(k * 3, (k - 1) * 3, k * 3);
            k--;
          }
          best[k] = d2;
          this.bestPos[k * 3] = list[i] ?? 0;
          this.bestPos[k * 3 + 1] = list[i + 1] ?? 0;
          this.bestPos[k * 3 + 2] = list[i + 2] ?? 0;
        }
      }
    }
    for (let k = 0; k < n; k++) {
      const light = lights[k] as THREE.PointLight;
      if (best[k] === Infinity) {
        light.intensity = 0;
        continue;
      }
      light.position.set(this.bestPos[k * 3] ?? 0, this.bestPos[k * 3 + 1] ?? 0, this.bestPos[k * 3 + 2] ?? 0);
      light.intensity = LIGHT_INTENSITY;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    for (const light of this.lights) light.dispose();
    this.lamps.clear();
  }

  /** Computes the lamp list of the nearest missing chunk of the 3 x 3 window (camera chunk first). */
  private loadOne(ccx: number, ccz: number): void {
    let bestKey = -1, bestCx = 0, bestCz = 0, bestD = Infinity;
    for (let cz = ccz - 1; cz <= ccz + 1; cz++) {
      for (let cx = ccx - 1; cx <= ccx + 1; cx++) {
        if (cx < MIN_CHUNK || cx > MAX_CHUNK || cz < MIN_CHUNK || cz > MAX_CHUNK) continue;
        const key = chunkKey(cx, cz);
        if (this.lamps.has(key)) continue;
        const d = Math.abs(cx - ccx) + Math.abs(cz - ccz);
        if (d < bestD) { bestD = d; bestKey = key; bestCx = cx; bestCz = cz; }
      }
    }
    if (bestKey < 0) return;
    const props = chunkLayout(this.city, bestCx, bestCz).props;
    const out: number[] = [];
    const p = { x: 0, y: 0, z: 0 };
    for (let i = 0; i + PROP_STRIDE <= props.length; i += PROP_STRIDE) {
      const kind = props[i] ?? 0;
      if (kind !== PROP.streetlight && kind !== PROP.lotLight) continue;
      lampHeadPosition(kind, props[i + 1] ?? 0, props[i + 2] ?? 0, props[i + 3] ?? 0, p);
      out.push(p.x, p.y, p.z);
    }
    this.lamps.set(bestKey, new Float32Array(out));
  }

  private evict(ccx: number, ccz: number): void {
    if (this.lamps.size <= (2 * KEEP_CHUNKS + 1) ** 2) return;
    for (const key of this.lamps.keys()) {
      const cx = (key >> 7) - 64, cz = (key & 127) - 64;
      if (Math.abs(cx - ccx) > KEEP_CHUNKS || Math.abs(cz - ccz) > KEEP_CHUNKS) this.lamps.delete(key);
    }
  }
}
