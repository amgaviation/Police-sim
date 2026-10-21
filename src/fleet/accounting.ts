import type { VehicleCondition } from '../vehicles/drivableVehicle';
import { MAINTENANCE } from './data';
import type { FleetClass, FleetService, LedgerEntry, MaintenanceConfig, Quote, QuoteLine } from './types';
import { LEDGER_KINDS } from './types';

/** Fleet money and career points (Phase 7 design §9.2). Pure. */

const WHEELS = 4;

function multiplier(fleetClass: string, cfg: MaintenanceConfig): number {
  return cfg.classMultiplier[fleetClass as FleetClass] ?? 1;
}

/** Sum of the 0..1 zone values. */
function sum(values: readonly number[]): number {
  let s = 0;
  for (const v of values) s += v;
  return s;
}

/**
 * Cost of `service` for a vehicle in `cond` of `fleetClass` (integers, `Math.round` per line, zero lines omitted).
 * Refuel is never multiplied; oil, tyre, body and engine lines are multiplied by the class.
 */
export function serviceQuote(
  service: FleetService,
  cond: VehicleCondition,
  capacityL: number,
  fleetClass: string,
  cfg: MaintenanceConfig = MAINTENANCE,
): Quote {
  const lines: QuoteLine[] = [];
  const mult = multiplier(fleetClass, cfg);
  const all = service === 'all';
  const push = (kind: QuoteLine['kind'], label: string, cost: number): void => {
    if (cost > 0) lines.push({ kind, label, cost });
  };
  if (all || service === 'refuel') {
    const liters = Math.max(0, 1 - cond.fuelFraction) * capacityL;
    push('fuel', `Fuel ${liters.toFixed(1)} L`, Math.round(liters * cfg.prices.fuelPerL));
  }
  if (all || service === 'oil') {
    if (cond.oilFraction < 1) push('oil', 'Oil change', Math.round(cfg.prices.oilChange * mult));
  }
  if (all || service === 'tires') {
    // A wheel is replaced once, whether it is flat, worn or both.
    let wheels = 0;
    for (let i = 0; i < WHEELS; i++) if (cond.flats[i] === true || (cond.tread[i] ?? 1) < 1) wheels++;
    push('tire', `Tyres x${wheels}`, Math.round(wheels * cfg.prices.tire * mult));
  }
  if (all || service === 'repair') {
    push('body', 'Body repair', Math.round(sum(cond.zones) * cfg.prices.bodyPerZone * mult));
    if (cond.engineFailed) push('engine', 'Engine replacement', Math.round(cfg.prices.engineReplace * mult));
    else push('engine', 'Engine repair', Math.round(Math.max(0, 1 - cond.engineHealth) * cfg.prices.enginePerHealth * mult));
  }
  let total = 0;
  for (const l of lines) total += l.cost;
  return { lines, total };
}

/**
 * Cost of an incident's damage: zone deltas x `bodyPerZone` + engine delta x `enginePerHealth` (`engineReplace` when it
 * failed in the incident) + `tire` per new flat, each line multiplied by the class and rounded.
 */
export function damageCost(
  zoneDelta: readonly number[],
  engineDelta: number,
  newFlats: number,
  engineFailed: boolean,
  fleetClass: string,
  cfg: MaintenanceConfig = MAINTENANCE,
): number {
  const mult = multiplier(fleetClass, cfg);
  const body = Math.round(sum(zoneDelta) * cfg.prices.bodyPerZone * mult);
  const engine = Math.round((engineFailed ? cfg.prices.engineReplace : Math.max(0, engineDelta) * cfg.prices.enginePerHealth) * mult);
  const tires = Math.round(Math.max(0, newFlats) * cfg.prices.tire * mult);
  return body + engine + tires;
}

/** A wreck: the body zones sum to `wreck.zoneSum` or more, or the engine failed. */
export function isWreck(zonesAfter: readonly number[], engineFailed: boolean, cfg: MaintenanceConfig = MAINTENANCE): boolean {
  return sum(zonesAfter) >= cfg.wreck.zoneSum || (cfg.wreck.engineFailed && engineFailed);
}

/** Career points (<= 0, never -0) charged for one incident. */
export function chargePoints(
  cost: number,
  ctx: { pursuit: boolean; emergency: boolean; reported: boolean; wreck: boolean },
  cfg: MaintenanceConfig = MAINTENANCE,
): number {
  const c = cfg.charges;
  const base = (Math.max(0, cost) / 1000) * c.pointsPer1000;
  const factor = ctx.pursuit ? c.pursuitFactor : ctx.emergency ? c.emergencyFactor : 1;
  let p = base * factor + (ctx.wreck ? c.wreckPoints : 0);
  if (!ctx.reported) p *= c.unreportedFactor;
  p = Math.min(Math.round(p), c.maxPointsPerIncident);
  return p === 0 ? 0 : -p;
}

// --- Ledger ---------------------------------------------------------------------------------

export interface LedgerSave {
  entries: LedgerEntry[];
  nextSeq: number;
  /** Totals include evicted entries. */
  departmentCost: number;
  officerPoints: number;
}

/**
 * Department cost ledger. Totals survive eviction of the oldest entries beyond `limit`. `departmentCost` counts what the
 * department paid (fuel, oil, tyre and repair lines); a `charge` entry records the damage cost and the officer's
 * career points but adds no department cost (the repair is paid when the unit is serviced).
 */
export class FleetLedger {
  private list: LedgerEntry[] = [];
  private seq = 1;
  private cost = 0;
  private points = 0;
  private readonly limit: number;

  constructor(limit: number = MAINTENANCE.limits.ledger) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  add(e: Omit<LedgerEntry, 'seq'>): LedgerEntry {
    const entry: LedgerEntry = { seq: this.seq++, ...e };
    this.list.push(entry);
    if (entry.kind !== 'charge') this.cost += entry.cost;
    this.points += entry.points;
    if (this.list.length > this.limit) this.list.splice(0, this.list.length - this.limit);
    return entry;
  }

  entries(): readonly LedgerEntry[] {
    return this.list;
  }

  /** Running total of the service lines, kept when old entries are evicted. */
  get departmentCost(): number {
    return this.cost;
  }

  /** Running total of the career points charged (<= 0), kept when old entries are evicted. */
  get officerPoints(): number {
    return this.points;
  }

  serialize(): LedgerSave {
    return { entries: this.list.map((e) => ({ ...e })), nextSeq: this.seq, departmentCost: this.cost, officerPoints: this.points };
  }

  static restore(s: LedgerSave, limit: number = MAINTENANCE.limits.ledger): FleetLedger {
    const l = new FleetLedger(limit);
    l.list = s.entries.map((e) => ({ ...e }));
    if (l.list.length > l.limit) l.list.splice(0, l.list.length - l.limit);
    l.seq = s.nextSeq;
    l.cost = s.departmentCost;
    l.points = s.officerPoints;
    return l;
  }
}

/** Is `x` shaped like a `LedgerSave`? */
export function isLedgerSave(x: unknown): x is LedgerSave {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  return (
    Array.isArray(o.entries) && o.entries.every(isLedgerEntry) && num(o.nextSeq) && Number.isInteger(o.nextSeq) &&
    num(o.departmentCost) && num(o.officerPoints)
  );
}

function isLedgerEntry(x: unknown): boolean {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  const num = (v: unknown): boolean => typeof v === 'number' && Number.isFinite(v);
  return (
    num(o.seq) && num(o.game) && typeof o.unitId === 'string' && typeof o.kind === 'string' &&
    (LEDGER_KINDS as readonly string[]).includes(o.kind) && num(o.cost) && num(o.points) && typeof o.note === 'string'
  );
}
