import { EventBus } from '../../src/core/events';
import type { EventMap } from '../../src/core/event-map';
import { createRng } from '../../src/core/rng';
import type { City } from '../../src/world/city';
import type { FurnitureItem, InteriorDoor, InteriorLayout, InteriorRoom, Rect } from '../../src/interior/types';
import {
  createListener,
  type DoorStateName,
  type InteriorQuery,
  type Listener,
  type ListenerPort,
  type OfficerPose,
} from '../../src/tactical/types';
import { TacticalSystem, type TacticalDeps } from '../../src/tactical/tacticalSystem';
import { TACTICS } from '../../src/tactical/data';

export function room(index: number, kind: InteriorRoom['kind'], rect: Rect, surface: InteriorRoom['surface'] = 'wood'): InteriorRoom {
  return { index, kind, label: kind, rect, surface, public: false, light: { x: (rect.minX + rect.maxX) / 2, z: (rect.minZ + rect.maxZ) / 2 }, switchAt: null };
}

export function door(index: number, a: number, b: number, x: number, z: number, axis: 'x' | 'z', over: Partial<InteriorDoor> = {}): InteriorDoor {
  return {
    index, a, b, x, z, axis, width: 0.9, kind: b < 0 ? 'exterior' : 'interior', lockable: false, lockedAtStart: false, lockSide: -1,
    strength: 0.3, exit: null, main: false, ...over,
  };
}

export function box(index: number, room: number, minX: number, minZ: number, maxX: number, maxZ: number, h: number): FurnitureItem {
  return {
    index, id: 'counter', room, x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, yaw: 0, w: maxX - minX, d: maxZ - minZ, h, minX, minZ, maxX, maxZ,
    color: 0x888888, solid: true, cover: h >= 0.8 && h <= 1.3, surface: null, container: 'none', hide: null, seat: null,
  };
}

/** Wall segments of a rectangle with gaps; test layouts list them by hand. */
export function layoutOf(rect: Rect, rooms: InteriorRoom[], doors: InteriorDoor[], walls: number[], furniture: FurnitureItem[] = []): InteriorLayout {
  const roomDoors: number[][] = rooms.map(() => []);
  for (const d of doors) {
    roomDoors[d.a]?.push(d.index);
    if (d.b >= 0) roomDoors[d.b]?.push(d.index);
  }
  return {
    buildingId: 1, kind: 'house', floorY: -40, rect, rooms, doors, walls: new Float32Array(walls), furniture, hidingSpots: [], spawnSpots: [], itemSpots: [],
    points: [], entry: { x: 1, z: 1, yaw: 0 }, roomDoors, residential: true,
    occupants: { day: [0, 0], night: [0, 0], profile: 'residentInnocent', role: 'resident', openHours: null },
  };
}

/** Two rooms side by side (A: x 0..5, B: x 5..10, z 0..5) joined by door 0 at (5, 2.5); exterior door 1 on A's front (z = 0). */
export function twoRooms(furniture: FurnitureItem[] = []): InteriorLayout {
  const rect = { minX: 0, minZ: 0, maxX: 10, maxZ: 5 };
  return layoutOf(
    rect,
    [room(0, 'living', { minX: 0, minZ: 0, maxX: 5, maxZ: 5 }, 'wood'), room(1, 'bedroom', { minX: 5, minZ: 0, maxX: 10, maxZ: 5 }, 'carpet')],
    [door(0, 0, 1, 5, 2.5, 'z'), door(1, 0, -1, 2.5, 0, 'x', { main: true })],
    [5, 0, 5, 2.05, 5, 2.95, 5, 5, 0, 0, 2.05, 0, 2.95, 0, 10, 0, 0, 5, 10, 5, 0, 0, 0, 5, 10, 0, 10, 5],
    furniture,
  );
}

/** A (0..5, 0..5) and B (5..10, 0..5) joined by a door; C (0..10, 5..10) shares walls with both, door B-C only. No A-C door. */
export function threeRooms(): InteriorLayout {
  const rect = { minX: 0, minZ: 0, maxX: 10, maxZ: 10 };
  return layoutOf(
    rect,
    [
      room(0, 'living', { minX: 0, minZ: 0, maxX: 5, maxZ: 5 }),
      room(1, 'kitchen', { minX: 5, minZ: 0, maxX: 10, maxZ: 5 }),
      room(2, 'bedroom', { minX: 0, minZ: 5, maxX: 10, maxZ: 10 }),
    ],
    [door(0, 0, 1, 5, 2.5, 'z'), door(1, 1, 2, 7.5, 5, 'x')],
    [5, 0, 5, 2.05, 5, 2.95, 5, 5, 0, 5, 7.05, 5, 7.95, 5, 10, 5],
  );
}

/** Stub of the InteriorSystem's query surface. */
export class StubInteriors implements InteriorQuery {
  officerBuilding = -1;
  readonly layouts = new Map<number, InteriorLayout>();
  /** Keyed by building * 1024 + door (no per-call string keys: the allocation test uses this stub). */
  readonly states = new Map<number, DoorStateName>();
  readonly revisions = new Map<number, number>();
  readonly unlit = new Set<number>();
  stateCalls = 0;

  constructor(entries: readonly [number, InteriorLayout][] = []) {
    for (const [id, l] of entries) this.layouts.set(id, l);
  }
  layout(id: number): InteriorLayout | null {
    return this.layouts.get(id) ?? null;
  }
  doorState(id: number, door: number): DoorStateName {
    this.stateCalls++;
    const s = this.states.get(id * 1024 + door);
    if (s !== undefined) return s;
    return this.layouts.get(id)?.doors[door]?.kind === 'wide' ? 'open' : 'closed';
  }
  doorRevision(id: number): number {
    return this.revisions.get(id) ?? 0;
  }
  roomLit(id: number, room: number): boolean {
    return !this.unlit.has(id * 1024 + room);
  }
  /** Changes a door without bumping the revision (what a stale cache would miss). */
  setDoorQuiet(id: number, door: number, state: DoorStateName): void {
    this.states.set(id * 1024 + door, state);
  }
  setDoor(id: number, door: number, state: DoorStateName): void {
    this.states.set(id * 1024 + door, state);
    this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1);
  }
}

export interface Stimulus {
  actorId: number;
  kind: 'sound' | 'sight' | 'light';
  amount: number;
}

/** Listener port with a fixed set of actors; records every stimulation. */
export class StubListeners implements ListenerPort {
  readonly actors: Listener[] = [];
  readonly calls: Stimulus[] = [];
  /** Level new listeners start on (the rig's building). */
  defaultBuilding = -1;

  add(over: Partial<Listener>): Listener {
    const l = { ...createListener(), building: this.defaultBuilding, actorId: this.actors.length + 1, ...over };
    this.actors.push(l);
    return l;
  }
  listeners(x: number, z: number, radius: number, out: Listener[]): number {
    let n = 0;
    for (const a of this.actors) {
      if (Math.hypot(a.x - x, a.z - z) > radius) continue;
      if (n >= out.length) break;
      const o = out[n] as Listener;
      Object.assign(o, a);
      n++;
    }
    return n;
  }
  stimulate(actorId: number, kind: 'sound' | 'sight' | 'light', amount: number): void {
    this.calls.push({ actorId, kind, amount });
  }
  of(actorId: number, kind: Stimulus['kind']): Stimulus[] {
    return this.calls.filter((c) => c.actorId === actorId && c.kind === kind);
  }
}

export interface Rig {
  sys: TacticalSystem;
  bus: EventBus<EventMap>;
  interiors: StubInteriors;
  port: StubListeners;
  officer: OfficerPose;
  earpiece: { on: boolean };
  night: { value: number };
}

const stubCity = { surfaceAt: () => 0 } as unknown as City;

export function makeRig(layout: InteriorLayout | null, building = 1, seed = 7, hasFlashlight?: () => boolean): Rig {
  const bus = new EventBus<EventMap>();
  const interiors = new StubInteriors(layout === null ? [] : [[building, layout]]);
  const port = new StubListeners();
  const officer: OfficerPose = { x: 2, z: 2, yaw: 0, pitch: 0, building: layout === null ? -1 : building, speed: 0, onFoot: true };
  const earpiece = { on: false };
  const night = { value: 0 };
  const deps: TacticalDeps = {
    seed,
    bus,
    rng: createRng(seed).stream('tactical'),
    city: stubCity,
    interiors,
    listeners: port,
    officer: (out) => Object.assign(out, officer),
    radioEarpiece: () => earpiece.on,
    nightFactor: () => night.value,
    ...(hasFlashlight ? { hasFlashlight } : {}),
    config: TACTICS,
  };
  port.defaultBuilding = officer.building;
  return { sys: new TacticalSystem(deps), bus, interiors, port, officer, earpiece, night };
}

export const T0 = { sim: 0, game: 0 };
