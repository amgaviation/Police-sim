/**
 * Pure view model of the editor's Loadout tab (Phase 7 §12.1): the trunk rows with their counts, the rack boxes, the
 * weight and slot bars and the validation messages the host's `validateLoadout` produced.
 */
import { defaultVehicleLoadout } from '../../gear';
import type { LoadoutValidation, VehicleCapacity, VehicleLoadout } from '../../gear';
import type { LiveryDoc } from '../../livery';
import { RACK_ITEMS } from '../../police/equipment';
import { TRUNK_ITEMS } from '../../police/inventory';
import type { VehicleModel } from '../../vehicles/model';

/** Most of one trunk item (the livery schema limit). */
export const MAX_TRUNK_COUNT = 99;

export interface LoadoutRow {
  id: string;
  label: string;
  count: number;
  weightKg: number;
  /** Cargo slots one takes. */
  size: number;
}

export interface LoadoutRackBox {
  id: string;
  label: string;
  checked: boolean;
  /** False when unchecked and the rack is full. */
  enabled: boolean;
}

export interface LoadoutBar {
  used: number;
  cap: number;
  /** 0..1 (1 when over). */
  fraction: number;
  over: boolean;
}

export interface LoadoutView {
  loadout: VehicleLoadout;
  /** The document has no loadout of its own: the unit's preset applies. */
  isDefault: boolean;
  rows: LoadoutRow[];
  rack: LoadoutRackBox[];
  weight: LoadoutBar;
  slots: LoadoutBar;
  rackSlots: LoadoutBar;
  errors: string[];
  warnings: string[];
  ok: boolean;
}

/** The unit's preset for `model`: its trunk loadout and (with a rack) every long gun that fits the rack. */
export function defaultLoadoutFor(model: VehicleModel): VehicleLoadout {
  let l: VehicleLoadout;
  try {
    l = defaultVehicleLoadout(model.equipment?.trunk ?? null, model.cargo.rackSlots > 0);
  } catch {
    l = { trunk: {}, rack: [] };
  }
  l.rack = l.rack.slice(0, model.cargo.rackSlots);
  return l;
}

/** The loadout the editor shows and edits: the document's own, else the unit's preset. */
export function effectiveLoadout(doc: LiveryDoc, model: VehicleModel): VehicleLoadout {
  if (doc.loadout === null) return defaultLoadoutFor(model);
  return { trunk: { ...doc.loadout.trunk }, rack: [...doc.loadout.rack] };
}

function bar(used: number, cap: number): LoadoutBar {
  const over = used > cap;
  return { used, cap, fraction: over ? 1 : cap > 0 ? used / cap : 0, over };
}

/** Rows, boxes, bars and messages of `loadout` given the host's validation of it. */
export function loadoutView(loadout: VehicleLoadout, validation: LoadoutValidation, capacity: VehicleCapacity, isDefault: boolean): LoadoutView {
  const rows: LoadoutRow[] = TRUNK_ITEMS.map((it) => ({
    id: it.id,
    label: it.label,
    count: loadout.trunk[it.id] ?? 0,
    weightKg: it.weightKg,
    size: it.size,
  }));
  const rackFull = loadout.rack.length >= capacity.rackSlots;
  const rack: LoadoutRackBox[] = RACK_ITEMS.map((it) => {
    const checked = loadout.rack.includes(it.id);
    return { id: it.id, label: it.label, checked, enabled: checked || !rackFull };
  });
  return {
    loadout,
    isDefault,
    rows,
    rack,
    weight: bar(validation.weightKg, validation.capacityKg),
    slots: bar(validation.slots.carry.used, validation.slots.carry.cap),
    rackSlots: bar(validation.slots.longGun.used, validation.slots.longGun.cap),
    errors: validation.errors.map((e) => e.message),
    warnings: validation.warnings.map((w) => w.message),
    ok: validation.ok,
  };
}

/** A copy with the trunk count of `id` set (clamped to 0..99; 0 removes the entry). */
export function withTrunkCount(loadout: VehicleLoadout, id: string, count: number): VehicleLoadout {
  const trunk = { ...loadout.trunk };
  const n = Math.min(MAX_TRUNK_COUNT, Math.max(0, Math.trunc(Number.isFinite(count) ? count : 0)));
  if (n === 0) delete trunk[id];
  else trunk[id] = n;
  return { trunk, rack: [...loadout.rack] };
}

/** A copy with `id` racked or not (a full rack refuses another gun). */
export function withRacked(loadout: VehicleLoadout, id: string, racked: boolean, rackSlots: number): VehicleLoadout {
  const has = loadout.rack.includes(id);
  let rack = [...loadout.rack];
  if (racked && !has && rack.length < rackSlots) rack.push(id);
  else if (!racked && has) rack = rack.filter((r) => r !== id);
  return { trunk: { ...loadout.trunk }, rack };
}
