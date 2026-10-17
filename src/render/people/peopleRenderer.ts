import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { interpolateTransform } from '../meshSync';
import { disposeObject } from '../renderer';
import { BODY, createLimbPose, FIGURE_FLAG, HELD, limbPoseAt, POSE, type HumanoidSource } from './pose';

export interface PeopleRendererOptions {
  /** Maximum human figures (and dogs) drawn per frame (default 320); further figures are skipped. */
  capacity?: number;
  /** Whether figures cast shadows. Default false. */
  shadows?: boolean;
}

// Proportions of the 1.75 m reference figure (metres, design §12.2). Parts hang from pivots at their top.
const HIP_HEIGHT = 0.85;
const TORSO_HEIGHT = 0.58;
const SHOULDER_HEIGHT = 0.55;
const SHOULDER_X = 0.265;
const HIP_X = 0.09;
const ARM_LENGTH = 0.6;
const LEG_SEGMENT = 0.425;
const HEAD_GAP = 0.02;
const REFERENCE_HEIGHT = 1.75;
/** Shoulder height of the dog model (m); a dog source's `height` is scaled against it. */
const DOG_HEIGHT = 0.6;
/** Beyond this distance (m) figures are drawn in a static pose. */
const SWING_DISTANCE = 50;
const HIGHLIGHT = 0.25;
const NO_HAIR = 0xffffffff;
const HALF_PI = Math.PI / 2;
const TWO_PI = Math.PI * 2;
const MIN_SCALE = 0.5;
const MAX_SCALE = 1.6;

/** Held item boxes in the hand frame (x, y = along the arm, z) in metres at 1.75 m, and their colours. */
const HELD_BOX = new Float32Array([
  0, 0, 0, // none
  0.025, 0.22, 0.04, // knife
  0.04, 0.17, 0.11, // handgun
  0.07, 0.22, 0.07, // bottle
  0.07, 0.13, 0.015, // phone
  0.05, 0.2, 0.1, // taser
  0.04, 0.17, 0.11, // sidearm
]);
const HELD_COLOR = [0x000000, 0xc4c8cc, 0x222426, 0x3b6e3b, 0x15161a, 0xf2c200, 0x222426] as const;

/** Linear value of each sRGB channel byte (through three's colour management, computed once). */
const LINEAR = (() => {
  const lut = new Float32Array(256);
  const c = new THREE.Color();
  for (let i = 0; i < 256; i++) lut[i] = c.setHex(i * 0x010101).r;
  return lut;
})();

const scratchPos = new THREE.Vector3();
const scratchQuat = new THREE.Quaternion();
const scratchPose = createLimbPose();
/**
 * Registers for the matrix helpers. Numbers are passed through this array instead of as arguments: a double
 * crossing a call that V8 does not inline is boxed (one heap allocation per call), which at 9 matrices per
 * figure adds up to megabytes per second. Translation, then scale, then the angle for `mulR*`.
 */
const reg = new Float64Array(8);
const TX = 0;
const SX = 3;
const ANGLE = 6;
/** Row-major 3x3 rotations: the figure frame, the vehicle frame, body, upper body, head and the limb being placed. */
const baseR = new Float64Array(9);
const vehicleR = new Float64Array(9);
const bodyR = new Float64Array(9);
const upperR = new Float64Array(9);
const headR = new Float64Array(9);
const limbA = new Float64Array(9);
const limbB = new Float64Array(9);
const armR = new Float64Array(9);

/** `out = A x Rx(reg[ANGLE])`. */
function mulRx(out: Float64Array, m: Float64Array): void {
  const a = reg[ANGLE] ?? 0;
  const c = Math.cos(a);
  const s = Math.sin(a);
  for (let r = 0; r < 9; r += 3) {
    const y = m[r + 1] ?? 0;
    const z = m[r + 2] ?? 0;
    out[r] = m[r] ?? 0;
    out[r + 1] = y * c + z * s;
    out[r + 2] = z * c - y * s;
  }
}

/** `out = A x Ry(reg[ANGLE])`. */
function mulRy(out: Float64Array, m: Float64Array): void {
  const a = reg[ANGLE] ?? 0;
  const c = Math.cos(a);
  const s = Math.sin(a);
  for (let r = 0; r < 9; r += 3) {
    const x = m[r] ?? 0;
    const z = m[r + 2] ?? 0;
    out[r] = x * c - z * s;
    out[r + 1] = m[r + 1] ?? 0;
    out[r + 2] = x * s + z * c;
  }
}

/** `out = A x Rz(reg[ANGLE])`. */
function mulRz(out: Float64Array, m: Float64Array): void {
  const a = reg[ANGLE] ?? 0;
  const c = Math.cos(a);
  const s = Math.sin(a);
  for (let r = 0; r < 9; r += 3) {
    const x = m[r] ?? 0;
    const y = m[r + 1] ?? 0;
    out[r] = x * c + y * s;
    out[r + 1] = y * c - x * s;
    out[r + 2] = m[r + 2] ?? 0;
  }
}

/** Row-major rotation matrix of `q`. */
function basisOf(q: THREE.Quaternion, out: Float64Array): void {
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
  out[1] = xy - wz;
  out[2] = xz + wy;
  out[3] = xy + wz;
  out[4] = 1 - (xx + zz);
  out[5] = yz - wx;
  out[6] = xz - wy;
  out[7] = yz + wx;
  out[8] = 1 - (xx + yy);
}

/** Writes instance `index`: rotation `m` scaled along its local axes by reg[SX..SX+2], at reg[TX..TX+2]. */
function putMatrix(array: THREE.TypedArray, index: number, m: Float64Array): void {
  const sx = reg[SX] ?? 1;
  const sy = reg[SX + 1] ?? 1;
  const sz = reg[SX + 2] ?? 1;
  const o = index * 16;
  array[o] = (m[0] ?? 0) * sx;
  array[o + 1] = (m[3] ?? 0) * sx;
  array[o + 2] = (m[6] ?? 0) * sx;
  array[o + 3] = 0;
  array[o + 4] = (m[1] ?? 0) * sy;
  array[o + 5] = (m[4] ?? 0) * sy;
  array[o + 6] = (m[7] ?? 0) * sy;
  array[o + 7] = 0;
  array[o + 8] = (m[2] ?? 0) * sz;
  array[o + 9] = (m[5] ?? 0) * sz;
  array[o + 10] = (m[8] ?? 0) * sz;
  array[o + 11] = 0;
  array[o + 12] = reg[TX] ?? 0;
  array[o + 13] = reg[TX + 1] ?? 0;
  array[o + 14] = reg[TX + 2] ?? 0;
  array[o + 15] = 1;
}

/** Writes the linear form of 0xRRGGBB at `out[o..o+2]`, lightened 25 % toward white when `highlight`. */
function putColor(out: THREE.TypedArray, o: number, hex: number, highlight: boolean): void {
  const lift = highlight ? HIGHLIGHT : 0;
  const r = LINEAR[(hex >> 16) & 255] ?? 0;
  const g = LINEAR[(hex >> 8) & 255] ?? 0;
  const b = LINEAR[hex & 255] ?? 0;
  out[o] = r + (1 - r) * lift;
  out[o + 1] = g + (1 - g) * lift;
  out[o + 2] = b + (1 - b) * lift;
}

function instanced(name: string, geometry: THREE.BufferGeometry, material: THREE.Material, capacity: number): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, capacity);
  mesh.name = name;
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  // Created up front so the shader is compiled with instance colours once.
  mesh.setColorAt(0, new THREE.Color(0xffffff));
  mesh.instanceColor?.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.visible = false;
  return mesh;
}

function box(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BoxGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

function dogGeometry(): THREE.BufferGeometry {
  const parts = [
    box(0.22, 0.26, 0.6, 0, 0.4, 0.02),
    box(0.15, 0.17, 0.22, 0, 0.52, -0.4),
    box(0.09, 0.09, 0.12, 0, 0.48, -0.55),
    box(0.05, 0.05, 0.22, 0, 0.5, 0.4),
    box(0.07, 0.27, 0.07, -0.07, 0.135, -0.2),
    box(0.07, 0.27, 0.07, 0.07, 0.135, -0.2),
    box(0.07, 0.27, 0.07, -0.07, 0.135, 0.2),
    box(0.07, 0.27, 0.07, 0.07, 0.135, 0.2),
  ];
  const merged = mergeGeometries(parts);
  for (const p of parts) p.dispose();
  if (!merged) throw new Error('PeopleRenderer: could not merge the dog parts');
  return merged;
}

/**
 * Instanced procedural humanoids without bones (design §12.2): per human a head, a hair cap, a torso, two
 * arms and four leg segments (thigh and shin, so knees bend), each an instance of a box mesh posed by CPU
 * matrices from `limbPose`; plus one mesh for dogs and one for held items. Seven meshes, so at most seven
 * draw calls. Colours come from the sources (skin, hair, top, bottom). Figures anchored to a vehicle are
 * placed in its interpolated frame. No allocation per frame; headless it only fills the instance buffers.
 */
export class PeopleRenderer {
  readonly stats = { figures: 0, drawCalls: 0 };
  private readonly capacity: number;
  private readonly group = new THREE.Group();
  private readonly head: THREE.InstancedMesh;
  private readonly hair: THREE.InstancedMesh;
  private readonly torso: THREE.InstancedMesh;
  private readonly arms: THREE.InstancedMesh;
  private readonly legs: THREE.InstancedMesh;
  private readonly dogs: THREE.InstancedMesh;
  private readonly held: THREE.InstancedMesh;
  private readonly meshes: readonly THREE.InstancedMesh[];

  constructor(scene: THREE.Scene, options: PeopleRendererOptions = {}) {
    this.capacity = Math.max(1, Math.floor(options.capacity ?? 320));
    const n = this.capacity;
    this.group.name = 'people';
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    // Pivots: head and hair at the neck, torso at the pelvis, arms at the shoulder, leg segments at the hip / knee.
    this.head = instanced('people-head', box(0.22, 0.24, 0.22, 0, HEAD_GAP + 0.12, 0), material, n);
    this.hair = instanced('people-hair', box(0.24, 0.08, 0.24, 0, HEAD_GAP + 0.25, 0), material, n);
    this.torso = instanced('people-torso', box(0.42, TORSO_HEIGHT, 0.24, 0, TORSO_HEIGHT / 2, 0), material, n);
    this.arms = instanced('people-arms', box(0.11, ARM_LENGTH, 0.11, 0, -ARM_LENGTH / 2, 0), material, n * 2);
    this.legs = instanced('people-legs', box(0.15, LEG_SEGMENT, 0.16, 0, -LEG_SEGMENT / 2, 0), material, n * 4);
    this.dogs = instanced('people-dogs', dogGeometry(), material, n);
    this.held = instanced('people-held', new THREE.BoxGeometry(1, 1, 1), material, n);
    this.meshes = [this.head, this.hair, this.torso, this.arms, this.legs, this.dogs, this.held];
    this.group.add(...this.meshes);
    this.setShadows(options.shadows ?? false);
    scene.add(this.group);
  }

  setShadows(enabled: boolean): void {
    for (const mesh of this.meshes) mesh.castShadow = enabled;
  }

  /**
   * Draws every figure of `sources` within `maxDistance` of the camera (`camX`, `camZ`), interpolating
   * position and yaw by `alpha` between the previous and current step. Hidden figures are skipped; beyond
   * 50 m limbs do not swing. Figures past the capacity are not drawn.
   */
  update(alpha: number, sources: readonly HumanoidSource[], camX: number, camZ: number, maxDistance: number): void {
    const t = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    const maxD2 = maxDistance * maxDistance;
    const cap = this.capacity;
    const headA = this.head.instanceMatrix.array;
    const hairA = this.hair.instanceMatrix.array;
    const torsoA = this.torso.instanceMatrix.array;
    const armsA = this.arms.instanceMatrix.array;
    const legsA = this.legs.instanceMatrix.array;
    const dogsA = this.dogs.instanceMatrix.array;
    const heldA = this.held.instanceMatrix.array;
    const headC = this.head.instanceColor?.array;
    const hairC = this.hair.instanceColor?.array;
    const torsoC = this.torso.instanceColor?.array;
    const armsC = this.arms.instanceColor?.array;
    const legsC = this.legs.instanceColor?.array;
    const dogsC = this.dogs.instanceColor?.array;
    const heldC = this.held.instanceColor?.array;
    if (!headC || !hairC || !torsoC || !armsC || !legsC || !dogsC || !heldC) return;
    let people = 0;
    let dogs = 0;
    let helds = 0;
    let lastAnchor = 0;

    for (let si = 0; si < sources.length; si++) {
      const src = sources[si];
      if (!src) continue;
      const n = Math.min(src.count, src.x.length, src.pose.length, src.anchor.length);
      for (let i = 0; i < n; i++) {
        const flags = src.flags[i] ?? 0;
        if ((flags & FIGURE_FLAG.hidden) !== 0) continue;
        const isDog = src.body[i] === BODY.dog;
        if (isDog ? dogs >= cap : people >= cap) continue;

        // Interpolated position and yaw; vehicle-anchored figures use the vehicle-local offset in its frame.
        const px = src.prevX[i] ?? 0;
        const py = src.prevY[i] ?? 0;
        const pz = src.prevZ[i] ?? 0;
        const prevYaw = src.prevYaw[i] ?? 0;
        let dyaw = (src.yaw[i] ?? 0) - prevYaw;
        dyaw -= TWO_PI * Math.round(dyaw / TWO_PI);
        reg[ANGLE] = prevYaw + dyaw * t;
        const lx = px + ((src.x[i] ?? 0) - px) * t;
        const ly = py + ((src.y[i] ?? 0) - py) * t;
        const lz = pz + ((src.z[i] ?? 0) - pz) * t;
        let wx = lx;
        let wy = ly;
        let wz = lz;
        const anchor = src.anchor[i] ?? 0;
        if (anchor > 0) {
          // Occupants of one vehicle are usually adjacent: interpolate its transform once.
          if (anchor !== lastAnchor) {
            interpolateTransform(anchor, t, scratchPos, scratchQuat);
            if (!Number.isFinite(scratchQuat.w) || scratchQuat.lengthSq() < 0.5) scratchQuat.identity();
            basisOf(scratchQuat, vehicleR);
            lastAnchor = anchor;
          }
          wx = scratchPos.x + (vehicleR[0] ?? 0) * lx + (vehicleR[1] ?? 0) * ly + (vehicleR[2] ?? 0) * lz;
          wy = scratchPos.y + (vehicleR[3] ?? 0) * lx + (vehicleR[4] ?? 0) * ly + (vehicleR[5] ?? 0) * lz;
          wz = scratchPos.z + (vehicleR[6] ?? 0) * lx + (vehicleR[7] ?? 0) * ly + (vehicleR[8] ?? 0) * lz;
          mulRy(baseR, vehicleR);
        } else {
          const yaw = reg[ANGLE] ?? 0;
          const c = Math.cos(yaw);
          const sn = Math.sin(yaw);
          baseR[0] = c;
          baseR[1] = 0;
          baseR[2] = sn;
          baseR[3] = 0;
          baseR[4] = 1;
          baseR[5] = 0;
          baseR[6] = -sn;
          baseR[7] = 0;
          baseR[8] = c;
        }
        const dx = wx - camX;
        const dz = wz - camZ;
        const d2 = dx * dx + dz * dz;
        if (d2 > maxD2) continue;

        const pose = src.pose[i] ?? 0;
        const near = d2 <= SWING_DISTANCE * SWING_DISTANCE;
        const highlight = (flags & FIGURE_FLAG.highlight) !== 0;

        if (isDog) {
          const k = dogs++;
          const h = src.height[i] ?? DOG_HEIGHT;
          let s = h > 0 ? h / DOG_HEIGHT : 1;
          s = s < MIN_SCALE ? MIN_SCALE : s > MAX_SCALE ? MAX_SCALE : s;
          reg[SX] = s;
          reg[SX + 1] = s;
          reg[SX + 2] = s;
          if (pose === POSE.lying || pose === POSE.prone) {
            reg[ANGLE] = HALF_PI;
            mulRz(limbA, baseR);
            const ox = 0.3 * s;
            const oy = 0.12 * s;
            reg[TX] = wx + (baseR[0] ?? 0) * ox + (baseR[1] ?? 0) * oy;
            reg[TX + 1] = wy + (baseR[3] ?? 0) * ox + (baseR[4] ?? 0) * oy;
            reg[TX + 2] = wz + (baseR[6] ?? 0) * ox + (baseR[7] ?? 0) * oy;
            putMatrix(dogsA, k, limbA);
          } else {
            const bob = near && (src.speed[i] ?? 0) > 0.05 && pose !== POSE.stand ? 0.02 * s * Math.abs(Math.sin((src.gait[i] ?? 0) * TWO_PI)) : 0;
            reg[TX] = wx;
            reg[TX + 1] = wy + bob;
            reg[TX + 2] = wz;
            putMatrix(dogsA, k, baseR);
          }
          putColor(dogsC, k * 3, src.top[i] ?? 0, highlight);
          continue;
        }

        const k = people++;
        const h = src.height[i] ?? REFERENCE_HEIGHT;
        let s = h > 0 ? h / REFERENCE_HEIGHT : 1;
        s = s < MIN_SCALE ? MIN_SCALE : s > MAX_SCALE ? MAX_SCALE : s;
        const b = src.build[i] ?? 1;
        let w = b > 0 ? b : 1;
        w = s * (w < MIN_SCALE ? MIN_SCALE : w > MAX_SCALE ? MAX_SCALE : w);
        const heldItem = src.held[i] ?? 0;
        const lp = limbPoseAt(pose, src.gait, src.speed, i, near, scratchPose);
        if (pose === POSE.aim && (heldItem === HELD.handgun || heldItem === HELD.sidearm)) lp.leftArm = lp.rightArm;
        reg[SX] = w;
        reg[SX + 1] = s;
        reg[SX + 2] = w;

        // Pelvis, then the body (whole figure), upper body and head rotate about it.
        const hip = (HIP_HEIGHT - lp.drop) * s;
        const pelX = wx + (baseR[1] ?? 0) * hip;
        const pelY = wy + (baseR[4] ?? 0) * hip;
        const pelZ = wz + (baseR[7] ?? 0) * hip;
        reg[ANGLE] = -lp.bodyPitch;
        mulRx(bodyR, baseR);
        reg[ANGLE] = -lp.torsoPitch;
        mulRx(upperR, bodyR);
        reg[ANGLE] = -lp.headPitch;
        mulRx(headR, upperR);

        reg[TX] = pelX;
        reg[TX + 1] = pelY;
        reg[TX + 2] = pelZ;
        putMatrix(torsoA, k, upperR);
        putColor(torsoC, k * 3, src.top[i] ?? 0, highlight);

        const rise = TORSO_HEIGHT * s;
        const neckX = pelX + (upperR[1] ?? 0) * rise;
        const neckY = pelY + (upperR[4] ?? 0) * rise;
        const neckZ = pelZ + (upperR[7] ?? 0) * rise;
        reg[TX] = neckX;
        reg[TX + 1] = neckY;
        reg[TX + 2] = neckZ;
        putMatrix(headA, k, headR);
        putColor(headC, k * 3, src.skin[i] ?? 0, false);
        const bald = (src.hair[i] ?? 0) === NO_HAIR;
        if (bald) {
          reg[SX] = 0;
          reg[SX + 1] = 0;
          reg[SX + 2] = 0;
        }
        putMatrix(hairA, k, headR);
        putColor(hairC, k * 3, bald ? 0 : (src.hair[i] ?? 0), false);
        reg[SX] = w;
        reg[SX + 1] = s;
        reg[SX + 2] = w;

        // Arms: pitch about the shoulder, then rolled outward (right arm +X, left -X).
        const shoulderUp = SHOULDER_HEIGHT * s;
        for (let side = 0; side < 2; side++) {
          const sign = side === 0 ? -1 : 1;
          const out = side === 0 ? lp.leftArmOut : lp.rightArmOut;
          const across = sign * SHOULDER_X * w;
          const shX = pelX + (upperR[0] ?? 0) * across + (upperR[1] ?? 0) * shoulderUp;
          const shY = pelY + (upperR[3] ?? 0) * across + (upperR[4] ?? 0) * shoulderUp;
          const shZ = pelZ + (upperR[6] ?? 0) * across + (upperR[7] ?? 0) * shoulderUp;
          reg[ANGLE] = side === 0 ? lp.leftArm : lp.rightArm;
          mulRx(limbA, upperR);
          reg[ANGLE] = sign * out;
          mulRz(armR, limbA);
          const ai = k * 2 + side;
          reg[TX] = shX;
          reg[TX + 1] = shY;
          reg[TX + 2] = shZ;
          putMatrix(armsA, ai, armR);
          putColor(armsC, ai * 3, src.top[i] ?? 0, false);
          if (side === 1 && heldItem !== HELD.none && heldItem <= HELD.sidearm) {
            // The held item sits in the right hand, its grip at the end of the arm and its length beyond it.
            const o = heldItem * 3;
            const by = HELD_BOX[o + 1] ?? 0;
            const along = (-ARM_LENGTH - by / 2 + 0.06) * s;
            const hk = helds++;
            reg[TX] = shX + (armR[1] ?? 0) * along;
            reg[TX + 1] = shY + (armR[4] ?? 0) * along;
            reg[TX + 2] = shZ + (armR[7] ?? 0) * along;
            reg[SX] = (HELD_BOX[o] ?? 0) * w;
            reg[SX + 1] = by * s;
            reg[SX + 2] = (HELD_BOX[o + 2] ?? 0) * w;
            putMatrix(heldA, hk, armR);
            putColor(heldC, hk * 3, HELD_COLOR[heldItem] ?? 0, false);
            reg[SX] = w;
            reg[SX + 1] = s;
            reg[SX + 2] = w;
          }
        }

        // Legs: thigh from the hip, shin from the knee (hips follow the body pitch only).
        const thigh = -LEG_SEGMENT * s;
        for (let side = 0; side < 2; side++) {
          const apart = (side === 0 ? -1 : 1) * HIP_X * w;
          const hipX = pelX + (bodyR[0] ?? 0) * apart;
          const hipY = pelY + (bodyR[3] ?? 0) * apart;
          const hipZ = pelZ + (bodyR[6] ?? 0) * apart;
          const leg = side === 0 ? lp.leftLeg : lp.rightLeg;
          const knee = side === 0 ? lp.leftKnee : lp.rightKnee;
          reg[ANGLE] = -leg;
          mulRx(limbA, bodyR);
          const li = k * 4 + side * 2;
          reg[TX] = hipX;
          reg[TX + 1] = hipY;
          reg[TX + 2] = hipZ;
          putMatrix(legsA, li, limbA);
          reg[ANGLE] = -leg - knee;
          mulRx(limbB, bodyR);
          reg[TX] = hipX + (limbA[1] ?? 0) * thigh;
          reg[TX + 1] = hipY + (limbA[4] ?? 0) * thigh;
          reg[TX + 2] = hipZ + (limbA[7] ?? 0) * thigh;
          putMatrix(legsA, li + 1, limbB);
          putColor(legsC, li * 3, src.bottom[i] ?? 0, false);
          putColor(legsC, (li + 1) * 3, src.bottom[i] ?? 0, false);
        }
      }
    }

    let drawCalls = this.finish(this.head, people, 1) + this.finish(this.hair, people, 1) + this.finish(this.torso, people, 1);
    drawCalls += this.finish(this.arms, people, 2) + this.finish(this.legs, people, 4);
    drawCalls += this.finish(this.dogs, dogs, 1) + this.finish(this.held, helds, 1);
    this.stats.figures = people + dogs;
    this.stats.drawCalls = drawCalls;
  }

  /** Removes everything from the scene and frees geometries, materials and instance buffers. */
  dispose(): void {
    this.group.removeFromParent();
    disposeObject(this.group);
  }

  /** Sets the draw count (`instances` per figure) and upload ranges; returns the draw calls the mesh makes. */
  private finish(mesh: THREE.InstancedMesh, figures: number, perFigure: number): number {
    const count = figures * perFigure;
    mesh.count = count;
    mesh.visible = count > 0;
    if (count === 0) return 0;
    const matrix = mesh.instanceMatrix;
    matrix.clearUpdateRanges();
    matrix.addUpdateRange(0, count * 16);
    matrix.needsUpdate = true;
    const color = mesh.instanceColor;
    if (color) {
      color.clearUpdateRanges();
      color.addUpdateRange(0, count * 3);
      color.needsUpdate = true;
    }
    return 1;
  }
}
