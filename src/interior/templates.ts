/**
 * Interior data (design §5.4): the furniture catalog and one room template per building kind, validated at
 * import. Every validation error names the file and the JSON path (`house.json: rooms[2].furniture[0].id ...`).
 */
import furnitureJson from '../data/interior/furniture.json';
import {
  fail,
  readArray,
  readBoolean,
  readNumber,
  readObject,
  readOneOf,
  readString,
  readVersion,
  type JsonObject,
} from '../vehicles/json';
import { BUILDING_KINDS, type BuildingKind } from './kinds';
import {
  CONTAINERS,
  HIDE_KINDS,
  POINT_KINDS,
  PRINT_SURFACES,
  ROOM_KINDS,
  SURFACE_KINDS,
  type Container,
  type FloorSurface,
  type HideKind,
  type OccupancySpec,
  type OccupantRole,
  type PointKind,
  type PrintSurface,
  type RoomKind,
} from './types';

// --- Shapes ----------------------------------------------------------------------------------

export interface FurnitureDef {
  readonly id: string;
  readonly w: number;
  readonly d: number;
  readonly h: number;
  readonly color: number;
  readonly solid: boolean;
  readonly surface: PrintSurface | null;
  readonly container: Container;
  readonly hide: HideKind | null;
  readonly seat: 'sit' | 'lie' | null;
}

export const FURNITURE_PLACES = ['wall', 'corner', 'center'] as const;
export type FurniturePlace = (typeof FURNITURE_PLACES)[number];

export interface FurnitureEntry {
  readonly id: string;
  readonly place: FurniturePlace;
  readonly count: readonly [number, number];
  readonly chance: number;
  readonly point: PointKind | null;
}

export const BANDS = ['front', 'back'] as const;
export type Band = (typeof BANDS)[number];

export interface RoomDef {
  readonly kind: RoomKind;
  readonly label: string;
  readonly size: number;
  readonly required: boolean;
  readonly count: readonly [number, number];
  /** Probability of an optional room existing. */
  readonly chance: number;
  /** Corridor layouts: the band the room sits in. */
  readonly band: Band | null;
  readonly surface: FloorSurface;
  readonly public: boolean;
  readonly light: boolean;
  /** A slab that is BSP-split into these room kinds; the kinds are described by `child` defs. */
  readonly suite: readonly RoomKind[] | null;
  /** Part of a suite: never placed on its own, only supplies label, surface and furniture. */
  readonly child: boolean;
  readonly furniture: readonly FurnitureEntry[];
}

export const DOOR_SIDES = ['front', 'back', 'left', 'right'] as const;
export type DoorSide = (typeof DOOR_SIDES)[number];

export interface ExteriorDoorDef {
  readonly room: RoomKind;
  readonly side: DoorSide;
  readonly width: number | null;
  readonly chance: number;
}

export interface CorridorDef {
  readonly kind: RoomKind;
  readonly label: string;
  readonly width: number;
  readonly frontShare: number;
  readonly surface: FloorSurface;
}

export const LAYOUTS = ['bsp', 'corridor'] as const;
export type LayoutKind = (typeof LAYOUTS)[number];

export interface BuildingTemplate {
  readonly kind: BuildingKind;
  readonly label: string;
  readonly layout: LayoutKind;
  readonly minWidth: number;
  readonly minDepth: number;
  readonly maxWidth: number;
  readonly maxDepth: number;
  readonly minRoomArea: number;
  readonly entry: RoomKind;
  readonly residential: boolean;
  readonly exteriorLocked: boolean;
  readonly exteriorStrength: number;
  readonly mainDoorWidth: number;
  readonly lockableRooms: readonly RoomKind[];
  readonly lockedRooms: readonly RoomKind[];
  readonly corridor: CorridorDef | null;
  readonly exteriorDoors: readonly ExteriorDoorDef[];
  readonly occupants: OccupancySpec;
  readonly rooms: readonly RoomDef[];
}

export interface TemplateSet {
  readonly furniture: Readonly<Record<string, FurnitureDef>>;
  readonly templates: Readonly<Record<BuildingKind, BuildingTemplate>>;
}

// --- Readers ---------------------------------------------------------------------------------

function show(value: unknown): string {
  return value === undefined ? 'undefined' : JSON.stringify(value);
}

function rejectUnknown(obj: JsonObject, allowed: readonly string[], file: string, path: string): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) fail(file, path === '' ? key : `${path}.${key}`, `is not a known field (${allowed.join(', ')})`);
  }
}

function readInt(value: unknown, file: string, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const n = readNumber(value, file, path, min, max);
  if (!Number.isInteger(n)) fail(file, path, `must be an integer, got ${n}`);
  return n;
}

function readIntRange(value: unknown, file: string, path: string, min: number): [number, number] {
  const arr = readArray(value, file, path);
  if (arr.length !== 2) fail(file, path, `must have 2 items [min, max], got ${arr.length}`);
  const lo = readInt(arr[0], file, `${path}[0]`, min);
  const hi = readInt(arr[1], file, `${path}[1]`, min);
  if (lo > hi) fail(file, path, `must be [min, max] with min <= max, got [${lo}, ${hi}]`);
  return [lo, hi];
}

function readKindList(value: unknown, file: string, path: string): RoomKind[] {
  return readArray(value, file, path).map((v, i) => readOneOf(v, ROOM_KINDS, file, `${path}[${i}]`));
}

// --- Furniture catalog -----------------------------------------------------------------------

/** Validates `furniture.json` into a catalog keyed by id. */
export function parseFurniture(raw: unknown, file = 'furniture.json'): Record<string, FurnitureDef> {
  const root = readObject(raw, file, '');
  readVersion(root, file);
  rejectUnknown(root, ['version', 'items'], file, '');
  const out: Record<string, FurnitureDef> = {};
  readArray(root.items, file, 'items', 1).forEach((v, i) => {
    const path = `items[${i}]`;
    const o = readObject(v, file, path);
    rejectUnknown(o, ['id', 'size', 'color', 'solid', 'surface', 'container', 'hide', 'seat'], file, path);
    const id = readString(o.id, file, `${path}.id`);
    if (out[id] !== undefined) fail(file, `${path}.id`, `duplicates ${show(id)}`);
    const size = readArray(o.size, file, `${path}.size`);
    if (size.length !== 3) fail(file, `${path}.size`, `must be [w, d, h], got ${size.length} items`);
    const [w, d, h] = size.map((s, k) => readNumber(s, file, `${path}.size[${k}]`, 0.05, 20)) as [number, number, number];
    out[id] = {
      id,
      w,
      d,
      h,
      color: readInt(o.color, file, `${path}.color`, 0, 0xffffff),
      solid: readBoolean(o.solid, file, `${path}.solid`),
      surface: o.surface === undefined ? null : readOneOf(o.surface, PRINT_SURFACES, file, `${path}.surface`),
      container: o.container === undefined ? 'none' : readOneOf(o.container, CONTAINERS, file, `${path}.container`),
      hide: o.hide === undefined ? null : readOneOf(o.hide, HIDE_KINDS, file, `${path}.hide`),
      seat: o.seat === undefined ? null : readOneOf(o.seat, ['sit', 'lie'] as const, file, `${path}.seat`),
    };
  });
  return out;
}

// --- Templates -------------------------------------------------------------------------------

function parseFurnitureEntry(v: unknown, furniture: Readonly<Record<string, FurnitureDef>>, file: string, path: string): FurnitureEntry {
  const o = readObject(v, file, path);
  rejectUnknown(o, ['id', 'place', 'count', 'chance', 'point'], file, path);
  const id = readString(o.id, file, `${path}.id`);
  if (furniture[id] === undefined) fail(file, `${path}.id`, `references unknown furniture ${show(id)}`);
  return {
    id,
    place: readOneOf(o.place, FURNITURE_PLACES, file, `${path}.place`),
    count: o.count === undefined ? [1, 1] : readIntRange(o.count, file, `${path}.count`, 0),
    chance: o.chance === undefined ? 1 : readNumber(o.chance, file, `${path}.chance`, 0, 1),
    point: o.point === undefined ? null : readOneOf(o.point, POINT_KINDS, file, `${path}.point`),
  };
}

function parseRoomDef(v: unknown, furniture: Readonly<Record<string, FurnitureDef>>, file: string, path: string): RoomDef {
  const o = readObject(v, file, path);
  rejectUnknown(o, ['kind', 'label', 'size', 'required', 'count', 'chance', 'band', 'surface', 'public', 'light', 'suite', 'child', 'furniture'], file, path);
  const kind = readOneOf(o.kind, ROOM_KINDS, file, `${path}.kind`);
  const required = readBoolean(o.required, file, `${path}.required`);
  const count = o.count === undefined ? ([1, 1] as [number, number]) : readIntRange(o.count, file, `${path}.count`, required ? 1 : 0);
  const suite = o.suite === undefined ? null : readKindList(o.suite, file, `${path}.suite`);
  if (suite !== null && suite.length < 2) fail(file, `${path}.suite`, 'must list at least 2 room kinds');
  const child = o.child === undefined ? false : readBoolean(o.child, file, `${path}.child`);
  const entries = o.furniture === undefined ? [] : readArray(o.furniture, file, `${path}.furniture`);
  if (suite !== null && entries.length > 0) fail(file, `${path}.furniture`, 'must be empty on a suite (put furniture on the child rooms)');
  return {
    kind,
    label: readString(o.label, file, `${path}.label`),
    size: readNumber(o.size, file, `${path}.size`, 0.01, 1000),
    required,
    count,
    chance: o.chance === undefined ? 0.5 : readNumber(o.chance, file, `${path}.chance`, 0, 1),
    band: o.band === undefined ? null : readOneOf(o.band, BANDS, file, `${path}.band`),
    surface: readOneOf(o.surface, SURFACE_KINDS, file, `${path}.surface`),
    public: o.public === undefined ? false : readBoolean(o.public, file, `${path}.public`),
    light: o.light === undefined ? true : readBoolean(o.light, file, `${path}.light`),
    suite,
    child,
    furniture: entries.map((e, i) => parseFurnitureEntry(e, furniture, file, `${path}.furniture[${i}]`)),
  };
}

function parseOccupancy(v: unknown, file: string, path: string): OccupancySpec {
  const o = readObject(v, file, path);
  rejectUnknown(o, ['day', 'night', 'profile', 'role', 'openHours'], file, path);
  let openHours: [number, number] | null = null;
  if (o.openHours !== null && o.openHours !== undefined) {
    const arr = readArray(o.openHours, file, `${path}.openHours`);
    if (arr.length !== 2) fail(file, `${path}.openHours`, `must be [open, close] or null, got ${arr.length} items`);
    openHours = [readNumber(arr[0], file, `${path}.openHours[0]`, 0, 24), readNumber(arr[1], file, `${path}.openHours[1]`, 0, 24)];
  }
  return {
    day: readIntRange(o.day, file, `${path}.day`, 0),
    night: readIntRange(o.night, file, `${path}.night`, 0),
    profile: readString(o.profile, file, `${path}.profile`),
    role: readOneOf<OccupantRole>(o.role, ['resident', 'staff', 'patron'], file, `${path}.role`),
    openHours,
  };
}

/** Validates one `templates/<kind>.json`. */
export function parseTemplate(raw: unknown, furniture: Readonly<Record<string, FurnitureDef>>, file = 'template.json'): BuildingTemplate {
  const root = readObject(raw, file, '');
  readVersion(root, file);
  rejectUnknown(root, [
    'version', 'kind', 'label', 'layout', 'minWidth', 'minDepth', 'maxWidth', 'maxDepth', 'minRoomArea', 'entry',
    'residential', 'exteriorLocked', 'exteriorStrength', 'mainDoorWidth', 'lockableRooms', 'lockedRooms', 'corridor',
    'exteriorDoors', 'occupants', 'rooms',
  ], file, '');
  const kind = readOneOf(root.kind, BUILDING_KINDS, file, 'kind');
  const layout = readOneOf(root.layout, LAYOUTS, file, 'layout');
  const minWidth = readNumber(root.minWidth, file, 'minWidth', 3, 200);
  const minDepth = readNumber(root.minDepth, file, 'minDepth', 3, 200);
  const maxWidth = readNumber(root.maxWidth, file, 'maxWidth', minWidth, 400);
  const maxDepth = readNumber(root.maxDepth, file, 'maxDepth', minDepth, 400);
  const entry = readOneOf(root.entry, ROOM_KINDS, file, 'entry');

  const rooms = readArray(root.rooms, file, 'rooms', 1).map((r, i) => parseRoomDef(r, furniture, file, `rooms[${i}]`));
  const entryDef = rooms.find((r) => r.kind === entry && !r.child);
  if (entryDef === undefined) fail(file, 'entry', `${show(entry)} is not the kind of any room`);
  if (!entryDef.required) fail(file, 'entry', `room ${show(entry)} must be required`);

  let corridor: CorridorDef | null = null;
  if (root.corridor !== null && root.corridor !== undefined) {
    const c = readObject(root.corridor, file, 'corridor');
    rejectUnknown(c, ['kind', 'label', 'width', 'frontShare', 'surface'], file, 'corridor');
    corridor = {
      kind: c.kind === undefined ? 'corridor' : readOneOf(c.kind, ROOM_KINDS, file, 'corridor.kind'),
      label: c.label === undefined ? 'Corridor' : readString(c.label, file, 'corridor.label'),
      width: readNumber(c.width, file, 'corridor.width', 1.2, 6),
      frontShare: readNumber(c.frontShare, file, 'corridor.frontShare', 0.1, 0.9),
      surface: c.surface === undefined ? 'linoleum' : readOneOf(c.surface, SURFACE_KINDS, file, 'corridor.surface'),
    };
  }
  if (layout === 'corridor') {
    if (corridor === null) fail(file, 'corridor', 'is required when layout is "corridor"');
    rooms.forEach((r, i) => {
      if (!r.child && r.band === null) fail(file, `rooms[${i}].band`, 'is required in a corridor layout (front or back)');
    });
    if (entryDef.band !== 'front') fail(file, 'entry', `room ${show(entry)} must be in the front band of a corridor layout`);
    for (const band of BANDS) {
      if (!rooms.some((r) => !r.child && r.required && r.band === band)) fail(file, 'rooms', `needs a required room in the ${band} band`);
    }
  }
  if (entryDef.suite !== null) fail(file, 'entry', `room ${show(entry)} cannot be a suite`);
  rooms.forEach((r, i) => {
    if (r.suite !== null && layout !== 'corridor') fail(file, `rooms[${i}].suite`, 'is only valid in a corridor layout');
  });

  // Suites: every suite kind needs exactly one child def; child defs are only valid when used.
  const childKinds = new Set<RoomKind>();
  rooms.forEach((r, i) => {
    if (!r.child) return;
    if (childKinds.has(r.kind)) fail(file, `rooms[${i}].kind`, `duplicates child room ${show(r.kind)}`);
    childKinds.add(r.kind);
    if (!r.required) fail(file, `rooms[${i}].required`, 'must be true on a child room');
  });
  const used = new Set<RoomKind>();
  rooms.forEach((r, i) => {
    r.suite?.forEach((k, j) => {
      if (!childKinds.has(k)) fail(file, `rooms[${i}].suite[${j}]`, `has no child room of kind ${show(k)}`);
      used.add(k);
    });
  });
  rooms.forEach((r, i) => {
    if (r.child && !used.has(r.kind)) fail(file, `rooms[${i}].child`, `room ${show(r.kind)} is not part of any suite`);
  });

  const exteriorDoors = (root.exteriorDoors === undefined ? [] : readArray(root.exteriorDoors, file, 'exteriorDoors')).map((v, i): ExteriorDoorDef => {
    const path = `exteriorDoors[${i}]`;
    const o = readObject(v, file, path);
    rejectUnknown(o, ['room', 'side', 'width', 'chance'], file, path);
    const room = readOneOf(o.room, ROOM_KINDS, file, `${path}.room`);
    if (!rooms.some((r) => r.kind === room && !r.child)) fail(file, `${path}.room`, `${show(room)} is not a room of this template`);
    return {
      room,
      side: readOneOf(o.side, DOOR_SIDES, file, `${path}.side`),
      width: o.width === undefined ? null : readNumber(o.width, file, `${path}.width`, 0.6, 6),
      chance: o.chance === undefined ? 1 : readNumber(o.chance, file, `${path}.chance`, 0, 1),
    };
  });

  const lockableRooms = root.lockableRooms === undefined ? [] : readKindList(root.lockableRooms, file, 'lockableRooms');
  const lockedRooms = root.lockedRooms === undefined ? [] : readKindList(root.lockedRooms, file, 'lockedRooms');
  lockedRooms.forEach((k, i) => {
    if (!lockableRooms.includes(k) && k !== 'cell') fail(file, `lockedRooms[${i}]`, `${show(k)} must also be in lockableRooms`);
  });

  return {
    kind,
    label: readString(root.label, file, 'label'),
    layout,
    minWidth,
    minDepth,
    maxWidth,
    maxDepth,
    minRoomArea: readNumber(root.minRoomArea, file, 'minRoomArea', 4, 200),
    entry,
    residential: readBoolean(root.residential, file, 'residential'),
    exteriorLocked: readBoolean(root.exteriorLocked, file, 'exteriorLocked'),
    exteriorStrength: readNumber(root.exteriorStrength, file, 'exteriorStrength', 0, 1),
    mainDoorWidth: root.mainDoorWidth === undefined ? 0.9 : readNumber(root.mainDoorWidth, file, 'mainDoorWidth', 0.6, 6),
    lockableRooms,
    lockedRooms,
    corridor,
    exteriorDoors,
    occupants: parseOccupancy(root.occupants, file, 'occupants'),
    rooms,
  };
}

/**
 * Validates the catalog and one template file per building kind. `files` maps a file name or path
 * (processed sorted by path) to its parsed JSON; errors name the file's base name.
 */
export function parseTemplateSet(furnitureRaw: unknown, files: Readonly<Record<string, unknown>>): TemplateSet {
  const furniture = parseFurniture(furnitureRaw);
  const templates: Partial<Record<BuildingKind, BuildingTemplate>> = {};
  for (const path of Object.keys(files).sort()) {
    const file = path.slice(path.lastIndexOf('/') + 1);
    const t = parseTemplate(files[path], furniture, file);
    if (templates[t.kind] !== undefined) fail(file, 'kind', `duplicates the template for ${show(t.kind)}`);
    templates[t.kind] = t;
  }
  for (const kind of BUILDING_KINDS) {
    if (templates[kind] === undefined) fail('templates', kind, 'has no template file');
  }
  return { furniture, templates: templates as Record<BuildingKind, BuildingTemplate> };
}

/** The shipped furniture catalog and templates. */
export const INTERIOR_TEMPLATES: TemplateSet = parseTemplateSet(
  furnitureJson,
  import.meta.glob<unknown>('../data/interior/templates/*.json', { eager: true, import: 'default' }),
);
export const FURNITURE: Readonly<Record<string, FurnitureDef>> = INTERIOR_TEMPLATES.furniture;
