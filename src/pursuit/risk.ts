/**
 * Pursuit risk and the supervisor's termination rules (design §10.2). Pure functions.
 */
import { PURSUIT_CONFIG } from './data';
import type { PursuitConfig } from './types';

/** Offense categories that count as violent for the risk estimate and termination rule 5. */
export const VIOLENT_OFFENSES: readonly string[] = ['violent', 'weapons'];

export interface RiskInput {
  speedMph: number;
  limitMph: number;
  district: string;
  wet: boolean;
  night: boolean;
  trafficDensity: number;
  durationS: number;
  offense: string | null;
  violentOffenses: readonly string[];
  lostSightS: number;
  airOnTarget: boolean;
}

/**
 * Risk to the public, 0..1: `overLimitPer10Mph * max(0, speed - limit) / 10` + the district weight + wet + night +
 * `density * trafficDensity` + `perMinute * minutes` + `nonViolent` (offense not in `violentOffenses`; an unknown
 * offense counts as non-violent) + `lostSight` (when the suspect was out of sight) + `airUnitRelief` (negative, when
 * the air unit is on target), clamped to [0, 1].
 */
export function pursuitRisk(i: RiskInput, cfg: PursuitConfig = PURSUIT_CONFIG): number {
  const r = cfg.risk;
  let v = (r.overLimitPer10Mph * Math.max(0, i.speedMph - i.limitMph)) / 10;
  v += r.district[i.district] ?? 0;
  if (i.wet) v += r.wet;
  if (i.night) v += r.night;
  v += r.density * i.trafficDensity;
  v += (r.perMinute * i.durationS) / 60;
  if (i.offense === null || !i.violentOffenses.includes(i.offense)) v += r.nonViolent;
  if (i.lostSightS > 0) v += r.lostSight;
  if (i.airOnTarget) v += r.airUnitRelief;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface DecisionInput extends RiskInput {
  allowedOffenses: readonly string[];
  maxDurationS: number;
  supervisorMonitoring: boolean;
  monitoringS: number;
}

export type PursuitDecision = { action: 'continue'; reason: '' } | { action: 'terminate'; reason: string };

const CONTINUE: PursuitDecision = { action: 'continue', reason: '' };

/**
 * Termination rules, first match wins, only while a supervisor monitors and `monitoringS >= monitorDelayS`
 * (else continue): 1 offense known and not allowed; 2 `durationS > maxDurationS`; 3 `lostSightS >= lostSightS` limit
 * without the air unit on target; 4 risk >= `riskTerminate`; 5 offense not violent and risk >=
 * `riskTerminateNonViolent`.
 */
export function pursuitDecision(i: DecisionInput, cfg: PursuitConfig = PURSUIT_CONFIG): PursuitDecision {
  const s = cfg.supervisor;
  if (!i.supervisorMonitoring || i.monitoringS < s.monitorDelayS) return CONTINUE;
  if (i.offense !== null && !i.allowedOffenses.includes(i.offense)) {
    return { action: 'terminate', reason: 'pursuit not authorized for this offense' };
  }
  if (i.durationS > i.maxDurationS) return { action: 'terminate', reason: 'time limit reached' };
  if (i.lostSightS >= s.lostSightS && !i.airOnTarget) return { action: 'terminate', reason: 'lost visual, no air support' };
  const risk = pursuitRisk(i, cfg);
  if (risk >= s.riskTerminate) return { action: 'terminate', reason: 'risk to the public too high' };
  const violent = i.offense !== null && i.violentOffenses.includes(i.offense);
  if (!violent && risk >= s.riskTerminateNonViolent) return { action: 'terminate', reason: 'risk outweighs a non-violent offense' };
  return CONTINUE;
}
