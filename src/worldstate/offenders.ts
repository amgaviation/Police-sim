import { WORLD_CONFIG, type OffendersConfig, type RecidivismConfig } from './data';
import type { OffenderRecord, WorldVerdict } from './types';

/** Offender and recidivism rules (Phase 8 design §6.3). Pure. */

const DAY_S = 86400;

/** clamp(riskBase + riskPerPrior * priors + riskJuvenile (juvenile) + riskConvicted (convicted), riskMin, riskMax). */
export function offenderRisk(priors: number, juvenile: boolean, convicted: boolean, cfg: OffendersConfig = WORLD_CONFIG.offenders): number {
  const raw = cfg.riskBase + cfg.riskPerPrior * Math.max(0, priors) + (juvenile ? cfg.riskJuvenile : 0) + (convicted ? cfg.riskConvicted : 0);
  return Math.min(cfg.riskMax, Math.max(cfg.riskMin, raw));
}

/**
 * Release game after a verdict: convicted / plea -> `game + jailDays[offenseClass] * 86400` (jailed, convicted);
 * acquitted / dismissed -> `game` (released).
 */
export function releaseAfterVerdict(
  o: OffenderRecord, verdict: WorldVerdict, game: number, cfg: OffendersConfig = WORLD_CONFIG.offenders,
): void {
  if (verdict === 'convicted' || verdict === 'plea') {
    o.convicted = true;
    o.custody = 'jailed';
    o.releaseGame = game + cfg.jailDays[o.offenseClass] * DAY_S;
  } else {
    o.custody = 'released';
    o.releaseGame = game;
  }
}

/**
 * Recidivist pick. pool = offenders with custody released | atLarge, `releaseGame <= game` and `fits(personId)`, in
 * personId order. Empty pool -> -1 WITHOUT calling `draw`. pAny = min(maxPickChance, pickChanceScale * max risk);
 * u = draw(); u >= pAny -> -1 (one draw). Else weights w = risk * (district === o.district ? sameDistrictWeight : 1);
 * v = draw() * sum(w); the first offender whose cumulative weight exceeds v.
 */
export function pickRecidivist(
  offenders: readonly OffenderRecord[], game: number, district: string, fits: (personId: number) => boolean,
  draw: () => number, cfg: RecidivismConfig = WORLD_CONFIG.recidivism,
): number {
  const pool: OffenderRecord[] = [];
  for (const o of offenders) {
    if (o.custody !== 'jailed' && o.releaseGame <= game && fits(o.personId)) pool.push(o);
  }
  if (pool.length === 0) return -1;
  for (let i = 1; i < pool.length; i++) {
    if ((pool[i - 1] as OffenderRecord).personId > (pool[i] as OffenderRecord).personId) {
      pool.sort((a, b) => a.personId - b.personId);
      break;
    }
  }
  let maxRisk = 0;
  for (const o of pool) if (o.risk > maxRisk) maxRisk = o.risk;
  const pAny = Math.min(cfg.maxPickChance, cfg.pickChanceScale * maxRisk);
  if (draw() >= pAny) return -1;
  let total = 0;
  for (const o of pool) total += o.risk * (o.district === district ? cfg.sameDistrictWeight : 1);
  const v = draw() * total;
  let acc = 0;
  for (const o of pool) {
    acc += o.risk * (o.district === district ? cfg.sameDistrictWeight : 1);
    if (acc > v) return o.personId;
  }
  return (pool[pool.length - 1] as OffenderRecord).personId;
}
