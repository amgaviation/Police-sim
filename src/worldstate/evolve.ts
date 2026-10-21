import type { Rng } from '../core/rng';
import { CRIME_DISTRICTS } from '../environment/crime';
import { followUpSuspect, isActiveCase } from './cases';
import type { WorldConfig } from './data';
import { evolveNeighborhood } from './neighborhoods';
import type {
  CaseRecord, EvolveInput, EvolveResult, FollowUpCall, NeighborhoodState, OffenderRecord, WitnessRecord,
} from './types';

/** Rollover evolution of the persistent world (Phase 8 design §6.4). */

const DAY_S = 86400;
const MAX_DAYS = 30;
/** Smallest crime change over a rollover that makes the news. */
const NEWS_CRIME_DELTA = 0.03;

/** The collections `evolveWorld` mutates (owned by `WorldState`). */
export interface EvolveData {
  readonly cases: CaseRecord[];
  /** In personId order. */
  readonly offenders: OffenderRecord[];
  readonly witnesses: WitnessRecord[];
  readonly neighborhoods: Record<string, NeighborhoodState>;
}

export interface EvolveEnv {
  readonly rng: Rng;
  readonly cfg: WorldConfig;
  readonly baseCrime: Readonly<Record<string, number>>;
  readonly offenderOf: (personId: number) => OffenderRecord | null;
  /** Called after a case changed status. */
  readonly onCase: (c: CaseRecord) => void;
}

/** `floor((toGame - fromGame) / 86400)` clamped to 0..30 (0 for non-finite input). */
export function evolveDays(fromGame: number, toGame: number): number {
  const d = Math.floor((toGame - fromGame) / DAY_S);
  return Number.isFinite(d) ? Math.min(MAX_DAYS, Math.max(0, d)) : 0;
}

/**
 * Evolves the world between two sessions, in this order: releases (`releaseGame <= toGame`), risk decay, witness moves
 * (array order; p = 1 - (1 - movePerDay)^days; u < p moves, then a second draw < unknownAddressShare gives an unknown
 * address, else `addressAt(third draw)`), neighborhoods (CRIME_DISTRICTS order, one draw each, only when days > 0), trust
 * deltas, cases (age, cold, follow-ups: one draw per eligible case, at most `maxFollowUpsPerShift`) and the news lines.
 * Draws only from `env.rng`.
 */
export function evolveWorld(d: EvolveData, input: Readonly<EvolveInput>, env: EvolveEnv): EvolveResult {
  const { cfg, rng } = env;
  const days = evolveDays(input.fromGame, input.toGame);
  const news: string[] = [];

  // Releases.
  const released: number[] = [];
  for (const o of d.offenders) {
    if (o.custody === 'jailed' && o.releaseGame <= input.toGame) {
      o.custody = 'released';
      released.push(o.personId);
    }
  }
  if (released.length > 0) news.push(`${released.length} ${released.length === 1 ? 'offender' : 'offenders'} released from custody`);

  // Risk decay.
  if (days > 0) {
    for (const o of d.offenders) o.risk = Math.max(cfg.offenders.riskMin, o.risk - cfg.offenders.riskDecayPerDay * days);
  }

  // Witness moves.
  const moves: EvolveResult['moves'] = [];
  if (days > 0) {
    const p = 1 - Math.pow(1 - cfg.witnesses.movePerDay, days);
    for (const w of d.witnesses) {
      if (!(rng.next() < p)) continue;
      const address = rng.next() < cfg.witnesses.unknownAddressShare ? null : input.addressAt(rng.next());
      w.addressText = address ?? 'Unknown';
      w.movedGame = input.toGame;
      moves.push({ personId: w.personId, address });
    }
  }

  // Neighborhoods and trust.
  const trustDeltas: EvolveResult['trustDeltas'] = [];
  if (days > 0) {
    const atLarge: Record<string, number> = {};
    for (const o of d.offenders) if (o.custody !== 'jailed') atLarge[o.district] = (atLarge[o.district] ?? 0) + 1;
    for (const district of CRIME_DISTRICTS) {
      const n = d.neighborhoods[district];
      const base = env.baseCrime[district] ?? 0;
      const u = rng.next();
      if (n === undefined) continue;
      const before = n.crime;
      evolveNeighborhood(n, base, input.trust[district] ?? 0.5, atLarge[district] ?? 0, input.arrestsByDistrict[district] ?? 0, days, u, cfg.neighborhoods);
      if (!(base > 0)) continue;
      const delta = -cfg.neighborhoods.crimeToTrust * (n.crime - base);
      if (Math.abs(delta) > 1e-9) trustDeltas.push({ district, delta });
      if (n.crime - before >= NEWS_CRIME_DELTA) news.push(`Crime is rising in ${district}`);
      else if (before - n.crime >= NEWS_CRIME_DELTA) news.push(`Crime is falling in ${district}`);
    }
  }

  // Cases.
  const followUps: FollowUpCall[] = [];
  for (const c of d.cases) {
    if (!isActiveCase(c.status)) continue;
    c.shiftsOpen++;
    if (c.shiftsOpen >= cfg.cases.coldAfterShifts) {
      c.status = 'cold';
      news.push(`Case ${c.id} (${c.nature}) has gone cold`);
      env.onCase(c);
      continue;
    }
    if (c.status !== 'open' || followUps.length >= cfg.cases.maxFollowUpsPerShift) continue;
    const suspect = followUpSuspect(c, env.offenderOf);
    if (suspect === null) continue;
    if (rng.next() < cfg.cases.followUpChance) {
      c.status = 'followUp';
      followUps.push({ caseId: c.id, callId: c.callId, typeId: 'warrantService', personId: suspect.personId, x: suspect.x, z: suspect.z });
      news.push(`Case ${c.id} (${c.nature}): suspect located, warrant service pending`);
      env.onCase(c);
    }
  }

  return { days, released, moves, followUps, trustDeltas, news };
}
