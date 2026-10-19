/**
 * AI partner placeholder (design §7.4): one uniformed figure that follows the officer, stacks beside a door and
 * clears the room behind it. Indoors it walks the room graph through `findPath`; it passes closed doors (like NPCs)
 * but not locked ones. Replies are returned by `command` or said through the hooks.
 */
import { INTERIOR_FLOOR_Y } from '../interior/constants';
import { findPath, roomAt } from '../interior/nav';
import type { InteriorDoor, InteriorLayout } from '../interior/types';
import { createHumanoidSource, FIGURE_FLAG, HELD, POSE, type HumanoidSource } from '../render/people/pose';
import type { TacticsConfig } from './data';
import type { InteriorQuery, OfficerPose } from './types';

export type PartnerMode = 'follow' | 'stack' | 'hold' | 'clear' | 'away';
export type PartnerCommand = 'follow' | 'stack' | 'hold' | 'clear' | 'dismiss' | 'summon';

/** Saved partner state (the walking route is not saved; it is recomputed). */
export interface PartnerSave {
  mode: PartnerMode;
  building: number;
  x: number;
  z: number;
  yaw: number;
  /** Door index being stacked on or cleared through, -1 none. */
  door: number;
  /** Room being cleared, -1 none. */
  room: number;
  /** Seconds left of the post-clear aim (clear mode); -1 while still walking. */
  timer: number;
}

/** What the partner needs from the world beyond the interior query. */
export interface PartnerHooks {
  /** A spoken report ("Room clear."). */
  say(text: string): void;
  /** True when an awake actor is in `room` of `building` ("Contact!"). */
  occupied(building: number, room: number): boolean;
}

export const PARTNER_MODES: readonly PartnerMode[] = ['follow', 'stack', 'hold', 'clear', 'away'];

/** Distance (m) from the officer within which `stack` looks for a door. */
const STACK_SEARCH = 4;
/** Distance (m) in front of the door (on the officer's side) where the partner stacks. */
const STACK_STANDOFF = 0.6;
/** Seconds the partner aims into the cleared room before reporting. */
const CLEAR_AIM_S = 2;
const REPATH_S = 0.5;
const ARRIVE = 0.12;
/** Fraction of `followM` behind the officer where a following partner heads. */
const FOLLOW_TARGET = 0.9;
const STRIDE = 1.4;
const MODE_SET = new Set<string>(PARTNER_MODES);

export function isPartnerMode(x: unknown): x is PartnerMode {
  return typeof x === 'string' && MODE_SET.has(x);
}

export class PartnerOfficer {
  /** One figure (`count` 0 while away). */
  readonly view: HumanoidSource & { count: number };
  private modeValue: PartnerMode = 'away';
  private buildingValue = -1;
  private xValue = 0;
  private zValue = 0;
  private yawValue = 0;
  private doorIndex = -1;
  private roomIndex = -1;
  private timerValue = -1;

  private readonly cfg: TacticsConfig;
  private readonly hooks: PartnerHooks | null;
  private readonly path = new Float32Array(64);
  private pathCount = 0;
  private pathIdx = 0;
  private repath = 0;
  private pathTx = Infinity;
  private pathTz = Infinity;
  private wasOnFoot = true;
  private curQ: InteriorQuery | null = null;
  private curBuilding = -1;
  private readonly passable = (door: number): boolean => this.curQ !== null && this.curQ.doorState(this.curBuilding, door) !== 'locked';
  private readonly spot = { x: 0, z: 0, yaw: 0 };

  constructor(cfg: TacticsConfig, hooks: PartnerHooks | null = null) {
    this.cfg = cfg;
    this.hooks = hooks;
    const v = createHumanoidSource(1);
    v.skin[0] = 0xc68e6b;
    v.hair[0] = 0x2a1d14;
    v.top[0] = cfg.partner.colors.top;
    v.bottom[0] = cfg.partner.colors.bottom;
    v.height[0] = 1.76;
    v.count = 0;
    this.view = v;
    this.writeView(0, 0, false);
  }

  get mode(): PartnerMode {
    return this.modeValue;
  }
  get building(): number {
    return this.buildingValue;
  }
  get x(): number {
    return this.xValue;
  }
  get z(): number {
    return this.zValue;
  }
  get yaw(): number {
    return this.yawValue;
  }
  get door(): number {
    return this.doorIndex;
  }
  get room(): number {
    return this.roomIndex;
  }
  get timer(): number {
    return this.timerValue;
  }

  /** Applies a command; returns the reply text, or null when it is ignored (the partner is away). */
  command(c: PartnerCommand, officer: OfficerPose, q: InteriorQuery): string | null {
    if (c === 'summon') return this.summon(officer, q);
    if (this.modeValue === 'away' && c !== 'follow') return null;
    switch (c) {
      case 'follow':
        if (this.modeValue === 'away') return this.summon(officer, q);
        this.setMode('follow');
        return 'Right behind you.';
      case 'hold':
        this.setMode('hold');
        return 'Holding here.';
      case 'dismiss':
        this.setMode('away');
        this.view.count = 0;
        return 'Copy, heading back.';
      case 'stack': {
        const layout = officer.building >= 0 ? q.layout(officer.building) : null;
        const door = layout === null ? -1 : this.nearestDoor(layout, officer);
        if (layout === null || door < 0) return 'No door close enough.';
        this.doorIndex = door;
        this.roomIndex = -1;
        this.timerValue = -1;
        this.modeValue = 'stack';
        this.pathTx = Infinity;
        return 'Stacked up on the door.';
      }
      case 'clear': {
        const layout = officer.building >= 0 ? q.layout(officer.building) : null;
        if (layout === null) return 'Nothing to clear here.';
        const door = this.modeValue === 'stack' && this.doorIndex >= 0 ? this.doorIndex : this.nearestDoor(layout, officer);
        if (door < 0) return 'No door to clear through.';
        const d = layout.doors[door] as InteriorDoor;
        if (q.doorState(officer.building, door) === 'locked') return "That door's locked.";
        const here = roomAt(layout, officer.x, officer.z);
        const room = d.a === here ? d.b : d.a;
        if (room < 0) return 'That leads outside.';
        this.doorIndex = door;
        this.roomIndex = room;
        this.timerValue = -1;
        this.modeValue = 'clear';
        this.pathTx = Infinity;
        return 'Going in.';
      }
    }
  }

  /** Advances the partner by `dt` seconds. */
  step(dt: number, officer: OfficerPose, q: InteriorQuery): void {
    if (this.modeValue === 'away') {
      this.view.count = 0;
      return;
    }
    const v = this.view;
    v.count = 1;
    if (!officer.onFoot) {
      // In the car with the officer: hidden until they get out.
      this.wasOnFoot = false;
      v.flags[0] = FIGURE_FLAG.hidden;
      return;
    }
    if (!this.wasOnFoot) {
      this.wasOnFoot = true;
      this.placeBeside(officer.building, officer.x, officer.z, officer.yaw, q);
      v.flags[0] = 0;
      this.writeView(this.xValue, this.zValue, false);
      return;
    }
    v.flags[0] = 0;
    if (this.buildingValue !== officer.building && (this.modeValue === 'follow' || this.modeValue === 'stack' || this.modeValue === 'clear')) {
      if (this.modeValue !== 'follow') this.setMode('follow');
      this.placeBeside(officer.building, officer.x, officer.z, officer.yaw, q);
      this.writeView(this.xValue, this.zValue, false);
      return;
    }
    const layout = this.buildingValue >= 0 ? q.layout(this.buildingValue) : null;
    const ox = this.xValue;
    const oz = this.zValue;
    let moved = 0;
    let aiming = false;
    switch (this.modeValue) {
      case 'follow':
        moved = this.stepFollow(dt, officer, q, layout);
        break;
      case 'stack':
        moved = this.stepStack(dt, officer, q, layout);
        break;
      case 'clear':
        moved = this.stepClear(dt, q, layout);
        aiming = this.timerValue >= 0;
        break;
      default:
        break;
    }
    const speed = dt > 0 ? moved / dt : 0;
    this.writeView(ox, oz, aiming, speed, dt);
  }

  /** Puts a following partner beside (x, z); other modes keep their place. */
  teleport(building: number, x: number, z: number, yaw: number, q: InteriorQuery): void {
    if (this.modeValue !== 'follow') return;
    this.placeBeside(building, x, z, yaw, q);
    this.writeView(this.xValue, this.zValue, false);
  }

  serialize(): PartnerSave {
    return { mode: this.modeValue, building: this.buildingValue, x: this.xValue, z: this.zValue, yaw: this.yawValue, door: this.doorIndex, room: this.roomIndex, timer: this.timerValue };
  }

  restore(s: PartnerSave): void {
    this.modeValue = s.mode;
    this.buildingValue = s.building;
    this.xValue = s.x;
    this.zValue = s.z;
    this.yawValue = s.yaw;
    this.doorIndex = s.door;
    this.roomIndex = s.room;
    this.timerValue = s.timer;
    this.pathCount = 0;
    this.pathIdx = 0;
    this.repath = 0;
    this.pathTx = Infinity;
    this.wasOnFoot = true;
    this.writeView(s.x, s.z, false);
    this.view.count = s.mode === 'away' ? 0 : 1;
  }

  // --- modes -----------------------------------------------------------------------------------------------

  private setMode(mode: PartnerMode): void {
    this.modeValue = mode;
    this.doorIndex = -1;
    this.roomIndex = -1;
    this.timerValue = -1;
    this.pathTx = Infinity;
  }

  private summon(officer: OfficerPose, q: InteriorQuery): string {
    this.setMode('follow');
    this.wasOnFoot = true;
    this.placeBeside(officer.building, officer.x, officer.z, officer.yaw, q);
    this.view.count = 1;
    this.writeView(this.xValue, this.zValue, false);
    return 'On my way.';
  }

  private stepFollow(dt: number, officer: OfficerPose, q: InteriorQuery, layout: InteriorLayout | null): number {
    const dx = officer.x - this.xValue;
    const dz = officer.z - this.zValue;
    const followM = this.cfg.partner.followM;
    const here = layout === null ? 0 : roomAt(layout, this.xValue, this.zValue);
    const there = layout === null ? 0 : roomAt(layout, officer.x, officer.z);
    if (Math.hypot(dx, dz) <= followM && here === there) {
      this.faceTowards(dx, dz);
      return 0;
    }
    // A point a little inside `followM` behind the officer (walking stops within ARRIVE of it), when it is in the same room.
    const behind = followM * FOLLOW_TARGET;
    let tx = officer.x + Math.sin(officer.yaw) * behind;
    let tz = officer.z + Math.cos(officer.yaw) * behind;
    if (layout !== null && roomAt(layout, tx, tz) !== there) {
      tx = officer.x;
      tz = officer.z;
    }
    return this.walkTo(dt, tx, tz, q, layout);
  }

  private stepStack(dt: number, officer: OfficerPose, q: InteriorQuery, layout: InteriorLayout | null): number {
    if (layout === null || this.doorIndex < 0) {
      this.setMode('follow');
      return 0;
    }
    const d = layout.doors[this.doorIndex] as InteriorDoor;
    this.stackSpot(layout, d, officer.x, officer.z, this.spot);
    const moved = this.walkTo(dt, this.spot.x, this.spot.z, q, layout);
    if (moved === 0) this.faceTowards(d.x - this.xValue, d.z - this.zValue);
    return moved;
  }

  private stepClear(dt: number, q: InteriorQuery, layout: InteriorLayout | null): number {
    if (layout === null || this.roomIndex < 0) {
      this.setMode('hold');
      return 0;
    }
    if (this.timerValue >= 0) {
      this.timerValue -= dt;
      if (this.timerValue <= 0) {
        const room = this.roomIndex;
        const contact = this.hooks !== null && this.hooks.occupied(this.buildingValue, room);
        this.setMode('hold');
        this.hooks?.say(contact ? 'Contact!' : 'Room clear.');
      }
      return 0;
    }
    const r = (layout.rooms[this.roomIndex] as InteriorLayout['rooms'][number]).rect;
    const cx = (r.minX + r.maxX) / 2;
    const cz = (r.minZ + r.maxZ) / 2;
    if (Math.hypot(cx - this.xValue, cz - this.zValue) <= ARRIVE) {
      this.timerValue = CLEAR_AIM_S;
      this.yawValue = this.doorFacing(layout, this.doorIndex, cx, cz);
      return 0;
    }
    const moved = this.walkTo(dt, cx, cz, q, layout);
    if (this.pathCount === 0) {
      // No route (a locked door on the way).
      this.setMode('hold');
      this.hooks?.say("Can't get in.");
      return 0;
    }
    return moved;
  }

  // --- movement --------------------------------------------------------------------------------------------

  /** Walks towards (tx, tz) for `dt` seconds along the room-graph route; returns the distance moved. */
  private walkTo(dt: number, tx: number, tz: number, q: InteriorQuery, layout: InteriorLayout | null): number {
    if (Math.hypot(tx - this.xValue, tz - this.zValue) <= ARRIVE) {
      this.pathCount = 0;
      this.pathTx = tx;
      this.pathTz = tz;
      return 0;
    }
    this.repath -= dt;
    if (this.repath <= 0 || Math.abs(tx - this.pathTx) > 0.3 || Math.abs(tz - this.pathTz) > 0.3) {
      this.repath = REPATH_S;
      this.pathTx = tx;
      this.pathTz = tz;
      this.pathIdx = 0;
      if (layout === null) {
        this.path[0] = tx;
        this.path[1] = tz;
        this.pathCount = 1;
      } else {
        this.curQ = q;
        this.curBuilding = this.buildingValue;
        this.pathCount = findPath(layout, this.xValue, this.zValue, tx, tz, this.passable, this.path);
        this.curQ = null;
      }
    }
    let budget = this.cfg.partner.speed * dt;
    let moved = 0;
    while (budget > 1e-6 && this.pathIdx < this.pathCount) {
      const wx = this.path[2 * this.pathIdx] as number;
      const wz = this.path[2 * this.pathIdx + 1] as number;
      const dx = wx - this.xValue;
      const dz = wz - this.zValue;
      const dist = Math.hypot(dx, dz);
      if (dist <= budget) {
        this.xValue = wx;
        this.zValue = wz;
        budget -= dist;
        moved += dist;
        this.pathIdx++;
        if (dist > 1e-6) this.faceTowards(dx, dz);
      } else {
        this.xValue += (dx / dist) * budget;
        this.zValue += (dz / dist) * budget;
        moved += budget;
        this.faceTowards(dx, dz);
        budget = 0;
      }
    }
    return moved;
  }

  private faceTowards(dx: number, dz: number): void {
    if (dx * dx + dz * dz > 1e-8) this.yawValue = Math.atan2(-dx, -dz);
  }

  // --- placement -------------------------------------------------------------------------------------------

  /** Beside the officer (right, then left, then behind) in the officer's room; the officer's spot as a last resort. */
  private placeBeside(building: number, x: number, z: number, yaw: number, q: InteriorQuery): void {
    const layout = building >= 0 ? q.layout(building) : null;
    const room = layout === null ? 0 : roomAt(layout, x, z);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    const bx = Math.sin(yaw);
    const bz = Math.cos(yaw);
    let px = x;
    let pz = z;
    const tries = [
      [x + rx * 0.8 + bx * 0.4, z + rz * 0.8 + bz * 0.4],
      [x - rx * 0.8 + bx * 0.4, z - rz * 0.8 + bz * 0.4],
      [x + bx * 0.9, z + bz * 0.9],
    ] as const;
    for (const [cx, cz] of tries) {
      if (layout === null || roomAt(layout, cx, cz) === room) {
        px = cx;
        pz = cz;
        break;
      }
    }
    this.buildingValue = building;
    this.xValue = px;
    this.zValue = pz;
    this.yawValue = yaw;
    this.pathCount = 0;
    this.pathTx = Infinity;
    this.repath = 0;
  }

  /** Nearest door of the officer's room within the search distance of the officer, -1 none. */
  private nearestDoor(layout: InteriorLayout, officer: OfficerPose): number {
    const room = roomAt(layout, officer.x, officer.z);
    let best = -1;
    let bestD = STACK_SEARCH;
    for (let i = 0; i < layout.doors.length; i++) {
      const d = layout.doors[i] as InteriorDoor;
      if (d.a !== room && d.b !== room) continue;
      const dist = Math.hypot(d.x - officer.x, d.z - officer.z);
      if (dist <= bestD) {
        best = i;
        bestD = dist;
      }
    }
    return best;
  }

  /**
   * Where to stack on door `d` for an officer at (ox, oz): 0.6 m in front of the door on the officer's side, next to
   * the frame on the side away from the officer (half the opening plus the stack offset from its centre), facing the door.
   */
  private stackSpot(layout: InteriorLayout, d: InteriorDoor, ox: number, oz: number, out: { x: number; z: number; yaw: number }): void {
    const alongX = d.axis === 'x';
    const side = (alongX ? oz - d.z : ox - d.x) < 0 ? -1 : 1;
    const lateral = alongX ? ox - d.x : oz - d.z;
    const away = lateral > 0 ? -1 : 1;
    const off = d.width / 2 + this.cfg.partner.stackOffset;
    let x = alongX ? d.x + away * off : d.x + side * STACK_STANDOFF;
    let z = alongX ? d.z + side * STACK_STANDOFF : d.z + away * off;
    // Stay inside the room on the officer's side.
    const room = roomAt(layout, alongX ? d.x : d.x + side * STACK_STANDOFF, alongX ? d.z + side * STACK_STANDOFF : d.z);
    if (room >= 0) {
      const r = (layout.rooms[room] as InteriorLayout['rooms'][number]).rect;
      x = Math.min(r.maxX - 0.3, Math.max(r.minX + 0.3, x));
      z = Math.min(r.maxZ - 0.3, Math.max(r.minZ + 0.3, z));
    }
    out.x = x;
    out.z = z;
    out.yaw = Math.atan2(-(d.x - x), -(d.z - z));
  }

  /** Yaw that faces away from the door into the room whose centre is (cx, cz). */
  private doorFacing(layout: InteriorLayout, door: number, cx: number, cz: number): number {
    const d = layout.doors[door];
    if (d === undefined) return this.yawValue;
    return Math.atan2(-(cx - d.x), -(cz - d.z));
  }

  private writeView(prevX: number, prevZ: number, aiming: boolean, speed = 0, dt = 0): void {
    const v = this.view;
    const y = this.buildingValue >= 0 ? INTERIOR_FLOOR_Y : 0;
    v.prevX[0] = prevX;
    v.prevY[0] = y;
    v.prevZ[0] = prevZ;
    v.prevYaw[0] = v.yaw[0] ?? 0;
    v.x[0] = this.xValue;
    v.y[0] = y;
    v.z[0] = this.zValue;
    v.yaw[0] = this.yawValue;
    v.speed[0] = speed;
    v.gait[0] = ((v.gait[0] ?? 0) + (speed * dt) / STRIDE) % 64;
    v.pose[0] = aiming ? POSE.aim : speed > 0.05 ? POSE.walk : POSE.stand;
    v.held[0] = aiming ? HELD.sidearm : HELD.none;
  }
}
