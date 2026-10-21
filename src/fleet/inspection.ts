import type { VehicleCondition } from '../vehicles/drivableVehicle';
import { INSPECTION_ITEMS } from './data';
import type { InspectionItem } from './types';

/** Shift-end inspection checklist (Phase 7 design §9.3). Pure. */

export interface InspectionInput {
  condition: VehicleCondition;
  /** Lamp / equipment faults reported by the vehicle (0 = none). */
  faults: number;
  /** Damage incidents of the unit without a damage report. */
  unreportedIncidents: number;
  /** Readable names of the missing loadout items ("flares x2", "aed"). */
  loadoutMissing: readonly string[];
  hasRack: boolean;
  rackSecured: boolean;
  hasCage: boolean;
  cageEmpty: boolean;
}

export interface InspectionRow {
  id: string;
  label: string;
  pass: boolean;
  /** False for checks that do not apply to the vehicle (no rack, no cage); they pass with detail "n/a". */
  applicable: boolean;
  detail: string;
  /** Fleet service that fixes the row, if any. */
  fix: string | null;
}

export interface InspectionResult {
  rows: InspectionRow[];
  passed: number;
  /** Ids of the failed items. */
  failed: string[];
}

const WHEEL_NAMES = ['FL', 'FR', 'RL', 'RR'] as const;

function pct(fraction: number): number {
  return Math.round(fraction * 100);
}

/** Index of the lowest tread. */
function worstWheel(tread: readonly number[]): number {
  let worst = 0;
  for (let i = 1; i < tread.length; i++) if ((tread[i] ?? 1) < (tread[worst] ?? 1)) worst = i;
  return worst;
}

function evaluate(item: InspectionItem, input: InspectionInput): { pass: boolean; applicable: boolean; detail: string } {
  const c = input.condition;
  const min = item.value ?? 0;
  switch (item.check) {
    case 'fuelMin':
      return { pass: c.fuelFraction >= min, applicable: true, detail: `Fuel ${pct(c.fuelFraction)} %` };
    case 'oilMin':
      return { pass: c.oilFraction >= min, applicable: true, detail: `Oil ${pct(c.oilFraction)} %` };
    case 'treadMin': {
      const w = worstWheel(c.tread);
      const t = c.tread[w] ?? 1;
      return { pass: t >= min, applicable: true, detail: `Tread ${pct(t)} % (${WHEEL_NAMES[w] ?? 'FL'})` };
    }
    case 'noFlats': {
      const flat = WHEEL_NAMES.filter((_, i) => c.flats[i] === true);
      return { pass: flat.length === 0, applicable: true, detail: flat.length === 0 ? 'OK' : `Flat: ${flat.join(', ')}` };
    }
    case 'engineMin':
      if (c.engineFailed) return { pass: false, applicable: true, detail: 'Engine failed' };
      return { pass: c.engineHealth >= min, applicable: true, detail: `Engine ${pct(c.engineHealth)} %` };
    case 'damageReported':
      return {
        pass: input.unreportedIncidents === 0,
        applicable: true,
        detail: input.unreportedIncidents === 0 ? 'OK' : `${input.unreportedIncidents} unreported`,
      };
    case 'noFaults':
      return {
        pass: input.faults === 0,
        applicable: true,
        detail: input.faults === 0 ? 'OK' : `${input.faults} fault${input.faults === 1 ? '' : 's'}`,
      };
    case 'loadoutComplete':
      return {
        pass: input.loadoutMissing.length === 0,
        applicable: true,
        detail: input.loadoutMissing.length === 0 ? 'OK' : `Missing: ${input.loadoutMissing.join(', ')}`,
      };
    case 'rackSecured':
      if (!input.hasRack) return { pass: true, applicable: false, detail: 'n/a' };
      return { pass: input.rackSecured, applicable: true, detail: input.rackSecured ? 'OK' : 'Rack unlocked' };
    case 'cageEmpty':
      if (!input.hasCage) return { pass: true, applicable: false, detail: 'n/a' };
      return { pass: input.cageEmpty, applicable: true, detail: input.cageEmpty ? 'OK' : 'Prisoner aboard' };
  }
}

/** Runs the checklist. Rows that do not apply pass with detail "n/a"; `passed` counts every passing row. */
export function runInspection(input: InspectionInput, items: readonly InspectionItem[] = INSPECTION_ITEMS): InspectionResult {
  const rows: InspectionRow[] = [];
  const failed: string[] = [];
  let passed = 0;
  for (const item of items) {
    const r = evaluate(item, input);
    rows.push({ id: item.id, label: item.label, pass: r.pass, applicable: r.applicable, detail: r.detail, fix: item.fix ?? null });
    if (r.pass) passed++;
    else failed.push(item.id);
  }
  return { rows, passed, failed };
}
