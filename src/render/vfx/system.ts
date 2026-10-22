import * as THREE from 'three';
import { createRng } from '../../core/rng';
import { disposeObject } from '../renderer';
import { TaserArc } from './arc';
import { HeadlightCones } from './cones';
import { VFX_DATA, type VfxData } from './data';
import { GlowSprites, GlowStage, LightPools } from './glow';
import { emitSpec, randomDirection, VFX_TIME_WRAP, type EmitSpec } from './math';
import { ParticlePool } from './particles';
import type { EffectsQuality, GlowSink, VfxParticleKind } from './types';

/** Share of a directed burst's speed added as random spread. */
const SPREAD = 0.35;
/** Muzzle flash sprite brightness under reduced flash. */
const REDUCED_MUZZLE = 0.4;
/** Pools are skipped below this night factor. */
const POOL_MIN_NIGHT = 0.05;
/** Fallback drawing-buffer height (px) until `setViewportHeight` is called. */
const DEFAULT_VIEWPORT_HEIGHT = 1080;
const MUZZLE_LIGHT_COLOR = 0xffd9a0;

/** Counters of the last `update` (draw calls <= 6). */
export interface VfxStats {
  glows: number;
  pools: number;
  cones: number;
  particles: number;
  drawCalls: number;
}

/** A point with `x`, `y`, `z` (the arc endpoints). */
export interface VfxPoint {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * Phase 9 effects (design §6): glow sprites and ground light pools on lit lamps, headlight cones, a GPU particle
 * pool, the CED arc and a pooled muzzle light. Presentation only; render-only randomness (`vfx:*` streams).
 * `CarRenderer.setGlowSink(vfx.glowSink)` feeds the lamps; `update` runs once per frame after the car renderer.
 * Everything is created once (the muzzle light stays in the scene at intensity 0) so no shader recompiles at runtime.
 * With `scene === null` the objects exist but are not attached anywhere.
 */
export class VfxSystem {
  readonly glowSink: GlowSink;
  readonly stats: VfxStats = { glows: 0, pools: 0, cones: 0, particles: 0, drawCalls: 0 };
  private readonly data: VfxData;
  private readonly group = new THREE.Group();
  private readonly stage: GlowStage;
  private readonly glow: GlowSprites;
  private readonly pools: LightPools;
  private readonly cones: HeadlightCones;
  private readonly particles: ParticlePool;
  private readonly taser: TaserArc;
  private readonly muzzleLight: THREE.PointLight;
  private readonly rng = createRng('vfx:particles');
  private readonly spec: EmitSpec = { count: 0, speed: 0, life: 0 };
  private readonly dir = new Float64Array(3);
  private quality: EffectsQuality = 'high';
  private reducedFlash = false;
  private time = 0;
  private muzzleLeft = 0;
  private viewportHeight = DEFAULT_VIEWPORT_HEIGHT;
  private disposed = false;

  constructor(scene: THREE.Scene | null, data: VfxData = VFX_DATA) {
    this.data = data;
    this.group.name = 'vfx';
    this.stage = new GlowStage(data.glow.capacity, data.glow.pool.capacity);
    this.glowSink = this.stage;
    this.glow = new GlowSprites(data);
    this.pools = new LightPools(data);
    this.cones = new HeadlightCones(data);
    this.particles = new ParticlePool(data);
    this.taser = new TaserArc(data);
    const m = data.muzzleLight;
    this.muzzleLight = new THREE.PointLight(MUZZLE_LIGHT_COLOR, 0, m.distance, 2);
    this.muzzleLight.name = 'vfx-muzzle-light';
    this.muzzleLight.castShadow = false;
    this.group.add(
      this.glow.mesh,
      this.pools.mesh,
      this.cones.mesh,
      this.particles.additive.points,
      this.particles.normal.points,
      this.taser.line,
      this.muzzleLight,
    );
    scene?.add(this.group);
  }

  /** Current effects quality. */
  get effectsQuality(): EffectsQuality {
    return this.quality;
  }

  /** off: nothing drawn and emissions ignored; low: no cones or pools, smaller glow, half the particles; high: all. */
  setQuality(q: EffectsQuality): void {
    this.quality = q;
    if (q === 'off') this.hideAll();
  }

  /** Reduced flash: no muzzle light and the muzzle sprites at 40 %, and a static dim CED arc. */
  setReducedFlash(on: boolean): void {
    this.reducedFlash = on;
    if (on) {
      this.muzzleLeft = 0;
      this.muzzleLight.intensity = 0;
    }
  }

  /** Drawing-buffer height in pixels (particle sprite scale); call on resize. */
  setViewportHeight(px: number): void {
    if (px > 0) this.viewportHeight = px;
  }

  /**
   * One-shot particles of `kind` at (x, y, z). A non-zero direction (dirX, dirY, dirZ) points the burst (with some
   * spread); a zero direction scatters it over the upper hemisphere. `intensity` (0..1) scales the particle count.
   */
  burst(kind: VfxParticleKind, x: number, y: number, z: number, dirX: number, dirY: number, dirZ: number, intensity: number): void {
    if (this.quality === 'off' || this.disposed) return;
    const inten = intensity > 1 ? 1 : intensity;
    if (!(inten > 0)) return;
    const k = this.data.particles.kinds[kind];
    const spec = this.spec;
    emitSpec(kind, this.rng, spec, this.data);
    let n = Math.round(spec.count * inten * (this.quality === 'low' ? 0.5 : 1));
    n = Math.min(Math.max(n, 1), this.particles.ringCapacity);
    const len = Math.sqrt(dirX * dirX + dirY * dirY + dirZ * dirZ);
    const directed = len > 1e-6;
    const fx = directed ? dirX / len : 0;
    const fy = directed ? dirY / len : 0;
    const fz = directed ? dirZ / len : 0;
    const dim = kind === 'muzzle' && this.reducedFlash ? REDUCED_MUZZLE : 1;
    const dir = this.dir;
    for (let i = 0; i < n; i++) {
      if (i > 0) emitSpec(kind, this.rng, spec, this.data);
      randomDirection(this.rng, !directed, dir);
      const s = spec.speed;
      const spread = directed ? s * SPREAD : s;
      const base = directed ? s : 0;
      this.particles.spawn(
        k.additive,
        x,
        y,
        z,
        fx * base + (dir[0] ?? 0) * spread,
        fy * base + (dir[1] ?? 0) * spread,
        fz * base + (dir[2] ?? 0) * spread,
        k.gravity,
        this.time,
        spec.life,
        k.size,
        k.color[0] * dim,
        k.color[1] * dim,
        k.color[2] * dim,
      );
    }
  }

  /**
   * Muzzle flash: a 'muzzle' burst along (dirX, dirZ) plus the pooled point light for `durationS`. With reduced flash
   * there is no light and the burst is dimmed to 40 %.
   */
  muzzle(x: number, y: number, z: number, dirX: number, dirZ: number): void {
    if (this.quality === 'off' || this.disposed) return;
    this.burst('muzzle', x, y, z, dirX, 0, dirZ, 1);
    if (this.reducedFlash) return;
    const light = this.muzzleLight;
    light.position.set(x, y, z);
    light.intensity = this.data.muzzleLight.intensity;
    this.muzzleLeft = this.data.muzzleLight.durationS;
  }

  /**
   * CED arc between two points for this frame (call every frame while the probes are attached); `null` hides it.
   * Jagged polyline of `arc.segments`; with reduced flash a static dim line.
   */
  arc(from: VfxPoint | null, to?: VfxPoint): void {
    if (this.quality === 'off' || this.disposed || !from || !to) {
      this.taser.clear();
      return;
    }
    this.taser.set(from.x, from.y, from.z, to.x, to.y, to.z);
  }

  /**
   * Per frame after `CarRenderer.update`: uploads the glow, pool and cone instances, flushes new particles,
   * advances the shader clock and sets the camera-dependent uniforms. `night` is 0..1, `dt` real seconds.
   * Allocation-free apart from three's own update-range records.
   */
  update(camera: THREE.Camera, dt: number, night: number, fogDensity: number, rain: number): void {
    if (this.disposed) return;
    const step = dt > 0 ? dt : 0;
    this.time = (this.time + step) % VFX_TIME_WRAP;
    if (this.quality === 'off') {
      this.hideAll();
      return;
    }
    const n = night < 0 ? 0 : night > 1 ? 1 : night;
    const high = this.quality === 'high';
    const stats = this.stats;
    const e = camera.matrixWorld.elements;
    const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 60;
    const scale = this.viewportHeight / (2 * Math.tan((fov * Math.PI) / 360));

    stats.glows = this.glow.update(this.stage, n, high ? 1 : this.data.glow.lowSizeFactor);
    stats.pools = high && n >= POOL_MIN_NIGHT ? this.pools.update(this.stage, n) : this.hidePools();
    stats.cones = high ? this.cones.update(this.stage, e[12] ?? 0, e[14] ?? 0, n, fogDensity, rain) : this.hideCones();

    this.particles.flush();
    stats.particles = this.particles.update(this.time, scale, true);

    const arcDrawn = this.taser.update(this.time, this.reducedFlash);

    if (this.muzzleLeft > 0) {
      this.muzzleLeft -= step;
      if (this.muzzleLeft <= 0) this.muzzleLight.intensity = 0;
    }

    stats.drawCalls =
      (stats.glows > 0 ? 1 : 0) +
      (stats.pools > 0 ? 1 : 0) +
      (stats.cones > 0 ? 1 : 0) +
      (this.particles.additive.points.visible ? 1 : 0) +
      (this.particles.normal.points.visible ? 1 : 0) +
      (arcDrawn ? 1 : 0);
  }

  /** Removes everything from the scene and frees the GPU resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.group.removeFromParent();
    disposeObject(this.group);
  }

  private hidePools(): number {
    this.pools.hide();
    return 0;
  }

  private hideCones(): number {
    this.cones.hide();
    return 0;
  }

  private hideAll(): void {
    this.glow.mesh.visible = false;
    this.glow.mesh.count = 0;
    this.pools.hide();
    this.cones.hide();
    this.particles.additive.points.visible = false;
    this.particles.normal.points.visible = false;
    this.taser.clear();
    this.muzzleLeft = 0;
    this.muzzleLight.intensity = 0;
    const s = this.stats;
    s.glows = s.pools = s.cones = s.particles = s.drawCalls = 0;
  }
}
