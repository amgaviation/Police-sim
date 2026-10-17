import * as THREE from 'three';
import { HEAD_STRIDE, SIGNAL_POLE_HEIGHT, allSignalHeads } from '../chunkLayout';
import type { City } from '../city';
import type { RoadGraph } from '../roadGraph';

/** Instances per head: pole, housing, then the red, yellow and green lamps. */
export const SIGNAL_HEAD_PARTS = 5;
export const SIGNAL_PART = { pole: 0, housing: 1, red: 2, yellow: 3, green: 4 } as const;
/** Heads nearer than this to the camera are refreshed every frame (m). */
export const SIGNAL_REFRESH_RADIUS = 200;

/** Linear RGB of each lamp lit and unlit, and of the pole/housing. */
export const SIGNAL_LIT: readonly (readonly [number, number, number])[] = [
  [1.6, 0.08, 0.05],
  [1.6, 0.7, 0.04],
  [0.1, 1.5, 0.45],
];
export const SIGNAL_UNLIT: readonly (readonly [number, number, number])[] = [
  [0.09, 0.01, 0.01],
  [0.09, 0.05, 0.01],
  [0.01, 0.08, 0.03],
];
const BODY_COLOR = [0.015, 0.016, 0.018] as const;
const HOUSING_Y = SIGNAL_POLE_HEIGHT - 0.7;
/** Lamp order by aspect: ASPECT.green = 0 -> green lamp, yellow -> yellow, red -> red. */
const LAMP_OF_ASPECT = [SIGNAL_PART.green, SIGNAL_PART.yellow, SIGNAL_PART.red] as const;

/**
 * Every traffic signal head of the city in one `InstancedMesh` of unit boxes
 * (pole, housing, three lamps per head). Lamp colours come from
 * `graph.signalAspect` via `instanceColor`; heads within 200 m of the camera are
 * refreshed each frame (allocation-free, uploads only when an aspect changed).
 */
export class SignalHeads {
  readonly mesh: THREE.InstancedMesh;
  /** Number of heads (instances / SIGNAL_HEAD_PARTS). */
  readonly count: number;
  private readonly graph: RoadGraph;
  private readonly heads: Float32Array;
  /** Aspect currently shown per head, -1 before the first refresh. */
  private readonly shown: Int8Array;
  private readonly colors: Float32Array;
  private disposed = false;

  constructor(scene: THREE.Scene, city: City) {
    this.graph = city.graph;
    this.heads = allSignalHeads(city);
    this.count = this.heads.length / HEAD_STRIDE;
    this.shown = new Int8Array(this.count).fill(-1);
    const total = Math.max(1, this.count * SIGNAL_HEAD_PARTS);
    const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), material, total);
    this.mesh.name = 'signalHeads';
    this.mesh.count = this.count * SIGNAL_HEAD_PARTS;
    this.mesh.frustumCulled = false;
    this.mesh.matrixAutoUpdate = false;
    this.colors = new Float32Array(total * 3);
    this.mesh.instanceColor = new THREE.InstancedBufferAttribute(this.colors, 3);

    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    const part = (i: number, k: number, lx: number, y: number, lz: number, sx: number, sy: number, sz: number, yaw: number, x: number, z: number): void => {
      // Local +X = (cos, -sin), +Z = (sin, cos).
      const c = Math.cos(yaw), sn = Math.sin(yaw);
      p.set(x + lx * c + lz * sn, y, z - lx * sn + lz * c);
      s.set(sx, sy, sz);
      this.mesh.setMatrixAt(i * SIGNAL_HEAD_PARTS + k, m.compose(p, q.setFromAxisAngle(up, yaw), s));
    };
    for (let i = 0; i < this.count; i++) {
      const o = i * HEAD_STRIDE;
      const x = this.heads[o + 2] ?? 0, z = this.heads[o + 3] ?? 0, yaw = this.heads[o + 4] ?? 0;
      part(i, SIGNAL_PART.pole, 0, SIGNAL_POLE_HEIGHT / 2, 0, 0.16, SIGNAL_POLE_HEIGHT, 0.16, yaw, x, z);
      part(i, SIGNAL_PART.housing, 0, HOUSING_Y, -0.12, 0.42, 1.15, 0.3, yaw, x, z);
      // Lamps on the housing front (local -Z faces the approaching traffic).
      part(i, SIGNAL_PART.red, 0, HOUSING_Y + 0.36, -0.29, 0.24, 0.24, 0.06, yaw, x, z);
      part(i, SIGNAL_PART.yellow, 0, HOUSING_Y, -0.29, 0.24, 0.24, 0.06, yaw, x, z);
      part(i, SIGNAL_PART.green, 0, HOUSING_Y - 0.36, -0.29, 0.24, 0.24, 0.06, yaw, x, z);
      this.setColor(i, SIGNAL_PART.pole, BODY_COLOR);
      this.setColor(i, SIGNAL_PART.housing, BODY_COLOR);
      this.showAspect(i, 0);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    scene.add(this.mesh);
  }

  /** Refreshes lamp colours of heads within 200 m of the camera for `simTime`. */
  update(simTime: number, cameraX: number, cameraZ: number): void {
    if (this.disposed) return;
    const r2 = SIGNAL_REFRESH_RADIUS * SIGNAL_REFRESH_RADIUS;
    let changed = false;
    for (let i = 0; i < this.count; i++) {
      const o = i * HEAD_STRIDE;
      const dx = (this.heads[o + 2] ?? 0) - cameraX, dz = (this.heads[o + 3] ?? 0) - cameraZ;
      if (dx * dx + dz * dz > r2) continue;
      if (this.showAspect(i, simTime)) changed = true;
    }
    if (changed && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }

  /** Sets head `i`'s lamps for `simTime`; true when the shown aspect changed. */
  private showAspect(i: number, simTime: number): boolean {
    const o = i * HEAD_STRIDE;
    const signal = this.heads[o] ?? 0, group = (this.heads[o + 1] ?? 0) === 1 ? 1 : 0;
    const aspect = this.graph.signalAspect(signal, group, simTime);
    if (aspect === this.shown[i]) return false;
    this.shown[i] = aspect;
    const lit = LAMP_OF_ASPECT[aspect];
    for (let k = SIGNAL_PART.red; k <= SIGNAL_PART.green; k++) {
      const table = k === lit ? SIGNAL_LIT : SIGNAL_UNLIT;
      this.setColor(i, k, table[k - SIGNAL_PART.red] ?? BODY_COLOR);
    }
    return true;
  }

  private setColor(i: number, k: number, c: readonly [number, number, number]): void {
    const o = (i * SIGNAL_HEAD_PARTS + k) * 3;
    this.colors[o] = c[0];
    this.colors[o + 1] = c[1];
    this.colors[o + 2] = c[2];
  }
}
