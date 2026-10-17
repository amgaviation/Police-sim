/**
 * Pure view models of the MDT (design §13.2): every string the overlay shows is built here, so the
 * DOM layer only copies text into reused elements and the logic is tested headless.
 */
import type { CadState } from '../../cad/cadState';
import { statusLabel } from '../../cad/codes';
import { dispositionLabel, findStatute, statuteForPlateIssue, statuteForViolation, type PlateIssue, type Statute } from '../../cad/data';
import { type CadDocument, type CitationViolation, type DocKind, type DocumentStore, citationTotal } from '../../cad/documents';
import { addressAt } from '../../cad/address';
import type { CadCall, Priority, TrafficStopInfo, UnitStatus } from '../../cad/types';
import { ageOn, formatClockTime, formatDate, formatStamp } from '../../records/calendar';
import type { PlateQueryResult, RecordsDb, VinQueryResult } from '../../records/db';
import type { RecordHit } from '../../records/hits';
import { displayName, type PersonRecord } from '../../records/person';
import { colorName, modelName, mountedPlate, observedVehicle, PLATE_FLAG, vehicleDescription, type RegistrationRecord } from '../../records/vehicle';
import { REGISTRY_POPULATION } from '../../traffic/registry';
import type { RoadGraph } from '../../world/roadGraph';
import { MDT_TABS, type MdtTab } from './types';

// --- Shared shapes ----------------------------------------------------------------------------

export type LineSeverity = 'none' | 'info' | 'caution' | 'alert';

/** One labelled line of a read-only pane; `personId`/`docId` make it a link. */
export interface MdtLine {
  readonly label: string;
  readonly text: string;
  readonly severity: LineSeverity;
  readonly personId?: number;
  readonly docId?: string;
}

export interface MdtSection {
  readonly id: string;
  readonly title: string;
  readonly lines: readonly MdtLine[];
}

function line(label: string, text: string, severity: LineSeverity = 'none'): MdtLine {
  return { label, text, severity };
}

const NONE_LINE: MdtLine = line('', 'NONE');

// --- Formatting -------------------------------------------------------------------------------

/** Elapsed seconds as "m:ss" (under an hour) or "h:mm:ss"; negative or non-finite -> "0:00". */
export function formatAge(seconds: number): string {
  const s = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** "1".."9" (also "Digit1", "Numpad1") -> the tab in tab-bar order; null for anything else. */
export function tabFromKey(key: string): MdtTab | null {
  const m = /^(?:Digit|Numpad)?([1-9])$/.exec(key);
  if (!m) return null;
  return MDT_TABS[Number(m[1]) - 1] ?? null;
}

function hitSeverity(h: RecordHit): LineSeverity {
  return h.severity;
}

function feetInches(cm: number): string {
  const inches = Math.round(cm / 2.54);
  return `${Math.floor(inches / 12)}'${inches % 12}"`;
}

// --- Queue ------------------------------------------------------------------------------------

export interface QueueRow {
  readonly callId: number;
  readonly number: string;
  readonly priority: Priority;
  readonly nature: string;
  readonly address: string;
  readonly caller: string;
  /** PENDING / OFFERED / DISPATCHED / ON SCENE. */
  readonly status: string;
  /** Assigned callsigns, primary first ("21,23" or "-"). */
  readonly units: string;
  /** Sim time since the call was created ("4:05"). */
  readonly age: string;
  /** Offered to the player and waiting for an answer. */
  readonly offered: boolean;
  /** The player's unit is assigned. */
  readonly mine: boolean;
}

export function callerText(call: CadCall): string {
  const c = call.caller;
  if (c.kind === 'anonymous') return 'ANONYMOUS';
  return c.name !== '' ? c.name : c.kind.toUpperCase();
}

function callStatusText(call: CadCall): string {
  if (call.status === 'closed') return 'CLOSED';
  if (call.status === 'pending') return call.offeredTo !== null ? 'OFFERED' : 'PENDING';
  return call.firstOnScene !== null ? 'ON SCENE' : 'DISPATCHED';
}

/** Open calls, P1 first then oldest (as `cad.openCalls()`); ages from `nowSim`. */
export function queueRows(cad: CadState, nowSim: number): QueueRow[] {
  const player = cad.playerUnit();
  const mine = player?.callsign ?? null;
  return cad.openCalls().map((c) => ({
    callId: c.id,
    number: c.number,
    priority: c.priority,
    nature: c.nature,
    address: c.location.text,
    caller: callerText(c),
    status: callStatusText(c),
    units: c.units.length > 0 ? c.units.join(',') : '-',
    age: formatAge(nowSim - c.created.sim),
    offered: c.offeredTo !== null && c.offeredTo === mine,
    mine: mine !== null && c.units.includes(mine) && c.status !== 'closed',
  }));
}

// --- Call detail ------------------------------------------------------------------------------

export interface CallDetailLine {
  readonly kind: 'title' | 'field' | 'narrative' | 'document';
  readonly label: string;
  readonly text: string;
}

/** Caller, location, units, times, then every narrative entry with its game clock and documents. */
export function callDetailLines(call: CadCall): CallDetailLine[] {
  const c = call.caller;
  const loc = call.location;
  const out: CallDetailLine[] = [
    { kind: 'title', label: call.number, text: `P${call.priority} ${call.nature}${call.selfInitiated ? ' (self-initiated)' : ''}` },
    { kind: 'field', label: 'Status', text: callStatusText(call) + (call.disposition !== null ? ` - ${dispositionLabel(call.disposition)}` : '') },
    { kind: 'field', label: 'Caller', text: `${callerText(call)} (${c.kind})${c.phone !== '' ? ` ${c.phone}` : ''}` },
    { kind: 'field', label: 'Address', text: loc.text },
    { kind: 'field', label: 'Cross street', text: loc.cross !== '' ? loc.cross : '-' },
    { kind: 'field', label: 'Near', text: loc.near },
    { kind: 'field', label: 'District', text: loc.district },
    {
      kind: 'field',
      label: 'Units',
      text: call.units.length > 0 ? call.units.map((u) => (u === call.primary ? `${u}*` : u)).join(', ') : 'NONE',
    },
    {
      kind: 'field',
      label: 'Times',
      text:
        `Created ${formatClockTime(call.created.game)}` +
        (call.dispatched ? `  Dispatched ${formatClockTime(call.dispatched.game)}` : '') +
        (call.firstOnScene ? `  On scene ${formatClockTime(call.firstOnScene.game)}` : '') +
        (call.closed ? `  Closed ${formatClockTime(call.closed.game)}` : ''),
    },
  ];
  for (const n of call.narrative) out.push({ kind: 'narrative', label: formatClockTime(n.game), text: `${n.source}: ${n.text}` });
  for (const id of call.documents) out.push({ kind: 'document', label: 'Document', text: id });
  return out;
}

// --- Units ------------------------------------------------------------------------------------

export interface UnitRow {
  readonly callsign: string;
  readonly officer: string;
  readonly player: boolean;
  readonly status: UnitStatus;
  /** "10-8 AVAILABLE". */
  readonly statusLabel: string;
  /** Call number or '-'. */
  readonly call: string;
  /** `near` text of the unit's AVL position. */
  readonly location: string;
  /** Time in status (sim) when `nowSim` is given, else the game clock it started. */
  readonly since: string;
  readonly emergency: boolean;
}

/** Search radius for a unit's AVL address. */
const UNIT_ADDRESS_RADIUS = 150;

/** The roster in CAD order with status labels and the `near` text of each AVL position. */
export function unitRows(cad: CadState, graph: RoadGraph, nowSim = Number.NaN): UnitRow[] {
  return cad.units().map((u) => {
    const call = u.callId !== null ? cad.call(u.callId) : null;
    const address = addressAt(graph, u.x, u.z, undefined, UNIT_ADDRESS_RADIUS);
    return {
      callsign: u.callsign,
      officer: u.officer,
      player: u.kind === 'player',
      status: u.status,
      statusLabel: statusLabel(u.status),
      call: call ? call.number : '-',
      location: address ? address.near : 'UNKNOWN',
      since: Number.isFinite(nowSim) ? formatAge(nowSim - u.statusSince.sim) : formatClockTime(u.statusSince.game),
      emergency: u.emergency,
    };
  });
}

// --- Person -----------------------------------------------------------------------------------

/** Record sections of a person (identity, hits, licence, warrants, ... priors); hits keep their severity. */
export function personSections(person: PersonRecord, hits: readonly RecordHit[], today: number): MdtSection[] {
  const p = person;
  const lic = p.license;
  const sup = p.supervision;
  const identity: MdtLine[] = [
    { ...line('Name', displayName(p)), personId: p.id },
    line('Sex', p.sex),
    line('DOB', `${formatDate(p.dob)} (age ${ageOn(p.dob, today)})`),
    line('Height/Weight', `${feetInches(p.heightCm)} / ${Math.round(p.weightKg * 2.20462)} lb`),
    line('Eyes/Hair', `${p.eyes} / ${p.hair}`),
    line('Address', p.address),
    line('Phone', p.phone),
  ];
  const hitLines = hits.length > 0 ? hits.map((h) => line('', h.text, hitSeverity(h))) : [line('', 'NO WANTS, WARRANTS OR FLAGS')];
  const license: MdtLine[] =
    lic.status === 'none'
      ? [line('Status', 'NO LICENSE ON FILE', 'caution')]
      : [
          line('Number', lic.number),
          line('Class', lic.cls),
          line('Status', lic.status.toUpperCase(), lic.status === 'valid' ? 'none' : 'caution'),
          line('Expires', formatDate(lic.expires), lic.status === 'expired' ? 'caution' : 'none'),
        ];
  const warrants = p.warrants.map((w) =>
    line(w.id, `${w.kind.toUpperCase()}: ${w.offense} - ${w.court} - bail $${w.bail} - issued ${formatDate(w.issued)}`, 'alert'),
  );
  const supervision =
    sup.kind === 'none'
      ? [NONE_LINE]
      : [
          line(sup.kind === 'parole' ? 'Parole' : 'Probation', `until ${formatDate(sup.until)} (${sup.agent})`, 'caution'),
          ...sup.conditions.map((c) => line('Condition', c, 'caution')),
        ];
  const gang = p.gang ? [line(p.gang.role === 'member' ? 'Member' : 'Associate', p.gang.name, 'caution')] : [NONE_LINE];
  const mental = p.mentalHealth !== null ? [line('', p.mentalHealth, 'caution')] : [NONE_LINE];
  const safety = p.officerSafety.map((n) => line('', n, 'alert'));
  const firearms = p.firearms.map((f) => line(f.type, `serial ${f.serial}, registered ${formatDate(f.registered)}`, 'info'));
  const orders = p.protectiveOrders.map((o) =>
    line('Restrained', `protects person #${o.protectedId}: ${o.conditions.join(', ')} (expires ${formatDate(o.expires)})`, 'caution'),
  );
  const priors = p.priors.map((c) => ({
    ...line(formatDate(c.day), `${c.kind.toUpperCase()}: ${c.summary}${c.location !== '' ? ` (${c.location})` : ''}`),
    ...(c.ref !== '' ? { docId: c.ref } : {}),
  }));
  const orNone = (lines: MdtLine[]): MdtLine[] => (lines.length > 0 ? lines : [NONE_LINE]);
  return [
    { id: 'identity', title: 'Identity', lines: identity },
    { id: 'hits', title: 'Hits', lines: hitLines },
    { id: 'license', title: 'Driver license', lines: license },
    { id: 'warrants', title: 'Warrants', lines: orNone(warrants) },
    { id: 'supervision', title: 'Supervision', lines: supervision },
    { id: 'gang', title: 'Gang', lines: gang },
    { id: 'mentalHealth', title: 'Mental health', lines: mental },
    { id: 'officerSafety', title: 'Officer safety', lines: orNone(safety) },
    { id: 'firearms', title: 'Firearms', lines: orNone(firearms) },
    { id: 'protectiveOrders', title: 'Protective orders', lines: orNone(orders) },
    { id: 'priors', title: 'Prior contacts', lines: orNone(priors) },
  ];
}

// --- Vehicle ----------------------------------------------------------------------------------

function isPlateResult(r: PlateQueryResult | VinQueryResult): r is PlateQueryResult {
  return 'plate' in r;
}

function registrationLines(reg: RegistrationRecord): MdtLine[] {
  return [
    line('Plate', reg.plate),
    line('VIN', reg.vin),
    line('Vehicle', vehicleDescription(reg)),
    line('Expires', `${formatDate(reg.expires)}${reg.expired ? ' (EXPIRED)' : ''}`, reg.expired ? 'caution' : 'none'),
    line('Insurance', reg.insured ? reg.insurer : 'NONE ON FILE', reg.insured ? 'none' : 'caution'),
    line('Status', reg.stolen ? 'STOLEN' : 'NOT REPORTED STOLEN', reg.stolen ? 'alert' : 'none'),
  ];
}

/** Sections of a plate or VIN query: query, registration, owner, observed car, hits (mismatch included). */
export function vehicleSections(result: PlateQueryResult | VinQueryResult): MdtSection[] {
  const plate = isPlateResult(result);
  const reg = result.registration;
  const query: MdtLine[] = [line(plate ? 'Plate' : 'VIN', plate ? result.plate : result.vin)];
  if (!result.found || !reg) {
    query.push(line('Result', 'NO RECORD', 'caution'));
    return [{ id: 'query', title: 'Query', lines: query }];
  }
  const hits = result.hits;
  query.push(line('Result', hits.length > 0 ? `${hits.length} HIT${hits.length === 1 ? '' : 'S'}` : 'CLEAR', worst(hits)));
  const sections: MdtSection[] = [
    { id: 'query', title: 'Query', lines: query },
    { id: 'registration', title: 'Registration', lines: registrationLines(reg) },
  ];
  if (plate && result.owner) {
    const o = result.owner;
    sections.push({
      id: 'owner',
      title: 'Registered owner',
      lines: [
        { ...line('Name', displayName(o)), personId: o.id },
        line('DOB', formatDate(o.dob)),
        line('DL', o.license.status === 'none' ? 'NONE' : `${o.license.number} (${o.license.status.toUpperCase()})`, o.license.status === 'valid' ? 'none' : 'caution'),
        line('Address', o.address),
      ],
    });
  } else {
    sections.push({ id: 'owner', title: 'Registered owner', lines: [{ ...line('Person', `#${reg.ownerId}`), personId: reg.ownerId }] });
  }
  if (plate && result.observed) {
    const obs = result.observed;
    const mismatch = hits.some((h) => h.kind === 'mismatch');
    sections.push({
      id: 'observed',
      title: 'Observed vehicle',
      lines: [line('Seen', `${colorName(obs.color)} ${modelName(obs.modelId)}`, mismatch ? 'alert' : 'none')],
    });
  }
  sections.push({ id: 'hits', title: 'Hits', lines: hits.length > 0 ? hits.map((h) => line('', h.text, hitSeverity(h))) : [line('', 'NO HITS')] });
  return sections;
}

function worst(hits: readonly RecordHit[]): LineSeverity {
  let s: LineSeverity = 'none';
  for (const h of hits) {
    if (h.severity === 'alert') return 'alert';
    if (h.severity === 'caution') s = 'caution';
  }
  return s;
}

// --- Citations --------------------------------------------------------------------------------

export interface CitationDraft {
  readonly callId: number | null;
  readonly personId: number;
  /** The driver was not identified (no licence requested): the registered owner is prefilled. */
  readonly idUnverified: boolean;
  readonly vehicleId: number;
  readonly plate: string;
  readonly location: string;
  readonly violations: CitationViolation[];
  readonly totalFine: number;
  readonly recordedSpeedMph: number | null;
  readonly limitMph: number | null;
  readonly notes: string;
}

/** What a plate run told the officer (a `PlateQueryResult` fits). */
export interface PlateRunInfo {
  readonly plate: string;
  readonly flags: number;
  readonly registration: RegistrationRecord | null;
}

function isRegistryId(id: number): boolean {
  return Number.isInteger(id) && id >= 0 && id < REGISTRY_POPULATION;
}

/** Registration the stop's mounted plate belongs to (no query log entry), null when unknown. */
function stopRegistration(stop: TrafficStopInfo, records: RecordsDb): RegistrationRecord | null {
  if (!isRegistryId(stop.vehicleId)) return null;
  const mp = mountedPlate(records.seed, stop.vehicleId);
  return records.registration(mp.plateVehicleId);
}

/** Plate issues the officer can cite after a run (VIN-confirmed for clones), in `PLATE_ISSUES` order. */
function plateIssues(stop: TrafficStopInfo, records: RecordsDb, run: PlateRunInfo | null): PlateIssue[] {
  let flags: number;
  let reg: RegistrationRecord | null;
  if (run && run.plate === stop.plate) {
    flags = run.flags;
    reg = run.registration;
  } else if (stop.plateRun) {
    reg = stopRegistration(stop, records);
    flags = 0;
    if (reg?.expired) flags |= PLATE_FLAG.expired;
    if (reg && (reg.stolen || reg.plateReportedStolen)) flags |= PLATE_FLAG.stolen;
    if (reg?.cloneAlert) flags |= PLATE_FLAG.cloned;
    if (reg && isRegistryId(stop.vehicleId)) {
      const seen = observedVehicle(records.seed, stop.vehicleId);
      if (seen.modelId !== reg.modelId || colorName(seen.color) !== reg.colorName) flags |= PLATE_FLAG.mismatched;
    }
  } else {
    return [];
  }
  // After a VIN check the car's own registration decides expiry and insurance; before it, a plate
  // that returns to another car (description mismatch) says nothing about this car's insurance.
  const own = stop.vinChecked && isRegistryId(stop.vehicleId) ? records.registration(stop.vehicleId) : null;
  const insReg = own ?? ((flags & PLATE_FLAG.mismatched) !== 0 ? null : reg);
  const out: PlateIssue[] = [];
  if (own ? own.expired : (flags & PLATE_FLAG.expired) !== 0) out.push('expired');
  if (insReg && !insReg.insured) out.push('uninsured');
  // A clone alert or a description mismatch is cited only once a VIN check showed another plate.
  if (flags & (PLATE_FLAG.cloned | PLATE_FLAG.mismatched) && stop.vinChecked && isRegistryId(stop.vehicleId)) {
    if (records.registration(stop.vehicleId).plate !== stop.plate) out.push('cloned');
  }
  if (flags & PLATE_FLAG.stolen) out.push('stolen');
  return out;
}

function addViolation(out: CitationViolation[], s: Statute | null, detail: string): void {
  if (!s || !s.citeable || out.some((v) => v.statuteId === s.id)) return;
  out.push({ statuteId: s.id, fine: s.fine, detail });
}

/**
 * Citation prefilled from the current stop: the identified driver (else the registered owner,
 * flagged `idUnverified`), plate, vehicle, location, observed violations via `statuteForViolation`,
 * plate issues of the last run via `statuteForPlateIssue` (non-citeable statutes are left to a
 * booking), recorded speed, fines and total. Violations are sorted by statute id.
 */
export function citationDraftFromStop(
  stop: TrafficStopInfo,
  records: RecordsDb,
  observedViolations: Readonly<Partial<Record<string, number>>>,
  observedSpeed: { speedMph: number; limitMph: number } | null,
  location: string,
  lastRun: PlateRunInfo | null = null,
): CitationDraft {
  let personId = stop.driverId;
  let idUnverified = false;
  if (!(personId >= 0)) {
    personId = stopRegistration(stop, records)?.ownerId ?? -1;
    idUnverified = true;
  }
  const speed = observedSpeed && Number.isFinite(observedSpeed.speedMph) ? observedSpeed : null;
  const violations: CitationViolation[] = [];
  for (const [kind, count] of Object.entries(observedViolations)) {
    if (count === undefined || !(count > 0)) continue;
    const s = statuteForViolation(kind);
    let detail = count > 1 ? `Observed ${count} times` : 'Observed by officer';
    if (s?.speed && speed) detail = `${Math.round(speed.speedMph)} mph in a ${Math.round(speed.limitMph)} mph zone`;
    addViolation(violations, s, detail);
  }
  for (const issue of plateIssues(stop, records, lastRun)) addViolation(violations, statuteForPlateIssue(issue), `Plate run: ${issue}`);
  violations.sort((a, b) => (a.statuteId < b.statuteId ? -1 : a.statuteId > b.statuteId ? 1 : 0));
  return {
    callId: stop.callId >= 0 ? stop.callId : null,
    personId,
    idUnverified,
    vehicleId: stop.vehicleId,
    plate: stop.plate,
    location,
    violations,
    totalFine: citationTotal(violations),
    recordedSpeedMph: speed ? Math.round(speed.speedMph) : null,
    limitMph: speed ? Math.round(speed.limitMph) : null,
    notes: idUnverified ? 'ID unverified: registered owner shown, driver not identified' : '',
  };
}

// --- Bookings ---------------------------------------------------------------------------------

/** Charges suggested for a prisoner: PC-220 with active warrants, PC-210 when the stopped car is stolen. */
export function suggestedCharges(records: RecordsDb, personId: number, stop: TrafficStopInfo | null): string[] {
  const out: string[] = [];
  if (personId >= 0 && records.personHits(personId).some((h) => h.kind === 'warrant')) out.push('PC-220');
  if (stop && isRegistryId(stop.vehicleId) && records.registration(stop.vehicleId).stolen) out.push('PC-210');
  return out.filter((id) => findStatute(id)?.bookable === true);
}

/** "Complete booking" is allowed at the station, for the seated prisoner, on an unfinished booking. */
export function canCompleteBooking(
  booking: { readonly personId: number; readonly status?: 'draft' | 'final' } | null,
  prisoner: number,
  atStation: boolean,
): boolean {
  return atStation && booking !== null && booking.personId >= 0 && booking.personId === prisoner && booking.status !== 'final';
}

// --- Documents --------------------------------------------------------------------------------

export interface DocRow {
  readonly id: string;
  readonly kind: DocKind;
  readonly status: 'DRAFT' | 'FINAL';
  readonly time: string;
  readonly summary: string;
}

export function docSummary(d: CadDocument): string {
  switch (d.kind) {
    case 'report':
      return d.title !== '' ? d.title : '(untitled)';
    case 'citation':
      return `${d.plate || '-'} ${d.violations.map((v) => v.statuteId).join(', ') || '(no violations)'} $${d.totalFine}`;
    case 'booking':
      return `Person #${d.personId}: ${d.charges.join(', ') || '(no charges)'}`;
    case 'evidence':
      return `${d.category}: ${d.description || '(no description)'}`;
    case 'supplement':
      return `Supplement to ${d.parentId || '-'}`;
  }
}

/** Documents of `kind`, newest first. */
export function docRows(docs: DocumentStore, kind: DocKind): DocRow[] {
  const list = docs.list(kind);
  const out: DocRow[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const d = list[i] as CadDocument;
    out.push({ id: d.id, kind: d.kind, status: d.status === 'final' ? 'FINAL' : 'DRAFT', time: formatStamp(d.created.game), summary: docSummary(d) });
  }
  return out;
}

function statuteText(id: string): string {
  const s = findStatute(id);
  return s ? `${s.id} ${s.title}` : id;
}

/** Read-only sections of a document (the viewer). */
export function docSections(d: CadDocument): MdtSection[] {
  const head: MdtLine[] = [
    line('Status', d.status.toUpperCase()),
    line('Author', d.author),
    line('Created', formatStamp(d.created.game)),
    line('Updated', formatStamp(d.updated.game)),
    line('Call', d.callId !== null ? `C-${String(d.callId).padStart(5, '0')}` : '-'),
  ];
  const sections: MdtSection[] = [{ id: 'doc', title: d.id, lines: head }];
  switch (d.kind) {
    case 'report':
      sections.push(
        {
          id: 'report',
          title: 'Incident report',
          lines: [
            line('Title', d.title),
            line('Location', d.location),
            line('Occurred', formatStamp(d.occurredGame)),
            ...d.offenseIds.map((id) => line('Offense', statuteText(id))),
            ...d.persons.map((p) => ({ ...line(p.role, `Person #${p.personId}`), personId: p.personId })),
            ...d.vehicles.map((v) => line(v.role || 'vehicle', `${v.plate || '-'} (vehicle #${v.vehicleId})`)),
            ...d.evidenceIds.map((id) => ({ ...line('Evidence', id), docId: id })),
          ],
        },
        { id: 'narrative', title: 'Narrative', lines: [line('', d.narrative)] },
      );
      break;
    case 'citation':
      sections.push({
        id: 'citation',
        title: 'Citation',
        lines: [
          { ...line('Person', `#${d.personId}`), personId: d.personId },
          line('Plate', d.plate || '-'),
          line('Vehicle', d.vehicleId >= 0 ? `#${d.vehicleId}` : '-'),
          line('Location', d.location),
          ...d.violations.map((v) => line(statuteText(v.statuteId), `$${v.fine}${v.detail !== '' ? ` - ${v.detail}` : ''}`)),
          line('Total', `$${d.totalFine}`),
          ...(d.recordedSpeedMph !== null ? [line('Speed', `${d.recordedSpeedMph} mph / limit ${d.limitMph ?? '-'} mph`)] : []),
          ...(d.notes !== '' ? [line('Notes', d.notes)] : []),
        ],
      });
      break;
    case 'booking':
      sections.push({
        id: 'booking',
        title: 'Booking',
        lines: [
          { ...line('Person', `#${d.personId}`), personId: d.personId },
          ...d.charges.map((id) => line('Charge', statuteText(id))),
          line('Arrested', formatStamp(d.arrestedGame)),
          line('Location', d.arrestLocation || '-'),
          line('Property', d.property || '-'),
          ...(d.notes !== '' ? [line('Notes', d.notes)] : []),
        ],
      });
      break;
    case 'evidence':
      sections.push(
        {
          id: 'evidence',
          title: 'Evidence item',
          lines: [line('Description', d.description), line('Category', d.category), line('Found at', d.foundAt || '-')],
        },
        {
          id: 'custody',
          title: 'Chain of custody',
          lines: d.custody.length > 0 ? d.custody.map((c) => line(formatStamp(c.game), `${c.action.toUpperCase()} by ${c.by}${c.note !== '' ? ` - ${c.note}` : ''}`)) : [NONE_LINE],
        },
      );
      break;
    case 'supplement':
      sections.push(
        { id: 'supplement', title: 'Supplement', lines: [{ ...line('Report', d.parentId), docId: d.parentId }] },
        { id: 'narrative', title: 'Narrative', lines: [line('', d.narrative)] },
      );
      break;
  }
  return sections;
}

// --- Traffic stop ------------------------------------------------------------------------------

/** Stop tab sections: vehicle, last plate run, driver, VIN, citations. */
export function stopSections(
  stop: TrafficStopInfo,
  records: RecordsDb,
  observed: { modelId: string; color: number } | null,
  lastRun: PlateQueryResult | null,
): MdtSection[] {
  const vehicle: MdtLine[] = [
    line('Plate', stop.plate),
    line('Vehicle', observed ? `${colorName(observed.color)} ${modelName(observed.modelId)}` : 'UNKNOWN'),
    line('Since', formatClockTime(stop.started.game)),
    line('Outcome', stop.outcome.toUpperCase(), stop.outcome === 'active' ? 'none' : 'info'),
  ];
  const run =
    lastRun && lastRun.plate === stop.plate
      ? lastRun.found
        ? lastRun.hits.length > 0
          ? lastRun.hits.map((h) => line('', h.text, hitSeverity(h)))
          : [line('', 'CLEAR - NO HITS')]
        : [line('', 'NO RECORD', 'caution')]
      : [line('', stop.plateRun ? 'Plate run (see call narrative)' : 'NOT RUN')];
  let driver: MdtLine[];
  if (stop.driverId >= 0) {
    const p = records.person(stop.driverId);
    const lic = p.license;
    driver = [
      { ...line('Name', displayName(p)), personId: p.id },
      line('DOB', formatDate(p.dob)),
      line('DL', lic.status === 'none' ? 'NONE' : `${lic.number} (${lic.status.toUpperCase()})`, lic.status === 'valid' ? 'none' : 'caution'),
      ...records.personHits(stop.driverId).map((h) => line('', h.text, hitSeverity(h))),
    ];
  } else {
    driver = [line('', 'NOT IDENTIFIED (request license at the driver window)')];
  }
  const vin = [line('', stop.vinChecked ? stop.vinResult || 'CHECKED' : 'NOT CHECKED')];
  const cites = stop.citations.length > 0 ? stop.citations.map((id) => ({ ...line('Citation', id), docId: id })) : [NONE_LINE];
  return [
    { id: 'vehicle', title: 'Stopped vehicle', lines: vehicle },
    { id: 'run', title: 'Plate run', lines: run },
    { id: 'driver', title: 'Driver', lines: driver },
    { id: 'vin', title: 'VIN check', lines: vin },
    { id: 'citations', title: 'Citations issued', lines: cites },
  ];
}
