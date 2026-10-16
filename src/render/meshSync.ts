import { addComponent, entityExists, hasComponent, removeComponent, type EntityId } from 'bitecs';
import * as THREE from 'three';
import { PrevTransform, RenderMesh, Transform, type TransformStore } from '../ecs/components';
import type { GameWorld } from '../ecs/world';

/** Maximum instances in the shared box pool. */
export const BOX_POOL_SIZE = 2000;

export interface BoxOptions {
  /** Full extents of the box (default 1x1x1). */
  size?: { x: number; y: number; z: number };
  color?: THREE.ColorRepresentation;
}

export interface MeshRegistryOptions {
  /** When given, `addBox`/`add` tag the entity with `RenderMesh` and `remove` clears it. */
  world?: GameWorld;
  boxPoolSize?: number;
  boxMaterial?: THREE.Material;
  /** Whether boxes cast/receive shadows. Default true. */
  shadows?: boolean;
}

const scratchPos = new THREE.Vector3();
const scratchQa = new THREE.Quaternion();
const scratchQb = new THREE.Quaternion();
const scratchQ = new THREE.Quaternion();
const scratchScale = new THREE.Vector3();
const scratchMatrix = new THREE.Matrix4();
const scratchColor = new THREE.Color();

/** Writes the interpolated position/rotation of `eid` into `pos` and `quat`. */
export function interpolateTransform(
  eid: EntityId,
  alpha: number,
  pos: THREE.Vector3,
  quat: THREE.Quaternion,
  prev: TransformStore = PrevTransform,
  cur: TransformStore = Transform,
): void {
  const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  const px = prev.x[eid] ?? 0;
  const py = prev.y[eid] ?? 0;
  const pz = prev.z[eid] ?? 0;
  pos.set(
    px + ((cur.x[eid] ?? 0) - px) * t,
    py + ((cur.y[eid] ?? 0) - py) * t,
    pz + ((cur.z[eid] ?? 0) - pz) * t,
  );
  scratchQa.set(prev.qx[eid] ?? 0, prev.qy[eid] ?? 0, prev.qz[eid] ?? 0, prev.qw[eid] ?? 1);
  scratchQb.set(cur.qx[eid] ?? 0, cur.qy[eid] ?? 0, cur.qz[eid] ?? 0, cur.qw[eid] ?? 1);
  quat.slerpQuaternions(scratchQa, scratchQb, t);
}

/**
 * Maps entity ids to renderable objects and copies interpolated ECS transforms
 * into them each frame. Boxes share one `InstancedMesh`; everything else is a
 * per-entity `Object3D` added to the scene.
 */
export class MeshRegistry {
  readonly scene: THREE.Scene;
  readonly boxes: THREE.InstancedMesh;
  private readonly world: GameWorld | undefined;
  private readonly objects = new Map<EntityId, THREE.Object3D>();
  private readonly boxSlot = new Map<EntityId, number>();
  private readonly slotEid: Int32Array;
  private readonly slotScale: Float32Array;
  private readonly poolSize: number;
  private boxCountValue = 0;

  constructor(scene: THREE.Scene, options: MeshRegistryOptions = {}) {
    this.scene = scene;
    this.world = options.world;
    this.poolSize = Math.max(1, Math.floor(options.boxPoolSize ?? BOX_POOL_SIZE));
    this.slotEid = new Int32Array(this.poolSize);
    this.slotScale = new Float32Array(this.poolSize * 3);

    const material = options.boxMaterial ?? new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
    this.boxes = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, this.poolSize);
    this.boxes.name = 'box-pool';
    this.boxes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boxes.frustumCulled = false;
    this.boxes.castShadow = options.shadows ?? true;
    this.boxes.receiveShadow = options.shadows ?? true;
    this.boxes.count = 0;
    scene.add(this.boxes);
  }

  /** Number of entities with a box instance. */
  get boxCount(): number {
    return this.boxCountValue;
  }

  /** Number of entities with a per-entity object. */
  get objectCount(): number {
    return this.objects.size;
  }

  /** Total registered entities. */
  get count(): number {
    return this.boxCountValue + this.objects.size;
  }

  has(eid: EntityId): boolean {
    return this.boxSlot.has(eid) || this.objects.has(eid);
  }

  /** The per-entity object for `eid` (boxes have none). */
  get(eid: EntityId): THREE.Object3D | undefined {
    return this.objects.get(eid);
  }

  /** Gives `eid` an instance in the box pool. Throws when the pool is full. */
  addBox(eid: EntityId, options: BoxOptions = {}): void {
    this.remove(eid);
    if (this.boxCountValue >= this.poolSize) {
      throw new RangeError(`MeshRegistry: box pool is full (${String(this.poolSize)})`);
    }
    const slot = this.boxCountValue++;
    this.boxSlot.set(eid, slot);
    this.slotEid[slot] = eid;
    const size = options.size ?? { x: 1, y: 1, z: 1 };
    this.slotScale[slot * 3] = size.x;
    this.slotScale[slot * 3 + 1] = size.y;
    this.slotScale[slot * 3 + 2] = size.z;
    scratchColor.set(options.color ?? 0xffffff);
    this.boxes.setColorAt(slot, scratchColor);
    if (this.boxes.instanceColor) this.boxes.instanceColor.needsUpdate = true;
    this.boxes.count = this.boxCountValue;
    this.tag(eid);
  }

  /** Attaches a per-entity object (added to the scene) to `eid`. */
  add(eid: EntityId, object: THREE.Object3D): void {
    this.remove(eid);
    this.objects.set(eid, object);
    if (object.parent !== this.scene) this.scene.add(object);
    this.tag(eid);
  }

  /** Detaches whatever `eid` has; per-entity objects are removed from the scene but not disposed. */
  remove(eid: EntityId): boolean {
    const object = this.objects.get(eid);
    if (object) {
      this.objects.delete(eid);
      object.removeFromParent();
      this.untag(eid);
      return true;
    }
    const slot = this.boxSlot.get(eid);
    if (slot === undefined) return false;
    this.boxSlot.delete(eid);
    const last = --this.boxCountValue;
    if (slot !== last) {
      const movedEid = this.slotEid[last] ?? 0;
      this.slotEid[slot] = movedEid;
      this.boxSlot.set(movedEid, slot);
      this.slotScale.copyWithin(slot * 3, last * 3, last * 3 + 3);
      if (this.boxes.instanceColor) {
        this.boxes.getColorAt(last, scratchColor);
        this.boxes.setColorAt(slot, scratchColor);
        this.boxes.instanceColor.needsUpdate = true;
      }
      this.boxes.getMatrixAt(last, scratchMatrix);
      this.boxes.setMatrixAt(slot, scratchMatrix);
      this.boxes.instanceMatrix.needsUpdate = true;
    }
    this.boxes.count = this.boxCountValue;
    this.untag(eid);
    return true;
  }

  /** Removes entries whose entity is dead or no longer tagged `RenderMesh`; returns how many. */
  reconcile(world: GameWorld = this.requireWorld()): number {
    let removed = 0;
    for (const eid of [...this.objects.keys(), ...this.boxSlot.keys()]) {
      if (!entityExists(world, eid) || !hasComponent(world, eid, RenderMesh)) {
        this.remove(eid);
        removed += 1;
      }
    }
    return removed;
  }

  /**
   * Copies transforms interpolated between `PrevTransform` and `Transform` by
   * `alpha` (the loop's interpolation factor) into every registered object.
   */
  syncFromEcs(alpha: number): void {
    const n = this.boxCountValue;
    for (let slot = 0; slot < n; slot++) {
      const eid = this.slotEid[slot] ?? 0;
      interpolateTransform(eid, alpha, scratchPos, scratchQ);
      scratchScale.set(
        this.slotScale[slot * 3] ?? 1,
        this.slotScale[slot * 3 + 1] ?? 1,
        this.slotScale[slot * 3 + 2] ?? 1,
      );
      scratchMatrix.compose(scratchPos, scratchQ, scratchScale);
      this.boxes.setMatrixAt(slot, scratchMatrix);
    }
    if (n > 0) this.boxes.instanceMatrix.needsUpdate = true;

    for (const [eid, object] of this.objects) {
      interpolateTransform(eid, alpha, object.position, object.quaternion);
    }
  }

  /** Removes all entries and frees the box pool's GPU resources. */
  dispose(): void {
    for (const eid of [...this.objects.keys()]) this.remove(eid);
    for (const eid of [...this.boxSlot.keys()]) this.remove(eid);
    this.boxes.removeFromParent();
    this.boxes.geometry.dispose();
    const material = this.boxes.material;
    if (Array.isArray(material)) for (const m of material) m.dispose();
    else material.dispose();
    this.boxes.dispose();
  }

  private requireWorld(): GameWorld {
    if (!this.world) throw new Error('MeshRegistry: no world was provided');
    return this.world;
  }

  private tag(eid: EntityId): void {
    if (this.world && entityExists(this.world, eid)) addComponent(this.world, eid, RenderMesh);
  }

  private untag(eid: EntityId): void {
    if (this.world && entityExists(this.world, eid) && hasComponent(this.world, eid, RenderMesh)) {
      removeComponent(this.world, eid, RenderMesh);
    }
  }
}
