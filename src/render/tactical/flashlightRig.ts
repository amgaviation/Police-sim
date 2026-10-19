/**
 * Officer flashlight (design §7.5): one SpotLight that is always in the scene (the shader's light count never
 * changes) and has intensity 0 while off. Builds and runs headless (no WebGL needed).
 */
import * as THREE from 'three';

export const FLASHLIGHT_INTENSITY = 60;
const COLOR = 0xfff4e0;
const DISTANCE = 25;
const ANGLE = 0.35;
const PENUMBRA = 0.4;
const DECAY = 2;
/** Offset of the lamp from the camera: right and down (m). */
const RIGHT = 0.2;
const DOWN = 0.2;
/** How far ahead of the camera the beam is aimed (m). */
const AIM_DISTANCE = 10;

const right = new THREE.Vector3();
const up = new THREE.Vector3();
const forward = new THREE.Vector3();

export class FlashlightRig {
  readonly light: THREE.SpotLight;
  private readonly scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    const light = new THREE.SpotLight(COLOR, 0, DISTANCE, ANGLE, PENUMBRA, DECAY);
    light.castShadow = false;
    this.light = light;
    scene.add(light);
    scene.add(light.target);
  }

  /** Follows `camera` (call after the camera pose is final for the frame); intensity 60 when `on`, else 0. */
  update(on: boolean, camera: THREE.Camera): void {
    const light = this.light;
    light.intensity = on ? FLASHLIGHT_INTENSITY : 0;
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    // Camera axes in world space: +X right, +Y up, -Z forward.
    right.set(e[0] ?? 1, e[1] ?? 0, e[2] ?? 0).normalize();
    up.set(e[4] ?? 0, e[5] ?? 1, e[6] ?? 0).normalize();
    forward.set(-(e[8] ?? 0), -(e[9] ?? 0), -(e[10] ?? 1)).normalize();
    const px = (e[12] ?? 0) + right.x * RIGHT - up.x * DOWN;
    const py = (e[13] ?? 0) + right.y * RIGHT - up.y * DOWN;
    const pz = (e[14] ?? 0) + right.z * RIGHT - up.z * DOWN;
    light.position.set(px, py, pz);
    light.target.position.set(px + forward.x * AIM_DISTANCE, py + forward.y * AIM_DISTANCE, pz + forward.z * AIM_DISTANCE);
    light.target.updateMatrixWorld();
  }

  dispose(): void {
    this.scene.remove(this.light);
    this.scene.remove(this.light.target);
    this.light.dispose();
  }
}
