/** Station bus topics (design §11.1, §14). */
import type { ArmoryEntry } from './armory';
import type { Loadout } from './locker';
import type { ShiftStep } from './shiftFlow';

/** The shift flow advanced; `step` is the new current step. */
export interface StationStepEvent {
  step: ShiftStep;
}

export interface StationArmoryEvent {
  entry: ArmoryEntry;
}

export interface StationLoadoutEvent {
  loadout: Loadout;
}

/** A person was put in a cell (`placed` true) or released from it (`placed` false, `cell` is the cell they left). */
export interface StationHoldingEvent {
  personId: number;
  cell: number;
  placed: boolean;
}

/** The interview room's subject changed; -1 when the interview ended. */
export interface StationInterviewEvent {
  personId: number;
}

declare module '../core/event-map' {
  interface EventMap {
    'station:step': StationStepEvent;
    'station:armory': StationArmoryEvent;
    'station:loadout': StationLoadoutEvent;
    'station:holding': StationHoldingEvent;
    'station:interview': StationInterviewEvent;
  }
}
