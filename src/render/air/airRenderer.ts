import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { AirView } from '../../resources/types';
import { disposeObject } from '../renderer';

/** Rotor mast height above the helicopter origin (m). */
const MAST_Y = 1.6;
/** Spotlight tuning (candela, m, rad): a narrow beam from the belly toward the target. */
export const AIR_SPOT = { intensity: 4000, distance: 450, angle: 0.09, penumbra: 0.4, decay: 1.5, dropM: 2 } as const;

const TWO_PI = Math.PI * 2;

function box(sx: number, sy: number, sz: number, x: number, y: number, z: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z);
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('AirRenderer: could not merge helicopter parts');
  return merged;
}

/** Fuselage 9 x 2.2 x 2.6 m (nose toward -Z), tail boom, fin, tail rotor and two skids. */
function bodyGeometry(): THREE.BufferGeometry {
  return merge([
    box(2.6, 2.2, 9, 0, 0, 0),
    box(0.6, 0.6, 6.5, 0, 0.4, 7.5),
    box(0.2, 1.8, 1.2, 0, 1.2, 10.4),
    box(0.1, 1.6, 0.25, 0.4, 1.3, 10.4),
    box(0.15, 0.15, 7, -1.2, -1.9, 0),
    box(0.15, 0.15, 7, 1.2, -1.9, 0),
    box(0.12, 0.8, 0.12, -1.1, -1.5, -2),
    box(0.12, 0.8, 0.12, 1.1, -1.5, -2),
    box(0.12, 0.8, 0.12, -1.1, -1.5, 2),
    box(0.12, 0.8, 0.12, 1.1, -1.5, 2),
  ]);
}

/** Main rotor: two thin blades crossing at 90 degrees, centred on the mast. */
function rotorGeometry(): THREE.BufferGeometry {
  return merge([box(14, 0.05, 0.4, 0, 0, 0), box(0.4, 0.05, 14, 0, 0, 0)]);
}

/** Shortest signed angle from `a` to `b`. */
function angleDelta(a: number, b: number): number {
  let d = (b - a) % TWO_PI;
  if (d > Math.PI) d -= TWO_PI;
  else if (d < -Math.PI) d += TWO_PI;
  return d;
}

/**
 * The air unit's helicopter (Phase 6 design §12.6): one group with a body mesh and a rotor mesh (two draw calls, at
 * most three) and a single `SpotLight` created once (intensity 0 when off, so the light count never changes). Hidden
 * while the view is null. Motion is interpolated between the last two distinct views by `alpha`.
 */
export class AirRenderer {
  readonly group = new THREE.Group();
  /** The helicopter (body and rotor); hidden when there is no air unit. */
  readonly heli = new THREE.Group();
  readonly body: THREE.Mesh;
  readonly rotor: THREE.Mesh;
  readonly spot: THREE.SpotLight;

  private px = 0;
  private py = 0;
  private pz = 0;
  private pyaw = 0;
  private cx = 0;
  private cy = 0;
  private cz = 0;
  private cyaw = 0;
  private have = false;

  constructor(scene: THREE.Object3D) {
    this.group.name = 'air-unit';
    this.body = new THREE.Mesh(bodyGeometry(), new THREE.MeshStandardMaterial({ color: 0x3a3f47, roughness: 0.6, metalness: 0.2 }));
    this.body.name = 'air-body';
    this.rotor = new THREE.Mesh(rotorGeometry(), new THREE.MeshStandardMaterial({ color: 0x15171a, roughness: 0.8 }));
    this.rotor.name = 'air-rotor';
    this.rotor.position.y = MAST_Y;
    this.body.frustumCulled = false;
    this.rotor.frustumCulled = false;
    this.heli.add(this.body, this.rotor);
    this.heli.visible = false;
    this.spot = new THREE.SpotLight(0xfff2d0, 0, AIR_SPOT.distance, AIR_SPOT.angle, AIR_SPOT.penumbra, AIR_SPOT.decay);
    this.spot.castShadow = false;
    this.spot.name = 'air-spot';
    // The light and its target live in world space under the (untransformed) group, never hidden: toggling a light's
    // visibility changes the light count and recompiles every lit material.
    this.group.add(this.heli, this.spot, this.spot.target);
    scene.add(this.group);
  }

  /** Draw calls the helicopter makes now (0 hidden, else 2). */
  get drawCalls(): number {
    return this.heli.visible ? 2 : 0;
  }

  /** Places the helicopter and aims the spotlight; `null` hides everything. Allocation-free. */
  update(view: Readonly<AirView> | null, alpha: number): void {
    if (view === null) {
      this.have = false;
      this.heli.visible = false;
      this.spot.intensity = 0;
      return;
    }
    if (!this.have) {
      this.cx = view.x;
      this.cy = view.y;
      this.cz = view.z;
      this.cyaw = view.yaw;
      this.px = this.cx;
      this.py = this.cy;
      this.pz = this.cz;
      this.pyaw = this.cyaw;
      this.have = true;
    } else if (view.x !== this.cx || view.y !== this.cy || view.z !== this.cz || view.yaw !== this.cyaw) {
      this.px = this.cx;
      this.py = this.cy;
      this.pz = this.cz;
      this.pyaw = this.cyaw;
      this.cx = view.x;
      this.cy = view.y;
      this.cz = view.z;
      this.cyaw = view.yaw;
    }
    const a = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
    const x = this.px + (this.cx - this.px) * a;
    const y = this.py + (this.cy - this.py) * a;
    const z = this.pz + (this.cz - this.pz) * a;
    const yaw = this.pyaw + angleDelta(this.pyaw, this.cyaw) * a;
    this.heli.visible = true;
    this.heli.position.set(x, y, z);
    this.heli.rotation.y = yaw;
    this.rotor.rotation.y = view.rotor;
    this.spot.position.set(x, y - AIR_SPOT.dropM, z);
    this.spot.target.position.set(view.targetX, 0, view.targetZ);
    this.spot.target.updateMatrixWorld();
    this.spot.intensity = view.spot ? AIR_SPOT.intensity : 0;
  }

  /** Removes the helicopter from the scene and frees geometries and materials. */
  dispose(): void {
    this.group.removeFromParent();
    disposeObject(this.group);
  }
}
