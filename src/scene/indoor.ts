/**
 * Indoor calls (Phase 4 design §12.1-§12.2): which calls bind to a real building (`src/data/scene/indoor.json`,
 * validated at import against the call catalog, the room kinds and the item ids) and the pure placement plan
 * of a bound scene inside its interior layout. Everything here is a function of (seed, call id, layout): the
 * plan draws no random numbers (integer hashes only), so the scene stream is untouched.
 */
import indoorJson from '../data/scene/indoor.json';
import { CALL_CATALOG, ITEM_IDS, type CallCatalog, type Spot } from '../calls';
import { BUILDING_KINDS, type BuildingKind } from '../interior/kinds';
import { ROOM_KINDS, type Container, type InteriorLayout, type RoomKind } from '../interior/types';
import { unitHash } from '../records/hash';
import { fail, readArray, readNumber, readObject, readOneOf, readString, readVersion, type JsonObject } from '../vehicles/json';

const FILE = 'indoor.json';

// --- Data --------------------------------------------------------------------------------------------

/** Where an indoor evidence item lies: loose on the floor, on a furniture surface, or concealed inside a container. */
export const EVIDENCE_WHERE = ['floor', 'surface', 'container'] as const;
export type EvidenceWhere = (typeof EVIDENCE_WHERE)[number];

export interface IndoorEvidenceDef {
  readonly item: string;
  readonly rooms: readonly RoomKind[];
  readonly chance: number;
  readonly where: EvidenceWhere;
}

/** Indoor rules of a call family. */
export interface IndoorFamily {
  readonly id: string;
  readonly kinds: readonly BuildingKind[];
  /** Preferred room kinds per participant role, in order. */
  readonly rooms: Readonly<Record<string, readonly RoomKind[]>>;
  /** Roles at the `door` spot that are inside the building instead. */
  readonly moveInside: readonly string[];
  readonly evidence: readonly IndoorEvidenceDef[];
  /** Chance the main door is locked when the scene starts. */
  readonly doorLocked: number;
}

/** A call type that binds to a building whatever its family says. */
export interface IndoorType {
  readonly id: string;
  readonly kinds: readonly BuildingKind[];
  /** The type's catalog family (checked), null when not stated. */
  readonly family: string | null;
}

export interface IndoorConfig {
  readonly families: Readonly<Record<string, IndoorFamily>>;
  readonly types: Readonly<Record<string, IndoorType>>;
  readonly excludeTypes: readonly string[];
}

function section(o: JsonObject, path: string, allowed: readonly string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(FILE, `${path}.${k}`, `is not one of ${allowed.join(', ')}`);
}

function readKinds(value: unknown, path: string): BuildingKind[] {
  const list = readArray(value, FILE, path, 1).map((v, i) => readOneOf(v, BUILDING_KINDS, FILE, `${path}[${i}]`));
  list.forEach((k, i) => {
    if (list.indexOf(k) !== i) fail(FILE, `${path}[${i}]`, `repeats ${k}`);
  });
  return list;
}

function readRooms(value: unknown, path: string, min: number): RoomKind[] {
  return readArray(value, FILE, path, min).map((v, i) => readOneOf(v, ROOM_KINDS, FILE, `${path}[${i}]`));
}

/**
 * Validates `indoor.json` against the call catalog: family ids, type ids, role ids, building kinds, room kinds and
 * item ids are all checked; unknown fields are rejected. Throws an `Error` naming the file and the JSON path.
 */
export function validateIndoor(json: unknown, catalog: CallCatalog = CALL_CATALOG): IndoorConfig {
  const root = readObject(json, FILE, '');
  readVersion(root, FILE);
  section(root, '', ['version', 'families', 'types', 'excludeTypes']);
  const families: Record<string, IndoorFamily> = {};
  for (const [id, raw] of Object.entries(readObject(root.families, FILE, 'families'))) {
    const path = `families.${id}`;
    const def = catalog.families.find((f) => f.id === id);
    if (!def) fail(FILE, path, `is not a family of the call catalog`);
    const o = readObject(raw, FILE, path);
    section(o, path, ['kinds', 'rooms', 'moveInside', 'evidence', 'doorLocked']);
    const roleOk = (role: string, p: string): void => {
      if (!def.roles.some((r) => r.role === role)) fail(FILE, p, `role "${role}" is not a role of family ${id}`);
    };
    const rooms: Record<string, RoomKind[]> = {};
    for (const [role, list] of Object.entries(readObject(o.rooms, FILE, `${path}.rooms`))) {
      roleOk(role, `${path}.rooms.${role}`);
      rooms[role] = readRooms(list, `${path}.rooms.${role}`, 1);
    }
    const moveInside =
      o.moveInside === undefined
        ? []
        : readArray(o.moveInside, FILE, `${path}.moveInside`).map((v, i) => {
            const role = readString(v, FILE, `${path}.moveInside[${i}]`);
            roleOk(role, `${path}.moveInside[${i}]`);
            return role;
          });
    const evidence =
      o.evidence === undefined
        ? []
        : readArray(o.evidence, FILE, `${path}.evidence`).map((v, i): IndoorEvidenceDef => {
            const p = `${path}.evidence[${i}]`;
            const e = readObject(v, FILE, p);
            section(e, p, ['item', 'rooms', 'chance', 'where']);
            const item = readString(e.item, FILE, `${p}.item`);
            if (!(ITEM_IDS as readonly string[]).includes(item)) fail(FILE, `${p}.item`, `is not an item id, got "${item}"`);
            return {
              item,
              rooms: readRooms(e.rooms, `${p}.rooms`, 1),
              chance: readNumber(e.chance, FILE, `${p}.chance`, 0, 1),
              where: readOneOf(e.where, EVIDENCE_WHERE, FILE, `${p}.where`),
            };
          });
    families[id] = { id, kinds: readKinds(o.kinds, `${path}.kinds`), rooms, moveInside, evidence, doorLocked: readNumber(o.doorLocked, FILE, `${path}.doorLocked`, 0, 1) };
  }
  const types: Record<string, IndoorType> = {};
  for (const [id, raw] of Object.entries(readObject(root.types, FILE, 'types'))) {
    const path = `types.${id}`;
    const type = catalog.types.find((t) => t.id === id);
    if (!type) fail(FILE, path, 'is not a call type of the catalog');
    const o = readObject(raw, FILE, path);
    section(o, path, ['kinds', 'family']);
    let family: string | null = null;
    if (o.family !== undefined) {
      family = readString(o.family, FILE, `${path}.family`);
      if (family !== type.family) fail(FILE, `${path}.family`, `must be the catalog family of ${id} ("${type.family}"), got "${family}"`);
    }
    types[id] = { id, kinds: readKinds(o.kinds, `${path}.kinds`), family };
  }
  const excludeTypes = readArray(root.excludeTypes, FILE, 'excludeTypes').map((v, i) => {
    const id = readString(v, FILE, `excludeTypes[${i}]`);
    if (!catalog.types.some((t) => t.id === id)) fail(FILE, `excludeTypes[${i}]`, `is not a call type of the catalog, got "${id}"`);
    return id;
  });
  return { families, types, excludeTypes };
}

/** The validated indoor rules (`src/data/scene/indoor.json`). */
export const INDOOR: IndoorConfig = validateIndoor(indoorJson);

// --- Binding -----------------------------------------------------------------------------------------

/** Building class used by the binding fallback: a residential call may use any residential building, and so on. */
const KIND_CLASS: Readonly<Partial<Record<BuildingKind, 'residential' | 'commercial'>>> = {
  house: 'residential',
  apartment: 'residential',
  convenienceStore: 'commercial',
  bank: 'commercial',
  bar: 'commercial',
  office: 'commercial',
  warehouse: 'commercial',
};

/**
 * The building kinds a call of `typeId` (catalog family `familyId`, CAD location kind `location`) may bind to, null
 * when it stays outdoors. A listed type binds always; otherwise its family must be listed, the type not excluded
 * and its location neither `road` nor `poi:*`.
 */
export function bindingKinds(cfg: IndoorConfig, typeId: string, familyId: string, location: string): readonly BuildingKind[] | null {
  if (Object.hasOwn(cfg.types, typeId)) return cfg.types[typeId]?.kinds ?? null;
  if (cfg.excludeTypes.includes(typeId)) return null;
  if (location === 'road' || location.startsWith('poi:')) return null;
  return Object.hasOwn(cfg.families, familyId) ? (cfg.families[familyId]?.kinds ?? null) : null;
}

/** Other enterable kinds of the same class(es) as `kinds` (the binding fallback), empty when none have a class. */
export function fallbackKinds(kinds: readonly BuildingKind[]): BuildingKind[] {
  const classes = new Set<string>();
  for (const k of kinds) {
    const c = KIND_CLASS[k];
    if (c !== undefined) classes.add(c);
  }
  return BUILDING_KINDS.filter((k) => {
    const c = KIND_CLASS[k];
    return c !== undefined && classes.has(c) && !kinds.includes(k);
  });
}

/** Indoor rules of a catalog family (null: none listed). */
export function indoorFamily(cfg: IndoorConfig, familyId: string): IndoorFamily | null {
  return Object.hasOwn(cfg.families, familyId) ? (cfg.families[familyId] ?? null) : null;
}

// --- Placement plan ----------------------------------------------------------------------------------

const SALT_PLACE = 0x51c0;
const SALT_LOCK = 0x51ce;
const SALT_ITEM_ROLL = 0x51d0;
const SALT_ITEM_PICK = 0x51d8;
/** Room kinds that connect the units of an apartment block but are nobody's home (a scene stays in one unit). */
const CONNECTORS: readonly RoomKind[] = ['corridor', 'hallway', 'lobby', 'mailroom', 'laundry', 'stairwell', 'deck'];
/** Spacing of people standing side by side at the door (m). */
const DOOR_SPACING = 1.2;

/** The entry room of a layout (side `a` of the main door). */
export function entryRoom(layout: InteriorLayout): number {
  return layout.doors.find((d) => d.main)?.a ?? 0;
}

/** Index of the main (front) door, -1 when the layout has none. */
export function mainDoor(layout: InteriorLayout): number {
  return layout.doors.findIndex((d) => d.main);
}

/** Whether the main door of `callId` starts locked: `unitHash(seed, 0x51ce, callId) < doorLocked`. */
export function lockRoll(seed: number, callId: number, doorLocked: number): boolean {
  return doorLocked >= 1 || unitHash(seed, SALT_LOCK, callId) < doorLocked;
}

/**
 * Rooms of the scene zone around `room`. In an apartment block a zone is one unit (the rooms reachable through doors
 * without crossing a corridor, mail room or laundry); every other building is one zone.
 */
export function zoneOf(layout: InteriorLayout, room: number): Set<number> {
  const zone = new Set<number>([room]);
  const queue = [room];
  while (queue.length > 0) {
    const r = queue.pop() as number;
    for (const di of layout.roomDoors[r] ?? []) {
      const d = layout.doors[di];
      if (!d) continue;
      const other = d.a === r ? d.b : d.a;
      const kind = other >= 0 ? layout.rooms[other]?.kind : undefined;
      if (other < 0 || kind === undefined || zone.has(other) || (layout.kind === 'apartment' && CONNECTORS.includes(kind))) continue;
      zone.add(other);
      queue.push(other);
    }
  }
  return zone;
}

function pickOf<T>(list: readonly T[], u: number): T | undefined {
  return list[Math.min(list.length - 1, Math.floor(u * list.length))];
}

/**
 * Index of a spawn spot: the first preferred room kind (in order) that has a free spot of the wanted pose, in the
 * scene zone when there is one; else any free spot outside the entry room; else any free spot. `lying` wants a
 * `lying` spot (falls back to a standing / sitting one), otherwise lying spots are not used. -1 when none.
 */
export function pickSpawn(
  layout: InteriorLayout,
  prefs: readonly RoomKind[],
  lying: boolean,
  zone: ReadonlySet<number> | null,
  used: ReadonlySet<number>,
  u: number,
): number {
  const entry = entryRoom(layout);
  const spots = layout.spawnSpots;
  const candidates = (poseOk: (lie: boolean) => boolean, roomOk: (room: number) => boolean): number[] => {
    const out: number[] = [];
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      if (s && !used.has(i) && poseOk(s.pose === 'lying') && roomOk(s.room)) out.push(i);
    }
    return out;
  };
  const kindOf = (room: number): RoomKind | undefined => layout.rooms[room]?.kind;
  const attempt = (poseOk: (lie: boolean) => boolean): number => {
    const inZone = (r: number): boolean => zone?.has(r) ?? true;
    const tiers: ((r: number) => boolean)[] = [];
    for (const k of prefs) tiers.push((r) => kindOf(r) === k && inZone(r));
    if (zone !== null) tiers.push((r) => r !== entry && inZone(r));
    for (const k of prefs) tiers.push((r) => kindOf(r) === k);
    tiers.push((r) => r !== entry, () => true);
    for (const tier of tiers) {
      const c = candidates(poseOk, tier);
      if (c.length > 0) return pickOf(c, u) ?? -1;
    }
    return -1;
  };
  if (lying) {
    const i = attempt((lie) => lie);
    if (i >= 0) return i;
  }
  return attempt((lie) => !lie);
}

/** Index of a hiding spot: preferred room kinds first, then outside the entry room, then any; free spots only. -1 when none. */
export function pickHiding(
  layout: InteriorLayout,
  prefs: readonly RoomKind[],
  zone: ReadonlySet<number> | null,
  used: ReadonlySet<number>,
  u: number,
): number {
  const entry = entryRoom(layout);
  const spots = layout.hidingSpots;
  const candidates = (roomOk: (room: number) => boolean): number[] => {
    const out: number[] = [];
    for (let i = 0; i < spots.length; i++) {
      const s = spots[i];
      if (s && !used.has(i) && roomOk(s.room)) out.push(i);
    }
    return out;
  };
  const inZone = (r: number): boolean => zone?.has(r) ?? true;
  const tiers: ((r: number) => boolean)[] = [];
  for (const k of prefs) tiers.push((r) => layout.rooms[r]?.kind === k && inZone(r));
  if (zone !== null) tiers.push((r) => r !== entry && inZone(r));
  for (const k of prefs) tiers.push((r) => layout.rooms[r]?.kind === k);
  tiers.push((r) => r !== entry, () => true);
  for (const tier of tiers) {
    const c = candidates(tier);
    if (c.length > 0) return pickOf(c, u) ?? -1;
  }
  return -1;
}

/** Index of an item spot of the wanted kind (`where`): preferred rooms first (in the zone), then any. -1 when none. */
export function pickItemSpot(
  layout: InteriorLayout,
  where: EvidenceWhere,
  prefs: readonly RoomKind[],
  zone: ReadonlySet<number> | null,
  used: ReadonlySet<number>,
  u: number,
): number {
  const spots = layout.itemSpots;
  const fits = (i: number): boolean => {
    const s = spots[i];
    if (!s || used.has(i)) return false;
    if (where === 'floor') return s.furniture < 0 && !s.concealed;
    if (where === 'surface') return s.furniture >= 0 && !s.concealed && s.container === 'none';
    return s.concealed && s.container !== 'none';
  };
  const candidates = (roomOk: (room: number) => boolean): number[] => {
    const out: number[] = [];
    for (let i = 0; i < spots.length; i++) if (fits(i) && roomOk(spots[i]?.room ?? -1)) out.push(i);
    return out;
  };
  const inZone = (r: number): boolean => zone?.has(r) ?? true;
  const isPref = (r: number): boolean => prefs.includes(layout.rooms[r]?.kind as RoomKind);
  const tiers: ((room: number) => boolean)[] = [(r) => isPref(r) && inZone(r)];
  if (zone !== null) tiers.push(inZone);
  tiers.push(isPref, () => true);
  for (const tier of tiers) {
    const c = candidates(tier);
    if (c.length > 0) return pickOf(c, u) ?? -1;
  }
  return -1;
}

export interface PlanParticipant {
  readonly index: number;
  readonly role: string;
  readonly spot: Spot;
  /** Lies on the floor (deceased, unconscious). */
  readonly lying: boolean;
  /** Not present in this scene (removed role): nothing is planned. */
  readonly skip: boolean;
}

export interface IndoorPlace {
  readonly index: number;
  /** `inside`: stands in a room; `hidden`: in a hiding spot; `door`: outdoors at the main door. */
  readonly mode: 'inside' | 'hidden' | 'door';
  /** Spawn spot (inside) or hiding spot (hidden) index, -1 for a door. */
  readonly spotIndex: number;
  readonly room: number;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly pose: 'stand' | 'sit' | 'lying';
}

export interface IndoorItem {
  readonly item: string;
  readonly where: EvidenceWhere;
  readonly itemSpot: number;
  readonly room: number;
  readonly furniture: number;
  readonly container: Container;
  readonly concealed: boolean;
  readonly x: number;
  /** Metres above the floor. */
  readonly y: number;
  readonly z: number;
}

export interface IndoorPlan {
  /** One entry per participant that is placed by the plan (others keep the Phase 3 spots). */
  readonly places: readonly IndoorPlace[];
  readonly items: readonly IndoorItem[];
}

/** Pose at the main door: the n-th person at the door stands beside the previous ones (alternating sides). */
export function doorSlot(exit: { x: number; z: number; yaw: number }, n: number, out: { x: number; z: number; yaw: number }): void {
  const offset = n === 0 ? 0 : (n % 2 === 1 ? 1 : -1) * Math.ceil(n / 2) * DOOR_SPACING;
  // Along the wall: perpendicular to the outward direction (-sin yaw, -cos yaw).
  out.x = exit.x + Math.cos(exit.yaw) * offset;
  out.z = exit.z - Math.sin(exit.yaw) * offset;
  out.yaw = exit.yaw;
}

/**
 * Places the participants and indoor evidence of call `callId` in `layout`. Inside and moved-inside roles get a
 * spawn spot in the first preferred room (all in one zone of connected rooms), hidden roles a hiding spot, door
 * roles stand at the main door's outdoor pose. A participant for whom nothing fits is left out of `places`.
 */
export function planInterior(seed: number, callId: number, layout: InteriorLayout, family: IndoorFamily | null, participants: readonly PlanParticipant[]): IndoorPlan {
  const places: IndoorPlace[] = [];
  const usedSpawn = new Set<number>();
  const usedHide = new Set<number>();
  const main = layout.doors.find((d) => d.main);
  let zone: Set<number> | null = null;
  let doorCount = 0;
  for (const p of participants) {
    if (p.skip) continue;
    const u = unitHash(seed, SALT_PLACE, callId * 64 + p.index);
    const prefs = family?.rooms[p.role] ?? [];
    const inside = p.spot === 'inside' || (p.spot === 'door' && (family?.moveInside.includes(p.role) ?? false));
    if (inside) {
      const i = pickSpawn(layout, prefs, p.lying, zone, usedSpawn, u);
      const s = layout.spawnSpots[i];
      if (!s) continue;
      usedSpawn.add(i);
      zone ??= zoneOf(layout, s.room);
      places.push({ index: p.index, mode: 'inside', spotIndex: i, room: s.room, x: s.x, z: s.z, yaw: s.yaw, pose: p.lying ? 'lying' : s.pose });
    } else if (p.spot === 'hidden') {
      const i = pickHiding(layout, prefs, zone, usedHide, u);
      const h = layout.hidingSpots[i];
      if (!h) continue;
      usedHide.add(i);
      zone ??= zoneOf(layout, h.room);
      places.push({ index: p.index, mode: 'hidden', spotIndex: i, room: h.room, x: h.x, z: h.z, yaw: h.yaw, pose: 'stand' });
    } else if (p.spot === 'door' && main?.exit) {
      const pose = { x: 0, z: 0, yaw: 0 };
      doorSlot(main.exit, doorCount++, pose);
      places.push({ index: p.index, mode: 'door', spotIndex: -1, room: -1, x: pose.x, z: pose.z, yaw: pose.yaw, pose: 'stand' });
    }
  }
  const items: IndoorItem[] = [];
  const usedItems = new Set<number>();
  (family?.evidence ?? []).forEach((e, k) => {
    if (unitHash(seed, SALT_ITEM_ROLL + k, callId) >= e.chance) return;
    const i = pickItemSpot(layout, e.where, e.rooms, zone, usedItems, unitHash(seed, SALT_ITEM_PICK + k, callId));
    const s = layout.itemSpots[i];
    if (!s) return;
    usedItems.add(i);
    items.push({ item: e.item, where: e.where, itemSpot: i, room: s.room, furniture: s.furniture, container: s.container, concealed: s.concealed, x: s.x, y: s.y, z: s.z });
  });
  return { places, items };
}
