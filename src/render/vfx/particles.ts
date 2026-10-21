import * as THREE from 'three';
import { VFX_DATA, type VfxData } from './data';
import { ringRanges, VFX_TIME_WRAP } from './math';

/** Largest point sprite, px. */
export const PARTICLE_MAX_PX = 64;

const VERTEX = /* glsl */ `
#define MAX_POINT_PX ${PARTICLE_MAX_PX.toFixed(1)}
attribute vec3 aStart;
attribute vec3 aVel;
attribute float aGrav;
attribute float aBirth;
attribute float aLife;
attribute float aSize;
attribute vec3 aColor;
uniform float uTime;
uniform float uScale;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float age = uTime - aBirth;
  vColor = aColor;
  if (age < 0.0 || age > aLife) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    return;
  }
  vec3 p = aStart + aVel * age + 0.5 * vec3(0.0, aGrav, 0.0) * age * age;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(aSize * uScale / max(-mv.z, 0.1), MAX_POINT_PX);
  vAlpha = 1.0 - age / max(aLife, 0.0001);
}`;

const FRAGMENT = /* glsl */ `
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = (1.0 - smoothstep(0.4, 1.0, d)) * vAlpha;
  if (a < 0.01) discard;
  gl_FragColor = vec4(vColor, a);
  #include <colorspace_fragment>
}`;

/** Attribute names, item sizes and the order of `Ring.attrs`. */
const ATTRIBUTES = [
  ['aStart', 3],
  ['aVel', 3],
  ['aGrav', 1],
  ['aBirth', 1],
  ['aLife', 1],
  ['aSize', 1],
  ['aColor', 3],
] as const;
const A_START = 0;
const A_VEL = 1;
const A_GRAV = 2;
const A_BIRTH = 3;
const A_LIFE = 4;
const A_SIZE = 5;
const A_COLOR = 6;

/** One ring buffer of particles drawn as one `Points`. */
interface Ring {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly attrs: THREE.BufferAttribute[];
  readonly capacity: number;
  /** Next slot to write. */
  head: number;
  /** Slots written since the last flush. */
  pending: number;
  /** Highest number of slots ever written (draw range). */
  filled: number;
  /** Latest wrapped-clock time at which a particle of this ring dies. */
  lastDeath: number;
}

const scratchRanges = new Int32Array(4);

function createRing(name: string, capacity: number, additive: boolean, uniforms: Record<string, THREE.IUniform>): Ring {
  const geometry = new THREE.BufferGeometry();
  const attrs = ATTRIBUTES.map(([attr, size]) => {
    const a = new THREE.BufferAttribute(new Float32Array(capacity * size), size);
    a.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(attr, a);
    return a;
  });
  // Every slot starts dead: born "in the future" with zero life.
  const birth = attrs[A_BIRTH]?.array;
  if (birth) birth.fill(-1);
  // `position` is required to draw; it aliases the start positions (one GPU buffer, never read by the shader).
  const start = attrs[A_START];
  if (start) geometry.setAttribute('position', start);
  geometry.setDrawRange(0, 0);
  const material = new THREE.ShaderMaterial({
    name,
    uniforms: { ...uniforms },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthWrite: false,
    depthTest: true,
    fog: false,
    toneMapped: false,
  });
  const points = new THREE.Points(geometry, material);
  points.name = name;
  points.frustumCulled = false;
  points.renderOrder = 11;
  points.visible = false;
  return { points, attrs, capacity, head: 0, pending: 0, filled: 0, lastDeath: -Infinity };
}

/**
 * GPU particle pool: two `Points` (additive and normal blending), each a ring buffer of `capacity / 2` particles.
 * A particle's whole motion is evaluated in the vertex shader from its start, velocity, gravity and birth time, so
 * the CPU only writes slots on emission (`spawn`) and uploads the written slot ranges in `flush`.
 */
export class ParticlePool {
  readonly additive: Ring;
  readonly normal: Ring;
  private readonly uTime: THREE.IUniform<number> = { value: 0 };
  private readonly uScale: THREE.IUniform<number> = { value: 1 };
  private readonly rings: readonly [Ring, Ring];

  constructor(data: VfxData = VFX_DATA) {
    const half = data.particles.capacity / 2;
    const uniforms = { uTime: this.uTime, uScale: this.uScale };
    this.additive = createRing('vfx-particles-add', half, true, uniforms);
    this.normal = createRing('vfx-particles', half, false, uniforms);
    this.rings = [this.additive, this.normal];
  }

  /** Per-ring capacity. */
  get ringCapacity(): number {
    return this.additive.capacity;
  }

  /**
   * Writes one particle into the next slot of the additive or normal ring (overwriting the oldest when full).
   * `birth` is on the wrapped render clock.
   */
  spawn(
    additive: boolean,
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    gravity: number,
    birth: number,
    life: number,
    size: number,
    r: number,
    g: number,
    b: number,
  ): void {
    const ring = additive ? this.additive : this.normal;
    const i = ring.head;
    const a = ring.attrs;
    const start = a[A_START]?.array;
    const vel = a[A_VEL]?.array;
    const color = a[A_COLOR]?.array;
    const grav = a[A_GRAV]?.array;
    const born = a[A_BIRTH]?.array;
    const lives = a[A_LIFE]?.array;
    const sizes = a[A_SIZE]?.array;
    if (!start || !vel || !color || !grav || !born || !lives || !sizes) return;
    const i3 = i * 3;
    start[i3] = x;
    start[i3 + 1] = y;
    start[i3 + 2] = z;
    vel[i3] = vx;
    vel[i3 + 1] = vy;
    vel[i3 + 2] = vz;
    color[i3] = r;
    color[i3 + 1] = g;
    color[i3 + 2] = b;
    grav[i] = gravity;
    born[i] = birth;
    lives[i] = life;
    sizes[i] = size;
    ring.head = (i + 1) % ring.capacity;
    if (ring.pending < ring.capacity) ring.pending++;
    if (ring.filled < ring.capacity) ring.filled++;
    const death = birth + life;
    if (death > ring.lastDeath) ring.lastDeath = death;
  }

  /** Uploads the slots written since the last flush (one or two ranges per attribute) and updates the draw ranges. */
  flush(): void {
    for (let q = 0; q < 2; q++) {
      const ring = q === 0 ? this.additive : this.normal;
      if (ring.pending === 0) continue;
      const start = (ring.head - ring.pending + ring.capacity) % ring.capacity;
      const n = ringRanges(start, ring.pending, ring.capacity, scratchRanges);
      for (let k = 0; k < ATTRIBUTES.length; k++) {
        const attr = ring.attrs[k];
        const size = ATTRIBUTES[k]?.[1] ?? 1;
        if (!attr) continue;
        for (let r = 0; r < n; r++) attr.addUpdateRange((scratchRanges[r * 2] ?? 0) * size, (scratchRanges[r * 2 + 1] ?? 0) * size);
        attr.needsUpdate = true;
      }
      ring.points.geometry.setDrawRange(0, ring.filled);
      ring.pending = 0;
    }
  }

  /**
   * Advances the shader clock to `time` (wrapped render seconds) with `scale` = drawing-buffer height /
   * (2 tan(fov / 2)), shows the rings that can hold live particles and returns the number alive.
   */
  update(time: number, scale: number, visible: boolean): number {
    const wrapped = time % VFX_TIME_WRAP;
    // A clock wrap hides every particle born before it (their birth is "in the future" now).
    if (wrapped < this.uTime.value) {
      this.additive.lastDeath = -Infinity;
      this.normal.lastDeath = -Infinity;
    }
    this.uTime.value = wrapped;
    this.uScale.value = scale;
    let alive = 0;
    for (let k = 0; k < 2; k++) {
      const ring = k === 0 ? this.additive : this.normal;
      const live = visible && ring.filled > 0 && this.uTime.value <= ring.lastDeath;
      ring.points.visible = live;
      if (!live) continue;
      const birth = ring.attrs[A_BIRTH]?.array;
      const life = ring.attrs[A_LIFE]?.array;
      if (!birth || !life) continue;
      const t = this.uTime.value;
      for (let i = 0; i < ring.filled; i++) {
        const age = t - (birth[i] ?? 0);
        if (age >= 0 && age <= (life[i] ?? 0)) alive++;
      }
    }
    return alive;
  }

  /** Marks every particle dead (and the rings empty). */
  clear(): void {
    for (const ring of this.rings) {
      ring.attrs[A_BIRTH]?.array.fill(-1);
      ring.attrs[A_LIFE]?.array.fill(0);
      ring.lastDeath = -Infinity;
      ring.pending = ring.capacity;
      ring.head = 0;
      ring.points.visible = false;
    }
    this.flush();
  }
}
