/**
 * The SWAT team (design §9.5): four operators who stage, stack on a door, breach, clear room by room, hold and
 * withdraw. Outdoors they walk straight; indoors they follow the room graph (`findPath`). Pure helpers
 * (`swatContactOdds`, `clearOrder`, `entryDoor`) are exported for tests; the `SwatTeam` runtime is driven by the
 * `BackupSystem` (commands arrive as requests, its view is part of the backup view).
 */
import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng } from '../core/rng';
import { INTERIOR_FLOOR_Y } from '../interior/constants';
import { findPath, roomAt } from '../interior/nav';
import type { InteriorDoor, InteriorLayout } from '../interior/types';
import type { ActorInfo } from '../npc/types';
import { FIGURE_FLAG, HELD, POSE, type HumanoidSource } from '../render/people/pose';
import type { InteriorQuery } from '../tactical/types';
import { yawToward } from './geometry';
import type { SwatConfig, SwatCommand, SwatPhase, SwatPlan } from './types';

export type { SwatCommand, SwatPhase, SwatPlan } from './types';

/** Radio speaker of every SWAT line. */
export const SWAT_SPEAKER = 'TAC-1';

/** Chances of the contact roll. */
export interface SwatOdds {
  surrender: number;
  hostageInjury: number;
  subjectInjury: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Pure: chance the subject surrenders on contact, and the injury chances. `surrender = clamp(surrenderBase +
 * negotiationTrust * trust + (dynamic ? dynamicSurprise : 0) + (lessLethal ? lessLethal : 0) - (hostage ?
 * hostagePenalty : 0) - (armed ? armedPenalty : 0), 0.05, 0.95)`; the remaining outcome is "subdued".
 */
export function swatContactOdds(plan: SwatPlan, s: { armed: boolean; hostage: boolean; negotiationTrust: number }, cfg: SwatConfig): SwatOdds {
  const c = cfg.contact;
  const dynamic = plan.tempo === 'dynamic';
  const surrender = clamp(
    c.surrenderBase + c.negotiationTrust * s.negotiationTrust + (dynamic ? c.dynamicSurprise : 0) + (plan.lessLethal ? c.lessLethal : 0)
      - (s.hostage ? c.hostagePenalty : 0) - (s.armed ? c.armedPenalty : 0),
    0.05,
    0.95,
  );
  return {
    surrender,
    hostageInjury: s.hostage ? c.hostageInjuryBase + (dynamic ? c.hostageInjuryDynamic : 0) : 0,
    subjectInjury: plan.lessLethal ? c.subjectInjuryLessLethal : 0,
  };
}

/**
 * Pure: rooms to clear in order: BFS over `layout.roomDoors` from `entryRoom` (ties: lower door index). Locked doors are
 * crossed too (the team breaches them), so every room connected to the entry room is listed, the entry room first.
 * Empty when `entryRoom` is not a room of the layout.
 */
export function clearOrder(layout: InteriorLayout, entryRoom: number): number[] {
  const n = layout.rooms.length;
  if (entryRoom < 0 || entryRoom >= n) return [];
  const seen = new Uint8Array(n);
  const order: number[] = [entryRoom];
  seen[entryRoom] = 1;
  for (let head = 0; head < order.length; head++) {
    const room = order[head] as number;
    const ids = layout.roomDoors[room] ?? [];
    for (const di of ids) {
      const d = layout.doors[di];
      if (!d || d.b < 0) continue;
      const next = d.a === room ? d.b : d.a;
      if (seen[next] === 1) continue;
      seen[next] = 1;
      order.push(next);
    }
  }
  return order;
}

/**
 * Pure: the exterior door for the plan. 'front' = the door marked main (else the exterior door nearest to the front
 * point); 'rear' = the exterior door farthest from the front door (the front door itself when it is the only one).
 * -1 when the layout has no exterior door.
 */
export function entryDoor(layout: InteriorLayout, entry: 'front' | 'rear', frontX: number, frontZ: number): number {
  let front: InteriorDoor | null = null;
  let bestD = Infinity;
  for (const d of layout.doors) {
    if (d.b >= 0) continue;
    const dist = d.main ? -1 : Math.hypot(d.x - frontX, d.z - frontZ);
    if (dist < bestD) {
      bestD = dist;
      front = d;
    }
  }
  if (front === null) return -1;
  if (entry === 'front') return front.index;
  let rear = front;
  let far = -1;
  for (const d of layout.doors) {
    if (d.b >= 0 || d.index === front.index) continue;
    const dist = Math.hypot(d.x - front.x, d.z - front.z);
    if (dist > far) {
      far = dist;
      rear = d;
    }
  }
  return rear.index;
}

// --- Runtime ---------------------------------------------------------------------------------------------------

/** Subset of the NPC system the team needs. */
export interface SwatNpcPort {
  actor(id: number, out: ActorInfo): ActorInfo | null;
  forceState(id: number, state: 'handsUp' | 'kneel' | 'prone' | 'hold' | 'leave'): void;
  cuff(id: number): 'ok' | 'resist' | 'notReady';
  incapacitate(id: number, seconds: number, by: 'beanbag' | 'strike'): boolean;
  actorsInBuilding(buildingId: number, out: number[]): number[];
}

export interface SwatDeps {
  readonly bus: EventBus<EventMap>;
  readonly rng: Rng;
  readonly npc: SwatNpcPort;
  readonly interiors: InteriorQuery;
  doorRequest(buildingId: number, door: number, action: 'open' | 'ram' | 'kick'): void;
  building(id: number): { minX: number; minZ: number; maxX: number; maxZ: number; door: { x: number; z: number; yaw: number } } | null;
  negotiationTrust(callId: number): number;
  readonly config: SwatConfig;
}

/** Saved team state. */
export interface SwatSave {
  callId: number;
  phase: SwatPhase;
  plan: SwatPlan;
  building: number;
  door: number;
  rooms: number[];
  roomIdx: number;
  timer: number;
  /** x, z, yaw, building per operator. */
  ops: [number, number, number, number][];
}

const SKIN = [0xc68e6b, 0x8d5a3c, 0xe0b48f, 0x6f4430] as const;
const HAIR = [0x2a1d14, 0x1a1410, 0x5a3a22, 0x3a3a3c] as const;
const FORMATION: readonly (readonly [number, number])[] = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]];
const SPOT_STAGE = 0;
const SPOT_STACK = 1;
const SPOT_ROOM = 2;
const ARRIVE_M = 0.5;
const ROOM_ARRIVE_M = 0.9;
const ROOM_WALK_MAX_S = 40;
const REPATH_S = 0.5;
const STRIDE = 1.4;
const CUFF_RETRY_S = 0.5;
const CUFF_MAX_TRIES = 20;
const SUBJECT_ROLES: readonly string[] = ['subject', 'suspect'];

/** One SWAT team (four AI operators on foot) working one call's building. */
export class SwatTeam {
  phase: SwatPhase = 'staging';
  plan: SwatPlan = { entry: 'front', tempo: 'deliberate', lessLethal: false };
  /** Exterior door being stacked on / breached, -1 while only staging. */
  door = -1;
  rooms: number[] = [];
  roomIdx = 0;
  /** Seconds left in the current room (clearing), -1 while walking to it. */
  timer = -1;
  readonly callId: number;
  readonly building: number;
  readonly count: number;
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly yaw: Float64Array;
  readonly bld: Int32Array;
  private readonly prevX: Float64Array;
  private readonly prevZ: Float64Array;
  private readonly prevYaw: Float64Array;
  private readonly prevBld: Int32Array;
  private readonly gait: Float64Array;
  private readonly speed: Float64Array;
  private readonly deps: SwatDeps;
  private readonly cfg: SwatConfig;
  private stageX = 0;
  private stageZ = 0;
  private stageDx = 0;
  private stageDz = 1;
  // walking
  private readonly paths: Float32Array[] = [];
  private readonly pathCount: Int32Array;
  private readonly pathIdx: Int32Array;
  private readonly repath: Float64Array;
  private readonly pathTx: Float64Array;
  private readonly pathTz: Float64Array;
  private curLayout: InteriorLayout | null = null;
  private breached = new Uint8Array(0);
  private readonly passable = (door: number): boolean => {
    const st = this.deps.interiors.doorState(this.building, door);
    return st !== 'locked' || this.breached[door] === 1;
  };
  // clearing
  private doorHandled = false;
  private doorWaitS = 0;
  private walkS = 0;
  private contactRoom = -1;
  private cuffId = 0;
  private cuffPerson = -1;
  private cuffTries = 0;
  private cuffT = 0;
  private readonly ids: number[] = [];
  private readonly info: ActorInfo = {
    id: 0, personId: -1, role: '', callId: 0, state: 0, x: 0, z: 0, yaw: 0, stress: 0, cuffed: false, following: false, hidden: false,
    armed: false, weaponDrawn: false, vehicleId: -1, seat: -1, profile: '', body: 0,
  };
  private readonly spot = { x: 0, z: 0, yaw: 0 };

  constructor(deps: SwatDeps, callId: number, building: number, truck: { x: number; z: number } | null) {
    this.deps = deps;
    this.cfg = deps.config;
    this.callId = callId;
    this.building = building;
    const n = deps.config.operators;
    this.count = n;
    this.x = new Float64Array(n);
    this.z = new Float64Array(n);
    this.yaw = new Float64Array(n);
    this.bld = new Int32Array(n).fill(-1);
    this.prevX = new Float64Array(n);
    this.prevZ = new Float64Array(n);
    this.prevYaw = new Float64Array(n);
    this.prevBld = new Int32Array(n).fill(-1);
    this.gait = new Float64Array(n);
    this.speed = new Float64Array(n);
    this.pathCount = new Int32Array(n);
    this.pathIdx = new Int32Array(n);
    this.repath = new Float64Array(n);
    this.pathTx = new Float64Array(n).fill(Infinity);
    this.pathTz = new Float64Array(n).fill(Infinity);
    for (let i = 0; i < n; i++) this.paths.push(new Float32Array(64));
    this.computeStaging(truck);
    for (let i = 0; i < n; i++) {
      const o = truck !== null ? { x: truck.x + (i - (n - 1) / 2) * 0.9, z: truck.z + 2.2 } : this.stageSpot(i);
      this.x[i] = o.x;
      this.z[i] = o.z;
      this.yaw[i] = yawToward(o.x, o.z, this.stageX, this.stageZ);
      this.prevX[i] = o.x;
      this.prevZ[i] = o.z;
      this.prevYaw[i] = this.yaw[i] as number;
    }
  }

  /** True while the operators are inside the building. */
  get inside(): boolean {
    return (this.bld[0] as number) >= 0;
  }

  // --- Commands --------------------------------------------------------------------------------------------

  /** Applies `command` (and any plan change); returns the radio reply, which is also emitted as `backup:swat`. */
  command(cmd: SwatCommand, plan?: Partial<SwatPlan>): string {
    const text = this.apply(cmd, plan);
    this.say(text);
    return text;
  }

  private apply(cmd: SwatCommand, plan?: Partial<SwatPlan>): string {
    const layout = this.deps.interiors.layout(this.building);
    const entered = this.inside || this.phase === 'breaching' || this.phase === 'clearing';
    if (plan !== undefined) {
      if (plan.tempo !== undefined) this.plan.tempo = plan.tempo;
      if (plan.lessLethal !== undefined) this.plan.lessLethal = plan.lessLethal;
      if (plan.entry !== undefined && plan.entry !== this.plan.entry && !entered) {
        this.plan.entry = plan.entry;
        if (this.door >= 0 && layout !== null) {
          // Re-stack on the other door.
          this.door = this.pickDoor(layout);
          if (this.phase === 'stacked') this.phase = 'staging';
        }
      }
    }
    switch (cmd) {
      case 'stage':
        if (this.phase === 'breaching') return 'Breach in progress, stand by.';
        if (this.inside) this.leaveBuilding(layout);
        this.door = -1;
        this.phase = 'staging';
        this.clearCuffing();
        return 'Falling back to staging.';
      case 'stack': {
        if (entered) return 'We are already inside.';
        if (layout === null) return "That building can't be entered.";
        const door = this.pickDoor(layout);
        if (door < 0) return 'No way in.';
        if (this.phase === 'stacked' && door === this.door) return 'Already stacked on the door.';
        this.door = door;
        this.phase = 'staging';
        return `Moving to stack on the ${this.plan.entry} door.`;
      }
      case 'breach':
        if (this.phase !== 'stacked') return this.inside ? 'We are already inside.' : 'Not stacked on a door yet.';
        return this.startBreach(layout);
      case 'clear':
        if (this.phase === 'stacked') return this.startBreach(layout);
        if (this.phase === 'holding' && this.inside) {
          this.phase = 'clearing';
          return 'Continuing the clear.';
        }
        if (this.phase === 'clearing' || this.phase === 'breaching') return 'Clearing now.';
        return 'Not stacked on a door yet.';
      case 'hold':
        if (this.phase === 'breaching' || this.phase === 'clearing') {
          this.phase = 'holding';
          return 'Holding position.';
        }
        return 'Holding position.';
      case 'withdraw':
        if (this.phase === 'withdrawn' || (this.phase === 'staging' && this.door < 0)) return 'Already out at staging.';
        if (this.inside) this.leaveBuilding(layout);
        this.door = -1;
        this.phase = 'withdrawn';
        this.clearCuffing();
        return 'Withdrawing to staging.';
    }
  }

  private startBreach(layout: InteriorLayout | null): string {
    if (layout === null || this.door < 0) return "That building can't be entered.";
    const state = this.deps.interiors.doorState(this.building, this.door);
    if (state !== 'open' && state !== 'broken') this.deps.doorRequest(this.building, this.door, state === 'locked' ? 'ram' : 'open');
    if (this.breached.length !== layout.doors.length) this.breached = new Uint8Array(layout.doors.length);
    this.breached[this.door] = 1;
    this.phase = 'breaching';
    this.timer = this.cfg.breachS;
    return 'Breaching.';
  }

  // --- Step ------------------------------------------------------------------------------------------------

  /** Advances the team by `dt` seconds. */
  step(dt: number): void {
    const n = this.count;
    for (let i = 0; i < n; i++) {
      this.prevX[i] = this.x[i] as number;
      this.prevZ[i] = this.z[i] as number;
      this.prevYaw[i] = this.yaw[i] as number;
      this.prevBld[i] = this.bld[i] as number;
      this.speed[i] = 0;
    }
    const layout = this.deps.interiors.layout(this.building);
    this.curLayout = layout;
    switch (this.phase) {
      case 'staging':
        this.stepStaging(dt, layout);
        break;
      case 'stacked':
        // Settle into the exact stack positions.
        if (layout !== null && this.door >= 0) this.walkAll(dt, SPOT_STACK, layout, -1, this.cfg.speed.move, ARRIVE_M);
        break;
      case 'breaching':
        this.timer -= dt;
        if (this.timer <= 0) this.enter(layout);
        break;
      case 'clearing':
        this.stepClearing(dt, layout);
        break;
      case 'done':
      case 'withdrawn':
        this.walkAll(dt, SPOT_STAGE, null, -1, this.cfg.speed.move, ARRIVE_M);
        break;
      default:
        break;
    }
    this.stepCuffing(dt);
    this.curLayout = null;
    for (let i = 0; i < n; i++) {
      const d = dt > 0 ? Math.hypot((this.x[i] as number) - (this.prevX[i] as number), (this.z[i] as number) - (this.prevZ[i] as number)) : 0;
      this.speed[i] = dt > 0 ? d / dt : 0;
      this.gait[i] = ((this.gait[i] as number) + d / STRIDE) % 64;
    }
  }

  private stepStaging(dt: number, layout: InteriorLayout | null): void {
    if (this.door < 0 || layout === null) {
      this.walkAll(dt, SPOT_STAGE, null, -1, this.cfg.speed.move, ARRIVE_M);
      return;
    }
    const arrived = this.walkAll(dt, SPOT_STACK, layout, -1, this.cfg.speed.move, ARRIVE_M);
    if (arrived) {
      this.phase = 'stacked';
      this.say('Team is stacked on the door.');
    }
  }

  private enter(layout: InteriorLayout | null): void {
    if (layout === null || this.door < 0) {
      this.phase = 'staging';
      this.door = -1;
      return;
    }
    const d = layout.doors[this.door] as InteriorDoor;
    this.rooms = clearOrder(layout, d.a);
    this.roomIdx = 0;
    this.timer = -1;
    this.doorHandled = true;
    this.doorWaitS = 0;
    this.walkS = 0;
    this.contactRoom = -1;
    for (let i = 0; i < this.count; i++) {
      this.insideSpotInto(layout, d, i, this.spot);
      this.x[i] = this.spot.x;
      this.z[i] = this.spot.z;
      this.yaw[i] = this.spot.yaw;
      this.bld[i] = this.building;
      this.pathTx[i] = Infinity;
      this.pathCount[i] = 0;
    }
    this.phase = 'clearing';
    this.say('Entry made, clearing.');
  }

  private stepClearing(dt: number, layout: InteriorLayout | null): void {
    if (layout === null || this.roomIdx >= this.rooms.length) {
      this.finish(layout);
      return;
    }
    const room = this.rooms[this.roomIdx] as number;
    if (this.timer >= 0) {
      this.timer -= dt;
      if (this.timer <= 0) {
        this.say(`Room ${this.roomIdx + 1} clear.`);
        this.roomIdx++;
        this.timer = -1;
        this.doorHandled = false;
        this.walkS = 0;
        if (this.roomIdx >= this.rooms.length) this.finish(layout);
      }
      return;
    }
    if (!this.doorHandled) {
      this.doorHandled = true;
      const door = this.doorInto(layout, this.roomIdx);
      if (door >= 0 && this.deps.interiors.doorState(this.building, door) === 'locked' && this.breached[door] !== 1) {
        this.deps.doorRequest(this.building, door, 'ram');
        this.breached[door] = 1;
        this.doorWaitS = this.cfg.breachS;
      }
    }
    if (this.doorWaitS > 0) {
      this.doorWaitS -= dt;
      return;
    }
    this.walkS += dt;
    const speed = this.plan.tempo === 'dynamic' ? this.cfg.speed.move : this.cfg.speed.walk;
    const arrived = this.walkAll(dt, SPOT_ROOM, layout, room, speed, ROOM_ARRIVE_M);
    if (arrived || this.walkS > ROOM_WALK_MAX_S) {
      this.timer = this.cfg.roomS[this.plan.tempo];
      if (this.contactRoom !== room) {
        this.contactRoom = room;
        this.contact(layout, room);
      }
    }
  }

  private finish(layout: InteriorLayout | null): void {
    this.leaveBuilding(layout);
    this.phase = 'done';
    this.timer = -1;
    this.say('Building clear.');
  }

  /** Moves the operators out through the entry door (to the outdoor pose beside it). */
  private leaveBuilding(layout: InteriorLayout | null): void {
    const d = layout !== null && this.door >= 0 ? (layout.doors[this.door]) : undefined;
    const door = this.deps.building(this.building)?.door;
    for (let i = 0; i < this.count; i++) {
      if ((this.bld[i] as number) < 0) continue;
      const ex = d?.exit?.x ?? door?.x ?? this.x[i] ?? 0;
      const ez = d?.exit?.z ?? door?.z ?? this.z[i] ?? 0;
      this.x[i] = ex + (i - (this.count - 1) / 2) * 0.6;
      this.z[i] = ez;
      this.bld[i] = -1;
      this.pathTx[i] = Infinity;
      this.pathCount[i] = 0;
    }
  }

  // --- Contact ---------------------------------------------------------------------------------------------

  private contact(layout: InteriorLayout, room: number): void {
    const { npc, rng } = this.deps;
    npc.actorsInBuilding(this.building, this.ids);
    let subject = 0;
    let armed = false;
    let hostage = false;
    for (let k = 0; k < this.ids.length; k++) {
      const id = this.ids[k] as number;
      const a = npc.actor(id, this.info);
      if (a === null || a.dead === true) continue;
      if (a.role === 'hostage') hostage = true;
      else if (subject === 0 && SUBJECT_ROLES.includes(a.role) && !a.cuffed && roomAt(layout, a.x, a.z) === room) {
        subject = id;
        armed = a.armed;
      }
    }
    if (subject === 0) return;
    const sub = npc.actor(subject, this.info);
    if (sub === null) return;
    const personId = sub.personId;
    const odds = swatContactOdds(this.plan, { armed, hostage, negotiationTrust: this.deps.negotiationTrust(this.callId) }, this.cfg);
    this.say('Contact!');
    if (rng.next() < odds.surrender) {
      npc.forceState(subject, 'handsUp');
      this.say('Suspect is surrendering.');
    } else {
      npc.incapacitate(subject, 8, this.plan.lessLethal ? 'beanbag' : 'strike');
      this.say('Suspect subdued.');
      if (odds.subjectInjury > 0 && rng.next() < odds.subjectInjury) this.say('Suspect injured.');
    }
    if (hostage && odds.hostageInjury > 0 && rng.next() < odds.hostageInjury) this.say('Hostage injured.');
    this.cuffId = subject;
    this.cuffPerson = personId;
    this.cuffTries = 0;
    this.cuffT = 0;
  }

  private stepCuffing(dt: number): void {
    if (this.cuffId === 0) return;
    this.cuffT -= dt;
    if (this.cuffT > 0) return;
    this.cuffT = CUFF_RETRY_S;
    this.cuffTries++;
    const r = this.deps.npc.cuff(this.cuffId);
    if (r === 'ok') {
      this.deps.bus.emit('backup:custody', { callId: this.callId, personId: this.cuffPerson, actorId: this.cuffId, by: SWAT_SPEAKER });
      this.say('Suspect in custody.');
      this.clearCuffing();
    } else if (this.cuffTries >= CUFF_MAX_TRIES) {
      this.clearCuffing();
    }
  }

  private clearCuffing(): void {
    this.cuffId = 0;
    this.cuffPerson = -1;
  }

  // --- Geometry --------------------------------------------------------------------------------------------

  private computeStaging(truck: { x: number; z: number } | null): void {
    const door = this.deps.building(this.building)?.door ?? null;
    const dx0 = door?.x ?? 0;
    const dz0 = door?.z ?? 0;
    let dx = door !== null ? -Math.sin(door.yaw) : 0;
    let dz = door !== null ? -Math.cos(door.yaw) : 1;
    if (truck !== null) {
      const tx = truck.x - dx0;
      const tz = truck.z - dz0;
      const len = Math.sqrt(tx * tx + tz * tz);
      if (len > 1e-3) {
        dx = tx / len;
        dz = tz / len;
      }
    }
    this.stageDx = dx;
    this.stageDz = dz;
    this.stageX = dx0 + dx * this.cfg.stageDistanceM;
    this.stageZ = dz0 + dz * this.cfg.stageDistanceM;
  }

  private stageSpot(i: number): { x: number; z: number } {
    const o = { x: 0, z: 0, yaw: 0 };
    this.stageSpotInto(i, o);
    return o;
  }

  private stageSpotInto(i: number, out: { x: number; z: number; yaw: number }): void {
    const lat = (i - (this.count - 1) / 2) * 0.9;
    out.x = this.stageX - this.stageDz * lat;
    out.z = this.stageZ + this.stageDx * lat;
    out.yaw = yawToward(out.x, out.z, this.stageX - this.stageDx * 10, this.stageZ - this.stageDz * 10);
  }

  private pickDoor(layout: InteriorLayout): number {
    const b = this.deps.building(this.building);
    return b === null ? -1 : entryDoor(layout, this.plan.entry, b.door.x, b.door.z);
  }

  /** Outdoor pose of an exterior door (the layout's exit pose, else the building door). */
  private exitOf(d: InteriorDoor): { x: number; z: number } {
    if (d.exit !== null) return d.exit;
    return this.deps.building(this.building)?.door ?? { x: d.x, z: d.z };
  }

  /** Operator `i` in the stack: in line along the wall beside the door frame, on the staging side, facing the door. */
  private stackSpotInto(layout: InteriorLayout, i: number, out: { x: number; z: number; yaw: number }): void {
    const d = layout.doors[this.door] as InteriorDoor;
    const e = this.exitOf(d);
    const lx = d.axis === 'x' ? 1 : 0;
    const lz = d.axis === 'x' ? 0 : 1;
    const side = (this.stageX - e.x) * lx + (this.stageZ - e.z) * lz < 0 ? -1 : 1;
    const off = d.width / 2 + this.cfg.stackOffsetM * (i + 1);
    out.x = e.x + lx * side * off;
    out.z = e.z + lz * side * off;
    out.yaw = yawToward(out.x, out.z, d.x, d.z);
  }

  /** Operator `i` just inside the entry door, in a line going deeper, facing in. */
  private insideSpotInto(layout: InteriorLayout, d: InteriorDoor, i: number, out: { x: number; z: number; yaw: number }): void {
    const e = this.exitOf(d);
    let nx = d.axis === 'x' ? 0 : 1;
    let nz = d.axis === 'x' ? 1 : 0;
    if ((e.x - d.x) * nx + (e.z - d.z) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const depth = 0.6 + 0.5 * i;
    let x = d.x - nx * depth;
    let z = d.z - nz * depth;
    const r = (layout.rooms[d.a] as InteriorLayout['rooms'][number]).rect;
    x = clamp(x, r.minX + 0.3, r.maxX - 0.3);
    z = clamp(z, r.minZ + 0.3, r.maxZ - 0.3);
    out.x = x;
    out.z = z;
    out.yaw = yawToward(x, z, x - nx * 5, z - nz * 5);
  }

  private formationInto(layout: InteriorLayout, room: number, i: number, out: { x: number; z: number; yaw: number }): void {
    const r = (layout.rooms[room] as InteriorLayout['rooms'][number]).rect;
    const f = FORMATION[i % FORMATION.length] as readonly [number, number];
    const cx = (r.minX + r.maxX) / 2;
    const cz = (r.minZ + r.maxZ) / 2;
    out.x = clamp(cx + f[0], r.minX + 0.3, r.maxX - 0.3);
    out.z = clamp(cz + f[1], r.minZ + 0.3, r.maxZ - 0.3);
    out.yaw = this.yaw[i] as number;
  }

  /** The door through which the BFS reached `rooms[idx]` (a door to an earlier room), -1 for the entry room. */
  private doorInto(layout: InteriorLayout, idx: number): number {
    if (idx <= 0) return -1;
    const room = this.rooms[idx] as number;
    const ids = layout.roomDoors[room] ?? [];
    for (const di of ids) {
      const d = layout.doors[di];
      if (!d || d.b < 0) continue;
      const other = d.a === room ? d.b : d.a;
      for (let k = 0; k < idx; k++) if (this.rooms[k] === other) return di;
    }
    return -1;
  }

  // --- Movement --------------------------------------------------------------------------------------------

  /** Walks every operator to its spot of `mode`; true when all arrived (within `tol`). */
  private walkAll(dt: number, mode: number, layout: InteriorLayout | null, room: number, speed: number, tol: number): boolean {
    let all = true;
    for (let i = 0; i < this.count; i++) {
      if (mode === SPOT_STACK && layout !== null) this.stackSpotInto(layout, i, this.spot);
      else if (mode === SPOT_ROOM && layout !== null) this.formationInto(layout, room, i, this.spot);
      else this.stageSpotInto(i, this.spot);
      const tx = this.spot.x;
      const tz = this.spot.z;
      const yaw = this.spot.yaw;
      const dist = Math.hypot(tx - (this.x[i] as number), tz - (this.z[i] as number));
      if (dist > tol) {
        all = false;
        this.walkOp(i, tx, tz, speed, dt);
      } else if (dist > 0.05) {
        this.walkOp(i, tx, tz, speed, dt);
        this.yaw[i] = yaw;
      } else {
        this.yaw[i] = yaw;
      }
    }
    return all;
  }

  private walkOp(i: number, tx: number, tz: number, speed: number, dt: number): void {
    const layout = this.curLayout;
    if ((this.bld[i] as number) < 0 || layout === null) {
      this.stepToward(i, tx, tz, speed * dt);
      return;
    }
    const x = this.x[i] as number;
    const z = this.z[i] as number;
    this.repath[i] = (this.repath[i] as number) - dt;
    if ((this.repath[i]) <= 0 || Math.abs(tx - (this.pathTx[i] as number)) > 0.3 || Math.abs(tz - (this.pathTz[i] as number)) > 0.3) {
      this.repath[i] = REPATH_S;
      this.pathTx[i] = tx;
      this.pathTz[i] = tz;
      this.pathIdx[i] = 0;
      const buf = this.paths[i] as Float32Array;
      let count = findPath(layout, x, z, tx, tz, this.passable, buf);
      if (count === 0) {
        // No route (a locked door on the way): head straight for the target rather than stall.
        buf[0] = tx;
        buf[1] = tz;
        count = 1;
      }
      this.pathCount[i] = count;
    }
    const buf = this.paths[i] as Float32Array;
    let budget = speed * dt;
    while (budget > 1e-6 && (this.pathIdx[i] as number) < (this.pathCount[i] as number)) {
      const k = this.pathIdx[i] as number;
      const wx = buf[2 * k] as number;
      const wz = buf[2 * k + 1] as number;
      const dist = Math.hypot(wx - (this.x[i] as number), wz - (this.z[i] as number));
      if (dist <= budget) {
        if (dist > 1e-6) this.yaw[i] = yawToward(this.x[i] as number, this.z[i] as number, wx, wz);
        this.x[i] = wx;
        this.z[i] = wz;
        budget -= dist;
        this.pathIdx[i] = k + 1;
      } else {
        this.stepToward(i, wx, wz, budget);
        budget = 0;
      }
    }
  }

  private stepToward(i: number, tx: number, tz: number, move: number): void {
    const x = this.x[i] as number;
    const z = this.z[i] as number;
    const dx = tx - x;
    const dz = tz - z;
    const dist = Math.sqrt(dx * dx + dz * dz);
    if (dist < 1e-6) return;
    this.yaw[i] = Math.atan2(-dx, -dz);
    const m = Math.min(move, dist);
    this.x[i] = x + (dx / dist) * m;
    this.z[i] = z + (dz / dist) * m;
  }

  // --- View, save ------------------------------------------------------------------------------------------

  /** Writes the operators into `v` slots `base .. base + count - 1`. */
  writeView(v: HumanoidSource & { count: number }, base: number): void {
    const aiming = this.phase === 'clearing' || this.phase === 'breaching';
    for (let i = 0; i < this.count; i++) {
      const s = base + i;
      const b = this.bld[i] as number;
      const pb = this.prevBld[i] as number;
      v.x[s] = this.x[i] as number;
      v.z[s] = this.z[i] as number;
      v.y[s] = b >= 0 ? INTERIOR_FLOOR_Y : 0;
      // A level change snaps instead of interpolating.
      v.prevX[s] = pb === b ? (this.prevX[i] as number) : (this.x[i] as number);
      v.prevZ[s] = pb === b ? (this.prevZ[i] as number) : (this.z[i] as number);
      v.prevY[s] = v.y[s];
      v.yaw[s] = this.yaw[i] as number;
      v.prevYaw[s] = pb === b ? (this.prevYaw[i] as number) : (this.yaw[i] as number);
      v.speed[s] = this.speed[i] as number;
      v.gait[s] = this.gait[i] as number;
      const moving = (this.speed[i] as number) > 0.05;
      v.pose[s] = aiming && (b >= 0 || this.phase === 'breaching') ? POSE.aim : moving ? POSE.walk : POSE.stand;
      v.held[s] = HELD.handgun;
      v.skin[s] = SKIN[i % SKIN.length] as number;
      v.hair[s] = HAIR[i % HAIR.length] as number;
      v.top[s] = this.cfg.colors.top;
      v.bottom[s] = this.cfg.colors.bottom;
      v.height[s] = 1.78;
      v.build[s] = 1.05;
      v.anchor[s] = 0;
      v.body[s] = 0;
      v.flags[s] = 0;
    }
  }

  /** Hides the operator slots. */
  static hideView(v: HumanoidSource, base: number, count: number): void {
    for (let i = 0; i < count; i++) v.flags[base + i] = FIGURE_FLAG.hidden;
  }

  serialize(): SwatSave {
    const ops: [number, number, number, number][] = [];
    for (let i = 0; i < this.count; i++) ops.push([this.x[i] as number, this.z[i] as number, this.yaw[i] as number, this.bld[i] as number]);
    return {
      callId: this.callId,
      phase: this.phase,
      plan: { ...this.plan },
      building: this.building,
      door: this.door,
      rooms: this.rooms.slice(),
      roomIdx: this.roomIdx,
      timer: this.timer,
      ops,
    };
  }

  restore(s: SwatSave): void {
    this.phase = s.phase;
    this.plan = { ...s.plan };
    this.door = s.door;
    this.rooms = s.rooms.slice();
    this.roomIdx = s.roomIdx;
    this.timer = s.timer;
    const layout = this.deps.interiors.layout(this.building);
    this.breached = new Uint8Array(layout?.doors.length ?? 0);
    for (let i = 0; i < this.count; i++) {
      const o = s.ops[i];
      if (!o) continue;
      this.x[i] = o[0];
      this.z[i] = o[1];
      this.yaw[i] = o[2];
      this.bld[i] = o[3];
      this.prevX[i] = o[0];
      this.prevZ[i] = o[1];
      this.prevYaw[i] = o[2];
      this.prevBld[i] = o[3];
      this.pathTx[i] = Infinity;
      this.pathCount[i] = 0;
    }
    // Rooms before the current one were cleared through breached doors; the entry door is open.
    if (layout !== null) {
      if (this.door >= 0) this.breached[this.door] = 1;
      for (let k = 1; k <= this.roomIdx && k < this.rooms.length; k++) {
        const di = this.doorInto(layout, k);
        if (di >= 0) this.breached[di] = 1;
      }
    }
    this.doorHandled = this.timer >= 0;
    this.doorWaitS = 0;
    this.walkS = 0;
    this.contactRoom = this.timer >= 0 ? (this.rooms[this.roomIdx] ?? -1) : -1;
    this.clearCuffing();
  }

  private say(text: string): void {
    const { bus } = this.deps;
    bus.emit('backup:swat', { phase: this.phase, text, callId: this.callId });
    bus.emit('backup:radio', { channel: 'tac', speaker: SWAT_SPEAKER, text });
  }
}
