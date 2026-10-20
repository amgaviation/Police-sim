import * as THREE from 'three';
import { DEFAULT_DRAW_DISTANCE, disposeObject, type Renderer, type ShadowQuality } from '../../render/renderer';
import type { Environment } from '../environment';
import type { Rgb } from '../sky';
import { HeatHazePass } from './heatHaze';
import {
  PRECIP_BOX,
  PRECIP_FALL_SPEED,
  PRECIP_FALL_WRAP,
  PRECIP_MAX_PARTICLES,
  PRECIP_SWAY_WRAP,
  PRECIP_WIND_DRIFT,
  createPrecipitation,
  type Precipitation,
} from './precipitation';
import { createSkyDome, type SkyDome } from './skyDome';

export interface EnvironmentRendererOptions {
  shadows?: ShadowQuality;
}

const SHADOW_MAP_SIZE: Record<Exclude<ShadowQuality, 'off'>, number> = { low: 1024, high: 2048 };
/** Half extent of the shadow camera around the focus, m. */
const SHADOW_HALF_EXTENT = 150;
/** Distance of the light from the focus along the light direction, m. */
const SHADOW_LIGHT_DISTANCE = 400;
/** Fog far as a fraction of the draw distance (matches the renderer's own fog scaling). */
const FOG_FAR_FRACTION = 0.4;
const FOG_NEAR_RATIO = 0.1875;
const MIN_FOG_FAR = 30;
/** Linear-fog visibility from the weather's exponential density: far ~ factor / density. */
const VISIBILITY_FACTOR = 2;
/** Heat-haze animation time wraps here so the shader keeps float precision. */
const HAZE_TIME_WRAP = 600;
/** Fallback drawing-buffer height without a renderer (headless). */
const HEADLESS_HEIGHT = 1080;
const RAIN_COLOR = { r: 0.72, g: 0.76, b: 0.82 };
const SNOW_COLOR = { r: 0.95, g: 0.96, b: 1.0 };
/**
 * sky.json ambient intensities are authored in legacy (pre-r155) light units; three's physically
 * based Lambert term divides by pi, so the hemisphere light is scaled back up by pi. Without it,
 * everything in shadow (street canyons at low sun) rendered near black.
 */
const AMBIENT_SCALE = Math.PI;
/** Hemisphere intensity indoors (before AMBIENT_SCALE): a faint fill so unlit rooms are not pitch black. */
const INDOOR_AMBIENT = 0.05;

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function setSrgb(color: THREE.Color, c: Readonly<Rgb>, scale = 1): void {
  color.setRGB(c.r * scale, c.g * scale, c.b * scale, THREE.SRGBColorSpace);
}

/**
 * Render side of the environment: sky dome, sun/moon directional light with a shadow
 * camera that follows the focus, hemisphere ambient, `scene.fog`/`scene.background`,
 * GPU precipitation and (in heat) a heat-haze post pass. Everything it adds lives
 * under one group; `update` is allocation-free.
 */
export class EnvironmentRenderer {
  private readonly scene: THREE.Scene;
  private readonly renderer: Renderer | null;
  private readonly root = new THREE.Group();
  private readonly sky: SkyDome;
  private readonly precip: Precipitation;
  private readonly light = new THREE.DirectionalLight(0xffffff, 0);
  private readonly hemisphere = new THREE.HemisphereLight(0xffffff, 0x000000, 0);
  private readonly fog = new THREE.Fog(0x000000, 60, 320);
  private readonly background = new THREE.Color();
  /** Created on first use and kept (rebuilding allocates an MSAA target and compiles a program). */
  private haze: HeatHazePass | null = null;
  private hazeInstalled = false;
  /** True while the camera is inside an interior: no precipitation, no heat haze. */
  private indoor = false;
  private shadowQuality: ShadowQuality = 'off';
  private time = 0;
  /** Precipitation motion integrated per frame (see PRECIP_FALL_WRAP): fall distance, sway clock, wind drift. */
  private fall = 0;
  private sway = 0;
  private readonly drift = new THREE.Vector2();
  private disposed = false;
  private readonly scratchPos = new THREE.Vector3();
  private readonly scratchDir = new THREE.Vector3();
  private readonly lightDir = new THREE.Vector3();
  private readonly right = new THREE.Vector3();
  private readonly up = new THREE.Vector3();
  private readonly bufferSize = new THREE.Vector2();

  constructor(scene: THREE.Scene, renderer: Renderer | null, options: EnvironmentRendererOptions = {}) {
    this.scene = scene;
    this.renderer = renderer;
    this.root.name = 'environment';
    this.sky = createSkyDome();
    this.precip = createPrecipitation();

    this.light.name = 'sunMoon';
    this.light.shadow.camera.left = -SHADOW_HALF_EXTENT;
    this.light.shadow.camera.right = SHADOW_HALF_EXTENT;
    this.light.shadow.camera.top = SHADOW_HALF_EXTENT;
    this.light.shadow.camera.bottom = -SHADOW_HALF_EXTENT;
    this.light.shadow.camera.near = 1;
    this.light.shadow.camera.far = SHADOW_LIGHT_DISTANCE * 2;
    this.light.shadow.camera.updateProjectionMatrix();
    this.light.shadow.bias = -0.0005;
    this.light.shadow.normalBias = 0.03;
    this.hemisphere.name = 'ambient';

    this.root.add(this.sky.mesh, this.light, this.light.target, this.hemisphere, this.precip.points);
    scene.add(this.root);
    scene.fog = this.fog;
    scene.background = this.background;
    this.fog.far = this.drawDistance() * FOG_FAR_FRACTION;
    this.fog.near = this.fog.far * FOG_NEAR_RATIO;
    this.setShadowQuality(options.shadows ?? renderer?.shadows ?? 'off');
  }

  /** Current linear fog far distance (m); the chunk streamer loads up to it. */
  get viewDistance(): number {
    return this.fog.far;
  }

  /** Per frame, after the camera moved. `focus` is the shadow centre (the player). */
  update(env: Environment, camera: THREE.PerspectiveCamera, focus: { x: number; y: number; z: number }, realDt: number): void {
    if (this.disposed) return;
    const sky = env.sky;
    const l = env.lighting;
    const w = env.weather;
    this.time = (this.time + Math.max(0, realDt)) % HAZE_TIME_WRAP;
    const cameraPos = camera.getWorldPosition(this.scratchPos);

    // Fog and background.
    const visibility = VISIBILITY_FACTOR / Math.max(w.fogDensity, 1e-6);
    this.fog.far = Math.max(MIN_FOG_FAR, Math.min(this.drawDistance() * FOG_FAR_FRACTION, visibility));
    this.fog.near = this.fog.far * FOG_NEAR_RATIO;
    setSrgb(this.fog.color, sky.fog);
    this.background.copy(this.fog.color);

    // Sky dome.
    const u = this.sky.uniforms;
    setSrgb(u.uTop.value, sky.skyTop);
    setSrgb(u.uHorizon.value, sky.skyHorizon);
    u.uFog.value.copy(this.fog.color);
    setSrgb(u.uSunColor.value, sky.sunColor);
    u.uSunDir.value.set(l.sunDirX, l.sunDirY, l.sunDirZ);
    u.uSunDisc.value = (1 - 0.9 * w.cloudCover) * smoothstep(-0.03, 0.02, l.sunDirY);
    u.uMoonDisc.value = (1 - 0.95 * w.cloudCover) * smoothstep(-0.03, 0.02, -l.sunDirY);
    this.sky.mesh.position.copy(cameraPos);
    this.sky.mesh.scale.setScalar(camera.far * 0.9);

    // Sun by day, moon (opposite direction) by night; both fade out at the horizon.
    const dayWeight = smoothstep(0, 0.08, l.sunDirY);
    const nightWeight = smoothstep(0, 0.08, -l.sunDirY);
    const sign = l.sunDirY >= 0 ? 1 : -1;
    this.lightDir.set(l.sunDirX * sign, l.sunDirY * sign, l.sunDirZ * sign);
    // Indoors the interior's own light pool does all the lighting: the sun has no occluder (the city is hidden, not shadowing).
    this.light.intensity = this.indoor ? 0 : l.sunIntensity * dayWeight + l.moonIntensity * nightWeight;
    setSrgb(this.light.color, sky.sunColor);
    this.placeLight(focus);
    const shadowsOn = this.shadowQuality !== 'off' && dayWeight > 0;
    this.light.shadow.autoUpdate = shadowsOn;
    this.light.shadow.intensity = shadowsOn ? 1 : 0;
    // Materials keep sampling the shadow map at night, so a map disposed by a quality change must
    // still be rebuilt once (an unbound shadow sampler is a GL_INVALID_OPERATION on every draw).
    if (!shadowsOn && this.light.castShadow && this.light.shadow.map === null) this.light.shadow.needsUpdate = true;

    setSrgb(this.hemisphere.color, sky.ambientSky);
    setSrgb(this.hemisphere.groundColor, sky.ambientGround);
    this.hemisphere.intensity = this.indoor ? INDOOR_AMBIENT * AMBIENT_SCALE : sky.ambientIntensity * AMBIENT_SCALE;

    this.updatePrecipitation(env, camera, cameraPos, Math.max(0, realDt));
    this.updateHaze(this.indoor ? 0 : w.heatHaze, camera);
  }

  /**
   * Compiles every program the heat-haze pass will need for what is in the scene now (call once the
   * session's first chunks are in, behind the loading phase). Otherwise the first hot spell recompiles
   * every material synchronously for the render-target variant in the middle of a drive. Precipitation
   * is hidden while it is dry and `compile` skips hidden objects, so it is shown for the duration and
   * compiled for the screen as well (otherwise the first rain of a session compiles mid-drive).
   */
  prewarmHaze(camera: THREE.Camera): void {
    const renderer = this.renderer;
    if (!renderer || this.disposed) return;
    this.haze ??= new HeatHazePass();
    const points = this.precip.points;
    const visible = points.visible;
    points.visible = true;
    renderer.gl.compile(this.scene, camera);
    this.haze.compile(renderer.gl, this.scene, camera);
    points.visible = visible;
  }

  /**
   * Indoors (an interior is resident under the camera): hides the precipitation points, skips the heat-haze pass and
   * replaces the sun / moon and the sky ambient with a faint constant ambient, so only the interior's lights light it.
   */
  setIndoor(on: boolean): void {
    this.indoor = on;
  }

  /** Enables/sizes the sun shadow map; call alongside `Renderer.setShadows`. */
  setShadowQuality(quality: ShadowQuality): void {
    this.shadowQuality = quality;
    const shadow = this.light.shadow;
    this.light.castShadow = quality !== 'off';
    if (quality !== 'off') shadow.mapSize.setScalar(SHADOW_MAP_SIZE[quality]);
    shadow.map?.dispose();
    shadow.map = null;
  }

  /** Removes everything this renderer added and frees its GPU resources. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.hazeInstalled) this.renderer?.setPostProcess(null);
    this.hazeInstalled = false;
    this.haze?.dispose();
    this.haze = null;
    this.root.removeFromParent();
    disposeObject(this.root);
    if (this.scene.fog === this.fog) this.scene.fog = null;
    if (this.scene.background === this.background) this.scene.background = null;
  }

  private drawDistance(): number {
    return this.renderer?.drawDistance ?? DEFAULT_DRAW_DISTANCE;
  }

  /**
   * Centres the shadow camera on the focus, snapped to whole shadow texels in light
   * space so static shadows do not shimmer as the focus moves.
   */
  private placeLight(focus: { x: number; y: number; z: number }): void {
    const dir = this.lightDir;
    // Light-space basis matching the shadow camera (looking along -dir, world up).
    this.right.set(dir.z, 0, -dir.x);
    if (this.right.lengthSq() < 1e-8) this.right.set(1, 0, 0);
    this.right.normalize();
    this.up.crossVectors(dir, this.right);
    const texel = (SHADOW_HALF_EXTENT * 2) / this.light.shadow.mapSize.x;
    const p = this.scratchDir.set(focus.x, focus.y, focus.z);
    const fx = Math.round(p.dot(this.right) / texel) * texel;
    const fy = Math.round(p.dot(this.up) / texel) * texel;
    const fz = p.dot(dir);
    const target = this.light.target.position;
    target.set(0, 0, 0).addScaledVector(this.right, fx).addScaledVector(this.up, fy).addScaledVector(dir, fz);
    this.light.position.copy(target).addScaledVector(dir, SHADOW_LIGHT_DISTANCE);
  }

  private updatePrecipitation(env: Environment, camera: THREE.PerspectiveCamera, cameraPos: THREE.Vector3, dt: number): void {
    const w = env.weather;
    const points = this.precip.points;
    const count = Math.round(PRECIP_MAX_PARTICLES * Math.min(1, w.precipitation));
    points.visible = count > 0 && !this.indoor;
    if (!points.visible) return;
    points.geometry.setDrawRange(0, count);
    const u = this.precip.uniforms;
    // By what falls, not by `w.kind`: a snow segment blending into clear still snows.
    const snow = w.precipSnow > 0.5;
    const height = this.renderer ? this.renderer.gl.getDrawingBufferSize(this.bufferSize).y : HEADLESS_HEIGHT;
    // Integrated here rather than as velocity * time in the shader, so a changing wind or fall speed
    // (a weather blend) only changes the current velocity, and the wraps are seamless.
    const drift = snow ? PRECIP_WIND_DRIFT.snow : PRECIP_WIND_DRIFT.rain;
    const dx = this.drift.x + w.windX * drift * dt, dz = this.drift.y + w.windZ * drift * dt;
    this.drift.set(dx - PRECIP_BOX * Math.floor(dx / PRECIP_BOX), dz - PRECIP_BOX * Math.floor(dz / PRECIP_BOX));
    this.fall = (this.fall + (snow ? PRECIP_FALL_SPEED.snow : PRECIP_FALL_SPEED.rain) * dt) % PRECIP_FALL_WRAP;
    this.sway = (this.sway + dt) % PRECIP_SWAY_WRAP;
    u.uTime.value = this.sway;
    u.uFall.value = this.fall;
    u.uDrift.value.copy(this.drift);
    u.uCamera.value.copy(cameraPos);
    u.uSnow.value = snow ? 1 : 0;
    u.uScale.value = height / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    u.uSize.value = snow ? 0.08 : 0.5;
    // Dimmer at night so particles do not glow in the dark.
    setSrgb(u.uColor.value, snow ? SNOW_COLOR : RAIN_COLOR, 0.25 + 0.75 * (1 - env.lighting.nightFactor));
    u.uOpacity.value = snow ? 0.9 : 0.35;
  }

  /** Installs the heat-haze pass only while there is haze (and a renderer to draw it). */
  private updateHaze(strength: number, camera: THREE.PerspectiveCamera): void {
    const renderer = this.renderer;
    if (!renderer) return;
    if (strength <= 0.01) {
      if (this.hazeInstalled) {
        renderer.setPostProcess(null);
        this.hazeInstalled = false;
      }
      return;
    }
    this.haze ??= new HeatHazePass();
    if (!this.hazeInstalled) {
      renderer.setPostProcess(this.haze);
      this.hazeInstalled = true;
    }
    // Screen height of the horizon from the camera pitch.
    const forward = camera.getWorldDirection(this.scratchDir);
    const pitch = Math.asin(Math.max(-1, Math.min(1, forward.y)));
    const ndcY = -Math.tan(pitch) / Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    this.haze.setParams(Math.min(1, strength), this.time, 0.5 + 0.5 * ndcY);
  }
}
