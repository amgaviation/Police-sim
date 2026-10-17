import * as THREE from 'three';
import type { PostProcess } from '../../render/renderer';

const VERTEX = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const FRAGMENT = /* glsl */ `
uniform sampler2D tDiffuse;
uniform float uTime;
uniform float uStrength;
uniform float uHorizon;
varying vec2 vUv;
void main() {
  // Strongest in a band just below the horizon, where distant hot road shimmers.
  float y = (vUv.y - uHorizon + 0.03) / 0.08;
  float band = exp(-y * y);
  float wobble = sin(vUv.y * 180.0 + uTime * 6.0) * 0.6 + sin(vUv.y * 97.0 - uTime * 4.3 + vUv.x * 30.0) * 0.4;
  vec2 uv = vUv + vec2(0.0025, 0.0012) * wobble * uStrength * band;
  gl_FragColor = texture2D(tDiffuse, uv);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

/**
 * Heat shimmer post pass: renders the scene into a linear HDR target, then draws a
 * full-screen triangle that distorts it near the horizon and applies the renderer's
 * tone mapping and output colour space (skipped for render targets).
 */
export class HeatHazePass implements PostProcess {
  private readonly target: THREE.WebGLRenderTarget;
  private readonly material: THREE.ShaderMaterial;
  private readonly uTime: THREE.IUniform<number> = { value: 0 };
  private readonly uStrength: THREE.IUniform<number> = { value: 0 };
  private readonly uHorizon: THREE.IUniform<number> = { value: 0.5 };
  private readonly quad: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly quadScene = new THREE.Scene();
  private readonly quadCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor() {
    this.target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
    this.material = new THREE.ShaderMaterial({
      name: 'heatHaze',
      uniforms: {
        tDiffuse: { value: this.target.texture },
        uTime: this.uTime,
        uStrength: this.uStrength,
        uHorizon: this.uHorizon,
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    // One triangle covering the screen.
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(geometry, this.material);
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
  }

  /** Shimmer strength 0..1, animation time (s) and horizon height in screen UV (0 bottom .. 1 top). */
  setParams(strength: number, time: number, horizon: number): void {
    this.uStrength.value = strength;
    this.uTime.value = time;
    this.uHorizon.value = horizon;
  }

  render(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    const previous = gl.getRenderTarget();
    gl.setRenderTarget(this.target);
    gl.render(scene, camera);
    gl.setRenderTarget(previous);
    gl.render(this.quadScene, this.quadCamera);
  }

  setSize(width: number, height: number, pixelRatio: number): void {
    this.target.setSize(Math.max(1, Math.floor(width * pixelRatio)), Math.max(1, Math.floor(height * pixelRatio)));
  }

  dispose(): void {
    this.target.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
  }
}
