import * as THREE from 'three';
import { log } from '../../core/log';
import { errorToString } from '../../workers/protocol';
import type { WorkerClient } from '../../workers/workerClient';
import { chunkLayout } from '../chunkLayout';
import type { City } from '../city';
import { CHUNKS_PER_SIDE, CHUNK_SIZE, MAX_CHUNK, MIN_CHUNK, chunkCoord, chunkKey } from '../constants';
import { buildChunkMesh, type ChunkGroupName, type ChunkMeshData } from './chunkMesher';
import type { ChunkWorkerMap } from './chunkProtocol';
import { CityMaterials } from './cityMaterials';

/** A chunk loads when its AABB is nearer than viewDistance + LOAD_MARGIN and unloads beyond viewDistance + UNLOAD_MARGIN. */
export const LOAD_MARGIN = 32;
export const UNLOAD_MARGIN = 160;
/** LOD0 nearer than LOD0_NEAR; an LOD0 chunk drops back to LOD1 beyond LOD0_FAR. */
export const LOD0_NEAR = 300;
export const LOD0_FAR = 340;
/** Camera movement (m) or view distance change that triggers recomputing the wanted set. */
const REFRESH_DISTANCE = 4;

export type ChunkLod = 0 | 1;

/** Distance from (x, z) to the AABB of chunk (cx, cz); 0 inside. */
export function chunkDistance(x: number, z: number, cx: number, cz: number): number {
  const minX = cx * CHUNK_SIZE, minZ = cz * CHUNK_SIZE;
  const dx = Math.max(minX - x, 0, x - (minX + CHUNK_SIZE));
  const dz = Math.max(minZ - z, 0, z - (minZ + CHUNK_SIZE));
  return Math.hypot(dx, dz);
}

export function chunkKeyX(key: number): number {
  return (key >> 7) - 64;
}

export function chunkKeyZ(key: number): number {
  return (key & 127) - 64;
}

/**
 * Wanted chunks (chunkKey -> LOD) for a camera position, with load/unload and
 * LOD hysteresis against `current` (the previous result), clamped to the world.
 * Clears and fills `out`.
 */
export function desiredChunks(
  camX: number,
  camZ: number,
  viewDistance: number,
  current: ReadonlyMap<number, ChunkLod>,
  out: Map<number, ChunkLod>,
): Map<number, ChunkLod> {
  out.clear();
  const reach = viewDistance + UNLOAD_MARGIN;
  const x0 = Math.max(MIN_CHUNK, chunkCoord(camX - reach)), x1 = Math.min(MAX_CHUNK, chunkCoord(camX + reach));
  const z0 = Math.max(MIN_CHUNK, chunkCoord(camZ - reach)), z1 = Math.min(MAX_CHUNK, chunkCoord(camZ + reach));
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      const key = chunkKey(cx, cz);
      const d = chunkDistance(camX, camZ, cx, cz);
      const prev = current.get(key);
      if (prev === undefined ? !(d < viewDistance + LOAD_MARGIN) : d > reach) continue;
      const lod: ChunkLod = prev === 0 ? (d > LOD0_FAR ? 1 : 0) : d < LOD0_NEAR ? 0 : 1;
      out.set(key, lod);
    }
  }
  return out;
}

export interface ChunkStreamerOptions {
  /** Meshing worker; null/absent meshes on the main thread. The caller owns (and terminates) it. */
  worker?: WorkerClient<ChunkWorkerMap> | null;
  maxInFlight?: number;
  maxResident?: number;
  shadows?: boolean;
}

export interface ChunkStreamerStats {
  loaded: number;
  inFlight: number;
  lod0: number;
  lod1: number;
}

interface Resident {
  group: THREE.Group;
  lod: ChunkLod;
}

interface ReadyMesh {
  key: number;
  lod: ChunkLod;
  data: ChunkMeshData;
}

function chunkIndex(key: number): number {
  return (chunkKeyX(key) - MIN_CHUNK) * CHUNKS_PER_SIDE + (chunkKeyZ(key) - MIN_CHUNK);
}

function castsShadow(name: string): boolean {
  return name === 'buildings' || name === 'props';
}

/**
 * Streams merged chunk meshes around the camera: requests missing chunk/LOD pairs
 * nearest-first from the worker (at most `maxInFlight`), keeps the old LOD visible
 * until the new one arrives, uploads at most one chunk per frame, disposes the
 * geometry of unloaded chunks and caps residency. Without a worker, or after it
 * fails, it meshes synchronously (one chunk per frame). Render-only.
 */
export class ChunkStreamer {
  readonly stats: ChunkStreamerStats = { loaded: 0, inFlight: 0, lod0: 0, lod1: 0 };
  /** Parent of every chunk group (named 'city'). */
  readonly root = new THREE.Group();
  private readonly city: City;
  private readonly worker: WorkerClient<ChunkWorkerMap> | null;
  private readonly materials = new CityMaterials();
  private readonly maxInFlight: number;
  private readonly maxResident: number;
  private shadows: boolean;
  private workerFailed = false;
  private disposed = false;
  private desired = new Map<number, ChunkLod>();
  private previous = new Map<number, ChunkLod>();
  /** Wanted keys, nearest first. */
  private readonly order: number[] = [];
  private readonly distance = new Float64Array(CHUNKS_PER_SIDE * CHUNKS_PER_SIDE);
  private readonly resident = new Map<number, Resident>();
  /** Requested (or received but not yet uploaded) chunk -> LOD. */
  private readonly inFlight = new Map<number, ChunkLod>();
  private readonly ready: ReadyMesh[] = [];
  private lastX = NaN;
  private lastZ = NaN;
  private lastView = NaN;
  private readonly byDistance = (a: number, b: number): number =>
    (this.distance[chunkIndex(a)] ?? 0) - (this.distance[chunkIndex(b)] ?? 0) || a - b;

  constructor(scene: THREE.Scene, city: City, options: ChunkStreamerOptions = {}) {
    this.city = city;
    this.worker = options.worker ?? null;
    this.maxInFlight = Math.max(1, options.maxInFlight ?? 3);
    this.maxResident = Math.max(1, options.maxResident ?? 96);
    this.shadows = options.shadows ?? true;
    this.root.name = 'city';
    this.root.matrixAutoUpdate = false;
    scene.add(this.root);
    if (this.worker) {
      this.worker.call('init', { seed: city.seed }).then(
        () => undefined,
        (error: unknown) => this.failWorker(error),
      );
    }
  }

  /** Per frame: recompute the wanted set when the camera moved, upload one chunk, issue requests. */
  update(cameraX: number, cameraZ: number, viewDistance: number): void {
    if (this.disposed) return;
    const moved = Math.hypot(cameraX - this.lastX, cameraZ - this.lastZ);
    if (!(moved < REFRESH_DISTANCE) || !(Math.abs(viewDistance - this.lastView) < 1)) this.refresh(cameraX, cameraZ, viewDistance);
    this.uploadOne();
    if (this.workerUsable()) this.request();
    this.stats.loaded = this.resident.size;
    this.stats.inFlight = this.inFlight.size;
  }

  /** Window glow follows the night factor; lamp heads glow while streetlights are on. */
  setLighting(nightFactor: number, streetlightsOn: boolean): void {
    this.materials.setLighting(nightFactor, streetlightsOn);
  }

  /** Forwards the wet sheen (`weather.wetness`, `weather.snowCover`) to the shared ground and marking materials. */
  setWetness(wetness: number, snowCover: number): void {
    this.materials.setWetness(wetness, snowCover);
  }

  /** Toggles shadow casting of LOD0 buildings and props. */
  setShadows(enabled: boolean): void {
    this.shadows = enabled;
    for (const r of this.resident.values()) {
      if (r.lod !== 0) continue;
      for (const child of r.group.children) child.castShadow = enabled && castsShadow(child.name);
    }
  }

  /** Removes every chunk and frees its geometry and the shared materials; later replies are ignored. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.removeFromParent();
    for (const r of this.resident.values()) this.disposeGroup(r.group);
    this.resident.clear();
    this.inFlight.clear();
    this.ready.length = 0;
    this.materials.dispose();
  }

  private workerUsable(): boolean {
    return this.worker !== null && !this.workerFailed && !this.worker.isTerminated;
  }

  private failWorker(error: unknown): void {
    if (this.disposed || this.workerFailed) return;
    this.workerFailed = true;
    log.warn(`ChunkStreamer: chunk worker failed (${errorToString(error)}); meshing on the main thread`);
  }

  private refresh(x: number, z: number, viewDistance: number): void {
    this.lastX = x;
    this.lastZ = z;
    this.lastView = viewDistance;
    const swap = this.previous;
    this.previous = this.desired;
    this.desired = desiredChunks(x, z, viewDistance, this.previous, swap);
    const order = this.order;
    order.length = 0;
    for (const key of this.desired.keys()) {
      this.distance[chunkIndex(key)] = chunkDistance(x, z, chunkKeyX(key), chunkKeyZ(key));
      order.push(key);
    }
    order.sort(this.byDistance);
    if (order.length > this.maxResident) {
      for (let i = this.maxResident; i < order.length; i++) this.desired.delete(order[i] ?? 0);
      order.length = this.maxResident;
    }
    for (const [key, r] of this.resident) {
      if (this.desired.has(key)) continue;
      this.resident.delete(key);
      this.countLod(r.lod, -1);
      r.group.removeFromParent();
      this.disposeGroup(r.group);
    }
  }

  private needsWork(key: number): ChunkLod | -1 {
    const lod = this.desired.get(key);
    if (lod === undefined || this.inFlight.has(key) || this.resident.get(key)?.lod === lod) return -1;
    return lod;
  }

  private request(): void {
    const order = this.order;
    for (let i = 0; i < order.length && this.inFlight.size < this.maxInFlight; i++) {
      const key = order[i] ?? 0;
      const lod = this.needsWork(key);
      if (lod !== -1) this.send(key, lod);
    }
  }

  private send(key: number, lod: ChunkLod): void {
    const worker = this.worker as WorkerClient<ChunkWorkerMap>;
    this.inFlight.set(key, lod);
    worker.call('build', { cx: chunkKeyX(key), cz: chunkKeyZ(key), lod }).then(
      (data) => {
        if (!this.disposed) this.ready.push({ key, lod, data });
      },
      (error: unknown) => {
        if (this.disposed) return;
        this.inFlight.delete(key);
        this.failWorker(error);
      },
    );
  }

  /** Uploads the first still-wanted worker result, or (without a worker) meshes the nearest missing chunk. */
  private uploadOne(): void {
    while (this.ready.length > 0) {
      const item = this.ready.shift() as ReadyMesh;
      this.inFlight.delete(item.key);
      if (this.desired.get(item.key) !== item.lod) continue;
      this.install(item.key, item.data);
      return;
    }
    if (this.workerUsable()) return;
    const order = this.order;
    for (let i = 0; i < order.length; i++) {
      const key = order[i] ?? 0;
      const lod = this.needsWork(key);
      if (lod === -1) continue;
      const cx = chunkKeyX(key), cz = chunkKeyZ(key);
      this.install(key, buildChunkMesh(this.city, chunkLayout(this.city, cx, cz), lod));
      return;
    }
  }

  private install(key: number, data: ChunkMeshData): void {
    const group = new THREE.Group();
    group.name = `chunk:${data.cx},${data.cz}`;
    group.matrixAutoUpdate = false;
    for (const g of data.groups) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
      geometry.setAttribute('color', new THREE.BufferAttribute(g.colors, 3));
      if (g.uvs) geometry.setAttribute('uv', new THREE.BufferAttribute(g.uvs, 2));
      geometry.setIndex(new THREE.BufferAttribute(g.indices, 1));
      const [x, y, z, r] = g.sphere;
      geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(x, y, z), r);
      const mesh = new THREE.Mesh(geometry, this.materials.get(g.name));
      mesh.name = g.name satisfies ChunkGroupName;
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = data.lod === 0 && this.shadows && castsShadow(g.name);
      mesh.receiveShadow = g.name !== 'lamps';
      group.add(mesh);
    }
    this.root.add(group);
    const old = this.resident.get(key);
    if (old) {
      this.countLod(old.lod, -1);
      old.group.removeFromParent();
      this.disposeGroup(old.group);
    }
    this.resident.set(key, { group, lod: data.lod });
    this.countLod(data.lod, 1);
  }

  private countLod(lod: ChunkLod, delta: number): void {
    if (lod === 0) this.stats.lod0 += delta;
    else this.stats.lod1 += delta;
  }

  private disposeGroup(group: THREE.Group): void {
    for (const child of group.children) (child as THREE.Mesh).geometry.dispose();
  }
}
