/** On-foot <-> driving state and the door/exit geometry used to switch between them. */
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { PlayerModeName } from './events';

export const PLAYER_MODE = { onFoot: 0, driving: 1 } as const;
export type PlayerModeId = (typeof PLAYER_MODE)[keyof typeof PLAYER_MODE];
/** Event/save name of each mode, indexed by id. */
export const PLAYER_MODE_NAMES: readonly PlayerModeName[] = ['onFoot', 'driving'];

/** Max distance (m) from the player to a driver door for `interact` to get in. */
export const ENTER_DISTANCE = 2.2;
/** Max |speed| (m/s) at which the officer may get out. */
export const EXIT_MAX_SPEED = 2;
/** Vehicles moving faster than this (m/s) cannot be entered. */
export const ENTER_MAX_SPEED = 1;
/** Gap between the body side and the door point used for entering. */
const DOOR_OFFSET = 0.4;
/** Gap between the body side and where the officer is placed on exit. */
const EXIT_OFFSET = 1;

export interface EnterCandidate {
  readonly eid: number;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly halfWidth: number;
  readonly halfLength: number;
  /** Signed forward speed (m/s). */
  readonly speed: number;
}

export interface PointXZ {
  x: number;
  z: number;
}

/** World point of the local (lx, lz) offset of a vehicle at (x, z) facing `yaw` (local -Z is the front). */
function localToWorld(c: EnterCandidate, lx: number, lz: number, out: PointXZ): PointXZ {
  const sin = Math.sin(c.yaw);
  const cos = Math.cos(c.yaw);
  out.x = c.x + lx * cos + lz * sin;
  out.z = c.z - lx * sin + lz * cos;
  return out;
}

/** Seat line: a third of the length back from the front. */
const seatZ = (c: EnterCandidate): number => -c.halfLength / 3;

/** Driver door (left side, -X local), a third back from the front and just outside the body. */
export function driverDoorPoint(c: EnterCandidate, out: PointXZ): PointXZ {
  return localToWorld(c, -(c.halfWidth + DOOR_OFFSET), seatZ(c), out);
}

/** Where the officer stands after getting out: `side` -1 = driver (left), 1 = passenger, 1 m clear. */
export function exitPoint(c: EnterCandidate, side: -1 | 1, out: PointXZ): PointXZ {
  return localToWorld(c, side * (c.halfWidth + EXIT_OFFSET), seatZ(c), out);
}

const door: PointXZ = { x: 0, z: 0 };

/** Index of the candidate whose driver door is nearest and within `ENTER_DISTANCE`, or -1. */
export function findEnterable(px: number, pz: number, candidates: readonly EnterCandidate[]): number {
  let best = -1;
  let bestSq = ENTER_DISTANCE * ENTER_DISTANCE;
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (c === undefined || !(Math.abs(c.speed) < ENTER_MAX_SPEED)) continue;
    driverDoorPoint(c, door);
    const dx = door.x - px;
    const dz = door.z - pz;
    const sq = dx * dx + dz * dz;
    if (sq <= bestSq) {
      best = i;
      bestSq = sq;
    }
  }
  return best;
}

/**
 * Tracks whether the officer is on foot or driving (and which vehicle). Emits `player:mode` on every
 * change when given a bus; the integrator moves bodies, meshes and input in response.
 */
export class PlayerModeMachine {
  private modeValue: PlayerModeId = PLAYER_MODE.onFoot;
  private vehicleValue = 0;
  private readonly bus: EventBus<EventMap> | undefined;

  constructor(bus?: EventBus<EventMap>) {
    this.bus = bus;
  }

  get mode(): PlayerModeId {
    return this.modeValue;
  }

  /** Eid of the vehicle being driven, 0 on foot. */
  get vehicle(): number {
    return this.vehicleValue;
  }

  /** Gets into vehicle `eid`; refused unless on foot. */
  enter(eid: number): boolean {
    if (this.modeValue !== PLAYER_MODE.onFoot || eid <= 0) return false;
    this.set(PLAYER_MODE.driving, eid);
    return true;
  }

  /** Gets out; refused unless driving and the vehicle's |speed| <= `EXIT_MAX_SPEED`. */
  exit(speed: number): boolean {
    if (this.modeValue !== PLAYER_MODE.driving || !(Math.abs(speed) <= EXIT_MAX_SPEED)) return false;
    this.set(PLAYER_MODE.onFoot, 0);
    return true;
  }

  /** Forces a state (session start, save load); emits only if it changed. */
  reset(mode: PlayerModeId, vehicle: number): void {
    this.set(mode, mode === PLAYER_MODE.driving ? vehicle : 0);
  }

  private set(mode: PlayerModeId, vehicle: number): void {
    if (mode === this.modeValue && vehicle === this.vehicleValue) return;
    this.modeValue = mode;
    this.vehicleValue = vehicle;
    this.bus?.emit('player:mode', { mode: PLAYER_MODE_NAMES[mode] ?? 'onFoot', vehicle });
  }
}
