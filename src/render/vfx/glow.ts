import * as THREE from 'three';
import { VFX_DATA, type VfxData } from './data';
import type { GlowSink } from './types';

/** Floats per staged glow: x, y, z, r, g, b, kind. */
export const GLOW_STRIDE = 7;
/** Floats per staged pool: x, z, r, g, b. */
export const POOL_STRIDE = 5;
/** Floats per staged beam: x, y, z, dx, dy, dz. */
export const BEAM_STRIDE = 6;
/** Most beams staged per frame (cones draw the nearest few). */
export const BEAM_STAGE = 128;
/** Light pool height above the ground, m. */
export const POOL_HEIGHT = 0.03;

/**
 * The glow sink: copies what `CarRenderer.update` reports into fixed typed arrays (overflow is dropped). Nothing
 * is allocated; `VfxSystem.update` turns the staged lamps into instances.
 */
export class GlowStage implements GlowSink {
  readonly glows: Float32Array;
  readonly pools: Float32Array;
  readonly beams = new Float32Array(BEAM_STAGE * BEAM_STRIDE);
  glowCount = 0;
  poolCount = 0;
  beamCount = 0;
  private readonly glowCapacity: number;
  private readonly poolCapacity: number;

  constructor(glowCapacity: number, poolCapacity: number) {
    this.glowCapacity = glowCapacity;
    this.poolCapacity = poolCapacity;
    this.glows = new Float32Array(glowCapacity * GLOW_STRIDE);
    this.pools = new Float32Array(poolCapacity * POOL_STRIDE);
  }

  begin(): void {
    this.glowCount = 0;
    this.poolCount = 0;
    this.beamCount = 0;
  }

  glow(x: number, y: number, z: number, r: number, g: number, b: number, kind: number): void {
    if (this.glowCount >= this.glowCapacity) return;
    const o = this.glowCount++ * GLOW_STRIDE;
    const a = this.glows;
    a[o] = x;
    a[o + 1] = y;
    a[o + 2] = z;
    a[o + 3] = r;
    a[o + 4] = g;
    a[o + 5] = b;
    a[o + 6] = kind;
  }

  pool(x: number, z: number, r: number, g: number, b: number): void {
    if (this.poolCount >= this.poolCapacity) return;
    const o = this.poolCount++ * POOL_STRIDE;
    const a = this.pools;
    a[o] = x;
    a[o + 1] = z;
    a[o + 2] = r;
    a[o + 3] = g;
    a[o + 4] = b;
  }

  beam(x: number, y: number, z: number, dx: number, dy: number, dz: number): void {
    if (this.beamCount >= BEAM_STAGE) return;
    const o = this.beamCount++ * BEAM_STRIDE;
    const a = this.beams;
    a[o] = x;
    a[o + 1] = y;
    a[o + 2] = z;
    a[o + 3] = dx;
    a[o + 4] = dy;
    a[o + 5] = dz;
  }

  end(): void {
    // Nothing to finish: the staged arrays are read by VfxSystem.update.
  }
}

const FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying vec2 vUv;
void main() {
  float r = length(vUv);
  if (r >= 1.0) discard;
  float a = pow(1.0 - r, 2.0);
  gl_FragColor = vec4(vColor, a);
  #include <colorspace_fragment>
}`;

const GLOW_VERTEX = /* glsl */ `
varying vec3 vColor;
varying vec2 vUv;
void main() {
  // Camera-facing billboard: the instance matrix holds the centre (translation) and the size (uniform scale).
  float s = length(instanceMatrix[0].xyz);
  vec4 mv = modelViewMatrix * vec4(instanceMatrix[3].xyz, 1.0);
  mv.xy += position.xy * s;
  gl_Position = projectionMatrix * mv;
  vUv = position.xy * 2.0;
  vColor = instanceColor;
}`;

const POOL_VERTEX = /* glsl */ `
varying vec3 vColor;
varying vec2 vUv;
void main() {
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  vUv = position.xz;
  vColor = instanceColor;
}`;

function additiveMaterial(name: string, vertexShader: string): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name,
    vertexShader,
    fragmentShader: FRAGMENT,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false,
  });
}

function instancedMesh(name: string, geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = name;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  // Created up front so the shader is compiled with instance colours once.
  mesh.setColorAt(0, new THREE.Color(0, 0, 0));
  mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  mesh.renderOrder = 10;
  mesh.count = 0;
  mesh.visible = false;
  return mesh;
}

/** Uploads the first `count` instances of `mesh` and shows it (hides it when empty). */
export function finishInstances(mesh: THREE.InstancedMesh, count: number): void {
  mesh.count = count;
  mesh.visible = count > 0;
  if (count === 0) return;
  const matrix = mesh.instanceMatrix;
  matrix.clearUpdateRanges();
  matrix.addUpdateRange(0, count * 16);
  matrix.needsUpdate = true;
  const color = mesh.instanceColor;
  if (color) {
    color.clearUpdateRanges();
    color.addUpdateRange(0, count * 3);
    color.needsUpdate = true;
  }
}

/** Writes translation (x, y, z) and a uniform scale into instance `index` of `array` (rotation identity). */
export function putScaled(array: THREE.TypedArray, index: number, x: number, y: number, z: number, s: number): void {
  const o = index * 16;
  array[o] = s;
  array[o + 1] = 0;
  array[o + 2] = 0;
  array[o + 3] = 0;
  array[o + 4] = 0;
  array[o + 5] = s;
  array[o + 6] = 0;
  array[o + 7] = 0;
  array[o + 8] = 0;
  array[o + 9] = 0;
  array[o + 10] = s;
  array[o + 11] = 0;
  array[o + 12] = x;
  array[o + 13] = y;
  array[o + 14] = z;
  array[o + 15] = 1;
}

/**
 * Glow sprites: one `InstancedMesh` of a unit quad drawn as a camera-facing, additive radial falloff
 * (`pow(1 - r, 2)`) at every staged lamp. The instance colour is the lamp colour times its intensity; the scale is
 * the size of the lamp kind times the quality factor.
 */
export class GlowSprites {
  readonly mesh: THREE.InstancedMesh;
  private readonly data: VfxData['glow'];

  constructor(data: VfxData = VFX_DATA) {
    this.data = data.glow;
    this.mesh = instancedMesh('vfx-glow', new THREE.PlaneGeometry(1, 1), additiveMaterial('vfx.glow', GLOW_VERTEX), data.glow.capacity);
  }

  /**
   * Fills the instances from `stage`. Bar glows (kind 0) shine by day at `dayFactor`; head and tail glows (kinds
   * 1, 2) scale with `night` alone. `sizeFactor` is 1 at high quality, `lowSizeFactor` at low. Returns the count.
   */
  update(stage: GlowStage, night: number, sizeFactor: number): number {
    const d = this.data;
    const barI = night + d.dayFactor * (1 - night);
    const matrix = this.mesh.instanceMatrix.array;
    const colors = this.mesh.instanceColor?.array;
    if (!colors) return 0;
    const glows = stage.glows;
    let n = 0;
    for (let i = 0; i < stage.glowCount && n < d.capacity; i++) {
      const o = i * GLOW_STRIDE;
      const kind = glows[o + 6] ?? 0;
      const intensity = kind === 0 ? barI : night;
      if (intensity < 0.004) continue;
      const size = kind === 0 ? d.barSize : kind === 1 ? d.headSize : d.tailSize;
      putScaled(matrix, n, glows[o] ?? 0, glows[o + 1] ?? 0, glows[o + 2] ?? 0, size * sizeFactor);
      const c = n * 3;
      colors[c] = (glows[o + 3] ?? 0) * intensity;
      colors[c + 1] = (glows[o + 4] ?? 0) * intensity;
      colors[c + 2] = (glows[o + 5] ?? 0) * intensity;
      n++;
    }
    finishInstances(this.mesh, n);
    return n;
  }
}

/**
 * Light pools: one `InstancedMesh` of a flat disc (y = 0.03, radius `pool.radiusM`) with the same additive falloff,
 * one per police car with its bar on. Skipped by the owner when it is not dusk or night.
 */
export class LightPools {
  readonly mesh: THREE.InstancedMesh;
  private readonly data: VfxData['glow']['pool'];

  constructor(data: VfxData = VFX_DATA) {
    this.data = data.glow.pool;
    const disc = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
    this.mesh = instancedMesh('vfx-pools', disc, additiveMaterial('vfx.pool', POOL_VERTEX), data.glow.pool.capacity);
  }

  /** Fills the instances from `stage` at intensity `pool.intensity * night`; returns the count. */
  update(stage: GlowStage, night: number): number {
    const d = this.data;
    const matrix = this.mesh.instanceMatrix.array;
    const colors = this.mesh.instanceColor?.array;
    if (!colors) return 0;
    const k = d.intensity * night;
    const pools = stage.pools;
    let n = 0;
    for (let i = 0; i < stage.poolCount && n < d.capacity; i++) {
      const o = i * POOL_STRIDE;
      putScaled(matrix, n, pools[o] ?? 0, POOL_HEIGHT, pools[o + 1] ?? 0, d.radiusM);
      const c = n * 3;
      colors[c] = (pools[o + 2] ?? 0) * k;
      colors[c + 1] = (pools[o + 3] ?? 0) * k;
      colors[c + 2] = (pools[o + 4] ?? 0) * k;
      n++;
    }
    finishInstances(this.mesh, n);
    return n;
  }

  hide(): void {
    finishInstances(this.mesh, 0);
  }
}
