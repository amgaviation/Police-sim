import * as THREE from 'three';
import type { Strip } from '../../pursuit/types';
import { disposeObject } from '../renderer';

/** Strip width (m) and height (m). */
export const STRIP_WIDTH_M = 0.25;
export const STRIP_HEIGHT_M = 0.04;
/** Spike row (thin box on top of the strip). */
const SPIKE_WIDTH_M = 0.06;
const SPIKE_HEIGHT_M = 0.08;
/** The spike row is this fraction of the strip length. */
const SPIKE_LENGTH_FRAC = 0.9;
/** Centre height of the strip box (just above the road surface). */
const STRIP_Y = STRIP_HEIGHT_M / 2 + 0.005;
const SPIKE_Y = STRIP_HEIGHT_M + SPIKE_HEIGHT_M / 2 - 0.01;
const AXIS_Y = new THREE.Vector3(0, 1, 0);

const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchMatrix = new THREE.Matrix4();

function instanced(name: string, color: number, max: number): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.3 }), max);
  mesh.name = name;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.count = 0;
  mesh.visible = false;
  return mesh;
}

/**
 * Spike strips lying on the road (Phase 6 design §12.6): one instanced dark strip and one instanced row of spikes, so
 * two draw calls however many strips there are (up to `max`). Only active strips are drawn (a used strip stays in the
 * list until it expires but is not drawn). Allocation-free update with scratch matrices.
 */
export class SpikeRenderer {
  readonly group = new THREE.Group();
  readonly strips: THREE.InstancedMesh;
  readonly spikes: THREE.InstancedMesh;
  readonly max: number;

  constructor(scene: THREE.Object3D, max = 8) {
    this.max = Math.max(1, Math.floor(max));
    this.group.name = 'spike-strips';
    this.strips = instanced('spike-strip', 0x1b1d20, this.max);
    this.spikes = instanced('spike-row', 0x9aa0a8, this.max);
    this.group.add(this.strips, this.spikes);
    scene.add(this.group);
  }

  /** Draw calls made now (0 without a visible strip, else 2). */
  get drawCalls(): number {
    return (this.strips.visible ? 1 : 0) + (this.spikes.visible ? 1 : 0);
  }

  /** Number of strips drawn. */
  get count(): number {
    return this.strips.count;
  }

  /** Sets the instance matrices of the active strips (at most `max`). */
  update(strips: readonly Strip[]): void {
    let n = 0;
    for (let i = 0; i < strips.length && n < this.max; i++) {
      const s = strips[i] as Strip;
      if (!s.active) continue;
      const dx = s.x1 - s.x0;
      const dz = s.z1 - s.z0;
      const len = Math.hypot(dx, dz);
      if (!(len > 0.01)) continue;
      // A box's long axis is +X; Ry(a) takes +X to (cos a, 0, -sin a).
      scratchQuat.setFromAxisAngle(AXIS_Y, Math.atan2(-dz, dx));
      const mx = (s.x0 + s.x1) / 2;
      const mz = (s.z0 + s.z1) / 2;
      scratchMatrix.compose(scratchPos.set(mx, STRIP_Y, mz), scratchQuat, scratchScale.set(len, STRIP_HEIGHT_M, STRIP_WIDTH_M));
      this.strips.setMatrixAt(n, scratchMatrix);
      scratchMatrix.compose(scratchPos.set(mx, SPIKE_Y, mz), scratchQuat, scratchScale.set(len * SPIKE_LENGTH_FRAC, SPIKE_HEIGHT_M, SPIKE_WIDTH_M));
      this.spikes.setMatrixAt(n, scratchMatrix);
      n++;
    }
    this.strips.count = n;
    this.spikes.count = n;
    const on = n > 0;
    this.strips.visible = on;
    this.spikes.visible = on;
    if (on) {
      this.strips.instanceMatrix.needsUpdate = true;
      this.spikes.instanceMatrix.needsUpdate = true;
    }
  }

  /** Removes the strips from the scene and frees geometry, materials and instance buffers. */
  dispose(): void {
    this.group.removeFromParent();
    disposeObject(this.group);
  }
}
