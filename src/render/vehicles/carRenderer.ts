import { commitRemovals, registerQuery, type EntityId, type Query } from 'bitecs';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MAX_ENTITIES, Transform } from '../../ecs/components';
import type { GameWorld } from '../../ecs/world';
import { hasPoliceLights, PoliceLights } from '../../police/components';
import { lightbarRgb } from '../../a11y/palette';
import { LIGHTBAR_SEGMENTS, lightbarColors, REDUCED_FLASH, SEGMENT_COLOR } from '../../police/lightbar';
import { FAULT, LIGHT, TRIM, VehicleLook } from '../../vehicles/components';
import type { WheelPose } from '../../vehicles/drivableVehicle';
import { VEHICLE_MODELS, wheelLayout, type VehicleModel } from '../../vehicles/model';
import { interpolateTransform } from '../meshSync';
import { spotlightMount, spotlightPose, type LocalPoint, type SpotlightPose } from '../police/spotlight';
import { disposeObject } from '../renderer';
import { buildCarParts, hiddenBarLens, LENS_KINDS, twoWheelPositions, wheelLocalPositions, type CarPart } from './carParts';
import { damageTransform, type DamageTransform } from './damageVisual';

/** Per-wheel poses from physics (`DrivableVehicle` satisfies it). */
export interface WheelSource {
  readonly wheelCount: number;
  wheelPose(i: number, out: WheelPose): WheelPose;
}

export interface CarRendererOptions {
  /** Instances per model (default 192); further cars of that model are not drawn. Fleet police models (`listOrder` >= 2) hold at most 16. */
  maxPerModel?: number;
  /** Whether car bodies and wheels cast/receive shadows. Default false. */
  shadows?: boolean;
}

/** Lens floats per entry: kind (index into LENS_KINDS), x, y, z, sx, sy, sz, light-bar segment (-1 none). */
const LENS_STRIDE = 8;
const LENS_HEAD_LEFT = LENS_KINDS.indexOf('headLeft');
const LENS_HEAD_RIGHT = LENS_KINDS.indexOf('headRight');
const LENS_TAIL_LEFT = LENS_KINDS.indexOf('tailLeft');
const LENS_TAIL_RIGHT = LENS_KINDS.indexOf('tailRight');

/** Instances of one fleet police model (`listOrder` >= 2). */
const FLEET_CAPACITY = 16;
/** Rotor part instances (helicopter blades, drone discs) across all vehicles. */
const ROTOR_CAPACITY = 64;
/** Rotor spin at full `VehicleLook.rotor` (rad/s), and the longest frame step it integrates (s). */
const ROTOR_RATE = 40;
const MAX_FRAME_DT = 0.1;
/** Rotor floats per entry: x, y, z, sx, sy, sz. */
const ROTOR_STRIDE = 6;

const HAZARD_HZ = 1.5;
/** Unlit light-bar lenses (and the whole bar when off), as in Phase 1. */
const LIGHTBAR_DIM = 0.12;
/** Lit lens colour scratch for `lightbarRgb` (linear RGB at full level; the active colour-vision palette picks the values). */
const scratchLens = new Float32Array(3);
/** Peak headlight spot intensity (candela) at night; a quarter of it by day. */
const SPOT_INTENSITY = 120;
const SPOT_DISTANCE = 70;
/** Spot aim point ahead of the bumper (m). */
const SPOT_AIM = 20;
/** Police spotlight (design §12): intensity 300 x (0.3 + 0.7 night), narrow beam, no shadows. */
export const SPOTLIGHT_LIGHT = {
  intensity: 300,
  dayFactor: 0.3,
  angle: 0.12,
  penumbra: 0.3,
  distance: 160,
  decay: 1.5,
} as const;
/** The spotlight target sits this far along the beam (m). */
const SPOTLIGHT_AIM = 30;
/** Frame-to-frame moves longer than this are teleports or recycled ids, not rolling. */
const MAX_ROLL_STEP = 5;
const TWO_PI = Math.PI * 2;

const CAR_TERMS = [VehicleLook, Transform];
const DAMAGE_GREY = new THREE.Color(0x2a2a2a);
const WHITE = new THREE.Color(0xffffff);

const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchColor = new THREE.Color();
/** Rotations of the car being drawn and of one wheel: 3x3 column-major, columns = local axes in world space. */
const carBasis = new Float64Array(9);
/** `carBasis` rolled about the ground contact when the vehicle leans. */
const leanBasis = new Float64Array(9);
const leanScratch = new Float64Array(9);
const leanShift = new Float64Array(3);
const leanQuat = new THREE.Quaternion();
/** World position of the vehicle-frame origin of the car being drawn (lean moves it). */
const origin = new Float64Array(3);
const wheelRot = new Float64Array(9);
const scratchDamage: DamageTransform = { scaleX: 1, scaleZ: 1, offsetX: 0, offsetZ: 0, tint: 0 };
const scratchWheel: WheelPose = { x: 0, y: 0, z: 0, steer: 0, spin: 0, radius: 0, inContact: false };
const spotPos = new THREE.Vector3();
const spotQuat = new THREE.Quaternion();
const beamPos = new THREE.Vector3();
const beamQuat = new THREE.Quaternion();
const beamDir = new THREE.Vector3();
const scratchBeam: SpotlightPose = { x: 0, y: 0, z: 0, dx: 0, dy: 0, dz: -1 };
/** Light-bar segment colours of the car being drawn. */
const barColors = new Uint8Array(LIGHTBAR_SEGMENTS);

interface ModelSlot {
  readonly model: VehicleModel;
  readonly body: THREE.InstancedMesh;
  readonly glass: THREE.InstancedMesh;
  /** Push bumper (drawn with `TRIM.pushBar`), spotlight housing (`TRIM.spotlight`) and other dark parts; null when the model has none. */
  readonly trimBar: THREE.InstancedMesh | null;
  readonly trimSpot: THREE.InstancedMesh | null;
  readonly trim: THREE.InstancedMesh | null;
  /** Instance capacity of this model's meshes. */
  readonly capacity: number;
  /** 'four' | 'two' | 'none' as 4 / 2 / 0. */
  readonly wheelN: number;
  /** ROTOR_STRIDE floats per rotor part (drawn by the shared rotor mesh). */
  readonly rotors: Float32Array;
  /** The 8 hidden-bar lens entries (LENS_STRIDE floats each); empty without a light bar. */
  readonly hidden: Float32Array;
  /** Spotlight lamp position in the vehicle frame. */
  readonly spotMount: LocalPoint;
  /** LENS_STRIDE floats per lens part. */
  readonly lenses: Float32Array;
  /** Wheel hub centres FL, FR, RL, RR (x, y, z). */
  readonly wheels: Float32Array;
  /** Head lamp centre (right side; the left one is mirrored) for the headlight spots. */
  readonly headX: number;
  readonly headY: number;
  count: number;
  countBar: number;
  countSpot: number;
  countTrim: number;
}

function mergedBoxes(parts: readonly CarPart[]): THREE.BufferGeometry {
  const boxes = parts.map((p) => new THREE.BoxGeometry(p.sx, p.sy, p.sz).translate(p.x, p.y, p.z));
  const merged = mergeGeometries(boxes);
  for (const box of boxes) box.dispose();
  if (!merged) throw new Error('CarRenderer: could not merge car part boxes');
  return merged;
}

function instanced(
  name: string,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  capacity: number,
  colored: boolean,
): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = name;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  if (colored) {
    // Created up front so the shader is compiled with instance colours once.
    mesh.setColorAt(0, WHITE);
    mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
  }
  mesh.count = 0;
  mesh.visible = false;
  return mesh;
}

/** Rotation matrix of `q` (same layout as `Matrix4.compose`). */
function setBasis(q: THREE.Quaternion, out: Float64Array): void {
  const { x, y, z, w } = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  out[0] = 1 - (yy + zz);
  out[1] = xy + wz;
  out[2] = xz - wy;
  out[3] = xy - wz;
  out[4] = 1 - (xx + zz);
  out[5] = yz + wx;
  out[6] = xz + wy;
  out[7] = yz - wx;
  out[8] = 1 - (xx + yy);
}

/** `car` x Ry(steer) x Rx(spin): a wheel steered about the car's up axis and spun about its axle. */
function wheelBasis(car: Float64Array, steer: number, spin: number, out: Float64Array): void {
  const cs = Math.cos(steer);
  const ss = Math.sin(steer);
  const cr = Math.cos(spin);
  const sr = Math.sin(spin);
  // Local columns of Ry(steer) x Rx(spin): (cs, 0, -ss), (ss sr, cr, cs sr), (ss cr, -sr, cs cr).
  for (let r = 0; r < 3; r++) {
    const c0 = car[r] ?? 0;
    const c1 = car[3 + r] ?? 0;
    const c2 = car[6 + r] ?? 0;
    out[r] = c0 * cs - c2 * ss;
    out[3 + r] = c0 * ss * sr + c1 * cr + c2 * cs * sr;
    out[6 + r] = c0 * ss * cr - c1 * sr + c2 * cs * cr;
  }
}

/**
 * Rolls `car` by `-lean` about the vehicle's local +Z axis (so + lean puts the right side down) pivoting at the
 * ground contact, local height `y0`: writes the rolled basis to `out` and the shift of the frame origin to
 * `shift` (world metres). A local point p maps to `pos + shift + out x p`.
 */
function leanFrame(car: Float64Array, lean: number, y0: number, out: Float64Array, shift: Float64Array): void {
  const c = Math.cos(lean);
  const s = -Math.sin(lean);
  for (let r = 0; r < 3; r++) {
    const c0 = car[r] ?? 0;
    const c1 = car[3 + r] ?? 0;
    out[r] = c0 * c + c1 * s;
    out[3 + r] = c1 * c - c0 * s;
    out[6 + r] = car[6 + r] ?? 0;
    shift[r] = c0 * (y0 * s) + c1 * (y0 * (1 - c));
  }
}

/**
 * Writes instance `index` of `array`: rotation `rot` scaled by (sx, sy, sz), placed at the vehicle-frame
 * point (lx, ly, lz) of the current car (`origin` + `place` x l; `place` defaults to `rot`).
 */
function putInstance(
  array: THREE.TypedArray,
  index: number,
  rot: Float64Array,
  lx: number,
  ly: number,
  lz: number,
  sx: number,
  sy: number,
  sz: number,
  place: Float64Array = rot,
): void {
  const o = index * 16;
  array[o] = (rot[0] ?? 0) * sx;
  array[o + 1] = (rot[1] ?? 0) * sx;
  array[o + 2] = (rot[2] ?? 0) * sx;
  array[o + 3] = 0;
  array[o + 4] = (rot[3] ?? 0) * sy;
  array[o + 5] = (rot[4] ?? 0) * sy;
  array[o + 6] = (rot[5] ?? 0) * sy;
  array[o + 7] = 0;
  array[o + 8] = (rot[6] ?? 0) * sz;
  array[o + 9] = (rot[7] ?? 0) * sz;
  array[o + 10] = (rot[8] ?? 0) * sz;
  array[o + 11] = 0;
  array[o + 12] = (origin[0] ?? 0) + (place[0] ?? 0) * lx + (place[3] ?? 0) * ly + (place[6] ?? 0) * lz;
  array[o + 13] = (origin[1] ?? 0) + (place[1] ?? 0) * lx + (place[4] ?? 0) * ly + (place[7] ?? 0) * lz;
  array[o + 14] = (origin[2] ?? 0) + (place[2] ?? 0) * lx + (place[5] ?? 0) * ly + (place[8] ?? 0) * lz;
  array[o + 15] = 1;
}

function frac(v: number): number {
  return v - Math.floor(v);
}

/**
 * The interpolated transform of vehicle `eid` as the renderer draws it: position and rotation of the vehicle
 * frame (origin = body box centre) with the two-wheeler lean applied (a roll about the ground contact), so
 * overlays such as the livery shell follow the body exactly. Allocation-free.
 */
export function vehicleRenderBasis(eid: EntityId, alpha: number, outPos: THREE.Vector3, outQuat: THREE.Quaternion): void {
  interpolateTransform(eid, alpha, outPos, outQuat);
  const lean = VehicleLook.lean[eid] ?? 0;
  if (lean === 0) return;
  const model = VEHICLE_MODELS[VehicleLook.model[eid] ?? 0];
  if (!model) return;
  const { height, groundClearance } = model.body;
  setBasis(outQuat, leanScratch);
  leanFrame(leanScratch, lean, -(height / 2 + groundClearance), leanBasis, leanShift);
  outPos.x += leanShift[0] ?? 0;
  outPos.y += leanShift[1] ?? 0;
  outPos.z += leanShift[2] ?? 0;
  // The rolled frame is the plain one turned by -lean about its own +Z.
  leanQuat.set(0, 0, Math.sin(-lean / 2), Math.cos(-lean / 2));
  outQuat.multiply(leanQuat);
}

/**
 * Instanced renderer for every `VehicleLook` entity: per model one body mesh (body colour with damage
 * tint), one glass mesh and, where the model has them, a push-bar, a spotlight-housing and an other-trim
 * mesh (the first two per instance by `VehicleLook.trim`), plus one shared wheel mesh (four, two or no
 * wheels per vehicle by `wheelLayout`), one shared lens mesh (lamps and light-bar segments, or the hidden
 * bar lenses) and one shared rotor mesh (spinning helicopter blades and drone discs). Two-wheelers lean by
 * `VehicleLook.lean`. Two headlight spots
 * and one police spotlight exist for the whole session so the shader light count never changes.
 */
export class CarRenderer {
  readonly stats = { cars: 0, drawCalls: 0 };
  private readonly world: GameWorld;
  /** Registered once per world generation: `query()` allocates (rest args, filter, hash strings) on every call. */
  private carQuery: Query | null = null;
  private queryGeneration = -1;
  private readonly group = new THREE.Group();
  private readonly slots: ModelSlot[];
  private readonly maxPerModel: number;
  private readonly wheelMesh: THREE.InstancedMesh;
  private readonly lensMesh: THREE.InstancedMesh;
  private readonly rotorMesh: THREE.InstancedMesh;
  private readonly spots: readonly [THREE.SpotLight, THREE.SpotLight];
  private readonly spotlight: THREE.SpotLight;
  private readonly sources = new Map<EntityId, WheelSource>();
  /** Speed-based wheel spin and last drawn position for cars without a WheelSource. */
  private readonly spin = new Float32Array(MAX_ENTITIES);
  private readonly lastX = new Float32Array(MAX_ENTITIES);
  private readonly lastZ = new Float32Array(MAX_ENTITIES);
  /** Rotor angle per entity (presentation only; integrated from `VehicleLook.rotor`). */
  private readonly rotorAngle = new Float32Array(MAX_ENTITIES);
  private lastTime = Number.NaN;
  /** Linear body colour per entity, recomputed only when its look colour or damage tint changes. */
  private readonly colorHex = new Int32Array(MAX_ENTITIES).fill(-1);
  private readonly colorTint = new Float64Array(MAX_ENTITIES);
  private readonly colorLinear = new Float32Array(MAX_ENTITIES * 3);
  private headlightTarget: EntityId = 0;
  private spotlightTarget: EntityId = 0;

  constructor(scene: THREE.Scene, world: GameWorld, options: CarRendererOptions = {}) {
    this.world = world;
    this.maxPerModel = Math.max(1, Math.floor(options.maxPerModel ?? 192));
    this.group.name = 'vehicles';
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.2 });
    const glassMaterial = new THREE.MeshStandardMaterial({ color: 0x1a2230, roughness: 0.15, metalness: 0.3 });
    const trimMaterial = new THREE.MeshStandardMaterial({ color: 0x141414, roughness: 0.85, metalness: 0.05 });

    let maxLenses = 0;
    let totalCars = 0;
    this.slots = VEHICLE_MODELS.map((model) => {
      const parts = buildCarParts(model);
      const painted = parts.filter((p) => p.kind === 'body' || p.kind === 'cabin');
      const glass = parts.filter((p) => p.kind === 'glass');
      const bar = parts.filter((p) => p.kind === 'pushBar');
      const spot = parts.filter((p) => p.kind === 'spotHousing');
      const trim = parts.filter((p) => p.kind === 'trim');
      const rotor = parts.filter((p) => p.kind === 'rotor');
      const lensParts = parts.filter((p) => LENS_KINDS.includes(p.kind));
      maxLenses = Math.max(maxLenses, lensParts.length);
      const lensEntry = (p: CarPart, out: Float32Array, i: number): void => {
        out.set([LENS_KINDS.indexOf(p.kind), p.x, p.y, p.z, p.sx, p.sy, p.sz, p.segment ?? -1], i * LENS_STRIDE);
      };
      const lenses = new Float32Array(lensParts.length * LENS_STRIDE);
      lensParts.forEach((p, i) => lensEntry(p, lenses, i));
      const hidden = new Float32Array(model.lightbar ? LIGHTBAR_SEGMENTS * LENS_STRIDE : 0);
      if (model.lightbar) for (let s = 0; s < LIGHTBAR_SEGMENTS; s++) lensEntry(hiddenBarLens(model, s), hidden, s);
      const rotors = new Float32Array(rotor.length * ROTOR_STRIDE);
      rotor.forEach((p, i) => rotors.set([p.x, p.y, p.z, p.sx, p.sy, p.sz], i * ROTOR_STRIDE));
      const head = lensParts.find((p) => p.kind === 'headRight');
      const layout = wheelLayout(model);
      const wheels = new Float32Array(12);
      if (layout === 'two') twoWheelPositions(model, wheels);
      else if (layout === 'four') wheelLocalPositions(model, wheels);
      const capacity = model.role === 'police' && model.listOrder >= 2 ? Math.min(FLEET_CAPACITY, this.maxPerModel) : this.maxPerModel;
      totalCars += capacity;
      const optional = (name: string, list: CarPart[], material: THREE.Material): THREE.InstancedMesh | null =>
        list.length > 0 ? instanced(`${name}:${model.id}`, mergedBoxes(list), material, capacity, false) : null;
      const slot: ModelSlot = {
        model,
        body: instanced(`car-body:${model.id}`, mergedBoxes(painted), bodyMaterial, capacity, true),
        glass: instanced(`car-glass:${model.id}`, mergedBoxes(glass), glassMaterial, capacity, false),
        trimBar: optional('car-trimbar', bar, trimMaterial),
        trimSpot: optional('car-trimspot', spot, trimMaterial),
        trim: optional('car-trim', trim, trimMaterial),
        capacity,
        wheelN: layout === 'four' ? 4 : layout === 'two' ? 2 : 0,
        rotors,
        hidden,
        spotMount: spotlightMount(model),
        lenses,
        wheels,
        headX: head?.x ?? 0,
        headY: head?.y ?? 0,
        count: 0,
        countBar: 0,
        countSpot: 0,
        countTrim: 0,
      };
      this.group.add(slot.body, slot.glass);
      for (const m of [slot.trimBar, slot.trimSpot, slot.trim]) if (m) this.group.add(m);
      return slot;
    });

    const wheelGeometry = new THREE.CylinderGeometry(1, 1, 1, 12).rotateZ(Math.PI / 2);
    const wheelMaterial = new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.9 });
    this.wheelMesh = instanced('car-wheels', wheelGeometry, wheelMaterial, totalCars * 4, false);
    const lensMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.lensMesh = instanced('car-lenses', new THREE.BoxGeometry(1, 1, 1), lensMaterial, totalCars * maxLenses, true);
    const rotorMaterial = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.7, metalness: 0.1 });
    this.rotorMesh = instanced('car-rotors', new THREE.BoxGeometry(1, 1, 1), rotorMaterial, ROTOR_CAPACITY, false);
    this.group.add(this.wheelMesh, this.lensMesh, this.rotorMesh);

    const spot = (name: string): THREE.SpotLight => {
      const light = new THREE.SpotLight(0xfff2dc, 0, SPOT_DISTANCE, 0.5, 0.45, 2);
      light.name = name;
      light.castShadow = false;
      light.target.name = `${name}-target`;
      this.group.add(light, light.target);
      return light;
    };
    this.spots = [spot('headlight-spot-left'), spot('headlight-spot-right')];
    // The police spotlight: created once (fixed light count, no shader recompiles), intensity 0 when unused.
    const L = SPOTLIGHT_LIGHT;
    this.spotlight = new THREE.SpotLight(0xf4f6ff, 0, L.distance, L.angle, L.penumbra, L.decay);
    this.spotlight.name = 'police-spotlight';
    this.spotlight.castShadow = false;
    this.spotlight.target.name = 'police-spotlight-target';
    this.group.add(this.spotlight, this.spotlight.target);

    this.setShadows(options.shadows ?? false);
    scene.add(this.group);
  }

  /** Draws `eid`'s wheels from `source` (steer, spin, suspension) instead of speed-based spin; null clears. */
  setDrivable(eid: EntityId, source: WheelSource | null): void {
    if (source) this.sources.set(eid, source);
    else this.sources.delete(eid);
  }

  /** The car whose headlights get the two spot lights (0 = none). */
  setHeadlightTarget(eid: EntityId): void {
    this.headlightTarget = eid;
  }

  /** The car whose `PoliceLights` spotlight is drawn (0 = none): the driven or last-driven patrol car. */
  setSpotlightTarget(eid: EntityId): void {
    this.spotlightTarget = eid;
  }

  setShadows(enabled: boolean): void {
    for (const slot of this.slots) {
      slot.body.castShadow = enabled;
      slot.body.receiveShadow = enabled;
      slot.glass.castShadow = enabled;
      for (const m of [slot.trimBar, slot.trimSpot, slot.trim]) {
        if (!m) continue;
        m.castShadow = enabled;
        m.receiveShadow = enabled;
      }
    }
    this.wheelMesh.castShadow = enabled;
    this.rotorMesh.castShadow = enabled;
  }

  /**
   * Draws every `VehicleLook` entity at its transform interpolated by `alpha`. `nightFactor` (0..1)
   * brightens lamps and the headlight spots, `timeSec` drives hazard and light-bar flashing (light-bar
   * patterns from `PoliceLights`), and `reducedFlash` slows and dims the light bar.
   */
  update(alpha: number, nightFactor: number, timeSec: number, reducedFlash: boolean): void {
    const slots = this.slots;
    for (let m = 0; m < slots.length; m++) {
      const slot = slots[m] as ModelSlot;
      slot.count = slot.countBar = slot.countSpot = slot.countTrim = 0;
    }
    let wheelCount = 0;
    let lensCount = 0;
    let rotorCount = 0;
    const frameDt = this.lastTime === this.lastTime ? Math.min(Math.max(timeSec - this.lastTime, 0), MAX_FRAME_DT) : 0;
    this.lastTime = timeSec;
    let cars = 0;
    let target: ModelSlot | null = null;
    let targetFaults = 0;
    let beamSlot: ModelSlot | null = null;
    const night = nightFactor < 0 ? 0 : nightFactor > 1 ? 1 : nightFactor;
    const blink = frac(timeSec * HAZARD_HZ) < 0.5;
    const barLevel = reducedFlash ? REDUCED_FLASH.level : 1;
    const lensColors = this.lensMesh.instanceColor?.array;
    if (!lensColors) return;

    if (!this.carQuery || this.queryGeneration !== this.world.generation) {
      this.carQuery = registerQuery(this.world, CAR_TERMS);
      this.queryGeneration = this.world.generation;
    }
    commitRemovals(this.world);
    const eids = this.carQuery.dense;
    for (let e = 0; e < eids.length; e++) {
      const eid = eids[e] ?? 0;
      const slot = slots[VehicleLook.model[eid] ?? 0];
      if (!slot || slot.count >= slot.capacity) continue;
      const { body, tires } = slot.model;
      interpolateTransform(eid, alpha, scratchPos, scratchQuat);
      const trimBits = VehicleLook.trim[eid] ?? 0;

      // Body and glass: the damage crumple is an axis-aligned scale + shift in the vehicle frame.
      const d = eid * 4;
      const dmg = damageTransform(
        VehicleLook.damage[d] ?? 0,
        VehicleLook.damage[d + 1] ?? 0,
        VehicleLook.damage[d + 2] ?? 0,
        VehicleLook.damage[d + 3] ?? 0,
        scratchDamage,
        body.length,
        body.width,
      );
      setBasis(scratchQuat, carBasis);
      // Two-wheelers lean: everything is rolled about the ground contact (lean 0 = the plain pose).
      origin[0] = scratchPos.x;
      origin[1] = scratchPos.y;
      origin[2] = scratchPos.z;
      let rot = carBasis;
      const lean = VehicleLook.lean[eid] ?? 0;
      if (lean !== 0) {
        leanFrame(carBasis, lean, -(body.height / 2 + body.groundClearance), leanBasis, leanShift);
        origin[0] += leanShift[0] ?? 0;
        origin[1] += leanShift[1] ?? 0;
        origin[2] += leanShift[2] ?? 0;
        rot = leanBasis;
      }
      const k = slot.count++;
      putInstance(slot.body.instanceMatrix.array, k, rot, dmg.offsetX, 0, dmg.offsetZ, dmg.scaleX, 1, dmg.scaleZ);
      putInstance(slot.glass.instanceMatrix.array, k, rot, dmg.offsetX, 0, dmg.offsetZ, dmg.scaleX, 1, dmg.scaleZ);
      if (slot.trimBar && (trimBits & TRIM.pushBar) !== 0) {
        putInstance(slot.trimBar.instanceMatrix.array, slot.countBar++, rot, dmg.offsetX, 0, dmg.offsetZ, dmg.scaleX, 1, dmg.scaleZ);
      }
      if (slot.trimSpot && (trimBits & TRIM.spotlight) !== 0) {
        putInstance(slot.trimSpot.instanceMatrix.array, slot.countSpot++, rot, dmg.offsetX, 0, dmg.offsetZ, dmg.scaleX, 1, dmg.scaleZ);
      }
      if (slot.trim) {
        putInstance(slot.trim.instanceMatrix.array, slot.countTrim++, rot, dmg.offsetX, 0, dmg.offsetZ, dmg.scaleX, 1, dmg.scaleZ);
      }
      this.writeBodyColor(eid, dmg.tint, slot.body, k);

      // Rotors: crossed blades / discs spin about their own vertical axis at the rotor speed.
      const rotors = slot.rotors;
      if (rotors.length > 0) {
        const angle = ((this.rotorAngle[eid] ?? 0) + (VehicleLook.rotor[eid] ?? 0) * ROTOR_RATE * frameDt) % TWO_PI;
        this.rotorAngle[eid] = angle;
        wheelBasis(rot, angle, 0, wheelRot);
        for (let i = 0; i < rotors.length && rotorCount < ROTOR_CAPACITY; i += ROTOR_STRIDE) {
          putInstance(
            this.rotorMesh.instanceMatrix.array,
            rotorCount++,
            wheelRot,
            rotors[i] ?? 0,
            rotors[i + 1] ?? 0,
            rotors[i + 2] ?? 0,
            rotors[i + 3] ?? 1,
            rotors[i + 4] ?? 1,
            rotors[i + 5] ?? 1,
            rot,
          );
        }
      }

      // Wheels: physics poses for drivable cars, otherwise spin from the distance rolled since last frame.
      const source = this.sources.get(eid);
      if (!source) {
        // Forward (-Z) in world space is minus the basis Z column.
        const dx = scratchPos.x - (this.lastX[eid] ?? 0);
        const dz = scratchPos.z - (this.lastZ[eid] ?? 0);
        let roll = -dx * (carBasis[6] ?? 0) - dz * (carBasis[8] ?? 0);
        if (Math.abs(roll) > MAX_ROLL_STEP) roll = 0;
        this.spin[eid] = ((this.spin[eid] ?? 0) - roll / tires.radius) % TWO_PI;
      }
      this.lastX[eid] = scratchPos.x;
      this.lastZ[eid] = scratchPos.z;
      let lastSteer = NaN;
      let lastSpin = NaN;
      const wheelN = slot.wheelN;
      for (let w = 0; w < wheelN; w++) {
        const pose = scratchWheel;
        // Two-wheelers read the front (0) and rear (2) poses of the four-wheel source.
        const si = wheelN === 2 ? w * 2 : w;
        if (source && si < source.wheelCount) {
          source.wheelPose(si, pose);
          if (wheelN === 2) pose.x = 0;
        } else {
          pose.x = slot.wheels[w * 3] ?? 0;
          pose.y = slot.wheels[w * 3 + 1] ?? 0;
          pose.z = slot.wheels[w * 3 + 2] ?? 0;
          pose.steer = 0;
          pose.spin = this.spin[eid] ?? 0;
          pose.radius = tires.radius;
        }
        if (pose.steer !== lastSteer || pose.spin !== lastSpin) {
          wheelBasis(rot, pose.steer, pose.spin, wheelRot);
          lastSteer = pose.steer;
          lastSpin = pose.spin;
        }
        const r = pose.radius;
        const array = this.wheelMesh.instanceMatrix.array;
        putInstance(array, wheelCount++, wheelRot, pose.x, pose.y, pose.z, tires.width, r, r, rot);
      }

      // Lenses follow the crumpled body.
      const lights = VehicleLook.lights[eid] ?? 0;
      const faults = VehicleLook.faults[eid] ?? 0;
      const police = slot.model.lightbar || eid === this.spotlightTarget ? hasPoliceLights(this.world, eid) : false;
      const barOn = slot.model.lightbar && (lights & LIGHT.lightbar) !== 0;
      if (barOn) {
        const pattern = police ? (PoliceLights.pattern[eid] ?? 0) : 0;
        const phase = police ? (PoliceLights.phase[eid] ?? 0) : 0;
        lightbarColors(pattern, timeSec + phase, reducedFlash, barColors);
      }
      const hiddenBar = (trimBits & TRIM.hiddenBar) !== 0;
      const noBar = (trimBits & TRIM.noBar) !== 0;
      for (let i = 0; i < slot.lenses.length; i += LENS_STRIDE) {
        const segment = slot.lenses[i + 7] ?? -1;
        if (segment >= 0 && noBar) continue;
        // A hidden bar swaps the roof lens for the matching grille / rear-window lens.
        let lenses = slot.lenses;
        let o = i;
        if (segment >= 0 && hiddenBar) {
          lenses = slot.hidden;
          o = segment * LENS_STRIDE;
        }
        putInstance(
          this.lensMesh.instanceMatrix.array,
          lensCount,
          rot,
          (lenses[o + 1] ?? 0) * dmg.scaleX + dmg.offsetX,
          lenses[o + 2] ?? 0,
          (lenses[o + 3] ?? 0) * dmg.scaleZ + dmg.offsetZ,
          (lenses[o + 4] ?? 0) * dmg.scaleX,
          lenses[o + 5] ?? 0,
          (lenses[o + 6] ?? 0) * dmg.scaleZ,
        );
        if (segment >= 0) {
          barLensColor(segment, barOn ? (barColors[segment] ?? 0) : SEGMENT_COLOR.off, barLevel, lensColors, lensCount * 3);
        } else {
          lensColor(slot.lenses[i] ?? 0, lights, faults, night, blink, lensColors, lensCount * 3);
        }
        lensCount++;
      }

      if (eid === this.headlightTarget && eid !== 0 && (lights & LIGHT.head) !== 0) {
        target = slot;
        targetFaults = faults;
        spotPos.copy(scratchPos);
        spotQuat.copy(scratchQuat);
      }
      if (eid === this.spotlightTarget && eid !== 0 && police && (trimBits & TRIM.spotlight) !== 0 && (PoliceLights.spot[eid] ?? 0) !== 0) {
        beamSlot = slot;
        beamPos.copy(scratchPos);
        beamQuat.copy(scratchQuat);
      }
      cars++;
    }

    let drawCalls = 0;
    for (let m = 0; m < slots.length; m++) {
      const slot = slots[m] as ModelSlot;
      drawCalls += this.finish(slot.body, slot.count, true) + this.finish(slot.glass, slot.count, false);
      if (slot.trimBar) drawCalls += this.finish(slot.trimBar, slot.countBar, false);
      if (slot.trimSpot) drawCalls += this.finish(slot.trimSpot, slot.countSpot, false);
      if (slot.trim) drawCalls += this.finish(slot.trim, slot.countTrim, false);
    }
    drawCalls += this.finish(this.wheelMesh, wheelCount, false) + this.finish(this.lensMesh, lensCount, true);
    drawCalls += this.finish(this.rotorMesh, rotorCount, false);
    this.stats.cars = cars;
    this.stats.drawCalls = drawCalls;
    this.updateSpots(target, targetFaults, night);
    this.updateSpotlight(beamSlot, night);
  }

  /** Removes everything from the scene and frees geometries, materials and instance buffers. */
  dispose(): void {
    this.group.removeFromParent();
    disposeObject(this.group);
    this.sources.clear();
  }

  /** Writes `eid`'s body colour (look colour blended toward grey by `tint`) to instance `k` of `mesh`. */
  private writeBodyColor(eid: EntityId, tint: number, mesh: THREE.InstancedMesh, k: number): void {
    const hex = VehicleLook.color[eid] ?? 0;
    const c = eid * 3;
    if (this.colorHex[eid] !== hex || this.colorTint[eid] !== tint) {
      scratchColor.setHex(hex).lerp(DAMAGE_GREY, tint);
      this.colorHex[eid] = hex;
      this.colorTint[eid] = tint;
      this.colorLinear[c] = scratchColor.r;
      this.colorLinear[c + 1] = scratchColor.g;
      this.colorLinear[c + 2] = scratchColor.b;
    }
    const out = mesh.instanceColor?.array;
    if (out) rgb(out, k * 3, this.colorLinear[c] ?? 0, this.colorLinear[c + 1] ?? 0, this.colorLinear[c + 2] ?? 0);
  }

  /** Sets the draw count and upload flags; returns the draw calls the mesh will make. */
  private finish(mesh: THREE.InstancedMesh, count: number, colored: boolean): number {
    mesh.count = count;
    mesh.visible = count > 0;
    if (count === 0) return 0;
    // Upload only the instances drawn (three clears the ranges after each upload).
    const matrix = mesh.instanceMatrix;
    matrix.clearUpdateRanges();
    matrix.addUpdateRange(0, count * 16);
    matrix.needsUpdate = true;
    if (colored && mesh.instanceColor) {
      mesh.instanceColor.clearUpdateRanges();
      mesh.instanceColor.addUpdateRange(0, count * 3);
      mesh.instanceColor.needsUpdate = true;
    }
    return 1;
  }

  /** Places the police spotlight on `slot`'s car (pose in `beamPos`/`beamQuat`) or switches it off. */
  private updateSpotlight(slot: ModelSlot | null, night: number): void {
    const light = this.spotlight;
    if (!slot) {
      light.intensity = 0;
      return;
    }
    const eid = this.spotlightTarget;
    const beam = spotlightPose(slot.spotMount, PoliceLights.spotYaw[eid] ?? 0, PoliceLights.spotPitch[eid] ?? 0, scratchBeam);
    light.position.set(beam.x, beam.y, beam.z).applyQuaternion(beamQuat).add(beamPos);
    beamDir.set(beam.dx, beam.dy, beam.dz).applyQuaternion(beamQuat);
    light.target.position.copy(light.position).addScaledVector(beamDir, SPOTLIGHT_AIM);
    light.intensity = SPOTLIGHT_LIGHT.intensity * (SPOTLIGHT_LIGHT.dayFactor + (1 - SPOTLIGHT_LIGHT.dayFactor) * night);
  }

  private updateSpots(slot: ModelSlot | null, faults: number, night: number): void {
    const intensity = SPOT_INTENSITY * (0.25 + 0.75 * night);
    for (let side = 0; side < 2; side++) {
      const light = this.spots[side];
      if (!light) continue;
      const out = side === 0 ? FAULT.headLeftOut : FAULT.headRightOut;
      if (!slot || (faults & out) !== 0) {
        light.intensity = 0;
        continue;
      }
      const { body } = slot.model;
      const x = (side === 0 ? -1 : 1) * slot.headX;
      light.position.set(x, slot.headY, -body.length / 2 - 0.05).applyQuaternion(spotQuat).add(spotPos);
      light.target.position
        .set(x, -(body.height / 2 + body.groundClearance), -body.length / 2 - SPOT_AIM)
        .applyQuaternion(spotQuat)
        .add(spotPos);
      light.intensity = intensity;
    }
  }
}

/** Writes the colour (linear RGB) of lens `kind` at `out[o..o+2]` from the `LIGHT`/`FAULT` bits; faulty lamps stay dark. */
function lensColor(
  kind: number,
  lights: number,
  faults: number,
  night: number,
  blink: boolean,
  out: THREE.TypedArray,
  o: number,
): void {
  const hazard = (lights & LIGHT.hazard) !== 0 && blink;
  const headOn = (lights & LIGHT.head) !== 0;
  if (kind === LENS_HEAD_LEFT || kind === LENS_HEAD_RIGHT) {
    const broken = (faults & (kind === LENS_HEAD_LEFT ? FAULT.headLeftOut : FAULT.headRightOut)) !== 0;
    if (broken) return rgb(out, o, 0.05, 0.05, 0.05);
    if (hazard) return rgb(out, o, 1, 0.45, 0.02);
    if (headOn) {
      const v = 0.75 + 0.25 * night;
      return rgb(out, o, v, v, v * 0.92);
    }
    return rgb(out, o, 0.22, 0.22, 0.22);
  }
  if (kind === LENS_TAIL_LEFT || kind === LENS_TAIL_RIGHT) {
    if ((faults & FAULT.tailOut) !== 0) return rgb(out, o, 0.06, 0.01, 0.01);
    if ((lights & LIGHT.brake) !== 0 && (faults & FAULT.brakeOut) === 0) return rgb(out, o, 1, 0.04, 0.03);
    if (hazard) return rgb(out, o, 1, 0.45, 0.02);
    if ((lights & LIGHT.reverse) !== 0) return rgb(out, o, 0.95, 0.95, 0.95);
    if (headOn) return rgb(out, o, 0.35 + 0.15 * night, 0.02, 0.02);
    return rgb(out, o, 0.12, 0.01, 0.01);
  }
  rgb(out, o, 0.2, 0.2, 0.2);
}

/**
 * Light-bar lens `segment` showing `color` (`SEGMENT_COLOR`) at `level`. Unlit lenses keep the Phase 1
 * dim tint: red on the left half of the bar, blue on the right.
 */
function barLensColor(segment: number, color: number, level: number, out: THREE.TypedArray, o: number): void {
  if (color > SEGMENT_COLOR.off && color <= SEGMENT_COLOR.amber) {
    lightbarRgb(color, scratchLens);
    return rgb(out, o, (scratchLens[0] ?? 0) * level, (scratchLens[1] ?? 0) * level, (scratchLens[2] ?? 0) * level);
  }
  if (segment < LIGHTBAR_SEGMENTS / 2) rgb(out, o, LIGHTBAR_DIM, LIGHTBAR_DIM * 0.05, LIGHTBAR_DIM * 0.05);
  else rgb(out, o, LIGHTBAR_DIM * 0.05, LIGHTBAR_DIM * 0.15, LIGHTBAR_DIM);
}

function rgb(out: THREE.TypedArray, o: number, r: number, g: number, b: number): void {
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
}
