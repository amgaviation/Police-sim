import { createRng } from '../core/rng';
import { REGISTRY_POPULATION, vehicleRecord } from '../traffic/registry';
import { formatDate } from './calendar';
import { BOLO_DATA } from './data';
import { PERSON_POPULATION } from './ids';
import { displayName, hasGeneratedWarrant, personIdentity } from './person';
import { generateRegistration, registrationFlag, vehicleDescription } from './vehicle';

/** Be-on-the-lookout bulletins (design §5.4): a daily bulletin pure from (seed, day) plus added ones. */

export interface Bolo {
  readonly id: string;
  /** Epoch day. */
  readonly day: number;
  readonly kind: 'vehicle' | 'person';
  /** -1 for a person BOLO. */
  readonly vehicleId: number;
  /** -1 for a vehicle BOLO. */
  readonly personId: number;
  readonly text: string;
}

/** Probe stride (prime, coprime to both populations). */
const PROBE_STRIDE = 7919;
/** Probe caps keep a day's bulletin bounded (~1 ms typical). */
const VEHICLE_PROBES = 4000;
const PERSON_PROBES = 2000;

function probe(start: number, size: number, cap: number, used: ReadonlySet<number>, ok: (id: number) => boolean): number {
  const n = Math.min(cap, size);
  for (let i = 0; i < n; i++) {
    const id = (start + i * PROBE_STRIDE) % size;
    if (!used.has(id) && ok(id)) return id;
  }
  return -1;
}

export function vehicleBoloText(reason: string, vehicleId: number, seed: number): string {
  const reg = generateRegistration(seed, vehicleId);
  return `${reason} - ${vehicleDescription(reg)}, plate ${reg.plate}`;
}

export function personBoloText(reason: string, personId: number, seed: number): string {
  const p = personIdentity(seed, personId);
  return `${reason} - ${displayName(p)}, DOB ${formatDate(p.dob)}`;
}

/**
 * The daily bulletin of `day` (pure). Draws from `'records:bolo:<day>'`: count, then per BOLO
 * (kind, reason, probe start). Vehicle BOLOs name a stolen or flagged registration, person BOLOs a
 * person with a warrant; a BOLO whose capped probe finds nobody is skipped.
 */
export function dailyBolos(seed: number, day: number): Bolo[] {
  const rng = createRng(seed).stream(`records:bolo:${day}`);
  const d = BOLO_DATA;
  const count = rng.nextInt(d.perDay[0], d.perDay[1]);
  const out: Bolo[] = [];
  const usedVehicles = new Set<number>();
  const usedPersons = new Set<number>();
  for (let i = 0; i < count; i++) {
    const isVehicle = rng.next() < d.vehicleShare;
    const uReason = rng.next();
    const start = rng.nextInt(0, 0x7fffffff);
    const id = `BOLO-${day}-${i + 1}`;
    if (isVehicle) {
      const reason = d.vehicleReasons[Math.floor(uReason * d.vehicleReasons.length)] ?? '';
      const v = probe(start % REGISTRY_POPULATION, REGISTRY_POPULATION, VEHICLE_PROBES, usedVehicles,
        (vid) => vehicleRecord(seed, vid).stolen || registrationFlag(seed, vid) !== null);
      if (v < 0) continue;
      usedVehicles.add(v);
      out.push({ id, day, kind: 'vehicle', vehicleId: v, personId: -1, text: vehicleBoloText(reason, v, seed) });
    } else {
      const reason = d.personReasons[Math.floor(uReason * d.personReasons.length)] ?? '';
      const p = probe(start % PERSON_POPULATION, PERSON_POPULATION, PERSON_PROBES, usedPersons, (pid) => hasGeneratedWarrant(seed, pid));
      if (p < 0) continue;
      usedPersons.add(p);
      out.push({ id, day, kind: 'person', vehicleId: -1, personId: p, text: personBoloText(reason, p, seed) });
    }
  }
  return out;
}
