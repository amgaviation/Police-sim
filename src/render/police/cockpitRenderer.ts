import type { EntityId } from 'bitecs';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { VehicleModel } from '../../vehicles/model';
import { interpolateTransform } from '../meshSync';
import {
  cockpitParts,
  LED_COUNT,
  ledColors,
  radioDisplayText,
  type CockpitGroup,
  type CockpitPart,
  type CockpitState,
} from './cockpitParts';
import { domCanvas, type CanvasFactory } from './mdtScreen';

export interface CockpitRendererOptions {
  /** Canvas for the radio head display (default: a DOM canvas; null headless). */
  createCanvas?: CanvasFactory;
}

/** Radio display canvas size (px). */
const RADIO_W = 128;
const RADIO_H = 32;
const SCREEN_OFF = 0x05080c;
const RADIO_OFF = 0x0a1a10;

const scratchQuat = new THREE.Quaternion();
const scratchEuler = new THREE.Euler(0, 0, 0, 'YXZ');
const scratchPos = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
const scratchMatrix = new THREE.Matrix4();

/** Local transform of `p` (no scale) into `out`. */
function partMatrix(p: CockpitPart, scale: boolean, out: THREE.Matrix4): THREE.Matrix4 {
  scratchEuler.set(p.rx, p.ry, 0, 'YXZ');
  scratchQuat.setFromEuler(scratchEuler);
  scratchPos.set(p.x, p.y, p.z);
  if (scale) scratchScale.set(p.sx, p.sy, p.sz);
  else scratchScale.set(1, 1, 1);
  return out.compose(scratchPos, scratchQuat, scratchScale);
}

/** Sized geometry of one part: a ring for the steering wheel, a plane for screens, a box otherwise. */
function partGeometry(p: CockpitPart): THREE.BufferGeometry {
  if (p.kind === 'wheel') {
    const tube = p.sz / 2;
    return new THREE.TorusGeometry(p.sx / 2 - tube, tube, 6, 20);
  }
  if (p.kind === 'screen' || p.kind === 'radioDisplay') return new THREE.PlaneGeometry(p.sx, p.sy);
  return new THREE.BoxGeometry(p.sx, p.sy, p.sz);
}

function mergedParts(parts: readonly CockpitPart[]): THREE.BufferGeometry {
  const pieces = parts.map((p) => partGeometry(p).applyMatrix4(partMatrix(p, false, scratchMatrix)));
  const merged = mergeGeometries(pieces);
  for (const g of pieces) g.dispose();
  if (!merged) throw new Error('CockpitRenderer: could not merge cockpit parts');
  return merged;
}

/** Meshes built for one vehicle model. */
interface Built {
  readonly meshes: THREE.Object3D[];
  readonly leds: THREE.InstancedMesh;
  /** Cage bars then guns; null without partition and rack. */
  readonly cage: THREE.InstancedMesh | null;
  /** Instance index of the first gun in `cage` and the gun matrices (16 floats each). */
  readonly gunStart: number;
  readonly gunMatrices: Float32Array;
  readonly drawCalls: number;
}

/**
 * First-person patrol-car interior (design §12): at most six meshes in the vehicle frame (interior,
 * dark trim, instanced LED quads, MDT screen plane with a `CanvasTexture`, radio display with its own
 * small canvas, instanced cage bars and racked guns), placed from the interpolated transform of the
 * selected vehicle each frame and visible only in cockpit view of a model with `equipment`.
 */
export class CockpitRenderer {
  readonly stats = { drawCalls: 0 };
  private readonly group = new THREE.Group();
  private readonly interiorMaterial = new THREE.MeshStandardMaterial({ color: 0x2a2c30, roughness: 0.9 });
  private readonly trimMaterial = new THREE.MeshStandardMaterial({ color: 0x111214, roughness: 0.6, metalness: 0.2 });
  private readonly ledMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false });
  private readonly screenMaterial = new THREE.MeshBasicMaterial({ color: SCREEN_OFF, toneMapped: false });
  private readonly radioMaterial = new THREE.MeshBasicMaterial({ color: RADIO_OFF, toneMapped: false });
  private readonly cageMaterial = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.5, metalness: 0.6 });
  private readonly radioCanvas: HTMLCanvasElement | null;
  private readonly radioCtx: CanvasRenderingContext2D | null;
  private readonly radioTexture: THREE.CanvasTexture | null;
  private screenTexture: THREE.CanvasTexture | null = null;
  private eid: EntityId = 0;
  private model: VehicleModel | null = null;
  private built: Built | null = null;
  private readonly leds = new Float32Array(LED_COUNT * 3);
  private readonly ledsShown = new Float32Array(LED_COUNT * 3).fill(-1);
  /** Per gun: 1 shown, 0 hidden, -1 not written yet. */
  private gunsShown = new Int8Array(0);
  private radioChannel: string | null = null;
  private radioFlags = -1;
  /** Radio display repaints (for tests and the perf overlay). */
  radioPaints = 0;

  constructor(scene: THREE.Scene, options: CockpitRendererOptions = {}) {
    this.group.name = 'cockpit';
    this.group.visible = false;
    const canvas = (options.createCanvas ?? domCanvas)(RADIO_W, RADIO_H);
    this.radioCtx = canvas ? canvas.getContext('2d') : null;
    this.radioCanvas = this.radioCtx ? canvas : null;
    if (this.radioCanvas) {
      this.radioTexture = new THREE.CanvasTexture(this.radioCanvas);
      this.radioTexture.colorSpace = THREE.SRGBColorSpace;
      this.radioMaterial.map = this.radioTexture;
      this.radioMaterial.color.set(0xffffff);
    } else {
      this.radioTexture = null;
    }
    scene.add(this.group);
  }

  /** The vehicle the cockpit sits in (0 / null = none). Rebuilds the meshes only when the model changes. */
  setVehicle(eid: EntityId, model: VehicleModel | null): void {
    this.eid = model ? eid : 0;
    if (model === this.model) return;
    this.model = model;
    this.clearBuilt();
    if (model?.equipment) this.built = this.build(model);
  }

  /** The canvas shown on the laptop screen (`MdtScreen.canvas`); null shows a dark screen. */
  setScreenSource(canvas: HTMLCanvasElement | null): void {
    if (this.screenTexture && this.screenTexture.image === canvas) return;
    this.screenTexture?.dispose();
    this.screenTexture = null;
    if (canvas) {
      this.screenTexture = new THREE.CanvasTexture(canvas);
      this.screenTexture.colorSpace = THREE.SRGBColorSpace;
      this.screenMaterial.color.set(0xffffff);
    } else {
      this.screenMaterial.color.set(SCREEN_OFF);
    }
    this.screenMaterial.map = this.screenTexture;
    this.screenMaterial.needsUpdate = true;
  }

  /** The screen canvas was repainted: upload it on the next render. */
  markScreenDirty(): void {
    if (this.screenTexture) this.screenTexture.needsUpdate = true;
  }

  /**
   * Places the cockpit at the vehicle's transform interpolated by `alpha` and refreshes LEDs, racked
   * guns and the radio display (each only when changed). Hidden unless `visible` (cockpit view) and
   * the vehicle's model has `equipment`.
   */
  update(alpha: number, visible: boolean, state: CockpitState): void {
    const built = this.built;
    const show = visible && built !== null && this.eid !== 0;
    this.group.visible = show;
    if (!show) {
      this.stats.drawCalls = 0;
      return;
    }
    interpolateTransform(this.eid, alpha, this.group.position, this.group.quaternion);

    // LEDs.
    const leds = ledColors(state, this.leds);
    let ledsChanged = false;
    for (let i = 0; i < leds.length; i++) {
      if (leds[i] !== this.ledsShown[i]) {
        ledsChanged = true;
        break;
      }
    }
    const colors = built.leds.instanceColor;
    if (ledsChanged && colors) {
      this.ledsShown.set(leds);
      (colors.array as Float32Array).set(leds);
      colors.needsUpdate = true;
    }

    // Racked guns: hidden ones get a zero matrix.
    const cage = built.cage;
    if (cage) {
      const shown = this.gunsShown;
      let dirty = false;
      for (let i = 0; i < shown.length; i++) {
        const on = state.racked[i] === true ? 1 : 0;
        if (shown[i] === on) continue;
        shown[i] = on;
        dirty = true;
        const array = cage.instanceMatrix.array;
        const o = (built.gunStart + i) * 16;
        if (on) array.set(built.gunMatrices.subarray(i * 16, i * 16 + 16), o);
        else array.fill(0, o, o + 16);
      }
      if (dirty) cage.instanceMatrix.needsUpdate = true;
    }

    // Radio display.
    const flags = (state.radioTx ? 1 : 0) | (state.radioRx ? 2 : 0) | (state.scanning ? 4 : 0) | (state.emergency ? 8 : 0);
    if (state.radioChannel !== this.radioChannel || flags !== this.radioFlags) {
      this.radioChannel = state.radioChannel;
      this.radioFlags = flags;
      this.paintRadio(state);
    }
    this.stats.drawCalls = built.drawCalls;
  }

  /** Removes the cockpit from the scene and frees geometries, materials and textures. */
  dispose(): void {
    this.clearBuilt();
    this.group.removeFromParent();
    this.screenTexture?.dispose();
    this.screenTexture = null;
    this.radioTexture?.dispose();
    for (const m of [
      this.interiorMaterial,
      this.trimMaterial,
      this.ledMaterial,
      this.screenMaterial,
      this.radioMaterial,
      this.cageMaterial,
    ]) {
      m.dispose();
    }
    this.model = null;
    this.eid = 0;
  }

  private paintRadio(state: CockpitState): void {
    const ctx = this.radioCtx;
    if (!ctx || !this.radioTexture) return;
    const [line1 = '', line2 = ''] = radioDisplayText(state.radioChannel, state.radioTx, state.radioRx, state.scanning, state.emergency).split('\n');
    ctx.fillStyle = state.emergency ? '#3a0a08' : '#08140c';
    ctx.fillRect(0, 0, RADIO_W, RADIO_H);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.font = 'bold 13px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = '#8cff9e';
    ctx.fillText(line1, 4, 9);
    ctx.font = 'bold 11px ui-monospace, Menlo, Consolas, monospace';
    ctx.fillStyle = state.emergency ? '#ff6a5a' : state.radioTx ? '#ffd27a' : '#8cff9e';
    ctx.fillText(line2, 4, 24);
    this.radioTexture.needsUpdate = true;
    this.radioPaints++;
  }

  private clearBuilt(): void {
    const built = this.built;
    if (!built) return;
    for (const mesh of built.meshes) {
      mesh.removeFromParent();
      if (mesh instanceof THREE.InstancedMesh) mesh.dispose();
      if (mesh instanceof THREE.Mesh) (mesh.geometry as THREE.BufferGeometry).dispose();
    }
    this.built = null;
    this.gunsShown = new Int8Array(0);
    this.ledsShown.fill(-1);
    this.radioChannel = null;
    this.radioFlags = -1;
  }

  private build(model: VehicleModel): Built {
    const parts = cockpitParts(model);
    const of = (group: CockpitGroup): CockpitPart[] => parts.filter((p) => p.group === group);
    const meshes: THREE.Object3D[] = [];
    const merged = (name: string, group: CockpitGroup, material: THREE.Material): void => {
      const list = of(group);
      if (list.length === 0) return;
      const mesh = new THREE.Mesh(mergedParts(list), material);
      mesh.name = name;
      meshes.push(mesh);
    };
    merged('cockpit-interior', 'interior', this.interiorMaterial);
    merged('cockpit-trim', 'trim', this.trimMaterial);
    merged('cockpit-screen', 'screen', this.screenMaterial);
    merged('cockpit-radio', 'radio', this.radioMaterial);

    const box = new THREE.BoxGeometry(1, 1, 1);
    const ledParts = of('led');
    const leds = new THREE.InstancedMesh(box, this.ledMaterial, Math.max(1, ledParts.length));
    leds.name = 'cockpit-leds';
    ledParts.forEach((p, i) => leds.setMatrixAt(i, partMatrix(p, true, scratchMatrix)));
    leds.setColorAt(0, new THREE.Color(0, 0, 0));
    leds.count = ledParts.length;
    meshes.push(leds);

    const bars = of('cage').filter((p) => p.kind === 'cageBar');
    const guns = of('cage').filter((p) => p.kind === 'gun');
    const gunMatrices = new Float32Array(guns.length * 16);
    let cage: THREE.InstancedMesh | null = null;
    if (bars.length + guns.length > 0) {
      cage = new THREE.InstancedMesh(box.clone(), this.cageMaterial, bars.length + guns.length);
      cage.name = 'cockpit-cage';
      bars.forEach((p, i) => cage?.setMatrixAt(i, partMatrix(p, true, scratchMatrix)));
      guns.forEach((p, i) => {
        partMatrix(p, true, scratchMatrix).toArray(gunMatrices, i * 16);
        cage?.setMatrixAt(bars.length + i, scratchMatrix);
      });
      meshes.push(cage);
    }
    for (const mesh of meshes) {
      // The group moves with the car every frame; the interior is always in front of the camera.
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
    this.gunsShown = new Int8Array(guns.length).fill(-1);
    return { meshes, leds, cage, gunStart: bars.length, gunMatrices, drawCalls: meshes.length };
  }
}
