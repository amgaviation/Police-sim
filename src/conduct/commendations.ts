import type { IncidentEvent, IncidentLog, LegalAssessment } from '../legal/types';
import { COMMENDATION_CONFIG, commendationRule, type CommendationConfig } from './data';

/** Incident families where calling EMS promptly counts as lifesaving. */
const LIFESAVING_FAMILIES: readonly string[] = ['medical', 'crisis', 'collision'];
const DEESCALATION_INDICATORS: readonly string[] = ['weaponSeen', 'weaponCall', 'assaultOnOfficer'];

function ofKind<K extends IncidentEvent['kind']>(log: IncidentLog, kind: K): Extract<IncidentEvent, { kind: K }>[] {
  return log.events.filter((e): e is Extract<IncidentEvent, { kind: K }> => e.kind === kind);
}

/**
 * Incident-time commendation rule ids earned by an incident (design 10.2): `deEscalation`, `lifesaving` and one
 * `dutyToIntervene` per lawful intervene determination. A rule absent from `cfg` never fires.
 */
export function commendationsFor(log: IncidentLog, a: LegalAssessment, cfg: CommendationConfig = COMMENDATION_CONFIG): string[] {
  const out: string[] = [];

  if (commendationRule(cfg, 'deEscalation')) {
    const threat = ofKind(log, 'indicator').some((e) => DEESCALATION_INDICATORS.includes(e.indicator));
    const noForce = !ofKind(log, 'force').some((e) => e.level !== 'presence' && e.level !== 'verbal');
    const ended = log.events.some((e) => e.kind === 'arrest' || e.kind === 'release');
    if (threat && noForce && ended) out.push('deEscalation');
  }

  const life = commendationRule(cfg, 'lifesaving');
  if (life) {
    const within = life.withinS ?? 120;
    const requests = ofKind(log, 'service').filter((e) => e.service === 'ems' && e.phase === 'requested');
    if (requests.length > 0) {
      const first = log.events.find((e) => e.kind === 'start' || e.kind === 'person');
      const t0 = first ? first.t : log.openedSim;
      const injuries = ofKind(log, 'force').filter((f) => f.injury > 0);
      const earned = requests.some((r) =>
        (LIFESAVING_FAMILIES.includes(log.family) && r.t - t0 <= within) ||
        injuries.some((f) => r.t >= f.t && r.t - f.t <= within),
      );
      if (earned) out.push('lifesaving');
    }
  }

  if (commendationRule(cfg, 'dutyToIntervene')) {
    for (const d of a.determinations) if (d.doctrine === 'intervene' && d.outcome === 'lawful') out.push('dutyToIntervene');
  }
  return out;
}
