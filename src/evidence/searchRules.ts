/**
 * Search and seizure rules (design phase 4 §9.2): lawful presence, plain view, consent scope and the search
 * authority ladder. Every refusal carries a human-readable reason. Pure.
 */
import type { Container } from './types';

export const SEARCH_BASES = [
  'plainView',
  'consent',
  'warrant',
  'incidentToArrest',
  'exigency',
  'protectiveSweep',
  'publicArea',
] as const;
export type SearchBasis = (typeof SEARCH_BASES)[number];

/** Sim seconds after an arrest during which the arrest room may be searched. */
export const ARREST_SEARCH_WINDOW_S = 600;

export interface ConsentRecord {
  readonly id: number;
  readonly personId: number;
  readonly kind: 'entry' | 'searchPremises' | 'searchRoom' | 'searchPerson' | 'searchVehicle' | 'pbt' | 'sfst';
  readonly granted: boolean;
  /** The consent was freely given (not coerced). */
  readonly valid: boolean;
  /** The person had authority over the place or thing (resident, owner, manager). */
  readonly authority: boolean;
  readonly buildingId: number;
  readonly room: number;
  readonly vehicleId: number;
  readonly sim: number;
  /** Sim second consent was withdrawn, -1 when never. */
  readonly revokedSim: number;
}

export interface PresenceContext {
  /** -1 outdoors (always lawful). */
  readonly buildingId: number;
  readonly room: number;
  readonly roomPublic: boolean;
  readonly businessOpen: boolean;
  readonly consents: readonly ConsentRecord[];
  /** Emergency aid, hot pursuit, in-progress crime, shots fired. */
  readonly exigency: boolean;
  readonly warrant: boolean;
  readonly sim: number;
}

/** granted && valid && authority && not revoked at `sim`. */
export function consentActive(c: ConsentRecord, sim: number): boolean {
  return c.granted && c.valid && c.authority && (c.revokedSim < 0 || sim < c.revokedSim);
}

/**
 * Officer lawfully present in that room: outdoors; public room of an open business (`publicArea`); warrant;
 * exigency; an active consent of kind entry / searchPremises (same building) or searchRoom (same building and room).
 */
export function lawfulPresence(ctx: PresenceContext): { lawful: boolean; basis: SearchBasis | 'invited' | null } {
  if (ctx.buildingId < 0) return { lawful: true, basis: null };
  if (ctx.roomPublic && ctx.businessOpen) return { lawful: true, basis: 'publicArea' };
  if (ctx.warrant) return { lawful: true, basis: 'warrant' };
  if (ctx.exigency) return { lawful: true, basis: 'exigency' };
  for (const c of ctx.consents) {
    if (!consentActive(c, ctx.sim) || c.buildingId !== ctx.buildingId) continue;
    if (c.kind === 'entry' || c.kind === 'searchPremises') return { lawful: true, basis: 'invited' };
    if (c.kind === 'searchRoom' && c.room === ctx.room) return { lawful: true, basis: 'invited' };
  }
  return { lawful: false, basis: null };
}

export interface PlainViewInput {
  readonly presence: PresenceContext;
  /** The item is hidden inside a closed container or under something. */
  readonly concealed: boolean;
  /** Line of sight and lit. */
  readonly visible: boolean;
  /** Weapon, contraband or call evidence. */
  readonly incriminating: boolean;
}

/** Plain view needs all four: lawful presence, visible, not concealed, immediately incriminating. */
export function plainView(input: PlainViewInput): { plainView: boolean; reason: string } {
  if (!lawfulPresence(input.presence).lawful) {
    return { plainView: false, reason: 'The officer is not lawfully in this place.' };
  }
  if (!input.visible) return { plainView: false, reason: 'The item is not in view (out of sight or too dark).' };
  if (input.concealed) return { plainView: false, reason: 'The item is concealed; finding it takes a search.' };
  if (!input.incriminating) return { plainView: false, reason: 'The item is not obviously evidence or contraband.' };
  return { plainView: true, reason: 'Lawfully present, in open view, immediately incriminating.' };
}

export interface SearchTarget {
  readonly kind: 'container' | 'room' | 'person' | 'vehicle';
  readonly buildingId: number;
  readonly room: number;
  readonly container: Container;
  /** A place a person could hide. */
  readonly hide: boolean;
  readonly personId: number;
  readonly vehicleId: number;
}

export interface ArrestRecord {
  readonly personId: number;
  readonly buildingId: number;
  readonly room: number;
  readonly sim: number;
}

export interface SearchContext extends PresenceContext {
  readonly target: SearchTarget;
  /** Arrests made on this call. */
  readonly arrests: readonly ArrestRecord[];
}

export type SearchAuthority = { allowed: boolean; basis: SearchBasis | null; reason: string };

function allow(basis: SearchBasis, reason: string): SearchAuthority {
  return { allowed: true, basis, reason };
}

function targetName(t: SearchTarget): string {
  if (t.kind === 'container') return t.container === 'none' ? 'this spot' : `this ${t.container}`;
  return t.kind === 'room' ? 'this room' : `this ${t.kind}`;
}

function consentCovers(c: ConsentRecord, t: SearchTarget): boolean {
  switch (c.kind) {
    case 'searchPremises':
      return (t.kind === 'container' || t.kind === 'room') && c.buildingId === t.buildingId;
    case 'searchRoom':
      return (t.kind === 'container' || t.kind === 'room') && c.buildingId === t.buildingId && c.room === t.room;
    case 'searchPerson':
      return t.kind === 'person' && c.personId === t.personId;
    case 'searchVehicle':
      return t.kind === 'vehicle' && c.vehicleId === t.vehicleId;
    default:
      return false;
  }
}

/**
 * First basis that allows the search, in order: warrant, consent (scope), incidentToArrest (same building and
 * room, within 600 s of the arrest: containers and the room, not other rooms), protectiveSweep (exigency or an
 * arrest on the premises: only `hide` places and rooms, never closed containers), exigency (rooms only),
 * publicArea (open items of the public room only: container 'none'); else not allowed, with a reason.
 */
export function searchAuthority(ctx: SearchContext): SearchAuthority {
  const t = ctx.target;
  const what = targetName(t);
  if (ctx.warrant) return allow('warrant', 'A search warrant covers the premises.');

  let entryOnly = false;
  let outOfScope = false;
  for (const c of ctx.consents) {
    if (!consentActive(c, ctx.sim)) continue;
    if (consentCovers(c, t)) return allow('consent', `Consent covers ${what} (${c.kind}).`);
    if (c.kind === 'entry') entryOnly = true;
    else if (c.kind !== 'pbt' && c.kind !== 'sfst') outOfScope = true;
  }

  const sameSpot = t.kind === 'container' || t.kind === 'room';
  for (const a of ctx.arrests) {
    const age = ctx.sim - a.sim;
    if (age < 0 || age > ARREST_SEARCH_WINDOW_S) continue;
    if (sameSpot && a.buildingId === t.buildingId && a.room === t.room) {
      return allow('incidentToArrest', 'Search incident to an arrest made in this room.');
    }
    if (t.kind === 'person' && a.personId === t.personId) {
      return allow('incidentToArrest', 'Search of the arrested person.');
    }
  }

  const arrestOnPremises = t.buildingId >= 0 && ctx.arrests.some((a) => a.buildingId === t.buildingId);
  if ((ctx.exigency || arrestOnPremises) && (t.kind === 'room' || (t.kind === 'container' && t.hide))) {
    return allow('protectiveSweep', 'Protective sweep of places a person could hide.');
  }

  if (ctx.exigency && t.kind === 'room') return allow('exigency', 'Exigent circumstances allow entering the room.');

  if (
    t.kind === 'container' &&
    t.container === 'none' &&
    ctx.roomPublic &&
    ctx.businessOpen &&
    ctx.buildingId === t.buildingId &&
    ctx.room === t.room
  ) {
    return allow('publicArea', 'Open item in the public area of an open business.');
  }

  let why = `No legal basis to search ${what}.`;
  if (outOfScope) why = `The consent given does not cover ${what}.`;
  else if (entryOnly) why = `Consent to enter is not consent to search ${what}.`;
  else if (ctx.exigency && sameSpot) why = `Exigent circumstances allow rooms and hiding places, not ${what}.`;
  else if (sameSpot && ctx.arrests.some((a) => a.buildingId === t.buildingId && a.room === t.room)) {
    why = `The ${ARREST_SEARCH_WINDOW_S} second window to search the arrest room has passed.`;
  } else if (arrestOnPremises && sameSpot) why = `An arrest on the premises allows a sweep for people, not a search of ${what}.`;
  return { allowed: false, basis: null, reason: `${why} Get consent or a warrant.` };
}

/** Evidence is admissible when found with a basis (plain view counts as `plainView`). */
export function admissible(found: { basis: SearchBasis | null }): boolean {
  return found.basis !== null;
}
