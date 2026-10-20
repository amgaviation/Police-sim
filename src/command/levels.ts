/** Command levels and resource needs (Phase 6 design §11.2). Pure. */
import { COMMAND_CONFIG } from './data';
import type { CommandConfig, CommandLevel } from './types';

/**
 * Command level of a call. A family listed in `levels.families` has that level, raised from `incident` to `major` when
 * `majorUnitsOnScene` units are already there. An unlisted family is `incident` once that many units are on scene, else `none`.
 */
export function commandLevel(family: string, unitsOnScene: number, cfg: CommandConfig = COMMAND_CONFIG): CommandLevel {
  const listed = cfg.levels.families[family];
  const crowded = unitsOnScene >= cfg.levels.majorUnitsOnScene;
  if (listed === undefined) return crowded ? 'incident' : 'none';
  if (listed === 'incident' && crowded) return 'major';
  return listed;
}

/**
 * Recommended additional resources.
 * ems = min(maxEms, ceil(immediate * emsPerImmediate + delayed * emsPerDelayed)) - onSceneEms (>= 0);
 * fire = min(maxFire, ceil(trapped * firePerTrapped) + (hazmat ? fireHazmat : 0)) - onSceneFire (>= 0);
 * supervisor 1 when none is assigned.
 */
export function resourceNeeds(
  i: { immediate: number; delayed: number; trapped: number; hazmat: boolean; onSceneEms: number; onSceneFire: number; supervisor: boolean },
  cfg: CommandConfig = COMMAND_CONFIG,
): { ems: number; fire: number; supervisor: number } {
  const n = cfg.needs;
  const ems = Math.min(n.maxEms, Math.ceil(i.immediate * n.emsPerImmediate + i.delayed * n.emsPerDelayed)) - i.onSceneEms;
  const fire = Math.min(n.maxFire, Math.ceil(i.trapped * n.firePerTrapped) + (i.hazmat ? n.fireHazmat : 0)) - i.onSceneFire;
  return { ems: Math.max(0, ems), fire: Math.max(0, fire), supervisor: i.supervisor ? 0 : 1 };
}
