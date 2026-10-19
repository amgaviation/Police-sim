import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { Rng, RngState } from '../core/rng';
import type { CadState } from '../cad/cadState';
import type { UnitRequest } from '../cad/types';
import type { CommMode, DialogueResult, IncidentTruth, SubjectMemory, Tone } from '../dialogue';
import type { SfstSave } from '../dialogue';
import type { NpcSystem } from '../npc/npcSystem';
import type { Population } from '../people/population';
import type { RecordsDb } from '../records/db';

/**
 * Contact module types (design §10.2). `IncidentResolver`, `ContactTarget`, `IncidentInfo` and `Presence`
 * are declared here with the exact definitions of the design; the scene module declares identical
 * structural copies (the two modules never import each other).
 */

export type ContactTarget =
  | { readonly kind: 'actor'; readonly actorId: number }
  | { readonly kind: 'ped'; readonly slot: number }
  | { readonly kind: 'occupant'; readonly vehicleId: number; readonly seat: number };

/** What the scene knows about the incident a person belongs to. */
export interface IncidentInfo {
  /** `"C-00042"` or `"FC-<personId>-<epochDay>"`. */
  readonly key: string;
  /** CAD call id, 0 for none. */
  readonly callId: number;
  readonly role: string;
  readonly truth: IncidentTruth;
  readonly guilty: boolean;
  /** The vehicle this person is associated with, -1 for none. */
  readonly vehicleId: number;
  /** Traffic-stop driver or passenger. */
  readonly stop: boolean;
}

/** Implemented by the scene director. */
export interface IncidentResolver {
  resolveIncident(personId: number, target: ContactTarget): IncidentInfo | null;
}

export interface Presence {
  readonly lights: boolean;
  readonly siren: boolean;
  readonly backup: number;
  readonly weapon: 'none' | 'sidearm' | 'taser';
}

/** The ids of every action a contact offers, in menu order. */
export const CONTACT_ACTIONS = [
  'frisk',
  'searchPerson',
  'searchVehicle',
  'visualCheck',
  'pbt',
  'sfst',
  'checkId',
  'runName',
  'runId',
  'runPlate',
  'checkVin',
  'cuff',
  'uncuff',
  'escort',
  'stopEscort',
  'release',
  'warnRelease',
  'writeCitation',
  'notifyGuardian',
  'useTranslationApp',
  'requestInterpreter',
  'seize',
] as const;
export type ContactActionId = (typeof CONTACT_ACTIONS)[number];

export type ContactRequest =
  | { readonly kind: 'open'; readonly target: ContactTarget }
  | { readonly kind: 'say'; readonly contactId: number; readonly utteranceId: string; readonly tone: Tone }
  | { readonly kind: 'action'; readonly contactId: number; readonly action: ContactActionId }
  | { readonly kind: 'commMode'; readonly contactId: number; readonly mode: CommMode }
  | { readonly kind: 'activate'; readonly contactId: number }
  | { readonly kind: 'close'; readonly contactId: number }
  /** Hides the dialogue but keeps the conversation (consent, found items, flags) for when the officer talks again. */
  | { readonly kind: 'dismiss'; readonly contactId: number }
  /** The officer stopped the field sobriety tests: the subject declines to continue (the tests can be retried). */
  | { readonly kind: 'sfstAbort' }
  | { readonly kind: 'sfstKey'; readonly key: string }
  | { readonly kind: 'cage'; readonly vehicleIndex: number };

export interface ContactDeps {
  readonly seed: number;
  readonly bus: EventBus<EventMap>;
  readonly cad: CadState;
  readonly records: RecordsDb;
  readonly people: Population;
  readonly npc: NpcSystem;
  /** `session.rng.stream('contact')`. */
  readonly rng: Rng;
  readonly playerCallsign: string;
  /** `dispatcher.request(playerCallsign, r, 'auto')`. */
  request(r: UnitRequest): void;
  officer(): { name: string; badge: string };
  presence(): Presence;
  /** Fills the officer's position; `building` (-1 outdoors) is optional: without it every level check is skipped. */
  officerPosition(out: { x: number; z: number; yaw: number; building?: number }): void;
  /**
   * Optional: the premises `personId` is at relative to the officer (the building the officer is in or at), or null.
   * `authority` is true for a resident or owner (records address = building address, or an ambient resident / staff
   * actor of it); `room` is the officer's room (-1 outdoors).
   */
  premises?(personId: number): { buildingId: number; authority: boolean; room: number } | null;
  trustAt(x: number, z: number): number;
  districtOf(x: number, z: number): string;
  /** Vehicle id of the active traffic stop, -1 for none. */
  stopVehicleId(): number;
  interpreterAvailable(callId: number): boolean;
  /**
   * Optional: world position of a vehicle (true when known). Without it the officer counts as being at the
   * vehicle of the active stop and next to any subject who stepped out of it.
   */
  vehiclePosition?(vehicleId: number, out: { x: number; z: number }): boolean;
}

export interface ContactSaveEntry {
  id: number;
  personId: number;
  incident: string;
  callId: number;
  role: string;
  target: ContactTarget;
  actorId: number;
  commMode: CommMode;
  memory: SubjectMemory;
  transcript: { id: number; speaker: 'officer' | 'subject' | 'system'; text: string }[];
  nextLine: number;
  /** Delayed answers (plain JSON); `dueSim` is in sim seconds. */
  pending: { dueSim: number; result: DialogueResult }[];
  sfst: SfstSave | null;
  /** Sim second the guardian arrives (counts as present for consent from then on), -1 when not notified. */
  guardianNotifiedAt: number;
  truth: IncidentTruth;
  guilty: boolean;
  vehicleId: number;
  stop: boolean;
  appTranslation: boolean;
  /** Optional when reading: one-shot markers (`frisked`, `pbt`, `releasing`, `noticedHearing`, ...), sorted. */
  flags?: string[];
  /** Optional when reading: instance ids found by a search and not yet seized. */
  found?: string[];
  /** Optional when reading: sim second of the last activity (eviction order). */
  lastSim?: number;
}

export interface ContactSave {
  version: 1;
  nextId: number;
  active: number;
  contacts: ContactSaveEntry[];
  /** Optional when reading: the step counter that phases the liveness and release checks. */
  step?: number;
  /** Optional when reading: the `contact` stream, so a restored session continues identically. */
  rng?: RngState;
}
