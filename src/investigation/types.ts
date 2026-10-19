/**
 * Investigation runtime contracts (design phase 4 §10.1). The investigation module imports only the evidence
 * rules, the interior layout types and Phase 0-3; everything else (scene, npc, interiors, kit, lighting) comes
 * through `InvestigationPorts`, implemented by the integrator.
 */
import type { Container, PrintSurface } from '../evidence';
import type { InteriorLayout } from '../interior/types';

/** Default and limits of the camera's horizontal field of view (degrees). */
export const PHOTO_FOV_DEFAULT = 60;
export const PHOTO_FOV_MIN = 20;
export const PHOTO_FOV_MAX = 100;

/**
 * A closed no-go polygon (scene tape). Declared structurally, identical to the npc module's `NoGoZone`
 * (design §8.1): `points` are x, z pairs of a closed polygon, the bounds are precomputed.
 */
export interface NoGoZone {
  readonly id: number;
  readonly points: Float32Array;
  readonly minX: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxZ: number;
}

/** The officer as the investigation sees them; `y` is the feet height (-40 on an interior level). */
export interface InvestigationOfficer {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  /** -1 outdoors. */
  building: number;
  room: number;
  onFoot: boolean;
  badge: string;
  flashlight: boolean;
}

/** What the scene knows about a call (null when the call is unknown). */
export interface CallContext {
  /** Emergency aid, hot pursuit, in-progress crime or shots fired. */
  exigency: boolean;
  /** A search warrant covers the premises (warrant-service calls only). */
  warrant: boolean;
  readonly arrests: readonly { personId: number; buildingId: number; room: number; sim: number }[];
  /** The call's bound building, -1 outdoors. */
  buildingId: number;
  /** Call family key into `evidence.json` `sawChance` ('domestic', 'property', 'inProgress', ...). */
  family: string;
  /** The suspect's person id, -1 when none. */
  suspectPersonId: number;
  anchorX: number;
  anchorZ: number;
}

/** Implemented by the integrator over SceneDirector / CAD / npc / records / interiors. */
export interface InvestigationPorts {
  callContext(callId: number): CallContext | null;
  /** The player's current call (assigned and materialized, nearest), 0 when none. */
  currentCall(): number;
  /** 'C-00042'. */
  incidentOf(callId: number): string;
  /** Canvass: spawns the resident at the building's door (role 'witness' when sawSomething, else 'resident'); actor id or 0. */
  spawnResident(buildingId: number, personId: number, callId: number, role: 'witness' | 'resident'): number;
  /** Person id of the building's resident `index` (design §6.3 resident rule). */
  residentOf(buildingId: number, index: number): number;
  /**
   * Hidden actors of a building (-1: outdoors) for the K9 sweep. `out` holds 16 ready objects: overwrite
   * `out[0..n-1]` (actorId, x, z) and return n (at most 16).
   */
  hiddenActors(buildingId: number, out: { actorId: number; x: number; z: number }[]): number;
  setNoGoZones(zones: readonly NoGoZone[]): void;
  kit(): { carried(item: string): number; use(item: string, n: number): boolean; give(item: string, n: number): boolean };
  bodycamWorn(): boolean;
  nightFactor(): number;
  /**
   * Line of sight on the officer's level using the live door states (integrator: interior `lineOfSight` +
   * the interior system's door states). Heights are metres above the floor of `building` (0 outdoors).
   */
  lineOfSight(building: number, ax: number, ay: number, az: number, bx: number, by: number, bz: number, ignoreFurniture: number): boolean;
  roomLit(building: number, room: number): boolean;
  businessOpen(building: number): boolean;
  layout(building: number): InteriorLayout | null;
  /** Street address of a building ('1420 Oak St'); for -1 the nearest address or ''. */
  addressOf(building: number): string;
  /** 'north on Elm St'. */
  describeDirection(fromX: number, fromZ: number, toX: number, toZ: number): string;
  describePerson(personId: number): string;
  /**
   * Optional: the building whose exterior door is within 1.8 m of (x, z), -1 when none. Lets the tools panel
   * offer "Knock (canvass)"; without it that row is disabled and the door panel issues `canvass` requests.
   */
  doorBuilding?(x: number, z: number): number;
}

export interface PlaceItemSpec {
  callId: number;
  /** People item id ('knife', 'handgun', ...). */
  item: string;
  label: string;
  x: number;
  /**
   * World height of the item. Interior items may also pass the layout `ItemSpot.y` (metres above the floor):
   * on a building level any value above -20 is taken as floor-relative and the level floor is added.
   */
  y: number;
  z: number;
  buildingId: number;
  room: number;
  /** Furniture index the item lies on / in, -1 on the floor. */
  furniture: number;
  container: Container;
  concealed: boolean;
  ownerPersonId: number;
  incriminating: boolean;
}

export type InvestigationRequest =
  | { readonly kind: 'marker' }
  | { readonly kind: 'removeMarker'; readonly no: number }
  | { readonly kind: 'photo'; readonly fovDeg: number }
  | { readonly kind: 'collect'; readonly itemId: string }
  | { readonly kind: 'bag'; readonly itemId: string }
  | { readonly kind: 'tag'; readonly itemId: string }
  | { readonly kind: 'transfer'; readonly itemId: string; readonly to: string }
  | { readonly kind: 'deposit' }
  | { readonly kind: 'search'; readonly buildingId: number; readonly furniture: number; readonly force: boolean }
  | { readonly kind: 'dustStart'; readonly buildingId: number; readonly furniture: number }
  | { readonly kind: 'dustMove'; readonly dir: 'up' | 'down' | 'left' | 'right' }
  | { readonly kind: 'dustBrush'; readonly seconds: number }
  | { readonly kind: 'dustLift' }
  | { readonly kind: 'dustCancel' }
  | { readonly kind: 'tapePost' }
  | { readonly kind: 'tapeClose' }
  | { readonly kind: 'tapeClear' }
  | { readonly kind: 'bodycam'; readonly on: boolean }
  | { readonly kind: 'canvass'; readonly buildingId: number };

export interface CaseSummary {
  items: number;
  found: number;
  plainView: number;
  suppressed: number;
  collected: number;
  custodyComplete: boolean;
  photos: number;
  markers: number;
  prints: number;
  canvass: number;
  consents: number;
  bodycam: boolean;
}

export type ToolAction =
  | { kind: 'request'; request: InvestigationRequest }
  | { kind: 'camera' }
  | { kind: 'caseFile' }
  | { kind: 'k9' }
  | { kind: 'none' };

/** Row indices of the tools panel (`toolsModel` / `toolsSelect`). */
export const TOOL_ROW = {
  marker: 0,
  photo: 1,
  collect: 2,
  bag: 3,
  tag: 4,
  search: 5,
  dust: 6,
  tapePost: 7,
  tapeClose: 8,
  tapeClear: 9,
  canvass: 10,
  k9: 11,
  bodycam: 12,
  caseFile: 13,
} as const;

/** The fingerprint minigame as the panel draws it; the object is updated in place (check `InvestigationSystem.revision`). */
export interface DustView {
  surface: PrintSurface;
  /** Display name of the surface furniture ('Desk'). */
  label: string;
  /** 0..15, row-major 4x4. */
  cursor: number;
  /** 16 cells, 0..1.5 (the live array). */
  coverage: readonly number[];
  /** Quality a lift would give now, 0..1. */
  quality: number;
  overbrush: number;
}
