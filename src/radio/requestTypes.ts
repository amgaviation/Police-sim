/**
 * Phase 6 radio request types: the list the radio menu pages through and the voice grammar matches. Set once by
 * the integrator from the unit types (`requestableTypes()`); empty by default, which keeps the Phase 2 menu
 * (backup code 2 / code 3) and the Phase 2 voice commands.
 */
import type { UnitRequest } from '../cad/types';

export interface RadioRequestType {
  /** Unit type id (`k9`, `ems`, ...). */
  id: string;
  /** Menu line (at most 28 characters). */
  menu: string;
  /** Short name used in the player's radio line ("requesting {label} to ..."). */
  label: string;
  /** Lower-case voice aliases ("k9", "canine"). */
  voice: readonly string[];
  /** The request the menu and the grammar return. */
  request: UnitRequest;
}

let list: readonly RadioRequestType[] = [];
let revisionValue = 0;

/**
 * Sets the request types (patrol types map to backup 2 / backup 3 / emergency, others to
 * `{ kind: 'resource', typeId }`). Replaces the previous list.
 */
export function setRadioRequestTypes(next: readonly RadioRequestType[]): void {
  list = next;
  revisionValue++;
}

/** The request types in menu order (default empty). */
export function radioRequestTypes(): readonly RadioRequestType[] {
  return list;
}

/** Bumps on every `setRadioRequestTypes` (caches of the menu and the grammar). */
export function radioRequestTypesRevision(): number {
  return revisionValue;
}

/** Label of the type `typeId`, or the id itself when unknown. */
export function requestLabel(typeId: string): string {
  for (const t of list) if (t.id === typeId) return t.label;
  return typeId;
}
