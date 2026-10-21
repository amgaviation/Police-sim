import * as THREE from 'three';
import { createRng } from '../../core/rng';
import { VFX_DATA, type VfxData } from '../../render/vfx/data';

/** Edge of the particle box that wraps around the camera, m. */
export const PRECIP_BOX = 40;
export const PRECIP_MAX_PARTICLES = 8000;
/**
 * Particles fade in between these distances from the eye (m) and sprites are capped at this size (px):
 * a drop or flake next to the camera would otherwise cover hundreds of pixels (and show inside the cabin).
 */
export const PRECIP_NEAR_FADE: readonly [number, number] = [1, 3];
export const PRECIP_MAX_POINT_PX = 64;
/** Base fall speed (m/s) and the share of the wind velocity particles drift with. */
export const PRECIP_FALL_SPEED = { rain: 9, snow: 1.2 } as const;
export const PRECIP_WIND_DRIFT = { rain: 0.15, snow: 0.6 } as const;
/**
 * The owner integrates the fall distance and the drift on the CPU and wraps them here. Per-particle
 * fall speeds are quantised to (20 + q) / 25 of the base (q = 0..9), so every particle's offset wraps
 * by a whole number of boxes at PRECIP_FALL_WRAP; sway frequencies are (8 + q) / 10 and (7 + q) / 10
 * rad/s, so the sway clock wraps after whole periods at PRECIP_SWAY_WRAP. Nothing jumps at a wrap.
 */
export const PRECIP_FALL_WRAP = PRECIP_BOX * 25;
export const PRECIP_SWAY_WRAP = 20 * Math.PI;
/** Height of the rain splash rings above the ground, m. */
export const SPLASH_HEIGHT = 0.02;

const VERTEX = /* glsl */ `
#define NEAR_FADE vec2(${PRECIP_NEAR_FADE[0].toFixed(1)}, ${PRECIP_NEAR_FADE[1].toFixed(1)})
#define MAX_POINT_PX ${PRECIP_MAX_POINT_PX.toFixed(1)}
uniform float uTime;
uniform float uFall;
uniform vec3 uCamera;
uniform vec2 uDrift;
uniform float uSnow;
uniform float uBox;
uniform float uScale;
uniform float uSize;
attribute float aRand;
varying float vFade;
void main() {
  float q = min(floor(aRand * 10.0), 9.0);
  vec3 p = position;
  p.y -= uFall * (0.8 + 0.04 * q);
  p.xz += uDrift;
  p.x += uSnow * sin(uTime * (0.8 + 0.1 * q) + aRand * 40.0) * 0.6;
  p.z += uSnow * cos(uTime * (0.7 + 0.1 * q) + aRand * 25.0) * 0.6;
  vec3 h = vec3(uBox * 0.5);
  vec3 world = uCamera + mod(p - uCamera + h, uBox) - h;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = min(uSize * uScale / max(-mv.z, 0.5), MAX_POINT_PX);
  float d = length(world - uCamera);
  vFade = (1.0 - smoothstep(uBox * 0.3, uBox * 0.5, d)) * smoothstep(NEAR_FADE.x, NEAR_FADE.y, d);
}`;

const FRAGMENT = /* glsl */ `
uniform float uSnow;
uniform vec3 uColor;
uniform float uOpacity;
varying float vFade;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float flake = 1.0 - smoothstep(0.2, 0.5, length(c));
  float streak = (1.0 - smoothstep(0.0, 0.06, abs(c.x))) * (1.0 - smoothstep(0.3, 0.5, abs(c.y)));
  float a = mix(streak, flake, uSnow) * vFade * uOpacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface PrecipitationUniforms {
  /** Snow sway clock, s (wrapped by the owner at PRECIP_SWAY_WRAP). */
  uTime: THREE.IUniform<number>;
  /** Base fall distance, m (integrated and wrapped at PRECIP_FALL_WRAP by the owner). */
  uFall: THREE.IUniform<number>;
  uCamera: THREE.IUniform<THREE.Vector3>;
  /** Integrated wind drift (x, z), m, wrapped by the owner at PRECIP_BOX. */
  uDrift: THREE.IUniform<THREE.Vector2>;
  /** 0 = rain streaks, 1 = swaying snow flakes. */
  uSnow: THREE.IUniform<number>;
  uBox: THREE.IUniform<number>;
  /** Drawing-buffer height / (2 tan(fov / 2)): metres at 1 m distance -> pixels. */
  uScale: THREE.IUniform<number>;
  /** Sprite size, m. */
  uSize: THREE.IUniform<number>;
  uColor: THREE.IUniform<THREE.Color>;
  uOpacity: THREE.IUniform<number>;
}

export interface Precipitation {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly uniforms: PrecipitationUniforms;
}

/**
 * GPU rain/snow: a fixed `Points` cloud whose particles are animated and wrapped into a
 * box around the camera entirely in the vertex shader. Per frame the CPU only writes
 * uniforms and the draw range (count scales with precipitation).
 */
export function createPrecipitation(): Precipitation {
  // Render-only scatter; a fixed seed keeps the pattern identical between runs.
  const rng = createRng('environment:precipitation');
  const positions = new Float32Array(PRECIP_MAX_PARTICLES * 3);
  const rand = new Float32Array(PRECIP_MAX_PARTICLES);
  for (let i = 0; i < PRECIP_MAX_PARTICLES; i++) {
    positions[i * 3] = rng.next() * PRECIP_BOX;
    positions[i * 3 + 1] = rng.next() * PRECIP_BOX;
    positions[i * 3 + 2] = rng.next() * PRECIP_BOX;
    rand[i] = rng.next();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aRand', new THREE.BufferAttribute(rand, 1));
  geometry.setDrawRange(0, 0);
  const uniforms: PrecipitationUniforms = {
    uTime: { value: 0 },
    uFall: { value: 0 },
    uCamera: { value: new THREE.Vector3() },
    uDrift: { value: new THREE.Vector2() },
    uSnow: { value: 0 },
    uBox: { value: PRECIP_BOX },
    uScale: { value: 1 },
    uSize: { value: 0.5 },
    uColor: { value: new THREE.Color() },
    uOpacity: { value: 0.5 },
  };
  const material = new THREE.ShaderMaterial({
    name: 'precipitation',
    uniforms: { ...uniforms },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const points = new THREE.Points(geometry, material);
  points.name = 'precipitation';
  points.frustumCulled = false;
  points.visible = false;
  return { points, uniforms };
}

const SPLASH_VERTEX = /* glsl */ `
#define MAX_POINT_PX ${PRECIP_MAX_POINT_PX.toFixed(1)}
uniform float uPhase;
uniform vec3 uCamera;
uniform float uRadius;
uniform float uRing;
uniform float uScale;
attribute float aRand;
varying float vPhase;
varying float vFade;
void main() {
  // Ground points wrapped into a square around the camera (xz).
  vec2 h = vec2(uRadius);
  vec2 xz = uCamera.xz + mod(position.xz - uCamera.xz + h, 2.0 * h) - h;
  vec4 mv = viewMatrix * vec4(xz.x, position.y, xz.y, 1.0);
  gl_Position = projectionMatrix * mv;
  vPhase = fract(uPhase + aRand);
  gl_PointSize = min(2.0 * uRing * uScale / max(-mv.z, 0.5), MAX_POINT_PX);
  float d = length(xz - uCamera.xz);
  vFade = (1.0 - smoothstep(uRadius * 0.6, uRadius, d)) * (1.0 - vPhase);
}`;

const SPLASH_FRAGMENT = /* glsl */ `
uniform vec3 uColor;
uniform float uOpacity;
varying float vPhase;
varying float vFade;
void main() {
  // Expanding ring: its radius (0..1 of the sprite half-width) is the phase.
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float ring = 1.0 - smoothstep(0.0, 0.18, abs(d - vPhase));
  float a = ring * vFade * uOpacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface SplashUniforms {
  /** Ring cycle position 0..1 (advanced at `rateHz` cycles per second and wrapped by the owner, so it never jumps). */
  uPhase: THREE.IUniform<number>;
  uCamera: THREE.IUniform<THREE.Vector3>;
  uRadius: THREE.IUniform<number>;
  uRing: THREE.IUniform<number>;
  /** Drawing-buffer height / (2 tan(fov / 2)). */
  uScale: THREE.IUniform<number>;
  uColor: THREE.IUniform<THREE.Color>;
  uOpacity: THREE.IUniform<number>;
}

export interface Splashes {
  readonly points: THREE.Points<THREE.BufferGeometry, THREE.ShaderMaterial>;
  readonly uniforms: SplashUniforms;
  /** Most splash points (the draw range scales with `precipitation * (1 - precipSnow)`). */
  readonly count: number;
}

/**
 * Rain splashes: `splashes.count` ground points (y = 0.02) scattered over a square of `2 * radiusM` that wraps around
 * the camera, each drawn as an expanding, fading ring at its own phase. GPU only; the owner writes uniforms and the
 * draw range (rain only, never snow).
 */
export function createSplashes(data: VfxData = VFX_DATA): Splashes {
  const s = data.splashes;
  const rng = createRng('vfx:splashes');
  const positions = new Float32Array(s.count * 3);
  const rand = new Float32Array(s.count);
  for (let i = 0; i < s.count; i++) {
    positions[i * 3] = rng.next() * s.radiusM * 2;
    positions[i * 3 + 1] = SPLASH_HEIGHT;
    positions[i * 3 + 2] = rng.next() * s.radiusM * 2;
    rand[i] = rng.next();
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aRand', new THREE.BufferAttribute(rand, 1));
  geometry.setDrawRange(0, 0);
  const uniforms: SplashUniforms = {
    uPhase: { value: 0 },
    uCamera: { value: new THREE.Vector3() },
    uRadius: { value: s.radiusM },
    uRing: { value: s.ringM },
    uScale: { value: 1 },
    uColor: { value: new THREE.Color() },
    uOpacity: { value: 0.5 },
  };
  const material = new THREE.ShaderMaterial({
    name: 'splashes',
    uniforms: { ...uniforms },
    vertexShader: SPLASH_VERTEX,
    fragmentShader: SPLASH_FRAGMENT,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const points = new THREE.Points(geometry, material);
  points.name = 'splashes';
  points.frustumCulled = false;
  points.visible = false;
  return { points, uniforms, count: s.count };
}
