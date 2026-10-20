import { TRUST } from '../dialogue/data';
import type { Doctrine, ForceRuling, IncidentLog, LegalAssessment } from '../legal/types';
import { commendationsFor } from './commendations';
import { COMMENDATION_CONFIG, TRUST_CONFIG, type CommendationConfig, type TrustConfig, type TrustDeltaKey } from './data';

/** Community trust per district type, 0..1 (design 10.2). */
export interface TrustState {
  values: Record<string, number>;
}

/** The baseline trust per district: `TRUST` of `src/dialogue`. */
export function trustBaselines(): ReadonlyMap<string, number> {
  return TRUST;
}

/** A fresh state at the baselines. */
export function newTrustState(baselines: ReadonlyMap<string, number> = TRUST): TrustState {
  const values: Record<string, number> = {};
  for (const [k, v] of baselines) values[k] = v;
  return { values };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * `district += delta`, every other district `+= delta * spill`, clamped to `[min, max]`. An unknown district spills to
 * all districts only.
 */
export function applyTrustDelta(s: TrustState, district: string, delta: number, cfg: TrustConfig = TRUST_CONFIG): void {
  for (const k of Object.keys(s.values)) {
    const v = s.values[k] ?? 0;
    s.values[k] = clamp(v + (k === district ? delta : delta * cfg.spill), cfg.min, cfg.max);
  }
}

/** Exponential drift toward the baseline: `v = base + (v - base) * exp(-driftPerDay * days)`. */
export function driftTrust(s: TrustState, days: number, cfg: TrustConfig = TRUST_CONFIG, baselines: ReadonlyMap<string, number> = TRUST): void {
  const f = Math.exp(-cfg.driftPerDay * days);
  for (const k of Object.keys(s.values)) {
    const base = baselines.get(k);
    if (base === undefined) continue;
    s.values[k] = base + ((s.values[k] ?? base) - base) * f;
  }
}

const DELTA_OF_DOCTRINE: Readonly<Partial<Record<Doctrine, TrustDeltaKey>>> = {
  detention: 'unlawfulDetention',
  search: 'unlawfulSearch',
  frisk: 'unlawfulSearch',
  friskScope: 'unlawfulSearch',
  entry: 'unlawfulSearch',
  arrest: 'unlawfulArrest',
  miranda: 'mirandaViolation',
};

const FORCE_DELTA: Readonly<Record<ForceRuling['verdict'], TrustDeltaKey>> = {
  justified: 'justifiedForce',
  questionable: 'questionableForce',
  excessive: 'excessiveForce',
};

/** Injury at which the force trust delta is amplified. */
const SERIOUS_INJURY = 0.3;

/**
 * The trust change in the incident's district (design 10.2): unlawful determinations, force rulings (amplified for
 * injury; a fatal outcome replaces the injury multiplier; a fellow officer's force counts half), lawful arrests,
 * de-escalation, a courteous contact (a release with no force and no unlawful determination) and aggressive lines.
 */
export function trustDeltaForIncident(
  a: LegalAssessment, log: IncidentLog, aggressiveLines: number, cfg: TrustConfig = TRUST_CONFIG,
  commendations: CommendationConfig = COMMENDATION_CONFIG,
): number {
  const d = cfg.deltas;
  let sum = 0;
  let unlawful = 0;
  for (const det of a.determinations) {
    if (det.outcome === 'unlawful') {
      unlawful++;
      const key = DELTA_OF_DOCTRINE[det.doctrine];
      if (key) sum += d[key];
    } else if (det.outcome === 'lawful' && det.doctrine === 'arrest') {
      sum += d.lawfulArrest;
    }
  }
  for (const f of a.force) {
    let v = d[FORCE_DELTA[f.verdict]];
    const e = log.events.find((x) => x.id === f.eventId);
    if (e && e.kind === 'force') {
      if (e.fatal) v *= d.fatalMultiplier;
      else if (e.injury >= SERIOUS_INJURY) v *= d.injuryMultiplier;
    }
    sum += f.other ? v / 2 : v;
  }
  if (commendationsFor(log, a, commendations).includes('deEscalation')) sum += d.deEscalation;
  const released = log.events.some((e) => e.kind === 'release');
  const forced = log.events.some((e) => e.kind === 'force');
  if (released && !forced && unlawful === 0) sum += d.courteousContact;
  sum += d.aggressiveLine * Math.max(0, aggressiveLines);
  return sum;
}

/** What a district's trust does to the world (design 10.2). */
export interface TrustEffects {
  /** NPC cooperation: the trust value itself. */
  cooperation: number;
  /** Multiplier on information error (tips). */
  errorScale: number;
  /** Multiplier on the crime rate. */
  crimeFactor: number;
  /** Hostile onlooker pressure, 0 above the threshold. */
  hostility: number;
}

/** Effects of trust `v`: `errorScale` / `crimeFactor` lerp from their first value at trust 0 to the second at trust 1. */
export function trustEffects(v: number, cfg: TrustConfig = TRUST_CONFIG): TrustEffects {
  const t = clamp(v, 0, 1);
  const e = cfg.effects;
  return {
    cooperation: v,
    errorScale: e.errorScale[0] + (e.errorScale[1] - e.errorScale[0]) * t,
    crimeFactor: e.crimeFactor[0] + (e.crimeFactor[1] - e.crimeFactor[0]) * t,
    hostility: Math.max(0, e.hostilityThreshold - v) * e.hostilityScale,
  };
}
