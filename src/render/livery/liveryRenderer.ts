import type { EntityId } from 'bitecs';
import * as THREE from 'three';
import type { LiveryDoc } from '../../livery/types';
import { paintLivery, SHELL_ATLAS, type Canvas2DLike } from '../../livery/painter';
import type { VehicleModel } from '../../vehicles/model';
import { disposeObject } from '../renderer';
import { vehicleRenderBasis } from '../vehicles/carRenderer';
import { hasShell, shellGeometryData } from './shell';

/** What the canvas factory returns: an object with a 2D context (a real `HTMLCanvasElement` satisfies it). */
export interface LiveryCanvas {
  getContext(kind: '2d'): Canvas2DLike | null;
}

export interface LiveryRendererOptions {
  /** Most shells placed per frame (default 8): the nearest liveried vehicles. */
  maxVisible?: number;
  /** Liveried vehicles farther than this from the camera (m, default 150) get no shell. */
  maxDistance?: number;
  /** Creates a `w` x `h` canvas; null = no canvas available (headless). Default: a DOM canvas when `document` exists. */
  canvasFactory?: (w: number, h: number) => LiveryCanvas | null;
}

/** Peak emissive strength of the reflective layers at night. */
const REFLECTIVE_GLOW = 0.9;
const POLYGON_OFFSET = -2;
const ALPHA_TEST = 0.04;

interface Paint {
  canvas: LiveryCanvas;
  ctx: Canvas2DLike;
  texture: THREE.CanvasTexture;
}

interface Entry {
  readonly eid: EntityId;
  model: VehicleModel;
  doc: LiveryDoc;
  /** JSON of `doc` when it was last painted (a re-parsed identical document does not repaint). */
  json: string;
  unit: string;
  dept: string;
  color: Paint | null;
  glow: Paint | null;
  material: THREE.MeshStandardMaterial | null;
}

function defaultCanvasFactory(w: number, h: number): LiveryCanvas | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  return canvas as unknown as LiveryCanvas;
}

/** Roughness and metalness of a finish (design §10.3). */
function finishParams(finish: LiveryDoc['base']['finish']): { roughness: number; metalness: number } {
  if (finish === 'matte') return { roughness: 0.85, metalness: 0 };
  if (finish === 'metallic') return { roughness: 0.3, metalness: 0.6 };
  return { roughness: 0.35, metalness: 0 };
}

/**
 * Livery decal shells (design §10.3): a thin shell of quads around a vehicle's body with the painted livery
 * (colour map) and its reflective layers (emissive map, glowing under low light). One mesh per shell, pooled:
 * only the nearest `maxVisible` liveried vehicles within `maxDistance` of the camera are placed. The two canvases
 * of a vehicle are repainted only when its document, unit number or department changes. Without a canvas
 * (headless) `set` just records the document and `update` only counts.
 */
export class LiveryRenderer {
  readonly stats = { shells: 0, drawCalls: 0, repaints: 0 };
  private readonly group = new THREE.Group();
  private readonly maxVisible: number;
  private readonly maxDistance: number;
  private readonly canvasFactory: (w: number, h: number) => LiveryCanvas | null;
  private readonly entries: Entry[] = [];
  private readonly byEid = new Map<EntityId, Entry>();
  private readonly geometries = new Map<string, THREE.BufferGeometry>();
  private readonly pool: THREE.Mesh[] = [];
  /** The nearest entries of this frame, ascending by distance, and their squared distances. */
  private readonly nearest: Entry[];
  private readonly nearestD: Float64Array;
  private readonly pos = new THREE.Vector3();
  private readonly quat = new THREE.Quaternion();
  private disposed = false;

  constructor(scene: THREE.Scene, options: LiveryRendererOptions = {}) {
    this.maxVisible = Math.max(1, Math.floor(options.maxVisible ?? 8));
    this.maxDistance = options.maxDistance ?? 150;
    this.canvasFactory = options.canvasFactory ?? defaultCanvasFactory;
    this.nearest = new Array<Entry>(this.maxVisible);
    this.nearestD = new Float64Array(this.maxVisible);
    this.group.name = 'livery-shells';
    scene.add(this.group);
  }

  /** Number of vehicles with a livery set. */
  get size(): number {
    return this.entries.length;
  }

  /**
   * Sets (or clears with null, or for a style without a shell) the livery of vehicle `eid`; repaints its two canvases only when the document, the
   * unit number or the department changed (pass a new document object after an edit).
   */
  set(eid: EntityId, model: VehicleModel, doc: LiveryDoc | null, unit: string, dept: string): void {
    // Thin-framed styles (bikes, ATV, boat, aircraft, drone) get no shell: an opaque slab would hide the vehicle.
    if (doc === null || !hasShell(model)) {
      this.remove(eid);
      return;
    }
    let entry = this.byEid.get(eid);
    if (!entry) {
      entry = { eid, model, doc, json: '', unit: '', dept: '', color: null, glow: null, material: null };
      this.entries.push(entry);
      this.byEid.set(eid, entry);
    }
    entry.model = model;
    let changed = entry.json === '' || entry.unit !== unit || entry.dept !== dept;
    if (entry.doc !== doc || entry.json === '') {
      const json = JSON.stringify(doc);
      if (json !== entry.json) changed = true;
      entry.json = json;
      entry.doc = doc;
    }
    entry.unit = unit;
    entry.dept = dept;
    if (changed) this.repaint(entry);
  }

  /** Drops the livery of `eid` and frees its canvases and textures. */
  remove(eid: EntityId): void {
    const entry = this.byEid.get(eid);
    if (!entry) return;
    this.byEid.delete(eid);
    const i = this.entries.indexOf(entry);
    const last = this.entries.pop();
    if (i >= 0 && last && last !== entry) this.entries[i] = last;
    this.free(entry);
  }

  /**
   * Places the nearest `maxVisible` liveried vehicles within `maxDistance` of the camera (`camX`, `camZ`) at their
   * interpolated transform (`alpha`); `night` 0..1 drives the glow of the reflective layers.
   */
  update(alpha: number, camX: number, camZ: number, night: number): void {
    const glow = REFLECTIVE_GLOW * (night < 0 ? 0 : night > 1 ? 1 : night);
    const maxD2 = this.maxDistance * this.maxDistance;
    const cap = this.maxVisible;
    const nearest = this.nearest;
    const nearestD = this.nearestD;
    let n = 0;
    for (let i = 0; i < this.entries.length; i++) {
      const entry = this.entries[i] as Entry;
      vehicleRenderBasis(entry.eid, alpha, this.pos, this.quat);
      const dx = this.pos.x - camX;
      const dz = this.pos.z - camZ;
      const d2 = dx * dx + dz * dz;
      if (d2 > maxD2) continue;
      // Insertion into the ascending top-N list.
      if (n === cap && d2 >= (nearestD[cap - 1] ?? Infinity)) continue;
      let j = n < cap ? n++ : cap - 1;
      while (j > 0 && (nearestD[j - 1] ?? 0) > d2) {
        nearest[j] = nearest[j - 1] as Entry;
        nearestD[j] = nearestD[j - 1] ?? 0;
        j--;
      }
      nearest[j] = entry;
      nearestD[j] = d2;
    }

    let drawn = 0;
    for (let k = 0; k < n; k++) {
      const entry = nearest[k] as Entry;
      const material = entry.material;
      if (!material) continue;
      const mesh = this.meshAt(drawn++);
      const geometry = this.geometryFor(entry.model);
      if (mesh.geometry !== geometry) mesh.geometry = geometry;
      if (mesh.material !== material) mesh.material = material;
      vehicleRenderBasis(entry.eid, alpha, mesh.position, mesh.quaternion);
      mesh.visible = true;
      material.emissiveIntensity = glow;
    }
    for (let k = drawn; k < this.pool.length; k++) (this.pool[k] as THREE.Mesh).visible = false;
    this.stats.shells = n;
    this.stats.drawCalls = drawn;
  }

  /** Removes everything from the scene and frees geometries, materials and textures. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries) this.free(entry);
    this.entries.length = 0;
    this.byEid.clear();
    this.group.removeFromParent();
    disposeObject(this.group);
    for (const geometry of this.geometries.values()) geometry.dispose();
    this.geometries.clear();
    this.pool.length = 0;
    this.stats.shells = 0;
    this.stats.drawCalls = 0;
  }

  /** Paints `entry`'s colour and reflective canvases (creating them and the material on first use). */
  private repaint(entry: Entry): void {
    if (!entry.color || !entry.glow) {
      const color = this.createPaint();
      const glow = this.createPaint();
      if (!color || !glow) {
        // Headless or no 2D context: the document is recorded, nothing is drawn.
        for (const paint of [color, glow]) paint?.texture.dispose();
        return;
      }
      entry.color = color;
      entry.glow = glow;
      entry.material = new THREE.MeshStandardMaterial({
        map: color.texture,
        emissiveMap: glow.texture,
        emissive: 0xffffff,
        emissiveIntensity: 0,
        transparent: true,
        alphaTest: ALPHA_TEST,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: POLYGON_OFFSET,
      });
    }
    paintLivery(entry.color.ctx, entry.doc, { unit: entry.unit, dept: entry.dept, reflectiveOnly: false });
    paintLivery(entry.glow.ctx, entry.doc, { unit: entry.unit, dept: entry.dept, reflectiveOnly: true });
    entry.color.texture.needsUpdate = true;
    entry.glow.texture.needsUpdate = true;
    const material = entry.material;
    if (material) {
      const { roughness, metalness } = finishParams(entry.doc.base.finish);
      material.roughness = roughness;
      material.metalness = metalness;
    }
    this.stats.repaints++;
  }

  private createPaint(): Paint | null {
    const canvas = this.canvasFactory(SHELL_ATLAS.width, SHELL_ATLAS.height);
    const ctx = canvas?.getContext('2d') ?? null;
    if (!canvas || !ctx) return null;
    const texture = new THREE.CanvasTexture(canvas as unknown as HTMLCanvasElement);
    texture.colorSpace = THREE.SRGBColorSpace;
    return { canvas, ctx, texture };
  }

  private free(entry: Entry): void {
    entry.color?.texture.dispose();
    entry.glow?.texture.dispose();
    entry.material?.dispose();
    entry.color = null;
    entry.glow = null;
    entry.material = null;
  }

  private geometryFor(model: VehicleModel): THREE.BufferGeometry {
    let geometry = this.geometries.get(model.id);
    if (!geometry) {
      const data = shellGeometryData(model);
      geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
      geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
      geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
      geometry.computeVertexNormals();
      geometry.name = `livery-shell:${model.id}`;
      this.geometries.set(model.id, geometry);
    }
    return geometry;
  }

  private meshAt(k: number): THREE.Mesh {
    let mesh = this.pool[k];
    if (!mesh) {
      mesh = new THREE.Mesh(new THREE.BufferGeometry());
      mesh.name = `livery-shell-${k}`;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = true;
      this.group.add(mesh);
      this.pool.push(mesh);
    }
    return mesh;
  }
}
