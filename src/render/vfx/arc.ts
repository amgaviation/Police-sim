import * as THREE from 'three';
import { createRng, type Rng } from '../../core/rng';
import { VFX_DATA, type VfxData } from './data';

/** Arc line opacity: full, and the static dim level under reduced flash. */
const ARC_OPACITY = 0.9;
const ARC_OPACITY_REDUCED = 0.45;

/**
 * CED arc: one `Line` of `arc.segments` segments between two points. The interior points are jittered and the
 * jitter is redrawn at `rateHz` (render rng `vfx:arc`); with reduced flash the line is straight and dim and never
 * changes.
 */
export class TaserArc {
  readonly line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  private readonly segments: number;
  private readonly jitterM: number;
  private readonly rateHz: number;
  private readonly positions: Float32Array;
  private readonly jitter: Float32Array;
  private readonly rng: Rng = createRng('vfx:arc');
  private tick = -1;
  private wanted = false;
  private readonly from = new Float64Array(3);
  private readonly to = new Float64Array(3);

  constructor(data: VfxData = VFX_DATA) {
    this.segments = data.arc.segments;
    this.jitterM = data.arc.jitterM;
    this.rateHz = data.arc.rateHz;
    const points = this.segments + 1;
    this.positions = new Float32Array(points * 3);
    this.jitter = new Float32Array(points * 3);
    const geometry = new THREE.BufferGeometry();
    const attr = new THREE.BufferAttribute(this.positions, 3);
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', attr);
    const material = new THREE.LineBasicMaterial({
      color: 0xc4dcff,
      transparent: true,
      opacity: ARC_OPACITY,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    this.line = new THREE.Line(geometry, material);
    this.line.name = 'vfx-arc';
    this.line.frustumCulled = false;
    this.line.renderOrder = 12;
    this.line.visible = false;
  }

  /** Sets the endpoints for the coming `update` (the arc is shown for that frame only). */
  set(fx: number, fy: number, fz: number, tx: number, ty: number, tz: number): void {
    this.from[0] = fx;
    this.from[1] = fy;
    this.from[2] = fz;
    this.to[0] = tx;
    this.to[1] = ty;
    this.to[2] = tz;
    this.wanted = true;
  }

  /** Hides the arc now. */
  clear(): void {
    this.wanted = false;
    this.line.visible = false;
  }

  /** Rebuilds the polyline when an arc was set since the last call; returns whether it is drawn. */
  update(timeS: number, reducedFlash: boolean): boolean {
    if (!this.wanted) {
      this.line.visible = false;
      return false;
    }
    this.wanted = false;
    const tick = Math.floor(timeS * this.rateHz);
    if (!reducedFlash && tick !== this.tick) {
      this.tick = tick;
      const j = this.jitter;
      for (let i = 0; i < j.length; i++) j[i] = this.rng.nextFloat(-this.jitterM, this.jitterM);
    }
    const n = this.segments;
    const pos = this.positions;
    const jitter = this.jitter;
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      // The ends stay on the officer and the target.
      const k = reducedFlash || i === 0 || i === n ? 0 : 1;
      for (let a = 0; a < 3; a++) {
        const f = this.from[a] ?? 0;
        pos[i * 3 + a] = f + ((this.to[a] ?? 0) - f) * t + k * (jitter[i * 3 + a] ?? 0);
      }
    }
    const attr = this.line.geometry.getAttribute('position');
    attr.needsUpdate = true;
    this.line.material.opacity = reducedFlash ? ARC_OPACITY_REDUCED : ARC_OPACITY;
    this.line.visible = true;
    return true;
  }
}
