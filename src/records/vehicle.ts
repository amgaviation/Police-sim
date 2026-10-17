import { createRng } from '../core/rng';
import { REGISTRY_POPULATION, vehicleRecord } from '../traffic/registry';
import { VEHICLE_MODELS } from '../vehicles/model';
import { CALENDAR } from './calendar';
import { VEHICLE_DATA } from './data';
import { hash3, unitHash } from './hash';
import { PERSON_POPULATION, ownerOfVehicle, vinOf } from './ids';
import { hasGeneratedWarrant } from './person';

/**
 * Registrations, mounted plates and plate states (design §5.3). The Phase 1 `vehicleRecord`
 * (model, colour, year, expired, insured, stolen) is used unchanged; the rest is drawn from
 * `createRng(seed).stream('records:vehicle:<id>')` or from fast integer hashes.
 */

export const PLATE_FLAG = { expired: 1, stolen: 2, cloned: 4, mismatched: 8, flagged: 16 } as const;
export type PlateFlagName = keyof typeof PLATE_FLAG;
export const PLATE_FLAG_NAMES: readonly PlateFlagName[] = ['expired', 'stolen', 'cloned', 'mismatched', 'flagged'];

export type PlateAnomaly = 'none' | 'cloned' | 'mismatched' | 'stolenPlate';

export interface MountedPlate {
  /** The physical car. */
  readonly vehicleId: number;
  readonly plate: string;
  /** Registration the mounted plate belongs to (= vehicleId when anomaly is 'none'). */
  readonly plateVehicleId: number;
  readonly anomaly: PlateAnomaly;
}

export interface ObservedVehicle {
  readonly modelId: string;
  /** 0xRRGGBB. */
  readonly color: number;
}

export interface RegistrationRecord {
  readonly vehicleId: number;
  readonly plate: string;
  readonly vin: string;
  readonly year: number;
  readonly modelId: string;
  readonly modelName: string;
  readonly color: number;
  readonly colorName: string;
  readonly ownerId: number;
  /** Epoch day. */
  readonly expires: number;
  readonly expired: boolean;
  readonly insured: boolean;
  /** '' when uninsured. */
  readonly insurer: string;
  readonly stolen: boolean;
  readonly plateReportedStolen: boolean;
  readonly cloneAlert: boolean;
  readonly flag: string | null;
}

const SALT_PLATE_STOLEN = 0x5645_0001;
const SALT_CLONE_ALERT = 0x5645_0002;
const SALT_DONOR = 0x5645_0003;
/** Donor probe stride, coprime to the registry population. */
const DONOR_STRIDE = 7919;

/** Intrinsic: this registration's plates were reported stolen (donor pool for 'stolenPlate'). */
export function plateReportedStolen(seed: number, vehicleId: number): boolean {
  return unitHash(seed, SALT_PLATE_STOLEN, vehicleId) < VEHICLE_DATA.intrinsic.plateReportedStolen;
}

/**
 * Whether registered car `vehicleId` may appear in traffic: a registration whose plates were
 * reported stolen is kept off the road (its owner is assumed to drive on replacement plates), so
 * a reported-stolen plate is only ever seen on another car (anomaly 'stolenPlate').
 */
export function canBeOnRoad(seed: number, vehicleId: number): boolean {
  return !plateReportedStolen(seed, vehicleId);
}

/** Intrinsic: a clone alert is on file for this registration (donor pool for 'cloned'). */
export function cloneAlert(seed: number, vehicleId: number): boolean {
  return unitHash(seed, SALT_CLONE_ALERT, vehicleId) < VEHICLE_DATA.intrinsic.cloneAlert;
}

/** Colour name of the exact palette entry, else of the nearest one (RGB distance). */
export function colorName(rgb: number): string {
  let best = '';
  let bestD = Infinity;
  const r = (rgb >> 16) & 255, g = (rgb >> 8) & 255, b = rgb & 255;
  for (const c of VEHICLE_DATA.colors) {
    const dr = ((c.rgb >> 16) & 255) - r, dg = ((c.rgb >> 8) & 255) - g, db = (c.rgb & 255) - b;
    const d = dr * dr + dg * dg + db * db;
    if (d < bestD) {
      bestD = d;
      best = c.name;
    }
  }
  return best;
}

/** Display name of a vehicle model id (the id itself when unknown). */
export function modelName(modelId: string): string {
  return VEHICLE_MODELS.find((m) => m.id === modelId)?.name ?? modelId;
}

/** "2019 black Sedan". */
export function vehicleDescription(r: { year: number; colorName: string; modelName: string }): string {
  return `${r.year} ${r.colorName} ${r.modelName}`;
}

interface VehicleDraws {
  readonly uExpiry: number;
  readonly uInsurer: number;
  readonly uFlag: number;
  readonly uReason: number;
  readonly uAnomaly: number;
  readonly uDriver: number;
  readonly otherDriver: number;
}

/**
 * Draws from `'records:vehicle:<id>'` in a FIXED, APPEND-ONLY order (always all of them):
 * 1 expiry, 2 insurer, 3 flag, 4 flag reason, 5 plate anomaly, 6 driver is owner, 7 other driver.
 */
function vehicleDraws(seed: number, vehicleId: number): VehicleDraws {
  const rng = createRng(seed).stream(`records:vehicle:${vehicleId}`);
  return {
    uExpiry: rng.next(),
    uInsurer: rng.next(),
    uFlag: rng.next(),
    uReason: rng.next(),
    uAnomaly: rng.next(),
    uDriver: rng.next(),
    otherDriver: rng.nextInt(0, PERSON_POPULATION - 2),
  };
}

function at<T>(list: readonly T[], u: number): T {
  const v = list[Math.min(list.length - 1, Math.floor(u * list.length))];
  if (v === undefined) throw new RangeError('at: empty list');
  return v;
}

/** Registration of registered vehicle `vehicleId` (RangeError outside the registry). */
export function generateRegistration(seed: number, vehicleId: number): RegistrationRecord {
  const rec = vehicleRecord(seed, vehicleId);
  const dr = vehicleDraws(seed, vehicleId);
  const reg = VEHICLE_DATA.registration;
  const start = CALENDAR.startEpochDay;
  const expires = rec.registrationExpired
    ? start - 1 - Math.floor(dr.uExpiry * reg.expiredMaxDays)
    : start + reg.validMinDays + Math.floor(dr.uExpiry * (reg.validMaxDays - reg.validMinDays + 1));
  return {
    vehicleId,
    plate: rec.plate,
    vin: vinOf(seed, vehicleId),
    year: rec.year,
    modelId: rec.modelId,
    modelName: modelName(rec.modelId),
    color: rec.color,
    colorName: colorName(rec.color),
    ownerId: ownerOfVehicle(seed, vehicleId),
    expires,
    expired: rec.registrationExpired,
    insured: rec.insured,
    insurer: rec.insured ? at(VEHICLE_DATA.insurers, dr.uInsurer) : '',
    stolen: rec.stolen,
    plateReportedStolen: plateReportedStolen(seed, vehicleId),
    cloneAlert: cloneAlert(seed, vehicleId),
    flag: registrationFlag(seed, vehicleId),
  };
}

/** Vehicle flag reason of registration `vehicleId` (cheaper than a full registration). */
export function registrationFlag(seed: number, vehicleId: number): string | null {
  const dr = vehicleDraws(seed, vehicleId);
  return dr.uFlag < VEHICLE_DATA.flags.rate ? at(VEHICLE_DATA.flags.reasons, dr.uReason) : null;
}

/** First donor id (probing from a hash start with a coprime stride, skipping `self`) accepted by `ok`; -1 if none. */
function findDonor(seed: number, self: number, ok: (id: number) => boolean): number {
  const start = hash3(seed, SALT_DONOR, self) % REGISTRY_POPULATION;
  for (let i = 0; i < REGISTRY_POPULATION; i++) {
    const id = (start + i * DONOR_STRIDE) % REGISTRY_POPULATION;
    if (id !== self && ok(id)) return id;
  }
  return -1;
}

/** What is physically mounted on car `vehicleId`: its own plate or (exclusive anomalies) a donor's. */
export function mountedPlate(seed: number, vehicleId: number): MountedPlate {
  const rec = vehicleRecord(seed, vehicleId);
  const own: MountedPlate = { vehicleId, plate: rec.plate, plateVehicleId: vehicleId, anomaly: 'none' };
  if (rec.stolen) return own; // a stolen vehicle keeps its own plate
  const a = VEHICLE_DATA.plateAnomalies;
  const u = vehicleDraws(seed, vehicleId).uAnomaly;
  let anomaly: PlateAnomaly = 'none';
  let donor = -1;
  if (u < a.cloned) {
    anomaly = 'cloned';
    donor = findDonor(seed, vehicleId, (id) => {
      if (!cloneAlert(seed, id)) return false;
      const b = vehicleRecord(seed, id);
      return b.modelId === rec.modelId && b.color === rec.color;
    });
  } else if (u < a.cloned + a.mismatched) {
    anomaly = 'mismatched';
    donor = findDonor(seed, vehicleId, (id) => vehicleRecord(seed, id).modelId !== rec.modelId);
  } else if (u < a.cloned + a.mismatched + a.stolenPlate) {
    anomaly = 'stolenPlate';
    donor = findDonor(seed, vehicleId, (id) => plateReportedStolen(seed, id));
  }
  if (donor < 0) return own;
  return { vehicleId, plate: vehicleRecord(seed, donor).plate, plateVehicleId: donor, anomaly };
}

/** The car's true model and colour (what an officer sees). */
export function observedVehicle(seed: number, vehicleId: number): ObservedVehicle {
  const rec = vehicleRecord(seed, vehicleId);
  return { modelId: rec.modelId, color: rec.color };
}

/**
 * Truth `PLATE_FLAG` bits of car `vehicleId` (a car that `canBeOnRoad`): stolen = the vehicle is
 * stolen or wears a donor plate reported stolen (anomaly 'stolenPlate'); cloned / mismatched = the
 * anomaly; expired / flagged = the registration the mounted plate belongs to is expired / has a
 * vehicle flag or an owner with a generated warrant. This is pre-overlay truth: warrants served
 * during the game (RecordsDb) are not applied, so a plate run may show fewer flags afterwards.
 */
export function plateFlags(seed: number, vehicleId: number): number {
  const rec = vehicleRecord(seed, vehicleId);
  const mp = mountedPlate(seed, vehicleId);
  const reg = generateRegistration(seed, mp.plateVehicleId);
  let flags = 0;
  // 'stolenPlate' implies reg.plateReportedStolen (what a plate run detects). A registration with
  // reported-stolen plates never drives on them itself (`canBeOnRoad`).
  if (rec.stolen || mp.anomaly === 'stolenPlate') flags |= PLATE_FLAG.stolen;
  if (mp.anomaly === 'cloned') flags |= PLATE_FLAG.cloned;
  if (mp.anomaly === 'mismatched') flags |= PLATE_FLAG.mismatched;
  if (reg.expired) flags |= PLATE_FLAG.expired;
  if (reg.flag !== null || hasGeneratedWarrant(seed, reg.ownerId)) flags |= PLATE_FLAG.flagged;
  return flags;
}

/**
 * Person driving car `vehicleId`: the owner with probability `driverIsOwner`, else another person;
 * never the owner when the vehicle is stolen or its plate anomalous.
 */
export function driverOf(seed: number, vehicleId: number): number {
  const rec = vehicleRecord(seed, vehicleId);
  const dr = vehicleDraws(seed, vehicleId);
  const owner = ownerOfVehicle(seed, vehicleId);
  const canBeOwner = !rec.stolen && mountedPlate(seed, vehicleId).anomaly === 'none';
  if (canBeOwner && dr.uDriver < VEHICLE_DATA.driverIsOwner) return owner;
  return dr.otherDriver >= owner ? dr.otherDriver + 1 : dr.otherDriver;
}
