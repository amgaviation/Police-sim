/**
 * Training cones (Phase 8 design 7.7): one `InstancedMesh`, one draw call. Matrices are written only in `set` (when a
 * course starts or a cone is knocked); nothing is allocated per frame. Constructible without WebGL.
 */
import {
  ConeGeometry,
  InstancedMesh,
  Matrix4,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
  type Scene,
} from 'three';

/** Most cones shown at once. */
export const CONE_CAPACITY = 64;
/** Cone size (m). */
export const CONE_RADIUS = 0.18;
export const CONE_HEIGHT = 0.5;
export const CONE_COLOR = 0xff7a1a;

export class ConeRenderer {
  readonly mesh: InstancedMesh;
  private readonly scene: Scene;
  private readonly geometry: ConeGeometry;
  private readonly material: MeshStandardMaterial;
  private readonly matrix = new Matrix4();
  private readonly position = new Vector3();
  private readonly scale = new Vector3(1, 1, 1);
  private readonly standing = new Quaternion();
  private readonly lying = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);

  constructor(scene: Scene) {
    this.scene = scene;
    this.geometry = new ConeGeometry(CONE_RADIUS, CONE_HEIGHT, 8);
    this.material = new MeshStandardMaterial({ color: CONE_COLOR, roughness: 0.7, metalness: 0 });
    this.mesh = new InstancedMesh(this.geometry, this.material, CONE_CAPACITY);
    this.mesh.name = 'training-cones';
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
  }

  /** Cones currently shown. */
  get count(): number {
    return this.mesh.count;
  }

  /**
   * Shows `count` cones (at most 64) at x, z pairs of `xz`; `knocked[i] = 1` lays cone i on its side. `groundY` is the
   * road height under the course.
   */
  set(xz: Float32Array, count: number, knocked: Uint8Array, groundY = 0): void {
    const n = Math.max(0, Math.min(count, CONE_CAPACITY, xz.length >> 1));
    for (let i = 0; i < n; i++) {
      const down = knocked[i] === 1;
      this.position.set(xz[2 * i] as number, groundY + (down ? CONE_RADIUS : CONE_HEIGHT * 0.5), xz[2 * i + 1]);
      this.matrix.compose(this.position, down ? this.lying : this.standing, this.scale);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** Hides every cone. */
  clear(): void {
    this.mesh.count = 0;
  }

  dispose(): void {
    this.scene.remove(this.mesh);
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}
