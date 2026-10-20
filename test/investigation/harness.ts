import type { EventMap } from '../../src/core/event-map';
import { EventBus } from '../../src/core/events';
import { createRng } from '../../src/core/rng';
import { generateInterior } from '../../src/interior/generate';
import { lineOfSight } from '../../src/interior/los';
import type { FurnitureItem, InteriorLayout } from '../../src/interior/types';
import { InvestigationSystem } from '../../src/investigation/investigationSystem';
import '../../src/investigation/events';
import '../../src/scene/events';
import type {
  CallContext,
  InvestigationOfficer,
  InvestigationPorts,
  NoGoZone,
  PlaceItemSpec,
} from '../../src/investigation/types';
import { handBuilding } from '../interior/helpers';

export const SEED = 42;
export const DT = 1 / 60;
export const BADGE = '4417';

const TOPICS = [
  'investigation:marker',
  'investigation:photo',
  'investigation:plainView',
  'investigation:found',
  'investigation:collected',
  'investigation:custody',
  'investigation:custodyComplete',
  'investigation:tape',
  'investigation:canvass',
  'investigation:k9Alert',
  'investigation:bodycam',
  'investigation:print',
  'investigation:radio',
  'investigation:flash',
] as const;

export interface Recorded {
  topic: string;
  payload: Record<string, unknown>;
}

/** The state behind the stub ports; tests change it freely. */
export interface World {
  call: number;
  kit: Record<string, number>;
  worn: boolean;
  night: number;
  /** Rooms that are dark; everything else is lit. */
  dark: Set<number>;
  doorsOpen: boolean;
  open: boolean;
  calls: Map<number, CallContext>;
  hidden: { actorId: number; x: number; z: number }[];
  spawned: { buildingId: number; personId: number; callId: number; role: string }[];
  zones: NoGoZone[];
  zoneCalls: number;
  /** Custodian id of the trunk within reach, '' when none. */
  trunk: string;
}

export interface Harness {
  sys: InvestigationSystem;
  bus: EventBus<EventMap>;
  layout: InteriorLayout;
  neighbor: InteriorLayout;
  off: InvestigationOfficer;
  world: World;
  events: Recorded[];
  sim: number;
  game: number;
  /** One fixed step. */
  step(): void;
  run(seconds: number): void;
  of(topic: string): Recorded[];
  flashes(): string[];
}

export function houseLayout(id = 900_000, cx = 100.013, cz = -200.027): InteriorLayout {
  const b = handBuilding('house', 16, 14, 0, id, cx, cz);
  const l = generateInterior(SEED, b);
  if (l === null) throw new Error('no house layout');
  return l;
}

export function makeHarness(): Harness {
  const layout = houseLayout();
  const neighbor = houseLayout(900_001, 140.013, -200.027);
  const bus = new EventBus<EventMap>();
  const world: World = {
    call: 42,
    kit: { evidenceMarkers: 20, evidenceBags: 20, fingerprintKit: 1, camera: 1, sceneTape: 1 },
    worn: true,
    night: 0,
    dark: new Set(),
    doorsOpen: false,
    open: false,
    calls: new Map(),
    hidden: [],
    spawned: [],
    zones: [],
    zoneCalls: 0,
    trunk: '',
  };
  const defaultCall = (): CallContext => ({
    exigency: false,
    warrant: false,
    arrests: [],
    buildingId: layout.buildingId,
    family: 'property',
    suspectPersonId: 7,
    anchorX: (layout.rect.minX + layout.rect.maxX) / 2,
    anchorZ: (layout.rect.minZ + layout.rect.maxZ) / 2,
  });
  const layouts = new Map<number, InteriorLayout>([
    [layout.buildingId, layout],
    [neighbor.buildingId, neighbor],
  ]);
  const ports: InvestigationPorts = {
    trunkLocker: () => world.trunk,
    callContext: (callId) => world.calls.get(callId) ?? (callId > 0 ? defaultCall() : null),
    currentCall: () => world.call,
    incidentOf: (callId) => `C-${String(callId).padStart(5, '0')}`,
    spawnResident: (buildingId, personId, callId, role) => {
      world.spawned.push({ buildingId, personId, callId, role });
      return 100 + world.spawned.length;
    },
    residentOf: (buildingId, index) => 1000 + (buildingId % 100) * 10 + index,
    hiddenActors: (_b, out) => {
      world.hidden.forEach((h, i) => {
        const slot = out[i];
        if (slot) Object.assign(slot, h);
      });
      return world.hidden.length;
    },
    setNoGoZones: (zones) => {
      world.zones = [...zones];
      world.zoneCalls++;
    },
    kit: () => ({
      carried: (item) => world.kit[item] ?? 0,
      use: (item, n) => {
        if ((world.kit[item] ?? 0) < n) return false;
        world.kit[item] = (world.kit[item] ?? 0) - n;
        return true;
      },
      give: (item, n) => {
        world.kit[item] = (world.kit[item] ?? 0) + n;
        return true;
      },
    }),
    bodycamWorn: () => world.worn,
    nightFactor: () => world.night,
    lineOfSight: (building, ax, ay, az, bx, by, bz, ignore) => {
      const l = layouts.get(building);
      return l ? lineOfSight(l, () => world.doorsOpen, ax, ay, az, bx, by, bz, ignore) : true;
    },
    roomLit: (_b, room) => !world.dark.has(room),
    businessOpen: () => world.open,
    layout: (b) => layouts.get(b) ?? null,
    addressOf: (b) => (b >= 0 ? `${String(1400 + (b % 100))} Oak St` : ''),
    describeDirection: () => 'north on Elm St',
    describePerson: () => 'a tall man in a red jacket',
  };
  const off: InvestigationOfficer = {
    x: 0, y: 0, z: 0, yaw: 0, pitch: 0, building: -1, room: -1, onFoot: true, badge: BADGE, flashlight: false,
  };
  const sys = new InvestigationSystem({
    seed: SEED,
    bus,
    rng: createRng(SEED).stream('investigation'),
    ports,
    officer: (out) => Object.assign(out, off),
  });
  const events: Recorded[] = [];
  for (const topic of TOPICS) {
    bus.on(topic, (payload) => {
      events.push({ topic, payload: payload as unknown as Record<string, unknown> });
    });
  }
  const h: Harness = {
    sys, bus, layout, neighbor, off, world, events, sim: 0, game: 10 * 3600,
    step() {
      sys.step(DT, { sim: h.sim, game: h.game });
      h.sim += DT;
      h.game += DT;
    },
    run(seconds) {
      const n = Math.round(seconds / DT);
      for (let i = 0; i < n; i++) h.step();
    },
    of: (topic) => events.filter((e) => e.topic === topic),
    flashes: () => events.filter((e) => e.topic === 'investigation:flash').map((e) => String(e.payload['text'])),
  };
  return h;
}

/** Places the officer at (x, z) in `building` (the house by default) facing `yaw`. */
export function stand(h: Harness, x: number, z: number, room: number, yaw = 0, building = h.layout.buildingId): void {
  h.off.x = x;
  h.off.z = z;
  h.off.y = building >= 0 ? -40 : 0;
  h.off.yaw = yaw;
  h.off.building = building;
  h.off.room = room;
}

/** Yaw that faces (tx, tz) from (x, z). */
export function yawTo(x: number, z: number, tx: number, tz: number): number {
  return Math.atan2(-(tx - x), -(tz - z));
}

export function standAt(h: Harness, f: FurnitureItem): void {
  stand(h, f.x, f.z, f.room);
}

export function placeSpec(h: Harness, over: Partial<PlaceItemSpec> = {}): PlaceItemSpec {
  return {
    callId: 42,
    item: 'knife',
    label: 'Knife',
    x: 0,
    y: 0.05,
    z: 0,
    buildingId: h.layout.buildingId,
    room: 0,
    furniture: -1,
    container: 'none',
    concealed: false,
    ownerPersonId: 7,
    incriminating: true,
    ...over,
  };
}

/** Free points of a room (not inside furniture, 0.4 m from walls). */
export function freeSpots(layout: InteriorLayout, room: number): { x: number; z: number }[] {
  const r = (layout.rooms[room] as InteriorLayout['rooms'][number]).rect;
  const out: { x: number; z: number }[] = [];
  for (let x = r.minX + 0.5; x <= r.maxX - 0.5; x += 0.5) {
    for (let z = r.minZ + 0.5; z <= r.maxZ - 0.5; z += 0.5) {
      const blocked = layout.furniture.some((f) => x > f.minX - 0.4 && x < f.maxX + 0.4 && z > f.minZ - 0.4 && z < f.maxZ + 0.4);
      if (!blocked) out.push({ x, z });
    }
  }
  return out;
}

/** An officer spot and an item spot 2-4 m apart in one room with a clear sight line (eye 1.6 m, item 0.1 m). */
export function clearPair(layout: InteriorLayout, room: number): { officer: { x: number; z: number }; item: { x: number; z: number } } {
  const spots = freeSpots(layout, room);
  for (const a of spots) {
    for (const b of spots) {
      const d = Math.hypot(a.x - b.x, a.z - b.z);
      if (d < 2 || d > 4) continue;
      if (lineOfSight(layout, () => false, a.x, 1.6, a.z, b.x, 0.1, b.z, -1)) return { officer: a, item: b };
    }
  }
  throw new Error(`no clear pair in room ${String(room)}`);
}

export function roomArea(layout: InteriorLayout, room: number): number {
  const r = (layout.rooms[room] as InteriorLayout['rooms'][number]).rect;
  return (r.maxX - r.minX) * (r.maxZ - r.minZ);
}

/** Index of the largest room. */
export function bigRoom(layout: InteriorLayout): number {
  let best = 0;
  for (let i = 1; i < layout.rooms.length; i++) if (roomArea(layout, i) > roomArea(layout, best)) best = i;
  return best;
}

/** Furniture with a drawer in each bedroom (one per bedroom). */
export function nightstands(layout: InteriorLayout): FurnitureItem[] {
  return layout.furniture.filter((f) => f.container === 'drawer' && layout.rooms[f.room]?.kind === 'bedroom');
}
