import RAPIER, { type Collider } from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../physics/physics';
import { COLLIDER_STRIDE, chunkLayout } from './chunkLayout';
import type { City } from './city';
import { MAX_CHUNK, MIN_CHUNK, chunkCoord, chunkKey } from './constants';

export interface WorldCollidersOptions {
  /** Chunks loaded around the centre chunk on each side; 1 = 3 x 3. */
  radiusChunks?: number;
  /** Chunk loads + unloads per `update` call. */
  maxChunkOpsPerStep?: number;
}

/** (cz, cx) order key of a chunk, so sorting it sorts rows first. */
function rowKey(cx: number, cz: number): number {
  return (cz + 64) * 128 + (cx + 64);
}

/**
 * Streams fixed cuboid colliders for the chunks around a point (the player's
 * sim position, updated in the fixed step). Chunk work is spread over steps:
 * adds first, then removes, each in (cz, cx) order, so streaming depends only
 * on the position sequence.
 */
export class WorldColliders {
  private readonly physics: PhysicsWorld;
  private readonly city: City;
  private readonly radius: number;
  private readonly maxOps: number;
  /** chunkKey -> colliders created for that chunk. */
  private readonly loaded = new Map<number, Collider[]>();
  private readonly rotation = { x: 0, y: 0, z: 0, w: 1 };
  private centerX = Number.NaN;
  private centerZ = Number.NaN;
  private pending = false;
  private count = 0;

  constructor(physics: PhysicsWorld, city: City, options: WorldCollidersOptions = {}) {
    this.physics = physics;
    this.city = city;
    this.radius = Math.max(0, Math.floor(options.radiusChunks ?? 1));
    this.maxOps = Math.max(1, Math.floor(options.maxChunkOpsPerStep ?? 1));
  }

  get loadedChunks(): number {
    return this.loaded.size;
  }

  get colliderCount(): number {
    return this.count;
  }

  /** Fixed step: moves the window to (x, z) and performs at most `maxChunkOpsPerStep` chunk ops. */
  update(x: number, z: number): void {
    this.recenter(x, z);
    if (this.pending) this.run(this.maxOps);
  }

  /** Loads (and unloads) the whole window around (x, z) now: session start, load, teleport. */
  prime(x: number, z: number): void {
    this.recenter(x, z);
    this.run(Infinity);
  }

  /** Removes every collider this instance created. Skip when the physics world itself is being disposed. */
  dispose(): void {
    for (const colliders of this.loaded.values()) for (const c of colliders) this.physics.raw.removeCollider(c, false);
    this.loaded.clear();
    this.count = 0;
    this.pending = false;
  }

  private recenter(x: number, z: number): void {
    const cx = chunkCoord(x);
    const cz = chunkCoord(z);
    if (cx === this.centerX && cz === this.centerZ) return;
    this.centerX = cx;
    this.centerZ = cz;
    this.pending = true;
  }

  private inWindow(cx: number, cz: number): boolean {
    return Math.abs(cx - this.centerX) <= this.radius && Math.abs(cz - this.centerZ) <= this.radius;
  }

  private run(maxOps: number): void {
    let ops = 0;
    const r = this.radius;
    for (let cz = this.centerZ - r; cz <= this.centerZ + r; cz++) {
      for (let cx = this.centerX - r; cx <= this.centerX + r; cx++) {
        if (cx < MIN_CHUNK || cx > MAX_CHUNK || cz < MIN_CHUNK || cz > MAX_CHUNK) continue;
        if (this.loaded.has(chunkKey(cx, cz))) continue;
        if (ops >= maxOps) return;
        this.load(cx, cz);
        ops++;
      }
    }
    const stale: number[] = [];
    for (const key of this.loaded.keys()) {
      const cx = Math.floor(key / 128) - 64;
      const cz = (key % 128) - 64;
      if (!this.inWindow(cx, cz)) stale.push(rowKey(cx, cz));
    }
    stale.sort((a, b) => a - b);
    for (const rk of stale) {
      if (ops >= maxOps) return;
      this.unload(chunkKey((rk % 128) - 64, Math.floor(rk / 128) - 64));
      ops++;
    }
    this.pending = false;
  }

  private load(cx: number, cz: number): void {
    const data = chunkLayout(this.city, cx, cz).colliders;
    const world = this.physics.raw;
    const colliders: Collider[] = [];
    for (let i = 0; i < data.length; i += COLLIDER_STRIDE) {
      const yaw = data[i + 6] ?? 0;
      this.rotation.y = Math.sin(yaw / 2);
      this.rotation.w = Math.cos(yaw / 2);
      const desc = RAPIER.ColliderDesc.cuboid(data[i + 3] ?? 0, data[i + 4] ?? 0, data[i + 5] ?? 0)
        .setTranslation(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0)
        .setRotation(this.rotation);
      colliders.push(world.createCollider(desc));
    }
    this.loaded.set(chunkKey(cx, cz), colliders);
    this.count += colliders.length;
  }

  private unload(key: number): void {
    const colliders = this.loaded.get(key);
    if (!colliders) return;
    for (const c of colliders) this.physics.raw.removeCollider(c, false);
    this.loaded.delete(key);
    this.count -= colliders.length;
  }
}
