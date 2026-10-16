import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export const SHADOW_QUALITIES = ['off', 'low', 'high'] as const;
export type ShadowQuality = (typeof SHADOW_QUALITIES)[number];

const SHADOW_MAP_SIZE: Record<Exclude<ShadowQuality, 'off'>, number> = { low: 1024, high: 2048 };
const MAX_PIXEL_RATIO = 2;

export interface RendererOptions {
  /** Target canvas; defaults to `canvas#game`. */
  canvas?: HTMLCanvasElement;
  /** Resolution multiplier on top of the clamped device pixel ratio. Default 1. */
  renderScale?: number;
  /** Vertical field of view in degrees. Default 60. */
  fov?: number;
  shadows?: ShadowQuality;
  antialias?: boolean;
}

/** Counters from `renderer.info` for the frame most recently rendered. */
export interface RenderStats {
  drawCalls: number;
  triangles: number;
  geometries: number;
  textures: number;
  programs: number;
}

export interface TestScene {
  ground: THREE.Mesh;
  grid: THREE.GridHelper;
  hemisphere: THREE.HemisphereLight;
  sun: THREE.DirectionalLight;
}

type TypedMesh = THREE.Mesh<THREE.BufferGeometry, THREE.Material | THREE.Material[]>;
type ShadowLight = THREE.DirectionalLight | THREE.SpotLight | THREE.PointLight;

function isMesh(object: THREE.Object3D): object is TypedMesh {
  return (object as Partial<TypedMesh>).isMesh === true;
}

function isShadowLight(object: THREE.Object3D): object is ShadowLight {
  return (
    object instanceof THREE.DirectionalLight || object instanceof THREE.SpotLight || object instanceof THREE.PointLight
  );
}

function materialsOf(mesh: TypedMesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

function findGameCanvas(): HTMLCanvasElement {
  const el = document.getElementById('game');
  if (!(el instanceof HTMLCanvasElement)) throw new Error('Renderer: canvas#game not found');
  return el;
}

/**
 * Owns the WebGL renderer, scene and camera. Fills the window by default (or a
 * fixed size via `resize(w, h)`), applies pixel ratio and render scale, and
 * exposes an optional orbiting debug camera that leaves the game camera untouched.
 */
export class Renderer {
  readonly canvas: HTMLCanvasElement;
  readonly gl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  /** Free-look camera used while `debugCameraEnabled` is true. */
  readonly debugCamera: THREE.PerspectiveCamera;
  readonly debugControls: OrbitControls;

  private readonly statsSnapshot: RenderStats = { drawCalls: 0, triangles: 0, geometries: 0, textures: 0, programs: 0 };
  private scale: number;
  private shadowQuality: ShadowQuality = 'off';
  private debugEnabled = false;
  private width = 1;
  private height = 1;
  private fixedSize: { width: number; height: number } | null = null;
  private readonly onWindowResize = (): void => this.resize();
  private disposed = false;

  constructor(options: RendererOptions = {}) {
    this.canvas = options.canvas ?? findGameCanvas();
    this.gl = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: options.antialias ?? true,
      powerPreference: 'high-performance',
    });
    this.gl.shadowMap.type = THREE.PCFShadowMap;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.scale = clampScale(options.renderScale ?? 1);

    this.camera = new THREE.PerspectiveCamera(options.fov ?? 60, 1, 0.1, 1000);
    this.camera.position.set(0, 5, 12);
    this.camera.lookAt(0, 1, 0);
    this.debugCamera = this.camera.clone();
    this.debugControls = new OrbitControls(this.debugCamera, this.canvas);
    this.debugControls.enableDamping = true;
    this.debugControls.enabled = false;

    this.setShadows(options.shadows ?? 'low');

    window.addEventListener('resize', this.onWindowResize);
    this.resize();
  }

  get fov(): number {
    return this.camera.fov;
  }

  set fov(degrees: number) {
    this.camera.fov = degrees;
    this.camera.updateProjectionMatrix();
  }

  get renderScale(): number {
    return this.scale;
  }

  /** Resolution multiplier in (0, 2]; applied on top of the device pixel ratio (clamped to 2). */
  setRenderScale(scale: number): void {
    this.scale = clampScale(scale);
    this.applySize();
  }

  get shadows(): ShadowQuality {
    return this.shadowQuality;
  }

  /** Toggles shadow maps and resizes the shadow map of every casting light in the scene. */
  setShadows(quality: ShadowQuality): void {
    this.shadowQuality = quality;
    this.gl.shadowMap.enabled = quality !== 'off';
    this.gl.shadowMap.needsUpdate = true;
    this.scene.traverse((object) => {
      if (isShadowLight(object)) {
        if (quality !== 'off') object.shadow.mapSize.setScalar(SHADOW_MAP_SIZE[quality]);
        object.shadow.map?.dispose();
        object.shadow.map = null;
      }
      if (isMesh(object)) {
        for (const material of materialsOf(object)) material.needsUpdate = true;
      }
    });
  }

  get debugCameraEnabled(): boolean {
    return this.debugEnabled;
  }

  /** The camera `render()` draws with. */
  get activeCamera(): THREE.PerspectiveCamera {
    return this.debugEnabled ? this.debugCamera : this.camera;
  }

  /** Switches between the game camera and the orbiting debug camera (starts from the game view). */
  setDebugCamera(enabled: boolean): void {
    if (enabled === this.debugEnabled) return;
    this.debugEnabled = enabled;
    this.debugControls.enabled = enabled;
    if (!enabled) return;
    this.debugCamera.position.copy(this.camera.position);
    this.debugCamera.quaternion.copy(this.camera.quaternion);
    this.debugCamera.fov = this.camera.fov;
    this.debugCamera.updateProjectionMatrix();
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.debugControls.target.copy(this.camera.position).addScaledVector(forward, 10);
    this.debugControls.update();
  }

  toggleDebugCamera(): void {
    this.setDebugCamera(!this.debugEnabled);
  }

  /**
   * Applies a size in CSS pixels. Without arguments the canvas fills the window
   * (re-applied on window resize); with arguments that fixed size sticks until
   * `resize()` is called again without them.
   */
  resize(width?: number, height?: number): void {
    if (width !== undefined && height !== undefined) this.fixedSize = { width, height };
    else if (width === undefined && height === undefined) this.fixedSize = null;
    const size = this.fixedSize ?? { width: window.innerWidth, height: window.innerHeight };
    this.width = Math.max(1, Math.floor(size.width));
    this.height = Math.max(1, Math.floor(size.height));
    this.applySize();
  }

  /** Draws the scene with the active camera and snapshots `stats`. */
  render(): void {
    if (this.disposed) return;
    if (this.debugEnabled) this.debugControls.update();
    this.gl.render(this.scene, this.activeCamera);
    const info = this.gl.info;
    const s = this.statsSnapshot;
    s.drawCalls = info.render.calls;
    s.triangles = info.render.triangles;
    s.geometries = info.memory.geometries;
    s.textures = info.memory.textures;
    s.programs = info.programs?.length ?? 0;
  }

  /** Counters for the last `render()`; the same object is updated in place each frame. */
  get stats(): Readonly<RenderStats> {
    return this.statsSnapshot;
  }

  /** Releases GPU resources, listeners and controls; the instance is unusable afterwards. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('resize', this.onWindowResize);
    this.debugControls.dispose();
    disposeObject(this.scene);
    this.gl.dispose();
  }

  private applySize(): void {
    const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio;
    this.gl.setPixelRatio(Math.min(dpr, MAX_PIXEL_RATIO) * this.scale);
    this.gl.setSize(this.width, this.height, true);
    const aspect = this.width / this.height;
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    this.debugCamera.aspect = aspect;
    this.debugCamera.updateProjectionMatrix();
  }
}

function clampScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.min(2, scale);
}

/** Disposes every geometry, material and texture under `root` (does not remove it). */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!isMesh(object)) return;
    object.geometry.dispose();
    for (const material of materialsOf(object)) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}

/** Populates `scene` with a lit, fogged 200x200 ground plane and grid for testing. */
export function createTestScene(scene: THREE.Scene): TestScene {
  const skyColor = 0x9fb8d0;
  scene.background = new THREE.Color(skyColor);
  scene.fog = new THREE.Fog(skyColor, 60, 320);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0x3f4247, roughness: 0.95, metalness: 0 }),
  );
  ground.name = 'ground';
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const grid = new THREE.GridHelper(200, 40, 0x7a7f88, 0x50545c);
  grid.name = 'grid';
  grid.position.y = 0.01;
  scene.add(grid);

  const hemisphere = new THREE.HemisphereLight(0xc8dcff, 0x4a4a3c, 1.0);
  hemisphere.name = 'hemisphere';
  scene.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xfff1e0, 2.5);
  sun.name = 'sun';
  sun.position.set(60, 100, 40);
  sun.castShadow = true;
  sun.shadow.mapSize.setScalar(SHADOW_MAP_SIZE.high);
  sun.shadow.camera.left = -120;
  sun.shadow.camera.right = 120;
  sun.shadow.camera.top = 120;
  sun.shadow.camera.bottom = -120;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 400;
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0005;
  sun.shadow.normalBias = 0.02;
  scene.add(sun);
  scene.add(sun.target);

  return { ground, grid, hemisphere, sun };
}
