import { WORLD_CONFIG, type NeighborhoodsConfig } from './data';
import type { NeighborhoodState } from './types';

/** Neighborhood crime evolution (Phase 8 design §6.3). Pure. */

/** A neighborhood at its base crime level. */
export function newNeighborhood(base: number): NeighborhoodState {
  return { crime: base, trend: 0, history: [] };
}

/**
 * crime += (target - crime) * (1 - exp(-relax * days)) + noise * (2u - 1) * min(1, days), with
 * target = base * (1 + trustWeight * (0.5 - trust) * 2) + offenderWeight * atLarge - arrestWeight * arrests; the result is
 * clamped to [min, max]; the new value is pushed to `history` (last `historyDays`); `trend` = new - old. No change when
 * `days <= 0`.
 */
export function evolveNeighborhood(
  n: NeighborhoodState, base: number, trust: number, atLarge: number, arrests: number, days: number, u: number,
  cfg: NeighborhoodsConfig = WORLD_CONFIG.neighborhoods,
): void {
  if (!(days > 0)) return;
  const target = base * (1 + cfg.trustWeight * (0.5 - trust) * 2) + cfg.offenderWeight * atLarge - cfg.arrestWeight * arrests;
  const old = n.crime;
  const next = old + (target - old) * (1 - Math.exp(-cfg.relax * days)) + cfg.noise * (2 * u - 1) * Math.min(1, days);
  n.crime = Math.min(cfg.max, Math.max(cfg.min, next));
  n.trend = n.crime - old;
  n.history.push(n.crime);
  while (n.history.length > cfg.historyDays) n.history.shift();
}

/** clamp(crime / base, factorRange); 1 when base is 0. */
export function crimeFactor(n: Readonly<NeighborhoodState>, base: number, cfg: NeighborhoodsConfig = WORLD_CONFIG.neighborhoods): number {
  if (!(base > 0)) return 1;
  return Math.min(cfg.factorRange[1], Math.max(cfg.factorRange[0], n.crime / base));
}
