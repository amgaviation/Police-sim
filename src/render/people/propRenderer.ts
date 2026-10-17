import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { disposeObject } from '../renderer';
import { PROP, type PropSource } from './pose';

/** Flare glow: emissive intensity by day and the extra added at full night. */
const FLARE_DAY = 0.5;
const FLARE_NIGHT = 1.5;

interface PropKind {
  readonly name: string;
  readonly kind: number;
  readonly color: number;
  readonly geometry: () => THREE.BufferGeometry;
  readonly emissive?: number;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

function merged(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const geometry = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  if (!geometry) throw new Error('PropRenderer: could not merge prop parts');
  return geometry;
}

/** Simple geometry per kind, origin on the ground; yaw rotates about Y (tape runs along local -Z). */
const KINDS: readonly PropKind[] = [
  { name: 'cone', kind: PROP.cone, color: 0xff6a00, geometry: () => new THREE.ConeGeometry(0.17, 0.7, 8).translate(0, 0.35, 0) },
  { name: 'flare', kind: PROP.flare, color: 0x7a1010, emissive: 0xff2a1a, geometry: () => box(0.05, 0.04, 0.3, 0, 0.02, 0) },
  {
    name: 'tape',
    kind: PROP.tape,
    color: 0xf2d023,
    geometry: () => merged([box(0.05, 1, 0.05, 0, 0.5, 0), box(0.02, 0.08, 3, 0, 0.9, -1.5)]),
  },
  { name: 'marker', kind: PROP.marker, color: 0xffd400, geometry: () => new THREE.ConeGeometry(0.12, 0.2, 4).translate(0, 0.1, 0) },
  { name: 'bottle', kind: PROP.bottle, color: 0x3b7a3b, geometry: () => new THREE.CylinderGeometry(0.035, 0.035, 0.22, 8).rotateZ(Math.PI / 2).translate(0, 0.035, 0) },
  { name: 'bag', kind: PROP.bag, color: 0x2b3a67, geometry: () => box(0.3, 0.18, 0.2, 0, 0.09, 0) },
  { name: 'knife', kind: PROP.knife, color: 0xbfc3c8, geometry: () => box(0.03, 0.01, 0.22, 0, 0.005, 0) },
  { name: 'handgun', kind: PROP.handgun, color: 0x222426, geometry: () => merged([box(0.04, 0.03, 0.18, 0, 0.015, 0), box(0.035, 0.09, 0.04, 0, 0.045, 0.07)]) },
  { name: 'package', kind: PROP.package, color: 0x9a7646, geometry: () => box(0.3, 0.2, 0.25, 0, 0.1, 0) },
  { name: 'casing', kind: PROP.casing, color: 0xc9a227, geometry: () => new THREE.CylinderGeometry(0.01, 0.01, 0.04, 6).rotateZ(Math.PI / 2).translate(0, 0.01, 0) },
  { name: 'glass', kind: PROP.glass, color: 0x9fd1e6, geometry: () => box(0.18, 0.005, 0.18, 0, 0.003, 0) },
  { name: 'note', kind: PROP.note, color: 0xf4f1e6, geometry: () => box(0.16, 0.005, 0.2, 0, 0.003, 0) },
];

interface Slot {
  readonly mesh: THREE.InstancedMesh;
  readonly material: THREE.MeshLambertMaterial;
  readonly flare: boolean;
}

/**
 * Scene props (cones, flares, tape, evidence markers and ground items): one `InstancedMesh` per prop kind,
 * drawn only when that kind is in use (at most 12 draw calls). Flares glow brighter at night. Instances are
 * written straight into the instance buffers (no allocation per frame); headless it only fills buffers.
 */
export class PropRenderer {
  readonly stats = { props: 0, drawCalls: 0 };
  private readonly group = new THREE.Group();
  /** Indexed by prop kind (index 0 unused). */
  private readonly slots: (Slot | undefined)[] = [];
  private readonly capacity: number;

  constructor(scene: THREE.Scene, capacity = 256) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.group.name = 'props';
    for (const def of KINDS) {
      const material = new THREE.MeshLambertMaterial({ color: def.color });
      if (def.emissive !== undefined) {
        material.emissive.setHex(def.emissive);
        material.emissiveIntensity = FLARE_DAY;
      }
      const mesh = new THREE.InstancedMesh(def.geometry(), material, this.capacity);
      mesh.name = `prop-${def.name}`;
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      mesh.visible = false;
      this.group.add(mesh);
      this.slots[def.kind] = { mesh, material, flare: def.emissive !== undefined };
    }
    scene.add(this.group);
  }

  /** Redraws all props of `source` (null clears); `nightFactor` (0..1) brightens the flares. */
  update(source: PropSource | null, nightFactor: number): void {
    const slots = this.slots;
    for (let k = 0; k < slots.length; k++) {
      const slot = slots[k];
      if (slot) slot.mesh.count = 0;
    }
    let props = 0;
    if (source) {
      const n = Math.min(source.count, source.x.length, source.kind.length);
      for (let i = 0; i < n; i++) {
        const slot = slots[source.kind[i] ?? 0];
        if (!slot || slot.mesh.count >= this.capacity) continue;
        const yaw = source.yaw[i] ?? 0;
        const c = Math.cos(yaw);
        const s = Math.sin(yaw);
        const a = slot.mesh.instanceMatrix.array;
        const o = slot.mesh.count++ * 16;
        // Ry(yaw): columns (c, 0, -s), (0, 1, 0), (s, 0, c).
        a[o] = c;
        a[o + 1] = 0;
        a[o + 2] = -s;
        a[o + 3] = 0;
        a[o + 4] = 0;
        a[o + 5] = 1;
        a[o + 6] = 0;
        a[o + 7] = 0;
        a[o + 8] = s;
        a[o + 9] = 0;
        a[o + 10] = c;
        a[o + 11] = 0;
        a[o + 12] = source.x[i] ?? 0;
        a[o + 13] = source.y[i] ?? 0;
        a[o + 14] = source.z[i] ?? 0;
        a[o + 15] = 1;
        props++;
      }
    }
    const night = nightFactor < 0 ? 0 : nightFactor > 1 ? 1 : nightFactor;
    let drawCalls = 0;
    for (let k = 0; k < slots.length; k++) {
      const slot = slots[k];
      if (!slot) continue;
      const mesh = slot.mesh;
      mesh.visible = mesh.count > 0;
      if (mesh.count === 0) continue;
      mesh.instanceMatrix.clearUpdateRanges();
      mesh.instanceMatrix.addUpdateRange(0, mesh.count * 16);
      mesh.instanceMatrix.needsUpdate = true;
      if (slot.flare) slot.material.emissiveIntensity = FLARE_DAY + FLARE_NIGHT * night;
      drawCalls++;
    }
    this.stats.props = props;
    this.stats.drawCalls = drawCalls;
  }

  dispose(): void {
    this.group.removeFromParent();
    disposeObject(this.group);
  }
}
