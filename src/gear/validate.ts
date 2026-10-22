/** Loadout validation against assignment policy and vehicle cargo (design §8.3). Pure. */
import { EQUIPMENT_DATA, ITEMS_DATA } from '../police/data';
import { RACK_ITEMS } from '../police/equipment';
import { GEAR_ITEMS, GEAR_POLICY, OFFICER_PRESETS, assignmentPolicy, gearItem } from './data';
import {
  GEAR_SLOTS,
  type GearIssue,
  type GearIssueCode,
  type GearSlot,
  type LoadoutValidation,
  type OfficerLoadout,
  type VehicleCapacity,
  type VehicleLoadout,
} from './types';

/** Slot capacity without providers (a belt or vest provides room). */
export const BASE_SLOT_CAPACITY: Readonly<Record<GearSlot, number>> = { belt: 0, vest: 0, body: 2, longGun: 1, carry: 2 };
/** Warn when the carried weight passes this share of the assignment limit. */
export const WEIGHT_WARNING_SHARE = 0.85;
/** Assignments that should carry a CED (warning only). */
const TASER_EXPECTED: ReadonlySet<string> = new Set(['patrol', 'traffic', 'supervisor']);
/** Most of one trunk item a vehicle loadout may hold. */
const MAX_TRUNK_COUNT = 99;

/** Rounds to 1e-6 so sums such as 3 x 0.05 are exact. */
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6;

function emptySlots(): Record<GearSlot, { used: number; cap: number }> {
  return { belt: { used: 0, cap: 0 }, vest: { used: 0, cap: 0 }, body: { used: 0, cap: 0 }, longGun: { used: 0, cap: 0 }, carry: { used: 0, cap: 0 } };
}

const issue = (code: GearIssueCode, item: string | null, message: string): GearIssue => ({ code, item, message });

const validCount = (n: number): boolean => Number.isInteger(n) && n >= 1;

/** Total mass of the loadout's known items (unknown ids weigh nothing). */
export function loadoutWeightKg(l: OfficerLoadout): number {
  let kg = 0;
  for (const it of l.items) {
    const def = gearItem(it.id);
    if (def !== undefined && validCount(it.count)) kg += def.weightKg * it.count;
  }
  return round6(kg);
}

/**
 * Checks an officer loadout against its assignment's policy. Every failure is collected, in this order: unknown ids,
 * count ranges (and duplicate ids), slot capacity, weight, required, forbidden, retention, long guns, `requires`.
 * `extraVestSlots` is the bonus of the uniform's external carrier.
 */
export function validateOfficerLoadout(l: OfficerLoadout, opts: { extraVestSlots?: number } = {}): LoadoutValidation {
  const policy = assignmentPolicy(l.assignment);
  const errors: GearIssue[] = [];
  const warnings: GearIssue[] = [];
  const present = new Set<string>();
  const slots = emptySlots();
  for (const s of GEAR_SLOTS) slots[s].cap = BASE_SLOT_CAPACITY[s];
  slots.vest.cap += Math.max(0, Math.trunc(opts.extraVestSlots ?? 0));

  const seen = new Set<string>();
  let longGuns = 0;
  for (const it of l.items) {
    const def = gearItem(it.id);
    if (def === undefined) {
      errors.push(issue('unknownItem', it.id, `Unknown item "${it.id}"`));
      continue;
    }
    if (seen.has(it.id)) errors.push(issue('countRange', it.id, `${def.label} is listed twice`));
    seen.add(it.id);
    present.add(it.id);
    if (!validCount(it.count) || it.count > def.max) {
      errors.push(issue('countRange', it.id, `${def.label}: count must be 1 to ${String(def.max)}, got ${String(it.count)}`));
      if (!validCount(it.count)) continue;
    }
    slots[def.slot].used += def.size * it.count;
    if (def.slot === 'longGun') longGuns += it.count;
    for (const s of GEAR_SLOTS) slots[s].cap += (def.provides[s] ?? 0) * it.count;
  }
  for (const s of GEAR_SLOTS) {
    if (slots[s].used > slots[s].cap) errors.push(issue('slotsFull', null, `Too much for the ${s} slot (${String(slots[s].used)} of ${String(slots[s].cap)})`));
  }

  const weightKg = loadoutWeightKg(l);
  if (weightKg > policy.maxKg) {
    errors.push(issue('overweight', null, `${String(weightKg)} kg is over the ${String(policy.maxKg)} kg limit for ${policy.label}`));
  } else if (weightKg > policy.maxKg * WEIGHT_WARNING_SHARE) {
    warnings.push(issue('overweight', null, `${String(weightKg)} kg is close to the ${String(policy.maxKg)} kg limit`));
  }

  for (const id of policy.required) {
    if (!present.has(id)) errors.push(issue('missingRequired', id, `${policy.label} requires ${gearItem(id)?.label ?? id}`));
  }
  for (const id of policy.forbidden) {
    if (present.has(id)) errors.push(issue('forbidden', id, `${policy.label} may not carry ${gearItem(id)?.label ?? id}`));
  }
  for (const it of l.items) {
    const def = gearItem(it.id);
    if (def === undefined || !def.retention || !present.has(it.id)) continue;
    if (it.retention === undefined) errors.push(issue('retentionMissing', it.id, `${def.label} needs a retention level`));
    else if (it.retention < policy.minRetention) {
      errors.push(issue('retentionTooLow', it.id, `${policy.label} needs retention level ${String(policy.minRetention)} or higher`));
    }
  }
  if (longGuns > policy.maxLongGuns) errors.push(issue('tooManyLongGuns', null, `${policy.label} may carry ${String(policy.maxLongGuns)} long guns, not ${String(longGuns)}`));
  for (const it of l.items) {
    const def = gearItem(it.id);
    if (def === undefined || !present.has(it.id)) continue;
    for (const req of def.requires) {
      if (!present.has(req)) errors.push(issue('requiresItem', it.id, `${def.label} needs ${gearItem(req)?.label ?? req}`));
    }
  }

  if (TASER_EXPECTED.has(policy.id) && !present.has('taser')) warnings.push(issue('missingRequired', 'taser', `${policy.label} normally carries a CED`));
  return { ok: errors.length === 0, errors, warnings, weightKg, capacityKg: policy.maxKg, slots };
}

/**
 * Checks a vehicle loadout against the vehicle's cargo. `fleetClass` selects the trunk items the class must carry
 * (`vehicleRequired`); null skips that check. Weight and slots use the police item `weightKg` and `size` per count.
 */
export function validateVehicleLoadout(l: VehicleLoadout, cap: VehicleCapacity, fleetClass: string | null): LoadoutValidation {
  const errors: GearIssue[] = [];
  const warnings: GearIssue[] = [];
  const slots = emptySlots();
  let kg = 0;
  let size = 0;
  for (const [id, count] of Object.entries(l.trunk)) {
    const def = ITEMS_DATA.find((t) => t.id === id);
    if (def === undefined) {
      errors.push(issue('unknownTrunkItem', id, `Unknown trunk item "${id}"`));
      continue;
    }
    if (!Number.isInteger(count) || count < 0 || count > MAX_TRUNK_COUNT) {
      errors.push(issue('countRange', id, `${def.label}: count must be 0 to ${String(MAX_TRUNK_COUNT)}, got ${String(count)}`));
      continue;
    }
    kg += def.weightKg * count;
    size += def.size * count;
  }
  const weightKg = round6(kg);
  if (weightKg > cap.kg) errors.push(issue('cargoWeight', null, `${String(weightKg)} kg is over the ${String(cap.kg)} kg cargo limit`));
  if (size > cap.slots) errors.push(issue('cargoSlots', null, `${String(size)} slots used of ${String(cap.slots)}`));
  for (const id of l.rack) {
    if (!RACK_ITEMS.some((r) => r.id === id)) errors.push(issue('notRackItem', id, `"${id}" does not fit the long-gun rack`));
  }
  if (l.rack.length > cap.rackSlots) errors.push(issue('rackFull', null, `${String(l.rack.length)} long guns in a ${String(cap.rackSlots)}-slot rack`));
  const required = fleetClass === null ? undefined : GEAR_POLICY.vehicleRequired[fleetClass];
  for (const id of required ?? []) {
    if ((l.trunk[id] ?? 0) < 1) errors.push(issue('missingVehicleItem', id, `${ITEMS_DATA.find((t) => t.id === id)?.label ?? id} is required for this vehicle`));
  }
  slots.carry = { used: size, cap: cap.slots };
  slots.longGun = { used: l.rack.length, cap: cap.rackSlots };
  return { ok: errors.length === 0, errors, warnings, weightKg, capacityKg: cap.kg, slots };
}

/**
 * The shipped vehicle loadout: a copy of `trunkLoadouts[trunkLoadoutId]` (empty for null; throws on an unknown id) and,
 * with a rack, every rack item except `lessLethal`.
 */
export function defaultVehicleLoadout(trunkLoadoutId: string | null, rack: boolean): VehicleLoadout {
  let trunk: Record<string, number> = {};
  if (trunkLoadoutId !== null) {
    const lo = EQUIPMENT_DATA.trunkLoadouts[trunkLoadoutId];
    if (lo === undefined) throw new Error(`Unknown trunk loadout "${trunkLoadoutId}"`);
    trunk = { ...lo };
  }
  return { trunk, rack: rack ? RACK_ITEMS.filter((r) => r.id !== 'lessLethal').map((r) => r.id) : [] };
}

/** A deep copy of the officer preset `id` (`loadouts.json`); throws on an unknown id. */
export function officerPreset(id: string): OfficerLoadout {
  const p = OFFICER_PRESETS[id];
  if (p === undefined) throw new Error(`Unknown officer preset "${id}"`);
  return { assignment: p.assignment, items: p.items.map((it) => ({ ...it })) };
}

/** Item ids the catalog defines (convenience for editors). */
export const GEAR_ITEM_IDS: readonly string[] = GEAR_ITEMS.map((it) => it.id);
