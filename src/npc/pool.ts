import type { BehaviorProfile } from './data';
import { ACTOR_STATE } from './types';

/** `ActorRec.flags` bits. The first six are the persisted contract (design §8.6); the rest are internal. */
export const FLAG = {
  cuffed: 1,
  following: 2,
  hidden: 4,
  armed: 8,
  weaponDrawn: 16,
  approached: 32,
  /** An armed melee attacker closing in on the officer. */
  advance: 64,
  /** Walking backwards towards the officer (walkBackward). */
  backward: 128,
  /** Keeps its back to the officer (turnAround, walkBackward). */
  faceAway: 256,
  /** Walking to the vehicle door to be seated again (returnToVehicle). */
  returning: 512,
} as const;

/** One ambient pedestrian; preallocated, dense in `NpcSystem.peds`. */
export class PedRec {
  person = -1;
  edge = 0;
  /** Arc length on the edge's centreline. */
  s = 0;
  /** +1 walks on the right of the edge direction, -1 on the left. */
  side = 1;
  /** +1 walks from `from` to `to`, -1 the other way. */
  dir = 1;
  /** Walking speed (m/s). */
  base = 1.3;
  /** Remaining seconds of running away from a drawn weapon. */
  flee = 0;
  /** Seconds since the last LOD update. */
  acc = 0;
  x = 0;
  z = 0;
  yaw = 0;
  prevX = 0;
  prevZ = 0;
  prevYaw = 0;
  gait = 0;
  speed = 0;
  height = 1.75;
  build = 1;
  skin = 0;
  hair = 0;
  top = 0;
  bottom = 0;
}

/** One scene actor; preallocated, dense in `NpcSystem.actors`. */
export class ActorRec {
  id = 0;
  person = -1;
  role = '';
  callId = 0;
  profile!: BehaviorProfile;
  state: number = ACTOR_STATE.idle;
  x = 0;
  z = 0;
  yaw = 0;
  prevX = 0;
  prevZ = 0;
  prevYaw = 0;
  speed = 0;
  gait = 0;
  stress = 0;
  timer = 0;
  stamina = 0;
  flags = 0;
  weapon = '';
  vehicleId = -1;
  seat = -1;
  body = 0;
  tx = 0;
  tz = 0;
  /** Waypoints x0, z0, x1, z1, ... (at most 32). */
  readonly route = new Float32Array(64);
  /** Number of floats in `route`. */
  routeLen = 0;
  /** Index of the next waypoint (point number, not float index). */
  routePos = 0;
  lost = 0;
  /** Seconds since the last decision. */
  acc = 0;
  /** Seconds since the actor appeared (loose bystanders are culled by age). */
  age = 0;
  // Derived at spawn and restore (not saved).
  walkSpeed = 1.3;
  runSpeed = 6;
  staminaMax = 25;
  fleeBonus = 0;
  height = 1.75;
  build = 1;
  skin = 0;
  hair = 0;
  top = 0;
  bottom = 0;
}
