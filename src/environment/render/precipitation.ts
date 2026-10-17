import * as THREE from 'three';
import { createRng } from '../../core/rng';

/** Edge of the particle box that wraps around the camera, m. */
export const PRECIP_BOX = 40;
export const PRECIP_MAX_PARTICLES = 8000;

const VERTEX = /* glsl */ `
uniform float uTime;
uniform vec3 uCamera;
uniform vec2 uWind;
uniform float uSnow;
uniform float uBox;
uniform float uScale;
uniform float uSize;
attribute float aRand;
varying float vFade;
void main() {
  float speed = mix(9.0, 1.2, uSnow) * (0.8 + 0.4 * aRand);
  vec3 p = position;
  p.y -= uTime * speed;
  p.xz += uWind * uTime * mix(0.15, 0.6, uSnow);
  p.x += uSnow * sin(uTime * (0.8 + aRand) + aRand * 40.0) * 0.6;
  p.z += uSnow * cos(uTime * (0.7 + aRand) + aRand * 25.0) * 0.6;
  vec3 h = vec3(uBox * 0.5);
  vec3 world = uCamera + mod(p - uCamera + h, uBox) - h;
  vec4 mv = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uScale / max(-mv.z, 0.5);
  vFade = 1.0 - smoothstep(uBox * 0.3, uBox * 0.5, length(world - uCamera));
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
  /** Animation time, s (wrapped by the owner to keep float precision). */
  uTime: THREE.IUniform<number>;
  uCamera: THREE.IUniform<THREE.Vector3>;
  /** Wind velocity (x, z), m/s. */
  uWind: THREE.IUniform<THREE.Vector2>;
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
    uCamera: { value: new THREE.Vector3() },
    uWind: { value: new THREE.Vector2() },
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
