import type { EventMap } from '../core/event-map';
import type { EventBus } from '../core/events';
import type { FoundItem, IncidentLog, LegalAssessment, ReportChoice } from '../legal/types';
import type { IncidentMapping } from './mapping';

/** Call facts at materialize / stop time. */
export interface CallInfo {
  typeId: string;
  family: string;
  /** The call is an emergency that justifies entering (exigent circumstances). */
  exigency: boolean;
  /** A warrant exists for the call's suspect or premises. */
  warrant: boolean;
  suspects: readonly number[];
  weaponReported: boolean;
  /** District type name of the call location ('' unknown). */
  district: string;
}

/** Scratch object the officer port fills (no allocation per call). */
export interface OfficerProbe {
  x: number;
  z: number;
  building: number;
  inVehicle: boolean;
  weapon: 'none' | 'sidearm' | 'taser';
}

export interface DashProbe {
  /** The light bar of the last-driven patrol car is on. */
  lights: boolean;
  /** The officer is inside or within `RECORDING.dashRangeM` of that car. */
  nearCar: boolean;
}

export interface PursuitProbe {
  speedMph: number;
  limitMph: number;
  district: string;
  wet: boolean;
  night: boolean;
  lights: boolean;
  siren: boolean;
}

/** What the recorder reads from the rest of the game (the integrator wires the real objects). */
export interface IncidentPorts {
  callInfo(callId: number): CallInfo | null;
  /** What the officer knows: the claimed name, else "Male, about 30". */
  personLabel(personId: number): string;
  /** Scene / contact role, '' unknown. */
  personRole(personId: number, callId: number): string;
  /** The active traffic stop. */
  stopDriver(): { personId: number; vehicleId: number; callId: number } | null;
  /** Violation kinds the stop vehicle was seen committing (keys are `TrafficViolationKind`). */
  observedViolations(vehicleId: number): Readonly<Partial<Record<string, number>>>;
  /** Investigation items. */
  itemInfo(itemId: string): (FoundItem & { ownerPersonId: number; buildingId: number }) | null;
  /** CAD booking document. */
  booking(docId: string): { personId: number; callId: number; charges: string[] } | null;
  /** Call id of the open call bound to the building, 0 none. */
  buildingIncident(buildingId: number): number;
  /** Store / bar / bank / hospital / school lobby during open hours, station. */
  publicPlace(buildingId: number): boolean;
  officer(out: OfficerProbe): void;
  bodycamWorn(): boolean;
  dashcam(out: DashProbe): void;
  /** False when the officer is not driving. */
  pursuitProbe(out: PursuitProbe): boolean;
  /** The incident string of the open field contact, null none. */
  activeContactIncident(): string | null;
}

export type IncidentRequest =
  | { readonly kind: 'mute'; readonly on: boolean }
  | { readonly kind: 'dashManual'; readonly on: boolean }
  | { readonly kind: 'report'; readonly key: string; readonly docId: string; readonly assertions: readonly string[] }
  | { readonly kind: 'jurisdiction'; readonly id: string }
  | { readonly kind: 'close'; readonly key: string };

export interface IncidentDeps {
  readonly bus: EventBus<EventMap>;
  readonly ports: IncidentPorts;
  /** Session seed (report choice order is a pure function of seed and incident key). */
  readonly seed: number;
  readonly mapping?: IncidentMapping;
  /** The player's unit callsign: lookups of other units are ignored, and the player's current call is followed. Absent = every lookup counts. */
  readonly callsign?: string;
  /** Starting jurisdiction id (default `generic`; a save or a `jurisdiction` request replaces it). */
  readonly jurisdiction?: string;
}

/** What conduct and court read (design 4.4). */
export interface IncidentSource {
  log(key: string): IncidentLog | null;
  assessment(key: string): LegalAssessment | null;
  reportChoices(key: string): readonly ReportChoice[];
}
