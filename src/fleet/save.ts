import type { RngState } from '../core/rng';
import type { VehicleLoadout } from '../gear/types';
import { parseLivery } from '../livery/schema';
import type { LiveryDoc } from '../livery/types';
import type { SerializedVehicle } from '../vehicles/drivableVehicle';
import { FleetLedger, isLedgerSave, type LedgerSave } from './accounting';
import { FLEET_DATA } from './data';
import type { InspectionResult } from './inspection';
import { FLEET_SERVICES, type DamageIncident, type DamageReport, type FleetRequest } from './types';

/** Persisted fleet state (Phase 7 design §9.6). */

/** Custom liveries kept in the library. */
export const MAX_LIBRARY = 32;

export interface FleetUnitSave {
  id: string;
  liveryId: string;
  /** Custom vehicle loadout; null = the shipped default. */
  loadout: VehicleLoadout | null;
  /** Index into the saved vehicles of the unit's spawned vehicle, -1 when it is in the yard. */
  vehicleIndex: number;
  /** Condition of a checked-in unit (its vehicle, serialized when it was despawned). */
  stored: SerializedVehicle | null;
}

export interface FleetSave {
  version: 1;
  rng: RngState;
  shift: number;
  shiftStartGame: number;
  assigned: string | null;
  units: FleetUnitSave[];
  liveries: LiveryDoc[];
  incidents: DamageIncident[];
  reports: DamageReport[];
  ledger: LedgerSave;
  lastInspection: InspectionResult | null;
  queue: FleetRequest[];
  nextIncident: number;
  nextReport: number;
}

/** A fresh fleet: every unit with its default livery and loadout, nothing spawned. */
export function emptyFleetSave(rng: RngState): FleetSave {
  return {
    version: 1,
    rng,
    shift: 1,
    shiftStartGame: 0,
    assigned: null,
    units: FLEET_DATA.units.map((u) => ({ id: u.id, liveryId: u.livery, loadout: null, vehicleIndex: -1, stored: null })),
    liveries: [],
    incidents: [],
    reports: [],
    ledger: new FleetLedger().serialize(),
    lastInspection: null,
    queue: [],
    nextIncident: 1,
    nextReport: 1,
  };
}

/**
 * v8 -> v9: binds each existing saved vehicle (by model id) to the first unused unit of that model. Vehicles without a
 * unit stay unbound; units without a vehicle get `vehicleIndex` -1.
 */
export function migratedFleetSave(rng: RngState, vehicleModelIds: readonly string[]): FleetSave {
  const save = emptyFleetSave(rng);
  vehicleModelIds.forEach((modelId, index) => {
    const def = FLEET_DATA.units.find((u) => u.model === modelId && save.units.some((s) => s.id === u.id && s.vehicleIndex < 0));
    const unit = def === undefined ? undefined : save.units.find((s) => s.id === def.id);
    if (unit !== undefined) unit.vehicleIndex = index;
  });
  return save;
}

// --- Validation --------------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function int(v: unknown): v is number {
  return num(v) && Number.isInteger(v);
}

function str(v: unknown): v is string {
  return typeof v === 'string';
}

function bool(v: unknown): v is boolean {
  return typeof v === 'boolean';
}

function nums(v: unknown, n: number): boolean {
  return Array.isArray(v) && v.length === n && v.every(num);
}

function isRngState(v: unknown): boolean {
  if (!isRecord(v) || !int(v.seed)) return false;
  const s = v.s;
  return Array.isArray(s) && s.length === 4 && s.every((x) => int(x) && x >= 0 && x < 4294967296);
}

function isLoadout(v: unknown): boolean {
  return (
    isRecord(v) && isRecord(v.trunk) && Object.values(v.trunk).every(int) && Array.isArray(v.rack) && v.rack.every(str)
  );
}

const SERIALIZED_NUMBERS = ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'vx', 'vy', 'vz', 'wx', 'wy', 'wz', 'fuelL', 'engineHealth'] as const;

/** Structural check of a `SerializedVehicle`: a model id string and finite numbers (the vehicle restore clamps). */
export function isStoredVehicle(v: unknown): v is SerializedVehicle {
  if (!isRecord(v) || !str(v.modelId)) return false;
  if (!SERIALIZED_NUMBERS.every((k) => num(v[k]))) return false;
  if (!nums(v.brakeTempC, 2) || !nums(v.zones, 4)) return false;
  if (!bool(v.engineFailed) || !bool(v.headlights) || !bool(v.lightbar) || !bool(v.reversing)) return false;
  if (!Array.isArray(v.tireFlat) || v.tireFlat.length !== 4 || !v.tireFlat.every(bool)) return false;
  if (v.sim !== undefined && !isRecord(v.sim)) return false;
  if (v.wear !== undefined && !(isRecord(v.wear) && num(v.wear.oilL) && nums(v.wear.tread, 4) && num(v.wear.odometerM))) return false;
  if (
    v.craft !== undefined &&
    !(isRecord(v.craft) && num(v.craft.speed) && num(v.craft.vy) && num(v.craft.yaw) && num(v.craft.pitch) && num(v.craft.roll))
  ) {
    return false;
  }
  return v.pushBar === undefined || bool(v.pushBar);
}

function isUnitSave(v: unknown): boolean {
  return (
    isRecord(v) && str(v.id) && str(v.liveryId) && (v.loadout === null || isLoadout(v.loadout)) && int(v.vehicleIndex) &&
    v.vehicleIndex >= -1 && (v.stored === null || isStoredVehicle(v.stored))
  );
}

function isIncident(v: unknown): boolean {
  return (
    isRecord(v) && int(v.id) && str(v.unitId) && int(v.shift) && num(v.startSim) && num(v.lastSim) && num(v.game) &&
    nums(v.zoneDelta, 4) && num(v.engineDelta) && int(v.newFlats) && bool(v.engineFailed) && num(v.maxImpact) &&
    bool(v.pursuit) && bool(v.emergency) && int(v.callId) && bool(v.closed) && num(v.cost) && bool(v.wreck) &&
    bool(v.reported) && bool(v.charged)
  );
}

function isReport(v: unknown): boolean {
  return isRecord(v) && int(v.id) && int(v.incidentId) && str(v.unitId) && num(v.game) && str(v.text);
}

function isInspectionResult(v: unknown): boolean {
  return (
    isRecord(v) && int(v.passed) && Array.isArray(v.failed) && v.failed.every(str) && Array.isArray(v.rows) &&
    v.rows.every((r) => isRecord(r) && str(r.id) && str(r.label) && bool(r.pass) && bool(r.applicable) && str(r.detail) && (r.fix === null || str(r.fix)))
  );
}

function isInspectInput(v: unknown): boolean {
  return (
    isRecord(v) && num(v.faults) && Array.isArray(v.loadoutMissing) && v.loadoutMissing.every(str) && bool(v.hasRack) &&
    bool(v.rackSecured) && bool(v.hasCage) && bool(v.cageEmpty)
  );
}

function isRequest(v: unknown): boolean {
  if (!isRecord(v)) return false;
  switch (v.kind) {
    case 'service':
      return str(v.unitId) && (FLEET_SERVICES as readonly string[]).includes(v.service as string);
    case 'report':
      return int(v.incidentId);
    case 'inspect':
      return str(v.unitId) && isInspectInput(v.input);
    case 'endShift':
      return true;
    default:
      return false;
  }
}

/** Is `x` shaped like a `FleetSave`? Liveries go through `parseLivery`, stored vehicles through a structural check. */
export function isFleetSave(x: unknown): x is FleetSave {
  return (
    isRecord(x) && x.version === 1 && isRngState(x.rng) && int(x.shift) && num(x.shiftStartGame) &&
    (x.assigned === null || str(x.assigned)) && Array.isArray(x.units) && x.units.every(isUnitSave) &&
    Array.isArray(x.liveries) && x.liveries.length <= MAX_LIBRARY && x.liveries.every((l) => parseLivery(l).ok) &&
    Array.isArray(x.incidents) && x.incidents.every(isIncident) && Array.isArray(x.reports) && x.reports.every(isReport) &&
    isLedgerSave(x.ledger) && (x.lastInspection === null || isInspectionResult(x.lastInspection)) &&
    Array.isArray(x.queue) && x.queue.every(isRequest) && int(x.nextIncident) && int(x.nextReport)
  );
}
