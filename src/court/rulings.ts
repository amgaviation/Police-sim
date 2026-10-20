import type { Offense, LegalAssessment, IncidentLog, Ruleset, EvidenceRuling } from '../legal/types';
import { COURT_CONFIG, type CourtConfig } from './data';
import type { MotionRuling } from './types';

/**
 * Motion rulings, evidence strength, conviction odds and hearing scheduling (design 11.2). All pure.
 */

const HOUR = 3600;
const DAY = 86400;

function relevant(r: EvidenceRuling, offenses: readonly Offense[]): boolean {
  return r.offense === null || offenses.length === 0 || offenses.includes(r.offense);
}

/**
 * The judge's rulings for one defendant: a granted dismissal for an unlawful arrest, a granted suppression for every
 * inadmissible piece of evidence that bears on `offenses`, and (when a search was judged) one denied suppression of an
 * item from a lawful search, which shows the basis the court accepted.
 */
export function motionRulings(a: LegalAssessment, personId: number, offenses: readonly Offense[], rs: Ruleset): MotionRuling[] {
  const out: MotionRuling[] = [];
  const person = a.persons.find((p) => p.personId === personId);
  if (person !== undefined && person.arrested && person.arrestLawful === false) {
    const d = a.determinations.find((x) => x.doctrine === 'arrest' && x.personId === personId && x.outcome === 'unlawful');
    out.push({
      text: 'Motion to dismiss: unlawful arrest — GRANTED',
      granted: true,
      ruleIds: d !== undefined ? [...d.ruleIds] : [rs.arrest.ruleId],
      dismissesCase: true,
    });
  }
  for (const r of a.evidence) {
    if (r.personId !== personId || r.admissible || !relevant(r, offenses)) continue;
    out.push({ text: `Motion to suppress ${r.label} — GRANTED (${r.ruleIds.join(', ')})`, granted: true, ruleIds: [...r.ruleIds], dismissesCase: false });
  }
  const searches = a.determinations.filter((d) => d.personId === personId && (d.doctrine === 'search' || d.doctrine === 'frisk'));
  for (const r of a.evidence) {
    if (r.personId !== personId || !r.admissible || r.kind !== 'item' || !relevant(r, offenses)) continue;
    const d = searches.find((x) => x.eventId === r.eventId && x.outcome === 'lawful');
    if (d === undefined) continue;
    const basis = d.basis !== null ? `${d.basis}: ` : '';
    out.push({ text: `Motion to suppress ${r.label} — DENIED (${basis}${d.ruleIds.join(', ')})`, granted: false, ruleIds: [...d.ruleIds], dismissesCase: false });
    break;
  }
  return out;
}

/**
 * How strong the prosecution's case for `offense` against `personId` is, 0..1: the probable-cause weight of the
 * person's admissible indicators for that offense, +1 per admissible item of that offense, +2 for an admissible
 * warrant hit on a `warrant` offense, over the ruleset's probable-cause threshold.
 *
 * The assessment does not expose per-indicator taint, so it is rebuilt from what it does expose: an indicator is
 * inadmissible when its source event has an inadmissible ruling for the same offense, or when it follows an unlawful
 * detention of the person and is neither a call fact nor an attenuating indicator.
 */
export function evidenceStrength(a: LegalAssessment, log: IncidentLog, personId: number, offense: Offense, rs: Ruleset): number {
  const person = a.persons.find((p) => p.personId === personId);
  let detentionId = -1;
  if (person !== undefined && person.detentionLawful === false) {
    const first = log.events.find((e) => e.kind === 'detention' && e.personId === personId);
    if (first !== undefined) detentionId = first.id;
  }
  const role = log.people.find((p) => p.personId === personId)?.role ?? '';
  let sum = 0;
  let warrantHit = false;
  for (const e of log.events) {
    if (e.kind !== 'indicator' || (e.personId !== personId && e.personId !== -1)) continue;
    const def = rs.indicators[e.indicator];
    if (def === undefined) continue;
    const off = e.indicator === 'callSuspect' ? (rs.familyOffense[log.family] ?? def.offense) : def.offense;
    if (off !== offense) continue;
    if (e.indicator === 'licenseInvalid' && role !== 'driver') continue;
    if (e.sourceEvent >= 0 && a.evidence.some((r) => r.eventId === e.sourceEvent && !r.admissible && (r.offense === null || r.offense === off))) continue;
    if (
      detentionId >= 0 && e.personId === personId && e.id > detentionId && e.source !== 'call' &&
      !rs.detention.attenuating.includes(e.indicator)
    ) continue;
    sum += def.pc;
    if (e.indicator === 'warrantHit') warrantHit = true;
  }
  for (const r of a.evidence) if (r.personId === personId && r.kind === 'item' && r.admissible && r.offense === offense) sum += 1;
  if (offense === 'warrant' && warrantHit) sum += 2;
  return Math.max(0, Math.min(1, sum / rs.thresholds.pc));
}

/**
 * Probability of a conviction: `base + strength·s + (testimony ?? 0.5)·t + (reportScore ?? noReportGrade)/100·r`,
 * scaled by `missedFactor` when the officer missed the hearing, clamped to 0.02..0.98.
 */
export function convictionChance(
  strength: number, testimony: number | null, reportScore: number | null, missed: boolean, cfg: CourtConfig = COURT_CONFIG,
): number {
  const c = cfg.conviction;
  let p = c.base + strength * c.strength + (testimony ?? 0.5) * c.testimony + ((reportScore ?? c.noReportGrade) / 100) * c.report;
  if (missed) p *= c.missedFactor;
  return Math.max(0.02, Math.min(0.98, p));
}

/**
 * The hearing time (game seconds): `createdGame` plus a delay of `delayH` interpolated by `u`, rounded up to the next
 * full hour. A time before the court opens moves to opening time the same day, one at or after closing to opening
 * time the next day.
 */
export function scheduleHearing(createdGame: number, u: number, cfg: CourtConfig = COURT_CONFIG): number {
  const [lo, hi] = cfg.delayH;
  let t = Math.ceil((createdGame + (lo + u * (hi - lo)) * HOUR) / HOUR) * HOUR;
  const [open, close] = cfg.hours;
  const hour = Math.floor((((t % DAY) + DAY) % DAY) / HOUR);
  if (hour < open) t += (open - hour) * HOUR;
  else if (hour >= close) t += DAY - hour * HOUR + open * HOUR;
  return t;
}
