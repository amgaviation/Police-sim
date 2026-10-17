/**
 * Pose constants, figure/prop source layouts and the bone-less limb solver (design §12.1).
 * Pure: no THREE import, so the npc module and tests can use it without a renderer.
 */

/** Body poses (`HumanoidSource.pose`). */
export const POSE = { stand: 0, walk: 1, run: 2, handsUp: 3, kneel: 4, prone: 5, cuffed: 6, seated: 7, aim: 8, fight: 9, lying: 10, sit: 11 } as const;
/** Held items (`HumanoidSource.held`), drawn at the right hand. */
export const HELD = { none: 0, knife: 1, handgun: 2, bottle: 3, phone: 4, taser: 5, sidearm: 6 } as const;
/** Figure bodies (`HumanoidSource.body`). */
export const BODY = { human: 0, dog: 1 } as const;
/** Bits of `HumanoidSource.flags`. */
export const FIGURE_FLAG = { highlight: 1, hidden: 2 } as const;
/** Prop kinds (`PropSource.kind`); 0 is "none". */
export const PROP = { cone: 1, flare: 2, tape: 3, marker: 4, bottle: 5, bag: 6, knife: 7, handgun: 8, package: 9, casing: 10, glass: 11, note: 12 } as const;

/** `PROP` by name ('cone' -> 1); a prototype-less record, so unknown names (even 'toString') read `undefined`. */
export const PROP_BY_NAME: Readonly<Record<string, number>> = Object.freeze(Object.assign(Object.create(null) as Record<string, number>, PROP));

/**
 * Read-only view of the figures to draw, structure-of-arrays (the npc view satisfies it). Positions are world
 * metres; `y` is the feet height (0 on the ground); `yaw` follows the project convention (0 = facing -Z).
 * Anchored figures (`anchor` > 0, a vehicle entity id) store a vehicle-local offset in `x/y/z` and a yaw
 * relative to the vehicle instead. `gait` is the walk-cycle phase in cycles, `speed` m/s, `height` m (a dog's
 * `height` is its shoulder height, about 0.6), `build` a width multiplier (1 = average). Colours are 0xRRGGBB;
 * `hair` 0xFFFFFFFF means bald; for dogs `top` is the fur colour.
 */
export interface HumanoidSource {
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly yaw: Float32Array;
  readonly prevX: Float32Array;
  readonly prevY: Float32Array;
  readonly prevZ: Float32Array;
  readonly prevYaw: Float32Array;
  readonly anchor: Int32Array;
  readonly pose: Uint8Array;
  readonly gait: Float32Array;
  readonly speed: Float32Array;
  readonly height: Float32Array;
  readonly build: Float32Array;
  readonly skin: Uint32Array;
  readonly hair: Uint32Array;
  readonly top: Uint32Array;
  readonly bottom: Uint32Array;
  readonly held: Uint8Array;
  readonly body: Uint8Array;
  readonly flags: Uint8Array;
}

/** Read-only view of the scene props to draw. */
export interface PropSource {
  readonly count: number;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly yaw: Float32Array;
  readonly kind: Uint8Array;
}

/**
 * Limb angles in radians. Pitch angles are measured in the facing direction: arms, `bodyPitch`, `torsoPitch`
 * and `headPitch` are positive forward (a positive `bodyPitch` leans face down); the legs use the hip-extension
 * sign (negative `leftLeg` / `rightLeg` swings the thigh forward, so a walking left leg and left arm both go
 * positive together while moving in opposite directions). `leftKnee` / `rightKnee` fold the shin backward
 * (positive). `leftArmOut` / `rightArmOut` roll the arm outward (negative = inward). `drop` lowers the hip pivot
 * from its standing height (0.85 m at 1.75 m) by that many metres at 1.75 m.
 */
export interface LimbPose {
  bodyPitch: number;
  drop: number;
  torsoPitch: number;
  headPitch: number;
  leftLeg: number;
  rightLeg: number;
  leftArm: number;
  rightArm: number;
  leftArmOut: number;
  rightArmOut: number;
  leftKnee: number;
  rightKnee: number;
}

export function createLimbPose(): LimbPose {
  // Fractional starting values give every field a double representation from the start (so later writes
  // update in place instead of reallocating); they are cleared right away.
  const p: LimbPose = {
    bodyPitch: 0.5,
    drop: 0.5,
    torsoPitch: 0.5,
    headPitch: 0.5,
    leftLeg: 0.5,
    rightLeg: 0.5,
    leftArm: 0.5,
    rightArm: 0.5,
    leftArmOut: 0.5,
    rightArmOut: 0.5,
    leftKnee: 0.5,
    rightKnee: 0.5,
  };
  return clearLimbPose(p);
}

function clearLimbPose(out: LimbPose): LimbPose {
  out.bodyPitch = 0;
  out.drop = 0;
  out.torsoPitch = 0;
  out.headPitch = 0;
  out.leftLeg = 0;
  out.rightLeg = 0;
  out.leftArm = 0;
  out.rightArm = 0;
  out.leftArmOut = 0;
  out.rightArmOut = 0;
  out.leftKnee = 0;
  out.rightKnee = 0;
  return out;
}

const TWO_PI = Math.PI * 2;
const HALF_PI = Math.PI / 2;
/** Speed (m/s) below which a walking or running figure stands still instead of swinging its limbs. */
const MOVING_SPEED = 0.05;
/** Hip pivot lowered to 0.12 m (a body lying flat on the ground) from the standing 0.85 m. */
const FLAT_DROP = 0.73;

/** Gait phase (cycles) and speed (m/s) handed to `solve` (doubles passed as arguments would be boxed per call). */
const input = new Float64Array(2);

/**
 * Limb angles for `pose` at walk-cycle phase `gait` (cycles; the fractional part is used) and speed (m/s).
 * Walk: legs +-0.45 and arms +-0.35 swinging with sin(2 pi gait); run: +-0.9 / +-0.8 with a 0.15 forward lean;
 * handsUp: arms straight up, rolled slightly out; kneel: knees on the ground (thighs vertical, shins back);
 * prone / lying: body flat (face down / up) with the hips 0.12 m up; cuffed: arms back and inward (legs walk
 * when moving); seated / sit: thighs forward, knees bent; aim: right arm raised forward (the renderer raises
 * the left one too for two-handed weapons); fight: arms 0.9 forward, alternating. Walk and run with a speed
 * of ~0 stand still. Allocation-free; returns `out`.
 */
export function limbPose(pose: number, gait: number, speed: number, out: LimbPose): LimbPose {
  input[0] = gait;
  input[1] = speed;
  return solve(pose, out);
}

/**
 * `limbPose` reading the gait and speed of figure `i` from `gaits` / `speeds`; `swing` false uses gait 0 (a
 * static pose). The renderer's per-figure call: no number crosses the call as an argument, so it never boxes.
 */
export function limbPoseAt(pose: number, gaits: Float32Array, speeds: Float32Array, i: number, swing: boolean, out: LimbPose): LimbPose {
  input[0] = swing ? (gaits[i] ?? 0) : 0;
  input[1] = speeds[i] ?? 0;
  return solve(pose, out);
}

function solve(pose: number, out: LimbPose): LimbPose {
  clearLimbPose(out);
  const gait = input[0] ?? 0;
  const phase = Math.sin((gait - Math.floor(gait)) * TWO_PI);
  const moving = (input[1] ?? 0) > MOVING_SPEED;
  switch (pose) {
    case POSE.walk:
      if (moving) {
        out.leftLeg = 0.45 * phase;
        out.rightLeg = -0.45 * phase;
        out.leftArm = 0.35 * phase;
        out.rightArm = -0.35 * phase;
      }
      break;
    case POSE.run:
      if (moving) {
        out.leftLeg = 0.9 * phase;
        out.rightLeg = -0.9 * phase;
        out.leftArm = 0.8 * phase;
        out.rightArm = -0.8 * phase;
        out.torsoPitch = 0.15;
      }
      break;
    case POSE.handsUp:
      out.leftArm = Math.PI;
      out.rightArm = Math.PI;
      out.leftArmOut = 0.2;
      out.rightArmOut = 0.2;
      break;
    case POSE.kneel:
      out.drop = 0.38;
      out.leftKnee = HALF_PI;
      out.rightKnee = HALF_PI;
      out.leftArm = 0.2;
      out.rightArm = 0.2;
      break;
    case POSE.prone:
      out.bodyPitch = HALF_PI;
      out.drop = FLAT_DROP;
      out.headPitch = -0.6;
      break;
    case POSE.lying:
      out.bodyPitch = -HALF_PI;
      out.drop = FLAT_DROP;
      break;
    case POSE.cuffed:
      out.leftArm = -0.5;
      out.rightArm = -0.5;
      out.leftArmOut = -0.2;
      out.rightArmOut = -0.2;
      if (moving) {
        out.leftLeg = 0.4 * phase;
        out.rightLeg = -0.4 * phase;
      }
      break;
    case POSE.seated:
      out.drop = 0.45;
      out.leftLeg = -HALF_PI;
      out.rightLeg = -HALF_PI;
      out.leftKnee = HALF_PI;
      out.rightKnee = HALF_PI;
      break;
    case POSE.sit:
      out.drop = 0.5;
      out.leftLeg = -HALF_PI;
      out.rightLeg = -HALF_PI;
      out.leftKnee = HALF_PI;
      out.rightKnee = HALF_PI;
      break;
    case POSE.aim:
      out.rightArm = HALF_PI;
      out.leftArm = 0.1;
      break;
    case POSE.fight:
      out.leftArm = 0.9 * (0.55 + 0.45 * phase);
      out.rightArm = 0.9 * (0.55 - 0.45 * phase);
      out.leftLeg = 0.15;
      out.rightLeg = -0.15;
      out.torsoPitch = 0.1;
      break;
    default:
      break;
  }
  return out;
}

/** Mutable humanoid source with room for `capacity` figures (`count` starts at 0). */
export function createHumanoidSource(capacity: number): HumanoidSource & { count: number } {
  const n = Math.max(0, Math.floor(capacity));
  return {
    count: 0,
    x: new Float32Array(n),
    y: new Float32Array(n),
    z: new Float32Array(n),
    yaw: new Float32Array(n),
    prevX: new Float32Array(n),
    prevY: new Float32Array(n),
    prevZ: new Float32Array(n),
    prevYaw: new Float32Array(n),
    anchor: new Int32Array(n),
    pose: new Uint8Array(n),
    gait: new Float32Array(n),
    speed: new Float32Array(n),
    height: new Float32Array(n).fill(1.75),
    build: new Float32Array(n).fill(1),
    skin: new Uint32Array(n),
    hair: new Uint32Array(n),
    top: new Uint32Array(n),
    bottom: new Uint32Array(n),
    held: new Uint8Array(n),
    body: new Uint8Array(n),
    flags: new Uint8Array(n),
  };
}

/** Mutable prop source with room for `capacity` props (`count` starts at 0). */
export function createPropSource(capacity: number): PropSource & { count: number } {
  const n = Math.max(0, Math.floor(capacity));
  return {
    count: 0,
    x: new Float32Array(n),
    y: new Float32Array(n),
    z: new Float32Array(n),
    yaw: new Float32Array(n),
    kind: new Uint8Array(n),
  };
}
