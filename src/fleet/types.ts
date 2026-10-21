import type { InspectionInput } from './inspection';

/** Fleet shared types (Phase 7 design §4.1, §9). */

/** Fleet classes (contract list; the gear policy keys use the same literal strings). */
export const FLEET_CLASSES = [
  'patrol', 'supervisor', 'unmarked', 'traffic', 'k9', 'motor', 'bicycle', 'atv',
  'swat', 'armored', 'transport', 'command', 'lab', 'marine', 'air', 'drone',
] as const;
export type FleetClass = (typeof FLEET_CLASSES)[number];

/** Fleet-yard services. */
export const FLEET_SERVICES = ['refuel', 'oil', 'tires', 'repair', 'all'] as const;
export type FleetService = (typeof FLEET_SERVICES)[number];

/** Where a unit is kept: the station lot, the harbor slip, the helipad or carried by the officer (drone). */
export const FLEET_HOMES = ['lot', 'boatSlip', 'helipad', 'carried'] as const;
export type FleetHome = (typeof FLEET_HOMES)[number];

/** Inspection checks (`inspection.json`). */
export const INSPECTION_CHECKS = [
  'fuelMin', 'oilMin', 'treadMin', 'noFlats', 'engineMin', 'damageReported', 'noFaults', 'loadoutComplete', 'rackSecured', 'cageEmpty',
] as const;
export type InspectionCheck = (typeof INSPECTION_CHECKS)[number];

// --- Data -----------------------------------------------------------------------------------

export interface FleetUnitDef {
  readonly id: string;
  readonly model: string;
  readonly cls: FleetClass;
  /** Default livery id (`DEFAULT_LIVERIES`). */
  readonly livery: string;
  /** Equipment trunk loadout id, null for none. */
  readonly trunk: string | null;
  readonly home: FleetHome;
}

export interface FleetData {
  readonly units: readonly FleetUnitDef[];
  /** Units that start checked out in the lot. */
  readonly startParked: readonly string[];
  /** Units that start checked out at their home (boat slip, helipad). */
  readonly startHome: readonly string[];
  /** Index of the yard slot a checked-out unit spawns at. */
  readonly garageSlot: number;
}

export interface MaintenancePrices {
  readonly fuelPerL: number;
  readonly oilChange: number;
  readonly tire: number;
  readonly bodyPerZone: number;
  readonly enginePerHealth: number;
  readonly engineReplace: number;
}

export interface ChargeConfig {
  readonly pointsPer1000: number;
  readonly wreckPoints: number;
  readonly pursuitFactor: number;
  readonly emergencyFactor: number;
  readonly unreportedFactor: number;
  readonly maxPointsPerIncident: number;
}

export interface MaintenanceConfig {
  readonly prices: MaintenancePrices;
  readonly classMultiplier: Readonly<Record<FleetClass, number>>;
  readonly charges: ChargeConfig;
  readonly wreck: { readonly zoneSum: number; readonly engineFailed: boolean };
  /** Hits within this many sim seconds of the last one belong to the same incident. */
  readonly incidentMergeS: number;
  readonly limits: { readonly incidents: number; readonly reports: number; readonly ledger: number };
}

export interface InspectionItem {
  readonly id: string;
  readonly label: string;
  readonly check: InspectionCheck;
  /** Threshold (0..1) of the min checks. */
  readonly value?: number;
  readonly fix?: FleetService;
}

/** Everything the fleet reads from data; tests inject variants through `FleetDeps.config`. */
export interface FleetConfigs {
  readonly fleet: FleetData;
  readonly maintenance: MaintenanceConfig;
  readonly inspection: readonly InspectionItem[];
}

// --- Accounting ------------------------------------------------------------------------------

export interface QuoteLine {
  kind: 'fuel' | 'oil' | 'tire' | 'body' | 'engine';
  label: string;
  cost: number;
}

export interface Quote {
  lines: QuoteLine[];
  total: number;
}

export type LedgerKind = 'fuel' | 'oil' | 'tire' | 'repair' | 'charge';
export const LEDGER_KINDS: readonly LedgerKind[] = ['fuel', 'oil', 'tire', 'repair', 'charge'];

export interface LedgerEntry {
  seq: number;
  /** Game second. */
  game: number;
  unitId: string;
  kind: LedgerKind;
  cost: number;
  /** Career points (<= 0). */
  points: number;
  note: string;
}

// --- Incidents and requests ---------------------------------------------------------------------

export interface DamageIncident {
  id: number;
  unitId: string;
  shift: number;
  startSim: number;
  lastSim: number;
  game: number;
  /** Damage gained in the incident, front rear left right. */
  zoneDelta: [number, number, number, number];
  engineDelta: number;
  newFlats: number;
  engineFailed: boolean;
  /** Largest impact speed (m/s). */
  maxImpact: number;
  pursuit: boolean;
  emergency: boolean;
  callId: number;
  closed: boolean;
  cost: number;
  wreck: boolean;
  reported: boolean;
  charged: boolean;
}

export interface DamageReport {
  id: number;
  incidentId: number;
  unitId: string;
  game: number;
  text: string;
}

export type FleetRequest =
  | { readonly kind: 'service'; readonly unitId: string; readonly service: FleetService }
  | { readonly kind: 'report'; readonly incidentId: number }
  | { readonly kind: 'inspect'; readonly unitId: string; readonly input: Omit<InspectionInput, 'condition' | 'unreportedIncidents'> }
  | { readonly kind: 'endShift' };

export type UnitStatus = 'ready' | 'service' | 'damaged' | 'out';

export interface FleetUnitView {
  id: string;
  /** Display unit number, the part of the id after the dash. */
  number: string;
  modelId: string;
  /** Vehicle model name. */
  label: string;
  cls: string;
  liveryId: string;
  /** Checked out: a vehicle is bound to the unit. */
  spawned: boolean;
  assigned: boolean;
  /** Fuel, oil 0..1; tread = lowest wheel 0..1; damage = worst body zone 0..1. */
  fuel: number;
  oil: number;
  tread: number;
  damage: number;
  status: UnitStatus;
}
