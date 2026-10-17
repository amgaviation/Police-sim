import { createRng, type Rng } from '../core/rng';
import { FAULT } from '../vehicles/components';
import { TRAFFIC_MODELS, pickModelColor, type VehicleModel } from '../vehicles/model';
import { REGISTRY, VIOLATIONS } from './data';

/**
 * Persistent vehicle registry (design §9.1). Every record is a pure function of
 * (seed, id) drawn from its own stream `'registry:<id>'`, so nothing is stored and
 * CAD can look up any vehicle, on the road or not.
 */

/** Registered vehicles: ids 0 .. REGISTRY_POPULATION - 1. */
export const REGISTRY_POPULATION = REGISTRY.population;

/** Plate space: 3 letters x 4 digits. */
export const PLATE_SPACE = 26 ** 3 * 10 ** 4;
/** Plate multiplier, coprime to PLATE_SPACE (= 2^7 * 5^4 * 13^3), so id -> plate is a bijection. */
const PLATE_A = 108626917;
const PLATE_RE = /^([A-Z]{3}) (\d{4})$/;

export interface VehicleTendencies {
  readonly speeding: boolean;
  readonly tailgating: boolean;
  readonly redLight: boolean;
  readonly rollingStop: boolean;
  /** Per-trip DUI chance before the hour multiplier (mean = data share). */
  readonly duiRisk: number;
}

export interface VehicleRecord {
  readonly id: number;
  readonly plate: string;
  readonly modelId: string;
  /** `VehicleModel.index` (what `VehicleLook.model` stores). */
  readonly modelIndex: number;
  /** 0xRRGGBB. */
  readonly color: number;
  readonly year: number;
  readonly registrationExpired: boolean;
  readonly insured: boolean;
  readonly stolen: boolean;
  /** `FAULT` bits. */
  readonly faults: number;
  /** Phase 2 derives the owner identity from this. */
  readonly ownerSeed: number;
  readonly tendencies: VehicleTendencies;
}

/** a * b mod m for non-negative a, b < m < 2^28 without leaving the exact double range. */
function mulMod(a: number, b: number, m: number): number {
  const hi = Math.floor(b / 16384);
  const lo = b % 16384;
  return (((a * hi) % m) * 16384 + a * lo) % m;
}

/** Modular inverse of a mod m (a coprime to m), extended Euclid. */
function modInverse(a: number, m: number): number {
  let t = 0, nt = 1, r = m, nr = a % m;
  while (nr !== 0) {
    const q = Math.floor(r / nr);
    [t, nt] = [nt, t - q * nt];
    [r, nr] = [nr, r - q * nr];
  }
  return t < 0 ? t + m : t;
}

const PLATE_A_INV = modInverse(PLATE_A, PLATE_SPACE);

/** Seed-dependent plate offset B(seed). */
function plateOffset(seed: number): number {
  return createRng(seed).stream('registry:plate').nextInt(0, PLATE_SPACE - 1);
}

const LETTER_A = 65;

/** Plate number n in [0, PLATE_SPACE) as 'ABC 1234'. */
function formatPlate(n: number): string {
  const letters = Math.floor(n / 10000);
  const digits = n % 10000;
  return (
    String.fromCharCode(LETTER_A + Math.floor(letters / 676), LETTER_A + (Math.floor(letters / 26) % 26), LETTER_A + (letters % 26)) +
    ' ' +
    String(digits).padStart(4, '0')
  );
}

/** Plate of registered vehicle `id`: n = (id * A + B(seed)) mod 26^3 * 10^4, rendered 'ABC 1234'. */
export function plateOf(seed: number, id: number): string {
  return formatPlate((mulMod(id % PLATE_SPACE, PLATE_A, PLATE_SPACE) + plateOffset(seed)) % PLATE_SPACE);
}

/** Exact inverse of `plateOf`; null when the plate is malformed or decodes outside the population. */
export function vehicleIdFromPlate(seed: number, plate: string): number | null {
  const m = PLATE_RE.exec(plate.trim().toUpperCase());
  if (!m) return null;
  const letters = m[1] as string;
  const l = (letters.charCodeAt(0) - LETTER_A) * 676 + (letters.charCodeAt(1) - LETTER_A) * 26 + (letters.charCodeAt(2) - LETTER_A);
  const n = l * 10000 + Number(m[2]);
  const diff = (n - plateOffset(seed) + PLATE_SPACE) % PLATE_SPACE;
  const id = mulMod(diff, PLATE_A_INV, PLATE_SPACE);
  return id < REGISTRY_POPULATION ? id : null;
}

/** Weighted pick of a traffic model for `u` in [0, 1). */
export function pickTrafficModel(u: number): VehicleModel {
  let total = 0;
  for (const m of TRAFFIC_MODELS) total += m.trafficWeight;
  let x = u * total;
  for (const m of TRAFFIC_MODELS) {
    x -= m.trafficWeight;
    if (x < 0) return m;
  }
  const last = TRAFFIC_MODELS[TRAFFIC_MODELS.length - 1];
  if (!last) throw new Error('No vehicle model has trafficWeight > 0');
  return last;
}

/** The record's own stream; draws below happen in a fixed order, so adding fields must append. */
function recordRng(seed: number, id: number): Rng {
  return createRng(seed).stream(`registry:${id}`);
}

/** Registered vehicle `id` (pure; throws RangeError outside the population). */
export function vehicleRecord(seed: number, id: number): VehicleRecord {
  if (!Number.isInteger(id) || id < 0 || id >= REGISTRY_POPULATION) {
    throw new RangeError(`vehicleRecord: id ${id} outside [0, ${REGISTRY_POPULATION})`);
  }
  const rng = recordRng(seed, id);
  const flags = VIOLATIONS.vehicleFlags;
  const b = VIOLATIONS.behaviors;
  const model = pickTrafficModel(rng.next());
  const color = pickModelColor(model, rng.next());
  const year = rng.nextInt(REGISTRY.yearRange[0], REGISTRY.yearRange[1]);
  const registrationExpired = rng.chance(flags.expiredRegistration);
  const insured = !rng.chance(flags.noInsurance);
  const stolen = rng.chance(flags.stolen);
  let faults = 0;
  if (rng.chance(flags.headlightOut)) faults |= rng.next() < 0.5 ? FAULT.headLeftOut : FAULT.headRightOut;
  if (rng.chance(flags.taillightOut)) faults |= FAULT.tailOut;
  if (rng.chance(flags.brakeLightOut)) faults |= FAULT.brakeOut;
  const ownerSeed = rng.nextInt(0, 0xffffffff);
  const tendencies: VehicleTendencies = {
    speeding: rng.chance(b.speeding.share),
    tailgating: rng.chance(b.tailgating.share),
    redLight: rng.chance(b.redLight.share),
    rollingStop: rng.chance(b.rollingStop.share),
    // Uniform in [0, 2 * share]: the population mean equals the data share.
    duiRisk: 2 * b.dui.share * rng.next(),
  };
  return {
    id,
    plate: plateOf(seed, id),
    modelId: model.id,
    modelIndex: model.index,
    color,
    year,
    registrationExpired,
    insured,
    stolen,
    faults,
    ownerSeed,
    tendencies,
  };
}
