import * as THREE from 'three';

const VERTEX = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAGMENT = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uFog;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunDisc;
uniform float uMoonDisc;
varying vec3 vDir;
void main() {
  vec3 d = normalize(vDir);
  float e = d.y;
  vec3 col = mix(uFog, uHorizon, smoothstep(-0.02, 0.1, e));
  col = mix(col, uTop, smoothstep(0.1, 0.65, e));
  float s = dot(d, uSunDir);
  col += uSunColor * uSunDisc * (smoothstep(0.9994, 0.9997, s) * 12.0 + pow(max(s, 0.0), 48.0) * 0.35);
  float m = dot(d, -uSunDir);
  col += vec3(0.8, 0.85, 0.95) * uMoonDisc * smoothstep(0.99955, 0.9998, m) * 1.5;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export interface SkyDomeUniforms {
  uTop: THREE.IUniform<THREE.Color>;
  uHorizon: THREE.IUniform<THREE.Color>;
  uFog: THREE.IUniform<THREE.Color>;
  uSunDir: THREE.IUniform<THREE.Vector3>;
  uSunColor: THREE.IUniform<THREE.Color>;
  /** 0..1 visibility of the sun and moon discs. */
  uSunDisc: THREE.IUniform<number>;
  uMoonDisc: THREE.IUniform<number>;
}

export interface SkyDome {
  readonly mesh: THREE.Mesh<THREE.SphereGeometry, THREE.ShaderMaterial>;
  readonly uniforms: SkyDomeUniforms;
}

/**
 * Inverted unit sphere with a horizon-to-zenith gradient plus sun and moon discs.
 * The owner moves it to the camera and scales it inside the far plane each frame.
 */
export function createSkyDome(): SkyDome {
  const uniforms: SkyDomeUniforms = {
    uTop: { value: new THREE.Color() },
    uHorizon: { value: new THREE.Color() },
    uFog: { value: new THREE.Color() },
    uSunDir: { value: new THREE.Vector3(0, 1, 0) },
    uSunColor: { value: new THREE.Color() },
    uSunDisc: { value: 0 },
    uMoonDisc: { value: 0 },
  };
  const material = new THREE.ShaderMaterial({
    name: 'skyDome',
    uniforms: { ...uniforms },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    side: THREE.BackSide,
    fog: false,
    depthWrite: false,
    depthTest: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 16), material);
  mesh.name = 'skyDome';
  mesh.renderOrder = -1000;
  mesh.frustumCulled = false;
  return { mesh, uniforms };
}
