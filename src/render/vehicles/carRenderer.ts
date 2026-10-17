import { commitRemovals, registerQuery, type EntityId, type Query } from 'bitecs';
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MAX_ENTITIES, Transform } from '../../ecs/components';
import type { GameWorld } from '../../ecs/world';
import { FAULT, LIGHT, VehicleLook } from '../../vehicles/components';
import type { WheelPose } from '../../vehicles/drivableVehicle';
import { VEHICLE_MODELS, type VehicleModel } from '../../vehicles/model';
import { interpolateTransform } from '../meshSync';
import { disposeObject } from '../renderer';
import { buildCarParts, LENS_KINDS, wheelLocalPositions, type CarPart } from './carParts';
import { damageTransform, type DamageTransform } from './damageVisual';

/** Per-wheel poses from physics (`DrivableVehicle` satisfies it). */
export interface WheelSource {
  readonly wheelCount: number;
  wheelPose(i: number, out: WheelPose): WheelPose;
}

export interface CarRendererOptions {
  /** Instances per model (default 192); further cars of that model are not drawn. */
  maxPerModel?: number;
  /** Whether car bodies and wheels cast/receive shadows. Default false. */
  shadows?: boolean;
}

/** Lens floats per entry: kind (index into LENS_KINDS), x, y, z, sx, sy, sz. */
const LENS_STRIDE = 7;
const LENS_HEAD_LEFT = LENS_KINDS.indexOf('headLeft');
const LENS_HEAD_RIGHT = LENS_KINDS.indexOf('headRight');
const LENS_TAIL_LEFT = LENS_KINDS.indexOf('tailLeft');
const LENS_TAIL_RIGHT = LENS_KINDS.indexOf('tailRight');
const LENS_RED = LENS_KINDS.indexOf('lightbarRed');

const HAZARD_HZ = 1.5;
const LIGHTBAR_HZ = 2;
const LIGHTBAR_REDUCED_HZ = 0.5;
const LIGHTBAR_REDUCED_LEVEL = 0.55;
/** Peak headlight spot intensity (candela) at night; a quarter of it by day. */
const SPOT_INTENSITY = 120;
const SPOT_DISTANCE = 70;
/** Spot aim point ahead of the bumper (m). */
const SPOT_AIM = 20;
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
const wheelRot = new Float64Array(9);
const scratchDamage: DamageTransform = { scaleX: 1, scaleZ: 1, offsetX: 0, offsetZ: 0, tint: 0 };
const scratchWheel: WheelPose = { x: 0, y: 0, z: 0, steer: 0, spin: 0, radius: 0, inContact: false };
const spotPos = new THREE.Vector3();
const spotQuat = new THREE.Quaternion();

interface ModelSlot {
  readonly model: VehicleModel;
  readonly body: THREE.InstancedMesh;
  readonly glass: THREE.InstancedMesh;
  /** LENS_STRIDE floats per lens part. */
  readonly lenses: Float32Array;
  /** Wheel hub centres FL, FR, RL, RR (x, y, z). */
  readonly wheels: Float32Array;
  /** Head lamp centre (right side; the left one is mirrored) for the headlight spots. */
  readonly headX: number;
  readonly headY: number;
  count: number;
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
 * Writes instance `index` of `array`: rotation `rot` scaled by (sx, sy, sz), placed at the vehicle-frame
 * point (lx, ly, lz) of the current car (`scratchPos` + `place` x l; `place` defaults to `rot`).
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
  array[o + 12] = scratchPos.x + (place[0] ?? 0) * lx + (place[3] ?? 0) * ly + (place[6] ?? 0) * lz;
  array[o + 13] = scratchPos.y + (place[1] ?? 0) * lx + (place[4] ?? 0) * ly + (place[7] ?? 0) * lz;
  array[o + 14] = scratchPos.z + (place[2] ?? 0) * lx + (place[5] ?? 0) * ly + (place[8] ?? 0) * lz;
  array[o + 15] = 1;
}

function frac(v: number): number {
  return v - Math.floor(v);
}

/**
 * Instanced renderer for every `VehicleLook` entity: per model one body mesh (body colour with damage
 * tint) and one glass mesh, plus one shared wheel mesh and one shared lens mesh (lamps and light bar).
 * Two headlight spots exist for the whole session so the shader light count never changes.
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
  private readonly spots: readonly [THREE.SpotLight, THREE.SpotLight];
  private readonly sources = new Map<EntityId, WheelSource>();
  /** Speed-based wheel spin and last drawn position for cars without a WheelSource. */
  private readonly spin = new Float32Array(MAX_ENTITIES);
  private readonly lastX = new Float32Array(MAX_ENTITIES);
  private readonly lastZ = new Float32Array(MAX_ENTITIES);
  /** Linear body colour per entity, recomputed only when its look colour or damage tint changes. */
  private readonly colorHex = new Int32Array(MAX_ENTITIES).fill(-1);
  private readonly colorTint = new Float64Array(MAX_ENTITIES);
  private readonly colorLinear = new Float32Array(MAX_ENTITIES * 3);
  private headlightTarget: EntityId = 0;

  constructor(scene: THREE.Scene, world: GameWorld, options: CarRendererOptions = {}) {
    this.world = world;
    this.maxPerModel = Math.max(1, Math.floor(options.maxPerModel ?? 192));
    this.group.name = 'vehicles';
    const bodyMaterial = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0.2 });
    const glassMaterial = new THREE.MeshStandardMaterial({ color: 0x1a2230, roughness: 0.15, metalness: 0.3 });

    let maxLenses = 0;
    this.slots = VEHICLE_MODELS.map((model) => {
      const parts = buildCarParts(model);
      const painted = parts.filter((p) => p.kind === 'body' || p.kind === 'cabin');
      const glass = parts.filter((p) => p.kind === 'glass');
      const lensParts = parts.filter((p) => LENS_KINDS.includes(p.kind));
      maxLenses = Math.max(maxLenses, lensParts.length);
      const lenses = new Float32Array(lensParts.length * LENS_STRIDE);
      lensParts.forEach((p, i) => {
        lenses.set([LENS_KINDS.indexOf(p.kind), p.x, p.y, p.z, p.sx, p.sy, p.sz], i * LENS_STRIDE);
      });
      const head = lensParts.find((p) => p.kind === 'headRight');
      const slot: ModelSlot = {
        model,
        body: instanced(`car-body:${model.id}`, mergedBoxes(painted), bodyMaterial, this.maxPerModel, true),
        glass: instanced(`car-glass:${model.id}`, mergedBoxes(glass), glassMaterial, this.maxPerModel, false),
        lenses,
        wheels: wheelLocalPositions(model, new Float32Array(12)),
        headX: head?.x ?? 0,
        headY: head?.y ?? 0,
        count: 0,
      };
      this.group.add(slot.body, slot.glass);
      return slot;
    });

    const totalCars = this.maxPerModel * Math.max(1, this.slots.length);
    const wheelGeometry = new THREE.CylinderGeometry(1, 1, 1, 12).rotateZ(Math.PI / 2);
    const wheelMaterial = new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.9 });
    this.wheelMesh = instanced('car-wheels', wheelGeometry, wheelMaterial, totalCars * 4, false);
    const lensMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.lensMesh = instanced('car-lenses', new THREE.BoxGeometry(1, 1, 1), lensMaterial, totalCars * maxLenses, true);
    this.group.add(this.wheelMesh, this.lensMesh);

    const spot = (name: string): THREE.SpotLight => {
      const light = new THREE.SpotLight(0xfff2dc, 0, SPOT_DISTANCE, 0.5, 0.45, 2);
      light.name = name;
      light.castShadow = false;
      light.target.name = `${name}-target`;
      this.group.add(light, light.target);
      return light;
    };
    this.spots = [spot('headlight-spot-left'), spot('headlight-spot-right')];

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

  setShadows(enabled: boolean): void {
    for (const slot of this.slots) {
      slot.body.castShadow = enabled;
      slot.body.receiveShadow = enabled;
      slot.glass.castShadow = enabled;
    }
    this.wheelMesh.castShadow = enabled;
  }

  /**
   * Draws every `VehicleLook` entity at its transform interpolated by `alpha`. `nightFactor` (0..1)
   * brightens lamps and the headlight spots, `timeSec` drives hazard and light-bar flashing, and
   * `reducedFlash` slows and dims the light bar.
   */
  update(alpha: number, nightFactor: number, timeSec: number, reducedFlash: boolean): void {
    const slots = this.slots;
    for (let m = 0; m < slots.length; m++) (slots[m] as ModelSlot).count = 0;
    let wheelCount = 0;
    let lensCount = 0;
    let cars = 0;
    let target: ModelSlot | null = null;
    let targetFaults = 0;
    const night = nightFactor < 0 ? 0 : nightFactor > 1 ? 1 : nightFactor;
    const blink = frac(timeSec * HAZARD_HZ) < 0.5;
    const redPhase = frac(timeSec * (reducedFlash ? LIGHTBAR_REDUCED_HZ : LIGHTBAR_HZ)) < 0.5;
    const barLevel = reducedFlash ? LIGHTBAR_REDUCED_LEVEL : 1;
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
      if (!slot || slot.count >= this.maxPerModel) continue;
      const { body, tires } = slot.model;
      interpolateTransform(eid, alpha, scratchPos, scratchQuat);

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
      const k = slot.count++;
      putInstance(slot.body.instanceMatrix.array, k, carBasis, dmg.offsetX, 0, dmg.offsetZ, dmg.scaleX, 1, dmg.scaleZ);
      putInstance(slot.glass.instanceMatrix.array, k, carBasis, dmg.offsetX, 0, dmg.offsetZ, dmg.scaleX, 1, dmg.scaleZ);
      this.writeBodyColor(eid, dmg.tint, slot.body, k);

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
      for (let w = 0; w < 4; w++) {
        const pose = scratchWheel;
        if (source && w < source.wheelCount) {
          source.wheelPose(w, pose);
        } else {
          pose.x = slot.wheels[w * 3] ?? 0;
          pose.y = slot.wheels[w * 3 + 1] ?? 0;
          pose.z = slot.wheels[w * 3 + 2] ?? 0;
          pose.steer = 0;
          pose.spin = this.spin[eid] ?? 0;
          pose.radius = tires.radius;
        }
        if (pose.steer !== lastSteer || pose.spin !== lastSpin) {
          wheelBasis(carBasis, pose.steer, pose.spin, wheelRot);
          lastSteer = pose.steer;
          lastSpin = pose.spin;
        }
        const r = pose.radius;
        const array = this.wheelMesh.instanceMatrix.array;
        putInstance(array, wheelCount++, wheelRot, pose.x, pose.y, pose.z, tires.width, r, r, carBasis);
      }

      // Lenses follow the crumpled body.
      const lights = VehicleLook.lights[eid] ?? 0;
      const faults = VehicleLook.faults[eid] ?? 0;
      const lenses = slot.lenses;
      for (let i = 0; i < lenses.length; i += LENS_STRIDE) {
        putInstance(
          this.lensMesh.instanceMatrix.array,
          lensCount,
          carBasis,
          (lenses[i + 1] ?? 0) * dmg.scaleX + dmg.offsetX,
          lenses[i + 2] ?? 0,
          (lenses[i + 3] ?? 0) * dmg.scaleZ + dmg.offsetZ,
          (lenses[i + 4] ?? 0) * dmg.scaleX,
          lenses[i + 5] ?? 0,
          (lenses[i + 6] ?? 0) * dmg.scaleZ,
        );
        lensColor(lenses[i] ?? 0, lights, faults, night, blink, redPhase, barLevel, lensColors, lensCount * 3);
        lensCount++;
      }

      if (eid === this.headlightTarget && eid !== 0 && (lights & LIGHT.head) !== 0) {
        target = slot;
        targetFaults = faults;
        spotPos.copy(scratchPos);
        spotQuat.copy(scratchQuat);
      }
      cars++;
    }

    let drawCalls = 0;
    for (let m = 0; m < slots.length; m++) {
      const slot = slots[m] as ModelSlot;
      drawCalls += this.finish(slot.body, slot.count, true) + this.finish(slot.glass, slot.count, false);
    }
    drawCalls += this.finish(this.wheelMesh, wheelCount, false) + this.finish(this.lensMesh, lensCount, true);
    this.stats.cars = cars;
    this.stats.drawCalls = drawCalls;
    this.updateSpots(target, targetFaults, night);
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
  redPhase: boolean,
  barLevel: number,
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
  // Light bar halves: red on in the first half of each period, blue in the second.
  const red = kind === LENS_RED;
  const lit = (lights & LIGHT.lightbar) !== 0 && red === redPhase;
  const v = lit ? barLevel : 0.12;
  if (red) rgb(out, o, v, v * 0.05, v * 0.05);
  else rgb(out, o, v * 0.05, v * 0.15, v);
}

function rgb(out: THREE.TypedArray, o: number, r: number, g: number, b: number): void {
  out[o] = r;
  out[o + 1] = g;
  out[o + 2] = b;
}
