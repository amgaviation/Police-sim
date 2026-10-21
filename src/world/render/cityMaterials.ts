import * as THREE from 'three';
import { createRng } from '../../core/rng';
import { VFX_DATA } from '../../render/vfx/data';
import { wetParams, type WetParams } from '../../render/vfx/math';
import { WINDOW_CELLS, WINDOW_TEXTURE_SIZE, type ChunkGroupName } from './chunkMesher';

/** Window emissive intensity at full night. */
const WINDOW_GLOW = 1.1;
/** Lamp head emissive intensity while streetlights are on. */
const LAMP_GLOW = 3;
/** Fraction of windows lit at night. */
const LIT_FRACTION = 0.42;
/** Dry roughness of the lane markings (the ground's comes from vfx.json). */
const MARKINGS_DRY_ROUGHNESS = 0.8;
/** Wetness steps smaller than this are not written to the materials. */
const WET_EPSILON = 0.01;
/** Fixed render-only seed of the window pattern. */
const WINDOW_SEED = 0x51ad0;

interface WindowTextures {
  map: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture;
}

/**
 * Canvas-generated window tile (WINDOW_CELLS x WINDOW_CELLS windows): white walls
 * with dark glass for the colour map, warm lit windows on black for the emissive
 * map. Null without a DOM (worker, tests). Each cell keeps a wall margin so the
 * mesher's roof UV (texel 0, bottom row) is plain wall.
 */
function createWindowTextures(): WindowTextures | null {
  if (typeof document === 'undefined') return null;
  const albedo = document.createElement('canvas');
  const glow = document.createElement('canvas');
  albedo.width = albedo.height = glow.width = glow.height = WINDOW_TEXTURE_SIZE;
  const a = albedo.getContext('2d');
  const e = glow.getContext('2d');
  if (!a || !e) return null;
  const cell = WINDOW_TEXTURE_SIZE / WINDOW_CELLS;
  const rng = createRng(WINDOW_SEED);
  a.fillStyle = '#ffffff';
  a.fillRect(0, 0, WINDOW_TEXTURE_SIZE, WINDOW_TEXTURE_SIZE);
  e.fillStyle = '#000000';
  e.fillRect(0, 0, WINDOW_TEXTURE_SIZE, WINDOW_TEXTURE_SIZE);
  const x0 = cell * 0.19, y0 = cell * 0.22, w = cell * 0.62, h = cell * 0.56;
  for (let row = 0; row < WINDOW_CELLS; row++) {
    for (let col = 0; col < WINDOW_CELLS; col++) {
      const px = col * cell + x0, py = row * cell + y0;
      a.fillStyle = '#3c4654';
      a.fillRect(px, py, w, h);
      if (!rng.chance(LIT_FRACTION)) continue;
      const v = 0.55 + 0.45 * rng.next();
      e.fillStyle = `rgb(${Math.round(255 * v)}, ${Math.round(214 * v)}, ${Math.round(150 * v)})`;
      e.fillRect(px, py, w, h);
    }
  }
  const make = (canvas: HTMLCanvasElement): THREE.CanvasTexture => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 4;
    return t;
  };
  return { map: make(albedo), emissive: make(glow) };
}

/**
 * Materials shared by every chunk mesh, one per group: vertex-coloured
 * `MeshStandardMaterial`s; buildings carry the window texture (map + emissive
 * map, when a DOM exists), markings use polygon offset, lamps are emissive.
 */
export class CityMaterials {
  readonly ground: THREE.MeshStandardMaterial;
  readonly markings: THREE.MeshStandardMaterial;
  readonly buildings: THREE.MeshStandardMaterial;
  readonly props: THREE.MeshStandardMaterial;
  readonly lamps: THREE.MeshStandardMaterial;
  private readonly windows: WindowTextures | null;
  /** Effective wetness last written to the ground and markings. */
  private wet = 0;
  private readonly wetScratch: WetParams = { w: 0, groundRoughness: 0, markingsRoughness: 0, groundTint: 1 };

  constructor() {
    this.windows = createWindowTextures();
    this.ground = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: VFX_DATA.wet.dryRoughness });
    this.markings = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: MARKINGS_DRY_ROUGHNESS,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.buildings = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.85,
      map: this.windows?.map ?? null,
      emissive: this.windows ? 0xffffff : 0x000000,
      emissiveMap: this.windows?.emissive ?? null,
      emissiveIntensity: 0,
    });
    this.props = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8 });
    this.lamps = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, emissive: 0xffd9a0, emissiveIntensity: 0 });
    this.ground.name = 'city.ground';
    this.markings.name = 'city.markings';
    this.buildings.name = 'city.buildings';
    this.props.name = 'city.props';
    this.lamps.name = 'city.lamps';
  }

  get(name: ChunkGroupName): THREE.MeshStandardMaterial {
    return this[name];
  }

  /** Lit windows scale with the night factor (only with the window texture); lamp heads glow while streetlights are on. */
  setLighting(nightFactor: number, streetlightsOn: boolean): void {
    const n = Math.min(1, Math.max(0, nightFactor));
    this.buildings.emissiveIntensity = this.windows ? n * WINDOW_GLOW : 0;
    this.lamps.emissiveIntensity = streetlightsOn ? LAMP_GLOW : 0;
  }

  /**
   * Wet sheen: with `w = wetness * (1 - snowCover)` the ground and the markings lerp from dry to wet roughness and the
   * ground darkens by `1 - darken * w` (a colour scalar). Writes only when `w` moved by more than 0.01 (or reached 0 / 1).
   */
  setWetness(wetness: number, snowCover: number): void {
    const p = wetParams(wetness, snowCover, MARKINGS_DRY_ROUGHNESS, this.wetScratch);
    const moved = Math.abs(p.w - this.wet);
    if (moved <= WET_EPSILON && !((p.w === 0 || p.w === 1) && p.w !== this.wet)) return;
    this.wet = p.w;
    this.ground.roughness = p.groundRoughness;
    this.markings.roughness = p.markingsRoughness;
    this.ground.color.setScalar(p.groundTint);
  }

  dispose(): void {
    this.windows?.map.dispose();
    this.windows?.emissive.dispose();
    for (const m of [this.ground, this.markings, this.buildings, this.props, this.lamps]) m.dispose();
  }
}
