import type { FleetService } from './types';

/** Fleet bus topics (Phase 7 design §4.3). Declared by declaration merging. */

/** First hit of a damage incident. */
export interface FleetDamageEvent {
  unitId: string;
  incidentId: number;
  zone: 'front' | 'rear' | 'left' | 'right';
  amount: number;
  /** m/s. */
  impactSpeed: number;
  pursuit: boolean;
  emergency: boolean;
}

/** An incident closed, `incidentMergeS` after its last hit. */
export interface FleetIncidentEvent {
  unitId: string;
  incidentId: number;
  cost: number;
  wreck: boolean;
}

/** Career charge of an incident (`points` <= 0 is the career delta). */
export interface FleetChargeEvent {
  unitId: string;
  incidentId: number;
  points: number;
  cost: number;
  reason: string;
}

export interface FleetServiceEvent {
  unitId: string;
  service: FleetService;
  cost: number;
}

export interface FleetInspectionEvent {
  unitId: string;
  passed: number;
  /** Ids of the failed inspection items. */
  failed: string[];
}

export interface FleetShiftEndEvent {
  points: number;
  departmentCost: number;
  incidents: number;
  unreported: number;
}

export interface FleetFlashEvent {
  text: string;
}

declare module '../core/event-map' {
  interface EventMap {
    'fleet:damage': FleetDamageEvent;
    'fleet:incident': FleetIncidentEvent;
    'fleet:charge': FleetChargeEvent;
    'fleet:service': FleetServiceEvent;
    'fleet:inspection': FleetInspectionEvent;
    'fleet:shiftEnd': FleetShiftEndEvent;
    'fleet:flash': FleetFlashEvent;
  }
}
