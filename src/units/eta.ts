/**
 * Response-time estimation (design §5.3): pure functions of the route (from `RoadGraph.routeBetweenPoints`),
 * the call priority, traffic density, wetness and the unit type's turnout. No state, no randomness.
 */
import { ETA_CONFIG } from './data';
import type { EtaConfig, EtaInput, EtaResult, Urgency } from './types';

export type { EtaConfig, EtaInput, EtaResult, Urgency } from './types';

/** A unit considered by `rankByEta`. */
export interface EtaCandidate {
  id: string;
  x: number;
  z: number;
}

/** One ranked unit: lowest `etaS` first. */
export interface RankedCandidate {
  id: string;
  etaS: number;
  /** Straight-line distance to the target (m). */
  distanceM: number;
  routeLengthM: number;
}

/** A route as the ranker needs it. */
export interface EtaRoute {
  timeS: number;
  lengthM: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function finite(name: string, v: number): void {
  if (!Number.isFinite(v)) throw new RangeError(`${name} must be a finite number, got ${v}`);
}

function turnoutFor(turnoutS: readonly [number, number], priority: number): number {
  finite('turnoutS[0]', turnoutS[0]);
  finite('turnoutS[1]', turnoutS[1]);
  if (priority !== 1 && priority !== 2 && priority !== 3 && priority !== 4) {
    throw new RangeError(`priority must be 1, 2, 3 or 4, got ${priority}`);
  }
  return turnoutS[0] + ((turnoutS[1] - turnoutS[0]) * (priority - 1)) / 3;
}

/** P1-P2 emergency, P3 respond, P4 routine. */
export function urgencyFor(priority: 1 | 2 | 3 | 4): Urgency {
  return priority <= 2 ? 'emergency' : priority === 3 ? 'respond' : 'routine';
}

/**
 * Turnout (interpolated by priority) plus travel: the route time at the posted limits scaled by the urgency
 * and unit speed factors, slowed by traffic density and wet roads, never below `minTravelS` (zero for a
 * zero-length route). Non-finite inputs throw a RangeError.
 */
export function estimateResponse(i: EtaInput, cfg: EtaConfig = ETA_CONFIG): EtaResult {
  finite('routeTimeS', i.routeTimeS);
  finite('routeLengthM', i.routeLengthM);
  finite('trafficDensity', i.trafficDensity);
  finite('wetness', i.wetness);
  finite('speedFactor', i.speedFactor);
  const turnoutS = turnoutFor(i.turnoutS, i.priority);
  let travelS = 0;
  if (i.routeLengthM > 0) {
    const base = i.routeTimeS / (cfg.urgencyFactor[i.urgency] * i.speedFactor);
    travelS =
      base * (1 + cfg.trafficPenalty[i.urgency] * clamp(i.trafficDensity, 0, 2)) * (1 + cfg.wetPenalty * clamp(i.wetness, 0, 1));
    if (travelS < cfg.minTravelS) travelS = cfg.minTravelS;
  }
  return { etaS: turnoutS + travelS, turnoutS, travelS };
}

/** Straight line at `speedMps` plus turnout (air unit). */
export function airEta(distanceM: number, speedMps: number, turnoutS: readonly [number, number], priority: 1 | 2 | 3 | 4): EtaResult {
  finite('distanceM', distanceM);
  finite('speedMps', speedMps);
  if (speedMps <= 0) throw new RangeError(`speedMps must be positive, got ${speedMps}`);
  const turnout = turnoutFor(turnoutS, priority);
  const travelS = Math.max(0, distanceM) / speedMps;
  return { etaS: turnout + travelS, turnoutS: turnout, travelS };
}

/** Live ETA of a unit en route: routeLeftM / max(1, expectedMps); -1 when routeLeftM < 0 (no route). */
export function remainingEta(routeLeftM: number, expectedMps: number): number {
  if (routeLeftM < 0) return -1;
  return routeLeftM / Math.max(1, expectedMps);
}

/** routeLengthM / max(1, travelS). */
export function expectedSpeed(routeLengthM: number, travelS: number): number {
  return routeLengthM / Math.max(1, travelS);
}

/**
 * Prefilter by straight-line distance to (x, z) (ties by id ascending), keep the first `cfg.rankCandidates`, ask
 * `route(c)` for { timeS, lengthM } (null = unreachable: dropped), estimate each with `make(c, route)` and sort by
 * etaS, then distance, then id. Pure apart from the callbacks; allocates (called on requests only).
 */
export function rankByEta(
  cands: readonly EtaCandidate[],
  x: number,
  z: number,
  route: (c: EtaCandidate) => EtaRoute | null,
  make: (c: EtaCandidate, r: EtaRoute) => EtaResult,
  cfg: EtaConfig = ETA_CONFIG,
): RankedCandidate[] {
  const near = cands.map((c) => ({ c, d: Math.hypot(c.x - x, c.z - z) }));
  near.sort((a, b) => a.d - b.d || (a.c.id < b.c.id ? -1 : a.c.id > b.c.id ? 1 : 0));
  const out: RankedCandidate[] = [];
  const n = Math.min(cfg.rankCandidates, near.length);
  for (let k = 0; k < n; k++) {
    const e = near[k];
    if (!e) continue;
    const r = route(e.c);
    if (r === null) continue;
    out.push({ id: e.c.id, etaS: make(e.c, r).etaS, distanceM: e.d, routeLengthM: r.lengthM });
  }
  out.sort((a, b) => a.etaS - b.etaS || a.distanceM - b.distanceM || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}
