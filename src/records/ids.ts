import { REGISTRY_POPULATION, vehicleRecord } from '../traffic/registry';
import { BODY_STYLES, VEHICLE_MODELS } from '../vehicles/model';
import { PERSON_DATA, VEHICLE_DATA, VIN_ALPHABET } from './data';
import { hash3, modInverse, mulMod, posMod, seedOffset } from './hash';

/**
 * Identity bijections (design §5.1): vehicle -> owner, person -> DL number, vehicle -> VIN.
 * Each is an affine map `(id * A + B(seed)) mod N` with A coprime to N, so it is exactly
 * invertible and needs no storage.
 */

/** Persons: ids 0 .. PERSON_POPULATION - 1. */
export const PERSON_POPULATION = PERSON_DATA.population;

if (PERSON_POPULATION < REGISTRY_POPULATION) {
  throw new Error(`person.json: population (${PERSON_POPULATION}) must be >= the vehicle registry (${REGISTRY_POPULATION})`);
}

/** Owner multiplier (prime, coprime to 2 and 5). */
const OWNER_A = 48271;
const OWNER_A_INV = modInverse(OWNER_A, PERSON_POPULATION);

/** DL numbers: 7 digits. */
const DL_SPACE = 10_000_000;
const DL_A = 7654321;
const DL_A_INV = modInverse(DL_A, DL_SPACE);
const DL_RE = /^D(\d{7})$/;

const VIN_BASE = VIN_ALPHABET.length; // 33
/** Six base-33 serial characters. */
const SERIAL_SPACE = VIN_BASE ** 6;
/** Coprime to 3 and 11. */
const SERIAL_A = 1000003;
const SERIAL_A_INV = modInverse(SERIAL_A, SERIAL_SPACE);
const VIN_LENGTH = 17;
const VIN_CHECK_POS = 8;
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2] as const;
const SALT_VIN_BODY = 0x5649_4e01;
const SALT_VIN_PLANT = 0x5649_4e02;

function isIdIn(id: number, size: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < size;
}

/** Registered owner of registered vehicle `vehicleId` (distinct for every vehicle). */
export function ownerOfVehicle(seed: number, vehicleId: number): number {
  if (!isIdIn(vehicleId, REGISTRY_POPULATION)) throw new RangeError(`ownerOfVehicle: id ${vehicleId} outside [0, ${REGISTRY_POPULATION})`);
  return (mulMod(vehicleId, OWNER_A, PERSON_POPULATION) + seedOffset(seed, 'records:owner', PERSON_POPULATION)) % PERSON_POPULATION;
}

/** The vehicle registered to `personId`, or -1 when the person owns none. */
export function vehicleOfOwner(seed: number, personId: number): number {
  if (!isIdIn(personId, PERSON_POPULATION)) return -1;
  const diff = posMod(personId - seedOffset(seed, 'records:owner', PERSON_POPULATION), PERSON_POPULATION);
  const v = mulMod(diff, OWNER_A_INV, PERSON_POPULATION);
  return v < REGISTRY_POPULATION ? v : -1;
}

/** Driver licence number "D1234567" of a person (assigned to everyone; a record may still say no licence). */
export function dlNumberOf(seed: number, personId: number): string {
  if (!isIdIn(personId, PERSON_POPULATION)) throw new RangeError(`dlNumberOf: id ${personId} outside [0, ${PERSON_POPULATION})`);
  const n = (mulMod(personId, DL_A, DL_SPACE) + seedOffset(seed, 'records:dl', DL_SPACE)) % DL_SPACE;
  return `D${String(n).padStart(7, '0')}`;
}

/** Inverse of `dlNumberOf`; null when malformed or outside the population. */
export function personIdFromDl(seed: number, dl: string): number | null {
  const m = DL_RE.exec(dl.trim().toUpperCase());
  if (!m) return null;
  const n = Number(m[1]);
  const id = mulMod(posMod(n - seedOffset(seed, 'records:dl', DL_SPACE), DL_SPACE), DL_A_INV, DL_SPACE);
  return id < PERSON_POPULATION ? id : null;
}

function vinChar(n: number): string {
  return VIN_ALPHABET.charAt(posMod(n, VIN_BASE));
}

function vinValue(ch: string): number {
  return VIN_ALPHABET.indexOf(ch);
}

/**
 * 17-character VIN: prefix (2) + model code + body code + 4 hash chars + check char + year code +
 * plant char + 6-char base-33 serial (an affine bijection of the vehicle id).
 */
export function vinOf(seed: number, vehicleId: number): string {
  const rec = vehicleRecord(seed, vehicleId); // RangeError outside the registry
  const model = VEHICLE_MODELS[rec.modelIndex];
  const style = model ? BODY_STYLES.indexOf(model.body.style) : 0;
  let h = hash3(seed, SALT_VIN_BODY, vehicleId) % VIN_BASE ** 4;
  const body: string[] = [];
  for (let i = 0; i < 4; i++) {
    body.push(vinChar(h % VIN_BASE));
    h = Math.floor(h / VIN_BASE);
  }
  let serial = (mulMod(vehicleId, SERIAL_A, SERIAL_SPACE) + seedOffset(seed, 'records:vin', SERIAL_SPACE)) % SERIAL_SPACE;
  const serialChars: string[] = [];
  for (let i = 0; i < 6; i++) {
    serialChars.unshift(vinChar(serial % VIN_BASE));
    serial = Math.floor(serial / VIN_BASE);
  }
  const chars = [
    ...VEHICLE_DATA.vinPrefix,
    vinChar(rec.modelIndex),
    vinChar(style),
    ...body,
    '0', // check placeholder
    vinChar(rec.year),
    vinChar(hash3(seed, SALT_VIN_PLANT, vehicleId)),
    ...serialChars,
  ];
  chars[VIN_CHECK_POS] = vinChar(vinCheckSum(chars));
  return chars.join('');
}

function vinCheckSum(chars: readonly string[]): number {
  let sum = 0;
  for (let i = 0; i < VIN_LENGTH; i++) {
    if (i !== VIN_CHECK_POS) sum += vinValue(chars[i] ?? '0') * (VIN_WEIGHTS[i] ?? 0);
  }
  return sum;
}

/** Inverse of `vinOf`: decodes the serial, then requires the whole VIN to match; null otherwise. */
export function vehicleIdFromVin(seed: number, vin: string): number | null {
  const v = vin.trim().toUpperCase();
  if (v.length !== VIN_LENGTH) return null;
  let serial = 0;
  for (let i = 0; i < VIN_LENGTH; i++) {
    const value = vinValue(v.charAt(i));
    if (value < 0) return null;
    if (i >= VIN_LENGTH - 6) serial = serial * VIN_BASE + value;
  }
  const id = mulMod(posMod(serial - seedOffset(seed, 'records:vin', SERIAL_SPACE), SERIAL_SPACE), SERIAL_A_INV, SERIAL_SPACE);
  if (id >= REGISTRY_POPULATION) return null;
  return vinOf(seed, id) === v ? id : null;
}
