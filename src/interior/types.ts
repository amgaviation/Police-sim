/** Interior layout types and fixed id lists (design §4.2, §5.2). */
import type { BuildingKind } from './kinds';

export const ROOM_KINDS = [
  'living', 'kitchen', 'dining', 'bedroom', 'bathroom', 'laundry', 'hallway', 'corridor', 'lobby',
  'unitLiving', 'unitBedroom', 'unitBath', 'mailroom', 'salesFloor', 'storage', 'office', 'restroom',
  'tellerArea', 'vault', 'breakRoom', 'barRoom', 'waiting', 'exam', 'patientRoom', 'nurseStation',
  'supply', 'classroom', 'library', 'floor', 'loading', 'conference', 'deck', 'stairwell', 'sallyPort',
  'booking', 'cell', 'control', 'visiting', 'garage', 'lockerRoom', 'rollCall', 'reportRoom', 'armory',
  'evidenceRoom', 'interview', 'backOffice', 'cooler', 'security', 'closet', 'utility', 'gym',
  'cafeteria', 'pharmacy', 'dock', 'lounge',
] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

export const POINT_KINDS = [
  'locker', 'briefing', 'armory', 'evidence', 'reportDesk', 'interview', 'cell', 'frontDesk', 'garage', 'booking',
] as const;
export type PointKind = (typeof POINT_KINDS)[number];

export const SURFACE_KINDS = ['carpet', 'wood', 'tile', 'concrete', 'linoleum'] as const;
export type FloorSurface = (typeof SURFACE_KINDS)[number];

export const PRINT_SURFACES = ['glass', 'metal', 'wood', 'stone', 'fabric'] as const;
export type PrintSurface = (typeof PRINT_SURFACES)[number];

export const CONTAINERS = ['none', 'drawer', 'cabinet', 'closet', 'safe'] as const;
export type Container = (typeof CONTAINERS)[number];

export const HIDE_KINDS = ['closet', 'underBed', 'behindCounter', 'shower', 'cabinet'] as const;
export type HideKind = (typeof HIDE_KINDS)[number];

export interface Rect {
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

export type DoorKind = 'interior' | 'exterior' | 'cell' | 'wide';

export interface InteriorRoom {
  readonly index: number;
  readonly kind: RoomKind;
  /** Template label, e.g. 'Kitchen'. */
  readonly label: string;
  /** World x/z. */
  readonly rect: Rect;
  readonly surface: FloorSurface;
  /** Public area of a business (lawful presence while open). */
  readonly public: boolean;
  /** Ceiling fixture (room centre), null = no light. */
  readonly light: { readonly x: number; readonly z: number } | null;
  readonly switchAt: { readonly x: number; readonly z: number; readonly yaw: number } | null;
}

export interface InteriorDoor {
  readonly index: number;
  /** Room index. */
  readonly a: number;
  /** Room index, -1 = outside. */
  readonly b: number;
  /** Centre of the opening (on the wall line). */
  readonly x: number;
  readonly z: number;
  /** 'x': the opening spans along world X (the wall runs along X, its normal is +-Z); 'z': spans along Z. */
  readonly axis: 'x' | 'z';
  readonly width: number;
  /** 'wide' openings have no door panel (always open, not lockable). */
  readonly kind: DoorKind;
  readonly lockable: boolean;
  /** Implies lockable. */
  readonly lockedAtStart: boolean;
  /** Room whose side holds the thumb-turn (interior lockable doors), -1 for exterior / not lockable. */
  readonly lockSide: number;
  /** 0..1 kick / ram resistance (>= 0.95 = unbreachable). */
  readonly strength: number;
  /** Exterior doors: outdoor pose outside the footprint (y = 0), facing out; null for interior doors. */
  readonly exit: { readonly x: number; readonly z: number; readonly yaw: number } | null;
  /** The front entrance (exactly one per layout). */
  readonly main: boolean;
}

export interface FurnitureItem {
  readonly index: number;
  readonly id: string;
  readonly room: number;
  readonly x: number;
  readonly z: number;
  /** One of 0, PI/2, PI, -PI/2: the front faces the room. */
  readonly yaw: number;
  /** Width (local x), depth (local z), height. */
  readonly w: number;
  readonly d: number;
  readonly h: number;
  /** World AABB. */
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
  readonly color: number;
  readonly solid: boolean;
  /** 0.8 <= h <= 1.3 (low cover). */
  readonly cover: boolean;
  /** Printable top. */
  readonly surface: PrintSurface | null;
  readonly container: Container;
  readonly hide: HideKind | null;
  readonly seat: 'sit' | 'lie' | null;
}

export interface HidingSpot {
  readonly index: number;
  readonly room: number;
  readonly furniture: number;
  readonly kind: HideKind;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

export interface SpawnSpot {
  readonly room: number;
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
  readonly pose: 'stand' | 'sit' | 'lying';
}

export interface ItemSpot {
  readonly index: number;
  readonly room: number;
  readonly x: number;
  /** Above the floor. */
  readonly y: number;
  readonly z: number;
  readonly container: Container;
  readonly concealed: boolean;
  /** Furniture index, -1 = floor. */
  readonly furniture: number;
}

export interface InteriorPoint {
  readonly kind: PointKind;
  readonly room: number;
  readonly furniture: number;
  /** Stand here, facing the furniture. */
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

export type OccupantRole = 'resident' | 'staff' | 'patron';

/** Template occupancy (design §5.4). A business is open when open <= hour < close (wrapping past midnight). */
export interface OccupancySpec {
  readonly day: readonly [number, number];
  readonly night: readonly [number, number];
  readonly profile: string;
  readonly role: OccupantRole;
  readonly openHours: readonly [number, number] | null;
}

export interface InteriorLayout {
  readonly buildingId: number;
  readonly kind: BuildingKind;
  /** INTERIOR_FLOOR_Y. */
  readonly floorY: number;
  /** Interior extent (inside the footprint). */
  readonly rect: Rect;
  readonly rooms: readonly InteriorRoom[];
  readonly doors: readonly InteriorDoor[];
  /** Wall lines without door gaps: x0, z0, x1, z1 per segment (axis-aligned). */
  readonly walls: Float32Array;
  readonly furniture: readonly FurnitureItem[];
  readonly hidingSpots: readonly HidingSpot[];
  readonly spawnSpots: readonly SpawnSpot[];
  readonly itemSpots: readonly ItemSpot[];
  readonly points: readonly InteriorPoint[];
  /** Officer arrival pose just inside the main door (1.0 m in), facing in. */
  readonly entry: { readonly x: number; readonly z: number; readonly yaw: number };
  /** Door indices per room (adjacency). */
  readonly roomDoors: readonly (readonly number[])[];
  /** Template flag. */
  readonly residential: boolean;
  /** Template occupancy. */
  readonly occupants: OccupancySpec;
}
