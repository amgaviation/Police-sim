import type { Bolo } from './bolo';
import { formatDate } from './calendar';
import type { PersonRecord } from './person';
import { colorName, vehicleDescription, type ObservedVehicle, type RegistrationRecord } from './vehicle';

/** Query hits (design §5.4): short upper-case lines with a severity, in a fixed order. */

export type HitSeverity = 'info' | 'caution' | 'alert';

export interface RecordHit {
  readonly kind: string;
  readonly severity: HitSeverity;
  readonly text: string;
}

export type SeverityRollup = 'clear' | 'caution' | 'alert';

function hit(kind: string, severity: HitSeverity, text: string): RecordHit {
  return { kind, severity, text: text.toUpperCase() };
}

/** 'alert' if any alert, else 'caution' if any caution, else 'clear' (info hits do not count). */
export function severityOf(hits: readonly RecordHit[]): SeverityRollup {
  let s: SeverityRollup = 'clear';
  for (const h of hits) {
    if (h.severity === 'alert') return 'alert';
    if (h.severity === 'caution') s = 'caution';
  }
  return s;
}

/** Hits of a person record (warrants, officer safety, supervision, gang, mental health, orders, licence, firearms, BOLOs). */
export function personHits(p: PersonRecord, bolos: readonly Bolo[]): RecordHit[] {
  const out: RecordHit[] = [];
  for (const w of p.warrants) out.push(hit('warrant', 'alert', `WARRANT: ${w.offense} - ${w.court} - BAIL $${w.bail}`));
  for (const b of bolos) {
    if (b.kind === 'person' && b.personId === p.id) out.push(hit('bolo', 'alert', `BOLO: ${b.text}`));
  }
  for (const note of p.officerSafety) out.push(hit('officerSafety', 'alert', `OFFICER SAFETY: ${note}`));
  const s = p.supervision;
  if (s.kind !== 'none') {
    const conditions = s.conditions.length > 0 ? `: ${s.conditions.join(', ')}` : '';
    out.push(hit('supervision', 'caution', `${s.kind} until ${formatDate(s.until)}${conditions} (${s.agent})`));
  }
  if (p.gang) out.push(hit('gang', 'caution', `GANG: ${p.gang.name} (${p.gang.role})`));
  if (p.mentalHealth !== null) out.push(hit('mentalHealth', 'caution', `MENTAL HEALTH: ${p.mentalHealth}`));
  for (const o of p.protectiveOrders) {
    out.push(hit('protectiveOrder', 'caution', `PROTECTIVE ORDER (RESTRAINED): ${o.conditions.join(', ')}`));
  }
  const lic = p.license;
  if (lic.status === 'none') out.push(hit('license', 'caution', 'NO LICENSE ON FILE'));
  else if (lic.status === 'expired') out.push(hit('license', 'caution', `LICENSE EXPIRED ${formatDate(lic.expires)}`));
  else if (lic.status !== 'valid') out.push(hit('license', 'caution', `LICENSE ${lic.status}`));
  if (p.firearms.length > 0) out.push(hit('firearms', 'info', `FIREARMS: ${p.firearms.length} REGISTERED`));
  return out;
}

/** True when `observed` (the targeted car) does not look like the registration (model or colour name). */
export function descriptionMismatch(r: RegistrationRecord, observed: ObservedVehicle): boolean {
  return observed.modelId !== r.modelId || colorName(observed.color) !== r.colorName;
}

/**
 * Hits of a plate/VIN query, in order: stolen vehicle, plates reported stolen, clone alert,
 * description mismatch (with `observed`), expired, uninsured, vehicle flag, vehicle BOLOs, RO
 * warrants, then the owner's other hits prefixed "RO ".
 */
export function registrationHits(
  r: RegistrationRecord,
  owner: PersonRecord | null,
  observed: ObservedVehicle | null,
  bolos: readonly Bolo[],
): RecordHit[] {
  const out: RecordHit[] = [];
  if (r.stolen) out.push(hit('stolenVehicle', 'alert', 'STOLEN VEHICLE'));
  if (r.plateReportedStolen) out.push(hit('stolenPlate', 'alert', 'PLATES REPORTED STOLEN'));
  if (r.cloneAlert) out.push(hit('cloneAlert', 'caution', 'POSSIBLE CLONED PLATE - VERIFY VIN'));
  if (observed && descriptionMismatch(r, observed)) {
    out.push(hit('mismatch', 'alert', `DESCRIPTION MISMATCH: RETURNS TO ${vehicleDescription(r)}`));
  }
  if (r.expired) out.push(hit('expired', 'caution', `REGISTRATION EXPIRED ${formatDate(r.expires)}`));
  if (!r.insured) out.push(hit('uninsured', 'caution', 'NO INSURANCE ON FILE'));
  if (r.flag !== null) out.push(hit('flag', 'alert', `FLAG: ${r.flag}`));
  for (const b of bolos) {
    if (b.kind === 'vehicle' && b.vehicleId === r.vehicleId) out.push(hit('bolo', 'alert', `BOLO: ${b.text}`));
  }
  if (owner) {
    for (const w of owner.warrants) out.push(hit('roWarrant', 'alert', `RO WANTED: ${w.offense} (${w.court})`));
    for (const h of personHits(owner, bolos)) {
      if (h.kind !== 'warrant') out.push({ kind: `ro:${h.kind}`, severity: h.severity, text: `RO ${h.text}` });
    }
  }
  return out;
}
