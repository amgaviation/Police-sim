/**
 * Fleet panels (Phase 7 §12.3): pure models over `ActionPanel` for the garage, the service counter, the shift-end
 * inspection and the shift summary, and the intents their rows pick. No DOM: the presenter opens an `ActionPanel`
 * with a model, calls the matching `...Pick` with the chosen index and acts on the intent (the fleet is only ever
 * changed through `FleetSystem.request`).
 */
import type { FleetShiftEndEvent } from '../../fleet/events';
import type { InspectionResult } from '../../fleet/inspection';
import { FLEET_SERVICES, type DamageIncident, type FleetRequest, type FleetService, type FleetUnitView, type LedgerEntry, type Quote } from '../../fleet/types';
import type { ActionPanelModel, PanelOption } from '../panels/actionPanel';
import { formatMoney, formatPercent, formatPoints } from './format';

export type FleetIntent =
  | { kind: 'checkout'; unitId: string }
  | { kind: 'checkin'; unitId: string }
  | { kind: 'customize'; unitId: string }
  | { kind: 'service'; unitId: string }
  | { kind: 'inspect'; unitId: string }
  | { kind: 'report'; incidentId: number }
  | { kind: 'request'; request: FleetRequest }
  /** A unit row was picked: the presenter opens (or closes) its action rows (`GarageContext.expanded`). */
  | { kind: 'select'; unitId: string }
  | { kind: 'endShift' }
  /** The garage's "End shift" row: inspect the unit the officer drives or stands next to, else end the shift directly. */
  | { kind: 'finish' }
  | { kind: 'back' };

export interface GarageContext {
  /** The officer is at the station: units can be checked out / in, customised and serviced. */
  atStation: boolean;
  /** Unit id of the vehicle the officer is driving, null on foot. */
  driving: string | null;
  /** Unit id of the spawned vehicle within the officer's reach, null when none. */
  nearUnit: string | null;
  /** The unit whose action rows are shown (null / absent: none). */
  expanded?: string | null;
  /** Is the spawned unit parked in its yard (service happens only there)? Absent: yes. */
  inYard?: (unitId: string) => boolean;
  /** Damage incidents (any unit): unreported ones get a "File damage report" row. */
  incidents?: readonly DamageIncident[];
}

interface Row {
  readonly option: PanelOption;
  readonly intent: FleetIntent | null;
}

/** The unit to expand after a `select` pick: the same unit again closes its rows. */
export function toggleExpanded(current: string | null | undefined, unitId: string): string | null {
  return current === unitId ? null : unitId;
}

const ZONES = ['front', 'rear', 'left', 'right'] as const;

/** The zone with the most damage in an incident ('front' when nothing was recorded, e.g. a burst tyre). */
export function incidentZone(i: Pick<DamageIncident, 'zoneDelta'>): (typeof ZONES)[number] {
  let best = 0;
  for (let k = 1; k < 4; k++) if ((i.zoneDelta[k] ?? 0) > (i.zoneDelta[best] ?? 0)) best = k;
  return ZONES[best] ?? 'front';
}

/** 'File damage report: P-101 front, 34 km/h'. */
export function reportRowLabel(i: Pick<DamageIncident, 'unitId' | 'zoneDelta' | 'maxImpact'>): string {
  return `File damage report: ${i.unitId} ${incidentZone(i)}, ${String(Math.round(i.maxImpact * 3.6))} km/h`;
}

function reportRows(incidents: readonly DamageIncident[], unitId: string | null): Row[] {
  return incidents
    .filter((i) => !i.reported && (unitId === null || i.unitId === unitId))
    .map((i) => ({
      option: { label: reportRowLabel(i), detail: i.closed ? formatMoney(i.cost) : 'in progress' },
      intent: { kind: 'report', incidentId: i.id } as const,
    }));
}

/** 'READY · fuel 80 % · in yard' / 'OUT (you)' / 'DAMAGED · fuel 40 % · in yard'. */
export function unitDetail(u: FleetUnitView, driving: string | null): string {
  if (u.id === driving) return 'OUT (you)';
  const fuel = `fuel ${formatPercent(u.fuel)}`;
  if (u.spawned) return u.status === 'damaged' ? `OUT · DAMAGED · ${fuel}` : `OUT · ${fuel}`;
  const word = u.status === 'damaged' ? 'DAMAGED' : u.status === 'service' ? 'SERVICE DUE' : 'READY';
  return `${word} · ${fuel} · in yard`;
}

function garageRows(units: readonly FleetUnitView[], ctx: GarageContext): Row[] {
  const rows: Row[] = [];
  const incidents = ctx.incidents ?? [];
  for (const u of units) {
    rows.push({
      option: { label: `${u.id} ${u.label}`, detail: unitDetail(u, ctx.driving), enabled: ctx.atStation },
      intent: { kind: 'select', unitId: u.id },
    });
    if (!ctx.atStation || ctx.expanded !== u.id) continue;
    const here = ctx.driving === u.id || ctx.nearUnit === u.id;
    const yard = u.spawned && (ctx.inYard === undefined || ctx.inYard(u.id));
    rows.push(
      {
        option: { label: '› Check out', detail: u.spawned ? 'Already out' : '', enabled: !u.spawned },
        intent: { kind: 'checkout', unitId: u.id },
      },
      {
        option: { label: '› Return', detail: !u.spawned ? 'In the yard' : here ? '' : 'Bring it to the yard', enabled: u.spawned && here },
        intent: { kind: 'checkin', unitId: u.id },
      },
      {
        option: { label: '› Customize…', detail: !u.spawned ? 'Check it out first' : here ? '' : 'Bring it to the yard', enabled: u.spawned && here },
        intent: { kind: 'customize', unitId: u.id },
      },
      {
        option: { label: '› Service…', detail: !u.spawned ? 'Check it out first' : yard ? '' : 'Bring it to the yard', enabled: yard },
        intent: { kind: 'service', unitId: u.id },
      },
      {
        option: { label: '› Inspect', detail: !u.spawned ? 'Check it out first' : here ? '' : 'Stand next to it', enabled: u.spawned && here },
        intent: { kind: 'inspect', unitId: u.id },
      },
    );
  }
  rows.push(...reportRows(incidents, null));
  if (ctx.atStation) rows.push({ option: { label: 'End shift', detail: 'Inspect, then close the shift' }, intent: { kind: 'finish' } });
  return rows;
}

/**
 * The garage ("Fleet", "City Police · yard"): one row per unit; at the station a unit row opens its actions (Check out,
 * Return, Customize, Service, Inspect), then the "End shift" row. Away from the station the units are listed
 * read-only, followed by a "File damage report" row per unreported incident.
 */
export function garagePanelModel(units: readonly FleetUnitView[], ctx: GarageContext): ActionPanelModel {
  return {
    title: 'Fleet',
    subtitle: ctx.atStation ? 'City Police · yard' : 'City Police · away from the yard',
    options: garageRows(units, ctx).map((r) => r.option),
  };
}

/** The intent of option `index` of the garage model for the same arguments; null for an unknown index. */
export function garagePanelPick(index: number, units: readonly FleetUnitView[], ctx: GarageContext): FleetIntent | null {
  return garageRows(units, ctx)[index]?.intent ?? null;
}

// --- Service ---------------------------------------------------------------------------------

const SERVICE_NAMES: Readonly<Record<FleetService, string>> = {
  refuel: 'Refuel',
  oil: 'Oil change',
  tires: 'Replace tyres',
  repair: 'Repair',
  all: 'Everything',
};

/** Quote lookup of the service panel: a quote per service, null when the unit cannot be quoted. */
export type ServiceQuotes = Readonly<Record<FleetService, Quote | null>>;

/** "Refuel ($ 46)", "Oil change ($ 80)", "Replace tyres ($ 360)", "Repair ($ 2 640)", "Everything ($ 3 126)" and Back; a service that costs nothing is disabled. */
export function servicePanelModel(unit: FleetUnitView, quotes: ServiceQuotes): ActionPanelModel {
  const options: PanelOption[] = FLEET_SERVICES.map((service) => {
    const q = quotes[service];
    const total = q?.total ?? 0;
    return {
      label: `${SERVICE_NAMES[service]} (${formatMoney(total)})`,
      detail: q === null ? 'No quote' : total > 0 ? q.lines.map((l) => l.label).join(', ') : 'Nothing to do',
      enabled: total > 0,
    };
  });
  options.push({ label: 'Back' });
  return {
    title: `Service ${unit.id}`,
    subtitle: `${unit.label} · fuel ${formatPercent(unit.fuel)} · oil ${formatPercent(unit.oil)} · tread ${formatPercent(unit.tread)} · damage ${formatPercent(unit.damage)}`,
    options,
  };
}

/** Rows 0..4 request that service for the unit, row 5 goes back. */
export function servicePanelPick(index: number, unit: FleetUnitView): FleetIntent | null {
  const service = FLEET_SERVICES[index];
  if (service !== undefined) return { kind: 'request', request: { kind: 'service', unitId: unit.id, service } };
  return index === FLEET_SERVICES.length ? { kind: 'back' } : null;
}

// --- Inspection ------------------------------------------------------------------------------

function inspectionRows(result: InspectionResult | null, incidents: readonly DamageIncident[], unitId: string, atStation: boolean): Row[] {
  const rows: Row[] = [];
  if (result === null) {
    rows.push({ option: { label: 'No inspection yet', detail: 'Run one below', enabled: false }, intent: null });
  } else {
    for (const r of result.rows) {
      const fix = !r.pass && r.fix !== null && (FLEET_SERVICES as readonly string[]).includes(r.fix) ? (r.fix as FleetService) : null;
      rows.push({
        option: {
          label: `${r.pass ? '✓' : '✗'} ${r.label}`,
          detail: `${r.detail}${fix !== null ? ` · fix: ${fix}` : ''}`,
          enabled: fix !== null,
        },
        intent: fix !== null ? { kind: 'request', request: { kind: 'service', unitId, service: fix } } : null,
      });
    }
  }
  rows.push(...reportRows(incidents, unitId));
  rows.push({ option: { label: result === null ? 'Run inspection' : 'Re-inspect' }, intent: { kind: 'inspect', unitId } });
  rows.push({
    option: { label: 'End shift', detail: atStation ? '' : 'Only at the station', enabled: atStation },
    intent: { kind: 'endShift' },
  });
  rows.push({ option: { label: 'Back' }, intent: { kind: 'back' } });
  return rows;
}

/**
 * The shift-end inspection of `unitId`: one row per check ("✓ Fuel at least a quarter tank", "✗ Tyre tread" with its
 * detail and fix; a failed row with a fix runs that service), a "File damage report" row per unreported incident of the
 * unit, "Re-inspect", "End shift" (only at the station) and Back.
 */
export function inspectionPanelModel(result: InspectionResult | null, incidents: readonly DamageIncident[], unitId: string, atStation = true): ActionPanelModel {
  return {
    title: `Inspection ${unitId}`,
    subtitle: result === null ? 'Not inspected yet' : `${String(result.passed)}/${String(result.rows.length)} checks passed`,
    options: inspectionRows(result, incidents, unitId, atStation).map((r) => r.option),
  };
}

/** The intent of option `index` of the inspection model for the same arguments. */
export function inspectionPanelPick(index: number, result: InspectionResult | null, incidents: readonly DamageIncident[], unitId: string, atStation = true): FleetIntent | null {
  return inspectionRows(result, incidents, unitId, atStation)[index]?.intent ?? null;
}

// --- Shift summary ---------------------------------------------------------------------------

/** Most charge rows the shift summary lists. */
export const SUMMARY_CHARGES = 5;

function newestCharges(charges: readonly LedgerEntry[]): LedgerEntry[] {
  return charges
    .filter((c) => c.kind === 'charge')
    .sort((a, b) => b.game - a.game || b.seq - a.seq)
    .slice(0, SUMMARY_CHARGES);
}

/**
 * The shift summary opened by `fleet:shiftEnd`: career points, department cost, incidents and unreported damage, the
 * newest charges and a Close row (the only selectable one).
 */
export function shiftSummaryModel(e: FleetShiftEndEvent, charges: readonly LedgerEntry[]): ActionPanelModel {
  const options: PanelOption[] = [
    { label: 'Career points', detail: formatPoints(e.points), enabled: false },
    { label: 'Department cost', detail: formatMoney(e.departmentCost), enabled: false },
    { label: 'Damage incidents', detail: String(e.incidents), enabled: false },
    { label: 'Unreported damage', detail: e.unreported > 0 ? `${String(e.unreported)} · file a report` : '0', enabled: false },
  ];
  for (const c of newestCharges(charges)) {
    options.push({ label: `${c.unitId} ${c.note}`, detail: `${formatMoney(c.cost)} · ${formatPoints(c.points)} pts`, enabled: false });
  }
  options.push({ label: 'Close' });
  return { title: 'Shift summary', subtitle: 'Fleet · City Police', options };
}

/** The Close row returns to the game; the other rows are informational. */
export function shiftSummaryPick(index: number, charges: readonly LedgerEntry[]): FleetIntent | null {
  return index === 4 + newestCharges(charges).length ? { kind: 'back' } : null;
}
