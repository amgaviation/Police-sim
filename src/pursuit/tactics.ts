/**
 * Box-in and roadblock geometry (design §10.2). Pure functions; yaw 0 = facing -Z, forward = (-sin yaw, -cos yaw).
 */
import { PURSUIT_CONFIG } from './data';
import type { PursuitConfig } from './types';

/** Can the suspect be boxed in? Slow enough, enough AI units within `radiusM` and (when required) the player's car too. */
export function canBoxIn(
  suspect: { x: number; z: number; yaw: number; speedMph: number },
  police: readonly { x: number; z: number; player: boolean }[],
  cfg: PursuitConfig = PURSUIT_CONFIG,
): { ok: boolean; reason: string } {
  const c = cfg.boxIn;
  if (suspect.speedMph > c.maxSuspectMph) return { ok: false, reason: `Suspect is moving too fast (over ${c.maxSuspectMph} mph)` };
  const r2 = c.radiusM * c.radiusM;
  let ai = 0;
  let player = false;
  for (const u of police) {
    const dx = u.x - suspect.x, dz = u.z - suspect.z;
    if (dx * dx + dz * dz > r2) continue;
    if (u.player) player = true;
    else ai++;
  }
  if (c.requirePlayer && !player) return { ok: false, reason: 'Your car must be next to the suspect' };
  if (ai < c.minAiUnits) return { ok: false, reason: `Need ${c.minAiUnits} more units close to the suspect` };
  return { ok: true, reason: '' };
}

/** Units ahead of the suspect: `dot(u - s, forward)` in (0, `aheadM`] and `|lateral| <= lateralM`. */
export function unitsAhead(
  suspect: { x: number; z: number; yaw: number },
  police: readonly { x: number; z: number }[],
  cfg: PursuitConfig = PURSUIT_CONFIG,
): number {
  const c = cfg.roadblock;
  const fx = -Math.sin(suspect.yaw), fz = -Math.cos(suspect.yaw);
  let n = 0;
  for (const u of police) {
    const dx = u.x - suspect.x, dz = u.z - suspect.z;
    const along = dx * fx + dz * fz;
    if (along <= 0 || along > c.aheadM) continue;
    // Right vector (cos yaw, -sin yaw) = (-fz, fx).
    const lateral = -dx * fz + dz * fx;
    if (Math.abs(lateral) <= c.lateralM) n++;
  }
  return n;
}
