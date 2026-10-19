/**
 * Shared id lists of the evidence module (design phase 4 §9). Re-declared here, identical to the interior
 * generator's lists, so the evidence rules import no other Phase 4 module.
 */

/** Where an item can lie: `none` = openly on a surface; the rest are closed containers. */
export const CONTAINERS = ['none', 'drawer', 'cabinet', 'closet', 'safe'] as const;
export type Container = (typeof CONTAINERS)[number];

/** Surface kinds that take latent prints (dust quality). */
export const PRINT_SURFACES = ['glass', 'metal', 'stone', 'wood', 'fabric'] as const;
export type PrintSurface = (typeof PRINT_SURFACES)[number];
