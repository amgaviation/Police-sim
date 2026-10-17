/**
 * CAD and dispatch bus topics (design §14). The `dispatch:*` topics and `unit:request` are declared
 * here (wave 1) so the radio, MDT and integrator can consume what the dispatcher emits without
 * importing it. Payloads are emitted on rare events only.
 */
import type { DocKind } from './documents';
import type { PersonReadback, PlateReadback, Priority, RequestVia, UnitRequest, UnitStatus } from './types';

export interface CadCallCreatedEvent {
  callId: number;
  typeId: string;
  priority: Priority;
  selfInitiated: boolean;
}

export type CadCallChange = 'narrative' | 'priority' | 'units' | 'status' | 'offer' | 'links' | 'location';

export interface CadCallUpdatedEvent {
  callId: number;
  change: CadCallChange;
}

export interface CadCallClosedEvent {
  callId: number;
  disposition: string;
}

export type AssignedBy = 'dispatch' | 'self' | 'backup';

export interface CadUnitAssignedEvent {
  callId: number;
  callsign: string;
  by: AssignedBy;
}

export interface CadUnitStatusEvent {
  callsign: string;
  status: UnitStatus;
  prev: UnitStatus;
  /** The unit's call after the change (null when it has none). */
  callId: number | null;
  via: RequestVia;
}

export interface CadDocumentSavedEvent {
  id: string;
  kind: DocKind;
  final: boolean;
}

export interface CadTrafficStopEvent {
  active: boolean;
  callId: number;
  vehicleId: number;
}

/** A unit's request (radio, MDT, voice, keys); the dispatcher queues it for its next step. */
export interface UnitRequestEvent {
  callsign: string;
  request: UnitRequest;
  via: RequestVia;
}

export interface DispatchOfferEvent {
  callId: number;
  callsign: string;
  /** True when the offer timed out without an answer. */
  expired: boolean;
}

export interface DispatchPlateResultEvent {
  callsign: string;
  via: RequestVia;
  vehicleId: number;
  readback: PlateReadback;
}

export interface DispatchPersonResultEvent {
  callsign: string;
  via: RequestVia;
  readback: PersonReadback;
}

export interface DispatchBackupEvent {
  requester: string;
  code: 2 | 3;
  units: string[];
  x: number;
  z: number;
  location: string;
}

export interface DispatchEmergencyEvent {
  callsign: string;
  active: boolean;
  units: string[];
  location: string;
}

export interface DispatchStatusCheckEvent {
  callsign: string;
  attempt: number;
  escalated: boolean;
  location: string;
}

export interface DispatchLocationEvent {
  callsign: string;
  text: string;
  /** True when dispatch asked for the unit's 10-20 (status check attempt 2). */
  asked: boolean;
}

export interface DispatchAckEvent {
  callsign: string;
  kind: UnitRequest['kind'];
  ok: boolean;
  text: string;
}

export interface DispatchArrestEvent {
  personId: number;
  callId: number;
}

declare module '../core/event-map' {
  interface EventMap {
    'cad:callCreated': CadCallCreatedEvent;
    'cad:callUpdated': CadCallUpdatedEvent;
    'cad:callClosed': CadCallClosedEvent;
    'cad:unitAssigned': CadUnitAssignedEvent;
    'cad:unitStatus': CadUnitStatusEvent;
    'cad:documentSaved': CadDocumentSavedEvent;
    'cad:trafficStop': CadTrafficStopEvent;
    'unit:request': UnitRequestEvent;
    'dispatch:offer': DispatchOfferEvent;
    'dispatch:plateResult': DispatchPlateResultEvent;
    'dispatch:personResult': DispatchPersonResultEvent;
    'dispatch:backup': DispatchBackupEvent;
    'dispatch:emergency': DispatchEmergencyEvent;
    'dispatch:statusCheck': DispatchStatusCheckEvent;
    'dispatch:location': DispatchLocationEvent;
    'dispatch:ack': DispatchAckEvent;
    'dispatch:arrest': DispatchArrestEvent;
  }
}
