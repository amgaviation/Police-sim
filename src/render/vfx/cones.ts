import * as THREE from 'three';
import { VFX_DATA, type VfxData } from './data';
import { BEAM_STRIDE, finishInstances, type GlowStage } from './glow';
import { basisFromForward, coneBoost, nearestN } from './math';

const VERTEX = /* glsl */ `
uniform float uLength;
varying float vAxial;
varying float vRim;
void main() {
  // Apex at the origin, widening toward local -Z.
  vAxial = clamp(-position.z / uLength, 0.0, 1.0);
  vec4 mv = modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * (mat3(instanceMatrix) * normal));
  vec3 viewDir = normalize(-mv.xyz);
  vRim = pow(1.0 - abs(dot(n, viewDir)), 1.5);
  gl_Position = projectionMatrix * mv;
}`;

const FRAGMENT = /* glsl */ `
uniform float uAlpha;
uniform vec3 uColor;
varying float vAxial;
varying float vRim;
void main() {
  float a = uAlpha * (1.0 - pow(vAxial, 1.5)) * vRim;
  if (a < 0.002) discard;
  gl_FragColor = vec4(uColor, a);
  #include <colorspace_fragment>
}`;

/** Cone tint (linear RGB): a warm white beam. */
const CONE_COLOR = new THREE.Color(1, 0.95, 0.82);

const basis = new Float64Array(9);

/**
 * Headlight cones: one `InstancedMesh` of an open cone (apex at the origin, widening along local -Z) drawn
 * additively with a soft rim, for the nearest `capacity` beams within `maxDistanceM` of the camera.
 */
export class HeadlightCones {
  readonly mesh: THREE.InstancedMesh;
  private readonly data: VfxData['cones'];
  private readonly alpha: THREE.IUniform<number>;
  private readonly pick: Int32Array;
  private readonly dist: Float64Array;

  constructor(data: VfxData = VFX_DATA) {
    this.data = data.cones;
    this.pick = new Int32Array(data.cones.capacity);
    this.dist = new Float64Array(data.cones.capacity);
    const c = data.cones;
    // CylinderGeometry: radiusTop at +y; move the apex to the origin and turn the axis from -Y to -Z.
    const geometry = new THREE.CylinderGeometry(0.15, c.radiusM, c.lengthM, 16, 1, true).translate(0, -c.lengthM / 2, 0).rotateX(Math.PI / 2);
    this.alpha = { value: 0 };
    const material = new THREE.ShaderMaterial({
      name: 'vfx.cones',
      uniforms: { uLength: { value: c.lengthM }, uAlpha: this.alpha, uColor: { value: CONE_COLOR } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: true,
      fog: false,
      toneMapped: false,
    });
    const mesh = new THREE.InstancedMesh(geometry, material, c.capacity);
    mesh.name = 'vfx-cones';
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.renderOrder = 9;
    mesh.count = 0;
    mesh.visible = false;
    this.mesh = mesh;
  }

  /**
   * Places the nearest beams of `stage` (to the camera at cx, cz) and sets the alpha from `night`, fog and rain.
   * Returns the cone count (0 hides the mesh).
   */
  update(stage: GlowStage, cx: number, cz: number, night: number, fogDensity: number, rain: number): number {
    const d = this.data;
    const boost = coneBoost(night, fogDensity, rain, d.fogBoost, d.rainBoost);
    if (boost <= 0 || stage.beamCount === 0) {
      finishInstances(this.mesh, 0);
      return 0;
    }
    const n = nearestN(stage.beams, BEAM_STRIDE, stage.beamCount, cx, cz, d.maxDistanceM, d.capacity, this.pick, this.dist);
    const array = this.mesh.instanceMatrix.array;
    const beams = stage.beams;
    for (let k = 0; k < n; k++) {
      const o = (this.pick[k] ?? 0) * BEAM_STRIDE;
      basisFromForward(beams[o + 3] ?? 0, beams[o + 4] ?? 0, beams[o + 5] ?? -1, basis);
      const m = k * 16;
      for (let r = 0; r < 3; r++) {
        array[m + r] = basis[r] ?? 0;
        array[m + 4 + r] = basis[3 + r] ?? 0;
        array[m + 8 + r] = basis[6 + r] ?? 0;
      }
      array[m + 3] = 0;
      array[m + 7] = 0;
      array[m + 11] = 0;
      array[m + 12] = beams[o] ?? 0;
      array[m + 13] = beams[o + 1] ?? 0;
      array[m + 14] = beams[o + 2] ?? 0;
      array[m + 15] = 1;
    }
    this.alpha.value = d.intensity * boost;
    finishInstances(this.mesh, n);
    return n;
  }

  hide(): void {
    finishInstances(this.mesh, 0);
  }
}
