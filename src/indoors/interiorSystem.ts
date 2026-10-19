/**
 * Interior runtime (design §6): residency (layout + Rapier colliders) of the buildings near the officer, enter/exit
 * fades, door states (open / close / lock / kick / ram), light switches, ambient occupants, a nav port for the npc
 * module and floor plans for the minimap. Fixed step, order -810. Simulation randomness comes only from `deps.rng`;
 * everything else is pure hashing of the seed, so a save continues identically.
 */
import RAPIER, { type Collider } from '@dimforge/rapier3d-compat';
import { DOOR_HEIGHT, MAX_RESIDENT, STREAM_RADIUS, WALL_HEIGHT, WALL_THICKNESS } from '../interior/constants';
import { generateInterior } from '../interior/generate';
import { exitPath, findPath, reachableRooms, roomAt } from '../interior/nav';
import type { InteriorDoor, InteriorLayout } from '../interior/types';
import { unitHash } from '../records/hash';
import type { BuildingInfo } from '../world/buildings';
import { MAX_OVERRIDES, MAX_QUEUE, emptyInteriorSave, type InteriorSave } from './save';
import { hourOf, isOpenAt, occupantPlan } from './occupants';
import {
  DOOR_STATE,
  DOOR_STATE_NAMES,
  type DoorStateId,
  type DoorStateName,
  type FloorPlan,
  type IndoorNavPort,
  type InteriorDeps,
  type InteriorInteractable,
  type InteriorQuery,
  type InteriorRequest,
  type OccupantSpawn,
  type OfficerAt,
} from './types';
import './events';

/** Layouts kept (pure, regenerated on demand). */
const LAYOUT_LRU = 16;
/** Residency is re-evaluated this often while the officer is outdoors (steps). */
const RESIDENCY_PERIOD = 15;
/** The residency window is re-evaluated sooner only when the officer moved this far (m). */
const RESIDENCY_MOVE = 0.5;
/** Seconds per half of an enter/exit fade. */
const FADE_S = 0.3;
const KICK_COOLDOWN_S = 1;
const ENTRANCE_REACH = 1.8;
const DOOR_REACH = 1.6;
const SWITCH_REACH = 1.2;
const POINT_REACH = 1.8;
/** cos(60 deg): the half cone ahead of the officer for doors, switches and points. */
const CONE_COS = 0.5;
const PANEL_HALF_THICKNESS = 0.025;
/** Inside pose distance from a non-main exterior door (m). */
const INSIDE_M = 1;
const KEY_STRIDE = 1024;
/** Strength at and above which a door can never be breached. */
const UNBREACHABLE = 0.95;
const SALT_LIGHT = 0x11c7;
const NIGHT_FROM = 19;
const NIGHT_TO = 7;
const ALWAYS_LIT = ['policeStation', 'hospital', 'jail'];

type Entrance = Extract<InteriorInteractable, { kind: 'entrance' }>;
type Exit = Extract<InteriorInteractable, { kind: 'exit' }>;
type DoorHit = Extract<InteriorInteractable, { kind: 'door' }>;
type SwitchHit = Extract<InteriorInteractable, { kind: 'switch' }>;
type PointHit = Extract<InteriorInteractable, { kind: 'point' }>;

interface LayoutEntry {
  /** Recency stamp for the LRU (a hit only writes this number, so lookups never allocate). */
  used: number;
  layout: InteriorLayout | null;
  plan: FloorPlan | null;
  planRev: number;
}

interface Ambient {
  actorId: number;
  /** -1 for an actor restored from a save. */
  personId: number;
}

interface Resident {
  readonly id: number;
  readonly layout: InteriorLayout;
  readonly colliders: Collider[];
  /** Door panel collider per door (null while open, broken or wide). */
  readonly panels: (Collider | null)[];
  ambient: Ambient[];
}

interface Pending {
  kind: 'enter' | 'exit';
  buildingId: number;
  door: number;
  phase: 0 | 1 | 2;
  t: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function doorKey(building: number, index: number): number {
  return building * KEY_STRIDE + index;
}

function defaultDoorState(d: InteriorDoor): DoorStateId {
  if (d.kind === 'wide') return DOOR_STATE.open;
  return d.lockedAtStart ? DOOR_STATE.locked : DOOR_STATE.closed;
}

function normalizeYaw(yaw: number): number {
  let y = yaw;
  while (y > Math.PI) y -= 2 * Math.PI;
  while (y <= -Math.PI) y += 2 * Math.PI;
  return y;
}

export class InteriorSystem implements InteriorQuery {
  readonly stats = { resident: 0, colliders: 0, stepMs: 0, occupants: 0 };

  private inside = -1;
  private readonly deps: InteriorDeps;
  private readonly layouts = new Map<number, LayoutEntry>();
  private useClock = 0;
  private readonly residents: Resident[] = [];
  private readonly residentIds: number[] = [];
  /** Busy ambient actors of unloaded buildings (kept until they are free to remove). */
  private readonly kept = new Map<number, Ambient[]>();
  /** key (building, door) -> DOOR_STATE; only states that differ from the default, oldest first. */
  private readonly doorOv = new Map<number, DoorStateId>();
  private readonly lightOv = new Map<number, 0 | 1>();
  private readonly doorRevs = new Map<number, number>();
  private readonly claims = new Map<number, Set<number>>();
  private queue: InteriorRequest[] = [];
  private pending: Pending | null = null;
  private kickCooldown = 0;
  private fadeLevel = 0;
  private revisionCount = 0;
  private stepCount = 0;
  private dirty = true;
  private lastHour = -1;
  private lastX = Number.NaN;
  private lastZ = Number.NaN;
  private lastNearest = -1;
  private readonly plan: OccupantSpawn[] = [];
  private readonly sEntrance: Entrance = { kind: 'entrance', buildingId: 0, door: 0, distance: 0 };
  private readonly sExit: Exit = { kind: 'exit', buildingId: 0, door: 0, distance: 0 };
  private readonly sDoor: DoorHit = { kind: 'door', buildingId: 0, door: 0, state: 'closed', distance: 0 };
  private readonly sSwitch: SwitchHit = { kind: 'switch', buildingId: 0, room: 0, on: false, distance: 0 };
  private readonly sPoint: PointHit = { kind: 'point', buildingId: 0, point: 0, pointKind: 'locker', distance: 0 };
  // Nav port.
  private navLayout: InteriorLayout | null = null;
  private navBuilding = -1;
  private readonly navDoor = { index: -1 };
  private readonly navRooms: number[] = [];
  private readonly passable = (door: number): boolean => this.navStateId(door) !== DOOR_STATE.locked;
  private readonly nav: IndoorNavPort;
  private disposed = false;

  constructor(deps: InteriorDeps) {
    this.deps = deps;
    this.nav = {
      path: (b, x, z, tx, tz, out) => {
        const layout = this.navFor(b);
        return layout === null ? 0 : findPath(layout, x, z, tx, tz, this.passable, out);
      },
      exit: (b, x, z, out, pose) => {
        const layout = this.navFor(b);
        if (layout === null) return 0;
        const n = exitPath(layout, x, z, this.passable, out, this.navDoor);
        const d = n > 0 ? layout.doors[this.navDoor.index] : undefined;
        if (!d?.exit) return 0;
        pose.x = d.exit.x;
        pose.z = d.exit.z;
        pose.yaw = d.exit.yaw;
        return n;
      },
      hideSpot: (b, x, z, ax, az, pose) => this.claimHide(b, x, z, ax, az, pose),
      releaseHide: (b, index) => {
        this.claims.get(b)?.delete(index);
      },
    };
  }

  // --- State ---------------------------------------------------------------------------------

  /** Building the officer is in, -1 outdoors. */
  get officerBuilding(): number {
    return this.inside;
  }

  /** Building ids with colliders (at most `MAX_RESIDENT`). */
  get resident(): readonly number[] {
    return this.residentIds;
  }

  /** Bumps on residency, door and light changes (the renderer rebuilds on it). */
  get revision(): number {
    return this.revisionCount;
  }

  /** Fade overlay level: 0 clear, 1 black. */
  get fade(): number {
    return this.fadeLevel;
  }

  private entryOf(buildingId: number): LayoutEntry {
    const hit = this.layouts.get(buildingId);
    if (hit !== undefined) {
      hit.used = ++this.useClock;
      return hit;
    }
    const info = this.deps.buildings.building(buildingId);
    const entry: LayoutEntry = {
      used: ++this.useClock,
      layout: info === null ? null : generateInterior(this.deps.seed, info),
      plan: null,
      planRev: -1,
    };
    this.layouts.set(buildingId, entry);
    if (this.layouts.size > LAYOUT_LRU) {
      let oldest = -1;
      let oldestUsed = Infinity;
      for (const [id, e] of this.layouts) {
        if (e.used < oldestUsed) {
          oldestUsed = e.used;
          oldest = id;
        }
      }
      this.layouts.delete(oldest);
    }
    return entry;
  }

  /** Pure layout (cached, LRU 16); null when the building is not enterable. */
  layout(buildingId: number): InteriorLayout | null {
    return this.entryOf(buildingId).layout;
  }

  building(buildingId: number): BuildingInfo | null {
    return this.deps.buildings.building(buildingId);
  }

  private stateId(buildingId: number, layout: InteriorLayout, door: number): DoorStateId {
    const d = layout.doors[door];
    if (d === undefined) return DOOR_STATE.closed;
    if (d.kind === 'wide') return DOOR_STATE.open;
    return this.doorOv.get(doorKey(buildingId, door)) ?? defaultDoorState(d);
  }

  private navStateId(door: number): DoorStateId {
    return this.navLayout === null ? DOOR_STATE.closed : this.stateId(this.navBuilding, this.navLayout, door);
  }

  doorState(buildingId: number, door: number): DoorStateName {
    const layout = this.layout(buildingId);
    if (layout === null) return 'closed';
    return DOOR_STATE_NAMES[this.stateId(buildingId, layout, door)] as DoorStateName;
  }

  doorRevision(buildingId: number): number {
    return this.doorRevs.get(buildingId) ?? 0;
  }

  roomLit(buildingId: number, room: number): boolean {
    const layout = this.layout(buildingId);
    const r = layout?.rooms[room];
    if (layout === null || r === undefined || r.light === null) return false;
    const ov = this.lightOv.get(doorKey(buildingId, room));
    if (ov !== undefined) return ov === 1;
    return this.defaultLit(layout, room);
  }

  private defaultLit(layout: InteriorLayout, room: number): boolean {
    if (ALWAYS_LIT.includes(layout.kind)) return true;
    const hour = hourOf(this.deps.now());
    if (layout.residential) {
      const night = hour >= NIGHT_FROM || hour < NIGHT_TO;
      return night && unitHash(this.deps.seed, SALT_LIGHT, layout.buildingId * 64 + room) < 0.35;
    }
    return isOpenAt(layout.occupants.openHours, hour);
  }

  /** Scenes: forces a door state (a barricade's locked front door, unlocked again after entry). Saved as an override. */
  setDoorState(buildingId: number, door: number, state: DoorStateName): void {
    const layout = this.layout(buildingId);
    const d = layout?.doors[door];
    if (layout === null || d === undefined || d.kind === 'wide' || door >= KEY_STRIDE) return;
    const id = DOOR_STATE_NAMES.indexOf(state) as DoorStateId;
    const was = this.stateId(buildingId, layout, door);
    const action = state === 'open' ? 'open' : state === 'closed' ? (was === DOOR_STATE.locked ? 'unlock' : 'close') : state === 'locked' ? 'lock' : 'breached';
    this.changeDoor(buildingId, layout, d, id, action, 'scene');
  }

  setRoomLight(buildingId: number, room: number, on: boolean): void {
    const layout = this.layout(buildingId);
    if (layout === null || room < 0 || room >= layout.rooms.length || room >= KEY_STRIDE) return;
    this.writeLight(buildingId, room, on);
  }

  private writeLight(buildingId: number, room: number, on: boolean): void {
    const key = doorKey(buildingId, room);
    this.lightOv.delete(key);
    this.lightOv.set(key, on ? 1 : 0);
    this.capOverrides(this.lightOv);
    this.revisionCount++;
    this.deps.bus.emit('interior:switch', { buildingId, room, on });
  }

  // --- Overrides -----------------------------------------------------------------------------

  /** Drops the oldest overrides beyond the cap, never those of the officer's or a resident building. */
  private capOverrides(map: Map<number, unknown>): void {
    if (map.size <= MAX_OVERRIDES) return;
    for (const key of map.keys()) {
      if (map.size <= MAX_OVERRIDES) break;
      const b = Math.floor(key / KEY_STRIDE);
      if (b === this.inside || this.residentIds.includes(b)) continue;
      map.delete(key);
    }
  }

  /** Sets a door state; updates the panel collider, revisions and emits the event. False when nothing changed. */
  private changeDoor(
    buildingId: number,
    layout: InteriorLayout,
    d: InteriorDoor,
    next: DoorStateId,
    action: 'open' | 'close' | 'lock' | 'unlock' | 'breached',
    by: 'officer' | 'scene',
  ): boolean {
    const prev = this.stateId(buildingId, layout, d.index);
    if (prev === next) return false;
    const key = doorKey(buildingId, d.index);
    this.doorOv.delete(key);
    if (next !== defaultDoorState(d)) {
      this.doorOv.set(key, next);
      this.capOverrides(this.doorOv);
    }
    this.doorRevs.set(buildingId, (this.doorRevs.get(buildingId) ?? 0) + 1);
    this.revisionCount++;
    const res = this.residentOf(buildingId);
    if (res !== null) this.syncPanel(res, d.index);
    this.emitDoor(buildingId, d, action, true, by);
    return true;
  }

  private emitDoor(buildingId: number, d: InteriorDoor, action: 'open' | 'close' | 'locked' | 'knock' | 'announce' | 'kick' | 'ram' | 'breached' | 'lock' | 'unlock', success: boolean, by: 'officer' | 'scene'): void {
    this.deps.bus.emit('interior:door', { buildingId, door: d.index, action, success, x: d.x, z: d.z, by });
  }

  // --- Residency -----------------------------------------------------------------------------

  private residentOf(buildingId: number): Resident | null {
    for (const r of this.residents) if (r.id === buildingId) return r;
    return null;
  }

  private createCollider(hx: number, hy: number, hz: number, x: number, y: number, z: number): Collider {
    const desc = RAPIER.ColliderDesc.cuboid(hx, hy, hz).setTranslation(x, y, z);
    return this.deps.physics.raw.createCollider(desc);
  }

  private panelCollider(res: Resident, d: InteriorDoor): Collider {
    const y = res.layout.floorY + DOOR_HEIGHT / 2;
    return d.axis === 'x'
      ? this.createCollider(d.width / 2, DOOR_HEIGHT / 2, PANEL_HALF_THICKNESS, d.x, y, d.z)
      : this.createCollider(PANEL_HALF_THICKNESS, DOOR_HEIGHT / 2, d.width / 2, d.x, y, d.z);
  }

  /** Door panel colliders exist while a door is closed or locked. */
  private syncPanel(res: Resident, door: number): void {
    const d = res.layout.doors[door];
    if (d === undefined) return;
    const s = this.stateId(res.id, res.layout, door);
    const want = d.kind !== 'wide' && (s === DOOR_STATE.closed || s === DOOR_STATE.locked);
    const have = res.panels[door] ?? null;
    if (want && have === null) {
      res.panels[door] = this.panelCollider(res, d);
      this.stats.colliders++;
    } else if (!want && have !== null) {
      if (!this.deps.physics.isDisposed) this.deps.physics.raw.removeCollider(have, false);
      res.panels[door] = null;
      this.stats.colliders--;
    }
  }

  private buildResident(id: number, layout: InteriorLayout): Resident {
    const res: Resident = { id, layout, colliders: [], panels: new Array<Collider | null>(layout.doors.length).fill(null), ambient: [] };
    const floorY = layout.floorY;
    const w = layout.walls;
    for (let i = 0; i + 3 < w.length; i += 4) {
      const x0 = w[i] as number, z0 = w[i + 1] as number, x1 = w[i + 2] as number, z1 = w[i + 3] as number;
      const lx = Math.abs(x1 - x0), lz = Math.abs(z1 - z0);
      const hx = lx >= lz ? lx / 2 : WALL_THICKNESS / 2;
      const hz = lx >= lz ? WALL_THICKNESS / 2 : lz / 2;
      res.colliders.push(this.createCollider(hx, WALL_HEIGHT / 2, hz, (x0 + x1) / 2, floorY + WALL_HEIGHT / 2, (z0 + z1) / 2));
    }
    for (const f of layout.furniture) {
      if (!f.solid) continue;
      res.colliders.push(
        this.createCollider((f.maxX - f.minX) / 2, f.h / 2, (f.maxZ - f.minZ) / 2, (f.minX + f.maxX) / 2, floorY + f.h / 2, (f.minZ + f.maxZ) / 2),
      );
    }
    this.stats.colliders += res.colliders.length;
    this.residents.push(res);
    this.residentIds.push(id);
    for (let i = 0; i < layout.doors.length; i++) this.syncPanel(res, i);
    this.stats.resident = this.residents.length;
    this.revisionCount++;
    return res;
  }

  /** Loads `id` (colliders, optional ambient occupants). False when the building has no interior. */
  private load(id: number, spawn: boolean): boolean {
    if (this.residentOf(id) !== null) return true;
    const layout = this.layout(id);
    if (layout === null) return false;
    const res = this.buildResident(id, layout);
    const kept = this.kept.get(id);
    if (kept !== undefined) {
      res.ambient = kept;
      this.kept.delete(id);
    }
    this.deps.bus.emit('interior:resident', { buildingId: id, loaded: true });
    if (spawn && !this.deps.occupants.sceneOwns(id)) this.spawnAmbient(res);
    return true;
  }

  private spawnAmbient(res: Resident): void {
    const list = occupantPlan(this.deps.seed, res.layout, this.deps.now(), this.plan);
    for (const spec of list) {
      if (res.ambient.some((a) => a.personId === spec.personId)) continue;
      const actorId = this.deps.occupants.spawn(spec);
      if (actorId > 0) {
        res.ambient.push({ actorId, personId: spec.personId });
        this.stats.occupants++;
      }
    }
  }

  private unload(res: Resident, removeActors: boolean): void {
    const raw = this.deps.physics.raw;
    const live = !this.deps.physics.isDisposed;
    for (const c of res.colliders) if (live) raw.removeCollider(c, false);
    for (const c of res.panels) if (c !== null && live) raw.removeCollider(c, false);
    this.stats.colliders -= res.colliders.length + res.panels.filter((c) => c !== null).length;
    const keep: Ambient[] = [];
    for (const a of res.ambient) {
      if (removeActors && !this.deps.occupants.busy(a.actorId)) {
        this.deps.occupants.remove(a.actorId);
        this.stats.occupants--;
      } else if (removeActors) keep.push(a);
    }
    if (keep.length > 0) this.kept.set(res.id, keep);
    const i = this.residents.indexOf(res);
    this.residents.splice(i, 1);
    this.residentIds.splice(i, 1);
    this.stats.resident = this.residents.length;
    this.revisionCount++;
    this.deps.bus.emit('interior:resident', { buildingId: res.id, loaded: false });
  }

  /** Busy actors of unloaded buildings are removed once they are free. */
  private releaseKept(): void {
    for (const [b, list] of this.kept) {
      for (let i = list.length - 1; i >= 0; i--) {
        const a = list[i] as Ambient;
        if (this.deps.occupants.busy(a.actorId)) continue;
        this.deps.occupants.remove(a.actorId);
        this.stats.occupants--;
        list.splice(i, 1);
      }
      if (list.length === 0) this.kept.delete(b);
    }
  }

  /** Synchronously makes `id` resident and unloads every other interior. */
  private makeOnlyResident(id: number, spawn: boolean): boolean {
    for (const r of this.residents.slice()) if (r.id !== id) this.unload(r, true);
    return this.load(id, spawn);
  }

  private updateResidency(officer: OfficerAt): void {
    const hour = hourOf(this.deps.now());
    if (hour !== this.lastHour) {
      this.lastHour = hour;
      if (this.residents.length > 0) this.revisionCount++;
    }
    const outdoors = this.inside < 0;
    const due = this.dirty || (outdoors && this.stepCount % RESIDENCY_PERIOD === 0);
    if (!due) return;
    let w0 = this.inside;
    if (outdoors) {
      const moved = Math.abs(officer.x - this.lastX) > RESIDENCY_MOVE || Math.abs(officer.z - this.lastZ) > RESIDENCY_MOVE;
      if (this.dirty || moved || Number.isNaN(this.lastX)) {
        this.lastX = officer.x;
        this.lastZ = officer.z;
        this.lastNearest = this.deps.buildings.nearestEntrance(officer.x, officer.z, STREAM_RADIUS)?.id ?? -1;
      }
      w0 = this.lastNearest;
    }
    const w1 = this.pending !== null && this.pending.buildingId !== w0 ? this.pending.buildingId : -1;
    if (this.kept.size > 0) this.releaseKept();
    for (let i = this.residents.length - 1; i >= 0; i--) {
      const r = this.residents[i] as Resident;
      if (r.id !== w0 && r.id !== w1) this.unload(r, true);
    }
    // At most one load per step; the other wanted building (if any) loads on the next one.
    let loads = 0;
    let outstanding = false;
    for (let k = 0; k < 2; k++) {
      const id = k === 0 ? w0 : w1;
      if (id < 0 || this.residentOf(id) !== null) continue;
      if (loads > 0 || this.residents.length >= MAX_RESIDENT) outstanding = true;
      else if (this.load(id, true)) loads++;
    }
    this.dirty = outstanding;
  }

  // --- Step ----------------------------------------------------------------------------------

  /** Fixed step (order -810). */
  step(dt: number, officer: OfficerAt): void {
    if (this.disposed) return;
    const clock = this.deps.clock;
    const t0 = clock === undefined ? 0 : clock();
    this.stepCount++;
    if (this.kickCooldown > 0) this.kickCooldown = Math.max(0, this.kickCooldown - dt);
    if (this.queue.length > 0) {
      const q = this.queue;
      this.queue = [];
      for (const r of q) this.apply(r, officer);
    }
    this.stepPending(dt);
    this.updateResidency(officer);
    if (clock !== undefined) this.stats.stepMs += (clock() - t0 - this.stats.stepMs) * 0.05;
  }

  /** Queues a request, applied at the start of the next step. */
  request(r: InteriorRequest): void {
    if (this.queue.length >= MAX_QUEUE) return;
    this.queue.push(r);
    this.dirty = true;
  }

  private apply(r: InteriorRequest, officer: OfficerAt): void {
    switch (r.kind) {
      case 'enter': this.enter(r.buildingId, r.door, officer); break;
      case 'exit': this.exit(r.door, officer); break;
      case 'door': this.doorRequest(r.buildingId, r.door, r.action, officer); break;
      case 'switch': this.switchRequest(r.buildingId, r.room, officer); break;
    }
  }

  private flash(text: string): void {
    this.deps.bus.emit('interior:flash', { text });
  }

  private enter(buildingId: number, door: number, officer: OfficerAt): void {
    if (this.pending !== null || this.inside >= 0 || !officer.onFoot) return;
    const res = this.residentOf(buildingId);
    const d = res?.layout.doors[door];
    if (res === null || d === undefined || d.exit === null) return;
    const dx = d.exit.x - officer.x, dz = d.exit.z - officer.z;
    if (dx * dx + dz * dz > ENTRANCE_REACH * ENTRANCE_REACH) return;
    const s = this.stateId(buildingId, res.layout, door);
    if (s === DOOR_STATE.locked) {
      this.emitDoor(buildingId, d, 'locked', false, 'officer');
      this.flash('Locked');
      return;
    }
    if (s === DOOR_STATE.closed) this.changeDoor(buildingId, res.layout, d, DOOR_STATE.open, 'open', 'officer');
    this.startTransition('enter', buildingId, door);
  }

  private exit(door: number, officer: OfficerAt): void {
    const buildingId = this.inside;
    if (this.pending !== null || buildingId < 0 || !officer.onFoot) return;
    const res = this.residentOf(buildingId);
    const d = res?.layout.doors[door];
    if (res === null || d === undefined || d.exit === null) return;
    const dx = d.x - officer.x, dz = d.z - officer.z;
    if (dx * dx + dz * dz > ENTRANCE_REACH * ENTRANCE_REACH) return;
    const s = this.stateId(buildingId, res.layout, door);
    // The thumb-turn is on the inside: leaving unlocks the door.
    if (s === DOOR_STATE.locked) this.changeDoor(buildingId, res.layout, d, DOOR_STATE.closed, 'unlock', 'officer');
    if (this.stateId(buildingId, res.layout, door) === DOOR_STATE.closed) this.changeDoor(buildingId, res.layout, d, DOOR_STATE.open, 'open', 'officer');
    this.startTransition('exit', buildingId, door);
  }

  private startTransition(kind: 'enter' | 'exit', buildingId: number, door: number): void {
    this.pending = { kind, buildingId, door, phase: 0, t: 0 };
    this.dirty = true;
    this.deps.bus.emit('interior:transition', { buildingId, entering: kind === 'enter', phase: 'out' });
  }

  private stepPending(dt: number): void {
    const p = this.pending;
    if (p === null) return;
    if (p.phase === 0) {
      p.t += dt;
      this.fadeLevel = Math.min(1, p.t / FADE_S);
      if (p.t >= FADE_S - 1e-6) {
        this.fadeLevel = 1;
        p.phase = 1;
        p.t = 0;
      }
    }
    if (p.phase === 1) {
      this.performMove(p);
      p.phase = 2;
      p.t = 0;
      this.deps.bus.emit('interior:transition', { buildingId: p.buildingId, entering: p.kind === 'enter', phase: 'in' });
    } else if (p.phase === 2) {
      p.t += dt;
      this.fadeLevel = Math.max(0, 1 - p.t / FADE_S);
      if (p.t >= FADE_S - 1e-6) {
        this.fadeLevel = 0;
        this.pending = null;
        this.dirty = true;
        this.deps.bus.emit('interior:transition', { buildingId: p.buildingId, entering: p.kind === 'enter', phase: 'done' });
      }
    }
  }

  /** The fade is black: teleport the officer (event), switch levels. */
  private performMove(p: Pending): void {
    const layout = this.layout(p.buildingId);
    const d = layout?.doors[p.door];
    if (layout === null || d === undefined) {
      this.pending = null;
      this.fadeLevel = 0;
      return;
    }
    this.dirty = true;
    if (p.kind === 'enter') {
      if (this.residentOf(p.buildingId) === null) this.makeOnlyResident(p.buildingId, true);
      let x = layout.entry.x, z = layout.entry.z, yaw = layout.entry.yaw;
      if (!d.main && d.exit !== null) {
        if (d.axis === 'x') {
          x = d.x;
          z = d.z - Math.sign(d.exit.z - d.z) * INSIDE_M;
        } else {
          x = d.x - Math.sign(d.exit.x - d.x) * INSIDE_M;
          z = d.z;
        }
        yaw = normalizeYaw(d.exit.yaw + Math.PI);
      }
      this.inside = p.buildingId;
      this.revisionCount++;
      this.deps.bus.emit('interior:moveOfficer', { buildingId: p.buildingId, x, y: layout.floorY, z, yaw });
    } else if (d.exit !== null) {
      this.inside = -1;
      this.lastX = Number.NaN;
      this.revisionCount++;
      this.deps.bus.emit('interior:moveOfficer', { buildingId: -1, x: d.exit.x, y: 0, z: d.exit.z, yaw: d.exit.yaw });
    }
  }

  /** Synchronous residency + officer placement (a new game in the station, loads, debug teleports). */
  placeOfficerInside(buildingId: number, pose: { x: number; z: number; yaw: number }): void {
    const layout = this.layout(buildingId);
    if (layout === null) return;
    this.pending = null;
    this.fadeLevel = 0;
    this.makeOnlyResident(buildingId, true);
    this.inside = buildingId;
    this.dirty = true;
    this.revisionCount++;
    this.deps.bus.emit('interior:moveOfficer', { buildingId, x: pose.x, y: layout.floorY, z: pose.z, yaw: pose.yaw });
  }

  /** Debug teleports: the officer is outdoors again at once (no fade, no move event; the caller moves the body). */
  leaveBuilding(): void {
    this.pending = null;
    this.fadeLevel = 0;
    this.inside = -1;
    this.lastX = Number.NaN;
    this.dirty = true;
    this.revisionCount++;
  }

  // --- Doors and switches --------------------------------------------------------------------

  private doorRequest(buildingId: number, door: number, action: Extract<InteriorRequest, { kind: 'door' }>['action'], officer: OfficerAt): void {
    const layout = this.layout(buildingId);
    const d = layout?.doors[door];
    if (layout === null || d === undefined || d.kind === 'wide') return;
    // Inside: within reach of the door. Outdoors: within reach of an exterior door's outside pose.
    let inside = false;
    if (this.inside === buildingId) {
      const dx = d.x - officer.x, dz = d.z - officer.z;
      if (dx * dx + dz * dz > DOOR_REACH * DOOR_REACH) return;
      inside = true;
    } else if (this.inside < 0 && d.exit !== null) {
      const dx = d.exit.x - officer.x, dz = d.exit.z - officer.z;
      if (dx * dx + dz * dz > ENTRANCE_REACH * ENTRANCE_REACH) return;
    } else return;
    const s = this.stateId(buildingId, layout, door);
    switch (action) {
      case 'toggle':
      case 'open':
      case 'close': {
        if (s === DOOR_STATE.locked) {
          this.emitDoor(buildingId, d, 'locked', false, 'officer');
          this.flash('Locked');
        } else if (s === DOOR_STATE.broken) break;
        else if (action === 'close' || (action === 'toggle' && s === DOOR_STATE.open)) this.changeDoor(buildingId, layout, d, DOOR_STATE.closed, 'close', 'officer');
        else this.changeDoor(buildingId, layout, d, DOOR_STATE.open, 'open', 'officer');
        break;
      }
      case 'knock': this.emitDoor(buildingId, d, 'knock', true, 'officer'); break;
      case 'announce': this.emitDoor(buildingId, d, 'announce', true, 'officer'); break;
      case 'kick':
      case 'ram': this.breach(buildingId, layout, d, s, action, officer); break;
      case 'lock':
      case 'unlock': this.lockRequest(buildingId, layout, d, s, action, inside, officer); break;
    }
  }

  private breach(buildingId: number, layout: InteriorLayout, d: InteriorDoor, s: DoorStateId, action: 'kick' | 'ram', officer: OfficerAt): void {
    if (s === DOOR_STATE.open || s === DOOR_STATE.broken || this.kickCooldown > 0) return;
    if (action === 'kick' && !officer.onFoot) return;
    if (action === 'ram' && this.deps.kit().carried('ram') < 1) {
      this.flash('No door ram');
      return;
    }
    this.kickCooldown = KICK_COOLDOWN_S;
    let ok = false;
    if (d.strength < UNBREACHABLE) {
      const p = action === 'kick' ? clamp(0.7 - 0.6 * d.strength, 0, 0.7) : clamp(1.1 - 0.8 * d.strength, 0, 0.95);
      ok = this.deps.rng.chance(p);
    }
    this.emitDoor(buildingId, d, action, ok, 'officer');
    if (ok) {
      this.changeDoor(buildingId, layout, d, DOOR_STATE.broken, 'breached', 'officer');
    }
  }

  private lockRequest(buildingId: number, layout: InteriorLayout, d: InteriorDoor, s: DoorStateId, action: 'lock' | 'unlock', inside: boolean, officer: OfficerAt): void {
    let allowed = d.lockable && s !== DOOR_STATE.broken;
    if (allowed) {
      // Interior doors from the thumb-turn side only; exterior doors from inside only.
      allowed = d.b >= 0 ? inside && roomAt(layout, officer.x, officer.z) === d.lockSide : inside;
    }
    if (!allowed) {
      this.emitDoor(buildingId, d, action, false, 'officer');
      return;
    }
    if (action === 'lock') {
      if (s === DOOR_STATE.open) {
        this.emitDoor(buildingId, d, 'lock', false, 'officer');
        return;
      }
      this.changeDoor(buildingId, layout, d, DOOR_STATE.locked, 'lock', 'officer');
    } else {
      this.changeDoor(buildingId, layout, d, DOOR_STATE.closed, 'unlock', 'officer');
    }
  }

  private switchRequest(buildingId: number, room: number, officer: OfficerAt): void {
    if (this.inside !== buildingId) return;
    const layout = this.layout(buildingId);
    const sw = layout?.rooms[room]?.switchAt;
    if (layout === null || !sw) return;
    const dx = sw.x - officer.x, dz = sw.z - officer.z;
    if (dx * dx + dz * dz > SWITCH_REACH * SWITCH_REACH) return;
    this.writeLight(buildingId, room, !this.roomLit(buildingId, room));
  }

  // --- Interaction ---------------------------------------------------------------------------

  /**
   * The nearest thing within reach (1.8 m entrance / exit, 1.6 m door, 1.2 m switch, 1.8 m point), ahead of the
   * officer (60 degree half cone; entrances and exits any direction). The result is a scratch object, valid until the
   * next call.
   */
  nearestInteractable(x: number, z: number, yaw: number, building: number): InteriorInteractable | null {
    let best: InteriorInteractable | null = null;
    let bestD = Infinity;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    if (building < 0) {
      for (const res of this.residents) {
        const doors = res.layout.doors;
        for (let i = 0; i < doors.length; i++) {
          const d = doors[i] as InteriorDoor;
          if (d.exit === null) continue;
          const ex = d.exit.x - x, ez = d.exit.z - z;
          const dist = Math.sqrt(ex * ex + ez * ez);
          if (dist > ENTRANCE_REACH || dist >= bestD) continue;
          bestD = dist;
          const s = this.sEntrance;
          s.buildingId = res.id; s.door = i; s.distance = dist;
          best = s;
        }
      }
      return best;
    }
    const res = this.residentOf(building);
    if (res === null) return null;
    const layout = res.layout;
    for (let i = 0; i < layout.doors.length; i++) {
      const d = layout.doors[i] as InteriorDoor;
      const dx = d.x - x, dz = d.z - z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist >= bestD) continue;
      if (d.exit !== null) {
        if (dist > ENTRANCE_REACH) continue;
        bestD = dist;
        const s = this.sExit;
        s.buildingId = building; s.door = i; s.distance = dist;
        best = s;
      } else if (d.kind !== 'wide' && dist <= DOOR_REACH && (dist < 0.25 || dx * fx + dz * fz >= CONE_COS * dist)) {
        bestD = dist;
        const s = this.sDoor;
        s.buildingId = building; s.door = i; s.distance = dist;
        s.state = DOOR_STATE_NAMES[this.stateId(building, layout, i)] as DoorStateName;
        best = s;
      }
    }
    for (let i = 0; i < layout.rooms.length; i++) {
      const sw = (layout.rooms[i] as InteriorLayout['rooms'][number]).switchAt;
      if (sw === null) continue;
      const dx = sw.x - x, dz = sw.z - z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > SWITCH_REACH || dist >= bestD || !(dist < 0.25 || dx * fx + dz * fz >= CONE_COS * dist)) continue;
      bestD = dist;
      const s = this.sSwitch;
      s.buildingId = building; s.room = i; s.distance = dist; s.on = this.roomLit(building, i);
      best = s;
    }
    for (let i = 0; i < layout.points.length; i++) {
      const p = layout.points[i] as InteriorLayout['points'][number];
      const dx = p.x - x, dz = p.z - z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > POINT_REACH || dist >= bestD || !(dist < 0.25 || dx * fx + dz * fz >= CONE_COS * dist)) continue;
      bestD = dist;
      const s = this.sPoint;
      s.buildingId = building; s.point = i; s.pointKind = p.kind; s.distance = dist;
      best = s;
    }
    return best;
  }

  // --- Nav port and floor plan ---------------------------------------------------------------

  private navFor(buildingId: number): InteriorLayout | null {
    const layout = this.layout(buildingId);
    this.navLayout = layout;
    this.navBuilding = buildingId;
    return layout;
  }

  /** The nav port for the npc module. Shares scratch buffers: do not call it from inside its own callbacks. */
  navPort(): IndoorNavPort {
    return this.nav;
  }

  private claimHide(buildingId: number, x: number, z: number, awayX: number, awayZ: number, pose: { x: number; z: number; yaw: number }): number {
    const layout = this.navFor(buildingId);
    if (layout === null) return -1;
    const from = roomAt(layout, x, z);
    const rooms = from >= 0 ? reachableRooms(layout, from, this.passable, this.navRooms) : null;
    let claimed = this.claims.get(buildingId);
    let best = -1;
    let bestD = -1;
    for (const spot of layout.hidingSpots) {
      if (claimed?.has(spot.index) || (rooms !== null && !rooms.includes(spot.room))) continue;
      const dx = spot.x - awayX, dz = spot.z - awayZ;
      const d = dx * dx + dz * dz;
      if (d > bestD) {
        bestD = d;
        best = spot.index;
      }
    }
    if (best < 0) return -1;
    const spot = layout.hidingSpots[best];
    if (spot === undefined) return -1;
    if (claimed === undefined) {
      claimed = new Set<number>();
      this.claims.set(buildingId, claimed);
    }
    claimed.add(best);
    pose.x = spot.x;
    pose.z = spot.z;
    pose.yaw = spot.yaw;
    return best;
  }

  /** Marks a hiding spot as used (restoring a hidden actor from a save). */
  claimHideSpot(buildingId: number, index: number): void {
    let claimed = this.claims.get(buildingId);
    if (claimed === undefined) {
      claimed = new Set<number>();
      this.claims.set(buildingId, claimed);
    }
    claimed.add(index);
  }

  /** Floor plan for the minimap; the arrays are cached per building and refreshed in place when a door changes. */
  floorPlan(buildingId: number): FloorPlan | null {
    const e = this.entryOf(buildingId);
    const layout = e.layout;
    if (layout === null) return null;
    if (e.plan === null) {
      const rooms = new Float32Array(layout.rooms.length * 4);
      layout.rooms.forEach((r, i) => {
        rooms[i * 4] = r.rect.minX;
        rooms[i * 4 + 1] = r.rect.minZ;
        rooms[i * 4 + 2] = r.rect.maxX;
        rooms[i * 4 + 3] = r.rect.maxZ;
      });
      const doors = new Float32Array(layout.doors.length * 3);
      layout.doors.forEach((d, i) => {
        doors[i * 3] = d.x;
        doors[i * 3 + 1] = d.z;
      });
      e.plan = { rooms, doors, rect: layout.rect };
      e.planRev = -1;
    }
    const rev = this.doorRevision(buildingId);
    if (e.planRev !== rev) {
      const doors = e.plan.doors;
      for (let i = 0; i < layout.doors.length; i++) {
        const s = this.stateId(buildingId, layout, i);
        doors[i * 3 + 2] = s === DOOR_STATE.open || s === DOOR_STATE.broken ? 1 : 0;
      }
      e.planRev = rev;
    }
    return e.plan;
  }

  // --- Save ----------------------------------------------------------------------------------

  serialize(): InteriorSave {
    const save = emptyInteriorSave(this.deps.rng.state());
    save.officerBuilding = this.inside;
    for (const [key, state] of this.doorOv) save.doors.push([Math.floor(key / KEY_STRIDE), key % KEY_STRIDE, state]);
    for (const [key, on] of this.lightOv) save.lights.push([Math.floor(key / KEY_STRIDE), key % KEY_STRIDE, on]);
    save.kickCooldown = this.kickCooldown;
    save.fade = this.fadeLevel;
    save.pending = this.pending === null ? null : { ...this.pending };
    save.queue = this.queue.map((r) => ({ ...r }));
    const spawned = new Map<number, number[]>();
    for (const res of this.residents) if (res.ambient.length > 0) spawned.set(res.id, res.ambient.map((a) => a.actorId));
    for (const [b, list] of this.kept) spawned.set(b, [...(spawned.get(b) ?? []), ...list.map((a) => a.actorId)]);
    save.spawned = [...spawned];
    return save;
  }

  /** Re-applies overrides and makes the officer's building resident (colliders) at once. Spawns nothing: npc restores its own actors. */
  restore(save: InteriorSave): void {
    for (const r of this.residents.slice()) this.unload(r, false);
    this.kept.clear();
    this.claims.clear();
    this.stats.occupants = 0;
    this.deps.rng.restore(save.rng);
    for (const e of this.doorRevs.keys()) this.doorRevs.set(e, (this.doorRevs.get(e) ?? 0) + 1);
    this.doorOv.clear();
    this.lightOv.clear();
    for (const [b, door, state] of save.doors) {
      if (door >= KEY_STRIDE) continue;
      this.doorOv.set(doorKey(b, door), state as DoorStateId);
      this.doorRevs.set(b, (this.doorRevs.get(b) ?? 0) + 1);
    }
    for (const [b, room, on] of save.lights) if (room < KEY_STRIDE) this.lightOv.set(doorKey(b, room), on);
    for (const e of this.layouts.values()) e.planRev = -1;
    this.kickCooldown = save.kickCooldown;
    this.fadeLevel = save.fade;
    this.pending = save.pending === null ? null : { ...save.pending };
    this.queue = save.queue.map((r) => ({ ...r }));
    this.inside = save.officerBuilding >= 0 && this.layout(save.officerBuilding) !== null ? save.officerBuilding : -1;
    const ambient = new Map(save.spawned);
    const want = [this.inside, this.pending?.buildingId ?? -1];
    for (const id of want) {
      if (id < 0 || this.residents.length >= MAX_RESIDENT || !this.load(id, false)) continue;
      const res = this.residentOf(id);
      if (res !== null && res.ambient.length === 0) {
        res.ambient = (ambient.get(id) ?? []).map((actorId) => ({ actorId, personId: -1 }));
        this.stats.occupants += res.ambient.length;
      }
    }
    for (const [b, ids] of ambient) {
      if (this.residentOf(b) === null && ids.length > 0) {
        this.kept.set(b, ids.map((actorId) => ({ actorId, personId: -1 })));
        this.stats.occupants += ids.length;
      }
    }
    this.lastX = Number.NaN;
    this.lastHour = -1;
    this.dirty = true;
    this.revisionCount++;
  }

  /** Removes every collider this system created (skip the physics world's own disposal). */
  dispose(): void {
    if (this.disposed) return;
    for (const r of this.residents.slice()) this.unload(r, false);
    this.disposed = true;
    this.queue.length = 0;
    this.layouts.clear();
  }
}
