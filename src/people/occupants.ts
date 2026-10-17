import { hash3, unitHash } from '../records/hash';
import { PERSON_POPULATION } from '../records/ids';
import { driverOf } from '../records/vehicle';
import { REGISTRY_POPULATION } from '../traffic/registry';
import { PEOPLE_DATA } from './data';
import { SALT } from './salt';

/**
 * People in registry vehicle `vehicleId`: the driver (`driverOf`) first, then 0..3 passengers drawn from
 * `occupants.passengers`. Fleet vehicle ids (>= `FLEET_ID_BASE`, outside the registry) and invalid ids give [].
 */
export function occupantsOf(seed: number, vehicleId: number): number[] {
  if (!Number.isInteger(vehicleId) || vehicleId < 0 || vehicleId >= REGISTRY_POPULATION) return [];
  const driver = driverOf(seed, vehicleId);
  const out = [driver];
  const p = PEOPLE_DATA.occupants.passengers;
  const u = unitHash(seed, SALT.passengers, vehicleId);
  let count = p.length - 1;
  let acc = 0;
  for (let i = 0; i < p.length; i++) {
    acc += p[i] ?? 0;
    if (u < acc) {
      count = i;
      break;
    }
  }
  for (let k = 0; k < count; k++) {
    let id = hash3(seed, SALT.passenger + k, vehicleId) % PERSON_POPULATION;
    while (out.includes(id)) id = (id + 1) % PERSON_POPULATION;
    out.push(id);
  }
  return out;
}
